# HermesRts.Plugin

A native Space Engineers Dedicated Server plugin (`net48`). It loads through the
game's own `VRage.Plugins.IPlugin` host, so no Torch/Pulsar/Magnetar install is
needed. It opens one **outbound** WebSocket to the backend; it never listens.

## What it does

- Reports telemetry for grids owned by a configured Steam id: position,
  velocity, power, fuel, links and sim ratio.
- Executes approved orders on the game thread: move/hold/stop via the Remote
  Control autopilot, level flight, dampener control, block properties, laser
  aiming, station conversion.
- Flies the final landing descent (`land_at`) from the backend's handover to
  touchdown, with a hull-bottom ground datum.
- Detects a programmable block that is ready to take over (handoff) and can
  inject the reference firmware.
- Safe mode: after `safeModeAfterSec` without a backend message it stops
  autopilots on owned grids and refuses world orders. A dampener dead-man
  restores dampeners after 6 s without an order on a grid.

Admin actions (spawn, clone, delete, refill, teleport, zero velocity, set
orientation, delete planets, snap dock, save) are **not in this build**.

## Layout

| File | Role |
|---|---|
| `src/NativeBoot.cs` | `IPlugin` entry: init, per-frame `Update`, dispose |
| `src/DsLoaderAdapter.cs` | Loader surface: grids, logging, tick |
| `src/Plugin.cs` | Subsystem owner; queues socket orders onto the game thread |
| `src/BackendLink.cs` | `ClientWebSocket`, token, reconnect, hello/telemetry/ack, dedupe |
| `src/TelemetryCollector.cs` | Owned-grid telemetry |
| `src/ActionApi.cs` | Action channel: reads, flight, landing, blocks, lasers |
| `src/ActionChannel.cs` | Production vs admin classification and refusal text |
| `src/CommandExecutor.cs` | Native move/hold/stop orders |
| `src/LandController.cs`, `src/LandMath.cs` | Final-descent controller and maths |
| `src/LevelController.cs`, `src/LevelMath.cs` | Level flight |
| `src/SafeMode.cs`, `src/DampenerDeadman.cs` | Watchdogs |
| `src/PluginConfig.cs`, `src/FeatureFlags.cs` | Config and flags |
| `src/TorchAdapter.cs`, `src/PulsarAdapter.cs` | Optional loader shims (templates, `// VERIFY:`) |

## Build

```bash
export SE_DS_BIN=/path/to/DedicatedServer64   # Sandbox.Game.dll etc.
dotnet build HermesRts.Plugin.csproj -c Release
```

`SE_DS_BIN` must point at DLLs from your own server install; they are Keen's and
are not in this repository. `net48` is compiled on Linux with
`Microsoft.NETFramework.ReferenceAssemblies`.

Offline control-law tests are separate `net8.0` console projects:

```bash
for t in tests/*/; do dotnet run --project "$t"; done
```

They need no game DLLs.

## Runtime configuration

`plugin.json` beside the DLL, overridable by `HERMES_*` environment variables:

| Variable | Meaning |
|---|---|
| `HERMES_BACKEND_URL` | `ws://<backend-host>:8761/plugin` |
| `HERMES_TOKEN` | Bearer token; required for a non-loopback backend, >= 16 chars |
| `HERMES_SERVER_ID` / `HERMES_AGENT_ID` | Stable ids |
| `HERMES_OWNER_STEAM_IDS` | Your Steam id(s) — which grids are yours |
| `HERMES_FACTION_TAG` | Optional faction tag also treated as yours |
| `HERMES_FIRMWARE_PATH` | Path to `firmware/HermesFirmware.cs` |
| `HERMES_FLAGS` | `telemetry,handoff_detection,safe_mode,command_execution,firmware_injection` |

See `../docs/CONFIGURATION.md`.
