# Tunarr Bumper Studio

A self-hosted web app that generates "You're Watching X / Up Next Y" bumpers for
Tunarr channels, with a visual editor for background, font, colors, and text
placement — per channel, so you can run it across your whole lineup.

## How it works

1. On a timer (per channel, configurable — default 10 minutes, since Tunarr
   currently can't splice mid-block, so this only needs to catch show-to-show
   changes, not anything finer), it reads the Tunarr XMLTV guide to find
   what's currently airing and what's next.
2. It renders a short video with ffmpeg using your chosen background image/gif,
   font, colors, and text positions — optionally with Piper TTS narration.
3. It overwrites the bumper file in a folder that's registered directly in
   Tunarr as a **Local Media Source**, then tells Tunarr to rescan that source
   so the updated file is available as filler.

No Plex, Jellyfin, or Emby involved anywhere in this — Tunarr's local media
source scans the filesystem itself, so this works the same way regardless of
what (if anything) you use as your main media server, and keeps working if you
ever move off Plex.

## One-time setup

### 1. Add a Local Media Source in Tunarr
In Tunarr, go to **Settings → Media Sources → Add → Local** and point it at a
folder, e.g. `/media/bumpers` on the Tunarr host. This is the folder this app
will write into. Since these are unstructured clips (not TV/movie content), you
shouldn't need NFO metadata files for them.

Note the **media source id** and the **library id** it creates — you can find
these via `GET /api/media-sources` on your Tunarr instance, or just use the
app's dropdowns once it can reach Tunarr.

### 2. Add each bumper as filler on its channel
The *first* time a channel's bumper is generated, go into that channel's Tunarr
filler settings and add the new item as filler content for that channel. After
that, regenerating just overwrites the same file/item in place.

### 3. Mount matching paths
The docker-compose file mounts a host folder into this app at `/data/output` —
**this must be the same host path you pointed Tunarr's local media source at**,
or Tunarr won't see the files this app writes. Edit the volume line in
`docker-compose.yml` before deploying.

## Deploying via Portainer

The image is built automatically by GitHub Actions on every push to `main` and
published to `ghcr.io/embargo1094/tunarr-bumper-studio:latest`. Nothing is
built on the server.

1. In Portainer, **Stacks → Add stack** (or edit the existing stack), paste
   `docker-compose.yml`, deploy.
2. The app is at `http://<host>:8420`.

## Updating

Automatic: the stack carries the Watchtower label, so Watchtower pulls new
versions on its own. To update right away instead, open the stack in Portainer
→ **Update the stack** with **Re-pull image** turned on.

Channel profiles, settings and uploads live in named volumes and survive
updates, as long as you keep updating the same stack rather than creating a
new one under a different name.

## Using the app

1. **Settings tab** — enter your Tunarr base URL. Save.
2. **Channels tab → + New Channel** — pick the Tunarr channel and the local
   media source/library id from the dropdowns.
3. **Backgrounds** — upload as many images, gifs, or video clips as you want.
   One is picked at random every time the bumper regenerates, so a channel can
   cycle through a whole pool of looks instead of always using the same one.
   Video backgrounds give you much better quality per MB than an animated gif
   at the same resolution — prefer video for anything longer or more detailed.
4. **Background music** — optional, same idea: upload several tracks and one
   is picked at random per generation. If voice narration is also on, music
   automatically ducks quietly underneath it; with narration off, music plays
   at normal volume and fades out at the end of the clip.
5. **Rectangles / bars** — add one or more solid-color boxes (e.g. a bar
   across the bottom 20% of the frame for text to sit on), each with its own
   position, size, color, and opacity, all in % of the frame so they scale
   with any resolution.
6. **Text styling** — each of the two text fields ("You're Watching" / "Up
   Next") has its own color, size, position (drag on the canvas), outline
   width/color, and drop shadow color/offset.
7. Click **Render Real Preview** to see actual ffmpeg output before going
   live — the canvas preview is a fast approximation (and can't show video
   backgrounds animating), so always check the real render once before
   trusting a look.
8. Click **Save Channel** — this schedules automatic regeneration at your
   chosen interval. **Generate & Push Now** runs it immediately.

## Voice narration (optional)

Narration uses [Piper](https://github.com/rhasspy/piper) (installed via the
`piper-tts` pip package in the image). Piper needs a voice model — download a
`.onnx` + `.onnx.json` pair from the
[Piper voices repo](https://huggingface.co/rhasspy/piper-voices), place both
files somewhere under the `bumper_uploads` volume (e.g. copy them in via
`docker cp` or a bind mount), and set the "Piper voice model path" field to the
`.onnx` file's path inside the container. Leave narration off if you'd rather
skip this.

## CPU usage

By default renders are unlimited. If you'd rather trade render speed for a
lighter footprint on the host, set a **CPU limit** in the Settings tab —
e.g. 50 caps ffmpeg to about half a CPU core, regardless of how many threads
it spawns internally. 0 means unlimited. This applies to every channel's
renders; there's no per-channel override. Since renders already only happen
on your regeneration interval (not continuously), a lower limit just makes
each individual render take longer — it doesn't affect anything else about
how often bumpers update.

## Text lines

Each bumper has two text lines. Each line is free text with placeholders:

| Placeholder | Fills in |
|---|---|
| `{show}`, `{time}` | the show picked in that line's dropdown, and its start time |
| `{current}`, `{current_time}` | the current show (the one that just ended, when the bumper plays after an episode) |
| `{next}`, `{next_time}` | the next show (`{nextshow}` works too) |
| `{later}`, `{later_time}` | the show after next |

New profiles default to `UP NEXT: {show}` (next show) and `FOLLOWED BY: {show}`
(show after next). Example with times: `UP NEXT: {next} AT {next_time}`. A line
that names a show the guide doesn't have yet is left off; an unknown placeholder
is left as typed so typos are easy to spot. Profiles saved before templates
existed are converted automatically, keeping their wording.

Narration reads the same lines. Typed words in ALL CAPS are read as normal
words, and a colon becomes a short pause; show names and times are read as-is.

"Fade text and music in/out" (on by default) fades the text over the first and
last half second and fades the music out at the end. Turn it off for hard cuts.

Start times use the `TZ` setting in the stack (default `America/New_York`).

## Multiple channels

Each channel profile writes its own file, named after the profile:
`Bumpers/<Channel name>/<Channel name> - Up Next.mp4`. They all live in the
one "Generated Bumpers" library in Tunarr; add each channel's file only to
that channel's filler list. Renaming a profile renames its file (and Tunarr
will see it as a new item); deleting a profile removes its file.

Only one bumper renders at a time across the whole app. When several channels
are due at once they queue up, so the CPU limit holds for the app as a whole.
Saving a profile renders it right away. "Render Real Preview" writes to a
separate preview file and never touches what Tunarr plays.

## Storage notes

Rendered clips are a few MB and only regenerate on the interval you set (a few
minutes is plenty) — that's well under the daily write volume that would
matter for SSD wear or NAS load, even continuously over years.

## Files

- `Dockerfile`, `docker-compose.yml` — image + stack definition
- `app/main.py` — FastAPI backend, channel storage, scheduler
- `app/bumper_engine.py` — Tunarr guide parsing, ffmpeg rendering, TTS, Plex/Tunarr rescan calls
- `app/static/` — the web GUI (vanilla HTML/CSS/JS, canvas-based placement editor)
