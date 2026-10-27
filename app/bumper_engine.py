"""
Core logic for generating "You're Watching / Up Next" bumpers for a Tunarr channel,
and pushing the result into Tunarr's local media source so it becomes playable filler.
"""
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests


# ---------------------------------------------------------------------------
# Tunarr: figure out what's currently airing and what's next on a channel
# ---------------------------------------------------------------------------

# Guide entries shorter than this are treated as filler, not shows.
FILLER_MAX_SECONDS = 150


def _parse_xmltv_time(raw: str) -> datetime:
    # XMLTV times look like "20260809180000 +0000"
    raw = raw.strip()
    dt_part, _, tz_part = raw.partition(" ")
    dt = datetime.strptime(dt_part, "%Y%m%d%H%M%S")
    if tz_part:
        sign = 1 if tz_part[0] == "+" else -1
        hours = int(tz_part[1:3])
        minutes = int(tz_part[3:5])
        from datetime import timedelta
        dt = dt.replace(tzinfo=timezone.utc) - sign * timedelta(hours=hours, minutes=minutes)
    else:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _resolve_xmltv_channel_id(root: ET.Element, channel_number: str, channel_name: str = "") -> str | None:
    """
    Tunarr's XMLTV guide identifies channels with a synthetic id (e.g. "C49.109.tunarr.com"),
    not the channel UUID Tunarr's REST API uses. The <channel> block's <display-name> entries
    are the only reliable link back to the channel number/name we actually have on hand.
    """
    channel_number = str(channel_number).strip()
    channel_name = (channel_name or "").strip().lower()

    for chan in root.findall("channel"):
        display_names = [
            (dn.text or "").strip()
            for dn in chan.findall("display-name")
            if dn.text
        ]
        for dn in display_names:
            if channel_number and dn.strip() == channel_number:
                return chan.get("id")
            if channel_number and dn.strip().split(" ", 1)[0] == channel_number:
                return chan.get("id")
        if channel_name:
            for dn in display_names:
                if dn.strip().lower() == channel_name:
                    return chan.get("id")
    return None


def fetch_now_next(
    tunarr_base_url: str,
    tunarr_channel_id: str,
    channel_number: str = "",
    channel_name: str = "",
    guide_path: str = "/api/xmltv.xml",
):
    """
    Returns dict: {
      "now_title": str, "now_stop": datetime,
      "next_title": str | None, "next_start": datetime | None
    }
    Raises RuntimeError with a human-readable message on failure.

    tunarr_channel_id is the Tunarr REST API channel UUID - kept for reference/future API calls,
    but the XMLTV guide uses its own synthetic id per channel, so channel_number (and/or
    channel_name) is used to resolve the real id to filter <programme> entries against.
    """
    url = tunarr_base_url.rstrip("/") + guide_path
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"Couldn't fetch Tunarr guide at {url}: {e}")

    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError as e:
        raise RuntimeError(f"Tunarr guide XML didn't parse: {e}")

    xmltv_channel_id = _resolve_xmltv_channel_id(root, channel_number, channel_name)
    if xmltv_channel_id is None:
        raise RuntimeError(
            f"Couldn't find channel number '{channel_number}' (name '{channel_name}') in the "
            "Tunarr guide's <channel> list. Double check the channel selection for this profile."
        )

    now = datetime.now(timezone.utc)
    programmes = []
    for prog in root.findall("programme"):
        if prog.get("channel") != xmltv_channel_id:
            continue
        start = _parse_xmltv_time(prog.get("start"))
        stop = _parse_xmltv_time(prog.get("stop"))
        title_el = prog.find("title")
        title = title_el.text.strip() if title_el is not None and title_el.text else "Unknown"
        programmes.append((start, stop, title))

    if not programmes:
        raise RuntimeError(
            f"No programmes found for resolved guide channel '{xmltv_channel_id}' "
            f"(Tunarr channel number '{channel_number}'). The channel's lineup may be empty, "
            "or the guide hasn't generated yet."
        )

    # Ignore guide entries that aren't real shows: our own bumpers, other short
    # filler (bumpers, ads, IDs), and flex blocks Tunarr titles with the channel name.
    channel_name_lc = (channel_name or "").strip().lower()

    def _is_show(p):
        start, stop, title = p
        t = title.strip().lower()
        if t.endswith(" - up next"):
            return False
        if channel_name_lc and t == channel_name_lc:
            return False
        return (stop - start).total_seconds() >= FILLER_MAX_SECONDS

    shows = [p for p in programmes if _is_show(p)] or programmes
    shows.sort(key=lambda p: p[0])

    # Find the current show plus the two after it. Between shows (e.g. while this
    # bumper plays as post-roll filler), "current" is the show that just ended.
    idx = next((k for k, (start, stop, _t) in enumerate(shows) if start <= now < stop), None)
    if idx is None:
        past = [k for k, p in enumerate(shows) if p[1] <= now]
        future = [k for k, p in enumerate(shows) if p[0] > now]
        if past:
            idx = past[-1]
        elif future:
            idx = future[0]
        else:
            idx = len(shows) - 1

    def at(k):
        return shows[k] if 0 <= k < len(shows) else None

    current, upcoming, later = at(idx), at(idx + 1), at(idx + 2)
    result = {
        "now_title": current[2],
        "now_stop": current[1],
        "next_title": upcoming[2] if upcoming else None,
        "next_start": upcoming[0] if upcoming else None,
        "later_title": later[2] if later else None,
        "later_start": later[0] if later else None,
    }
    return result


def format_next_time(dt: datetime) -> str:
    if dt is None:
        return ""
    local = dt.astimezone()  # convert to system-local tz of the container
    return local.strftime("%-I:%M %p") if os.name != "nt" else local.strftime("%I:%M %p").lstrip("0")


# ---------------------------------------------------------------------------
# TTS via Piper (optional)
# ---------------------------------------------------------------------------

def generate_tts(text: str, voice: str, out_wav_path: str) -> bool:
    """Returns True if audio was generated, False if TTS is unavailable/disabled."""
    if not text.strip():
        return False
    try:
        proc = subprocess.run(
            ["piper", "--model", voice, "--output_file", out_wav_path],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0:
            return False
        return os.path.exists(out_wav_path) and os.path.getsize(out_wav_path) > 0
    except FileNotFoundError:
        return False
    except Exception:
        return False


# ---------------------------------------------------------------------------
# ffmpeg rendering
# ---------------------------------------------------------------------------

def _escape_drawtext(text: str) -> str:
    # ffmpeg drawtext needs backslash, colon, single-quote and percent escaped.
    # Order matters: backslash first, then the rest.
    text = text.replace("\\", "\\\\")
    text = text.replace(":", "\\:")
    text = text.replace("%", "\\%")
    text = text.replace("'", "\u2019")  # swap to a typographic apostrophe, which drawtext handles cleanly
    return text


def _run_ffmpeg(cmd: list, cpu_limit_percent: int = 0, timeout: int = 180):
    """
    Runs an ffmpeg (or related) command, optionally hard-capped to a percentage of one CPU
    core via cpulimit (100 = one full core, regardless of how many threads ffmpeg spawns
    internally - this throttles actual usage, not just thread count). 0/None = unlimited.
    Falls back to running unwrapped if cpulimit isn't installed, rather than failing the render.
    """
    full_cmd = cmd
    if cpu_limit_percent and cpu_limit_percent > 0:
        full_cmd = ["cpulimit", "-l", str(int(cpu_limit_percent)), "--"] + cmd
    try:
        return subprocess.run(full_cmd, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        if full_cmd is not cmd:
            # cpulimit binary missing - don't let a resource-limiting feature block rendering entirely
            return subprocess.run(cmd, capture_output=True, timeout=timeout)
        raise


def render_bumper(
    background: dict,
    resolution: str,
    duration_seconds: float,
    shapes: list,
    fields: list,
    font_path: str,
    audio_path: str | None,
    out_path: str,
    cpu_limit_percent: int = 0,
):
    """
    background: { "path": str, "type": "image" | "gif" | "video" }
    shapes: list of dicts, each a rectangle:
      { "x_pct": float, "y_pct": float, "width_pct": float, "height_pct": float,
        "color": "#RRGGBB", "opacity": float (0-1) }
    fields: list of dicts, each:
      { "text": str, "x_pct": float, "y_pct": float, "font_size": int, "color": "#RRGGBB",
        "outline_width": int (0 = none), "outline_color": "#RRGGBB",
        "shadow_enabled": bool, "shadow_color": "#RRGGBB", "shadow_x": int, "shadow_y": int }
    cpu_limit_percent: 0 = unlimited; otherwise caps ffmpeg to that % of one CPU core
      (e.g. 50 = half a core), trading render speed for lower system impact.
    """
    width, height = (resolution.split("x") + ["1920", "1080"])[:2]
    width, height = int(width), int(height)
    bg_type = background.get("type", "image")

    filters = [f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"]
    if bg_type == "gif":
        filters.append("loop=loop=-1:size=32767")

    for shape in shapes or []:
        x = int(shape.get("x_pct", 0) / 100 * width)
        y = int(shape.get("y_pct", 80) / 100 * height)
        w = int(shape.get("width_pct", 100) / 100 * width)
        h = int(shape.get("height_pct", 20) / 100 * height)
        color = shape.get("color", "#000000").lstrip("#")
        opacity = shape.get("opacity", 0.6)
        filters.append(f"drawbox=x={x}:y={y}:w={w}:h={h}:color=0x{color}@{opacity}:t=fill")

    for f in fields:
        if not f.get("text"):
            continue
        x = int(f.get("x_pct", 10) / 100 * width)
        y = int(f.get("y_pct", 70) / 100 * height)
        size = int(f.get("font_size", 42))
        color = f.get("color", "#FFFFFF").lstrip("#")
        text = _escape_drawtext(f["text"])
        fontfile_arg = f":fontfile='{font_path}'" if font_path and os.path.exists(font_path) else ""
        alpha_expr = f"if(lt(t\\,0.5)\\,t/0.5\\,if(gt(t\\,{duration_seconds-0.5})\\,({duration_seconds}-t)/0.5\\,1))"

        extra = ""
        outline_width = f.get("outline_width", 0)
        if outline_width:
            outline_color = f.get("outline_color", "#000000").lstrip("#")
            extra += f":borderw={int(outline_width)}:bordercolor=0x{outline_color}"
        if f.get("shadow_enabled"):
            shadow_color = f.get("shadow_color", "#000000").lstrip("#")
            shadow_x = f.get("shadow_x", 2)
            shadow_y = f.get("shadow_y", 2)
            extra += f":shadowcolor=0x{shadow_color}@0.7:shadowx={int(shadow_x)}:shadowy={int(shadow_y)}"
        elif not outline_width:
            # sane default so text stays legible even with no explicit styling
            extra += ":shadowcolor=black@0.6:shadowx=2:shadowy=2"

        filters.append(
            f"drawtext=text='{text}'{fontfile_arg}:fontcolor=0x{color}:fontsize={size}"
            f":x={x}:y={y}:alpha='{alpha_expr}'{extra}"
        )

    vf = ",".join(filters)

    cmd = ["ffmpeg", "-y"]
    if bg_type in ("gif", "video"):
        cmd += ["-stream_loop", "-1", "-i", background["path"]]
    else:
        cmd += ["-loop", "1", "-i", background["path"]]

    if audio_path and os.path.exists(audio_path):
        cmd += ["-i", audio_path]

    cmd += ["-vf", vf, "-t", str(duration_seconds), "-pix_fmt", "yuv420p"]

    if audio_path and os.path.exists(audio_path):
        cmd += ["-c:v", "libx264", "-c:a", "aac", "-shortest"]
    else:
        cmd += ["-c:v", "libx264", "-an"]

    cmd += [out_path]

    # A throttled render takes proportionally longer - stretch the timeout accordingly
    # instead of a fixed window that would kill a deliberately-slow render partway through.
    timeout = 180
    if cpu_limit_percent and cpu_limit_percent > 0:
        timeout = min(int(180 * max(1, 100 / cpu_limit_percent)), 1800)

    proc = _run_ffmpeg(cmd, cpu_limit_percent=cpu_limit_percent, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode(errors='ignore')[-2000:]}")


# ---------------------------------------------------------------------------
# audio mixing: narration + background music
# ---------------------------------------------------------------------------

def mix_audio(
    narration_path: str | None,
    music_path: str | None,
    duration_seconds: float,
    out_path: str,
    cpu_limit_percent: int = 0,
) -> str | None:
    """
    Combines optional narration and optional looped background music into a single
    track. Returns out_path if anything was produced, or None if both inputs are absent.
    Music is ducked under narration when both are present.
    """
    if not narration_path and not music_path:
        return None

    if narration_path and not music_path:
        return narration_path

    timeout = 60
    if cpu_limit_percent and cpu_limit_percent > 0:
        timeout = min(int(60 * max(1, 100 / cpu_limit_percent)), 600)

    if music_path and not narration_path:
        cmd = [
            "ffmpeg", "-y", "-stream_loop", "-1", "-i", music_path,
            "-t", str(duration_seconds),
            "-af", f"afade=t=out:st={max(duration_seconds - 0.75, 0)}:d=0.75,volume=0.6",
            "-c:a", "aac", out_path,
        ]
        proc = _run_ffmpeg(cmd, cpu_limit_percent=cpu_limit_percent, timeout=timeout)
        if proc.returncode != 0:
            return narration_path  # fall back gracefully
        return out_path

    # both present: duck music under narration
    cmd = [
        "ffmpeg", "-y",
        "-i", narration_path,
        "-stream_loop", "-1", "-i", music_path,
        "-filter_complex",
        f"[1:a]volume=0.25,afade=t=out:st={max(duration_seconds - 0.75, 0)}:d=0.75[m];"
        f"[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]",
        "-map", "[aout]", "-t", str(duration_seconds),
        "-c:a", "aac", out_path,
    ]
    proc = _run_ffmpeg(cmd, cpu_limit_percent=cpu_limit_percent, timeout=timeout)
    if proc.returncode != 0:
        return narration_path  # fall back gracefully
    return out_path


# ---------------------------------------------------------------------------
# Tunarr integration so the new file actually becomes playable filler.
# No Plex involved - the bumper folder is registered directly in Tunarr as a
# Local Media Source, so we only ever need to tell Tunarr to rescan it.
# ---------------------------------------------------------------------------

def trigger_tunarr_media_source_scan(tunarr_base_url: str, media_source_id: str, library_id: str):
    url = tunarr_base_url.rstrip("/") + f"/api/media-sources/{media_source_id}/libraries/{library_id}/scan"
    resp = requests.post(url, timeout=30)
    resp.raise_for_status()


def list_tunarr_channels(tunarr_base_url: str):
    url = tunarr_base_url.rstrip("/") + "/api/channels"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return [{"id": c.get("id"), "name": c.get("name"), "number": c.get("number")} for c in data]


def list_tunarr_media_sources(tunarr_base_url: str):
    url = tunarr_base_url.rstrip("/") + "/api/media-sources"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json()
