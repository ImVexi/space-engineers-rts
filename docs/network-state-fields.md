# Antenna / network-state fields — what the plugin can actually read

Measured with a read-only probe in the development build (not part of this
release): it ran 20 s after plugin init and wrote a JSON file on the server.
Every field is either `{"state":"readable","value":…}` (sampled from the live
object) or `{"state":"UNVERIFIED","reason":…}`. Nothing is inferred.

Sample: test server, 2026-11-09 10:16 UTC, `gridsTotal = 27`,
`gridsWithRadio = 2`, `gridsWithLaser = 0`, `gridsSampled = 2`.

## Radio antenna — `Sandbox.ModAPI.IMyRadioAntenna` (inherits `Ingame`)

| Field | Result | Sample |
|---|---|---|
| `Radius` | READABLE | `1000.000244140625` (m) |
| `EnableBroadcasting` | READABLE | `true` |
| `IsBroadcasting` | READABLE | `true` (second grid: `Enabled=false` → `IsBroadcasting` still `true`, see note) |
| `Enabled` | READABLE | `true` / `false` |
| `IsWorking` | READABLE | `true` / `false` |
| `IsFunctional` | READABLE | `true` |

Note (observation, not inference): on the powered-down antenna
`Enabled = false` but `IsBroadcasting = true` and `IsWorking = false`. Do not
treat `IsBroadcasting` alone as "on air"; gate on `IsWorking` **and**
`EnableBroadcasting` **and** `Enabled`.

`IsWorking` is the only field the telemetry collector uses today
(`TelemetryCollector.LinkState`: `Enabled && IsWorking` → `up`), which matches
the samples: the working antenna's grid reports `linkStatus: "up"`, the other
one `"unknown"`/`"down"`.

## Laser antenna — `Sandbox.ModAPI.Ingame.IMyLaserAntenna`

Sampled 2026-11-09 18:01 CST from four `SmallBlockLaserAntenna` blocks on the
owner's satellites (all values READABLE unless noted).

| Field | Result | Sample |
|---|---|---|
| `Status` (`MyLaserAntennaStatus`) | READABLE | `Idle`; during a link `RotatingToTarget` → `SearchingTargetForAntenna` → `Connecting` → `Connected` |
| `TargetCoords` | READABLE | set/read back by `SetTargetCoords` (GPS string) |
| `IsPermanent` | READABLE (settable) | `false` |
| `Range` | READABLE (settable) | `50000` |
| `RequireLoS` | READABLE | `true` (default) |
| `IsOutsideLimits` | READABLE | `false` |
| `Enabled` / `IsWorking` | READABLE | `false` / `false` when idle per profile |
| connected-to | READABLE via `Sandbox.ModAPI.IMyLaserAntenna.Other` | `otherAntennaId`, `otherGridId` (null when idle) |
| range ceiling | READABLE from `MyLaserAntennaDefinition.MaxRange` | `-1` (sentinel: no extra cap beyond `Range`) |
| power draw | READABLE from the block definition | idle `0` MW, turning `0.001` MW, lasing `1.0` MW |

Live lock result: two satellites 37.1 m apart reached mutual `Connected` in 9.8 s
with `Other` resolving to each other's grid; a 2.8 km pair with terrain between
them reached `Connected` on one end while the other stayed
`SearchingTargetForAntenna` for 60 s. Method and full ledger: `docs/naming.md`,
the probe output noted below.

## Static / lock state — `profile`, `list_tagged`

| Field | Result | Sample |
|---|---|---|
| `isStatic` | READABLE | base `true`, satellites `false` |
| `lockedBy.landingGears` / `landingGearsLocked` | READABLE | `1` / `1` on two satellites, `1` / `0` on the others |
| `lockedBy.connectors` / `connectorsConnected` | READABLE | `1` / `0` |
| `lockedBy.totalLocked` | READABLE | `1` on the two parked satellites |

`massKg` follows the physics body: a dynamic grid held by a locked landing gear
reports `0` while parked (observed on `grid:107519913664561774` and
`grid:115081011520040319`), the unlocked ones report 19,003.6 kg. This is why
"mass 0" is not evidence of a static grid — check `isStatic` and `lockedBy`.

## Sun direction — `Sandbox.Game.World.MySector.DirectionToSunNormalized`

| Field | Result | Sample |
|---|---|---|
| `sun` (telemetry frame) | READABLE | `{x: 0.121152, y: 0, z: 0.992634}` (unit vector, world space) |
| `sunState` | READABLE | `"readable"` |

## Per-grid power telemetry (same frame)

| Field | Result | Sample |
|---|---|---|
| `batteryPct` | READABLE | `100` |
| `h2Pct` | READABLE | `50` |
| `solarOutputMw` | READABLE (ratio × panel `MaxOutput`) | `0.002` / `0.015` |
| `solarMaxMw` | READABLE | `0.044` / `0.015` |

## Antenna connectivity — `Sandbox.Game.GameSystems.MyAntennaSystem`

In-process only (needs the `Sandbox.Game` implementation type, so it is
available to a plugin but not to a script). All three calls returned values:

| Call | Result | Sample (grid 1 / grid 2) |
|---|---|---|
| `GetCubeGridGroupSignalReceivers(MyCubeGrid, HashSet<IMySignalReceiverEntityComponent>)` | READABLE | `0` / `0` |
| `GetCubeGridGroupBroadcasters(MyCubeGrid, HashSet<MyDataBroadcaster>, long playerId)` | READABLE | `1` / `2` |
| `GetLogicalGroupRepresentative(MyCubeGrid)` | READABLE | `grid:106775739181630114` / `grid:82594204877303611` |

Also reflected but **NOT exercised** (needs a player / identity to be
meaningful, and a write path is out of scope for this task):
`GetConnectedGridsInfo(MyEntity, MyPlayer, mutual, accessible)`,
`GetAllReachableReceivers`, `GetAllRelayedBroadcasters`, `CheckConnection(...)`,
`GetEntityBroadcasters`, `GetEntityReceivers`.

`groupSignalReceivers = 0` for both sampled grids is a raw count of receivers in
the grid's antenna group; with two lone rovers nothing is expected to receive.
It is not a measurement of link quality.

## What is NOT readable

- `SimSpeed` — no public member on `IMySession` / `MyObjectBuilder_SessionSettings`
  in `01_210_014` (searched all reference assemblies). The `status` frame omits
  the optional `simSpeed` field rather than guessing.
- Faction lookup in `Ownership.cs` (`Session.Factions.TryGetPlayerFaction`)
  compiles, but with `factionTag` empty it was never exercised — treat as
  UNVERIFIED.
- `grid.BigOwners` returns **identity ids**, not Steam ids. Ownership now maps
  the configured Steam ids through `MyAPIGateway.Players.TryGetIdentityId(ulong)`
  (reflected) before comparing; that mapping is what makes the 5 owned grids
  appear in telemetry.
