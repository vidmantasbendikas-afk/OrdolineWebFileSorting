# CLAUDE.md

Guidance for Claude Code in this repository. User-facing docs: `README.md`, `docs/API.md`, `KNOWN_ISSUES.md`.

## What this is

Browser-only dental photo classifier (11 categories). A ConvNeXt-Tiny ONNX model (`model/best.onnx`, 384×384 input)
runs in the browser via onnxruntime-web 1.22.0, loaded from jsDelivr. Two deliverables:

- **Sorter module** (`src/sorter/`): drop-in API for other websites (`createSorter`, `classify`, `sort`).
- **App** (`index.html` + `src/app/app.ts`): minimal page built on the module, for sorting and checking accuracy.

## Commands (everything runs in Docker)

```bash
docker compose up -d                                   # build (tsc --watch), web :8000, model-cdn :8001
docker compose run --rm tests npx playwright test --grep-invert @slow   # fast tests (~2.5 min)
docker compose run --rm tests                          # all tests incl. 300-photo accuracy (~4 min)
docker compose run --rm tests npx tsc --noEmit         # type-check sources + tests
docker compose run --rm reference                      # Python reference accuracy (tools/ground_truth.py)
docker compose run --rm tests npm run package -- --model-url=https://…/best.onnx   # release/ordoline-sorter-<version>(.zip)
docker compose build tests                             # after changing package.json / package-lock.json
```

Without Docker: Node 22 is installed via nvm but not on the default PATH
(`export PATH=~/.nvm/versions/node/v22.18.0/bin:$PATH`); then `npm run build`, `npm run typecheck`, `npm run test:fast`
(uses the installed Google Chrome; `docker compose up -d` must still be running for the servers).

## Layout and conventions

- **All code is TypeScript in `src/`.** `tsc -p tsconfig.build.json` compiles it 1:1 to ES modules in `dist/`
  (with `.d.ts` and source maps). Never edit `dist/` (generated, gitignored). No bundler.
- `src/sorter/`: `ordoline-sorter.ts` is the public entry (only `createSorter` + re-exports). Public types live in
  `types.ts`; keep them in sync with `docs/API.md`. Internals: `sorter.ts` (in-thread sorter, shared `sortWith`),
  `worker.ts` (worker proxy + host), `decode.ts`, `preprocess.ts`, `runtime.ts`, `model-cache.ts`, `categories.ts`,
  `options.ts`, `errors.ts`.
- `src/ui/ordoline-sorter-element.ts`: optional `<ordoline-sorter>` widget; imports `../sorter/`.
- **Release for external providers = ONE file.** `scripts/package-release.ts` bundles
  `src/sorter/ordoline-sorter.ts` (API + worker) with esbuild into `ordoline-sorter.js`. **Never ship the model or the
  `<ordoline-sorter>` widget to third parties.** The model stays on our CDN; `--model-url` bakes its URL in via the
  `__ORDOLINE_MODEL_URL__` define in `options.ts`. Widget docs stay inside `<!-- repo-only -->` blocks in
  `docs/API.md` (stripped when packaging). Provider-facing docs live in `packaging/`. Bump `version` in
  `package.json` for a new release.
- The bundle is also loaded inside the sorter's own Web Worker, so code in `src/sorter/` must not touch DOM globals
  at module level.
- The sorter core must stay **DOM-free** (runs in Web Workers). DOM code belongs in `src/ui/` or `src/app/`.
- Browser-only: no Node/Deno/Bun support paths.
- Tests: TypeScript Playwright in `tests/`. `tests/global-setup.ts` builds before every run. The harness page
  `tests/harness.html` exposes the module as `window.api`.
- Git: **never add `Co-Authored-By` (or other AI attribution) to commit messages.** Commit or push only when asked.

## Invariants that are easy to break

- **Preprocessing must match training** (`src/sorter/preprocess.ts`): EXIF orientation → letterbox, longest edge to
  384 with PIL-style antialiased bilinear → black padding → ImageNet mean/std, CHW. The Python reference
  (`tools/ground_truth.py`, PIL) must give the same accuracy as the browser: currently **269/300 = 89.7%**,
  identical per folder. `tests/accuracy.spec.ts` fails below 89%.
- **API results never throw per image**: `classify()` resolves `{ ok: false, error: { code } }`. A stopped `sort()`
  resolves with partial results (`summary.aborted`, `summary.skipped`); it does not reject.
- **Worker mode** (`worker: true`) loads `dist/sorter/worker.js` via a `blob:` wrapper using `import.meta.url`, so the
  modules must be served as separate files (not bundled) and with CORS if cross-origin.
- **Multi-threading** needs a cross-origin isolated page (COOP + COEP headers, sent by the `web` nginx). Up to 4
  threads (measured: more gave no gain).
- **Model caching**: Cache API copy revalidated by ETag; cross-origin the CDN must send
  `Access-Control-Expose-Headers: ETag`. The default model URL is `model/best.onnx` next to the module; nginx aliases
  `/dist/sorter/model/` to `model/`.
- ONNX Runtime silently drops WebGPU without a GPU adapter, so `runtime.ts` checks for an adapter first to report the
  real backend. Headless test browsers have no GPU: tests run on WASM.

## Docker notes

- `net` holds the shared network namespace; `web`, `model-cdn` and `tests` join it so both origins are `localhost`
  (secure context for the Cache API) on different ports (genuinely cross-origin).
- Port 8001 is used for the model CDN because 8081 is taken by another project's container on this machine.
  Ports are bound to 127.0.0.1.
- The Playwright image tag (`docker/tests.Dockerfile`) must match `@playwright/test` in `package.json` (1.65.0).
- Cache tests touch `model/best.onnx`'s mtime to simulate a new upload and restore it afterwards.

## Known open issues

See `KNOWN_ISSUES.md`: left/right lateral views come out swapped on photos from a SHOFU EyeSpecial C-IV camera
(convention question for the clinic; not a code bug). Extraoral frontal smile photos score 8/30 (17 classified as
rest). The previous model scored 97.7%; the current one is INT8-quantized (commit e2ac27c), but whether that explains
the drop is unverified.
