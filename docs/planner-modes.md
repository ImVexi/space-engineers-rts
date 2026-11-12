# Planner modes — radio chain, layered tiers, planet coverage, assignment

Status: **shipped** in the backend planner (pure planning; no game orders).
Code: `packages/backend/src/planner/relay.ts` (chain + layers),
`packages/backend/src/planner/planetCoverage.ts` (coverage grid + rovers),
`packages/backend/src/demo/designer/classification.ts` (hull v2),
`packages/backend/src/demo/designer/hetero.ts` (assignment),
`packages/backend/src/demo/designer/modes.ts` (designer wiring).
Tests: `packages/backend/tests/planner-modes.test.ts` (28 cases).
Everything geometric is labelled **SIMULATED**; per-pair radio quality is
**UNVERIFIED** (no game measurement of a link exists in the planner).

## Request

`POST /api/demo/designer/plan` accepts the existing `constellation`/`connect`
modes plus:

```json
{
  "mode": "radio-chain | layered | cover-planet",
  "planet": "EarthLike",
  "base": { "planet": "EarthLike", "altitudeM": 1800 },
  "hullId": "prefab:Eradicator_mk.1",
  "hullIds": ["tagged:grid:…", "prefab:Eradicator_mk.1"],
  "rangeMargin": 0.9,
  "maxHopM": 45000,
  "keepFirstHopOnBase": true,
  "reachM": 0,
  "bearingDeg": 0,
  "atmoCount": 3, "h2Count": 1, "zeroGCount": 4,
  "k": 1, "cellDeg": 10, "roverFallback": true,
  "maxNewBuilds": 40
}
```

`base` defaults to **BASE-01**: 1,800 m AGL above the mean surface on the
`+Y` radial (overridable with `base.gps` or `base.altitudeM`).
`hullIds` restricts the assignment pool; without it every available hull
(prefab + owner-tagged) is a candidate. Each mode returns one option with the
usual `positions`, `links`, `spofs`, `coveragePct`, `reasons`, `summary`,
`endurance`, and the new `tiers`, `assignment` and (cover-planet) `coverage`.

`GET /api/demo/designer/coverage?planet=EarthLike&mode=cover-planet&k=1&cellDeg=10`
returns the same geometry as a heatmap (`cells: [{latDeg, lonDeg, coveredBy,
byTier}]`), plus per-tier node lists, footprint radii, SPOFs and rover spots.
`mode=radio-chain|layered` returns the footprint of that network instead.
`tier=atmo|station|zero-g` restricts the cover-planet computation to one layer.

## Hull classification v2 (T22)

Derived from the measured profile, not from memory:

| Field | Rule |
|---|---|
| `tierEligibility.atmo` | `thrust.atmo > 0`; ceiling **10 km AGL** (atmo effectiveness is ~0 above the ~10 km scale height) |
| `tierEligibility.h2` | `thrust.h2 > 0`; no ceiling, but burns fuel |
| `tierEligibility.ion` | `thrust.ion > 0`; usable from **45 km AGL** (orbital spawn) or carried |
| `stationCapable` | always true: `convert_to_station` holds any grid at any altitude for free (T18) |
| `carriedAboveM` | atmo-only hull above its ceiling, or a station-only grid |
| `flightMode` | `profile.flightMode.recommended`, else from `thrustPerDirection`: lift-dominant (`down < 0.25 x up` or lateral `< 0.25 x up`) → **level**, else **autopilot** |
| `roles` | radio-relay; laser-hub (>=3 ports), laser-relay (2), laser-leaf (1); converter (1 laser + radio); ground-laser-rover (laser + no hover thrust) |
| `costRank` | small grid < unknown < large, then mass (cheapness only, never a capability claim) |

Measured overrides live in `MEASURED_FLIGHT_MODES`: **SAT-R-0001** is
lift-only (T24), so it is `level` even when the plugin has no per-direction
envelope. A hull without an envelope and without a measured override says so in
`notes` and is assumed `autopilot` (never silently labelled level).

Examples:

* `Eradicator_mk.1` — ion only, 50 km radio → `SPACE_RELAY`, eligible
  `>= 45 km` or carried, autopilot.
* `SAT-R-0001` — atmo only, 50 km compact radio, lift-only → `ATMO_RELAY`
  (<= 10 km), `flightMode: level`, above 10 km it must be carried and stationed.
* A hull with 3 lasers and a radio is `laser-hub` + `radio-relay`; a hull with
  1 laser + radio is also a `converter` (laser → radio bridge).

## `radio-chain` — radio-only "station in the sky" (T16)

Algorithm:

1. hop limit = `min(maxHopM (default 45 km), rangeMargin x radioRange)`.
2. The first node climbs radially above the base. It is placed at the zero-g
   altitude when `zeroG - baseAlt <= hopLimit`, otherwise the climb is split
   into `ceil(climb / hopLimit)` equal hops.
3. No laser requirement at all; lasers are optional.
4. `keepFirstHopOnBase: false` starts the chain at zero-g displaced one hop
   sideways, so the base link is reported separately and usually fails.
5. `reachM > 0` extends the chain horizontally at the zero-g altitude with
   hops inside the same limit (great-circle chords, not surface arcs).
6. Every node inside gravity carries `stationPreferred: true` and a warning
   that hover costs fuel/power unless it is stationed (T18).

EarthLike / BASE-01 / 50 km radio / margin 0.9:

| Quantity | Value |
|---|---|
| hop limit | 45.0 km |
| nodes | **1** (43.7 km AGL, zero-g) |
| first hop | 41.9 km (AGL 43.7 - base 1.8) |
| hold cost | zero (gravity 0.00 m/s²) |
| surface footprint | 0.5 % (a single 50 km radio sees a small cap, not a planet) |

With a 20 km radio the same climb needs 3 nodes (18 km hops) and still reaches
zero-g. `maxGapM` includes the base downlink.

## `layered` — atmo/station tier + H2 station tier + zero-g bridge (T17)

| Tier | Altitude (default) | Hull hint | Hold |
|---|---|---|---|
| `atmo` | 8 km (6–10 km; capped by the measured atmo ceiling) | atmo (hover, power) | station = free |
| `h2` | 15 km (10–20 km) | H2 station | station = free |
| `zero-g` | max(45 km, gravity cutoff) | any | free, no station needed |

Each tier is a horizontal ring sized so consecutive nodes are inside the hop
limit (the chord at altitude, not a surface arc); each tier is linked to the
next by its first node, and the base is part of the link graph. EarthLike with
3 atmo + 1 H2 + 4 zero-g (8 ships): whole-network footprint 19.1 %, max gap
39.3 km, all 8 nodes reachable from BASE-01. Tier coverage is 15.3 % (8 km
ring), 12.8 % (15 km node), 2.0 % (zero-g ring) — a spine, not a coverage plan;
use `cover-planet` for coverage.

## `cover-planet` — minimum relay set per tier (T28)

Footprint per node, curvature-corrected (`phi` from the law of cosines); the
flat `sqrt(R² - h²)` value is reported alongside for comparison. The
**measured radio range** is used for the footprint; `rangeMargin` applies to
node-to-node hops only.

| Tier | Altitude | 50 km radio: curvature / flat footprint | Nodes k=1 | Nodes k=2 |
|---|---|---|---|---|
| `station` (recommended) | 15 km | **43.6 km / 47.7 km** | **14** relays + 15 bridges = 29 ships | 25 + 7 = 32 |
| `atmo` | 8 km | 47.6 km / 49.4 km | 13 + 9 = 22 (needs an atmo hull with a long antenna; prefabs only → 1 km drone → 0 coverage) | fleet-dependent |
| `zero-g` | 45 km | **16.5 km / 21.8 km** | 80 + 4 = 84 | 142 + 0 = 142 |

Coverage is 100 % of a 10° lat/long grid (648 cells) at k=1 and k=2; the
station layer is recommended because it needs ~5x fewer ships than zero-g
(T28's "low station layer for ground coverage, a few zero-g relays only as the
bridge"). k=2 means every cell is seen by two independent nodes; it does not
make the link graph 2-connected, and SPOFs are still reported (station k=1 has
11, station k=2 has 14 in the tested fleet).

Bridging: coverage nodes are not necessarily within 0.9R of each other or the
base, so the planner walks each disconnected component toward the base along a
great circle at the tier altitude, inserting bridge nodes at hop-sized steps.
Bridges are counted separately (`bridgeCount`) but are real ships and appear in
the assignment.

Rover fallback: cells no sky node reaches (union over the requested tiers) are
clustered into at most 24 representative spots, returned with lat/lon and the
reason "no sky node reaches this cell". With the station layer at 15 km on
EarthLike there are none; a tier above the radio horizon (e.g. 70 km with a
50 km radio) produces 100 % uncovered and shows the fallback list.

## Heterogeneous assignment (T22)

Hard constraints, checked in this order: radio length (hull antenna x margin
>= the slot's longest incident link), laser ports/range (per laser edge), tier
eligibility (atmo <= 10 km, H2 any, ion >= 45 km or carried; zero-g needs no
hold thrust), then the T30 power budget **when the module exists**. The power
module is a separate workstream: `powerBridge.ts` loads it at request time and
records `power.skipped = true` with a note when absent — no MW number is
invented.

Objective, in order: avoid a new build (reuse an owner-tagged ship), avoid a
carrier tow, avoid station-only hulls, fewer hull types, cheaper/smaller hull,
less movement. One ship fills one slot, so "minimise ships" here means "fill
every slot with the fewest new builds"; an existing hull always beats a clone.

Example (EarthLike layered plan, 8 slots):

```
SAT-R-0001 (role radio-relay, radio 50 km, flight level) -> t1 at 8.0 km (atmo tier):
needs 39.3 km of radio, hull has 50 km; atmo thrust holds up to 10 km; station hold
is free (T18); lift-only -> level flight (T25), never face-the-waypoint autopilot;
reuses an existing ship 29.0 km away

Eradicator_mk.1 (role radio-relay, radio 50 km, flight autopilot) -> t101 at 15.0 km
(inside gravity): needs 39.2 km of radio, hull has 50 km; not self-deploying at
15.0 km: carried, then stationed; station hold is free (T18); new build
```

Every assignment carries `why`, `requiredRadioM`, `radioHeadroomM`, `moveM`,
`reused`, `carried`, `role`, `flightMode`. Unfilled slots carry the **exact
gap**, e.g.:

```
slot long needs a 60.0 km radio link; the longest antenna available is
50.0 km (Eradicator_mk.1)
```

plus `missingHullTypes[].need` ("atmo relay", "H2 relay for the in-gravity
tier", "ground relay / rover"). The response also reports `shipCount`,
`newBuilds`, `existingUsed`, `carriedCount`, `hullTypes` and `power`.

`execute` refuses a heterogeneous plan (`409 hetero_execute_unsupported`) with
the per-slot hull list, because the executor clones one hull into every slot in
this build; launch each assigned hull in its own mission (or restrict
`hullIds` and replan). Homogeneous plans execute as before.

## Determinism and limits

All geometry is deterministic (Fibonacci/grid sampling, fixed tie-breaks by
slot index/hull id), so repeated plans are byte-identical apart from
`createdAt`; the tests assert this for coverage and assignment.

Not modelled: terrain (a cell marked covered may be blocked by a mountain, which
is why rover fallback exists but is conservative), laser edges in these three
modes (assignment supports them, the modes are radio-only by design), antenna
power draw at a tuned range (T29), and the actual game link state (guarded by
the comms gate at execution time).
