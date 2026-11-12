# Endurance model — ascent, transit, reserve, hold

Per hull × per slot: can it get there, how long does the trip take, how much
hydrogen/charge is left, and how long can it hold station. The model gates the
designer's launches and ranks feasible options first.

Code: `packages/backend/src/demo/endurance/` (`definitions.ts` = block data,
`model.ts` = physics). Tests: `packages/backend/tests/endurance.test.ts`.

## Sources

Everything that is a game constant is taken from the definitions, never typed
in from memory:

| Value | Source |
|---|---|
| `ForceMagnitude`, `MaxPowerConsumption`, `Min/MaxPlanetaryInfluence`, `EffectivenessAtMin/MaxInfluence`, `FuelConverter` | `Content/Data/CubeBlocks/CubeBlocks_Thrusters.sbc` |
| battery `MaxStoredPower` / `MaxPowerOutput`, solar `MaxPowerOutput` | `CubeBlocks_Energy.sbc` |
| hydrogen tank `Capacity` (litres) | `CubeBlocks_Logistics.sbc` |
| hydrogen `EnergyDensity` 0.001556 MWh/litre | `Sources/SpaceEngineers/Content/Data/GasProperties.sbc` |
| air-density ramp, force multiplier, fuel→power conversion | SE source: `MyPlanet.GetAirDensity`, `MyThrusterBlockThrustComponent.CalculateForceMultiplier`, `MyEntityThrustComponent.PowerAmountToFuel` |
| planet radius/gravity | `PlanetGeneratorDefinitions.sbc` + the test save; same model as `docs/designer.md` |

Definition values used (all exact): ion 4.32 MN / 33.6 MW (large-large),
0.3456 MN / 3.36 MW (large-small), 0.1728 MN / 2.4 MW (small-large);
hydrogen 7.2 MN / 7.5 MW (large-large), 1.08 MN / 1.25 MW (large-small),
0.48 MN / 0.6 MW (small-large), 0.0984 MN / 0.125 MW (small-small); atmospheric
6.48 MN / 16.8 MW (large-large), 0.648 MN / 2.4 MW (large-small), 0.576 MN /
2.4 MW (small-large), 0.096 MN / 0.6 MW (small-small). Batteries 3 MWh / 12 MW
(large), 1 MWh / 4 MW (small), 0.05 MWh / 0.2 MW (small-small). Solar 0.16 MW
(large), 0.04 MW (small). Tanks 15,000,000 / 1,000,000 / 500,000 / 15,000 L.

## Formulas

**Air density** (`MyPlanet.GetAirDensity`, linear, not an assumption):

```
AverageRadius     = MaximumHillRadius / (1 + 0.12)        // HillParams.Max 0.12
AtmosphereAltitude= AverageRadius * 0.12 * 2.0            // LimitAltitude 2.0
rate              = clamp(1 - (r - AverageRadius) / AtmosphereAltitude, 0, 1)
density           = rate * Atmosphere.Density             // EarthLike 1.0, Alien 1.2
```

EarthLike atmosphere top = **15.0 km AGL**; density is 0 at 20 km.

**Thrust vs altitude** — planetary influence is the air density:

```
eff(kind) = lerp(effMin, effMax, clamp((density - minInfluence)/(maxInfluence - minInfluence), 0, 1))
ion:  1.0 -> 0.2     weak in air, full in vacuum
atmo: 0.3 -> 1.0     zero below 0.3 density (above the atmosphere)
h2:   constant 1.0
force(kind) = nominalForce * eff(kind)
```

**Hydrogen burn** (`PowerAmountToFuel`): a thruster's fuel input at full
throttle is `MaxPowerConsumption / (Efficiency * EnergyDensity)`; at throttle
`t` the burn is `t * powerMW / 0.001556` L/s. Example: large-large H2 at 100 %
= 7.5 / 0.001556 = **4,820 L/s**. Electric draw for ion/atmo is
`t * powerMW`.

**Hover / hold at a slot**: `required = mass * g(slot)`. Force is allocated
atmosphere → ion → hydrogen (fuel last). Then:

```
solarMW   = panelPeakMW * 0.5                 // ASSUMPTION: average insolation
netMW     = reactorMW + solarMW - drawMW
batteryS  = netMW >= 0 ? infinite : batteryMWh / -netMW * 3600
h2S       = burnLps > 0 ? h2Litres / burnLps : infinite
hold      = min(batteryS, h2S)                // 'indefinite' when both infinite
g == 0    -> hold = 'indefinite'              // nothing to hold against
```

`g(slot)` is the verified gravity model from `designer.md`: g = 0 above
43.69 km AGL on EarthLike.

**Ascent**: 1 s steps from the launch altitude. Each step uses the thrust
available at that altitude (effectiveness above), caps speed at 100 m/s,
consumes H2 and battery at the commanded throttle, and fails when TWR ≤ 1,
H2 hits 0, or the battery cannot cover the draw. No drag. **Transit** at
100 m/s over the worst-case slot distance; in vacuum (g = 0) the leg is coasting
and costs nothing, inside a well it costs the same thrust as a hold.

**Reserve** = min(remaining H2 %, remaining battery %) at arrival. The launch
gate refuses below **15 %** (designer setting `launchReservePct`, clamped 0–50).

## ASSUMPTIONS (also returned on every plan)

* solar input is 50 % of panel peak (planet shadow/orientation unknown);
* 100 m/s speed cap, no drag;
* grid mass is constant (burned H2 mass is small);
* a hull that cannot lift from the surface spawns at 40 km AGL, or at the slot
  altitude when lower;
* owner-tagged hulls only get a model when the profile supplies mass, power and
  tank state. `list_tagged` does not, so their `enduranceSource` is
  `unavailable` and the gate does not claim a result it cannot prove.

## Gate and ranking

`POST /api/demo/designer/execute` runs `preflightLaunch` before creating a
mission and returns `409 endurance_refused` with the model's reason, e.g.
`H2 exhausted at 31.0 km` or `ion TWR 0.21 at 0.0 km`; a refusal is audited as
`designer_launch_refused`. Plan options carry `endurance` and are sorted
feasible-first (the requested pattern stays first among feasible options).
Connect anchors are geometric waypoints at maximum hill radius + 1 km, so their
endurance is informational (`enforced: false`) rather than a hold requirement.

## Worked outputs (EarthLike)

| Case | Result |
|---|---|
| Eradicator (ion, 2,071,825 kg) → 60 km ring, 17 slots | orbital launch; ascent 205 s from 40 km, worst transit 40 min, reserve **100 %**, hold **indefinite** (0 g) |
| Escort TT-420 (atmo + H2) → 60 km, surface launch | ascent **601 s**, **1.2 %** H2 used, reserve **98.8 %**, hold indefinite |
| Small-grid ion + solar sat (10 t, 2× large ion, 4 panels, 2 MWh) at **30 km** | orbital launch; hold **19 h 06 min**, 0.18 MW draw, battery-limited |
| Small-grid H2 sat (10 t, 1× large H2, 500,000 L) at **30 km** | surface launch; ascent 301 s, **10.7 L/s**, hold **12 h 38 min**, reserve 97.1 % |
| Either sat at **60 km** | hold **indefinite** (0 g; no fuel to hold) |

The trade is explicit: at 30 km hydrogen lifts from the ground but burns its
tank in ~13 h; ion + solar cannot lift from the ground at all (ion is 20 % in
air) but holds longer once placed and needs no fuel. At 60 km both are free to
hold — the recommendation is always to park above 44 km when the mission allows.

## Calibration against the live server (2026-11-09)

Read-only `profile` on a live tagged grid (`grid:126323015058751318`, 1.78 km
AGL): mass 18,965.4 kg, atmo 1,152,000 N + H2 984,000 N, measured
`maxEffectiveThrustN` 1,999,167 N and TWR 10.745.

| Quantity | Model | Live | Error |
|---|---|---|---|
| effective thrust at 1.78 km | 2,001,143 N | 1,999,167 N | **0.10 %** |
| TWR | 10.756 | 10.745 | **0.10 %** |
| gravity | 9.81 m/s² | 9.81 m/s² | 0 |

The live profile does not report instantaneous power draw or H2 flow, so those
two are marked UNMEASURED; the profile does confirm the battery (2 MWh), tank
fill (39.96 %) and force split the model consumes.

## Tests

`packages/backend/tests/endurance.test.ts` (20 tests): thrust-vs-altitude curves
(atmo → 0, ion → vacuum value, H2 constant), definition-derived burn rate,
battery-limited vs tank-limited hold, zero-g indefinite hold, ascent with H2
exhaustion, ion-cannot-lift and atmo-cannot-leave-atmosphere cases, the 15 %
reserve gate, and designer integration (endurance fields, feasible-first sort).
`npm test` passes with `RTS_DEMO`/`RTS_TOKEN` unset.
