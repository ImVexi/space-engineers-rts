# Building from source

You only need this if you want to change the code or build the plugin yourself.
The released `HermesRts.Plugin.dll` already contains the survival build.

## What you need

| Tool | Version | For |
|---|---|---|
| Node.js | 20.19+ (npm 9+) | backend, site, tests |
| .NET SDK | 8 | the `net48` plugin build |
| Space Engineers Dedicated Server | `01_210_014` | reference assemblies only |

The plugin compiles against Keen's own DLLs in your `DedicatedServer64` folder.
They are not in this repository and cannot be redistributed.

## Backend and site

```bash
git clone <your-fork-url> space-engineers-rts
cd space-engineers-rts
npm ci
npm run typecheck
npm test                 # backend, schemas, site and firmware tests
npm run demo:build       # builds packages/demo-site/dist
```

If `npm run demo:build` fails on fonts or WebGL types, check `node -v` first.

## Plugin

```bash
export SE_DS_BIN=/path/to/DedicatedServer64    # must contain Sandbox.Game.dll
dotnet build plugin/HermesRts.Plugin/HermesRts.Plugin.csproj -c Release
```

Output: `plugin/HermesRts.Plugin/bin/Release/HermesRts.Plugin.dll`.

The build fails with a clear error if `SE_DS_BIN` is unset or has no
`Sandbox.Game.dll`. No third-party dependency needs to be shipped beside the
DLL: the server already provides `Newtonsoft.Json` and the game assemblies.

## Proving the survival build

```bash
export SE_DS_BIN=/path/to/DedicatedServer64
bash deploy/build-plugin.sh
```

This builds into `deploy/plugin-out/`, then reads the produced DLL's symbol
table and fails the build if any admin handler is present (`SpawnPrefab`,
`CloneGrid`, `ZeroVelocity`, `SetOrientation`, `RefillGrid`, `TeleportPlayer`,
`DsTestHarness`). The last line must read:

```
OK: survival package has no admin handler.
```

The snake_case action names do remain in the string table: they are the routing
table and the refusal text, so the check looks at CLR method names, not those.

## Offline plugin tests

The control-law tests are plain console projects under
`plugin/HermesRts.Plugin/tests/` and need no game assemblies:

```bash
cd plugin/HermesRts.Plugin/tests/land-math && dotnet run
cd ../channel-routing && dotnet run
```

## Packaging a release

```bash
mkdir -p dist
cp deploy/plugin-out/HermesRts.Plugin.dll dist/
cp deploy/plugin.json.template dist/plugin.json.example
cd dist && zip space-engineers-rts-plugin-<version>.zip HermesRts.Plugin.dll plugin.json.example
cd .. && sha256sum dist/*.zip > dist/SHA256SUMS
```

Do not commit the DLL or the zip; attach them to a release instead.
