#!/usr/bin/env python3
"""Playwright acceptance for the camera CONTEXT rig (T59).

Checks, against a real browser (dev server or deployed site):
  1. a single click only selects — context key and camera position unchanged;
  2. double-clicking a ship enters its level (ship context) instead of silently
     re-aiming an orbit on the selection;
  3. orbiting a ship on the planet's SIDE keeps roll ~0 relative to local up
     and holds the camera's local elevation (the skewed world-Y arc is gone);
  4. 'look' (right-drag in fly mode) turns the view in place: position AND
     target unchanged, the look offset non-zero;
  5. Esc pops exactly one level and restores that level's saved pose;
  6. 0 camera jumps over 10 s of idle;
  7. the zoom-scaled pick radius shrinks as you zoom in.

Usage: python3 e2e/camera_contexts.py [base-url]
Default base is the local dev server http://127.0.0.1:8764 (never rebuilds dist).
Exit code 0 = pass.
"""
from __future__ import annotations

import math
import os
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_BASE", "http://127.0.0.1:8764")).rstrip("/")
TOKEN_FILE = "<token-file>"
SHOT = "<path>/cache/scratch/camera-contexts.png"


def token() -> str:
    for line in open(TOKEN_FILE, encoding="utf-8"):
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("RTS_TOKEN missing from token.env")


def cam(page) -> dict:
    probe = page.evaluate(
        """() => { const c = window.__demoCam; return c ? {
             pos: [...c.pos], target: [...c.target], yaw: c.yaw, pitch: c.pitch,
             distance: c.distance, flying: c.flying, frames: c.frames,
             jumps: c.jumps.length, mode: c.mode, context: c.context,
             contextKind: c.contextKind, up: [...c.up], rollDeg: c.rollDeg,
             pickRadiusPx: c.pickRadiusPx, look: { ...c.look } } : null; }"""
    )
    assert probe, "__demoCam probe missing"
    return probe


def ctx(page) -> dict:
    probe = page.evaluate("() => window.__demoContext ? JSON.parse(JSON.stringify(window.__demoContext)) : null")
    assert probe, "__demoContext probe missing"
    return probe


def pick(page) -> dict:
    return page.evaluate("() => window.__demoPick ? JSON.parse(JSON.stringify(window.__demoPick)) : null")


def sel(page) -> list[str]:
    return page.evaluate("() => window.__demoSel || []")


def settle(page, timeout_ms: int = 12000) -> dict:
    page.wait_for_function("() => window.__demoCam && window.__demoCam.flying === false", timeout=timeout_ms)
    prev = cam(page)
    waited = 0
    while waited < timeout_ms:
        page.wait_for_timeout(200)
        waited += 200
        now = cam(page)
        if math.dist(now["pos"], prev["pos"]) < 1e-3:
            return now
        prev = now
    return cam(page)


def dist(a, b) -> float:
    return math.dist(a, b)


def drag(page, x, y, dx, dy, button="left", steps=18) -> None:
    page.mouse.move(x, y)
    page.mouse.down(button=button)
    for i in range(1, steps + 1):
        page.mouse.move(x + dx * i / steps, y + dy * i / steps)
        page.wait_for_timeout(12)
    page.mouse.up(button=button)
    page.wait_for_timeout(300)


def marker_boxes(page) -> list[tuple[str, dict]]:
    boxes = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-testid=marker-dot]')).map((el) => {
             const r = el.getBoundingClientRect();
             return { id: el.getAttribute('data-marker-id'), x: r.x, y: r.y, w: r.width, h: r.height };
           })"""
    )
    return [(b["id"], b) for b in boxes if b["id"] and b["w"] > 0]


def centre(box) -> tuple[float, float]:
    return box["x"] + box["w"] / 2, box["y"] + box["h"] / 2


def canvas_point(page) -> tuple[float, float]:
    box = page.locator("[data-testid=demo-canvas]").bounding_box()
    for fx, fy in [(0.5, 0.55), (0.42, 0.5), (0.6, 0.6), (0.35, 0.45), (0.68, 0.42)]:
        x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
        tag = page.evaluate(
            "([x,y]) => { const e = document.elementFromPoint(x,y); return e ? e.tagName : 'none'; }", [x, y]
        )
        if tag == "CANVAS":
            return x, y
    raise AssertionError("no empty canvas point found")


def main() -> int:
    checks: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []

    def ok(msg: str) -> None:
        checks.append(msg)
        print(f"[ok] {msg}")

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        if page.locator("[data-testid=token-input]").count():
            page.fill("[data-testid=token-input]", token())
            page.click("[data-testid=token-submit]")
        page.wait_for_selector("[data-testid=demo-canvas]", timeout=30000)
        page.wait_for_function("() => window.__demoCam && window.__demoCam.frames > 5", timeout=30000)
        page.wait_for_function("() => window.__demoContext && window.__demoContext.depth >= 1", timeout=30000)
        settle(page)
        assert page.locator("[data-testid=breadcrumb]").count() == 1, "breadcrumb missing"
        base_ctx = ctx(page)
        base_pose = cam(page)
        ok(f"booted on level '{base_ctx['label']}' ({base_ctx['key']}), breadcrumb depth {base_ctx['depth']}")

        # ---- 1. single click only selects -----------------------------------
        entries = marker_boxes(page)
        assert entries, "no ship markers on the map"
        ship_id, ship_box = entries[0]
        cx, cy = centre(ship_box)
        before = cam(page)
        page.mouse.click(cx, cy)
        page.wait_for_timeout(350)
        after = cam(page)
        assert sel(page), "click on a marker did not select"
        assert ctx(page)["key"] == base_ctx["key"], f"single click changed the camera level: {ctx(page)['key']}"
        assert dist(before["pos"], after["pos"]) < 1e-4, f"single click moved the camera {dist(before['pos'], after['pos'])} km"
        ok("single click selects without changing the camera level or position")

        # Hover highlight before the click, from the same radius.
        page.mouse.move(cx, cy)
        page.wait_for_timeout(300)
        hovered = pick(page)["hover"]
        assert hovered == ship_id, f"hover highlight did not follow the pick ({hovered} vs {ship_id})"
        assert page.locator("[data-testid=hover-ring]").count() == 1, "no hover ring drawn for the hovered ship"
        ok("hover highlights the ship the click would pick (same radius)")

        # A near-miss click inside the (scaled) pick radius also only selects.
        near = None
        for dx, dy in [(16, 0), (0, 16), (-16, 0), (0, -16), (14, 12), (-14, -12)]:
            cand = (cx + dx, cy + dy)
            tag = page.evaluate(
                "([x,y]) => { const e=document.elementFromPoint(x,y); return e ? e.tagName : 'none'; }", list(cand)
            )
            if tag == "CANVAS":
                near = cand
                break
        if near:
            before = cam(page)
            page.mouse.click(*near)
            page.wait_for_timeout(300)
            assert ctx(page)["key"] == base_ctx["key"], "near-miss click changed the camera level"
            assert dist(before["pos"], cam(page)["pos"]) < 1e-4, "near-miss click moved the camera"
            ok("a near-miss click inside the pick radius still only selects")
        else:
            skipped.append("near-miss click (no marker-free offset point on canvas)")

        # ---- 2. double-click enters the SHIP level --------------------------
        cx, cy = centre(ship_box)
        page.mouse.dblclick(cx, cy)
        page.wait_for_function("() => window.__demoContext.kind === 'ship'", timeout=8000)
        ship_ctx = ctx(page)
        assert ship_ctx["depth"] == max(2, base_ctx["depth"] + 1), f"unexpected depth {ship_ctx['depth']}"
        assert ship_ctx["breadcrumb"][-1].startswith("SAT") or ship_ctx["label"], "breadcrumb has no ship label"
        ok(f"double-click entered '{ship_ctx['label']}' (depth {ship_ctx['depth']}, up {tuple(round(v,3) for v in ship_ctx['up'])})")

        # ---- 3. orbit about local up: roll ~0, local elevation held --------
        page.wait_for_function("() => window.__demoCam.flying === false", timeout=8000)
        settled = settle(page)
        up = settled["up"]
        pivot = ship_ctx["pivot"]
        off0 = [settled["pos"][i] - pivot[i] for i in range(3)]
        elev0 = sum(off0[i] * up[i] for i in range(3))
        length0 = math.hypot(*off0)
        assert length0 > 0, "camera is on the pivot"
        rolls: list[float] = []
        elevations: list[float] = []
        vx, vy = canvas_point(page)
        page.mouse.move(vx, vy)
        page.mouse.down()
        for i in range(1, 25):
            page.mouse.move(vx + 420 * i / 24, vy)
            page.wait_for_timeout(25)
            probe = cam(page)
            rolls.append(probe["rollDeg"])
            off = [probe["pos"][k] - pivot[k] for k in range(3)]
            elevations.append(sum(off[k] * up[k] for k in range(3)))
        page.mouse.up()
        page.wait_for_timeout(250)
        worst_roll = max(abs(r) for r in rolls)
        worst_elev = max(abs(e - elev0) for e in elevations)
        assert worst_roll < 1.0, f"roll drifted to {worst_roll:.2f} deg while orbiting a side ship"
        assert worst_elev < 0.02 * length0, f"local elevation moved {worst_elev:.4f} km (skewed frame?)"
        ok(f"orbit around a side ship: roll <= {worst_roll:.2f} deg, local elevation held within {worst_elev*1000:.0f} m")

        # ---- 4. look turns in place (fly mode) -----------------------------
        page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")
        page.keyboard.press("Tab")
        try:
            page.wait_for_function("() => window.__demoCam.mode === 'fly'", timeout=3000)
        except Exception:
            page.keyboard.press("Tab")  # one retry; focus may have been stolen
            page.wait_for_function("() => window.__demoCam.mode === 'fly'", timeout=3000)
        assert cam(page)["mode"] == "fly", "Tab did not enter fly mode"
        before = cam(page)
        lx, ly = canvas_point(page)
        drag(page, lx, ly, -220, 40, button="right")
        after = cam(page)
        assert dist(before["pos"], after["pos"]) < 1e-4, f"look moved the camera {dist(before['pos'], after['pos'])} km"
        assert dist(before["target"], after["target"]) < 1e-4, "look orbited the target instead of turning in place"
        assert abs(after["look"]["yaw"] - before["look"]["yaw"]) > 0.5, "look did not turn the view"
        ok(f"right-drag look turned {abs(after['look']['yaw']-before['look']['yaw']):.2f} rad in place (target fixed)")
        page.keyboard.press("Tab")
        page.wait_for_function("() => window.__demoCam.mode === 'orbit'", timeout=5000)

        # ---- 5. Esc restores each saved pose -------------------------------
        # Re-seed: planet level, note pose, ship level, note pose, then walk out.
        page.evaluate("() => window.__demoEnterContext({ kind: 'planet', id: 'EarthLike', upMode: 'gravity' })")
        page.wait_for_function("() => window.__demoContext.kind === 'planet'", timeout=8000)
        planet_pose = settle(page)
        planet_ctx = ctx(page)
        page.evaluate("() => window.__demoEnterContext({ kind: 'ship', id: window.__demoSel[0], upMode: 'gravity' })")
        page.wait_for_function("() => window.__demoContext.kind === 'ship'", timeout=8000)
        settle(page)
        # Move a little so "restored" is not just "unchanged".
        drag(page, *canvas_point(page), 90, 30, button="left")
        moved = cam(page)
        page.keyboard.press("Escape")
        page.wait_for_function("() => window.__demoContext.kind === 'planet'", timeout=8000)
        back = cam(page)
        assert ctx(page)["label"] == planet_ctx["label"], "Esc landed on the wrong level"
        for key in ("yaw", "pitch", "distance"):
            assert abs(back[key] - planet_pose[key]) < 1e-6, f"planet pose {key} not restored ({back[key]} vs {planet_pose[key]})"
        assert dist(back["pos"], planet_pose["pos"]) < 1e-5, "planet camera position not restored"
        ok(f"Esc from a ship restored the planet pose (distance {back['distance']:.3f} km, yaw {back['yaw']:.3f})")
        page.keyboard.press("Escape")
        page.wait_for_function("() => window.__demoContext.depth === 1", timeout=8000)
        top = settle(page)
        assert dist(top["pos"], base_pose["pos"]) < 1e-3, (
            f"system pose not restored by the second Esc: {top['pos']} vs {base_pose['pos']} "
            f"(d={dist(top['pos'], base_pose['pos']):.4f} km, yaw {top['yaw']:.4f}/{base_pose['yaw']:.4f}, "
            f"dist {top['distance']:.4f}/{base_pose['distance']:.4f}, level {ctx(page)['key']})"
        )
        ok("Esc again restored the system level pose")

        # ---- 6. no jumps over 10 s idle ------------------------------------
        jumps_before = cam(page)["jumps"]
        frames_before = cam(page)["frames"]
        page.wait_for_timeout(10_000)
        final = cam(page)
        assert final["frames"] > frames_before + 30, "render loop stalled during the idle window"
        assert final["jumps"] == jumps_before, f"camera jumped {final['jumps'] - jumps_before} time(s) while idle"
        ok(f"0 camera jumps over 10 s idle ({final['frames'] - frames_before} frames)")

        # ---- 7. zoom-scaled pick radius ------------------------------------
        page.evaluate("() => window.__demoEnterContext({ kind: 'planet', id: 'EarthLike', upMode: 'gravity' })")
        page.wait_for_timeout(400)
        settle(page)
        far = cam(page)
        box = page.locator("[data-testid=demo-canvas]").bounding_box()
        mid = (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.move(*mid)
        for _ in range(6):
            page.mouse.wheel(0, -240)
            page.wait_for_timeout(120)
        page.wait_for_timeout(400)
        near = cam(page)
        assert near["distance"] < far["distance"], f"wheel did not zoom in ({far['distance']} -> {near['distance']} km)"
        assert near["pickRadiusPx"] < far["pickRadiusPx"], (
            f"pick radius did not shrink when zooming in ({far['pickRadiusPx']} -> {near['pickRadiusPx']})"
        )
        assert 13.9 <= near["pickRadiusPx"] <= 28.1, f"pick radius out of bounds: {near['pickRadiusPx']}"
        ok(f"pick radius scales with zoom: {far['pickRadiusPx']} px at {far['distance']:.0f} km -> {near['pickRadiusPx']} px at {near['distance']:.0f} km")

        # ---- 8. multi-node disambiguation list ------------------------------
        # Ranking several hits is unit-tested (tests/pickShips.test.ts); here we
        # drive the real list UI with two known ids and prove that picking from
        # it is an explicit context entry.
        ids: list[str] = []
        for sel_attr in page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-testid=cluster-badge]')).map(e => e.getAttribute('data-ids'))"""
        ) or []:
            ids.extend((sel_attr or "").split(","))
        ids = [i for i in ids if i]
        if len(ids) < 2:
            ids = [b[0] for b in marker_boxes(page)]
        assert len(ids) >= 2, f"need two ship ids for the pick list, found {ids}"
        a_id, b_id = ids[0], ids[1]
        page.evaluate("(ids) => window.__demoShowPick(ids)", [a_id, b_id])
        page.wait_for_selector("[data-testid=pick-list]", timeout=5000)
        rows = page.locator("[data-testid=pick-item]")
        rendered = rows.count()
        assert rendered == 2, f"pick list rendered {rendered} rows for 2 candidates"
        page.click(f'[data-testid=pick-item][data-pick-id="{b_id}"]')
        page.wait_for_function("() => window.__demoContext.kind === 'ship'", timeout=8000)
        assert sel(page) == [b_id], f"list pick selected {sel(page)} instead of {b_id}"
        assert ctx(page)["stack"][-1] == f"ship:{b_id}", "list pick did not enter the picked ship level"
        ok(f"pick list rendered {rendered} candidates; choosing one selected and entered ship:{b_id[:14]}…")
        page.evaluate("() => window.__demoJumpLevel(0)")
        page.wait_for_function("() => window.__demoContext.depth === 1", timeout=8000)

        page.screenshot(path=SHOT)
        assert not errors, f"console errors: {errors[:3]}"
        browser.close()

    print("\n".join(f"[skip] {s}" for s in skipped))
    print(f"\n{len(checks)} checks passed, {len(skipped)} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
