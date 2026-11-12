/**
 * T29: antenna range auto-tune.
 *
 * SE scales an antenna's power sink with its configured radius, so a relay
 * left at the 50 km default burns power for a link it never uses. This module
 * computes, per node, the smallest radio radius and laser range that still
 * serves its role with a 15 % margin:
 *
 *   * backbone node: longest active link x 1.15
 *   * coverage node: the footprint radius the coverage plan needs (or the
 *     longest link x 1.15 when no footprint is supplied)
 *   * base: max range (the owner wants the best uplink; never shrink)
 *
 * Hard rule: never below a link in use. The longest active link is a floor on
 * top of the margin, and an owner pin wins over everything.
 *
 * Pure functions; applying the plan is a separate module so the rule can be
 * tested without a game.
 */
import { BLOCK_POWER, radioDrawMw } from '../power/budget.js';

export const RANGE_MARGIN = 1.15;
export const MIN_RADIO_M = 1_000;

export interface TuneLink {
  to: string;
  distanceM: number;
}

export interface TuneNodeInput {
  gridId: string;
  name: string;
  role: 'base' | 'coverage' | 'backbone';
  radioRadiusM: number | null;
  laserRangeM: number | null;
  /** Coverage footprint the plan needs at this node, metres. */
  footprintM?: number | null;
  /** Owner override: use exactly this range and never touch the block. */
  pinRadioM?: number | null;
  pinLaserM?: number | null;
  /** Hardware maximum read from the block definition (fallback: current). */
  maxRadioM?: number | null;
  maxLaserM?: number | null;
  radioLinks: TuneLink[];
  laserLinks: TuneLink[];
  /** Live draw of all radio antennas on the grid (profile.antennaDrawMw). */
  antennaDrawMw?: number | null;
  /** Live draw of all laser antennas (profile.laserDrawMw). */
  laserDrawMw?: number | null;
}

export interface TuneChange {
  nowM: number | null;
  neededM: number | null;
  deltaM: number | null;
  savedMw: number;
  action: 'shrink' | 'grow' | 'keep' | 'pinned' | 'blocked';
  reason: string;
}

export interface TuneNodePlan {
  gridId: string;
  name: string;
  role: TuneNodeInput['role'];
  radio: TuneChange;
  laser: TuneChange;
  savedMw: number;
  warnings: string[];
}

export interface TunePlan {
  generatedAt: number;
  margin: number;
  nodes: TuneNodePlan[];
  totals: { nodes: number; changed: number; savedMw: number; blocked: number };
  /** Flat list of the block writes an apply would perform. */
  changes: { gridId: string; kind: 'radio'; fromM: number; toM: number }[];
  labels: ['SIMULATED'];
  note: string;
}

export function longestLink(links: TuneLink[]): number {
  return links.reduce((max, link) => (Number.isFinite(link.distanceM) ? Math.max(max, link.distanceM) : max), 0);
}

function savedFor(nowM: number | null, neededM: number | null, antennaDrawMw: number | null | undefined): number {
  if (nowM === null || neededM === null || nowM <= 0 || neededM >= nowM) return 0;
  // Calibrate to the live draw when the profile reported it: that is the real
  // sink at the sampled radius. Fall back to the documented linear model.
  const nowDraw = antennaDrawMw !== null && antennaDrawMw !== undefined && antennaDrawMw > 0
    ? antennaDrawMw
    : radioDrawMw(nowM);
  const after = (nowDraw / nowM) * neededM;
  return round(Math.max(0, nowDraw - after), 3);
}

export function tuneNode(input: TuneNodeInput): TuneNodePlan {
  const warnings: string[] = [];
  const radioLinks = input.radioLinks.filter((l) => l.distanceM > 0);
  const laserLinks = input.laserLinks.filter((l) => l.distanceM > 0);
  const longestRadio = longestLink(radioLinks);
  const longestLaser = longestLink(laserLinks);
  const nowRadio = input.radioRadiusM;
  const nowLaser = input.laserRangeM;
  const maxRadio = input.maxRadioM ?? nowRadio ?? 50_000;

  // ---- radio ---------------------------------------------------------------
  let neededRadio: number | null;
  let action: TuneChange['action'];
  let reason: string;
  if (input.pinRadioM !== null && input.pinRadioM !== undefined && input.pinRadioM > 0) {
    neededRadio = input.pinRadioM;
    action = 'pinned';
    reason = `owner pin: keep exactly ${Math.round(neededRadio / 1000)} km`;
  } else if (input.role === 'base') {
    neededRadio = maxRadio;
    action = 'keep';
    reason = `base: keep max range ${Math.round(maxRadio / 1000)} km`;
  } else if (input.footprintM !== null && input.footprintM !== undefined && input.footprintM > 0) {
    neededRadio = Math.max(input.footprintM, longestRadio * RANGE_MARGIN);
    action = nowRadio === null ? 'grow' : neededRadio < nowRadio - 500 ? 'shrink' : 'keep';
    reason = `coverage: keep the ${(input.footprintM / 1000).toFixed(1)} km footprint` +
      (longestRadio > 0 ? `, longest link ${(longestRadio / 1000).toFixed(1)} km` : '');
  } else if (longestRadio > 0) {
    neededRadio = longestRadio * RANGE_MARGIN;
    action = nowRadio === null ? 'grow' : neededRadio < nowRadio - 500 ? 'shrink' : 'keep';
    reason = `backbone: longest active link ${(longestRadio / 1000).toFixed(1)} km x ${RANGE_MARGIN}`;
  } else if (nowRadio !== null) {
    neededRadio = nowRadio;
    action = 'keep';
    reason = 'no active radio link: keep the current radius';
  } else {
    neededRadio = null;
    action = 'keep';
    reason = 'no antenna on this grid';
  }

  if (neededRadio !== null) neededRadio = Math.max(MIN_RADIO_M, neededRadio);
  // Hard floor: a link in use can never fall outside the tuned radius.
  if (neededRadio !== null && longestRadio > 0 && neededRadio < longestRadio) {
    neededRadio = longestRadio * RANGE_MARGIN;
    action = 'blocked';
    reason = 'link in use is longer than the plan: clamped to the link + margin';
    warnings.push('clamped to the longest link in use');
  }
  if (neededRadio !== null && neededRadio > maxRadio * 1.0001) {
    warnings.push(`needed ${(neededRadio / 1000).toFixed(1)} km exceeds the antenna maximum ${(maxRadio / 1000).toFixed(1)} km`);
    neededRadio = maxRadio;
    action = 'blocked';
  }

  const radio: TuneChange = {
    nowM: nowRadio,
    neededM: neededRadio === null ? null : Math.round(neededRadio),
    deltaM: neededRadio !== null && nowRadio !== null ? Math.round(neededRadio - nowRadio) : null,
    savedMw: savedFor(nowRadio, neededRadio, input.antennaDrawMw),
    action,
    reason,
  };

  // ---- laser ---------------------------------------------------------------
  let neededLaser: number | null;
  let laserAction: TuneChange['action'];
  let laserReason: string;
  if (input.pinLaserM !== null && input.pinLaserM !== undefined && input.pinLaserM > 0) {
    neededLaser = input.pinLaserM;
    laserAction = 'pinned';
    laserReason = `owner pin: keep exactly ${(neededLaser / 1000).toFixed(1)} km`;
  } else if (longestLaser > 0) {
    neededLaser = longestLaser * RANGE_MARGIN;
    laserAction = nowLaser === null ? 'grow' : neededLaser < nowLaser - 500 ? 'shrink' : 'keep';
    laserReason = `laser link ${(longestLaser / 1000).toFixed(1)} km x ${RANGE_MARGIN}`;
  } else if (nowLaser !== null) {
    neededLaser = nowLaser;
    laserAction = 'keep';
    laserReason = 'no active laser link: keep the current range';
  } else {
    neededLaser = null;
    laserAction = 'keep';
    laserReason = 'no laser antenna on this grid';
  }
  const maxLaser = input.maxLaserM ?? 100_000;
  if (neededLaser !== null && neededLaser > maxLaser) {
    warnings.push(`laser needs ${(neededLaser / 1000).toFixed(1)} km, above the ${(maxLaser / 1000).toFixed(0)} km model cap`);
    neededLaser = maxLaser;
    laserAction = 'blocked';
  }
  const laser: TuneChange = {
    nowM: nowLaser,
    neededM: neededLaser === null ? null : Math.round(neededLaser),
    deltaM: neededLaser !== null && nowLaser !== null ? Math.round(neededLaser - nowLaser) : null,
    // The laser definition draws by state (idle/turning/lasing), not by range,
    // so shrinking a laser saves nothing. Reported as 0 instead of inventing it.
    savedMw: 0,
    action: laserAction,
    reason: laserReason,
  };

  return {
    gridId: input.gridId,
    name: input.name,
    role: input.role,
    radio,
    laser,
    savedMw: round(radio.savedMw + laser.savedMw, 3),
    warnings,
  };
}

export function tunePlan(nodes: TuneNodeInput[], now: number): TunePlan {
  const plans = nodes.map(tuneNode);
  const changes = plans
    .filter((p) => p.radio.action === 'shrink' || p.radio.action === 'grow')
    .filter((p) => p.radio.nowM !== null && p.radio.neededM !== null)
    .map((p) => ({ gridId: p.gridId, kind: 'radio' as const, fromM: p.radio.nowM!, toM: p.radio.neededM! }))
    // Ignore sub-500 m changes: below the block's useful resolution.
    .filter((c) => Math.abs(c.toM - c.fromM) >= 500);
  const savedMw = round(plans.reduce((sum, p) => sum + p.savedMw, 0), 3);
  return {
    generatedAt: now,
    margin: RANGE_MARGIN,
    nodes: plans,
    totals: {
      nodes: plans.length,
      changed: changes.length,
      savedMw,
      blocked: plans.filter((p) => p.radio.action === 'blocked' || p.laser.action === 'blocked').length,
    },
    changes,
    labels: ['SIMULATED'],
    note:
      'radio savings are calibrated to the live profile antennaDrawMw (linear radius model); laser draw is state-based so a laser shrink saves 0 MW',
  };
}

/** MWh per day a saved continuous draw represents. */
export function savedMWhPerDay(savedMw: number): number {
  return round((savedMw * 24), 3);
}

export const TUNE_MODEL = {
  radioMwPerKm: BLOCK_POWER.radioMwPerKm,
  margin: RANGE_MARGIN,
} as const;

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
