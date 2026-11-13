/** Letterbox resize (PIL-style antialiased bilinear) and ImageNet normalization, matching training. */
import { OrdolineError } from "./errors.js";
import type { RawImage } from "./types.js";

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

// PIL Image.resize(BILINEAR) coefficients: triangle filter, widened when downscaling (antialias).
export function resampleCoeffs(inSize: number, outSize: number) {
  const scale = inSize / outSize;
  const fscale = Math.max(scale, 1);
  const support = fscale; // bilinear support = 1
  const bounds = new Int32Array(outSize * 2);
  const ksize = Math.ceil(support) * 2 + 1;
  const weights = new Float32Array(outSize * ksize);
  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale;
    const xmin = Math.max(0, Math.floor(center - support + 0.5));
    const xmax = Math.min(inSize, Math.floor(center + support + 0.5));
    let total = 0;
    for (let j = 0; j < xmax - xmin; j++) {
      const w = Math.max(0, 1 - Math.abs((j + xmin - center + 0.5) / fscale));
      weights[x * ksize + j] = w;
      total += w;
    }
    if (total) for (let j = 0; j < xmax - xmin; j++) weights[x * ksize + j] /= total;
    bounds[2 * x] = xmin;
    bounds[2 * x + 1] = xmax - xmin;
  }
  return { bounds, weights, ksize };
}

export const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

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

  // horizontal pass: w x h -> nw x h (RGB, rounded to 8 bit like PIL)
  const hc = resampleCoeffs(w, nw);
  const tmp = new Uint8Array(nw * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < nw; x++) {
      const start = hc.bounds[2 * x], n = hc.bounds[2 * x + 1], k = x * hc.ksize;
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++) {
        const wt = hc.weights[k + j], p = (row + start + j) * ch;
        r += data[p] * wt; g += data[p + 1] * wt; b += data[p + 2] * wt;
      }
      const o = (y * nw + x) * 3;
      tmp[o] = clamp8(r); tmp[o + 1] = clamp8(g); tmp[o + 2] = clamp8(b);
    }
  }

  // vertical pass into the letterbox canvas, then normalize; padding is black (0) before normalization
  const vc = resampleCoeffs(h, nh);
  const left = Math.floor((size - nw) / 2), top = Math.floor((size - nh) / 2);
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) out.fill(-MEAN[c] / STD[c], c * plane, (c + 1) * plane);
  for (let y = 0; y < nh; y++) {
    const start = vc.bounds[2 * y], n = vc.bounds[2 * y + 1], k = y * vc.ksize;
    const orow = (top + y) * size + left;
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++) {
        const wt = vc.weights[k + j], p = ((start + j) * nw + x) * 3;
        r += tmp[p] * wt; g += tmp[p + 1] * wt; b += tmp[p + 2] * wt;
      }
      const o = orow + x;
      out[o] = (clamp8(r) / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (clamp8(g) / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (clamp8(b) / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}
