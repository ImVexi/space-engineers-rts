import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Store } from './store.js';

/**
 * Audit retention (2026-11-11).
 *
 * The `audit` table grew to 3.3 GB because three routine writers dominated it
 * (`plugin_event` action results, `alert_delivered` re-deliveries and
 * `ack_unknown` for fire-and-forget action ids). Those are fixed at the
 * source (routine channel / first delivery only / not ack-audited at all), and
 * this job bounds what is left: every hour, rows older than
 * `RTS_AUDIT_RETENTION_DAYS` (default 7) are STREAMED to
 * `data/archive/audit-<from>-<to>.csv.gz` in the same CSV shape as the earlier
 * manual archives, and only then deleted, in small batches.
 *
 * Nothing is deleted that was not first written and flushed: an archive that
 * fails to finish leaves the rows in place (the next hourly run retries).
 * `RTS_AUDIT_RETENTION_DAYS=0` (or `RTS_AUDIT_RETENTION=off`) disables the
 * job entirely.
 */
export class AuditRetention {
  static readonly DEFAULT_RETENTION_DAYS = 7;
  /** Rows per archive page / per DELETE. Keeps each txn short. */
  static readonly BATCH = 2_000;
  static readonly DAY_MS = 24 * 60 * 60 * 1000;

  private readonly store: Store;
  private readonly archiveDir: string;
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  readonly retentionDays: number;

  constructor(opts: {
    store: Store;
    archiveDir: string;
    /** 0 disables the job. */
    retentionDays?: number;
    clock?: () => number;
    log?: (message: string) => void;
  }) {
    this.store = opts.store;
    this.archiveDir = opts.archiveDir;
    this.retentionDays = opts.retentionDays ?? AuditRetention.DEFAULT_RETENTION_DAYS;
    this.clock = opts.clock ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(`[audit-retention] ${m}`));
  }

  get enabled(): boolean {
    return Number.isFinite(this.retentionDays) && this.retentionDays > 0;
  }

  /**
   * Archive then delete everything older than the window.
   * Returns what happened so a caller (or a test) can assert on it.
   */
  async run(now = this.clock()): Promise<{ archived: number; deleted: number; file: string | null }> {
    if (!this.enabled) return { archived: 0, deleted: 0, file: null };
    // Leftover `routine = 1` rows written before routine traffic stopped being
    // stored get an hour's TTL, not the 7 d window: they are poller noise whose
    // source no longer exists, so archiving them would only carry the bloat into
    // the archive directory.
    const pruned = this.store.pruneRoutineAudit(now);
    if (pruned > 0) this.log(`pruned ${pruned} leftover routine rows (1 h TTL)`);
    const cutoff = now - this.retentionDays * AuditRetention.DAY_MS;
    const range = this.store.auditRangeBefore(cutoff);
    if (range.count === 0 || range.oldest === null || range.newest === null) {
      return { archived: 0, deleted: 0, file: null };
    }

    fs.mkdirSync(this.archiveDir, { recursive: true });
    const file = this.uniquePath(
      path.join(
        this.archiveDir,
        `audit-${stamp(range.oldest)}-${stamp(range.newest)}.csv.gz`,
      ),
    );

    // ---- 1. stream every expired row to the archive -------------------------
    const ids: string[] = [];
    let written = 0;
    const self = this;
    async function* rows(): AsyncGenerator<string> {
      yield HEADER;
      let after: { at: number; rowid: number } | null = null;
      for (;;) {
        const page = self.store.auditBefore(cutoff, AuditRetention.BATCH, after);
        if (page.length === 0) break;
        for (const row of page) {
          ids.push(row.id);
          written++;
          yield csvRow(row);
        }
        after = { at: page[page.length - 1]!.at, rowid: page[page.length - 1]!.rowid };
        if (page.length < AuditRetention.BATCH) break;
      }
    }

    await pipeline(Readable.from(rows()), zlib.createGzip(), fs.createWriteStream(file));

    // A short archive is worse than no archive: never delete on a mismatch.
    if (written !== range.count) {
      this.log(
        `archive ${file} has ${written} rows but ${range.count} rows are expired - keeping the rows`,
      );
      return { archived: written, deleted: 0, file };
    }

    // ---- 2. delete what was safely written, in small batches ----------------
    const deleted = this.store.deleteAuditIds(ids, AuditRetention.BATCH);
    this.log(
      `archived ${written} rows older than ${this.retentionDays} d to ${path.basename(file)}, deleted ${deleted}`,
    );
    return { archived: written, deleted, file };
  }

  /** Never overwrite an earlier archive of the same range. */
  private uniquePath(file: string): string {
    if (!fs.existsSync(file)) return file;
    const base = file.replace(/\.csv\.gz$/, '');
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}.csv.gz`;
      if (!fs.existsSync(candidate)) return candidate;
    }
    return `${base}-${Date.now()}.csv.gz`;
  }
}

const HEADER = 'id,at,actor,action,subject,detail,rollback_point,routine\r\n';

/** RFC 4180 field: quote when it holds a quote, comma, CR or LF. */
function field(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(row: {
  id: string;
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
  rollbackPoint: string | null;
  routine: boolean;
}): string {
  return [
    field(row.id),
    field(row.at),
    field(row.actor),
    field(row.action),
    field(row.subject),
    field(JSON.stringify(row.detail)),
    field(row.rollbackPoint),
    field(row.routine ? 1 : 0),
  ].join(',') + '\r\n';
}

/** `20261109T0412`, local time — the same stamp the manual archives use. */
function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * `RTS_AUDIT_RETENTION_DAYS` (default 7) with `RTS_AUDIT_RETENTION` as the
 * off switch. An unreadable value falls back to the default rather than to
 * "delete everything now".
 */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const switchOff = (env.RTS_AUDIT_RETENTION ?? '').trim().toLowerCase();
  if (switchOff === 'off' || switchOff === '0' || switchOff === 'false' || switchOff === 'no') return 0;
  const raw = (env.RTS_AUDIT_RETENTION_DAYS ?? '').trim();
  if (!raw) return AuditRetention.DEFAULT_RETENTION_DAYS;
  if (raw.toLowerCase() === 'off') return 0;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days;
}
