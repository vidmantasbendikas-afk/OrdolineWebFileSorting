/**
 * Ordoline Sorter — API v1.0
 * Classifies dental photos into 11 categories. Environment-neutral core (no DOM):
 * browser main thread, Web Workers, Node.js / Deno / Bun.
 */

export const API_VERSION: "1.0";

/* ============================== Categories ============================== */

export type CategoryId =
  | "extraoral_frontal_rest"
  | "extraoral_frontal_smile"
  | "extraoral_profile_rest"
  | "extraoral_profile_smile"
  | "intraoral_frontal"
  | "intraoral_left"
  | "intraoral_right"
  | "intraoral_upper"
  | "intraoral_lower"
  | "cephalometric_frontal"
  | "cephalometric_lateral";

export interface Category {
  readonly id: CategoryId;
  /** Human-readable English label, e.g. "Intraoral left". */
  readonly label: string;
}

/** All categories in canonical display order. */
export const CATEGORIES: readonly Category[];

/* ================================ Input ================================= */

/** Already-decoded pixels. Works everywhere, including Node without a decoder. */
export interface RawImage {
  /** Row-major RGB or RGBA bytes, top-left first, already in display orientation. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). Inferred from data.length if omitted. */
  channels?: 3 | 4;
}

/** Encoded image file contents (JPEG, PNG, WebP, ...). EXIF orientation is applied. */
export type EncodedImage = Blob | File | ArrayBuffer | Uint8Array;

/**
 * Anything the sorter accepts as one image.
 * - RawImage / ImageData:   all environments
 * - EncodedImage, URL:       browsers & workers built in; elsewhere requires `options.decode`
 * - URL string:              fetched (http(s):, data:, blob:, and file: in Node)
 * - Browser image sources:   main thread / workers only
 */
export type ImageInput =
  | RawImage
  | EncodedImage
  | string
  | ImageData
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | VideoFrame;

/** An image with caller-chosen identity, echoed back in the result. */
export interface TaggedInput {
  image: ImageInput;
  /** Echoed as result.id. Default: generated ("img-N") for classify(), input index ("0", "1", ...) for sort(). */
  id?: string | number;
  /** Echoed as result.name. Default: File name or URL file name, else null. */
  name?: string;
}

export type SorterInput = ImageInput | TaggedInput;

/* ================================ Output ================================ */

export interface CategoryScore {
  category: CategoryId;
  label: string;
  /** Probability 0..1. */
  confidence: number;
}

interface ResultBase {
  id: string;
  name: string | null;
  /** Position in the input list (sort() only). */
  index?: number;
}

export interface ClassificationSuccess extends ResultBase {
  ok: true;
  /** Best category. */
  category: CategoryId;
  label: string;
  /** Probability of the best category, 0..1. */
  confidence: number;
  /** confidence < options.lowConfidenceThreshold (default 0.6): suggest human review. */
  lowConfidence: boolean;
  /** Best `topK` categories, highest first (top[0] is the chosen category). */
  top: CategoryScore[];
  /** Probability for every category; sums to 1. */
  scores: Record<CategoryId, number>;
  /** Raw model class name (diagnostics; may change with model versions). */
  modelClass: string;
  /** Decoded image size after EXIF orientation. */
  image: { width: number; height: number };
  /** Decode + preprocess + inference time. */
  timingMs: number;
}

export type ErrorCode =
  | "UNSUPPORTED_INPUT"   // input type not accepted in this environment
  | "FETCH_FAILED"        // URL input could not be fetched
  | "DECODE_FAILED"       // bytes are not a decodable image / bad pixel data
  | "INFERENCE_FAILED"    // model run failed
  | "DISPOSED"            // sorter.dispose() was called
  | "MODEL_LOAD_FAILED"   // createSorter(): model download/session creation failed
  | "RUNTIME_LOAD_FAILED" // createSorter(): onnxruntime could not be loaded
  | "ABORTED"             // sort() aborted via signal
  | "BUSY";               // <ordoline-sorter> only: a sort is already running

export interface ClassificationFailure extends ResultBase {
  ok: false;
  error: { code: ErrorCode; message: string };
}

/** Per-image result. Always plain JSON-serializable data. Discriminate on `ok`. */
export type ClassificationResult = ClassificationSuccess | ClassificationFailure;

export interface ModelInfo {
  readonly url: string | null;
  /** Execution provider in use: "webgpu", "wasm", or "default" (runtime's own, e.g. CPU in Node). */
  readonly backend: string;
  readonly inputSize: number;
  readonly classes: readonly string[];
}

export interface SortResult {
  apiVersion: "1.0";
  model: ModelInfo;
  /** One entry per input, in input order (`index` set). */
  results: Array<ClassificationResult & { index: number }>;
  /** Result ids per category, highest confidence first. Every category key is present. */
  byCategory: Record<CategoryId, string[]>;
  summary: {
    total: number;
    sorted: number;
    failed: number;
    lowConfidence: number;
    timingMs: number;
  };
}

/* ================================= API ================================== */

export interface SorterOptions {
  /** Model URL (must allow CORS in browsers). Default: built-in CDN URL. */
  modelUrl?: string;
  /** Model bytes instead of a URL (e.g. fs.readFileSync in Node). */
  model?: ArrayBuffer | Uint8Array;
  /** An onnxruntime module to use (onnxruntime-web or onnxruntime-node). Default: onnxruntime-web 1.22.0 from jsDelivr. */
  ort?: unknown;
  /** ESM URL to import onnxruntime-web from when `ort` is not given. */
  ortUrl?: string;
  /** Directory URL for onnxruntime-web .wasm files. */
  wasmPaths?: string;
  /** Default: ["webgpu", "wasm"] if WebGPU exists, else ["wasm"]; runtime default as last resort. */
  executionProviders?: string[];
  /** Decoder for encoded images where none is built in (Node). Must apply EXIF orientation. */
  decode?: (bytes: Uint8Array) => Promise<RawImage> | RawImage;
  /** Default 0.6. */
  lowConfidenceThreshold?: number;
  /** Default 3. */
  topK?: number;
  /** Model download progress. */
  onProgress?: (p: { loaded: number; total: number; fraction: number }) => void;
}

export interface SortOptions {
  topK?: number;
  /** Called after each image, in input order. */
  onResult?: (result: ClassificationResult & { index: number }, progress: { done: number; total: number }) => void;
  /** Stops before the next image; sort() then rejects. */
  signal?: AbortSignal;
}

export interface Sorter {
  readonly apiVersion: "1.0";
  readonly model: ModelInfo;
  readonly categories: readonly Category[];
  /** Classify one image. Never rejects for per-image problems: check `ok`. */
  classify(input: SorterInput, options?: { topK?: number }): Promise<ClassificationResult>;
  /** Classify many images sequentially and group them by category. */
  sort(inputs: Iterable<SorterInput> | ArrayLike<SorterInput>, options?: SortOptions): Promise<SortResult>;
  /** Free the model. Later calls return error code DISPOSED. */
  dispose(): void;
}

/**
 * Load runtime + model and return a Sorter. Identical plain options share one instance.
 * Rejects with OrdolineError (code MODEL_LOAD_FAILED or RUNTIME_LOAD_FAILED).
 */
export function createSorter(options?: SorterOptions): Promise<Sorter>;

export class OrdolineError extends Error {
  readonly name: "OrdolineError";
  readonly code: ErrorCode;
}
