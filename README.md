# space-engineers-rts

RTS-style automation for player-owned ships in Space Engineers: a server plugin,
a LAN control backend, and a web map you steer it from.

The plugin is a native Dedicated Server plugin (no Torch/Pulsar needed). It
reads telemetry from your own grids, flies autopilot orders you approve, lands
ships with a final-descent controller, and reports ground truth back. The
backend plans missions, gates every order through a comms/authority check, and
serves a 3D map of your world. Nothing in the shipped build can spawn, clone,
delete, refuel, teleport or re-own a grid — those actions are not compiled in.

**Status: survival-only public build.** It has been developed and flown against
a private dedicated server; this tree removes the test harness and all
test-server admin actions. Treat it as a working but young system: fly it on a
server you can restart.

## What it does

- **Survival-safe control.** No cheats in the binary: no spawn, clone, delete,
  refill, teleport, orientation write or save action. The plugin only uses
  blocks and APIs a player could use from the cockpit.
- **Ship roles by tag.** `[HERMES-MANAGED]`, `[PERSONAL]`, `[HERMES-BASE]`,
  `[OFF]` (or `HERMES_ROLE=` in CustomData). Untagged grids get no orders.
- **Survival refuel loop.** A managed ship that runs low returns to its base,
  lands, waits for refuel/charge, then relaunches on your approval.
- **Landing controller.** Final descent is flown in-plugin from 150 m AGL to
  touchdown, with a hull-bottom ground datum and a gear lock.
- **Coverage planner.** Radio-relay and laser-backbone placement with terrain,
  redundancy and cost-per-covered-cell scoring; the heatmap is the authority.
- **Sim-speed aware.** Orders are held when the world slows below 0.95 sim
  speed, using the plugin's own `simRatio` sample (no Remote API needed).
- **Approval and budgets.** Every mission has a budget and a loss limit; the
  kill switch stops reconciliation and dispatch.

## Requirements

| Item | Version / note |
|---|---|
| Space Engineers Dedicated Server | `01_210_014` (assembly version 1.0.0.0). The plugin references the server's own DLLs at build time; other builds may work but are untested. |
| Server OS | Windows, or Linux running the DS under Wine (tested with Wine 11). |
| Server runtime | .NET Framework 4.8 (the plugin targets `net48`). Windows: built in. Linux/Wine: a wine prefix with `wine-mono` or .NET 4.8 installed. |
| Backend host | Any machine on the same LAN as the game server: Linux or Windows, Node.js 20.19+ (npm 9+). |
| Build toolchain | .NET SDK 8 (uses `Microsoft.NETFramework.ReferenceAssemblies` for `net48`) and Node.js 20.19+. |
| Browser | A current Chromium/Firefox for the map. WebGL2 required. |

No game assets are included. You copy the reference DLLs from your own
`DedicatedServer64` folder to build the plugin — they are Keen's and are not
redistributable.

## Install

### 1. Get the plugin

Download the release zip (`HermesRts.Plugin.dll`, `plugin.json.example`,
`INSTALL.txt`), or build it from source — see [docs/BUILDING.md](docs/BUILDING.md).

```bash
git clone <your-fork-url> space-engineers-rts
cd space-engineers-rts
npm ci

export SE_DS_BIN=/path/to/your/DedicatedServer64   # contains Sandbox.Game.dll
dotnet build plugin/HermesRts.Plugin/HermesRts.Plugin.csproj -c Release
```

Output: `plugin/HermesRts.Plugin/bin/Release/HermesRts.Plugin.dll`.

### 2. Install it into the dedicated server

Stop the server first. Copy the DLL next to the server executable and register
it in `SpaceEngineers-Dedicated.cfg`:

```xml
<Plugins>
  <string>plugins\HermesRts.Plugin.dll</string>
</Plugins>
```

Put `plugin.json` beside the DLL (see `deploy/plugin.json.template`):

```json
{
  "backendUrl": "ws://<backend-host>:8761/plugin",
  "token": "<same token as RTS_TOKEN>",
  "serverId": "se1",
  "agentId": "hermes-plugin-1",
  "ownerSteamIds": [ 0 ],
  "flags": "telemetry,handoff_detection,safe_mode,command_execution"
}
```

Replace `0` with your own Steam id (a 64-bit number). Start the server. The
plugin logs to the server log; a successful start prints
`hermes plugin <version> initialised` and `backend connected`.

### 3. Run the backend

```bash
cp deploy/se-rts.env.example .env      # then edit it
RTS_ENV=live RTS_DEMO=1 RTS_DEMO_SURVIVAL=1 \
RTS_BIND=0.0.0.0 RTS_PORT=8761 \
RTS_TOKEN='<32+ random chars>' \
RTS_OWNER_STEAM_IDS=<your-steam-id> \
npm start
```

The backend serves the API and the map at `http://<backend-host>:8761/demo/`.
Build the site first if `packages/demo-site/dist` is missing:

```bash
npm run demo:build
```

### 4. In game

Put a powered radio antenna on one base and tag a block `[HERMES-BASE]`. Tag the
hulls the system may fly `[HERMES-MANAGED]`; tag everything else `[PERSONAL]` or
`[OFF]`. Full walkthrough: [docs/IN-GAME-SETUP.md](docs/IN-GAME-SETUP.md).

## Configuration

Environment variables are the source of truth. The common ones:

| Variable | Default | Meaning |
|---|---|---|
| `RTS_ENV` | unset | `live` for a hosted survival server. `test` only for an isolated world you own. |
| `RTS_DEMO` | unset | `1` mounts the map/demo routes. |
| `RTS_DEMO_SURVIVAL` | unset | `1` is required with `RTS_ENV=live`; it is the explicit survival opt-in. |
| `RTS_BIND` | `127.0.0.1` | Listen address. A non-loopback bind refuses to start without a token. |
| `RTS_PORT` | `8761` | HTTP/WS port. |
| `RTS_TOKEN` | empty | Bearer token for `/api/*` and both WebSockets. Required off-loopback, >= 16 chars. |
| `RTS_OWNER_STEAM_IDS` | empty | Comma-separated Steam ids that may own managed grids. **Set this**; with it empty the backend warns and automates nothing. |
| `RTS_OWNER_STEAM_ID` / `RTS_OWNER_IDENTITIES` | empty | The owner's Steam id / identity display names, used by the read-only save detector. |
| `RTS_DATA_DIR` | `data` | Control DB, audit log, settings. |
| `RTS_SAVE_DIR` | `data/save` | Local copy of the world save for the read-only handoff detector. |
| `RTS_DEMO_DIST` | `packages/demo-site/dist` | Built site served at `/demo/`. |
| `RTS_SIMSPEED_MIN` | `0.95` | No new flight orders below this sim speed. |
| `RTS_DEMO_SPEED_MPS` | `100` | Cruise cap for a flight leg. |
| `RTS_STATION` | `1` | Allow a holding relay to be converted to a station. |

The full list, including planner, staging and landing knobs, is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Safety

- **LAN only.** The control API is not designed to face the internet. Bind it to
  the LAN or localhost, keep `RTS_TOKEN` set, and never port-forward it.
- **Survival by construction.** `RTS_ENV=live` refuses to boot if a test-server
  marker or a world fixture is present, and the admin actions are not in the
  binary at all.
- **Nothing moves without a role tag and an owner match.** Untagged, unowned or
  `[OFF]` grids are read-only.
- **Kill switch** stops reconciliation and dispatch; safe mode stops autopilots
  when the backend goes silent.
- See [docs/SAFETY.md](docs/SAFETY.md).

## Troubleshooting

Short version: check the plugin loaded (`hermes plugin ... initialised` in the
server log), `agentConnected: true` in `/api/health`, and that the base has a
powered antenna. Details and fixes: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — install, upgrade, uninstall
- [docs/BUILDING.md](docs/BUILDING.md) — build the plugin, backend and site from source
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every environment variable
- [docs/IN-GAME-SETUP.md](docs/IN-GAME-SETUP.md) — tags, base, roles
- [docs/SAFETY.md](docs/SAFETY.md) — what the system refuses and why
- [docs/FAQ.md](docs/FAQ.md) — short answers to the usual questions
- [docs/architecture.md](docs/architecture.md) — components and data flow
- [docs/ship-roles.md](docs/ship-roles.md) — roles, tags, ownership
- [docs/survival-mode.md](docs/survival-mode.md), [docs/survival-loop.md](docs/survival-loop.md)
- [docs/flight-guards.md](docs/flight-guards.md), [docs/simspeed.md](docs/simspeed.md)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Development

```bash
npm ci
npm test                 # backend, schemas, site and firmware tests
npm run typecheck        # root tsc
npm run demo:test        # site tests only
npm run demo:build       # typecheck + vite build
npm run dev              # backend on 127.0.0.1:8761, all flags off
npm run fake-plugin      # fake plugin for the WS protocol
```

The plugin builds only with `SE_DS_BIN` set. Its offline control-law tests are
plain console projects under `plugin/HermesRts.Plugin/tests/`.

## Licence and assets

MIT — see [LICENSE](LICENSE). This project contains only original code. It does
not include, bundle or redistribute any Keen Software House assets (models,
textures, definitions, sounds or game binaries). Space Engineers is a trademark
of Keen Software House; this project is unaffiliated with it.
