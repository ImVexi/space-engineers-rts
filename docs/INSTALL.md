# Install, upgrade and uninstall

This guide assumes the game server and the backend run on the same LAN.

## 1. Requirements

- Space Engineers Dedicated Server `01_210_014` (the build this plugin was
  compiled against). Other builds may work; the assembly references must resolve.
- .NET Framework 4.8 on the server host (Windows: built in. Linux/Wine: a prefix
  with `wine-mono` or .NET 4.8).
- Node.js 20.19+ for the backend, on any LAN host (Linux or Windows).
- A current Chromium or Firefox with WebGL2 for the map.

You do **not** need a .NET SDK unless you build the plugin yourself — see
[BUILDING.md](BUILDING.md).

## 2. Get the plugin

Either use the `HermesRts.Plugin.dll` attached to a GitHub release, or build it
from source ([BUILDING.md](BUILDING.md)). A release zip also contains
`plugin.json.example` and a short `INSTALL.txt`.

## 3. Install the plugin on the server

1. **Stop the server.** Do not hot-swap the DLL.
2. Create a `hermes` folder in the **server root** — the folder that holds
   `DedicatedServer64`, not a subfolder of it — and copy
   `HermesRts.Plugin.dll` and `plugin.json` into it:

   ```
   <server root>\hermes\HermesRts.Plugin.dll
   <server root>\hermes\plugin.json
   ```

   On a Pelican/Wine server the root is the game volume (`Z:\home\container`),
   so the plugin lives at `Z:\home\container\hermes\`. This is the path the
   loader reads `plugin.json` from; a copy under `config\hermes` or
   `DedicatedServer64\plugins` is not loaded.

3. Add the plugin to `SpaceEngineers-Dedicated.cfg`, with the path **relative to
   the server root**:

```xml
<Plugins>
  <string>hermes\HermesRts.Plugin.dll</string>
</Plugins>
```

The path is relative to the server root. On Linux/Wine use the
same Windows-style path you would use on Windows.

4. Start the server and check the log for:

```
hermes: config file: .../plugin.json (exists=True)
hermes plugin 0.4.0-action-channel initialised on ...
hermes: backend connected: ws://<backend-host>:8761/plugin
```

5. Log in once with the account whose Steam id is in `ownerSteamIds` — the
   plugin resolves identities from players that exist in the world.

## 4. Run the backend

```bash
npm ci
npm run demo:build          # packages/demo-site/dist
cp deploy/se-rts.env.example .env      # then edit it
```

```bash
export RTS_ENV=live
export RTS_DEMO=1
export RTS_DEMO_SURVIVAL=1
export RTS_BIND=0.0.0.0
export RTS_PORT=8761
export RTS_TOKEN="$(head -c 24 /dev/urandom | base64)"
export RTS_OWNER_STEAM_IDS=<your-steam-id>
npm start
```

Use the same token in `plugin.json`. `deploy/se-rts.env.example` has the full set
with comments; `deploy/se-rts.service` is a systemd unit template.

Check it:

```bash
curl -s http://<backend-host>:8761/api/health
# {"ok":true,...,"agentConnected":true,"survivalMode":true,"killSwitch":false}
```

Three fields decide whether the install is done:

| Field | Expected | If not |
|---|---|---|
| `ok` | `true` | read the startup message; a refusal names the variable |
| `agentConnected` | `true` | the plugin is not reaching the backend — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| `survivalMode` | `true` | `RTS_ENV=live` and `RTS_DEMO_SURVIVAL=1` are both set |

Open `http://<backend-host>:8761/demo/` for the map.

## 5. A live instance is its own install

Do not run the live backend on the same port, token or data directory as a test
instance. One backend serves one game server, and one data directory holds one
audit history.

| | Live | Test (optional) |
|---|---|---|
| `RTS_ENV` | `live` | `test` |
| `RTS_DEMO_SURVIVAL` | `1` | unset |
| `RTS_PORT` | e.g. `8761` | e.g. `8762` |
| `RTS_DATA_DIR` | e.g. `/var/lib/se-rts-live` | e.g. `/var/lib/se-rts-test` |
| `RTS_TOKEN` | its own token | its own token |
| plugin `serverId` | e.g. `se1-live` | e.g. `se1` |

A second game server also needs its own CPU. A test server running beside the
live one halves the live sim speed and trips the sim-speed hold; stop the test
server when you are not using it ([simspeed.md](simspeed.md)).

## 6. In game

Put a powered radio antenna on one base and tag a block `[HERMES-BASE]`. Tag the
hulls the system may fly `[HERMES-MANAGED]`; tag everything else `[PERSONAL]` or
`[OFF]`. Full walkthrough: [IN-GAME-SETUP.md](IN-GAME-SETUP.md).

## 7. Upgrade

1. Stop the game server.
2. Replace `HermesRts.Plugin.dll` (keep the old one as `.bak`).
3. Start the game server; confirm `initialised` and `backend connected`.
4. Restart the backend (`systemctl restart se-rts`) and rebuild the site if the
   frontend changed.

The control database (`RTS_DATA_DIR/rts.db`) is forward-compatible; back it up
before upgrading anyway.

## 8. Uninstall

1. Stop the game server and remove the `<Plugins>` entry (or the DLL) from the
   server folder.
2. Remove the backend unit / process and the `RTS_DATA_DIR` directory.
3. Nothing is written into the world save by the plugin, so no save rollback is
   required.
