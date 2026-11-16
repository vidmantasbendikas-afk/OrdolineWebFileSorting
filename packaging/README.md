# Ordoline Sorter {{VERSION}}

Classifies dental photographs into 11 categories (intraoral, extraoral, cephalometric views) **entirely in the
user's browser**. Photos never leave the user's machine.

## Contents

| Path | Purpose |
|---|---|
| **`ordoline-sorter.js`** | **The only file your pages include:** the sorter API and its Web Worker |
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
| **HTTPS** | The model is cached, and its SHA-256 checked, only on secure pages; without HTTPS it is downloaded on every visit and not verified |
| **Access to the model's server** | Users' browsers download the model from it (see *The model*) |
| **Access to `cdn.jsdelivr.net`** | The ONNX runtime (onnxruntime-web 1.22.0, CPU build, about 11 MB, cached by the browser) is loaded from there. To self-host it, see `ortUrl` / `wasmPaths` in `API.md` |
| **`Content-Security-Policy`**, if your site has one | Allow `script-src cdn.jsdelivr.net 'wasm-unsafe-eval'`, `worker-src blob:`, and `connect-src` for jsDelivr and the model's host |
| **Modern browser** | Tested in Chrome. Uses standard APIs (ES modules, Web Workers, `createImageBitmap`, `OffscreenCanvas`) available in current Chrome, Edge, Firefox and Safari |

### Optional: faster sorting (server headers)

**No server changes are needed.** Without them the module sorts on one CPU thread: about 0.6 s per photo on our test
machine (older office computers will be slower).

If the page that uses the module is served with these two HTTP response headers, the module uses up to 4 CPU threads,
about 0.3 s per photo (2× faster):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They must be real HTTP headers from your web server; a `<meta http-equiv>` tag does not work. They are needed only on
the HTML page itself, not on `ordoline-sorter.js` or the model. Examples:

```nginx
# nginx (server or location block of the page)
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

```apache
# Apache (.htaccess or VirtualHost; needs mod_headers)
Header set Cross-Origin-Opener-Policy "same-origin"
Header set Cross-Origin-Embedder-Policy "require-corp"
```

Hosting services and CDNs (Cloudflare, Netlify, Vercel, …) have a "custom response headers" setting for the same.

**Check your site first.** With `require-corp`, the browser blocks every resource from another domain that does not
opt in (images, scripts, fonts, iframes, analytics, embedded videos). `Cross-Origin-Opener-Policy: same-origin` also
cuts the link to windows opened from or opening the page (some login and payment pop-ups rely on it). The softer
alternative:

```
Cross-Origin-Embedder-Policy: credentialless
```

loads resources from other domains without cookies instead of blocking them, and gives the same 4 threads in Chrome
(verified) and Edge. Safari does not support it as far as we know; there the module stays on one thread.

`sorter.model.threads` shows how many threads are in use.

## Before going live

Read `KNOWN_ISSUES.md`. In particular, left and right side views came out swapped on photos from one camera model;
check the classification of left/right views on photos from your own cameras.

## Not supported

Re-bundling `ordoline-sorter.js` with webpack/Vite is untested: worker mode loads the file's own URL again. Serve it as
a plain static file and load it with `<script type="module">` or `import` (classic `<script>` without `type="module"`
does not work).
