# Station mode — park a relay as a static grid (T18/T19)

Status: **shipped and live on the test server** (plugin restart 2026-11-10 03:21 UTC;
backend station lifecycle deployed with it). A satellite parked as a *station* is
`IsStatic = true`: it has no physics drive, so inside gravity it holds altitude for
free — no thrust, no hydrogen, no battery drain beyond its own blocks, and almost
no simulation cost. It also cannot move until it is converted back.

## Why it matters

Hovering in gravity burns fuel continuously. The ten relay clones that were
holding at 7–16 km on hydrogen were draining tanks to stay still; a static grid at
the same position costs nothing. For early-game atmo/radio relays *any* altitude
becomes viable once the node is stationed: a static grid can sit inside gravity
for free.

## Plugin actions

| Action | Params | Does |
|---|---|---|
| `convert_to_station` | `gridId`, `force?`, `thrustersOff?` | `IsStatic = true` on the game thread; returns `isStaticBefore/After`, `converted`, `speedBeforeMs`, `aglM`, `positionBefore/After`, `positionDriftM`, `massBefore/AfterKg`, `thrustersDisabled`, `method` |
| `convert_to_ship` | `gridId` | the reverse (already existed) |
| `is_under_control` | `gridId` | `underControl` + per-controller list (cockpit / RC `IsUnderControl`) |
| `profile` (extended) | `gridId` | adds `power.*`, `fuel.h2FillPct`, `thrustPerDirection`, `thrustBanks`, `flightMode`, `control` |
| `suit_radio` | `identityId?` | a character's suit antenna radius (`MyCharacter.RadioBroadcaster.BroadcastRadius`) |

### Refusals

`convert_to_station` refuses (the order fails with the exact reason) when:

* speed > **0.5 m/s** — a station snapshots the current position; converting a
  moving ship freezes it mid-flight, not where it was going;
* AGL < **100 m** — never station on the ground (a landed grid must stay dynamic
  so it can be refuelled and picked up);
* either check can be bypassed with `force: true`, which is intended for recovery
  (e.g. a ship already falling) and is never used by the executor.

`thrustersOff` defaults to true: a static grid cannot thrust, so leaving the banks
enabled only wastes power and makes the ship look like it is still hovering.

## Backend lifecycle (T19, minimal)

`packages/backend/src/demo/station.ts` (pure policy) + a station pass in
`executor.ts`. Config (env, defaults on for the test server):

| Variable | Default | Meaning |
|---|---|---|
| `RTS_STATION` | on | `0` disables every station write |
| `RTS_STATION_AFTER_MS` | 30000 | stable time in `holding` before stationing |
| `RTS_STATION_MAX_SPEED` | 0.5 | m/s |
| `RTS_STATION_MIN_AGL` | 100 | m |

A drone is stationed only when **all** hold: state `holding` (i.e. at its slot),
speed ≤ 0.5 m/s, AGL ≥ 100 m, held ≥ 30 s, no pending order, and the plugin reports
no player in a cockpit/RC. The executor asks `is_under_control` first and skips the
conversion if a player is flying (T27). Every decision and result is audited
(`demo_station_decision`, `demo_station_check`, `demo_station`, `demo_station_skipped`),
and each drone row carries `stationed` + `stationState` (`ship` / `converting` /
`stationed`).

`holding` is a terminal state for the flight loop, so the decision runs from a
dedicated `stationPass()` rather than inside `advance()`; that pass also resolves
the station orders, because the flight loop never touches a `holding` drone again.

### Moving a stationed grid

Any new order goes through the existing launch preflight, which reads `diag` and
sees `isStatic: true`, then sends `convert_to_ship` before the first move
(`docs/staging.md`, release chain). The cost is hydrogen: unstation → thrust →
re-station burns fuel, which is why repeated unstationing is discouraged
(the no-hydro-farms concern) and why the executor stations only once per
mission.

## Level mode (T25/T27) — shipped, off by default

`level_hold` / `level_move` in the plugin are a game-thread controller (10 Hz) for
hulls that cannot be flown by SE's autopilot: it holds the grid level with gyro
override (tilt cap 10°) and drives the lift bank with a PD loop on altitude and
vertical speed, while lateral banks chase the horizontal target. It refuses when
lift < 1.05 × weight, in zero-g, or when a player is piloting, and aborts on tilt,
ground floor, battery (< 15 %) or H2 (< 5 %) reserve. It is started only by an
explicit `level_hold`/`level_move` order — the executor still uses the autopilot
unless `profile.flightMode.recommended == "level"` (lift-dominant hull) is wired in.

`profile.thrustPerDirection` (N, grid local: up/down/fwd/back/left/right) is the
envelope the decision is based on; `flightMode.liftDominant` is true when the hull
has lift but little down/lateral authority.

The gyro axis convention is not documented by the game API, so the controller
measures divergence and flips its sign once if tilt grows while correcting, then
aborts rather than fight.

## Power / inventory reads (T20)

`profile.power` now reports, measured from the live grid:

* battery stored / capacity / % + `inputMw`, `outputMw`, `chargeState`
  (charging/discharging/idle), `netMw`;
* total `deviceDrawMw` (sum of the resource sinks of every functional block),
  split out as `antennaDrawMw` and `laserDrawMw`;
* per reactor: `outputMw`, `uraniumKg`, inventory volume + `uraniumCapacityKg`
  derived from the **measured** kg/m³ of the ore on board (never a guessed density);
* per solar panel + `solarActualMw` / `solarMaxMw` / `solarEfficiency`;
* `fuel.tanks[]` (L, ratio, stockpile) and `fuel.h2FillPct` (minimum across H2 tanks).

## Verification (test server, 2026-11-10)

See `docs/qa-results.md` for the fleet table and the numbers from the run.

## Rollback

* Backend: `RTS_STATION=0` + restart — no writes, ships keep flying (and burning).
* Plugin: restore `<server-dir>/hermes/HermesRts.Plugin.dll.bak-pre-station` and
  restart the container (~4 min). The DLL on disk is hot-swap-free: a restart is
  mandatory (docs/plugin-loading.md).
* A stationed grid is converted back with `convert_to_ship {gridId}` — same
  action the launch preflight uses.
