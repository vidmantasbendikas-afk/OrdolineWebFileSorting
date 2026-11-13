/** Public types of the sorter API. */

export const API_VERSION = "1.0";

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

/** Already-decoded pixels, e.g. from your own canvas or image pipeline. */
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
 * - URL string: fetched (http(s):, data:, blob:); cross-origin URLs need CORS
 * - HTMLImageElement / HTMLCanvasElement: main thread only (not available in workers)
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
  | "UNSUPPORTED_INPUT" // input type not accepted
  | "FETCH_FAILED" // URL input could not be fetched
  | "DECODE_FAILED" // bytes are not a decodable image / bad pixel data
  | "INFERENCE_FAILED" // model run failed
  | "DISPOSED" // sorter.dispose() was called
  | "MODEL_LOAD_FAILED" // createSorter(): model download/session creation failed
  | "RUNTIME_LOAD_FAILED" // createSorter(): onnxruntime could not be loaded
  | "ABORTED" // classify() cancelled via signal
  | "INVALID_OPTIONS" // createSorter(): options cannot be combined (worker + ort)
  | "BUSY"; // <ordoline-sorter> only: a sort is already running

export interface ClassificationFailure extends ResultBase {
  ok: false;
  error: { code: ErrorCode; message: string };
}

/** Per-image result. Always plain JSON-serializable data. Discriminate on `ok`. */
export type ClassificationResult = ClassificationSuccess | ClassificationFailure;

export interface ModelInfo {
  readonly url: string;
  /** Where the model bytes came from: "network" (downloaded) or "cache" (Cache API copy: ETag unchanged, or offline). */
  readonly source: "network" | "cache";
  /** Execution provider in use: "webgpu" or "wasm". */
  readonly backend: string;
  /** WASM threads in use (null on WebGPU). More than 1 only on cross-origin isolated pages (COOP + COEP headers). */
  readonly threads: number | null;
  /** True when the sorter runs in a Web Worker (options.worker). */
  readonly worker: boolean;
  readonly inputSize: number;
  readonly classes: readonly string[];
}

export type IndexedResult = ClassificationResult & { index: number };

export interface SortResult {
  apiVersion: typeof API_VERSION;
  model: ModelInfo;
  /** One entry per processed input, in input order (`index` set). After a stop, inputs not reached are absent. */
  results: IndexedResult[];
  /** Result ids per category, highest confidence first. Every category key is present. */
  byCategory: Record<CategoryId, string[]>;
  summary: {
    /** Number of inputs given; equals sorted + failed + skipped. */
    total: number;
    sorted: number;
    failed: number;
    /** Inputs not processed because the sort was stopped. */
    skipped: number;
    lowConfidence: number;
    /** True when the sort was stopped via `signal`; the result then covers the photos done so far. */
    aborted: boolean;
    timingMs: number;
  };
}

export interface ProgressInfo {
  loaded: number;
  total: number;
  fraction: number;
}

export interface SorterOptions {
  /** Model URL (must allow CORS when cross-origin). Default: model/best.onnx next to this module. */
  modelUrl?: string;
  /**
   * Cache API name for a persistent model copy, revalidated by ETag (or Last-Modified) on every load. Default
   * "ordoline-sorter-model"; false disables. Cross-origin the CDN must send `Access-Control-Expose-Headers: ETag`.
   */
  modelCache?: string | false;
  /** Your own onnxruntime-web module (e.g. bundled via npm). Default: onnxruntime-web 1.22.0 from jsDelivr. */
  ort?: unknown;
  /** ESM URL to import onnxruntime-web from when `ort` is not given. */
  ortUrl?: string;
  /** Directory URL for onnxruntime-web .wasm files. */
  wasmPaths?: string | null;
  /** Default: ["webgpu", "wasm"]; "webgpu" is skipped when no GPU adapter is available. */
  executionProviders?: string[] | null;
  /**
   * Run decoding, preprocessing and inference in a Web Worker so the page never freezes. Same API and results.
   * Not combinable with `ort`. Default false.
   */
  worker?: boolean;
  /** WASM inference threads. Default: up to 4 on cross-origin isolated pages, else 1. */
  numThreads?: number | null;
  /** Default 0.6. */
  lowConfidenceThreshold?: number;
  /** Default 3. */
  topK?: number;
  /** Model download progress. */
  onProgress?: (p: ProgressInfo) => void;
}

export interface SortOptions {
  topK?: number;
  /** Called after each image, in input order. */
  onResult?: (result: IndexedResult, progress: { done: number; total: number }) => void;
  /**
   * Stops the sort. sort() then resolves at once with the photos done so far and `summary.aborted: true`.
   * A photo whose inference is already running cannot be interrupted; its result is discarded.
   */
  signal?: AbortSignal;
}

export interface ClassifyOptions {
  topK?: number;
  /** Id used when the input carries none (sort() passes the index). */
  id?: string;
  /** Cancels this call: it resolves at once with error code ABORTED unless the result is already available. */
  signal?: AbortSignal;
}

export interface Sorter {
  readonly apiVersion: typeof API_VERSION;
  readonly model: ModelInfo;
  readonly categories: readonly Category[];
  /** Classify one image. Never rejects for per-image problems: check `ok`. */
  classify(input: SorterInput, options?: ClassifyOptions): Promise<ClassificationResult>;
  /** Classify many images sequentially and group them by category. */
  sort(inputs: Iterable<SorterInput> | ArrayLike<SorterInput>, options?: SortOptions): Promise<SortResult>;
  /** Free the model. Later calls return error code DISPOSED. */
  dispose(): void;
}
