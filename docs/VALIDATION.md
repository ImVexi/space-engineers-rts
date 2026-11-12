# Validation

What has actually been run, as opposed to what is designed. Everything below was
re-measured on the tree that produced this release.

## Automated tests

```
npm ci && npm test
  Test Files  130 passed | 1 skipped (131)
  Tests       1352 passed | 3 skipped (1355)
```

- `packages/schemas` — protocol and mission schemas.
- `packages/backend` — reconciler, dispatcher, comms gate, roles, planner,
  executor, landing maths, survival loop, alerts, staging, power, detector.
- `packages/demo-site` — camera/context stack, picking, coverage mesh, panels.
- `scenarios`, `firmware` — ladder runner and PB size/lint rules.

Skipped by design (they need a real world):

| Test | Why it skips |
|---|---|
| `packages/backend/tests/realData.test.ts` (2) | Requires `RTS_SAVE_DIR` pointing at a world save and `RTS_DEFS_DIR` at a game `Content/Data` copy. Read-only when present. |
| `packages/backend/tests/detector.test.ts` (1) | One fixture-backed case that needs a real save. |

`npm run typecheck` (root) and `tsc --noEmit` in `packages/demo-site` are clean.
The plugin's offline control-law projects (`plugin/HermesRts.Plugin/tests/`:
`land-math`, `level-math`, `power-math`, `passenger-math`, `block-filter`,
`channel-routing`) are plain `net8.0` console programs and need no game DLLs.

## Builds

- `dotnet build -c Release` with `SE_DS_BIN` pointing at a
  `DedicatedServer64` folder: succeeds, 0 errors, 1 obsolete-API warning
  (`IMyLaserAntenna.IsOutsideLimits`).
- `npm run demo:build`: `tsc --noEmit` + vite build succeed.
- `deploy/build-plugin.sh` confirms no admin handler symbol is present in the
  release DLL.

## What was flown (private test server)

The system has been exercised in game on a dedicated server running
Space Engineers `01_210_014` under Wine, against player-owned grids:

- autopilot move/hold/stop, level flight, and the plugin's final-descent landing
  from a 150 m handover, including gear lock and touchdown reporting;
- the survival loop: low fuel → return → land → `NEEDS_REFUEL` →
  `READY_TO_RELAUNCH` → approved relaunch;
- provisioned relays and the coverage planner, measured on a whole EarthLike
  with a 50 km radio: cheapest placement 22–24 ships for 93–100 % coverage,
  max-reach 28 ships at 18.25 km for 98 %, all with terrain-corrected cells;
- sim-speed gating driven by the plugin's own `simRatio` sample (the Remote API is not
  used on that server).

Those runs are not reproducible from this repository alone — they need a world,
a save and player grids. The numbers above are reported as measurements, not as
benchmarks.

## Not validated

- Space Engineers builds other than `01_210_014`.
- Windows hosts (development ran under Linux + Wine).
- More than one game server per backend (one backend serves one world by design).
- Client mods that alter connector or antenna definitions.
