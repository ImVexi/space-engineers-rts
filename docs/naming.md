# Auto-naming, laser links and sun direction (T9)

Status: implemented and deployed to `SE-RTS Test Lab` (test server only), 2026-11-09.
One plugin bundle / two announced restarts (the second added `convert_to_ship` +
static/lock reporting after the owner's mid-task steer). Backend routes are live at
`127.0.0.1:8762`; nothing here touches the live server.

## Naming scheme

Numbers are allocated once and stored in SQLite (kv row `naming:registry`); they are
**never reused**, even if a grid is deleted.

| Grid | Name | Rules |
|---|---|---|
| Satellite | `SAT-<R\|L\|M>-<NNNN>` | `L` = 2+ lasers (radio optional), `M` = radio + exactly 1 laser, `R` = radio only; a solo laser is `L` |
| Base | `BASE-NN` | two digits |

Blocks:

| Block | Name |
|---|---|
| radio antenna | the grid name (`SAT-L-0001`) |
| laser antennas | `<grid name> L1`, `<grid name> L2` (ordered by block entity id) |
| programmable block | `[HERMES-TEST] <grid name>` / `[HERMES-BASE] <grid name>` |

Names are written through the plugin (`rename_grid` + `rename_block`) and read back;
a rename that does not read back is recorded as `renameOk: false` and retried on the
next 10 s pass.

### Owner override

On every pass the live grid name from `list_tagged` is compared with the assigned
name. If it differs, is not a stock name (`Small Grid …`, `Static Grid …`, `Grid …`,
empty), **and** our rename previously read back successfully, the record is marked
`ownerOverride: true` and the service never writes to that grid again. A site rename
(`POST /api/demo/naming/rename`) also sets the override. Every rename — automatic,
override detection, or site request — writes an audit row `naming_rename` (actor
`naming` or `owner-request`).

Deployed result (read back from `GET /api/demo/naming`):

| gridId | name | class | renameOk |
|---|---|---|---|
| `grid:107519913664561774` | `SAT-L-0001` | L (2 lasers) | true |
| `grid:126323015058751318` | `SAT-L-0002` | L | true |
| `grid:113586721763627228` | `SAT-L-0003` | L | true |
| `grid:115081011520040319` | `SAT-L-0004` | L | true |
| `grid:76941937918779763` | `BASE-01` | base | true |

## Plugin actions (test build)

| Action | Params | Returns |
|---|---|---|
| `rename_grid` | `gridId, name` | CustomName before/after, `ok` |
| `rename_block` | `gridId, name, blockEntityId \| filter` | per-block before/after, `renamed` |
| `laser_target` | `gridId, laserBlockId \| filter, x, y, z, permanent?` | target before/after, `status`, `isPermanent` |
| `laser_connect` | same selector, `permanent?` | full laser readout + `error` |
| `laser_disconnect` | same selector | readout + `disconnectMethod` |
| `laser_state` | `gridId` (or `gridIds`, or none = every grid with a laser) | per laser: status, target, range/`maxRangeM`, `requireLos`, `isPermanent`, power draw, `otherAntennaId`/`otherGridId` |
| `convert_to_ship` | `gridId` | `isStaticBefore/After`, `converted`, `physicsPresent`, `massKg` |

`convert_to_ship` exists for the executor's launch preflight only; it was built and
deployed but **not called on any live grid** in this task (the owner said not to
convert anything). The preflight dry path (`packages/backend/tests/release.test.ts`)
recognises the action; the plugin dispatches it and reports the conversion read-back.

`laser_disconnect` note: `01_210_014` exposes `Connect()` but no `Disconnect()` on
the Ingame laser interface. The action tries the concrete `Disconnect` method
(reflection) and otherwise switches the block off (`Enabled=false`), which drops the
link; the provisioning profile keeps lasers `OnOff=false` when idle anyway.

## Laser link test (first real laser data)

Route: `POST /api/demo/naming/laser-test {gridA?, gridB?, timeoutMs?, permanent?}`.
It reads `laser_state`, switches the two laser blocks on, aims each at the other's
block position (`SetTargetCoords`, GPS string), `Connect`s both, polls every 2 s until
both report `Connected` (max 60 s), then disconnects and returns the lasers to
`OnOff=false`. **No grid is moved.**

Result 2026-11-09 18:02 CST — `SAT-L-0001` ↔ `SAT-L-0002`, 37.1 m apart:

| Field | Value |
|---|---|
| status (both ends) | `Connected`, after 9.8 s |
| connected-to | `grid:126323015058751318` / `grid:107519913664561774` (mutual) |
| range | 50,000 m per antenna; definition MaxRange `-1` (no extra cap) |
| power draw (block definition) | idle 0 MW, turning 0.001 MW, lasing 1.0 MW |
| cleanup | 2 disconnects, 2 grids lasers `OnOff=false` |

A second attempt over 2,802.8 m (SAT-L-0004 ↔ SAT-L-0003, terrain between them)
reached `Connected` on one end and `SearchingTargetForAntenna` on the other within
60 s — a real line-of-sight/aiming asymmetry, not a range problem. A later repeat
on SAT-L-0001 ↔ SAT-L-0002 failed at 534.8 m because `SAT-L-0002` is **unlocked and
slid ~470 m downhill** between runs (z 1684 → 1213); the default pair picker uses
geometric distance only, so it cannot know line of sight. Explicit `gridA`/`gridB`
and the `GET /api/demo/naming/lasers` readout are there for that reason. Full ledger
entry: see [VALIDATION.md](VALIDATION.md).

Live demo 2026-11-09 18:40 CST: `SAT-L-0003 L1` ↔ `SAT-L-0004 L1` (2,802.8 m)
reached mutual `Connected` in ~8 s and was **left connected** for the owner;
`/api/demo/state` shows the edge with `source: "GAME"`. `isPermanent` still reads
false after `permanent:true` on target/connect, so persistence across a server
restart is UNVERIFIED (the block reports the flag as unsupported).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/demo/naming` | scheme, records, counters, last run, sun sample, last laser test |
| GET | `/api/demo/naming/lasers` | live `laser_state` (all tagged satellites, or `?gridId=`) |
| POST | `/api/demo/naming/sync` | force one naming pass |
| POST | `/api/demo/naming/rename` | `{gridId, name}` — rename + set owner override (audited) |
| POST | `/api/demo/naming/laser-test` | aim/connect/poll/disconnect one laser pair |
| POST | `/api/demo/provision/save` | force a world save through the plugin (pre-restart) |

All sit behind the existing demo env lock + bearer token. `RTS_DEMO` unset means no
routes.

## Telemetry additions

- `sun` + `sunState` on every telemetry frame: `MySector.DirectionToSunNormalized`
  (unit vector, world space). Sample: `{x: 0.121152, y: 0, z: 0.992634}`,
  `sunState: "readable"`.
- Per grid: `batteryPct`, `h2Pct`, `solarOutputMw`, `solarMaxMw`.
  Solar output = panel `CurrentProductionRatio` (read reflectively — protected on the
  concrete block) × the panel component's `MaxOutput`; battery/H2 reuse the same
  samples as `powerFraction` / `fuelFraction`.
- `profile` and `list_tagged` now report `isStatic` and `lockedBy`
  (`landingGears`, `landingGearsLocked`, `connectors`, `connectorsConnected`,
  `totalLocked`). Nothing is locked or unlocked by this code.

Mass-0 finding (owner question): `grid:107519913664561774` is **not static**
(`isStatic=false`) but has **one locked landing gear** (`lockedBy.totalLocked=1`),
which is why `massKg` reads 0 while parked; the same is true of
`grid:115081011520040319`. The two unlocked satellites read 19,003.6 kg. Left as-is.

## Tests

`packages/backend/tests/naming.test.ts` (9 cases, no network): sat class mapping,
stock-name detection, first assignment (grid/radio/L1/L2/PB), numbering never reused
and persisted across service instances, in-game rename → owner override (no further
plugin calls), stock name is not an override, site rename + audit, closest-pair
selection, and a laser test that reaches mutual `Connected` with cleanup.

```bash
env -u RTS_DEMO -u RTS_TOKEN npx vitest run packages/backend/tests/naming.test.ts
```

`packages/backend/tests/release.test.ts` (10 cases) covers the launch preflight's
`convert_to_ship` request path.

## Rollback

- Backend: remove the `namingRoutesFor` / `namingSyncHook` lines in
  `packages/backend/src/server.ts`; delete kv rows `naming:registry`,
  `naming:lasertest` to forget assignments. Provisioning keeps working without the
  `onGrids` hook.
- Plugin: restore `<server-dir>/hermes/HermesRts.Plugin.dll.bak-pret9` and restart.
  Grid names already written stay (they are just CustomNames).
