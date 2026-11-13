/* <ordoline-sorter> — optional drop-zone UI on top of the DOM-free core (ordoline-sorter.js).
 *
 *   <script type="module" src="ordoline-sorter-element.js"></script>
 *   <ordoline-sorter model-url="https://cdn.example.com/best.onnx"></ordoline-sorter>
 *
 * Attributes: model-url, low-confidence-threshold, no-results (hide built-in result grid),
 *             no-worker (run on the page's main thread instead of a Web Worker)
 * Methods:    sort(inputs) -> Promise<SortResult>, clear(), ready (Promise)
 * Events:     ordoline-ready, ordoline-progress, ordoline-result, ordoline-done, ordoline-error
 */
import { createSorter, CATEGORIES, OrdolineError } from "./ordoline-sorter.js";

export * from "./ordoline-sorter.js";

const STYLE = `
:host { display:block; font:14px/1.4 system-ui, sans-serif; color:#1f2937; --accent:#0d9488; }
.drop { border:2px dashed #cbd5e1; border-radius:12px; padding:24px; text-align:center; cursor:pointer; background:#f8fafc; }
.drop.over { border-color:var(--accent); background:#f0fdfa; }
.drop[aria-disabled="true"] { opacity:.6; cursor:progress; }
.status { margin:8px 0; font-size:13px; color:#64748b; }
.bar { height:4px; background:#e2e8f0; border-radius:2px; overflow:hidden; }
.bar > div { height:100%; width:0; background:var(--accent); transition:width .15s; }
.cats { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin-top:12px; }
.cat { border:1px solid #e2e8f0; border-radius:10px; padding:10px; }
.cat h4 { margin:0 0 8px; font-size:13px; display:flex; justify-content:space-between; }
.grid { display:flex; flex-wrap:wrap; gap:6px; }
.chip { position:relative; width:64px; height:64px; border-radius:6px; overflow:hidden; background:#000; }
.chip.low { outline:2px solid #f59e0b; }
.chip img { width:100%; height:100%; object-fit:cover; }
.chip span { position:absolute; right:2px; bottom:2px; font-size:10px; background:rgba(0,0,0,.65); color:#fff; padding:0 3px; border-radius:3px; }
.hidden { display:none; }
`;

const emit = (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
const isImageFile = (f) => !(f instanceof File) || f.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f.name);

export class OrdolineSorterElement extends HTMLElement {
  constructor() {
    super();
    this._urls = [];
    this._busy = false;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="drop" part="dropzone" tabindex="0" role="button" aria-disabled="true">
        <slot name="prompt">Drop dental photos here or click to choose</slot>
        <input type="file" accept="image/*" multiple hidden />
      </div>
      <div class="status" part="status">Loading model…</div>
      <div class="bar" part="progress"><div></div></div>
      <div class="cats" part="results"></div>`;
    this._drop = root.querySelector(".drop");
    this._input = root.querySelector("input");
    this._status = root.querySelector(".status");
    this._bar = root.querySelector(".bar");
    this._cats = root.querySelector(".cats");

    const run = (files) => this.sort(files).catch((err) => emit(this, "ordoline-error", { code: err.code || "ERROR", message: err.message }));
    const pick = () => { if (!this._busy && this.sorter) this._input.click(); };
    this._drop.addEventListener("click", pick);
    this._drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    this._input.addEventListener("change", () => { run([...this._input.files]); this._input.value = ""; });
    for (const t of ["dragenter", "dragover"]) this._drop.addEventListener(t, (e) => { e.preventDefault(); this._drop.classList.add("over"); });
    this._drop.addEventListener("dragleave", () => this._drop.classList.remove("over"));
    this._drop.addEventListener("drop", (e) => {
      e.preventDefault();
      this._drop.classList.remove("over");
      if (e.dataTransfer?.files) run([...e.dataTransfer.files]);
    });
  }

  connectedCallback() {
    if (this._loading) return;
    const opts = {
      onProgress: (p) => {
        this._setProgress(p.fraction, `Loading model… ${Math.round(p.fraction * 100)}%`);
        emit(this, "ordoline-progress", { phase: "model", ...p });
      },
    };
    const url = this.getAttribute("model-url");
    if (url) opts.modelUrl = new URL(url, document.baseURI).href;
    opts.worker = !this.hasAttribute("no-worker");
    const th = parseFloat(this.getAttribute("low-confidence-threshold"));
    if (Number.isFinite(th)) opts.lowConfidenceThreshold = th;

    this._loading = createSorter(opts).then((s) => {
      this.sorter = s;
      this._drop.setAttribute("aria-disabled", "false");
      this._bar.classList.add("hidden");
      this._status.textContent = `Ready (${s.model.backend === "webgpu" ? "WebGPU" : "WASM"})`;
      emit(this, "ordoline-ready", { apiVersion: s.apiVersion, model: s.model });
    }, (err) => {
      this._status.textContent = `Model failed to load: ${err.message}`;
      emit(this, "ordoline-error", { code: err.code || "MODEL_LOAD_FAILED", message: err.message });
    });
  }

  disconnectedCallback() { this.clear(); }

  /** Resolves when the model has loaded (or failed to). */
  get ready() { return this._loading; }

  clear() {
    this._urls.forEach((u) => URL.revokeObjectURL(u));
    this._urls = [];
    this._cats.innerHTML = "";
  }

  /** Classify inputs (any ImageInput) and render them grouped by category. Resolves with the SortResult. */
  async sort(inputs) {
    const list = Array.from(inputs || []).filter(isImageFile);
    if (!list.length) return null;
    if (this._busy) throw new OrdolineError("BUSY", "A sort is already running");
    await this._loading;
    if (!this.sorter) throw new OrdolineError("MODEL_LOAD_FAILED", "Model is not loaded");

    this._busy = true;
    this._drop.setAttribute("aria-disabled", "true");
    this._setProgress(0, `Sorting 0 / ${list.length}`);
    try {
      const result = await this.sorter.sort(list, {
        onResult: (r, p) => {
          this._setProgress(p.done / p.total, `Sorting ${p.done} / ${p.total}`);
          if (r.ok) this._render(r, list[r.index]);
          emit(this, "ordoline-result", { result: r, input: list[r.index] });
          emit(this, "ordoline-progress", { phase: "sort", ...p, fraction: p.done / p.total });
        },
      });
      const s = result.summary;
      this._status.textContent = `Sorted ${s.sorted} photo(s)` + (s.failed ? `, ${s.failed} failed` : "") +
        (s.lowConfidence ? `, ${s.lowConfidence} uncertain` : "");
      emit(this, "ordoline-done", { result, inputs: list });
      return result;
    } finally {
      this._bar.classList.add("hidden");
      this._busy = false;
      this._drop.setAttribute("aria-disabled", "false");
    }
  }

  _setProgress(fraction, text) {
    this._bar.classList.remove("hidden");
    this._bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
    if (text) this._status.textContent = text;
  }

  _thumbSrc(input) {
    const image = input && typeof input === "object" && "image" in input && !(input instanceof Blob) ? input.image : input;
    if (image instanceof Blob) { const u = URL.createObjectURL(image); this._urls.push(u); return u; }
    if (typeof image === "string") return image;
    return null;
  }

  _render(r, input) {
    if (this.hasAttribute("no-results")) return;
    let card = this._cats.querySelector(`[data-cat="${r.category}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "cat";
      card.dataset.cat = r.category;
      card.setAttribute("part", "category");
      card.innerHTML = `<h4><span></span><span class="n">0</span></h4><div class="grid"></div>`;
      card.querySelector("h4 span").textContent = r.label;
      const order = CATEGORIES.findIndex((c) => c.id === r.category);
      const next = [...this._cats.children].find((c) => CATEGORIES.findIndex((x) => x.id === c.dataset.cat) > order);
      this._cats.insertBefore(card, next || null);
    }
    const chip = document.createElement("div");
    chip.className = "chip" + (r.lowConfidence ? " low" : "");
    chip.title = `${r.name ?? r.id} → ${r.label} (${(r.confidence * 100).toFixed(1)}%)`;
    chip.innerHTML = `<img alt="" /><span>${Math.round(r.confidence * 100)}%</span>`;
    const src = this._thumbSrc(input);
    if (src) chip.querySelector("img").src = src;
    card.querySelector(".grid").appendChild(chip);
    const n = card.querySelector(".n");
    n.textContent = String(Number(n.textContent) + 1);
  }
}

if (!customElements.get("ordoline-sorter")) customElements.define("ordoline-sorter", OrdolineSorterElement);
