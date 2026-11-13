/** Downloading the model, with a persistent Cache API copy revalidated by ETag. */

export type ByteProgress = (loaded: number, total: number) => void;

export async function readUrl(url: string, onProgress?: ByteProgress): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return readBody(res, onProgress);
}

export async function readBody(res: Response, onProgress?: ByteProgress): Promise<ArrayBuffer> {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/* Model cache: a persistent copy in the Cache API, revalidated against the server's ETag on every load.
 *   - unchanged ETag  -> body download is cancelled, cached copy is used
 *   - changed ETag    -> new model is downloaded and replaces the cached copy (after it loads successfully)
 *   - network failure -> cached copy is used (offline)
 * Cross-origin, ETag is only readable with `Access-Control-Expose-Headers: ETag`; Last-Modified is the fallback.
 * Without Cache API (insecure http: pages, some private modes) this is a plain download. */
export const VALIDATOR_HEADER = "x-ordoline-validator";

export async function openModelCache(name: string | false): Promise<Cache | null> {
  if (!name || typeof caches === "undefined") return null;
  try { return await caches.open(name); } catch { return null; }
}

export interface ModelBytes {
  buffer: ArrayBuffer;
  source: "network" | "cache";
  /** Stores the downloaded model in the cache; call only after it loaded successfully. */
  commit?: (bytes: ArrayBuffer) => Promise<void>;
}

export async function loadModelBytes(url: string, cacheName: string | false, onProgress?: ByteProgress): Promise<ModelBytes> {
  const cache = await openModelCache(cacheName);
  let cached: Response | undefined;
  if (cache) { try { cached = await cache.match(url); } catch { cached = undefined; } }
  const useCached = async (copy: Response): Promise<ModelBytes> => {
    const buffer = await copy.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return { buffer, source: "cache" };
  };

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (cached) return useCached(cached); // offline / server unreachable
    throw err;
  }
  if (!res.ok) {
    if (cached) { res.body?.cancel().catch(() => {}); return useCached(cached); }
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }

  const validator = res.headers.get("etag") || res.headers.get("last-modified");
  if (cached && validator && cached.headers.get(VALIDATOR_HEADER) === validator) {
    res.body?.cancel().catch(() => {});
    return useCached(cached);
  }

  const buffer = await readBody(res, onProgress);
  if (!cache) return { buffer, source: "network" };
  // Stored only after the session is created from it, so a broken download never gets cached.
  const commit = async (bytes: ArrayBuffer) => {
    try {
      if (!validator) { await cache.delete(url); return; } // cannot revalidate: do not keep a copy
      await cache.put(url, new Response(bytes, {
        headers: { "content-type": "application/octet-stream", [VALIDATOR_HEADER]: validator },
      }));
      for (const req of await cache.keys()) if (req.url !== url) await cache.delete(req); // drop old model URLs
    } catch (err) {
      console.warn("[ordoline] model not cached:", (err as Error)?.name || err); // e.g. QuotaExceededError
    }
  };
  return { buffer, source: "network", commit };
}
