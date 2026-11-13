/* Ordoline Sorter — dental photo classifier core (ES module). API v1 — see API.md / ordoline-sorter.d.ts.
 *
 * Environment-neutral: no DOM. Runs on a browser main thread, in Web Workers, and in Node/Deno/Bun.
 *   - Inference: onnxruntime (web from jsDelivr by default, or inject any build via options.ort)
 *   - Preprocessing: pure JS (PIL-style antialiased bilinear letterbox), identical in every environment
 *   - Image decoding: built in where createImageBitmap + OffscreenCanvas exist (browsers, workers);
 *     elsewhere pass decoded pixels (RawImage) or provide options.decode (e.g. with sharp in Node)
 *
 * Preprocessing matches training:
 *   EXIF orientation -> letterbox (longest edge -> N, bilinear, centered on black N x N)
 *   -> RGB [0,1] CHW -> Normalize(ImageNet mean/std)
 *
 * The optional drop-zone UI lives in ordoline-sorter-element.js.
 */

export const API_VERSION = "1.0";

// onnxruntime-web ESM build from jsDelivr (CORS-enabled, version-pinned; identical to the files in ../ort/).
const ORT_VERSION = "1.22.0";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Where the model lives. Must be served with CORS (Access-Control-Allow-Origin).
// Set this to the CDN URL once the model is hosted; until then it resolves next to this module.
const MODEL_CDN_URL = new URL("model/best.onnx", import.meta.url).href;

const DEFAULTS = {
  modelUrl: MODEL_CDN_URL,
  ortUrl: `${ORT_CDN}ort.all.min.mjs`,
  wasmPaths: null, // null: ORT_CDN when ort is loaded from ortUrl, otherwise the runtime's own default
  executionProviders: null, // null: ["webgpu", "wasm"] if WebGPU exists, else ["wasm"]; runtime default as last resort
  lowConfidenceThreshold: 0.6,
  topK: 3,
};
const MIN_MODEL_BYTES = 1 << 20;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const DEFAULT_CLASSES = [
  "ceph_front", "ceph_side", "extr_profile_rest", "extr_profile_smile", "extr_rest", "extr_smile",
  "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
];

export const CATEGORIES = Object.freeze([
  { id: "extraoral_frontal_rest", label: "Extraoral frontal (rest)" },
  { id: "extraoral_frontal_smile", label: "Extraoral frontal (smile)" },
  { id: "extraoral_profile_rest", label: "Extraoral profile (rest)" },
  { id: "extraoral_profile_smile", label: "Extraoral profile (smile)" },
  { id: "intraoral_frontal", label: "Intraoral frontal" },
  { id: "intraoral_left", label: "Intraoral left" },
  { id: "intraoral_right", label: "Intraoral right" },
  { id: "intraoral_upper", label: "Intraoral upper" },
  { id: "intraoral_lower", label: "Intraoral lower" },
  { id: "cephalometric_frontal", label: "Cephalometric (frontal)" },
  { id: "cephalometric_lateral", label: "Cephalometric (lateral)" },
].map(Object.freeze));
const LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

const CLASS_TO_CATEGORY = {
  extr_rest: "extraoral_frontal_rest",
  extr_smile: "extraoral_frontal_smile",
  extr_profile_rest: "extraoral_profile_rest",
  extr_profile_smile: "extraoral_profile_smile",
  intr_front: "intraoral_frontal",
  intr_left: "intraoral_left",
  intr_right: "intraoral_right",
  intr_upper: "intraoral_upper",
  intr_lower: "intraoral_lower",
  ceph_front: "cephalometric_frontal",
  ceph_side: "cephalometric_lateral",
};

// fallback for unknown class names; most specific patterns first
const SUFFIX_RULES = [
  ["profile_rest", "extraoral_profile_rest"], ["profile_smile", "extraoral_profile_smile"],
  ["ceph_front", "cephalometric_frontal"], ["ceph_side", "cephalometric_lateral"], ["lateral", "cephalometric_lateral"],
  ["rest", "extraoral_frontal_rest"], ["smile", "extraoral_frontal_smile"], ["front", "intraoral_frontal"],
  ["left", "intraoral_left"], ["right", "intraoral_right"], ["upper", "intraoral_upper"], ["lower", "intraoral_lower"],
];

function classToCategory(cls) {
  if (CLASS_TO_CATEGORY[cls]) return CLASS_TO_CATEGORY[cls];
  for (const [pattern, id] of SUFFIX_RULES) if (cls.includes(pattern)) return id;
  return CATEGORIES[0].id;
}

/* ---------------- Errors ---------------- */

export class OrdolineError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "OrdolineError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/* ---------------- Runtime + model loading ---------------- */

const ortImports = new Map();
async function loadOrt(opts) {
  if (opts.ort) return { ort: opts.ort, fromCdn: false };
  if (globalThis.ort?.InferenceSession) return { ort: globalThis.ort, fromCdn: false };
  if (!ortImports.has(opts.ortUrl)) {
    const p = import(/* webpackIgnore: true */ /* @vite-ignore */ opts.ortUrl);
    p.catch(() => ortImports.delete(opts.ortUrl));
    ortImports.set(opts.ortUrl, p);
  }
  const mod = await ortImports.get(opts.ortUrl);
  return { ort: mod.InferenceSession ? mod : mod.default, fromCdn: true };
}

async function readUrl(url, onProgress) {
  if (url.startsWith("file:")) { // Node/Deno/Bun: fetch() does not read file: URLs everywhere
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(new URL(url));
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return await res.arrayBuffer();
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

function parseClassNames(meta) {
  const raw = meta && meta.names;
  if (!raw) return null;
  const pairs = [...String(raw).matchAll(/(\d+)\s*:\s*'([^']+)'/g)];
  if (!pairs.length) return null;
  const byIndex = {};
  for (const [, idx, name] of pairs) byIndex[Number(idx)] = name;
  return Object.keys(byIndex).map(Number).sort((a, b) => a - b).map((i) => byIndex[i]);
}

function sessionInputSize(session) {
  const dims = session.inputMetadata?.[0]?.dims;
  return Array.isArray(dims) && dims.length >= 4 && Number.isFinite(dims[2]) && dims[2] > 0 ? dims[2] : 384;
}

/* ---------------- Input normalization + decoding ---------------- */

const isObj = (v) => v !== null && typeof v === "object";
const isRawImage = (v) => isObj(v) && ArrayBuffer.isView(v.data) && Number.isInteger(v.width) && Number.isInteger(v.height);
const isBlob = (v) => typeof Blob !== "undefined" && v instanceof Blob;
const isBytes = (v) => v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && !isRawImage(v));
const isWrapper = (v) => isObj(v) && "image" in v && !isRawImage(v) && !isBlob(v);

/** Split an ImageInput or {image, id?, name?} into its parts. */
function unwrap(input) {
  if (isWrapper(input)) return { image: input.image, id: input.id != null ? String(input.id) : null, name: input.name ?? null };
  return { image: input, id: null, name: null };
}

function inferName(image) {
  if (isBlob(image) && typeof image.name === "string") return image.name; // File
  const url = typeof image === "string" ? image : (isObj(image) && typeof image.currentSrc === "string" ? image.currentSrc || image.src : null);
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return null;
  try { return decodeURIComponent(url.split(/[?#]/)[0].split("/").pop()) || null; } catch { return null; }
}

/** Encoded bytes (file contents) for string/Blob/ArrayBuffer/TypedArray inputs, else null. */
async function encodedBytes(image) {
  if (typeof image === "string") {
    try { return new Uint8Array(await readUrl(image)); } catch (err) {
      throw new OrdolineError("FETCH_FAILED", `Could not fetch ${image}`, err);
    }
  }
  if (isBlob(image)) return new Uint8Array(await image.arrayBuffer());
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (ArrayBuffer.isView(image)) return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
  return null;
}

const hasBuiltinDecoder = () => typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";

/** Browser/worker decoding: anything createImageBitmap accepts -> RGBA pixels at native size. */
async function builtinDecode(source) {
  let bmp;
  try {
    // from-image applies EXIF orientation for encoded images
    bmp = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    try { bmp = await createImageBitmap(source); } catch (err) {
      if (err?.name === "TypeError") throw new OrdolineError("UNSUPPORTED_INPUT", "Unsupported input type", err);
      throw new OrdolineError("DECODE_FAILED", "Image could not be decoded", err);
    }
  }
  try {
    const { width, height } = bmp;
    if (!width || !height) throw new OrdolineError("DECODE_FAILED", "Image has zero size");
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, channels: 4 };
  } finally {
    if (bmp !== source) bmp.close?.();
  }
}

async function decode(image, userDecode) {
  if (isRawImage(image)) return image;
  if (typeof image === "string" || isBlob(image) || isBytes(image)) {
    if (userDecode) {
      const raw = await userDecode(await encodedBytes(image));
      if (!isRawImage(raw)) throw new OrdolineError("DECODE_FAILED", "options.decode did not return {data, width, height}");
      return raw;
    }
    if (!hasBuiltinDecoder()) {
      throw new OrdolineError("UNSUPPORTED_INPUT", "No image decoder in this environment: pass {data, width, height} pixels or options.decode");
    }
    if (isBlob(image)) return builtinDecode(image);
    return builtinDecode(new Blob([await encodedBytes(image)]));
  }
  // HTMLImageElement, canvas, ImageBitmap, VideoFrame, ...
  if (!hasBuiltinDecoder()) throw new OrdolineError("UNSUPPORTED_INPUT", `Unsupported input type: ${Object.prototype.toString.call(image)}`);
  if (typeof image.decode === "function" && "naturalWidth" in image) {
    try { await image.decode(); } catch (err) { throw new OrdolineError("DECODE_FAILED", "Image element could not be decoded", err); }
  }
  return builtinDecode(image);
}

/* ---------------- Preprocessing (pure JS) ---------------- */

// PIL Image.resize(BILINEAR) coefficients: triangle filter, widened when downscaling (antialias).
function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const fscale = Math.max(scale, 1);
  const support = fscale; // bilinear support = 1
  const bounds = new Int32Array(outSize * 2);
  const ksize = Math.ceil(support) * 2 + 1;
  const weights = new Float32Array(outSize * ksize);
  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale;
    const xmin = Math.max(0, Math.floor(center - support + 0.5));
    const xmax = Math.min(inSize, Math.floor(center + support + 0.5));
    let total = 0;
    for (let j = 0; j < xmax - xmin; j++) {
      const w = Math.max(0, 1 - Math.abs((j + xmin - center + 0.5) / fscale));
      weights[x * ksize + j] = w;
      total += w;
    }
    if (total) for (let j = 0; j < xmax - xmin; j++) weights[x * ksize + j] /= total;
    bounds[2 * x] = xmin;
    bounds[2 * x + 1] = xmax - xmin;
  }
  return { bounds, weights, ksize };
}

const clamp8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** RawImage -> letterboxed, normalized Float32 CHW tensor data of size x size. */
function preprocess(raw, size) {
  const { width: w, height: h, data } = raw;
  const ch = raw.channels ?? data.length / (w * h);
  if (!(ch === 3 || ch === 4) || data.length < w * h * ch) {
    throw new OrdolineError("DECODE_FAILED", `Pixel data must be RGB or RGBA (${w}x${h}, ${data.length} values)`);
  }
  const scale = size / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  // horizontal pass: w x h -> nw x h (RGB, rounded to 8 bit like PIL)
  const hc = resampleCoeffs(w, nw);
  const tmp = new Uint8Array(nw * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < nw; x++) {
      const start = hc.bounds[2 * x], n = hc.bounds[2 * x + 1], k = x * hc.ksize;
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++) {
        const wt = hc.weights[k + j], p = (row + start + j) * ch;
        r += data[p] * wt; g += data[p + 1] * wt; b += data[p + 2] * wt;
      }
      const o = (y * nw + x) * 3;
      tmp[o] = clamp8(r); tmp[o + 1] = clamp8(g); tmp[o + 2] = clamp8(b);
    }
  }

  // vertical pass into the letterbox canvas, then normalize; padding is black (0) before normalization
  const vc = resampleCoeffs(h, nh);
  const left = Math.floor((size - nw) / 2), top = Math.floor((size - nh) / 2);
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) out.fill(-MEAN[c] / STD[c], c * plane, (c + 1) * plane);
  for (let y = 0; y < nh; y++) {
    const start = vc.bounds[2 * y], n = vc.bounds[2 * y + 1], k = y * vc.ksize;
    const orow = (top + y) * size + left;
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++) {
        const wt = vc.weights[k + j], p = ((start + j) * nw + x) * 3;
        r += tmp[p] * wt; g += tmp[p + 1] * wt; b += tmp[p + 2] * wt;
      }
      const o = orow + x;
      out[o] = (clamp8(r) / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (clamp8(g) / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (clamp8(b) / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

/* ---------------- Public API ---------------- */

const sorters = new Map();

/**
 * Load the runtime + model once and return a Sorter. Calls with the same options share one instance
 * (options holding objects/functions such as ort, model or decode always create a new instance).
 * Rejects with OrdolineError code RUNTIME_LOAD_FAILED / MODEL_LOAD_FAILED.
 */
export function createSorter(options = {}) {
  const { onProgress, ...rest } = options;
  const opts = { ...DEFAULTS, ...rest };
  const cacheable = !opts.ort && !opts.model && !opts.decode;
  const key = cacheable ? JSON.stringify(opts) : null;
  if (key && sorters.has(key)) return sorters.get(key);
  const p = buildSorter(opts, onProgress, key);
  if (key) {
    p.catch(() => sorters.delete(key)); // allow retry after failure
    sorters.set(key, p);
  }
  return p;
}

async function buildSorter(opts, onProgress, cacheKey) {
  let ort, fromCdn;
  try {
    ({ ort, fromCdn } = await loadOrt(opts));
  } catch (err) {
    throw new OrdolineError("RUNTIME_LOAD_FAILED", `Could not load ONNX runtime from ${opts.ortUrl}`, err);
  }
  if (ort.env?.wasm) {
    const wasmPaths = opts.wasmPaths ?? (fromCdn ? ORT_CDN : null);
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = 1; // no COOP/COEP headers required on the host page
  }
  if (ort.env) ort.env.logLevel = "error";

  let buffer;
  try {
    if (opts.model) {
      buffer = opts.model instanceof ArrayBuffer ? opts.model
        : opts.model.buffer.slice(opts.model.byteOffset, opts.model.byteOffset + opts.model.byteLength);
      onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength, fraction: 1 });
    } else {
      buffer = await readUrl(opts.modelUrl, (loaded, total) => onProgress?.({ loaded, total, fraction: total ? loaded / total : 0 }));
    }
  } catch (err) {
    throw new OrdolineError("MODEL_LOAD_FAILED", `Could not load model from ${opts.modelUrl}`, err);
  }
  if (buffer.byteLength < MIN_MODEL_BYTES) {
    throw new OrdolineError("MODEL_LOAD_FAILED", `Model is only ${buffer.byteLength} bytes (Git LFS pointer?)`);
  }

  const eps = opts.executionProviders ?? (globalThis.navigator?.gpu ? ["webgpu", "wasm"] : ["wasm"]);
  const attempts = [...eps.map((_, i) => eps.slice(i)), null]; // null: runtime default (e.g. "cpu" in onnxruntime-node)
  let session = null, backend = null, lastErr;
  for (const list of attempts) {
    try {
      session = await ort.InferenceSession.create(new Uint8Array(buffer), list ? { executionProviders: list } : {});
      backend = list ? list[0] : "default";
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!session) throw new OrdolineError("MODEL_LOAD_FAILED", "Could not create ONNX session", lastErr);

  let classNames = DEFAULT_CLASSES;
  try { classNames = parseClassNames(await session.metadata) || classNames; } catch { /* keep defaults */ }
  const inputSize = sessionInputSize(session);
  const classCategory = classNames.map(classToCategory);
  const model = Object.freeze({ url: opts.model ? null : opts.modelUrl, backend, inputSize, classes: Object.freeze([...classNames]) });

  // ORT sessions must not run concurrently; serialize inference calls.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };
  let disposed = false;
  let autoId = 0;

  function buildResult(probs, k) {
    let sum = 0;
    for (let i = 0; i < probs.length; i++) sum += probs[i];
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
    let best = 0;
    for (let i = 0; i < probs.length; i++) {
      scores[classCategory[i]] += probs[i] / (sum || 1);
      if (probs[i] > probs[best]) best = i;
    }
    const top = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, k))
      .map(([category, confidence]) => ({ category, label: LABELS[category], confidence }));
    return { modelClass: classNames[best] || String(best), scores, top };
  }

  async function classify(input, callOpts = {}) {
    const { image, id, name } = unwrap(input);
    const base = { id: id ?? callOpts.id ?? `img-${++autoId}`, name: name ?? inferName(image) };
    const t0 = performance.now();
    try {
      if (disposed) throw new OrdolineError("DISPOSED", "Sorter has been disposed");
      const raw = await decode(image, opts.decode);
      const data = preprocess(raw, inputSize);
      const probs = await exclusive(async () => {
        if (disposed) throw new OrdolineError("DISPOSED", "Sorter has been disposed");
        try {
          const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, inputSize, inputSize]) };
          return (await session.run(feeds))[session.outputNames[0]].data;
        } catch (err) {
          throw new OrdolineError("INFERENCE_FAILED", "Model inference failed", err);
        }
      });
      const { modelClass, scores, top } = buildResult(probs, callOpts.topK ?? opts.topK);
      const confidence = top[0].confidence;
      return {
        ...base,
        ok: true,
        category: top[0].category,
        label: top[0].label,
        confidence,
        lowConfidence: confidence < opts.lowConfidenceThreshold,
        top,
        scores,
        modelClass,
        image: { width: raw.width, height: raw.height },
        timingMs: Math.round(performance.now() - t0),
      };
    } catch (err) {
      const e = err instanceof OrdolineError ? err : new OrdolineError("INFERENCE_FAILED", String(err?.message || err), err);
      return { ...base, ok: false, error: { code: e.code, message: e.message } };
    }
  }

  async function sort(inputs, callOpts = {}) {
    const list = Array.from(inputs);
    const results = [];
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
    const t0 = performance.now();
    for (let i = 0; i < list.length; i++) {
      if (callOpts.signal?.aborted) throw callOpts.signal.reason ?? new OrdolineError("ABORTED", "Sort was aborted");
      const r = { index: i, ...(await classify(list[i], { topK: callOpts.topK, id: String(i) })) };
      results.push(r);
      if (r.ok) byCategory[r.category].push(r.id);
      callOpts.onResult?.(r, { done: i + 1, total: list.length });
    }
    const conf = new Map(results.map((r) => [r.id, r.ok ? r.confidence : 0]));
    for (const id in byCategory) byCategory[id].sort((a, b) => conf.get(b) - conf.get(a));
    const failed = results.filter((r) => !r.ok).length;
    return {
      apiVersion: API_VERSION,
      model,
      results,
      byCategory,
      summary: {
        total: results.length,
        sorted: results.length - failed,
        failed,
        lowConfidence: results.filter((r) => r.ok && r.lowConfidence).length,
        timingMs: Math.round(performance.now() - t0),
      },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (cacheKey) sorters.delete(cacheKey);
    chain.then(() => session.release?.());
  }

  return Object.freeze({ apiVersion: API_VERSION, model, categories: CATEGORIES, classify, sort, dispose });
}
