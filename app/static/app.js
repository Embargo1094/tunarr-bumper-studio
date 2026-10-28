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
  extras: [],        // extra text lines
  dragItems: [],
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
  $("f-strip-year").checked = true;
  $("f-voice").value = "";
  $("f-enabled").checked = true;

  setLineDom("nw", { source: "next", template: "UP NEXT: {show}", color: "#ffd400", font_size: 52 });
  setLineDom("un", { source: "after_next", template: "FOLLOWED BY: {show}", color: "#ffffff", font_size: 40 });
  state.extras = [];

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
  renderExtraList();
  updateTimeSlider();
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
  $("f-strip-year").checked = c.strip_year !== false;
  $("f-voice").value = c.tts_voice || "";
  $("f-enabled").checked = !!c.enabled;

  const nw = c.now_watching || {};
  setLineDom("nw", { ...nw, source: nw.source || "current", template: templateFor(nw, "YOU'RE WATCHING", false),
                     color: nw.color || "#ffd400", font_size: nw.font_size || 52 });
  const un = c.up_next || {};
  setLineDom("un", { ...un, source: un.source || "next", template: templateFor(un, "UP NEXT", true),
                     color: un.color || "#ffffff", font_size: un.font_size || 40 });
  state.extras = (c.extra_texts || []).map(e => ({ ...e }));

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
  renderExtraList();
  updateTimeSlider();
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
  renderExtraList();
  updateTimeSlider();
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

  // Draw every text element as it looks at the preview time; remember where
  // each one is so it can be dragged.
  const t = parseFloat($("preview-time").value) || 0;
  state.dragItems = [];
  for (const [pfx, key] of Object.entries(LINE_KEYS)) {
    drawElement(lineFromDom(pfx), state.fields[key], t, () => syncLineControls());
  }
  state.extras.forEach(extra => drawElement(extra, extra, t, () => syncExtraPos(extra)));
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
function fillPreview(template, source) {
  const src = source || "next";
  const values = { ...PREVIEW_VALUES, show: PREVIEW_VALUES[src], time: PREVIEW_VALUES[`${src}_time`] };
  return (template || "").replace(/\{\s*([A-Za-z_]+)\s*\}/g, (m, name) => {
    const key = PLACEHOLDERS[name.toLowerCase()];
    return key ? values[key] : m;
  }).replace(/\s{2,}/g, " ").trim();
}
function previewText(pfx) { return fillPreview($(`${pfx}-template`).value, $(`${pfx}-source`).value); }
function hexToRgba(hex, alpha) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function previewScale() {
  const w = parseInt(($("f-resolution").value || "1920x1080").split("x")[0]) || 1920;
  return canvas.width / w;
}

// Which text a line shows at time t (its swap text after swap_at).
function textAt(line, t) {
  const main = fillPreview(line.template, line.source);
  // After the switch time: the switch text, or nothing if it's left blank.
  if (line.swap_enabled && t >= (parseFloat(line.swap_at) || 0)) {
    return fillPreview(line.swap_template, line.source);
  }
  return main;
}
function drawElement(line, pos, t, onDrag) {
  const text = textAt(line, t);
  if (!text) return;
  const s = previewScale();
  const size = (parseInt(line.font_size) || 40) * s;
  const x = (pos.x_pct / 100) * canvas.width;
  const y = (pos.y_pct / 100) * canvas.height;
  const align = pos.align || "left";
  ctx.font = `${size}px "DejaVu Sans", sans-serif`;
  ctx.letterSpacing = `${(parseFloat(line.letter_spacing) || 0) * s}px`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";   // Y is the top of the letters, same as the render
  const w = ctx.measureText(text).width;
  const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  state.dragItems.push({ pos, onDrag, bounds: { x: left - 6, y: y - 6, w: w + 12, h: size + 12 } });

  if (line.shadow_enabled) {
    ctx.fillStyle = hexToRgba(line.shadow_color, 0.7);
    ctx.fillText(text, x + (parseInt(line.shadow_x) || 0) * s, y + (parseInt(line.shadow_y) || 0) * s);
  }
  const ow = parseInt(line.outline_width) || 0;
  if (ow > 0) {
    ctx.lineWidth = ow * 2 * s;
    ctx.lineJoin = "round";
    ctx.strokeStyle = line.outline_color || "#000000";
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = line.color || "#ffffff";
  ctx.fillText(text, x, y);
  ctx.letterSpacing = "0px";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ---------------------------------------------------------------------
// the two show lines (fixed form fields)
// ---------------------------------------------------------------------
const LINE_KEYS = { nw: "now_watching", un: "up_next" };
function lineFromDom(pfx) {
  const pos = state.fields[LINE_KEYS[pfx]];
  return {
    source: $(`${pfx}-source`).value, template: $(`${pfx}-template`).value,
    color: $(`${pfx}-color`).value, font_size: parseInt($(`${pfx}-size`).value) || 40,
    x_pct: pos.x_pct, y_pct: pos.y_pct, align: pos.align || "left",
    letter_spacing: parseFloat($(`${pfx}-spacing`).value) || 0,
    outline_width: parseInt($(`${pfx}-outline-width`).value) || 0, outline_color: $(`${pfx}-outline-color`).value,
    shadow_enabled: $(`${pfx}-shadow`).checked, shadow_color: $(`${pfx}-shadow-color`).value,
    shadow_x: parseInt($(`${pfx}-shadow-x`).value) || 0, shadow_y: parseInt($(`${pfx}-shadow-y`).value) || 0,
    swap_enabled: $(`${pfx}-swap`).checked, swap_template: $(`${pfx}-swap-text`).value,
    swap_at: parseFloat($(`${pfx}-swap-at`).value) || 0, swap_crossfade: $(`${pfx}-swap-xfade`).checked,
  };
}
function setLineDom(pfx, l) {
  $(`${pfx}-source`).value = l.source || "next";
  $(`${pfx}-template`).value = l.template ?? "";
  $(`${pfx}-color`).value = l.color || "#ffffff";
  $(`${pfx}-size`).value = l.font_size || 40;
  $(`${pfx}-spacing`).value = l.letter_spacing || 0;
  $(`${pfx}-outline-width`).value = l.outline_width || 0;
  $(`${pfx}-outline-color`).value = l.outline_color || "#000000";
  $(`${pfx}-shadow`).checked = l.shadow_enabled !== false;
  $(`${pfx}-shadow-color`).value = l.shadow_color || "#000000";
  $(`${pfx}-shadow-x`).value = l.shadow_x ?? 2;
  $(`${pfx}-shadow-y`).value = l.shadow_y ?? 2;
  $(`${pfx}-swap`).checked = !!l.swap_enabled;
  $(`${pfx}-swap-text`).value = l.swap_template || "";
  $(`${pfx}-swap-at`).value = l.swap_at ?? 3;
  $(`${pfx}-swap-xfade`).checked = !!l.swap_crossfade;
}
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
  for (const id of ["source", "template", "color", "size", "spacing", "outline-width", "outline-color",
                    "shadow", "shadow-color", "shadow-x", "shadow-y", "swap", "swap-text", "swap-at", "swap-xfade"]) {
    $(`${pfx}-${id}`).addEventListener("input", drawCanvas);
    $(`${pfx}-${id}`).addEventListener("change", drawCanvas);
  }
  // Editing a swap moves the preview to just after it, so you can see the new text.
  for (const id of ["swap", "swap-text", "swap-at"]) {
    $(`${pfx}-${id}`).addEventListener("input", () => showTime(parseFloat($(`${pfx}-swap-at`).value) + 0.1));
  }
}

// ---------------------------------------------------------------------
// extra text lines (a list, like rectangles)
// ---------------------------------------------------------------------
const EXTRA_KEYS = ["template", "source", "x_pct", "y_pct", "align", "font_size", "color", "letter_spacing",
  "outline_width", "outline_color", "shadow_enabled", "shadow_color", "shadow_x", "shadow_y",
  "swap_enabled", "swap_template", "swap_at", "swap_crossfade"];
$("add-extra").onclick = () => {
  state.extras.push({ template: "SCHEDULE", source: "next", x_pct: 50, y_pct: 10, align: "center",
    font_size: 60, color: "#ffffff", letter_spacing: 0, outline_width: 0, outline_color: "#000000",
    shadow_enabled: true, shadow_color: "#000000", shadow_x: 2, shadow_y: 2,
    swap_enabled: false, swap_template: "", swap_at: 3, swap_crossfade: false });
  renderExtraList();
  drawCanvas();
};
function syncExtraPos(extra) {
  if (extra._inputs) {
    extra._inputs.x_pct.value = Math.round(extra.x_pct * 2) / 2;
    extra._inputs.y_pct.value = Math.round(extra.y_pct * 2) / 2;
  }
}
function renderExtraList() {
  const ul = $("extra-list");
  ul.innerHTML = "";
  state.extras.forEach((extra, i) => {
    const li = document.createElement("li");
    li.className = "extra-item";
    const grid = document.createElement("div");
    grid.className = "extra-grid";
    extra._inputs = {};
    const add = (labelText, key, type, opts = {}) => {
      const label = document.createElement("label");
      label.textContent = labelText;
      if (opts.cls) label.className = opts.cls;
      let input;
      if (type === "select") {
        input = document.createElement("select");
        for (const [v, t] of opts.options) { const o = document.createElement("option"); o.value = v; o.textContent = t; input.appendChild(o); }
        input.value = extra[key] ?? opts.options[0][0];
      } else {
        input = document.createElement("input");
        input.type = type;
        if (opts.step) input.step = opts.step;
        if (type === "checkbox") input.checked = !!extra[key]; else input.value = extra[key] ?? "";
      }
      const update = () => {
        extra[key] = type === "checkbox" ? input.checked : type === "number" ? (parseFloat(input.value) || 0) : input.value;
        if (key === "align" && input.value === "center") { extra.x_pct = 50; syncExtraPos(extra); }
        if (key.startsWith("swap")) showTime((parseFloat(extra.swap_at) || 0) + 0.1); else drawCanvas();
      };
      input.addEventListener("input", update);
      input.addEventListener("change", update);
      extra._inputs[key] = input;
      if (type === "checkbox") { label.textContent = ""; label.classList.add("inline"); label.append(input, " " + labelText); }
      else label.appendChild(input);
      grid.appendChild(label);
    };
    add("Text", "template", "text", { cls: "wide" });
    add("{show} and {time} mean", "source", "select", { cls: "half", options: [["current", "current show"], ["next", "next show"], ["after_next", "show after next"]] });
    add("Align", "align", "select", { cls: "half", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]] });
    add("X %", "x_pct", "number", { step: "0.5" });
    add("Y %", "y_pct", "number", { step: "0.5" });
    add("Size", "font_size", "number");
    add("Spacing", "letter_spacing", "number");
    add("Color", "color", "color");
    add("Outline", "outline_width", "number");
    add("Outline color", "outline_color", "color");
    add("Shadow", "shadow_enabled", "checkbox");
    add("Shadow color", "shadow_color", "color");
    add("Shadow X", "shadow_x", "number");
    add("Shadow Y", "shadow_y", "number");
    add("Switch to different text partway through", "swap_enabled", "checkbox", { cls: "wide" });
    add("Then show", "swap_template", "text", { cls: "half" });
    add("At (seconds)", "swap_at", "number", { step: "0.1" });
    add("Crossfade", "swap_crossfade", "checkbox");
    const rm = document.createElement("button");
    rm.className = "asset-remove"; rm.textContent = "✕ Remove"; rm.type = "button";
    rm.onclick = () => { state.extras.splice(i, 1); renderExtraList(); drawCanvas(); };
    li.append(grid, rm);
    ul.appendChild(li);
  });
}
function extrasForSave() {
  return state.extras.map(e => Object.fromEntries(EXTRA_KEYS.map(k => [k, e[k]])));
}

// ---------------------------------------------------------------------
// preview time slider
// ---------------------------------------------------------------------
function updateTimeSlider() {
  const d = parseFloat($("f-duration").value) || 6;
  $("preview-time").max = d;
  if (parseFloat($("preview-time").value) > d) $("preview-time").value = d;
  $("preview-time-label").textContent = `${parseFloat($("preview-time").value).toFixed(1)}s`;
}
function showTime(t) {
  if (!Number.isNaN(t)) $("preview-time").value = Math.max(0, t);
  updateTimeSlider();
  drawCanvas();
}
$("preview-time").addEventListener("input", () => { updateTimeSlider(); drawCanvas(); });
$("f-duration").addEventListener("input", () => { updateTimeSlider(); drawCanvas(); });
$("f-resolution").addEventListener("input", drawCanvas);

// ---------------------------------------------------------------------
// dragging any text on the canvas
// ---------------------------------------------------------------------
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
}
canvas.addEventListener("mousedown", (e) => {
  const m = canvasPoint(e);
  const items = state.dragItems || [];
  for (let k = items.length - 1; k >= 0; k--) {   // top-most first
    const { bounds: b, pos } = items[k];
    if (m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h) {
      state.drag = { item: items[k], off: { x: m.x - (pos.x_pct / 100) * canvas.width, y: m.y - (pos.y_pct / 100) * canvas.height } };
      break;
    }
  }
});
canvas.addEventListener("mousemove", (e) => {
  if (!state.drag) return;
  const m = canvasPoint(e);
  const { item, off } = state.drag;
  item.pos.x_pct = Math.max(0, Math.min(100, ((m.x - off.x) / canvas.width) * 100));
  item.pos.y_pct = Math.max(0, Math.min(100, ((m.y - off.y) / canvas.height) * 100));
  item.onDrag();
  drawCanvas();
});
window.addEventListener("mouseup", () => { state.drag = null; });

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
    now_watching: lineFromDom("nw"),
    up_next: lineFromDom("un"),
    extra_texts: extrasForSave(),
    fade_enabled: $("f-fade").checked,
    strip_year: $("f-strip-year").checked,
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
  renderExtraList();
  updateTimeSlider();
  drawCanvas();
})();
