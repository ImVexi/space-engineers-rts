# Uniform PB firmware

**UNCOMPILED — test on the test server first.**

`HermesFirmware.cs` is the one script that runs on every grid. Identity and
role are data (`Me.CustomData`), not code. The server distinguishes grids by
entity id and injects/updates the config; it never needs a custom script per
ship.

## Custom Data written by the server / the owner

```
HERMES_ID=sat-relay-001
HERMES_ROLE=relay
HERMES_GOAL=hover
```

`HERMES_GOAL` accepts `hover`, `orbit`, `interplanetary`, `crash`; anything
else falls back to `hover`. The PB writes `HERMES: READY — goal=<goal>` to the
LCD whose name contains `HERMES`, and broadcasts status on IGC tag
`HERMES_STATUS`.

## Commands (IGC tag `HERMES`, or the PB's Run argument)

| Command | Effect |
|---|---|
| `CMD\|MOVE\|x\|y\|z\|speed` | Autopilot to a world-space point |
| `CMD\|WAYPOINT\|x\|y\|z` | Same as MOVE (single waypoint) |
| `CMD\|HOLD` | Low-speed hold near the current position |
| `CMD\|STOP` | Disable autopilot, clear waypoints |
| `CMD\|DOCK\|<name>` | Connect the named (or first) connector |
| `CMD\|UNDOCK\|<name>` | Disconnect it |
| `CMD\|STATUS` | Force an LCD/IGC status update |

The leading `CMD|` is optional. The script is deliberately small: local reflex
only. It has no network access (PB sandbox), so telemetry and orders travel
through the plugin, not from this script.

## Before use

1. Run `node firmware/tools/firmware-lint.mjs firmware/HermesFirmware.cs`.
2. Paste into a PB on a **test server** and confirm it compiles.
3. Verify the `// VERIFY:` calls (autopilot, connector, LCD) against the
   installed SE version (live is `01_210_014`, wine-mono 6.13).
4. Only then pin the version as certified (`hermes-cert-<goal>-vN`).

Nothing here has been run in game. The LCD line is intentionally the contract
from the deploy instructions §5; do not change its shape without updating the
backend detector/tests.
