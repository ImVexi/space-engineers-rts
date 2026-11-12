#!/usr/bin/env python3
"""Read-only Playwright check for the groups / constellation / layers batch.

Runs against the built site (vite preview proxies /api to the live test backend).
Creates one group, opens the constellation panel, changes the count, checks the
coverage popover and the links toggle, then asserts panels never overlap and
the console stayed clean. Never approves or applies a mission.
"""
from __future__ import annotations

import os
import re
import sys
import time

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE = os.environ.get("DEMO_BASE", "http://127.0.0.1:8764")
SHOT = "<path>/cache/scratch/frontend-batch-fail.png"
IGNORED = ("WebGL", "GPU", "THREE.WebGLRenderer", "favicon", "Failed to load resource")


def token() -> str:
    raw = open("<token-file>", encoding="utf-8").read()
    match = re.search(r"RTS_TOKEN\s*=\s*\"?([^\"\n]+)\"?", raw)
    if not match:
        raise SystemExit("no RTS_TOKEN in <token-file>")
    return match.group(1).strip()


def main() -> int:
    errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.set_default_timeout(20_000)
        t0 = time.time()

        def step(msg: str) -> None:
            print(f"[e2e] {time.time() - t0:6.1f}s {msg}", flush=True)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not any(t in m.text for t in IGNORED) else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.add_init_script(f"localStorage.setItem('se-rts-demo-token', {token()!r})")

        try:
            page.goto(BASE, wait_until="domcontentloaded")
            page.get_by_test_id("stage").wait_for()
            page.get_by_test_id("live-count").wait_for()
            step("map up")

            # ---- groups: pick 3 fleet rows, group them, click the chip ----
            page.get_by_test_id("fleet-toggle").click()
            page.get_by_test_id("fleet-panel").wait_for()
            picks = page.get_by_test_id("fleet-pick")
            picks.nth(0).check()
            picks.nth(1).check()
            picks.nth(2).check()
            page.get_by_test_id("fleet-group-as").click()
            page.get_by_test_id("group-create-form").wait_for()
            page.get_by_test_id("group-name").fill("Batch Group")
            page.get_by_test_id("group-create-save").click()
            chip = page.get_by_test_id("group-chip").first
            chip.wait_for()
            assert chip.get_attribute("data-count") == "3", chip.get_attribute("data-count")
            selected = page.evaluate("window.__demoSel || []")
            assert len(selected) == 3, selected
            step("group of 3 created, 3 selected")

            page.get_by_test_id("group-active").wait_for()
            chip.click()  # chip toggles: off, then on again
            chip.click()
            page.get_by_test_id("group-active").wait_for()
            for tid in ("group-move", "group-launch", "group-constellation"):
                assert page.get_by_test_id(tid).is_visible(), tid
            bar = page.get_by_test_id("group-action-bar")
            assert bar.is_visible(), "group action bar"
            for tid in ("groupbar-move", "groupbar-launch", "groupbar-station", "groupbar-stop"):
                assert page.get_by_test_id(tid).is_visible(), tid
            step("chip selects all; bulk actions visible")

            # ---- constellation: change count, ghost + cost update ----
            page.get_by_test_id("group-constellation").click()
            page.get_by_test_id("constellation-panel").wait_for()
            cost_before = page.get_by_test_id("constellation-cost").inner_text()
            page.get_by_test_id("constellation-count").fill("5")
            page.wait_for_function("window.__demoPreview && window.__demoPreview.slots === 5", timeout=20_000)
            cost_after = page.get_by_test_id("constellation-cost").inner_text()
            assert cost_after != cost_before, (cost_before, cost_after)
            assert "ships" in cost_after and "total" in cost_after, cost_after
            step(f"ghost preview 5 slots; cost: {cost_after}")
            page.get_by_test_id("constellation-close").click()

            # ---- layers: coverage heatmap + why popover ----
            page.get_by_test_id("layers-toggle").click()
            page.get_by_test_id("layers-panel").wait_for()
            page.get_by_test_id("coverage-toggle").check()
            page.get_by_test_id("coverage-pct").wait_for(timeout=30_000)
            assert page.get_by_test_id("coverage-legend").is_visible()
            layer = page.evaluate("window.__demoCoverageLayer")
            if page.evaluate("window.__demoWebgl !== false"):
                assert layer and layer["cells"] > 0, layer
            red = page.evaluate("window.__demoCoverage.redCell")
            if red:
                page.evaluate(f"window.__demoPickCell({red['latDeg']}, {red['lonDeg']}, 'EarthLike')")
            else:
                page.evaluate("window.__demoPickCell(-5, -5, 'EarthLike')")
            print("[e2e] red cell picked" if red else "[e2e] no red cell at 10 deg (100% union coverage); used a covered cell")
            popover = page.get_by_test_id("coverage-popover")
            popover.wait_for()
            text = popover.inner_text()
            assert "uncovered" in text or "covered" in text, text
            assert page.get_by_test_id("coverage-plan-fix").is_visible()
            step(f"coverage popover: {text.splitlines()[0]}")
            page.get_by_test_id("coverage-plan-fix").click()
            page.get_by_test_id("constellation-panel").wait_for()
            assert page.get_by_test_id("constellation-sentence").inner_text().startswith("Places")
            page.get_by_test_id("constellation-close").click()

            # ---- links toggle ----
            page.get_by_test_id("layers-toggle").click()
            page.get_by_test_id("layers-panel").wait_for()
            page.get_by_test_id("link-mode-both").click()
            assert page.evaluate("window.__demoLinks.mode") == "both"
            soon = page.get_by_test_id("links-coming-soon")
            if soon.is_visible():
                assert "coming soon" in soon.inner_text().lower()
                step("links route 404 -> coming-soon note, no fake edges")
            else:
                count = page.get_by_test_id("link-count").inner_text()
                step(f"links live: {count}")
            page.get_by_test_id("link-mode-current").evaluate("el => el.click()")
            page.wait_for_timeout(300)
            assert page.evaluate("window.__demoLinks.mode") == "current"

            # ---- panels never overlap ----
            boxes = []
            for tid in ("groups-panel", "layers-panel", "fleet-panel", "constellation-panel"):
                loc = page.get_by_test_id(tid)
                if loc.count() and loc.is_visible():
                    boxes.append((tid, loc.bounding_box()))
            for i in range(len(boxes)):
                for j in range(i + 1, len(boxes)):
                    a, b = boxes[i][1], boxes[j][1]
                    if not a or not b:
                        continue
                    overlap = not (a["x"] + a["width"] <= b["x"] or b["x"] + b["width"] <= a["x"] or a["y"] + a["height"] <= b["y"] or b["y"] + b["height"] <= a["y"])
                    assert not overlap, (boxes[i][0], boxes[j][0])
            step(f"no overlapping panels ({len(boxes)} visible)")

            page.wait_for_timeout(600)
            assert not page_errors, page_errors
            assert not errors, errors
            step("0 console errors")
            return 0
        except (AssertionError, PlaywrightTimeout) as exc:
            page.screenshot(path=SHOT, full_page=True)
            print(f"[e2e] FAIL: {exc}\n[e2e] screenshot: {SHOT}", file=sys.stderr)
            if errors or page_errors:
                print(f"[e2e] console: {errors}\n[e2e] pageerrors: {page_errors}", file=sys.stderr)
            return 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
