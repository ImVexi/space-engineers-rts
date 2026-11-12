/**
 * T68 alerts service: evaluate -> dedupe -> deliver.
 *
 * Dedupe contract (the owner's rules):
 *   * ONE active (open or acked) alert per kind+subject. A recurrence updates
 *     message/evidence/actions/count/lastSeenAt on the same row.
 *   * A per-kind cooldown stops a cleared condition from re-opening a brand new
 *     alert on the very next tick (flapping). Updates are not cooldown-limited;
 *     the condition is still true.
 *   * A condition that no longer holds AUTO-RESOLVES: the row gets state
 *     `resolved` + `resolvedAt`, the event is audited and a resolution message
 *     is queued (batched, never critical).
 *
 * Delivery never throws into the poller: `tick()` catches and audits.
 */
import type { Alert, AlertFilter, Store } from '../../store.js';
import type { PowerPoller } from '../power/index.js';
import { evaluateConditions } from './conditions.js';
import { AlertDelivery, type DeliveryVariant, type FetchLike } from './delivery.js';
import { buildAlertContext, type AlertsContextDeps } from './context.js';
import { readAlertsSettings, type AlertsSettings } from './settings.js';
import { ALERT_KINDS, SEVERITY_RANK, type AlertCandidate, type AlertContext, type AlertKind } from './types.js';

/** Minimum spacing between two identical condition evaluations on one key. */
export const ALERT_COOLDOWNS_MS: Record<AlertKind, number> = {
  'energy-runway': 5 * 60_000,
  'grid-isolated': 2 * 60_000,
  'grid-lost': 30 * 60_000,
  'coverage-hole': 10 * 60_000,
  'coverage-drop': 10 * 60_000,
  'grid-under-control': 60_000,
  'mission-failed': 60_000,
  'mission-aborted': 60_000,
  'telemetry-stale': 5 * 60_000,
  'plugin-link-down': 60_000,
  'sim-speed': 60_000,
  'needs-refuel': 10 * 60_000,
  'come-to-me-timeout': 10 * 60_000,
};

const EVALUATE_INTERVAL_MS = 30_000;

/**
 * Kinds this engine owns: it is the only thing that opens them, so it is the
 * only thing allowed to auto-resolve them.
 *
 * Auto-resolving a kind it does not evaluate is what made alerts flap. The
 * survival loop opens `stranded` / `return-home` itself (in `raiseAlert`), and
 * this engine never produced a candidate for those kinds — so every 30 s
 * evaluation "cleared" each of them, the survival loop re-created it, and the
 * pair wrote an `alert_resolved` + `alert_resolved_delivered` row per grid per
 * tick with no matching `alert_opened` (measured 2026-11-11: 70 distinct ids
 * resolved in 5 minutes, zero opens).
 */
const OWNED_KINDS: ReadonlySet<string> = new Set(Object.keys(ALERT_COOLDOWNS_MS));

/**
 * How long a condition must stay absent before the alert is resolved, ms.
 * One full evaluation interval: the absence must be seen by TWO consecutive
 * evaluations, so one skipped sample (a poller hiccup, a tick that ran before
 * its input arrived) can never resolve and re-open an alert.
 */
export const RESOLVE_HOLD_MS = EVALUATE_INTERVAL_MS;

export interface AlertsServiceDeps {
  store: Store;
  clock?: () => number;
  fixturePath?: string | null;
  power?: PowerPoller | null;
  executor?: { summary(): Record<string, unknown> } | null;
  simSpeed?: AlertsContextDeps['simSpeed'];
  pluginConnected?: () => boolean;
  fetchImpl?: FetchLike;
  logger?: (message: string) => void;
  /** Tests inject a fixed context; production reads the live world. */
  context?: () => AlertContext;
}

export interface EvaluateResult {
  evaluatedAt: number;
  candidates: number;
  opened: Alert[];
  updated: Alert[];
  resolved: Alert[];
  delivered: { alertId: string; channels: string[]; mode: 'immediate' | 'batched' | 'disabled' }[];
}

export class AlertsService {
  private readonly clock: () => number;
  private readonly delivery: AlertDelivery;
  private readonly lastFiredAt = new Map<string, number>();
  private readonly deliveredAt = new Map<string, number>();
  /** alert id -> first evaluation that no longer saw its condition. */
  private readonly clearSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastEvaluatedAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: AlertsServiceDeps) {
    this.clock = deps.clock ?? (() => Date.now());
    this.delivery = new AlertDelivery({
      store: deps.store,
      clock: this.clock,
      settings: () => this.settings,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
  }

  get settings(): AlertsSettings {
    return readAlertsSettings(this.deps.store);
  }

  get pendingDeliveries(): number {
    return this.delivery.pending;
  }

  get lastDeliveryError(): string | null {
    return this.delivery.lastDeliveryError;
  }

  /** 30 s evaluation + 1 s delivery flush. Safe to call twice. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* tick already audits; this is only a last-resort guard */
      });
    }, 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Poller tick entry point. Evaluates at most once per 30 s unless `force`.
   * Returns null when the throttle skipped this call.
   */
  async tick(now = this.clock(), force = false): Promise<EvaluateResult | null> {
    try {
      await this.delivery.flushDue(now);
      if (!force && this.lastEvaluatedAt !== null && now - this.lastEvaluatedAt < EVALUATE_INTERVAL_MS - 1_000) {
        return null;
      }
      return await this.evaluate(undefined, now);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.store.audit({
        actor: 'alerts',
        action: 'alerts_error',
        subject: 'evaluate',
        detail: { error: this.lastError },
        at: now,
      });
      return null;
    }
  }

  /** On-demand evaluation (`POST /api/alerts/evaluate` and tests). */
  async evaluate(context?: AlertContext, now?: number): Promise<EvaluateResult> {
    const ctx = context ?? this.deps.context?.() ?? this.buildContext();
    const evaluatedAt = now ?? ctx.now;
    const settings = this.settings;
    const candidates = uniqueCandidates(evaluateConditions({ ...ctx, now: evaluatedAt }, settings));
    this.lastEvaluatedAt = evaluatedAt;

    const opened: Alert[] = [];
    const updated: Alert[] = [];
    const resolved: Alert[] = [];
    const toDeliver: { alert: Alert; variant: DeliveryVariant; escalated?: boolean }[] = [];

    const active = this.deps.store.listAlertRecords({ state: ['open', 'acked'], limit: 1000 });
    const activeByKey = new Map(active.map((a) => [keyOf(a.kind, a.subjectId), a]));
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const key = keyOf(candidate.kind, candidate.subjectId);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = activeByKey.get(key);
      if (existing) {
        const escalated = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity];
        const row = this.deps.store.updateAlert(existing.id, {
          message: candidate.message,
          evidence: candidate.evidence,
          actions: candidate.actions,
          severity: escalated ? candidate.severity : maxSeverity(existing.severity, candidate.severity),
          count: existing.count + 1,
          lastSeenAt: evaluatedAt,
        });
        if (row) {
          updated.push(row);
          if (escalated || this.shouldDeliverUpdate(row, evaluatedAt, candidate.kind)) {
            toDeliver.push({ alert: row, variant: 'updated', escalated });
          }
        }
        continue;
      }

      const cooldown = ALERT_COOLDOWNS_MS[candidate.kind] ?? 60_000;
      const last = this.lastFiredAt.get(key);
      if (last !== undefined && evaluatedAt - last < cooldown) continue;

      const row = this.deps.store.createAlert({
        kind: candidate.kind,
        severity: candidate.severity,
        subjectType: candidate.subjectType,
        subjectId: candidate.subjectId,
        message: candidate.message,
        evidence: candidate.evidence,
        actions: candidate.actions,
        count: 1,
        firstSeenAt: evaluatedAt,
        lastSeenAt: evaluatedAt,
      });
      this.lastFiredAt.set(key, evaluatedAt);
      this.deps.store.audit({
        actor: 'alerts',
        action: 'alert_opened',
        subject: row.id,
        detail: {
          kind: row.kind,
          severity: row.severity,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          message: row.message,
        },
        at: evaluatedAt,
      });
      opened.push(row);
      toDeliver.push({ alert: row, variant: 'opened' });
    }

    // AUTO-RESOLVE: an active alert whose condition is absent this evaluation.
    // Only kinds this engine opened, and only after the absence has held for
    // RESOLVE_HOLD_MS (hysteresis: one missing sample is not a state change).
    for (const alert of active) {
      if (!OWNED_KINDS.has(alert.kind)) continue;
      const key = keyOf(alert.kind, alert.subjectId);
      if (seen.has(key)) {
        this.clearSince.delete(alert.id);
        continue;
      }
      const since = this.clearSince.get(alert.id);
      if (since === undefined) {
        this.clearSince.set(alert.id, evaluatedAt);
        continue;
      }
      if (evaluatedAt - since < RESOLVE_HOLD_MS) continue;
      const row = this.deps.store.resolveAlert(alert.id, evaluatedAt);
      if (!row) continue;
      this.clearSince.delete(alert.id);
      this.deliveredAt.delete(alert.id);
      this.deps.store.audit({
        actor: 'alerts',
        action: 'alert_resolved',
        subject: row.id,
        detail: {
          kind: row.kind,
          severity: row.severity,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          count: row.count,
          reason: 'condition cleared',
          auto: true,
          absentForMs: evaluatedAt - since,
        },
        at: evaluatedAt,
      });
      resolved.push(row);
      toDeliver.push({ alert: row, variant: 'resolved' });
    }

    const delivered = await this.delivery.deliver(toDeliver, evaluatedAt);
    for (const item of delivered) {
      if (item.mode === 'immediate' || item.mode === 'batched') this.deliveredAt.set(item.alertId, evaluatedAt);
    }

    return {
      evaluatedAt,
      candidates: candidates.length,
      opened,
      updated,
      resolved,
      delivered,
    };
  }

  /** Flush queued non-critical messages whose 5 s window has elapsed. */
  async flushDelivery(now = this.clock()): Promise<number> {
    return this.delivery.flushDue(now);
  }

  list(filter: AlertFilter = {}): Alert[] {
    return this.deps.store.listAlertRecords(filter);
  }

  get(id: string): Alert | null {
    return this.deps.store.getAlert(id);
  }

  /**
   * Ack one alert. Returns null for an unknown id; a resolved alert is
   * returned unchanged (the route turns that into 409, never a fake ack).
   */
  acknowledge(id: string, actor: string, now = this.clock()): Alert | null {
    const before = this.deps.store.getAlert(id);
    if (!before) return null;
    if (before.state !== 'open') return before;
    const after = this.deps.store.ackAlert(id, actor, now);
    this.deps.store.audit({
      actor,
      action: 'alert_acked',
      subject: id,
      detail: { kind: before.kind, subjectId: before.subjectId, by: actor },
      at: now,
    });
    return after;
  }

  resolve(id: string, actor: string, now = this.clock()): Alert | null {
    const before = this.deps.store.getAlert(id);
    if (!before) return null;
    if (before.state === 'resolved') return before;
    const after = this.deps.store.resolveAlert(id, now);
    this.deps.store.audit({
      actor,
      action: 'alert_resolved',
      subject: id,
      detail: { kind: before.kind, subjectId: before.subjectId, by: actor, reason: 'resolved by operator', auto: false },
      at: now,
    });
    this.deliveredAt.delete(id);
    return after;
  }

  /** Compact block for `/api/demo/state`. */
  summary(now = this.clock()): Record<string, unknown> {
    return {
      ...this.deps.store.countActiveAlerts(),
      evaluatedAt: this.lastEvaluatedAt,
      ageMs: this.lastEvaluatedAt === null ? null : Math.max(0, now - this.lastEvaluatedAt),
      pendingDeliveries: this.delivery.pending,
      lastError: this.lastError,
      discord: this.settings.discordWebhook ? 'configured' : 'disabled',
      recent: this.deps.store.listAlertRecords({ state: ['open', 'acked'], limit: 10 }),
    };
  }

  private shouldDeliverUpdate(alert: Alert, now: number, kind: string): boolean {
    const last = this.deliveredAt.get(alert.id);
    if (last === undefined) return true;
    const cooldown = ALERT_COOLDOWNS_MS[kind as AlertKind] ?? 60_000;
    return now - last >= cooldown;
  }

  private buildContext(): AlertContext {
    return buildAlertContext({
      store: this.deps.store,
      clock: this.clock,
      fixturePath: this.deps.fixturePath ?? null,
      settings: () => this.settings,
      power: this.deps.power ?? null,
      executor: this.deps.executor ?? null,
      simSpeed: this.deps.simSpeed ?? null,
      ...(this.deps.pluginConnected ? { pluginConnected: this.deps.pluginConnected } : {}),
    });
  }
}

/** One candidate per kind+subject; the strongest severity wins. */
function uniqueCandidates(candidates: AlertCandidate[]): AlertCandidate[] {
  const byKey = new Map<string, AlertCandidate>();
  for (const candidate of candidates) {
    const key = keyOf(candidate.kind, candidate.subjectId);
    const prev = byKey.get(key);
    if (!prev || SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[prev.severity]) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function keyOf(kind: string, subjectId: string): string {
  return `${kind}|${subjectId}`;
}

function maxSeverity(a: Alert['severity'], b: Alert['severity']): Alert['severity'] {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export { ALERT_KINDS };
