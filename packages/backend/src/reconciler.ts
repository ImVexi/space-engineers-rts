import { DEFAULT_SHIP_COST, type Mission } from '@se-rts/schemas';
import type { Store } from './store.js';
import { createMission, type MissionContext } from './missions.js';

/**
 * Desired-state reconciler: compares desired N units of a spec at a station
 * against telemetry and emits at most ONE mission per desired entry per gap.
 *
 * Idempotency key = `desired:<entry id>`. Because the open mission is stored
 * in SQLite, repeated cycles and process restarts see it and emit nothing new.
 */
export interface ReconcileOptions {
  minIntervalMs: number;
  maxQueuedBuilds: number;
  autoMissionTypes: readonly string[];
  actor?: string;
  /** Feature flag gate; the capability is OFF unless this returns true. */
  enabled?: () => boolean;
}

export interface ReconcileSkip {
  desiredId: string;
  reason:
    | 'satisfied'
    | 'dedupe'
    | 'rate_limited'
    | 'repair_pending'
    | 'cap_reached'
    | 'kill_switch'
    | 'disabled'
    | 'invalid';
}

export interface ReconcileResult {
  cycle: number;
  created: Mission[];
  skipped: ReconcileSkip[];
}

export class Reconciler {
  private cycles = 0;

  constructor(
    private readonly store: Store,
    private readonly opts: ReconcileOptions,
    private readonly clock: () => number = Date.now,
  ) {}

  get cycleCount(): number {
    return this.cycles;
  }

  cycle(): ReconcileResult {
    this.cycles += 1;
    const now = this.clock();
    const result: ReconcileResult = { cycle: this.cycles, created: [], skipped: [] };

    if (this.opts.enabled && !this.opts.enabled()) {
      for (const d of this.store.listDesired()) result.skipped.push({ desiredId: d.id, reason: 'disabled' });
      return result;
    }

    if (this.store.isKillSwitchOn()) {
      for (const d of this.store.listDesired()) result.skipped.push({ desiredId: d.id, reason: 'kill_switch' });
      return result;
    }

    const units = this.store.listUnits();

    for (const desired of this.store.listDesired()) {
      if (!desired.enabled) continue;

      const actual = units.filter(
        (u) => u.specId === desired.spec && u.station === desired.station,
      ).length;
      const gap = desired.count - actual;
      if (gap <= 0) {
        result.skipped.push({ desiredId: desired.id, reason: 'satisfied' });
        continue;
      }

      const key = `desired:${desired.id}`;
      const open = this.store.openMissionByIdempotencyKey(key);
      if (open) {
        result.skipped.push({ desiredId: desired.id, reason: 'dedupe' });
        continue;
      }

      // Rate limit per desired entry so a flapping desired-state cannot
      // flood the queue; the open mission above is the primary guard.
      const last = this.store.lastMissionForKey(key);
      if (last && now - last.createdAt < this.opts.minIntervalMs) {
        result.skipped.push({ desiredId: desired.id, reason: 'rate_limited' });
        continue;
      }

      if (this.store.hasOpenPriorityWork()) {
        result.skipped.push({ desiredId: desired.id, reason: 'repair_pending' });
        this.auditOnce(desired.id, 'reconcile_skipped', { reason: 'repair_pending' }, now);
        continue;
      }

      if (this.store.countOpenBuilds() >= this.opts.maxQueuedBuilds) {
        result.skipped.push({ desiredId: desired.id, reason: 'cap_reached' });
        this.auditOnce(desired.id, 'reconcile_cap', { cap: this.opts.maxQueuedBuilds }, now);
        continue;
      }

      const unitCost = DEFAULT_SHIP_COST[desired.spec] ?? { iron: 12000 };
      const resources: Record<string, number> = {};
      for (const [item, qty] of Object.entries(unitCost)) resources[item] = qty * gap;

      const ctx: MissionContext = {
        now,
        actor: this.opts.actor ?? 'reconciler',
        autoMissionTypes: this.opts.autoMissionTypes,
        maxQueuedBuilds: this.opts.maxQueuedBuilds,
      };

      const created = createMission(
        this.store,
        {
          schemaVersion: 1,
          type: 'build_deploy',
          priority: 50,
          desiredState: {
            shipSpec: desired.spec,
            station: desired.station,
            formation: desired.formation,
            qty: gap,
          },
          budget: desired.budget ?? { resources, timeMin: 90, lossLimit: 1 },
          approval: 'approve',
          idempotencyKey: key,
          createdBy: 'reconciler',
        },
        ctx,
      );

      if (!created.ok) {
        result.skipped.push({
          desiredId: desired.id,
          reason: created.code === 'cap_reached' ? 'cap_reached' : 'invalid',
        });
        continue;
      }

      if (created.created) {
        this.store.audit({
          actor: this.opts.actor ?? 'reconciler',
          action: 'reconcile_emit',
          subject: desired.id,
          detail: {
            missionId: created.mission.id,
            spec: desired.spec,
            station: desired.station,
            actual,
            desired: desired.count,
            gap,
          },
          rollbackPoint: `mission:${created.mission.id}:cancel`,
          at: now,
        });
        result.created.push(created.mission);
      } else {
        result.skipped.push({ desiredId: desired.id, reason: 'dedupe' });
      }
    }

    return result;
  }

  /** Audit at most once per minute per (desired, action) pair. */
  private auditOnce(desiredId: string, action: string, detail: Record<string, unknown>, now: number): void {
    const key = `throttle:${action}:${desiredId}`;
    const last = Number(this.store.getKv(key) ?? 0);
    if (now - last < 60_000) return;
    this.store.setKv(key, String(now));
    this.store.audit({
      actor: this.opts.actor ?? 'reconciler',
      action,
      subject: desiredId,
      detail,
      at: now,
    });
  }
}
