# Ordoline Sorter — API v1.0

Classifies dental photos into 11 categories, fully in the browser. The core (`ordoline-sorter.js`) has no DOM
dependency, so it runs on the page's main thread or in a Web Worker.
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

| Input | Main thread | Worker |
|---|---|---|
| `File`, `Blob`, `ArrayBuffer`, `Uint8Array` (encoded JPEG/PNG/WebP…) | ✓ | ✓ |
| URL string (`https:`, `data:`, `blob:`; cross-origin needs CORS) | ✓ | ✓ |
| `{ data, width, height, channels? }` (raw RGB/RGBA pixels), `ImageData` | ✓ | ✓ |
| `ImageBitmap`, `OffscreenCanvas`, `VideoFrame` | ✓ | ✓ |
| `HTMLImageElement`, `HTMLCanvasElement` | ✓ | – |

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
  "model": { "url": "…/best.onnx", "source": "cache", "backend": "wasm", "threads": 4, "worker": true, "inputSize": 384, "classes": ["ceph_front", "…"] },
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

**Note on `intraoral_left` / `intraoral_right`:** these follow the training data's left/right convention. Photos from
some cameras (seen with a SHOFU EyeSpecial C-IV) come out swapped. See [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).

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
| `INVALID_OPTIONS` | `createSorter()` options that cannot be combined (`worker` + `ort`) |

## Options

```js
createSorter({
  modelUrl: "https://cdn.example.com/ordoline/best.onnx",
  modelCache: "ordoline-sorter-model",    // Cache API name; false to disable
  numThreads: 4,                          // default: up to 4 when cross-origin isolated, else 1
  worker: true,                           // run in a Web Worker (recommended for pages)
  lowConfidenceThreshold: 0.6,
  topK: 3,
  onProgress: ({ fraction }) => {},       // model download
  // advanced: ort, ortUrl, wasmPaths, executionProviders
});

sorter.sort(files, { onResult: (r, { done, total }) => {}, signal: abortController.signal });
```

## Performance

Inference takes about **570 ms per photo on one CPU thread** (measured on a 2080×1560 photo; decoding and
preprocessing add about 50 ms). Two things make it faster:

| | Speed | Requirement |
|---|---|---|
| **WebGPU** | Typically the fastest; not yet measured for this model | Used automatically when the browser has a usable GPU adapter |
| **Multi-threaded WASM** | ~260 ms per photo with 4 threads (2.2× faster) | The host page must be **cross-origin isolated** |

Cross-origin isolation means the page is served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The sorter detects this (`crossOriginIsolated`) and uses up to 4 threads; more threads gave no further gain.
`sorter.model.backend` and `sorter.model.threads` show what is in use. Override with `createSorter({ numThreads })`.

**Caution for host sites:** with `require-corp`, every cross-origin resource on the page (images, scripts, iframes,
analytics) must be served with CORS or `Cross-Origin-Resource-Policy`, or the browser blocks it. Check the site
before enabling. Without the headers, the sorter still works on one thread.

## Model caching

The model is kept in the browser's Cache API and revalidated on every load:

| Server says | What happens |
|---|---|
| Same ETag as the cached copy | Download is cancelled, cached copy is used (a few KB of traffic) |
| Different ETag | New model is downloaded, loaded, then replaces the cached copy |
| Unreachable / error | Cached copy is used |

A copy is stored only after the model loads successfully. Old model URLs are removed from the cache.
`sorter.model.source` tells you whether the model came from `"network"` or `"cache"`.
Disable with `createSorter({ modelCache: false })`.

**Server/CDN setup for `best.onnx`** (e.g. S3 + CloudFront):

```
Cache-Control: no-cache                       # revalidate every load; a new upload is picked up at once
ETag: "..."                                   # S3/CloudFront send this automatically
Access-Control-Allow-Origin: *                # or the host sites' origins
Access-Control-Expose-Headers: ETag           # otherwise browsers hide ETag from cross-origin scripts
```

Without `Expose-Headers: ETag` the sorter falls back to `Last-Modified`. If neither is readable, the model
is downloaded on every load and not cached. The Cache API needs a secure context (https or localhost).

The ONNX runtime needs no setup: jsDelivr serves the pinned version as `immutable` for one year.
Upgrading means changing `ORT_VERSION`, which changes the URL.

## Web Worker (keeps the page responsive)

```js
const sorter = await createSorter({ worker: true });
```

Decoding, preprocessing and inference then run in a dedicated Web Worker. The API and results are identical, and
`sorter.model.worker` is `true`. Without it, the page freezes for the duration of each photo's inference (measured:
up to ~300 ms per photo; with the worker, under 10 ms). It does not make a single photo faster.

The worker loads this same module file, so nothing extra needs to be deployed. That works when the module is served
from another origin too, as long as that origin sends CORS headers. `<img>` and `<canvas>` inputs are converted to
`ImageBitmap` on the page before sending, and relative URLs are resolved against the page. `worker: true` cannot be
combined with `ort` (use `ortUrl`). The `<ordoline-sorter>` widget uses a worker by default.

You can also import the module inside your own worker; the core has no DOM dependency.

| Event | `detail` |
|---|---|
| `ordoline-ready` | `{ apiVersion, model }` |
| `ordoline-progress` | `{ phase: "model" \| "sort", fraction, … }` |
| `ordoline-result` | `{ result, input }`: `input` is the dropped `File` |
| `ordoline-done` | `{ result: SortResult, inputs }` |
| `ordoline-error` | `{ code, message }` |

Attributes: `model-url`, `low-confidence-threshold`, `no-results` (hide the built-in grid and render your own),
`no-worker` (run on the main thread instead of a Web Worker).
Method: `el.sort(inputs)` returns `Promise<SortResult>`.
