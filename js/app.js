/* Ordoline — Dental Photo Sorting page.
 * UI only: all loading, preprocessing and classification go through the sorter API (../sorter/ordoline-sorter.js).
 */
import { createSorter, CATEGORIES } from "../sorter/ordoline-sorter.js";

// test-set folder -> accepted category ids
const TEST_TRUTH = {
  ceph_front: ["cephalometric_frontal"],
  ceph_side: ["cephalometric_lateral"],
  extr_profile: ["extraoral_profile_rest", "extraoral_profile_smile"],
  extr_rest: ["extraoral_frontal_rest"],
  extr_smile: ["extraoral_frontal_smile"],
  intr_front: ["intraoral_frontal"],
  intr_left: ["intraoral_left"],
  intr_right: ["intraoral_right"],
  intr_upper: ["intraoral_upper"],
  intr_lower: ["intraoral_lower"],
};

// Exposed on window for debugging in the browser console.
const state = {
  sorter: null,
  modelReady: false,
  classifying: false,
  activeEP: null,
  inputSize: null,
  classNames: [],
  items: new Map(), // id -> { id, file, url, truth, result }
  queueOrder: [],
  nextId: 1,
};
window.state = state;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/* ---------------- Model ---------------- */

/** Optional deployment config ({ modelUrl }) served next to the page; without it the module's default model URL is used. */
async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-cache" });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function loadModel() {
  const config = await loadConfig();
  try {
    state.sorter = await createSorter({
      worker: true, // keep the page responsive while sorting
      ...(config.modelUrl ? { modelUrl: config.modelUrl } : {}),
      onProgress: ({ fraction }) => ($("model-status").textContent = `loading… ${Math.round(fraction * 100)}%`),
    });
  } catch (err) {
    console.error(err);
    $("model-status").textContent = `failed to load (${err.code}: ${err.message})`;
    return;
  }
  const { model } = state.sorter;
  Object.assign(state, { modelReady: true, activeEP: model.backend, inputSize: model.inputSize, classNames: [...model.classes] });
  const engine = (model.backend === "webgpu" ? "WebGPU" : `WASM, ${model.threads} thread${model.threads === 1 ? "" : "s"}`) +
    (model.worker ? ", in worker" : "");
  $("model-status").textContent = `ready (${engine}, ${model.source === "cache" ? "from cache" : "downloaded"})`;
  updateButtons();
}

/* ---------------- Queue ---------------- */

function addFiles(files, truth = null) {
  for (const file of files) {
    if (!(file.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(file.name))) continue;
    const item = { id: `item-${state.nextId++}`, file, url: URL.createObjectURL(file), truth, result: null };
    state.items.set(item.id, item);
    state.queueOrder.push(item.id);
    const chip = el("span", { className: "q-item", textContent: file.name, title: file.name });
    chip.dataset.id = item.id;
    $("queue-grid").append(chip);
  }
  renderQueue();
}

function renderQueue() {
  $("queue-count").textContent = String(state.queueOrder.length);
  updateButtons();
}

function updateButtons() {
  const busy = state.classifying;
  $("submit-btn").disabled = !state.modelReady || busy || !state.queueOrder.length;
  $("clear-btn").disabled = busy || !state.items.size;
  $("validate-btn").disabled = !state.modelReady || busy;
  $("dropzone").classList.toggle("disabled", busy);
}

function clearAll() {
  for (const item of state.items.values()) URL.revokeObjectURL(item.url);
  state.items.clear();
  state.queueOrder = [];
  $("queue-grid").replaceChildren();
  $("overall-result").classList.add("hidden");
  buildCategoryCards();
  renderQueue();
}

/* ---------------- Sorting ---------------- */

async function runClassification() {
  if (state.classifying || !state.modelReady || !state.queueOrder.length) return;
  state.classifying = true;
  updateButtons();

  const batch = state.queueOrder.map((id) => state.items.get(id));
  const inputs = batch.map((item) => ({ image: item.file, id: item.id, name: item.file.name }));

  const { summary } = await state.sorter.sort(inputs, {
    onResult: (r, { done, total }) => {
      $("sort-progress-text").textContent = `${done} / ${total}`;
      state.queueOrder = state.queueOrder.filter((id) => id !== r.id);
      $("queue-count").textContent = String(state.queueOrder.length);
      const item = state.items.get(r.id);
      item.result = r;
      const chip = $("queue-grid").querySelector(`[data-id="${r.id}"]`);
      if (r.ok) {
        chip?.remove();
        placeInCategory(item);
      } else {
        console.error(`${r.name}: ${r.error.code} ${r.error.message}`);
        chip?.classList.add("error");
        if (chip) chip.title = `${r.error.code}: ${r.error.message}`;
      }
    },
  });

  $("sort-progress-text").textContent =
    `sorted ${summary.sorted}` + (summary.failed ? `, ${summary.failed} failed` : "") +
    (summary.lowConfidence ? `, ${summary.lowConfidence} low confidence` : "");
  showAccuracy();
  state.classifying = false;
  renderQueue();
}

function placeInCategory(item) {
  const r = item.result;
  const card = document.querySelector(`.cat-card[data-cat="${r.category}"]`);
  const wrong = item.truth && !item.truth.includes(r.category);
  const chip = el("div", {
    className: "chip" + (wrong ? " mismatch" : r.lowConfidence ? " low" : ""),
    title: `${r.name} → ${r.label} (${(r.confidence * 100).toFixed(1)}%)` + (wrong ? ` · expected ${item.truth.join(" / ")}` : ""),
  }, el("img", { src: item.url, alt: r.name ?? "" }), el("span", { textContent: `${Math.round(r.confidence * 100)}%` }));
  chip.dataset.conf = (r.confidence * 100).toFixed(1);

  // keep each category sorted by confidence, highest first
  const grid = card.querySelector(".cat-grid");
  const before = [...grid.children].find((c) => Number(c.dataset.conf) < r.confidence * 100);
  grid.insertBefore(chip, before ?? null);
  card.querySelector(".cat-count").textContent = String(grid.children.length);
}

function showAccuracy() {
  const tested = [...state.items.values()].filter((i) => i.truth && i.result?.ok);
  const line = $("overall-result");
  document.querySelectorAll(".acc-badge").forEach((b) => b.remove());
  if (!tested.length) { line.classList.add("hidden"); return; }

  // per-category accuracy, grouped by the expected category
  const per = new Map();
  for (const i of tested) {
    const key = i.truth[0];
    const s = per.get(key) ?? { total: 0, correct: 0 };
    s.total++;
    if (i.truth.includes(i.result.category)) s.correct++;
    per.set(key, s);
  }
  for (const [cat, s] of per) {
    document.querySelector(`.cat-card[data-cat="${cat}"] .cat-meta`)?.append(
      el("span", { className: "acc-badge " + (s.correct === s.total ? "acc-good" : "acc-bad"), textContent: `${s.correct}/${s.total}` }));
  }
  const correct = [...per.values()].reduce((a, s) => a + s.correct, 0);
  line.textContent = `Test-set accuracy: ${correct}/${tested.length} = ${((correct / tested.length) * 100).toFixed(1)}%`;
  line.classList.remove("hidden");
}

/* ---------------- Test set ---------------- */

async function loadTestSet() {
  const perClass = Number($("test-count").value) || 3;
  const manifest = await (await fetch("js/testfiles.json")).json();
  $("validate-btn").disabled = true;
  for (const dir of Object.keys(manifest).sort()) {
    const files = await Promise.all(manifest[dir].slice(0, perClass).map(async (name) => {
      const res = await fetch(`data/test/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`);
      if (!res.ok) { console.warn("missing test image", dir, name); return null; }
      const blob = await res.blob();
      return new File([blob], name, { type: blob.type || "image/jpeg" });
    }));
    addFiles(files.filter(Boolean), TEST_TRUTH[dir] ?? null);
  }
  runClassification();
}

/* ---------------- Wiring ---------------- */

function buildCategoryCards() {
  $("results").replaceChildren(...CATEGORIES.map((c) => {
    const card = el("div", { className: "cat-card" },
      el("div", { className: "cat-head" },
        el("h2", { textContent: c.label }),
        el("span", { className: "cat-meta muted" }, el("span", { className: "cat-count", textContent: "0" }))),
      el("div", { className: "cat-grid" }));
    card.dataset.cat = c.id;
    return card;
  }));
}

function wireEvents() {
  const dz = $("dropzone"), input = $("file-input");
  dz.addEventListener("click", () => !state.classifying && input.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { addFiles([...input.files]); input.value = ""; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  dz.addEventListener("dragover", () => dz.classList.add("over"));
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => { dz.classList.remove("over"); addFiles([...(e.dataTransfer?.files ?? [])]); });

  $("submit-btn").addEventListener("click", runClassification);
  $("clear-btn").addEventListener("click", clearAll);
  $("validate-btn").addEventListener("click", loadTestSet);
}

buildCategoryCards();
wireEvents();
loadModel();
