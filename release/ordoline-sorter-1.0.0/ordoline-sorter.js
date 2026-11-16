/*! Ordoline Sorter 1.0.0 — single-file build. Docs: API.md */

var ORT_VERSION = "1.22.0";
var ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
var ORT_WASM_URL = `${ORT_CDN}ort.wasm.min.mjs`;
var ORT_ALL_URL = `${ORT_CDN}ort.all.min.mjs`;
var MODEL_CDN_URL = typeof __ORDOLINE_MODEL_URL__ === "string" ? __ORDOLINE_MODEL_URL__ : new URL("model/best.onnx", import.meta.url).href;
var MODEL_SHA256 = typeof __ORDOLINE_MODEL_SHA256__ === "string" ? __ORDOLINE_MODEL_SHA256__ : null;
var DEFAULTS = {
  modelUrl: MODEL_CDN_URL,
  modelSha256: MODEL_SHA256,
  // only for the default model URL; another modelUrl is checked only with its own modelSha256
  ortUrl: ORT_WASM_URL,
  // ORT_ALL_URL when executionProviders asks for more than "wasm" (see resolveOptions)
  wasmPaths: null,
  // null: ORT_CDN when ort is loaded from ortUrl, otherwise the runtime's own default
  executionProviders: ["wasm"],
  // WebGPU is opt-in: ["webgpu", "wasm"] (skipped without a GPU adapter)
  worker: false,
  // true: run decoding + inference in a Web Worker so the page never freezes
  numThreads: null,
  // null: several threads when the page is cross-origin isolated, else 1
  modelCache: "ordoline-sorter-model",
  // Cache API name for the persistent model copy; false to disable
  lowConfidenceThreshold: 0.6,
  topK: 3
};
var MIN_MODEL_BYTES = 1 << 20;
function resolveOptions(options) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== void 0));
  const opts = { ...DEFAULTS, ...given };
  if (given.modelSha256 === void 0 && given.modelUrl !== void 0 && given.modelUrl !== DEFAULTS.modelUrl) opts.modelSha256 = null;
  if (opts.modelSha256 != null) opts.modelSha256 = opts.modelSha256.toLowerCase();
  opts.executionProviders = opts.executionProviders?.length ? opts.executionProviders : DEFAULTS.executionProviders;
  if (given.ortUrl == null && opts.executionProviders.some((ep) => ep !== "wasm")) opts.ortUrl = ORT_ALL_URL;
  return opts;
}

var OrdolineError = class extends Error {
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "OrdolineError";
    this.code = code;
  }
};
var errorCodeOf = (err, fallback) => err instanceof OrdolineError ? err.code : err?.code ?? fallback;
var messageOf = (err) => err instanceof Error ? err.message : String(err);

var DEFAULT_CLASSES = [
  "ceph_front",
  "ceph_side",
  "extr_profile_rest",
  "extr_profile_smile",
  "extr_rest",
  "extr_smile",
  "intr_front",
  "intr_left",
  "intr_lower",
  "intr_right",
  "intr_upper"
];
var CATEGORIES = Object.freeze([
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
  { id: "cephalometric_lateral", label: "Cephalometric (lateral)" }
].map((c) => Object.freeze(c)));
var LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
var CLASS_TO_CATEGORY = {
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
  ceph_side: "cephalometric_lateral"
};
var SUFFIX_RULES = [
  ["profile_rest", "extraoral_profile_rest"],
  ["profile_smile", "extraoral_profile_smile"],
  ["ceph_front", "cephalometric_frontal"],
  ["ceph_side", "cephalometric_lateral"],
  ["lateral", "cephalometric_lateral"],
  ["rest", "extraoral_frontal_rest"],
  ["smile", "extraoral_frontal_smile"],
  ["front", "intraoral_frontal"],
  ["left", "intraoral_left"],
  ["right", "intraoral_right"],
  ["upper", "intraoral_upper"],
  ["lower", "intraoral_lower"]
];
function classToCategory(cls) {
  if (CLASS_TO_CATEGORY[cls]) return CLASS_TO_CATEGORY[cls];
  for (const [pattern, id] of SUFFIX_RULES) if (cls.includes(pattern)) return id;
  return CATEGORIES[0].id;
}

async function readUrl(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return readBody(res, onProgress);
}
async function readBody(res, onProgress) {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}
var VALIDATOR_HEADER = "x-ordoline-validator";
async function openModelCache(name) {
  if (!name || typeof caches === "undefined") return null;
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}
var ModelIntegrityError = class extends Error {
  constructor(url, expected, actual) {
    super(`Model integrity check failed for ${url}: SHA-256 is ${actual}, expected ${expected}`);
    this.url = url;
    this.expected = expected;
    this.actual = actual;
    this.name = "ModelIntegrityError";
  }
  url;
  expected;
  actual;
};
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function matches(bytes, expected) {
  if (!expected) return { ok: true, actual: null };
  const actual = await sha256Hex(bytes);
  if (actual === null) {
    console.warn("[ordoline] model SHA-256 not checked: Web Crypto is only available on secure (https) pages");
    return { ok: true, actual: null };
  }
  return { ok: actual === expected, actual };
}
async function loadModelBytes(url, cacheName, onProgress, expectedSha256 = null) {
  const cache = await openModelCache(cacheName);
  let cached;
  if (cache) {
    try {
      cached = await cache.match(url);
    } catch {
      cached = void 0;
    }
  }
  if (cached && expectedSha256) {
    const copy = await cached.clone().arrayBuffer();
    if (!(await matches(copy, expectedSha256)).ok) {
      cached = void 0;
      try {
        await cache.delete(url);
      } catch {
      }
    }
  }
  const useCached = async (copy) => {
    const buffer2 = await copy.arrayBuffer();
    onProgress?.(buffer2.byteLength, buffer2.byteLength);
    return { buffer: buffer2, source: "cache" };
  };
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    if (cached) return useCached(cached);
    throw err;
  }
  if (!res.ok) {
    if (cached) {
      res.body?.cancel().catch(() => {
      });
      return useCached(cached);
    }
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
  const validator = res.headers.get("etag") || res.headers.get("last-modified");
  if (cached && validator && cached.headers.get(VALIDATOR_HEADER) === validator) {
    res.body?.cancel().catch(() => {
    });
    return useCached(cached);
  }
  const buffer = await readBody(res, onProgress);
  const check = await matches(buffer, expectedSha256);
  if (!check.ok) throw new ModelIntegrityError(url, expectedSha256, check.actual);
  if (!cache) return { buffer, source: "network" };
  const commit = async (bytes) => {
    try {
      if (!validator) {
        await cache.delete(url);
        return;
      }
      await cache.put(url, new Response(bytes, {
        headers: { "content-type": "application/octet-stream", [VALIDATOR_HEADER]: validator }
      }));
      for (const req of await cache.keys()) if (req.url !== url) await cache.delete(req);
    } catch (err) {
      console.warn("[ordoline] model not cached:", err?.name || err);
    }
  };
  return { buffer, source: "network", commit };
}

var isObj = (v) => v !== null && typeof v === "object";
var isRawImage = (v) => isObj(v) && ArrayBuffer.isView(v.data) && Number.isInteger(v.width) && Number.isInteger(v.height);
var isBlob = (v) => typeof Blob !== "undefined" && v instanceof Blob;
var isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) && !isRawImage(v);
var isTagged = (v) => isObj(v) && "image" in v && !isRawImage(v) && !isBlob(v);
function unwrap(input) {
  if (isTagged(input)) return { image: input.image, id: input.id != null ? String(input.id) : null, name: input.name ?? null };
  return { image: input, id: null, name: null };
}
function inferName(image) {
  if (isBlob(image) && typeof image.name === "string") return image.name;
  let url = null;
  if (typeof image === "string") url = image;
  else if (isObj(image) && typeof image.currentSrc === "string") url = image.currentSrc || image.src;
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return null;
  try {
    return decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? "") || null;
  } catch {
    return null;
  }
}
async function encodedBytes(image) {
  if (typeof image === "string") {
    try {
      return new Uint8Array(await readUrl(image));
    } catch (err) {
      throw new OrdolineError("FETCH_FAILED", `Could not fetch ${image}`, err);
    }
  }
  if (isBlob(image)) return new Uint8Array(await image.arrayBuffer());
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
}
var hasBuiltinDecoder = () => typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
async function builtinDecode(source) {
  let bmp;
  try {
    bmp = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch {
    try {
      bmp = await createImageBitmap(source);
    } catch (err) {
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
async function decode(image) {
  if (isRawImage(image)) return image;
  if (!hasBuiltinDecoder()) {
    throw new OrdolineError("UNSUPPORTED_INPUT", "This browser lacks createImageBitmap/OffscreenCanvas: pass {data, width, height} pixels");
  }
  if (isBlob(image)) return builtinDecode(image);
  if (typeof image === "string" || isBytes(image)) return builtinDecode(new Blob([await encodedBytes(image)]));
  const el = image;
  if (typeof el.decode === "function" && "naturalWidth" in el) {
    try {
      await el.decode();
    } catch (err) {
      throw new OrdolineError("DECODE_FAILED", "Image element could not be decoded", err);
    }
  }
  return builtinDecode(image);
}

var MEAN = [0.485, 0.456, 0.406];
var STD = [0.229, 0.224, 0.225];
var PRECISION_BITS = 32 - 8 - 2;
var ONE = 2 ** PRECISION_BITS;
var HALF = 2 ** (PRECISION_BITS - 1);
function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const fscale = Math.max(scale, 1);
  const invFscale = 1 / fscale;
  const support = fscale;
  const bounds = new Int32Array(outSize * 2);
  const ksize = Math.ceil(support) * 2 + 1;
  const weights = new Float64Array(outSize * ksize);
  const fixed = new Int32Array(outSize * ksize);
  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5));
    let total = 0;
    for (let j = 0; j < xmax - xmin; j++) {
      const w = Math.max(0, 1 - Math.abs((j + xmin - center + 0.5) * invFscale));
      weights[x * ksize + j] = w;
      total += w;
    }
    for (let j = 0; j < xmax - xmin; j++) {
      const k = x * ksize + j;
      if (total) weights[k] /= total;
      fixed[k] = Math.trunc(weights[k] < 0 ? weights[k] * ONE - 0.5 : weights[k] * ONE + 0.5);
    }
    bounds[2 * x] = xmin;
    bounds[2 * x + 1] = xmax - xmin;
  }
  return { bounds, weights, fixed, ksize };
}
var clipFixed = (ss) => {
  const v = Math.floor(ss / ONE);
  return v <= 0 ? 0 : v >= 255 ? 255 : v;
};
function resizeHorizontal(src, w, h, ch, outW, c) {
  const dst = new Uint8Array(outW * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < outW; x++) {
      const start = c.bounds[2 * x], n = c.bounds[2 * x + 1], k = x * c.ksize;
      let r = HALF, g = HALF, b = HALF;
      for (let j = 0; j < n; j++) {
        const wt = c.fixed[k + j], p = (row + start + j) * ch;
        r += src[p] * wt;
        g += src[p + 1] * wt;
        b += src[p + 2] * wt;
      }
      const o = (y * outW + x) * 3;
      dst[o] = clipFixed(r);
      dst[o + 1] = clipFixed(g);
      dst[o + 2] = clipFixed(b);
    }
  }
  return dst;
}
function resizeVertical(src, w, ch, outH, c) {
  const dst = new Uint8Array(w * outH * 3);
  for (let y = 0; y < outH; y++) {
    const start = c.bounds[2 * y], n = c.bounds[2 * y + 1], k = y * c.ksize;
    for (let x = 0; x < w; x++) {
      let r = HALF, g = HALF, b = HALF;
      for (let j = 0; j < n; j++) {
        const wt = c.fixed[k + j], p = ((start + j) * w + x) * ch;
        r += src[p] * wt;
        g += src[p + 1] * wt;
        b += src[p + 2] * wt;
      }
      const o = (y * w + x) * 3;
      dst[o] = clipFixed(r);
      dst[o + 1] = clipFixed(g);
      dst[o + 2] = clipFixed(b);
    }
  }
  return dst;
}
function resizeBilinear(src, w, h, ch, outW, outH) {
  const horizontalFirst = !(h - outH > 0 && h - outH > (w - outW) * 2);
  const needH = outW !== w, needV = outH !== h;
  let img = src, curW = w, curCh = ch;
  const doH = () => {
    if (needH) {
      img = resizeHorizontal(img, curW, needV && !horizontalFirst ? outH : h, curCh, outW, resampleCoeffs(w, outW));
      curW = outW;
      curCh = 3;
    }
  };
  const doV = () => {
    if (needV) {
      img = resizeVertical(img, curW, curCh, outH, resampleCoeffs(h, outH));
      curCh = 3;
    }
  };
  if (horizontalFirst) {
    doH();
    doV();
  } else {
    doV();
    doH();
  }
  if (curCh === 3) return img;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = src[i * ch];
    rgb[i * 3 + 1] = src[i * ch + 1];
    rgb[i * 3 + 2] = src[i * ch + 2];
  }
  return rgb;
}
function preprocess(raw, size) {
  const { width: w, height: h, data } = raw;
  const ch = raw.channels ?? data.length / (w * h);
  if (!(ch === 3 || ch === 4) || data.length < w * h * ch) {
    throw new OrdolineError("DECODE_FAILED", `Pixel data must be RGB or RGBA (${w}x${h}, ${data.length} values)`);
  }
  const scale = size / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const rgb = resizeBilinear(data, w, h, ch, nw, nh);
  const left = Math.floor((size - nw) / 2), top = Math.floor((size - nh) / 2);
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) out.fill(-MEAN[c] / STD[c], c * plane, (c + 1) * plane);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 3, o = (top + y) * size + left + x;
      out[o] = (rgb[i] / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (rgb[i + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (rgb[i + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

var ortImports = /* @__PURE__ */ new Map();
async function loadOrt(opts) {
  if (opts.ort) return { ort: opts.ort, fromCdn: false };
  const globalOrt = globalThis.ort;
  if (globalOrt?.InferenceSession) return { ort: globalOrt, fromCdn: false };
  if (!ortImports.has(opts.ortUrl)) {
    const p = import(
      /* webpackIgnore: true */
      /* @vite-ignore */
      opts.ortUrl
    );
    p.catch(() => ortImports.delete(opts.ortUrl));
    ortImports.set(opts.ortUrl, p);
  }
  const mod = await ortImports.get(opts.ortUrl);
  return { ort: mod.InferenceSession ? mod : mod.default, fromCdn: true };
}
function defaultThreads() {
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores - 1));
}
async function hasWebGpuAdapter() {
  try {
    const gpu = globalThis.navigator?.gpu;
    return !!await gpu?.requestAdapter();
  } catch {
    return false;
  }
}
function parseClassNames(meta) {
  const raw = meta?.names;
  if (!raw) return null;
  const pairs = [...String(raw).matchAll(/(\d+)\s*:\s*'([^']+)'/g)];
  if (!pairs.length) return null;
  const byIndex = /* @__PURE__ */ new Map();
  for (const [, idx, name] of pairs) byIndex.set(Number(idx), name);
  return [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i));
}
function sessionInputSize(session) {
  const dim = session.inputMetadata?.[0]?.dims?.[2];
  return typeof dim === "number" && Number.isFinite(dim) && dim > 0 ? dim : 384;
}

var API_VERSION = "1.0";

async function sortWith(classify, model, inputs, callOpts = {}) {
  const list = Array.from(inputs);
  const results = [];
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
  const t0 = performance.now();
  const signal = callOpts.signal;
  for (let i = 0; i < list.length && !signal?.aborted; i++) {
    const r = { index: i, ...await classify(list[i], { topK: callOpts.topK, id: String(i), signal }) };
    if (signal?.aborted) break;
    results.push(r);
    if (r.ok) byCategory[r.category].push(r.id);
    callOpts.onResult?.(r, { done: i + 1, total: list.length });
  }
  const conf = new Map(results.map((r) => [r.id, r.ok ? r.confidence : 0]));
  for (const ids of Object.values(byCategory)) ids.sort((a, b) => conf.get(b) - conf.get(a));
  const failed = results.filter((r) => !r.ok).length;
  return {
    apiVersion: API_VERSION,
    model,
    results,
    byCategory,
    summary: {
      total: list.length,
      sorted: results.length - failed,
      failed,
      skipped: list.length - results.length,
      aborted: !!signal?.aborted,
      lowConfidence: results.filter((r) => r.ok && r.lowConfidence).length,
      timingMs: Math.round(performance.now() - t0)
    }
  };
}
var abortedResult = (base) => ({ ...base, ok: false, error: { code: "ABORTED", message: "Cancelled" } });
function abortable(work, signal, aborted) {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(aborted());
  return new Promise((resolve) => {
    const onAbort = () => resolve(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((r) => {
      signal.removeEventListener("abort", onAbort);
      resolve(signal.aborted ? aborted() : r);
    });
  });
}
async function buildSorter(opts, onProgress, onDispose) {
  let ort, fromCdn;
  try {
    ({ ort, fromCdn } = await loadOrt(opts));
  } catch (err) {
    throw new OrdolineError("RUNTIME_LOAD_FAILED", `Could not load ONNX runtime from ${opts.ortUrl}`, err);
  }
  if (ort.env?.wasm) {
    const wasmPaths = opts.wasmPaths ?? (fromCdn ? ORT_CDN : null);
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = opts.numThreads ?? (globalThis.crossOriginIsolated ? defaultThreads() : 1);
  }
  if (ort.env) ort.env.logLevel = "error";
  let loaded;
  try {
    loaded = await loadModelBytes(
      opts.modelUrl,
      opts.modelCache,
      (bytes, total) => onProgress?.({ loaded: bytes, total, fraction: total ? bytes / total : 0 }),
      opts.modelSha256
    );
  } catch (err) {
    if (err instanceof ModelIntegrityError) throw new OrdolineError("MODEL_LOAD_FAILED", err.message, err);
    throw new OrdolineError("MODEL_LOAD_FAILED", `Could not load model from ${opts.modelUrl}`, err);
  }
  const { buffer, source, commit } = loaded;
  const verifiedSha256 = opts.modelSha256 && globalThis.crypto?.subtle ? opts.modelSha256 : null;
  if (buffer.byteLength < MIN_MODEL_BYTES) {
    throw new OrdolineError("MODEL_LOAD_FAILED", `Model is only ${buffer.byteLength} bytes (Git LFS pointer?)`);
  }
  const gpuUsable = await hasWebGpuAdapter();
  let eps = opts.executionProviders ?? ["wasm"];
  if (!gpuUsable) eps = eps.filter((ep) => ep !== "webgpu");
  if (!eps.length) eps = ["wasm"];
  const attempts = eps.map((_, i) => eps.slice(i));
  const cacheCopy = commit ? buffer.slice(0) : null;
  let session = null, backend = "", lastErr;
  for (const list of attempts) {
    try {
      session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: list });
      backend = list[0];
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!session) throw new OrdolineError("MODEL_LOAD_FAILED", "Could not create ONNX session", lastErr);
  const sess = session;
  if (commit && cacheCopy) await commit(cacheCopy);
  let classNames = DEFAULT_CLASSES;
  try {
    classNames = parseClassNames(await sess.metadata) ?? classNames;
  } catch {
  }
  const inputSize = sessionInputSize(sess);
  const classCategory = classNames.map(classToCategory);
  const threads = backend === "wasm" ? ort.env?.wasm?.numThreads || 1 : null;
  const model = Object.freeze({
    url: opts.modelUrl,
    source,
    backend,
    threads,
    worker: false,
    inputSize,
    classes: Object.freeze([...classNames]),
    sha256: verifiedSha256
  });
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const r = chain.then(fn, fn);
    chain = r.catch(() => {
    });
    return r;
  };
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
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, k)).map(([category, confidence]) => ({ category, label: LABELS[category], confidence }));
    return { modelClass: classNames[best] || String(best), scores, top };
  }
  function classify(input, callOpts = {}) {
    const { image, id, name } = unwrap(input);
    const base = { id: id ?? callOpts.id ?? `img-${++autoId}`, name: name ?? inferName(image) };
    return abortable(run(image, base, callOpts), callOpts.signal, () => abortedResult(base));
  }
  async function run(image, base, callOpts) {
    const t0 = performance.now();
    const checkAborted = () => {
      if (callOpts.signal?.aborted) throw new OrdolineError("ABORTED", "Cancelled", callOpts.signal.reason);
    };
    try {
      if (disposed) throw new OrdolineError("DISPOSED", "Sorter has been disposed");
      checkAborted();
      const raw = await decode(image);
      const data = preprocess(raw, inputSize);
      const probs = await exclusive(async () => {
        if (disposed) throw new OrdolineError("DISPOSED", "Sorter has been disposed");
        checkAborted();
        try {
          const feeds = { [sess.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, inputSize, inputSize]) };
          return (await sess.run(feeds))[sess.outputNames[0]].data;
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
        timingMs: Math.round(performance.now() - t0)
      };
    } catch (err) {
      return { ...base, ok: false, error: { code: errorCodeOf(err, "INFERENCE_FAILED"), message: messageOf(err) } };
    }
  }
  return Object.freeze({
    apiVersion: API_VERSION,
    model,
    categories: CATEGORIES,
    classify,
    sort: (inputs, callOpts) => sortWith(classify, model, inputs, callOpts),
    dispose() {
      if (disposed) return;
      disposed = true;
      onDispose?.();
      void chain.then(() => sess.release?.());
    }
  });
}

var WORKER_NAME = "ordoline-sorter";
var MSG = "ordoline-sorter/v1";
var isOfType = (v, name) => {
  const ctor = globalThis[name];
  return typeof ctor === "function" && v instanceof ctor;
};
async function toTransferable(image) {
  if (typeof image === "string") {
    if (/^(data|blob):/.test(image)) return image;
    try {
      return new URL(image, globalThis.document?.baseURI ?? globalThis.location?.href).href;
    } catch {
      return image;
    }
  }
  if (isOfType(image, "HTMLImageElement")) {
    try {
      await image.decode();
    } catch (err) {
      throw new OrdolineError("DECODE_FAILED", "Image element could not be decoded", err);
    }
    return createImageBitmap(image);
  }
  if (["HTMLCanvasElement", "OffscreenCanvas", "SVGImageElement", "HTMLVideoElement"].some((t) => isOfType(image, t))) {
    try {
      return await createImageBitmap(image);
    } catch (err) {
      throw new OrdolineError("DECODE_FAILED", "Image could not be read", err);
    }
  }
  return image;
}
async function buildWorkerSorter(opts, onProgress, onDispose) {
  const wrapper = URL.createObjectURL(new Blob([`import ${JSON.stringify(import.meta.url)};`], { type: "text/javascript" }));
  const worker = new Worker(wrapper, { type: "module", name: WORKER_NAME });
  URL.revokeObjectURL(wrapper);
  const send = (m) => worker.postMessage(m);
  const pending = /* @__PURE__ */ new Map();
  let nextReq = 0, autoId = 0, disposed = false;
  let failure = null;
  const failAll = (code, message) => {
    failure = { code, message };
    for (const done of pending.values()) done(null);
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m?.ns !== MSG) return;
      if (m.type === "progress") onProgress?.(m.progress);
      else if (m.type === "ready") resolve(m.model);
      else if (m.type === "init-error") reject(new OrdolineError(m.error.code, m.error.message));
      else if (m.type === "result") {
        pending.get(m.reqId)?.(m.result);
        pending.delete(m.reqId);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      const msg = `Sorter worker failed: ${e.message || "could not start (check that the module URL is reachable with CORS)"}`;
      reject(new OrdolineError("RUNTIME_LOAD_FAILED", msg));
      failAll("INFERENCE_FAILED", msg);
    };
  });
  const { worker: _worker, ort: _ort, ...workerOpts } = opts;
  send({ ns: MSG, type: "init", options: workerOpts });
  let remoteModel;
  try {
    remoteModel = await ready;
  } catch (err) {
    worker.terminate();
    throw err;
  }
  const model = Object.freeze({ ...remoteModel, worker: true });
  async function classify(input, callOpts = {}) {
    const { image, id, name } = unwrap(input);
    const base = { id: id ?? callOpts.id ?? `img-${++autoId}`, name: name ?? inferName(image) };
    const fail = (code, message) => ({ ...base, ok: false, error: { code, message } });
    const { signal } = callOpts;
    if (disposed) return fail("DISPOSED", "Sorter has been disposed");
    if (failure) return fail(failure.code, failure.message);
    if (signal?.aborted) return abortedResult(base);
    let payload;
    try {
      payload = await toTransferable(image);
    } catch (err) {
      return fail(errorCodeOf(err, "DECODE_FAILED"), messageOf(err));
    }
    if (signal?.aborted) return abortedResult(base);
    const reqId = ++nextReq;
    const result = new Promise((resolve) => pending.set(reqId, resolve));
    try {
      send({ ns: MSG, type: "classify", reqId, input: { image: payload, id: base.id, name: base.name ?? void 0 }, topK: callOpts.topK });
    } catch (err) {
      pending.delete(reqId);
      return fail("UNSUPPORTED_INPUT", `Input cannot be sent to the worker: ${err?.name || err}`);
    }
    const onAbort = () => {
      const done = pending.get(reqId);
      if (!done) return;
      pending.delete(reqId);
      send({ ns: MSG, type: "cancel", reqId });
      done(abortedResult(base));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const r = await result;
    signal?.removeEventListener("abort", onAbort);
    if (r) return { ...r, name: base.name };
    const f = failure;
    return fail(f?.code ?? "INFERENCE_FAILED", f?.message ?? "Sorter worker stopped");
  }
  return Object.freeze({
    apiVersion: API_VERSION,
    model,
    categories: CATEGORIES,
    classify,
    sort: (inputs, callOpts) => sortWith(classify, model, inputs, callOpts),
    dispose() {
      if (disposed) return;
      disposed = true;
      onDispose?.();
      send({ ns: MSG, type: "dispose" });
      failAll("DISPOSED", "Sorter has been disposed");
      setTimeout(() => worker.terminate(), 1e3);
    }
  });
}
function startWorkerHost(scope) {
  let sorter = null;
  const cancels = /* @__PURE__ */ new Map();
  const post = (m) => scope.postMessage({ ns: MSG, ...m });
  scope.addEventListener("message", async (e) => {
    const m = e.data;
    if (m?.ns !== MSG) return;
    if (m.type === "init") {
      sorter = buildSorter({ ...m.options, worker: false }, (progress) => post({ type: "progress", progress }));
      try {
        post({ type: "ready", model: (await sorter).model });
      } catch (err) {
        post({ type: "init-error", error: { code: errorCodeOf(err, "MODEL_LOAD_FAILED"), message: messageOf(err) } });
      }
    } else if (m.type === "classify" && sorter) {
      const ctrl = new AbortController();
      cancels.set(m.reqId, ctrl);
      const result = await (await sorter).classify(m.input, { topK: m.topK, signal: ctrl.signal });
      cancels.delete(m.reqId);
      post({ type: "result", reqId: m.reqId, result });
    } else if (m.type === "cancel") {
      cancels.get(m.reqId)?.abort();
    } else if (m.type === "dispose") {
      if (sorter) (await sorter).dispose();
      scope.close();
    }
  });
}
{
  const g = globalThis;
  if (typeof g.WorkerGlobalScope === "function" && globalThis instanceof g.WorkerGlobalScope && g.name === WORKER_NAME) {
    startWorkerHost(globalThis);
  }
}

var sorters = /* @__PURE__ */ new Map();
function createSorter(options = {}) {
  const { onProgress, ...rest } = options;
  const opts = resolveOptions(rest);
  if (opts.modelSha256 != null && !/^[0-9a-f]{64}$/.test(opts.modelSha256)) {
    return Promise.reject(new OrdolineError("INVALID_OPTIONS", "modelSha256 must be 64 hexadecimal characters"));
  }
  if (opts.worker && opts.ort) {
    return Promise.reject(new OrdolineError("INVALID_OPTIONS", "options.ort cannot be passed to a worker; use ortUrl instead"));
  }
  const useWorker = opts.worker && typeof Worker === "function";
  const key = opts.ort ? null : JSON.stringify(opts);
  if (key && sorters.has(key)) return sorters.get(key);
  const forget = () => {
    if (key) sorters.delete(key);
  };
  const p = useWorker ? buildWorkerSorter(opts, onProgress, forget) : buildSorter(opts, onProgress, forget);
  if (key) {
    p.catch(() => sorters.delete(key));
    sorters.set(key, p);
  }
  return p;
}
export {
  API_VERSION,
  CATEGORIES,
  OrdolineError,
  createSorter
};
