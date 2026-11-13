# Ordoline — Dental Photo Sorting

Sorts dental photographs into 11 categories (intraoral, extraoral, cephalometric views) entirely in the browser.
Photos never leave the user's machine: a ConvNeXt-Tiny model runs locally via ONNX Runtime Web (WebGPU, or WebAssembly
as a fallback).

The project has two parts:

- **`sorter/`**: a drop-in JavaScript module that any website can use to classify photos. See [`sorter/API.md`](sorter/API.md).
- **The app** (`index.html`, `js/app.js`): a minimal page built on that module, for sorting photos and checking accuracy.

Everything runs in Docker; only Docker with Compose v2 is needed.

## Run the app

```bash
docker compose up -d        # app: http://localhost:8000   model CDN: http://localhost:8001
docker compose down
```

Open http://localhost:8000, drop photos onto the page (or choose files) and press **Sort**. Each category lists its
photos by confidence. **Run test set** sorts labelled photos from `data/test/` and shows the accuracy. Sample photos
are in `data/mixed/`.

The app needs internet access on first load, because the ONNX runtime comes from jsDelivr. After that, the browser
keeps both the runtime and the model cached.

### Containers

| Service | Purpose |
|---|---|
| `web` | nginx serving the app and `sorter/` on port 8000, with cross-origin isolation headers (multi-threaded inference) |
| `model-cdn` | nginx serving `model/` on port 8001, a separate origin with the same headers the production CDN must send |
| `net` | Holds the shared network so both servers are `localhost` (required for the Cache API) |
| `tests` | Playwright + Chromium; runs the TypeScript tests (on demand) |
| `reference` | Python + onnxruntime; computes the model's reference accuracy (on demand) |

The repository is mounted into the containers, so code edits show up on reload without rebuilding.

## Use the module on a website

```html
<script type="module">
  import { createSorter } from "/path/to/ordoline-sorter.js";

  const sorter = await createSorter({ modelUrl: "https://cdn.example.com/ordoline/best.onnx", worker: true });
  const result = await sorter.sort(fileInput.files);   // arrays, FileLists, URLs, Blobs, …
  console.log(result.byCategory, result.results);
</script>
```

Or use the ready-made drop zone:

```html
<script type="module" src="/path/to/ordoline-sorter-element.js"></script>
<ordoline-sorter model-url="https://cdn.example.com/ordoline/best.onnx"></ordoline-sorter>
```

Copy `sorter/ordoline-sorter.js` (and optionally `ordoline-sorter-element.js` and `ordoline-sorter.d.ts`) to the site.
The full input/output contract, error codes, events, performance and caching setup are in
[`sorter/API.md`](sorter/API.md).

### Model hosting

Upload `model/best.onnx` to a CDN that sends these headers, as `model-cdn` does locally
(`docker/nginx/model-cdn.conf.template`):

```
Cache-Control: no-cache
ETag: "..."
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: ETag
```

Browsers keep the model in the Cache API and check its ETag on every load. An unchanged model costs one small request,
and a new upload is picked up automatically. Pass the URL as `modelUrl`, or set `MODEL_CDN_URL` at the top of
`sorter/ordoline-sorter.js` as the default. The app reads its model URL from `/config.json`, which `web` generates
from `MODEL_URL` in `docker-compose.yml`.

### Speed

About **570 ms per photo** on one CPU thread, and about **260 ms** with 4 threads. Multiple threads need the host page
to be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), which `web` sends. WebGPU, when the browser has a usable GPU, is used
automatically. With `worker: true` (used by the app and the widget) the work runs in a Web Worker, so the page
stays responsive: the longest freeze while sorting drops from ~300 ms to under 10 ms. The app's status line shows the
engine, thread count and whether a worker is used. See *Performance* in
`sorter/API.md` before enabling isolation on another site.

## Tests

```bash
docker compose run --rm tests                                   # everything (~3 min)
docker compose run --rm tests npx playwright test --grep-invert @slow   # fast set (~1 min)
docker compose run --rm tests npx tsc --noEmit                  # type-check
docker compose run --rm reference                               # Python reference accuracy
```

The tests are TypeScript ([Playwright](https://playwright.dev)) and cover the API, every input type, error codes,
worker mode (including page responsiveness), model caching and ETag revalidation (same-origin and via the CDN), the app and the drop-zone widget.
`docker compose up -d` must be running first. After changing `package.json`, rebuild with
`docker compose build tests`.

To run the tests without Docker, use Node 22+ and the installed Google Chrome: `npm install`, then `npm run test:fast`.

### Accuracy

On the 300-photo test set the model scores **269/300 = 89.7%**, both in the browser (`tests/accuracy.spec.ts`) and in
the Python reference (`tools/ground_truth.py`), which confirms the browser preprocessing matches training. Most errors
are extraoral frontal **smile** photos (8/30 correct; 17 are classified as **rest**). The accuracy test fails if the
result drops below 89%.

The previous model scored 97.7% on the same test set (26/30 on smile photos), according to its report in git history
(`git show f848fa4:tools/ground_truth_report.json`).

See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md): left and right side views come out swapped on photos from some cameras.

## Project layout

| Path | Contents |
|---|---|
| `sorter/ordoline-sorter.js` | Core module: loading, preprocessing, inference (no DOM dependency; runs on the page or in a Web Worker) |
| `sorter/ordoline-sorter-element.js` | Optional `<ordoline-sorter>` drop-zone UI |
| `sorter/ordoline-sorter.d.ts`, `sorter/API.md` | API v1.0 types and documentation |
| `sorter/demo.html` | Example page using the drop-zone UI |
| `index.html`, `js/app.js` | The app |
| `js/testfiles.json` | List of labelled test images |
| `model/best.onnx` | The model (34 MB, ConvNeXt-Tiny, 384×384 input, 11 classes) |
| `data/test/`, `data/mixed/` | Labelled test photos (30 per folder) and unlabelled samples |
| `docker-compose.yml`, `docker/` | Containers and nginx configuration |
| `tests/` | Playwright tests (TypeScript) |
| `KNOWN_ISSUES.md` | Open findings, e.g. left/right swapped on some cameras |
| `tools/ground_truth.py` | Python reference accuracy of the model; writes `tools/ground_truth_report.json` |
