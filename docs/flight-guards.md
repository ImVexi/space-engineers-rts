# Flight and landing safety guards

Every flight goes through the executor, which computes what the hull can
actually stop from and rewrites the autopilot `SpeedLimit` before the ship can
get into a corner it cannot brake out of.

## Braking model

For a ship of mass `m` at altitude `h`, with measured available thrust

```
F = F_atmo(h) + F_ion(h) + F_h2 (if any hydrogen is aboard)

a_available = max(0, (F − m·g(h)) / m)     # net of weight, m/s²
d_brake     = v² / (2 · a_available)       # metres
d_safe      = 1.5 · d_brake                # 1.5x margin
v_allowed   = sqrt(2 · a_available · d_remaining / 1.5)
```

Thrust comes from the block definitions at that altitude, with the **measured**
mass from live telemetry. A grid whose thrust split has never been measured is
capped at 5 m/s instead of being flown on a guess.

Hard speed caps, also enforced by `v_allowed`:

| Remaining distance | Max speed |
|---|---|
| ≤ 100 m | **5 m/s** |
| ≤ 10 m | **1 m/s** |
| ≤ 300 m (first order) | 20 m/s |
| further | `RTS_DEMO_SPEED_MPS` (default 60, clamped to 1..100) |

The cap is applied with a **15 m look-ahead**, because telemetry arrives about
once a second and the ship covers ~5 m between samples: the 1 m/s cap engages by
25 m so the ship is already slow when it crosses 10 m. Arrival is 10 m, or 3 m
for a landing waypoint.

Setting the cap to 100 m/s is possible but wasteful: a real 45 km climb at
~100 m/s burned 22 % of the hydrogen and tripped the reserve guard. The tanks,
not the autopilot, are the limit.

## Guards

Evaluated in this order on every `en_route` tick:

| Guard | Trigger | Action |
|---|---|---|
| **Thrust loss** | `F < 1.02 · m·g` | stop autopilot, alert, post-mortem |
| **Reserve** | battery < 15 %, or the flight would eat the 15 % H2 reserve | hold position, alert |
| **Ground floor** | AGL ≤ 25 m while descending faster than 2 m/s | hold position, abort |
| **Ground descent** | AGL < 150 m and descending faster than 5 m/s | hold/brake, resume when the rate recovers |
| **Braking / caps** | `v > v_allowed` or the braking distance no longer fits | re-issue the move at the lower limit |
| **Overshoot** | distance to slot grows for 4 ticks and is > 15 m | hold, abort |
| **Collision avoidance** | every move or hold resend | `CollisionAvoidance` + `DampenersOverride` on the remote control |

Ground altitude is **terrain-aware**: the planet's nominal surface radius is not
the voxel surface, so the executor probes the ground from 120 m beside the ship,
caches the hit for 10 s, and uses the real AGL. The ground floor drops to
`max(2 m, waypoint AGL − 3)` when the waypoint itself is inside 25 m, so a
deliberate low hover is not treated as a crash dive.

## Collision avoidance near the pad

The game treats base grids and terrain as obstacles, so avoidance stays **on for
all transit waypoints** and turns **off only inside the last 30 m**, where the
1 m/s cap, the ground floor and the 3 m arrival test own the ship. Left on for
the whole approach, it once pushed a ship 600 m past its waypoint. The switch is
audited with the reason `terminal approach`.

## Failure reporting

Every failed or aborted flight writes a plain-language paragraph into the
mission notes and the audit, and raises an alert. It states what happened, the
speed, distance to slot, AGL, braking distance, hull deceleration, the action
taken and the next step.

## What the guards cannot do

- **They see the ground below, not ahead.** AGL comes from a downward probe;
  cliffs, mountains and grids ahead are not modelled. Collision avoidance is the
  only lateral protection, and it is off inside 30 m by design.
- **They are only as fresh as telemetry.** Orders are evaluated on the last
  received position, typically a second old. The 15 m look-ahead and the 1.5x
  margin absorb that; a stalled plugin is not a safe state, and the comms gate
  refuses moves without fresh telemetry.
- **Thrust is a model, not a per-tick read.** The definition curve plus measured
  mass is used, and a grid with no measured split gets a 5 m/s cap.
- **The game cannot command below 1 m/s.** `SpeedLimit` floors at 1.0; measured
  terminal speed is 1.0–1.2 m/s, which is inside the arrival tolerance.
- **Holding is not guarded by this loop.** `holding` relies on the staging
  emergency (descent < −5 m/s or battery < 15 %) and the autopilot.
- **It does not repair or remove damage.** A failed ship is held or stopped and
  reported; nothing is deleted.
