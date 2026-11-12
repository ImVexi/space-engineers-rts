# Survival mode — what the backend refuses, and how it is detected (T74)

Status: **backend half on `t74-survival`** (plugin half in the same branch;
both must deploy together for the live build to be honest). This is the
backend-side rule: the plugin's live build has no cheat code compiled in, and
the backend refuses to *send* one. A refusal that never reaches the game looks
like a policy; a refusal that fails at the plugin looks like a bug.

## The flag

`resolveSurvivalMode()` in `packages/backend/src/demo/survival.ts`:

```
survivalMode = NOT (RTS_ENV == "test" AND RTS_TEST_SERVER_MARKER == "se-rts-test")
```

That pair is exactly the lock the demo routes already require, so nothing new
has to be configured: the marked test world is the ONE place a cheat can run.
Unset env, a missing marker, `RTS_ENV=production`, a copied service — every
other combination is survival. The default is the safe one on purpose.

The flag is exposed for operators and the UI:

* `GET /api/health` → `survivalMode: true|false`
* `GET /api/demo/state` → `survivalMode: true|false`
* the demo badge reads `SURVIVAL MODE — no spawning, no deletes, no teleports`
  when the marker is absent, `TEST SERVER — SE-RTS Test Lab` when it is present.

### The marker is no longer a boot lock

Before T74 `resolveDemoEnv()` threw when `RTS_TEST_SERVER_MARKER` was missing, so
a hosted deployment could not start the demo at all. Now the marker decides
survival mode, not whether the routes load: a hosted process boots, serves its
routes, and refuses the admin capabilities at runtime with a reason. `RTS_ENV`
must still select a known mode to mount the demo runtime — that part of the lock
is unchanged (T78 below).

### T78: `RTS_ENV=live` — the hosted survival instance

A second backend pointed at the owner's live server must not pretend to be the
test world just to mount the runtime. `RTS_ENV=live` mounts the same demo
runtime **in survival mode**, and is stricter than the old "test without the
marker" path:

```
RTS_DEMO=1
RTS_ENV=live
RTS_DEMO_SURVIVAL=1        # explicit opt-in; RTS_ENV=live alone is a boot error
# RTS_TEST_SERVER_MARKER   absent, and a boot ERROR if present (any value)
# RTS_DEMO_STATE           absent, and a boot ERROR if present (world fixture)
```

* `DemoEnv.testLocked` is false, the badge is the survival one, and
  `resolveSurvivalMode()` is true (it is only false for `test` +
  `se-rts-test`).
* **The marker is refused, not ignored**: `resolveDemoEnv()` throws
  `must not carry RTS_TEST_SERVER_MARKER` for `RTS_ENV=live`, so one copied env
  line cannot turn the live instance into a cheat-enabled backend.
* `demo_execute` is **not** auto-enabled outside `RTS_ENV=test`
  (`config.ts`), so a live instance must set `RTS_FLAGS=demo_execute`
  explicitly; that is the honest way round (the flag is stated in the unit,
  not inherited from an env name).
* Deployment template and runbook: `deploy/live/`.

Tests: `packages/backend/tests/demo-live-env.test.ts` pins the four
combinations (live mounts survival, live needs the opt-in, live refuses the
marker and a fixture, the marked test world is unchanged, another env name is
still a boot error) and boots a live runtime to prove `/api/health` and
`/api/demo/state` report `survivalMode: true` while `/api/test/order` is 409
`survival_mode`.

## What is refused

Admin actions (`ADMIN_ACTIONS`): `spawn_prefab`, `clone_grid`, `delete_grid`,
`refill_grid`, `teleport`, `teleport_player`, `zero_velocity`,
`set_orientation`, `ownership`, `delete_planets`, `snap_dock`.

Admin features (`ADMIN_FEATURES`): `fillWithClones`, `harness_spawn`,
`delete_cleanup`.

Where it is enforced:

| Path | Survival behaviour |
|---|---|
| `POST /api/demo/designer/plugin` | 409 `survival_mode` + `survival_refused` audit row; the action never reaches the plugin |
| `POST /api/demo/designer/execute` with `fillWithClones` | 409 `survival_mode` |
| `POST /api/demo/designer/execute` with `ignoreReach` | 409 `survival_mode` (admin override is test-world only) |
| `POST /api/demo/move-to` with `ignoreReach` | 409 `survival_mode` + `survival_refused` audit row, before the preflight |
| `POST /api/test/order` | the whole endpoint is 409 `survival_mode` + audit row (it IS the test channel) |
| executor, `queued` spawn branch | mission drone fails with "not available in survival build: cannot spawn …" + audit row |
| executor, `cleanupStale` | `delete_grid` is refused, `deleted` is `[]`, one `survival_refused` audit row per grid |
| executor, station stop | no `zero_velocity` (see below) |

Every refusal carries `reason: "survival_mode"` (the 409 body's `code` too) and
names the action, so a client can tell policy from a fault.

A lost node is recovered in survival by re-shaping neighbours, assigning an
owned spare that can reach the slot, or a build request — never by spawning,
teleporting or deleting.

### What a feature loses in survival, and why (2026-11-11)

Every action the executor, provisioner, power poller, staging, autotune, naming
and demo routes send is now pinned by `tests/survival-feature-actions.test.ts`:
each one is either a production action (answered live) or an admin action the
backend refuses before the wire with `reason: 'survival_mode'`. Nothing falls
through to a channel the live build does not compile.

| Feature | Cannot send | Why |
|---|---|---|
| missions queued as spawn | `spawn_prefab`, `clone_grid` | survival has no spawn; a lost node is re-shaped, reassigned to an owned spare, or built |
| `cleanupStale` / `delete_cleanup` | `delete_grid` | survival never removes world content |
| ownership takeover on spawn | `ownership` | a grid is given or merged by its owner, never stolen |
| provisioner `teleportOwner` | `teleport_player` | moving the owner character is a cheat and does not exist live |
| test-world station path | `zero_velocity` | writing the physics body is a teleport; survival stations on dampeners only |
| world trim (test world only) | `save`, `delete_planets` | the live server owns its saves and its planets |

### Reclassified: cockpit-grade capabilities are production

These were on the test/admin list and were wrong there: each is a read, a HUD
marker, a grid's own autopilot switch, or ownership-guarded naming, so a player
could do it from the cockpit and the live build must answer it.

| Action | Verdict | Notes |
|---|---|---|
| `ai_off` | production | autopilot off + waypoint clear + thrust/gyro override clear on a grid. The executor's secure sequence is `release -> diag -> wake -> ai_off -> move`, so it has to work in survival |
| `list_players` | production | read-only; `PlayerRead.CollectJson`, same shape as telemetry |
| `gps_add`, `gps_remove`, `gps_list` | production | HUD markers only; a player can add/delete these themselves |
| `rename_grid` | production | CustomName write, **owned or unclaimed grids only** (`GridOwnedBy`: the caller's identity must be a big owner) |
| `dock_state` | production | read; the live build answers UNKNOWN with the reason because `snap_dock` jobs only exist in the test build |
| `planets` | production | read-only planet list/geometry (provisioner `teleportOwner` planet pick) |
| `suit_radio` | production | read-only: the owner character's `RadioBroadcaster.BroadcastRadius` |
| `save` | **test-only** | a server save mutates the world's persistence; the live server owns its saves |

## Order channels

The plugin compiles two order channels (T75):

| `orderType` | Channel | Compiled in | Carries |
|---|---|---|---|
| `action` | production | **every** build (live and test) | legitimate actions: reads (`inspect`, `profile`, `list_players`, `planets`, `suit_radio`, `dock_state`), dampeners/block writes, flight handover, landing, laser links, naming (`rename_block`, `rename_grid`), HUD markers (`gps_*`), `ai_off` |
| `test` | test | the test-world build only | admin cheats and test-harness-only names (`save`, `delete_planets`, `damage`, `wave`, `reset_world`, `despawn_state`, `refill`, ...) |

The backend routes on the pair `(orderType, params.action)` in
`packages/backend/src/demo/channel.ts`:

```
decideOrderChannel('test', action, survivalMode)
  action in PRODUCTION_ACTIONS      -> orderType 'action'  (both modes)
  action admin / unknown, survival  -> refused: 'survival_mode' (nothing sent)
  action admin / unknown, test      -> orderType 'test'
  orderType native (move/hold/stop/
    waypoint/drive/dock/undock/
    repair/laser)                   -> unchanged
```

Why this exists: sending a legitimate action as `test` worked on the test world
and died at the plugin everywhere else, because the live build has no test
channel at all. Now `set_dampeners`, `inspect`, `land_at`, `set_block_props`,
`profile` and the rest go out as `action` in BOTH modes. Admin actions stay on
`test` and are refused before the wire in survival.

Where the channel is decided:

* **executor** — `send()` and `sendRaw()` (the central helpers: the decision
  picks both the wire `orderType` and the stored `createOrder` record), plus
  the standalone payload builders (`is_under_control`, `probe_ground`,
  `set_block_props` for collision avoidance, `inspect`, `set_dampeners`,
  `delete_grid` cleanup).
* **poller / provisioner / staging / autotune / designer / demo routes** —
  the profile reads and block writes each call `decideOrderChannel` once
  (`resolveSurvivalMode()` where there is no executor).

A refused send writes one `survival_refused` audit row
(`detail: { action, orderType, reason: 'survival_mode', note: 'no order was
sent to the plugin' }`) and never calls `hub.send`.

The `ignoreReach` admin override (move-to and designer execute) is gated the
same way: in survival it is a 409 `survival_mode` before the preflight, so a
ship is never labelled `ADMIN OVERRIDE` on a hosted server. `preflightMove`
takes an optional `survivalMode` argument and drops both the override wording
in `linkText` and the "use Admin override" sentence from its hint.

Owner hints follow the same rule: `hintForCode('comms_denied')` in survival
says to build or power an antenna on a `[HERMES-BASE]` grid within radio range,
and `hintForCode('not_reachable')` drops the override advice. The test world
keeps the old wording (`hintForCode(code, { survivalMode })` pins either).

### The plugin half: one class, two files

The routing table is `ActionChannelRules` (`plugin/HermesRts.Plugin/src/ActionChannel.cs`):
a game-free list of names, so `tests/channel-routing` can prove it offline with
`dotnet run` (88 checks, exit 0). Names only — the code behind them is split:

| File | Compiled in | Contains |
|---|---|---|
| `ActionApi.cs` (`class HermesActions`) | **both** builds | every legitimate handler: reads (`inspect`, `profile`, `identity`, `list_tagged`, `radio_links`, `laser_state`, `get_block_props`, `is_under_control`, `connector_state`, `diag`, probes), `set_dampeners`, `wake`/`gyro_fix`/`physics_wake`, `set_block_props` (the antenna `Radius` write), `level_*`, `land_at`/`land_ground`/`land_status`/`land_stop`, `convert_to_ship`, `convert_to_station`, `laser_*`, `rename_block`; plus the dispatch, the dampener lease and the safe-mode check |
| `TestHarness.cs` (`class DsTestHarness : HermesActions`) | `HERMES_TEST_BUILD` only | the admin set: `spawn_prefab`, `clone_grid`, `delete_grid`, `refill_grid`, `teleport`, `teleport_player`, `zero_velocity`, `set_orientation`, `ownership`, `delete_planets`, `snap_dock`, `save`, `despawn_state`, the `dock_state` overlay (real snap_dock jobs exist only here), and the station test path (velocity zeroing) |
| `StationConverter.cs` (`SurvivalStationConverter`) | **both** builds | the dampener stop, used by `convert_to_station` whenever the build is survival (it used to be test-build-only, which made station conversion impossible in the live build) |
| `ConnectorRead.cs` | **both** builds | the read-only connector table (`connector_state`); `DockAssistant` keeps the `snap_dock` matrix write |

Plugin routing in `Plugin.ExecuteOrder`:

```
orderType 'action'  -> HermesActions.TryAction        (both builds)
orderType 'test'    -> TestApi -> DsTestHarness       (test build)
                       "not available in survival build: test channel (live build)" otherwise
anything else       -> CommandExecutor                (native move/hold/stop/waypoint/dock)
```

An admin name on `action` is refused by `ExecuteAction` in **both** builds
(`ok=false, error="not available in survival build: <action>"`): the production
channel never reaches the admin override, even where that code exists. Unknown
names get the same refusal.

Capabilities in `hello` now follow the build: `action_api` is advertised by any
build with `command_execution` (it is real in both), while `test_api` is
advertised only by the test build that actually compiles the channel. The live
build used to claim `test_api` and then fail every order it was sent.

Both channels keep the same safety rules: `NoteBackendOrder` renews the dampener
dead-man lease on every order (before dispatch, so a failing order still counts
as a live backend), safe mode refuses production orders until the watchdog
clears, the safe-mode watchdog stops autopilots *and* releases level/landing
jobs, and every order still runs on the game thread from `Plugin.Tick`'s queue.

Build both flavours (from `plugin/HermesRts.Plugin`):

```
SE_DS_BIN=<DedicatedServer64> dotnet build -c Release -o <out-live>
SE_DS_BIN=<DedicatedServer64> dotnet build -c Release -p:HermesTestBuild=true -o <out-test>
```

## Station conversion in survival

`zero_velocity` writes the physics body directly: it is a teleport. SE also
refuses `IsStatic = true` while the grid still moves, so the test-world path
(zero the velocity, settle 2 s, convert) is not available here.

The survival path in `stationPass()`:

1. `is_under_control` probe — a piloted grid is never stationed (manual wins).
2. `set_dampeners on` — the hull stops on its own thrusters. No `zero_velocity`
   is ever sent, and none is retried.
3. poll the live speed every pass; convert only when `|v| < 0.5 m/s`
   (`STATION_CONVERT_MAX_SPEED_MPS`, the limit SE will freeze).
4. the convert order carries `zone: 'survival'` so the plugin log says which
   path did it; success requires `isStaticAfter === true`.
5. a refused conversion retries with **dampeners again** (never a zeroing),
   capped at `STATION_MAX_ATTEMPTS` (3).
6. a hull that never slows gives up after `STATION_SURVIVAL_STOP_TIMEOUT_MS`
   (30 s): the step ends with

   `station refused: dampeners did not bring it under 0.5 m/s in 30 s (still
   2.00 m/s) - not zeroing the velocity in survival`

   plus a `demo_station_stop_timeout` audit row. The ship stays a ship and keeps
   hovering with its dampeners on.

Nothing in that path spawns, teleports, writes a world matrix or takes
ownership.

## Tests

* `packages/backend/tests/survival-mode.test.ts` — the flag (with explicit env
  objects, no ambient env), every admin action, the routes, the boot lock.
* `packages/backend/tests/order-channel.test.ts` — the channel split: a
  legitimate action reaches the plugin as `action` in both modes, an admin
  action is refused before `hub.send` in survival, `/api/test/order` is 409
  in survival and still 200 in the test world, `ignoreReach` is gated, and the
  survival hint text drops the override advice.
* `packages/backend/tests/survival-feature-actions.test.ts` — the feature sweep:
  the action set is derived from `src/demo/**` (every `callPlugin`, `send(...,
  'test', ...)`, `sendRaw` action object, `orderChannel` and inline
  `decideOrderChannel`), and each name must be a production action or an admin
  action with a stated `survival_mode` refusal. Reclassified reads/HUD/naming
  and the unavailable-feature table are pinned here too.
* `plugin/HermesRts.Plugin/tests/channel-routing` — the offline channel harness
  (`dotnet run`, no game): every production name classifies as production, every
  admin name as admin, the tables never overlap, and the required legit set is
  fully routable (91 checks after the 2026-11-11 reclassification). Both build flavours must also compile
  (`dotnet build -c Release` and `-p:HermesTestBuild=true`).
* `packages/backend/tests/survival-station.test.ts` — the dampener stop, the
  0.5 m/s threshold, `isStatic` verification, the 3-attempt cap, the timeout,
  and the test-world path still zeroing (the refusal is not global).
* `packages/backend/tests/setup-fixture-env.ts` — declares `RTS_ENV=test` +
  the marker for the suite, so the harness tests keep running as the test
  world. Survival mode itself is never proven by the ambient env.
