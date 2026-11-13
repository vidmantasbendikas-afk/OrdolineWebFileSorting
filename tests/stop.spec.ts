import { test, expect } from "@playwright/test";
import { openHarness, SAMPLE, testImages } from "./helpers.ts";

for (const worker of [false, true]) {
  test.describe(worker ? "worker" : "in-thread", () => {
    test.beforeEach(async ({ page }) => openHarness(page));

    test("stopped sort resolves with the photos done so far", async ({ page }) => {
      const urls = testImages(1).slice(0, 5).map((i) => i.url);
      const res = await page.evaluate(async ({ urls, worker }) => {
        const s = await window.api.createSorter({ worker });
        const stopper = new AbortController();
        return s.sort(urls, { signal: stopper.signal, onResult: (_r, p) => { if (p.done === 2) stopper.abort(); } });
      }, { urls, worker });

      expect(res.summary).toMatchObject({ total: 5, sorted: 2, failed: 0, skipped: 3, aborted: true });
      expect(res.results.map((r) => r.index)).toEqual([0, 1]);
      expect(Object.values(res.byCategory).flat().sort()).toEqual(["0", "1"]);
    });

    test("an unstopped sort reports aborted: false", async ({ page }) => {
      const summary = await page.evaluate(async ({ url, worker }) =>
        (await (await window.api.createSorter({ worker })).sort([url])).summary, { url: SAMPLE.url, worker });
      expect(summary).toMatchObject({ total: 1, sorted: 1, skipped: 0, aborted: false });
    });

    test("stop returns quickly while a photo is in progress", async ({ page }) => {
      const urls = testImages(1).slice(0, 4).map((i) => i.url);
      const out = await page.evaluate(async ({ urls, worker }) => {
        const s = await window.api.createSorter({ worker });
        await s.classify(urls[0]); // warm up
        const stopper = new AbortController();
        const sorting = s.sort(urls, { signal: stopper.signal });
        await new Promise((r) => setTimeout(r, 50)); // first photo is now being processed
        const t0 = performance.now();
        stopper.abort();
        const res = await sorting;
        return { ms: performance.now() - t0, summary: res.summary };
      }, { urls, worker });
      console.log(`${worker ? "worker" : "in-thread"}: sort settled ${Math.round(out.ms)} ms after stop`);
      // in-thread, the page is blocked during inference, so the stop may land just after photo 1 finished
      expect(out.summary).toMatchObject({ total: 4, aborted: true });
      expect(out.summary.sorted).toBeLessThanOrEqual(worker ? 0 : 1);
      expect(out.summary.sorted + out.summary.skipped).toBe(4);
      // A worker drops the in-flight photo at once; in-thread, the running inference must finish first.
      expect(out.ms).toBeLessThan(worker ? 50 : 1000);
    });

    test("classify with a signal resolves ABORTED", async ({ page }) => {
      const codes = await page.evaluate(async ({ urls, worker }) => {
        const s = await window.api.createSorter({ worker });
        const code = (r: Awaited<ReturnType<typeof s.classify>>) => (r.ok ? "ok" : r.error.code);
        const already = new AbortController();
        already.abort();
        const queued = new AbortController();
        // three at once: the third waits behind the first two, and is cancelled before its turn
        const runs = [s.classify(urls[0]), s.classify(urls[1]), s.classify(urls[2], { signal: queued.signal })];
        queued.abort();
        return {
          preAborted: code(await s.classify(urls[0], { signal: already.signal })),
          parallel: (await Promise.all(runs)).map(code),
          afterwards: code(await s.classify(urls[0])), // the sorter keeps working
        };
      }, { urls: testImages(1).slice(0, 3).map((i) => i.url), worker });
      expect(codes).toEqual({ preAborted: "ABORTED", parallel: ["ok", "ok", "ABORTED"], afterwards: "ok" });
    });
  });
}
