# T6 designer (constellation planner) — backend + plugin

Test-server-only admin API behind the same lock as the rest of `/api/demo`
(`RTS_DEMO=1`, `RTS_ENV=test`, `RTS_TEST_SERVER_MARKER=se-rts-test`), the
bearer token, the kill switch and the audit log. There is no production mode.

## Routes

| Method | Route | Result |
|---|---|---|
| GET | `/api/demo/designer/hulls` | `{hulls:[…], ownerTagged:{available,reason}}`. Prefab entries use the measured profiles; owner-tagged grids are profiled live (`list_tagged`) and returned first. |
| POST | `/api/demo/designer/plan` | up to 4 options, requested pattern first then cheapest. Stores the plan for `/execute`. Also accepts `mode: radio-chain | layered | cover-planet` (one option each) — see `docs/planner-modes.md`. |
| GET | `/api/demo/designer/coverage` | T28 heatmap: `?planet=&mode=cover-planet|layered|radio-chain&k=&cellDeg=&tier=` → lat/long `cells` with `coveredBy`, per-tier counts/footprints/SPOFs and rover fallback spots. Read-only, no mission. |
| POST | `/api/demo/designer/execute` | creates an approval-state mission (one `slot-N` step per position); executor: spawn/clone → ownership → wake → ai_off → move → hold. `launch=surface` requires `canGroundLaunch:true`; the active cap is `settings.maxActive` (or the request's `maxActive`) and `SCALED` is returned when the plan is larger. T10 additions: `useGridIds: string[]` launches existing owner-tagged grids in place (release → move → hold, no spawn/clone/ownership transfer), `fillWithClones` (default false) clones the planned hull into slots the owner did not fill, and `dryRun` (default false) returns the assignment + preflight without a mission. |
| GET/POST | `/api/demo/designer/settings` | `{simSpeedMin (0.5..1, default 0.95), maxActive (1..10, default 5), launchReservePct (0..50, default 15)}`, persisted in SQLite kv, audited; the executor and the SimSpeed monitor read it live, and the execute route uses the reserve for its preflight. |
| POST/DELETE | `/api/demo/designer/gps` | `{missionId}` adds/removes GPS markers for the owner identity. Add reads the markers back with `gps_list`; `verified` is true only when every expected name is in `GetGpsList`. |
| POST | `/api/demo/designer/plugin` | narrow test-harness proxy (`clone_grid`, `delete_grid`, `profile`, `list_tagged`, `gps_*`, `identity`) so the plugin actions can be proved on the test server; same lock/token/audit, kill switch enforced for mutations. Extra to the contract (documented deviation), not used by the public UI. |

Plan options carry `positions`, `links`, `spofs`, `redundancyAchieved`,
`coveragePct`, `maxGapM`, `gravityAtSlotMps2`, `feasible`, `reasons`, a
plain-language `summary`, an `endurance` block and labels (`SIMULATED`,
`RADIO-UNVERIFIED`, `ENDURANCE-MODEL`, `OWNER-TAGGED`). Radio links are only
created when the gap is at most `rangeMargin * hull.radioRangeM`; there is no
hidden 100 % assumption.

`endurance` is the propulsion/energy model in `docs/endurance.md`:
`canReachSlot`, `ascentTimeS`, `transitTimeS`, `etaS`, `fuelUsedPct`,
`batteryUsedPct`, `reservePct`, `holdEnduranceS` / `holdEnduranceText`,
`failureReason` and a `recommendation`. It makes an option infeasible when the
hull cannot reach the slot; options are sorted feasible-first. `execute`
re-runs the same preflight with the audited `launchReservePct` and refuses with
`409 endurance_refused` instead of spawning a hull that cannot make it.

## Patterns

The T16/T17/T28 relay modes (`radio-chain`, `layered`, `cover-planet`) and the
T22 hull classification / heterogeneous assignment are documented separately in
`docs/planner-modes.md`. The existing constellation patterns are unchanged:

* `ring` — equatorial ring at `surfaceRadiusM + altitudeM`.
* `inclined-rings` — two rings, planes tilted ±55° around the X axis.
* `shell` — Fibonacci sphere.
* `chain` — constellation: a great-circle arc across one hemisphere (not a
  closed loop, so its two ends have degree 1 and fail k=2).
* `auto` — requested option becomes `ring`; alternatives are ranked by count.
* `connect` — always a chain route; `ring`/`shell` in connect mode is reported
  with a reason (they are constellation shapes). k=2 adds a second route
  offset sideways and verifies two node-disjoint paths with a unit-capacity
  max-flow check, not a BFS heuristic.

`count` grows to satisfy `spacingM` when it is supplied. Redundancy 2 means the
constellation graph is connected, every node has degree >= 2 and has no
articulation points; `no-spof` additionally requires the verified second path /
2-connectivity.

## Gravity model (verified against the game)

The plugin is not the source: SE's own `MySphericalNaturalGravityComponent`
implements

```
attenuation = (r / MaximumHillRadius) ^ -GravityFalloff   (r > max radius)
g           = 9.81 * SurfaceGravity * attenuation
g           = 0                                        (r > gravity limit)
limit       = MaxRadius * (intensity / 0.05) ^ (1 / falloff)
```

Planet values read from `Saves/MiniLab5/SANDBOX_0_0_0_.sbs`:
EarthLike `MinimumSurfaceRadius 59400`, `MaximumHillRadius 67200`,
`SurfaceGravity 1`, `GravityFalloff 7`.

Measured probe (2026-11-09): **0.665 m/s² at 40 km AGL** while this model gives
**0.633 m/s²** (the probe read one vector axis, so the difference is sampling,
not model drift). The same model gives gravity = **0 above 43.69 km AGL**, so
the measured "0 g at ~60 km" is consistent; a 60 km slot is gravity-free.

Consequence the planner states honestly: a 50 km radio at 60 km altitude has
a slant range of 60 km to the ground, so its surface footprint is empty
(`coveragePct = 0`, reason "coverage is below 1 %"). At 20 km altitude the
Eradicator radio covers part of the planet but gravity is ~3 m/s² and the
ion-only hull cannot hold there. A hull with both atmosphere thrust and a
long-range antenna (or an owner-tagged grid) is required to cover the surface
while station-keeping; the designer does not hide this trade-off.

## Plugin actions (test build only)

`gps_add {identityId,name,x,y,z,color,description}` → creates the marker,
adds it to the identity and returns the read-back (`visible`, `hash`).
`gps_remove {identityId,namePrefix}` → removes matching markers, then lists
again (`verified` = none left). `gps_list {identityId}` is the read-back used
by the route. `clone_grid {sourceGridId,x,y,z,fwd,up,ownerId?}` copies the
owner-tagged grid through its object builder, remaps IDs, applies orientation,
transfers ownership (`ChangeGridOwnership` + per-block fix) and returns the new
grid id. `list_tagged {tag}` returns each grid with a matching programmable
block name plus a live profile (radio radius, laser count, thrust by type,
mass, TWR, gravity at its position, `canGroundLaunch`).

## Worked examples (planner output)

| Input | Result |
|---|---|
| EarthLike ring, Eradicator 50 km, margin 0.9, 60 km, 17 sats, k=2 | 17 slots, connected, 0 SPOFs, redundancy 2, gravity 0.00, coverage 0 % (see above) |
| EarthLike ring, spacing 40 km, count 6, k=2 | count grows to 17, max gap 43.9 km <= 45 km |
| EarthLike → Moon connect, Eradicator 50 km, margin 0.9, k=1 | **6 drones**, 4 SPOFs, max gap 40.4 km |
| EarthLike → Moon connect, same, k=2 | **13 drones**, two node-disjoint paths, 0 SPOFs |

## Tests

`packages/backend/tests/designer.test.ts` covers every pattern, the spacing and
planet-intersection rules, k=2 2-connectivity/articulation points, two disjoint
connect paths, the gravity fit and cutoff, settings persistence/audit and the
executor cap. `npm test` with `RTS_DEMO`/`RTS_TOKEN` unset passes.

## T10 — launch existing owner-tagged drones in place

`POST /api/demo/designer/execute` also accepts:

```json
{ "optionId": "o1", "launch": "orbital",
  "useGridIds": ["grid:…", "grid:…"],
  "fillWithClones": false,
  "dryRun": false,
  "ignoreReach": false }
```

* `useGridIds` must be owner-tagged `[HERMES-TEST]` grids owned by identity
  `144115188075855926` and present in live `list_tagged`; anything else is
  refused (`unknown_grid`, `not_owned`, `grid_position_unknown`) instead of
  silently ignored.
* Slots are matched to grids by a greedy nearest-pair assignment (all pairs
  sorted by distance, ties by grid id, then slot id). The response lists every
  pair with `distanceM`; the assignment is deterministic and is not a hidden
  optimisation.
* Per-grid endurance preflight: `preflightGridLaunch` uses the existing
  endurance model with `launch: 'orbital'` (conservative on the ascent leg) and
  the exact transit leg from the grid position to the slot. A proven failure
  (`endurance_refused`, or `hydrogen_empty` when live telemetry says 0 % H2 and
  there is no ion bank) refuses only that drone; the rest launch. A profile
  without tank/power state is `unverified` (never a fabricated pass), except
  for the provable 0 % H2 case. Radio range is checked per grid against the
  option's `maxGapM` (`radio_range_short`).
* `maxActive` caps the launched set; launchable excess is `deferred` and
  labelled `QUEUED`. Unfilled slots stay empty unless `fillWithClones` is true,
  in which case the planned hull is cloned into them (labelled `CLONES`).
* Executor chain for an in-place drone starts at the existing release preflight
  (`release_gears` → `release_connectors` → `diag` → `convert_to_ship` when
  static) and then `move` → `hold`. Spawn, ownership transfer, wake and `ai_off`
  are skipped; the grid is never inserted into `demo_spawned`, so debris
  cleanup can never delete the owner's satellite. Thrust staging runs for
  `en_route`/`holding` as usual.
* The comms gate still applies. Owner-tagged grids have no prefab capability
  profile, so the measured radio radius is persisted (`designer:gridRadios`)
  and the gate uses the largest stand-in radius that does **not** exceed it:
  range math may under-estimate reachability, never over-estimate it.
* `dryRun: true` returns the assignment, preflight verdicts and cap/queue
  decision with no mission and no order.
* `ignoreReach: true` is the test-server admin override (see
  `docs/move-to.md`): the executor's reachability half of the gate is
  bypassed, every order carries `ADMIN OVERRIDE (test server)`, and the
  response is labelled the same. It never bypasses the kill switch, the
  game-link/telemetry half, or the endurance/fuel checks.

Every per-grid verdict is `{status, code, message, hint, reason, reservePct,
requiredReservePct, altitudeM, holdEnduranceText, labels}`.

### Dry-run example (owner's 4 satellites, 4-slot EarthLike ring at 60 km)

`npm test` covers assignment, per-grid refusal (including the 0 % H2 case),
the in-place release chain, the deferred cap state and the admin override
flag. A live dry run is read-only; it creates no mission:

```bash
curl -s -H "authorization: Bearer $RTS_TOKEN" -H 'content-type: application/json' \
  -d '{"optionId":"o1","launch":"orbital","dryRun":true,
       "useGridIds":["grid:…","grid:…","grid:…","grid:…"]}' \
  http://127.0.0.1:8762/api/demo/designer/execute
```
