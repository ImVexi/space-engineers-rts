/**
 * T10: assign existing owner-tagged drones to planned slots.
 *
 * The assignment is a greedy nearest-pair matching (globally sorted by
 * distance, ties broken deterministically by grid id then slot id). It is not
 * optimal in the Hungarian sense, but it never picks a remote drone while a
 * closer free pair exists, and the response reports the distance of every
 * chosen pair so the owner can see what was decided.
 *
 * Endurance preflight runs per assigned grid (the owner's satellites have
 * different mass/fuel), using the same model as the option planner. A proven
 * failure refuses only that grid; the rest of the launch proceeds. When the
 * plugin profile has no tank/power state the verdict is `unverified` instead
 * of a fabricated pass or fail.
 */
import type { Planet } from '@se-rts/schemas';
import { hullForDesigner, preflightLaunch, type DesignerEndurance } from '../endurance/index.js';
import type { DesignerHull } from './hulls.js';

/** Owner identity on the test server (owner). Provisioned grids are owned by it. */
export const OWNER_IDENTITY_ID = '144115188075855926';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AssignableGrid {
  gridId: string;
  name: string;
  position: Vec3;
}

export interface AssignableSlot {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface SlotAssignment {
  gridId: string;
  gridName: string;
  slotId: string;
  slotIndex: number;
  distanceM: number;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Greedy nearest-pair assignment: every (grid, slot) pair sorted by distance,
 * take a pair when both ends are still free. Returns one entry per assigned
 * grid ordered by slot index; grids with no free slot are dropped (the caller
 * reports them as unused).
 */
export function assignGridsToSlots(grids: AssignableGrid[], slots: AssignableSlot[]): SlotAssignment[] {
  const pairs: { grid: AssignableGrid; slot: AssignableSlot; slotIndex: number; distanceM: number }[] = [];
  slots.forEach((slot, slotIndex) => {
    for (const grid of grids) {
      pairs.push({ grid, slot, slotIndex, distanceM: dist(grid.position, slot) });
    }
  });
  pairs.sort(
    (a, b) =>
      a.distanceM - b.distanceM ||
      a.grid.gridId.localeCompare(b.grid.gridId) ||
      a.slotIndex - b.slotIndex,
  );
  const usedGrids = new Set<string>();
  const usedSlots = new Set<string>();
  const out: SlotAssignment[] = [];
  for (const pair of pairs) {
    if (usedGrids.has(pair.grid.gridId) || usedSlots.has(pair.slot.id)) continue;
    usedGrids.add(pair.grid.gridId);
    usedSlots.add(pair.slot.id);
    out.push({
      gridId: pair.grid.gridId,
      gridName: pair.grid.name,
      slotId: pair.slot.id,
      slotIndex: pair.slotIndex,
      distanceM: Math.round(pair.distanceM),
    });
    if (usedGrids.size === Math.min(grids.length, slots.length)) break;
  }
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

export type PreflightStatus = 'ok' | 'refused' | 'unverified';

export interface GridPreflight {
  status: PreflightStatus;
  /** Stable machine code for the verdict ('ok', 'hydrogen_empty', …). */
  code: string;
  canReachSlot: boolean | null;
  reason: string | null;
  hint: string;
  reservePct: number | null;
  requiredReservePct: number;
  altitudeM: number;
  holdEnduranceText: string | null;
  labels: string[];
}

export interface GridPreflightArgs {
  hull: DesignerHull;
  planet: Planet;
  slot: Vec3;
  gridPosition: Vec3;
  requiredReservePct: number;
  /** Live hydrogen fraction from telemetry (0..1), null when unknown. */
  liveFuelPct?: number | null;
}

/**
 * Per-grid launch-in-place preflight.
 *
 * The endurance model's `orbital` launch starts at 40 km; an existing
 * satellite below that still has to climb, so the pass is conservative on the
 * ascent leg and exact on the transit leg (grid position -> slot). When the
 * model is unavailable the verdict is `unverified`, except for one case the
 * live telemetry proves on its own: 0 % hydrogen with no ion bank cannot climb
 * out of the atmosphere.
 */
export function preflightGridLaunch(args: GridPreflightArgs): GridPreflight {
  const { hull, planet, slot, gridPosition, requiredReservePct } = args;
  const center = planet.center;
  const altitudeM = Math.max(
    0,
    Math.round(Math.hypot(slot.x - center.x, slot.y - center.y, slot.z - center.z) - planet.surfaceRadiusM),
  );
  const transitM = Math.round(dist(gridPosition, slot));
  const adapted: DesignerEndurance = hullForDesigner(hull);
  if (!adapted.hull) {
    if (args.liveFuelPct !== null && args.liveFuelPct !== undefined && args.liveFuelPct <= 0.001 && hull.thrust.ion === 0) {
      return {
        status: 'refused',
        code: 'hydrogen_empty',
        canReachSlot: false,
        reason:
          'live telemetry reports 0 % hydrogen and the hull has no ion thrust, so it cannot climb from its current position to the slot',
        hint: 'Refuel the ship, or assign a different drone to this slot.',
        reservePct: 0,
        requiredReservePct,
        altitudeM,
        holdEnduranceText: null,
        labels: ['SIMULATED', 'ENDURANCE-MODEL', 'IN-PLACE'],
      };
    }
    return {
      status: 'unverified',
      code: 'endurance_model_unavailable',
      canReachSlot: null,
      reason: adapted.reason,
      hint: 'The plugin profile has no tank/power state. Check the profile (or refuel the grid) before relying on the endurance pass.',
      reservePct: null,
      requiredReservePct,
      altitudeM,
      holdEnduranceText: null,
      labels: ['SIMULATED', 'ENDURANCE-UNVERIFIED', 'IN-PLACE'],
    };
  }
  const gate = preflightLaunch({
    hull: adapted.hull,
    planet,
    altitudeM,
    transitDistanceM: transitM,
    launch: 'orbital',
    requiredReservePct,
  });
  return {
    status: gate.ok ? 'ok' : 'refused',
    code: gate.ok ? 'ok' : 'endurance_refused',
    canReachSlot: gate.report.canReachSlot,
    reason: gate.reason,
    hint: gate.ok
      ? 'No action needed: the ship can reach the slot with the required reserve.'
      : 'Pick a closer slot, raise the launch reserve, or refuel the ship.',
    reservePct: gate.reservePct,
    requiredReservePct,
    altitudeM,
    holdEnduranceText: gate.report.holdEnduranceText,
    labels: ['SIMULATED', 'ENDURANCE-MODEL', 'IN-PLACE'],
  };
}
