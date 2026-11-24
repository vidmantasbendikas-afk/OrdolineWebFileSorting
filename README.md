# Ordoline — Dental Photo Sorting

A browser app that sorts dental and orthodontic photos into clinical categories.
Classification runs entirely in the browser (ONNX Runtime Web, WebGPU with WASM fallback),
so photos never leave the user's machine.

## Running locally

```bash
python3 serve.py
```

Then open http://localhost:8000. Drop photos onto the page and press **Submit**.
The **Load test images** button in the footer runs the built-in test set from `data/test/`.

## Model

The current model is `model/best.onnx`: ConvNeXt-Tiny (timm, Apache 2.0), 384×384 input,
INT8-quantized MatMul layers (~33 MB).

### What changed in this version

| | Previous model (v1) | Current model (v2) |
|---|---|---|
| Training data | batch 1 (~1,100 images) | batch 2 (~5,300 images) |
| Label smoothing | — | none (0.0), for clearer confidence separation |
| Trained classes | 11 | 11 |
| Output categories | 11 | 12 (11 + "Intraoral. Other") |
| Unrelated / unclear images | always forced into one of the 11 classes | sent to "Intraoral. Other" when confidence is below the group threshold |
| Category names | short internal names | official category names (see below) |

"Intraoral. Other" is **not** a trained class, because it can be literally anything.
A photo goes there when the model's top confidence is below the threshold of the
predicted class's group. The thresholds are built into the ONNX file:

| Group | Threshold |
|---|---|
| X-ray | 0.984 |
| Extraoral Pictures | 0.906 |
| Intraoral | 0.970 |

### Categories

| Model class | Category |
|---|---|
| `ceph_front` | X-ray. Panoramic X-Ray |
| `ceph_side` | X-ray. Lateral X-Ray |
| `extr_profile_rest` | Extraoral Pictures. Profile |
| `extr_profile_smile` | Extraoral Pictures. Profile with smile |
| `extr_rest` | Extraoral Pictures. Frontal |
| `extr_smile` | Extraoral Pictures. Frontal with Smile |
| `intr_front` | Intraoral. Frontal view |
| `intr_left` | Intraoral. Left view |
| `intr_lower` | Intraoral. Lower arch |
| `intr_right` | Intraoral. Right view |
| `intr_upper` | Intraoral. Upper arch |
| — (threshold) | Intraoral. Other |

### Model outputs

| Output | Type | Meaning |
|---|---|---|
| `label` | int64 [1] | final category index 0–11 (11 = "Intraoral. Other"), thresholds already applied |
| `confidence` | float32 [1] | highest class probability |
| `probs` | float32 [1, 11] | probabilities of the 11 trained classes |

Preprocessing (must match training): apply EXIF orientation → scale so the longer side is 384 px
(bilinear) → paste centered on a 384×384 black canvas → pixel values / 255 → normalize with
ImageNet mean `[0.485, 0.456, 0.406]` and std `[0.229, 0.224, 0.225]`.

## Model comparison: v1 vs v2

Tested on 509 already-sorted images from the 2026-11-17 image batch (`raw-images/2026-11-17`),
read directly from S3. Both models received identical preprocessing.

| Category | Images | v1 correct | v1 missed | v1 accuracy | v2 correct | v2 missed | v2 sent to Other | v2 accuracy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Extraoral Pictures. Frontal with Smile | 103 | 101 | 2 | 0.981 | 103 | 0 | 0 | **1.000** |
| Extraoral Pictures. Profile | 140 | 137 | 3 | 0.979 | 137 | 3 | 2 | 0.979 |
| Intraoral. Frontal view | 54 | 53 | 1 | **0.981** | 52 | 2 | 0 | 0.963 |
| Intraoral. Left view | 53 | 47 | 6 | 0.887 | 48 | 5 | 5 | **0.906** |
| Intraoral. Lower arch | 52 | 44 | 8 | 0.846 | 51 | 1 | 0 | **0.981** |
| Intraoral. Right view | 55 | 38 | 17 | 0.691 | 41 | 14 | 9 | **0.745** |
| Intraoral. Upper arch | 52 | 52 | 0 | 1.000 | 52 | 0 | 0 | 1.000 |
| **Total** | **509** | **472** | **37** | **0.927** | **484** | **25** | **16** | **0.951** |

"v2 sent to Other" is included in "v2 missed": those images were rejected to "Intraoral. Other"
instead of being put into the wrong category.

Key points:

- Overall accuracy improved from **92.7% to 95.1%**.
- **Wrong-category errors dropped from 37 to 9.** Of v2's 25 misses, 16 were rejections to
  "Other" (the photo is left for manual sorting) and only 9 were sorted into a wrong category.
- The biggest gains are in **Intraoral. Lower arch** (84.6% → 98.1%) and **Intraoral. Right view**
  (69.1% → 74.5%).
- **Intraoral. Right view** is still the weakest category; most of its misses are rejections to
  "Other" (9 of 14).
- This test batch has no X-ray, "Extraoral Pictures. Frontal" or "Extraoral Pictures. Profile with
  smile" images, so those categories are not covered by this comparison.

## Built-in test set

`data/test/` holds public-dataset images in one folder per model class; `js/testfiles.json` lists
them for the **Load test images** button. After adding, removing or moving test images, rebuild
the list from the folders. The test accuracy shown in the app counts only images that were sorted;
images sent to "Intraoral. Other" are reported separately.

## Notes

- `RELEASE_MODEL_URL` in `js/app.js` is a fallback used only if `model/best.onnx` is missing.
  It points to a `model-v1` release that doesn't exist, so the fallback currently doesn't work.
- The scripts in `tools/` (`ground_truth.py`, `browser_test.py`) were written for the earlier
  YOLO model and don't match the current model.
