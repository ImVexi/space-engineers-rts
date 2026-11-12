# Survival loop (T66) — return home, refuel, relaunch on approval

Status: **on `main`, not deployed.** One loop per process:
`packages/backend/src/demo/survival/` (`loop.ts` = pure model, `service.ts` = live pass).
Tests: `packages/backend/tests/survival-loop.test.ts` (model + service) and
`packages/backend/tests/survival-executor-e2e.test.ts` (loop mission -> real
executor -> order).

A MANAGED relay that cannot stay on station comes home on its own, is flagged
`NEEDS_REFUEL`, and goes back to its slot only when the owner says so. The loop
sends **no plugin order of its own**: everything it does is a normal
`move` mission through the executor, so every role, comms, flight and landing
guard applies.

## 1. Trigger

Inputs (per grid, from the 30 s power poll snapshot and its sample series —
the same data `GET /api/demo/state` shows):

* `remainingPct` — `h2Pct` (fuel) or `batteryPct` (power);
* `runwayMin` — `computeRunway(snapshot, estimateRates(series))`: the endurance
  model's minutes left at the current drain;
* the live position, the home base position and the altitude of both.

```
fullTankMin = runwayMin / remainingPct * 100
transitMin  = distanceM / 100 m/s / 60
climbMin    = max(0, homeAltitudeM - altitudeM) / 100 m/s / 60
tripMin     = transitMin + climbMin + 3 min        // landing allowance
tripPct     = tripMin / fullTankMin * 100
needPct     = tripPct + 15                          // the existing reserve
threshold   = needPct * (1 + marginPct / 100)       // margin, default 20
trigger     = remainingPct < threshold
launchable  = remainingPct >= tripPct        // the flight itself, no reserve
```

Both resources are evaluated; the one with the **least headroom** decides (the
one that dies first). A resource with no projected drain has no runway and is
not judged — a net-positive battery is not "low" — **unless it reads `0 %` and
the trip needs it** (§1.1): a landed, static grid has no drain, so `runwayMin`
is null, and "no runway" must never hide an empty tank.

### 1.1 The launch gate — STRANDED

`trigger` says "come home". `launchable` says "it can still get there". A
triggered ship whose tank does **not** cover `tripPct` (transit + climb +
landing, **without** the 15 % reserve and without the margin) is not launched:

```
H2 0 %, needs 12 % to reach BASE-01; cannot return — refuel it where it is or send a tanker
```

The empty case is judged **before** the runway test, because `runwayMin === null`
only means "nothing is drawing from it right now":

* a resource the trip **needs** at `pct <= 0` is **STRANDED regardless of the
  runway** (this is the verify #3 case: eight static relays with `h2Pct 0` and no
  projected drain read `OK` on their 100 % battery, because the runway-null early
  return swallowed the `pct <= 0` branch);
* which resources the trip needs comes from the hull's thruster banks
  (`tripResources()` over `PREFAB_HARDWARE.thrustCounts`, the endurance
  classification staging already uses): any **H2 bank** = an empty tank grounds
  it, any **atmo/ion bank** = an empty battery grounds it. A hull with no
  profile is judged conservatively (both needed) and the reason says so;
* a resource the trip does **not** burn reading `0 %` is reported as
  "empty, but this resource is not what lifts the ship", not as STRANDED (an ion
  relay with a dry H2 tank still flies home);
* an **unknown** reading (`pct === null`) stays unknown and never triggers.

The consequences are the ones a triggered, unlaunchable ship always had:

* state **`STRANDED`**, a `stranded` alert (critical, one row per grid,
  resolved when it can fly again), a `demo_survival_stranded` audit row with the
  numbers and `keptStation`;
* **no mission, no order** — and a static grid in the air **stays a station**:
  the executor's unstation happens only in the launch preflight, which is never
  reached;
* the alert/state clears on its own: a later pass with enough fuel triggers and
  starts the return normally (as does a pass that is no longer below the
  threshold).

The threshold and the reserve are unchanged. `0 %` and `null` are still
different: `0 %` triggers (and is STRANDED), `null` never triggers.

**Why a full ship can never trigger (measured 2026-11-11, keep this in mind
before asking the test world to fly):** `threshold = (tripPct + 15) x (1 +
margin/100)` and `margin <= 100`, so the threshold tops out at `2 x needPct`. A
100 % reading therefore needs `tripPct > 35`, i.e. a trip that eats a third of a
full tank. To exercise the loop use `testRunwayOverride` (§7.2), not a full
ship and a bigger margin: `POST {marginPct: 600}` is `400 invalid` by design.

**A null never triggers.** No `pct`, no `runwayMin`, no distance, no home: the
loop says so and does nothing. `0 %` does trigger, with the number ("H2 0 %:
empty — needs 3.1 min of burn to reach BASE-01; cannot return").

Every decision is audited with the numbers in plain words, e.g.

```
SAT-L-0007: H2 18 %, needs 12 % to reach BASE-01 and land (+20 % margin = 15 %), returning
```

Audit actions: `demo_survival_recommendation`, `demo_survival_return_pending`,
`demo_survival_return_started`, `demo_survival_return_refused`,
`demo_survival_postponed`, `demo_survival_needs_refuel`,
`demo_survival_return_failed`, `demo_survival_ready`, `demo_survival_relaunch`,
`demo_survival_relaunch_refused`, `demo_survival_settings`, `demo_survival_home`,
`demo_survival_stranded`, `demo_survival_test_runway`,
`demo_survival_test_runway_used`, `demo_survival_test_runway_cleared`,
`demo_survival_test_runway_expired`.
A `return-home` alert row (one per grid, updated not repeated) carries the same
line and the numbers; `needs-refuel` is raised at touchdown and resolved at
relaunch.

## 2. Roles and a seated pilot

| Role | What the loop does |
|---|---|
| `MANAGED` | return (auto or approval-first), land, flag, wait, relaunch on approval |
| `PERSONAL` | **alert only** — `personal ship: no automatic action`; never a mission |
| `BASE` | nothing (not evaluated) |
| `OFF` | nothing (not evaluated) |

A seated pilot (`snapshot.underControl`) postpones everything: no mission, one
`demo_survival_postponed` audit row per minute, reason "a pilot is aboard (the
loop sends no orders while a seat is occupied)". The executor's existing manual
rule owns the grid from there.

## 3. Home

`resolveHome()` in `loop.ts`, in this order:

1. **per-ship override** — `POST /api/demo/survival/home {gridId, homeGridId}`
   or `{gridId, homePoint: {x,y,z}}`;
2. **the base flagged home** — `POST …/home {homeGridId}`, default `BASE-01`
   (a point may be the one home too: `POST …/home {homePoint}`);
3. **nearest base with a charging/refuel bay** (a battery or H2 tank in its
   profile);
4. otherwise **refused** with the reason: `no home: no base flagged home and no
   reachable base with a charging bay (N base candidate(s))`.

Only grids whose role resolves to `BASE` are candidates. A base is never moved
by the loop (roles already refuse it).

### 3.1 A home may be a point (map click / GPS)

`homePoint {x,y,z}` (or a `homeGridId` of `point:x,y,z` / a pasted
`GPS:name:x:y:z:` string) is stored as `point:x,y,z` and resolved **before**
the BASE lookup, so it is never silently dropped in favour of BASE-01. It is
validated first, and a bad point is a plain **400**, not a stored key:

| rule | code |
|---|---|
| near a planet | `off_planet` |
| on the surface (below the ground sample / more than 25 m above it) | `below_surface` / `above_surface` |
| landing-grade terrain (level 5, from the shared `ground.ts` sampler) | `coarse_ground` |
| at least 60 m from every grid | `too_close_to_grid` |

A grid home is validated too: `unknown_home` (no such grid) and `home_not_base`
(a MANAGED grid cannot be the home). A point home has no charging bay, so
`resolveHome` never falls back to it as a "nearest charger"; its altitude is
read from the planet catalogue for the climb allowance.

## 4. Return mission — the whole flight is existing code

`service.ts` resolves the landing spot, then creates and approves the same
`move` mission `POST /api/demo/move-to` would, with `desiredState.land: true`
and `desiredState.station = survival:return:<gridId>` (one grid in
`assignedUnits`, the target in the `move` step). The executor's `seedsFor()`
flies `survival:` through the **same seed builder as `move:`** — verify #3 never
left the ground because that builder only knew `designer:`/`chain:`/`move:`, so
the approved mission produced no execution and no order. A source no builder
understands is now an audited failure (`demo_mission_source_not_executable`,
reason "mission source not executable") that fails the mission instead of
leaving it at `approved`.

1. **unstation** — the executor's launch preflight reads `diag`, sees
   `isStatic`, sends `convert_to_ship` and verifies (`docs/station-mode.md`);
2. **comms gate** — checked before the mission is created and again on the move
   step. A denial holds the return with `comms gate denied <node>: <reason>`;
   stop/brake/hold are never gated (and the loop never sends them anyway).
   **Test-world exception:** `testIgnoreReach` (below) carries the same audited
   `ignoreReach` override `POST /api/demo/move-to` allows, because the test
   world's BASE-01 has no antenna block and the gate can never pass there;
3. **landing spot** — `chooseLandingSpot()`. Two home kinds, two rules:
   * a **point home** (`point:x,y,z`, already validated level-5 ground, on the
     surface, `>= 60 m` from every grid) has no hull: the ship lands **on the
     point** when it is still clear (`landing.atHome: true`, reason records the
     measured clearance), and is offset onto the ring search **only** when a
     grid blocks the point, with the blocker named in the reason (verify #3
     landed 150 m away on bearing 90 deg although the point was clear);
   * a **base grid** home keeps the polar sweep on the tangent plane at the base,
     closest ring first (150/250/350/450 m), bearings ordered by the side the
     ship arrives from. Keep-outs: the base hull + 90 m clearance, and every
     **landed** grid within 50 m of the base altitude + 60 m clearance.

   The same world gives the same spot, so an audit can be re-checked. No free
   landing point is a plain refusal, not a nudge;
4. **landing sequence** — the existing `lateral leg -> settle -> land_at`
   (`docs/HANDOFF.md` §4.11/§4.11a), flare and touchdown on the true ground;
5. **touchdown housekeeping** — `finishLanding()` sends the gear/mag-plate lock,
   autopilot off, dampeners on, and stays a ship (never a station on the ground);
6. **flag** — the loop sees the mission `done` and the drone `holding` and marks
   `NEEDS_REFUEL` (persisted in `kv:survival:loop`, shown per node in state and
   on the site). Its remembered slot is reported `vacant (refuelling)`; the
   coverage/self-heal logic sees a live grid that is no longer on station and may
   reshape neighbours — the survival rules still forbid spawning, teleporting or
   deleting one.

## 5. Refuel and relaunch

`NEEDS_REFUEL -> READY_TO_RELAUNCH` when every known tank/charge reading is at
or above `relaunchPct` (default **90 %**, configurable). The resource that
brought it home must be readable — an unread H2 tank cannot be "full".

Relaunch is **always owner-approved**, even in auto mode:
`POST /api/demo/survival/relaunch {gridId, confirm: true}`, or the site's
*Relaunch to slot*. Refusals: no confirm, wrong state, wrong role, no remembered
slot, gate denied. The mission is a `move` mission with
`desiredState.station = survival:relaunch:<gridId>`, the remembered slot as its
target and **no** `land`, so the executor flies it through the same move/seed
path as a return and the normal climb path back to the slot; the station pass
re-stations it after 30 s if station rules allow (`RTS_STATION_AFTER_MS`), and
the state returns to `OK`.

## 6. State machine

```
OK ──trigger (auto)──────────────> RETURNING ──landed──> NEEDS_REFUEL ──≥90 %──> READY_TO_RELAUNCH
 │                                    │                        ^                        │
 │  (approval-first)                  └─failed/cancelled──> OK (retry after 10 min)    │
 ├──> RETURN_PENDING ──owner approve──> RETURNING                                      │
 │                                                                                     │
 │  trigger + remaining < tripPct                                                      │
 └──> STRANDED (no mission, no order; alert + audit)                                   │
        │  later pass with enough fuel, or no longer below threshold                    │
        └──> OK / RETURNING / RETURNING(PENDING)          relaunch (confirm) ───────────┘
                                                           RETURNING (phase relaunch) ──arrived──> OK
```

The record (per grid) carries the state, phase, the need that produced it, the
home and landing spot, the remembered slot, the mission id and the refuel
percentage. `survivalView()` is what the site renders: `RETURN_PENDING` shows as
"RETURNING (awaiting approval)"; a grid with a slot and `NEEDS_REFUEL` /
`READY_TO_RELAUNCH` shows "vacant (refuelling)".

## 7. Settings and routes

| Route | Body | Does |
|---|---|---|
| `GET /api/demo/survival` | — | settings + defaults + every grid the loop has an opinion on |
| `POST /api/demo/survival/settings` | `{approvalMode?, marginPct?, relaunchPct?, testIgnoreReach?}` | clamp + audit; `auto` (default) or `approve`; `testIgnoreReach` is test-env only (see below) |
| `POST /api/demo/survival/home` | `{gridId?, homeGridId?, homePoint?}` | per-ship or global home: a BASE grid, an encoded point/GPS string, or `homePoint {x,y,z}` (`null` clears); invalid targets are 400 |
| `POST /api/demo/survival/test-runway` | `{gridId, resource, runwayMin, pct, ttlMin?}` | TEST-ENV-ONLY per-grid runway override (see 7.2) |
| `POST /api/demo/survival/test-runway/clear` | `{gridId?}` | clear one override, or all when no grid is named |
| `POST /api/demo/survival/return` | `{gridId}` | approve a `RETURN_PENDING` return |
| `POST /api/demo/survival/relaunch` | `{gridId, confirm}` | owner-approved relaunch to the slot |

`GET /api/demo/state` gains `survival: {settings, defaultHomeId, overrides,
grids[]}` and `nodes[].survival` (state, label, reason, slot status, refuel %).

### 7.1 `testIgnoreReach` — the TEST-ENV-ONLY loop override

The loop's return/relaunch missions can carry the same audited `ignoreReach`
admin override that `POST /api/demo/move-to` accepts, so the loop can actually
be exercised on the test world (BASE-01 has **zero antenna blocks**, so the
comms gate refuses every move and the ship would stay on the ground forever).

* Setting: `settings.testIgnoreReach`, default **false**; only a real boolean
  turns it on (`"true"` / `1` stay off).
* In force only when **all three** hold: the setting is on, the process is the
  demo/test env (`RTS_DEMO=1` + `RTS_ENV=test`), and **survival mode is off**
  (`resolveSurvivalMode() === false`, i.e. `RTS_TEST_SERVER_MARKER=se-rts-test`).
  A persisted `true` on a survival backend is **ignored**, not trusted
  (`testIgnoreReachActive()` in `demo/survival/loop.ts`).
* The route refuses it explicitly: `POST /api/demo/survival/settings
  {testIgnoreReach:true}` on a survival backend → **409 `survival_mode`** with
  an audit row (`survival_refused`, flag `testIgnoreReach`); outside the demo env
  → 409 `admin_override_not_allowed`.
* When used, the mission carries `plan.steps[].params.adminOverride: true` (the
  field the executor already reads for a T10 admin override), the plan notes say
  `[ADMIN OVERRIDE (test server): reachability check bypassed]`, and the
  `demo_survival_return_started` / `demo_survival_relaunch` audit rows carry
  `adminOverride: true` plus `gateBypassed: <gate reason>`.

### 7.2 `testRunwayOverride` — exercising the flight on the test world

The test world's ships are full, and a full ship cannot trigger (§1.1). A
test-env-only override replaces the **trigger's reading for one grid** so the
whole return -> land -> refuel -> relaunch flight can be run:

```
POST /api/demo/survival/test-runway
{ "gridId": "grid:…", "resource": "h2", "runwayMin": 480, "pct": 8, "ttlMin": 30 }
```

* **only** that grid and **only** the trigger: `{pct, runwayMin}` go through the
  same `evaluateResourceNeed` formula; no threshold or reserve changes;
* `READY_TO_RELAUNCH` is judged on **live** readings (`advanceRefuel` never uses
  the override), so on the test world a full ship goes READY once it has landed —
  clear the override and the loop is back on live numbers;
* refused with **409 `survival_mode`** (audited `survival_refused`) when the
  process is not the test world, and **ignored** there even if a value was
  already persisted (`survival:test-runway` kv row, `runwayOverrideActive()`);
* audited on set (`demo_survival_test_runway`), on use
  (`demo_survival_test_runway_used`, once a minute per grid, with the live
  reading it replaced), on clear (`demo_survival_test_runway_cleared`) and on
  expiry (`demo_survival_test_runway_expired`);
* **expires by itself**: default 30 min, `ttlMin` accepted up to 120; expired
  rows are dropped and audited on the next read.

The Fleet panel shows a "Return & refuel" section: the mode toggle, the margin /
reserve / relaunch thresholds, one row per grid with its state badge and the
backend's reason line, and the two buttons (Approve return, Relaunch to slot).

## 8. What this does not do

* No spawning, teleporting, deleting or velocity writes — pinned by a source
  sweep over `src/demo/survival/**` (`'spawn_prefab'`, `'clone_grid'`,
  `'delete_grid'`, `'zero_velocity'`, `'teleport'`, `'set_orientation'`) and by
  the fact the module calls no plugin API at all.
* No automatic relaunch, not even in auto mode: the owner approves it.
* No safety-threshold changes: the 15 % reserve and every landing abort limit
  are the existing ones; the margin is on the requirement, not on the reserve.
* No second poller: it reads the power poller's cache on its own 30 s pass.
