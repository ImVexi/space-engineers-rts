/**
 * T20 power poller.
 *
 * Samples every owner-tagged grid with the plugin's read-only `profile` order
 * and keeps the latest snapshot plus a 24 h history in memory.
 *
 * Scheduling rules (the owner's spec):
 *   * one poll per grid every 30 s, first polls staggered so 14 grids do not
 *     all land on the same second;
 *   * at most 3 profile orders per second (one in flight, 333 ms spacing);
 *   * a grid a player is piloting is skipped entirely (T27 manual handoff);
 *   * a missing profile is never an error for the caller — the previous
 *     snapshot stays, the site keeps showing its age.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '../../store.js';
import type { PluginHub } from '../../pluginHub.js';
import { capabilitiesFromStore } from '../network.js';
import { decideOrderChannel } from '../channel.js';
import { resolveSurvivalMode, SURVIVAL_REASON } from '../survival.js';
import { waitForOrderResult } from '../../orderResults.js';
import { parseProfileResult } from './parse.js';
import { sampleOf, type PowerSample } from './rates.js';
import { POWER_DEFAULTS, type PowerSnapshot } from './types.js';

export interface ProfileSender {
  isConnected: () => boolean;
  send: (message: unknown) => boolean;
}

export interface PowerPollerOptions {
  store: Store;
  hub: ProfileSender;
  clock?: () => number;
  intervalMs?: number;
  maxOrdersPerSec?: number;
  timeoutMs?: number;
  historyMs?: number;
  /** Defaults to the provisioning snapshot: exactly the owner-tagged grids. */
  taggedGrids?: () => string[];
  /** Injection point for tests; the default sends a real plugin order. */
  sendProfile?: (gridId: string) => Promise<Record<string, unknown> | null>;
}

interface GridState {
  lastSnapshotAt: number | null;
  lastAttemptAt: number | null;
  nextDueAt: number | null;
  lastError: string | null;
  errors: number;
  polls: number;
  skippedManual: number;
  /** Scheduler passes where this grid was idle and its read was deferred. */
  skippedIdle: number;
}

/**
 * Idle cadence (sim-speed audit #2/#5). A grid that is NOT flying, NOT piloted
 * and has no open mission does not change its power state between two passes:
 * re-reading it every 30 s was 70 % of all plugin orders. It is re-read every
 * 5 min instead, and its snapshot is left alone (age keeps growing on the site;
 * nothing is coerced to zero).
 */
export const IDLE_REFRESH_MS = 5 * 60_000;
/** Telemetry this fresh is the precondition for treating a grid as idle. */
export const IDLE_TELEMETRY_FRESH_MS = 10_000;
/** Below this speed a grid is not flying (m/s). */
export const IDLE_MAX_SPEED_MPS = 0.5;

export interface PowerHistoryBucket {
  minute: number;
  samples: number;
  batteryPct: number | null;
  netMw: number | null;
  solarPct: number | null;
  h2Pct: number | null;
  uraniumPct: number | null;
  runwayMin: number | null;
}

export class PowerPoller {
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly spacingMs: number;
  private readonly timeoutMs: number;
  private readonly historyMs: number;

  private timer: NodeJS.Timeout | null = null;
  private readonly snapshots = new Map<string, PowerSnapshot>();
  private readonly history = new Map<string, PowerSample[]>();
  private readonly gridState = new Map<string, GridState>();
  private queue: string[] = [];
  private inFlight = false;
  private lastSentAt = 0;
  private lastTickAt: number | null = null;
  private lastPollAt: number | null = null;
  private ordersSent = 0;
  private manualSkipped = 0;
  private started = false;

  /**
   * Optional 30 s consumer (the T68 alerts engine). Called once per scheduler
   * pass, before the connection check, so stale-telemetry/sim-speed conditions
   * are still evaluated while the plugin link is down. Must not throw; the
   * consumer throttles itself to one evaluation per 30 s.
   */
  onTick?: (now: number) => void;

  constructor(private readonly opts: PowerPollerOptions) {
    this.clock = opts.clock ?? (() => Date.now());
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? POWER_DEFAULTS.intervalMs);
    this.spacingMs = Math.ceil(1000 / Math.max(1, opts.maxOrdersPerSec ?? POWER_DEFAULTS.maxOrdersPerSec));
    this.timeoutMs = opts.timeoutMs ?? POWER_DEFAULTS.timeoutMs;
    this.historyMs = opts.historyMs ?? POWER_DEFAULTS.historyMs;
  }

  start(): void {
    if (this.timer) return;
    this.started = true;
    // The clock tick is cheap; the rate limit and the per-grid due times decide
    // when an order actually leaves.
    this.timer = setInterval(() => {
      void this.tick();
    }, 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  get running(): boolean {
    return this.started;
  }

  tagged(): string[] {
    const ids = this.opts.taggedGrids?.() ?? [...capabilitiesFromStore(this.opts.store).keys()];
    return [...new Set(ids)].filter(Boolean);
  }

  /** One scheduler pass. Exposed for deterministic tests. */
  async tick(now = this.clock()): Promise<void> {
    this.lastTickAt = now;
    try {
      this.onTick?.(now);
    } catch {
      // A consumer must never break the poller.
    }
    if (!this.opts.hub.isConnected()) return;

    const ids = this.tagged();
    ids.forEach((id, index) => {
      const state = this.stateOf(id);
      if (state.nextDueAt !== null) return;
      // Stagger the first poll of each grid across one interval instead of
      // firing fourteen `profile` orders in the same millisecond.
      state.nextDueAt = now + Math.floor((index * this.intervalMs) / Math.max(1, ids.length));
    });

    // Oldest due first, so a grid cannot starve another one just because its
    // id sorts earlier.
    const dueNow = ids
      .filter((id) => {
        const state = this.stateOf(id);
        return state.nextDueAt !== null && now >= state.nextDueAt;
      })
      .sort((a, b) => (this.stateOf(a).nextDueAt ?? 0) - (this.stateOf(b).nextDueAt ?? 0));

    for (const id of dueNow) {
      const state = this.stateOf(id);
      if (this.queue.includes(id) || this.inFlight) break;
      if (this.isManual(id)) {
        state.skippedManual += 1;
        state.nextDueAt = now + this.intervalMs;
        continue;
      }
      // Idle skip: fresh telemetry + no mission + not moving = nothing to learn.
      // The snapshot is not touched, so the site shows its real age.
      if (this.isIdle(id, now)) {
        state.skippedIdle += 1;
        state.nextDueAt = now + IDLE_REFRESH_MS;
        continue;
      }
      this.queue.push(id);
    }

    // One order in flight, at most one every `spacingMs` (<= 3/s).
    if (!this.inFlight && this.queue.length > 0 && now - this.lastSentAt >= this.spacingMs) {
      const id = this.queue.shift()!;
      this.inFlight = true;
      this.lastSentAt = now;
      this.ordersSent += 1;
      const state = this.stateOf(id);
      state.lastAttemptAt = now;
      state.nextDueAt = now + this.intervalMs;
      try {
        const result = await this.profile(id);
        if (result && Object.keys(result).length > 0) this.ingest(id, result);
        else this.fail(id, 'no profile result (timeout or plugin refused)');
      } catch (err) {
        this.fail(id, err instanceof Error ? err.message : String(err));
      } finally {
        this.inFlight = false;
        state.polls += 1;
        this.lastPollAt = this.clock();
      }
    }
  }

  /** Record a profile result (also used by tests and by future event hooks). */
  ingest(gridId: string, result: Record<string, unknown>, at = this.clock()): PowerSnapshot {
    if (!result || Object.keys(result).length === 0) {
      // Never replace a good snapshot with an empty reply: that is what made a
      // healthy satellite read as all-null (and then "0 %").
      const previous = this.snapshots.get(gridId);
      if (previous) return previous;
    }
    const snap = parseProfileResult(gridId, result, at);
    this.snapshots.set(gridId, snap);
    const series = this.history.get(gridId) ?? [];
    series.push(sampleOf(snap));
    const cutoff = at - this.historyMs;
    // 30 s * 24 h = 2880 samples; the cap only guards against a clock jump.
    const pruned = series.filter((s) => s.at >= cutoff).slice(-3_000);
    this.history.set(gridId, pruned);
    const state = this.stateOf(gridId);
    state.lastSnapshotAt = at;
    state.lastError = null;
    return snap;
  }

  snapshot(gridId: string): PowerSnapshot | null {
    return this.snapshots.get(gridId) ?? null;
  }

  allSnapshots(): PowerSnapshot[] {
    return [...this.snapshots.values()];
  }

  series(gridId: string, hours = 24): PowerSample[] {
    const cutoff = this.clock() - Math.max(1, hours) * 3_600_000;
    return (this.history.get(gridId) ?? []).filter((s) => s.at >= cutoff);
  }

  /** Last 24 h in 1-minute buckets; only buckets that hold a real sample. */
  buckets(gridId: string, hours = 24, bucketMs = 60_000): PowerHistoryBucket[] {
    const samples = this.series(gridId, hours);
    const byMinute = new Map<number, PowerSample[]>();
    for (const s of samples) {
      const minute = Math.floor(s.at / bucketMs) * bucketMs;
      const bucket = byMinute.get(minute) ?? [];
      bucket.push(s);
      byMinute.set(minute, bucket);
    }
    return [...byMinute.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minute, rows]) => ({
        minute,
        samples: rows.length,
        batteryPct: average(rows.map((r) => r.batteryPct)),
        netMw: average(rows.map((r) => r.netMw)),
        solarPct: average(rows.map((r) => r.solarPct)),
        h2Pct: last(rows.map((r) => r.h2Pct)),
        uraniumPct: last(rows.map((r) => r.uraniumKg)),
        runwayMin: null,
      }));
  }

  summary(now = this.clock()) {
    const states = [...this.gridState.entries()];
    const freshest = [...this.snapshots.values()].map((s) => s.at);
    const manual = [...this.snapshots.values()].filter((s) => s.underControl).map((s) => s.gridId);
    return {
      enabled: true,
      source: 'GAME' as const,
      intervalMs: this.intervalMs,
      maxOrdersPerSec: Math.round(1000 / this.spacingMs),
      note: 'read-only profile poll; one order per grid per 30 s, max 3/s',
      taggedGrids: this.tagged().length,
      polledGrids: this.snapshots.size,
      ordersSent: this.ordersSent,
      manualSkipped: this.manualSkipped,
      idleSkipped: states.reduce((n, [, s]) => n + s.skippedIdle, 0),
      idleRefreshMs: IDLE_REFRESH_MS,
      queued: this.queue.length,
      inFlight: this.inFlight,
      lastTickAt: this.lastTickAt,
      lastPollAt: this.lastPollAt,
      newestSampleAt: freshest.length ? Math.max(...freshest) : null,
      oldestSampleAt: freshest.length ? Math.min(...freshest) : null,
      manualControl: manual,
      errors: states.filter(([, s]) => s.lastError !== null).map(([id, s]) => ({ gridId: id, error: s.lastError, count: s.errors })),
    };
  }

  /** True when the last snapshot says a player is piloting the grid. */
  isManual(gridId: string): boolean {
    const snap = this.snapshots.get(gridId);
    if (snap?.underControl) {
      this.manualSkipped += 1;
      return true;
    }
    const unit = this.opts.store.getUnit(gridId);
    const meta = (unit?.meta ?? {}) as Record<string, unknown>;
    if (meta.underControl === true || meta.manualControl === true || meta.piloted === true) {
      this.manualSkipped += 1;
      return true;
    }
    return false;
  }

  /**
   * True when this grid is parked: telemetry is FRESH, no open mission is
   * assigned to it, nobody is piloting it, it is not moving, and it is
   * static/stationed/landed. Anything unknown (no unit row, no velocity, stale
   * telemetry) is NOT idle and keeps the normal 30 s cadence — the safe side is
   * polling.
   */
  isIdle(gridId: string, now = this.clock()): boolean {
    if (this.hasOpenMission(gridId)) return false;
    // A pilot reported by the last profile is a live control even when the
    // grid is parked and static.
    if (this.snapshots.get(gridId)?.underControl) return false;
    const unit = this.opts.store.getUnit(gridId);
    if (!unit) return false;
    if (now - unit.lastSeen > IDLE_TELEMETRY_FRESH_MS) return false;
    const meta = (unit.meta ?? {}) as Record<string, unknown>;
    const control = meta.control as { underControl?: boolean; piloted?: boolean; carryingPassengers?: boolean } | undefined;
    if (control?.underControl === true || control?.piloted === true || control?.carryingPassengers === true) return false;
    if (meta.underControl === true || meta.manualControl === true || meta.piloted === true) return false;
    const vel = unit.vel;
    if (!vel) return false;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (!Number.isFinite(speed) || speed >= IDLE_MAX_SPEED_MPS) return false;
    // Landed / static / stationed. `unit.station` is the game's own onStation
    // string; `isStatic` comes from the provisioning capability snapshot.
    if (unit.station != null && unit.station !== '') return true;
    if (meta.landed === true || meta.static === true || meta.isStatic === true) return true;
    const cap = capabilitiesFromStore(this.opts.store).get(gridId);
    return cap?.isStatic === true;
  }

  /** Any mission still open (queued..paused) that names this grid. */
  private openMissionGridsCache: { at: number; ids: Set<string> } | null = null;

  private hasOpenMission(gridId: string): boolean {
    const now = this.clock();
    if (!this.openMissionGridsCache || now - this.openMissionGridsCache.at > 5_000) {
      const ids = new Set<string>();
      try {
        for (const mission of this.opts.store.listMissions({ status: ['queued', 'planned', 'approved', 'executing', 'paused'] })) {
          for (const id of mission.assignedUnits ?? []) ids.add(id);
        }
      } catch {
        // A store read failure must not make a grid look idle.
        return true;
      }
      this.openMissionGridsCache = { at: now, ids };
    }
    return this.openMissionGridsCache.ids.has(gridId);
  }

  private stateOf(gridId: string): GridState {
    const found = this.gridState.get(gridId);
    if (found) return found;
    const created: GridState = {
      lastSnapshotAt: null,
      lastAttemptAt: null,
      nextDueAt: null,
      lastError: null,
      errors: 0,
      polls: 0,
      skippedManual: 0,
      skippedIdle: 0,
    };
    this.gridState.set(gridId, created);
    return created;
  }

  private fail(gridId: string, message: string): void {
    const state = this.stateOf(gridId);
    state.lastError = message;
    state.errors += 1;
  }

  private async profile(gridId: string): Promise<Record<string, unknown> | null> {
    if (this.opts.sendProfile) return this.opts.sendProfile(gridId);
    if (!this.opts.hub.isConnected()) return null;
    const now = this.clock();
    const orderId = `demo:power:${randomUUID()}`;
    // T75: a profile read is a legitimate action, so it leaves on the
    // production channel in every build (never refused in practice).
    const decision = decideOrderChannel('test', 'profile', resolveSurvivalMode());
    if (decision.refused) {
      this.opts.store.audit({
        actor: 'power-poller',
        action: 'survival_refused',
        subject: gridId,
        detail: { action: 'profile', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
        at: now,
      });
      return null;
    }
    const frame = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: decision.orderType,
      entityId: gridId,
      params: { action: 'profile', entityId: gridId },
      tick: 0,
      issuedAt: now,
      expiresAt: now + this.timeoutMs,
    };
    // Cursor BEFORE the frame leaves (sim-speed audit #7): a hub that answers
    // synchronously writes the result during `send`, and it must be visible.
    const sinceRowid = this.opts.store.maxAuditRowid();
    if (!this.opts.hub.send(frame)) return null;
    // Event-first: the order_result frame wakes this wait on the same tick; the
    // store is read only for rows newer than the cursor, at most 1/s while this
    // one order is outstanding.
    const hit = await waitForOrderResult(this.opts.store, orderId, this.timeoutMs, { sinceRowid });
    const result = hit?.result;
    // An order_result without a body is not a reading. Ingesting it wiped a
    // good snapshot to all-null (the site then showed "0 %" / "—" for a grid
    // that was fine). Treat it as a failed poll instead.
    if (!result || typeof result !== 'object' || Object.keys(result).length === 0) return null;
    return result;
  }
}

function average(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

function last(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}
