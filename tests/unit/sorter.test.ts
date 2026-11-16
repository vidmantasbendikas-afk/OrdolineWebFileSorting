/** The sorter core with a fake onnxruntime and raw-pixel inputs: scoring, options, errors, stopping, caching. */
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createSorter } from "../../src/sorter/ordoline-sorter.ts";
import { DEFAULTS, ORT_ALL_URL, ORT_WASM_URL, resolveOptions, type ResolvedOptions } from "../../src/sorter/options.ts";
import { abortable, buildSorter } from "../../src/sorter/sorter.ts";
import type { ClassificationResult, ClassificationSuccess, Sorter, SorterInput } from "../../src/sorter/types.ts";
import { MB, fakeOrt, outputFor, rgb, sleep, stubCaches, stubFetch, stubGlobal, trackedResponse, type FakeOrtOptions } from "./fakes.ts";

let restore: Array<() => void> = [];
let sorters: Sorter[] = [];
test.afterEach(() => {
  sorters.forEach((s) => s.dispose());
  restore.forEach((r) => r());
  restore = [];
  sorters = [];
});

let n = 0;
/** A model server for one test: a unique URL serving `size` bytes with an ETag. */
function modelServer(size = MB, etag = '"m1"') {
  const url = `https://cdn.test/${++n}/best.onnx`;
  const f = stubFetch(() => trackedResponse(new Uint8Array(size), { headers: { etag } }).response);
  restore.push(f.restore);
  return { url, requests: f.urls };
}

async function sorterWith(ortOpts: FakeOrtOptions = {}, opts: Partial<ResolvedOptions> = {}, onDispose?: () => void) {
  const { url } = modelServer();
  const { ort, log } = fakeOrt(ortOpts);
  const sorter = await buildSorter({ ...DEFAULTS, modelUrl: url, modelCache: false, ort, ...opts }, undefined, onDispose);
  sorters.push(sorter);
  return { sorter, log, ort };
}

const ok = (r: ClassificationResult): ClassificationSuccess => {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.message}`);
  return r;
};

test.describe("classification results", () => {
  test("a result has category, label, confidence, top-k and per-category scores", async () => {
    const { sorter, log } = await sorterWith({ output: () => outputFor("intr_right", 0.8), inputSize: 16 });
    const r = ok(await sorter.classify({ image: rgb(40, 30), id: "p1", name: "a.jpg" }));
    expect([r.id, r.name, r.category, r.label, r.modelClass]).toEqual(["p1", "a.jpg", "intraoral_right", "Intraoral right", "intr_right"]);
    expect(r.confidence).toBeCloseTo(0.8, 5);
    expect(r.lowConfidence).toBe(false);
    expect(r.top.map((t) => t.category)[0]).toBe("intraoral_right");
    expect(r.top).toHaveLength(3); // DEFAULTS.topK
    expect(Object.keys(r.scores)).toHaveLength(11);
    expect(Object.values(r.scores).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(r.image).toEqual({ width: 40, height: 30 });
    expect(log.inputs).toEqual([[1, 3, 16, 16]]); // the input size is read from the model
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // plain JSON data
  });

  test("model outputs are normalized and classes of the same category are summed", async () => {
    // a model with two classes that map to "intraoral_left": together they beat the single best class
    const classes = ["intr_left", "extra_left_view", "intr_right"];
    const { sorter } = await sorterWith({ classes, output: () => [3, 3, 4] });
    const r = ok(await sorter.classify(rgb(4, 4)));
    expect(r.category).toBe("intraoral_left");
    expect(r.confidence).toBeCloseTo(0.6, 5);
    expect(r.scores.intraoral_right).toBeCloseTo(0.4, 5);
    expect(r.modelClass).toBe("intr_right"); // the single most likely model class
    expect(sorter.model.classes).toEqual(classes);
  });

  test("lowConfidence follows lowConfidenceThreshold; topK is per call", async () => {
    const { sorter } = await sorterWith({ output: () => outputFor("ceph_side", 0.55) }, { lowConfidenceThreshold: 0.5 });
    const r = ok(await sorter.classify(rgb(4, 4), { topK: 1 }));
    expect([r.category, r.lowConfidence, r.top.length]).toEqual(["cephalometric_lateral", false, 1]);
    const { sorter: strict } = await sorterWith({ output: () => outputFor("ceph_side", 0.55) });
    expect(ok(await strict.classify(rgb(4, 4), { topK: 20 }))).toMatchObject({ lowConfidence: true, top: { length: 11 } });
  });

  test("ids are generated when not given", async () => {
    const { sorter } = await sorterWith();
    const [a, b] = await Promise.all([sorter.classify(rgb(4, 4)), sorter.classify(rgb(4, 4))]);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^img-\d+$/);
  });

  test("per-image failures resolve with an error code instead of throwing", async () => {
    const { sorter } = await sorterWith();
    expect(await sorter.classify({ data: new Uint8Array(5), width: 2, height: 2 })).toMatchObject({ ok: false, error: { code: "DECODE_FAILED" } });
    const inferenceFails = (await sorterWith({ runError: new Error("boom") })).sorter;
    expect(await inferenceFails.classify(rgb(4, 4))).toMatchObject({ ok: false, error: { code: "INFERENCE_FAILED" } });
  });
});

test.describe("runtime", () => {
  test("inference calls never overlap (ORT sessions are not re-entrant)", async () => {
    const { sorter, log } = await sorterWith({ runDelayMs: 5 });
    const results = await Promise.all(Array.from({ length: 6 }, () => sorter.classify(rgb(8, 8))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect([log.runs, log.maxActive]).toEqual([6, 1]);
  });

  test("falls back to the next execution provider when one fails", async () => {
    const { sorter, log } = await sorterWith({ failingProviders: ["webnn"] }, { executionProviders: ["webnn", "wasm"] });
    expect(log.created).toEqual([["webnn", "wasm"], ["wasm"]]);
    expect(sorter.model.backend).toBe("wasm");
  });

  test("default backend is WASM only", async () => {
    const { sorter, log } = await sorterWith();
    expect(log.created).toEqual([["wasm"]]);
    expect(sorter.model).toMatchObject({ backend: "wasm", threads: 1, worker: false, source: "network" });
  });

  test("opt-in webgpu is skipped without a GPU adapter, so the reported backend is the real one", async () => {
    const { sorter, log } = await sorterWith({}, { executionProviders: ["webgpu", "wasm"] }); // Node has no navigator.gpu
    expect(log.created).toEqual([["wasm"]]);
    expect(sorter.model.backend).toBe("wasm");
  });

  test("opt-in webgpu is used when a GPU adapter exists", async () => {
    const restoreNav = stubGlobal("navigator", { hardwareConcurrency: 4, gpu: { requestAdapter: async () => ({}) } });
    try {
      const { sorter, log } = await sorterWith({}, { executionProviders: ["webgpu", "wasm"] });
      expect(log.created).toEqual([["webgpu", "wasm"]]);
      expect(sorter.model).toMatchObject({ backend: "webgpu", threads: null });
      const { log: defaultLog } = await sorterWith(); // not without opting in
      expect(defaultLog.created).toEqual([["wasm"]]);
    } finally { restoreNav(); }
  });

  test("threads: 1 without cross-origin isolation, several with it, or as configured", async () => {
    const isolated = stubGlobal("crossOriginIsolated", true);
    const cores = stubGlobal("navigator", { hardwareConcurrency: 8 });
    try {
      expect((await sorterWith()).sorter.model.threads).toBe(4);
    } finally { isolated(); cores(); }
    expect((await sorterWith({}, { numThreads: 2 })).sorter.model.threads).toBe(2);
  });

  test("model load failures reject with MODEL_LOAD_FAILED", async () => {
    const { ort } = fakeOrt();
    const tiny = modelServer(200); // e.g. a Git LFS pointer file instead of the model
    await expect(buildSorter({ ...DEFAULTS, modelUrl: tiny.url, modelCache: false, ort }, undefined))
      .rejects.toMatchObject({ code: "MODEL_LOAD_FAILED", message: expect.stringContaining("LFS") });

    restore.push(stubFetch(() => new Response("", { status: 404, statusText: "Not Found" })).restore);
    await expect(buildSorter({ ...DEFAULTS, modelUrl: "https://cdn.test/missing.onnx", modelCache: false, ort }, undefined))
      .rejects.toMatchObject({ code: "MODEL_LOAD_FAILED" });

    const broken = fakeOrt({ failingProviders: ["wasm"] });
    await expect(buildSorter({ ...DEFAULTS, modelUrl: modelServer().url, modelCache: false, ort: broken.ort }, undefined))
      .rejects.toMatchObject({ code: "MODEL_LOAD_FAILED" });
  });

  test("modelSha256: a matching model loads and reports its hash; another model is refused", async () => {
    const zeros = createHash("sha256").update(new Uint8Array(MB)).digest("hex"); // what modelServer() serves
    expect((await sorterWith({}, { modelSha256: zeros })).sorter.model.sha256).toBe(zeros);
    expect((await sorterWith()).sorter.model.sha256).toBeNull();
    const { ort } = fakeOrt();
    await expect(buildSorter({ ...DEFAULTS, modelUrl: modelServer().url, modelCache: false, ort, modelSha256: "0".repeat(64) }, undefined))
      .rejects.toMatchObject({ code: "MODEL_LOAD_FAILED", message: expect.stringContaining("integrity") });
  });

  test("the model is cached only after a session was created from it", async () => {
    const caches = stubCaches();
    restore.push(caches.restore);
    const broken = fakeOrt({ failingProviders: ["wasm"] });
    const { url } = modelServer();
    await expect(buildSorter({ ...DEFAULTS, modelUrl: url, ort: broken.ort }, undefined)).rejects.toMatchObject({ code: "MODEL_LOAD_FAILED" });
    expect(caches.stores.get(DEFAULTS.modelCache as string)!.entries.size).toBe(0);

    const working = fakeOrt();
    const s = await buildSorter({ ...DEFAULTS, modelUrl: url, ort: working.ort }, undefined);
    sorters.push(s);
    expect(caches.stores.get(DEFAULTS.modelCache as string)!.entries.has(url)).toBe(true);
    const again = await buildSorter({ ...DEFAULTS, modelUrl: url, ort: working.ort }, undefined);
    sorters.push(again);
    expect(again.model.source).toBe("cache");
  });

  test("dispose: later calls fail with DISPOSED, the session is released, onDispose runs once", async () => {
    let disposed = 0;
    const { sorter, log } = await sorterWith({}, {}, () => disposed++);
    sorter.dispose();
    sorter.dispose();
    expect(await sorter.classify(rgb(4, 4))).toMatchObject({ ok: false, error: { code: "DISPOSED" } });
    await sleep(0);
    expect([disposed, log.released]).toEqual([1, 1]);
  });
});

test.describe("sort and stopping", () => {
  const photos = (count: number): SorterInput[] => Array.from({ length: count }, (_, i) => ({ image: rgb(4, 4), name: `p${i}.jpg` }));

  test("sort returns results in input order, byCategory by confidence, and a summary", async () => {
    const confs = [0.7, 0.95, 0.4];
    let i = 0;
    const { sorter } = await sorterWith({ output: () => outputFor("intr_upper", confs[i++]) });
    const inputs = [...photos(3), { image: { data: new Uint8Array(1), width: 1, height: 1 }, name: "bad" }];
    const seen: Array<[number, number]> = [];
    const r = await sorter.sort(inputs, { onResult: (_, p) => seen.push([p.done, p.total]) });
    expect(r.results.map((x) => [x.index, x.id, x.name])).toEqual([[0, "0", "p0.jpg"], [1, "1", "p1.jpg"], [2, "2", "p2.jpg"], [3, "3", "bad"]]);
    expect(r.byCategory.intraoral_upper).toEqual(["1", "0", "2"]);
    expect(r.summary).toMatchObject({ total: 4, sorted: 3, failed: 1, skipped: 0, lowConfidence: 1, aborted: false });
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(r.apiVersion).toBe("1.0");
  });

  test("sort accepts any iterable or array-like, including an empty one", async () => {
    const { sorter } = await sorterWith();
    expect((await sorter.sort(new Set(photos(2)))).summary.sorted).toBe(2);
    expect((await sorter.sort({ length: 1, 0: rgb(4, 4) })).summary.sorted).toBe(1);
    expect((await sorter.sort([])).summary).toMatchObject({ total: 0, sorted: 0, aborted: false });
  });

  test("stopping a sort resolves with the photos done so far", async () => {
    const { sorter, log } = await sorterWith();
    const stop = new AbortController();
    const r = await sorter.sort(photos(5), { signal: stop.signal, onResult: (_, { done }) => { if (done === 2) stop.abort(); } });
    expect(r.summary).toMatchObject({ total: 5, sorted: 2, skipped: 3, aborted: true });
    expect(r.results).toHaveLength(2);
    expect(log.runs).toBe(2);
  });

  test("a photo in progress when the sort is stopped is not counted", async () => {
    const { sorter } = await sorterWith({ runDelayMs: 30 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10);
    const r = await sorter.sort(photos(3), { signal: stop.signal });
    expect(r.summary).toMatchObject({ sorted: 0, skipped: 3, aborted: true });
  });

  test("an already stopped signal does nothing", async () => {
    const { sorter, log } = await sorterWith();
    const r = await sorter.sort(photos(3), { signal: AbortSignal.abort() });
    expect(r.summary).toMatchObject({ sorted: 0, skipped: 3, aborted: true });
    expect(await sorter.classify(rgb(4, 4), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "ABORTED" } });
    expect(log.runs).toBe(0);
  });

  test("classify cancelled while queued behind other photos skips its inference", async () => {
    const { sorter, log } = await sorterWith({ runDelayMs: 20 });
    const stop = new AbortController();
    const first = sorter.classify(rgb(4, 4));
    const second = sorter.classify(rgb(4, 4), { signal: stop.signal });
    stop.abort();
    expect(await second).toMatchObject({ ok: false, error: { code: "ABORTED" } }); // settles immediately
    expect((await first).ok).toBe(true);
    await sleep(30);
    expect(log.runs).toBe(1);
  });

  test("abortable: the result wins unless the signal fires first", async () => {
    const aborted = () => ({ id: "x", name: null, ok: false as const, error: { code: "ABORTED" as const, message: "Cancelled" } });
    const success = { id: "x", name: null, ok: false as const, error: { code: "DECODE_FAILED" as const, message: "" } };
    expect(await abortable(Promise.resolve(success), undefined, aborted)).toBe(success);
    expect(await abortable(Promise.resolve(success), new AbortController().signal, aborted)).toBe(success);
    const c = new AbortController();
    const p = abortable(sleep(50).then(() => success), c.signal, aborted);
    c.abort();
    expect((await p).ok === false && (await p as { error: { code: string } }).error.code).toBe("ABORTED");
  });
});

test.describe("options", () => {
  test("defaults: CPU-only runtime and backend", () => {
    expect(resolveOptions({})).toMatchObject({ ortUrl: ORT_WASM_URL, executionProviders: ["wasm"], worker: false, topK: 3 });
    expect(ORT_WASM_URL).toMatch(/onnxruntime-web@[\d.]+\/dist\/ort\.wasm\.min\.mjs$/);
  });

  test("asking for WebGPU switches to the full runtime, unless ortUrl is given", () => {
    expect(resolveOptions({ executionProviders: ["webgpu", "wasm"] }).ortUrl).toBe(ORT_ALL_URL);
    expect(resolveOptions({ executionProviders: ["webgpu", "wasm"], ortUrl: "/my/ort.mjs" }).ortUrl).toBe("/my/ort.mjs");
    expect(resolveOptions({ executionProviders: ["wasm"] }).ortUrl).toBe(ORT_WASM_URL);
  });

  test("modelSha256 is normalized; the baked-in hash applies only to the baked-in URL", async () => {
    const h = "AB".repeat(32);
    expect(resolveOptions({ modelSha256: h }).modelSha256).toBe(h.toLowerCase());
    expect(resolveOptions({ modelUrl: "https://other.test/m.onnx" }).modelSha256).toBeNull();
    expect(resolveOptions({ modelUrl: "https://other.test/m.onnx", modelSha256: h }).modelSha256).toBe(h.toLowerCase());
    expect(resolveOptions({ modelUrl: DEFAULTS.modelUrl }).modelSha256).toBe(DEFAULTS.modelSha256);
    await expect(createSorter({ modelSha256: "abc" })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  test("null, empty or undefined options mean the default", () => {
    for (const executionProviders of [null, [], undefined]) {
      expect(resolveOptions({ executionProviders }).executionProviders).toEqual(["wasm"]);
    }
    expect(resolveOptions({ topK: undefined, modelUrl: undefined })).toEqual(resolveOptions({}));
  });
});

test.describe("createSorter", () => {
  test("worker mode cannot take an ort module", async () => {
    await expect(createSorter({ worker: true, ort: {} })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  test("same options share one instance until it is disposed; failures can be retried", async () => {
    const { ort } = fakeOrt();
    restore.push(stubGlobal("ort", ort)); // like a page that loaded onnxruntime with a <script> tag
    const server = modelServer();
    const opts = { modelUrl: server.url, modelCache: false as const };
    const a = createSorter(opts);
    expect(createSorter({ ...opts })).toBe(a);
    const s = await a;
    s.dispose();
    const b = await createSorter(opts);
    sorters.push(b);
    expect(b).not.toBe(s);

    const failing = `https://cdn.test/fail-${++n}.onnx`;
    restore.push(stubFetch(() => new Response("", { status: 500 })).restore);
    await expect(createSorter({ ...opts, modelUrl: failing })).rejects.toMatchObject({ code: "MODEL_LOAD_FAILED" });
    restore.push(stubFetch(() => trackedResponse(new Uint8Array(MB)).response).restore);
    sorters.push(await createSorter({ ...opts, modelUrl: failing })); // not stuck on the failed attempt
  });

  test("passing ort always creates a new instance", async () => {
    const { ort } = fakeOrt();
    const server = modelServer();
    const opts = { modelUrl: server.url, modelCache: false as const, ort };
    const [a, b] = await Promise.all([createSorter(opts), createSorter(opts)]);
    sorters.push(a, b);
    expect(a).not.toBe(b);
  });

  test("a runtime that cannot be loaded rejects with RUNTIME_LOAD_FAILED", async () => {
    await expect(createSorter({ ortUrl: "data:text/javascript,throw new Error('no runtime')", modelUrl: modelServer().url }))
      .rejects.toMatchObject({ code: "RUNTIME_LOAD_FAILED" });
  });
});
