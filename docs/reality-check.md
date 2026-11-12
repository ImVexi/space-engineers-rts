# Reality check — R1–R26

Status: **desk verification, plus the first test-server results (2026-11-09).**
A test server now exists: `SE-RTS Test Lab` on VM 100, see
a dedicated test server. Rows marked "test" below were produced by
running it; every other row is still desk/inspection only.

Evidence was gathered read-only against the live install on VM 100 on
2026-11-09. Nothing in this file was produced by running a scenario. Rows marked
`[V]` are verified by documentation or direct inspection; `[U]` has no
evidence; `[D]` is disproven. A `[V]` is not a substitute for the listed
experiment when a phase depends on it.

## Environment facts used below

- Live SE1 dedicated server: VM 100, Pelican/wings container,
  image `ghcr.io/parkervcp/yolks:wine_latest`.
- Launch: `wine DedicatedServer64/SpaceEngineersDedicated.exe -path
  Z:\home\container\config -console -ignorelastsession`.
- App Version `01_210_014`; runtime reports Mono 6.13 (wine-mono); OS reports
  Windows 11 (Wine).
- No plugin loader is installed (no Torch, Pulsar, Magnetar, SEPluginLoader).
- Reference DLLs exist in `DedicatedServer64`: Sandbox.Game, Sandbox.Common,
  VRage.Game, VRage.Library, VRage.Math, SpaceEngineers.Game,
  SpaceEngineers.ObjectBuilders, VRage.Scripting, Newtonsoft.Json, netstandard.
- VRAGE Remote API is **disabled** (`RemoteApiEnabled=false`, port 8081
  unpublished) and is **not** read-only.
- No `dotnet`, `mono`, or `wine` on LXC 106; no host has 6–8 GB RAM free for a
  second server (see `<repo>-PENDING.md`).

## Counts

| Status | Count |
|---|---|
| [V] verified | 6 (R2, R12, R15, R16, R17, R23) |
| [U] unverified | 17 |
| [D] disproven | 3 (R6, R14, R20) — R14 now proven by experiment, not just by config |

## Table

| # | Claim | Status | Evidence / correction (2026-11-09) | Cheapest experiment | Test-server capability needed | Run? |
|---|---|---|---|---|---|---|
| R1 | Procedural asteroids/voxels load around unmanned grids | [U] | No test grid placed away from players; voxel loading not observed. | Place a grid 5 km from an asteroid with no players; plugin voxel/raycast query; check collidable. ~10 min. | Test server + plugin raycast/voxel query | not run — no test server |
| R2 | Jump drives cannot jump inside gravity | [V] | Documented game behaviour; not re-tested here. | Attempt a jump in a planet's gravity; record exact error/telemetry. | Test server + planet + jump-capable grid | not run — no test server |
| R3 | Jump drives have a minimum range | [U] | No measurements. | Jump at 0.5/1/2/5 km; record the smallest that works. | Test server + jump grid | not run — no test server |
| R4 | Charge time and range scale with drives/mass | [U] | No measurements. | 1/2/4 drives at two masses; record charge time and achieved range. | Test server + jump grids | not run — no test server |
| R5 | A jump-strike drone is viable | [U] | Depends on R3/R4; no data. | Compute arrival-within-weapon-range from R3/R4, then prototype one drone. | Test server + R3/R4 results + weapon grid | not run — no test server |
| R6 | Cameras can feed the website | [D] | No video path exists out of the dedicated server. Detection is sensor/camera API data, not frames. | Desk: enumerate camera APIs; confirm there is no stream. Design around plugin raycasts. | None (desk) | desk only |
| R7 | Plugin-spawned blueprints behave like printed ones | [U] | No plugin, no spawn path. | Spawn a blueprint via plugin; compare block count, ownership, ProgramData, conveyors, power against a printed copy. | Test server + plugin + test spawn + printer | not run — no test server |
| R8 | Plugin can read per-block build state | [U] | Not inspected. | Build a partially welded block; read SlimBlock build level/integrity via plugin; record fields. | Test server + plugin | not run — no test server |
| R9 | Sim speed/PCU hold with many automated ships | [U] | Live server has 47 grids but no benchmark under automation. | Spawn 10/25/50 simple grids in one area; record sim speed, memory, tick time; set a cap. | Test server + test spawn | not run — no test server |
| R10 | A shield mod exposes a usable API | [U] | No mod installed or inspected. | Install candidate on test; inspect terminal properties/API; test read/write. | Test server + mod | not run — no test server |
| R11 | Welder-range/nanobot mods work with projections/scripts | [U] | Not tested. | Projector + welders with and without mod; measure completion and component use. | Test server + mods + projector | not run — no test server |
| R12 | PB cannot reach external network | [V] | PB sandbox has no sockets/file system; confirmed by docs/community and by the design of every PB API used here. | None; design must not rely on PB networking. | None (desk) | desk only |
| R13 | Torch vs Magnetar/Quasar compatibility on the real server | [V] | **Resolved without a third-party loader.** SE `01_210_014` ships a native plugin host (`VRage.Plugins.IPlugin` + `VRage.Plugins.MyPlugins`, `-plugin` switch; cfg has an empty `<Plugins/>`). On the test server the cfg `<Plugins><string>Z:\home\container\hermes\HermesRts.Plugin.dll</string></Plugins>` loaded the DLL: SE log `Registered modules from: HermesRts.Plugin` and `Plugin Init: HermesRts.Plugin.HermesRtsBoot`, then backend hello + telemetry (5 owned grids of 27). Torch/Pulsar/Magnetar are therefore **not required** and were not installed. See `docs/plugin-loading.md`. | Done on test server. Remaining: live server is untouched, so R13 is not claimed for live. |
| R14 | Remote API is read-only | [D] | **Disproven on the test server (2026-11-09).** `RemoteApiEnabled=true`, port 8082 reachable. GET `/vrageremote/v1/server`, `/session/grids`, `/session/players`, `/session/planets` all `200`. `POST /vrageremote/v1/session/chat` with body `"hermes test"` returned **200** — a write endpoint executed. (An object body `{"Message": …}` returns `500`; the endpoint wants a raw JSON string.) Live still has `RemoteApiEnabled=false` and 8081 unpublished. | Done. Do not build on "the API is read-only"; it has write endpoints (chat, save, stop, grid delete). | Test server (done) | **run 2026-11-09** |
| R15 | Sensor/camera detection APIs usable server-side | [V] | API surface exists (`LastDetectedEntity`, raycast) in PB/plugin assemblies; not exercised tonight. | On test: read both fields from a sensor and a camera at known ranges; record data fields. | Test server + sensor/camera grid | not run — no test server |
| R16 | Laser/radio range + LOS limits | [V] | Documented ranges; not measured on this build. | Link two grids at max range, then break LOS; record behaviour. | Test server + two grids | not run — no test server |
| R17 | Selective physics/simulation distance still applies | [V] | Documented engine behaviour; not observed here. | Park a grid far from players; observe frozen/unloaded state and wake conditions. | Test server | not run — no test server |
| R18 | Plugin can set PB ProgramData / inject firmware | [U] | Still **not attempted**: a loader now exists (R13), but `firmware_injection` is OFF in the test run and no tagged PB exists in the world. The API surface (`IMyProgrammableBlock.ProgramData`) is not yet reflected. | Next: flag on + a `[HERMES-TEST]` PB on the test server. | not run — feature flag OFF |
| R19 | Plugin code hot-reload without restart | [V] | **No.** Replacing `HermesRts.Plugin.dll` on disk while the server runs has no effect — `MyPlugins` loads assemblies once at init. Every plugin change in this task needed `docker restart hermes-se-test` (~4 min to `Game ready`). | n/a — answered. | test server, 6 restart cycles |
| R20 | Blueprint XML is safe for an LLM to author | [D] | Orientation/quaternion/subtype traps make raw XML unsafe; LLM emits `ShipSpec`, deterministic code assembles. This is a design finding, not a game test. | Desk: attempt one nontrivial blueprint by hand vs assembler; compare failure rate. | None (desk) | desk only |
| R21 | One firmware on every grid; server tells them apart | [U] | Firmware exists as source only; never compiled or run. | Print two grids with identical firmware; verify distinct identities and independent commands. | Test server + plugin + printer + firmware | not run — no test server |
| R22 | Per-grid Custom Data can be injected/updated live | [U] | Injection code is uncompiled; no test. | Plugin writes identity/role; confirm it applies; update live and confirm. | Test server + loader + tagged PB | not run — no test server |
| R23 | A live change can be rolled back from a snapshot | [V] | **Verified on the test server (2026-11-09).** Baseline snapshot 1.9 MB / 47 entries of `Saves/World` + cfg, taken before first start. Mutated `Sandbox.sbc` (appended a comment) and added a stray file; `restore.sh` stopped the container, rebuilt the world dir from the archive and the hashes returned exactly to baseline (`Sandbox.sbc` `df095079…87db4`, `SANDBOX_0_0_0_.sbs` `97f0b90a…002b8c`), the stray file was gone, and the server booted to `Game ready` afterwards. Downtime for stop → restore → ready: **3 m 50 s** (boot alone is ~3 m 40 s, so the restore step is seconds). | Repeat under a live restart window when a real change is applied. | Test server + world copy + snapshot tooling | **run 2026-11-09** |
| R24 | Steam Workshop packaging is feasible and allowed | [U] | Not reviewed with KSW/Workshop rules; no upload. | Review rules; upload a private item containing only our content; install on client and server. | Steam/Workshop account; no game server needed | not run — no account review |
| R25 | PAM-like waypoint/drive/dock via plugin are reliable | [U] | Command executor is uncompiled; no commands issued. | Print a test grid; issue waypoint/drive/dock 20 times; measure success and failure modes. | Test server + plugin + firmware + printer | not run — no test server |
| R26 | Cross-base stock requests and cargo transport work | [U] | Logistics/MRP not built; no two-base world. | Two bases, low stock at one; trigger request; cargo ship fulfils; measure fuel/time/ledger. | Test server + two bases + MRP/ledger | not run — no test server |

## Link-model assumptions (relay planner)

`packages/backend/src/planner/` is pure computation. These are the modelling
choices, not game facts:

| Assumption | Status | Note |
|---|---|---|
| Radio relay chaining carries control through multiple hops | **[U]** | Not tested in-game; the planner assumes a node with a broadcasting antenna can relay for the next hop. |
| Laser links work between moving grids | **[U]** | Planner treats a laser pair as a two-ended link; tracking/aiming while both grids move is unverified. |
| Planets block radio | **[U]** | Default `radioBlockedByPlanets: false`; can be enabled. No in-game measurement. |
| Planets block laser | **approximation** | Spheres of `maxHillRadiusM + margin` (default 1000 m), `laserBlockedByPlanets: true`. Real terrain is not a sphere. |
| Radio edges are directional (`dist <= sender.radius`) | **[U]** | In-game antennas may be mutual; the config flag `radioDirectional` can be turned off. |
| Laser `MaxRange: -1` means unlimited | **[U]** | Read from the definition; the engine may still impose a hidden cap (commonly quoted 40 km). |
| 0.9 spacing safety factor and 2 km relay altitude | design choice | Not game constants; both are config values. |
| Coverage uses a Fibonacci shell and greedy set cover | approximation | Geometric coverage only; no terrain occlusion, atmosphere, or power budget. |
| Battery capacity falls back to the definition when saved `MaxStoredPower` is 0 | **[V] data mapping** | Observed in this save; definitions give 1 MWh (small) / 3 MWh (large). |

## What this means for the build

- Do not start P4 (print/deploy) until R7, R18, R21, R22 and R25 have test-server
  results. They are the load-bearing claims for the first vertical slice.
- R14 is settled against the original plan, now by experiment: the Remote API has
  write endpoints (`POST /session/chat` → 200 on the test server). Live keeps
  `RemoteApiEnabled=false`; the outbound-WebSocket plugin design stands.
- R23 is settled: snapshot/restore works on the test copy with a sub-minute
  restore step and a ~3 m 50 s full cycle. Use the same shape for live changes.
- R13 is settled for the **test server**: the native `VRage.Plugins.IPlugin`
  host loads our assembly under wine-mono 6.13 (no Torch/Pulsar/Magnetar), and
  hello + telemetry reach the backend. The live server is still untouched, so
  its plugin remains unloaded there.
- `[U]` rows now mean "not run", not "no test server": a test server exists and
  a loader works. The remaining ones are feature-flagged write paths (R18, R21,
  R22, R25) that stay OFF until each is exercised deliberately.
