# Thrust staging — hydrogen off when atmo/ion suffice

Status: implemented in the backend, deployed with the demo site. **No plugin
change and no game restart**: staging drives the existing `set_block_props`
action that auto-provisioning already ships. A backend restart is enough.

Code: `packages/backend/src/demo/staging/` (`hardware.ts`, `policy.ts`,
`controller.ts`) plus two hooks in `executor.ts`. Tests:
`packages/backend/tests/staging.test.ts` (27 cases) and
`packages/backend/tests/release.test.ts` (10 cases).

## Why

A drone that keeps every hydrogen thruster enabled burns H2 whenever the flight
controller spreads the load over all banks, even at 2 km where the atmosphere
alone can hold it. The endurance model says the owner satellite would burn
~83 L/s of hydrogen to hold at 2 km if all banks are live; atmosphere needs no
fuel. Staging keeps the fuel for the part of the flight that actually needs it,
and stops tanks draining while parked in zero-g.

## Policy (per drone, every 2 s)

1. **Available thrust per type** at the current altitude comes from the
   endurance curves (`thrustAtAltitude`; CubeBlocks influence data, exact).
2. **Required force** = `mass × g × margin`: **1.3** while `en_route`
   (climbing), **1.1** while `holding`. `g` is the verified SE gravity model.
3. **Allocation**: atmosphere first while effective, then ion (no fuel), then
   hydrogen only for the remaining gap. Hydrogen is switched **off exactly when
   atmo + ion already cover the requirement** (no partial ganging: the bank is
   either on or off, the flight controller still allocates thrust internally).
4. **Stockpile**: tanks stockpile **ON** only when parked (`holding`), gravity
   is zero, and H2 is not needed. **OFF** whenever H2 may be needed and always
   during a climb. Stockpiling refills the tanks and prevents drain.
5. **Emergency override**: vertical speed < **−5 m/s** while holding/climbing,
   or battery < **15 %** → enable every bank (H2 included), stockpile off, raise
   an alert (`thrust_staging_emergency`) and audit `staging_emergency`. The
   override lasts while the condition holds.
6. **Hysteresis**: at least **10 s between actuator switches** per drone. A
   decision that flips inside the window is held (reason logged); emergency
   bypasses the window. Ion is never toggled, so only H2 and stockpile count
   as switches.

`h2Scope`: the plugin does not report block orientation yet, so every hull uses
`all` (the "else all H2" branch). The policy already computes `up` when a
hardware profile lists up-facing H2 block names and they cover the gap; that is
the hook for when direction telemetry arrives.

## Actuator mapping (existing plugin actions)

| Bank | `set_block_props` filter | Props | Actions |
|---|---|---|---|
| Hydrogen thrusters | `{type:"Thruster", subtype:"Hydrogen"}` | `OnOff` | `OnOff_On` / `OnOff_Off` |
| Hydrogen tanks | `{type:"GasTank", subtype:"HydrogenTank"}` | `Stockpile` | `Stockpile_On` / `Stockpile_Off` |

Both the property and the terminal action are sent: the plugin validates the
property against the block's own `GetProperties()` and reports an unknown id per
block instead of ignoring it (docs/provisioning.md). `subtype` is a substring
match, so `Hydrogen` covers large/small hydrogen thrusters and `HydrogenTank`
never touches oxygen tanks. Every write is read back by the plugin
(`before`/`after`).

## Worked decision table — owner satellite climbing to 60 km

Hull: 12 small atmospheric (1.152 MN) + 10 small hydrogen (0.984 MN), 0 ion,
mass 18,965.4 kg (measured live, docs/endurance.md calibration). Climb margin
1.3, 100 m/s, EarthLike.

| Altitude | H2 | atmo cover | ion cover | required | H2 gap | staged burn | saved vs all-on |
|---|---|---|---|---|---|---|---|
| 0 km | **off** | 100 % | 0 % | 242 kN | 0 | 0 L/s | 91 L/s |
| 2 km | **off** | 100 % | 0 % | 242 kN | 0 | 0 L/s | 98 L/s |
| 6 km | **off** | 100 % | 0 % | 242 kN | 0 | 0 L/s | 128 L/s |
| 8 km | **off** | 100 % | 0 % | 237 kN | 0 | 0 L/s | 148 L/s |
| **9 km** | **on** | 90 % | 0 % | 214 kN | 22 kN | 18 L/s | 128 L/s |
| 10 km | on | 40 % | 0 % | 193 kN | 115 kN | 94 L/s | 52 L/s |
| 15 km | on | 0 % | 0 % | 119 kN | 119 kN | 97 L/s | 0 |
| 20 km | on | 0 % | 0 % | 75 kN | 75 kN | 61 L/s | 0 |
| 30 km | on | 0 % | 0 % | 33 kN | 33 kN | 27 L/s | 0 |
| 40 km | on | 0 % | 0 % | 16 kN | 16 kN | 13 L/s | 0 |
| **44 km** | **off** | 0 % | 0 % | 0 (g = 0) | 0 | 0 L/s | 0 |
| 50–60 km | off | 0 % | 0 % | 0 | 0 | 0 L/s | 0 |

H2 turns **on at ~9 km** (atmosphere effectiveness falls under the climb
requirement) and **off at 44 km** (gravity cut-off); it is off for the whole
ascent below 9 km and for the entire parked phase at 50–60 km. With the 10 s
hysteresis and a 2 s tick the switch lands within ~1 km of these altitudes.

At 2 km the same hull **holding** keeps H2 off and saves **83 L/s** — about
**299,520 L/h**, 60 % of a full 500,000 L tank per hour. Integrating a 100 m/s
climb from 0 to 60 km: **11,658 L saved**, staged burn 16,894 L versus 28,552 L
with every bank enabled (**41 % less H2 on the ascent**).

## Executor integration

* `executor.ts` constructs one `StagingController` (env below) and calls
  `stageDrone()` after each `advance()` for `en_route`/`holding` drones only.
* Staging orders do **not** use the executor's single `pendingOrder` slot: a
  staging write can never block or be blocked by a move/hold order. Results are
  matched from `plugin_event/order_result` audits, exactly like the provisioner.
* A staging fault is audited (`staging_error`) and swallowed; the mission keeps
  flying. Kill switch calls `staging.reset()` and stages nothing.
* Sounding data is the ordinary telemetry row: `pos`, `vel`,
  `meta.massKg`, `meta.powerFraction` (battery), `meta.fuelFraction` (H2).
  Telemetry older than 60 s is never acted on (`stale-telemetry`).

Env (read by the controller, defaults keep it on):

| Variable | Default | Meaning |
|---|---|---|
| `RTS_STAGING` | on | `0` disables all staging writes |
| `RTS_STAGING_DRY` | off | `1` decides and audits, sends nothing |
| `RTS_STAGING_TICK_MS` | 2000 | decision cadence per drone |

## Launch preflight — release a parked drone (owner follow-up)

A parked grid (landing gear, docked connector) or a save-static grid accepts a
move order but does not move. The executor now runs a release preflight **after
the securing chain and before the first move** (never during provisioning):

| Order | Grid | What is sent | Audit |
|---|---|---|---|
| 1 | gears | `set_block_props {type:"LandingGear"}`, `Autolock=false`, action `Unlock` | `launch_release` |
| 2 | connectors | `set_block_props {type:"ShipConnector"}`, actions `Unlock`, `Disconnect` | `launch_release` |
| 3 | read | `diag` (mass, static flag, physics present/enabled/active) | `launch_release_verify` |
| 4 | static only | `convert_to_ship {gridId}` then re-read | `launch_release_convert` |
| 5 | verify | `diag` again; refuse unless `mass > 0` and physics present/enabled | `launch_release_verify` |

* The release block steps are **tolerant**: a missing landing gear or a
  connector that does not know `Disconnect` cannot block a launch. The diag
  read is the gate.
* A static grid calls `convert_to_ship`. Until the plugin build that adds the
  action is live, the call fails and the drone is refused with the exact reason
  **`static grid: convert pending plugin update`** (audited with the plugin
  error). A second diag after a successful convert must show dynamic mass.
* Refusals: `launch refused: grid mass is N kg after release (no live physics
  body)`, `launch refused: physics body is not present/enabled after release`,
  `launch refused: release profile unreadable (no mass/physics read-back)`.
* Optional arrival step (`RTS_RELEASE_RELOCK_GEAR=1`): when a drone reaches a
  hold at ≤ 200 m AGL in gravity, send `Autolock=true` on the landing gears
  (audited as `launch_release`, step `relock_gear`). Default off.
* The existing `move:` demo missions (grid that already exists) run the same
  release chain, so a ship parked on a gear or connector is unblocked.

## Demo-site deploy verification (mandatory)

Every demo-site build must be produced with the test lock, then verified:

```bash
cd packages/demo-site
VITE_DEMO_ENV=test VITE_DEMO_API_BASE=/api \
  node <repo>/node_modules/vite/bin/vite.js build --outDir dist-next --emptyOutDir
rm -rf dist-old && mv dist dist-old && mv dist-next dist && rm -rf dist-old
cd <repo> && node scripts/verify-demo-deploy.mjs \
  --dist packages/demo-site/dist --url http://127.0.0.1:8762/demo/
```

`vite.config.ts` stamps the resolved values into `<head>`
(`demo-build-env`, `demo-build-api-base`), because the string "Demo site
locked" is always present in the bundle (it is the lock screen). The script
checks the local dist and the live page; a build without the env renders the
lock screen and fails the check.

## `/api/demo/state` and UI

Each drone in `executions[].drones[]` now carries `staging` and `stagingLine`:

```jsonc
"staging": {
  "mode": "active", "h2": "off", "desiredH2": "off", "h2Scope": "all",
  "stockpile": false, "emergency": false,
  "altitudeM": 2000, "gravityMps2": 9.78, "requiredN": 204656,
  "availableN": { "atmo": 1152000, "ion": 0, "h2": 984000 },
  "coverPct": { "atmo": 100, "ion": 0, "h2": 0 },
  "h2FillPct": 39.96, "fuelSavedL": 231, "fuelSavedLps": 83.2,
  "switches": 1, "lastSwitchAt": 1800000003000,
  "labels": ["SIMULATED", "ENDURANCE-MODEL"]
}
```

`h2`/`stockpile` are the **applied** actuator state, `desired*` the latest
decision (they differ during the hysteresis window or a pending write). The
mission-progress row shows the small second line `H2 off · atmo 100% · ion 0%`
(+ `stockpile`, `EMERGENCY`, `saved N L` when relevant) with the required
thrust, altitude and labels in the tooltip. The section footer shows
`staging ON/OFF (dry-run) every 2 s`. Layout rules are unchanged: the staging
line is a new grid row in column 2, so it cannot overlap the state badge or the
distance/ETA line.

## Hardware sources and limits

* Prefabs: measured `hulls.ts` mass + definitions-derived block counts
  (Eradicator ion-only, Large Control Drone atmo-only, Escort atmo + H2).
* Owner satellite: the measured live profile (`grid:126323015058751318`,
  18,965.4 kg, atmo 1.152 MN + H2 0.984 MN) with 2 MWh of battery. Tank volume
  is the stock small tank (500,000 L) — **ASSUMPTION**; it only scales the
  fuel-saved percentage, not the burn rate.
* An owner-tagged grid with no measured per-type split is **refused**
  (`unknown-hardware`): mass alone cannot prove which bank is redundant, so
  switching H2 off would be a guess. Register the measured profile to enable it.
* Stockpile is only asserted while parked; the plugin writes are idempotent, so
  a tank already stockpiled reports no change.
* Ion thrusters are never switched: they consume no fuel, and switching them
  off cannot save H2.
* The endurance model's solar assumption does not enter the decision: staging
  looks at thrust and H2, not recharge.

## Tests

`packages/backend/tests/staging.test.ts` (27 cases, no network):

* altitude sweep EarthLike 0–60 km in 250 m steps for four hull mixes (atmo+H2,
  H2 only, ion+H2, owner satellite): H2 on iff a real gap exists, coverage sane;
* owner satellite thresholds (off below 9 km, on 9–43 km, off ≥ 44 km), ion
  taking over on the mixed hull, H2-only hull, 1.3/1.1 margins;
* hysteresis inside/outside 10 s, unchanged state, emergency bypass;
* emergency on −6.2 m/s and 9 % battery, no trip at −4.9 m/s / 15 %;
* stockpile in zero-g hold, not while coasting, not inside the well, not when
  H2 is needed;
* fuel-saved estimate (lower atmosphere > 0, zero when H2 is genuinely needed),
  actuator order planning (cold start, no-op, delta only);
* controller: writes `set_block_props` with the Hydrogen/GasTank filters, audits
  `staging_switch` with reason + H2 fill + altitude, exposes the line, honours
  dwell on a climb, refuses stale telemetry and unknown hardware;
* release preflight: payloads, diag/profile parsing and verdicts, static ->
  `convert_to_ship` -> exact `static grid: convert pending plugin update`
  refusal, and a healthy read advancing the drone to `move`.

```bash
env -u RTS_DEMO -u RTS_TOKEN npx vitest run packages/backend/tests/staging.test.ts
env -u RTS_DEMO -u RTS_TOKEN npx vitest run packages/backend/tests/release.test.ts
env -u RTS_DEMO -u RTS_TOKEN npm test   # 350 tests
```

No live flight was required (the owner's satellites still have no Remote
Control). The policy was dry-run read-only against the live telemetry of the
owner satellite (`grid:126323015058751318`, 1,795 m AGL, 18,965.4 kg, battery
100 %, H2 0 %): decision **H2 off, stockpile off, atmo covers 100 % of the
205 kN hold / 242 kN climb requirement**, 82–97 L/s saved versus all-on. The
plugin action ids are the same ones provisioning already exercised
(`OnOff`/`OnOff_On`, `Stockpile`/`Stockpile_On`).

## Rollback

* Turn writes off without a deploy: restart the backend with `RTS_STAGING=0`
  (decisions stop; existing thruster/tank state stays as last written).
* Or `RTS_STAGING_DRY=1` to keep auditing decisions with no writes.
* Code is additive: remove `stageDrone()`/the `StagingController` field and the
  two summary fields to return to the previous executor. No DB migration, no
  plugin artefact. Audit rows are `staging_*`; the only new alert kind is
  `thrust_staging_emergency`.
