/**
 * Thrust-staging controller (T8).
 *
 * One instance lives inside the demo executor. Every ~2 s, for each flying or
 * holding drone, it:
 *   1. resolves the hull's staged banks against live telemetry (altitude,
 *      vertical speed, battery, mass, fuel);
 *   2. runs the pure policy (`decideStaging`);
 *   3. applies actuator changes through the existing plugin `set_block_props`
 *      action (no plugin change: gas tanks `Stockpile`, hydrogen thrusters
 *      `OnOff`);
 *   4. audits every switch with reason, H2 fill and altitude, and keeps a
 *      fuel-saved estimate versus leaving every bank enabled.
 *
 * Orders are sent outside the executor's single `pendingOrder` slot: a staging
 * write must not block (or be blocked by) a move/hold order. Results come back
 * as `plugin_event/order_result` audit rows, exactly like the provisioner.
 */
import type { Planet } from '@se-rts/schemas';
import type { Store, UnitRecord } from '../../store.js';
import { decideStaging, actuatorKey, maySwitch, phaseFor, type StagingDecision, type StagingMode } from './policy.js';
import { hardwareFor, hardwareFromLiveProfile, type StagingHardware } from './hardware.js';
import { decideOrderChannel } from '../channel.js';
import { resolveSurvivalMode, SURVIVAL_REASON } from '../survival.js';

export interface StagingOrder {
  /** Human label used in audit rows, e.g. "Hydrogen:OnOff=true". */
  label: string;
  filter: Record<string, unknown>;
  props: Record<string, unknown>;
  actions: string[];
}

interface PendingBatch {
  key: string;
  orders: { orderId: string; order: StagingOrder }[];
  sentAt: number;
  decision: StagingDecision;
}

interface AppliedState {
  key: string;
  h2Enabled: boolean;
  h2Scope: 'all' | 'up';
  stockpile: boolean;
}

interface DroneStaging {
  gridId: string;
  missionId: string;
  idx: number;
  label: string;
  mode: StagingMode;
  reason: string | null;
  hardware: StagingHardware | null;
  decision: StagingDecision | null;
  applied: AppliedState | null;
  pending: PendingBatch | null;
  lastSwitchAt: number | null;
  switches: number;
  emergencySince: number | null;
  emergencyAlerted: boolean;
  fuelSavedL: number;
  lastSampleAt: number | null;
  h2FillPct: number | null;
  batteryPct: number | null;
  retryAfter: number;
  lastError: string | null;
  updatedAt: number;
  /** Hardware built from a live plugin `profile` read (grid with no registry entry). */
  liveHardware: StagingHardware | null;
  liveHardwareAt: number;
  /** In-flight `profile` read, resolved from the audit trail. */
  profileRequest: { orderId: string; sentAt: number } | null;
  profileRetryAfter: number;
}

export interface StagingTickInput {
  missionId: string;
  idx: number;
  label: string;
  prefab: string;
  gridId: string | null;
  state: string;
  unit: UnitRecord | null;
  planet: Planet | null;
  now: number;
  /** Controlled-fall descent in progress: a fast deliberate descent is not an emergency. */
  plannedDescent?: boolean;
}

export interface StagingControllerDeps {
  store: Store;
  send: (payload: Record<string, unknown>) => boolean;
  /** Staging writes ON by default; RTS_STAGING=0 turns the controller off. */
  enabled?: boolean;
  /** RTS_STAGING_DRY=1 computes and audits, never writes to the game. */
  dryRun?: boolean;
  tickMs?: number;
  maxTelemetryAgeMs?: number;
  /** How long a live `profile` read is trusted before it is re-read. */
  profileRefreshMs?: number;
}

const MIN_ORDER_AGE_MS = 20_000;
const RETRY_AFTER_MS = 30_000;
/** A `profile` order is answered in well under a second; 20 s means it is lost. */
const PROFILE_TIMEOUT_MS = 20_000;
const PROFILE_RETRY_MS = 30_000;
const PROFILE_REFRESH_MS = 120_000;

export class StagingController {
  private readonly drones = new Map<string, DroneStaging>();
  private readonly lastTickAt = new Map<string, number>();

  constructor(private readonly deps: StagingControllerDeps) {}

  get enabled(): boolean {
    return this.deps.enabled !== false;
  }

  get dryRun(): boolean {
    return this.deps.dryRun === true;
  }

  get tickMs(): number {
    return Math.max(500, this.deps.tickMs ?? 2_000);
  }

  /** Called by the executor once per flying/holding drone per tick. */
  tick(input: StagingTickInput): void {
    if (!this.enabled) return;
    const gridId = input.gridId;
    if (!gridId) return;
    const last = this.lastTickAt.get(gridId);
    if (last !== undefined && input.now - last < this.tickMs) return;
    this.lastTickAt.set(gridId, input.now);

    const previous = this.drones.get(gridId);
    const manualFrom = previous && previous.mode === 'manual' ? previous.missionId : null;
    const row = this.rowFor(input);
    row.updatedAt = input.now;

    // T27: `manual` is cleared only by a new explicit mission for this grid.
    // The executor still withholds every order while the cockpit is occupied.
    if (row.mode === 'manual' && manualFrom !== null && manualFrom !== input.missionId) {
      row.mode = 'off';
      row.reason = `new mission ${input.missionId}; staging may resume`;
      row.decision = null;
    }
    // Suspended rows are never staged: no write may reach a piloted grid, even
    // if a tick slips past the executor's control pass.
    if (row.mode === 'manual') return;

    // Resolve anything sent on an earlier tick before deciding again.
    this.resolvePending(row, input.now);
    if (row.pending) return;

    const phase = phaseFor(input.state);
    if (!phase) {
      row.mode = 'off';
      row.reason = `state ${input.state} is not staged`;
      return;
    }

    if (!input.planet) {
      row.mode = 'no-telemetry';
      row.reason = 'planet unknown for this drone';
      return;
    }
    const unit = input.unit;
    if (!unit?.pos) {
      row.mode = 'no-telemetry';
      row.reason = 'no position telemetry for the grid';
      return;
    }
    const age = input.now - unit.lastSeen;
    const maxAge = this.deps.maxTelemetryAgeMs ?? 60_000;
    if (age > maxAge) {
      row.mode = 'stale-telemetry';
      row.reason = `telemetry is ${Math.round(age / 1000)} s old (max ${Math.round(maxAge / 1000)} s); no write`;
      return;
    }

    const resolved = this.resolveHardware(row, input.prefab, gridId, input.now, numeric(unit.meta.massKg));
    if (!resolved.hardware) {
      // No registry entry (a cloned grid keeps the hull but gets a new id).
      // Build the profile from the live grid instead of refusing to stage it.
      row.mode = resolved.pending ? 'profile-pending' : 'unknown-hardware';
      row.reason = resolved.reason;
      return;
    }
    const hardware = resolved.hardware;
    row.hardware = hardware;

    const center = input.planet.center;
    const dx = unit.pos.x - center.x;
    const dy = unit.pos.y - center.y;
    const dz = unit.pos.z - center.z;
    const radius = Math.hypot(dx, dy, dz) || 1;
    const altitudeM = Math.max(0, radius - Number(input.planet.surfaceRadiusM ?? 0));
    const up = { x: dx / radius, y: dy / radius, z: dz / radius };
    const verticalSpeedMps = unit.vel
      ? unit.vel.x * up.x + unit.vel.y * up.y + unit.vel.z * up.z
      : null;
    const powerFraction = numeric(unit.meta.powerFraction);
    const fuelFraction = numeric(unit.meta.fuelFraction);
    const batteryPct = powerFraction === null ? null : clampPct(powerFraction * 100);
    row.batteryPct = batteryPct;
    row.h2FillPct = fuelFraction === null ? clampPct(hardware.h2Fill * 100) : clampPct(fuelFraction * 100);

    const decision = decideStaging(hardware, input.planet, {
      phase,
      altitudeM,
      verticalSpeedMps,
      batteryPct,
      massKg: numeric(unit.meta.massKg),
      plannedDescent: input.plannedDescent === true,
    });
    row.decision = decision;
    row.mode = 'active';
    row.reason = decision.reason;

    // Fuel-saved integral, in litres, versus leaving every bank enabled.
    const dtS = row.lastSampleAt === null ? 0 : Math.min(10, Math.max(0, (input.now - row.lastSampleAt) / 1000));
    row.fuelSavedL += decision.fuelSavedLps * dtS;
    row.lastSampleAt = input.now;

    if (decision.emergency) {
      if (row.emergencySince === null) row.emergencySince = input.now;
      if (!row.emergencyAlerted) {
        row.emergencyAlerted = true;
        this.deps.store.addAlert({
          kind: 'thrust_staging_emergency',
          message: `${row.label} (${gridId}): ${decision.emergencyReason}; every bank enabled`,
          missionId: row.missionId,
          at: input.now,
        });
        this.deps.store.audit({
          actor: 'thrust-staging',
          action: 'staging_emergency',
          subject: `${input.missionId}:${input.idx}`,
          detail: {
            gridId,
            reason: decision.emergencyReason,
            altitudeM: decision.altitudeM,
            verticalSpeedMps,
            batteryPct,
            h2FillPct: fuelFraction === null ? null : clampPct(fuelFraction * 100),
            action: 'all banks enabled',
          },
          at: input.now,
        });
      }
    } else {
      row.emergencySince = null;
      row.emergencyAlerted = false;
    }

    const key = actuatorKey(decision);
    if (row.applied?.key === key) return;
    if (input.now < row.retryAfter) return;

    if (
      !maySwitch({
        previousKey: row.applied?.key ?? null,
        nextKey: key,
        lastSwitchAt: row.lastSwitchAt,
        now: input.now,
        emergency: decision.emergency,
      })
    ) {
      row.reason = `${decision.reason}; hysteresis: last switch ${Math.round((input.now - (row.lastSwitchAt ?? input.now)) / 1000)} s ago (min 10 s)`;
      return;
    }

    const orders = ordersFor(decision, row.applied);
    if (orders.length === 0) {
      row.applied = { key, h2Enabled: decision.h2Enabled, h2Scope: decision.h2Scope, stockpile: decision.stockpile };
      row.lastSwitchAt = input.now;
      return;
    }

    if (this.dryRun || !this.deps.send) {
      this.store(row, decision, orders, input.now, hardware, fuelFraction, 'dry-run: not sent');
      row.applied = { key, h2Enabled: decision.h2Enabled, h2Scope: decision.h2Scope, stockpile: decision.stockpile };
      row.lastSwitchAt = input.now;
      row.switches += 1;
      return;
    }

    const batch: PendingBatch = {
      key,
      orders: orders.map((order, i) => ({
        orderId: `staging:${gridId}:${input.now}:${i}:${order.label}`,
        order,
      })),
      sentAt: input.now,
      decision,
    };

    let sentAny = false;
    for (const entry of batch.orders) {
      const plan = entry.order;
      // T75: H2/stockpile writes are legitimate actions and go out on the
      // production channel in both builds (refused only if that ever changes).
      const decision = decideOrderChannel('test', 'set_block_props', resolveSurvivalMode());
      if (decision.refused) {
        this.deps.store.audit({
          actor: 'thrust-staging',
          action: 'survival_refused',
          subject: entry.orderId,
          detail: { action: 'set_block_props', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
          at: input.now,
        });
        continue;
      }
      const payload = {
        schemaVersion: 1 as const,
        type: 'order' as const,
        orderId: entry.orderId,
        orderType: decision.orderType,
        entityId: gridId,
        params: {
          action: 'set_block_props',
          entityId: gridId,
          filter: plan.filter,
          props: plan.props,
          actions: plan.actions,
        },
        tick: 0,
        issuedAt: input.now,
        expiresAt: input.now + 30_000,
      };
      const sent = this.deps.send(payload);
      sentAny = sentAny || sent;
      this.deps.store.audit({
        actor: 'thrust-staging',
        action: sent ? 'staging_order_sent' : 'staging_order_send_failed',
        subject: entry.orderId,
        detail: { gridId, label: plan.label, filter: plan.filter, props: plan.props, actions: plan.actions },
        at: input.now,
      });
    }
    if (!sentAny) {
      row.lastError = 'plugin socket refused every staging order';
      row.retryAfter = input.now + RETRY_AFTER_MS;
      return;
    }
    row.pending = batch;
    this.store(row, decision, orders, input.now, hardware, fuelFraction, 'sent');
  }

  /**
   * T27 manual handoff: a player owns this grid. Drop any pending write and
   * stop staging it entirely until the mark is cleared by the executor.
   */
  suspend(gridId: string, reason: string): void {
    const row = this.drones.get(gridId);
    if (!row) return;
    if (row.mode === 'manual' && row.reason === reason) return;
    row.pending = null;
    row.mode = 'manual';
    row.reason = reason;
    this.deps.store.audit({
      actor: 'thrust-staging',
      action: 'staging_suspended',
      subject: `${row.missionId}:${row.idx}`,
      detail: { gridId, reason },
      at: Date.now(),
    });
  }

  /** Drop all state (kill switch / reset): no more writes until re-evaluated. */
  reset(reason: string): void {
    if (this.drones.size === 0) return;
    const allOff = [...this.drones.values()].every((r) => r.mode === 'off' && r.reason === reason);
    if (allOff) return;
    this.deps.store.audit({
      actor: 'thrust-staging',
      action: 'staging_reset',
      subject: 'all',
      detail: { reason, drones: this.drones.size },
      at: Date.now(),
    });
    for (const row of this.drones.values()) {
      row.pending = null;
      row.mode = 'off';
      row.reason = reason;
    }
  }

  /** Per-drone view for `/api/demo/state` (null when this grid was never staged). */
  view(gridId: string | null): Record<string, unknown> | null {
    if (!gridId) return null;
    const row = this.drones.get(gridId);
    if (!row) return null;
    const d = row.decision;
    return {
      mode: row.mode,
      reason: row.reason,
      enabled: this.enabled,
      dryRun: this.dryRun,
      h2: row.applied ? (row.applied.h2Enabled ? 'on' : 'off') : null,
      desiredH2: d ? (d.h2Enabled ? 'on' : 'off') : null,
      h2Scope: row.applied?.h2Scope ?? d?.h2Scope ?? null,
      stockpile: row.applied ? row.applied.stockpile : null,
      desiredStockpile: d ? d.stockpile : null,
      emergency: d?.emergency ?? false,
      emergencyReason: d?.emergencyReason ?? null,
      phase: d?.phase ?? null,
      altitudeM: d?.altitudeM ?? null,
      gravityMps2: d?.gravityMps2 ?? null,
      requiredN: d?.requiredN ?? null,
      availableN: d?.availableN ?? null,
      coverPct: d?.coverPct ?? null,
      h2GapN: d?.h2GapN ?? null,
      h2FillPct: row.h2FillPct,
      batteryPct: row.batteryPct,
      hardwareSource: row.hardware?.source ?? null,
      fuelSavedL: Math.round(row.fuelSavedL),
      fuelSavedLps: d?.fuelSavedLps ?? 0,
      h2BurnLpsStaged: d?.h2BurnLpsStaged ?? 0,
      h2BurnLpsAllOn: d?.h2BurnLpsAllOn ?? 0,
      h2PctPerHour: d?.h2PctPerHour ?? null,
      switches: row.switches,
      lastSwitchAt: row.lastSwitchAt,
      lastError: row.lastError,
      labels: ['SIMULATED', 'ENDURANCE-MODEL'],
    };
  }

  /**
   * One-line label for the demo site mission row, e.g.
   * "H2 off · atmo 82% · ion 0%".
   */
  line(gridId: string | null): string | null {
    const view = this.view(gridId) as
      | { mode: string; h2: string | null; coverPct: Record<string, number> | null; stockpile: boolean | null; emergency: boolean }
      | null;
    if (!view) return null;
    if (view.mode !== 'active' || !view.coverPct || !view.h2)
      return view.mode === 'off' ? null : `${view.mode}: ${this.drones.get(gridId!)?.reason ?? ''}`.trim();
    const parts = [
      `H2 ${view.h2}`,
      `atmo ${Math.round(view.coverPct.atmo ?? 0)}%`,
      `ion ${Math.round(view.coverPct.ion ?? 0)}%`,
    ];
    if (view.stockpile) parts.push('stockpile');
    if (view.emergency) parts.unshift('EMERGENCY');
    return parts.join(' · ');
  }

  // --------------------------------------------------------------- internals

  /**
   * Hardware resolution order:
   *   1. the measured registry (owner satellites, measured prefabs);
   *   2. a live plugin `profile` read, cached per grid and refreshed when it
   *      ages out or the measured mass drifts. This is what makes a cloned grid
   *      (new grid id, no prefab entry) stageable at all.
   * When neither is available the caller keeps H2 untouched: no guess.
   */
  private resolveHardware(
    row: DroneStaging,
    prefab: string,
    gridId: string,
    now: number,
    massKg: number | null,
  ): { hardware: StagingHardware | null; reason: string | null; pending: boolean } {
    const registry = hardwareFor(prefab, gridId, massKg);
    if (registry.hardware) return { hardware: registry.hardware, reason: null, pending: false };

    const cached = row.liveHardware;
    const massDrift =
      cached !== null && massKg !== null && Math.abs(massKg - cached.massKg) > Math.max(500, cached.massKg * 0.03);
    if (cached && !massDrift && now - row.liveHardwareAt < this.profileRefreshMs) {
      return { hardware: massKg === null ? cached : { ...cached, massKg }, reason: null, pending: false };
    }

    if (row.profileRequest) {
      const result = findProfileResult(this.deps.store, row.profileRequest.orderId);
      if (result) {
        row.profileRequest = null;
        const built = result.ok === false ? null : hardwareFromLiveProfile(gridId, result.result ?? {});
        if (built) {
          row.liveHardware = built;
          row.liveHardwareAt = now;
          this.deps.store.audit({
            actor: 'thrust-staging',
            action: 'staging_profile_live',
            subject: `${row.missionId}:${row.idx}`,
            detail: {
              gridId,
              massKg: Math.round(built.massKg),
              thrustMN: {
                atmo: Math.round(built.thrustN.atmo / 1e4) / 100,
                ion: Math.round(built.thrustN.ion / 1e4) / 100,
                h2: Math.round(built.thrustN.h2 / 1e4) / 100,
              },
              h2TankLitres: built.h2TankLitres,
              h2FillPct: Math.round(built.h2Fill * 1000) / 10,
              batteryMWh: built.batteryMWh,
              source: built.source,
            },
            at: now,
          });
          return { hardware: massKg === null ? built : { ...built, massKg }, reason: null, pending: false };
        }
        row.lastError = `live profile for ${gridId} carries no mass/thrust; staging refused`;
        row.profileRetryAfter = now + PROFILE_RETRY_MS;
        return { hardware: cached, reason: row.lastError, pending: cached === null };
      }
      if (now - row.profileRequest.sentAt <= PROFILE_TIMEOUT_MS) {
        const why = `reading live profile for ${gridId}`;
        row.reason = why;
        return { hardware: cached, reason: why, pending: cached === null };
      }
      row.profileRequest = null;
      row.profileRetryAfter = now + PROFILE_RETRY_MS;
      row.lastError = `live profile for ${gridId}: no plugin result after ${Math.round(PROFILE_TIMEOUT_MS / 1000)} s`;
    }

    if (now < row.profileRetryAfter) {
      return { hardware: cached, reason: row.lastError, pending: cached === null };
    }

    const orderId = `staging:profile:${gridId}:${now}`;
    // T75: a profile read is a legitimate action: production channel in both builds.
    const decision = decideOrderChannel('test', 'profile', resolveSurvivalMode());
    if (decision.refused) {
      this.deps.store.audit({
        actor: 'thrust-staging',
        action: 'survival_refused',
        subject: `${row.missionId}:${row.idx}`,
        detail: { action: 'profile', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
        at: now,
      });
      row.profileRetryAfter = now + PROFILE_RETRY_MS;
      row.lastError = `profile order for ${gridId} was refused in survival mode`;
      return { hardware: cached, reason: row.lastError, pending: cached === null };
    }
    const sent = this.deps.send?.({
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: decision.orderType,
      entityId: gridId,
      params: { action: 'profile', entityId: gridId },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    });
    this.deps.store.audit({
      actor: 'thrust-staging',
      action: sent ? 'staging_profile_requested' : 'staging_profile_send_failed',
      subject: `${row.missionId}:${row.idx}`,
      detail: { gridId, orderId, reason: registry.reason },
      at: now,
    });
    if (!sent) {
      row.profileRetryAfter = now + PROFILE_RETRY_MS;
      row.lastError = `profile order for ${gridId} was not sent`;
      return { hardware: cached, reason: row.lastError, pending: cached === null };
    }
    row.profileRequest = { orderId, sentAt: now };
    const why = `live profile requested for ${gridId}; staging starts on the next tick`;
    row.reason = why;
    return { hardware: cached, reason: why, pending: cached === null };
  }

  private get profileRefreshMs(): number {
    return Math.max(30_000, this.deps.profileRefreshMs ?? PROFILE_REFRESH_MS);
  }

  private rowFor(input: StagingTickInput): DroneStaging {
    const existing = this.drones.get(input.gridId!);
    if (existing) {
      existing.missionId = input.missionId;
      existing.idx = input.idx;
      existing.label = input.label;
      return existing;
    }
    const row: DroneStaging = {
      gridId: input.gridId!,
      missionId: input.missionId,
      idx: input.idx,
      label: input.label,
      mode: 'active',
      reason: null,
      hardware: null,
      decision: null,
      applied: null,
      pending: null,
      lastSwitchAt: null,
      switches: 0,
      emergencySince: null,
      emergencyAlerted: false,
      fuelSavedL: 0,
      lastSampleAt: null,
      h2FillPct: null,
      batteryPct: null,
      retryAfter: 0,
      lastError: null,
      updatedAt: input.now,
      liveHardware: null,
      liveHardwareAt: 0,
      profileRequest: null,
      profileRetryAfter: 0,
    };
    this.drones.set(row.gridId, row);
    return row;
  }

  private resolvePending(row: DroneStaging, now: number): void {
    const batch = row.pending;
    if (!batch) return;
    let done = 0;
    let failed = 0;
    for (const entry of batch.orders) {
      const result = findResult(this.deps.store, entry.orderId);
      if (result) {
        const rejected = result.blocksWithErrors > 0;
        const unmatched = result.count === 0;
        if (result.ok && !rejected && !unmatched) {
          done += 1;
        } else {
          failed += 1;
          const why = result.error
            ? result.error
            : unmatched
              ? 'no blocks matched the filter'
              : `${result.blocksWithErrors} block(s) rejected the property/action`;
          row.lastError = `${entry.order.label}: ${why}`;
        }
        continue;
      }
      if (now - batch.sentAt > MIN_ORDER_AGE_MS) {
        failed += 1;
        row.lastError = `${entry.order.label}: no plugin result after ${Math.round((now - batch.sentAt) / 1000)} s`;
        continue;
      }
      return; // still waiting for at least one order
    }

    row.pending = null;
    if (failed > 0) {
      this.deps.store.audit({
        actor: 'thrust-staging',
        action: 'staging_apply_failed',
        subject: `${row.missionId}:${row.idx}`,
        detail: { gridId: row.gridId, failed, ok: done, error: row.lastError, retryInMs: RETRY_AFTER_MS },
        at: now,
      });
      row.retryAfter = now + RETRY_AFTER_MS;
      return;
    }

    row.applied = {
      key: batch.key,
      h2Enabled: batch.decision.h2Enabled,
      h2Scope: batch.decision.h2Scope,
      stockpile: batch.decision.stockpile,
    };
    row.lastSwitchAt = now;
    row.switches += 1;
    this.deps.store.audit({
      actor: 'thrust-staging',
      action: 'staging_switch',
      subject: `${row.missionId}:${row.idx}`,
      detail: {
        gridId: row.gridId,
        h2: batch.decision.h2Enabled ? 'on' : 'off',
        h2Scope: batch.decision.h2Scope,
        stockpile: batch.decision.stockpile ? 'on' : 'off',
        reason: batch.decision.reason,
        altitudeM: batch.decision.altitudeM,
        h2FillPct: row.h2FillPct,
        requiredN: batch.decision.requiredN,
        availableN: batch.decision.availableN,
        h2GapN: batch.decision.h2GapN,
        h2BurnLps: batch.decision.h2BurnLpsStaged,
        fuelSavedLps: batch.decision.fuelSavedLps,
        orders: batch.orders.map((o) => o.order.label),
        labels: ['SIMULATED', 'ENDURANCE-MODEL'],
      },
      at: now,
    });
  }

  private rowFuelPct(row: DroneStaging): number | null {
    const hw = row.hardware;
    return hw ? Math.round(hw.h2Fill * 1000) / 10 : null;
  }

  /** Audit the decision and the planned orders on every switch. */
  private store(
    row: DroneStaging,
    decision: StagingDecision,
    orders: StagingOrder[],
    now: number,
    hardware: StagingHardware,
    fuelFraction: number | null,
    state: string,
  ): void {
    this.deps.store.audit({
      actor: 'thrust-staging',
      action: 'staging_decision',
      subject: `${row.missionId}:${row.idx}`,
      detail: {
        gridId: row.gridId,
        state,
        h2: decision.h2Enabled ? 'on' : 'off',
        h2Scope: decision.h2Scope,
        stockpile: decision.stockpile ? 'on' : 'off',
        reason: decision.reason,
        altitudeM: decision.altitudeM,
        gravityMps2: decision.gravityMps2,
        requiredN: decision.requiredN,
        coverPct: decision.coverPct,
        h2FillPct: fuelFraction === null ? Math.round(hardware.h2Fill * 1000) / 10 : clampPct(fuelFraction * 100),
        fuelSavedLps: decision.fuelSavedLps,
        orders: orders.map((o) => o.label),
        labels: ['SIMULATED', 'ENDURANCE-MODEL'],
      },
      at: now,
    });
  }
}

/** Actuator plan for a decision. Only the banks that actually change are sent. */
export function ordersFor(decision: StagingDecision, applied: AppliedState | null): StagingOrder[] {
  const out: StagingOrder[] = [];
  const h2Changed =
    !applied || applied.h2Enabled !== decision.h2Enabled || (decision.h2Enabled && applied.h2Scope !== decision.h2Scope);
  if (h2Changed) {
    if (!decision.h2Enabled) {
      out.push(order('Hydrogen:OnOff=false', { type: 'Thruster', subtype: 'Hydrogen' }, { OnOff: false }, ['OnOff_Off']));
    } else if (decision.h2Scope === 'up') {
      // Conservative order: all H2 first OFF, then only the up-facing blocks ON.
      out.push(order('Hydrogen:OnOff=false', { type: 'Thruster', subtype: 'Hydrogen' }, { OnOff: false }, ['OnOff_Off']));
    } else {
      out.push(order('Hydrogen:OnOff=true', { type: 'Thruster', subtype: 'Hydrogen' }, { OnOff: true }, ['OnOff_On']));
    }
  }
  if (!applied || applied.stockpile !== decision.stockpile) {
    out.push(
      order(
        `HydrogenTank:Stockpile=${String(decision.stockpile)}`,
        { type: 'GasTank', subtype: 'HydrogenTank' },
        { Stockpile: decision.stockpile },
        [decision.stockpile ? 'Stockpile_On' : 'Stockpile_Off'],
      ),
    );
  }
  return out;
}

function order(
  label: string,
  filter: Record<string, unknown>,
  props: Record<string, unknown>,
  actions: string[],
): StagingOrder {
  return { label, filter, props, actions };
}

interface PluginTestResult {
  ok: boolean;
  error?: string;
  blocksWithErrors: number;
  count: number;
}

interface PluginProfileResult {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown> | null;
}

/** Resolve a `profile` order from the audit trail (read-only plugin action). */
function findProfileResult(store: Store, orderId: string): PluginProfileResult | null {
  for (const entry of store.listOrderResults(400)) {
    const detail = entry.detail as {
      eventType?: string;
      data?: { orderId?: string; ok?: boolean; error?: string; result?: Record<string, unknown> | null };
    };
    if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result') continue;
    const data = detail.data;
    if (data?.orderId !== orderId) continue;
    return { ok: data.ok !== false, error: data.error, result: data.result ?? null };
  }
  return null;
}

function findResult(store: Store, orderId: string): PluginTestResult | null {
  for (const entry of store.listOrderResults(400)) {
    const detail = entry.detail as {
      eventType?: string;
      data?: {
        orderId?: string;
        ok?: boolean;
        error?: string;
        result?: { blocksWithErrors?: number; count?: number } | null;
      };
    };
    if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result') continue;
    const data = detail.data;
    if (data?.orderId !== orderId) continue;
    return {
      ok: data.ok !== false,
      error: data.error,
      blocksWithErrors: data.result?.blocksWithErrors ?? 0,
      count: data.result?.count ?? -1,
    };
  }
  return null;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPct(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}
