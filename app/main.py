import json
import logging
import os
import random
import re
import shutil
import tempfile
import threading
import uuid
from datetime import datetime
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import bumper_engine as engine

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_DIR = DATA_DIR / "config"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "output"
# Renders happen here first, then get moved into OUTPUT_DIR finished, so Tunarr
# never sees a half-written file. Previews live here too and never reach Tunarr.
WORK_DIR = DATA_DIR / "work"
PREVIEW_DIR = WORK_DIR / "previews"
for d in (CONFIG_DIR, UPLOAD_DIR, OUTPUT_DIR, WORK_DIR, PREVIEW_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Only one bumper renders at a time across the whole app, so the CPU limit
# holds no matter how many channels are due at once.
RENDER_LOCK = threading.Lock()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bumper-studio")

SETTINGS_FILE = CONFIG_DIR / "settings.json"
CHANNELS_FILE = CONFIG_DIR / "channels.json"
ROTATION_FILE = CONFIG_DIR / "rotation.json"

app = FastAPI(title="Tunarr Bumper Studio")
scheduler = BackgroundScheduler()

DEFAULT_SETTINGS = {
    "tunarr_base_url": "http://tunarr:8000",
    "cpu_limit_percent": 0,  # 0 = unlimited; otherwise caps ffmpeg to that % of one CPU core
}

DEFAULT_FIELDS = {
    "now_watching": {
        "template": "UP NEXT: {show}", "source": "next",
        "x_pct": 8, "y_pct": 68, "font_size": 52, "color": "#FFD400",
        "outline_width": 0, "outline_color": "#000000",
        "shadow_enabled": True, "shadow_color": "#000000", "shadow_x": 2, "shadow_y": 2,
    },
    "up_next": {
        "template": "FOLLOWED BY: {show}", "source": "after_next",
        "x_pct": 8, "y_pct": 80, "font_size": 40, "color": "#FFFFFF",
        "outline_width": 0, "outline_color": "#000000",
        "shadow_enabled": True, "shadow_color": "#000000", "shadow_x": 2, "shadow_y": 2,
    },
}


# ---------------------------------------------------------------------------
# storage helpers
# ---------------------------------------------------------------------------

def load_json(path: Path, default):
    if not path.exists():
        return default
    with open(path) as f:
        return json.load(f)


def save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def get_settings():
    return load_json(SETTINGS_FILE, DEFAULT_SETTINGS)


def get_channels():
    return load_json(CHANNELS_FILE, [])


def save_channels(channels):
    save_json(CHANNELS_FILE, channels)


def _safe_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".")
    return cleaned or "Channel"


def output_folder_name(channel: dict, channels: list | None = None) -> str:
    """Readable per-channel folder name, e.g. "Adult Swim". Two profiles with the
    same name get a short id suffix so their files never collide."""
    base = _safe_name(channel.get("name"))
    others = channels if channels is not None else get_channels()
    if any(c["id"] != channel["id"] and _safe_name(c.get("name")).lower() == base.lower() for c in others):
        base = f"{base} ({channel['id'][:6]})"
    return base


def output_path_for(channel: dict, channels: list | None = None) -> Path:
    folder = output_folder_name(channel, channels)
    return OUTPUT_DIR / folder / f"{folder} - Up Next.mp4"


def _remove_output_folder(folder: Path):
    # Only ever delete direct children of OUTPUT_DIR.
    try:
        if folder.exists() and folder.resolve().parent == OUTPUT_DIR.resolve():
            shutil.rmtree(folder)
    except Exception as e:
        log.warning("Couldn't remove old output folder %s: %s", folder, e)


def pick_rotating(channel_id: str, pool_name: str, paths: list[str]) -> str | None:
    """Shuffle-bag pick: goes through every item in a random order before any
    repeats, and never picks the same item twice in a row. State is kept in
    rotation.json so it survives restarts. Callers hold RENDER_LOCK."""
    if not paths:
        return None
    if len(paths) == 1:
        return paths[0]
    state = load_json(ROTATION_FILE, {})
    entry = state.setdefault(channel_id, {}).setdefault(pool_name, {"queue": [], "last": None})
    queue = [p for p in entry.get("queue", []) if p in paths]
    if not queue:
        queue = paths[:]
        random.shuffle(queue)
        if queue[0] == entry.get("last"):
            swap = random.randrange(1, len(queue))
            queue[0], queue[swap] = queue[swap], queue[0]
    choice = queue.pop(0)
    entry["queue"], entry["last"] = queue, choice
    save_json(ROTATION_FILE, state)
    return choice


def get_channel_or_404(channel_id: str):
    for c in get_channels():
        if c["id"] == channel_id:
            return c
    raise HTTPException(404, "channel not found")


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------

class Settings(BaseModel):
    tunarr_base_url: str
    cpu_limit_percent: int = 0


class ChannelIn(BaseModel):
    name: str
    tunarr_channel_id: str
    tunarr_channel_number: str = ""
    tunarr_channel_name: str = ""
    tunarr_media_source_id: str = ""
    tunarr_library_id: str = ""
    interval_minutes: int = 10
    resolution: str = "1920x1080"
    duration_seconds: float = 6.0
    backgrounds: list = []       # [{ "path": str, "type": "image"|"gif"|"video", "name": str }]
    music_tracks: list = []      # [{ "path": str, "name": str }]
    shapes: list = []            # [{ x_pct, y_pct, width_pct, height_pct, color, opacity }]
    font_path: str = ""
    now_watching: dict = None
    up_next: dict = None
    fade_enabled: bool = True
    tts_enabled: bool = False
    tts_voice: str = ""
    enabled: bool = True


# ---------------------------------------------------------------------------
# settings endpoints
# ---------------------------------------------------------------------------

@app.get("/api/settings")
def api_get_settings():
    return get_settings()


@app.put("/api/settings")
def api_put_settings(settings: Settings):
    save_json(SETTINGS_FILE, settings.dict())
    return settings


# ---------------------------------------------------------------------------
# channel CRUD
# ---------------------------------------------------------------------------

@app.get("/api/channels")
def api_list_channels():
    return get_channels()


@app.post("/api/channels")
def api_create_channel(ch: ChannelIn):
    channels = get_channels()
    new_id = str(uuid.uuid4())
    data = ch.dict()
    data["id"] = new_id
    if not data.get("now_watching"):
        data["now_watching"] = DEFAULT_FIELDS["now_watching"]
    if not data.get("up_next"):
        data["up_next"] = DEFAULT_FIELDS["up_next"]
    channels.append(data)
    save_channels(channels)
    _schedule_channel(data, run_now=True)
    return data


@app.put("/api/channels/{channel_id}")
def api_update_channel(channel_id: str, ch: ChannelIn):
    channels = get_channels()
    for i, c in enumerate(channels):
        if c["id"] == channel_id:
            old_folder = output_path_for(c, channels).parent
            data = ch.dict()
            data["id"] = channel_id
            channels[i] = data
            save_channels(channels)
            new_folder = output_path_for(data, channels).parent
            if old_folder != new_folder:
                _remove_output_folder(old_folder)
            _remove_output_folder(OUTPUT_DIR / channel_id)  # pre-rename layout
            _schedule_channel(data, run_now=True)
            return data
    raise HTTPException(404, "channel not found")


@app.delete("/api/channels/{channel_id}")
def api_delete_channel(channel_id: str):
    all_channels = get_channels()
    doomed = next((c for c in all_channels if c["id"] == channel_id), None)
    channels = [c for c in all_channels if c["id"] != channel_id]
    save_channels(channels)
    job_id = f"channel-{channel_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    if doomed:
        _remove_output_folder(output_path_for(doomed, all_channels).parent)
    _remove_output_folder(OUTPUT_DIR / channel_id)
    preview = PREVIEW_DIR / f"{channel_id}.mp4"
    if preview.exists():
        preview.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# uploads (background image/gif, custom font)
# ---------------------------------------------------------------------------

@app.post("/api/uploads/background")
async def upload_background(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    video_exts = (".mp4", ".webm", ".mov", ".mkv")
    if ext == ".gif":
        bg_type = "gif"
    elif ext in (".png", ".jpg", ".jpeg", ".webp"):
        bg_type = "image"
    elif ext in video_exts:
        bg_type = "video"
    else:
        raise HTTPException(400, "background must be an image, gif, or video (mp4/webm/mov/mkv)")
    fname = f"{uuid.uuid4()}{ext}"
    dest = UPLOAD_DIR / fname
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": str(dest), "type": bg_type, "name": file.filename}


@app.post("/api/uploads/music")
async def upload_music(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"):
        raise HTTPException(400, "music must be mp3/wav/ogg/m4a/aac/flac")
    fname = f"{uuid.uuid4()}{ext}"
    dest = UPLOAD_DIR / fname
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": str(dest), "name": file.filename}


@app.post("/api/uploads/font")
async def upload_font(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in (".ttf", ".otf"):
        raise HTTPException(400, "font must be .ttf or .otf")
    fname = f"{uuid.uuid4()}{ext}"
    dest = UPLOAD_DIR / fname
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": str(dest)}


@app.get("/api/uploads/{filename}")
def serve_upload(filename: str):
    path = UPLOAD_DIR / filename
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


# ---------------------------------------------------------------------------
# Tunarr helper lookups (populate GUI dropdowns)
# ---------------------------------------------------------------------------

@app.get("/api/tunarr/channels")
def api_tunarr_channels():
    s = get_settings()
    try:
        return engine.list_tunarr_channels(s["tunarr_base_url"])
    except Exception as e:
        raise HTTPException(502, f"Tunarr lookup failed: {e}")


@app.get("/api/tunarr/media-sources")
def api_tunarr_media_sources():
    s = get_settings()
    try:
        return engine.list_tunarr_media_sources(s["tunarr_base_url"])
    except Exception as e:
        raise HTTPException(502, f"Tunarr lookup failed: {e}")


# ---------------------------------------------------------------------------
# generation
# ---------------------------------------------------------------------------

# Text lines are templates with placeholders filled in at render time.
# {show} / {time} mean the show picked in that line's "Shows" dropdown; the
# others name a specific show no matter what the dropdown says.
PLACEHOLDERS = {
    "show": "show", "time": "time",
    "current": "current", "currentshow": "current", "now": "current",
    "next": "next", "nextshow": "next",
    "later": "after_next", "latershow": "after_next", "after_next": "after_next", "afternext": "after_next",
    "current_time": "current_time", "now_time": "current_time",
    "next_time": "next_time",
    "later_time": "after_next_time", "after_next_time": "after_next_time",
}
SHOW_KEYS = {"show", "current", "next", "after_next"}
PLACEHOLDER_RE = re.compile(r"\{\s*([A-Za-z_]+)\s*\}")

# Profiles saved before templates existed: line 1 named the current show,
# line 2 the next show plus its start time.
LEGACY_LINE_DEFAULTS = {
    "now_watching": {"source": "current", "show_time": False, "prefix": "YOU'RE WATCHING"},
    "up_next": {"source": "next", "show_time": True, "prefix": "UP NEXT"},
}


def _line_settings(channel: dict, key: str) -> dict:
    line = dict(channel.get(key) or DEFAULT_FIELDS[key])
    if "template" not in line:
        legacy = LEGACY_LINE_DEFAULTS[key]
        line.setdefault("source", legacy["source"])
        prefix = (line.get("prefix", legacy["prefix"]) or "").strip()
        template = f"{prefix}: {{show}}" if prefix else "{show}"
        if line.get("show_time", legacy["show_time"]) and line["source"] != "current":
            template += " AT {time}"
        line["template"] = template
    line.setdefault("source", "next")
    return line


def fill_template(template: str, values: dict) -> list[tuple[bool, str]] | None:
    """Returns the line as (is_placeholder, text) segments, or None if it names a
    show the guide doesn't have (so the line is left off instead of half-empty).
    Unknown placeholders are left as typed, so typos are visible."""
    segments, pos = [], 0
    for m in PLACEHOLDER_RE.finditer(template):
        if m.start() > pos:
            segments.append((False, template[pos:m.start()]))
        key = PLACEHOLDERS.get(m.group(1).lower())
        if key is None:
            segments.append((False, m.group(0)))
        else:
            value = values.get(key) or ""
            if key in SHOW_KEYS and not value:
                return None
            segments.append((True, value))
        pos = m.end()
    if pos < len(template):
        segments.append((False, template[pos:]))
    return segments


def _join(segments) -> str:
    return re.sub(r"\s{2,}", " ", "".join(t for _, t in segments)).strip()


def _build_lines(channel: dict, shows: dict) -> list[dict]:
    """shows: {"current": (title, time), "next": (title, time), "after_next": (title, time)}"""
    lines = []
    for key in ("now_watching", "up_next"):
        line = _line_settings(channel, key)
        values = {}
        for name in ("current", "next", "after_next"):
            title, start = shows.get(name) or (None, "")
            values[name], values[f"{name}_time"] = title or "", start or ""
        values["show"] = values.get(line["source"], "")
        values["time"] = values.get(f"{line['source']}_time", "")
        segments = fill_template(line.get("template") or "", values)
        if not segments or not _join(segments):
            continue
        lines.append({
            "text": _join(segments), "segments": segments,
            "x_pct": line.get("x_pct", 8), "y_pct": line.get("y_pct", 68 if key == "now_watching" else 80),
            "align": line.get("align", "left"),
            "font_size": line.get("font_size", 52 if key == "now_watching" else 40),
            "color": line.get("color", "#FFFFFF"),
            "outline_width": line.get("outline_width", 0), "outline_color": line.get("outline_color", "#000000"),
            "shadow_enabled": line.get("shadow_enabled", True), "shadow_color": line.get("shadow_color", "#000000"),
            "shadow_x": line.get("shadow_x", 2), "shadow_y": line.get("shadow_y", 2),
        })
    return lines


def _narration_for(lines: list[dict]) -> str:
    """Speaks the on-screen lines. Typed words in ALL CAPS are read as normal
    words ("UP NEXT" -> "Up next"); show names are kept exactly as they are."""
    sentences = []
    for line in lines:
        spoken = []
        for is_value, text in line["segments"]:
            if not is_value:
                # Only typed text is adjusted; show names and times are read as-is.
                if text.isupper():
                    text = text.lower()
                text = re.sub(r"\s*:\s*", ", ", text)
            spoken.append(text)
        sentence = re.sub(r"\s{2,}", " ", "".join(spoken)).strip(" ,")
        if sentence:
            sentence = sentence[0].upper() + sentence[1:]
            sentences.append(sentence if sentence[-1] in ".!?" else sentence + ".")
    return " ".join(sentences)


def generate_for_channel(channel: dict, use_placeholder: bool = False):
    """Renders one channel's bumper. Holds RENDER_LOCK, so renders from the
    scheduler and from the buttons in the UI all queue up and run one at a time."""
    with RENDER_LOCK:
        return _render_channel(channel, use_placeholder)


def _render_channel(channel: dict, use_placeholder: bool = False):
    settings = get_settings()

    if use_placeholder:
        shows = {
            "current": ("Example Show", "8:00 PM"),
            "next": ("Next Example Show", "8:30 PM"),
            "after_next": ("Later Example Show", "9:00 PM"),
        }
    else:
        info = engine.fetch_now_next(
            settings["tunarr_base_url"], channel["tunarr_channel_id"],
            channel_number=channel.get("tunarr_channel_number", ""),
            channel_name=channel.get("tunarr_channel_name", ""),
        )
        fmt = lambda dt: engine.format_next_time(dt) if dt else ""
        shows = {
            "current": (info["now_title"], fmt(info.get("now_start"))),
            "next": (info["next_title"], fmt(info["next_start"])),
            "after_next": (info.get("later_title"), fmt(info.get("later_start"))),
        }

    fields = _build_lines(channel, shows)
    duration = channel.get("duration_seconds", 6.0)
    cpu_limit_percent = settings.get("cpu_limit_percent", 0)

    narration_path = None
    if channel.get("tts_enabled") and fields:
        narration = _narration_for(fields)
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        if engine.generate_tts(narration, channel.get("tts_voice", ""), tmp_wav):
            narration_path = tmp_wav

    music_tracks = channel.get("music_tracks") or []
    music_paths = [m["path"] for m in music_tracks if m.get("path") and os.path.exists(m["path"])]
    # Previews pick at random so they don't use up the live channel's rotation.
    pick = (lambda _cid, _pool, paths: random.choice(paths) if paths else None) if use_placeholder else pick_rotating
    music_path = pick(channel["id"], "music", music_paths)

    audio_path = None
    if narration_path or music_path:
        tmp_audio = tempfile.NamedTemporaryFile(suffix=".m4a", delete=False).name
        audio_path = engine.mix_audio(narration_path, music_path, duration, tmp_audio, cpu_limit_percent=cpu_limit_percent,
                                      fade=channel.get("fade_enabled", True))

    if use_placeholder:
        final_path = PREVIEW_DIR / f"{channel['id']}.mp4"
    else:
        final_path = output_path_for(channel)
    tmp_out = WORK_DIR / f"render_{uuid.uuid4().hex}.mp4"

    backgrounds = channel.get("backgrounds") or []
    valid_backgrounds = [b for b in backgrounds if b.get("path") and os.path.exists(b["path"])]
    if not valid_backgrounds:
        raise RuntimeError("No background image/gif/video configured for this channel.")
    bg_path = pick(channel["id"], "backgrounds", [b["path"] for b in valid_backgrounds])
    background = next(b for b in valid_backgrounds if b["path"] == bg_path)
    log.info(
        "Rendering %s for '%s': background %s, music %s",
        "preview" if use_placeholder else "bumper", channel.get("name"),
        background.get("name") or os.path.basename(bg_path),
        os.path.basename(music_path) if music_path else "none",
    )

    try:
        engine.render_bumper(
            background=background,
            resolution=channel.get("resolution", "1920x1080"),
            duration_seconds=duration,
            shapes=channel.get("shapes") or [],
            fields=fields,
            cpu_limit_percent=cpu_limit_percent,
            fade=channel.get("fade_enabled", True),
            font_path=channel.get("font_path", ""),
            audio_path=audio_path,
            out_path=str(tmp_out),
        )
    except Exception:
        if tmp_out.exists():
            tmp_out.unlink()
        raise

    _publish(tmp_out, final_path)
    if audio_path and os.path.exists(audio_path):
        os.remove(audio_path)
    if narration_path and narration_path != audio_path and os.path.exists(narration_path):
        os.remove(narration_path)

    if not use_placeholder:
        try:
            if channel.get("tunarr_media_source_id") and channel.get("tunarr_library_id"):
                engine.trigger_tunarr_media_source_scan(
                    settings["tunarr_base_url"], channel["tunarr_media_source_id"],
                    channel["tunarr_library_id"],
                )
        except Exception as e:
            # Rendering succeeded even if the rescan hook failed - surface as a warning, not a hard error.
            return {"ok": True, "file": str(final_path), "rescan_warning": str(e)}

    return {"ok": True, "file": str(final_path)}


def _publish(src: Path, final_path: Path):
    """Moves a finished render into place. The copy lands under a hidden
    non-video name first, then gets renamed, so Tunarr only ever sees a
    complete file."""
    final_path.parent.mkdir(parents=True, exist_ok=True)
    staging = final_path.parent / f".{final_path.name}.partial"
    shutil.copyfile(src, staging)
    os.replace(staging, final_path)
    src.unlink()


@app.post("/api/channels/{channel_id}/generate")
def api_generate(channel_id: str):
    channel = get_channel_or_404(channel_id)
    try:
        return generate_for_channel(channel)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/channels/{channel_id}/preview")
def api_preview(channel_id: str):
    channel = get_channel_or_404(channel_id)
    try:
        result = generate_for_channel(channel, use_placeholder=True)
        return {"ok": True, "preview_url": f"/api/channels/{channel_id}/preview.mp4"}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/channels/{channel_id}/preview.mp4")
def serve_preview(channel_id: str):
    path = PREVIEW_DIR / f"{channel_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "no preview rendered yet")
    return FileResponse(path, media_type="video/mp4")


# ---------------------------------------------------------------------------
# scheduler
# ---------------------------------------------------------------------------

def _scheduled_render(channel_id: str):
    # Always render from the latest saved profile, not a copy captured at scheduling time.
    channel = next((c for c in get_channels() if c["id"] == channel_id), None)
    if channel is None:
        return
    try:
        generate_for_channel(channel)
    except Exception as e:
        log.error("Bumper render failed for %s: %s", channel.get("name"), e)


def _schedule_channel(channel: dict, run_now: bool = False):
    job_id = f"channel-{channel['id']}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    if channel.get("enabled", True):
        kwargs = {"next_run_time": datetime.now()} if run_now else {}
        scheduler.add_job(
            _scheduled_render, IntervalTrigger(minutes=channel.get("interval_minutes", 10)),
            args=[channel["id"]], id=job_id, replace_existing=True, max_instances=1,
            coalesce=True, misfire_grace_time=None, **kwargs,
        )


@app.on_event("startup")
def on_startup():
    if not SETTINGS_FILE.exists():
        save_json(SETTINGS_FILE, DEFAULT_SETTINGS)
    for leftover in WORK_DIR.glob("render_*.mp4"):
        leftover.unlink()
    scheduler.start()
    channels = get_channels()
    for c in channels:
        legacy = OUTPUT_DIR / c["id"]
        moved = legacy.exists()
        _remove_output_folder(legacy)  # old "<id>/bumper.mp4" layout
        # Render right away if this channel's file doesn't exist yet (first run
        # after this update, or a fresh volume) so Tunarr always has something.
        _schedule_channel(c, run_now=moved or not output_path_for(c, channels).exists())


@app.middleware("http")
async def always_revalidate_frontend(request, call_next):
    """Make browsers check for a newer page/script on every load (a 304 if
    nothing changed). Without this, a browser can keep an old app.js after an
    update; it then crashes against the new page and the editor looks empty."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
