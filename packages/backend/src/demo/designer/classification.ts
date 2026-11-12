/**
 * Hull classification v2 (T22).
 *
 * Everything is derived from the hull's measured profile (prefab survey or the
 * live plugin profile), plus the two measured tier facts:
 *
 *   * atmospheric thrust is ~0 above ~10 km AGL on EarthLike (density), so an
 *     ATMO_RELAY is eligible for the atmo tier only;
 *   * hydrogen works at any altitude but burns fuel;
 *   * ion is weak in air and usable from ~45 km AGL (or anywhere when carried).
 *
 * A station (`IsStatic`) holds anywhere for free (T18), so any grid can *hold*
 * at any tier — the tier eligibility below describes how the hull can *get
 * there* and hover, not whether the position is physically possible.
 */
import type { DesignerHull, ThrustPerDirection } from './hulls.js';

export type HullRole =
  | 'radio-relay'
  | 'laser-leaf'
  | 'laser-relay'
  | 'laser-hub'
  | 'converter'
  | 'ground-laser-rover';

export type HullTier = 'atmo' | 'in-gravity' | 'zero-g' | 'ground';

/** Measured: atmo effectiveness reaches 0 above the ~10 km scale height. */
export const ATMO_CEILING_M = 10_000;
/** Measured/policy: an ion-only hull is usable from 45 km AGL (zero-g edge 43.7). */
export const ION_MIN_ALTITUDE_M = 45_000;
/** BASE-01 sits ~1.8 km above the mean surface. */
export const BASE_ALTITUDE_M = 1_800;

/**
 * Measured flight-mode overrides. A hull whose profile has no per-direction
 * thrust envelope but whose behaviour was measured in game.
 */
const MEASURED_FLIGHT_MODES: Record<string, { mode: 'level'; note: string }> = {
  'SAT-R-0001': {
    mode: 'level',
    note: 'measured 2026-11-09 (T24): lift-only atmo bank (12 flat atmo thrusters, no H2/ion); must stay level, autopilot would tip it',
  },
};

export interface HullCapability {
  hullId: string;
  name: string;
  source: DesignerHull['source'];
  gridSize: DesignerHull['gridSize'];
  radioRangeM: number | null;
  laserPorts: number;
  laserRangeM: number | null;
  /** Which thrust types exist on the hull. */
  tierEligibility: { atmo: boolean; h2: boolean; ion: boolean };
  ceilings: {
    /** Highest altitude atmo thrust can hold (measured scale height). */
    atmoM: number;
    /** H2 has no altitude ceiling; null means unlimited. */
    h2M: number | null;
    /** Lowest altitude ion can hold in air. */
    ionFloorM: number;
  };
  /** Any grid can become a station: `IsStatic` holds anywhere for free. */
  stationCapable: boolean;
  /** True when the hull cannot lift itself off the ground (station/rover only). */
  stationOnly: boolean;
  /** Altitude above which the hull must be carried by another ship. */
  carriedAboveM: number | null;
  /** Highest altitude the hull can reach and hold on its own (Infinity = any). */
  selfDeployMaxM: number;
  canHoverInGravity: boolean;
  roles: HullRole[];
  flightMode: 'autopilot' | 'level';
  liftDominant: boolean;
  thrustPerDirection: ThrustPerDirection | null;
  /** UI labels, e.g. "atmo (hover, power) / space (free hold)". */
  tierLabels: string[];
  massKg: number | null;
  /** Lower is cheaper/smaller; used only for deterministic tie-breaking. */
  costRank: number;
  costLabel: 'small' | 'large' | 'unknown';
  notes: string[];
}

function hasLiftDirection(envelope: ThrustPerDirection): boolean {
  const up = envelope.upN;
  const lateral = Math.max(envelope.fwdN, envelope.backN) + Math.max(envelope.leftN, envelope.rightN);
  return up > 0 && (envelope.downN < up * 0.25 || lateral < up * 0.25);
}

export interface ClassifyOptions {
  /** Planet-specific atmo ceiling if a lower one was measured; default 10 km. */
  atmoCeilingM?: number;
}

export function classifyHull(hull: DesignerHull, options: ClassifyOptions = {}): HullCapability {
  const atmoCeilingM = Math.min(ATMO_CEILING_M, options.atmoCeilingM ?? ATMO_CEILING_M);
  const hasN = (value: number | undefined): boolean => typeof value === 'number' && value > 0;
  const tierEligibility = {
    atmo: hasN(hull.thrust.atmo),
    h2: hasN(hull.thrust.h2),
    ion: hasN(hull.thrust.ion),
  };
  const roles: HullRole[] = [];
  if ((hull.radioRangeM ?? 0) > 0) roles.push('radio-relay');
  if (hull.laserCount >= 3) roles.push('laser-hub');
  else if (hull.laserCount === 2) roles.push('laser-relay');
  else if (hull.laserCount === 1) roles.push('laser-leaf');
  if (hull.laserCount === 1 && (hull.radioRangeM ?? 0) > 0) roles.push('converter');
  const canHoverInGravity = tierEligibility.atmo || tierEligibility.h2;
  if (hull.laserCount > 0 && !canHoverInGravity) roles.push('ground-laser-rover');

  const measured = MEASURED_FLIGHT_MODES[hull.name] ?? null;
  const envelope = hull.thrustPerDirection ?? null;
  const liftDominant = envelope
    ? hasLiftDirection(envelope)
    : measured !== null || hull.flightMode === 'level';
  const flightMode: 'autopilot' | 'level' =
    hull.flightMode === 'level' || hull.flightMode === 'autopilot'
      ? hull.flightMode
      : liftDominant
        ? 'level'
        : 'autopilot';

  const stationOnly = !tierEligibility.atmo && !tierEligibility.h2 && !tierEligibility.ion;
  const selfDeployMaxM = tierEligibility.h2
    ? Number.POSITIVE_INFINITY
    : tierEligibility.atmo
      ? atmoCeilingM
      : tierEligibility.ion
        ? Number.POSITIVE_INFINITY
        : 0;
  const carriedAboveM = stationOnly ? 0 : tierEligibility.h2 ? null : atmoCeilingM;

  const notes: string[] = [];
  if (measured) notes.push(measured.note);
  if (!envelope && !measured && hull.flightMode !== 'level' && hull.flightMode !== 'autopilot') {
    notes.push('thrust per direction is not measured: autopilot assumed, verify with a hover test before flying this hull in level mode');
  }
  if (tierEligibility.atmo && !tierEligibility.h2 && !tierEligibility.ion) {
    notes.push(`atmo-only hull: eligible up to ${(atmoCeilingM / 1000).toFixed(0)} km; above that it must be carried and stationed`);
  }
  if (tierEligibility.ion && !tierEligibility.atmo && !tierEligibility.h2) {
    notes.push(`ion-only hull: usable from ${(ION_MIN_ALTITUDE_M / 1000).toFixed(0)} km (orbital spawn) or carried; it cannot lift off in air`);
  }
  if (stationOnly) notes.push('no thrust at all: a stationary grid or a ground rover, never a self-deploying relay');
  if ((hull.radioRangeM ?? 0) === 0) notes.push('no radio antenna: this hull cannot be a radio relay');

  const tierLabels: string[] = [];
  if (tierEligibility.atmo) tierLabels.push(`atmo (hover, power, <=${(atmoCeilingM / 1000).toFixed(0)} km)`);
  if (tierEligibility.h2) tierLabels.push('space (H2, any altitude, fuel)');
  if (tierEligibility.ion) tierLabels.push(`space (ion, >=${(ION_MIN_ALTITUDE_M / 1000).toFixed(0)} km)`);
  tierLabels.push('station (free hold, any altitude, T18)');

  const costRank =
    (hull.gridSize === 'small' ? 0 : hull.gridSize === 'large' ? 1_000_000 : 500_000) + (hull.massKg ?? 0);

  return {
    hullId: hull.id,
    name: hull.name,
    source: hull.source,
    gridSize: hull.gridSize,
    radioRangeM: hull.radioRangeM,
    laserPorts: hull.laserCount,
    laserRangeM: hull.laserRangeM ?? null,
    tierEligibility,
    ceilings: { atmoM: atmoCeilingM, h2M: null, ionFloorM: ION_MIN_ALTITUDE_M },
    stationCapable: true,
    stationOnly,
    carriedAboveM,
    selfDeployMaxM,
    canHoverInGravity,
    roles,
    flightMode,
    liftDominant,
    thrustPerDirection: envelope,
    tierLabels,
    massKg: hull.massKg,
    costRank,
    costLabel: hull.gridSize ?? 'unknown',
    notes,
  };
}

/** Classify every hull and return the same order (deterministic). */
export function classifyHulls(hulls: DesignerHull[], options: ClassifyOptions = {}): HullCapability[] {
  return hulls.map((hull) => classifyHull(hull, options));
}

/** Tier of a slot at `altitudeM` given the planet's zero-g edge. */
export function tierAtAltitude(altitudeM: number, zeroGAltitudeM: number): HullTier {
  if (altitudeM <= 1) return 'ground';
  if (zeroGAltitudeM > 0 && altitudeM >= zeroGAltitudeM) return 'zero-g';
  if (altitudeM <= ATMO_CEILING_M) return 'atmo';
  return 'in-gravity';
}

/** Short role summary used in the per-assignment `why` line. */
export function roleSummary(cap: HullCapability): string {
  const primary = cap.roles.find((role) => role !== 'radio-relay' && role !== 'converter') ?? cap.roles[0] ?? 'none';
  const parts = [`role ${primary}`];
  parts.push(`radio ${cap.radioRangeM === null ? 'none' : `${(cap.radioRangeM / 1000).toFixed(0)} km`}`);
  if (cap.laserPorts > 0) parts.push(`${cap.laserPorts} laser port(s)`);
  parts.push(`flight ${cap.flightMode}`);
  return parts.join(', ');
}
