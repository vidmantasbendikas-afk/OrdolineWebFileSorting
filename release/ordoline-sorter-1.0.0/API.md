# Ordoline Sorter 1.0.0 — API

## Quick start

```js
import { createSorter } from "./ordoline-sorter.js";

const sorter = await createSorter({ modelUrl: "https://…/best.onnx", worker: true });   // loads runtime + model once
const r = await sorter.classify(file);                      // one image
const { results, byCategory } = await sorter.sort(files);   // many images
```

## Input

`classify()` and `sort()` accept images as:

- `File` or `Blob` (e.g. from `<input type="file">`), `ArrayBuffer`, `Uint8Array` (JPEG, PNG, WebP…)
- an image URL (`https:`, `data:`, `blob:`)
- `ImageData`, `ImageBitmap`, `OffscreenCanvas`
- `HTMLImageElement`, `HTMLCanvasElement`

Wrap an image as `{ image, id }` to attach your own id. EXIF orientation is applied.

## Result of `classify()`

It **never rejects** for a bad image; check `ok`.

```json
{
  "id": "img-1",
  "name": "IMG_2234.jpg",
  "ok": true,
  "category": "intraoral_left",
  "label": "Intraoral left",
  "confidence": 0.868,
  "lowConfidence": false,
  "top": [
    { "category": "intraoral_left", "label": "Intraoral left", "confidence": 0.868 },
    { "category": "intraoral_frontal", "label": "Intraoral frontal", "confidence": 0.041 },
    { "category": "intraoral_right", "label": "Intraoral right", "confidence": 0.022 }
  ],
  "scores": { "extraoral_frontal_rest": 0.004, "...": "every category, sums to 1" },
  "image": { "width": 4032, "height": 3024 },
  "timingMs": 412
}
```

```json
{ "id": "img-2", "name": "notes.txt", "ok": false, "error": { "code": "DECODE_FAILED", "message": "Image could not be decoded" } }
```

`lowConfidence` is `true` when `confidence` is below 0.6: flag those photos for a human check.

## Result of `sort()`

```json
{
  "results": [ { "index": 0, "id": "0", "...": "one result per input, in input order" } ],
  "byCategory": { "intraoral_left": ["0", "7"], "intraoral_right": [], "...": "every category, ids by confidence" },
  "summary": { "total": 12, "sorted": 11, "failed": 1, "skipped": 0, "lowConfidence": 2, "aborted": false, "timingMs": 5120 }
}
```

## Categories

| id | label |
|---|---|
| `extraoral_frontal_rest` | Extraoral frontal (rest) |
| `extraoral_frontal_smile` | Extraoral frontal (smile) |
| `extraoral_profile_rest` | Extraoral profile (rest) |
| `extraoral_profile_smile` | Extraoral profile (smile) |
| `intraoral_frontal` | Intraoral frontal |
| `intraoral_left` | Intraoral left |
| `intraoral_right` | Intraoral right |
| `intraoral_upper` | Intraoral upper |
| `intraoral_lower` | Intraoral lower |
| `cephalometric_frontal` | Cephalometric (frontal) |
| `cephalometric_lateral` | Cephalometric (lateral) |

## Error codes

| code | when |
|---|---|
| `UNSUPPORTED_INPUT` | The input is not an accepted image type |
| `FETCH_FAILED` | An image URL could not be loaded |
| `DECODE_FAILED` | Not a readable image |
| `INFERENCE_FAILED` | Classification failed |
| `ABORTED` | `classify()` was stopped with `signal` |
| `DISPOSED` | `dispose()` was called |
| `MODEL_LOAD_FAILED`, `RUNTIME_LOAD_FAILED` | `createSorter()` rejects: the model or the ONNX runtime could not be loaded |
| `INVALID_OPTIONS` | `createSorter()` was given an invalid option |

## Options

```js
const sorter = await createSorter({
  modelUrl: "https://…/best.onnx",        // model URL received from Ordoline (not needed if built in)
  modelSha256: "…",                       // its SHA-256, received with the URL
  worker: true,                           // recommended: the page stays responsive while sorting
  onProgress: ({ fraction }) => {},       // model loading progress, 0–1
  lowConfidenceThreshold: 0.6,
  topK: 3,                                // entries in `top`
});

const result = await sorter.sort(files, {
  onResult: (r, { done, total }) => {},   // after each photo
  signal: abortController.signal,         // to stop, see below
});
```

## Stopping

```js
const stopper = new AbortController();
const result = await sorter.sort(files, { signal: stopper.signal });   // stopButton.onclick = () => stopper.abort()
```

When stopped, `sort()` resolves at once with the photos done so far: `summary.aborted` is `true` and
`summary.skipped` counts the photos not processed. `sorter.dispose()` releases the sorter for good.

## Speed

About 0.6 s per photo on our test machine; older computers are slower. The first visit downloads the ONNX runtime (about 11 MB) and the
model (about 34 MB); later visits load both from the browser cache.
