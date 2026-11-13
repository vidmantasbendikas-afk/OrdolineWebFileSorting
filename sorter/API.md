# Ordoline Sorter — API v1.0

Classifies dental photos into 11 categories, fully on the client. The core (`ordoline-sorter.js`) has no DOM
dependency and runs on a browser main thread, in Web Workers, and in Node.js / Deno / Bun.
Exact types: [`ordoline-sorter.d.ts`](ordoline-sorter.d.ts).

| File | Purpose |
|---|---|
| `ordoline-sorter.js` | Core API (required) |
| `ordoline-sorter-element.js` | Optional `<ordoline-sorter>` drop-zone UI (browser only) |
| model `best.onnx` (34 MB) | Loaded from `modelUrl` |
| onnxruntime-web 1.22.0 | Loaded from jsDelivr unless you inject `ort` |

## Quick start

```js
import { createSorter } from "./ordoline-sorter.js";

const sorter = await createSorter();          // loads runtime + model once
const r = await sorter.classify(file);        // one image
const { results, byCategory } = await sorter.sort(files);  // many images
```

## Input

Every method accepts an `ImageInput`, optionally wrapped as `{ image, id?, name? }` to attach your own id.

| Input | Main thread | Worker | Node |
|---|---|---|---|
| `{ data, width, height, channels? }` (raw RGB/RGBA pixels), `ImageData` | ✓ | ✓ | ✓ |
| `File`, `Blob`, `ArrayBuffer`, `Uint8Array` (encoded JPEG/PNG/WebP…) | ✓ | ✓ | with `decode` option |
| URL string (`https:`, `data:`, `blob:`; `file:` in Node) | ✓ | ✓ | with `decode` option |
| `ImageBitmap`, `HTMLImageElement`, canvas, `VideoFrame` | ✓ | ✓ (no `<img>`) | – |

Encoded images have their EXIF orientation applied.

## Output

`classify()` resolves to one result. It **never rejects** for a bad image; check `ok` instead.
All output is plain JSON-serializable data.

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
  "modelClass": "intr_left",
  "image": { "width": 4032, "height": 3024 },
  "timingMs": 412
}
```

Failure:

```json
{ "id": "img-2", "name": "notes.txt", "ok": false, "error": { "code": "DECODE_FAILED", "message": "Image could not be decoded" } }
```

`sort()` resolves to:

```json
{
  "apiVersion": "1.0",
  "model": { "url": "…/best.onnx", "backend": "webgpu", "inputSize": 384, "classes": ["ceph_front", "…"] },
  "results": [ { "index": 0, "id": "0", "...": "one result per input, in input order" } ],
  "byCategory": { "intraoral_left": ["0", "7"], "intraoral_right": [], "...": "every category, ids by confidence" },
  "summary": { "total": 12, "sorted": 11, "failed": 1, "lowConfidence": 2, "timingMs": 5120 }
}
```

`lowConfidence` is `true` when `confidence < lowConfidenceThreshold` (default 0.6). Use it to flag photos for
human review.

### Categories

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

### Error codes

| code | when |
|---|---|
| `UNSUPPORTED_INPUT` | Input type not accepted in this environment |
| `FETCH_FAILED` | URL input could not be fetched |
| `DECODE_FAILED` | Not a decodable image / bad pixel data |
| `INFERENCE_FAILED` | Model run failed |
| `DISPOSED` | `dispose()` was called |
| `MODEL_LOAD_FAILED`, `RUNTIME_LOAD_FAILED` | `createSorter()` rejects with `OrdolineError` |
| `ABORTED` | `sort()` stopped via `signal` |

## Options

```js
createSorter({
  modelUrl: "https://cdn.example.com/ordoline/best.onnx", // or model: bytes
  lowConfidenceThreshold: 0.6,
  topK: 3,
  onProgress: ({ fraction }) => {},       // model download
  // advanced: ort, ortUrl, wasmPaths, executionProviders, decode
});

sorter.sort(files, { onResult: (r, { done, total }) => {}, signal: abortController.signal });
```

## Environments

**Web Worker** (keeps the page responsive):

```js
// worker.js
import { createSorter } from "./ordoline-sorter.js";
const sorter = await createSorter();
onmessage = async (e) => postMessage(await sorter.sort(e.data)); // File objects can be posted to workers
```

**Node.js** (not yet tested): inject the runtime and a decoder. `sharp` applies EXIF orientation with `.rotate()`.

```js
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { createSorter } from "./ordoline-sorter.js";

const sorter = await createSorter({
  ort,
  model: readFileSync("best.onnx"),
  decode: async (bytes) => {
    const { data, info } = await sharp(bytes).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: 3 };
  },
});
console.log(await sorter.classify(readFileSync("photo.jpg")));
```

## UI widget (optional, browser)

```html
<script type="module" src="ordoline-sorter-element.js"></script>
<ordoline-sorter model-url="https://cdn.example.com/ordoline/best.onnx"></ordoline-sorter>
```

| Event | `detail` |
|---|---|
| `ordoline-ready` | `{ apiVersion, model }` |
| `ordoline-progress` | `{ phase: "model" \| "sort", fraction, … }` |
| `ordoline-result` | `{ result, input }`: `input` is the dropped `File` |
| `ordoline-done` | `{ result: SortResult, inputs }` |
| `ordoline-error` | `{ code, message }` |

Attributes: `model-url`, `low-confidence-threshold`, `no-results` (hide the built-in grid and render your own).
Method: `el.sort(inputs)` returns `Promise<SortResult>`.
