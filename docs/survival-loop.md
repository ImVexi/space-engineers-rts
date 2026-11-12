# Survival loop: return, refuel, relaunch

A `MANAGED` relay that cannot stay on station comes home on its own, is flagged
`NEEDS_REFUEL`, and goes back to its slot only when you say so.

The loop sends **no plugin order of its own**. Everything it does is an ordinary
`move` mission through the executor, so every role, comms, flight and landing
guard applies exactly as it does to a hand-flown order.

## When it triggers

The loop reads each grid's fuel and charge from the power poller, projects the
minutes left at the current drain, and asks whether the ship can still get home
with the usual 15 % reserve plus a margin (default 20 %):

```
full tank minutes = runwayMin / remainingPct x 100
trip              = distance / 100 m/s + climb + 3 min landing allowance
need              = trip + 15 %                        (the reserve)
threshold         = need x (1 + marginPct / 100)
trigger           = remainingPct < threshold
```

Both resources are evaluated; the one with the least headroom decides. A
resource with no projected drain is not judged — a net-positive battery is not
"low" — unless it reads 0 % and the trip needs it.

**A full ship never triggers**: the threshold tops out at twice the need, so a
100 % reading would need a trip eating a third of a full tank. In practice the
loop fires on ships that have been out for a while.

Every decision is written to the audit in plain words, e.g.

```
SAT-L-0007: H2 18 %, needs 12 % to reach BASE-01 and land (+20 % margin = 15 %), returning
```

## STRANDED

A triggered ship whose tank does not cover the trip (transit + climb + landing,
without the reserve) is **not launched**:

```
H2 0 %, needs 12 % to reach BASE-01; cannot return — refuel it where it is or send a tanker
```

State `STRANDED`, a critical `stranded` alert (one per grid, cleared when it can
fly again), and **no mission, no order**. A static grid in the air stays a
station. It clears itself on a later pass with enough fuel.

Which resource grounds a ship comes from its thrusters: any hydrogen bank means
an empty tank grounds it, any atmo/ion bank means an empty battery does. A
resource the trip does not burn reading 0 % is reported as "empty, but this
resource is not what lifts the ship". An unreadable value never triggers.

## Roles and pilots

| Role | What the loop does |
|---|---|
| `MANAGED` | return (auto or approval-first), land, flag, wait, relaunch on approval |
| `PERSONAL` | alert only — never a mission |
| `BASE`, `OFF` | nothing (not evaluated) |

A seated pilot postpones everything: no mission, one audit row per minute,
reason "a pilot is aboard". Manual control owns the grid from there.

## Home

Resolved in this order:

1. a per-ship home — a base grid, a map point, or a GPS string;
2. the base flagged home (default: the base you flag);
3. the nearest base with a battery or hydrogen tank in its profile;
4. otherwise refused: `no home: no base flagged home and no reachable base with
   a charging bay`.

Only `BASE` grids are candidates, and a base is never moved by the loop.

A point home is validated: it must be near a planet, on the surface, on
landing-grade terrain and at least 60 m from every grid. A bad point is a plain
400, never a silently substituted base.

## The return flight

The whole flight is existing code:

1. **unstation** — the launch preflight sees `isStatic` and converts back to a
   ship;
2. **comms gate** — checked before the mission and again on the move step; a
   denial holds the return with the reason;
3. **landing spot** — a point home is landed on directly when it is clear, and
   offset only if a grid blocks it. A base home uses a polar sweep on the
   tangent plane, closest ring first (150 / 250 / 350 / 450 m), keeping 90 m
   from the base hull and 60 m from landed grids;
4. **landing** — lateral leg, settle, final descent, flare, touchdown;
5. **housekeeping** — gear lock, autopilot off, dampeners on; the ship stays a
   ship, never a station on the ground;
6. **flag** — `NEEDS_REFUEL`, and its slot shows as *vacant (refuelling)*.

The landing spot is deterministic: the same world gives the same spot, so an
audit can be re-checked. No free landing point is a refusal, not a nudge.

## Refuel and relaunch

`NEEDS_REFUEL` becomes `READY_TO_RELAUNCH` when every readable tank or battery
is at or above `relaunchPct` (default **90 %**). An unread tank cannot count as
full.

**Relaunch is always owner-approved**, even in auto mode: the site's *Relaunch
to slot* button, or `POST /api/demo/survival/relaunch` with `confirm: true`. It
is refused without the confirmation, in the wrong state or role, without a
remembered slot, or when the comms gate denies. The flight back is the normal
climb path; the station pass re-stations it after 30 s if station rules allow,
and the state returns to `OK`.

## State machine

```
OK ──trigger (auto)──────────> RETURNING ──landed──> NEEDS_REFUEL ──≥90 %──> READY_TO_RELAUNCH
 │                                 │                      ^                        │
 │  (approval-first)               └─failed/cancelled──> OK (retry after 10 min)   │
 ├──> RETURN_PENDING ─approve──> RETURNING                                         │
 │                                                                                 │
 ├──trigger + remaining < trip──> STRANDED (no mission, no order; alert + audit)   │
 │        └─ later pass with enough fuel ──> OK / RETURNING                         │
 │                                                          relaunch ──────────────┘
 │                                                          RETURNING ──arrived──> OK
```

## Settings and endpoints

| Route | Body | Does |
|---|---|---|
| `GET /api/demo/survival` | — | settings, defaults, every grid the loop has an opinion on |
| `POST /api/demo/survival/settings` | `{approvalMode?, marginPct?, relaunchPct?}` | clamp and audit; `auto` (default) or `approve` |
| `POST /api/demo/survival/home` | `{gridId?, homeGridId?, homePoint?}` | per-ship or global home; `null` clears |
| `POST /api/demo/survival/return` | `{gridId}` | approve a pending return |
| `POST /api/demo/survival/relaunch` | `{gridId, confirm}` | owner-approved relaunch to the slot |

`GET /api/demo/state` reports the loop per grid (state, reason, slot status,
refuel percentage) and the fleet panel shows a *Return & refuel* section with the
mode, the thresholds and the two buttons.

`approvalMode: auto` still requires approval for relaunch; it only skips the
approval step for the return leg.

## What this does not do

- No spawning, teleporting, deleting or velocity writes — the module calls no
  plugin API directly at all.
- No automatic relaunch, not even in auto mode.
- No change to safety thresholds: the 15 % reserve and every landing abort limit
  are the existing ones; the margin applies to the requirement, not the reserve.
- No second poller: it reads the power poller's cache on its own 30 s pass.
