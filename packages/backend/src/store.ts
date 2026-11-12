import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import {
  MissionSchema,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  type Mission,
  type MissionBudget,
  type MissionStatus,
  type MissionType,
  type PluginLink,
  type Vec3,
} from '@se-rts/schemas';

export interface UnitRecord {
  id: string;
  name: string;
  specId: string | null;
  station: string | null;
  linkStatus: 'up' | 'down' | 'unknown';
  lastSeen: number;
  pos: Vec3 | null;
  vel: Vec3 | null;
  meta: Record<string, unknown>;
}

export interface LinkRecord {
  agentId: string;
  a: string;
  b: string;
  status: 'up' | 'down';
  at: number;
}

export type OrderStatus = 'pending' | 'sent' | 'acked' | 'failed';

export interface OrderRecord {
  orderId: string;
  missionId: string;
  unitId: string;
  orderType: string;
  payload: Record<string, unknown>;
  status: OrderStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  ackedAt: number | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
  rollbackPoint: string | null;
}

export interface AlertRecord {
  id: string;
  at: number;
  kind: string;
  missionId: string | null;
  message: string;
  acknowledged: boolean;
}

/**
 * T68 alerts engine. These are the durable, deduplicated alerts the owner
 * sees; the older mission notices above stay in `alerts_legacy` because
 * missions/executor/staging still write them and `/api/state` reads them.
 */
export type AlertSeverity = 'info' | 'warn' | 'critical';
export type AlertSubjectType = 'grid' | 'planet' | 'system';
export type AlertState = 'open' | 'acked' | 'resolved';

/** One recommended action. `endpoint` is a real API path (never invented). */
export interface AlertAction {
  label: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
}

export interface Alert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  subjectType: AlertSubjectType;
  subjectId: string;
  message: string;
  evidence: Record<string, unknown>;
  actions: AlertAction[];
  state: AlertState;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  ackedBy: string | null;
  resolvedAt: number | null;
}

export interface AlertInput {
  id?: string;
  kind: string;
  severity: AlertSeverity;
  subjectType: AlertSubjectType;
  subjectId: string;
  message: string;
  evidence?: Record<string, unknown>;
  actions?: AlertAction[];
  count?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
}

export interface AlertFilter {
  state?: AlertState | AlertState[];
  severity?: AlertSeverity | AlertSeverity[];
  kind?: string;
  subjectType?: AlertSubjectType;
  subjectId?: string;
  limit?: number;
}

export interface DesiredRecord {
  id: string;
  spec: string;
  station: string;
  count: number;
  formation: string;
  budget: MissionBudget | null;
  enabled: boolean;
  createdAt: number;
}

/**
 * CONTRACT-FEATURES §4: a named, coloured set of grid ids. Membership is a
 * JSON array of strings on purpose - SE grid ids exceed 2^53, so they must
 * never round-trip through a JS number. One grid may appear in several groups.
 */
export interface GroupRecord {
  id: string;
  name: string;
  color: string | null;
  members: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GroupInput {
  id: string;
  name: string;
  color?: string | null;
  members: string[];
  createdAt?: number;
  updatedAt?: number;
}

/**
 * T50 fleet operations: one record owns a whole group of grids and the ordered
 * steps that move them. Grid ids are strings throughout (SE ids exceed 2^53).
 */
export type FleetOpKind = 'swap' | 'recall' | 'reshape' | 'relocate' | 'scuttle';
export type FleetOpStatus = 'planned' | 'approved' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type FleetAbortPolicy = 'hold' | 'return' | 'continue';
export type FleetStepAction = 'unstation' | 'move' | 'land' | 'dock' | 'flag' | 'abort';
export type FleetStepStatus = 'pending' | 'dispatched' | 'done' | 'skipped' | 'failed';
export type FleetInvariantName =
  | 'commandable'
  | 'last_path'
  | 'manual'
  | 'fuel'
  | 'separation'
  | 'coverage_loss'
  | 'nested_operation'
  | 'confirm_required'
  | 'scuttle_execution'
  /** The executor's own guard ended the flight (not a fleet-level refusal). */
  | 'executor_abort'
  /** The executor mission failed or its drone was deferred/skipped. */
  | 'executor_failed';

/** Where a step's executor mission stands (T50: steps are executor missions). */
export interface FleetStepExecution {
  /** Executor mission flying this step, null until dispatched. */
  missionId: string | null;
  /** Executor flights observed on the grid before this step's mission existed. */
  baselineOrders: number;
  dispatchedAt: number | null;
  /** Set while an abort is resolving this step through the executor. */
  aborting?: FleetAbortPolicy;
  /** Abort `hold`: the mission whose `holding` state parks the grid. */
  holdMissionId?: string;
  /** The executor state that completed/failed the step (never telemetry distance). */
  verified?: { state: string; reason: string | null; at: number };
}

export interface FleetVec3 {
  x: number;
  y: number;
  z: number;
}

/** One addressable step. `id` is stable for the life of the operation. */
export interface FleetStep {
  id: string;
  /** Higher wave = later. Every member in a wave moves together. */
  wave: number;
  memberId: string;
  action: FleetStepAction;
  target: FleetVec3 | null;
  status: FleetStepStatus;
  reason?: string;
  orderId?: string;
  dispatchedAt?: number;
  completedAt?: number;
  /** NEEDS_REFUEL / NEEDS_REPAIR for a `flag` step. */
  flags?: string[];
  /** T50: the executor mission that flies this step and how it ended. */
  execution?: FleetStepExecution;
}

export interface FleetMemberPlan {
  gridId: string;
  home: FleetVec3 | null;
  verdict: 'ok' | 'skipped';
  reason?: string;
  /** Comms gate verdict recorded at plan time. */
  gate?: { allowed: boolean; reason: string; source: string };
  isStatic?: boolean;
  fuelFraction?: number | null;
  powerFraction?: number | null;
  health?: number | null;
  /** Total distance the member's steps will fly, metres. */
  distanceM?: number;
}

export interface FleetInvariantFailure {
  invariant: FleetInvariantName;
  memberId?: string;
  reason: string;
  /**
   * `hard` refuses the plan/wave outright; `member` skips just that grid and
   * is reported (the rest of the operation still runs).
   */
  severity?: 'hard' | 'member';
}

export interface FleetAbortState {
  gridId: string;
  policy: FleetAbortPolicy;
  /** What was actually done: `hold` sends stop, `return` flies home, `continue` keeps flying. */
  action: FleetAbortPolicy;
  orderId?: string;
  reason: string;
}

export interface FleetInvariants {
  ok: boolean;
  checkedAt: number;
  members: FleetMemberPlan[];
  failures: FleetInvariantFailure[];
  notes: string[];
  /** Separation floor the plan was built with, metres. */
  minSeparationM?: number;
  /** Cells that stop being covered once this plan has run. */
  coverageLoss?: { cells: { latDeg: number; lonDeg: number }[]; count: number; accepted: boolean };
  /** Per-member result of a cancel/abort, set by the policy. */
  abort?: FleetAbortState[];
}

/** Terrain-labelled coverage summary; cells are capped by the producer. */
export interface FleetCoverage {
  planet: string;
  cellDeg: number;
  k: 1 | 2;
  radioRangeM: number;
  coveragePct: number;
  coveredCells: number;
  totalCells: number;
  terrain: 'corrected' | 'unavailable' | 'none' | 'skipped';
  terrainReason: string | null;
  uncoveredCells: { latDeg: number; lonDeg: number }[];
  nodeIds: string[];
}

export interface FleetOperation {
  id: string;
  kind: FleetOpKind;
  planetId: string | null;
  members: string[];
  steps: FleetStep[];
  status: FleetOpStatus;
  dryRun: boolean;
  coverageBefore: FleetCoverage | null;
  coverageAfter: FleetCoverage | null;
  invariants: FleetInvariants;
  abortPolicy: FleetAbortPolicy;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  lastError: string | null;
  /** Ship roles: the owner explicitly selected and confirmed a PERSONAL ship. */
  confirmedPersonal?: boolean;
}

export interface MissionFilter {
  status?: MissionStatus[];
  type?: MissionType[];
  limit?: number;
}

interface MissionRow {
  id: string;
  type: string;
  priority: number;
  status: string;
  approval: string;
  idempotency_key: string | null;
  desired_json: string;
  budget_json: string;
  spent_json: string;
  losses: number;
  attempts: number;
  assigned_json: string;
  plan_json: string;
  pause_reason: string | null;
  blocked_by: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface UnitRow {
  id: string;
  name: string;
  spec_id: string | null;
  station: string | null;
  link_status: string;
  last_seen: number;
  pos_json: string | null;
  vel_json: string | null;
  meta_json: string;
}

function rowToMission(row: MissionRow): Mission {
  return MissionSchema.parse({
    schemaVersion: 1,
    id: row.id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    approval: row.approval,
    idempotencyKey: row.idempotency_key ?? undefined,
    desiredState: JSON.parse(row.desired_json),
    budget: JSON.parse(row.budget_json),
    assignedUnits: JSON.parse(row.assigned_json),
    plan: JSON.parse(row.plan_json),
    pauseReason: row.pause_reason ?? undefined,
    blockedBy: row.blocked_by ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

const BUILD_TYPES: MissionType[] = ['build_deploy', 'replace'];
const PRIORITY_TYPES: MissionType[] = ['repair', 'replace'];

export class Store {
  constructor(
    public readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  close(): void {
    this.db.close();
  }

  now(): number {
    return this.clock();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- kv/flags

  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  }

  isKillSwitchOn(): boolean {
    return this.getKv('kill_switch') === '1';
  }

  setKillSwitch(on: boolean, actor = 'operator'): boolean {
    const previous = this.isKillSwitchOn();
    this.setKv('kill_switch', on ? '1' : '0');
    this.audit({
      actor,
      action: on ? 'kill_switch_on' : 'kill_switch_off',
      subject: 'global',
      detail: { previous },
      rollbackPoint: on ? 'kv:kill_switch=0' : 'kv:kill_switch=1',
    });
    return previous;
  }

  /** Creates missing flag rows; existing (operator-set) values are kept. */
  ensureFlags(names: readonly string[], initial: Record<string, boolean> = {}): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO flags (name, enabled) VALUES (?, ?)');
    this.tx(() => {
      for (const name of names) stmt.run(name, initial[name] ? 1 : 0);
    });
  }

  getFlags(): Record<string, boolean> {
    const rows = this.db.prepare('SELECT name, enabled FROM flags').all() as {
      name: string;
      enabled: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.enabled === 1]));
  }

  setFlag(name: string, enabled: boolean, actor = 'operator'): void {
    this.db
      .prepare('INSERT INTO flags (name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled')
      .run(name, enabled ? 1 : 0);
    this.audit({
      actor,
      action: 'flag_set',
      subject: `flag:${name}`,
      detail: { enabled },
      rollbackPoint: `flag:${name}=${enabled ? 0 : 1}`,
    });
  }

  // ------------------------------------------------------------------- audit

  /**
   * Routine poller traffic (`radio_links`, `laser_state`, `list_tagged`,
   * `profile` orders and their results) is NOT stored in `audit` at all.
   *
   * Storing it, even on a `routine = 1` channel, kept the table at ~90 k
   * rows/day: the rows were excluded from reads but still written, still
   * carried the full 8–12 KB result body, and still had to be pruned. The
   * order-result bus (`orderResults.ts`) already delivers every result in
   * memory on the tick it arrives, so the only reason to keep a row — an
   * order-result lookup — no longer needs one. What survives is a counter and
   * a rate-limited log line, which is what an operator actually reads.
   */
  static readonly ROUTINE_AUDIT_TTL_MS = 60 * 60 * 1000;
  /** One summary line per interval, never one line per routine row. */
  static readonly ROUTINE_LOG_INTERVAL_MS = 60_000;

  private readonly routineCounts = new Map<string, number>();
  private routineTotal = 0;
  private routineSince = 0;
  private routineLastAt = 0;
  private lastRoutineLogAt = 0;
  private routineLogger: ((message: string) => void) | null = null;

  /** Route the rate-limited routine summary somewhere (default: console). */
  setRoutineLogger(logger: ((message: string) => void) | null): void {
    this.routineLogger = logger;
  }

  /**
   * Routine traffic counters, for `/api/health`. These are the only trace a
   * routine row leaves: how many, of what kind, since when, newest one.
   */
  routineStats(): { total: number; since: number | null; lastAt: number | null; byAction: Record<string, number> } {
    const byAction: Record<string, number> = {};
    for (const [action, n] of [...this.routineCounts].sort((a, b) => b[1] - a[1])) byAction[action] = n;
    return {
      total: this.routineTotal,
      since: this.routineTotal === 0 ? null : this.routineSince,
      lastAt: this.routineTotal === 0 ? null : this.routineLastAt,
      byAction,
    };
  }

  /** Count one routine event; drop it, log a summary at most once a minute. */
  private noteRoutine(action: string, at: number): void {
    if (this.routineTotal === 0) this.routineSince = at;
    this.routineTotal += 1;
    this.routineLastAt = at;
    this.routineCounts.set(action, (this.routineCounts.get(action) ?? 0) + 1);
    if (at - this.lastRoutineLogAt < Store.ROUTINE_LOG_INTERVAL_MS) return;
    this.lastRoutineLogAt = at;
    const summary = Object.entries(this.routineStats().byAction)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const line = `[routine] ${this.routineTotal} routine events not audited (${summary})`;
    (this.routineLogger ?? ((m: string) => console.log(m)))(line);
  }

  audit(input: {
    actor?: string;
    action: string;
    subject: string;
    detail?: Record<string, unknown>;
    rollbackPoint?: string | null;
    at?: number;
    /**
     * Routine poller traffic: counted and dropped, never written. The body is
     * not even serialised. Never use it for a state change or an error.
     */
    routine?: boolean;
  }): string {
    const id = `aud-${randomUUID()}`;
    const at = input.at ?? this.now();
    if (input.routine === true) {
      this.noteRoutine(input.action, at);
      return id;
    }
    this.db
      .prepare(
        'INSERT INTO audit (id, at, actor, action, subject, detail, rollback_point, routine) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(
        id,
        at,
        input.actor ?? 'system',
        input.action,
        input.subject,
        JSON.stringify(input.detail ?? {}),
        input.rollbackPoint ?? null,
      );
    return id;
  }

  /**
   * Drop leftover `routine = 1` rows written before routine traffic stopped
   * being stored (the column stays for the old rows and the CSV export).
   * Called by the retention pass, not by every audit write.
   */
  pruneRoutineAudit(now = this.now()): number {
    const info = this.db
      .prepare('DELETE FROM audit WHERE routine = 1 AND at < ?')
      .run(now - Store.ROUTINE_AUDIT_TTL_MS);
    return Number(info.changes);
  }

  /**
   * Audit rows, newest first. Routine poller traffic is EXCLUDED unless asked
   * for, so `/api/audit` and every internal scan see a window measured in hours
   * instead of minutes (measured 2026-11-10: 2 000 rows = 4 minutes, and the
   * landing evidence was gone).
   */
  listAudit(limit = 200, opts: { includeRoutine?: boolean } = {}): AuditEntry[] {
    const rows = this.db
      .prepare(
        opts.includeRoutine
          ? 'SELECT * FROM audit ORDER BY at DESC, rowid DESC LIMIT ?'
          : 'SELECT * FROM audit WHERE routine = 0 ORDER BY at DESC, rowid DESC LIMIT ?',
      )
      .all(limit) as {
      id: string;
      at: number;
      actor: string;
      action: string;
      subject: string;
      detail: string;
      rollback_point: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
      rollbackPoint: r.rollback_point,
    }));
  }

  /**
   * One order's result from the audit table, if it was written there.
   *
   * Only the CONTROL channel (`ord:` mission orders) and `order_error` rows
   * are stored now; routine poller results live in the in-memory bus, so this
   * is the durable half of `lookupOrderResult()` (orderResults.ts) and the
   * only half that survives a restart. Bounded by `since`: an order's result
   * is never older than its timeout.
   */
  findOrderResult(orderId: string, since = 0): AuditEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM audit
           WHERE action = 'plugin_event' AND at >= ?
             AND detail LIKE '%"orderId":"' || ? || '"%'
           ORDER BY rowid DESC LIMIT 1`,
      )
      .get(since, orderId) as
      | {
          id: string;
          at: number;
          actor: string;
          action: string;
          subject: string;
          detail: string;
          rollback_point: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
      rollbackPoint: row.rollback_point,
    };
  }

  /**
   * `plugin_event/order_result` rows from the business channel only, newest
   * first. Kept for the debug/count paths; the waiters use the order-result
   * bus and `findOrderResult()` instead of scanning a window.
   */
  listOrderResults(limit = 400): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit
           WHERE action = 'plugin_event' AND detail LIKE '%"eventType":"order_result"%'
           ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      at: number;
      actor: string;
      action: string;
      subject: string;
      detail: string;
      rollback_point: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
      rollbackPoint: r.rollback_point,
    }));
  }

  /**
   * Cheap cursor read for order-result waiters (sim-speed audit #7): only rows
   * that arrived after `afterRowid`, oldest first. The 100 ms rescan of the
   * newest 500 rows is what starved the flight tick; this reads new rows only.
   */
  listOrderResultsAfter(afterRowid: number, limit = 100): { rowid: number; entry: AuditEntry }[] {
    const rows = this.db
      .prepare(
        `SELECT rowid AS rid, * FROM audit
           WHERE rowid > ? AND action = 'plugin_event'
             AND detail LIKE '%"eventType":"order_result"%'
           ORDER BY rowid ASC LIMIT ?`,
      )
      .all(afterRowid, limit) as {
      rid: number;
      id: string;
      at: number;
      actor: string;
      action: string;
      subject: string;
      detail: string;
      rollback_point: string | null;
    }[];
    return rows.map((r) => ({
      rowid: r.rid,
      entry: {
        id: r.id,
        at: r.at,
        actor: r.actor,
        action: r.action,
        subject: r.subject,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
        rollbackPoint: r.rollback_point,
      },
    }));
  }

  /** Highest audit rowid now (O(1), rowid index). */
  maxAuditRowid(): number {
    const row = this.db.prepare('SELECT IFNULL(MAX(rowid), 0) AS n FROM audit').get() as { n: number };
    return row.n;
  }

  countAudit(action: string, subject?: string): number {
    const row = subject
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ? AND subject = ?').get(action, subject) as {
          n: number;
        })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action) as { n: number });
    return row.n;
  }

  /**
   * Audit rows older than `cutoff` for the retention job (2026-11-11).
   *
   * Keyset paging on `(at, rowid)`, not OFFSET: the table is being written by
   * the running backend, and an OFFSET page would skip rows when a delete (or
   * the routine prune) lands between two pages. `after` is the previous page's
   * last `(at, rowid)`.
   */
  auditBefore(
    cutoff: number,
    limit: number,
    after: { at: number; rowid: number } | null = null,
  ): (AuditEntry & { rowid: number; routine: boolean })[] {
    const sql = `SELECT rowid AS rid, * FROM audit
       WHERE at < ?
         AND (at > ? OR (at = ? AND rowid > ?))
       ORDER BY at ASC, rowid ASC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(
        cutoff,
        after?.at ?? Number.MIN_SAFE_INTEGER,
        after?.at ?? Number.MIN_SAFE_INTEGER,
        after?.rowid ?? 0,
        limit,
      ) as {
      rid: number;
      id: string;
      at: number;
      actor: string;
      action: string;
      subject: string;
      detail: string;
      rollback_point: string | null;
      routine: number;
    }[];
    return rows.map((r) => ({
      rowid: r.rid,
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
      rollbackPoint: r.rollback_point,
      routine: r.routine === 1,
    }));
  }

  /** Oldest/newest `at` and the row count below `cutoff` (one indexed scan). */
  auditRangeBefore(cutoff: number): { count: number; oldest: number | null; newest: number | null } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, MIN(at) AS lo, MAX(at) AS hi FROM audit WHERE at < ?')
      .get(cutoff) as { n: number; lo: number | null; hi: number | null };
    return { count: row.n, oldest: row.lo, newest: row.hi };
  }

  /**
   * Delete audit rows by id, in small batches: one statement per batch keeps
   * the write lock (and the WAL) short on a table the backend is using.
   */
  deleteAuditIds(ids: string[], batchSize = 500): number {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const slice = ids.slice(i, i + batchSize);
      const marks = slice.map(() => '?').join(',');
      const info = this.db.prepare(`DELETE FROM audit WHERE id IN (${marks})`).run(...slice);
      deleted += Number(info.changes);
    }
    return deleted;
  }

  // ------------------------------------------- alerts (legacy mission notices)
  // Migration 9 moved these rows to `alerts_legacy` and gave `alerts` to the
  // T68 engine. The writers below (missions, executor, staging) are unchanged.

  addAlert(input: { kind: string; message: string; missionId?: string | null; at?: number }): string {
    const id = `alert-${randomUUID()}`;
    this.db
      .prepare('INSERT INTO alerts_legacy (id, at, kind, mission_id, message, acknowledged) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, input.at ?? this.now(), input.kind, input.missionId ?? null, input.message);
    return id;
  }

  listAlerts(unacknowledgedOnly = false): AlertRecord[] {
    const sql = `SELECT * FROM alerts_legacy ${unacknowledgedOnly ? 'WHERE acknowledged = 0' : ''} ORDER BY at DESC, rowid DESC`;
    const rows = this.db.prepare(sql).all() as {
      id: string;
      at: number;
      kind: string;
      mission_id: string | null;
      message: string;
      acknowledged: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      missionId: r.mission_id,
      message: r.message,
      acknowledged: r.acknowledged === 1,
    }));
  }

  acknowledgeAlert(id: string): boolean {
    return this.db.prepare('UPDATE alerts_legacy SET acknowledged = 1 WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------- T68 alerts repository

  createAlert(input: AlertInput): Alert {
    const id = input.id ?? `alert-${randomUUID()}`;
    const at = input.firstSeenAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO alerts
         (id, kind, severity, subject_type, subject_id, message, evidence, actions, state,
          count, first_seen_at, last_seen_at, acked_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        input.kind,
        input.severity,
        input.subjectType,
        input.subjectId,
        input.message,
        JSON.stringify(input.evidence ?? {}),
        JSON.stringify(input.actions ?? []),
        input.count ?? 1,
        at,
        input.lastSeenAt ?? at,
      );
    return this.getAlert(id)!;
  }

  getAlert(id: string): Alert | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
    return row ? mapAlert(row) : null;
  }

  /**
   * The active alert for one kind+subject, if any. `acked` still counts as
   * active: acking is an acknowledgement, not a fix, so a recurrence updates
   * the same row instead of opening a duplicate.
   */
  findActiveAlert(kind: string, subjectId: string): Alert | null {
    const row = this.db
      .prepare(
        `SELECT * FROM alerts
         WHERE kind = ? AND subject_id = ? AND state IN ('open', 'acked')
         ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
      )
      .get(kind, subjectId) as AlertRow | undefined;
    return row ? mapAlert(row) : null;
  }

  updateAlert(
    id: string,
    patch: Partial<Pick<Alert, 'message' | 'evidence' | 'actions' | 'severity' | 'count' | 'lastSeenAt'>>,
  ): Alert | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.message !== undefined) {
      sets.push('message = ?');
      values.push(patch.message);
    }
    if (patch.evidence !== undefined) {
      sets.push('evidence = ?');
      values.push(JSON.stringify(patch.evidence));
    }
    if (patch.actions !== undefined) {
      sets.push('actions = ?');
      values.push(JSON.stringify(patch.actions));
    }
    if (patch.severity !== undefined) {
      sets.push('severity = ?');
      values.push(patch.severity);
    }
    if (patch.count !== undefined) {
      sets.push('count = ?');
      values.push(patch.count);
    }
    if (patch.lastSeenAt !== undefined) {
      sets.push('last_seen_at = ?');
      values.push(patch.lastSeenAt);
    }
    if (sets.length === 0) return this.getAlert(id);
    values.push(id);
    this.db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getAlert(id);
  }

  listAlertRecords(filter: AlertFilter = {}): Alert[] {
    const where: string[] = [];
    const values: unknown[] = [];
    const states = filter.state === undefined ? null : Array.isArray(filter.state) ? filter.state : [filter.state];
    if (states?.length) {
      where.push(`state IN (${states.map(() => '?').join(', ')})`);
      values.push(...states);
    }
    const severities =
      filter.severity === undefined ? null : Array.isArray(filter.severity) ? filter.severity : [filter.severity];
    if (severities?.length) {
      where.push(`severity IN (${severities.map(() => '?').join(', ')})`);
      values.push(...severities);
    }
    if (filter.kind) {
      where.push('kind = ?');
      values.push(filter.kind);
    }
    if (filter.subjectType) {
      where.push('subject_type = ?');
      values.push(filter.subjectType);
    }
    if (filter.subjectId) {
      where.push('subject_id = ?');
      values.push(filter.subjectId);
    }
    const limit = Math.max(1, Math.min(1000, Math.round(filter.limit ?? 100)));
    values.push(limit);
    const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_seen_at DESC, rowid DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values) as AlertRow[];
    return rows.map(mapAlert);
  }

  /** Mark one alert read by a human. Idempotent; never touches a resolved row. */
  ackAlert(id: string, by: string, at = this.now()): Alert | null {
    const changes = this.db
      .prepare(`UPDATE alerts SET state = 'acked', acked_by = ? WHERE id = ? AND state = 'open'`)
      .run(by, id).changes;
    if (changes === 0) return this.getAlert(id);
    return this.getAlert(id);
  }

  /** Terminal for an alert. Idempotent. */
  resolveAlert(id: string, at = this.now()): Alert | null {
    this.db
      .prepare(`UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ? AND state != 'resolved'`)
      .run(at, id);
    return this.getAlert(id);
  }

  countActiveAlerts(): { open: number; acked: number; critical: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN state = 'acked' THEN 1 ELSE 0 END) AS acked,
           SUM(CASE WHEN state IN ('open','acked') AND severity = 'critical' THEN 1 ELSE 0 END) AS critical
         FROM alerts`,
      )
      .get() as { open: number | null; acked: number | null; critical: number | null };
    return { open: row.open ?? 0, acked: row.acked ?? 0, critical: row.critical ?? 0 };
  }

  // ---------------------------------------------------------------- missions

  /** Idempotent insert. Returns the existing mission when the key already exists. */
  createMission(mission: Mission): { created: boolean; mission: Mission } {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO missions
         (id, type, priority, status, approval, idempotency_key, desired_json, budget_json,
          spent_json, losses, attempts, assigned_json, plan_json, pause_reason, blocked_by,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mission.id,
        mission.type,
        mission.priority,
        mission.status,
        mission.approval,
        mission.idempotencyKey ?? null,
        JSON.stringify(mission.desiredState),
        JSON.stringify(mission.budget),
        JSON.stringify(mission.assignedUnits),
        JSON.stringify(mission.plan),
        mission.pauseReason ?? null,
        mission.blockedBy ?? null,
        mission.createdBy,
        mission.createdAt,
        mission.updatedAt,
      );
    if (info.changes === 0 && mission.idempotencyKey) {
      const existing = this.openMissionByIdempotencyKey(mission.idempotencyKey);
      if (existing) return { created: false, mission: existing };
    }
    return { created: info.changes > 0, mission: this.getMission(mission.id)! };
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined;
    return row ? rowToMission(row) : null;
  }

  openMissionByIdempotencyKey(key: string): Mission | null {
    const row = this.db
      .prepare(
        `SELECT * FROM missions WHERE idempotency_key = ? AND status IN (${placeholders(OPEN_STATUSES)})`,
      )
      .get(key, ...OPEN_STATUSES) as MissionRow | undefined;
    return row ? rowToMission(row) : null;
  }

  listMissions(filter: MissionFilter = {}): Mission[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${placeholders(filter.status)})`);
      params.push(...filter.status);
    }
    if (filter.type?.length) {
      where.push(`type IN (${placeholders(filter.type)})`);
      params.push(...filter.type);
    }
    const sql = `SELECT * FROM missions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority DESC, created_at ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, filter.limit ?? 500) as MissionRow[];
    return rows.map(rowToMission);
  }

  /**
   * Mission ids with a live (non-terminal) demo drone on `gridId`. Used by the
   * supersede rule: a new move/execute for a grid cancels any older active
   * mission on the same grid.
   */
  activeDemoDroneMissionsForGrid(gridId: string, exceptMissionId?: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT mission_id FROM demo_drones
         WHERE grid_id = ? AND mission_id != ?
           AND state NOT IN ('holding','stopped','failed','aborted','skipped','deferred')`,
      )
      .all(gridId, exceptMissionId ?? '') as { mission_id: string }[];
    return rows.map((r) => r.mission_id);
  }

  updateMission(
    id: string,
    patch: Partial<
      Pick<
        Mission,
        | 'status'
        | 'approval'
        | 'priority'
        | 'assignedUnits'
        | 'plan'
        | 'pauseReason'
        | 'blockedBy'
        | 'budget'
        | 'desiredState'
      >
    > & { spent?: Record<string, number>; losses?: number; attempts?: number },
    at = this.now(),
  ): Mission | null {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [at];
    const add = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.approval !== undefined) add('approval', patch.approval);
    if (patch.priority !== undefined) add('priority', patch.priority);
    if (patch.assignedUnits !== undefined) add('assigned_json', JSON.stringify(patch.assignedUnits));
    if (patch.plan !== undefined) add('plan_json', JSON.stringify(patch.plan));
    // The executor writes come-to-me progress (phase/readyAt) back into the
    // desired state, because that is the one place the schema keeps.
    if (patch.desiredState !== undefined) add('desired_json', JSON.stringify(patch.desiredState));
    // `undefined` clears these nullable columns (used to release a repair hold).
    if ('pauseReason' in patch) add('pause_reason', patch.pauseReason ?? null);
    if ('blockedBy' in patch) add('blocked_by', patch.blockedBy ?? null);
    if (patch.budget !== undefined) add('budget_json', JSON.stringify(patch.budget));
    if (patch.spent !== undefined) add('spent_json', JSON.stringify(patch.spent));
    if (patch.losses !== undefined) add('losses', patch.losses);
    if (patch.attempts !== undefined) add('attempts', patch.attempts);
    this.db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getMission(id);
  }

  /** Raw counter access used by budget enforcement. */
  missionCounters(id: string): { spent: Record<string, number>; losses: number; attempts: number } {
    const row = this.db
      .prepare('SELECT spent_json, losses, attempts FROM missions WHERE id = ?')
      .get(id) as { spent_json: string; losses: number; attempts: number } | undefined;
    if (!row) return { spent: {}, losses: 0, attempts: 0 };
    return { spent: JSON.parse(row.spent_json) as Record<string, number>, losses: row.losses, attempts: row.attempts };
  }

  countMissions(filter: { status?: MissionStatus[]; type?: MissionType[] }): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${placeholders(filter.status)})`);
      params.push(...filter.status);
    }
    if (filter.type?.length) {
      where.push(`type IN (${placeholders(filter.type)})`);
      params.push(...filter.type);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM missions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
      .get(...params) as { n: number };
    return row.n;
  }

  countOpenBuilds(): number {
    return this.countMissions({ status: OPEN_STATUSES, type: BUILD_TYPES });
  }

  /** True when a repair or replacement mission is still in flight. */
  hasOpenPriorityWork(): boolean {
    return this.countMissions({ status: OPEN_STATUSES, type: PRIORITY_TYPES }) > 0;
  }

  hasOpenRepair(): boolean {
    return this.countMissions({ status: OPEN_STATUSES, type: ['repair'] }) > 0;
  }

  isTerminal(id: string): boolean {
    const m = this.getMission(id);
    return !m || TERMINAL_STATUSES.includes(m.status);
  }

  /** Most recent mission created for a desired-state entry, if any. */
  lastMissionForKey(prefix: string): Mission | null {
    const row = this.db
      .prepare(
        `SELECT * FROM missions WHERE idempotency_key LIKE ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(`${prefix}%`) as MissionRow | undefined;
    return row ? rowToMission(row) : null;
  }

  // ------------------------------------------------------------------- units

  upsertUnit(unit: UnitRecord): void {
    this.db
      .prepare(
        `INSERT INTO units (id, name, spec_id, station, link_status, last_seen, pos_json, vel_json, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           spec_id = excluded.spec_id,
           station = excluded.station,
           link_status = excluded.link_status,
           last_seen = excluded.last_seen,
           pos_json = excluded.pos_json,
           vel_json = excluded.vel_json,
           meta_json = excluded.meta_json`,
      )
      .run(
        unit.id,
        unit.name,
        unit.specId,
        unit.station,
        unit.linkStatus,
        unit.lastSeen,
        unit.pos ? JSON.stringify(unit.pos) : null,
        unit.vel ? JSON.stringify(unit.vel) : null,
        JSON.stringify(unit.meta),
      );
  }

  getUnit(id: string): UnitRecord | null {
    const row = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          spec_id: string | null;
          station: string | null;
          link_status: string;
          last_seen: number;
          pos_json: string | null;
          vel_json: string | null;
          meta_json: string;
        }
      | undefined;
    return row ? this.rowToUnit(row) : null;
  }

  listUnits(): UnitRecord[] {
    const rows = this.db.prepare('SELECT * FROM units ORDER BY id').all() as UnitRow[];
    return rows.map((r) => this.rowToUnit(r));
  }

  private rowToUnit(row: UnitRow): UnitRecord {
    return {
      id: row.id,
      name: row.name,
      specId: row.spec_id,
      station: row.station,
      linkStatus: row.link_status as UnitRecord['linkStatus'],
      lastSeen: row.last_seen,
      pos: row.pos_json ? (JSON.parse(row.pos_json) as Vec3) : null,
      vel: row.vel_json ? (JSON.parse(row.vel_json) as Vec3) : null,
      meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    };
  }

  /** Replace all links reported by one plugin agent (telemetry is authoritative). */
  replaceLinks(agentId: string, links: PluginLink[], at: number): void {
    const del = this.db.prepare('DELETE FROM links WHERE agent_id = ?');
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO links (agent_id, a, b, status, at) VALUES (?, ?, ?, ?, ?)',
    );
    this.tx(() => {
      del.run(agentId);
      for (const link of links) ins.run(agentId, link.a, link.b, link.status, at);
    });
  }

  listLinks(): LinkRecord[] {
    const rows = this.db.prepare('SELECT * FROM links').all() as {
      agent_id: string;
      a: string;
      b: string;
      status: string;
      at: number;
    }[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      a: r.a,
      b: r.b,
      status: r.status as 'up' | 'down',
      at: r.at,
    }));
  }

  // ------------------------------------------------------------------ orders

  getOrder(orderId: string): OrderRecord | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  latestOrderFor(missionId: string, unitId: string): OrderRecord | null {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE mission_id = ? AND unit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(missionId, unitId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  createOrder(order: OrderRecord): { created: boolean; order: OrderRecord } {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO orders
         (order_id, mission_id, unit_id, order_type, payload_json, status, attempts, next_attempt_at, created_at, acked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.orderId,
        order.missionId,
        order.unitId,
        order.orderType,
        JSON.stringify(order.payload),
        order.status,
        order.attempts,
        order.nextAttemptAt,
        order.createdAt,
        order.ackedAt,
      );
    return { created: info.changes > 0, order: this.getOrder(order.orderId) ?? order };
  }

  updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, 'status' | 'attempts' | 'nextAttemptAt' | 'ackedAt' | 'payload'>>,
  ): OrderRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.attempts !== undefined) add('attempts', patch.attempts);
    if (patch.nextAttemptAt !== undefined) add('next_attempt_at', patch.nextAttemptAt);
    if (patch.ackedAt !== undefined) add('acked_at', patch.ackedAt);
    if (patch.payload !== undefined) add('payload_json', JSON.stringify(patch.payload));
    if (!sets.length) return this.getOrder(orderId);
    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE order_id = ?`).run(...params, orderId);
    return this.getOrder(orderId);
  }

  listOrders(missionId?: string, limit = 500): OrderRecord[] {
    const rows = missionId
      ? (this.db
          .prepare('SELECT * FROM orders WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?')
          .all(missionId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM orders ORDER BY created_at ASC LIMIT ?').all(limit) as Record<
          string,
          unknown
        >[]);
    return rows.map((r) => this.rowToOrder(r));
  }

  countOrdersSince(since: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?').get(since) as { n: number };
    return row.n;
  }

  private rowToOrder(row: Record<string, unknown>): OrderRecord {
    return {
      orderId: String(row.order_id),
      missionId: String(row.mission_id),
      unitId: String(row.unit_id),
      orderType: String(row.order_type),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      status: String(row.status) as OrderStatus,
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      createdAt: Number(row.created_at),
      ackedAt: row.acked_at === null ? null : Number(row.acked_at),
    };
  }

  // ----------------------------------------------------------------- desired

  upsertDesired(entry: Omit<DesiredRecord, 'createdAt'> & { createdAt?: number }): DesiredRecord {
    this.db
      .prepare(
        `INSERT INTO desired (id, spec, station, count, formation, budget_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           spec = excluded.spec, station = excluded.station, count = excluded.count,
           formation = excluded.formation, budget_json = excluded.budget_json, enabled = excluded.enabled`,
      )
      .run(
        entry.id,
        entry.spec,
        entry.station,
        entry.count,
        entry.formation,
        entry.budget ? JSON.stringify(entry.budget) : null,
        entry.enabled ? 1 : 0,
        entry.createdAt ?? this.now(),
      );
    return this.listDesired().find((d) => d.id === entry.id)!;
  }

  listDesired(): DesiredRecord[] {
    const rows = this.db.prepare('SELECT * FROM desired ORDER BY id').all() as {
      id: string;
      spec: string;
      station: string;
      count: number;
      formation: string;
      budget_json: string | null;
      enabled: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      spec: r.spec,
      station: r.station,
      count: r.count,
      formation: r.formation,
      budget: r.budget_json ? (JSON.parse(r.budget_json) as MissionBudget) : null,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
    }));
  }

  removeDesired(id: string): boolean {
    return this.db.prepare('DELETE FROM desired WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------------------ groups

  private rowToGroup(row: Record<string, unknown>): GroupRecord {
    let members: string[] = [];
    try {
      const parsed = JSON.parse(String(row.members)) as unknown;
      if (Array.isArray(parsed)) {
        // Grid ids are strings. A row carrying a number is corrupt for our
        // purposes: keep the string form only when it is unambiguous.
        members = parsed.filter((m): m is string => typeof m === 'string' && m.length > 0);
      }
    } catch {
      members = [];
    }
    return {
      id: String(row.id),
      name: String(row.name),
      color: row.color === null || row.color === undefined ? null : String(row.color),
      members,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listGroups(): GroupRecord[] {
    const rows = this.db.prepare('SELECT * FROM groups ORDER BY created_at ASC, id ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToGroup(r));
  }

  getGroup(id: string): GroupRecord | null {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToGroup(row) : null;
  }

  /** Null means the id already exists; group ids are client-supplied. */
  createGroup(input: GroupInput): GroupRecord | null {
    const now = this.now();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO groups (id, name, color, members, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.color ?? null,
        JSON.stringify(input.members),
        input.createdAt ?? now,
        input.updatedAt ?? now,
      );
    return info.changes > 0 ? this.getGroup(input.id) : null;
  }

  updateGroup(
    id: string,
    patch: { name?: string; color?: string | null; members?: string[] },
  ): GroupRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.color !== undefined) add('color', patch.color);
    if (patch.members !== undefined) add('members', JSON.stringify(patch.members));
    if (!sets.length) return this.getGroup(id);
    add('updated_at', this.now());
    const info = this.db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return info.changes > 0 ? this.getGroup(id) : null;
  }

  deleteGroup(id: string): boolean {
    return this.db.prepare('DELETE FROM groups WHERE id = ?').run(id).changes > 0;
  }

  // --------------------------------------------------------- fleet operations

  private rowToFleetOp(row: Record<string, unknown>): FleetOperation {
    const json = <T>(value: unknown, fallback: T): T => {
      if (typeof value !== 'string' || !value) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    };
    const members = json<unknown>(row.members, []);
    return {
      id: String(row.id),
      kind: String(row.kind) as FleetOpKind,
      planetId: row.planet_id === null || row.planet_id === undefined ? null : String(row.planet_id),
      // Grid ids are strings; a number in the row is corrupt and is dropped
      // rather than rounded into a different grid.
      members: Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string' && m.length > 0) : [],
      steps: json<FleetStep[]>(row.steps, []),
      status: String(row.status) as FleetOpStatus,
      dryRun: Number(row.dry_run) === 1,
      coverageBefore: json<FleetCoverage | null>(row.coverage_before, null),
      coverageAfter: json<FleetCoverage | null>(row.coverage_after, null),
      invariants: json<FleetInvariants>(row.invariants, {
        ok: false,
        checkedAt: Number(row.updated_at),
        members: [],
        failures: [],
        notes: [],
      }),
      abortPolicy: String(row.abort_policy) as FleetAbortPolicy,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      createdBy: String(row.created_by),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    };
  }

  /** Null means the id already exists; fleet operation ids are generated. */
  createFleetOp(op: FleetOperation): FleetOperation | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO fleet_operations
         (id, kind, planet_id, members, steps, status, dry_run, coverage_before, coverage_after,
          invariants, abort_policy, created_at, updated_at, created_by, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.kind,
        op.planetId,
        JSON.stringify(op.members),
        JSON.stringify(op.steps),
        op.status,
        op.dryRun ? 1 : 0,
        op.coverageBefore ? JSON.stringify(op.coverageBefore) : null,
        op.coverageAfter ? JSON.stringify(op.coverageAfter) : null,
        JSON.stringify(op.invariants),
        op.abortPolicy,
        op.createdAt,
        op.updatedAt,
        op.createdBy,
        op.lastError,
      );
    return info.changes > 0 ? this.getFleetOp(op.id) : null;
  }

  getFleetOp(id: string): FleetOperation | null {
    const row = this.db.prepare('SELECT * FROM fleet_operations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToFleetOp(row) : null;
  }

  listFleetOps(
    filter: { status?: FleetOpStatus[]; kind?: FleetOpKind[]; limit?: number } = {},
  ): FleetOperation[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${placeholders(filter.status)})`);
      params.push(...filter.status);
    }
    if (filter.kind?.length) {
      where.push(`kind IN (${placeholders(filter.kind)})`);
      params.push(...filter.kind);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM fleet_operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 100) as Record<string, unknown>[];
    return rows.map((row) => this.rowToFleetOp(row));
  }

  updateFleetOp(
    id: string,
    patch: Partial<
      Pick<
        FleetOperation,
        'status' | 'steps' | 'coverageBefore' | 'coverageAfter' | 'invariants' | 'abortPolicy' | 'lastError'
      >
    >,
    at = this.now(),
  ): FleetOperation | null {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [at];
    const add = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.steps !== undefined) add('steps', JSON.stringify(patch.steps));
    if (patch.coverageBefore !== undefined) {
      add('coverage_before', patch.coverageBefore ? JSON.stringify(patch.coverageBefore) : null);
    }
    if (patch.coverageAfter !== undefined) {
      add('coverage_after', patch.coverageAfter ? JSON.stringify(patch.coverageAfter) : null);
    }
    if (patch.invariants !== undefined) add('invariants', JSON.stringify(patch.invariants));
    if (patch.abortPolicy !== undefined) add('abort_policy', patch.abortPolicy);
    // `undefined` clears this nullable column.
    if ('lastError' in patch) add('last_error', patch.lastError ?? null);
    const info = this.db.prepare(`UPDATE fleet_operations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return info.changes > 0 ? this.getFleetOp(id) : null;
  }

  /**
   * Append one step atomically. Returns null when the operation does not exist.
   * A duplicate step id is ignored so a retried cancel/abort cannot double-add.
   */
  appendFleetOpStep(id: string, step: FleetStep): FleetOperation | null {
    return this.tx(() => {
      const op = this.getFleetOp(id);
      if (!op) return null;
      if (op.steps.some((existing) => existing.id === step.id)) return op;
      const steps = [...op.steps, step];
      return this.updateFleetOp(id, { steps }, this.now());
    });
  }

  setFleetOpStatus(id: string, status: FleetOpStatus, lastError?: string | null): FleetOperation | null {
    if (lastError === undefined) {
      const info = this.db
        .prepare('UPDATE fleet_operations SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, this.now(), id);
      return info.changes > 0 ? this.getFleetOp(id) : null;
    }
    return this.updateFleetOp(id, { status, lastError }, this.now());
  }

  // ------------------------------------------------------------------ ledger

  listLedger(): {
    site: string;
    item: string;
    qty: number;
    reserved: number;
    inTransit: number;
    available: number;
    asOf: number;
  }[] {
    const rows = this.db.prepare('SELECT * FROM ledger ORDER BY site, item').all() as {
      site: string;
      item: string;
      qty: number;
      reserved: number;
      in_transit: number;
      as_of: number;
    }[];
    return rows.map((r) => ({
      site: r.site,
      item: r.item,
      qty: r.qty,
      reserved: r.reserved,
      inTransit: r.in_transit,
      available: Math.max(0, r.qty - r.reserved - r.in_transit),
      asOf: r.as_of,
    }));
  }

  upsertLedger(entry: {
    site: string;
    item: string;
    qty: number;
    reserved?: number;
    inTransit?: number;
    asOf: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ledger (site, item, qty, reserved, in_transit, as_of) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(site, item) DO UPDATE SET
           qty = excluded.qty, reserved = excluded.reserved,
           in_transit = excluded.in_transit, as_of = excluded.as_of`,
      )
      .run(entry.site, entry.item, entry.qty, entry.reserved ?? 0, entry.inTransit ?? 0, entry.asOf);
  }
}

/** Raw `alerts` row as stored; JSON columns are parsed by `mapAlert`. */
interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  message: string;
  evidence: string;
  actions: string;
  state: string;
  count: number;
  first_seen_at: number;
  last_seen_at: number;
  acked_by: string | null;
  resolved_at: number | null;
}

function mapAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity as AlertSeverity,
    subjectType: row.subject_type as AlertSubjectType,
    subjectId: row.subject_id,
    message: row.message,
    evidence: safeJson<Record<string, unknown>>(row.evidence, {}),
    actions: safeJson<AlertAction[]>(row.actions, []),
    state: row.state as AlertState,
    count: Number(row.count),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    ackedBy: row.acked_by,
    resolvedAt: row.resolved_at,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
