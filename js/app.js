/* Ordoline — Dental Photo Sorting
 * Client-side classification of dental photographs with a YOLO11-cls ONNX model.
 * Preprocessing matches Ultralytics v8.4.69 ClassificationPredictor:
 *   Resize(shortest edge -> N, bilinear, aspect preserved) -> CenterCrop(N x N)
 *   -> ToTensor (RGB, [0,1], CHW) -> Normalize(mean=0, std=1)
 */
"use strict";

const MODEL_URL = "model/best.onnx";
const ORT_WASM_DIR = "ort/";
const DEFAULT_CLASSES = [
  "ceph_front", "ceph_side", "extr_profile", "extr_rest", "extr_smile",
  "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
];

const CATEGORIES = [
  { id: "extraoral_frontal_rest", label: "Extraoral frontal (rest)" },
  { id: "extraoral_frontal_smile", label: "Extraoral frontal (smile)" },
  { id: "extraoral_profile", label: "Extraoral profile" },
  { id: "intraoral_frontal", label: "Intraoral frontal" },
  { id: "intraoral_left", label: "Intraoral left" },
  { id: "intraoral_right", label: "Intraoral right" },
  { id: "intraoral_upper", label: "Intraoral upper" },
  { id: "intraoral_lower", label: "Intraoral lower" },
  { id: "panoramic", label: "Panoramic" },
  { id: "cephalometric", label: "Cephalometric" },
];

const CLASS_TO_CATEGORY = {
  extr_rest: "extraoral_frontal_rest",
  extr_smile: "extraoral_frontal_smile",
  extr_profile: "extraoral_profile",
  intr_front: "intraoral_frontal",
  intr_left: "intraoral_left",
  intr_right: "intraoral_right",
  intr_upper: "intraoral_upper",
  intr_lower: "intraoral_lower",
  ceph_front: "panoramic",
  ceph_side: "cephalometric",
};

const SUFFIX_TO_CATEGORY = (() => {
  const map = { rest: 0, smile: 1, profile: 2, frontal: 3, left: 4, right: 5, upper: 6, lower: 7, panoramic: 8, cephalometric: 9 };
  return (cls) => {
    for (const [suffix, idx] of Object.entries(map)) {
      if (cls.includes(suffix)) return CATEGORIES[idx].id;
    }
    return null;
  };
})();

const state = {
  session: null,
  modelReady: false,
  classifying: false,
  classNames: [...DEFAULT_CLASSES],
  inputSize: 512,
  activeEP: "wasm",
  items: new Map(),
  queueOrder: [],
  nextId: 1,
};

const $ = (id) => document.getElementById(id);
const dom = {};

function cacheDom() {
  ["model-status", "ep-badge", "model-progress", "model-progress-bar", "dropzone", "file-input",
    "open-btn", "queue", "queue-count", "queue-grid", "clear-btn", "submit-btn", "sort-progress",
    "sort-progress-bar", "sort-progress-text", "overall-result", "results", "validate-btn",
    "test-count", "lightbox", "lightbox-img", "lightbox-caption"].forEach((k) => (dom[k] = $(k)));
}

/* ---------------- Model ---------------- */

function setModelBadge(text, cls) {
  dom["model-status"].textContent = text;
  dom["model-status"].className = `badge ${cls}`;
}

function parseClassNames(meta) {
  try {
    const namesRaw = meta && meta.names;
    if (!namesRaw) return null;
    const pairs = [...String(namesRaw).matchAll(/(\d+)\s*:\s*'([^']+)'/g)];
    if (!pairs.length) return null;
    const byIndex = {};
    for (const [, idx, name] of pairs) byIndex[Number(idx)] = name;
    const list = Object.keys(byIndex).map(Number).sort((a, b) => a - b).map((i) => byIndex[i]);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

function sessionInputSize(session) {
  try {
    const dims = session.inputMetadata && session.inputMetadata[0] && session.inputMetadata[0].dims;
    if (Array.isArray(dims) && dims.length >= 4 && Number.isFinite(dims[2]) && dims[2] > 0) return dims[2];
  } catch { /* older ort: metadata unavailable */ }
  return 512;
}

async function loadModel() {
  ort.env.wasm.wasmPaths = new URL(ORT_WASM_DIR, location.href).href;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";

  let buffer;
  try {
    buffer = await fetchWithProgress(MODEL_URL, (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      dom["model-progress-bar"].style.width = `${pct}%`;
      setModelBadge(`Loading model… ${pct}%`, "badge-wait");
    });
  } catch (err) {
    console.error("Model download failed:", err);
    setModelBadge("Model download failed", "badge-err");
    return;
  }

  const attempts = [["webgpu", "wasm"], ["wasm"]];
  for (const eps of attempts) {
    try {
      state.session = await ort.InferenceSession.create(buffer, { executionProviders: eps });
      state.activeEP = eps[0];
      break;
    } catch (err) {
      console.warn(`Session create with [${eps}] failed:`, err);
      state.session = null;
    }
  }

  if (!state.session) {
    setModelBadge("Model failed to load", "badge-err");
    return;
  }

  try {
    const meta = await state.session.metadata;
    const names = parseClassNames(meta);
    if (names) state.classNames = names;
  } catch { /* keep defaults */ }

  state.inputSize = sessionInputSize(state.session);
  state.modelReady = true;
  dom["model-progress"].classList.add("hidden");
  dom["ep-badge"].textContent = state.activeEP === "webgpu" ? "WebGPU" : "WASM";
  dom["ep-badge"].classList.remove("hidden");
  dom["ep-badge"].className = "badge badge-info";
  setModelBadge("Model ready", "badge-ok");
  updateButtons();
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/* ---------------- Image intake ---------------- */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f.name));
  if (!files.length) return;
  for (const file of files) {
    const id = `item-${state.nextId++}`;
    const item = {
      id, name: file.name, file, truth: file.__truth || null,
      url: URL.createObjectURL(file),
      status: "queued",
      result: null,
    };
    state.items.set(id, item);
    state.queueOrder.push(id);
    dom["queue-grid"].appendChild(buildQueueChip(item));
  }
  dom.queue.classList.remove("hidden");
  dom.results.classList.remove("hidden");
  updateButtons();
}

function buildQueueChip(item) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "q-item";
  chip.dataset.id = item.id;
  chip.innerHTML = `<img src="${item.url}" alt="" /><span class="q-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>`;
  chip.addEventListener("click", () => openLightbox(item));
  return chip;
}

function updateQueueCount() {
  dom["queue-count"].textContent = String(state.queueOrder.length);
}

function updateButtons() {
  dom["submit-btn"].disabled = !state.modelReady || state.classifying || state.queueOrder.length === 0;
  dom["clear-btn"].disabled = state.classifying || (!state.queueOrder.length && ![...state.items.values()].some((i) => i.status === "done"));
  dom["open-btn"].disabled = state.classifying;
  dom.dropzone.classList.toggle("disabled", state.classifying);
  dom["validate-btn"].disabled = state.classifying || !state.modelReady;
}

function clearAll() {
  for (const item of state.items.values()) URL.revokeObjectURL(item.url);
  state.items.clear();
  state.queueOrder = [];
  dom["queue-grid"].innerHTML = "";
  dom["overall-result"].classList.add("hidden");
  buildCategoryCards();
  dom.queue.classList.add("hidden");
  updateQueueCount();
  updateButtons();
}

/* ---------------- Preprocessing + inference ---------------- */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function ctx2d(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  return ctx;
}

async function decodeBitmap(source) {
  try {
    return await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(source);
  }
}

async function preprocess(source) {
  const size = state.inputSize;
  const bmp = await decodeBitmap(source);
  const w = bmp.width, h = bmp.height;
  if (!w || !h) { bmp.close && bmp.close(); throw new Error("Empty image"); }

  // Resize shortest edge to `size`, aspect preserved (matches torchvision Resize(scalar)).
  const scale = size / Math.min(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const scaled = makeCanvas(nw, nh);
  ctx2d(scaled).drawImage(bmp, 0, 0, nw, nh);
  bmp.close && bmp.close();

  // Center crop size x size.
  const left = Math.round((nw - size) / 2);
  const top = Math.round((nh - size) / 2);
  const crop = makeCanvas(size, size);
  ctx2d(crop).drawImage(scaled, left, top, size, size, 0, 0, size, size);

  const ctx = crop.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, size, size).data;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = data[4 * i] / 255;
    out[plane + i] = data[4 * i + 1] / 255;
    out[2 * plane + i] = data[4 * i + 2] / 255;
  }
  return out;
}

function classToCategory(cls) {
  if (CLASS_TO_CATEGORY[cls]) return CLASS_TO_CATEGORY[cls];
  return SUFFIX_TO_CATEGORY(cls) || CATEGORIES[0].id;
}

async function classify(item) {
  const input = await preprocess(item.file);
  const feeds = { [state.session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, state.inputSize, state.inputSize]) };
  const res = await state.session.run(feeds);
  const outName = state.session.outputNames[0];
  const probs = res[outName].data;
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  const cls = state.classNames[best] || String(best);
  const conf = probs[best] / (probs.reduce((a, b) => a + b, 0) || 1);
  item.result = { cls, conf, probs: Array.from(probs) };
  item.status = "done";
}

/* ---------------- Classification run ---------------- */

async function runClassification() {
  if (state.classifying || !state.modelReady || !state.queueOrder.length) return;
  state.classifying = true;
  updateButtons();

  const batch = state.queueOrder.slice();
  state.queueOrder = [];
  updateQueueCount();

  dom["sort-progress"].classList.remove("hidden");
  let done = 0;
  const truthStats = new Map(); // categoryId -> {total, correct}

  for (const id of batch) {
    const item = state.items.get(id);
    const node = dom["queue-grid"].querySelector(`[data-id="${id}"]`);
    if (node) node.classList.add("working");
    try {
      await classify(item);
      moveIntoCategory(item, truthStats);
    } catch (err) {
      console.error("Classification failed for", item.name, err);
      item.status = "error";
      if (node) { node.classList.remove("working"); node.classList.add("error"); }
    }
    done++;
    const pct = Math.round((done / batch.length) * 100);
    dom["sort-progress-bar"].style.width = `${pct}%`;
    dom["sort-progress-text"].textContent = `${done} / ${batch.length}`;
  }

  dom["sort-progress"].classList.add("hidden");
  dom["sort-progress-bar"].style.width = "0%";
  finishBatch(truthStats);
  state.classifying = false;
  updateButtons();
}

function moveIntoCategory(item, truthStats) {
  const node = dom["queue-grid"].querySelector(`[data-id="${item.id}"]`);
  if (node) node.remove();

  const catId = classToCategory(item.result.cls);
  const cardGrid = document.querySelector(`.cat-card[data-cat="${catId}"] .cat-grid`);
  const empty = cardGrid && cardGrid.parentElement.querySelector(".cat-empty");
  if (empty) empty.remove();

  const isMatch = !item.truth || item.truth === catId;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip" + (isMatch ? "" : " mismatch");
  chip.title = `${item.name} → ${item.result.cls} (${(item.result.conf * 100).toFixed(1)}%)`;
  chip.innerHTML =
    `<img src="${item.url}" alt="${escapeHtml(item.name)}" />` +
    `<span class="conf">${Math.round(item.result.conf * 100)}%</span>`;
  chip.addEventListener("click", () => openLightbox(item, catId, isMatch));

  const grids = document.querySelectorAll(".cat-card");
  let grid = cardGrid;
  if (grid) {
    const chips = [...grid.querySelectorAll(".chip")];
    const insertBefore = chips.find((c) => Number(c.dataset.conf) < item.result.conf * 100);
    if (insertBefore) grid.insertBefore(chip, insertBefore); else grid.appendChild(chip);
    chip.dataset.conf = (item.result.conf * 100).toFixed(1);
  }

  const countEl = document.querySelector(`.cat-card[data-cat="${catId}"] .cat-count`);
  if (countEl) countEl.textContent = String(Number(countEl.textContent || "0") + 1);

  if (item.truth) {
    const st = truthStats.get(item.truth) || { total: 0, correct: 0 };
    st.total++;
    if (isMatch) st.correct++;
    truthStats.set(item.truth, st);
  }
}

function finishBatch(truthStats) {
  let total = 0, correct = 0;
  for (const [, st] of truthStats) { total += st.total; correct += st.correct; }

  if (total > 0) {
    for (const cat of CATEGORIES) {
      const st = truthStats.get(cat.id);
      const head = document.querySelector(`.cat-card[data-cat="${cat.id}"] .cat-meta`);
      if (!head) continue;
      head.querySelectorAll(".acc-badge").forEach((el) => el.remove());
      if (st) {
        const b = document.createElement("span");
        b.className = "acc-badge " + (st.correct === st.total ? "acc-good" : "acc-bad");
        b.textContent = `${st.correct}/${st.total}`;
        head.appendChild(b);
      }
    }
    const line = dom["overall-result"];
    line.classList.remove("hidden");
    line.textContent = `Test-set accuracy: ${correct}/${total} = ${((correct / total) * 100).toFixed(1)}%`;
  } else {
    dom["overall-result"].classList.add("hidden");
  }
  if (!dom["queue-grid"].querySelector(".q-item.error")) dom.queue.classList.add("hidden");
  updateQueueCount();
}

/* ---------------- Test set ---------------- */

async function loadTestSet() {
  const perClass = Number(dom["test-count"].value) || 3;
  let manifest;
  try {
    manifest = await (await fetch("js/testfiles.json")).json();
  } catch (err) {
    console.error("Could not load test manifest:", err);
    return;
  }

  const wanted = [];
  for (const dir of Object.keys(manifest).sort()) {
    for (const name of (manifest[dir] || []).slice(0, perClass)) {
      wanted.push({ dir, name });
    }
  }
  if (!wanted.length) return;

  dom["validate-btn"].disabled = true;
  const originalText = dom["validate-btn"].textContent;
  let fetched = 0;
  for (const { dir, name } of wanted) {
    try {
      const res = await fetch(`data/test/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const file = new File([blob], name, { type: blob.type || "image/jpeg" });
      file.__truth = classToCategory(dir);
      addFiles([file]);
    } catch (err) {
      console.warn("Failed to fetch test image", dir, name, err);
    }
    fetched++;
    dom["validate-btn"].textContent = `Loading ${fetched}/${wanted.length}`;
  }
  dom["validate-btn"].textContent = originalText;
  updateButtons();
  runClassification();
}

/* ---------------- Lightbox ---------------- */

function openLightbox(item, catId, isMatch) {
  dom["lightbox-img"].src = item.url;
  let caption = item.name;
  if (item.result) {
    caption += ` → ${item.result.cls} (${(item.result.conf * 100).toFixed(1)}%)`;
    if (catId) caption += ` · sorted into ${catId}`;
    if (item.truth && !isMatch) caption += ` · expected ${item.truth}`;
  }
  dom["lightbox-caption"].textContent = caption;
  dom.lightbox.classList.remove("hidden");
}

function closeLightbox() {
  dom.lightbox.classList.add("hidden");
}

/* ---------------- Wiring ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildCategoryCards() {
  dom.results.innerHTML = CATEGORIES.map((cat) => `
    <article class="cat-card" data-cat="${cat.id}">
      <div class="cat-head">
        <div>
          <span class="cat-title">${cat.label}</span>
          <span class="cat-id">${cat.id}</span>
        </div>
        <div class="cat-meta">
          <span class="cat-count">0</span>
        </div>
      </div>
      <div class="cat-body">
        <div class="cat-grid"></div>
        <p class="cat-empty">No photos in this category yet.</p>
      </div>
    </article>`).join("");
}

function wireEvents() {
  dom["open-btn"].addEventListener("click", (e) => { e.stopPropagation(); dom["file-input"].click(); });
  dom.dropzone.addEventListener("click", () => { if (!state.classifying) dom["file-input"].click(); });
  dom.dropzone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !state.classifying) { e.preventDefault(); dom["file-input"].click(); }
  });
  dom["file-input"].addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

  let dragDepth = 0;
  ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) =>
    window.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }));
  dom.dropzone.addEventListener("dragenter", () => { dragDepth++; dom.dropzone.classList.add("dragover"); });
  dom.dropzone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dom.dropzone.classList.remove("dragover"); } });
  dom.dropzone.addEventListener("dragover", () => dom.dropzone.classList.add("dragover"));
  dom.dropzone.addEventListener("drop", (e) => {
    dragDepth = 0;
    dom.dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  dom["submit-btn"].addEventListener("click", runClassification);
  dom["clear-btn"].addEventListener("click", clearAll);
  dom["validate-btn"].addEventListener("click", loadTestSet);

  dom.lightbox.addEventListener("click", (e) => { if (e.target === dom.lightbox || e.target.classList.contains("lightbox-close")) closeLightbox(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
}

async function init() {
  cacheDom();
  buildCategoryCards();
  wireEvents();
  updateQueueCount();
  loadModel();
}

init();