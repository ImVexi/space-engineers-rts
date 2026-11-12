import { OrderMessageSchema, type Mission, type OrderType } from '@se-rts/schemas';
import type { OrderRecord, Store } from './store.js';
import { reachableUnits, type CommsOptions } from './comms.js';
import { checkBudget } from './budgets.js';
import { clearRepairBlocks, pauseMission } from './missions.js';
import { snapDockDecision } from './demo/docking.js';
import { isRoutineOrderId } from './demo/provision/provisioner.js';

/**
 * Order dispatcher. Every outbound order goes through, in this order:
 *   1. kill switch        — nothing leaves the backend;
 *   2. feature flag       — dispatch defaults OFF;
 *   3. budget/loss check  — a paused mission sends nothing;
 *   4. repair priority    — no build order while repair/replacement is open;
 *   5. comms authority    — no order to an unreachable unit;
 *   6. rate limit         — hard cap on orders per rolling minute;
 *   7. idempotency        — one orderId per (mission, unit, attempt);
 *   8. retry cap          — 3 attempts, then pause + escalate.
 */
export interface OrderSender {
  send(message: unknown): boolean;
  isConnected(): boolean;
  agentId(): string | null;
}

export interface DispatcherOptions {
  maxAttempts: number;
  backoffMs: number;
  maxOrdersPerMinute: number;
  comms?: CommsOptions;
  actor?: string;
  /** Feature flag gate; the capability is OFF unless this returns true. */
  enabled?: () => boolean;
}

export interface DispatchResult {
  sent: string[];
  suppressed: string[];
  escalated: string[];
  rateLimited: boolean;
  skipped: string;
}

const ORDER_TYPE_BY_MISSION: Record<string, OrderType> = {
  build_deploy: 'move',
  move: 'move',
  cover: 'move',
  patrol: 'waypoint',
  strike: 'laser',
  logistics: 'move',
  scout: 'move',
  repair: 'repair',
  replace: 'repair',
};

export class Dispatcher {
  constructor(
    private readonly store: Store,
    private readonly sender: OrderSender,
    private readonly opts: DispatcherOptions,
    private readonly clock: () => number = Date.now,
  ) {}

  cycle(now = this.clock()): DispatchResult {
    const result: DispatchResult = {
      sent: [],
      suppressed: [],
      escalated: [],
      rateLimited: false,
      skipped: 'none',
    };

    if (this.opts.enabled && !this.opts.enabled()) {
      result.skipped = 'disabled';
      return result;
    }
    if (this.store.isKillSwitchOn()) {
      result.skipped = 'kill_switch';
      return result;
    }

    clearRepairBlocks(this.store, now);

    const missions = this.store
      .listMissions({ status: ['approved', 'executing'] })
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    const units = this.store.listUnits();
    const links = this.store.listLinks();
    const reachable = reachableUnits(units, links, now, this.opts.comms);

    for (const mission of missions) {
      if (mission.blockedBy) {
        result.suppressed.push(`${mission.id}:blocked:${mission.blockedBy}`);
        continue;
      }

      const counters = this.store.missionCounters(mission.id);
      const budget = checkBudget(mission, counters, now, mission.status === 'paused');
      if (!budget.ok) {
        pauseMission(
          this.store,
          mission.id,
          budget.reason === 'losses' ? 'loss_limit' : budget.reason === 'time' ? 'time_budget' : 'resource_budget',
          { kind: `${budget.reason}_budget`, message: budget.message ?? 'budget exceeded' },
          this.opts.actor ?? 'dispatcher',
          now,
        );
        result.suppressed.push(`${mission.id}:budget:${budget.reason}`);
        continue;
      }

      for (const unitId of mission.assignedUnits) {
        if (!units.some((u) => u.id === unitId)) {
          this.auditOnce(`order_unknown_unit:${mission.id}:${unitId}`, {
            action: 'order_suppressed',
            subject: mission.id,
            detail: { unitId, reason: 'unit_unknown' },
            now,
          });
          result.suppressed.push(`${mission.id}:${unitId}:unknown_unit`);
          continue;
        }
        if (!reachable.has(unitId)) {
          // Hard rule: no connection, no control.
          this.auditOnce(`order_unreachable:${mission.id}:${unitId}`, {
            action: 'order_suppressed',
            subject: mission.id,
            detail: { unitId, reason: 'unreachable' },
            now,
          });
          result.suppressed.push(`${mission.id}:${unitId}:unreachable`);
          continue;
        }

        const current = this.store.latestOrderFor(mission.id, unitId);
        if (current?.status === 'acked') continue;

        if (current && current.attempts >= this.opts.maxAttempts) {
          this.escalate(mission, unitId, current, now, result);
          continue;
        }

        if (this.store.countOrdersSince(now - 60_000) >= this.opts.maxOrdersPerMinute) {
          this.auditOnce('order_rate_limit', {
            action: 'order_rate_limited',
            subject: 'global',
            detail: { cap: this.opts.maxOrdersPerMinute },
            now,
          });
          result.rateLimited = true;
          continue;
        }

        let order: OrderRecord;
        let attempt: number;
        if (!current) {
          attempt = 1;
          order = this.buildOrder(mission, unitId, attempt, now);
          this.store.createOrder(order);
        } else if (current.status === 'sent' && current.nextAttemptAt > now) {
          continue;
        } else if (current.status === 'sent') {
          // Resend the exact same orderId: the plugin dedupes, the backend
          // never creates a second logical order for the same attempt.
          attempt = current.attempts + 1;
          order = current;
        } else {
          // pending (never left) or failed (nack) -> next attempt, new id.
          attempt = current.attempts + 1;
          order = this.buildOrder(mission, unitId, attempt, now);
          this.store.createOrder(order);
        }

        // snap_dock is unsafe until its geometry is fixed (2026-11-10): refuse
        // to put one on the wire even if such an order ever reaches the queue.
        const docking = snapDockDecision(this.store, (order.payload as { params?: unknown } | undefined)?.params);
        if (docking.refused) {
          this.store.audit({
            actor: 'dispatcher',
            action: 'snap_dock_refused',
            subject: order.orderId,
            detail: {
              missionId: mission.id,
              unitId,
              flag: docking.flag,
              flagOn: docking.flagOn,
              reason: docking.reason,
              note: 'no order was sent to the plugin',
            },
            at: now,
          });
          continue;
        }

        const ok = this.sender.send(order.payload);
        if (!ok) {
          this.auditOnce(`order_plugin_offline:${mission.id}:${unitId}`, {
            action: 'order_pending',
            subject: order.orderId,
            detail: { reason: 'plugin_offline' },
            now,
          });
          continue;
        }

        this.store.updateOrder(order.orderId, {
          status: 'sent',
          attempts: attempt,
          nextAttemptAt: now + this.backoff(attempt),
        });
        this.store.audit({
          actor: this.opts.actor ?? 'dispatcher',
          action: 'order_sent',
          subject: order.orderId,
          detail: { missionId: mission.id, unitId, attempt, agentId: this.sender.agentId() },
          at: now,
        });
        result.sent.push(order.orderId);
      }
    }

    return result;
  }

  /** Plugin ack handling is idempotent: duplicate/reordered acks are ignored. */
  onAck(orderId: string, ok: boolean, error: string | undefined, now = this.clock()): void {
    const order = this.store.getOrder(orderId);
    if (!order) {
      // Ack can arrive before we persisted the order (reordered delivery).
      // The provisioner's own orders (`provision:*`) are never in the orders
      // table by design, so their acks are expected and routine.
      this.store.audit({
        actor: 'plugin',
        action: 'ack_unknown',
        subject: orderId,
        detail: { ok, error: error ?? null },
        at: now,
        routine: isRoutineOrderId(orderId),
      });
      return;
    }
    if (order.status === 'acked') {
      this.store.audit({
        actor: 'plugin',
        action: 'ack_duplicate',
        subject: orderId,
        detail: { ok },
        at: now,
      });
      return;
    }
    if (ok) {
      this.store.updateOrder(orderId, { status: 'acked', ackedAt: now });
      const mission = this.store.getMission(order.missionId);
      if (mission && mission.status === 'approved') {
        this.store.updateMission(mission.id, { status: 'executing' }, now);
      }
      this.store.audit({
        actor: 'plugin',
        action: 'order_acked',
        subject: orderId,
        detail: { missionId: order.missionId, unitId: order.unitId },
        at: now,
      });
    } else {
      this.store.updateOrder(orderId, {
        status: 'failed',
        nextAttemptAt: now + this.backoff(order.attempts),
      });
      this.store.audit({
        actor: 'plugin',
        action: 'order_nacked',
        subject: orderId,
        detail: { missionId: order.missionId, unitId: order.unitId, error: error ?? null },
        at: now,
      });
    }
  }

  private buildOrder(mission: Mission, unitId: string, attempt: number, now: number): OrderRecord {
    const orderId = `ord:${mission.id}:${unitId}:a${attempt}`;
    const orderType = ORDER_TYPE_BY_MISSION[mission.type] ?? 'move';
    const payload = OrderMessageSchema.parse({
      schemaVersion: 1,
      type: 'order',
      orderId,
      missionId: mission.id,
      orderType,
      entityId: unitId,
      params: {
        missionType: mission.type,
        desiredState: mission.desiredState,
      },
      tick: 0,
      issuedAt: now,
    });
    return {
      orderId,
      missionId: mission.id,
      unitId,
      orderType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    };
  }

  private escalate(mission: Mission, unitId: string, order: OrderRecord, now: number, result: DispatchResult): void {
    const alreadyPaused = mission.status === 'paused' && mission.pauseReason === 'retry_cap_exhausted';
    if (alreadyPaused) return;
    pauseMission(
      this.store,
      mission.id,
      'retry_cap_exhausted',
      {
        kind: 'order_retry_cap',
        message: `mission ${mission.id} paused: order ${order.orderId} to ${unitId} hit the retry cap (${this.opts.maxAttempts})`,
      },
      this.opts.actor ?? 'dispatcher',
      now,
    );
    result.escalated.push(order.orderId);
  }

  private backoff(attempt: number): number {
    return this.opts.backoffMs * Math.pow(2, Math.max(0, attempt - 1));
  }

  private auditOnce(
    throttleKey: string,
    entry: { action: string; subject: string; detail: Record<string, unknown>; now: number },
  ): void {
    const key = `throttle:${throttleKey}`;
    const last = Number(this.store.getKv(key) ?? 0);
    if (entry.now - last < 60_000) return;
    this.store.setKv(key, String(entry.now));
    this.store.audit({
      actor: this.opts.actor ?? 'dispatcher',
      action: entry.action,
      subject: entry.subject,
      detail: entry.detail,
      at: entry.now,
    });
  }
}
