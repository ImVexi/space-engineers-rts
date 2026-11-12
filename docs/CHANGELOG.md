# Changelog

Operator-facing changes, newest first. The plugin version is the DLL's own
version string; a release tag names the plugin build, so backend-only changes do
not mint a new release.

## Unreleased

### Roles and naming

- **Short tags are equal to long ones.** `[BASE]`, `[MANAGED]`, `[PERSONAL]`,
  `[OFF]` are read by the same resolver (`resolveGridRole()`) as the
  `[HERMES-*]` spellings, on any block or in CustomData, and the provisioner,
  capability snapshot, network builder, comms gate and naming service all ask
  that resolver. A grid tagged `[BASE]` on a cargo container is a control source
  exactly like one tagged `[HERMES-BASE]` on a programmable block.
- **Naming keeps your tag form.** The PB prefix reproduces the spelling the
  owner typed (`[BASE]` stays `[BASE]`), a grid marked only in CustomData gets no
  name tag, and auto-rename is **off by default on a live instance**
  (`RTS_NAMING_AUTO=1` re-enables it; the test instance keeps it on).

### Audit

- **Routine rows are no longer stored.** Raw `plugin_event` action results,
  alert re-deliveries and `ack_unknown` for fire-and-forget ids are counted
  (`/api/health` → `routineAudit`) instead of written; the audit now records a
  material event per change, and the survival loop writes a row on a state
  change rather than on every evaluation.
- **Retention with an archive.** Rows older than `RTS_AUDIT_RETENTION_DAYS`
  (default 7) are streamed to `<data>/archive/audit-<from>-<to>.csv.gz` and then
  deleted in batches. `RTS_AUDIT_RETENTION=off` or `_DAYS=0` disables it.
- **Alert hysteresis.** A `stranded` / return-home alert no longer flaps between
  states: it is held for a settling window, resolves only for the kinds the loop
  owns, and clears once instead of re-raising per pass.

### Survival loop

- A ship that cannot reach any home point with the fuel and charge aboard is
  reported `STRANDED` and is **not launched**.
- Home points can be a base grid, a map point or a GPS string; a per-ship
  override is cleared with an explicit `null`, and a bad point is a plain 400
  rather than a silently substituted base.
- Return and relaunch legs fly as `survival:` missions through the executor, so
  every role, comms, flight and landing guard applies. A relaunch from a ground
  slot is flown as a landing profile, not an air hold.

### Plugin

- Order results are read from the order-result bus instead of being scraped, and
  routine action results are no longer stored on the backend.
- The plugin frame carries `simRatio`; the backend ingests it and picks the
  freshest source (plugin telemetry first, then the optional Remote API file), so
  no Remote API is needed on a live server.

### Install and operations

- **Plugin path corrected.** The plugin lives in a `hermes` folder at the
  **server root** — `<server root>\hermes\HermesRts.Plugin.dll`, i.e.
  `Z:\home\container\hermes\` on a Pelican/Wine volume — not under `config\` or
  `DedicatedServer64\plugins\`.
- A live instance is documented as its own install (own port, token, data
  directory and `serverId`), and the docs warn that a second Space Engineers
  server on the same VM halves the live sim speed.
- New **Sharing the panel with a crew** section: never expose the backend raw;
  put an authenticating proxy or Cloudflare Access in front, inject the token
  server-side, block `/plugin` and `/api/test/*` publicly, keep the plugin socket
  LAN-only.
- Tests remove the temp directories they create (`se-rts-test-*`), and a global
  sweep clears leftovers older than 12 h.

## 0.4.0 — 2026-11-11

- First public release: survival-only plugin build, TypeScript backend and web
  map, JSON schemas, reference PB firmware.
- Live-instance mode: `RTS_ENV=live` + `RTS_DEMO_SURVIVAL=1` boot, untagged grids
  default to `OFF`, and a non-`OFF` role requires the grid to be owned by a Steam
  id in `RTS_OWNER_STEAM_IDS` (or the owner's faction).
- Survival loop, landing controller, coverage planner, sim-speed gating and the
  documentation site.
