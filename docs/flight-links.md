# Flight profile, links API and the laser connect sequence

Contract: `docs/CONTRACT-FEATURES.md` §1–§3. Backend only; no plugin rebuild.

## 1. `GET /api/demo/links?planet=`

```json
{
  "current":  [{ "a": "...", "b": "...", "kind": "radio|laser", "label": "GAME|SIMULATED", "lengthM": 30000 }],
  "possible": [{ "a": "...", "b": "...", "kind": "radio|laser", "lengthM": 52000,
                 "reason": "in radio range", "feasible": true }],
  "summary":  { "radioEdges": 3, "laserEdges": 1, "possibleRadio": 8, "possibleLaser": 2, "isolated": [] }
}
```

`current`
* `GAME` radio: grids the plugin reports in one logical antenna group
  (`radio_links.logicalGroupRepresentative`), one edge per pair in the group.
* `GAME` laser: a pair whose blocks both read `Connected` in `laser_state`
  (mutual check, disabled blocks excluded).
* `SIMULATED`: the planner's range edges that are *not* already GAME.

`possible`
* radio: every unordered pair with `d <= 0.9 * min(radioA, radioB)`. Pairs that
  fit the larger nominal radius but not the 0.9 margin are returned
  `feasible: false` with the distance in the reason.
* laser: every pair that has a port on both ends. Infeasible reasons:
  `laser no free port`, `out of laser range: …`, `occluded by <planet>`.
  Free ports, range hit and planets clear gives `feasible: true` with
  `laser LOS clear` when the plugin answered `probe_los`, otherwise
  `laser LOS unchecked` (no `probe_los` action exists on the test build yet).

`summary.isolated` = ids with no current edge and no feasible possible pair.

`POST /api/demo/links/connect {a, b, permanent?, timeoutMs?}` runs the laser
sequence below on two grid ids and audits the full result (`200` connected,
`502` not connected, with the exact per-end status).

## 2. Laser connect sequence — `packages/backend/src/demo/laser.ts`

Order, verified on the test server (T42):

```
set_block_props OnOff=true      (per end, by CustomName so a third beam never joins)
laser_target                    (coords of the PARTNER'S LASER BLOCK from laser_state)
laser_connect                   (per end)
poll laser_state <= 20 s        (both ends must read Connected to each other)
retry the whole sequence once   (enable included: a failed connect can drop OnOff)
```

Failure returns the exact status per end (`a=RotatingToTarget b=Off`) instead
of a generic timeout, plus every step in `steps[]` for the audit.

A block that reports `Connecting`/`RotatingToTarget` with `targetCoords` all
zeros is stale (it was never commanded); the sequence disconnects it first and
records `clearedStale`.

Used by: `POST /api/demo/links/connect` and `POST /api/demo/naming/laser-test`
(the test action tears the beam down again with `keepConnected: false`). The
same `LaserLinker` is the only path a planner or supervisor should use.

## 3. Flight profile — `packages/backend/src/demo/flight.ts`

```
a_brake   = (sum(thrust_usable) - m*g) / m        (gravity subtracted once)
v_cruise  = min(configMax, sqrt(2 * a_brake * (dist - brakeMargin)))
vacuum    dampeners OFF: burn to v, coast, brake at v²/(2a)
atmosphere dampeners ON, continuous thrust, climb >= 30 m/s
```

* One `move` order per leg. A new order is only sent when the required speed
  changed by more than 20 % (the guard throttling the approach) or a guard
  tripped (`brake`, `overshoot`, stall after a reconnect).
* Dampeners go back on at the last 100 m even in vacuum, so the autopilot can
  trim and hold instead of coasting past the slot.
* `flightMode` is `OneWay` outside 100 m and `Precision` inside it (reported;
  the plugin pins OneWay on `move` because the block enum is not mod API).
* Guards are unchanged: reserve, ground floor, overshoot, speed caps.
* Predicted `{etaS, fuelL, vCruise, dampeners, flightMode}` is written to the
  audit as `demo_leg_profile` when the move goes out; on arrival/abort
  `demo_flight_profile` records predicted vs actual and the same line is
  appended to the mission notes. The arrival watchdog scales with the
  predicted ETA (a 500 km coast is not a stalled approach).

## Tests

* `packages/backend/tests/demo-flight-profile.test.ts` — vacuum/atmosphere,
  short/huge legs, climb floor, fuel model, 20 % resend rule.
* `packages/backend/tests/demo-links.test.ts` — fixture world: GAME vs
  SIMULATED current, possible counts, infeasible reasons, planet and asteroid
  LOS, isolated ids.
* `packages/backend/tests/demo-laser-connect.test.ts` — fake hub: action order,
  partner-block coordinates, retry once, exact failure status, stale clear,
  cleanup.
* `packages/backend/tests/demo-executor.test.ts` — "one move per leg" with a
  fake hub counting orders across a coasting leg.
