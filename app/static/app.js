const state = {
  channels: [],
  selectedId: null,
  bgImage: null,
  tunarrChannels: [], // [{id, number, name}] from Tunarr, used to resolve number/name at save time
  fields: {
    now_watching: { x_pct: 8, y_pct: 68 },
    up_next: { x_pct: 8, y_pct: 80 },
  },
  backgrounds: [],   // [{path, type, name}]
  music: [],         // [{path, name}]
  shapes: [],        // [{x_pct, y_pct, width_pct, height_pct, color, opacity}]
  uploadedFont: null, // {path}
  dragTarget: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $("preview-canvas");
const ctx = canvas.getContext("2d");

// ---------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------
$("tab-channels").onclick = () => switchTab("channels");
$("tab-settings").onclick = () => switchTab("settings");
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(`tab-${name}`).classList.add("active");
  $(`view-${name}`).classList.remove("hidden");
}

// ---------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------
async function loadSettings() {
  const s = await (await fetch("/api/settings")).json();
  $("s-tunarr-url").value = s.tunarr_base_url || "";
  $("s-cpu-limit").value = s.cpu_limit_percent ?? 0;
}
$("save-settings").onclick = async () => {
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tunarr_base_url: $("s-tunarr-url").value,
      cpu_limit_percent: parseInt($("s-cpu-limit").value) || 0,
    }),
  });
  populateDropdowns();
  alert("Saved.");
};

// ---------------------------------------------------------------------
// dropdowns sourced from Tunarr
// ---------------------------------------------------------------------
async function populateDropdowns() {
  try {
    const chans = await (await fetch("/api/tunarr/channels")).json();
    state.tunarrChannels = chans;
    fillSelect("f-tunarr-channel", chans.map(c => ({ value: c.id, label: `${c.number ?? ""} ${c.name}` })));
  } catch (e) { /* tunarr not reachable yet */ }

  try {
    const sources = await (await fetch("/api/tunarr/media-sources")).json();
    const opts = [];
    (sources || []).forEach(ms => opts.push({ value: ms.id, label: ms.name || ms.id }));
    fillSelect("f-tunarr-mediasource", opts);
  } catch (e) { /* ignore */ }
}
function fillSelect(id, options) {
  const sel = $(id);
  const current = sel.value;
  sel.innerHTML = "";
  options.forEach(o => {
    const el = document.createElement("option");
    el.value = o.value; el.textContent = o.label;
    sel.appendChild(el);
  });
  if (current) sel.value = current;
}

// ---------------------------------------------------------------------
// channel list
// ---------------------------------------------------------------------
async function loadChannels() {
  state.channels = await (await fetch("/api/channels")).json();
  renderChannelList();
}
function renderChannelList() {
  const ul = $("channel-list");
  ul.innerHTML = "";
  state.channels.forEach(c => {
    const li = document.createElement("li");
    li.textContent = c.name;
    if (c.id === state.selectedId) li.classList.add("selected");
    li.onclick = () => selectChannel(c.id);
    ul.appendChild(li);
  });
}
$("new-channel").onclick = () => {
  state.selectedId = null;
  clearEditorForm();
  $("editor-panel").classList.remove("hidden");
};

function selectChannel(id) {
  state.selectedId = id;
  const c = state.channels.find(ch => ch.id === id);
  renderChannelList();
  fillEditorForm(c);
  $("editor-panel").classList.remove("hidden");
}

function clearEditorForm() {
  $("f-name").value = "";
  $("f-tunarr-library").value = "";
  $("f-interval").value = 10;
  $("f-duration").value = 6;
  $("f-resolution").value = "1920x1080";
  $("f-tts").checked = false;
  $("f-fade").checked = true;
  $("f-voice").value = "";
  $("f-enabled").checked = true;

  $("nw-source").value = "next";
  $("nw-template").value = "UP NEXT: {show}";
  $("nw-color").value = "#ffd400";
  $("nw-size").value = 52;
  $("nw-outline-width").value = 0;
  $("nw-outline-color").value = "#000000";
  $("nw-shadow").checked = true;
  $("nw-shadow-color").value = "#000000";
  $("nw-shadow-x").value = 2;
  $("nw-shadow-y").value = 2;

  $("un-source").value = "after_next";
  $("un-template").value = "FOLLOWED BY: {show}";
  $("un-color").value = "#ffffff";
  $("un-size").value = 40;
  $("un-outline-width").value = 0;
  $("un-outline-color").value = "#000000";
  $("un-shadow").checked = true;
  $("un-shadow-color").value = "#000000";
  $("un-shadow-x").value = 2;
  $("un-shadow-y").value = 2;

  state.fields.now_watching = { x_pct: 8, y_pct: 68, align: "left" };
  state.fields.up_next = { x_pct: 8, y_pct: 80, align: "left" };
  syncLineControls();
  state.fallbackChannelNumber = "";
  state.fallbackChannelName = "";
  state.backgrounds = [];
  state.music = [];
  state.shapes = [];
  state.uploadedFont = null;
  state.bgImage = null;
  $("font-preview-name").textContent = "";
  $("preview-video").classList.add("hidden");
  renderBackgroundList();
  renderMusicList();
  renderShapeList();
  drawCanvas();
}

function fillEditorForm(c) {
  $("f-name").value = c.name;
  $("f-tunarr-library").value = c.tunarr_library_id || "";
  $("f-interval").value = c.interval_minutes;
  $("f-duration").value = c.duration_seconds;
  $("f-resolution").value = c.resolution;
  $("f-tts").checked = !!c.tts_enabled;
  $("f-fade").checked = c.fade_enabled !== false;
  $("f-voice").value = c.tts_voice || "";
  $("f-enabled").checked = !!c.enabled;

  const nw = c.now_watching || {};
  $("nw-source").value = nw.source || "current";
  $("nw-template").value = templateFor(nw, "YOU'RE WATCHING", false);
  $("nw-color").value = nw.color || "#ffd400";
  $("nw-size").value = nw.font_size || 52;
  $("nw-outline-width").value = nw.outline_width || 0;
  $("nw-outline-color").value = nw.outline_color || "#000000";
  $("nw-shadow").checked = nw.shadow_enabled !== false;
  $("nw-shadow-color").value = nw.shadow_color || "#000000";
  $("nw-shadow-x").value = nw.shadow_x ?? 2;
  $("nw-shadow-y").value = nw.shadow_y ?? 2;

  const un = c.up_next || {};
  $("un-source").value = un.source || "next";
  $("un-template").value = templateFor(un, "UP NEXT", true);
  $("un-color").value = un.color || "#ffffff";
  $("un-size").value = un.font_size || 40;
  $("un-outline-width").value = un.outline_width || 0;
  $("un-outline-color").value = un.outline_color || "#000000";
  $("un-shadow").checked = un.shadow_enabled !== false;
  $("un-shadow-color").value = un.shadow_color || "#000000";
  $("un-shadow-x").value = un.shadow_x ?? 2;
  $("un-shadow-y").value = un.shadow_y ?? 2;

  state.fields.now_watching = { x_pct: nw.x_pct ?? 8, y_pct: nw.y_pct ?? 68, align: nw.align || "left" };
  state.fields.up_next = { x_pct: un.x_pct ?? 8, y_pct: un.y_pct ?? 80, align: un.align || "left" };
  syncLineControls();
  state.fallbackChannelNumber = c.tunarr_channel_number || "";
  state.fallbackChannelName = c.tunarr_channel_name || "";

  state.backgrounds = (c.backgrounds || []).slice();
  state.music = (c.music_tracks || []).slice();
  state.shapes = (c.shapes || []).slice();
  state.uploadedFont = c.font_path ? { path: c.font_path } : null;
  $("font-preview-name").textContent = c.font_path ? c.font_path.split("/").pop() : "";

  setTimeout(() => {
    fillSelect("f-tunarr-channel", getSelectOptions("f-tunarr-channel"));
    $("f-tunarr-channel").value = c.tunarr_channel_id || "";
    $("f-tunarr-mediasource").value = c.tunarr_media_source_id || "";
  }, 300);

  renderBackgroundList();
  renderMusicList();
  renderShapeList();
  loadBackgroundPreviewImage();
  $("preview-video").classList.add("hidden");
  drawCanvas();
}
function getSelectOptions(id) {
  return Array.from($(id).options).map(o => ({ value: o.value, label: o.textContent }));
}

// ---------------------------------------------------------------------
// backgrounds (multiple, random pick at generation time)
// ---------------------------------------------------------------------
$("f-background-file").onchange = async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await (await fetch("/api/uploads/background", { method: "POST", body: fd })).json();
    state.backgrounds.push(res);
  }
  e.target.value = "";
  renderBackgroundList();
  loadBackgroundPreviewImage();
};
function renderBackgroundList() {
  const ul = $("background-list");
  ul.innerHTML = "";
  state.backgrounds.forEach((bg, i) => {
    const li = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "asset-meta";
    meta.textContent = `${bg.name || bg.path.split("/").pop()} (${bg.type})`;
    const rm = document.createElement("button");
    rm.className = "asset-remove"; rm.textContent = "✕";
    rm.onclick = () => { state.backgrounds.splice(i, 1); renderBackgroundList(); loadBackgroundPreviewImage(); };
    li.appendChild(meta); li.appendChild(rm);
    ul.appendChild(li);
  });
}
function loadBackgroundPreviewImage() {
  // Canvas preview only shows still images/gif first-frame; videos just show a placeholder tint.
  const imgLike = state.backgrounds.find(b => b.type === "image" || b.type === "gif");
  if (!imgLike) { state.bgImage = null; drawCanvas(); return; }
  const filename = imgLike.path.split("/").pop();
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { state.bgImage = img; drawCanvas(); };
  img.src = `/api/uploads/${filename}`;
}

// ---------------------------------------------------------------------
// background music (multiple, random pick at generation time)
// ---------------------------------------------------------------------
$("f-music-file").onchange = async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await (await fetch("/api/uploads/music", { method: "POST", body: fd })).json();
    state.music.push(res);
  }
  e.target.value = "";
  renderMusicList();
};
function renderMusicList() {
  const ul = $("music-list");
  ul.innerHTML = "";
  state.music.forEach((m, i) => {
    const li = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "asset-meta";
    meta.textContent = m.name || m.path.split("/").pop();
    const rm = document.createElement("button");
    rm.className = "asset-remove"; rm.textContent = "✕";
    rm.onclick = () => { state.music.splice(i, 1); renderMusicList(); };
    li.appendChild(meta); li.appendChild(rm);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------
// font
// ---------------------------------------------------------------------
$("f-font-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await (await fetch("/api/uploads/font", { method: "POST", body: fd })).json();
  state.uploadedFont = res;
  $("font-preview-name").textContent = file.name;
};

// ---------------------------------------------------------------------
// shapes (rectangles)
// ---------------------------------------------------------------------
$("add-shape").onclick = () => {
  state.shapes.push({ x_pct: 0, y_pct: 80, width_pct: 100, height_pct: 20, color: "#000000", opacity: 0.6 });
  renderShapeList();
  drawCanvas();
};
function renderShapeList() {
  const ul = $("shape-list");
  ul.innerHTML = "";
  state.shapes.forEach((shape, i) => {
    const li = document.createElement("li");
    li.style.display = "block";
    const row = document.createElement("div");
    row.className = "shape-row";

    const mk = (labelText, type, key, step) => {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      if (step) input.step = step;
      input.value = shape[key];
      input.oninput = () => {
        shape[key] = type === "number" ? parseFloat(input.value) : input.value;
        drawCanvas();
      };
      label.appendChild(input);
      return label;
    };

    row.appendChild(mk("X %", "number", "x_pct"));
    row.appendChild(mk("Y %", "number", "y_pct"));
    row.appendChild(mk("Width %", "number", "width_pct"));
    row.appendChild(mk("Height %", "number", "height_pct"));
    row.appendChild(mk("Color", "color", "color"));
    row.appendChild(mk("Opacity", "number", "opacity", "0.05"));

    const rm = document.createElement("button");
    rm.className = "asset-remove"; rm.textContent = "✕ Remove";
    rm.type = "button";
    rm.onclick = () => { state.shapes.splice(i, 1); renderShapeList(); drawCanvas(); };
    row.appendChild(rm);

    li.appendChild(row);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------
// canvas preview + drag-to-position
// ---------------------------------------------------------------------
function drawCanvas() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.bgImage) {
    ctx.drawImage(state.bgImage, 0, 0, canvas.width, canvas.height);
  } else if (state.backgrounds.some(b => b.type === "video")) {
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#555";
    ctx.font = "14px sans-serif";
    ctx.fillText("(video background — see Render Real Preview)", 20, canvas.height / 2);
  }

  state.shapes.forEach(shape => {
    const x = (shape.x_pct / 100) * canvas.width;
    const y = (shape.y_pct / 100) * canvas.height;
    const w = (shape.width_pct / 100) * canvas.width;
    const h = (shape.height_pct / 100) * canvas.height;
    ctx.fillStyle = hexToRgba(shape.color, shape.opacity);
    ctx.fillRect(x, y, w, h);
  });

  drawLabel("now_watching", previewText("nw"), $("nw-color").value,
    parseInt($("nw-size").value || 52) * previewScale(), {
      outlineWidth: parseInt($("nw-outline-width").value || 0),
      outlineColor: $("nw-outline-color").value,
      shadow: $("nw-shadow").checked,
      shadowColor: $("nw-shadow-color").value,
      shadowX: parseInt($("nw-shadow-x").value || 0),
      shadowY: parseInt($("nw-shadow-y").value || 0),
    });
  drawLabel("up_next", previewText("un"), $("un-color").value,
    parseInt($("un-size").value || 40) * previewScale(), {
      outlineWidth: parseInt($("un-outline-width").value || 0),
      outlineColor: $("un-outline-color").value,
      shadow: $("un-shadow").checked,
      shadowColor: $("un-shadow-color").value,
      shadowX: parseInt($("un-shadow-x").value || 0),
      shadowY: parseInt($("un-shadow-y").value || 0),
    });
}
const PREVIEW_VALUES = {
  current: "Example Show", current_time: "8:00 PM",
  next: "Next Example Show", next_time: "8:30 PM",
  after_next: "Later Example Show", after_next_time: "9:00 PM",
};
const PLACEHOLDERS = {
  show: "show", time: "time",
  current: "current", currentshow: "current", now: "current",
  next: "next", nextshow: "next",
  later: "after_next", latershow: "after_next", after_next: "after_next", afternext: "after_next",
  current_time: "current_time", now_time: "current_time", next_time: "next_time",
  later_time: "after_next_time", after_next_time: "after_next_time",
};
// Same conversion the server does for profiles saved before templates existed.
function templateFor(line, legacyPrefix, legacyTime) {
  if (line.template !== undefined) return line.template;
  const prefix = (line.prefix ?? legacyPrefix).trim();
  let t = prefix ? `${prefix}: {show}` : "{show}";
  const source = line.source || (legacyTime ? "next" : "current");
  if ((line.show_time ?? legacyTime) && source !== "current") t += " AT {time}";
  return t;
}
function previewText(pfx) {
  const source = $(`${pfx}-source`).value;
  const values = { ...PREVIEW_VALUES, show: PREVIEW_VALUES[source], time: PREVIEW_VALUES[`${source}_time`] };
  return $(`${pfx}-template`).value.replace(/\{\s*([A-Za-z_]+)\s*\}/g, (m, name) => {
    const key = PLACEHOLDERS[name.toLowerCase()];
    return key ? values[key] : m;
  }).replace(/\s{2,}/g, " ").trim();
}
function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function previewScale() {
  const w = parseInt(($("f-resolution").value || "1920x1080").split("x")[0]) || 1920;
  return canvas.width / w;
}
function drawLabel(key, text, color, size, style) {
  const f = state.fields[key];
  const x = (f.x_pct / 100) * canvas.width;
  const y = (f.y_pct / 100) * canvas.height;
  const align = f.align || "left";
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";   // ffmpeg places text by its top edge
  const w = ctx.measureText(text).width;
  const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  f._bounds = { x: left - 6, y: y - 6, w: w + 12, h: size + 12 };

  const s = previewScale();
  if (style.shadow) {
    ctx.fillStyle = hexToRgba(style.shadowColor, 0.7);
    ctx.fillText(text, x + style.shadowX * s, y + style.shadowY * s);
  }
  if (style.outlineWidth > 0) {
    ctx.lineWidth = style.outlineWidth * 2 * s;
    ctx.strokeStyle = style.outlineColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

$("f-resolution").addEventListener("input", drawCanvas);

// X/Y inputs and alignment stay in sync with dragging on the canvas.
const LINE_KEYS = { nw: "now_watching", un: "up_next" };
function syncLineControls() {
  for (const [pfx, key] of Object.entries(LINE_KEYS)) {
    const f = state.fields[key];
    $(`${pfx}-x`).value = Math.round(f.x_pct * 2) / 2;
    $(`${pfx}-y`).value = Math.round(f.y_pct * 2) / 2;
    $(`${pfx}-align`).value = f.align || "left";
  }
}
for (const [pfx, key] of Object.entries(LINE_KEYS)) {
  for (const axis of ["x", "y"]) {
    $(`${pfx}-${axis}`).addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) { state.fields[key][`${axis}_pct`] = Math.max(0, Math.min(100, v)); drawCanvas(); }
    });
  }
  $(`${pfx}-align`).addEventListener("change", (e) => {
    state.fields[key].align = e.target.value;
    if (e.target.value === "center") state.fields[key].x_pct = 50;   // centered on screen
    syncLineControls();
    drawCanvas();
  });
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  for (const key of ["now_watching", "up_next"]) {
    const b = state.fields[key]._bounds;
    if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
      const f = state.fields[key];
      state.dragTarget = key;
      state.dragOffset = { x: mx - (f.x_pct / 100) * canvas.width, y: my - (f.y_pct / 100) * canvas.height };
      break;
    }
  }
});
canvas.addEventListener("mousemove", (e) => {
  if (!state.dragTarget) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  const off = state.dragOffset || { x: 0, y: 0 };
  state.fields[state.dragTarget].x_pct = Math.max(0, Math.min(100, ((mx - off.x) / canvas.width) * 100));
  state.fields[state.dragTarget].y_pct = Math.max(0, Math.min(100, ((my - off.y) / canvas.height) * 100));
  syncLineControls();
  drawCanvas();
});
window.addEventListener("mouseup", () => { state.dragTarget = null; });

// redraw live as text/style options change
[
  "nw-source", "nw-template", "nw-color", "nw-size", "nw-outline-width", "nw-outline-color",
  "nw-shadow", "nw-shadow-color", "nw-shadow-x", "nw-shadow-y",
  "un-source", "un-template", "un-color", "un-size", "un-outline-width", "un-outline-color",
  "un-shadow", "un-shadow-color", "un-shadow-x", "un-shadow-y",
].forEach(id => {
  $(id).addEventListener("input", drawCanvas);
  $(id).addEventListener("change", drawCanvas);
});

// ---------------------------------------------------------------------
// save / delete / generate
// ---------------------------------------------------------------------
function collectPayload() {
  const selectedChannelId = $("f-tunarr-channel").value || "";
  const matchedChannel = state.tunarrChannels.find(c => c.id === selectedChannelId);
  return {
    name: $("f-name").value || "Untitled Channel",
    tunarr_channel_id: selectedChannelId,
    tunarr_channel_number: matchedChannel ? String(matchedChannel.number ?? "") : (state.fallbackChannelNumber || ""),
    tunarr_channel_name: matchedChannel ? (matchedChannel.name || "") : (state.fallbackChannelName || ""),
    tunarr_media_source_id: $("f-tunarr-mediasource").value || "",
    tunarr_library_id: $("f-tunarr-library").value || "",
    interval_minutes: parseInt($("f-interval").value) || 10,
    resolution: $("f-resolution").value || "1920x1080",
    duration_seconds: parseFloat($("f-duration").value) || 6,
    backgrounds: state.backgrounds,
    music_tracks: state.music,
    shapes: state.shapes,
    font_path: state.uploadedFont ? state.uploadedFont.path : "",
    now_watching: {
      source: $("nw-source").value, template: $("nw-template").value, color: $("nw-color").value,
      font_size: parseInt($("nw-size").value), x_pct: state.fields.now_watching.x_pct,
      y_pct: state.fields.now_watching.y_pct, align: state.fields.now_watching.align || "left",
      outline_width: parseInt($("nw-outline-width").value) || 0,
      outline_color: $("nw-outline-color").value,
      shadow_enabled: $("nw-shadow").checked,
      shadow_color: $("nw-shadow-color").value,
      shadow_x: parseInt($("nw-shadow-x").value) || 0,
      shadow_y: parseInt($("nw-shadow-y").value) || 0,
    },
    up_next: {
      source: $("un-source").value, template: $("un-template").value, color: $("un-color").value,
      font_size: parseInt($("un-size").value), x_pct: state.fields.up_next.x_pct,
      y_pct: state.fields.up_next.y_pct, align: state.fields.up_next.align || "left",
      outline_width: parseInt($("un-outline-width").value) || 0,
      outline_color: $("un-outline-color").value,
      shadow_enabled: $("un-shadow").checked,
      shadow_color: $("un-shadow-color").value,
      shadow_x: parseInt($("un-shadow-x").value) || 0,
      shadow_y: parseInt($("un-shadow-y").value) || 0,
    },
    fade_enabled: $("f-fade").checked,
    tts_enabled: $("f-tts").checked,
    tts_voice: $("f-voice").value,
    enabled: $("f-enabled").checked,
  };
}

$("save-channel").onclick = async () => {
  const payload = collectPayload();
  if (!payload.backgrounds.length) {
    alert("Add at least one background before saving.");
    return;
  }
  let res;
  if (state.selectedId) {
    res = await fetch(`/api/channels/${state.selectedId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
  } else {
    res = await fetch("/api/channels", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
  }
  const data = await res.json();
  state.selectedId = data.id;
  await loadChannels();
  renderChannelList();
  alert("Saved.");
};

$("delete-channel").onclick = async () => {
  if (!state.selectedId) return;
  if (!confirm("Delete this channel profile?")) return;
  await fetch(`/api/channels/${state.selectedId}`, { method: "DELETE" });
  state.selectedId = null;
  $("editor-panel").classList.add("hidden");
  await loadChannels();
};

$("render-preview").onclick = async () => {
  if (!state.selectedId) { alert("Save the channel first."); return; }
  const btn = $("render-preview");
  btn.disabled = true; btn.textContent = "Rendering...";
  try {
    const res = await fetch(`/api/channels/${state.selectedId}/preview`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).detail || "render failed");
    const data = await res.json();
    const video = $("preview-video");
    video.src = data.preview_url + "?t=" + Date.now();
    video.classList.remove("hidden");
    video.play();
  } catch (e) {
    alert("Preview failed: " + e.message);
  }
  btn.disabled = false; btn.textContent = "🔄 Render Real Preview";
};

$("generate-now").onclick = async () => {
  if (!state.selectedId) { alert("Save the channel first."); return; }
  const btn = $("generate-now");
  btn.disabled = true; btn.textContent = "Working...";
  try {
    const res = await fetch(`/api/channels/${state.selectedId}/generate`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "generation failed");
    alert(data.rescan_warning ? `Rendered, but rescan warning: ${data.rescan_warning}` : "Generated and pushed.");
  } catch (e) {
    alert("Failed: " + e.message);
  }
  btn.disabled = false; btn.textContent = "▶ Generate & Push Now";
};

// ---------------------------------------------------------------------
// init
// ---------------------------------------------------------------------
(async function init() {
  await loadSettings();
  await populateDropdowns();
  await loadChannels();
  renderBackgroundList();
  renderMusicList();
  renderShapeList();
  drawCanvas();
})();
