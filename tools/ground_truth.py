#!/usr/bin/env python3
"""Reference accuracy of model/best.onnx on data/test, computed in Python, independent of the browser.

Preprocessing follows training (PIL), which the browser module (sorter/ordoline-sorter.js) reimplements in JS:
  EXIF orientation -> letterbox (longest edge -> N, PIL BILINEAR, centered on black N x N)
  -> RGB [0,1] CHW -> Normalize(ImageNet mean/std)

If this accuracy and the browser's (tests/accuracy.spec.ts) diverge, the JS preprocessing is wrong, not the model.

Run:  docker compose run --rm reference [limit_per_class]
Writes tools/ground_truth_report.json.
"""
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "model" / "best.onnx"
TEST = ROOT / "data" / "test"
REPORT = ROOT / "tools" / "ground_truth_report.json"

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Same fallback and mapping as sorter/ordoline-sorter.js
DEFAULT_CLASSES = [
    "ceph_front", "ceph_side", "extr_profile_rest", "extr_profile_smile", "extr_rest", "extr_smile",
    "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
]
CLASS_TO_CATEGORY = {
    "extr_rest": "extraoral_frontal_rest",
    "extr_smile": "extraoral_frontal_smile",
    "extr_profile_rest": "extraoral_profile_rest",
    "extr_profile_smile": "extraoral_profile_smile",
    "intr_front": "intraoral_frontal",
    "intr_left": "intraoral_left",
    "intr_right": "intraoral_right",
    "intr_upper": "intraoral_upper",
    "intr_lower": "intraoral_lower",
    "ceph_front": "cephalometric_frontal",
    "ceph_side": "cephalometric_lateral",
}

# Test folder -> categories counted as correct (same as tests/helpers.ts)
TRUTH = {
    "ceph_front": ["cephalometric_frontal"],
    "ceph_side": ["cephalometric_lateral"],
    "extr_profile": ["extraoral_profile_rest", "extraoral_profile_smile"],
    "extr_rest": ["extraoral_frontal_rest"],
    "extr_smile": ["extraoral_frontal_smile"],
    "intr_front": ["intraoral_frontal"],
    "intr_left": ["intraoral_left"],
    "intr_right": ["intraoral_right"],
    "intr_upper": ["intraoral_upper"],
    "intr_lower": ["intraoral_lower"],
}


def class_names(sess: ort.InferenceSession) -> list[str]:
    raw = sess.get_modelmeta().custom_metadata_map.get("names", "")
    pairs = re.findall(r"(\d+)\s*:\s*'([^']+)'", raw)
    if not pairs:
        return DEFAULT_CLASSES
    by_index = {int(i): name for i, name in pairs}
    return [by_index[i] for i in sorted(by_index)]


def input_size(sess: ort.InferenceSession) -> int:
    dims = sess.get_inputs()[0].shape
    return dims[2] if len(dims) >= 4 and isinstance(dims[2], int) and dims[2] > 0 else 384


def preprocess(im: Image.Image, size: int) -> np.ndarray:
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    scale = size / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    canvas = Image.new("RGB", (size, size))
    canvas.paste(im.resize((nw, nh), Image.BILINEAR), ((size - nw) // 2, (size - nh) // 2))
    arr = (np.asarray(canvas, dtype=np.float32) / 255.0 - MEAN) / STD  # HWC
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None])  # 1,3,N,N


def main(limit_per_class: int = 0) -> int:
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    inp, out = sess.get_inputs()[0].name, sess.get_outputs()[0].name
    names = class_names(sess)
    size = input_size(sess)

    per_folder = {d: {"correct": 0, "total": 0} for d in TRUTH}
    confusion: dict[str, dict[str, int]] = {d: {} for d in TRUTH}
    misclassified = []
    t0 = time.time()

    for folder in sorted(TRUTH):
        files = sorted(p for p in (TEST / folder).iterdir() if p.is_file())
        if limit_per_class:
            files = files[:limit_per_class]
        for f in files:
            try:
                with Image.open(f) as im:
                    x = preprocess(im, size)
            except Exception as e:  # noqa: BLE001 - report and continue
                print(f"  ! cannot read {f}: {e}", file=sys.stderr)
                continue
            probs = sess.run([out], {inp: x})[0][0]
            probs = probs / (probs.sum() or 1)
            best = int(np.argmax(probs))
            category = CLASS_TO_CATEGORY.get(names[best], names[best])
            ok = category in TRUTH[folder]
            per_folder[folder]["total"] += 1
            per_folder[folder]["correct"] += int(ok)
            confusion[folder][category] = confusion[folder].get(category, 0) + 1
            if not ok:
                misclassified.append({"file": f.name, "folder": folder, "predicted": category,
                                      "confidence": round(float(probs[best]), 4)})

    seconds = time.time() - t0
    correct = sum(v["correct"] for v in per_folder.values())
    total = sum(v["total"] for v in per_folder.values())
    report = {
        "model": {"classes": names, "input_size": size},
        "images": total,
        "accuracy": round(correct / max(total, 1), 4),
        "correct": correct,
        "per_folder": {d: f"{v['correct']}/{v['total']}" for d, v in per_folder.items()},
        "confusion": confusion,
        "misclassified": misclassified,
        "ms_per_image": round(seconds / max(total, 1) * 1000, 1),
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"accuracy {correct}/{total} = {report['accuracy']:.1%}")
    for d, v in report["per_folder"].items():
        print(f"  {d:<14} {v:>6}   predicted: {confusion[d]}")
    print(f"report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 0))
