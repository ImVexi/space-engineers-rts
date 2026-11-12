# In-game setup

The control system only touches grids you have explicitly marked and that you
own. Do this before you expect the map to show anything useful.

## 1. Build one base with a radio antenna

1. Put a block on the base and rename it `[HERMES-BASE] BASE-01` (any block's
   CustomName works), or add `HERMES_ROLE=base` to a block's CustomData.
2. Build and **power** at least one radio antenna on that base, switched **On**, with a range that reaches where your ships fly (~50 km for a large-grid
   antenna).
3. Leave the base grid alone: it is the home point the survival loop returns to
   and it is never moved by the system.

Without a reachable `[HERMES-BASE]` grid, every movement order is refused with
`comms_denied`. A base with zero powered antennas cannot authorise anything.

## 2. Tag your ships

Matching is case-insensitive. Full tags, aliases and the `HERMES_ROLE=` form all
work:

| Purpose | Tag in a block's CustomName | CustomData |
|---|---|---|
| Let the system fly it | `[HERMES-MANAGED]` or `[MANAGED]` | `HERMES_ROLE=managed` |
| Never touch automatically | `[PERSONAL]` or `[HERMES-PERSONAL]` | `HERMES_ROLE=personal` |
| A base / station | `[HERMES-BASE]` or `[BASE]` | `HERMES_ROLE=base` |
| Read only, no orders ever | `[OFF]` or `[HERMES-OFF]` | `HERMES_ROLE=off` |

- **Untagged grids are OFF.** An untagged ship, a pirate/NPC grid or debris gets
  no orders.
- **Ownership is checked on top of the tag.** A non-OFF role also requires the
  grid's big owner to be you (a Steam id in `RTS_OWNER_STEAM_IDS` /
  `ownerSteamIds`) or a member of your faction. An NPC grid carrying a copied
  tag is still not yours.
- Tag `[PERSONAL]` on every ship of your own you do not want automated. It is
  the only role that keeps a ship out of the optimiser, provisioning and fleet
  operations while still allowing a confirmed order.

## 3. What a managed hull needs

- a Remote Control block (the autopilot),
- a radio antenna with range to the base,
- fuel and/or battery charge,
- a role tag and an owner match.

A hull missing any of these is reported with a reason rather than flown.

## 4. First run

1. Open `http://<backend-host>:8761/demo/`.
2. Confirm the safety bar shows `SURVIVAL MODE` and `agentConnected`.
3. Select a ship, open its role panel and confirm the tag was read from the
   game (in-game tags beat the site toggle).
4. Send one explicit move order to a nearby point, at low speed. Approve it.
5. Fly a landing (`land_at`) on flat ground before you trust a fleet mission.

## 5. The survival loop

A managed ship whose fuel drops below its runway threshold returns to its home
point, lands, and waits. When you refuel it (or its battery recharges), it
becomes `READY_TO_RELAUNCH`; relaunch is an approval, never automatic. The full
state machine is in [survival-loop.md](survival-loop.md).
