#!/usr/bin/env python3
"""Writes tests/unit/fixtures/preprocess-pil.json: PIL letterbox output for small synthetic images.

tests/unit/preprocess.test.ts checks that src/sorter/preprocess.ts produces exactly these pixels, i.e. that the
TypeScript resize matches training (PIL BILINEAR) also for odd sizes, extreme aspect ratios and upscaling.
The letterbox code is the same as tools/ground_truth.py preprocess(), minus normalization.

Run:  docker compose run --rm -v ./tests/unit/fixtures:/work/fixtures reference python tools/preprocess_fixture.py
"""
import base64
import json
from pathlib import Path

import numpy as np
from PIL import Image

# (width, height, letterbox size): downscale, upscale, odd sizes, very wide/tall, 1x1, no-op (32x32), one pass only
# (64x48). Pillow runs the vertical pass first when the height shrinks more than twice as much as the width
# (7x500, 3x200, 100x300); the other cases run horizontal first.
CASES = [
    (37, 23, 16), (23, 37, 16), (500, 7, 64), (7, 500, 64), (1, 1, 8), (10, 10, 40), (2, 3, 7),
    (64, 48, 64), (97, 61, 32), (3, 200, 24), (640, 480, 48), (480, 640, 48), (32, 32, 32),
    (300, 100, 50), (100, 300, 50), (120, 200, 64),
]


def pixel(x: np.ndarray, y: np.ndarray, c: int) -> np.ndarray:
    """Deterministic test pattern; tests/unit/preprocess.test.ts has the same formula."""
    return (x * 31 + y * 17 + c * 67 + ((x * y) % 13) * 7) & 255


def synthetic(w: int, h: int) -> Image.Image:
    y, x = np.mgrid[0:h, 0:w]
    rgb = np.stack([pixel(x, y, c) for c in range(3)], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def letterbox(im: Image.Image, size: int) -> np.ndarray:
    w, h = im.size
    scale = size / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    canvas = Image.new("RGB", (size, size))
    canvas.paste(im.resize((nw, nh), Image.BILINEAR), ((size - nw) // 2, (size - nh) // 2))
    return np.asarray(canvas, dtype=np.uint8)  # HWC


def main() -> None:
    cases = [
        {"width": w, "height": h, "size": s, "rgb": base64.b64encode(letterbox(synthetic(w, h), s).tobytes()).decode()}
        for w, h, s in CASES
    ]
    out = Path("fixtures/preprocess-pil.json")
    out.write_text(json.dumps({"pillow": Image.__version__, "cases": cases}, indent=1) + "\n")
    print(f"{out}: {len(cases)} cases (Pillow {Image.__version__})")


if __name__ == "__main__":
    main()
