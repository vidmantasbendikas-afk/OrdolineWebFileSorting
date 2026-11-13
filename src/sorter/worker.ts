/** Worker mode: page-side proxy with the Sorter API, and the host that runs inside the worker. */
import { CATEGORIES } from "./categories.js";
import { inferName, unwrap } from "./decode.js";
import { OrdolineError, errorCodeOf, messageOf } from "./errors.js";
import type { ResolvedOptions } from "./options.js";
import { abortedResult, buildSorter, sortWith } from "./sorter.js";
import {
  API_VERSION, type ClassificationFailure, type ClassificationResult, type ClassifyOptions, type ErrorCode, type ImageInput,
  type ModelInfo, type ProgressInfo, type Sorter, type SorterInput, type SorterOptions, type TaggedInput,
} from "./types.js";

/*
 * createSorter({ worker: true }) runs decoding, preprocessing and inference in a dedicated Web Worker, so the page
 * stays responsive. The worker loads this same file; a tiny blob: wrapper makes that work even when this module is
 * served from another origin (a CDN). Page side: a proxy with the same Sorter API. Worker side: startWorkerHost().
 */

const WORKER_NAME = "ordoline-sorter";
const MSG = "ordoline-sorter/v1";

type ToWorker =
  | { ns: typeof MSG; type: "init"; options: Omit<ResolvedOptions, "worker" | "ort"> }
  | { ns: typeof MSG; type: "classify"; reqId: number; input: TaggedInput & { id: string }; topK?: number }
  | { ns: typeof MSG; type: "cancel"; reqId: number }
  | { ns: typeof MSG; type: "dispose" };

type FromWorker =
  | { ns: typeof MSG; type: "progress"; progress: ProgressInfo }
  | { ns: typeof MSG; type: "ready"; model: ModelInfo }
  | { ns: typeof MSG; type: "init-error"; error: { code: ErrorCode; message: string } }
  | { ns: typeof MSG; type: "result"; reqId: number; result: ClassificationResult };

/** Omit `ns` from each member of a message union separately. */
type WithoutNs<T> = T extends unknown ? Omit<T, "ns"> : never;

const isOfType = (v: unknown, name: string): boolean => {
  const ctor = (globalThis as Record<string, unknown>)[name];
  return typeof ctor === "function" && v instanceof (ctor as abstract new (...args: never[]) => unknown);
};

/** Page side: turn an input into something that can be posted to the worker. */
async function toTransferable(image: ImageInput): Promise<ImageInput> {
  if (typeof image === "string") {
    // relative URLs must be resolved against the page, not the worker's blob: URL
    if (/^(data|blob):/.test(image)) return image;
    try { return new URL(image, globalThis.document?.baseURI ?? globalThis.location?.href).href; } catch { return image; }
  }
  if (isOfType(image, "HTMLImageElement")) {
    try { await (image as HTMLImageElement).decode(); } catch (err) {
      throw new OrdolineError("DECODE_FAILED", "Image element could not be decoded", err);
    }
    return createImageBitmap(image as HTMLImageElement);
  }
  if (["HTMLCanvasElement", "OffscreenCanvas", "SVGImageElement", "HTMLVideoElement"].some((t) => isOfType(image, t))) {
    try { return await createImageBitmap(image as ImageBitmapSource); } catch (err) {
      throw new OrdolineError("DECODE_FAILED", "Image could not be read", err);
    }
  }
  return image; // Blob/File, bytes, ImageBitmap, ImageData, VideoFrame, raw pixels: structured-cloneable
}

/** Start a worker running this module and return a proxy Sorter. `onDispose` runs once when it is disposed. */
export async function buildWorkerSorter(
  opts: ResolvedOptions, onProgress: SorterOptions["onProgress"], onDispose?: () => void,
): Promise<Sorter> {
  const wrapper = URL.createObjectURL(new Blob([`import ${JSON.stringify(import.meta.url)};`], { type: "text/javascript" }));
  const worker = new Worker(wrapper, { type: "module", name: WORKER_NAME });
  URL.revokeObjectURL(wrapper);
  const send = (m: ToWorker) => worker.postMessage(m);

  const pending = new Map<number, (result: ClassificationResult | null) => void>();
  let nextReq = 0, autoId = 0, disposed = false;
  let failure: { code: ErrorCode; message: string } | null = null;

  const failAll = (code: ErrorCode, message: string) => {
    failure = { code, message };
    for (const done of pending.values()) done(null);
    pending.clear();
  };

  const ready = new Promise<ModelInfo>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m?.ns !== MSG) return;
      if (m.type === "progress") onProgress?.(m.progress);
      else if (m.type === "ready") resolve(m.model);
      else if (m.type === "init-error") reject(new OrdolineError(m.error.code, m.error.message));
      else if (m.type === "result") { pending.get(m.reqId)?.(m.result); pending.delete(m.reqId); }
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
  let remoteModel: ModelInfo;
  try {
    remoteModel = await ready;
  } catch (err) {
    worker.terminate();
    throw err;
  }
  const model: ModelInfo = Object.freeze({ ...remoteModel, worker: true });

  async function classify(input: SorterInput, callOpts: ClassifyOptions = {}): Promise<ClassificationResult> {
    const { image, id, name } = unwrap(input);
    const base = { id: id ?? callOpts.id ?? `img-${++autoId}`, name: name ?? inferName(image) };
    const fail = (code: ErrorCode, message: string): ClassificationFailure => ({ ...base, ok: false, error: { code, message } });
    const { signal } = callOpts;
    if (disposed) return fail("DISPOSED", "Sorter has been disposed");
    if (failure) return fail(failure.code, failure.message);
    if (signal?.aborted) return abortedResult(base);
    let payload: ImageInput;
    try {
      payload = await toTransferable(image);
    } catch (err) {
      return fail(errorCodeOf(err, "DECODE_FAILED"), messageOf(err));
    }
    if (signal?.aborted) return abortedResult(base);
    const reqId = ++nextReq;
    const result = new Promise<ClassificationResult | null>((resolve) => pending.set(reqId, resolve));
    try {
      send({ ns: MSG, type: "classify", reqId, input: { image: payload, id: base.id, name: base.name ?? undefined }, topK: callOpts.topK });
    } catch (err) {
      pending.delete(reqId);
      return fail("UNSUPPORTED_INPUT", `Input cannot be sent to the worker: ${(err as Error)?.name || err}`);
    }
    // Cancel: settle at once, and tell the worker to skip this photo if its inference has not started.
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
    if (r) return { ...r, name: base.name }; // keep page-side name (null stays null)
    const f = failure as { code: ErrorCode; message: string } | null;
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
      setTimeout(() => worker.terminate(), 1000);
    },
  } satisfies Sorter);
}

/** Worker side: serve requests from buildWorkerSorter(). */
function startWorkerHost(scope: { postMessage(m: FromWorker): void; addEventListener(t: "message", l: (e: MessageEvent<ToWorker>) => void): void; close(): void }) {
  let sorter: Promise<Sorter> | null = null;
  const cancels = new Map<number, AbortController>(); // reqId -> in-progress classify
  const post = (m: WithoutNs<FromWorker>) => scope.postMessage({ ns: MSG, ...m } as FromWorker);
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
  const g = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown; name?: string };
  if (typeof g.WorkerGlobalScope === "function" && globalThis instanceof g.WorkerGlobalScope && g.name === WORKER_NAME) {
    startWorkerHost(globalThis as unknown as Parameters<typeof startWorkerHost>[0]);
  }
}
