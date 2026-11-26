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

`model/best.onnx` is a ConvNeXt-Tiny image classifier (timm, Apache 2.0) with a 384×384 input.
Its MatMul layers are INT8-quantized, which keeps the file at about 30 MB and fully browser-compatible.

### How it decides

1. The model predicts one of **11 trained categories** and gives a confidence for it.
2. If that confidence is below the threshold of the category's group (X-ray, Extraoral Pictures
   or Intraoral), the photo goes to **"Other"** instead.

"Other" is not a trained category, because it can be literally anything (unrelated photos,
unusable shots). The three group thresholds were tuned to separate genuine photos from rejected
and unrelated images, then lowered by 0.1 so that fewer genuine photos are rejected.
They are built into the ONNX file, so the app only reads the final `label` output.

### Categories

**X-ray**
- Panoramic X-ray
- Lateral X-ray

**Extraoral Pictures**
- Profile
- Profile with smile
- Frontal
- Frontal with smile

**Intraoral**
- Frontal view
- Left view
- Lower arch
- Right view
- Upper arch

**Other**: photos that don't confidently match any category above.

### Inputs and outputs

| | Name | Type | Meaning |
|---|---|---|---|
| Input | `input` | float32 [1, 3, 384, 384] | preprocessed RGB image (NCHW) |
| Output | `label` | int64 [1] | final category, thresholds already applied (the last value means "Other") |
| Output | `confidence` | float32 [1] | highest class probability |
| Output | `probs` | float32 [1, 11] | probabilities of the 11 trained categories |

Preprocessing (must match training): apply EXIF orientation → scale so the longer side is 384 px
(bilinear) → paste centered on a 384×384 black canvas → pixel values / 255 → normalize with
ImageNet mean `[0.485, 0.456, 0.406]` and std `[0.229, 0.224, 0.225]`.

Class names, thresholds and preprocessing settings are also stored inside the ONNX file
(metadata key `classifier_info`).

## Built-in test set

`data/test/` holds public-dataset images in one folder per model class; `js/testfiles.json` lists
them for the **Load test images** button. After adding, removing or moving test images, rebuild
the list from the folders. The test accuracy shown in the app counts only images that were sorted;
images sent to "Other" are reported separately.

## Notes

- `RELEASE_MODEL_URL` in `js/app.js` is a fallback used only if `model/best.onnx` is missing.
  It points to a `model-v1` release that doesn't exist, so the fallback currently doesn't work.
- The scripts in `tools/` (`ground_truth.py`, `browser_test.py`) were written for an earlier
  YOLO model and don't match the current model.
