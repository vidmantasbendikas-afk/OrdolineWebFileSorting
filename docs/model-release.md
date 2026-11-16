# Releasing a new model version

How to replace the model partners use, e.g. `web-2d-photo-classifier-v1.onnx` → `web-2d-photo-classifier-v2.onnx`.
Hosting and protection: [`model-protection.md`](model-protection.md).

## Principle: one release = one model

The release build bakes the model's URL **and its SHA-256** into `ordoline-sorter.js`. A new model therefore ships as a
new `ordoline-sorter.js`; partners do **not** name the model version in their code:

```js
const sorter = await createSorter({ worker: true });   // the same with v1 and v2
```

| Release | Model |
|---|---|
| `ordoline-sorter-1.0.0` | `models/web-2d-photo-classifier-v1.onnx` |
| `ordoline-sorter-1.1.0` | `models/web-2d-photo-classifier-v2.onnx` |

## Steps

**Ordoline**

1. **Check the new model**: the accuracy test (`tests/accuracy.spec.ts`, with the new model as `model/best.onnx`) and
   the Python reference (`docker compose run --rm reference`). Compare with the current model per category.
2. **Check its interface** (see *Compatible or breaking* below): same classes, same input size.
3. **Upload it next to the old one, under a new name**. Never overwrite an existing file:

   ```
   s3://ordoline-models/models/web-2d-photo-classifier-v1.onnx   ← stays
   s3://ordoline-models/models/web-2d-photo-classifier-v2.onnx   ← new
   ```

4. **Bump `version` in `package.json`** (`1.0.0` → `1.1.0`; `2.0.0` if breaking) and build the release:

   ```
   docker compose run --rm tests npm run package -- --model-url=https://cdn.ordoline.com/models/web-2d-photo-classifier-v2.onnx
   ```

   The build downloads the model from that URL and bakes in its SHA-256 (it prints it). Pass
   `--model-sha256=HEX` as well to make the build fail unless the uploaded file is exactly the one you tested.
5. **Send partners** the new package with short release notes: which model, accuracy compared with the previous one,
   whether categories changed, and the SHA-256.

**Partner (e.g. NFQ)**

6. Replace `ordoline-sorter.js` on their server (and update their copy of the docs). No code changes for a
   compatible release.
7. Users' browsers download the new model once (about 34 MB) on their next visit. The module removes the cached copy
   of the old model by itself.

**Rollback:** the partner puts the previous `ordoline-sorter.js` back. The old model is still on the CDN, so it
works immediately.

## Trying the new model before upgrading

A partner can test v2 on their staging site with the **current** release by passing the model explicitly (only for
a compatible model):

```js
const sorter = await createSorter({
  modelUrl: "https://cdn.ordoline.com/models/web-2d-photo-classifier-v2.onnx",
  modelSha256: "<SHA-256 from the release notes>",
  worker: true,
});
```

For production, use the new release instead: typing the URL and the 64-character hash by hand is error-prone, and
the module and model should come as a tested pair.

## Compatible or breaking

| Change in the new model | Kind | Release |
|---|---|---|
| Retrained weights; same 11 classes, same input | Compatible | Minor (`1.1.0`); partners only swap the file |
| Category added, removed, renamed or merged | **Breaking**: partner code may check `category` ids | Major (`2.0.0`); update `docs/API.md`, warn partners explicitly |
| Different input size only (e.g. 448 instead of 384) | Handled: the module reads it from the model | Minor; check accuracy and speed |
| Different preprocessing (resize method, normalization, colour order) | Needs module changes too (`src/sorter/preprocess.ts`) | Major, with the module change |

The module reads the class names and input size from the model, but the public category ids, labels and docs live in
the module (`src/sorter/categories.ts`), so any class change needs a module change as well.

## Keeping old versions

Keep every model version on the CDN while any partner still uses a release that points at it, and for rollback.
Storage costs fractions of a cent per model per month. Delete a version only when no partner release uses it any more.

## Do not

- **Overwrite a model file** or use a moving name such as `models/latest.onnx`. The baked-in SHA-256 would no longer
  match, so browsers would refuse the model; and the classification would change without partners knowing, which is
  unacceptable in a clinical workflow.
- **Reuse a version name** for a different file, even for a "small fix". Every changed file gets a new name.
