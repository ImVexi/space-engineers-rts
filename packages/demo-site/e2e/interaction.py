#!/usr/bin/env python3
"""Playwright interaction test for the demo camera + selection fixes.

Runs against the REAL backend (token read from <token-file>,
never printed). Checks the five behaviours the owner reported broken:

  1. auto-framing happens once; a drag disables it for the session;
  2. list / marker focus flies once, then hands control back;
  3. nothing moves the camera on a poll (6 s = 3 polls);
  4. selection persists by id across polls, switches, and clears on empty space;
  5. planet A/B Connect clicks still work and are not hijacked by markers.

Usage: python3 e2e/interaction.py [base-url]
Exit code 0 = pass.
"""
from __future__ import annotations

import math
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_BASE", "http://127.0.0.1:8762")).rstrip("/")
TOKEN_FILE = "<token-file>"
POLL_WAIT_MS = 2000
POLLS = 3
SETTLE_MS = 700


def token() -> str:
    for line in open(TOKEN_FILE, encoding="utf-8"):
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("RTS_TOKEN missing from token.env")


def dist(a, b) -> float:
    return math.dist(a, b)


def cam(page) -> dict:
    probe = page.evaluate(
        """() => { const c = window.__demoCam; return c ? {pos: [...c.pos], target: [...c.target],
             flying: c.flying, autoFrameDisabled: c.autoFrameDisabled, frames: c.frames} : null; }"""
    )
    assert probe, "__demoCam probe missing (camera rig not mounted)"
    return probe


def settle(page, timeout_ms: int = 8000) -> dict:
    """Wait for OrbitControls damping to stop coasting (software GL is slow, so
    a release can coast for a few hundred ms). Returns the settled pose."""
    deadline = time.time() + timeout_ms / 1000
    prev = cam(page)
    while time.time() < deadline:
        page.wait_for_timeout(250)
        now = cam(page)
        if not now["flying"] and dist(now["pos"], prev["pos"]) < 0.01:
            return now
        prev = now
    return cam(page)


def wait_idle(page, timeout_ms: int = 5000) -> None:
    page.wait_for_function("() => window.__demoCam && window.__demoCam.flying === false", timeout=timeout_ms)


def canvas_box(page):
    return page.locator("[data-testid=demo-canvas]").bounding_box()


def element_at(page, x: float, y: float) -> str:
    return page.evaluate(
        """([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : 'none'; }""",
        [x, y],
    )


def empty_point(page):
    box = canvas_box(page)
    for fx, fy in [(0.32, 0.28), (0.68, 0.28), (0.3, 0.68), (0.7, 0.68), (0.5, 0.5), (0.5, 0.8), (0.5, 0.2)]:
        x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
        if element_at(page, x, y).startswith("CANVAS"):
            return x, y
    raise AssertionError("no empty canvas point found")


def drag(page, x: float, y: float, dx: float = 150.0, dy: float = 55.0) -> None:
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(x + dx * i / 12, y + dy * i / 12)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(SETTLE_MS)


def click_marker(page, marker_id: str) -> None:
    """Click a marker by id, re-locating it each attempt (markers are
    re-projected every frame, so coordinates are only valid for one instant)."""
    for _ in range(5):
        loc = page.locator(f'[data-testid=marker-dot][data-marker-id="{marker_id}"]')
        if loc.count():
            box = loc.first.bounding_box()
            if box:
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(350)
                if page.locator("[data-testid=node-panel]").get_attribute("data-node-id") == marker_id:
                    return
        page.wait_for_timeout(300)
    raise AssertionError(f"marker {marker_id} did not become the selection")


def main() -> int:
    checks: list[str] = []
    console_errors: list[str] = []

    def ok(msg: str) -> None:
        checks.append(msg)
        print(f"[ok] {msg}")

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        page.goto(f"{BASE}/demo/", wait_until="domcontentloaded")
        if page.locator("[data-testid=token-input]").count():
            page.fill("[data-testid=token-input]", token())
            page.click("[data-testid=token-submit]")
        page.wait_for_selector("[data-testid=demo-canvas]", timeout=30000)
        page.wait_for_selector("[data-testid=map-overlay]", timeout=30000)
        page.wait_for_function("() => window.__demoCam && window.__demoCam.frames > 5", timeout=30000)
        wait_idle(page)
        canvas_handle = page.locator("[data-testid=demo-canvas]").element_handle()
        ok("loaded, auto-frame flight finished")

        # --- 1. drag then 3 polls: camera must not move -------------------
        cam0 = cam(page)
        assert cam0["autoFrameDisabled"] is False, "auto-framing reported disabled before any input"
        x, y = empty_point(page)
        drag(page, x, y)
        after_drag = settle(page)
        assert dist(after_drag["pos"], cam0["pos"]) > 0.5, "drag did not move the camera at all"
        assert after_drag["autoFrameDisabled"] is True, "drag did not disable auto-framing"
        ok(f"drag moved camera {dist(after_drag['pos'], cam0['pos']):.1f} km and disabled auto-framing")

        time.sleep(POLLS * POLL_WAIT_MS / 1000)
        after_polls = cam(page)
        drift = dist(after_polls["pos"], after_drag["pos"])
        assert drift < 0.05, f"camera drifted {drift:.3f} km over {POLLS} polls (snap-back)"
        assert dist(after_polls["target"], after_drag["target"]) < 0.05, "camera target moved during polls"
        assert after_polls["frames"] > after_drag["frames"], "render loop stopped"
        ok(f"camera unchanged across {POLLS} polls (drift {drift:.4f} km)")

        # --- 2. list click flies once, then user keeps control -------------
        row = page.locator("[data-testid=live-grids-panel] .grid-row").first
        assert row.count() > 0, "no live grid rows to click"
        row_id = row.get_attribute("data-id")
        before = cam(page)
        row.click()
        page.wait_for_function("() => window.__demoCam.flying === true", timeout=3000)
        wait_idle(page)
        landed = settle(page)
        assert dist(landed["pos"], before["pos"]) > 0.5, "list click did not fly the camera"
        assert page.locator(f"[data-testid=node-panel][data-node-id='{row_id}']").count() == 1, "list click did not select the grid"
        page.wait_for_timeout(POLL_WAIT_MS + 400)
        assert dist(cam(page)["pos"], landed["pos"]) < 0.05, "camera moved after the flight landed (still chasing)"
        ok("list click flew once and released the camera")

        x, y = empty_point(page)
        drag(page, x, y, dx=-120, dy=40)
        held = settle(page)
        time.sleep(POLLS * POLL_WAIT_MS / 1000)
        drift = dist(cam(page)["pos"], held["pos"])
        assert drift < 0.05, f"camera drifted {drift:.3f} km after focus+drag"
        ok(f"drag after focus holds across polls (drift {drift:.4f} km)")

        # --- 3. marker A -> marker B, inspector follows and persists ------
        dots = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-testid=marker-dot]')).map(e => {
                 const r = e.getBoundingClientRect();
                 return {id: e.dataset.markerId, x: r.x + r.width / 2, y: r.y + r.height / 2}; })"""
        )
        assert len(dots) >= 2, f"need 2 markers, found {len(dots)}"
        pair = max(
            ((a, b) for i, a in enumerate(dots) for b in dots[i + 1:]),
            key=lambda ab: math.dist((ab[0]["x"], ab[0]["y"]), (ab[1]["x"], ab[1]["y"])),
        )
        first, second = pair

        click_marker(page, first["id"])
        ok(f"marker click selected {first['id'][:18]}…")
        click_marker(page, second["id"])
        for i in range(POLLS):
            page.wait_for_timeout(POLL_WAIT_MS)
            shown = page.locator("[data-testid=node-panel]").get_attribute("data-node-id")
            assert shown == second["id"], f"selection reset on poll {i + 1}: {shown} != {second['id']}"
        ok(f"selection switched to {second['id'][:18]}… and survived {POLLS} polls")

        # --- 4. click empty space clears the selection --------------------
        x, y = empty_point(page)
        page.mouse.click(x, y)
        page.wait_for_timeout(400)
        assert page.locator("[data-testid=node-panel]").count() == 0, "empty-space click did not clear the inspector"
        assert page.locator("[data-testid=node-panel-empty]").count() == 1, "inspector did not fall back to its empty state"
        page.wait_for_timeout(POLL_WAIT_MS)
        assert page.locator("[data-testid=node-panel-empty]").count() == 1, "cleared selection came back after a poll"
        ok("empty-space click clears the selection and it stays cleared")

        # --- 5. planet A -> B clicks still work ---------------------------
        def zoom(notches: int) -> None:
            """OrbitControls dollies 5% per wheel event. Synthetic events keep
            this deterministic (a real close-up needs hundreds of notches)."""
            page.evaluate(
                """([n]) => {
                    const c = document.querySelector('[data-testid=demo-canvas]');
                    for (let i = 0; i < n; i += 1) {
                      c.dispatchEvent(new WheelEvent('wheel', {deltaY: 800, clientX: 10, clientY: 10,
                        bubbles: true, cancelable: true}));
                    }
                }""",
                [notches],
            )
            page.wait_for_timeout(350)
            settle(page)

        def on_screen_planets() -> list[dict]:
            """Planet labels whose true projected centre is inside the canvas."""
            raw = page.evaluate(
                """() => Array.from(document.querySelectorAll('[data-testid=planet-label]')).map(e => ({
                     name: e.textContent.trim(), cx: Number(e.dataset.cx), cy: Number(e.dataset.cy)}))"""
            )
            box = canvas_box(page)
            out = []
            for p in raw:
                x, y = p["cx"], p["cy"]
                if 2 < x < box["width"] - 2 and 2 < y < box["height"] - 2:
                    out.append({**p, "x": box["x"] + x, "y": box["y"] + y})
            return out

        def click_planet(name: str, tag: str, zoom_hint: int = 0) -> bool:
            if zoom_hint:
                zoom(zoom_hint)
            target = next((p for p in on_screen_planets() if p["name"] == name), None)
            if not target:
                return False
            if not element_at(page, target["x"], target["y"]).startswith("CANVAS"):
                return False
            page.mouse.click(target["x"], target["y"])
            page.wait_for_timeout(500)
            return tag in (page.locator(f"[data-testid=planet-{name}]").get_attribute("class") or "")

        order = page.evaluate(
            "() => Array.from(document.querySelectorAll('.planet-list button[data-testid^=planet-]'))"
            ".map(e => e.dataset.testid.replace('planet-',''))"
        )
        a = (on_screen_planets() or [{}])[0].get("name") or order[0]
        assert click_planet(a, "planet-a"), f"3D click did not select planet A ({a})"
        # Fly out one step so a second planet's disc is on screen, then click it.
        b = next(
            (n for n in order if n != a and any(p["name"] == n for p in on_screen_planets())),
            None,
        ) or next((n for n in order if n != a), None)
        for hint in (0, 14, 22, 30):
            if click_planet(b, "planet-b", zoom_hint=hint):
                break
            if page.locator(f"[data-testid=planet-{b}]").get_attribute("class") == "planet-a":
                reset()
        assert "planet-b" in (page.locator(f"[data-testid=planet-{b}]").get_attribute("class") or ""), (
            f"3D click did not select planet B ({b}); A={a} visible={[p['name'] for p in on_screen_planets()]}"
        )
        assert page.locator("[data-testid=connect-open]").is_enabled(), "Connect not armed after A+B clicks"
        ok(f"planet 3D clicks still arm Connect ({a} → {b})")

        # --- 6. controls / canvas were never re-created -------------------
        same = page.evaluate("(el) => el === document.querySelector('[data-testid=demo-canvas]')", canvas_handle)
        assert same, "canvas element was replaced (Three roots/controls re-created) during polling"
        assert cam(page)["frames"] > 0 and page.locator("[data-testid=map-overlay]").count() == 1
        ok("same canvas/controls instance after all polls (no remount, no flicker)")

        assert not console_errors, f"console errors: {console_errors[:3]}"
        ok("0 console errors")
        browser.close()

    print(f"\nPASS — {len(checks)} checks against {BASE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
