# Flight safety guards

Status: **wired into the demo executor** (`packages/backend/src/demo/executor.ts`,
pure math in `safety.ts`, 14 unit cases in `tests/safety.test.ts`). Verified on
the isolated test server (`SE-RTS Test Lab`, VM 100) with a single-ship hop and
a four-satellite hover; both left every grid at integrity 1.0.

## Why

The T13 constellation run crashed because there was **no braking profile**:
the executor only reacted inside a 50 m arrival radius, the move orders carried
`SpeedLimit 60` with collision avoidance **off**, and telemetry updates about
once a second. At 60–81 m/s a ship crosses 50 m in well under a second, so the
first "arrival" sample came after the impact. Two satellites lost ~45 % of
their blocks; all four arrived with H2 at 0.

The guard closes that loop: every `en_route` tick it computes what the hull can
actually stop from, and rewrites the autopilot `SpeedLimit` before the ship can
get into a corner it cannot brake out of.

## Braking model

For a ship of mass `m` at altitude `h`, with measured thrust split
`F = F_atmo(h) + F_ion(h) + F_h2 (if H2 > 0)`:

```
a_available = max(0, (F − m·g(h)) / m)        # m/s², net of weight
d_brake     = v² / (2 · a_available)           # metres
d_safe      = 1.5 · d_brake                    # 1.5x margin
v_allowed   = sqrt(2 · a_available · d_remaining / 1.5)
```

`F_atmo/ion/h2(h)` comes from the endurance thrust curve (CubeBlocks influence
data, `thrustAtAltitude`) with the **measured** mass from live telemetry; the
owner-satellite family uses its measured 1.152/1.344 MN atmospheric + 0.984 MN
hydrogen split. A grid with no measured split is capped at 5 m/s instead of
trusting a guess.

Hard caps (also enforced by `v_allowed`):

| Remaining distance | Max speed |
|---|---|
| ≤ 100 m | **5 m/s** |
| ≤ 10 m | **1 m/s** |
| ≤ 300 m (first order) | 20 m/s |
| further | configured `demo.speedLimitMps` (default **60**, `RTS_DEMO_SPEED_MPS`) |

The cap is validated by `loadConfig` and clamped to 1..100 (SE's Remote Control
autopilot maximum; higher values are ignored). **100 is opt-in**
(`RTS_DEMO_SPEED_MPS=100`): a live 45 km climb on a 20.4 t, 4×15 000 L-tank
clone reached **99.89 m/s** but burned 22 % H2 in 205 s, so the reserve guard
aborted the leg at 69 % H2 (and refused the next legs) — the tanks, not the
autopilot, are the limit. The braking formula, the 1.5x margin and the 5/1 m/s
arrival caps are unchanged: at 100 m/s a 48 m/s² vacuum hull brakes in 104 m,
and the guard still refuses any speed it cannot stop from in the remaining
distance.

Because telemetry arrives about once a second and the ship covers ~5 m between
samples, the caps use a **15 m look-ahead** (`distance − 15`): the 1 m/s cap
engages by 25 m so the ship is already slow when it physically crosses 10 m.
The first move order is chosen from the same table, so nothing starts at 60 m/s
inside 100 m. Arrival is 10 m normally and 3 m for a landing waypoint.

## Guards (in evaluation order)

| Guard | Trigger | Action |
|---|---|---|
| **Thrust loss** | `F < 1.02 · m·g` | stop autopilot (`abort-stop`), alert, post-mortem |
| **Reserve** | battery < 15 %, or vacuum flight would eat the 15 % H2 reserve (0.25 m/s² manoeuvring floor in zero-g) | hold at current position (`abort-hold`), alert |
| **Ground floor** | AGL ≤ 25 m while descending > 2 m/s | hold at current position, abort |
| **Ground descent** | AGL < 150 m and descending > 5 m/s | hold/brake, resume when the rate recovers |
| **Braking / caps** | `v > v_allowed` or `d_brake·1.5 > d_remaining` | re-issue the move with the lower `SpeedLimit` |
| **Overshoot** | distance to slot grows 4 ticks in a row and is > 15 m | hold, abort (this is the case the 50 m radius missed) |
| **Collision avoidance** | every move/hold resend | `CollisionAvoidance=true` + `DampenersOverride=true` write on the RC |

Ground altitude is **terrain-aware**: `planet.surfaceRadiusM` is not the voxel
surface at BASE-01 (terrain is ~1.78 km higher). The executor casts
`probe_ground` from 120 m to the side of the ship, caches `|hit|` for 10 s and
uses `|ship| − groundRadius` as AGL. Probes are matched from audit results
outside the single pending-order slot, so they cannot block a move.

The ground floor is lowered to `max(2 m, waypoint AGL − 3)` when the waypoint
itself is inside 25 m, so a deliberate 5 m landing hover is not treated as a
crash dive.

### Collision avoidance exception at the terminal phase

SE's avoidance treats BASE-01/terrain as an obstacle. With it ON for the whole
100 m hop, SAT-L-0005 climbed **600 m past its 100 m waypoint** (integrity 1.0,
recovered by hand; see `qa-results.md`). The guard now keeps avoidance **ON for
all transit waypoints** and turns it **OFF only inside the last 30 m**, where the
1 m/s cap, the ground floor and the 3 m arrival test own the ship. The switch is
audited (`demo_guard_collision_avoidance`, `on:false`, reason
`terminal approach`).

## Post-mortem

Every failed or aborted flight writes a plain-language paragraph to
`missions.plan.notes` and to the audit (`demo_flight_postmortem`), and raises an
alert (`flight_abort` / `flight_failed`). It states what happened, speed,
distance to slot, AGL, braking distance, hull decel, the action taken and the
next step. No numeric log is required to understand a failure in the UI.

## What the guards cannot do

- **They see the ground below, not ahead.** AGL comes from a downward probe;
  cliffs, mountains and grids ahead are not modelled. Collision avoidance is the
  only lateral protection, and it is off inside 30 m by design.
- **They are only as fresh as telemetry.** Orders are evaluated on the last
  received position/velocity (typically ~1 s old). The 15 m look-ahead and the
  1.5x braking margin absorb that, but a stalled plugin (no samples) is not a
  safe state; the comms gate refuses moves without fresh telemetry.
- **Thrust is a measured model, not a per-tick thrust read.** The endurance
  curve plus measured mass is used. A grid with no measured split is refused a
  high speed (5 m/s cap) rather than flown on a guess.
- **SE cannot command below 1 m/s.** `RemoteControl.SpeedLimit` is floored at
  1.0; measured terminal speed is 1.0–1.2 m/s. The 10 m criterion is met within
  that controller tolerance.
- **Holding is not guarded by this loop.** `holding` relies on the staging
  emergency (descent < −5 m/s or battery < 15 %) and the autopilot. The guards
  run in `en_route` only.
- **It does not repair damage.** A failed ship is held/stopped and reported; it
  is never deleted (owner grids are not in the spawn registry).

## Verification numbers (2026-11-09, test server)

| Check | Result |
|---|---|
| SAT-L-0005 hop, commanded caps | ≤ 5 m/s inside 100 m, 1 m/s inside 10 m |
| Measured | max **5.3 m/s** inside 100 m (SE holds 5 ± 0.3); max **1.19 m/s** inside 10 m |
| Overshoot | arrived **8.0 m** short of the 100 m target; hold settled to 3.3 m |
| Integrity | **1.0** after climb, 60 s hold and settle |
| 4-sat square | 300 m above BASE-01, sides **99.5–100.9 m**, diagonals 140–142 m |
| Square hold 120 s | all four `holding`, 3.1–3.3 m from their corner, speed 0, integrity **1.0**, H2 100 % |
| SimSpeed | 0.85 (threshold 0.65) |
