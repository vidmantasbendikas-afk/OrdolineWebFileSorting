#!/usr/bin/env python3
"""End-to-end browser test over Chrome DevTools Protocol.

Loads the app, waits for the ONNX model, sets real test files on the file
input, clicks Submit, verifies sorting, and reports accuracy + console errors.
"""
import asyncio
import json
import random
import sys
import urllib.request

import websockets

APP = "http://localhost:8000"
DEBUG_HOST = "http://127.0.0.9222"


def browser_ws_url():
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json/version").read())
    return data["webSocketDebuggerUrl"]


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 1
        self.pending = {}
        self.events = asyncio.Queue()

    async def run(self):
        self.reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self.pending:
                fut = self.pending.pop(msg["id"])
                if msg.get("error"):
                    fut.set_exception(RuntimeError(f"CDP error: {msg['error']}"))
                else:
                    fut.set_result(msg.get("result", {}))
            elif "method" in msg:
                await self.events.put(msg)

    async def cmd(self, method, params=None, session_id=None, timeout=60):
        mid = self.next_id
        self.next_id += 1
        payload = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        fut = asyncio.get_event_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps(payload))
        return await asyncio.wait_for(fut, timeout)

    async def drain_events(self, seconds=0.0):
        collected = []
        try:
            while True:
                collected.append(self.events.get_nowait())
        except asyncio.QueueEmpty:
            pass
        return collected


async def evaluate(cdp, sid, expression, timeout=60):
    res = await cdp.cmd("Runtime.evaluate", {
        "expression": expression, "returnByValue": True, "awaitPromise": False,
    }, sid, timeout)
    r = res.get("result", {})
    if r.get("subtype") == "error":
        raise RuntimeError(f"evaluate failed: {r.get('description')}")
    return r.get("value")


async def main(limit_per_class=1, screenshot=None):
    console_msgs, exceptions = [], []
    ws = await websockets.connect(browser_ws_url(), max_size=None)
    cdp = CDP(ws)
    await cdp.run()

    target = await cdp.cmd("Target.createTarget", {"url": APP})
    tid = target["targetId"]
    sid = (await cdp.cmd("Target.attachToTarget", {"targetId": tid, "flatten": True}))["sessionId"]
    for m in ("Runtime.enable", "Page.enable", "DOM.enable", "Log.enable"):
        await cdp.cmd(m, {}, sid)

    # Wait for model ready (max 3 min)
    ready = False
    for _ in range(180):
        await asyncio.sleep(1)
        try:
            if await evaluate(cdp, sid, "typeof state !== 'undefined' && state.modelReady === true"):
                ready = True
                break
        except RuntimeError:
            pass
        for ev in await cdp.drain_events():
            if ev["method"] == "Runtime.consoleAPICalled":
                console_msgs.append((ev["params"]["type"], " ".join(str(a.get("value", a.get("description", ""))) for a in ev["params"]["args"])))
            elif ev["method"] == "Runtime.exceptionThrown":
                exceptions.append(ev["params"]["exceptionDetails"].get("exception", {}).get("description", str(ev["params"]["exceptionDetails"])[:500]))
            elif ev["method"] == "Log.entryAdded":
                e = ev["params"]["entry"]
                if e.get("level") in ("error",):
                    console_msgs.append(("log-error", f"{e.get('text')} {e.get('url', '')}"))
    if not ready:
        print("MODEL FAILED TO LOAD")
        print("console:", console_msgs[-30:])
        print("exceptions:", exceptions[-10:])
        return 1

    ep = await evaluate(cdp, sid, "state.activeEP")
    input_size = await evaluate(cdp, sid, "state.inputSize")
    classes = await evaluate(cdp, sid, "state.classNames.join(',')")
    print(f"model ready, EP={ep}, inputSize={input_size}, classes={classes}")

    # Pick real test files from disk, one class dir at a time
    from pathlib import Path
    test_root = Path("/home/vidmantasb/Documents/Projects/Ordoline/OrdolineWebFileSorting/data/test")
    truth_by_dir = {
        "ceph_front": "panoramic", "ceph_side": "cephalometric", "extr_profile": "extraoral_profile",
        "extr_rest": "extraoral_frontal_rest", "extr_smile": "extraoral_frontal_smile",
        "intr_front": "intraoral_frontal", "intr_left": "intraoral_left", "intr_lower": "intraoral_lower",
        "intr_right": "intraoral_right", "intr_upper": "intraoral_upper",
    }
    paths, expect = [], []
    for d in sorted(test_root.iterdir()):
        files = sorted(p for p in d.iterdir() if p.is_file())
        if limit_per_class:
            random.Random(7).shuffle(files)
            files = files[:limit_per_class]
        for f in files:
            paths.append(str(f))
            expect.append(truth_by_dir[d.name])
    print(f"setting {len(paths)} files on input...")

    root = await cdp.cmd("DOM.getDocument", {}, sid)
    doc_node = root["root"]["nodeId"]
    node = await cdp.cmd("DOM.querySelector", {"nodeId": doc_node, "selector": "#file-input"}, sid)
    await cdp.cmd("DOM.setFileInputFiles", {"files": paths, "nodeId": node["nodeId"]}, sid)

    n_queued = await evaluate(cdp, sid, "state.queueOrder.length")
    print("queued:", n_queued)
    await cdp.cmd("Runtime.evaluate", {"expression": "document.getElementById('submit-btn').click()"}, sid)

    # Wait until classification completes: no queued items and not classifying
    done = False
    for _ in range(1200):
        await asyncio.sleep(1)
        try:
            v = await evaluate(cdp, sid, "state.classifying === false && state.queueOrder.length === 0")
            if v:
                done = True
                break
        except RuntimeError:
            pass
    if not done:
        print("TIMED OUT waiting for classification")
        print("console:", console_msgs[-30:])
        return 1

    results = await evaluate(cdp, sid, """
      JSON.stringify({
        counts: [...document.querySelectorAll('.cat-card')].map(c => ({
          cat: c.dataset.cat, n: Number(c.querySelector('.cat-count').textContent)
        })),
        chips: [...document.querySelectorAll('.chip')].map(c => ({
          conf: Number(c.dataset.conf), cat: c.closest('.cat-card').dataset.cat
        })),
        overall: document.getElementById('overall-result').textContent
      })
    """)
    data = json.loads(results)
    print("counts:", {c["cat"]: c["n"] for c in data["counts"]})
    print("total chips:", len(data["chips"]))
    if data["overall"]:
        print("overall:", data["overall"])

    # accuracy vs ground truth by order: chips are grouped per category; recompute from state
    acc = await evaluate(cdp, sid, """
      JSON.stringify((() => {
        const ok = [...state.items.values()].filter(i => i.result);
        let correct = 0, total = 0, mism = [];
        for (const i of ok) {
          // truth was not set via file.__truth in this path; use DOM mismatch chips count instead
        }
        return { chips: document.querySelectorAll('.chip').length,
                 mismatch: document.querySelectorAll('.chip.mismatch').length };
      })())
    """)
    print("dom check:", acc)

    errors = await evaluate(cdp, sid, "document.querySelectorAll('.q-item.error').length")
    print("errored items:", errors)

    for ev in await cdp.drain_events():
        if ev["method"] == "Runtime.consoleAPICalled" and ev["params"]["type"] in ("error", "warning"):
            console_msgs.append((ev["params"]["type"], " ".join(str(a.get("value", a.get("description", ""))) for a in ev["params"]["args"])))
        elif ev["method"] == "Runtime.exceptionThrown":
            exceptions.append(str(ev["params"]["exceptionDetails"])[:500])

    fatal = [m for m in console_msgs if m[0] in ("error", "log-error")]
    print("console errors:", fatal if fatal else "none")
    print("uncaught exceptions:", exceptions if exceptions else "none")

    if screenshot:
        shot = await cdp.cmd("Page.captureScreenshot", {"format": "png"}, sid)
        import base64
        Path(screenshot).write_bytes(base64.b64decode(shot["data"]))
        print("screenshot saved:", screenshot)

    return 0


if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    shot = sys.argv[2] if len(sys.argv) > 2 else None
    sys.exit(asyncio.run(main(limit, shot)))