# Troubleshooting

## The plugin does not load

Symptoms: no `hermes` lines in the server log at all.

- The `<Plugins>` entry in `SpaceEngineers-Dedicated.cfg` must point at the DLL
  relative to the server executable, with a Windows-style path
  (`plugins\HermesRts.Plugin.dll`) even under Wine.
- `net48` needs .NET Framework 4.8 in the host or prefix. Under Wine, install
  `wine-mono` or the .NET 4.8 runtime; without it the assembly fails to load with
  a `FileLoadException`.
- Check `plugin.json` parses. A malformed file throws during `Init` and the
  server log shows `plugin init failed: ...`.
- If the log shows `config invalid: ...`, the message names the field. A
  non-loopback `backendUrl` with a token shorter than 16 characters is the most
  common cause.

## Plugin loads but `agentConnected` is false

`curl -s http://<backend-host>:8761/api/health`.

- The plugin makes an **outbound** WebSocket. The game server must be able to
  reach `<backend-host>:8761`. Test from the game host, not from your desktop.
- `token` in `plugin.json` must equal `RTS_TOKEN` exactly.
- A reverse proxy in front of the backend must forward WebSocket upgrades.
- The plugin reconnects with backoff; watch for `backend connected` after a fix
  rather than restarting the world.

## Orders are refused with `comms_denied`

The authority gate could not find a fresh path from the hull to a powered
`[HERMES-BASE]` antenna.

- Is the base tagged, and does it have a powered, switched-on radio antenna?
- Is the antenna's range enough to reach the hull?
- Is the hull's own antenna powered and on?
- A base with zero antennas authorises nothing, by design. Build the antenna
  rather than looking for a bypass.

## Nothing is automated, no matter what I tag

- `RTS_OWNER_STEAM_IDS` (backend) and `ownerSteamIds` (plugin) are empty. The
  backend logs a warning at startup in that case. Set both to your Steam id.
- The backend started without `RTS_FLAGS=demo_execute` on a live instance: the
  executor never sends an order.
- The kill switch is on (`/api/health` → `killSwitch`).

## "sim speed hold" / orders stop

The world dropped below `RTS_SIMSPEED_MIN` (0.95) for `RTS_SIMSPEED_HOLD_MS`.
New flight orders are held until it recovers. Check for a runaway grid count
(`/api/demo/state` → `nodes`), a large unloaded complex, or a server that is
short of CPU. Raising the limit is not recommended; fix the world.

## A ship hovers and never touches down

- The landing handover is `RTS_DEMO_HANDOVER_AGL` (150 m by default). Below it
  the plugin's `land_at` controller flies the last part. If the plugin does not
  advertise `land_controller` in its hello, the backend flies pulsed descents
  instead and touchdown is rougher.
- Terrain height comes from the planet's own data. On a modded planet the
  ground datum can be off; check `/api/demo/state` for `groundSource`.
- A hull whose belly hangs below its pivot needs a correct keel depth (the
  plugin reports it). Without it the target ground point is wrong.

## Map is empty or ships are missing

- The map shows grids the plugin reports. Only grids owned by a configured Steam
  id (or faction) are reported.
- Ships unseen for `RTS_DEMO_ARCHIVE_MS` (6 h) are archived.
- If the site shows "Demo site locked", it was built without
  `VITE_DEMO_API_BASE`; rebuild with `npm run demo:build`.

## Backend will not start

- `refusing to bind ...`: a non-loopback `RTS_BIND` needs `RTS_TOKEN` of at least
  16 characters.
- `demo routes refused to start: ...`: read the message — it names the missing
  `RTS_DEMO_SURVIVAL=1`, a forbidden marker on `live`, or a test-only fixture.
- `EADDRINUSE`: another process has the port. One backend serves one game
  server; do not point two plugins at one backend.

## Where the logs are

- Plugin: the dedicated server log, lines prefixed `hermes:`.
- Backend: stdout / journal (`journalctl -u se-rts`).
- Audit: `/api/audit` shows every accepted and refused order with its reason.
