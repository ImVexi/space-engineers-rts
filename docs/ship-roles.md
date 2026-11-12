# Ship roles ("marking")

A grid's **role** says what the control system may do with it. The role is set
**in game** by a tag; the site toggle is only a fallback. Resolver:
`packages/backend/src/demo/roles.ts` (single resolver — every sender calls it,
so no feature can invent a role of its own).

| Role | Meaning |
|---|---|
| `MANAGED` | Full autonomy. The only role the optimiser, provisioning, self-healing, staging, naming and fleet defaults may touch. |
| `PERSONAL` | The owner's own ship. Never touched automatically; only explicit, confirmed owner orders, flying the gentle profile. |
| `BASE` | A station. Never moved, never assigned a slot; still a control source when it has a broadcasting antenna. |
| `OFF` | The backend sends it **no orders at all**, reads only. |

## Tags and aliases

Put the tag in **any block's CustomName**, or as a line in **CustomData**.
Matching is case-insensitive, and both spellings work:

| Full tag | Alias | `HERMES_ROLE=` form |
|---|---|---|
| `[HERMES-MANAGED]` | `[MANAGED]` | `HERMES_ROLE=managed` |
| `[HERMES-PERSONAL]` | `[PERSONAL]` | `HERMES_ROLE=personal` |
| `[HERMES-BASE]` | `[BASE]` | `HERMES_ROLE=base` |
| `[HERMES-OFF]` | `[OFF]` | `HERMES_ROLE=off` |
| `[HERMES-TEST]` (legacy) | — | (managed) |

Full tags are matched first, so `[HERMES-BASE]` never triggers the short
`[BASE]` alias (a `-` sits before it). An unknown `HERMES_ROLE=` value is
ignored. `[HERMES-TEST]` is kept as a second spelling of MANAGED for the test
world and for hulls tagged before T79.

## The untagged default depends on the instance

| Instance | Untagged, no site toggle | `roleSource` | Reason |
|---|---|---|---|
| test (`RTS_ENV=test` + marker) | `MANAGED` | `default` | "untagged: the system keeps its existing behaviour for this grid" |
| live (`RTS_ENV=live`) | **`OFF`** | `default-live` | "untagged on the live server: add [HERMES-MANAGED] or [HERMES-TEST] to automate it" |

On the live (shared survival) instance "nobody marked it" must not mean
"automate it": untagged ships, MES/NPC grids, wrecks and debris receive no
orders, reads only. The test instance keeps the old default so existing test
flows do not change.

## Ownership: live only

On `RTS_ENV=live` a **non-OFF role additionally requires the grid to be
yours**. The plugin's `list_tagged` row carries each grid's big owners
(identity ids) and their faction tags; the backend compares them with the
owner policy:

- `RTS_OWNER_STEAM_IDS` (comma-separated, default `10000000000000001` — the owner).
  Steam id → identity id is resolved from the players telemetry the plugin
  already sends (falling back to the provisioner's owner identity). Add
  `friend` (`10000000000000002`) by listing him in that env; nothing else
  needs to be hard-coded.
- a grid is owned when any big owner is one of those identities **or** is in
  the same faction as one of them (the faction tag comes from the plugin's
  legitimate faction read; no faction configured/observed means the identity
  rule alone applies).

A grid that fails the check is `OFF` with `roleSource: 'ownership'` and the
reason **"not owned by you"** — whatever tag it carries, including a copied
`[HERMES-MANAGED]`. This runs inside the single resolver, so the executor's
role gate, the provisioner, the survival loop, autotune, naming, staging and
fleet ops all inherit it; no automatic feature can bypass it. It fails closed:
no policy, no known identity, or no reported owner means not yours. The test
instance is not gated by ownership (its provisioner keeps the existing
owner-identity check).

## Precedence: OFF > PERSONAL > BASE > MANAGED

A grid carrying more than one distinct role resolves to the **most restrictive**
one, and the registry raises **one** `role_conflict` alert per conflicting tag
set (not per poll) plus an audit row. That alert names both roles, e.g.
"PERSONAL vs BASE".

**`MANAGED` is the default role and never takes part in a conflict.** A grid
with `[HERMES-TEST]` (legacy managed) on its programmable block and `[PERSONAL]`
on another block is a PERSONAL ship — that is the owner saying "this one is
mine", not an ambiguity, so no alert and `conflict: false`. The same holds for
`[HERMES-TEST]` + `[BASE]` / `[OFF]`. A conflict is **two non-default tags**
(`PERSONAL` + `BASE`, `OFF` + `BASE`, `PERSONAL` + `OFF`), and only then does the
most-restrictive rule apply.

**An in-game tag always beats the site toggle.** `POST /api/demo/roles` on a
tagged grid returns 409 `role_set_in_game` with the tag's source in the reason;
the site disables the select and explains why. Clear the tag on the grid to use
the toggle.

## What each role allows / refuses

| Role | Automatic features (provision, autotune, naming, staging, fleet, designer, self-heal) | Owner flight orders | Safety (stop / brake / hold, incl. dampeners + collision-avoidance guard) |
|---|---|---|---|
| `MANAGED` | allowed | allowed | allowed |
| `PERSONAL` | **refused** (`role_personal`) — no automatic action at all | **needs confirmation**, then allowed | always allowed |
| `BASE` | reads and safety only; a move/reconfigure is refused (`role_base`) | **refused**: "a base is never moved: every movement order is refused" | allowed |
| `OFF` | refused | refused | **refused** — the one exception: safety is also blocked |

`OFF` refuses every intent with one sentence: *"marked OFF in game: this grid
receives no orders."* Mission creation is gated before a mission exists
(`roleRefusalForMission` in `demo/routes.ts`): `OFF` → 409 `role_off`,
`BASE` + movement → 409 `role_base`, `PERSONAL` without confirmation → 409
`personal_confirmation_required`, and `PERSONAL` refuses build/repair/replace/
slot missions even when confirmed (those are automatic features).

## PERSONAL: the confirm flag and the gentle envelope

A PERSONAL order must carry `confirmPersonal: true` (in the mission body, or
`desiredState.personalConfirmed: true`); `/api/demo/move-to` also accepts
`confirmPersonal`. The site asks in a dialog before sending it. Allowed actions
are the explicit owner ones — `move`, `hold`, `stop`, `brake`, `land_at`,
`land_ground`, `land_stop`, `land_status`, `level_*`, `set_dampeners`, and the
read-only probes — plus the flight-safety writes (dampeners, collision
avoidance, gear/connector release).

Flights use `personalShipLimits(g)` (`demo/passengers.ts`): **60 m/s** cruise
cap, lateral accel dampened to 0.5 g and vertical to the passenger vertical
limit, **dampeners stay on, no free fall**.

## Routes

- `GET /api/demo/roles` → `{ roles: [{ gridId, name, role, roleSource,
  roleReason, conflict, conflictRoles, hints }], siteToggles, labels }` where
  `roleSource` is `in-game-tag | site-toggle | default | default-live |
  ownership` (`default-live` = untagged on the live instance, `ownership` = not
  your grid).
- `POST /api/demo/roles` with `{ gridId, role }` (`role` may be `null` to clear
  the toggle) → 200 with the new resolution, 409 `role_set_in_game` on a tagged
  grid. Every set is audited (`action: 'role_set'`).

The demo site shows the role as a badge with its source and reason in the
"Ship roles" panel (`RolePanel.tsx`).
