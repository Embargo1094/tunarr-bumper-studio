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
log = logging.getLogger("bumper-studio")

SETTINGS_FILE = CONFIG_DIR / "settings.json"
CHANNELS_FILE = CONFIG_DIR / "channels.json"

app = FastAPI(title="Tunarr Bumper Studio")
scheduler = BackgroundScheduler()

DEFAULT_SETTINGS = {
    "tunarr_base_url": "http://tunarr:8000",
    "cpu_limit_percent": 0,  # 0 = unlimited; otherwise caps ffmpeg to that % of one CPU core
}

DEFAULT_FIELDS = {
    "now_watching": {
        "prefix": "YOU'RE WATCHING", "x_pct": 8, "y_pct": 68, "font_size": 52, "color": "#FFD400",
        "outline_width": 0, "outline_color": "#000000",
        "shadow_enabled": True, "shadow_color": "#000000", "shadow_x": 2, "shadow_y": 2,
    },
    "up_next": {
        "prefix": "UP NEXT", "x_pct": 8, "y_pct": 80, "font_size": 40, "color": "#FFFFFF",
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

def _build_fields(channel: dict, now_title: str, next_title: str, next_time: str):
    fields = []
    nw = channel.get("now_watching") or DEFAULT_FIELDS["now_watching"]
    nw_prefix = nw.get("prefix", "YOU'RE WATCHING")
    fields.append({
        "text": f"{nw_prefix}: {now_title}",
        "x_pct": nw.get("x_pct", 8), "y_pct": nw.get("y_pct", 68),
        "font_size": nw.get("font_size", 52), "color": nw.get("color", "#FFD400"),
        "outline_width": nw.get("outline_width", 0), "outline_color": nw.get("outline_color", "#000000"),
        "shadow_enabled": nw.get("shadow_enabled", True), "shadow_color": nw.get("shadow_color", "#000000"),
        "shadow_x": nw.get("shadow_x", 2), "shadow_y": nw.get("shadow_y", 2),
    })
    if next_title:
        un = channel.get("up_next") or DEFAULT_FIELDS["up_next"]
        text = f"{un.get('prefix', 'UP NEXT')}: {next_title}"
        if next_time:
            text += f" AT {next_time}"
        fields.append({
            "text": text,
            "x_pct": un.get("x_pct", 8), "y_pct": un.get("y_pct", 80),
            "font_size": un.get("font_size", 40), "color": un.get("color", "#FFFFFF"),
            "outline_width": un.get("outline_width", 0), "outline_color": un.get("outline_color", "#000000"),
            "shadow_enabled": un.get("shadow_enabled", True), "shadow_color": un.get("shadow_color", "#000000"),
            "shadow_x": un.get("shadow_x", 2), "shadow_y": un.get("shadow_y", 2),
        })
    return fields


def generate_for_channel(channel: dict, use_placeholder: bool = False):
    """Renders one channel's bumper. Holds RENDER_LOCK, so renders from the
    scheduler and from the buttons in the UI all queue up and run one at a time."""
    with RENDER_LOCK:
        return _render_channel(channel, use_placeholder)


def _render_channel(channel: dict, use_placeholder: bool = False):
    settings = get_settings()

    if use_placeholder:
        now_title, next_title, next_time = "Example Show", "Next Example Show", "8:30 PM"
    else:
        info = engine.fetch_now_next(
            settings["tunarr_base_url"], channel["tunarr_channel_id"],
            channel_number=channel.get("tunarr_channel_number", ""),
            channel_name=channel.get("tunarr_channel_name", ""),
        )
        now_title = info["now_title"]
        next_title = info["next_title"]
        next_time = engine.format_next_time(info["next_start"]) if info["next_start"] else ""

    fields = _build_fields(channel, now_title, next_title, next_time)
    duration = channel.get("duration_seconds", 6.0)
    cpu_limit_percent = settings.get("cpu_limit_percent", 0)

    narration_path = None
    if channel.get("tts_enabled"):
        narration = f"You're watching {now_title}."
        if next_title:
            narration += f" Up next, {next_title}" + (f", at {next_time}." if next_time else ".")
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        if engine.generate_tts(narration, channel.get("tts_voice", ""), tmp_wav):
            narration_path = tmp_wav

    music_tracks = channel.get("music_tracks") or []
    music_path = random.choice(music_tracks)["path"] if music_tracks else None

    audio_path = None
    if narration_path or music_path:
        tmp_audio = tempfile.NamedTemporaryFile(suffix=".m4a", delete=False).name
        audio_path = engine.mix_audio(narration_path, music_path, duration, tmp_audio, cpu_limit_percent=cpu_limit_percent)

    if use_placeholder:
        final_path = PREVIEW_DIR / f"{channel['id']}.mp4"
    else:
        final_path = output_path_for(channel)
    tmp_out = WORK_DIR / f"render_{uuid.uuid4().hex}.mp4"

    backgrounds = channel.get("backgrounds") or []
    valid_backgrounds = [b for b in backgrounds if b.get("path") and os.path.exists(b["path"])]
    if not valid_backgrounds:
        raise RuntimeError("No background image/gif/video configured for this channel.")
    background = random.choice(valid_backgrounds)

    try:
        engine.render_bumper(
            background=background,
            resolution=channel.get("resolution", "1920x1080"),
            duration_seconds=duration,
            shapes=channel.get("shapes") or [],
            fields=fields,
            cpu_limit_percent=cpu_limit_percent,
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


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
