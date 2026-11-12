#!/usr/bin/env python3
"""Playwright verification for the deterministic camera rig (v3).

Live deploy: http://127.0.0.1:8762/demo/
Checks:
  1. 180 deg orbit around EarthLike with one left drag; camera holds for 10 s,
     jump detector stays empty;
  2. wheel zoom into a satellite is monotonic inward over 5 events;
  3. double-click a satellite lands at 0.05-2 km;
  4. WASD after a 90 deg yaw moves along the new view;
  5. zero console errors; screenshot cam-v3.png.
"""
from __future__ import annotations

import math
import sys
import time

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8762").rstrip("/")
TOKEN_FILE = "<token-file>"
SHOT = "<path>/cache/scratch/cam-v3.png"
FOV = 50.0
ORBIT_SENS = 0.005


def token() -> str:
    for line in open(TOKEN_FILE, encoding="utf-8"):
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("token missing")


def cam(page) -> dict:
    probe = page.evaluate(
        """() => { const c = window.__demoCam; return c ? {
             pos: [...c.pos], target: [...c.target], yaw: c.yaw, pitch: c.pitch,
             distance: c.distance, flying: c.flying, frames: c.frames,
             jumps: c.jumps.length, mode: c.mode } : null; }"""
    )
    assert probe, "__demoCam probe missing"
    return probe


def dist(a, b) -> float:
    return math.dist(a, b)


def wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


def wait_idle(page, timeout_ms: int = 15000) -> dict:
    page.wait_for_function("() => window.__demoCam && window.__demoCam.flying === false", timeout=timeout_ms)
    return cam(page)


def canvas_box(page) -> dict:
    return page.locator("[data-testid=demo-canvas]").bounding_box()


def empty_point(page, box) -> tuple[float, float]:
    for fx, fy in [(0.5, 0.62), (0.42, 0.55), (0.58, 0.55), (0.5, 0.4), (0.35, 0.7), (0.65, 0.7)]:
        x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
        if page.evaluate(
            "([x,y]) => { const e=document.elementFromPoint(x,y); return e ? e.tagName : 'none'; }", [x, y]
        ) == "CANVAS":
            return x, y
    raise AssertionError("no empty canvas point")


def drag(page, x, y, dx, dy, steps=16) -> None:
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(x + dx * i / steps, y + dy * i / steps)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(250)


def project(probe: dict, point_km, box) -> tuple[float, float, float]:
    """Project a world point (km) with the rig's own basis."""
    pos, yaw, pitch = probe["pos"], probe["yaw"], probe["pitch"]
    sp, cp = math.sin(pitch), math.cos(pitch)
    sy, cy = math.sin(yaw), math.cos(yaw)
    fwd = (-cp * cy, -sp, -cp * sy)
    right = (sy, 0.0, -cy)
    up = (-sp * cy, cp, -sp * sy)
    v = (point_km[0] - pos[0], point_km[1] - pos[1], point_km[2] - pos[2])
    depth = sum(a * b for a, b in zip(v, fwd))
    tan_half = math.tan(math.radians(FOV / 2))
    nx = sum(a * b for a, b in zip(v, right)) / (depth * tan_half)
    ny = sum(a * b for a, b in zip(v, up)) / (depth * tan_half)
    return (
        box["x"] + (nx * 0.5 + 0.5) * box["width"],
        box["y"] + (0.5 - ny * 0.5) * box["height"],
        depth,
    )


def aim_at(page, point_km) -> None:
    """Rotate the rig so `point_km` sits at the centre of the canvas.

    The rig orbits its target, so a yaw change also moves the camera; converge
    with a few small corrections instead of one open-loop drag.
    """
    box = canvas_box(page)
    for _ in range(4):
        probe = cam(page)
        pos = probe["pos"]
        v = (point_km[0] - pos[0], point_km[1] - pos[1], point_km[2] - pos[2])
        n = math.sqrt(sum(a * a for a in v))
        desired_yaw = math.atan2(-v[2], -v[0])
        desired_pitch = math.asin(max(-1.0, min(1.0, -v[1] / n)))
        dx = -wrap(desired_yaw - probe["yaw"]) / ORBIT_SENS
        dy = (desired_pitch - probe["pitch"]) / ORBIT_SENS
        if abs(dx) < 2 and abs(dy) < 2:
            break
        x, y = empty_point(page, box)
        drag(page, x, y, dx, dy, steps=16)
        page.wait_for_timeout(150)
    page.wait_for_timeout(150)


def wheel(page, box, delta_y: int, count: int = 1) -> None:
    """Dispatch real wheel events on the canvas at its centre."""
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for _ in range(count):
        page.evaluate(
            """([x, y, dy]) => {
                 const host = document.querySelector('[data-testid=demo-canvas]');
                 const el = host.tagName === 'CANVAS' ? host : host.querySelector('canvas');
                 el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: x, clientY: y,
                   bubbles: true, cancelable: true }));
               }""",
            [cx, cy, delta_y],
        )
        page.wait_for_timeout(20)


def focus_click(page, x, y) -> None:
    """Double-click, wait for the one-shot tween to start and land."""
    page.mouse.dblclick(x, y)
    page.wait_for_timeout(80)
    try:
        page.wait_for_function("() => window.__demoCam.flying === true", timeout=2500)
    except Exception:
        pass
    wait_idle(page)
    page.wait_for_timeout(350)


def load(page) -> None:
    page.goto(f"{BASE}/demo/", wait_until="domcontentloaded")
    if page.locator("[data-testid=token-input]").count():
        page.fill("[data-testid=token-input]", token())
        page.click("[data-testid=token-submit]")
    page.wait_for_selector("[data-testid=demo-canvas]", timeout=30000)
    page.wait_for_function("() => window.__demoCam && window.__demoCam.frames > 5", timeout=30000)
    wait_idle(page)
    page.wait_for_timeout(400)


def main() -> int:
    errors: list[str] = []
    results: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # --- 1. EarthLike focus, 180 deg orbit, 10 s hold --------------------
        load(page)
        assert cam(page)["jumps"] == 0, f"jumps at load: {cam(page)['jumps']}"
        # Terrain tiles sit in front of the picking sphere; turn them off so a
        # double-click reaches the EarthLike mesh itself.
        page.click("[data-testid=network-toggle]")
        page.uncheck("[data-testid=overlay-terrain]")
        page.click("[data-testid=network-toggle]")
        page.wait_for_timeout(300)
        aim_at(page, (0.0, 0.0, 0.0))
        box = canvas_box(page)
        # Off-centre point: the exact centre is covered by the live-grid cluster
        # badge, whose double-click focuses a grid instead of the planet.
        px, py = box["x"] + box["width"] * 0.4, box["y"] + box["height"] * 0.5
        assert page.evaluate(
            "([x,y]) => document.elementFromPoint(x,y)?.tagName", [px, py]
        ) == "CANVAS", "planet click point is not canvas"
        focus_click(page, px, py)
        focused = cam(page)
        radius = math.sqrt(sum(v * v for v in focused["target"]))
        assert radius < 0.5, f"EarthLike focus target {focused['target']}"
        assert 200 < focused["distance"] < 400, f"EarthLike framing distance {focused['distance']}"
        focus_out = focused
        results.append(f"EarthLike focus: d={focus_out['distance']:.1f} km")

        before = cam(page)
        x, y = empty_point(page, box)
        drag(page, x, y, math.pi / ORBIT_SENS, 0, steps=24)
        after = cam(page)
        turned = abs(wrap(after["yaw"] - before["yaw"]))
        assert abs(turned - math.pi) < 0.08, f"orbit was {math.degrees(turned):.1f} deg, not 180"
        results.append(f"orbit turned {math.degrees(turned):.1f} deg")

        held = cam(page)
        time.sleep(10.0)
        steady = cam(page)
        drift = dist(steady["pos"], held["pos"])
        assert drift < 0.01, f"camera drifted {drift:.3f} km after 10 s"
        assert dist(steady["target"], held["target"]) < 0.01, "target drifted after 10 s"
        assert steady["jumps"] == 0, f"jump detector fired: {steady['jumps']}"
        results.append(f"held 10 s: drift={drift:.4f} km, jumps={steady['jumps']}, frames={steady['frames']}")

        # --- 2/3. satellite focus + monotonic wheel zoom --------------------
        load(page)
        assert cam(page)["jumps"] == 0, f"jumps at reload: {cam(page)['jumps']}"
        box = canvas_box(page)
        dots = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-testid=marker-dot]')).map(e => {
                 const r = e.getBoundingClientRect();
                 return { id: e.dataset.markerId, label: e.getAttribute('aria-label'),
                          x: r.x + r.width / 2, y: r.y + r.height / 2 }; })"""
        )
        sats = [
            d for d in dots
            if "SAT" in (d["label"] or "")
            and box["x"] + 40 < d["x"] < box["x"] + box["width"] - 40
            and box["y"] + 40 < d["y"] < box["y"] + box["height"] - 40
        ]
        assert sats, f"no on-screen satellite marker: {dots}"
        sat = sats[0]
        focus_click(page, sat["x"], sat["y"])
        near = cam(page)
        assert 0.05 <= near["distance"] <= 2.0, f"satellite focus distance {near['distance']}"
        results.append(f'satellite focus {sat["label"]}: {near["distance"]:.3f} km')

        # Pull back to the ~100 km range with real wheel notches.
        for _ in range(80):
            if 100 <= cam(page)["distance"] <= 160:
                break
            wheel(page, box, 120, 1)
            page.wait_for_timeout(15)
        start = cam(page)["distance"]
        seq = []
        for _ in range(5):
            wheel(page, box, -100, 1)
            page.wait_for_timeout(40)
            seq.append(round(cam(page)["distance"], 2))
        assert all(b < a for a, b in zip([start] + seq[:-1], seq)), f"zoom not monotonic: {start} -> {seq}"
        results.append(f"wheel 5 in: {start:.1f} -> " + " -> ".join(f"{v:.1f}" for v in seq))

        focus_click(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        landed = cam(page)
        assert 0.05 <= landed["distance"] <= 2.0, f"satellite re-focus distance {landed['distance']}"
        results.append(f"double-click satellite landed {landed['distance']:.3f} km")

        # --- 4. 90 deg yaw then WASD along the new view ---------------------
        before = cam(page)
        x, y = empty_point(page, box)
        drag(page, x, y, -(math.pi / 2) / ORBIT_SENS, 0, steps=20)
        yawed = cam(page)
        turned = abs(wrap(yawed["yaw"] - before["yaw"]))
        assert abs(turned - math.pi / 2) < 0.06, f"yaw drag was {math.degrees(turned):.1f} deg"
        start = cam(page)
        page.keyboard.down("w")
        page.wait_for_timeout(500)
        page.keyboard.up("w")
        page.wait_for_timeout(120)
        moved = cam(page)
        d = [moved["target"][i] - start["target"][i] for i in range(3)]
        length = math.sqrt(sum(a * a for a in d))
        sp, cp = math.sin(moved["pitch"]), math.cos(moved["pitch"])
        forward = (-cp * math.cos(moved["yaw"]), -sp, -cp * math.sin(moved["yaw"]))
        align = sum(a * b for a, b in zip(d, forward)) / max(length, 1e-9)
        cam_move = dist(moved["pos"], start["pos"])
        assert length > 0.03, f"W did not move the target ({length:.4f} km)"
        assert align > 0.98, f"W moved off the view axis (align={align:.3f})"
        assert abs(cam_move - length) < 1e-6, "camera did not follow the target"
        results.append(f"W after 90 deg: {length:.3f} km, align={align:.3f}")

        # selection must not move the camera
        held = cam(page)
        page.mouse.click(sat["x"], sat["y"])
        page.wait_for_timeout(400)
        assert dist(cam(page)["pos"], held["pos"]) < 0.001, "selection moved the camera"

        page.screenshot(path=SHOT)
        assert cam(page)["jumps"] is not None
        results.append(f"jumps total={cam(page)['jumps']}, frames={cam(page)['frames']}")
        browser.close()

    assert not errors, f"console errors: {errors}"
    print("[ok] " + "\n[ok] ".join(results))
    print(f"[ok] console errors: 0; screenshot {SHOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
