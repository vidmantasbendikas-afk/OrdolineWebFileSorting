# Ordoline — Dental Photo Sorting

Sorts dental photographs into 11 categories (intraoral, extraoral, cephalometric views) entirely in the browser.
Photos never leave the user's machine: a ConvNeXt-Tiny model runs locally via ONNX Runtime Web (WebAssembly on the
CPU; WebGPU is opt-in).

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

## Release package for external providers

```bash
docker compose run --rm tests npm run package -- --model-url=https://cdn.example.com/ordoline/best.onnx
```

This creates `release/ordoline-sorter-<version>/` and a `.zip` of it. Providers include **one file**,
`ordoline-sorter.js` (the sorter API and its worker, bundled by esbuild). **The model is not included**: it stays on
our server, and `--model-url` bakes its URL into the file as the default (without it, providers must pass `modelUrl`;
the provider README and example page then say so). The `<ordoline-sorter>` widget is not included either; it is for this repository's pages only. The package also contains
TypeScript types, an example page, a provider README (`packaging/README.md`), `API.md`,
`KNOWN_ISSUES.md` and `SHA256SUMS`. The version comes from `package.json`. `tests/release.spec.ts` builds the package
and checks it works.

## Use the module on a website

```html
<script type="module">
  import { createSorter } from "/ordoline/ordoline-sorter.js";

  const sorter = await createSorter({ modelUrl: "https://cdn.example.com/ordoline/best.onnx", worker: true });
  const result = await sorter.sort(fileInput.files);   // arrays, FileLists, URLs, Blobs, …
  console.log(result.byCategory, result.results);
</script>
```

For other sites, use the release package above: copy `ordoline-sorter.js` to the site, e.g. into `/ordoline/`. The
model comes from our model CDN (see *Model storage*). The full input/output
contract, error codes, events, performance and caching setup are in [`docs/API.md`](docs/API.md).

### Model storage (CDN)

The model is the one file we host for every partner, so it must not be swapped, and it should be hard to misuse.
What can and cannot be protected:

- **Tampering: fully preventable.** The release build contains the model's SHA-256; browsers refuse any other file.
- **Copying: only made harder.** Whatever a browser downloads can be saved by its user. Running in the browser is what
  keeps patients' photos on their machine, so the weights are always obtainable by a determined person. Protect them
  with license terms in partner contracts, and make casual reuse harder with the measures below. Encrypting the model
  would not help: the key would have to be sent to the browser too.

**Strategy**

1. **One URL per model version, never overwritten**, e.g. `https://models.example.com/ordoline/2026-11-15/best.onnx`.
   A release of `ordoline-sorter.js` points at exactly one model version. Rolling back means pointing back at the old
   URL, which still exists.
2. **SHA-256 baked into the release.** `npm run package -- --model-url=URL` downloads the model from that URL and
   bakes its hash into `ordoline-sorter.js` next to the URL, so the hash always describes what is actually deployed.
   Browsers check the downloaded and the cached copy; a mismatch fails with `MODEL_LOAD_FAILED` instead of sorting
   with the wrong model. `--model-sha256=HEX` makes the build fail unless the deployed file has that hash. Outside
   the release (our app, `modelUrl` without a baked hash), pass `modelSha256` to get the same check. Checking needs
   Web Crypto, i.e. an https page; on plain http it is skipped with a console warning.
3. **Private storage behind the CDN** (AWS: S3 + CloudFront):
   - S3 bucket with *Block Public Access* on; CloudFront reads it through *Origin Access Control*.
   - Bucket versioning on, so an accidental overwrite or delete can be undone.
   - Only a deploy role can write; separate buckets/URLs for dev and production.
4. **Response headers for `best.onnx`** (as `model-cdn` sends locally, `docker/nginx/model-cdn.conf.template`):

   ```
   Cache-Control: no-cache                          # browsers revalidate (one small request per load)
   ETag: "..."                                      # S3/CloudFront send this automatically
   Access-Control-Allow-Origin: https://partner.example   # partners' origins (or * while testing)
   Access-Control-Expose-Headers: ETag              # otherwise browsers hide ETag from cross-origin scripts
   Vary: Origin                                     # when Allow-Origin depends on the requesting site
   ```

   Limiting `Access-Control-Allow-Origin` to partners' sites stops other websites from using our model in their
   pages; it does not stop a direct download. CloudFront needs a response headers policy listing the partner origins.
5. **Optional:** AWS WAF rate limits and CloudFront access logs to spot bulk downloading. Signed, short-lived URLs
   (CloudFront signed cookies/URLs) would restrict downloads to visitors of partner sites, but need a server that
   issues them; only worth it if the model itself becomes a target.

**Publishing a new model**

1. Check it: `docker compose run --rm reference` and the accuracy test (`tests/accuracy.spec.ts`).
2. Upload it under a **new** versioned URL.
3. Build the release against that URL: `docker compose run --rm tests npm run package -- --model-url=URL`
   (it prints the SHA-256 it baked in).
4. Give partners the new package. Sites still on the previous package keep using the previous model URL.

Browsers keep the model in the Cache API and revalidate it by ETag on every load: one small request when nothing
changed. For local development the app reads its model URL from `/config.json`, which `web` generates from
`MODEL_URL` in `docker-compose.yml`.

### Speed

About **570 ms per photo** on one CPU thread, and about **260 ms** with 4 threads. Multiple threads need the host page
to be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), which `web` sends. WebGPU is opt-in
(`executionProviders: ["webgpu", "wasm"]`): it doubles the runtime download and is not yet verified for this model.
With `worker: true` (used by the app and the widget) the work runs in a Web Worker, so the page
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
| `dist/` | Compiled output, one module per source file (generated; used by the app and tests) |
| `scripts/package-release.ts`, `packaging/` | Single-file release build, its provider README and example page |
| `release/` | Release packages (generated) |
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
