# Known issues

## Left and right swapped on some cameras

Found on 2026-11-13.

Five real full-size photos (2080×1560, SHOFU EyeSpecial C-IV camera, in `DATA/introralphotos/images` next to this
repository) were checked. Frontal, upper and lower views are classified correctly (~90% confidence), but **left and
right lateral views come out swapped**, with high confidence:

| Photo | Model says | Model says with the photo mirrored |
|---|---|---|
| `introral-left.JPG` | intraoral **right** (87%) | intraoral **left** (91%) |
| `introral-right.JPG` | intraoral **left** (90%) | intraoral **right** (86%) |

This is not caused by the browser code: the Python reference gives the same result, and the photos have no EXIF
rotation or flip (orientation 1). The photos most likely follow the opposite left/right convention from the training
data. Intraoral side views are often taken with a mirror, and "left" can mean the patient's left or the viewer's left.

Open questions before changing anything:

1. Which convention do these file names use: the patient's left or the viewer's left?
2. Depending on the answer: add a "mirrored side views" option that swaps left and right, retrain the model with
   photos in this convention, or treat the file names as wrong.

Five photos are a strong signal, not proof; more photos from this camera would confirm it.
