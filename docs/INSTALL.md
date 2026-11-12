# Install, upgrade and uninstall

This guide assumes the game server and the backend run on the same LAN.

## 1. Requirements

- Space Engineers Dedicated Server `01_210_014` (the build this plugin was
  compiled against). Other builds may work; the assembly references must resolve.
- .NET Framework 4.8 on the server host (Windows: built in. Linux/Wine: a prefix
  with `wine-mono` or .NET 4.8).
- Node.js 20.19+ for the backend, on any LAN host (Linux or Windows).
- .NET SDK 8 on the build machine, to build the plugin.
- Your own `DedicatedServer64` folder for the plugin's reference DLLs. They are
  Keen's binaries and are **not** in this repository.

## 2. Build the backend and site

```bash
npm ci
npm run typecheck
npm test
npm run demo:build          # packages/demo-site/dist
```

If `npm run demo:build` fails on fonts or WebGL types, you are on an older
Node — check `node -v` first.

## 3. Build the plugin

```bash
export SE_DS_BIN=/path/to/DedicatedServer64
dotnet build plugin/HermesRts.Plugin/HermesRts.Plugin.csproj -c Release
```

The build fails with a clear error if `SE_DS_BIN` is unset. The output is
`plugin/HermesRts.Plugin/bin/Release/HermesRts.Plugin.dll`.

`deploy/build-plugin.sh` wraps the same command, writes into
`deploy/plugin-out/`, and greps the produced DLL to prove that no admin handler
(`SpawnPrefab`, `CloneGrid`, `TeleportPlayer`, …) is inside it.

## 4. Install the plugin on the server

1. **Stop the server.** Do not hot-swap the DLL.
2. Copy `HermesRts.Plugin.dll` and `plugin.json` into a folder inside the server
   directory, e.g. `DedicatedServer64\plugins\`.
3. Add the plugin to `SpaceEngineers-Dedicated.cfg`:

```xml
<Plugins>
  <string>plugins\HermesRts.Plugin.dll</string>
</Plugins>
```

The path is relative to the dedicated server executable. On Linux/Wine use the
same Windows-style path you would use on Windows.

4. Start the server and check the log for:

```
hermes: config file: .../plugin.json (exists=True)
hermes plugin 0.4.0-action-channel initialised on ...
hermes: backend connected: ws://<backend-host>:8761/plugin
```

5. Log in once with the account whose Steam id is in `ownerSteamIds` — the
   plugin resolves identities from players that exist in the world.

## 5. Run the backend

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

Use the same token in `plugin.json`. `deploy/se-rts.env.example` has the full
set with comments; `deploy/se-rts.service` is a systemd unit template.

Check it:

```bash
curl -s http://<backend-host>:8761/api/health
# {"ok":true,...,"agentConnected":true,"survivalMode":true,"killSwitch":false}
```

Open `http://<backend-host>:8761/demo/` for the map.

## 6. Upgrade

1. Stop the game server.
2. Replace `HermesRts.Plugin.dll` (keep the old one as `.bak`).
3. Start the game server; confirm `initialised` and `backend connected`.
4. Restart the backend (`systemctl restart se-rts`) and rebuild the site if the
   frontend changed.

The control database (`RTS_DATA_DIR/rts.db`) is forward-compatible; back it up
before upgrading anyway.

## 7. Uninstall

1. Stop the game server and remove the `<Plugins>` entry (or the DLL) from the
   server folder.
2. Remove the backend unit / process and the `RTS_DATA_DIR` directory.
3. Nothing is written into the world save by the plugin, so no save rollback is
   required.
