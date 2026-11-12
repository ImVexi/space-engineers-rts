#!/usr/bin/env python3
"""T51/T60 acceptance: the operator screens load against a MOCK backend.

Serves a built demo-site (default <path>/cache/scratch/site-build) and
intercepts every API call with fixtures, then at 393x852 and 1440x900 opens each
tab of the Ops panel and asserts:
  * no two visible panels overlap;
  * the map keeps >= 55 % of the phone viewport (>= 50 % on desktop);
  * zero console errors and zero page exceptions.

It never talks to the live backend: all /api routes are fulfilled locally.

Usage: python3 e2e/ops_screens.py [site-dir]
"""
from __future__ import annotations

import functools
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

SITE_DIR = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "SITE_DIR", "<path>/cache/scratch/site-build")).rstrip("/")
TOKEN = "e2e-mock-token"

PLANETS = [
    {"id": "p1", "name": "EarthLike", "center": {"x": 0, "y": 0, "z": 0},
     "surfaceRadiusM": 59400, "maxHillRadiusM": 67200, "hasAtmosphere": True},
]

NODES = [
    {"id": "g1", "name": "SAT-L-0001", "prefab": "DRONE", "planet": "EarthLike",
     "position": {"x": 0, "y": 70000, "z": 0}, "controlSource": False, "status": "alive",
     "origin": "fixture", "note": "", "source": "GAME",
     "telemetry": {"name": "SAT-L-0001", "lastSeen": 1, "ageMs": 1000, "fresh": True,
                   "pos": {"x": 0, "y": 70000, "z": 0}, "vel": {"x": 0, "y": 0, "z": 0},
                   "speedMps": 0, "moving": False, "linkStatus": "up", "ownership": None},
     "capabilityKnown": True,
     "capability": {"role": "drone", "radioRadiusM": 50000, "laserRangeM": None, "laserPorts": 0,
                    "controllable": True, "sizeClass": "large", "isStatic": False, "sourceNote": ""},
     "links": [], "ports": {"used": 0, "capacity": 0}, "reachable": True, "gate": None},
    {"id": "g2", "name": "BASE-01", "prefab": "STATION", "planet": "EarthLike",
     "position": {"x": 0, "y": 59400, "z": 0}, "controlSource": True, "status": "alive",
     "origin": "provisioned", "note": "", "source": "GAME",
     "telemetry": {"name": "BASE-01", "lastSeen": 1, "ageMs": 1000, "fresh": True,
                   "pos": {"x": 0, "y": 59400, "z": 0}, "vel": {"x": 0, "y": 0, "z": 0},
                   "speedMps": 0, "moving": False, "linkStatus": "up", "ownership": None},
     "capabilityKnown": True,
     "capability": {"role": "station", "radioRadiusM": 50000, "laserRangeM": 30000, "laserPorts": 2,
                    "controllable": True, "sizeClass": "large", "isStatic": True, "sourceNote": ""},
     "links": [], "ports": {"used": 0, "capacity": 2}, "reachable": True, "gate": None},
]

STATE = {
    "schemaVersion": 1, "now": 1,
    "env": {"name": "test", "locked": True, "rtsEnv": "test", "marker": "e2e", "productionFallback": False},
    "planets": PLANETS,
    "world": {"snapshot": "e2e", "nodes": len(NODES), "planned": 0},
    "nodes": NODES,
    "telemetry": {"source": "plugin", "connected": True, "gridCount": len(NODES), "freshCount": len(NODES),
                  "staleCount": 0, "recentCount": len(NODES), "archivedCount": 0, "movingCount": 0,
                  "latestAgeMs": 1000, "pollMs": 60000, "note": "e2e fixture"},
    "graph": {"nodes": [{"id": "g1", "kind": "relay", "controlSource": False},
                        {"id": "g2", "kind": "base", "controlSource": True}],
              "edges": [{"from": "g1", "to": "g2", "kind": "radio", "distanceM": 12000}]},
    "reachability": {"reachable": ["g1", "g2"], "isolated": [], "sources": ["g2"]},
    "spofs": [], "bridges": [], "ports": {},
    "flags": {"fleet_ops_execute": False},
    "killSwitch": False,
    "plugin": {"connected": True, "agentId": "e2e", "lastStatus": None, "lastHeartbeatAgeMs": 1000, "gridCount": 2},
    "standins": [],
    "hardwareSummary": {"radio": "HORN", "laser": "none", "mixed": "none", "lasersAvailable": 0, "radioRelaysAvailable": 1},
    "missions": {"open": 0, "awaitingApproval": 0, "recent": []},
    "assumptions": [], "labels": ["SIMULATED"],
    "survivalMode": True,
}

ALERTS = {
    "enabled": True, "now": 1,
    "alerts": [
        {"id": "a1", "kind": "coverage-hole", "severity": "critical", "subjectType": "planet",
         "subjectId": "EarthLike", "message": "Coverage hole of 13.7 % over EarthLike",
         "evidence": {"coveragePct": 86.3, "uncoveredCells": 412},
         "actions": [{"label": "Plan a coverage fix", "endpoint": "/api/demo/designer/optimise", "method": "POST"}],
         "state": "open", "count": 1, "firstSeenAt": 1, "lastSeenAt": 2, "ackedBy": None},
        {"id": "a2", "kind": "needs-refuel", "severity": "warn", "subjectType": "grid",
         "subjectId": "g1", "message": "SAT-L-0001 is down to 9 min of hydrogen",
         "evidence": {}, "actions": [], "state": "open", "count": 3,
         "firstSeenAt": 1, "lastSeenAt": 2, "ackedBy": None},
    ],
    "counts": {"open": 2, "acked": 0, "critical": 1},
}

OP = {
    "id": "op-e2e", "kind": "recall", "planetId": "p1", "members": ["g1", "g2"],
    "steps": [
        {"id": "s1", "wave": 1, "memberId": "g1", "action": "return", "target": None, "status": "planned", "reason": "come home"},
        {"id": "s2", "wave": 2, "memberId": "g2", "action": "hold", "target": None, "status": "planned", "reason": "stay"},
    ],
    "status": "awaiting_approval", "dryRun": True,
    "coverageBefore": {"coveragePct": 88.0, "terrain": "corrected", "totalCells": 100, "terrainReason": None},
    "coverageAfter": {"coveragePct": 61.0, "terrain": "corrected", "totalCells": 100, "terrainReason": None},
    "invariants": {"ok": True,
                   "members": [{"gridId": "g1", "home": None, "verdict": "ok", "distanceM": 12000},
                               {"gridId": "g2", "home": None, "verdict": "skipped", "reason": "already home"}],
                   "failures": [], "notes": []},
    "abortPolicy": "hold", "lastError": None,
}

OPTIMISE = {
    "schemaVersion": 1, "planId": "plan-e2e", "asOf": 1,
    "planet": {"id": "p1", "name": "EarthLike", "surfaceRadiusM": 59400},
    "request": {"target": "hemisphere", "k": 1, "cellDeg": 5, "cellDegUsed": 5, "rangeMarginPct": 10,
                "maxMoves": None, "dryRun": True, "altitudeMode": "cheapest"},
    "base": {"gridId": "g2", "name": "BASE-01", "latDeg": 0, "lonDeg": 0, "altitudeM": 0, "source": "provisioned"},
    "fleet": {"total": 2, "withRadio": 2, "commandable": 2, "movable": 1, "entries": []},
    "excluded": [],
    "coverageNow": {"pct": 78.0, "coveredCells": 78, "totalCells": 100, "cellsByK": {"k1": 78, "k2": 0},
                    "blockedCells": 0, "geometricPct": 78.0, "terrain": "corrected", "terrainReason": None,
                    "sampling": None},
    "moves": [{"gridId": "g1", "name": "SAT-L-0001",
               "from": {"pos": {"x": 0, "y": 70000, "z": 0}, "altitudeM": 10600, "latDeg": 0, "lonDeg": 0},
               "to": {"pos": {"x": 0, "y": 61000, "z": 0}, "altitudeM": 1600, "latDeg": 10, "lonDeg": 20},
               "distanceM": 12000, "etaS": 360,
               "fuel": {"h2L": 210, "batteryMWh": 4, "reservePct": 15},
               "thrustClassNeeded": "hydrogen", "holdMode": "hover", "reason": "fills the eastern hole",
               "substitution": {"basis": "nearest movable", "cellsCovered": 12, "coversTotal": 40,
                                "uncoveredDuringTransit": True, "uncoveredCellCount": 3,
                                "uncoveredCells": [], "uncoveredTruncated": False, "transitEtaS": 360}}],
    "staying": [{"gridId": "g2", "name": "BASE-01", "reason": "it is the base"}],
    "surplus": [],
    "coverageAfter": {"pct": 94.0, "coveredCells": 94, "totalCells": 100, "cellsByK": {"k1": 94, "k2": 0},
                      "blockedCells": 0, "geometricPct": 94.0, "terrain": "corrected", "terrainReason": None,
                      "sampling": None},
    "gainPct": 16.0, "gainCells": 16,
    "holes": [{"latDeg": 12.5, "lonDeg": -30.0, "reason": "terrain shadow",
               "fix": {"kind": "move", "text": "lower SAT-L-0001 by 2 km", "gridId": "g1", "distanceM": 4000, "etaS": 120}}],
    "holesTotal": 6, "holesTruncated": True,
    "buildRequests": [{"slotId": "slot-1", "buildRequest": "build 2x station relay: 6 solar, 2 batteries, compact radio", "reason": "south pole hole"}],
    "solver": {"candidateSlots": 40, "movesEvaluated": 120, "altitudesEvaluated": 3, "basis": "hemisphere"},
    "assumptions": [], "labels": ["SIMULATED"], "limitations": [], "executable": True, "operation": None,
}

PREFLIGHT_OK = {
    "dryRun": True, "gridId": "g1",
    "target": {"position": {"x": 0, "y": 61400, "z": 0}, "planet": "EarthLike", "altitudeM": 2000,
               "label": "2 km above EarthLike"},
    "preflight": {"ok": True, "canReach": True, "summary": "SAT-L-0001 can reach the target",
                  "linkText": "linked through BASE-01, 12.0 km", "fuelText": "fuel: hydrogen 82 %, battery 100 %",
                  "etaText": "ETA ~3 min at 60 m/s over 12.0 km", "distanceM": 12000, "etaS": 200,
                  "block": None, "warnings": []},
    "labels": ["SIMULATED"],
}


def json_response(route, body, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def handle_api(route):
    url = route.request.url
    path = url.split("/api", 1)[-1].split("?")[0]
    method = route.request.method
    if path.endswith("/demo/state"):
        return json_response(route, STATE)
    if path.endswith("/alerts"):
        return json_response(route, ALERTS)
    if path.endswith("/health"):
        return json_response(route, {"ok": True, "survivalMode": True, "env": "test"})
    if path.endswith("/demo/groups"):
        return json_response(route, {"groups": []})
    if path.endswith("/demo/designer/hulls"):
        return json_response(route, {"hulls": []})
    if path.endswith("/demo/designer/optimise"):
        return json_response(route, OPTIMISE)
    if path.endswith("/demo/fleet-ops") and method == "GET":
        return json_response(route, {"operations": [OP]})
    if path.endswith("/demo/fleet-ops") and method == "POST":
        return json_response(route, {"operation": OP, "coverage": None, "note": "planned", "labels": ["SIMULATED"]}, 201)
    if path.endswith("/demo/naming"):
        return json_response(route, {"grids": [], "names": {}})
    if "/demo/links" in path:
        return json_response(route, {"current": [], "possible": [], "summary": {"radioEdges": 0, "laserEdges": 0, "possibleRadio": 0, "possibleLaser": 0, "isolated": []}})
    if path.endswith("/demo/world/manifest"):
        return json_response(route, {"save_hash": "e2e", "save_mtime": 0, "generated_at": 0, "grids": []})
    if path.endswith("/demo/terrain/planets"):
        return json_response(route, {"planets": []})
    if path.endswith("/demo/provision/state"):
        return json_response(route, {"bases": [], "drones": []})
    if path.endswith("/demo/move-to"):
        return json_response(route, PREFLIGHT_OK)
    return json_response(route, {"error": {"code": "not_found", "message": f"mock has no {path}"}}, 404)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def translate_path(self, path):
        # The production build uses base=/demo/; serve the dist root under it.
        if path.startswith("/demo"):
            path = path[len("/demo"):] or "/"
        return super().translate_path(path)


def serve(directory: str) -> tuple[socketserver.TCPServer, int]:
    handler = functools.partial(Quiet, directory=directory)
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


def boxes(page):
    found = []
    for sel in ["[data-testid=ops-panel]", "[data-testid=action-bar]", ".hud-top", "[data-testid=breadcrumb]"]:
        loc = page.locator(sel)
        for i in range(loc.count()):
            el = loc.nth(i)
            if not el.is_visible():
                continue
            box = el.bounding_box()
            if box and box["width"] > 1 and box["height"] > 1:
                found.append((sel, box))
    return found


def overlap(a, b, pad=1.0):
    return not (a["x"] + a["width"] + pad <= b["x"] or b["x"] + b["width"] + pad <= a["x"]
                or a["y"] + a["height"] + pad <= b["y"] or b["y"] + b["height"] + pad <= a["y"])


def map_fraction(page, panel_boxes):
    stage = page.locator("[data-testid=stage]").bounding_box()
    area = stage["width"] * stage["height"]
    covered = 0.0
    for _, b in panel_boxes:
        w = max(0.0, min(b["x"] + b["width"], stage["x"] + stage["width"]) - max(b["x"], stage["x"]))
        h = max(0.0, min(b["y"] + b["height"], stage["y"] + stage["height"]) - max(b["y"], stage["y"]))
        covered += w * h
    return 1 - covered / area


def run(p, base: str, width: int, height: int, phone: bool) -> None:
    tag = "phone" if phone else "desktop"
    errors: list[str] = []
    browser = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    page.on("console", lambda msg: errors.append(f"console: {msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda err: errors.append(f"pageerror: {err}"))
    page.route("**/api/**", handle_api)
    page.add_init_script(
        "window.localStorage.setItem('se-rts-demo-token', %s)" % json.dumps(TOKEN)
    )
    page.goto(f"{base}/demo/", wait_until="domcontentloaded")
    page.wait_for_selector("[data-testid=stage]", timeout=30000)
    page.wait_for_selector("[data-testid=ops-toggle]", timeout=30000)
    page.wait_for_timeout(1200)

    page.click("[data-testid=ops-toggle]")
    page.wait_for_selector("[data-testid=ops-panel]")
    page.wait_for_timeout(600)

    min_map = 0.55 if phone else 0.50
    for tab in ("alerts", "optimise", "send", "fleet"):
        page.click(f"[data-testid=ops-tab-{tab}]")
        page.wait_for_timeout(700)
        found = boxes(page)
        for i in range(len(found)):
            for j in range(i + 1, len(found)):
                assert not overlap(found[i][1], found[j][1]), f"{tag}/{tab}: {found[i][0]} overlaps {found[j][0]}"
        vw = page.viewport_size
        for name, b in found:
            assert b["x"] >= -1 and b["y"] >= -1, f"{tag}/{tab}: {name} starts outside the viewport"
            assert b["x"] + b["width"] <= vw["width"] + 1, f"{tag}/{tab}: {name} overflows right"
            assert b["y"] + b["height"] <= vw["height"] + 1, f"{tag}/{tab}: {name} overflows bottom"
        fraction = map_fraction(page, found)
        assert fraction >= min_map, f"{tag}/{tab}: map only {fraction:.0%} visible (need {min_map:.0%})"
        assert page.locator(f"[data-testid=ops-{tab if tab != 'send' else 'send'}]").count() >= 1, \
            f"{tag}/{tab}: screen did not render"
        print(f"[ok] {tag}/{tab}: no overlap, map {fraction:.0%} visible")

    # The survival badge must be readable from /api/health.
    assert page.locator("[data-testid=survival-badge]").inner_text() == "SURVIVAL MODE", \
        f"{tag}: survival badge did not read survivalMode"

    page.screenshot(path=f"<path>/cache/scratch/ops-{tag}.png")
    browser.close()
    assert errors == [], f"{tag}: console errors: {errors}"


def main() -> int:
    if not os.path.isdir(SITE_DIR):
        print(f"site build not found: {SITE_DIR} (build it first)", file=sys.stderr)
        return 2
    server, port = serve(SITE_DIR)
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as p:
            run(p, base, 1440, 900, phone=False)
            run(p, base, 393, 852, phone=True)
    finally:
        server.shutdown()
    print("\nops screens: both viewports pass with no console errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
