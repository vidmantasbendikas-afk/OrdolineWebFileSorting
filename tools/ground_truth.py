#!/usr/bin/env python3
"""Ground-truth validation of best.onnx with Ultralytics classify preprocessing.

Replicates ultralytics v8.4.69 ClassificationPredictor preprocessing for
ONNX models: Resize(shortest_edge=512, BILINEAR) -> CenterCrop(512) ->
ToTensor([0,1], RGB, CHW) -> Normalize(mean=0, std=1).
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "model" / "best.onnx"
TEST = ROOT / "data" / "test"

MODEL_CLASSES = [
    "ceph_front", "ceph_side", "extr_profile", "extr_rest", "extr_smile",
    "intr_front", "intr_left", "intr_lower", "intr_right", "intr_upper",
]

TEST_DIR_TO_CLASS = {
    "ceph_front": "ceph_front", "ceph_side": "ceph_side", "extr_profile": "extr_profile",
    "extr_rest": "extr_rest", "extr_smile": "extr_smile", "intr_front": "intr_front",
    "intr_left": "intr_left", "intr_lower": "intr_lower", "intr_right": "intr_right",
    "intr_upper": "intr_upper",
}


def preprocess(im: Image.Image, size: int = 512) -> np.ndarray:
    im = im.convert("RGB")
    w, h = im.size
    scale = size / min(w, h)
    nw, nh = round(w * scale), round(h * scale)
    im = im.resize((nw, nh), Image.BILINEAR)
    left = round((nw - size) / 2)
    top = round((nh - size) / 2)
    im = im.crop((left, top, left + size, top + size))
    arr = np.asarray(im, dtype=np.float32) / 255.0  # HWC RGB
    chw = arr.transpose(2, 0, 1)[None]  # 1,3,512,512
    return np.ascontiguousarray(chw)


def main(limit_per_class: int = 0) -> int:
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    per_class = {c: {"correct": 0, "total": 0} for c in MODEL_CLASSES}
    confusion = {c: {} for c in MODEL_CLASSES}
    low_conf = []
    softmax_seen = False
    n = 0
    t0 = time.time()

    for test_dir in sorted(TEST_DIR_TO_CLASS):
        files = sorted((TEST / test_dir).glob("*"))
        if limit_per_class:
            files = files[:limit_per_class]
        for f in files:
            try:
                with Image.open(f) as im:
                    x = preprocess(im)
            except Exception as e:
                print(f"  ! failed to read {f}: {e}", file=sys.stderr)
                continue
            out = sess.run([out_name], {inp_name: x})[0][0]
            total = float(out.sum())
            if 0.99 <= total <= 1.01:
                softmax_seen = True
            cls = int(np.argmax(out))
            conf = float(out[cls])
            pred = MODEL_CLASSES[cls]
            gt = TEST_DIR_TO_CLASS[test_dir]
            per_class[gt]["total"] += 1
            per_class[gt]["correct"] += int(pred == gt)
            confusion[gt][pred] = confusion[gt].get(pred, 0) + 1
            if pred != gt:
                low_conf.append({"file": f.name, "gt": gt, "pred": pred, "conf": round(conf, 4)})
            n += 1

    dt = time.time() - t0
    total_ok = sum(v["correct"] for v in per_class.values())
    total_n = sum(v["total"] for v in per_class.values())
    report = {
        "images": n,
        "seconds": round(dt, 1),
        "ms_per_image": round(dt / max(n, 1) * 1000, 1),
        "output_is_softmax": softmax_seen,
        "accuracy": round(total_ok / max(total_n, 1), 4),
        "per_class": {c: f"{v['correct']}/{v['total']}" for c, v in per_class.items()},
        "misclassified": low_conf[:40],
    }
    print(json.dumps(report, indent=2))
    (ROOT / "tools" / "ground_truth_report.json").write_text(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    sys.exit(main(limit))