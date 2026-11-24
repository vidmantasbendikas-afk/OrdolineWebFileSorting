// Copyright (c) 2026 UAB Agmis. All rights reserved.
/**
 * Peak memory of the sorter in Chromium. Not a pass/fail test: prints a report (results are in docs/API.md,
 * *Performance → Memory*). Samples the memory (PSS, from /proc, so Linux only) of every Chrome process every 25 ms
 * while the sorter loads the model and sorts small, 2080×1560 and 6000×4000 photos, for main thread / worker and
 * 1 / 4 threads; once for the sorter in src/ (dist/sorter) and once for the memory-saving variant in
 * tests/memory/sorter-strips (built to dist/sorter-strips by build-variant.ts). Results: tests/memory/README.md.
 *
 *   docker compose up -d
 *   docker compose run --rm tests npm run measure:memory
 *
 * The "renderer" figures are the page's process (page + its workers); the rest of the browser is listed separately.
 */
import { readFileSync, readdirSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { buildVariant, VARIANT_DIR } from "./build-variant.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8000";
const SAMPLE_MS = 25;
/** Photos sorted per size: the test-set photos (640 px, one per folder) and larger JPEGs made by upscaling one. */
const SIZES: Record<string, [number, number] | null> = { "640px": null, "2080x1560": [2080, 1560], "6000x4000": [6000, 4000] };
const SORTERS = [
  { name: "src/", dir: "dist/sorter" },
  { name: "sorter-strips", dir: VARIANT_DIR },
];
const CONFIGS = [
  { threads: 1, worker: false },
  { threads: 4, worker: false },
  { threads: 1, worker: true },
  { threads: 4, worker: true },
  { threads: 4, worker: true, cached: true }, // model from the Cache API copy instead of the network
];

const MB = (bytes: number) => Math.round(bytes / 1048576);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PSS of one process, or null when it has exited. */
function pssOf(pid: string): number | null {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)/m);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return null;
  }
}

/** Chrome processes by type (browser, renderer, gpu-process, utility:NetworkService, ...). */
function chromeProcesses(): Array<{ pid: string; type: string }> {
  const out: Array<{ pid: string; type: string }> = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (!/chrom|headless_shell/.test(cmd.split("\0")[0])) continue;
    const type = cmd.match(/--type=([a-z-]+)/)?.[1] ?? "browser";
    const sub = cmd.match(/--utility-sub-type=([\w.]+)/)?.[1].split(".").pop();
    out.push({ pid, type: type === "utility" && sub ? `utility:${sub}` : type });
  }
  return out;
}

interface Sample { total: number; renderer: number; byType: Record<string, number> }

function sample(): Sample {
  const s: Sample = { total: 0, renderer: 0, byType: {} };
  for (const { pid, type } of chromeProcesses()) {
    const pss = pssOf(pid);
    if (pss == null) continue;
    s.total += pss;
    s.byType[type] = (s.byType[type] ?? 0) + pss;
    if (type === "renderer") s.renderer += pss;
  }
  return s;
}

/** Peak renderer memory since the last reset, sampled in the background. */
let peak = sample().renderer;
const sampler = setInterval(() => { peak = Math.max(peak, sample().renderer); }, SAMPLE_MS);
const resetPeak = () => { peak = sample().renderer; };

/** Memory after garbage collection and a short pause. */
async function settled(page: Page, waitMs = 1500): Promise<number> {
  await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.());
  await sleep(waitMs);
  return sample().renderer;
}

async function measure(config: (typeof CONFIGS)[number], sorterDir: string) {
  const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
  const context = await browser.newContext({ baseURL: BASE_URL });
  const row: Record<string, number> = {};
  let page = await context.newPage();
  const open = async () => {
    await page.goto("/tests/harness.html");
    await page.waitForFunction(() => window.apiReady);
    // the sorter under test, and the same model URL for both (shares the Cache API copy)
    await page.evaluate(async (dir) => {
      window.api = await import(`/${dir}/ordoline-sorter.js`);
      (window as unknown as { modelUrl: string }).modelUrl = new URL("/dist/sorter/model/best.onnx", location.href).href;
    }, sorterDir);
  };
  await open();
  if (config.cached) { // the first load fills the Cache API, then a fresh page loads from it
    await page.evaluate(async () => (await window.api.createSorter({ modelUrl: (window as unknown as { modelUrl: string }).modelUrl })).dispose());
    await page.close();
    page = await context.newPage();
    await open();
  }

  // photos are prepared before the baseline, so they are not counted as the sorter's memory
  await page.evaluate(async (sizes) => {
    const manifest: Record<string, string[]> = await (await fetch("/js/testfiles.json")).json();
    const urls = Object.entries(manifest).map(([dir, files]) => `/data/test/${dir}/${encodeURIComponent(files[0])}`);
    const small = await Promise.all(urls.map(async (u) => (await fetch(u)).blob()));
    const src = await createImageBitmap(small[0]);
    const upscaled = async ([w, h]: [number, number]) => {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")!.drawImage(src, 0, 0, w, h);
      return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    };
    const photos: Record<string, Blob[]> = {};
    for (const [name, size] of Object.entries(sizes)) {
      photos[name] = size ? [await upscaled(size), await upscaled(size), await upscaled(size)] : small;
    }
    (window as unknown as { photos: typeof photos }).photos = photos;
  }, SIZES);
  row.baseline = await settled(page);

  resetPeak();
  const backend = await page.evaluate(async ({ threads, worker }) => {
    const sorter = await window.api.createSorter({ numThreads: threads, worker, modelUrl: (window as unknown as { modelUrl: string }).modelUrl });
    (window as unknown as { sorter: typeof sorter }).sorter = sorter;
    return `${sorter.model.backend}, ${sorter.model.threads} thr, model from ${sorter.model.source}`;
  }, config);
  row["load (peak)"] = peak;
  row.loaded = await settled(page);

  const sorted: number[] = [];
  for (const name of Object.keys(SIZES)) {
    resetPeak();
    sorted.push(await page.evaluate(async (name) => {
      const w = window as unknown as { sorter: import("../../src/sorter/types.ts").Sorter; photos: Record<string, Blob[]> };
      return (await w.sorter.sort(w.photos[name].map((image) => ({ image })))).summary.sorted;
    }, name));
    row[`sort ${name} (peak)`] = peak;
  }
  row["after sort"] = await settled(page);

  await page.evaluate(() => (window as unknown as { sorter: { dispose(): void } }).sorter.dispose());
  row["dispose +1.5 s"] = await settled(page);
  row["dispose +6 s"] = await settled(page, 4500); // a worker is terminated 1 s after dispose(), then freed
  const others = Object.entries(sample().byType).filter(([type]) => type !== "renderer");
  await browser.close();
  return { row, backend, sorted, others };
}

const label = (c: (typeof CONFIGS)[number]) =>
  `${c.worker ? "worker" : "main thread"}, ${c.threads} thread${c.threads > 1 ? "s" : ""}${c.cached ? ", cached model" : ""}`;

try {
  buildVariant();
  console.log(`Renderer process memory (PSS, MB), ${BASE_URL}\n`);
  for (const config of CONFIGS) {
    console.log(`## ${label(config)}`);
    for (const sorter of SORTERS) {
      const { row, backend, sorted, others } = await measure(config, sorter.dir);
      console.log(`  ${sorter.name.padEnd(14)} ` + Object.entries(row).map(([k, v]) => `${k}: ${MB(v)}`).join(" | "));
      console.log(`  ${"".padEnd(14)} [${backend}; sorted ${sorted.join("/")}; other browser processes: ` +
        others.map(([k, v]) => `${k} ${MB(v)}`).join(", ") + "]");
    }
    console.log();
  }
} finally {
  clearInterval(sampler);
}
