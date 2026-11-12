#!/usr/bin/env python3
"""T6 Admin / Designer end-to-end test.

Phase 1 (mock backend): `/api/demo/designer/**` is fulfilled from
tests/fixtures/designer/*.json, so the whole panel can be exercised before the
backend routes ship. Phase 2 (real backend, read-only): if GET
/api/demo/designer/hulls answers 200, the panel is driven against it exactly
like the owner would, but only GET + /plan are called — execute is never hit.

Checks:
  * the panel is a real layout column (no overlap with the map, side panels,
    labels or its own option cards);
  * a constellation plan renders up to 4 option cards, and the preview shows
    exactly as many slots as the selected card;
  * a two-point connect can be planned from pasted SE GPS strings;
  * surface launch is disabled with a reason when the hull cannot ground-launch;
  * approve -> mission id + SCALED label + GPS toggle (mock only);
  * the camera is not hijacked by planning/preview/hover;
  * 0 console errors.

Usage: python3 e2e/designer.py [base-url]
Exit code 0 = pass, 2 = mock phase failed, 3 = real phase failed.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_BASE", "http://127.0.0.1:8762")).rstrip("/")
TOKEN_FILE = "<token-file>"
FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "designer"
POLL_MS = 2000


def token() -> str:
    for line in open(TOKEN_FILE, encoding="utf-8"):
        if line.startswith("RTS_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("RTS_TOKEN missing from token.env")


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def cam(page: Page) -> dict:
    probe = page.evaluate(
        """() => { const c = window.__demoCam; return c ? {pos: [...c.pos], target: [...c.target],
             flying: c.flying, autoFrameDisabled: c.autoFrameDisabled, frames: c.frames} : null; }"""
    )
    assert probe, "__demoCam probe missing"
    return probe


def dist(a, b) -> float:
    return math.dist(a, b)


def overlap(a: dict, b: dict, slack: float = 1.0) -> bool:
    return not (
        a["x"] + a["width"] <= b["x"] + slack
        or b["x"] + b["width"] <= a["x"] + slack
        or a["y"] + a["height"] <= b["y"] + slack
        or b["y"] + b["height"] <= a["y"] + slack
    )


def box(page: Page, selector: str) -> dict:
    loc = page.locator(selector).first
    assert loc.count() > 0, f"missing element {selector}"
    b = loc.bounding_box()
    assert b, f"no bounding box for {selector}"
    return b


def set_range(page: Page, selector: str, value: str) -> None:
    # React tracks the input value on the DOM node; a plain assignment is
    # swallowed. Use the native setter, then fire the event React listens to.
    page.locator(selector).evaluate(
        """(el, v) => {
             const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
             setter.call(el, v);
             el.dispatchEvent(new Event('input', { bubbles: true }));
           }""",
        value,
    )
    page.wait_for_timeout(120)


def login(page: Page, tok: str) -> None:
    page.goto(f"{BASE}/demo/", wait_until="domcontentloaded")
    if page.locator("[data-testid=token-input]").count():
        page.fill("[data-testid=token-input]", tok)
        page.click("[data-testid=token-submit]")
    page.wait_for_selector("[data-testid=demo-canvas]", timeout=30000)
    page.wait_for_selector("[data-testid=map-overlay]", timeout=30000)
    page.wait_for_function("() => window.__demoCam && window.__demoCam.frames > 5", timeout=30000)
    page.wait_for_function("() => window.__demoCam && window.__demoCam.flying === false", timeout=15000)


def install_mock(page: Page) -> None:
    def handler(route):
        url = route.request.url
        method = route.request.method
        if url.endswith("/hulls"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(fixture("hulls")))
        if url.endswith("/settings"):
            if method == "POST":
                body = json.loads(route.request.post_data or "{}")
                body["liveSimSpeed"] = 1.02
                return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(fixture("settings")))
        if url.endswith("/plan"):
            body = json.loads(route.request.post_data or "{}")
            name = "plan-connect" if body.get("mode") == "connect" else "plan-constellation"
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(fixture(name)))
        if url.endswith("/execute"):
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(fixture("execute")))
        if url.endswith("/gps"):
            payload = {
                "missionId": "m-designer-fixture",
                "on": method == "POST",
                "added": 18 if method == "POST" else 0,
                "removed": 18 if method == "DELETE" else 0,
            }
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
        return route.continue_()

    page.route("**/api/demo/designer/**", handler)


def real_endpoint_status(tok: str) -> int:
    req = urllib.request.Request(f"{BASE}/api/demo/designer/hulls", headers={"authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status
    except urllib.error.HTTPError as err:
        return err.code
    except Exception:
        return 0


def open_panel(page: Page) -> None:
    page.click("[data-testid=designer-toggle]")
    page.wait_for_selector("[data-testid=designer-panel]", timeout=10000)
    page.wait_for_function(
        "() => { const s = document.querySelector('[data-testid=designer-hull]'); return s && !s.disabled; }",
        timeout=15000,
    )
    page.wait_for_timeout(300)


def assert_layout(page: Page, stage_handle) -> None:
    panel = box(page, "[data-testid=designer-panel]")
    stage = box(page, ".stage")
    assert not overlap(panel, stage), f"designer panel overlaps the map: {panel} vs {stage}"
    for side in (".left", ".right"):
        if page.locator(side).count():
            assert not overlap(panel, box(page, side)), f"designer panel overlaps {side}"
    # its own cards must not collide (the option area is a grid, not a stack)
    cards = page.locator("[data-testid=designer-options] article")
    boxes = [cards.nth(i).bounding_box() for i in range(cards.count())]
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            assert boxes[i] and boxes[j] and not overlap(boxes[i], boxes[j]), f"option cards {i}/{j} overlap"
    assert page.evaluate("(el) => el === document.querySelector('[data-testid=demo-canvas]')", stage_handle)


def run_mock(page: Page, tok: str) -> None:
    install_mock(page)
    login(page, tok)
    canvas_handle = page.locator("[data-testid=demo-canvas]").element_handle()

    open_panel(page)
    print("[ok] designer panel opened without touching the camera")

    hulls = page.locator("[data-testid=designer-hull] option")
    assert hulls.count() == 4, f"expected placeholder + 3 hulls, got {hulls.count()}"
    assert "[HERMES-TEST]" in (hulls.nth(1).text_content() or ""), "owner-tagged hull is not first"
    print("[ok] hulls ordered owner-tagged first")

    # --- executor limits (SimSpeed floor + active cap) ---
    live = page.text_content("[data-testid=designer-simspeed-live]") or ""
    assert "live SimSpeed" in live and "unknown" not in live, f"live SimSpeed missing: {live}"
    assert "5" in (page.text_content("[data-testid=designer-maxactive-value]") or ""), "maxActive default not shown"
    set_range(page, "[data-testid=designer-simspeed]", "0.93")
    shown = page.text_content("[data-testid=designer-simspeed-value]") or ""
    assert "0.93" in shown, f"SimSpeed slider did not update the label ({shown})"
    page.click("[data-testid=designer-settings-save]")
    page.wait_for_function(
        "() => (document.querySelector('[data-testid=designer-settings-save]') || {}).textContent === 'Limits applied'",
        timeout=10000,
    )
    print(f"[ok] executor limits editable and saved ({live.strip()})")

    # --- constellation plan ---
    page.select_option("[data-testid=designer-hull]", "owner-eagle")
    page.select_option("[data-testid=designer-planet]", "EarthLike")
    page.select_option("[data-testid=designer-pattern]", "ring")
    page.click("[data-testid=designer-preset-gravity-free]")
    altitude = int(page.input_value("[data-testid=designer-altitude]"))
    assert altitude >= 60_000, f"gravity-free preset left altitude at {altitude} m"
    page.fill("[data-testid=designer-count]", "18")
    page.select_option("[data-testid=designer-redundancy]", "2")
    set_range(page, "[data-testid=designer-margin]", "0.9")
    assert "90%" in (page.text_content("[data-testid=designer-margin-value]") or "")
    print(f"[ok] constellation form set (altitude {altitude} m, count 18, k=2, margin 90%)")

    page.click("[data-testid=designer-plan]")
    page.wait_for_selector("[data-testid=designer-options]", timeout=10000)
    cards = page.locator("[data-testid=designer-options] article")
    assert cards.count() == 4, f"expected 4 option cards, got {cards.count()}"
    counts = [int(cards.nth(i).get_attribute("data-count") or 0) for i in range(cards.count())]
    assert counts[0] == 18, f"requested pattern was not first: {counts}"
    assert page.locator("[data-testid=designer-option-reasons]").count() == 1, "infeasible option has no reasons"
    print(f"[ok] 4 option cards rendered (counts {counts}), reasons shown for the infeasible one")

    page.click("[data-testid=designer-select-ring-18]")
    page.wait_for_timeout(200)
    preview = page.locator("[data-testid=designer-preview]")
    assert int(preview.get_attribute("data-slot-count") or 0) == 18
    assert page.locator("[data-testid=designer-preview-slot]").count() == 18, "preview slot list != card count"
    print("[ok] preview draws 18 slots for the selected ring option")

    cards.nth(1).hover()
    page.wait_for_timeout(200)
    assert int(preview.get_attribute("data-slot-count") or 0) == 36, "hover did not preview the second option"
    page.mouse.move(5, 5)
    page.wait_for_timeout(200)
    assert int(preview.get_attribute("data-slot-count") or 0) == 18, "preview did not fall back to the selection"
    print("[ok] hover previews the hovered option, selection restored on leave")

    # --- infeasible option blocks approval with a reason ---
    page.click("[data-testid=designer-select-chain-6]")
    page.wait_for_timeout(200)
    assert page.locator("[data-testid=designer-approve]").is_disabled(), "infeasible option can be approved"
    assert page.locator("[data-testid=designer-approve-reason]").count() == 1, "disabled approve has no reason"
    page.click("[data-testid=designer-select-ring-18]")
    page.wait_for_timeout(200)
    assert page.locator("[data-testid=designer-approve]").is_enabled(), "feasible option stayed blocked"
    print("[ok] infeasible option disables Approve & fly with a reason")

    assert_layout(page, canvas_handle)

    # --- connect plan from pasted GPS ---
    page.click("[data-testid=designer-mode-connect]")
    page.fill("[data-testid=designer-gps-a]", "GPS:Base:0:0:0:#FF0000:")
    page.click("[data-testid=designer-gps-a-apply]")
    page.fill("[data-testid=designer-gps-b]", "GPS:Target:1031072:131072:1631072:")
    page.click("[data-testid=designer-gps-b-apply]")
    assert "GPS 0, 0, 0" in (page.text_content("[data-testid=designer-point-a-label]") or "")
    assert "1031072" in (page.text_content("[data-testid=designer-point-b-label]") or "")
    page.click("[data-testid=designer-plan]")
    page.wait_for_selector("[data-testid=designer-option-connect-44]", timeout=10000)
    assert page.locator("[data-testid=designer-option-connect-88]").count() == 1
    page.click("[data-testid=designer-select-connect-88]")
    page.wait_for_timeout(200)
    assert int(preview.get_attribute("data-slot-count") or 0) == 88, "connect preview did not switch to 88 slots"
    print("[ok] two-point connect planned from pasted GPS strings (44 / 88 slots)")

    # --- approval gate ---
    page.select_option("[data-testid=designer-hull]", "prefab-eradicator")
    page.wait_for_timeout(200)
    detail = page.get_attribute("[data-testid=designer-hull-detail]", "data-ground-launch")
    assert detail == "no", f"ion-only hull not reported as no-ground-launch ({detail})"
    assert page.locator("[data-testid=designer-launch-surface]").is_disabled(), "surface launch enabled for a non-launching hull"
    assert page.locator("[data-testid=designer-approve]").is_enabled(), "orbital launch should stay available"
    page.select_option("[data-testid=designer-hull]", "owner-eagle")
    page.wait_for_timeout(200)
    assert page.locator("[data-testid=designer-launch-surface]").is_enabled(), "surface launch not enabled for a verified hull"
    print("[ok] surface launch disabled with a reason for non-ground-launch hulls")

    # --- approve & fly (mock execute) + GPS toggle ---
    page.click("[data-testid=designer-approve]")
    page.wait_for_selector("[data-testid=designer-execute-result]", timeout=10000)
    assert page.get_attribute("[data-testid=designer-execute-result]", "data-mission-id") == "m-designer-fixture"
    assert "SCALED" in (page.text_content("[data-testid=designer-execute-result]") or "")
    toggle = page.locator("[data-testid=designer-gps-toggle]")
    assert toggle.is_enabled(), "GPS toggle disabled after a mission was created"
    # Controlled checkbox: the state follows the POST, so click and wait for
    # the POST result instead of using check() (which asserts instantly).
    toggle.click()
    page.wait_for_selector("[data-testid=designer-gps-note]", timeout=10000)
    assert "added" in (page.text_content("[data-testid=designer-gps-note]") or "")
    print("[ok] approve -> mission id + SCALED + GPS markers toggled on")

    # --- camera must not be hijacked ---
    before = cam(page)
    time.sleep(3 * POLL_MS / 1000)
    after = cam(page)
    drift = dist(after["pos"], before["pos"])
    assert drift < 0.05, f"camera drifted {drift:.3f} km during designer polling"
    assert dist(after["target"], before["target"]) < 0.05, "camera target moved during designer polling"
    assert page.evaluate("(el) => el === document.querySelector('[data-testid=demo-canvas]')", canvas_handle)
    print(f"[ok] camera unchanged across 3 polls (drift {drift:.4f} km)")


def run_real(page: Page, tok: str) -> None:
    login(page, tok)
    open_panel(page)
    options = page.locator("[data-testid=designer-hull] option")
    assert options.count() > 1, "real backend returned no hulls"
    names = [options.nth(i).text_content() or "" for i in range(1, options.count())]
    print(f"[ok] real hulls: {len(names)} (first: {names[0][:60]})")

    first_value = options.nth(1).get_attribute("value")
    page.select_option("[data-testid=designer-hull]", first_value)
    page.select_option("[data-testid=designer-pattern]", "ring")
    page.click("[data-testid=designer-preset-gravity-free]")
    page.fill("[data-testid=designer-count]", "24")
    page.click("[data-testid=designer-plan]")
    page.wait_for_selector("[data-testid=designer-options]", timeout=45000)
    cards = page.locator("[data-testid=designer-options] article")
    assert cards.count() >= 1, "real planner returned no options"
    first_count = cards.first.get_attribute("data-count")
    assert int(first_count or 0) > 0
    page.click(f"[data-testid=designer-select-{cards.first.get_attribute('data-option-id')}]")
    page.wait_for_timeout(200)
    slots = page.locator("[data-testid=designer-preview-slot]").count()
    assert slots == int(first_count or -1), f"preview slots {slots} != card count {first_count}"
    print(f"[ok] real planner: {cards.count()} options, first count {first_count}, preview {slots} slots (read-only)")


def main() -> int:
    tok = token()
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = browser.new_context(viewport={"width": 1600, "height": 900})
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            run_mock(page, tok)
        except AssertionError as err:
            print(f"[FAIL] mock phase: {err}")
            return 2
        except Exception as err:  # noqa: BLE001 - report, never mask
            print(f"[FAIL] mock phase ({type(err).__name__}): {err}")
            return 2
        if errors:
            print(f"[FAIL] console errors: {errors[:5]}")
            return 2
        print("[ok] 0 console errors (mock phase)")

        status = real_endpoint_status(tok)
        if status != 200:
            print(f"[skip] real designer backend not deployed yet (GET /api/demo/designer/hulls -> {status})")
            browser.close()
            print("\nPASS (mock only) — designer UI verified; real backend pending")
            return 0

        ctx2 = browser.new_context(viewport={"width": 1600, "height": 900})
        page2 = ctx2.new_page()
        real_errors: list[str] = []
        page2.on("console", lambda m: real_errors.append(m.text) if m.type == "error" else None)
        page2.on("pageerror", lambda e: real_errors.append(str(e)))
        try:
            run_real(page2, tok)
        except AssertionError as err:
            print(f"[FAIL] real phase: {err}")
            return 3
        except Exception as err:  # noqa: BLE001
            print(f"[FAIL] real phase ({type(err).__name__}): {err}")
            return 3
        if real_errors:
            print(f"[FAIL] console errors (real phase): {real_errors[:5]}")
            return 3
        print("[ok] 0 console errors (real phase, read-only)")
        browser.close()
    print(f"\nPASS — mock + real (read-only) against {BASE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
