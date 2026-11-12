import type { Mission } from '@se-rts/schemas';
import type { Store } from './store.js';
import { pauseMission } from './missions.js';

export interface BudgetCheck {
  ok: boolean;
  reason?: 'time' | 'resources' | 'losses';
  message?: string;
}

export interface MissionCounters {
  spent: Record<string, number>;
  losses: number;
}

/**
 * Budget is checked before every dispatch and after every outcome. Hitting
 * either the resource budget or the loss limit pauses the mission and raises
 * an alert — it never silently continues.
 */
export function checkBudget(
  mission: Mission,
  counters: MissionCounters,
  now: number,
  pausedAlready = false,
): BudgetCheck {
  if (pausedAlready) return { ok: false, reason: 'losses', message: 'mission is paused' };

  const elapsedMs = now - mission.createdAt;
  if (elapsedMs > mission.budget.timeMin * 60_000) {
    return {
      ok: false,
      reason: 'time',
      message: `time budget exceeded (${mission.budget.timeMin} min)`,
    };
  }

  for (const [item, cap] of Object.entries(mission.budget.resources)) {
    const spent = counters.spent[item] ?? 0;
    if (spent > cap) {
      return { ok: false, reason: 'resources', message: `resource budget exceeded for ${item} (${spent}/${cap})` };
    }
  }

  if (counters.losses >= mission.budget.lossLimit) {
    return {
      ok: false,
      reason: 'losses',
      message: `loss limit reached (${counters.losses}/${mission.budget.lossLimit})`,
    };
  }

  return { ok: true };
}

export function recordLoss(
  store: Store,
  missionId: string,
  count: number,
  now: number,
  actor = 'telemetry',
): { paused: boolean; reason?: string } {
  const mission = store.getMission(missionId);
  if (!mission) return { paused: false };
  const counters = store.missionCounters(missionId);
  const losses = counters.losses + Math.max(0, Math.trunc(count));
  store.updateMission(missionId, { losses }, now);
  store.audit({
    actor,
    action: 'mission_loss_recorded',
    subject: missionId,
    detail: { count, losses, lossLimit: mission.budget.lossLimit },
    at: now,
  });

  if (losses >= mission.budget.lossLimit) {
    pauseMission(
      store,
      missionId,
      'loss_limit',
      {
        kind: 'loss_limit',
        message: `mission ${missionId} paused: loss limit reached (${losses}/${mission.budget.lossLimit})`,
      },
      actor,
      now,
    );
    return { paused: true, reason: 'loss_limit' };
  }
  return { paused: false };
}

export function recordSpend(
  store: Store,
  missionId: string,
  resources: Record<string, number>,
  now: number,
  actor = 'production',
): { paused: boolean; reason?: string } {
  const mission = store.getMission(missionId);
  if (!mission) return { paused: false };
  const counters = store.missionCounters(missionId);
  const spent = { ...counters.spent };
  for (const [item, qty] of Object.entries(resources)) {
    spent[item] = (spent[item] ?? 0) + qty;
  }
  store.updateMission(missionId, { spent }, now);
  store.audit({
    actor,
    action: 'mission_spend_recorded',
    subject: missionId,
    detail: { resources },
    at: now,
  });

  const check = checkBudget(mission, { spent, losses: counters.losses }, now);
  if (!check.ok) {
    pauseMission(
      store,
      missionId,
      check.reason === 'time' ? 'time_budget' : check.reason === 'losses' ? 'loss_limit' : 'resource_budget',
      { kind: `${check.reason}_budget`, message: `mission ${missionId} paused: ${check.message}` },
      actor,
      now,
    );
    return { paused: true, reason: check.reason };
  }
  return { paused: false };
}
