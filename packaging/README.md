# Ordoline Sorter {{VERSION}}

Classifies dental photographs into 11 categories (intraoral, extraoral, cephalometric views) **entirely in the
user's browser**. Photos never leave the user's machine.

## Contents

| Path | Purpose |
|---|---|
| **`ordoline-sorter.js`** | **The only file your pages include:** the sorter API and its Web Worker |
| `ordoline-sorter.d.ts`, `types/` | TypeScript types (optional) |
| `example.html` | Minimal working page |
| `API.md` | Full API: inputs, results, errors, options, caching, performance |
| `KNOWN_ISSUES.md` | Known limitations of the model |
| `SHA256SUMS` | Checksums of all files (`sha256sum -c SHA256SUMS`) |

## Quick start

1. Copy `ordoline-sorter.js` to your web server, e.g. into `/ordoline/` (or copy the whole folder, including the
   example page).
2. Open `/ordoline/example.html` in a browser to check it works. It must be served over HTTP(S); opening the file
   directly from disk (`file://`) does not work.
3. Use it in your page:

```html
<input type="file" id="photos" multiple accept="image/*">
<script type="module">
  import { createSorter } from "/ordoline/ordoline-sorter.js";

  const sorter = await createSorter({ {{MODEL_URL_OPTION}}worker: true });   // loads runtime + model once
  document.getElementById("photos").addEventListener("change", async (e) => {
    const result = await sorter.sort(e.target.files);
    for (const r of result.results) {
      console.log(r.name, r.ok ? `${r.category} (${Math.round(r.confidence * 100)}%)` : r.error.code);
    }
  });
</script>
```

Each result has `category` (e.g. `"intraoral_left"`), `label`, `confidence` (0–1) and `lowConfidence` (true below
0.6: worth a human check). `sort()` also returns `byCategory` and a `summary`. Pass your own ids with
`{ image: file, id: "your-id" }`. Stop a running sort with an `AbortController` (`signal` option); it then returns the
photos done so far. Details: `API.md`.

## The model

The model (about 34 MB) is not part of this package; it is downloaded by the user's browser from Ordoline's server.
{{MODEL_URL_TEXT}} Browsers keep it in their cache and only re-check it on later visits (one small request), so it is
downloaded again only when Ordoline publishes a new version.

## Requirements for your site

| Requirement | Why |
|---|---|
| **HTTPS** | The model is cached in the browser only on secure pages; without HTTPS it is downloaded on every visit |
| **Access to the model's server** | Users' browsers download the model from it (see *The model*) |
| **Access to `cdn.jsdelivr.net`** | The ONNX runtime (onnxruntime-web 1.22.0) is loaded from there. To self-host it, see `ortUrl` / `wasmPaths` in `API.md` |
| **`Content-Security-Policy`**, if your site has one | Allow `script-src cdn.jsdelivr.net 'wasm-unsafe-eval'`, `worker-src blob:`, and `connect-src` for jsDelivr and the model's host |
| **Modern browser** | Tested in Chrome. Uses standard APIs (ES modules, Web Workers, `createImageBitmap`, `OffscreenCanvas`) available in current Chrome, Edge, Firefox and Safari |

### Optional: faster sorting

On our test machine, sorting took about 0.6 s per photo on one CPU thread and 0.3 s with 4 threads; older office
computers will be slower. A usable GPU (WebGPU) is used automatically and is typically faster still. If your page is served with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

the module uses up to 4 CPU threads (about 2× faster). These headers make browsers block cross-origin resources that
do not opt in (images, scripts, iframes, analytics), so check your site first. Without them everything still works,
on one thread.

## Before going live

Read `KNOWN_ISSUES.md`. In particular, left and right side views came out swapped on photos from one camera model;
check the classification of left/right views on photos from your own cameras.

## Not supported

Re-bundling `ordoline-sorter.js` with webpack/Vite is untested: worker mode loads the file's own URL again. Serve it as
a plain static file and load it with `<script type="module">` or `import` (classic `<script>` without `type="module"`
does not work).
