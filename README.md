# Ordoline — Dental Photo Sorting

Sorts dental photographs into 11 categories (intraoral, extraoral, cephalometric views) entirely in the browser.
Photos never leave the user's machine: a ConvNeXt-Tiny model runs locally via ONNX Runtime Web (WebGPU, or WebAssembly
as a fallback).

The project has two parts:

- **The sorter** (`src/sorter/`): a drop-in module that any website can use to classify photos. See
  [`docs/API.md`](docs/API.md).
- **The app** (`index.html`, `src/app/app.ts`): a minimal page built on that module, for sorting photos and checking
  accuracy.

All code is TypeScript in `src/`. It compiles to plain ES modules in `dist/` (with `.d.ts` types and source maps),
which is what pages load and what you give to other sites. `dist/` is generated, not committed.

Everything runs in Docker; only Docker with Compose v2 is needed.

## Run the app

```bash
docker compose up -d        # app: http://localhost:8000   model CDN: http://localhost:8001
docker compose down
```

Open http://localhost:8000, drop photos onto the page (or choose files) and press **Sort**. Each category lists its
photos by confidence. **Stop** ends a running sort; photos not reached stay queued, and **Sort** continues with them. **Run test set** sorts labelled photos from `data/test/` and shows the accuracy. Sample photos
are in `data/mixed/`.

The app needs internet access on first load, because the ONNX runtime comes from jsDelivr. After that, the browser
keeps both the runtime and the model cached.

### Containers

| Service | Purpose |
|---|---|
| `build` | Compiles `src/` to `dist/` and recompiles on every save |
| `web` | nginx serving the app and `dist/` on port 8000, with cross-origin isolation headers (multi-threaded inference) |
| `model-cdn` | nginx serving `model/` on port 8001, a separate origin with the same headers the production CDN must send |
| `net` | Holds the shared network so both servers are `localhost` (required for the Cache API) |
| `tests` | Playwright + Chromium; runs the TypeScript tests (on demand) |
| `reference` | Python + onnxruntime; computes the model's reference accuracy (on demand) |

The repository is mounted into the containers, so code edits show up on reload without rebuilding.

## Use the module on a website

```html
<script type="module">
  import { createSorter } from "/ordoline/sorter/ordoline-sorter.js";

  const sorter = await createSorter({ modelUrl: "https://cdn.example.com/ordoline/best.onnx", worker: true });
  const result = await sorter.sort(fileInput.files);   // arrays, FileLists, URLs, Blobs, …
  console.log(result.byCategory, result.results);
</script>
```

Or use the ready-made drop zone:

```html
<script type="module" src="/ordoline/ui/ordoline-sorter-element.js"></script>
<ordoline-sorter model-url="https://cdn.example.com/ordoline/best.onnx"></ordoline-sorter>
```

Build (`npm run build`, or the `build` container), then copy `dist/sorter/` (required) and `dist/ui/` (only for the
drop zone) to the site, keeping them side by side, e.g. as `/ordoline/sorter/` and `/ordoline/ui/`. `dist/sorter/`
holds the entry point `ordoline-sorter.js` and the internal modules it imports; both folders include `.d.ts` types for
TypeScript users. The `.map` files are optional. Put the model in `/ordoline/sorter/model/best.onnx`, or pass
`modelUrl`. The full input/output
contract, error codes, events, performance and caching setup are in [`docs/API.md`](docs/API.md).

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
`src/sorter/options.ts` as the default. The app reads its model URL from `/config.json`, which `web` generates
from `MODEL_URL` in `docker-compose.yml`.

### Speed

About **570 ms per photo** on one CPU thread, and about **260 ms** with 4 threads. Multiple threads need the host page
to be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), which `web` sends. WebGPU, when the browser has a usable GPU, is used
automatically. With `worker: true` (used by the app and the widget) the work runs in a Web Worker, so the page
stays responsive: the longest freeze while sorting drops from ~300 ms to under 10 ms. The app's status line shows the
engine, thread count and whether a worker is used. See *Performance* in
`docs/API.md` before enabling isolation on another site.

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

Every Playwright run compiles `src/` first, so tests always use the current sources.

Without Docker, use Node 22+ and the installed Google Chrome: `npm install`, `npm run build` (or `npm run build:watch`),
`npm run typecheck`, `npm run test:fast`.

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
| `src/sorter/ordoline-sorter.ts` | Public entry: `createSorter`, re-exports the public API |
| `src/sorter/types.ts` | Public types (`Sorter`, `ClassificationResult`, options, …) |
| `src/sorter/sorter.ts` | In-thread sorter: inference, results, `sort()` |
| `src/sorter/worker.ts` | Worker mode: page-side proxy and worker host |
| `src/sorter/decode.ts`, `preprocess.ts` | Input handling, image decoding, resize and normalization |
| `src/sorter/runtime.ts`, `model-cache.ts` | ONNX Runtime loading, model download and Cache API |
| `src/sorter/categories.ts`, `options.ts`, `errors.ts` | Categories, defaults, `OrdolineError` |
| `src/ui/ordoline-sorter-element.ts` | Optional `<ordoline-sorter>` drop-zone UI |
| `src/app/app.ts`, `index.html` | The app |
| `dist/` | Compiled output (generated) |
| `docs/API.md` | API documentation |
| `examples/widget-demo.html` | Example page using the drop-zone UI |
| `js/testfiles.json` | List of labelled test images |
| `model/best.onnx` | The model (34 MB, ConvNeXt-Tiny, 384×384 input, 11 classes) |
| `data/test/`, `data/mixed/` | Labelled test photos (30 per folder) and unlabelled samples |
| `docker-compose.yml`, `docker/` | Containers and nginx configuration |
| `tests/` | Playwright tests (TypeScript) |
| `CLAUDE.md` | Guidance for Claude Code: commands, conventions, invariants |
| `KNOWN_ISSUES.md` | Open findings, e.g. left/right swapped on some cameras |
| `tools/ground_truth.py` | Python reference accuracy of the model; writes `tools/ground_truth_report.json` |
