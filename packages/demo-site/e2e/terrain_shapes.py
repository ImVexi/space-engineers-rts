#!/usr/bin/env python3
"""T14 e2e: TEST-world terrain + real ship shapes at the live telemetry pose.

READ-ONLY: it only reads /api/demo/state, /api/demo/world/* and /api/demo/terrain/*
through the site's own session; it never moves a ship, never toggles the kill
switch and never approves a mission.

Checks:
  1. focus (the bug that kept grids at LOD 'far'): requested == applied camera
     distance, the flight actually runs, userTookOver stays false
  2. focusing BASE-01 reaches LOD 'near' and draws exactly block_count instances
  3. the model sits at the live telemetry position (<= 5 m), not the save pose
  4. the HTML dot for a drawn grid is hidden (no marker over the hull)
  5. low over EarthLike (<= 25 km altitude) the map renders > 20 SETR tiles
  6. 'Real ship shapes' and 'Colour by function' change the rendered pixels
  7. zero console errors
  8. screenshot <path>/cache/scratch/ui-terrain.png (terrain + satellites)

Usage: python3 e2e/terrain_shapes.py [base-url]
Exit 0 = pass.
"""
from __future__ import annotations

import io
import math
import os
import sys

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_BASE", "http://127.0.0.1:8762")).rstrip("/")
TOKEN_FILE = "<token-file>"
SHOT = "<path>/cache/scratch/ui-terrain.png"
FAIL_SHOT = "<path>/cache/scratch/e2e-terrain-fail.png"

IGNORED_CONSOLE = ("WebGL", "GPU", "THREE.WebGLRenderer", "favicon", "Failed to load resource")


def token() -> str:
    for line in open(TOKEN_FILE, encoding="utf-8"):
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("RTS_TOKEN missing from token.env")


def cam(page) -> dict:
    probe = page.evaluate(
        """() => { const c = window.__demoCam; return c ? {pos: [...c.pos], target: [...c.target],
             flying: c.flying, frames: c.frames} : null; }"""
    )
    assert probe, "__demoCam probe missing"
    return probe


def settle(page, timeout_ms: int = 12000) -> dict:
    deadline = timeout_ms / 1000
    prev = cam(page)
    waited = 0.0
    while waited < deadline:
        page.wait_for_timeout(200)
        waited += 0.2
        now = cam(page)
        if not now["flying"] and math.dist(now["pos"], prev["pos"]) < 0.01:
            return now
        prev = now
    return cam(page)


def wait_for(page, script: str, description: str, timeout_s: float = 45.0) -> object:
    steps = int(timeout_s / 0.25)
    for _ in range(steps):
        value = page.evaluate(script)
        if value:
            return value
        page.wait_for_timeout(250)
    raise AssertionError(f"timed out waiting for {description}")


def stage_mean(page, box) -> float:
    img = Image.open(io.BytesIO(page.screenshot(clip=box))).convert("RGB")
    return float(np.asarray(img, dtype=np.float32).mean())


def main() -> int:
    tok = token()
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.set_default_timeout(45_000)
        page.add_init_script(f"try {{ localStorage.setItem('se-rts-demo-token', {tok!r}); }} catch (e) {{}}")

        page.on(
            "console",
            lambda msg: console_errors.append(msg.text)
            if msg.type == "error" and not any(t in msg.text for t in IGNORED_CONSOLE)
            else None,
        )
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        print("[t14] load site")
        page.goto(f"{BASE}/demo/", wait_until="networkidle")
        page.get_by_test_id("live-count").wait_for()
        page.get_by_test_id("demo-canvas").wait_for()
        settle(page)

        state = page.request.get(f"{BASE}/api/demo/state", headers={"authorization": f"Bearer {tok}"}).json()
        nodes = {n["name"]: n for n in state["nodes"]}
        base = nodes.get("BASE-01")
        assert base, "BASE-01 missing from live telemetry"
        assert len(state["nodes"]) < 60, f"state still carries {len(state['nodes'])} nodes (archived rows leaked in)"
        tel = state["telemetry"]
        print(f"[t14] state nodes={len(state['nodes'])} fresh={tel.get('freshCount')} "
              f"archived={tel.get('archivedCount')} total={tel.get('gridCount')}")

        manifest = page.request.get(
            f"{BASE}/api/demo/world/manifest", headers={"authorization": f"Bearer {tok}"}
        ).json()
        grids = {g["id"]: g for g in manifest["grids"]}
        base_raw = base["id"].removeprefix("grid:")
        assert base_raw in grids, "BASE-01 is not in the TEST-world save manifest"

        sats = [n for n in state["nodes"] if n["name"].startswith("SAT-L-") and n["id"].removeprefix("grid:") in grids]
        sat = sats[0] if sats else None
        if sat:
            print(f"[t14] satellite {sat['name']} blocks={grids[sat['id'].removeprefix('grid:')]['block_count']}")

        # 1) focus BASE-01: the flight must be honoured exactly (this is the T14 bug)
        print("[t14] focus BASE-01")
        page.evaluate("(id) => window.__demoFocusNode(id)", base["id"])
        settle(page)
        flog = wait_for(page, "() => (window.__demoFocusLog || []).length", "focus log", 10)
        last = page.evaluate("() => window.__demoFocusLog[window.__demoFocusLog.length - 1]")
        print(f"[t14] focus {last['id']} from={last['fromKm']} km requested={last['requestedKm']} km "
              f"applied={last['appliedKm']} km tookOver={last['userTookOverNow']}")
        assert last["id"] == base["id"], f"focus log id {last['id']} != {base['id']}"
        assert abs(last["appliedKm"] - last["requestedKm"]) < 0.01, (
            f"camera landed at {last['appliedKm']} km, requested {last['requestedKm']} km"
        )
        assert last["requestedKm"] < 3.0, f"grid focus distance {last['requestedKm']} km is not close enough"
        assert last["userTookOverNow"] is False, "a stray automation event latched userTookOver"

        # 2/3) BASE-01 blocks at the live pose
        info = wait_for(
            page,
            f"""() => {{ const s = window.__demoShapes?.[{base_raw!r}];
                 return s && s.level === 'near' && s.instances > 0 ? s : null; }}""",
            "BASE-01 block instances",
            60,
        )
        expected = grids[base_raw]["block_count"]
        print(f"[t14] BASE-01 LOD={info['level']} instances={info['instances']} expected={expected}")
        assert info["level"] == "near", f"BASE-01 LOD is {info['level']}, expected near"
        assert int(info["instances"]) == int(expected), (
            f"block instance count {info['instances']} != block_count {expected}"
        )
        fresh = page.request.get(f"{BASE}/api/demo/state", headers={"authorization": f"Bearer {tok}"}).json()
        live = next(n for n in fresh["nodes"] if n["id"] == base["id"])
        want = (live.get("telemetry") or {}).get("pos") or live["position"]
        got = info["pos"]
        drift = math.dist((want["x"], want["y"], want["z"]), (got["x"], got["y"], got["z"]))
        print(f"[t14] BASE-01 pose drift vs live telemetry: {drift:.2f} m")
        assert drift <= 5.0, f"shape pose is {drift:.1f} m from live telemetry"

        # 4) no duplicate HTML dot over a drawn hull
        assert page.locator(f'[data-marker-id="{base["id"]}"]').count() == 0, "marker dot still drawn over the hull"

        # 5) low over EarthLike: > 20 terrain tiles
        camnow = cam(page)
        altitude_km = math.dist(camnow["pos"], [0, 0, 0]) - 59.4
        tiles = wait_for(page, "() => (window.__seMap?.terrain?.tiles ?? 0) > 20 ? window.__seMap.terrain.tiles : 0", "terrain tiles", 90)
        print(f"[t14] altitude={altitude_km:.2f} km terrain tiles={tiles}")
        assert altitude_km <= 25.0, f"altitude {altitude_km:.1f} km is not a low pass"
        assert int(tiles) > 20, f"only {tiles} terrain tiles rendered"

        box = page.get_by_test_id("stage").bounding_box()
        assert box, "stage box missing"

        # 6a) 'Real ship shapes' toggles the block models
        page.get_by_test_id("network-toggle").click()
        before_shapes = stage_mean(page, box)
        page.get_by_test_id("overlay-shapes").uncheck()
        page.wait_for_timeout(900)
        after_shapes = stage_mean(page, box)
        page.get_by_test_id("overlay-shapes").check()
        page.wait_for_timeout(900)
        print(f"[t14] shapes toggle brightness {before_shapes:.2f} -> {after_shapes:.2f}")
        assert abs(before_shapes - after_shapes) > 0.1, "turning shapes off changed nothing"

        # 6b) 'Colour by function' changes block colours
        page.evaluate("() => window.__demoFocusNode(window.__demoSel && window.__demoSel[0])")
        page.wait_for_timeout(400)
        page.get_by_test_id("overlay-blockByFunction").check()
        page.wait_for_timeout(1200)
        fn_mean = stage_mean(page, box)
        page.get_by_test_id("overlay-blockByFunction").uncheck()
        page.wait_for_timeout(1200)
        paint_mean = stage_mean(page, box)
        print(f"[t14] colour-by-function brightness {paint_mean:.2f} <-> {fn_mean:.2f}")
        assert abs(fn_mean - paint_mean) > 0.05, "colour-by-function changed no pixels"

        # 6c) terrain toggle removes the ground
        before = stage_mean(page, box)
        page.get_by_test_id("overlay-terrain").uncheck()
        page.wait_for_timeout(900)
        after = stage_mean(page, box)
        page.get_by_test_id("overlay-terrain").check()
        page.wait_for_timeout(600)
        print(f"[t14] terrain toggle brightness {before:.2f} -> {after:.2f}")
        assert abs(before - after) > 1.0, "terrain toggle changed almost nothing"
        page.get_by_test_id("network-toggle").click()

        # 8) screenshot: back to BASE-01, then one gentle pull-back to ~0.8 km so
        #    the block-built base, the neighbouring satellite labels and the
        #    terrain surface all share the frame. (At the 0.2 km focus distance
        #    the 20 m base fills the view but its neighbours are outside it.)
        page.evaluate("(id) => window.__demoFocusNode(id)", base["id"])
        settle(page)
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        for _ in range(60):
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(40)
            if math.dist(cam(page)["pos"], cam(page)["target"]) > 0.75:
                break
        page.wait_for_timeout(5000)
        page.screenshot(path=SHOT)
        print(f"[t14] screenshot {SHOT}")
        print("[t14] camera dist at shot: %.2f km, tiles %s" % (
            math.dist(cam(page)["pos"], cam(page)["target"]),
            page.evaluate("() => window.__seMap?.terrain?.tiles"),
        ))

        if page_errors:
            raise AssertionError(f"page errors: {page_errors[:3]}")
        if console_errors:
            raise AssertionError(f"console errors: {console_errors[:3]}")
        print("[t14] PASS")
        browser.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        try:
            with sync_playwright() as p2:
                b = p2.chromium.launch(headless=True)
                pg = b.new_page(viewport={"width": 1500, "height": 950})
                pg.goto(f"{BASE}/demo/", wait_until="networkidle")
                pg.wait_for_timeout(1500)
                pg.screenshot(path=FAIL_SHOT, full_page=True)
                b.close()
                print(f"[t14] failure screenshot {FAIL_SHOT}", file=sys.stderr)
        except Exception:  # noqa: BLE001
            pass
        raise
