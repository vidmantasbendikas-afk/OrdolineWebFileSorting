/** Loading onnxruntime-web (minimal typing of the parts we use), threads and WebGPU detection. */
import type { ResolvedOptions } from "./options.js";

export interface OrtTensor {
  readonly data: ArrayLike<number>;
}

export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly inputMetadata?: ReadonlyArray<{ dims?: ReadonlyArray<number | string> }>;
  readonly metadata?: unknown;
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface OrtModule {
  InferenceSession: { create(model: Uint8Array, options?: { executionProviders?: string[] }): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => OrtTensor;
  env?: { logLevel?: string; wasm?: { wasmPaths?: string; numThreads?: number } };
}

export const ortImports = new Map<string, Promise<{ default?: OrtModule } & Partial<OrtModule>>>();

export async function loadOrt(opts: ResolvedOptions): Promise<{ ort: OrtModule; fromCdn: boolean }> {
  if (opts.ort) return { ort: opts.ort as OrtModule, fromCdn: false };
  const globalOrt = (globalThis as { ort?: OrtModule }).ort;
  if (globalOrt?.InferenceSession) return { ort: globalOrt, fromCdn: false };
  if (!ortImports.has(opts.ortUrl)) {
    const p = import(/* webpackIgnore: true */ /* @vite-ignore */ opts.ortUrl);
    p.catch(() => ortImports.delete(opts.ortUrl));
    ortImports.set(opts.ortUrl, p);
  }
  const mod = await ortImports.get(opts.ortUrl)!;
  return { ort: (mod.InferenceSession ? mod : mod.default) as OrtModule, fromCdn: true };
}


export function defaultThreads(): number {
  // Measured on a 22-core machine: 1 thread 570 ms, 2: 360 ms, 4: 260 ms, 8+: no further gain.
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores - 1)); // leave a core for the page
}

export async function hasWebGpuAdapter(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
    return !!(await gpu?.requestAdapter());
  } catch {
    return false;
  }
}

export function parseClassNames(meta: unknown): string[] | null {
  const raw = (meta as { names?: unknown } | null | undefined)?.names;
  if (!raw) return null;
  const pairs = [...String(raw).matchAll(/(\d+)\s*:\s*'([^']+)'/g)];
  if (!pairs.length) return null;
  const byIndex = new Map<number, string>();
  for (const [, idx, name] of pairs) byIndex.set(Number(idx), name);
  return [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!);
}

export function sessionInputSize(session: OrtSession): number {
  const dim = session.inputMetadata?.[0]?.dims?.[2];
  return typeof dim === "number" && Number.isFinite(dim) && dim > 0 ? dim : 384;
}
