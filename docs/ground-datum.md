# Ground datum: which source is right, and one radius for every consumer

Measured 2026-11-11 (run set 2, HEAD `22cac9f`) on the TEST server. Raw states:
raw captures are not part of this repository. Offline
re-sampling of the same columns: `data/repro-ground.ts` and
`data/repro-footprint.ts` (read-only GETs to the test telemetry instance on
the world-geometry service, through the backend's own cubesphere mapping).

## The three numbers at the come-to-me hover column

Hull radius 61 263.83 m, keel −8.66 m (hull bottom 61 255.17 m), so AGL =
hull-bottom radius − ground radius:

| source | ground radius, m | hull-bottom AGL, m |
|---|---|---|
| executor readback (`hoverAglM`, `groundSource: terrain`) | 61 160.66 (level 0) | 110.9 |
| plan (`terrain-l5`) | 61 197.80 | 74.3 |
| level-5 terrain sample script | 61 204.8 | 40.3\* |

\* the script still carried the previous hull's keel (18.76 m instead of 8.66 m),
worth 10.1 m of its 34 m gap; the rest is its own tile choice. It is a
diagnostic script, not a production source.

Same column, every level (the backend's own mapping):

| level | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| ground, m | 61 160.66 | 61 195.39 | 61 192.06 | 61 194.83 | 61 196.07 | 61 197.80 |

## Which source is right

The ship came to rest twice, and at rest the hull bottom IS the ground, so a
correct terrain model must reproduce the DIFFERENCE between the two resting
radii. Resting radii 61 191.11 m and 61 158.34 m → 32.77 m of relief.

| level | ground at rest | ground at landing-1 | difference | error vs 32.77 m |
|---|---|---|---|---|
| 5 | 61 197.82 | 61 164.44 | 33.38 | **0.6** |
| 4 | 61 196.09 | 61 160.07 | 36.02 | 3.3 |
| 0 | 61 160.68 | 61 163.32 | −2.64 | **36.4** |

**Level 5 is the right source** (shape-accurate to 0.6 m over 33 m of relief);
level 0 flattens the hill by 36 m. Level 5 also carries a constant ~15 m bias
(15.37 m and 14.77 m at the two resting columns), i.e. the smooth heightmap sits
above the voxel contact point — a DEM-calibration job, not an LOD bug, and it
errs on the side of braking high.

## The -37.1 m jump

`land_at` was handed 61 197.8 (level 5). At 18 m indicated AGL the backend
pushed **61 160.7** — exactly the level-0 value for that column, `-37.1 m`.
Indicated AGL became 52.5 m in one tick, the 21.4 m brake stopped being a brake,
and the hull flew the last metres at ~5 m/s until a 32.1 deg/s rate forced a safe
abort at 39.6 m indicated (~18 m of real clearance on the contact-calibrated
ground).

## Fixes

1. `demo/ground.ts` `groundColumnKey` was a grid of ~0.4 mm, not 6 m
   (`round(u*1e6)/6` in a space where one bucket unit is 6e-9 of the unit
   direction), so every descent tick was a cold column and fell back to level 0
   while the plan's awaited read had filed level 5. It now buckets in METRES on
   the surface sphere (`GROUND_COLUMN_BUCKET_M`), radius-aware.
2. `bestColumnGround` is the ONE resolution policy: finest cached sample → the
   planning field **labelled `terrain-l0`** with `level: 0` → null. The coarse
   value is never filed as a measured sample. `TerrainField` now declares its
   `level`.
3. Every consumer records the source and the LOD: `demo_landing_handover`,
   `demo_landing_handover_deferred` / `_coarse`, `demo_landing_ground_update`,
   `demo_landing_ground_coarse`, `demo_landing_ground_disagreement`,
   `demo_landing_touchdown_test`, `come_to_me_ready` (`hoverAglLevel`,
   `hoverAglSource`).
4. A plugin-land handover waits up to 5 ticks for a landing-grade sample
   (bounded: a descent never waits on terrain), then hands over on the coarse
   datum labelled.
5. Late-descent datum guard: a `land_ground` that would change the AGL by more
   than max(5 m, 25 % of the AGL in force) below 150 m AGL is **not sent**; the
   backend orders `land_stop` (the plugin's safe hover) and audits
   `demo_landing_ground_disagreement`.
6. A hover AGL read is only reported as measured on a landing-grade sample;
   otherwise it is reported on the datum the hover was built with, labelled.

## The 32.1 deg/s rate (spin)

Backend-caused? **No.** The backend has no gyro code at all (`grep -i gyro`
over `packages/backend/src` is empty), sends no `set_block_props` during a
plugin-land descent, and the only order in that window was the single
`land_ground` (plugin log 10:21:10.656, `datum 61197.8 -> 61160.7`); everything
else in the log is the power poller and read-only probes.

Plugin-side, the numbers point at the attitude loop and its open yaw channel:
one gyro, `38.1 deg/s per unit` of command (measured by its own sign test), and
`RateDamped` strips the up-axis component by design, so yaw is never damped
during a landing. The datum jump dropped the lift command to 35 % at ~18 m real
clearance; the resulting attitude demand was applied at full gain, and the two
`land gyro sign flipped` lines immediately after the abort (tilt 3.3 deg in
0.13 s, 7.2 deg in 0.43 s) show the authority available. Proposed plugin fix
(not applied — no plugin edits in this change): damp the up-axis rate in brake
and hover (`|yaw rate|` > 1 deg/s, gain ~0.3, tilt < 10 deg), and refuse a
`land_ground` whose AGL change exceeds the same 5 m / 25 % rule.
