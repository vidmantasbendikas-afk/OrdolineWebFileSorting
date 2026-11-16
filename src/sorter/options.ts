/** Defaults: runtime and model locations, thresholds. */
import type { SorterOptions } from "./types.js";

// onnxruntime-web ESM builds from jsDelivr (CORS-enabled, version-pinned). Measured download (uncompressed):
//   CPU only (WebAssembly):  ort.wasm.min.mjs 0.05 MB + ort-wasm-simd-threaded.wasm      10.7 MB   (default)
//   WebGPU + CPU:            ort.all.min.mjs  0.8 MB  + ort-wasm-simd-threaded.jsep.wasm 20.9 MB   (opt-in)
export const ORT_VERSION = "1.22.0";
export const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_WASM_URL = `${ORT_CDN}ort.wasm.min.mjs`;
export const ORT_ALL_URL = `${ORT_CDN}ort.all.min.mjs`;

// Where the model lives. Must be served with CORS (Access-Control-Allow-Origin) when cross-origin.
// The release build bakes in a URL (npm run package -- --model-url=...); otherwise it resolves next to this module.
declare const __ORDOLINE_MODEL_URL__: string | undefined;
declare const __ORDOLINE_MODEL_SHA256__: string | undefined;
export const MODEL_CDN_URL: string = typeof __ORDOLINE_MODEL_URL__ === "string"
  ? __ORDOLINE_MODEL_URL__
  : new URL("model/best.onnx", import.meta.url).href;
// SHA-256 of that model, baked in by the release build (npm run package -- --model-url=...); null: not checked.
export const MODEL_SHA256: string | null = typeof __ORDOLINE_MODEL_SHA256__ === "string" ? __ORDOLINE_MODEL_SHA256__ : null;

export type ResolvedOptions = Required<Omit<SorterOptions, "onProgress" | "ort">> & { ort?: unknown };

export const DEFAULTS: ResolvedOptions = {
  modelUrl: MODEL_CDN_URL,
  modelSha256: MODEL_SHA256, // only for the default model URL; another modelUrl is checked only with its own modelSha256
  ortUrl: ORT_WASM_URL, // ORT_ALL_URL when executionProviders asks for more than "wasm" (see resolveOptions)
  wasmPaths: null, // null: ORT_CDN when ort is loaded from ortUrl, otherwise the runtime's own default
  executionProviders: ["wasm"], // WebGPU is opt-in: ["webgpu", "wasm"] (skipped without a GPU adapter)
  worker: false, // true: run decoding + inference in a Web Worker so the page never freezes
  numThreads: null, // null: several threads when the page is cross-origin isolated, else 1
  modelCache: "ordoline-sorter-model", // Cache API name for the persistent model copy; false to disable
  lowConfidenceThreshold: 0.6,
  topK: 3,
};
export const MIN_MODEL_BYTES = 1 << 20;

/** Options with defaults filled in. Asking for WebGPU (or another non-wasm provider) switches the default runtime
 * to the full build, which includes it; an explicit ortUrl is kept as given. */
export function resolveOptions(options: Omit<SorterOptions, "onProgress">): ResolvedOptions {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as typeof options;
  const opts: ResolvedOptions = { ...DEFAULTS, ...given };
  // the baked-in hash belongs to the baked-in URL: a different model URL is not checked unless given its own hash
  if (given.modelSha256 === undefined && given.modelUrl !== undefined && given.modelUrl !== DEFAULTS.modelUrl) opts.modelSha256 = null;
  if (opts.modelSha256 != null) opts.modelSha256 = opts.modelSha256.toLowerCase();
  opts.executionProviders = opts.executionProviders?.length ? opts.executionProviders : DEFAULTS.executionProviders;
  if (given.ortUrl == null && opts.executionProviders!.some((ep) => ep !== "wasm")) opts.ortUrl = ORT_ALL_URL;
  return opts;
}
