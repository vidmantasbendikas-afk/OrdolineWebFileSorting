// The memory-saving variant (tests/memory/sorter-strips, built to dist/sorter-strips) must give exactly the same
// model input as the sorter in src/ (dist/sorter): it only changes how the decoded pixels are read.
import { test, expect } from "@playwright/test";
import { openHarness, SAMPLE } from "../helpers.ts";
import { buildVariant, VARIANT_DIR } from "./build-variant.ts";

type Decode = typeof import("../../src/sorter/decode.ts");
type Preprocess = typeof import("../../src/sorter/preprocess.ts");
// the variant's additions (typed here: its sources type-check only inside build-variant.ts's merged copy of src/)
type RegionReader = (x: number, y: number, width: number, height: number) => ArrayLike<number>;
interface VariantPreprocess {
  resizeBilinearTiled(read: RegionReader, w: number, h: number, outW: number, outH: number, stripPixels?: number): Uint8Array;
  preprocessTiled(read: RegionReader, w: number, h: number, size: number): Float32Array;
}
interface VariantDecode {
  decodeToTensor(image: Blob, size: number): Promise<{ data: Float32Array; width: number; height: number }>;
}
const ORIGINAL_DIR = "dist/sorter";

test.beforeAll(() => buildVariant());
test.beforeEach(async ({ page }) => openHarness(page));

test("strip resize equals the whole-image resize for every pass order and strip size", async ({ page }) => {
  const failures = await page.evaluate(async ({ originalDir, variantDir }) => {
    const original: Preprocess = await import(`/${originalDir}/preprocess.js`);
    const variant: VariantPreprocess = await import(`/${variantDir}/preprocess.js`);
    const pixel = (x: number, y: number, c: number) => (x * 31 + y * 17 + c * 67 + ((x * y) % 13) * 7) & 255;
    const failed: string[] = [];
    // horizontal first, vertical first (height shrinks > 2x the width), one pass only, no pass, upscaling
    const cases = [[300, 200, 38, 25], [120, 900, 50, 40], [300, 200, 38, 200], [300, 200, 300, 25], [30, 20, 30, 20], [20, 30, 40, 60]];
    for (const [w, h, outW, outH] of cases) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = c === 3 ? (x * 7 + y) & 255 : pixel(x, y, c);
      const read = (x: number, y: number, rw: number, rh: number) => {
        const out = new Uint8ClampedArray(rw * rh * 4);
        for (let r = 0; r < rh; r++) out.set(data.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + rw) * 4), r * rw * 4);
        return out;
      };
      const expected = original.resizeBilinear(data, w, h, 4, outW, outH);
      for (const strip of [1, 997, 5000, 1 << 20]) {
        const actual = variant.resizeBilinearTiled(read, w, h, outW, outH, strip);
        if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) failed.push(`${w}x${h}->${outW}x${outH} strip ${strip}`);
      }
      const tensor = original.preprocess({ data, width: w, height: h, channels: 4 }, 64);
      const tiled = variant.preprocessTiled(read, w, h, 64);
      if (tiled.length !== tensor.length || tiled.some((v, i) => v !== tensor[i])) {
        failed.push(`preprocess ${w}x${h}`);
      }
    }
    return failed;
  }, { originalDir: ORIGINAL_DIR, variantDir: VARIANT_DIR });
  expect(failures).toEqual([]);
});

test("large photos read in strips give the same model input as src/", async ({ page }) => {
  const mismatches = await page.evaluate(async ({ sampleUrl, originalDir, variantDir }) => {
    const { decode }: Decode = await import(`/${originalDir}/decode.js`);
    const { preprocess }: Preprocess = await import(`/${originalDir}/preprocess.js`);
    const { decodeToTensor }: VariantDecode = await import(`/${variantDir}/decode.js`);
    const src = await createImageBitmap(await (await fetch(sampleUrl)).blob());
    const make = async (w: number, h: number, type: string, transparent = false) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d")!;
      if (transparent) ctx.globalAlpha = 0.4;
      ctx.drawImage(src, 0, 0, w, h);
      return c.convertToBlob({ type, quality: 0.9 });
    };
    // row strips (horizontal pass first), column strips (vertical first), a semi-transparent PNG, a small photo
    const blobs: Record<string, Blob> = {
      wide: await make(2600, 1700, "image/jpeg"),
      tall: await make(1200, 4000, "image/jpeg"),
      png: await make(1500, 1000, "image/png", true),
      sample: await (await fetch(sampleUrl)).blob(),
    };
    const out: Record<string, number> = {};
    for (const [name, blob] of Object.entries(blobs)) {
      const expected = preprocess(await decode(blob), 384);
      const { data } = await decodeToTensor(blob, 384);
      let diff = Math.abs(expected.length - data.length);
      for (let i = 0; i < expected.length; i++) if (expected[i] !== data[i]) diff++;
      out[name] = diff;
    }
    return out;
  }, { sampleUrl: SAMPLE.url, originalDir: ORIGINAL_DIR, variantDir: VARIANT_DIR });
  expect(mismatches).toEqual({ wide: 0, tall: 0, png: 0, sample: 0 });
});

test("the variant sorter classifies like src/", async ({ page }) => {
  const [a, b] = await page.evaluate(async ({ sampleUrl, variantDir }) => {
    const modelUrl = new URL("/dist/sorter/model/best.onnx", location.href).href;
    const variant: typeof window.api = await import(`/${variantDir}/ordoline-sorter.js`);
    const results = [];
    for (const api of [window.api, variant]) {
      const sorter = await api.createSorter({ modelUrl });
      const r = await sorter.classify(sampleUrl);
      sorter.dispose();
      results.push(r.ok ? { category: r.category, scores: r.scores } : r.error);
    }
    return results;
  }, { sampleUrl: SAMPLE.url, variantDir: VARIANT_DIR });
  expect(b).toEqual(a);
});
