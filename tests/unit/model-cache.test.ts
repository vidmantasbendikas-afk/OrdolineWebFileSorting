import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { ModelIntegrityError, VALIDATOR_HEADER, loadModelBytes, readBody, sha256Hex } from "../../src/sorter/model-cache.ts";
import { stubGlobal } from "./fakes.ts";
import { stubCaches, stubFetch, trackedResponse } from "./fakes.ts";

const URL_V1 = "https://cdn.test/model/best.onnx";
const CACHE = "test-model-cache";
const v1 = new Uint8Array([1, 1, 1, 1]);
const v2 = new Uint8Array([2, 2, 2, 2, 2]);

let restore: Array<() => void> = [];
test.afterEach(() => { restore.forEach((r) => r()); restore = []; });

/** Fake model server: serves `bytes` with `headers`; records whether each body was read or cancelled. */
function server(bytes: () => Uint8Array, headers: () => Record<string, string>) {
  const bodies: Array<{ read: boolean; cancelled: boolean }> = [];
  const f = stubFetch(() => {
    const { response, state } = trackedResponse(bytes(), { headers: headers() });
    bodies.push(state);
    return response;
  });
  restore.push(f.restore);
  return { bodies, urls: f.urls };
}

function cacheStores() {
  const c = stubCaches();
  restore.push(c.restore);
  return c.stores;
}

const bytesOf = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

test("first load downloads; the copy is stored only on commit", async () => {
  const stores = cacheStores();
  server(() => v1, () => ({ etag: '"v1"' }));
  const first = await loadModelBytes(URL_V1, CACHE);
  expect(first.source).toBe("network");
  expect(bytesOf(first.buffer)).toEqual([1, 1, 1, 1]);
  expect(stores.get(CACHE)!.entries.size).toBe(0); // not before the session was created from it
  await first.commit!(first.buffer);
  expect(stores.get(CACHE)!.entries.get(URL_V1)!.headers.get(VALIDATOR_HEADER)).toBe('"v1"');
});

test("unchanged ETag: cached copy is used and the download is cancelled", async () => {
  cacheStores();
  const { bodies } = server(() => v1, () => ({ etag: '"v1"' }));
  const first = await loadModelBytes(URL_V1, CACHE);
  await first.commit!(first.buffer);

  const second = await loadModelBytes(URL_V1, CACHE);
  expect(second.source).toBe("cache");
  expect(second.commit).toBeUndefined();
  expect(bytesOf(second.buffer)).toEqual([1, 1, 1, 1]);
  expect(bodies[1]).toEqual({ read: false, cancelled: true });
});

test("changed ETag: new model is downloaded and replaces the cached copy", async () => {
  const stores = cacheStores();
  let version = 1;
  server(() => (version === 1 ? v1 : v2), () => ({ etag: `"v${version}"` }));
  const first = await loadModelBytes(URL_V1, CACHE);
  await first.commit!(first.buffer);

  version = 2;
  const second = await loadModelBytes(URL_V1, CACHE);
  expect(second.source).toBe("network");
  expect(bytesOf(second.buffer)).toEqual([2, 2, 2, 2, 2]);
  // until committed, the old copy stays (a broken new model must not replace a working one)
  expect(stores.get(CACHE)!.entries.get(URL_V1)!.headers.get(VALIDATOR_HEADER)).toBe('"v1"');
  await second.commit!(second.buffer);
  expect(stores.get(CACHE)!.entries.get(URL_V1)!.headers.get(VALIDATOR_HEADER)).toBe('"v2"');
});

test("Last-Modified is used when ETag is not readable", async () => {
  cacheStores();
  const { bodies } = server(() => v1, () => ({ "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" }));
  const first = await loadModelBytes(URL_V1, CACHE);
  await first.commit!(first.buffer);
  expect((await loadModelBytes(URL_V1, CACHE)).source).toBe("cache");
  expect(bodies[1].cancelled).toBe(true);
});

test("no validator at all: nothing is cached (it could never be revalidated)", async () => {
  const stores = cacheStores();
  server(() => v1, () => ({}));
  const first = await loadModelBytes(URL_V1, CACHE);
  await first.commit!(first.buffer);
  expect(stores.get(CACHE)!.entries.size).toBe(0);
  expect((await loadModelBytes(URL_V1, CACHE)).source).toBe("network");
});

test("offline or server error: the cached copy is used; without one the load fails", async () => {
  cacheStores();
  server(() => v1, () => ({ etag: '"v1"' }));
  const first = await loadModelBytes(URL_V1, CACHE);
  await first.commit!(first.buffer);

  restore.push(stubFetch(() => { throw new TypeError("Failed to fetch"); }).restore);
  expect((await loadModelBytes(URL_V1, CACHE)).source).toBe("cache");
  await expect(loadModelBytes("https://cdn.test/other.onnx", CACHE)).rejects.toThrow("Failed to fetch");

  restore.push(stubFetch(() => new Response("down", { status: 503, statusText: "Service Unavailable" })).restore);
  expect((await loadModelBytes(URL_V1, CACHE)).source).toBe("cache");
  await expect(loadModelBytes("https://cdn.test/other.onnx", CACHE)).rejects.toThrow("503");
});

test("a new model URL drops copies of old URLs", async () => {
  const stores = cacheStores();
  server(() => v1, () => ({ etag: '"v1"' }));
  for (const url of [URL_V1, "https://cdn.test/model/v2/best.onnx"]) {
    const r = await loadModelBytes(url, CACHE);
    await r.commit!(r.buffer);
  }
  expect([...stores.get(CACHE)!.entries.keys()]).toEqual(["https://cdn.test/model/v2/best.onnx"]);
});

test("without the Cache API, or with modelCache: false, it is a plain download", async () => {
  const { urls } = server(() => v1, () => ({ etag: '"v1"' }));
  const noCacheApi = await loadModelBytes(URL_V1, CACHE); // caches is not defined in Node
  expect([noCacheApi.source, noCacheApi.commit]).toEqual(["network", undefined]);
  const stores = cacheStores();
  const disabled = await loadModelBytes(URL_V1, false);
  expect([disabled.source, disabled.commit, stores.size]).toEqual(["network", undefined, 0]);
  expect(urls).toHaveLength(2);
});

test("a failing cache write does not fail the load", async () => {
  const stores = cacheStores();
  server(() => v1, () => ({ etag: '"v1"' }));
  const r = await loadModelBytes(URL_V1, CACHE);
  stores.get(CACHE)!.put = async () => { throw new DOMException("full", "QuotaExceededError"); };
  const warn = console.warn;
  console.warn = () => {};
  try { await r.commit!(r.buffer); } finally { console.warn = warn; }
  expect(stores.get(CACHE)!.entries.size).toBe(0);
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test.describe("SHA-256 integrity check", () => {
  test("sha256Hex matches Node's hash, and is null without Web Crypto", async () => {
    expect(await sha256Hex(v2.slice().buffer)).toBe(sha(v2));
    const restoreCrypto = stubGlobal("crypto", undefined);
    try { expect(await sha256Hex(v2.slice().buffer)).toBeNull(); } finally { restoreCrypto(); }
  });

  test("a download with the expected hash is accepted and can be cached", async () => {
    const stores = cacheStores();
    server(() => v1, () => ({ etag: '"v1"' }));
    const r = await loadModelBytes(URL_V1, CACHE, undefined, sha(v1));
    expect(r.source).toBe("network");
    await r.commit!(r.buffer);
    expect(stores.get(CACHE)!.entries.size).toBe(1);
    expect((await loadModelBytes(URL_V1, CACHE, undefined, sha(v1))).source).toBe("cache");
  });

  test("a download with another hash is refused and never offered for caching", async () => {
    cacheStores();
    server(() => v2, () => ({ etag: '"v2"' }));
    const err = await loadModelBytes(URL_V1, CACHE, undefined, sha(v1)).catch((e) => e);
    expect(err).toBeInstanceOf(ModelIntegrityError);
    expect(err).toMatchObject({ expected: sha(v1), actual: sha(v2) });
  });

  test("a cached copy that does not match is dropped and the model downloaded again", async () => {
    const stores = cacheStores();
    let version = 1;
    const { bodies } = server(() => (version === 1 ? v1 : v2), () => ({ etag: '"same-etag"' }));
    const first = await loadModelBytes(URL_V1, CACHE);
    await first.commit!(first.buffer); // cached v1

    version = 2; // the expected model is v2, but the server still sends the same ETag
    const r = await loadModelBytes(URL_V1, CACHE, undefined, sha(v2));
    expect(r.source).toBe("network");
    expect(bodies[1].read).toBe(true);
    expect(stores.get(CACHE)!.entries.size).toBe(0); // old copy removed; the new one is stored on commit
    await r.commit!(r.buffer);
    expect((await loadModelBytes(URL_V1, CACHE, undefined, sha(v2))).source).toBe("cache");
  });

  test("offline with a cached copy that does not match: the load fails instead of using it", async () => {
    cacheStores();
    server(() => v1, () => ({ etag: '"v1"' }));
    const first = await loadModelBytes(URL_V1, CACHE);
    await first.commit!(first.buffer);
    restore.push(stubFetch(() => { throw new TypeError("Failed to fetch"); }).restore);
    await expect(loadModelBytes(URL_V1, CACHE, undefined, sha(v2))).rejects.toThrow("Failed to fetch");
  });

  test("without Web Crypto (insecure http: page) the check is skipped with a warning", async () => {
    server(() => v2, () => ({ etag: '"v2"' }));
    const restoreCrypto = stubGlobal("crypto", undefined);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      expect((await loadModelBytes(URL_V1, false, undefined, sha(v1))).source).toBe("network");
    } finally { console.warn = warn; restoreCrypto(); }
    expect(warnings.join()).toContain("secure (https) pages");
  });
});

test("download progress reports bytes loaded and the total", async () => {
  const chunks = [new Uint8Array(3), new Uint8Array(5)];
  const body = new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
  const seen: Array<[number, number]> = [];
  const buf = await readBody(new Response(body, { headers: { "content-length": "8" } }), (l, t) => seen.push([l, t]));
  expect(buf.byteLength).toBe(8);
  expect(seen).toEqual([[3, 8], [8, 8]]);
});
