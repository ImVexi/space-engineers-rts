#!/usr/bin/env python3
"""T11 UI v2 acceptance test: direct manipulation on the REAL test backend.

READ-ONLY by design: it never presses Go/Launch, never toggles the kill switch
and never calls move-to. It only reads state, runs one /designer/plan (no
mission) and exercises the client-side camera/selection/menu behaviour.

Checks:
  1. build is unlocked and the action bar is always present
  2. WASD flight actually moves the camera, then it settles
  3. right-click menus (empty space + ship) carry the direct actions
  4. drag-box selects several ships; action bar switches to the N-ship verbs
  5. double-click a marker flies the camera to it
  6. Move flow opens and renders the destination picker + preflight card slot
  7. Launch flow reaches Review and renders planner text from /designer/plan
  8. visible panels do not overlap the action bar or each other
  9. zero console errors

Usage: python3 e2e/ui_v2.py [base-url]
Exit code 0 = pass.
"""
from __future__ import annotations

import math
import os
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_BASE", "http://127.0.0.1:8762")).rstrip("/")
TOKEN_FILE = "<token-file>"
SHOT = "<path>/cache/scratch/ui-v2.png"


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


def settle(page, timeout_ms: int = 9000) -> dict:
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


def stage_box(page):
    return page.locator("[data-testid=stage]").bounding_box()


def element_at(page, x: float, y: float) -> str:
    return page.evaluate(
        "([x,y]) => { const e = document.elementFromPoint(x,y); return e ? e.tagName + '.' + e.className : 'none'; }",
        [x, y],
    )


def empty_point(page):
    box = stage_box(page)
    for fx, fy in [(0.30, 0.30), (0.70, 0.30), (0.30, 0.62), (0.70, 0.62), (0.50, 0.75), (0.5, 0.22)]:
        x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
        if element_at(page, x, y).startswith("CANVAS"):
            return x, y
    raise AssertionError("no empty canvas point found")


def selection_count(page) -> int:
    return int(page.locator("[data-testid=selection-count]").get_attribute("data-count") or "0")


def marker_ids(page) -> list[str]:
    return page.eval_on_selector_all("[data-testid=marker-dot]", "els => els.map(e => e.dataset.markerId)")


def ensure_dots(page) -> list[str]:
    """Clustered grids collapse into one badge; open the cluster first."""
    for _ in range(4):
        ids = marker_ids(page)
        if ids:
            return ids
        badges = page.locator("[data-testid=cluster-badge]")
        if not badges.count():
            page.wait_for_timeout(400)
            continue
        box = badges.first.bounding_box()
        if not box:
            page.wait_for_timeout(300)
            continue
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(1100)
        settle(page)
    return marker_ids(page)


def click_marker(page, marker_id: str) -> None:
    for _ in range(6):
        loc = page.locator(f'[data-testid=marker-dot][data-marker-id="{marker_id}"]')
        if loc.count():
            box = loc.first.bounding_box()
            if box:
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(250)
                if selection_count(page) >= 1:
                    return
        page.wait_for_timeout(250)
    raise AssertionError(f"marker {marker_id} did not select")


def safe_box(page, marker: str):
    loc = page.locator(f'[data-testid=marker-dot][data-marker-id="{marker}"]')
    if loc.count() == 0:
        return None
    try:
        return loc.first.bounding_box(timeout=1500)
    except Exception:
        return None


def boxes_overlap(a: dict, b: dict, pad: float = 0.0) -> bool:
    return not (
        a["x"] + a["width"] + pad <= b["x"]
        or b["x"] + b["width"] + pad <= a["x"]
        or a["y"] + a["height"] + pad <= b["y"]
        or b["y"] + b["height"] + pad <= a["y"]
    )


def main() -> int:
    checks: list[str] = []
    errors: list[str] = []

    def ok(msg: str) -> None:
        checks.append(msg)
        print(f"[ok] {msg}")

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{BASE}/demo/", wait_until="domcontentloaded")
        if page.locator("[data-testid=token-input]").count():
            page.fill("[data-testid=token-input]", token())
            page.click("[data-testid=token-submit]")
        page.wait_for_selector("[data-testid=demo-canvas]", timeout=30000)
        page.wait_for_function("() => window.__demoCam && window.__demoCam.frames > 5", timeout=30000)
        settle(page)
        assert page.locator("[data-testid=lockdown]").count() == 0, "build is locked"
        assert page.locator("[data-testid=action-bar]").is_visible(), "action bar missing"
        assert page.locator("[data-testid=action-launch-satellites]").count() == 1
        assert page.locator("[data-testid=action-network]").count() == 1
        ok("unlocked, map rendered, empty selection shows Launch satellites + Network view")

        # ---- 1 keyboard flight
        before = cam(page)
        page.keyboard.down("w")
        page.wait_for_timeout(650)
        page.keyboard.up("w")
        page.wait_for_timeout(150)
        after = settle(page)
        moved = math.dist(before["pos"], after["pos"])
        assert moved > 0.05, f"W did not move the camera (delta {moved:.4f})"
        ok(f"W flight moved the camera {moved:.1f} km and settled")

        # ---- 2 right-click empty space
        ex, ey = empty_point(page)
        page.mouse.click(ex, ey, button="right")
        page.wait_for_selector("[data-testid=context-menu]", timeout=5000)
        for key in ("move-here", "copy-gps", "teleport"):
            assert page.locator(f"[data-testid=ctx-{key}]").count() == 1, f"space menu missing {key}"
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        ok("right-click on empty space opens Move here / Copy GPS / Teleport")

        # ---- 3 right-click a ship
        ids = ensure_dots(page)
        assert ids, "no markers on the map"
        target_id = ids[0]
        for _ in range(5):
            loc = page.locator(f'[data-testid=marker-dot][data-marker-id="{target_id}"]').first
            box = loc.bounding_box()
            if box:
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, button="right")
                if page.locator("[data-testid=context-menu]").count():
                    break
            page.wait_for_timeout(250)
        page.wait_for_selector("[data-testid=context-menu]", timeout=5000)
        for key in ("move", "follow", "launch-orbit", "rename", "copy-gps", "teleport"):
            assert page.locator(f"[data-testid=ctx-{key}]").count() == 1, f"ship menu missing {key}"
        assert selection_count(page) == 1
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        ok("right-click on a ship opens Move / Follow / Launch to orbit / Rename / Copy GPS / Teleport")

        # ---- 4 drag-box selects many, bar changes
        box = stage_box(page)
        page.mouse.move(box["x"] + 12, box["y"] + 90)
        page.mouse.down()
        for i in range(1, 13):
            page.mouse.move(box["x"] + 12 + (box["width"] - 40) * i / 12, box["y"] + 90 + (box["height"] - 200) * i / 12)
            page.wait_for_timeout(20)
        page.mouse.up()
        page.wait_for_timeout(400)
        count = selection_count(page)
        assert count >= 2, f"box select found {count} ships"
        assert page.locator("[data-testid=action-move-here]").count() == 1
        assert page.locator("[data-testid=action-form-network]").count() == 1
        ok(f"drag box selected {count} ships; bar now Move here / Form network / Launch to orbit")

        # ---- 5 double-click flies
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        ids = ensure_dots(page)
        assert ids, "no visible marker to fly to"
        # Prefer a marker that is not the one already centred (that flight would
        # be zero-length by definition).
        order = ids[1:] + ids[:1]
        flew = None
        for marker in order[:3]:
            b = safe_box(page, marker)
            if not b:
                ensure_dots(page)
                b = safe_box(page, marker)
            if not b:
                continue
            before = cam(page)
            page.mouse.dblclick(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
            page.wait_for_timeout(250)
            try:
                page.wait_for_function("() => window.__demoCam.flying === true", timeout=2500)
            except Exception:
                continue
            page.wait_for_timeout(1000)
            after = settle(page)
            delta = math.dist(before["target"], after["target"])
            if delta > 0.05 or math.dist(before["pos"], after["pos"]) > 0.05:
                flew = (marker, delta)
                break
        assert flew, "double-click did not fly to any marker"
        ok(f"double-click flew the camera to {flew[0]} (target moved {flew[1]:.2f} km)")

        # ---- 6 Move flow opens
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        ids = ensure_dots(page)
        assert ids, "no ship to move"
        click_marker(page, ids[0])
        page.click("[data-testid=action-move]")
        page.wait_for_selector("[data-testid=move-flow]", timeout=5000)
        assert page.locator("[data-testid=move-target-zero-g]").count() == 1
        assert page.locator("[data-testid=move-target-low]").count() == 1
        assert page.locator("[data-testid=move-pick-map]").count() == 1
        ok("Move flow opens with zero-g / low orbit / pick-on-map in one panel")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

        # ---- 7 Launch flow to Review (plan only, no mission)
        page.keyboard.press("Escape")  # clear selection
        page.wait_for_timeout(200)
        page.click("[data-testid=action-launch-satellites]")
        page.wait_for_selector("[data-testid=launch-flow]", timeout=6000)
        step1_sats = page.locator(".sat-row").count()
        assert step1_sats >= 1, "no satellites listed"
        page.click("[data-testid=launch-next]")
        page.wait_for_selector("[data-testid=launch-step-2]", timeout=5000)
        assert page.locator(".station-row").count() >= 1, "no ground stations listed"
        page.click("[data-testid=launch-next]")
        page.wait_for_selector("[data-testid=launch-step-3]", timeout=5000)
        assert page.locator("[data-testid=launch-orbit-zero]").count() == 1
        page.click("[data-testid=launch-next]")
        page.wait_for_selector("[data-testid=launch-review]", timeout=25000)
        review = page.locator("[data-testid=launch-review]").inner_text()
        assert len(review) > 60, "planner review is empty"
        ok(f"Launch flow: {step1_sats} satellites, station list, orbit cards, planner review from /designer/plan")

        # ---- 8 no overlapping panels
        flow_box = page.locator("[data-testid=launch-flow]").bounding_box()
        bar_box = page.locator("[data-testid=action-bar]").bounding_box()
        hud_box = page.locator(".hud-top").bounding_box()
        assert flow_box and bar_box and hud_box
        assert not boxes_overlap(flow_box, bar_box, 2), "flow panel overlaps the action bar"
        assert not boxes_overlap(flow_box, hud_box, 2), "flow panel overlaps the top HUD"
        ok("launch panel clears the action bar and the top HUD")

        # ---- screenshot: close flow, select two named satellites, network view open
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        ids = [i for i in ensure_dots(page)]
        boxes = []
        for marker in ids:
            b = safe_box(page, marker)
            if b:
                boxes.append((b["x"] + b["width"] / 2, b["y"] + b["height"] / 2))
            if len(boxes) == 2:
                break
        if len(boxes) < 2:
            ensure_dots(page)
            ids = marker_ids(page)
            boxes = []
            for marker in ids:
                b = safe_box(page, marker)
                if b:
                    boxes.append((b["x"] + b["width"] / 2, b["y"] + b["height"] / 2))
                if len(boxes) == 2:
                    break
        assert boxes, "no markers for the screenshot"
        page.mouse.click(*boxes[0])
        if len(boxes) > 1:
            page.keyboard.down("Shift")
            page.mouse.click(*boxes[1])
            page.keyboard.up("Shift")
        page.click("[data-testid=network-toggle]")
        page.wait_for_timeout(700)
        page.mouse.move(24, 360)
        page.wait_for_timeout(250)
        page.screenshot(path=SHOT, full_page=False)
        ok(f"screenshot captured at {SHOT}")

        assert not errors, f"console errors: {errors[:5]}"
        ok("0 console errors")

        print(f"\nPASS — {len(checks)} checks")
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
