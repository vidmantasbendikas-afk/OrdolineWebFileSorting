import { test, expect } from "@playwright/test";
import { openHarness, SAMPLE, testImages } from "./helpers.ts";

test.beforeEach(async ({ page }) => openHarness(page));

test("createSorter loads the model and reports its info", async ({ page }) => {
  const info = await page.evaluate(async () => {
    const s = await window.api.createSorter();
    return { apiVersion: s.apiVersion, model: s.model, categories: s.categories.length };
  });
  expect(info.apiVersion).toBe("1.0");
  expect(info.model.inputSize).toBe(384);
  expect(info.model.classes).toHaveLength(11);
  expect(["webgpu", "wasm"]).toContain(info.model.backend);
  expect(["network", "cache"]).toContain(info.model.source);
  // the dev server sends COOP + COEP, so WASM inference runs multi-threaded
  if (info.model.backend === "wasm") expect(info.model.threads).toBeGreaterThan(1);
  expect(info.categories).toBe(11);
});

test("createSorter returns the same instance for the same options", async ({ page }) => {
  const same = await page.evaluate(async () => (await window.api.createSorter()) === (await window.api.createSorter()));
  expect(same).toBe(true);
});

test("classify returns the documented result shape", async ({ page }) => {
  const r = await page.evaluate(async (url) => (await window.api.createSorter()).classify(url), SAMPLE.url);

  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.category).toBe("intraoral_left");
  expect(r.label).toBe("Intraoral left");
  expect(r.name).toBe(SAMPLE.name);
  expect(r.id).toMatch(/^img-\d+$/);
  expect(r.confidence).toBeGreaterThan(0.6);
  expect(r.lowConfidence).toBe(false);
  expect(r.top).toHaveLength(3);
  expect(r.top[0]).toEqual({ category: r.category, label: r.label, confidence: r.confidence });
  expect(r.top.map((t) => t.confidence)).toEqual([...r.top.map((t) => t.confidence)].sort((a, b) => b - a));
  expect(Object.keys(r.scores)).toHaveLength(11);
  expect(Object.values(r.scores).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  expect(r.modelClass).toBe("intr_left");
  expect(r.image.width).toBeGreaterThan(0);
  expect(r.image.height).toBeGreaterThan(0);
  expect(r.timingMs).toBeGreaterThanOrEqual(0);
});

test("classify honours topK", async ({ page }) => {
  const r = await page.evaluate(async (url) => (await window.api.createSorter()).classify(url, { topK: 5 }), SAMPLE.url);
  expect(r.ok && r.top.length).toBe(5);
});

test("every supported input type gives the same result", async ({ page }) => {
  const rows = await page.evaluate(async (url) => {
    const s = await window.api.createSorter();
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const img = new Image();
    img.src = url;

    const inputs: Record<string, unknown> = {
      Blob: blob,
      File: new File([blob], "photo.jpg", { type: "image/jpeg" }),
      ArrayBuffer: await blob.arrayBuffer(),
      Uint8Array: new Uint8Array(await blob.arrayBuffer()),
      "URL string": url,
      ImageBitmap: bitmap,
      ImageData: imageData,
      RawImage: { data: imageData.data, width: imageData.width, height: imageData.height },
      HTMLImageElement: img,
      TaggedInput: { image: blob, id: "my-id", name: "my-name" },
    };
    const out = [];
    for (const [type, input] of Object.entries(inputs)) {
      const r = await s.classify(input as Blob);
      out.push({ type, ok: r.ok, category: r.ok ? r.category : null, confidence: r.ok ? r.confidence : 0, id: r.id, name: r.name });
    }
    return out;
  }, SAMPLE.url);

  for (const row of rows) {
    expect(row.ok, row.type).toBe(true);
    expect(row.category, row.type).toBe("intraoral_left");
    expect(row.confidence, row.type).toBeCloseTo(rows[0].confidence, 3);
  }
  const tagged = rows.find((r) => r.type === "TaggedInput")!;
  expect(tagged).toMatchObject({ id: "my-id", name: "my-name" });
  expect(rows.find((r) => r.type === "File")!.name).toBe("photo.jpg");
});

test("sort accepts arrays, FileLists, Sets and other iterables", async ({ page }) => {
  const urls = testImages(1).slice(0, 3).map((i) => i.url);
  const counts = await page.evaluate(async (urls) => {
    const s = await window.api.createSorter();
    const files = await Promise.all(urls.map(async (u, i) => new File([await (await fetch(u)).blob()], `f${i}.jpg`, { type: "image/jpeg" })));
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    function* gen() { yield* files; }
    return {
      array: (await s.sort(files)).summary.sorted,
      fileList: (await s.sort(dt.files)).summary.sorted,
      set: (await s.sort(new Set(files))).summary.sorted,
      generator: (await s.sort(gen())).summary.sorted,
      urls: (await s.sort(urls)).summary.sorted,
      empty: (await s.sort([])).summary.total,
    };
  }, urls);
  expect(counts).toEqual({ array: 3, fileList: 3, set: 3, generator: 3, urls: 3, empty: 0 });
});

test("sort keeps input order, groups by category and reports progress", async ({ page }) => {
  const images = testImages(1);
  const { result, progress } = await page.evaluate(async (urls) => {
    const s = await window.api.createSorter();
    const progress: Array<[number, number, number]> = [];
    const result = await s.sort(urls, { onResult: (r, p) => progress.push([r.index, p.done, p.total]) });
    return { result, progress };
  }, images.map((i) => i.url));

  expect(result.apiVersion).toBe("1.0");
  expect(result.results.map((r) => r.index)).toEqual(images.map((_, i) => i));
  expect(result.results.map((r) => r.id)).toEqual(images.map((_, i) => String(i)));
  expect(progress).toEqual(images.map((_, i) => [i, i + 1, images.length]));
  expect(Object.keys(result.byCategory)).toHaveLength(11);
  const grouped = Object.values(result.byCategory).flat().sort();
  expect(grouped).toEqual(result.results.filter((r) => r.ok).map((r) => r.id).sort());
  for (const ids of Object.values(result.byCategory)) {
    const conf = ids.map((id) => { const r = result.results.find((x) => x.id === id)!; return r.ok ? r.confidence : 0; });
    expect(conf).toEqual([...conf].sort((a, b) => b - a));
  }
  expect(result.summary).toMatchObject({ total: images.length, sorted: images.length, failed: 0 });
});

test("sort can be aborted", async ({ page }) => {
  const outcome = await page.evaluate(async (url) => {
    const s = await window.api.createSorter();
    const ctrl = new AbortController();
    let seen = 0;
    try {
      await s.sort([url, url, url], { signal: ctrl.signal, onResult: () => { seen++; ctrl.abort(); } });
      return { code: "none", seen };
    } catch (e) {
      return { code: (e as InstanceType<typeof window.api.OrdolineError>).code, seen };
    }
  }, SAMPLE.url);
  expect(outcome).toEqual({ code: "ABORTED", seen: 1 });
});

test("bad inputs return error results instead of throwing", async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const s = await window.api.createSorter();
    const codes: Record<string, string> = {};
    const cases: Record<string, unknown> = {
      "garbage bytes": new Uint8Array([1, 2, 3]),
      "missing URL": "/data/does-not-exist.jpg",
      number: 42,
      "bad pixel data": { data: new Uint8Array(10), width: 100, height: 100 },
    };
    for (const [k, v] of Object.entries(cases)) {
      const r = await s.classify(v as Blob);
      codes[k] = r.ok ? "ok" : r.error.code;
    }
    return codes;
  });
  expect(errors).toEqual({
    "garbage bytes": "DECODE_FAILED",
    "missing URL": "FETCH_FAILED",
    number: "UNSUPPORTED_INPUT",
    "bad pixel data": "DECODE_FAILED",
  });
});

test("one failing image does not stop a sort", async ({ page }) => {
  const summary = await page.evaluate(async (url) =>
    (await (await window.api.createSorter()).sort([url, new Uint8Array([0]), url])).summary, SAMPLE.url);
  expect(summary).toMatchObject({ total: 3, sorted: 2, failed: 1 });
});

test("createSorter rejects with MODEL_LOAD_FAILED for a missing model", async ({ page }) => {
  const err = await page.evaluate(async () => {
    try {
      await window.api.createSorter({ modelUrl: "/model/missing.onnx", modelCache: false });
      return null;
    } catch (e) {
      return { isOrdolineError: e instanceof window.api.OrdolineError, code: (e as { code: string }).code };
    }
  });
  expect(err).toEqual({ isOrdolineError: true, code: "MODEL_LOAD_FAILED" });
});

test("dispose stops further classification", async ({ page }) => {
  const r = await page.evaluate(async (url) => {
    const s = await window.api.createSorter();
    s.dispose();
    return s.classify(url);
  }, SAMPLE.url);
  expect(r.ok ? "ok" : r.error.code).toBe("DISPOSED");
});

test("parallel classify calls give the same results as sequential ones", async ({ page }) => {
  const urls = testImages(1).slice(0, 4).map((i) => i.url);
  const { sequential, parallel } = await page.evaluate(async (urls) => {
    const s = await window.api.createSorter();
    const sequential = [];
    for (const u of urls) sequential.push(await s.classify(u));
    const parallel = await Promise.all(urls.map((u) => s.classify(u)));
    const pick = (r: Awaited<ReturnType<typeof s.classify>>) => (r.ok ? [r.category, r.confidence.toFixed(4)] : [r.error.code]);
    return { sequential: sequential.map(pick), parallel: parallel.map(pick) };
  }, urls);
  expect(parallel).toEqual(sequential);
});

test("works inside a Web Worker without a DOM", async ({ page }) => {
  const urls = testImages(1).slice(0, 3).map((i) => i.url);
  const { inWorker, onPage } = await page.evaluate(async (urls) => {
    const code = `
      import { createSorter } from "${location.origin}/sorter/ordoline-sorter.js";
      onmessage = async (e) => {
        const s = await createSorter();
        const res = await s.sort(e.data.map((u) => new URL(u, "${location.origin}").href));
        postMessage({ hasDocument: typeof document !== "undefined", categories: res.results.map((r) => r.ok ? r.category : r.error.code) });
      };`;
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })), { type: "module" });
    const inWorker = await new Promise<{ hasDocument: boolean; categories: string[] }>((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(urls);
    });
    worker.terminate();
    const onPage = (await (await window.api.createSorter()).sort(urls)).results.map((r) => (r.ok ? r.category : r.error.code));
    return { inWorker, onPage };
  }, urls);
  expect(inWorker.hasDocument).toBe(false);
  expect(inWorker.categories).toEqual(onPage);
});

test("results are plain JSON", async ({ page }) => {
  const roundTrips = await page.evaluate(async (url) => {
    const res = await (await window.api.createSorter()).sort([url]);
    return JSON.stringify(JSON.parse(JSON.stringify(res))) === JSON.stringify(res);
  }, SAMPLE.url);
  expect(roundTrips).toBe(true);
});
