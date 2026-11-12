# Architecture

Three pieces: a plugin inside the game server, a backend on your LAN, and a web
map the backend serves.

```
Space Engineers Dedicated Server
  ├─ your grids
  │    └─ Programmable Block: firmware (local hold / waypoint / dock reflex)
  └─ HermesRts.Plugin.dll
       • telemetry collector   (your grids only)
       • command executor      (autopilot, connectors, landing)
       • handoff detector      (programmable block handover)
       • safe mode             (backend silence -> stop autopilots)
                    │
                    │ outbound WebSocket (the plugin dials out; no inbound port)
                    ▼
Backend (Node/TypeScript)
  • plugin link: hello, telemetry, event, order, ack, status
  • mission queue, reconciler, comms gate, dispatcher, budgets, audit
  • REST/WS on 127.0.0.1 by default; a token is required off-loopback
  • serves the map and the API at :8761
                    │
                    ▼
Web map (packages/demo-site)
  • 3D world view, fleet and mission panels, approvals, alerts
```

## How the pieces talk

- **Plugin to backend:** one outbound WebSocket per backend, JSON. Every order
  carries an `orderId`; the plugin de-duplicates and acknowledges retries with
  the same id.
- **Plugin to programmable block:** in-game scripting interface (IGC) only. A
  programmable block has no sockets, so it can never be the backend path.
- **Backend to game:** orders only for grids the comms gate can reach through a
  powered antenna on a `[HERMES-BASE]` grid with fresh telemetry.
- **Remote API:** not used. The plugin reads the server's own assemblies.

## Authority and safety layers

1. **Role gate.** Only owned, tagged grids are commanded. Untagged, unowned,
   `[PERSONAL]` and `[OFF]` grids are read-only (see [ship-roles.md](ship-roles.md)).
2. **Comms gate.** No reachable base antenna, no order — `comms_denied`.
3. **Flight guards.** Braking, reserve, ground and overshoot checks on every
   flight tick (see [flight-guards.md](flight-guards.md)).
4. **Sim-speed gate.** No new flight orders below `RTS_SIMSPEED_MIN`.
5. **Safe mode.** The plugin stops autopilots when the backend goes silent; a
   dead-man restores dampeners on a grid the backend stops ordering.
6. **Kill switch.** Stops reconciliation and dispatch process-wide.

## Optional world-geometry service

The map can draw terrain and block shapes from a separate world-geometry
service. That service is **not part of this project and is not published**.
Without it the map falls back to an approximate planet shell with no terrain
occlusion; every control function works either way. If you have such a service,
point `RTS_TELEMETRY_TEST_BASE` at it (default `http://127.0.0.1:8786`). The
backend only proxies fixed read-only paths to it.

## Deliberate gaps

No blueprint printing, no material ledger, no pathfinding around terrain, no
multi-backend clustering (one backend drives one world). The plugin performs no
action a player could not perform from the cockpit.
