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
  $("f-voice").value = "";
  $("f-enabled").checked = true;

  $("nw-source").value = "next";
  $("nw-prefix").value = "UP NEXT";
  $("nw-time").checked = false;
  $("nw-color").value = "#ffd400";
  $("nw-size").value = 52;
  $("nw-outline-width").value = 0;
  $("nw-outline-color").value = "#000000";
  $("nw-shadow").checked = true;
  $("nw-shadow-color").value = "#000000";
  $("nw-shadow-x").value = 2;
  $("nw-shadow-y").value = 2;

  $("un-source").value = "after_next";
  $("un-prefix").value = "FOLLOWED BY";
  $("un-time").checked = false;
  $("un-color").value = "#ffffff";
  $("un-size").value = 40;
  $("un-outline-width").value = 0;
  $("un-outline-color").value = "#000000";
  $("un-shadow").checked = true;
  $("un-shadow-color").value = "#000000";
  $("un-shadow-x").value = 2;
  $("un-shadow-y").value = 2;

  state.fields.now_watching = { x_pct: 8, y_pct: 68 };
  state.fields.up_next = { x_pct: 8, y_pct: 80 };
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
  $("f-voice").value = c.tts_voice || "";
  $("f-enabled").checked = !!c.enabled;

  const nw = c.now_watching || {};
  $("nw-source").value = nw.source || "current";
  $("nw-prefix").value = nw.prefix ?? "YOU'RE WATCHING";
  $("nw-time").checked = nw.show_time ?? false;
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
  $("un-prefix").value = un.prefix ?? "UP NEXT";
  $("un-time").checked = un.show_time ?? true;
  $("un-color").value = un.color || "#ffffff";
  $("un-size").value = un.font_size || 40;
  $("un-outline-width").value = un.outline_width || 0;
  $("un-outline-color").value = un.outline_color || "#000000";
  $("un-shadow").checked = un.shadow_enabled !== false;
  $("un-shadow-color").value = un.shadow_color || "#000000";
  $("un-shadow-x").value = un.shadow_x ?? 2;
  $("un-shadow-y").value = un.shadow_y ?? 2;

  state.fields.now_watching = { x_pct: nw.x_pct ?? 8, y_pct: nw.y_pct ?? 68 };
  state.fields.up_next = { x_pct: un.x_pct ?? 8, y_pct: un.y_pct ?? 80 };
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
    parseInt($("nw-size").value || 52) / 2, {
      outlineWidth: parseInt($("nw-outline-width").value || 0),
      outlineColor: $("nw-outline-color").value,
      shadow: $("nw-shadow").checked,
      shadowColor: $("nw-shadow-color").value,
      shadowX: parseInt($("nw-shadow-x").value || 0),
      shadowY: parseInt($("nw-shadow-y").value || 0),
    });
  drawLabel("up_next", previewText("un"), $("un-color").value,
    parseInt($("un-size").value || 40) / 2, {
      outlineWidth: parseInt($("un-outline-width").value || 0),
      outlineColor: $("un-outline-color").value,
      shadow: $("un-shadow").checked,
      shadowColor: $("un-shadow-color").value,
      shadowX: parseInt($("un-shadow-x").value || 0),
      shadowY: parseInt($("un-shadow-y").value || 0),
    });
}
const PREVIEW_SHOWS = {
  current: ["Example Show", ""],
  next: ["Next Example Show", "8:30 PM"],
  after_next: ["Later Example Show", "9:00 PM"],
};
function previewText(pfx) {
  const source = $(`${pfx}-source`).value;
  const [title, time] = PREVIEW_SHOWS[source] || PREVIEW_SHOWS.next;
  const prefix = $(`${pfx}-prefix`).value.trim();
  let text = prefix ? `${prefix}: ${title}` : title;
  if ($(`${pfx}-time`).checked && source !== "current") text += ` AT ${time}`;
  return text;
}
function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function drawLabel(key, text, color, size, style) {
  const f = state.fields[key];
  const x = (f.x_pct / 100) * canvas.width;
  const y = (f.y_pct / 100) * canvas.height;
  ctx.font = `bold ${size}px sans-serif`;
  const metrics = ctx.measureText(text);
  f._bounds = { x: x - 6, y: y - size, w: metrics.width + 12, h: size + 12 };

  if (style.shadow) {
    ctx.fillStyle = hexToRgba(style.shadowColor, 0.7);
    ctx.fillText(text, x + style.shadowX / 2, y + style.shadowY / 2);
  }
  if (style.outlineWidth > 0) {
    ctx.lineWidth = style.outlineWidth;
    ctx.strokeStyle = style.outlineColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  for (const key of ["now_watching", "up_next"]) {
    const b = state.fields[key]._bounds;
    if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
      state.dragTarget = key;
      break;
    }
  }
});
canvas.addEventListener("mousemove", (e) => {
  if (!state.dragTarget) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  state.fields[state.dragTarget].x_pct = Math.max(0, Math.min(100, (mx / canvas.width) * 100));
  state.fields[state.dragTarget].y_pct = Math.max(0, Math.min(100, (my / canvas.height) * 100));
  drawCanvas();
});
window.addEventListener("mouseup", () => { state.dragTarget = null; });

// redraw live as text/style options change
[
  "nw-source", "nw-time", "nw-prefix", "nw-color", "nw-size", "nw-outline-width", "nw-outline-color",
  "nw-shadow", "nw-shadow-color", "nw-shadow-x", "nw-shadow-y",
  "un-source", "un-time", "un-prefix", "un-color", "un-size", "un-outline-width", "un-outline-color",
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
      source: $("nw-source").value, show_time: $("nw-time").checked,
      prefix: $("nw-prefix").value, color: $("nw-color").value,
      font_size: parseInt($("nw-size").value), x_pct: state.fields.now_watching.x_pct,
      y_pct: state.fields.now_watching.y_pct,
      outline_width: parseInt($("nw-outline-width").value) || 0,
      outline_color: $("nw-outline-color").value,
      shadow_enabled: $("nw-shadow").checked,
      shadow_color: $("nw-shadow-color").value,
      shadow_x: parseInt($("nw-shadow-x").value) || 0,
      shadow_y: parseInt($("nw-shadow-y").value) || 0,
    },
    up_next: {
      source: $("un-source").value, show_time: $("un-time").checked,
      prefix: $("un-prefix").value, color: $("un-color").value,
      font_size: parseInt($("un-size").value), x_pct: state.fields.up_next.x_pct,
      y_pct: state.fields.up_next.y_pct,
      outline_width: parseInt($("un-outline-width").value) || 0,
      outline_color: $("un-outline-color").value,
      shadow_enabled: $("un-shadow").checked,
      shadow_color: $("un-shadow-color").value,
      shadow_x: parseInt($("un-shadow-x").value) || 0,
      shadow_y: parseInt($("un-shadow-y").value) || 0,
    },
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
