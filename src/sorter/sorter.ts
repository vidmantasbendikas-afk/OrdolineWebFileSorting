/** The in-thread sorter, and sort() shared with the worker proxy. */
import { CATEGORIES, DEFAULT_CLASSES, LABELS, classToCategory } from "./categories.js";
import { decode, inferName, unwrap } from "./decode.js";
import { OrdolineError, errorCodeOf, messageOf } from "./errors.js";
import { loadModelBytes, type ModelBytes } from "./model-cache.js";
import { MIN_MODEL_BYTES, ORT_CDN, type ResolvedOptions } from "./options.js";
import { preprocess } from "./preprocess.js";
import { defaultThreads, hasWebGpuAdapter, loadOrt, parseClassNames, sessionInputSize, type OrtModule, type OrtSession } from "./runtime.js";
import {
  API_VERSION, type CategoryId, type CategoryScore, type ClassificationFailure, type ClassificationResult, type ImageInput, type ClassifyOptions, type IndexedResult,
  type ModelInfo, type Sorter, type SorterInput, type SorterOptions, type SortOptions, type SortResult,
} from "./types.js";

export type ClassifyFn = (input: SorterInput, options?: ClassifyOptions) => Promise<ClassificationResult>;

export async function sortWith(
  classify: ClassifyFn,
  model: ModelInfo,
  inputs: Iterable<SorterInput> | ArrayLike<SorterInput>,
  callOpts: SortOptions = {},
): Promise<SortResult> {
  const list = Array.from(inputs);
  const results: IndexedResult[] = [];
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, [] as string[]])) as Record<CategoryId, string[]>;
  const t0 = performance.now();
  const signal = callOpts.signal;
  for (let i = 0; i < list.length && !signal?.aborted; i++) {
    const r: IndexedResult = { index: i, ...(await classify(list[i], { topK: callOpts.topK, id: String(i), signal })) };
    if (signal?.aborted) break; // stopped while this photo was in progress: it does not count
    results.push(r);
    if (r.ok) byCategory[r.category].push(r.id);
    callOpts.onResult?.(r, { done: i + 1, total: list.length });
  }
  const conf = new Map(results.map((r) => [r.id, r.ok ? r.confidence : 0]));
  for (const ids of Object.values(byCategory)) ids.sort((a, b) => conf.get(b)! - conf.get(a)!);
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
      timingMs: Math.round(performance.now() - t0),
    },
  };
}

export const abortedResult = (base: { id: string; name: string | null }): ClassificationFailure =>
  ({ ...base, ok: false, error: { code: "ABORTED", message: "Cancelled" } });

/** A pending result that settles early with ABORTED when `signal` fires. */
export function abortable<T extends ClassificationResult>(
  work: Promise<T>, signal: AbortSignal | undefined, aborted: () => ClassificationResult,
): Promise<ClassificationResult> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(aborted());
  return new Promise((resolve) => {
    const onAbort = () => resolve(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((r) => { signal.removeEventListener("abort", onAbort); resolve(signal.aborted ? aborted() : r); });
  });
}

/** Load runtime + model and return a Sorter running on this thread. `onDispose` runs once when it is disposed. */
export async function buildSorter(
  opts: ResolvedOptions, onProgress: SorterOptions["onProgress"], onDispose?: () => void,
): Promise<Sorter> {
  let ort: OrtModule, fromCdn: boolean;
  try {
    ({ ort, fromCdn } = await loadOrt(opts));
  } catch (err) {
    throw new OrdolineError("RUNTIME_LOAD_FAILED", `Could not load ONNX runtime from ${opts.ortUrl}`, err);
  }
  if (ort.env?.wasm) {
    const wasmPaths = opts.wasmPaths ?? (fromCdn ? ORT_CDN : null);
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    // Multi-threaded WASM needs SharedArrayBuffer, i.e. a cross-origin isolated page (COOP + COEP headers).
    ort.env.wasm.numThreads = opts.numThreads ?? (globalThis.crossOriginIsolated ? defaultThreads() : 1);
  }
  if (ort.env) ort.env.logLevel = "error";

  let loaded: ModelBytes;
  try {
    loaded = await loadModelBytes(opts.modelUrl, opts.modelCache,
      (bytes, total) => onProgress?.({ loaded: bytes, total, fraction: total ? bytes / total : 0 }));
  } catch (err) {
    throw new OrdolineError("MODEL_LOAD_FAILED", `Could not load model from ${opts.modelUrl}`, err);
  }
  const { buffer, source, commit } = loaded;
  if (buffer.byteLength < MIN_MODEL_BYTES) {
    throw new OrdolineError("MODEL_LOAD_FAILED", `Model is only ${buffer.byteLength} bytes (Git LFS pointer?)`);
  }

  // onnxruntime silently drops "webgpu" when no GPU adapter exists, so check first to report the real backend.
  const gpuUsable = await hasWebGpuAdapter();
  let eps = opts.executionProviders ?? ["webgpu", "wasm"];
  if (!gpuUsable) eps = eps.filter((ep) => ep !== "webgpu");
  if (!eps.length) eps = ["wasm"];
  const attempts = eps.map((_, i) => eps.slice(i)); // e.g. [webgpu, wasm], then [wasm]
  // keep a private copy for the cache: the runtime may take ownership of the bytes it is given
  const cacheCopy = commit ? buffer.slice(0) : null;
  let session: OrtSession | null = null, backend = "", lastErr: unknown;
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
  try { classNames = parseClassNames(await sess.metadata) ?? classNames; } catch { /* keep defaults */ }
  const inputSize = sessionInputSize(sess);
  const classCategory = classNames.map(classToCategory);
  const threads = backend === "wasm" ? (ort.env?.wasm?.numThreads || 1) : null;
  const model: ModelInfo = Object.freeze({
    url: opts.modelUrl, source, backend, threads, worker: false, inputSize, classes: Object.freeze([...classNames]),
  });

  // ORT sessions must not run concurrently; serialize inference calls.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn, fn);
    chain = r.catch(() => {});
    return r;
  };
  let disposed = false;
  let autoId = 0;

  function buildResult(probs: ArrayLike<number>, k: number) {
    let sum = 0;
    for (let i = 0; i < probs.length; i++) sum += probs[i];
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) as Record<CategoryId, number>;
    let best = 0;
    for (let i = 0; i < probs.length; i++) {
      scores[classCategory[i]] += probs[i] / (sum || 1);
      if (probs[i] > probs[best]) best = i;
    }
    const top: CategoryScore[] = (Object.entries(scores) as Array<[CategoryId, number]>)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, k))
      .map(([category, confidence]) => ({ category, label: LABELS[category], confidence }));
    return { modelClass: classNames[best] || String(best), scores, top };
  }

  function classify(input: SorterInput, callOpts: ClassifyOptions = {}): Promise<ClassificationResult> {
    const { image, id, name } = unwrap(input);
    const base = { id: id ?? callOpts.id ?? `img-${++autoId}`, name: name ?? inferName(image) };
    return abortable(run(image, base, callOpts), callOpts.signal, () => abortedResult(base));
  }

  async function run(image: ImageInput, base: { id: string; name: string | null }, callOpts: ClassifyOptions): Promise<ClassificationResult> {
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
        checkAborted(); // cancelled while waiting for earlier photos: skip the inference
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
        timingMs: Math.round(performance.now() - t0),
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
    },
  } satisfies Sorter);
}
