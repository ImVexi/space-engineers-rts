# Auto-provisioning for owner-tagged grids

Status: implemented, deployed to `SE-RTS Test Lab` (test server only). One game-server
restart is needed for the plugin actions; every later setting change is data.

## Why

An owner-tagged grid used to be configured by hand, so each new hull meant another
code path plus another 4-minute server restart. Now the plugin exposes **two generic
actions** and the backend keeps the wanted state in JSON:

| Piece | Where | Changes need |
|---|---|---|
| Generic property/action executor | `plugin/HermesRts.Plugin/src/ActionApi.cs` (`set_block_props`, `get_block_props`) | plugin rebuild + restart |
| Profiles (what to set) | `packages/backend/src/demo/provision/profiles.json` | backend restart only |
| Provisioner + routes | `packages/backend/src/demo/provision/*.ts` | backend restart only |

## Tags

| Tag | Meaning | Profile |
|---|---|---|
| `[HERMES-BASE]` | control station | `BASE` |
| `[HERMES-TEST]` | drone / satellite hull | `DRONE` |

A tag is found on a **programmable block's custom name** (case-insensitive), exactly
like the handoff detector. `list_tagged` with no `tag` parameter now returns both tags
and reports `tags`, `tag`, `owner`, `owners` and `pbName` per grid; an explicit
`tag` still filters to one tag (back-compatible with the designer).

## Plugin actions (test build)

### `get_block_props`

```jsonc
{ "action": "get_block_props",
  "entityId": "grid:107519913664561774",
  "filter": { "type": "RadioAntenna" },   // type?, subtype?, nameContains?
  "ids": ["Radius", "EnableBroadcasting"] // optional whitelist
}
```

Returns, per matching block: `entityId`, `name`, `subtype`, `type`, every property
(`id`, `type`, `kind`, `value`, `min`, `max` for numbers) and the terminal action ids.
This is the **source of truth for ids**: never guess one, read it here first.

### `set_block_props`

```jsonc
{ "action": "set_block_props",
  "entityId": "grid:107519913664561774",
  "filter": { "type": "LaserAntenna" },
  "props": { "OnOff": false, "Range": "$max" },
  "actions": ["OnOff_On"]
}
```

- Property ids are validated against the block's own `GetProperties()`; an unknown id
  is reported per block, never silently ignored.
- Numbers are clamped to the property's own min/max, and the special values `$max` /
  `$min` resolve to that range — "as far as this antenna goes" needs no hard-coded
  number (this is how the antenna radius is set).
- Every write is read back: each row carries `before` and `after`.
- `actions` are terminal action ids applied after the properties (`OnOff_On`, …).
- Runs on the game thread with the rest of the test harness.

`filter.type` accepts a functional name (`RadioAntenna`, `LaserAntenna`,
`RemoteControl`, `Battery`, `Thruster`, `Gyro`, `ProgrammableBlock`, `Reactor`,
`GasTank`, `Cockpit`), a block class name, or an object-builder TypeId.
`filter.subtype` / `filter.nameContains` are substring matches.

### `teleport_player`

```jsonc
{ "action": "teleport_player", "identityId": "144115188075855926",
  "steamId": "10000000000000001", "x": 0, "y": 60300, "z": 0 }
```

Moves the matching player's character and zeroes its velocity. The target is checked
against every planet (`AverageRadius + 200 m` minimum); if it is below that, it is
pushed out along the radial direction and `adjustedForSurface: true` says so. A
connected player without a character returns `teleported: false` with the reason and
the online list.

## Profiles (data)

`profiles.json` holds the owner identity, the tags, enum mappings and the step lists.
A step is `{name, filter, props, actions?}` and is sent verbatim (after enum mapping)
to `set_block_props`.

**BASE** — radio antennas `OnOff` + `EnableBroadCast` + `Radius: "$max"`; laser
antennas `OnOff: false` (idle until a link is planned); batteries `OnOff` plus the
terminal action `Auto`.

**DRONE** — the same radio/laser steps, plus Remote Control (`AutoPilot: false`,
`CollisionAvoidance: true`, `DampenersOverride: true`, `ControlThrusters/Wheels: true`;
the RC block has **no `OnOff` terminal property**, so that id was removed and the
step now applies 5 props with no error), batteries Auto, thrusters on, gyros on, and
built-in AI off (programmable block, timers, event controllers, AI flight/combat/
mission blocks).

Dropdown properties (an `Int64` on the battery) are **not** written directly: the block's
own terminal action (`Auto`, `Recharge`, `Discharge`) is used instead. The `enums` table is
kept for any future name→number property and is empty today.

Property ids are block-specific and sometimes oddly capitalised: the antenna property is
`EnableBroadCast`, not `EnableBroadcasting`. Never guess — read `get_block_props` (or
`POST /api/demo/provision/inspect`) first; an unknown id is reported per block, not
silently ignored.

## Behaviour

- The provisioner polls `list_tagged` every **10 s** (`POLL_MS`).
- Ownership is enforced: a grid whose `BigOwners` do not include the owner identity
  (`144115188075855926`) is **skipped with a reason** and never written to.
- A grid that failed is retried at most once per **5 minutes** (`FAILURE_RETRY_MS`), so a
  broken step cannot hammer the game thread every poll.
- Idempotent: the per-grid signature (`blocks | radios | lasers | mass`) is stored in
  the `provision:grids` kv row; an unchanged, previously successful grid is not
  re-applied. A rebuilt grid (block count changes) is re-provisioned automatically.
- Every apply writes an audit row `provision_apply` with the profile, the changed flag,
  the per-step counts and the before/after of each property (capped at 40 rows).
- The last 50 issues (owner mismatch, plugin offline, failed step) are returned by the
  state endpoint.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/demo/provision/state` | `{bases, drones, lastRun, issues, labels, profiles}` |
| GET | `/api/demo/provision/profiles` | the profile data exactly as sent to the plugin |
| POST | `/api/demo/provision/apply` | `{gridId}` — force one re-apply (ignores the signature cache) |
| POST | `/api/demo/provision/inspect` | `{gridId, filter?, ids?}` — read-only `get_block_props` passthrough |
| POST | `/api/demo/provision/teleport` | `{target: "planet:<name>" \| "grid:<id>" \| {x,y,z}}` |
| POST | `/api/demo/provision/save` | force a world save through the plugin (before a restart) |

`planet:<name>` places the owner 300 m above the planet's average surface radius
(`center + unit(center) * (radius + 300)`); `grid:<id>` places him 25 m up and 25 m
back from the grid. The plugin re-checks the surface rule and reports any adjustment.
Teleport is **only** run when the owner asks: there is no automatic teleport, and no
live character was moved during the build. The action itself was unit-tested against a
fake plugin and dry-run; moving the owner's character needs him online, so the live
call was deliberately not exercised.

## Verified on the test server

Deployed 2026-11-09 (one restart, 2 m 47 s from `docker restart` to `Game ready`).
Property ids read from real blocks with `get_block_props`:

| Block | Property / action | Notes |
|---|---|---|
| `SmallBlockRadioAntenna` | `EnableBroadCast` (bool), `Radius` (float, 1…50000) | note the capital `C`; `Radius: "$max"` resolves to 50000 |
| `SmallBlockBatteryBlock` | actions `Auto`, `Recharge`, `Discharge`; `ChargeMode` is an `Int64` | write the action, not the Int64 property |
| `SmallBlockLaserAntenna` | `OnOff` (bool) | enough to keep it idle; targeting is a separate concern |

What the provisioner did on the owner's grids (audited with before/after):
`[HERMES-BASE]` static base plus four `[HERMES-TEST]` satellites — radio
`EnableBroadCast true`, `Radius 50000` (before 50000, already at max), lasers
`OnOff false`, batteries `OnOff true` + `Auto`, 22 thrusters and 2 gyros `OnOff true`,
programmable block `OnOff false`. All five grids ended `ok: true` and unchanged
(`changed: false`), i.e. the design already matched the profile and the pass verified it.

The test satellites carry **no Remote Control and no cockpit**, so the DRONE RC step
matches zero blocks and nothing can autopilot them — a hardware gap, not a provisioning
failure. The state endpoint reports the step with `blocks: 0`, which is how to see it.

## Gate wiring (for the comms gate owner)

The provisioned bases are the gate's control sources. Import:

```ts
import { controlSourcesFromState, provisionerFor } from './provision/index.js';

const sources = controlSourcesFromState(provisionerFor(deps).state());
// [{ gridId, name, radioRangeM, antennaBroadcasting: true,
//    labels: { antenna: 'GAME', range: 'SIMULATED' } }]
```

- Only `[HERMES-BASE]` grids whose radio antenna was **read back** as broadcasting and
  with a positive radius qualify — a base with no working antenna contributes nothing.
- The antenna state is `GAME` (it is a terminal value read from the running block on the
  game thread). Any range or distance maths built on it stays `SIMULATED`, exactly like
  the planner half, and must keep its label.

## Registration

`packages/backend/src/server.ts`, two lines next to the designer registration:

```ts
routes.push(...provisionRoutesFor({ config, store, hub, clock }));
if (process.env.RTS_DEMO === '1') startProvisioner({ config, store, hub, clock });
```

The routes reuse `DemoHttpError`, so the existing error mapping applies. `RTS_DEMO=0`
means no routes and no poller (the test-server env lock is unchanged).

## Tests

`packages/backend/tests/provision.test.ts` (11 cases, no network): profile data shape and
`$max`; binding of a BASE grid with `ChargeMode` enum mapping and audited before/after;
idempotency (second pass writes nothing); re-apply on a changed block count; owner
mismatch skipped with a reason; `[HERMES-TEST]` → DRONE; plugin offline surfaces as an
error; gate hook filters non-broadcasting bases; teleport maths for planet / grid and
the "no character" refusal.

```bash
env -u RTS_DEMO -u RTS_TOKEN npx vitest run packages/backend/tests/provision.test.ts
```

## Rollback

- Backend: the module is additive; remove the two registration lines. The kv row
  `provision:grids` can be deleted to forget what was applied.
- Plugin: `plugin/HermesRts.Plugin.dll.bak-pret7` on the test server (previous build),
  restore and restart. `[HERMES-BASE]` / `[HERMES-TEST]` grid names are the only
  trigger, so untagged grids are never touched.
