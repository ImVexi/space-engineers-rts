# Ship roles

A grid's **role** says what the control system may do with it. You set the role
**in game**, by a tag on any block. The site toggle is only a fallback for
untagged grids.

| Role | Meaning |
|---|---|
| `MANAGED` | Full autonomy. The only role automatic features may touch. |
| `PERSONAL` | Your own ship. Never touched automatically; only explicit, confirmed owner orders, on a gentle flight profile. |
| `BASE` | A station. Never moved, never given a slot; still a control source when it has a broadcasting antenna. |
| `OFF` | No orders at all. Read-only. |

## Tags

Put the tag in any block's **CustomName**, or as a line in **CustomData**. Both
spellings work, and matching is case-insensitive:

| Full tag | Alias | CustomData form |
|---|---|---|
| `[HERMES-MANAGED]` | `[MANAGED]` | `HERMES_ROLE=managed` |
| `[HERMES-PERSONAL]` | `[PERSONAL]` | `HERMES_ROLE=personal` |
| `[HERMES-BASE]` | `[BASE]` | `HERMES_ROLE=base` |
| `[HERMES-OFF]` | `[OFF]` | `HERMES_ROLE=off` |

Full tags are matched first, so `[HERMES-BASE]` is never read as `[BASE]` by
accident. An unknown `HERMES_ROLE=` value is ignored. `[HERMES-TEST]` is a
second spelling of `MANAGED`, kept for hulls tagged before the role names
settled.

## Untagged grids

On a hosted server (`RTS_ENV=live`) an untagged grid is **`OFF`**. "Nobody
marked it" must not mean "automate it", so untagged ships, NPC grids, wrecks and
debris are read-only. Only a marked test world defaults an untagged grid to
`MANAGED`.

## Ownership is required on a live server

A non-`OFF` role also requires the grid to be **yours**. The plugin reports each
grid's owning identities and faction; the backend compares them with
`RTS_OWNER_STEAM_IDS` and the faction the plugin resolves for those identities
(plus the optional `factionTag` in `plugin.json`):

- a grid is yours when an owner identity is listed in `RTS_OWNER_STEAM_IDS`, or
  is in the same faction as one of them;
- anything else is `OFF` with the reason **"not owned by you"**, whatever tag it
  carries — including a copied `[HERMES-MANAGED]`.

It fails closed: no list, no known identity, or no reported owner means not
yours. This check sits in the single role resolver, so no feature can bypass it.

## Conflicting tags

A grid with two different non-default tags resolves to the **most restrictive**
one, in the order `OFF` > `PERSONAL` > `BASE` > `MANAGED`, and raises one
`role_conflict` alert naming both roles.

`MANAGED` never takes part in a conflict: `[HERMES-TEST]` plus `[PERSONAL]` is a
PERSONAL ship, which is you saying "this one is mine".

An in-game tag always beats the site toggle. Setting a role on the site for a
tagged grid returns 409 `role_set_in_game`; clear the tag first.

## What each role allows

| Role | Automatic features | Owner flight orders | Safety (stop / brake / hold) |
|---|---|---|---|
| `MANAGED` | allowed | allowed | allowed |
| `PERSONAL` | **refused** — no automatic action at all | allowed **with confirmation** | always allowed |
| `BASE` | reads and safety only | **refused** — a base is never moved | allowed |
| `OFF` | refused | refused | **refused** |

`OFF` refuses everything with one sentence: *"marked OFF in game: this grid
receives no orders."* A `MANAGED` grid that is not yours behaves the same way.

## PERSONAL orders

A PERSONAL order must carry an explicit confirmation; the site asks in a dialog
before sending it. Allowed actions are the owner ones — move, hold, stop, brake,
land, level, dampeners — plus flight-safety writes.

PERSONAL flights use a gentle profile: **60 m/s** cruise cap, lateral
acceleration dampened, and dampeners stay on (no free fall).
