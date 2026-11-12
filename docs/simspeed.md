# Sim-speed work: what changed, and what it saves

Companion to the read-only measurement that preceded it.
Branch `simspeed` off `6624952`. Nothing here was deployed; no safety threshold, telemetry rate or
flight behaviour changed.

## The audit in one line

The control stack cost ~2 % of game-thread time on **average** but spent it in bursts: `list_tagged`
ran 17 nested `profile` calls (median **134 ms**, p90 235 ms) inside a single tick every 10 s, and the
backend's power poller rescanned the newest 500 audit rows every 100 ms — up to 10 x 500-row reads/s on
the event loop the demo flight tick runs on. 19 grids, 0 missions, 47.5 orders/min.

## What changed

| # | change | where |
|---|---|---|
| 1 | `list_tagged` is ONE block pass, no nested `profile`: identity, tags, positions, `blocksTotal`, `radioCount`/`radioRangeM`, `laserCount`/`laserRangeM`, `massKg`, `isStatic`, `lockedBy`, and **every block that carries a CustomName/CustomData line** (role tags). Profile-derived scalars (thrust, TWR, gravity, canGroundLaunch) are `null` unless the caller passes `withProfile: true`; only the designer hull list does. | plugin `ActionApi.cs:ListTagged`; backend `designer/routes.ts:HULL_LIST_OPTS`, `provisioner.ts:TaggedGrid` |
| 2 | Provisioning pass 10 s -> **30 s**, with an immediate pass on a genuinely new grid in telemetry, an owner order (any non-routine ack), or a plugin reconnect. Triggers are coalesced (5 s) and only active once a pass has succeeded, so a cold boot does not fire poller orders at a silent plugin. | `provision/provisioner.ts:POLL_MS`, `requestPass`, `requestProvisionPass*`; `runtime.ts` onHello/onTelemetry/onAck |
| 3 | `laser_state` asks only grids that have a laser (from the same scan), per grid, and after 3 identical reads drops to a 90 s cadence (the audit's "2 s -> 30 s" with a 30 s base). An open mission or a laser/link command on the grid makes it due immediately; samples are merged so a backed-off grid keeps its graph edge. `radio_links` is pre-filtered to grids that have an antenna **and** a neighbour inside 2x their reach, and cached for 20 s. | `provisioner.ts:sampleLasers/laserDue/noteLaserReading/markLaserActivity`; `demo/routes.ts:radioPollCandidates` + `RADIO_LINKS_TTL_MS` |
| 4 | The 100 ms `listOrderResults(500)` rescan is gone. `order_result` frames are handed to an in-memory bus (`orderResults.record`) from the WebSocket handler and wake the waiting poller on the same tick. Fallback is a **cursor** read (`rowid > seen`), at most 1/s, only while an order is outstanding. Acks were never on this path and still are not. | `src/orderResults.ts`; `runtime.ts` onEvent; `provisioner.ts:callPlugin`; `power/poller.ts:profile`; `store.ts:listOrderResultsAfter/maxAuditRowid` |
| 5 | `demo:power` skips a grid that is idle — fresh telemetry (<=10 s), no open mission, not piloted/under control, `|v| < 0.5 m/s`, and static/landed/stationed — and re-reads it every **5 min** instead of 30 s. Flying, piloted and mission grids keep 30 s. A skipped grid keeps its last snapshot (never zeroed); its age is what the site shows. `summary()` reports `idleSkipped`/`idleRefreshMs`. | `power/poller.ts:IDLE_REFRESH_MS`, `isIdle`, `hasOpenMission`, `tick` |
| 6 | `plugin.log` rotates at **20 MB**, keeping 3 older files, in the shared loader adapter (both build flavours). | plugin `DsLoaderAdapter.cs:RotateIfNeeded` |

Not done, deliberately: `DrainOrders` per-tick change, static-grid telemetry hysteresis, telemetry
trimming, DB row deletion. Telemetry for flying/piloted grids is untouched at 2 s.

## Expected order rate

Orders/s leaving the backend, measured baseline (audit) vs after, assuming 6 static grids and the rest
parked (`|v| < 0.5`) unless flying:

| source | @19 before | @19 after | @50 before | @50 after |
|---|---|---|---|---|
| `demo:power` | 0.63 | **0.24** (6 at 30 s + 13 at 300 s) | 1.67 | **0.64** |
| `provision:list_tagged` | 0.100 (every 10 s) | **0.033** (every 30 s) | 0.100 | **0.033** |
| `provision:laser_state` | 0.100 | **~0.03** (per laser grid, 90 s backoff) | 0.100 | **~0.05** |
| `provision:radio_links` | 0.036 | **<=0.05, 0 when the map is closed** | 0.036 | same |
| **total** | **0.79–0.87** | **~0.32** (≈19/min) | **1.90** | **~0.77** |

The 3 orders/s power cap is no longer reachable at 50 grids (1.67 -> 0.64). Provisioning re-profiles
only when a grid's signature (blocks/radio/laser/mass) changes; with the cheap scan a pass that
changes nothing is one ~27 ms order instead of 17 profiles.

## Expected game-thread time

| source | before | after |
|---|---|---|
| `list_tagged` | 134 ms x 6/min = **805 ms/min** | ~27 ms x 2/min = **54 ms/min** |
| `demo:power` | 34 profiles/min x 7.9 ms = **270 ms/min** | ~14.6/min = **115 ms/min** |
| `laser_state` | 6 x ~134 ms = **800 ms/min** | ~1.3 x = **~130 ms/min** |
| `radio_links` | 2.1 x ~200 ms = **420 ms/min** | ~1.2 x = **~240 ms/min** |
| **total** | **~2.3 s/min ≈ 38 ms/s** | **~0.54 s/min ≈ 9 ms/s** |

So ~**-29 ms/s of game-thread time**, and — the part sim speed actually feels — the **134 ms single-frame
stall every 10 s is gone** (replaced by ~27 ms every 30 s). At 50 grids the old shape was a 394 ms
stall; that is the number that stops growing now.

Backend side: **10 x 500-row SQLite reads/s -> 0** on the order-result path (one `MAX(rowid)` aggregate
per order plus a bounded cursor read while it is outstanding). That is the documented flight-tick
starvation path from the 2026-11-10 run.

## Verification

```
env -u RTS_DEMO -u RTS_TOKEN -u RTS_ENV -u RTS_TEST_SERVER_MARKER npm test   # full suite, green
npx tsc -p tsconfig.json --noEmit                                          # root clean
cd packages/demo-site && npx tsc -p tsconfig.json --noEmit                 # site clean
plugin/HermesRts.Plugin/tests/land-math        (dotnet run)                # 275
plugin/HermesRts.Plugin/tests/channel-routing  (dotnet run)                # 91
dotnet build -c Release -o …/sim-live                                      # 0 errors
dotnet build -p:HermesTestBuild=true -o …/sim-test                         # 0 errors
```

Tests added (`packages/backend/tests/simspeed.test.ts`): cheap-payload provisioning with role blocks,
the designer's `withProfile` contract, the 30 s cadence + coalesced trigger, laser backoff and
forced-due, order-result delivery inside a tick with no 500-row rescan, the power poller waking on the
frame, and idle skip with the reading preserved (55 %, old `at`) while flying/stale grids keep 30 s.
