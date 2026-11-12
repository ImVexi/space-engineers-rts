import type { Mission, MissionStatus, MissionType } from '@se-rts/schemas';

/**
 * Hard rules encoded here (never weaken):
 *  - approval defaults to 'approve';
 *  - 'auto' is honoured only for mission types an operator explicitly listed;
 *  - repair/replacement outranks new builds;
 *  - queued builds are hard-capped.
 */

export const BUILD_MISSION_TYPES: MissionType[] = ['build_deploy', 'replace'];
export const PRIORITY_MISSION_TYPES: MissionType[] = ['repair', 'replace'];

export function isBuildMission(type: MissionType): boolean {
  return BUILD_MISSION_TYPES.includes(type);
}

export function isPriorityMission(type: MissionType): boolean {
  return PRIORITY_MISSION_TYPES.includes(type);
}

export interface ApprovalDecision {
  approval: 'approve' | 'auto';
  /** True when an `auto` request was downgraded because the type is not allowed. */
  coerced: boolean;
}

export function resolveApproval(
  requested: 'approve' | 'auto' | undefined,
  type: MissionType,
  autoMissionTypes: readonly string[],
): ApprovalDecision {
  if (requested !== 'auto') return { approval: 'approve', coerced: false };
  if (autoMissionTypes.includes(type)) return { approval: 'auto', coerced: false };
  // An LLM or client cannot grant itself autonomy; only config can.
  return { approval: 'approve', coerced: true };
}

export function initialStatus(approval: 'approve' | 'auto'): MissionStatus {
  return approval === 'auto' ? 'approved' : 'queued';
}

/** Legal operator-driven status transitions (approve/cancel only for now). */
const ALLOWED_TRANSITIONS: Partial<Record<MissionStatus, MissionStatus[]>> = {
  queued: ['approved', 'cancelled'],
  planned: ['approved', 'cancelled'],
  approved: ['cancelled', 'executing', 'paused'],
  executing: ['cancelled', 'paused', 'done', 'failed'],
  paused: ['approved', 'cancelled', 'failed'],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function missionSummary(missions: Mission[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of missions) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}
