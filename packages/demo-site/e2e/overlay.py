#!/usr/bin/env python3
"""Playwright check for the decluttered demo map (real backend, token from file).

Verifies:
  * stale grids hidden by default; header counts match the overlay
  * no two visible grid labels overlap; planet labels never cover grid labels
  * clustering at far zoom produces a badge with a count; badge click zooms
  * side-list row click flies the camera and selects the grid
  * zero console/page errors, screenshot for the owner

Run: python3 e2e/overlay.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8762/demo/"
TOKEN_FILE = Path("<token-file>")
SHOT = "<path>/cache/scratch/demo-after.png"
FAIL_SHOT = "<path>/cache/scratch/demo-overlay-fail.png"

IGNORED_CONSOLE = ("WebGL", "GPU", "THREE.WebGLRenderer", "favicon", "Failed to load resource")


def token() -> str:
    for line in TOKEN_FILE.read_text().splitlines():
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("RTS_TOKEN not found in token file")


def boxes(page, selector: str) -> list[dict]:
    return page.evaluate(
        """(sel) => Array.from(document.querySelectorAll(sel))
             .filter((el) => {
               const r = el.getBoundingClientRect();
               const s = getComputedStyle(el);
               return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
             })
             .map((el) => {
               const r = el.getBoundingClientRect();
               return {id: el.dataset.id || el.dataset.planet || el.textContent || '', x: r.x, y: r.y, w: r.width, h: r.height};
             })""",
        selector,
    )


def overlap(a: dict, b: dict, eps: float = 0.5) -> bool:
    return (
        a["x"] < b["x"] + b["w"] - eps
        and b["x"] < a["x"] + a["w"] - eps
        and a["y"] < b["y"] + b["h"] - eps
        and b["y"] < a["y"] + a["h"] - eps
    )


def check_labels(page, context: str, require: int = 1) -> tuple[int, int]:
    labels = boxes(page, "[data-testid=grid-label]")
    planets = boxes(page, "[data-testid=planet-label]")
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            if overlap(labels[i], labels[j]):
                raise AssertionError(f"{context}: grid labels overlap: {labels[i]} vs {labels[j]}")
    for planet in planets:
        for label in labels:
            if overlap(planet, label):
                raise AssertionError(f"{context}: planet label {planet} covers grid label {label}")
    if len(labels) < require:
        raise AssertionError(f"{context}: expected >= {require} grid labels, got {len(labels)}")
    print(f"[e2e] {context}: {len(labels)} grid labels / {len(planets)} planet labels, no overlap")
    return len(labels), len(planets)


def camera(page) -> tuple[float, float, float]:
    raw = page.get_by_test_id("map-overlay").get_attribute("data-camera") or "0,0,0"
    return tuple(float(v) for v in raw.split(","))  # type: ignore[return-value]


def camera_moved(before: tuple[float, float, float], after: tuple[float, float, float]) -> float:
    return sum((a - b) ** 2 for a, b in zip(before, after)) ** 0.5


def fail(page, message: str) -> None:
    try:
        page.screenshot(path=FAIL_SHOT, full_page=True)
        print(f"[e2e] screenshot: {FAIL_SHOT}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass
    raise AssertionError(message)


def wait_framed(page) -> None:
    page.get_by_test_id("map-overlay").wait_for()
    page.wait_for_function(
        "() => document.querySelector('[data-testid=map-overlay]')?.dataset.camera?.length > 0"
    )
    page.wait_for_timeout(1500)  # initial eased camera flight


def main() -> int:
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.set_default_timeout(45_000)
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text)
            if msg.type == "error" and not any(t in msg.text for t in IGNORED_CONSOLE)
            else None,
        )
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        print("[e2e] load")
        page.goto(BASE, wait_until="networkidle")
        if page.get_by_test_id("token-gate").count():
            page.get_by_test_id("token-input").fill(token())
            page.get_by_test_id("token-submit").click()
        wait_framed(page)

        badge = page.get_by_test_id("telemetry-badge")
        badge_text = badge.inner_text()
        print(f"[e2e] header: {badge_text!r}")
        m = re.search(r"(\d+)\s+live\s+·\s+(\d+)\s+stale", badge_text)
        assert m, f"header counts missing: {badge_text!r}"
        live, stale = int(m.group(1)), int(m.group(2))
        overlay = page.get_by_test_id("map-overlay")
        assert overlay.get_attribute("data-live") == str(live), "overlay live count disagrees with header"
        assert overlay.get_attribute("data-stale") == str(stale), "overlay stale count disagrees with header"
        if stale > 0:
            assert "(hidden)" in badge_text, "stale count is not marked hidden by default"
        assert page.locator('[data-testid=marker-dot][data-kind=stale]').count() == 0, "stale dots drawn while off"
        assert page.locator('[data-testid=cluster-badge].stale').count() == 0, "stale cluster drawn while off"
        print(f"[e2e] counts: {live} live · {stale} stale (hidden)")

        # --- 1. default view: no grid labels, planet labels sane -----------
        check_labels(page, "default view", require=0)

        # --- 2. selected + hovered labels stay apart (declutter) -----------
        positions = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-testid=marker-dot]')).map((e) => {
                 const r = e.getBoundingClientRect();
                 return {id: e.dataset.markerId, x: r.x + r.width / 2, y: r.y + r.height / 2};
               })"""
        )
        print(f"[e2e] default dots: {[p['id'] for p in positions]}")
        if len(positions) >= 2:
            from itertools import combinations
            from math import hypot

            a, b = max(
                combinations(positions, 2),
                key=lambda pair: hypot(pair[0]["x"] - pair[1]["x"], pair[0]["y"] - pair[1]["y"]),
            )
            page.locator(f'[data-testid=marker-dot][data-marker-id="{a["id"]}"]').click()
            page.wait_for_timeout(350)
            page.locator(f'[data-testid=marker-dot][data-marker-id="{b["id"]}"]').hover()
            page.wait_for_timeout(450)
            labels, _ = check_labels(page, "select+hover", require=1)
            roles = page.evaluate(
                "() => Array.from(document.querySelectorAll('[data-testid=grid-label]')).map(e=>e.dataset.role)"
            )
            print(f"[e2e] select+hover labels: {labels} roles={roles}")
            assert "selected" in roles, "selected grid lost its label"
            # Deselect so the following checks start from a clean map.
            page.locator('[data-testid=marker-dot][data-marker-id="' + a["id"] + '"]').click()
            page.wait_for_timeout(250)

        # --- 3. clustering at far zoom -------------------------------------
        page.get_by_test_id("toggle-stale").check()
        page.wait_for_timeout(600)
        assert "(hidden)" not in page.get_by_test_id("telemetry-badge").inner_text(), "toggle did not reveal stale"
        badges = page.locator("[data-testid=cluster-badge]")
        badge_count = badges.count()
        counts = [int(badges.nth(i).get_attribute("data-count") or 0) for i in range(badge_count)]
        stale_dots = page.locator('[data-testid=marker-dot][data-kind=stale]').count()
        print(f"[e2e] stale shown: {stale_dots} stale dots, {badge_count} cluster badges {counts}")
        assert badge_count > 0 and max(counts) >= 2, f"no multi-marker cluster badge: {counts}"
        assert sum(counts) + stale_dots > 0, "Show stale did not reveal any stale marker"
        assert page.locator("[data-testid=cluster-badge].stale").count() > 0, "stale clusters not styled stale"

        cam_before = camera(page)
        page.locator("[data-testid=cluster-badge].stale").nth(0).click()
        page.wait_for_timeout(1600)
        moved = camera_moved(cam_before, camera(page))
        print(f"[e2e] cluster click camera move: {moved:.1f} km")
        assert moved > 0.5, "cluster badge click did not zoom the camera"

        # --- 3. side-list click flies the camera and selects ----------------
        rows = page.locator("[data-testid^=grid-row-]")
        assert rows.count() > 0, "no grid rows in the side list"
        row_id = rows.nth(0).get_attribute("data-id")
        cam_before = camera(page)
        rows.nth(0).click()
        page.wait_for_timeout(1600)
        moved = camera_moved(cam_before, camera(page))
        print(f"[e2e] list row click camera move: {moved:.1f} km ({row_id})")
        assert moved > 0.5, "side-list row click did not fly the camera"
        assert page.locator(".grid-row.selected").count() == 1, "clicked row is not marked selected"
        assert (
            page.locator(f'[data-testid=grid-label][data-id="{row_id}"]').count() == 1
        ), "selected grid has no label after list focus"

        # --- 4. hover a second marker: two labels, still no overlap --------
        dots = page.locator("[data-testid=marker-dot]")
        print(f"[e2e] dots on screen after focus: {dots.count()}")
        hovered_id = None
        for i in range(dots.count()):
            marker_id = dots.nth(i).get_attribute("data-marker-id")
            if marker_id and marker_id != row_id:
                dots.nth(i).hover()
                hovered_id = marker_id
                break
        page.wait_for_timeout(450)
        label_count, _ = check_labels(page, "after focus", require=1)
        if hovered_id:
            hover_label = page.locator(f'[data-testid=grid-label][data-id="{hovered_id}"]')
            print(f"[e2e] hover {hovered_id}: label={'yes' if hover_label.count() else 'decluttered'} ({label_count} labels)")

        # --- 5. default view again for the owner screenshot ----------------
        page.get_by_test_id("toggle-stale").uncheck()
        page.wait_for_timeout(300)
        assert page.locator('[data-testid=marker-dot][data-kind=stale]').count() == 0
        page.reload(wait_until="networkidle")
        if page.get_by_test_id("token-gate").count():
            page.get_by_test_id("token-input").fill(token())
            page.get_by_test_id("token-submit").click()
        wait_framed(page)
        drawn = (
            page.locator("[data-testid=marker-dot]").count()
            + page.locator("[data-testid=cluster-badge]").count()
            + page.locator("[data-testid=planet-label]").count()
        )
        assert drawn > 0, "map drew nothing at all"
        check_labels(page, "reloaded view", require=0)
        page.screenshot(path=SHOT, full_page=True)
        print(f"[e2e] screenshot: {SHOT}")

        if page_errors:
            fail(page, f"page errors: {page_errors}")
        if console_errors:
            fail(page, f"console errors: {console_errors}")

        browser.close()

    print("[e2e] PASS: stale filter, counts, label declutter, clustering, list focus, 0 console errors")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PlaywrightTimeout as exc:
        print(f"[e2e] TIMEOUT: {exc}", file=sys.stderr)
        sys.exit(1)
    except AssertionError as exc:
        print(f"[e2e] FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
