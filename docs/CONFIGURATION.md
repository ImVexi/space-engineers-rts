# Configuration

Two processes read configuration:

- the **plugin**, from `plugin.json` beside the DLL plus `HERMES_*` env vars;
- the **backend**, from `RTS_*` env vars (and `VITE_*` at site build time).

Nothing is compiled in. Tokens and Steam ids live in the environment or in
files you create; none are in the repository.

## Backend — core

| Variable | Default | Meaning |
|---|---|---|
| `RTS_ENV` | unset | `live` = hosted survival instance. `test` = an isolated world you control. Any other value with `RTS_DEMO=1` is a startup error. |
| `RTS_DEMO` | unset | `1` mounts the demo/map routes and the `/demo/` static site. |
| `RTS_DEMO_SURVIVAL` | unset | Must be `1` with `RTS_ENV=live`. Explicit opt-in to the survival runtime. |
| `RTS_TEST_SERVER_MARKER` | unset | Only for a marked test world (`se-rts-test`). `RTS_ENV=live` refuses to boot with it set. |
| `RTS_DEMO_STATE` | unset | JSON world fixture, test worlds only. Refused on `live`. |
| `RTS_BIND` | `127.0.0.1` | Listen address. Non-loopback requires `RTS_TOKEN` (>= 16 chars) or the process refuses to start. |
| `RTS_PORT` | `8761` | HTTP + WebSocket port. |
| `RTS_TOKEN` | empty | Bearer token. Required for every `/api/*` route and both WebSockets when bound off-loopback. |
| `RTS_DATA_DIR` | `data` | Directory for the control DB, settings and audit data. |
| `RTS_DB_PATH` | `<data>/rts.db` | SQLite file. |
| `RTS_FLAGS` | empty | Comma list of feature flags: `reconciler`, `dispatch`, `plugin_orders`, `detector`, `test_api`, `demo_execute`. All off by default; `demo_execute` is auto-enabled only with `RTS_DEMO=1` and `RTS_ENV=test`. On a live instance set `RTS_FLAGS=demo_execute`, otherwise the executor never sends an order. |
| `RTS_MAX_QUEUED_BUILDS` | `8` | Cap on open build missions. |
| `RTS_MAX_ORDERS_PER_MIN` | `60` | Order rate limit. |
| `RTS_AUTO_MISSION_TYPES` | empty | Mission types that may skip approval. Empty = nothing does. |

## Backend — ownership

| Variable | Default | Meaning |
|---|---|---|
| `RTS_OWNER_STEAM_IDS` | empty | Comma-separated allow-list. A non-OFF role also requires the grid's big owner to be on this list (or in the owner's faction). **Empty means nothing is owned**; the backend warns at startup. |
| `RTS_OWNER_STEAM_ID` | empty | The single owner Steam id used by the read-only save detector. |
| `RTS_OWNER_IDENTITIES` | empty | Comma-separated identity display names accepted as "you" by the detector. |

## Backend — reads and detector

| Variable | Default | Meaning |
|---|---|---|
| `RTS_SAVE_DIR` | `data/save` | Local copy of the world save the detector reads. Read-only. |
| `RTS_SBS_PATH` / `RTS_SBC_PATH` | `<save>/SANDBOX_0_0_0_.sbs`, `<save>/Sandbox.sbc` | Explicit save paths. |
| `RTS_DETECTOR_REFRESH_MS` | `60000` | Detector refresh interval. |
| `RTS_CONTROL_SOURCES` | empty | Units treated as control sources (antennas/stations) when the in-game read is unavailable. |
| `RTS_RADIO_LOS` | unset | `1` restores the pessimistic radio radius + line-of-sight model. Radio is range-only in vanilla; this flag exists for regression comparison. |
| `RTS_DEMO_DIST` | `packages/demo-site/dist` | Built site served at `/demo/`. |
| `RTS_BASE_URL` | empty | Public base URL used in generated links, when set. |

## Backend — flight, landing, sim speed

| Variable | Default | Meaning |
|---|---|---|
| `RTS_DEMO_SPEED_MPS` | `100` | Cruise cap, clamped to 1..100 (the Remote Control ignores higher). |
| `RTS_SIMSPEED_MIN` | `0.95` | No new flight orders below this sim speed. |
| `RTS_SIMSPEED_SAMPLE_MS` | `5000` | Sample interval. |
| `RTS_SIMSPEED_HOLD_MS` | `30000` | Sustained-low window that counts as a hold. |
| `RTS_SIMSPEED_ENV` | empty | Optional file with Remote API host/port/key. Live instances leave it empty: the plugin's own `sim_ratio` is the source. |
| `RTS_DEMO_HANDOVER_AGL` | `150` | Height above hull-bottom ground at which the backend hands the landing to the plugin controller (clamped 20..2000). |
| `RTS_DEMO_TICK_MS` | `1000` | Executor tick. |
| `RTS_DEMO_GATE_FRESH_MS` | `30000` | Telemetry freshness the comms gate requires. |
| `RTS_DEMO_MAX_PER_MISSION` | `6` | Drones per mission. |
| `RTS_DEMO_MAX_ACTIVE` | `10` | Concurrent stand-in cap. |
| `RTS_DEMO_MAX_CLIMB` | `3` | Concurrent climbs under one move order; `0` disables. |
| `RTS_DEMO_MAX_GRIDS` | `20` | Refuse a run when more live grids exist (sim-speed protection). |
| `RTS_DEMO_SPAWN_AGL` / `RTS_DEMO_GRAVITY_AGL` / `RTS_DEMO_ORBIT_AGL` | `8000` / `2500` / `40000` | Spawn altitudes for demo planning, metres. |
| `RTS_DEMO_LEAVE_HOLDING` | unset | `1` keeps healthy holding drones at mission end. |
| `RTS_DEMO_ARCHIVE_MS` | `21600000` | Telemetry grids unseen this long are archived. |
| `RTS_COME_TO_ME_LATERAL_M` / `_AGL_M` / `_TIMEOUT_MS` | `40` / `80` / `600000` | Hover beside a player. |
| `RTS_STATION` | `1` | `0` disables converting a holding relay into a station. |
| `RTS_STATION_AFTER_MS` / `_MAX_SPEED` / `_ZERO_SPEED` / `_MIN_AGL` | `30000` / `0.5` / `5` / `100` | Station conversion thresholds. |
| `RTS_STAGING` | on | Thrust staging (hydrogen off when atmo/ion suffice). `RTS_STAGING=0` disables. |
| `RTS_STAGING_DRY` | unset | `1` computes staging but sends nothing. |
| `RTS_RELEASE_RELOCK_GEAR` | unset | `1` re-locks landing gear after a release. |

## Site build (`VITE_*`)

| Variable | Meaning |
|---|---|
| `VITE_DEMO_API_BASE` | API base the site calls. Default same-origin `/api`. |
| `VITE_DEMO_ENV` | `test` marks a test-world build. Leave unset for survival. |

The build stamps both values into `<head>` as meta tags so a deployed bundle can
be checked without trusting the page text
(`node scripts/verify-demo-deploy.mjs --dist packages/demo-site/dist`).

## Plugin (`plugin.json` and `HERMES_*`)

| Key / variable | Default | Meaning |
|---|---|---|
| `backendUrl` / `HERMES_BACKEND_URL` | `ws://127.0.0.1:8761/plugin` | Backend WebSocket. Non-loopback requires a token. |
| `token` / `HERMES_TOKEN` | empty | Must match `RTS_TOKEN`. |
| `serverId` / `HERMES_SERVER_ID` | `se1-live` | Stable id. |
| `agentId` / `HERMES_AGENT_ID` | `hermes-plugin-1` | Plugin instance id. |
| `ownerSteamIds` / `HERMES_OWNER_STEAM_IDS` | empty | Which grids the plugin reports and treats as yours. **Set this.** |
| `factionTag` / `HERMES_FACTION_TAG` | empty | Optional faction tag also considered yours. |
| `firmwarePath` / `HERMES_FIRMWARE_PATH` | `firmware/HermesFirmware.cs` | PB firmware injected on a detected handoff. |
| `flags` / `HERMES_FLAGS` | empty | `telemetry,handoff_detection,safe_mode,command_execution,firmware_injection`. Telemetry, handoff detection and safe mode default ON; command execution and firmware injection default OFF. |
| `telemetryIntervalSec` / `HERMES_TELEMETRY_SEC` | `1.0` | Telemetry cadence. |
| `safeModeAfterSec` / `HERMES_SAFE_MODE_SEC` | `30` | Backend silence before safe mode stops autopilots. |
| `isTestServer` / `HERMES_TEST_SERVER` | false | Only meaningful for a private test build; the public build never enables admin actions. |

A non-loopback `backendUrl` with a token shorter than 16 characters is refused
at startup.
