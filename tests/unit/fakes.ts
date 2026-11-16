/** Test doubles for unit tests: fetch, the Cache API and onnxruntime. No browser, no model, no network. */
import type { OrtModule, OrtSession, OrtTensor } from "../../src/sorter/runtime.ts";
import type { RawImage } from "../../src/sorter/types.ts";

export const MB = 1 << 20;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replace a global for one test; returns a restore function. */
export function stubGlobal(name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => (had ? Object.defineProperty(globalThis, name, had) : delete (globalThis as Record<string, unknown>)[name]);
}

/** A response whose body records whether it was read or cancelled. */
export function trackedResponse(bytes: Uint8Array, init: ResponseInit = {}) {
  const state = { read: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) { state.read = true; ctrl.enqueue(bytes); ctrl.close(); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  const headers = new Headers(init.headers);
  headers.set("content-length", String(bytes.length));
  return { response: new Response(body, { ...init, headers }), state };
}

export type FetchHandler = (url: string) => Response | Promise<Response>;

/** Stub global fetch; records requested URLs. */
export function stubFetch(handler: FetchHandler) {
  const urls: string[] = [];
  const restore = stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return handler(url);
  });
  return { urls, restore };
}

/** Minimal in-memory Cache API (only what model-cache.ts uses). */
export class FakeCache {
  readonly entries = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();
  async match(req: RequestInfo): Promise<Response | undefined> {
    const e = this.entries.get(typeof req === "string" ? req : req.url);
    return e && new Response(e.bytes.slice(0), { headers: e.headers });
  }
  async put(req: RequestInfo, res: Response): Promise<void> {
    this.entries.set(typeof req === "string" ? req : req.url, { bytes: await res.arrayBuffer(), headers: new Headers(res.headers) });
  }
  async delete(req: RequestInfo): Promise<boolean> {
    return this.entries.delete(typeof req === "string" ? req : req.url);
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export function stubCaches() {
  const stores = new Map<string, FakeCache>();
  const restore = stubGlobal("caches", {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
  });
  return { stores, restore };
}

/** The 11 training classes in model order, as the model's metadata lists them. */
export const CLASS_NAMES = [
  "ceph_front", "ceph_side", "extr_profile_rest", "extr_profile_smile", "extr_rest", "extr_smile",
  "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
];
export const namesMetadata = (names: string[]) => ({ names: `{${names.map((n, i) => `${i}: '${n}'`).join(", ")}}` });

export interface FakeOrtOptions {
  /** Output for one run; receives the input tensor data. Default: confident "intr_left". */
  output?: (input: Float32Array) => number[];
  classes?: string[];
  inputSize?: number;
  runDelayMs?: number;
  /** Execution providers whose session creation fails. */
  failingProviders?: string[];
  runError?: Error;
}

/** Fake onnxruntime-web: records sessions and runs, and checks that runs never overlap. */
export function fakeOrt(o: FakeOrtOptions = {}) {
  const classes = o.classes ?? CLASS_NAMES;
  const size = o.inputSize ?? 8;
  const log = { created: [] as string[][], runs: 0, active: 0, maxActive: 0, released: 0, inputs: [] as number[][] };
  const session: OrtSession = {
    inputNames: ["input"],
    outputNames: ["logits"],
    inputMetadata: [{ dims: [1, 3, size, size] }],
    metadata: namesMetadata(classes),
    async run(feeds) {
      const t = feeds.input as OrtTensor & { dims: number[] };
      log.inputs.push(t.dims);
      log.runs++;
      log.active++;
      log.maxActive = Math.max(log.maxActive, log.active);
      try {
        await sleep(o.runDelayMs ?? 0);
        if (o.runError) throw o.runError;
        const probs = o.output?.(t.data as Float32Array) ?? classes.map((c) => (c === "intr_left" ? 0.9 : 0.1 / (classes.length - 1)));
        return { logits: { data: probs } };
      } finally {
        log.active--;
      }
    },
    async release() { log.released++; },
  };
  const ort: OrtModule = {
    InferenceSession: {
      async create(_model, opts) {
        const eps = opts?.executionProviders ?? [];
        log.created.push(eps);
        if (o.failingProviders?.includes(eps[0])) throw new Error(`${eps[0]} not available`);
        return session;
      },
    },
    Tensor: class { constructor(public type: string, public data: Float32Array, public dims: readonly number[]) {} },
    env: { wasm: {} },
  };
  return { ort, log };
}

export const rgb = (width: number, height: number, fill = 128): RawImage =>
  ({ data: new Uint8Array(width * height * 3).fill(fill), width, height, channels: 3 });

/** One-hot-ish output: `winner` gets p, the rest share 1 - p. */
export const outputFor = (winner: string, p: number, classes = CLASS_NAMES) =>
  classes.map((c) => (c === winner ? p : (1 - p) / (classes.length - 1)));
