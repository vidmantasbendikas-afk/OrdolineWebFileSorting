/* <ordoline-sorter> — optional drop-zone UI on top of the DOM-free core (../sorter/ordoline-sorter.ts).
 *
 *   <script type="module" src="ordoline-sorter-element.js"></script>
 *   <ordoline-sorter model-url="https://cdn.example.com/best.onnx"></ordoline-sorter>
 *
 * Attributes: model-url, low-confidence-threshold, no-results (hide built-in result grid),
 *             no-worker (run on the page's main thread instead of a Web Worker)
 * Methods:    sort(inputs) -> Promise<SortResult | null>, stop(), clear(), ready (Promise)
 * Events:     ordoline-ready, ordoline-progress, ordoline-result, ordoline-done, ordoline-error
 */
import {
  createSorter, CATEGORIES, OrdolineError,
  type ClassificationSuccess, type ErrorCode, type ModelInfo, type IndexedResult, type Sorter, type SorterInput,
  type SorterOptions, type SortResult,
} from "../sorter/ordoline-sorter.js";

export * from "../sorter/ordoline-sorter.js";

/** `detail` of each event the element dispatches. */
export interface OrdolineSorterEventMap {
  "ordoline-ready": { apiVersion: string; model: ModelInfo };
  "ordoline-progress": { phase: "model" | "sort"; fraction: number; loaded?: number; total?: number; done?: number };
  "ordoline-result": { result: IndexedResult; input: SorterInput };
  "ordoline-done": { result: SortResult; inputs: SorterInput[] };
  "ordoline-error": { code: ErrorCode | "ERROR"; message: string };
}

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
.stop { margin-left:8px; font:inherit; font-size:12px; padding:1px 8px; cursor:pointer; }
.hidden { display:none; }
`;

const isImageFile = (f: unknown) =>
  !(f instanceof File) || f.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f.name);

export class OrdolineSorterElement extends HTMLElement {
  /** The underlying sorter, once the model has loaded. */
  sorter: Sorter | null = null;

  private loading: Promise<void> | null = null;
  private busy = false;
  private stopper: AbortController | null = null;
  private urls: string[] = [];
  private readonly drop: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLSpanElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly bar: HTMLDivElement;
  private readonly cats: HTMLDivElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="drop" part="dropzone" tabindex="0" role="button" aria-disabled="true">
        <slot name="prompt">Drop dental photos here or click to choose</slot>
        <input type="file" accept="image/*" multiple hidden />
      </div>
      <div><span class="status" part="status">Loading model…</span><button class="stop hidden" part="stop" type="button">Stop</button></div>
      <div class="bar" part="progress"><div></div></div>
      <div class="cats" part="results"></div>`;
    this.drop = root.querySelector(".drop")!;
    this.input = root.querySelector("input")!;
    this.status = root.querySelector(".status")!;
    this.stopButton = root.querySelector(".stop")!;
    this.stopButton.addEventListener("click", () => this.stop());
    this.bar = root.querySelector(".bar")!;
    this.cats = root.querySelector(".cats")!;

    const run = (files: File[]) => this.sort(files).catch((err: unknown) =>
      this.emit("ordoline-error", { code: (err as OrdolineError).code ?? "ERROR", message: String((err as Error).message ?? err) }));
    const pick = () => { if (!this.busy && this.sorter) this.input.click(); };
    this.drop.addEventListener("click", pick);
    this.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    this.input.addEventListener("change", () => { void run([...(this.input.files ?? [])]); this.input.value = ""; });
    for (const t of ["dragenter", "dragover"]) {
      this.drop.addEventListener(t, (e) => { e.preventDefault(); this.drop.classList.add("over"); });
    }
    this.drop.addEventListener("dragleave", () => this.drop.classList.remove("over"));
    this.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      this.drop.classList.remove("over");
      if (e.dataTransfer?.files) void run([...e.dataTransfer.files]);
    });
  }

  connectedCallback(): void {
    if (this.loading) return;
    const opts: SorterOptions = {
      worker: !this.hasAttribute("no-worker"),
      onProgress: (p) => {
        this.setProgress(p.fraction, `Loading model… ${Math.round(p.fraction * 100)}%`);
        this.emit("ordoline-progress", { phase: "model", ...p });
      },
    };
    const url = this.getAttribute("model-url");
    if (url) opts.modelUrl = new URL(url, document.baseURI).href;
    const th = parseFloat(this.getAttribute("low-confidence-threshold") ?? "");
    if (Number.isFinite(th)) opts.lowConfidenceThreshold = th;

    this.loading = createSorter(opts).then((s) => {
      this.sorter = s;
      this.drop.setAttribute("aria-disabled", "false");
      this.bar.classList.add("hidden");
      this.status.textContent = `Ready (${s.model.backend === "webgpu" ? "WebGPU" : "WASM"})`;
      this.emit("ordoline-ready", { apiVersion: s.apiVersion, model: s.model });
    }, (err: OrdolineError) => {
      this.status.textContent = `Model failed to load: ${err.message}`;
      this.emit("ordoline-error", { code: err.code ?? "MODEL_LOAD_FAILED", message: err.message });
    });
  }

  disconnectedCallback(): void { this.clear(); }

  /** Resolves when the model has loaded (or failed to). */
  get ready(): Promise<void> { return this.loading ?? Promise.resolve(); }

  /** Stop the running sort. sort() then resolves with the photos done so far (`summary.aborted: true`). */
  stop(): void {
    this.stopper?.abort();
  }

  clear(): void {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.cats.replaceChildren();
  }

  /** Classify inputs (any ImageInput) and render them grouped by category. Resolves with the SortResult. */
  async sort(inputs: Iterable<SorterInput> | ArrayLike<SorterInput>): Promise<SortResult | null> {
    const list = Array.from(inputs ?? []).filter(isImageFile);
    if (!list.length) return null;
    if (this.busy) throw new OrdolineError("BUSY", "A sort is already running");
    await this.loading;
    if (!this.sorter) throw new OrdolineError("MODEL_LOAD_FAILED", "Model is not loaded");

    this.busy = true;
    this.stopper = new AbortController();
    this.stopButton.classList.remove("hidden");
    this.drop.setAttribute("aria-disabled", "true");
    this.setProgress(0, `Sorting 0 / ${list.length}`);
    try {
      const result = await this.sorter.sort(list, {
        signal: this.stopper.signal,
        onResult: (r, p) => {
          this.setProgress(p.done / p.total, `Sorting ${p.done} / ${p.total}`);
          if (r.ok) this.render(r, list[r.index]);
          this.emit("ordoline-result", { result: r, input: list[r.index] });
          this.emit("ordoline-progress", { phase: "sort", ...p, fraction: p.done / p.total });
        },
      });
      const s = result.summary;
      this.status.textContent = (s.aborted ? "Stopped. " : "") + `Sorted ${s.sorted} photo(s)` +
        (s.failed ? `, ${s.failed} failed` : "") + (s.lowConfidence ? `, ${s.lowConfidence} uncertain` : "") +
        (s.skipped ? `, ${s.skipped} not processed` : "");
      this.emit("ordoline-done", { result, inputs: list });
      return result;
    } finally {
      this.bar.classList.add("hidden");
      this.stopButton.classList.add("hidden");
      this.stopper = null;
      this.busy = false;
      this.drop.setAttribute("aria-disabled", "false");
    }
  }

  private emit<K extends keyof OrdolineSorterEventMap>(type: K, detail: OrdolineSorterEventMap[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private setProgress(fraction: number, text?: string): void {
    this.bar.classList.remove("hidden");
    (this.bar.firstElementChild as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
    if (text) this.status.textContent = text;
  }

  private thumbSrc(input: SorterInput): string | null {
    const image = input && typeof input === "object" && "image" in input && !(input instanceof Blob) ? input.image : input;
    if (image instanceof Blob) { const u = URL.createObjectURL(image); this.urls.push(u); return u; }
    if (typeof image === "string") return image;
    return null;
  }

  private render(r: ClassificationSuccess, input: SorterInput): void {
    if (this.hasAttribute("no-results")) return;
    let card = this.cats.querySelector<HTMLDivElement>(`[data-cat="${r.category}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "cat";
      card.dataset.cat = r.category;
      card.setAttribute("part", "category");
      card.innerHTML = `<h4><span></span><span class="n">0</span></h4><div class="grid"></div>`;
      card.querySelector("h4 span")!.textContent = r.label;
      const order = CATEGORIES.findIndex((c) => c.id === r.category);
      const next = [...this.cats.children].find(
        (c) => CATEGORIES.findIndex((x) => x.id === (c as HTMLElement).dataset.cat) > order);
      this.cats.insertBefore(card, next ?? null);
    }
    const chip = document.createElement("div");
    chip.className = "chip" + (r.lowConfidence ? " low" : "");
    chip.title = `${r.name ?? r.id} → ${r.label} (${(r.confidence * 100).toFixed(1)}%)`;
    chip.innerHTML = `<img alt="" /><span>${Math.round(r.confidence * 100)}%</span>`;
    const src = this.thumbSrc(input);
    if (src) chip.querySelector("img")!.src = src;
    card.querySelector(".grid")!.appendChild(chip);
    const n = card.querySelector(".n")!;
    n.textContent = String(Number(n.textContent) + 1);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ordoline-sorter": OrdolineSorterElement;
  }
}

if (!customElements.get("ordoline-sorter")) customElements.define("ordoline-sorter", OrdolineSorterElement);
