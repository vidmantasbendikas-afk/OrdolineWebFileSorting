import { test, expect } from "@playwright/test";
import { openHarness, SAMPLE, testImages } from "./helpers.ts";

test.beforeEach(async ({ page }) => openHarness(page));

test("worker sorter reports where it runs", async ({ page }) => {
  const model = await page.evaluate(async () => (await window.api.createSorter({ worker: true })).model);
  expect(model.worker).toBe(true);
  expect(model.classes).toHaveLength(11);
  if (model.backend === "wasm") expect(model.threads).toBeGreaterThan(1); // isolation is inherited by the worker
});

test("worker and in-thread sorters give identical results for every input type", async ({ page }) => {
  const rows = await page.evaluate(async (url) => {
    const inThread = await window.api.createSorter();
    const inWorker = await window.api.createSorter({ worker: true });
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    offscreen.getContext("2d")!.drawImage(bitmap, 0, 0);
    const imageData = canvas.getContext("2d")!.getImageData(0, 0, bitmap.width, bitmap.height);
    const img = new Image();
    img.src = url;

    const inputs: Record<string, () => unknown> = {
      Blob: () => blob,
      File: () => new File([blob], "photo.jpg", { type: "image/jpeg" }),
      Uint8Array: () => blob.arrayBuffer().then((b) => new Uint8Array(b)),
      "relative URL": () => url,
      ImageBitmap: () => bitmap,
      ImageData: () => imageData,
      HTMLImageElement: () => img,
      HTMLCanvasElement: () => canvas,
      OffscreenCanvas: () => offscreen,
      TaggedInput: () => ({ image: blob, id: "x1", name: "tagged" }),
    };
    const out = [];
    for (const [type, make] of Object.entries(inputs)) {
      const a = await inThread.classify((await make()) as Blob);
      const b = await inWorker.classify((await make()) as Blob);
      out.push({
        type,
        thread: a.ok ? `${a.category} ${a.confidence.toFixed(4)} ${a.id === "x1" ? a.id : ""} ${a.name ?? ""}` : a.error.code,
        worker: b.ok ? `${b.category} ${b.confidence.toFixed(4)} ${b.id === "x1" ? b.id : ""} ${b.name ?? ""}` : b.error.code,
      });
    }
    return out;
  }, SAMPLE.url);

  for (const r of rows) {
    expect(r.worker, r.type).toBe(r.thread);
    expect(r.worker, r.type).toContain("intraoral_left");
  }
});

test("worker sort keeps order, reports progress and can be aborted", async ({ page }) => {
  const urls = testImages(1).slice(0, 4).map((i) => i.url);
  const out = await page.evaluate(async (urls) => {
    const s = await window.api.createSorter({ worker: true });
    const progress: number[] = [];
    const res = await s.sort(urls, { onResult: (_r, p) => progress.push(p.done) });
    const ctrl = new AbortController();
    let code = "none";
    try {
      await s.sort(urls, { signal: ctrl.signal, onResult: () => ctrl.abort() });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    return { indexes: res.results.map((r) => r.index), progress, sorted: res.summary.sorted, model: res.model.worker, code };
  }, urls);
  expect(out).toEqual({ indexes: [0, 1, 2, 3], progress: [1, 2, 3, 4], sorted: 4, model: true, code: "ABORTED" });
});

test("worker reports per-image errors and dispose", async ({ page }) => {
  const codes = await page.evaluate(async (url) => {
    const s = await window.api.createSorter({ worker: true });
    const code = (r: Awaited<ReturnType<typeof s.classify>>) => (r.ok ? "ok" : r.error.code);
    const out = {
      garbage: code(await s.classify(new Uint8Array([1, 2, 3]))),
      missing: code(await s.classify("/data/does-not-exist.jpg")),
      notCloneable: code(await s.classify((() => 1) as unknown as Blob)),
      good: code(await s.classify(url)),
      disposed: "",
    };
    s.dispose();
    out.disposed = code(await s.classify(url));
    return out;
  }, SAMPLE.url);
  expect(codes).toEqual({
    garbage: "DECODE_FAILED", missing: "FETCH_FAILED", notCloneable: "UNSUPPORTED_INPUT", good: "ok", disposed: "DISPOSED",
  });
});

test("worker cannot be combined with an injected runtime", async ({ page }) => {
  const code = await page.evaluate(async () => {
    try {
      await window.api.createSorter({ worker: true, ort: {} });
      return "none";
    } catch (e) {
      return (e as { code: string }).code;
    }
  });
  expect(code).toBe("INVALID_OPTIONS");
});

test("page stays responsive while sorting in a worker", async ({ page }) => {
  const urls = testImages(1).slice(0, 6).map((i) => i.url);
  const gaps = await page.evaluate(async (urls) => {
    /** Longest time the main thread was blocked (gap between 5 ms timer ticks) while `fn` runs. */
    async function longestFreeze(fn: () => Promise<unknown>) {
      let last = performance.now(), max = 0;
      const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now; }, 5);
      await fn();
      clearInterval(timer);
      return Math.round(max);
    }
    const inThread = await window.api.createSorter();
    const inWorker = await window.api.createSorter({ worker: true });
    await inThread.classify(urls[0]); // warm up both
    await inWorker.classify(urls[0]);
    return {
      inThread: await longestFreeze(() => inThread.sort(urls)),
      inWorker: await longestFreeze(() => inWorker.sort(urls)),
    };
  }, urls);
  console.log(`longest main-thread freeze while sorting 6 photos: in-thread ${gaps.inThread} ms, worker ${gaps.inWorker} ms`);
  expect(gaps.inWorker).toBeLessThan(100);
  expect(gaps.inWorker).toBeLessThan(gaps.inThread);
});
