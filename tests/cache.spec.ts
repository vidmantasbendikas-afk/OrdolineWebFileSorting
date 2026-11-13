import { statSync, utimesSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { MODEL_CDN_URL, MODEL_PATH, openHarness, SAMPLE } from "./helpers.ts";

/** Fresh page load + createSorter; returns where the model came from. */
async function loadSource(page: Page, options: { modelCache?: false; modelUrl?: string } = {}): Promise<string> {
  await openHarness(page);
  return page.evaluate(async (opts) => (await window.api.createSorter(opts)).model.source, options);
}

test("model is cached and revalidated by ETag", async ({ page }) => {
  const original = statSync(MODEL_PATH);
  try {
    expect(await loadSource(page), "first visit downloads").toBe("network");
    expect(await loadSource(page), "unchanged model comes from cache").toBe("cache");

    utimesSync(MODEL_PATH, new Date(), new Date()); // new mtime -> new ETag, like uploading a new model
    expect(await loadSource(page), "changed ETag downloads again").toBe("network");
    expect(await loadSource(page), "new copy is cached").toBe("cache");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.clearBrowserCache"); // browser evicted its HTTP cache
    expect(await loadSource(page), "Cache API copy survives HTTP cache eviction").toBe("cache");

    const r = await page.evaluate(async (url) => (await window.api.createSorter()).classify(url), SAMPLE.url);
    expect(r.ok && r.category).toBe("intraoral_left");
  } finally {
    utimesSync(MODEL_PATH, original.atime, original.mtime);
  }
});

test("only the current model URL is kept in the cache", async ({ page }) => {
  await loadSource(page);
  const keys = await page.evaluate(async () =>
    (await (await caches.open("ordoline-sorter-model")).keys()).map((r) => new URL(r.url).pathname));
  expect(keys).toEqual(["/dist/sorter/model/best.onnx"]);
});

test("modelCache: false always downloads and stores nothing", async ({ page }) => {
  expect(await loadSource(page, { modelCache: false })).toBe("network");
  expect(await loadSource(page, { modelCache: false })).toBe("network");
  const stored = await page.evaluate(async () => (await caches.has("ordoline-sorter-model")));
  expect(stored).toBe(false);
});

test("cross-origin model (CDN) is cached and revalidated by ETag", async ({ page }) => {
  const original = statSync(MODEL_PATH);
  try {
    expect(await loadSource(page, { modelUrl: MODEL_CDN_URL }), "first visit downloads").toBe("network");
    expect(await loadSource(page, { modelUrl: MODEL_CDN_URL }), "ETag readable cross-origin -> cache").toBe("cache");
    utimesSync(MODEL_PATH, new Date(), new Date());
    expect(await loadSource(page, { modelUrl: MODEL_CDN_URL }), "new upload is picked up").toBe("network");
  } finally {
    utimesSync(MODEL_PATH, original.atime, original.mtime);
  }
});

test("model CDN sends the headers the sorter relies on", async ({ request }) => {
  const res = await request.get(MODEL_CDN_URL, { headers: { Origin: "http://example.com" } });
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["etag"]).toBeTruthy();
  expect(h["cache-control"]).toBe("no-cache");
  expect(h["access-control-allow-origin"]).toBe("*");
  expect(h["access-control-expose-headers"]).toBe("ETag");
  const revalidated = await request.get(MODEL_CDN_URL, { headers: { "If-None-Match": h["etag"] } });
  expect(revalidated.status()).toBe(304);
});
