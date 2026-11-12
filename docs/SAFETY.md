# Safety

The system is built so that the safe state is the default, and so that a
mistake in configuration cannot turn it into a cheat console.

## What this build cannot do

The public plugin is compiled without the test harness. These actions do not
exist in the DLL at all, and asking for one returns
`not available in survival build: <name>`:

`spawn_prefab`, `clone_grid`, `delete_grid`, `refill_grid`, `teleport`,
`teleport_player`, `zero_velocity`, `set_orientation`, `ownership`,
`delete_planets`, `snap_dock`, `despawn_state`, `save`.

`deploy/build-plugin.sh` greps the produced DLL for the corresponding CLR
handlers and fails the build if any is present.

## What the backend refuses

- **Survival mode is structural on a hosted server.** With `RTS_ENV=live` the
  backend refuses to boot if `RTS_TEST_SERVER_MARKER` or a world fixture is set.
  Survival mode is not a flag you can flip; it is the absence of the test pair.
- **No order without an owned, role-tagged grid.** The comms gate requires a
  telemetry-fresh path to a powered `[HERMES-BASE]` antenna; otherwise the
  mission is refused with `comms_denied` and nothing is sent.
- **Untagged means OFF.** An untagged grid, an NPC grid or debris is read-only,
  even if it appears selectable on the map.
- **Approval by default.** Missions need approval; `auto` is honoured only for
  mission types an operator listed in `RTS_AUTO_MISSION_TYPES` (shipped: none).
- **Budget and loss limits.** Every mission carries a budget; hitting it pauses
  the mission and raises an alert.
- **Kill switch.** Stops reconciliation and dispatch process-wide.

## Flight guards

Every multi-step flight goes through the executor, which applies:

- fuel/charge reserve per leg and a per-step budget,
- a speed cap (`RTS_DEMO_SPEED_MPS`, max 100 m/s),
- separation and clearance guards, including a hard ground guard below 150 m AGL,
- sim-speed gating: no new flight orders below `RTS_SIMSPEED_MIN` (0.95),
- manual-handoff: if a player takes control, the mission stops ordering the hull.

Details: [flight-guards.md](flight-guards.md).

## Failure behaviour

- **Backend goes silent:** the plugin's safe mode (30 s) stops autopilots on
  owned grids and refuses further world orders until the backend returns.
- **A hull left with dampeners off:** a dead-man restores dampeners after 6 s
  without a backend order on that grid. This runs on the game thread, so it does
  not depend on the backend's event loop.
- **Touchdown confirmed is landed:** housekeeping after touchdown (gear lock)
  failing is a warning on a landed mission, never a retried landing.

## Network exposure

The control API and both WebSockets are LAN tools. They are authenticated with a
single bearer token and are not hardened for the public internet: there is no
TLS, no rate-limit beyond the order cap, and the map exposes your world state.
Bind to the LAN, keep the token secret, and do not port-forward the backend.
The game server port is separate; the plugin only makes an outbound connection.
