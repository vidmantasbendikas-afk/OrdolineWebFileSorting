// Copyright (c) 2026 UAB Agmis. All rights reserved.
/** Letterbox resize (Pillow's antialiased BILINEAR, bit-exact) and ImageNet normalization, matching training. */
import { OrdolineError } from "./errors.js";
import type { RawImage } from "./types.js";

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

// PIL Image.resize(BILINEAR), ported from Pillow's Resample.c: a triangle filter, widened when downscaling
// (antialias). Weights are computed in double precision, then rounded to fixed point (PRECISION_BITS = 22) exactly
// like Pillow's 8-bit path, so the output matches training bit for bit (checked in tests/unit/preprocess.test.ts).
const PRECISION_BITS = 32 - 8 - 2;
const ONE = 2 ** PRECISION_BITS;
const HALF = 2 ** (PRECISION_BITS - 1);

export function resampleCoeffs(inSize: number, outSize: number) {
  const scale = inSize / outSize;
  const fscale = Math.max(scale, 1);
  const invFscale = 1 / fscale;
  const support = fscale; // bilinear support = 1
  const bounds = new Int32Array(outSize * 2);
  const ksize = Math.ceil(support) * 2 + 1;
  const weights = new Float64Array(outSize * ksize);
  const fixed = new Int32Array(outSize * ksize);
  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5));
    let total = 0;
    for (let j = 0; j < xmax - xmin; j++) {
      const w = Math.max(0, 1 - Math.abs((j + xmin - center + 0.5) * invFscale));
      weights[x * ksize + j] = w;
      total += w;
    }
    for (let j = 0; j < xmax - xmin; j++) {
      const k = x * ksize + j;
      if (total) weights[k] /= total;
      fixed[k] = Math.trunc(weights[k] < 0 ? weights[k] * ONE - 0.5 : weights[k] * ONE + 0.5);
    }
    bounds[2 * x] = xmin;
    bounds[2 * x + 1] = xmax - xmin;
  }
  return { bounds, weights, fixed, ksize };
}

/** Pillow's clip8: fixed-point accumulator (started at HALF, so this rounds) -> 0..255. */
const clipFixed = (ss: number) => {
  const v = Math.floor(ss / ONE);
  return v <= 0 ? 0 : v >= 255 ? 255 : v;
};

type Coeffs = ReturnType<typeof resampleCoeffs>;

/** Horizontal pass: w x h (RGB or RGBA) -> outW x h RGB. */
function resizeHorizontal(src: ArrayLike<number>, w: number, h: number, ch: number, outW: number, c: Coeffs): Uint8Array {
  const dst = new Uint8Array(outW * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < outW; x++) {
      const start = c.bounds[2 * x], n = c.bounds[2 * x + 1], k = x * c.ksize;
      let r = HALF, g = HALF, b = HALF;
      for (let j = 0; j < n; j++) {
        const wt = c.fixed[k + j], p = (row + start + j) * ch;
        r += src[p] * wt; g += src[p + 1] * wt; b += src[p + 2] * wt;
      }
      const o = (y * outW + x) * 3;
      dst[o] = clipFixed(r); dst[o + 1] = clipFixed(g); dst[o + 2] = clipFixed(b);
    }
  }
  return dst;
}

/** Vertical pass: w x h (RGB or RGBA) -> w x outH RGB. */
function resizeVertical(src: ArrayLike<number>, w: number, ch: number, outH: number, c: Coeffs): Uint8Array {
  const dst = new Uint8Array(w * outH * 3);
  for (let y = 0; y < outH; y++) {
    const start = c.bounds[2 * y], n = c.bounds[2 * y + 1], k = y * c.ksize;
    for (let x = 0; x < w; x++) {
      let r = HALF, g = HALF, b = HALF;
      for (let j = 0; j < n; j++) {
        const wt = c.fixed[k + j], p = ((start + j) * w + x) * ch;
        r += src[p] * wt; g += src[p + 1] * wt; b += src[p + 2] * wt;
      }
      const o = (y * w + x) * 3;
      dst[o] = clipFixed(r); dst[o + 1] = clipFixed(g); dst[o + 2] = clipFixed(b);
    }
  }
  return dst;
}

/** Image.resize((outW, outH), BILINEAR) -> RGB, with Pillow's pass order and skipped no-op passes. */
export function resizeBilinear(src: ArrayLike<number>, w: number, h: number, ch: number, outW: number, outH: number): Uint8Array {
  // Pillow runs the vertical pass first when the height shrinks more than twice as much as the width
  const horizontalFirst = !(h - outH > 0 && h - outH > (w - outW) * 2);
  const needH = outW !== w, needV = outH !== h;
  let img: ArrayLike<number> = src, curW = w, curCh = ch;
  const doH = () => { if (needH) { img = resizeHorizontal(img, curW, needV && !horizontalFirst ? outH : h, curCh, outW, resampleCoeffs(w, outW)); curW = outW; curCh = 3; } };
  const doV = () => { if (needV) { img = resizeVertical(img, curW, curCh, outH, resampleCoeffs(h, outH)); curCh = 3; } };
  if (horizontalFirst) { doH(); doV(); } else { doV(); doH(); }
  if (curCh === 3) return img as Uint8Array;
  // neither pass needed: drop alpha
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = src[i * ch]; rgb[i * 3 + 1] = src[i * ch + 1]; rgb[i * 3 + 2] = src[i * ch + 2]; }
  return rgb;
}

/** RawImage -> letterboxed, normalized Float32 CHW tensor data of size x size. */
export function preprocess(raw: RawImage, size: number): Float32Array {
  const { width: w, height: h, data } = raw;
  const ch = raw.channels ?? data.length / (w * h);
  if (!(ch === 3 || ch === 4) || data.length < w * h * ch) {
    throw new OrdolineError("DECODE_FAILED", `Pixel data must be RGB or RGBA (${w}x${h}, ${data.length} values)`);
  }
  const scale = size / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const rgb = resizeBilinear(data, w, h, ch, nw, nh);

  // paste centred on the black canvas, then normalize; padding is black (0) before normalization
  const left = Math.floor((size - nw) / 2), top = Math.floor((size - nh) / 2);
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) out.fill(-MEAN[c] / STD[c], c * plane, (c + 1) * plane);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 3, o = (top + y) * size + left + x;
      out[o] = (rgb[i] / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (rgb[i + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (rgb[i + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}
