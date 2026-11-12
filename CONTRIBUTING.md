# Contributing

Bug reports and pull requests are welcome.

## Before you start

- Read [docs/SAFETY.md](docs/SAFETY.md). The survival boundary is not negotiable:
  the public plugin must not gain spawn, clone, delete, refill, teleport,
  orientation-write or save actions. `deploy/build-plugin.sh` fails the build if
  an admin handler appears in the DLL.
- One backend serves one game server. Do not add multi-world support to a pull
  request that is fixing something else.

## Development setup

```bash
npm ci
npm test
npm run typecheck
npm run demo:build
```

The plugin needs the SE Dedicated Server reference DLLs:

```bash
export SE_DS_BIN=/path/to/DedicatedServer64
dotnet build plugin/HermesRts.Plugin/HermesRts.Plugin.csproj -c Release
```

Those DLLs are Keen's and must never be committed.

## Pull requests

- Keep the change focused; describe the failure it fixes and the measurement
  that proves it (a test, a number, a log line).
- Add or update a test for backend/site behaviour. Tests that need a real world
  must skip cleanly when the fixture is absent (see
  `packages/backend/tests/realData.test.ts`).
- `npm test`, `npm run typecheck` and (for the plugin) a Release build must pass.
- No personal data in code or docs: no real Steam ids, LAN addresses, hostnames
  or tokens. Use placeholders and environment variables.

## Commit style

Short imperative subject lines, e.g. `fix(landing): use the hull-bottom datum`.
Reference the failing behaviour in the body when it is not obvious.

## Licence

Contributions are accepted under the MIT licence in [LICENSE](LICENSE).
