# Passenger rule (T61 item 3) — pilot vs passenger

**Status: implemented, tested, NOT deployed.** Deployment needs a game-server
restart (which disconnects players), so it waits for the owner's go-ahead. The
DLL is built at `plugin/HermesRts.Plugin/bin/Release/HermesRts.Plugin.dll`.

## The bug this removes

The control check treated ANY occupied ship controller as "under control":
The control read looped controllers and used `IMyShipController.IsUnderControl`.
Telemetry once reported *"Passenger Seat 2 is piloting"*, and the backend's
manual-handoff rule (`packages/backend/src/demo/control.ts` + the executor) then
sent that ship **zero** orders. A player who sat in a passenger seat made the
ship stop obeying the system.

## ModAPI properties used (verified against `plugin/refs`, SE `01_210_014`)

Read out of the referenced assemblies (metadata + IL of the getters), not assumed:

| Property | Where | What it actually means |
|---|---|---|
| `IMyShipController.IsUnderControl` | `Sandbox.ModAPI.Ingame.IMyShipController` (implemented by `Sandbox.Game.Entities.MyShipController`) | IL: `ControllerInfo.Controller != null` — "somebody is attached to this seat", NOT "this seat can fly" |
| `IMyShipController.CanControlShip` | same interface | IL: `this.EnableShipControl` — the definition's `EnableShipControl`. **False for a passenger seat**, true for a cockpit / flight seat / control seat / Remote Control |
| `IMyShipController.IsMainCockpit` | same interface (+ `MyShipController.IsMainCockpit`) | whether this controller is the grid's main cockpit |
| `IMyShipController.Pilot` | `Sandbox.ModAPI.IMyShipController` | the `IMyCharacter` in the seat (null for an RC with nobody driving) |
| `IMyControllableEntity.ControllerInfo.ControllingIdentityId` | `VRage.Game.ModAPI` | the identity attached to a seat / driving an RC |
| `IMyCubeBlock.BlockDefinition` (`SerializableDefinitionId`) | `VRage.Game.ModAPI.Ingame.IMyCubeBlock` | `.SubtypeId` names the seat (`Cockpit`, `PassengerSeatLarge`, `PassengerSeatSmallNew`, `PassengerSeatSmallOffset`, `PassengerBench`, `LargeBlockRemoteControl`, …) |
| `IMyCubeBlock` on grid (`grid.GetFatBlocks<IMyShipController>()`) | `Sandbox.ModAPI` | enumerates cockpits, flight seats, control seats and Remote Controls together |
| `grid.PositionComp.WorldAABB` | `VRage.ModAPI.IMyEntity` | the hull box used for "a player is standing inside the hull" |

Passenger seats are `MyCockpit` blocks whose definition subtype starts with
`PassengerSeat` / is `PassengerBench` (names appear in `Sandbox.Game.dll`); the
authoritative signal is `CanControlShip == false`, not the subtype string.

## The classification (`plugin/HermesRts.Plugin/src/ControlReport.cs`)

For every ship controller on the grid:

* **pilot** — `IsUnderControl && CanControlShip` (the first such controller), or
  a Remote Control that a player is driving (`IsUnderControl` is exactly
  `ControllerInfo.Controller != null` for an RC). Reported with identity id,
  display name, controller block name, concrete type, definition subtype and
  `remoteControl`/`main` flags.
* **passengers[]** — every other occupied seat (passenger seat, or a
  non-controlling cockpit). Identity + seat name + type/subtype.
* **aboard[]** — online players whose character is inside the grid's AABB
  (padded 2 m) and not seated in any controller. This is the "standing on the
  hull" case; geometry is the only signal the API gives.

`underControl` / `by` stay for compatibility and are **true only for a real
pilot**. The classified detail rides beside them in telemetry
(`grids[].control`) and in the `is_under_control` action result (`pilot`,
`passengers`, `aboard`, `carryingPassengers`, `standingAboard`, `control`).

The same rule now gates the plugin's own control loops: `LevelController` and
`LandController` only hand the ship to a *pilot*. `PlayerRead` reports
`piloting = IsUnderControl && CanControlShip` (plus `seatCanControl`), so a
passenger seat no longer reads as "piloting" anywhere.

## Limits for a ship with non-pilots aboard (`packages/backend/src/demo/passengers.ts`)

| | Seated passenger | Player standing inside the hull |
|---|---|---|
| cruise cap | **60 m/s** (config cap is 100) | 60 m/s |
| lateral acceleration | **0.5 g** | **0.25 g** |
| vertical acceleration | **1 g** | **0.5 g** |
| dampeners-off vacuum cruise | refused | refused |
| ballistic free-fall descent | refused → dampened descent | refused → dampened descent |

The executor applies them in four places: the leg profile (`maxAccelMps2` +
capped `maxCruiseMps` in `computeLegProfile`), the vacuum dampener release
(refused with an audit row), `beginDescentMeasure` (returns false, so the
dampened descent flies it) and the arrival-guard speed. The plugin's own
`land_at` controller also refuses the free-fall phase when a non-pilot is aboard
(`Job.CarryingPassengers`).

Audit/site wording: one `carrying_passengers` row per mission with the names
(`carrying owner (Passenger Seat 2); …`), plus `demo_passenger_dampeners` /
`demo_descent_passengers` when a phase is refused. `/api/demo/state` nodes carry
`crew: { pilot, passengers, aboard, carrying, standing, limits }`.

## Tests

* Plugin offline: `plugin/HermesRts.Plugin/tests/passenger-math` (43 checks) —
  classification rule, limit maths, AABB standing case, sentences.
* Backend: `packages/backend/tests/passengers.test.ts` (14 tests) — crew
  parsing, compat boolean, limits, passenger-only ship keeps receiving orders at
  ≤ 60 m/s with dampeners on, the same leg without passengers cruises at 100,
  standing player capped harder, piloted ship still gets zero orders, descent
  with a passenger is dampened (control case still probes lift), and
  `/api/demo/state` exposes the crew.

## Deploy (needs a game-server restart — do it only on the owner's say-so)

1. `ssh root@127.0.0.1` and snapshot the world:
   `TS=$(date +%Y%m%d-%H%M%S); tar -czf <snapshot-dir>/pre-passengers-$TS.tgz -C <server-dir>/config SpaceEngineers-Dedicated.cfg Saves/MiniLab5`
2. Back up the live plugin DLL:
   `cp -a <server-dir>/hermes/HermesRts.Plugin.dll <server-dir>/hermes/HermesRts.Plugin.dll.bak-pre-passengers`
3. Install the new build:
   `scp root@<build-host>:<repo>/plugin/HermesRts.Plugin/bin/Release/HermesRts.Plugin.dll <server-dir>/hermes/HermesRts.Plugin.dll && chown 999:987 <server-dir>/hermes/HermesRts.Plugin.dll`
4. Restart the game server (disconnects players, ~4 min boot):
   `docker stop --time 120 hermes-se-test && docker start hermes-se-test`
   Ready when the newest log has `Session loaded` + `Game ready...`.
5. Restart the backend so it loads the new TS: `systemctl restart se-rts-backend`,
   then confirm `GET /api/health` shows `agentConnected: true` and
   `GET /api/demo/state` shows `crew` on a grid.
6. Rollback: restore the `.bak-pre-passengers` DLL, `docker restart`, restart the
   backend, restore the snapshot with `<server-dir>/restore.sh <file>` if needed.
