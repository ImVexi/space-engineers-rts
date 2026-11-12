# Power & fuel telemetry, range auto-tune, slot power budget (T20/T29/T30)

**Status: live on the test server (2026-11-09, backend `se-rts-backend`).**
Everything below is read from the live grid with the plugin's read-only
`profile` action unless a line says otherwise.

## 1. T20 — power & fuel telemetry

`packages/backend/src/demo/power/`

* **Poller** (`poller.ts`): every tagged grid (the provisioning snapshot, i.e.
  `[HERMES-TEST]`/`[HERMES-BASE]` grids) is profiled **once every 30 s**, with
  the first poll of each grid staggered across the interval. **At most 3
  orders/s** (one in flight, 333 ms spacing). A grid whose last profile reports
  `control.underControl` (T27 manual handoff), or whose telemetry row carries a
  manual marker, is **skipped** and reported as `manualControl`.
* **Cache**: latest `PowerSnapshot` per grid + a 24 h sample ring (in memory;
  a backend restart drops history, the first poll repopulates values).
* **Rates** (`estimateRates`): least-squares slope over samples at least 120 s
  apart — battery %/h, H2 %/h and L/h, uranium kg/h. One sample is never a rate.
* **Runways** (`computeRunway`): battery = stored MWh / net draw (only while
  net < 0); H2 = % / burn %/h (or litres / L/h); uranium = kg / kg/h (only on a
  grid that actually has a reactor). `expectedLife` = smallest known runway,
  **"no limit"** for a station (`isStatic`), a zero-g hold, or a net-positive
  grid with no fuel burn.
* **What `netMw` means (fixed 2026-11-11).** Batteries are **storage**, not
  production: `netMw = production − consumption`, where production is solar +
  reactors + H2 engines + wind turbines (+ any other producer) **current
  output**, and consumption is the sum of **non-battery** consumers' current
  input. The old plugin sum was
  `solar + reactor + batteryOut − batteryIn − deviceDraw`, which counted a
  **discharging** battery's own output as generation (and subtracted charging
  input twice, since the device sum already contained the battery's sink).
  Measured on SAT-R-0001: `chargeState: discharging`, battery output 1.7043 MW,
  `netMw: +1.5042` — so `powerRunwayMin` was `null` on **all 10** grids with
  power telemetry and the survival loop could never fire on power. The plugin
  now also publishes `generationMw`, `consumerDrawMw`, `batteryChargeMw`,
  `powerRunwayMin` and `powerRunwayReason`. Since 2026-11-11 the backend
  **forwards the breakdown** instead of dropping it at the profile boundary:
  `nodes[].telemetry.generationMw / consumerDrawMw / batteryChargeMw` (flat,
  next to `netMw`) and `telemetry.power.breakdown {generationMw,
  consumerDrawMw, batteryChargeMw, netMw}`. The Fleet panel shows
  "gen X MW / draw Y MW" beside the battery cell so a negative net is
  explainable. A profile that does not send them leaves them `null` (never 0).
  The pure model lives in
  `plugin/HermesRts.Plugin/src/PowerMath.cs`, pinned by
  `plugin/HermesRts.Plugin/tests/power-math`.
* **A null runway says why** (`runway.powerRunwayReason`): `draining`
  (a runway exists), `charging`, `idle`, `absent` (no battery) or `unread`
  (a deficit with no stored-charge figure). Never coerced to 0 minutes, and
  `0 MWh` is ambiguous (empty vs a failed read) so it stays a null with a
  reason.
* **Alerts** (`evaluatePowerAlerts`), returned per node and in
  `state.power.alerts`:
  | alert | rule |
  |---|---|
  | `low-battery` | battery < 25 % (bad < 10 %) |
  | `draining` | net < 0 and battery runway < 2 h (bad < 30 min) |
  | `needs-fuel` | H2 < 30 % (bad < 10 %) |
  | `uranium-low` | uranium < 10 % of reactor capacity |
  | `solar-pointing` | solar < 30 % of installed capacity **in daylight** |
  | `manual-control` | a player is piloting the grid |
* **Daylight** is computed from the plugin's sun vector (`kv telemetry:sun`)
  and the radial from the nearest planet: `asin(dot(up, sun)) > 0`.
* **Merge** into `GET /api/demo/state` → `nodes[].telemetry` with the exact
  field names `packages/demo-site/src/lib/fleet.ts` feature-detects:
  `batteryPct, batteryStoredMWh, batteryMaxMWh, chargeState, currentInputMw,
  currentOutputMw, netMw, generationMw, consumerDrawMw, batteryChargeMw,
  solarActualMw, solarOutputMw, solarMaxMw,
  solarEfficiency, h2Pct, h2Litres, h2PctPerHour, uraniumKg,
  uraniumCapacityKg, uraniumPct, uraniumKgPerHour, powerRunwayMin,
  fuelRunwayMin, uraniumRunwayMin, runwayMin, expectedLife, isStatic,
  underControl, daylight, zeroG` plus a structured `telemetry.power`
  (battery/breakdown/solar/reactor/h2/draw/antennas/lasers/rates/runways/alerts).
* **History**: `GET /api/demo/power/:gridId?hours=24` → 1-minute buckets
  (`{minute, samples, batteryPct, netMw, solarPct, h2Pct, uraniumPct}`) over the
  last 24 h. Missing values stay `null`; the UI shows "—".
* `GET /api/demo/power/budget` is documented in §3.

### Verified on the live test server (2026-11-09 22:0x)

14 tagged grids polled, 0 errors. Sample rows (game was in **night**, sun
elevation −39…−43° for every grid, so solar actual/max = 0 — a real read, not a
missing field; `daylight=false` is emitted):

| grid | battery | charge | net MW | solar | H2 | U | life |
|---|---|---|---|---|---|---|---|
| SAT-L-0010 | 100 % | discharging | +0.004 | 0/0 | 31.7 % | — | no limit |
| SAT-R-0001 | 100 % | discharging | +1.487 | 0/0 | — | — | no limit |
| BASE-01 | 100 % | discharging | 0 | 0/0 | — | — | no limit |
| SAT-L-0016 | 100 % | discharging | +0.004 | 0/0 | 34.8 % | — | no limit |

Alerts firing: `needs-fuel` (bad) on SAT-L-0005, SAT-L-0006 (H2 0 %) and
SAT-L-0015. Low-battery/solar-pointing paths are covered by unit tests; they do
not fire here because every battery is at 100 % at night.

## 2. T29 — antenna range auto-tune

`packages/backend/src/demo/autotune/`

* `POST /api/demo/autotune/preview` → per node `nowM`, `neededM`, `action`
  (`shrink|grow|keep|pinned|blocked`), `savedMw`, reason + network totals.
  Rules: backbone = longest active link × 1.15; coverage = footprint the plan
  needs (or longest link × 1.15); base = max range; **never below a link in
  use** (the longest link is a hard floor); hardware maximum never exceeded.
* `POST /api/demo/autotune/apply` (audited, kill switch must be off) writes
  `Radius` with `set_block_props` `{filter:{type:"RadioAntenna"}}`, then reads
  the block back with a fresh `profile` and reports before/after radius, antenna
  draw and net MW. Dedicated `demo:tune-set:*` orders; no restart.
* `GET/POST /api/demo/autotune/pins` — owner override: an exact range (or
  coverage footprint) per node. Pinned nodes are skipped by apply, always.
* **Default OFF** for automatic re-tuning. `RTS_AUTOTUNE_AUTO_MS` (≥ 60 000)
  enables the timer that re-previews and applies the diff; every write is
  audited as `demo_autotune_auto`. On-demand preview/apply always reflects the
  current topology, so a topology change is picked up on the next call.
* **MW model**: radio draw is calibrated to the live `antennaDrawMw` at the
  sampled radius and scaled linearly with radius (SE has no power value in the
  antenna definition; the sink follows the configured radius). **Laser draw is
  state-based** (idle 0.0001 MW, turning 0.001 MW, lasing 1.0 MW), so shrinking
  a laser reports **0 MW saved** rather than an invented number. Laser *range*
  per link is still computed (distance × 1.15) for the planner.

### Verified apply (SAT-L-0010, owned clone; not 0006/0015)

```
before: Radius 50 000 m, antennaDraw 0.2000 MW, net +0.004 MW
after : Radius 16 442 m, antennaDraw 0.0658 MW, net +0.004 MW
draw drop 0.1342 MW (predicted 0.200 × (1 − 16442/50000) = 0.134)
```

Read back from the block, links unchanged (13 links, still reachable). A second
preview after the write is a no-op (`now 16 442 = needed 16 442`, action
`keep`), so apply is idempotent.

## 3. T30 — power budget per slot

`packages/backend/src/demo/power/budget.ts` (pure) and
`GET /api/demo/power/budget?gridId=&slotAltM=&lat=&region=&flightMode=&...`.

Definitions are exact (`docs/endurance.md`): large solar 0.16 MW, small 0.04 MW,
large battery 3 MWh/12 MW, small 1 MWh/4 MW, small-small 0.05 MWh/0.2 MW,
laser 1.0 MW lasing. Insolation is an assumption: 50 % of panel peak at the
equator × cos(latitude) × terrain factor (polar 0.9, equator 1, valley 0.6,
zero-g 0.95). Night fraction polar 0.68, equator/valley 0.5, zero-g 0.3.

Output: `need {avgMw, peakMw, nightMWh}`, `supply {solarAvgMw, solarPeakMw,
batteryMWh, batteryMaxOutputMw, reactorMw}`, `verdict`
(`ok-24-7 | short-at-night | generation-short | no-storage`), `shortfallMWh`,
one-sentence `summary`, and a `suggestion` with block counts for the region
(polar station / equator station / valley rover / zero-g relay).

Examples from the live API:

* SAT-L-0010 at 45 km: `short-at-night` — needs 1.21 MW avg / 2.21 MW peak,
  short by 8.44 MWh at night with a 3 MWh battery (night, so solar supply 0.04 MW).
* Polar hover slot, 12 km, 65°: `short-at-night` — needs 1.61 MW avg, short by
  25.28 MWh with a 1 MWh battery; suggestion: 6 large solar + 2 large batteries
  + 1 radio (station instead of hover).

`GET /api/demo/power/budget?gridId=…` derives the design from the live profile
(antenna radius, laser count, panel sizes, battery capacity) and the
provisioning read-back, so a ship's actual fit is one query away.

## Rollback

* `RTS_AUTOTUNE_AUTO_MS` unset (default) → no automatic writes; preview/apply
  and telemetry keep working.
* A tuned radius is restored with the same endpoint and the owner pin, or by
  `set_block_props` `Radius` at the old value.
* Poller does no writes at all (only the read-only `profile` order).
