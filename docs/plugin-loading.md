# Plugin loading — R13 result (native DS plugin host)

**Status: proven on a dedicated server** (SE `01_210_014`, Wine 11 + wine-mono 6.13).
No Torch, Pulsar or Magnetar was installed.

## Toolchain

| Item | Value |
|---|---|
| SDK | .NET SDK **8.0.427** (`dot.net/v1/dotnet-install.sh`, channel `8.0`) |
| Target | `net48`, `LangVersion 7.3` |
| Reference assemblies | `Microsoft.NETFramework.ReferenceAssemblies` 1.0.3 (NuGet, `PrivateAssets=all`) |
| Game references | `SE_DS_BIN=<dir with Sandbox.Game.dll>`, `Private=false` so no game DLLs are shipped |
| Build | `dotnet build plugin/HermesRts.Plugin/HermesRts.Plugin.csproj -c Release -p:SE_DS_BIN=...` |

Reference DLLs are copied from the test server's `DedicatedServer64` into
`plugin/refs/` (git-ignored by `plugin/.gitignore` because of `*.dll`). They are
never committed.

Both configurations build clean:

```
Build succeeded.  0 Warning(s)  0 Error(s)
```

### API corrections found while compiling

Every fix below came from reflecting the shipped `01_210_014` assemblies
(`plugin/refs`), not from guesswork:

| Was | Reality | Fix |
|---|---|---|
| `using Sandbox.ModAPI` + `using Sandbox.ModAPI.Ingame` everywhere | `IMyRadioAntenna`, `IMyLaserAntenna`, `IMyRemoteControl`, `IMyProgrammableBlock`, `IMyThrust`, `IMyGyro`, `IMyBatteryBlock`, `IMyReactor`, `IMyCockpit`, `IMyShipConnector` exist in **both** namespaces | disambiguating `using` aliases to the `Sandbox.ModAPI` twins (block objects implement those) |
| `rc.FlightMode = FlightMode.OneWay` | no `FlightMode` member on `IMyRemoteControl`; the enum lives on `MyAutopilotComponent`, which is not mod API | line removed, `// VERIFY` comment kept |
| `Session.SessionSettings.SimSpeed` | `IMySession.SessionSettings` is `MyObjectBuilder_SessionSettings`; it has no `SimSpeed`. No public `SimSpeed` on the session at all (searched all refs) | `simSpeed` omitted; it is optional in `packages/schemas/src/plugin.ts` |
| `MyWaypointInfo` / `FlightMode` | `Sandbox.ModAPI.Ingame` | kept that namespace imported and aliased only the ambiguous block types |

## How the DLL is loaded

SE's dedicated server has a **native plugin host** in `VRage.dll`:

- `VRage.Plugins.IPlugin` — `Init(object gameInstance)`, `Update()`, `Dispose()`
- `VRage.Plugins.MyPlugins` — `RegisterFromArgs(string[], bool)`; `VRage.dll`
  contains the literal switch `-plugin`
- the dedicated config already carries an empty `<Plugins />` element
  (line 286 of `SpaceEngineers-Dedicated.cfg`)

We registered the DLL through that cfg element, one path per `<string>`:

```xml
<Plugins><string>Z:\home\container\hermes\HermesRts.Plugin.dll</string></Plugins>
```

`Z:\home\container` is the container-side mount of `<server-dir>`, the same
mapping the server's own `-path` argument uses.

`src/NativeBoot.cs` implements `IPlugin`; `src/DsLoaderAdapter.cs` is the
loader-neutral adapter for this host (`LoaderName = "se-native"`). `Init()` runs
before the world exists, so the plugin's own `Init` is deferred until
`MyAPIGateway.Session` and `MyAPIGateway.Entities` are non-null. Ticks come from
`IPlugin.Update()` with a `Stopwatch` delta — no Torch-style tick registration is
needed.

## Evidence (test server, 2026-11-09)

SE log (`<server-dir>/config/SpaceEngineersDedicated_20261109_*`):

```
03:39:03.305 -> Registered modules from: HermesRts.Plugin, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null
03:39:22.985 -> Plugin Init: HermesRts.Plugin.HermesRtsBoot
```

`<server-dir>/hermes/plugin.log`:

```
10:15:56.796 [info] hermes-rts native DS plugin assembly loaded (IPlugin.Init, gameInstance=Sandbox.MySandboxGame)
10:15:58.638 [info] hermes: backend target: ws://127.0.0.1:8762/plugin (serverId=se1-testlab, agentId=hermes-plugin-test-1, token=set)
10:15:58.839 [info] hermes: backend connected: ws://127.0.0.1:8762/plugin
10:20:28.397 [info] hermes: safe mode cleared
```

`safe mode cleared` is only logged after the backend sends a `status` frame, so
the link is bidirectional. Backend side (`GET /api/health`, `GET /api/state`):

```
agentConnected: true
agent: {"agentId":"hermes-plugin-test-1","serverId":"se1-testlab","version":"0.2.0-partB",
        "capabilities":["telemetry","handoff_detection","safe_mode"]}
agentStatus: {"schemaVersion":1,"type":"status","note":"ok"}
units: 5   (telemetry, 2 s interval)
```

`units` are the **owned** grids: the probe saw `gridsTotal = 27`, the telemetry
frame carries the 5 whose `BigOwners` resolve to the configured owner
(`STATISTICS` also reports `GridsCount = 27`, so the 27 is confirmed; the 5 is
the ownership filter, not a loss).

## wine-mono findings (these cost the most time)

1. **`ClientWebSocket` is unusable here.** Every connect failed with
   `WebSocketException: Unable to connect to the remote server` while a raw
   `/dev/tcp` connect to the same host:port succeeded from the same container.
   Replaced by `src/WssClient.cs`, a ~200-line RFC 6455 client over `TcpClient`
   (handshake, masking, ping/pong, close). It works.
2. **Connect by IP literal.** `TcpClient.ConnectAsync(string, int)` goes through
   the mono/win32 resolver; `IPAddress.TryParse` + the `IPAddress` overload
   removes that layer.
3. **`PluginConfig.FromEnvironment()` clobbered `plugin.json`.** Its built-in
   default (`ws://127.0.0.1:8761/plugin`) is non-empty, so the "env overrides
   file" branch always fired and pointed the plugin at its own loopback. Fixed:
   only an explicitly set variable may override the file.

## R19 — hot reload

**Not supported without a restart.** The assembly is loaded once during
`MyPlugins` init; replacing the DLL on disk while the server runs leaves the
loaded copy in place (`File` copy succeeds, behaviour does not change). Every
test in this task that changed plugin code required `docker restart
hermes-se-test` (~4 min to `Game ready`).
