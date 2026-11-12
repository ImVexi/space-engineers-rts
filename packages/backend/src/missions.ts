import {
  MissionCreateSchema,
  formatIssues,
  type Mission,
  type MissionStatus,
  type MissionType,
} from '@se-rts/schemas';
import type { Store } from './store.js';
import { initialStatus, isBuildMission, resolveApproval } from './policy.js';

export interface MissionContext {
  now: number;
  actor: string;
  autoMissionTypes: readonly string[];
  maxQueuedBuilds: number;
}

export type CreateMissionResult =
  | { ok: true; mission: Mission; created: boolean }
  | { ok: false; code: 'invalid' | 'cap_reached' | 'conflict'; message: string; issues?: string[] };

let counter = 0;

export function makeMissionId(now: number, salt = ''): string {
  counter = (counter + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(36)
    .padStart(3, '0');
  return `m-${now.toString(36)}-${counter.toString(36)}${salt}${rand}`;
}

export function createMission(
  store: Store,
  input: unknown,
  ctx: MissionContext,
): CreateMissionResult {
  const parsed = MissionCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid',
      message: 'mission failed schema validation',
      issues: formatIssues(parsed.error),
    };
  }
  const body = parsed.data;

  // Idempotency before caps: a repeated request must return the same mission,
  // never a duplicate or a cap error caused by itself.
  if (body.idempotencyKey) {
    const existing = store.openMissionByIdempotencyKey(body.idempotencyKey);
    if (existing) return { ok: true, mission: existing, created: false };
  }

  const approval = resolveApproval(body.approval, body.type, ctx.autoMissionTypes);
  if (approval.coerced) {
    store.audit({
      actor: ctx.actor,
      action: 'approval_coerced',
      subject: `type:${body.type}`,
      detail: { requested: 'auto', applied: 'approve', reason: 'type_not_allowlisted' },
      at: ctx.now,
    });
  }

  const status: MissionStatus = initialStatus(approval.approval);

  if (isBuildMission(body.type) && store.countOpenBuilds() >= ctx.maxQueuedBuilds) {
    store.addAlert({
      kind: 'cap_reached',
      message: `queued build cap reached (${ctx.maxQueuedBuilds}); mission rejected`,
      at: ctx.now,
    });
    store.audit({
      actor: ctx.actor,
      action: 'mission_rejected',
      subject: 'queue',
      detail: { reason: 'build_cap', cap: ctx.maxQueuedBuilds, type: body.type },
      at: ctx.now,
    });
    return {
      ok: false,
      code: 'cap_reached',
      message: `queued build cap reached (${ctx.maxQueuedBuilds})`,
    };
  }

  // repair/replacement outranks new builds: create the mission, but hold it.
  const blockedBy =
    body.type === 'build_deploy' && store.hasOpenPriorityWork() ? 'repair_pending' : undefined;

  const mission = {
    schemaVersion: 1 as const,
    id: body.id ?? makeMissionId(ctx.now),
    type: body.type,
    priority: body.priority,
    desiredState: body.desiredState,
    budget: body.budget,
    approval: approval.approval,
    status,
    assignedUnits: body.assignedUnits,
    plan: body.plan,
    idempotencyKey: body.idempotencyKey,
    blockedBy,
    createdBy: ctx.actor,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  const result = store.createMission(mission);
  if (result.created) {
    store.audit({
      actor: ctx.actor,
      action: 'mission_created',
      subject: result.mission.id,
      detail: {
        type: result.mission.type,
        status: result.mission.status,
        approval: result.mission.approval,
        idempotencyKey: result.mission.idempotencyKey ?? null,
        blockedBy: result.mission.blockedBy ?? null,
      },
      rollbackPoint: `mission:${result.mission.id}:cancel`,
      at: ctx.now,
    });
    if (blockedBy) {
      store.audit({
        actor: ctx.actor,
        action: 'mission_blocked',
        subject: result.mission.id,
        detail: { reason: blockedBy },
        at: ctx.now,
      });
    }
  }
  return { ok: true, mission: result.mission, created: result.created };
}

export function approveMission(
  store: Store,
  id: string,
  actor: string,
  now: number,
): { ok: true; mission: Mission } | { ok: false; code: 'not_found' | 'conflict'; message: string } {
  const mission = store.getMission(id);
  if (!mission) return { ok: false, code: 'not_found', message: `mission ${id} not found` };
  if (mission.status !== 'queued' && mission.status !== 'planned') {
    return { ok: false, code: 'conflict', message: `cannot approve mission in status ${mission.status}` };
  }
  const updated = store.updateMission(id, { status: 'approved' }, now);
  store.audit({
    actor,
    action: 'mission_approved',
    subject: id,
    detail: { previousStatus: mission.status, approval: mission.approval },
    rollbackPoint: `mission:${id}:cancel`,
    at: now,
  });
  return { ok: true, mission: updated! };
}

export function cancelMission(
  store: Store,
  id: string,
  actor: string,
  now: number,
  note?: string,
): { ok: true; mission: Mission } | { ok: false; code: 'not_found' | 'conflict'; message: string } {
  const mission = store.getMission(id);
  if (!mission) return { ok: false, code: 'not_found', message: `mission ${id} not found` };
  if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'cancelled') {
    return { ok: false, code: 'conflict', message: `mission already ${mission.status}` };
  }
  const updated = store.updateMission(id, { status: 'cancelled' }, now);
  store.audit({
    actor,
    action: 'mission_cancelled',
    subject: id,
    detail: { previousStatus: mission.status, note: note ?? null },
    rollbackPoint: `mission:${id}:reopen`,
    at: now,
  });
  return { ok: true, mission: updated! };
}

/**
 * Supersede rule: a new move/execute for a grid cancels every older active
 * mission on that same grid (and audits each cancellation). The executor never
 * flies two missions on one grid because the older mission is cancelled here
 * before the new one is approved.
 */
export function supersedeGridMissions(
  store: Store,
  gridId: string,
  keepMissionId: string,
  actor: string,
  now: number,
  reason = 'superseded by a newer mission on the same grid',
): string[] {
  const statuses: MissionStatus[] = ['queued', 'planned', 'approved', 'executing', 'paused'];
  const ids = new Set<string>(store.activeDemoDroneMissionsForGrid(gridId, keepMissionId));
  for (const mission of store.listMissions({ status: statuses })) {
    if (mission.id !== keepMissionId && (mission.assignedUnits ?? []).includes(gridId)) ids.add(mission.id);
  }
  const cancelled: string[] = [];
  for (const id of ids) {
    if (id === keepMissionId) continue;
    const result = cancelMission(store, id, actor, now, reason);
    if (!result.ok) continue;
    cancelled.push(id);
    store.audit({
      actor,
      action: 'mission_superseded',
      subject: id,
      detail: { gridId, supersededBy: keepMissionId, reason },
      at: now,
    });
  }
  return cancelled;
}

export function pauseMission(
  store: Store,
  id: string,
  reason: string,
  alert: { kind: string; message: string },
  actor: string,
  now: number,
): Mission | null {
  const mission = store.getMission(id);
  if (!mission) return null;
  if (mission.status === 'paused') return mission;
  const updated = store.updateMission(id, { status: 'paused', pauseReason: reason }, now);
  store.addAlert({ kind: alert.kind, message: alert.message, missionId: id, at: now });
  store.audit({
    actor,
    action: 'mission_paused',
    subject: id,
    detail: { reason, previousStatus: mission.status },
    rollbackPoint: `mission:${id}:approve`,
    at: now,
  });
  return updated;
}

/** Called by the dispatcher: clears the repair hold once priority work is done. */
export function clearRepairBlocks(store: Store, now: number): number {
  if (store.hasOpenPriorityWork()) return 0;
  const held = store.listMissions({ status: ['queued', 'planned', 'approved', 'executing', 'paused'] });
  let cleared = 0;
  for (const m of held) {
    if (m.blockedBy === 'repair_pending') {
      store.updateMission(m.id, { blockedBy: undefined }, now);
      store.audit({
        actor: 'dispatcher',
        action: 'mission_unblocked',
        subject: m.id,
        detail: { reason: 'repair_pending_cleared' },
        at: now,
      });
      cleared += 1;
    }
  }
  return cleared;
}

export function missionTypesWithOpenWork(store: Store): MissionType[] {
  const open = store.listMissions({ status: ['queued', 'planned', 'approved', 'executing', 'paused'] });
  return [...new Set(open.map((m) => m.type))];
}
