import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL,
    approval TEXT NOT NULL,
    idempotency_key TEXT,
    desired_json TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    spent_json TEXT NOT NULL DEFAULT '{}',
    losses INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    assigned_json TEXT NOT NULL DEFAULT '[]',
    plan_json TEXT NOT NULL DEFAULT '{"steps":[]}',
    pause_reason TEXT,
    blocked_by TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
  CREATE INDEX IF NOT EXISTS idx_missions_type ON missions(type);
  -- Idempotency applies while a mission is open. Once it is terminal the key
  -- is released so the reconciler can legitimately emit a follow-up mission.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_open_key
    ON missions(idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND status IN ('queued', 'planned', 'approved', 'executing', 'paused');

  CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    spec_id TEXT,
    station TEXT,
    link_status TEXT NOT NULL DEFAULT 'unknown',
    last_seen INTEGER NOT NULL,
    pos_json TEXT,
    vel_json TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS links (
    agent_id TEXT NOT NULL,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, a, b)
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    order_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_orders_mission_unit ON orders(mission_id, unit_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

  CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    rollback_point TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    mission_id TEXT,
    message TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS desired (
    id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    station TEXT NOT NULL,
    count INTEGER NOT NULL,
    formation TEXT NOT NULL DEFAULT 'none',
    budget_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flags (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ledger (
    site TEXT NOT NULL,
    item TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    in_transit REAL NOT NULL DEFAULT 0,
    as_of INTEGER NOT NULL,
    PRIMARY KEY (site, item)
  );
  `,
  `
  -- T5 demo execution: one row per mission (durable) and one per drone, so a
  -- backend restart resumes the same state machine instead of re-spawning.
  CREATE TABLE IF NOT EXISTS demo_exec (
    mission_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    scaled INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cap INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS demo_drones (
    mission_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    label TEXT NOT NULL,
    prefab TEXT NOT NULL,
    role TEXT,
    planet TEXT,
    plan_slot_json TEXT NOT NULL,
    exec_slot_json TEXT NOT NULL,
    spawn_json TEXT NOT NULL,
    state TEXT NOT NULL,
    grid_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    pending_order TEXT,
    pending_action TEXT,
    pending_at INTEGER,
    hold_at INTEGER,
    stop_sent_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (mission_id, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_demo_drones_state ON demo_drones(state);
  `,
  // 2: the securing step must not share the `reason` column - `reason` is the
  // human note, and setState() overwrites it with that note. A separate step
  // column keeps the ownership -> ownership_check -> wake -> ai_off -> move
  // chain moving after a restart instead of stalling in `securing`.
  `
  ALTER TABLE demo_drones ADD COLUMN step TEXT;
  `,
  // 3: bounded waiting for fresh link telemetry before a flight order.
  `
  ALTER TABLE demo_drones ADD COLUMN gate_waits INTEGER NOT NULL DEFAULT 0;
  `,
  // 4: hull selection is decided once at mission sync (surface vs orbital
  // spawn) and must survive a backend restart, so it is stored with the drone.
  `
  ALTER TABLE demo_drones ADD COLUMN spawn_mode TEXT;
  `,
  // 5: every grid the harness spawns is registered here so debris cleanup can
  // delete exactly what we created (never a player grid), by age or on mission
  // end. `deleted_at` makes cleanup idempotent across restarts.
  `
  CREATE TABLE IF NOT EXISTS demo_spawned (
    grid_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    name TEXT,
    spawned_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_demo_spawned_live ON demo_spawned(deleted_at, spawned_at);
  `,
  // 6: T10 admin override. A move/execute with ignoreReach on the test server
  // bypasses the range half of the comms gate and must survive a restart, so
  // the choice is stored per drone and every order carries the label.
  `
  ALTER TABLE demo_drones ADD COLUMN admin_override INTEGER NOT NULL DEFAULT 0;
  `,
  // 7: CONTRACT-FEATURES §4 satellite groups. Members are JSON array *strings*:
  // SE grid ids exceed 2^53, so they are never parsed as numbers. A grid may be
  // a member of several groups, so membership lives inside each group's JSON.
  `
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    members TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_groups_updated ON groups(updated_at);
  `,
  // 8: T50 fleet operations. One row owns a whole set of grids and the ordered
  // steps that move them. `members` stays a JSON array *of strings* (SE grid
  // ids exceed 2^53) and `steps` is a JSON array whose entries each carry their
  // own id/status, so a paused operation can resume at the first step that is
  // not terminal instead of replaying the whole sequence from the top.
  `
  CREATE TABLE IF NOT EXISTS fleet_operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    planet_id TEXT,
    members TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 1,
    coverage_before TEXT,
    coverage_after TEXT,
    invariants TEXT NOT NULL DEFAULT '{}',
    abort_policy TEXT NOT NULL DEFAULT 'hold',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_ops_status ON fleet_operations(status);
  CREATE INDEX IF NOT EXISTS idx_fleet_ops_updated ON fleet_operations(updated_at);
  `,
  // 9: T68 alerts engine. (Numbered 9 in this file's comment scheme; the
  // stored `schema_meta.version` becomes 10 because the comments have always
  // been one behind the migration count - fleet_operations already stored 9.)
  // Migration 1 created a minimal `alerts` table for the
  // old mission notices (`at`, `mission_id`, `acknowledged`). Those writers
  // (missions.ts, executor.ts, staging) are still live and `/api/state` reads
  // them, so the old table is kept under `alerts_legacy` and the T68 engine
  // owns `alerts`. `subject_id` is TEXT because SE grid ids exceed 2^53; the
  // CHECK constraints make an invalid state/severity a database error rather
  // than a silently unstyled row.
  `
  ALTER TABLE alerts RENAME TO alerts_legacy;

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('grid', 'planet', 'system')),
    subject_id TEXT NOT NULL,
    message TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    actions TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('open', 'acked', 'resolved')),
    count INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    acked_by TEXT,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(state, kind, subject_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_subject ON alerts(subject_type, subject_id);
  `,
  // 10: landing mode (owner request 2026-11-10). A drone may be told to LAND at
  // its slot: the intent (and its flare height) is stored as JSON so a backend
  // restart resumes the landing instead of turning it into a hover.
  `
  ALTER TABLE demo_drones ADD COLUMN landing_json TEXT;
  `,
  // T61: last-known player position per identity. Every id is TEXT: SE
  // identity ids are ~1.4e17 and Steam ids are ~7.6e16, both past 2^53, so a
  // number column would corrupt them. `online` is 1 only for the run that
  // reported the character; a player who logs off or dies keeps the row with
  // online = 0 and `last_seen_at` = the timestamp of their last sample, which
  // is what the API reports as the age.
  `
  CREATE TABLE IF NOT EXISTS players (
    identity_id TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    character_entity_id TEXT,
    pos_json TEXT,
    vel_json TEXT,
    grid_id TEXT,
    seat_name TEXT,
    piloting INTEGER NOT NULL DEFAULT 0,
    planet TEXT,
    agl_m REAL,
    altitude_m REAL,
    gravity_mps2 REAL,
    on_foot INTEGER NOT NULL DEFAULT 1,
    is_dead INTEGER NOT NULL DEFAULT 0,
    faction_tag TEXT,
    faction_id TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_online_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_players_online ON players(online, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_players_faction ON players(faction_tag);
  CREATE INDEX IF NOT EXISTS idx_players_steam ON players(steam_id);
  `,
  // 11: routine audit channel (measured 2026-11-10 during a landing).
  // Routine poller traffic (`radio_links` / `laser_state` / `list_tagged` /
  // `profile` orders and their results and acks) was ~90 % of the `audit`
  // table: 2 000 rows covered ~4 minutes, so a landing's evidence was gone
  // before the run ended. Those rows now carry routine = 1, are excluded from
  // the default reads (and from /api/audit) and are pruned after an hour. The
  // table stays one table so the order-result lookups keep working.
  `
  ALTER TABLE audit ADD COLUMN routine INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_audit_routine_at ON audit(routine, at);
  `,
];

export interface OpenDbOptions {
  /** Skip WAL for throwaway in-memory databases. */
  memory?: boolean;
}

export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!opts.memory) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const hasTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`)
    .get() as { name: string } | undefined;
  const row = hasTable
    ? (db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string } | undefined)
    : undefined;
  const current = row ? Number(row.value) : 0;
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v + 1));
    }
  })();
}
