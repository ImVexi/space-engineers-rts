# Move-to (single ship) + admin override — test server only

Backend: `packages/backend/src/demo/moveTo.ts`, route
`POST /api/demo/move-to` in `demo/routes.ts`. Same lock as the rest of
`/api/demo` (`RTS_DEMO=1`, `RTS_ENV=test`, `RTS_TEST_SERVER_MARKER`), bearer
token, kill switch and audit. No production fallback.

## Request

```json
{ "gridId": "grid:…",
  "target": { "gps": {"x":0,"y":0,"z":119400} } }
```

`target` is one of:

| Form | Meaning |
|---|---|
| `{ "gps": {x,y,z} }` | exact point; altitude/planet are derived for the readout |
| `{ "planet": "EarthLike", "altitudeM": 35000 }` | above the planet on the ship's current radial (ground track) |
| `"orbit-low"` | 20 km above the nearest planet |
| `"orbit-zero-g"` | gravity-free shelf: `max(60 km, gravity cutoff + 5 km)` above the nearest planet |

Optional: `dryRun: true` (preflight only, no mission), `ignoreReach: true`
(admin override, below).

## Response

`200` dry run, `201` mission created. Always contains a plain-language
preflight:

```json
{ "mission": { … },
  "target": { "position": {…}, "planet": "EarthLike", "altitudeM": 60000,
              "label": "gravity-free orbit above EarthLike at 60 km" },
  "preflight": {
    "summary": "SAT-L-0002 cannot move to …: The destination is not reachable …",
    "ok": false, "canReach": false,
    "linkText": "not linked: 58.2 km from BASE-01, whose radio reaches 50 km",
    "fuelText": "fuel: hydrogen 0 %, battery 100 %",
    "etaText": "ETA ~16 min at 60 m/s over 58.2 km",
    "distanceM": 58223, "etaS": 970,
    "block": { "code": "not_reachable",
               "message": "The destination is not reachable from your network: …",
               "hint": "The point is outside BASE-01's 50 km radio (58.2 km away). Lower the destination, add a relay within radio range, or use Admin override (test server)." },
    "warnings": [] },
  "commsGate": { … }, "adminOverride": false,
  "labels": ["SIMULATED"] }
```

* Reach is planner range math over the relay/base graph (`min(rangeA,
  rangeB)` per link, BFS from control sources) — labelled SIMULATED, never
  inferred from an unreadable game field.
* Fuel is the live telemetry fraction. The model never invents a tank size.
  A 0 % H2 ship with no ion bank is refused when the destination is higher
  than its current altitude.
* ETA = straight-line distance / the configured demo speed cap.
* The endpoint refuses (`403 comms_denied`, then `409 not_reachable` /
  `no_fuel`) before creating a mission. `dryRun` returns `200` with
  `preflight.ok=false` and the same `{code,message,hint}` block.

## Admin override (`ignoreReach`)

Test-server-only. `ignoreReach: true` on `move-to` and on
`designer/execute`:

* skips the reachability (planner path) half of the comms gate;
* keeps the kill switch, the game-link/telemetry half, and the
  endurance/fuel checks;
* audits `admin_override: true` in the route audit entry;
* labels every order and response `ADMIN OVERRIDE (test server)` (the gate
  decision in the audit carries the label too);
* is persisted per drone (`demo_drones.admin_override`, schema migration 6)
  so a restart does not silently drop back to normal gating.

The flag travels in the mission's `validate` step params, because the mission
schema strips unknown `desiredState` keys.

## Failure shape

Every demo failure now returns:

```json
{ "error": { "code": "comms_denied", "message": "…",
             "hint": "Ship is outside your base's 50 km radio range. Move it closer, add a relay, or use Admin override." } }
```

`hintForCode` in `demo/routes.ts` holds the map; unknown codes get a generic
"check the request and test-server state" hint. The same `{code, message,
hint}` shape is used inside per-grid endurance verdicts on
`designer/execute`.

## Worked dry runs (real test server, 2026-11-09)

* `move-to` SAT-L-0001..0004 → `orbit-zero-g`: target 60 km above EarthLike,
  ~58.2 km away, ETA 16 min at 60 m/s, link refused (58.2 km from the
  provisioned `BASE-01`, 50 km radio). The same satellites → a ground point
  at the base are reachable (`inside BASE-01's 50 km radio (0.1 km)`).
* Control sources are the provisioned `[HERMES-BASE]` grids; the built-in
  fixture node `earthlike-hq` is no longer part of the reach model.
* `designer/execute` dry run: 4 owner satellites → 4-slot EarthLike ring at
  60 km: greedy assignment SAT-L-0004→s1 (135.6 km), SAT-L-0002→s2
  (68.1 km), SAT-L-0003→s3 (130.2 km), SAT-L-0001→s4 (177.0 km).
  SAT-L-0002/0003 refused `hydrogen_empty` (0 % H2, no ion bank);
  SAT-L-0001/0004 `unverified` (`endurance_model_unavailable`: plugin profile
  has no tank/power state). Slots s2/s3 left unfilled with
  `fillWithClones=false`.

## Tests

`packages/backend/tests/move-to.test.ts` (target resolution incl. presets,
radio chain reach, refusal/override/fuel blocks, ETA formatting, hints, and
the executor storing the override) and the T10 block in
`packages/backend/tests/designer.test.ts`. `npm test` with `RTS_DEMO` /
`RTS_TOKEN` unset passes.
