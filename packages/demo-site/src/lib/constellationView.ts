/**
 * Constellation panel view model (T51.9, T52, T53).
 *
 * Pure functions only, so every claim the panel makes is testable without a
 * browser: how many ships Apply moves and which ones (T51.9a), whether Apply
 * must be disabled and why (T51.9b), the per-member cost line (T51.9c) and the
 * movement-vs-gain comparison (T51.9d).
 *
 * The labels are part of the contract: a coverage number is SIMULATED unless
 * the response says it came from telemetry, and a missing terrain field is
 * stated next to the number, never hidden behind it (T51.3).
 */
import type { DesignerOption } from './designer';
import type { MemberEstimate } from './constellation';
import { MIN_APPLY_COVERAGE_PCT, groundReachM } from './constellation';
import type { OptimisePlan } from './optimise';

export interface PlannedShip {
  gridId: string;
  name: string;
  /** metres the move costs; null when the planner did not move it. */
  distanceM: number | null;
}

export interface ApplyPlan {
  /** Exactly what Apply sends: the number of ships moved. */
  count: number;
  ships: PlannedShip[];
  /** Group members the plan does not need: they stay where they are. */
  staying: { gridId: string; name: string; reason: string }[];
  source: 'optimiser' | 'plan';
}

const STILL = 'no planned slot to fill (stays put)';

/** Build the per-member estimate list from optimiser moves (T51.9c). */
export function memberEstimatesFromMoves(
  moves: OptimisePlan['moves'],
  names: Record<string, string> = {},
): MemberEstimate[] {
  return moves.map((move) => ({
    id: move.gridId,
    name: names[move.gridId] ?? move.name ?? move.gridId.replace(/^grid:/, '').slice(0, 12),
    distanceM: move.distanceM,
    etaS: move.etaS,
    h2L: typeof move.fuel?.h2L === 'number' ? move.fuel.h2L : null,
    batteryMWh: typeof move.fuel?.batteryMWh === 'number' ? move.fuel.batteryMWh : null,
    altitudeChangeM: move.altitudeChangeM ?? move.to.altitudeM - move.from.altitudeM,
    reason: move.reason,
  }));
}

/**
 * T51.9a: Apply moves exactly the planned count, chosen by the backend's own
 * assignment (optimiser moves for optimise plans, the plan's sorted
 * assignment for pattern plans). Never every member.
 */
export function decidePlannedShips(args: {
  members: { id: string; name?: string }[];
  optimise: OptimisePlan | null;
  option: DesignerOption | null;
  names?: Record<string, string>;
}): ApplyPlan {
  const { members, optimise, option } = args;
  const names = args.names ?? {};
  const label = (id: string, fallback?: string) => names[id] ?? fallback ?? id.replace(/^grid:/, '').slice(0, 12);
  const memberIds = members.map((m) => m.id);

  if (optimise && optimise.moves.length > 0) {
    const moves = optimise.moves.slice().sort((a, b) => a.distanceM - b.distanceM);
    const chosen = moves
      .filter((move) => memberIds.length === 0 || memberIds.includes(move.gridId))
      .map((move) => ({ gridId: move.gridId, name: label(move.gridId, move.name), distanceM: move.distanceM }));
    const used = new Set(chosen.map((ship) => ship.gridId));
    const staying = members
      .filter((member) => !used.has(member.id))
      .map((member) => {
        const why = optimise.staying.find((entry) => entry.gridId === member.id)?.reason ?? STILL;
        return { gridId: member.id, name: label(member.id, member.name), reason: why };
      });
    return { count: chosen.length, ships: chosen, staying, source: 'optimiser' };
  }

  // Pattern/cover-plan fallback: the plan's assignment names the grid per slot.
  const assignment = (option as (DesignerOption & { assignment?: { assignments?: { gridId?: string | null; slotId: string }[] } }) | null)
    ?.assignment?.assignments;
  if (option && assignment && assignment.length > 0) {
    const ships: PlannedShip[] = [];
    const used = new Set<string>();
    for (const entry of assignment) {
      const gridId = entry.gridId ?? null;
      if (!gridId || used.has(gridId)) continue;
      if (memberIds.length > 0 && !memberIds.includes(gridId)) continue;
      used.add(gridId);
      ships.push({ gridId, name: label(gridId), distanceM: null });
    }
    const staying = members
      .filter((member) => !used.has(member.id))
      .map((member) => ({ gridId: member.id, name: label(member.id, member.name), reason: STILL }));
    return { count: ships.length, ships, staying, source: 'plan' };
  }

  // No assignment to trust: the planner's own count of slots, taken from the
  // first members in a stable order — and the label says exactly that many.
  const planned = option
    ? (typeof option.countUsed === 'number' ? option.countUsed : typeof option.countNeeded === 'number' ? option.countNeeded : option.positions.length)
    : 0;
  const ships = members.slice(0, Math.max(0, planned)).map((member) => ({
    gridId: member.id,
    name: label(member.id, member.name),
    distanceM: null,
  }));
  const staying = members
    .slice(ships.length)
    .map((member) => ({ gridId: member.id, name: label(member.id, member.name), reason: STILL }));
  return { count: ships.length, ships, staying, source: 'plan' };
}

export interface ApplyGuardInput {
  members: number;
  planet: boolean;
  hull: boolean;
  overLimit: boolean;
  planning: boolean;
  planError: string | null;
  /** Simulated coverage of the proposed layout, percent (null = unknown). */
  coveragePct: number | null;
  manualAltitudeM: number | null;
  radioRangeM: number | null;
  surfaceRadiusM: number | null;
  relayOnly: boolean;
}

export interface ApplyGuard {
  disabled: boolean;
  reason: string | null;
}

/**
 * T51.9b: a 0 % plan is not applyable. Apply is disabled with a visible reason
 * when the simulated coverage is below the floor or a manual altitude is above
 * the radio's horizon-limited ground reach — unless the operator ticked the
 * explicit "relay-only, no ground coverage" intent.
 */
export function applyGuard(input: ApplyGuardInput): ApplyGuard {
  if (input.planning) return { disabled: true, reason: 'Planning…' };
  if (input.planError) return { disabled: true, reason: input.planError };
  if (input.members === 0) return { disabled: true, reason: 'This group has no live members.' };
  if (!input.planet) return { disabled: true, reason: 'Pick a planet first.' };
  if (!input.hull) return { disabled: true, reason: 'No hull profile matched this group.' };
  if (input.overLimit) return { disabled: true, reason: 'Too many members for one mission.' };
  if (input.relayOnly) return { disabled: false, reason: 'RELAY-ONLY: ships are positioned for links, not ground coverage.' };
  if (input.coveragePct !== null && input.coveragePct < MIN_APPLY_COVERAGE_PCT) {
    return {
      disabled: true,
      reason: `Coverage is ${input.coveragePct.toFixed(1)}% (floor ${MIN_APPLY_COVERAGE_PCT}%): tick relay-only to apply anyway.`,
    };
  }
  if (
    input.manualAltitudeM !== null &&
    input.radioRangeM !== null &&
    input.surfaceRadiusM !== null &&
    input.radioRangeM > 0
  ) {
    const reach = groundReachM(input.surfaceRadiusM, input.manualAltitudeM, input.radioRangeM);
    if (reach < 1) {
      return {
        disabled: true,
        reason: `Manual altitude ${(input.manualAltitudeM / 1000).toFixed(1)} km is above the ${(input.radioRangeM / 1000).toFixed(0)} km radio's ground reach: tick relay-only to apply anyway.`,
      };
    }
  }
  return { disabled: false, reason: null };
}

/** One labelled coverage figure; SIMULATED unless the payload says GAME. */
export interface CoverageNumber {
  pct: number;
  label: 'SIMULATED' | 'GAME';
  terrainNote: string | null;
}

export function coverageNumber(
  pct: number | null | undefined,
  terrain: 'corrected' | 'unavailable' | 'none' | undefined,
  reason: string | null | undefined,
  labels: string[] | undefined,
): CoverageNumber | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const label = labels?.includes('GAME') ? 'GAME' : 'SIMULATED';
  const terrainNote =
    terrain === 'unavailable'
      ? `terrain unavailable${reason ? ` (${reason})` : ''}`
      : terrain === 'corrected'
        ? 'terrain-corrected'
        : null;
  return { pct: Math.round(pct * 10) / 10, label, terrainNote };
}

export function formatCoverage(coverage: CoverageNumber | null): string {
  if (!coverage) return 'n/a';
  return `${coverage.pct.toFixed(1)}% · ${coverage.label}${coverage.terrainNote ? ` · ${coverage.terrainNote}` : ''}`;
}

/** One line per alternative: ships / H2 / MW / coverage. */
export function alternativeLines(
  alternatives: DesignerOption['alternatives'] | null | undefined,
): string[] {
  return (alternatives ?? []).map((alt) => {
    const range =
      alt.altitudeRangeM && alt.altitudeRangeM[0] !== alt.altitudeRangeM[1]
        ? `${(alt.altitudeRangeM[0] / 1000).toFixed(1)}–${(alt.altitudeRangeM[1] / 1000).toFixed(1)} km`
        : alt.altitudeRangeM
          ? `${(alt.altitudeRangeM[0] / 1000).toFixed(1)} km`
          : 'mixed';
    const terrain = alt.terrain === 'unavailable' ? ' · terrain unavailable' : '';
    return `${alt.label}: ${alt.ships} ships, ${alt.coveragePct.toFixed(1)}% cover, ${alt.h2L.toFixed(1)} L H2, ${alt.antennaMW.toFixed(2)} MW, ${range} · SIMULATED${terrain}`;
  });
}

/** A per-slot readout in plain words, from the response only. */
export function slotLines(option: DesignerOption | null): string[] {
  if (!option) return [];
  const altitudes = option.slotAltitudes ?? option.goal?.slots?.map((slot) => ({
    id: slot.id,
    altitudeM: slot.altitudeM,
    groundRadiusM: slot.footprintRadiusM,
    radioRadiusM: slot.radioRadiusM,
    role: slot.role,
  })) ?? [];
  return altitudes.map(
    (slot) =>
      `${slot.id} · ${(slot.altitudeM / 1000).toFixed(1)} km · ground ${(slot.groundRadiusM / 1000).toFixed(1)} km · radio ${(slot.radioRadiusM / 1000).toFixed(1)} km`,
  );
}

/** The count readout: AUTO names the solver's number. */
export function countLabel(count: number | null, countNeeded: number | null | undefined): string {
  if (count !== null) return `${count}`;
  return typeof countNeeded === 'number' ? `Auto (${countNeeded})` : 'Auto';
}
