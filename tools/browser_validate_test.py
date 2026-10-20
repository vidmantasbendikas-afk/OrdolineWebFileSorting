#!/usr/bin/env python3
"""Test the built-in 'Load test images' validation path over CDP."""
import asyncio
import json
import urllib.request

import websockets

APP = "http://localhost:8000"


def browser_ws_url():
    return json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json/version").read())["webSocketDebuggerUrl"]


async def main():
    ws = await websockets.connect(browser_ws_url(), max_size=None)
    mid = 0
    pending = {}

    async def reader():
        async for raw in ws:
            m = json.loads(raw)
            if "id" in m and m["id"] in pending:
                pending.pop(m["id"]).set_result(m.get("result", {}))

    rt = asyncio.create_task(reader())

    async def cmd(method, params=None, session_id=None, timeout=120):
        nonlocal mid
        mid += 1
        p = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            p["sessionId"] = session_id
        fut = asyncio.get_event_loop().create_future()
        pending[mid] = fut
        await ws.send(json.dumps(p))
        return await asyncio.wait_for(fut, timeout)

    async def ev(expression, session_id, timeout=120):
        r = await cmd("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": False}, session_id, timeout)
        if r.get("result", {}).get("subtype") == "error":
            raise RuntimeError(r["result"].get("description"))
        return r.get("result", {}).get("value")

    target = await cmd("Target.createTarget", {"url": APP})
    sid = (await cmd("Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}))["sessionId"]
    for m in ("Runtime.enable", "Page.enable", "Log.enable"):
        await cmd(m, {}, sid)

    for _ in range(180):
        await asyncio.sleep(1)
        try:
            if await ev("typeof state !== 'undefined' && state.modelReady === true", sid):
                break
        except RuntimeError:
            pass

    await ev("document.getElementById('test-count').value = '1'", sid)
    await ev("document.getElementById('validate-btn').click()", sid)
    print("clicked validate; waiting for auto-submit to finish...")

    for _ in range(600):
        await asyncio.sleep(1)
        try:
            if await ev("state.classifying === false && state.queueOrder.length === 0", sid):
                break
        except RuntimeError:
            pass

    overall = await ev("document.getElementById('overall-result').textContent", sid)
    badges = await ev("[...document.querySelectorAll('.acc-badge')].map(b => b.closest('.cat-card').dataset.cat + ':' + b.textContent).join(' ')", sid)
    mismatch = await ev("document.querySelectorAll('.chip.mismatch').length", sid)
    chips = await ev("document.querySelectorAll('.chip').length", sid)
    errors = await ev("document.querySelectorAll('.q-item.error').length", sid)
    print("overall:", overall)
    print("badges:", badges)
    print("chips:", chips, "mismatch chips:", mismatch, "errored:", errors)

    # regression: queue section hidden when empty
    hidden = await ev("document.getElementById('queue').classList.contains('hidden')", sid)
    print("queue hidden after run:", hidden)
    return 0


asyncio.run(main())