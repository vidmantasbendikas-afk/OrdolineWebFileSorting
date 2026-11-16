import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { preprocess, resampleCoeffs, resizeBilinear } from "../../src/sorter/preprocess.ts";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// PIL output for synthetic images, made by tools/preprocess_fixture.py (Pillow, same code path as training).
const fixture: { pillow: string; cases: Array<{ width: number; height: number; size: number; rgb: string }> } =
  JSON.parse(readFileSync(new URL("fixtures/preprocess-pil.json", import.meta.url), "utf8"));

/** Same test pattern as tools/preprocess_fixture.py. */
const pixel = (x: number, y: number, c: number) => (x * 31 + y * 17 + c * 67 + ((x * y) % 13) * 7) & 255;

function synthetic(w: number, h: number, channels: 3 | 4) {
  const data = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) data[(y * w + x) * channels + c] = pixel(x, y, c);
    if (channels === 4) data[(y * w + x) * 4 + 3] = (x * 7 + y) & 255; // alpha must be ignored
  }
  return { data, width: w, height: h, channels };
}

/** Normalized CHW tensor -> 8-bit HWC RGB, to compare with PIL. */
function toRgb(out: Float32Array, size: number): Uint8Array {
  const plane = size * size;
  const rgb = new Uint8Array(plane * 3);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
    rgb[i * 3 + c] = Math.round((out[c * plane + i] * STD[c] + MEAN[c]) * 255);
  }
  return rgb;
}

test.describe("letterbox matches PIL (training) exactly", () => {
  for (const { width, height, size, rgb } of fixture.cases) {
    test(`${width}x${height} -> ${size}`, () => {
      const expected = new Uint8Array(Buffer.from(rgb, "base64"));
      const out = preprocess(synthetic(width, height, 3), size);
      expect(out.length).toBe(3 * size * size);
      const actual = toRgb(out, size);
      const diffs = actual.reduce((n, v, i) => n + (v !== expected[i] ? 1 : 0), 0);
      expect(diffs, `pixels differing from Pillow ${fixture.pillow}`).toBe(0);
    });
  }
});

test("RGBA input gives the same tensor as RGB (alpha ignored)", () => {
  expect(preprocess(synthetic(37, 23, 4), 16)).toEqual(preprocess(synthetic(37, 23, 3), 16));
});

test("channels are inferred from the data length when omitted", () => {
  const { data, width, height } = synthetic(20, 10, 4);
  expect(preprocess({ data, width, height }, 16)).toEqual(preprocess(synthetic(20, 10, 4), 16));
});

test("padding is black and the image is centred", () => {
  const out = preprocess({ data: new Uint8Array(40 * 10 * 3).fill(255), width: 40, height: 10, channels: 3 }, 8);
  const plane = 64;
  const black = -MEAN[0] / STD[0];
  const white = (1 - MEAN[0]) / STD[0];
  // 40x10 -> 8x2, placed at rows 3-4 of the 8x8 canvas
  for (let y = 0; y < 8; y++) {
    const row = Array.from(out.subarray(y * 8, y * 8 + 8));
    expect(row.every((v) => Math.abs(v - (y === 3 || y === 4 ? white : black)) < 1e-6), `row ${y}`).toBe(true);
  }
  expect(out.length).toBe(3 * plane);
});

test("output is CHW with ImageNet normalization per channel", () => {
  const out = preprocess({ data: new Uint8Array([255, 0, 128]), width: 1, height: 1, channels: 3 }, 1);
  expect(out[0]).toBeCloseTo((1 - MEAN[0]) / STD[0], 5);
  expect(out[1]).toBeCloseTo((0 - MEAN[1]) / STD[1], 5);
  expect(out[2]).toBeCloseTo((128 / 255 - MEAN[2]) / STD[2], 5);
});

test("bad pixel data is rejected with DECODE_FAILED", () => {
  const bad = [
    { data: new Uint8Array(10), width: 4, height: 4 }, // too short
    { data: new Uint8Array(32), width: 4, height: 4 }, // 2 channels
    { data: new Uint8Array(12), width: 2, height: 2, channels: 4 as const }, // shorter than declared
  ];
  for (const raw of bad) expect(() => preprocess(raw, 8)).toThrow(expect.objectContaining({ code: "DECODE_FAILED" }));
});

test("resample weights are normalized and stay inside the source", () => {
  for (const [inSize, outSize] of [[100, 7], [7, 100], [384, 384], [1, 5], [4032, 384]]) {
    const { bounds, weights, ksize } = resampleCoeffs(inSize, outSize);
    for (let x = 0; x < outSize; x++) {
      const start = bounds[2 * x], n = bounds[2 * x + 1];
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + n).toBeLessThanOrEqual(inSize);
      const sum = Array.from(weights.subarray(x * ksize, x * ksize + n)).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  }
});

test("fixed-point weights sum to 1.0 (2^22), like Pillow", () => {
  for (const [inSize, outSize] of [[100, 7], [7, 100], [4032, 384], [3, 1]]) {
    const { bounds, fixed, ksize } = resampleCoeffs(inSize, outSize);
    for (let x = 0; x < outSize; x++) {
      const sum = Array.from(fixed.subarray(x * ksize, x * ksize + bounds[2 * x + 1])).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 2 ** 22)).toBeLessThanOrEqual(bounds[2 * x + 1]); // rounding: at most 1 per weight
    }
  }
});

test("resizing to the same size returns the pixels unchanged (alpha dropped)", () => {
  const { data } = synthetic(5, 4, 4);
  const rgb = resizeBilinear(data, 5, 4, 4, 5, 4);
  expect(Array.from(rgb)).toEqual(Array.from(synthetic(5, 4, 3).data));
});
