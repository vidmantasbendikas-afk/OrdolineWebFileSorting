# Ordoline Sorter {{VERSION}}

Classifies dental photographs into 11 categories (intraoral, extraoral, cephalometric views) **entirely in the
user's browser**. Photos never leave the user's machine.

## Contents

| Path | Purpose |
|---|---|
| **`ordoline-sorter.js`** | **The only file your pages include:** the sorter API and its Web Worker |
<!-- included-model -->
| **`model/best.onnx`** | **The model** (about 34 MB): keep it next to `ordoline-sorter.js` |
<!-- /included-model -->
| `example.html` | Minimal working page |
| `sample-photos/` | 3 photos for trying the example page |
| `API.md` | API: inputs, results, categories, errors, options |
| `SHA256SUMS` | Checksums of all files (`sha256sum -c SHA256SUMS`) |

## Quick start

<!-- hosted-model -->
1. Copy `ordoline-sorter.js` to your web server, e.g. into `/ordoline/` (or copy the whole folder, including the
   example page).
<!-- /hosted-model -->
<!-- included-model -->
1. Copy `ordoline-sorter.js` **and the `model` folder** to your web server, e.g. into `/ordoline/` (or copy the
   whole folder, including the example page). The module loads `model/best.onnx` from next to itself.
<!-- /included-model -->
2. Open `/ordoline/example.html` in a browser to check it works (see *Testing the example page*). It must be served
   over HTTP(S); opening the file directly from disk (`file://`) does not work.
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

## Testing the example page

<!-- hosted-model -->
You can try the module on your own computer before adding it to your site. Ordoline's model server only serves
registered websites: ask Ordoline to enable your test address (e.g. `http://localhost:8000`) for the integration
period, or test on your registered staging site instead.
<!-- /hosted-model -->
<!-- included-model -->
You can try the module on your own computer before adding it to your site:
<!-- /included-model -->

1. {{EXAMPLE_MODEL_STEP}}
2. Serve this folder over HTTP. Any static web server works. For example, if Python is installed, run this inside the
   folder:

   ```
   python3 -m http.server 8000
   ```

   With Node.js installed, `npx serve -l 8000 .` works too.
3. Open <http://localhost:8000/example.html>. The status line shows `Loading model… N%`, then
   `Ready (wasm, 1 thread(s))`. The first visit downloads the ONNX runtime (about 11 MB) and the model (about 34 MB);
   later visits load both from the browser cache.
4. Choose a few photos, e.g. the 3 in `sample-photos/`. Each row shows the photo, its category and the confidence. Confidences below 60% are shown in
   orange: worth a human check. **Stop** ends a running sort and keeps the results so far. The photos stay in the
   browser; nothing is uploaded.

If it does not work:

<!-- hosted-model -->
- **`Could not load the sorter (MODEL_LOAD_FAILED)`**: open the browser's developer console (F12) for the reason.
  Usually the model's server does not allow your test page's address (`403` or a CORS error); ask Ordoline to
  enable it. Otherwise check the model URL.
<!-- /hosted-model -->
<!-- included-model -->
- **`Could not load the sorter (MODEL_LOAD_FAILED)`**: open the browser's developer console (F12) for the reason.
  Check that `model/best.onnx` is next to `ordoline-sorter.js` and that your server delivers it (some servers, e.g.
  IIS, refuse unknown file types until `.onnx` is given a MIME type such as `application/octet-stream`).
<!-- /included-model -->
- **Nothing happens, or a module error in the console**: the page was opened from disk (`file://`) instead of through
  the web server.
- Use `localhost`, not your computer's IP address: browsers treat `http://localhost` as secure, so the model is cached
  and its SHA-256 checked as on an HTTPS site. On plain `http://` with any other address it is downloaded on every
  visit and not checked.

## The model

<!-- hosted-model -->
The model (about 34 MB) is not part of this package; it is downloaded by the user's browser from Ordoline's server.
{{MODEL_URL_TEXT}} Browsers keep it in their cache and only re-check it on later visits (one small request), so it is
downloaded again only when Ordoline publishes a new version.
<!-- /hosted-model -->
<!-- included-model -->
The model is included in this package: `model/best.onnx` (about 34 MB). `ordoline-sorter.js` loads it from the
`model` folder next to itself, so keep the two together. Its SHA-256 is built into `ordoline-sorter.js`: browsers
refuse a model file that does not match. Browsers keep it in their cache and only re-check it on later visits (one
small request; your server sends the `ETag` or `Last-Modified` header this needs, as almost all servers do).

A new model comes as a new package: replace `ordoline-sorter.js` and the `model` folder together.
<!-- /included-model -->

## Requirements for your site

| Requirement | Why |
|---|---|
| **HTTPS** | The model is cached, and its SHA-256 checked, only on secure pages; without HTTPS it is downloaded on every visit and not verified |
<!-- hosted-model -->
| **Access to the model's server** | Users' browsers download the model from it (see *The model*) |
<!-- /hosted-model -->
<!-- included-model -->
| **Serving `model/best.onnx`** | Your server delivers it like any static file (about 34 MB). Some servers (e.g. IIS) need a MIME type for `.onnx`, such as `application/octet-stream` |
<!-- /included-model -->
| **Access to `cdn.jsdelivr.net`** | The ONNX runtime (onnxruntime-web 1.22.0, about 11 MB, cached by the browser) is loaded from there |
<!-- hosted-model -->
| **`Content-Security-Policy`**, if your site has one | Allow `script-src cdn.jsdelivr.net 'wasm-unsafe-eval'`, `worker-src blob:`, and `connect-src` for jsDelivr and the model's host |
<!-- /hosted-model -->
<!-- included-model -->
| **`Content-Security-Policy`**, if your site has one | Allow `script-src cdn.jsdelivr.net 'wasm-unsafe-eval'`, `worker-src blob:`, and `connect-src 'self'` and jsDelivr |
<!-- /included-model -->
| **Load it as a module** | Serve `ordoline-sorter.js` as a plain static file and load it with `<script type="module">` or `import`. Do not re-bundle it (webpack, Vite) |
| **Modern browser** | Tested in Chrome and Firefox; current Edge and Safari support the same standard APIs |
