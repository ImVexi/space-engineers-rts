# Architecture (PART B skeleton)

Short version of how the pieces fit. This describes intended structure, not a
working deployment: the plugin and firmware are uncompiled, and no test server
exists.

## Components

```
┌────────────────────────── game server (VM 100 / test VM) ──────────────────────────┐
│  Space Engineers DS (wine, 01_210_014)                                              │
│    ├─ grids                                                                         │
│    │    └─ Programmable Block: uniform firmware (firmware/HermesFirmware.cs)        │
│    │         • identity/role from Custom Data                                       │
│    │         • local reflex: hold / waypoint / dock / undock                        │
│    │         • IGC status on tag HERMES_STATUS                                      │
│    └─ plugin (C#, loader shim: Torch or Pulsar/Magnetar)                            │
│         • TelemetryCollector  (own-faction grids only)                              │
│         • CommandExecutor     (autopilot/connector; flag OFF)                       │
│         • HandoffDetector     ([HERMES-TEST] / HERMES_TEST=READY)                   │
│         • FirmwareInjector    (ProgramData; flag OFF)                               │
│         • SafeMode            (link silence -> stop autopilots)                     │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │ outbound WSS (plugin dials out; no inbound port)
                                    ▼
┌──────────────────────────── backend (Node/TS, PART A) ─────────────────────────────┐
│  /plugin WS: hello, telemetry, event, order, ack, status, test                      │
│  mission queue · reconciler · comms gate · dispatcher · budgets · audit             │
│  REST/WS on 127.0.0.1 by default; token required for non-loopback                   │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              ▼                                            ▼
   scenarios/runner.ts (stub)                    website (PART A: not built)
   ladder + catalog, JSONL results               map / queue / approvals
```

## Transport and authority

- **Plugin → backend:** outbound WebSocket, JSON, one agent per backend. Every
  order has an `orderId`; the plugin dedupes and acks the same id on retry.
- **Plugin ↔ PB:** IGC only, local reflex. PBs are sandboxed (no sockets), so
  they can never be the backend path.
- **Backend → game:** orders only for units the comms gate considers reachable.
  `RTS_CONTROL_SOURCES` plus link freshness (30 s stub) is the current rule;
  real range/LOS is P5.
- **Remote API:** disabled on the live server and not read-only. Not used.

## Safety layers

1. Feature flags: telemetry/handoff/safe-mode on; command execution and firmware
   injection off until an operator enables them.
2. Safe mode: backend silence beyond the window stops every owned autopilot and
   refuses orders until a message arrives.
3. Test-server refusal: `FirmwareInjector` refuses unless `HERMES_TEST_SERVER=1`;
   the scenario runner refuses unless both
   `RTS_TEST_SERVER_URL` and `RTS_TEST_SERVER_MARKER` are set.
4. Toolchain/loader gates: plugin is source-only until a build toolchain and a
   loader are approved and a test server exists.

## Read-only profiler and relay planner

Two offline components sit beside the control plane and never touch a game
server:

- `packages/backend/src/capabilities/` streams a **copy** of the save plus local
  `CubeBlocks_*.sbc` definitions and emits a `CapabilityProfile` per top-level
  grid (antennas, thrusters with definition-sourced force, power, tanks, roles).
  `SerializedPirateStation` prefabs are excluded. Unknowns are `null`, and every
  definition-sourced number records its subtype.
- `packages/backend/src/planner/` is pure deterministic geometry/graph code:
  link graph (radio directed, laser LOS), reachability, articulation points,
  bridges, node-loss what-if, A→B chains that route around planet spheres, and
  Fibonacci/greedy surface coverage. Assumptions are config and are listed in
  `docs/reality-check.md` as UNVERIFIED where the game is the authority.

They are exposed as `npm run profile`, `npm run plan`, and `/api/plan/*`
(`POST` there is pure computation; every other write route is unrelated).

## Deliberate gaps

- No blueprint assembly/printing (P3), no MRP/ledger (P7), no real pathfinding
  (P6), no website.
- Firmware is one script, but per-grid config distribution is not implemented.
- Loader adapters are templates, not compiling integrations.
- Scenario runner has no game driver; it records `pending`/`refused` only.

## Data contracts

`packages/schemas` is canonical: `hello`, `telemetry`, `event`, `order`, `ack`,
`status`, `test`, plus `LADDER_RUNGS` and `SCENARIOS`. The read-only profile and
planner contracts are `CapabilityProfile`, `CapabilityReport`, `Planet`,
`NodeTemplate`, `LinkModelConfig`, `LinkGraph`, `WhatIfResult`, `ChainPlan` and
`CoveragePlan`. The C# code mirrors those field names by hand; the JSON Schema
bundle is the cross-language check.
