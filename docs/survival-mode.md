# Survival mode

Survival mode is the shipped behaviour, not an option. The plugin has no cheat
code compiled in, and the backend refuses to *send* one. A refusal that never
reaches the game looks like a policy; a refusal that fails inside the plugin
looks like a bug.

## How it is decided

Survival is the default. The one exception is a marked test world:

```
survival  = NOT (RTS_ENV == "test" AND RTS_TEST_SERVER_MARKER == "se-rts-test")
```

Unset variables, a missing marker, `RTS_ENV=production`, a copied service file —
every other combination is survival mode.

On a hosted server you run `RTS_ENV=live` with an explicit opt-in:

```
RTS_DEMO=1
RTS_ENV=live
RTS_DEMO_SURVIVAL=1        # required; RTS_ENV=live alone is a boot error
# RTS_TEST_SERVER_MARKER   must be absent; boot error if present
# RTS_DEMO_STATE           must be absent (world fixture); boot error if present
```

The marker is **refused**, not ignored, so one copied env line cannot turn a
live instance into a cheat-enabled backend. Check the state at any time with
`GET /api/health` or `GET /api/demo/state` — both report `survivalMode`.

## What is refused

These actions do not exist in the shipped plugin, and the backend refuses to
send them before they reach the wire:

`spawn_prefab`, `clone_grid`, `delete_grid`, `refill_grid`, `teleport`,
`teleport_player`, `zero_velocity`, `set_orientation`, `ownership`,
`delete_planets`, `snap_dock`, `despawn_state`, `save`.

Every refusal carries `reason: "survival_mode"`, names the action, and writes a
`survival_refused` audit row. A lost relay node is recovered by re-shaping
neighbours, assigning an owned spare that can reach the slot, or building a new
one — never by spawning, teleporting or deleting.

## What a feature loses, and why

| Feature | Cannot use | Consequence |
|---|---|---|
| missions queued as a spawn | `spawn_prefab`, `clone_grid` | a lost node is re-shaped, reassigned or built |
| stale-grid cleanup | `delete_grid` | nothing in the world is removed |
| ownership on spawn | `ownership` | a grid is given or merged by its owner, never taken |
| provisioner teleport | `teleport_player` | moving your character is a cheat and is not available |
| old station path | `zero_velocity` | stations stop on dampeners only (below) |
| world trim | `save`, `delete_planets` | the server owns its saves and its planets |

These are **production** actions and work in survival, because a player could do
them from the cockpit: reads and probes, dampener and collision-avoidance
writes, autopilot off, GPS markers, `rename_grid` (on your grids only), laser
links, landing, and station conversion.

## Order channels

The plugin has two channels. The production channel (`action`) is compiled into
every build and carries only legitimate actions. The test channel (`test`)
exists only in the private test build; on the shipped build a `test` order is
answered with `not available in survival build: test channel`.

The backend decides per action: a production action goes out as `action` in both
modes, an admin action is refused before anything is sent. The same applies to
the "ignore reachability" admin override — in survival it is a 409 before
preflight, so a ship is never labelled `ADMIN OVERRIDE` on a hosted server.

## Station conversion in survival

Converting a relay to a station cannot zero its velocity (that is a teleport,
and the game refuses to freeze a moving grid anyway). The survival path is:

1. probe `is_under_control` — a piloted grid is never stationed (manual wins);
2. switch dampeners on, so the hull stops on its own thrusters;
3. poll the live speed; convert only below **0.5 m/s**;
4. verify `isStaticAfter === true` after the convert order;
5. on refusal, try dampeners again — at most 3 attempts;
6. if the hull is still moving after 30 s, give up with
   `station refused: dampeners did not bring it under 0.5 m/s in 30 s` plus an
   audit row. The ship stays a ship and keeps hovering.

Nothing in that path spawns, teleports, writes a world matrix or takes
ownership.
