/** Defaults: runtime and model locations, thresholds. */
import type { SorterOptions } from "./types.js";

// onnxruntime-web ESM build from jsDelivr (CORS-enabled, version-pinned).
export const ORT_VERSION = "1.22.0";
export const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Where the model lives. Must be served with CORS (Access-Control-Allow-Origin) when cross-origin.
// Set this to the CDN URL once the model is hosted; until then it resolves next to this module.
export const MODEL_CDN_URL = new URL("model/best.onnx", import.meta.url).href;

export type ResolvedOptions = Required<Omit<SorterOptions, "onProgress" | "ort">> & { ort?: unknown };

export const DEFAULTS: ResolvedOptions = {
  modelUrl: MODEL_CDN_URL,
  ortUrl: `${ORT_CDN}ort.all.min.mjs`,
  wasmPaths: null, // null: ORT_CDN when ort is loaded from ortUrl, otherwise the runtime's own default
  executionProviders: null, // null: ["webgpu", "wasm"]; "webgpu" is skipped without a GPU adapter
  worker: false, // true: run decoding + inference in a Web Worker so the page never freezes
  numThreads: null, // null: several threads when the page is cross-origin isolated, else 1
  modelCache: "ordoline-sorter-model", // Cache API name for the persistent model copy; false to disable
  lowConfidenceThreshold: 0.6,
  topK: 3,
};
export const MIN_MODEL_BYTES = 1 << 20;
