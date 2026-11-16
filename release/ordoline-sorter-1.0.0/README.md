# Ordoline Sorter 1.0.0

Classifies dental photographs into 11 categories (intraoral, extraoral, cephalometric views) **entirely in the
user's browser**. Photos never leave the user's machine.

## Contents

| Path | Purpose |
|---|---|
| **`ordoline-sorter.js`** | **The only file your pages include:** the sorter API and its Web Worker |
| `example.html` | Minimal working page |
| `sample-photos/` | 3 photos for trying the example page |
| `API.md` | API: inputs, results, categories, errors, options |
| `SHA256SUMS` | Checksums of all files (`sha256sum -c SHA256SUMS`) |

## Quick start

1. Copy `ordoline-sorter.js` to your web server, e.g. into `/ordoline/` (or copy the whole folder, including the
   example page).
2. Open `/ordoline/example.html` in a browser to check it works (see *Testing the example page*). It must be served
   over HTTP(S); opening the file directly from disk (`file://`) does not work.
3. Use it in your page:

```html
<input type="file" id="photos" multiple accept="image/*">
<script type="module">
  import { createSorter } from "/ordoline/ordoline-sorter.js";

  const sorter = await createSorter({ modelUrl: "https://…/best.onnx", worker: true });   // loads runtime + model once
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

You can try the module on your own computer before adding it to your site. Ordoline's model server only serves
registered websites: ask Ordoline to enable your test address (e.g. `http://localhost:8000`) for the integration
period, or test on your registered staging site instead.

1. Edit `example.html`: replace `https://…/best.onnx` in the `modelUrl` line with the model URL you received from Ordoline, and add `modelSha256: "…",` with its SHA-256 on the next line.
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

- **`Could not load the sorter (MODEL_LOAD_FAILED)`**: open the browser's developer console (F12) for the reason.
  Usually the model's server does not allow your test page's address (`403` or a CORS error); ask Ordoline to
  enable it. Otherwise check the model URL.
- **Nothing happens, or a module error in the console**: the page was opened from disk (`file://`) instead of through
  the web server.
- Use `localhost`, not your computer's IP address: browsers treat `http://localhost` as secure, so the model is cached
  and its SHA-256 checked as on an HTTPS site. On plain `http://` with any other address it is downloaded on every
  visit and not checked.

## The model

The model (about 34 MB) is not part of this package; it is downloaded by the user's browser from Ordoline's server.
This build has **no default model URL**: pass the URL you received from Ordoline as `modelUrl`, and its SHA-256 as `modelSha256` so browsers refuse any other file. Browsers keep it in their cache and only re-check it on later visits (one small request), so it is
downloaded again only when Ordoline publishes a new version.

## Requirements for your site

| Requirement | Why |
|---|---|
| **HTTPS** | The model is cached, and its SHA-256 checked, only on secure pages; without HTTPS it is downloaded on every visit and not verified |
| **Access to the model's server** | Users' browsers download the model from it (see *The model*) |
| **Access to `cdn.jsdelivr.net`** | The ONNX runtime (onnxruntime-web 1.22.0, about 11 MB, cached by the browser) is loaded from there |
| **`Content-Security-Policy`**, if your site has one | Allow `script-src cdn.jsdelivr.net 'wasm-unsafe-eval'`, `worker-src blob:`, and `connect-src` for jsDelivr and the model's host |
| **Load it as a module** | Serve `ordoline-sorter.js` as a plain static file and load it with `<script type="module">` or `import`. Do not re-bundle it (webpack, Vite) |
| **Modern browser** | Tested in Chrome and Firefox; current Edge and Safari support the same standard APIs |
