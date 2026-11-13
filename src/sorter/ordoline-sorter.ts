/* Ordoline Sorter — dental photo classifier core (ES module). API v1 — see docs/API.md.
 *
 * Browser-only, no DOM dependency: runs on the page's main thread or in a Web Worker.
 *   - Inference: onnxruntime-web (from jsDelivr by default, or pass your own build via options.ort)
 *   - Image decoding: createImageBitmap + OffscreenCanvas
 *   - Preprocessing: pure TS (PIL-style antialiased bilinear letterbox)
 *
 * Preprocessing matches training:
 *   EXIF orientation -> letterbox (longest edge -> N, bilinear, centered on black N x N)
 *   -> RGB [0,1] CHW -> Normalize(ImageNet mean/std)
 *
 * The optional drop-zone UI lives in ordoline-sorter-element.ts.
 */

import { DEFAULTS, type ResolvedOptions } from "./options.js";
import { OrdolineError } from "./errors.js";
import { buildSorter } from "./sorter.js";
import { buildWorkerSorter } from "./worker.js";
import type { Sorter, SorterOptions } from "./types.js";

export * from "./types.js";
export { CATEGORIES } from "./categories.js";
export { OrdolineError } from "./errors.js";

const sorters = new Map<string, Promise<Sorter>>();

/**
 * Load the runtime + model once and return a Sorter. Calls with the same options share one instance
 * (passing options.ort always creates a new instance).
 * Rejects with OrdolineError code RUNTIME_LOAD_FAILED / MODEL_LOAD_FAILED / INVALID_OPTIONS.
 */
export function createSorter(options: SorterOptions = {}): Promise<Sorter> {
  const { onProgress, ...rest } = options;
  const opts: ResolvedOptions = { ...DEFAULTS, ...rest };
  if (opts.worker && opts.ort) {
    return Promise.reject(new OrdolineError("INVALID_OPTIONS", "options.ort cannot be passed to a worker; use ortUrl instead"));
  }
  const useWorker = opts.worker && typeof Worker === "function";
  const key = opts.ort ? null : JSON.stringify(opts);
  if (key && sorters.has(key)) return sorters.get(key)!;
  const forget = () => { if (key) sorters.delete(key); };
  const p = useWorker ? buildWorkerSorter(opts, onProgress, forget) : buildSorter(opts, onProgress, forget);
  if (key) {
    p.catch(() => sorters.delete(key)); // allow retry after failure
    sorters.set(key, p);
  }
  return p;
}
