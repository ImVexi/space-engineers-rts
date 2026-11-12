#!/usr/bin/env python3
"""Playwright e2e for the TEST-LOCKED demo site.

Uses the system-wide Python Playwright 1.64 + Chromium (no npm browser
download). Started by scripts/demo-e2e.sh, which owns the two servers.
"""
from __future__ import annotations

import re
import sys

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8764"
FAIL_SCREENSHOT = "<path>/cache/scratch/e2e-fail.png"

IGNORED_CONSOLE = (
    "WebGL",
    "GPU",
    "THREE.WebGLRenderer",
    "favicon",
    "Failed to load resource",
)


def fail(page, message: str) -> None:
    try:
        page.screenshot(path=FAIL_SCREENSHOT, full_page=True)
        print(f"[e2e] screenshot: {FAIL_SCREENSHOT}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass
    raise AssertionError(message)


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

        def on_console(msg):
            if msg.type == "error" and not any(token in msg.text for token in IGNORED_CONSOLE):
                console_errors.append(msg.text)

        page.on("console", on_console)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        print("[e2e] load site")
        page.goto(BASE, wait_until="networkidle")

        badge = page.get_by_test_id("env-badge")
        badge.wait_for()
        badge_text = badge.inner_text()
        print(f"[e2e] env badge: {badge_text!r}")
        assert "test server" in badge_text.lower(), "environment badge missing"
        assert "hermes test lab" in badge_text.lower(), f"wrong test marker badge: {badge_text!r}"

        page.get_by_test_id("planet-EarthLike").click()
        page.get_by_test_id("planet-Alien").click()
        connect = page.get_by_test_id("connect-open")
        assert connect.is_enabled(), "Connect button did not arm after A/B selection"
        print("[e2e] planets selected: EarthLike -> Alien")
        connect.click()

        dialog = page.get_by_test_id("connect-dialog")
        dialog.wait_for()
        page.get_by_test_id("count-radio").wait_for()

        counts = {
            "radio": int(page.get_by_test_id("count-radio").inner_text()),
            "laser": int(page.get_by_test_id("count-laser").inner_text()),
            "mixed": int(page.get_by_test_id("count-mixed").inner_text()),
        }
        print(f"[e2e] option counts: {counts}")
        assert counts["radio"] > counts["laser"], "laser should need fewer nodes than radio"
        assert counts["laser"] < counts["mixed"] < counts["radio"], "mixed should sit between laser and radio"

        text = dialog.inner_text()
        assert "EncounterCitadelStation" in text, "hardware summary missing laser flyer"
        assert "UNVERIFIED" in text, "assumptions are not labelled UNVERIFIED"
        assert "SIMULATED" in text, "planner results are not labelled SIMULATED"
        assert "Radio only" in text and "Laser only" in text and "Mixed" in text, "option cards missing"

        print("[e2e] choose laser option and approve")
        page.get_by_test_id("select-laser").click()
        assert "preview: Laser only" in page.get_by_test_id("preview-chip").inner_text()
        page.get_by_test_id("approve-connect").click()

        mission_state = page.get_by_test_id("mission-state")
        mission_state.wait_for()
        status = page.get_by_test_id("mission-status").inner_text()
        print(f"[e2e] mission status: {status}")
        assert "queued" in status and "approve" in status, "mission is not in approval state"
        execution = page.get_by_test_id("execution-state").inner_text()
        assert execution == "pending: plugin not connected", f"unexpected execution label: {execution}"

        page.get_by_test_id("approve-mission").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=mission-status]')?.textContent?.includes('approved')",
        )
        print("[e2e] mission approved (queue only, no execution)")
        page.get_by_test_id("close-connect").click()

        print("[e2e] kill switch blocks further approvals")
        page.get_by_test_id("kill-switch").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=kill-switch]')?.textContent?.includes('KILL SWITCH ON')",
        )
        page.get_by_test_id("connect-open").click()
        page.get_by_test_id("connect-dialog").wait_for()
        page.get_by_test_id("count-radio").wait_for()
        page.get_by_test_id("approve-connect").click()
        error = page.get_by_test_id("connect-error")
        error.wait_for()
        error_text = error.inner_text()
        print(f"[e2e] blocked as expected: {error_text}")
        assert "kill_switch" in error_text, "kill switch did not block mission approval"
        page.get_by_test_id("close-connect").click()
        page.get_by_test_id("kill-switch").click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=kill-switch]')?.textContent?.includes('KILL SWITCH OFF')",
        )

        print("[e2e] reset requires typed confirmation")
        page.get_by_test_id("reset-open").click()
        page.get_by_test_id("reset-dialog").wait_for()
        submit = page.get_by_test_id("reset-submit")
        assert submit.is_disabled(), "reset submit must stay disabled before typed confirmation"
        page.get_by_test_id("reset-confirm").fill("RESET")
        assert submit.is_enabled(), "reset submit did not enable after typing RESET"
        submit.click()
        page.wait_for_function(
            "() => document.querySelector('[data-testid=toast]')?.textContent?.includes('Reset mission')",
        )
        print("[e2e] reset created a mission only")

        page.screenshot(path="<path>/cache/scratch/demo-e2e-ok.png", full_page=True)

        if page_errors:
            fail(page, f"page errors: {page_errors}")
        if console_errors:
            fail(page, f"console errors: {console_errors}")

        browser.close()

    print("[e2e] PASS: selection, comparison, approval state, kill switch, reset confirm, no console errors")
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
