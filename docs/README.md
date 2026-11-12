# Documentation

Start with the install guide, then the in-game setup. The rest is reference.

## Operator guides

| File | What it covers |
|---|---|
| [INSTALL.md](INSTALL.md) | Requirements, build, plugin install, backend, upgrade, uninstall |
| [CONFIGURATION.md](CONFIGURATION.md) | Every `RTS_*`, `VITE_*` and `HERMES_*` setting |
| [IN-GAME-SETUP.md](IN-GAME-SETUP.md) | Base antenna, role tags, first flight |
| [SAFETY.md](SAFETY.md) | What the build cannot do and what the backend refuses |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Plugin not loading, no connection, refusals |
| [VALIDATION.md](VALIDATION.md) | What has been tested and flown, and what has not |

## Design reference

These are working notes from building the system. They describe behaviour as
implemented, including the measured reasons behind thresholds, and they assume
the reader is comfortable with the code.

Where a document mentions a *test build*, `TestHarness.cs`, `TestApi.cs`,
`HERMES_TEST_BUILD` or `snap_dock`, it is describing the private development
build. That half is not in this repository: the published plugin has no admin
actions at all.

| File | Topic |
|---|---|
| [architecture.md](architecture.md) | Components, data flow, one-backend-one-world |
| [flight-guards.md](flight-guards.md) | Speed, clearance, ground and reserve guards |
| [ground-datum.md](ground-datum.md) | Which ground source is used and why |
| [ship-roles.md](ship-roles.md) | Roles, tags, ownership rules |
| [survival-mode.md](survival-mode.md) | How survival mode is enforced |
| [survival-loop.md](survival-loop.md) | Return, refuel, relaunch state machine |
| [simspeed.md](simspeed.md) | Sim-speed gating and its source |
| [planner-modes.md](planner-modes.md) | Relay chain, tiers, coverage, redundancy |
| [designer.md](designer.md) | Constellation designer and option comparison |
| [endurance.md](endurance.md) | Ascent, transit, reserve, hold model |
| [power-telemetry.md](power-telemetry.md) | Power/fuel telemetry and budgets |
| [provisioning.md](provisioning.md) | Auto-provisioning managed grids |
| [staging.md](staging.md) | Thrust staging |
| [station-mode.md](station-mode.md) | Parking a relay as a station |
| [move-to.md](move-to.md) | Single-ship move and player standoff |
| [passengers.md](passengers.md) | Pilot vs passenger rule |
| [naming.md](naming.md) | Auto-naming, laser links, sun direction |
| [flight-links.md](flight-links.md) | Links API and laser connect sequence |
| [network-state-fields.md](network-state-fields.md) | Fields the plugin can read |
| [plugin-loading.md](plugin-loading.md) | How the DLL loads, and the proven recipe |
| [reality-check.md](reality-check.md) | API assumptions checked against the assemblies |
| [CONTRACT-FEATURES.md](CONTRACT-FEATURES.md) | Links/coverage API contract |
