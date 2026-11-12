/**
 * Thrust staging policy (T8).
 *
 * Pure decisions only: no I/O, no timers. Given a hull, the endurance-model
 * thrust at the current altitude, the required force and the live state, it
 * answers "may hydrogen be off, do the tanks stockpile, is this an emergency".
 *
 * Policy
 * ------
 *  - available thrust per type comes from the endurance curves
 *    (`thrustAtAltitude`, exact CubeBlocks influence data);
 *  - required force = mass * g * margin: 1.3 while climbing, 1.1 while holding;
 *  - atmosphere is used while it is effective, then ion (electric), hydrogen
 *    only for the remaining gap;
 *  - hydrogen is off exactly when the gap is zero (atmo + ion already cover the
 *    requirement). Ion is never switched off: it burns no fuel;
 *  - tanks stockpile only when parked in zero gravity and hydrogen is not
 *    needed; stockpile is off whenever hydrogen may be needed;
 *  - emergency (an UNPLANNED descent faster than 5 m/s while holding/climbing,
 *    or battery below 15 %) enables every bank and raises the alert. A
 *    controlled-fall descent is planned and does not trip it, but the brake
 *    bank is held on for the whole fall.
 *
 * Hysteresis lives in the controller: `maySwitch` refuses a flip within
 * `MIN_DWELL_MS` unless the decision is an emergency.
 */
import type { Planet } from '@se-rts/schemas';
import { gravityAtAltitude, planetGravity } from '../designer/gravity.js';
import {
  airDensity,
  thrustAtAltitude,
  HYDROGEN_ENERGY_DENSITY_MWH_PER_L,
  type EnduranceHull,
} from '../endurance/index.js';
import type { ThrusterKind } from '../endurance/definitions.js';
import type { StagingHardware } from './hardware.js';

export type StagingPhase = 'climb' | 'hold';
export type StagingMode = 'active' | 'unknown-hardware' | 'profile-pending' | 'no-telemetry' | 'stale-telemetry' | 'off' | 'manual';

/** Do not flap the banks: a non-emergency switch needs this gap between flips. */
export const MIN_DWELL_MS = 10_000;
export const CLIMB_MARGIN = 1.3;
export const HOLD_MARGIN = 1.1;
export const EMERGENCY_DESCENT_MPS = -5;
export const EMERGENCY_BATTERY_PCT = 15;

export interface StagingInput {
  phase: StagingPhase;
  /** Altitude above the planet's minimum surface radius, metres. */
  altitudeM: number;
  /** Vertical speed along the local up vector, m/s (positive = climbing). */
  verticalSpeedMps: number | null;
  /** Battery charge 0..100, or null when the plugin did not report it. */
  batteryPct: number | null;
  /** Measured grid mass; falls back to the hardware catalog value. */
  massKg: number | null;
  /**
   * A controlled-fall descent is in progress. A deliberate fall is not an
   * emergency: the ship is supposed to be descending fast with dampeners off,
   * and the braking bank must stay available for the burn.
   */
  plannedDescent?: boolean;
}

export interface StagingDecision {
  h2Enabled: boolean;
  /** 'up' only when the hardware lists up-facing hydrogen blocks and they cover the gap. */
  h2Scope: 'all' | 'up';
  stockpile: boolean;
  emergency: boolean;
  emergencyReason: string | null;
  reason: string;
  phase: StagingPhase;
  altitudeM: number;
  gravityMps2: number;
  density: number;
  margin: number;
  requiredN: number;
  availableN: Record<ThrusterKind, number>;
  /** Share of the requirement covered by each bank, percent (sums to 100 when covered). */
  coverPct: Record<ThrusterKind, number>;
  h2GapN: number;
  h2BurnLpsStaged: number;
  h2BurnLpsAllOn: number;
  /** Staged burn avoided versus leaving every bank enabled, L/s. */
  fuelSavedLps: number;
  /** Fraction of the H2 tank used per hour by the staged burn. */
  h2PctPerHour: number | null;
}

export function enduranceHullFor(hardware: StagingHardware, massKg?: number): EnduranceHull {
  return {
    id: hardware.id,
    name: hardware.name,
    gridSize: 'large',
    massKg: Math.max(1, massKg ?? hardware.massKg),
    massSource: 'measured',
    thrust: {
      atmo: { forceN: hardware.thrustN.atmo, powerMW: hardware.powerMW.atmo, count: hardware.count.atmo },
      ion: { forceN: hardware.thrustN.ion, powerMW: hardware.powerMW.ion, count: hardware.count.ion },
      h2: { forceN: hardware.thrustN.h2, powerMW: hardware.powerMW.h2, count: hardware.count.h2 },
    },
    reactorMW: 0,
    batteryMWh: hardware.batteryMWh,
    batteryOutputMW: hardware.batteryOutputMW,
    solarPeakMW: 0,
    h2CapacityL: hardware.h2TankLitres,
    h2Fill: hardware.h2Fill,
    batteryFill: hardware.batteryFill,
  };
}

/** The decision the policy would make right now. */
export function decideStaging(hardware: StagingHardware, planet: Planet, input: StagingInput): StagingDecision {
  const massKg = Math.max(1, input.massKg ?? hardware.massKg);
  const hull = enduranceHullFor(hardware, massKg);
  const gravityMps2 = gravityAtAltitude(planetGravity(planet), input.altitudeM);
  const available = thrustAtAltitude(hull, planet, input.altitudeM);
  const margin = input.phase === 'climb' ? CLIMB_MARGIN : HOLD_MARGIN;
  const requiredN = Math.max(0, massKg * gravityMps2 * margin);

  const atmoN = available.forceN.atmo;
  const ionN = available.forceN.ion;
  const h2N = available.forceN.h2;
  const gapN = Math.max(0, requiredN - atmoN - ionN);

  const emergencyReason = emergencyFor(input);
  const emergency = emergencyReason !== null;
  const plannedDescent = input.plannedDescent === true;
  // A planned fall holds every bank open: the brake burn needs the whole
  // upward bank, and switching hydrogen off mid-fall would take it away.
  const h2Enabled = emergency || plannedDescent ? h2N > 0 : gapN > 0.5 && h2N > 0;
  const stockpile =
    !emergency && !h2Enabled && hardware.h2TankLitres > 0 && gravityMps2 <= 0.001 && input.phase === 'hold';

  const h2GapN = Math.min(gapN, h2N);
  const stagedBurn = h2Enabled ? burnFor(hardware, h2GapN) : 0;
  // "All on" comparison: every bank enabled, the controller spreads the
  // requirement over the banks in proportion to their available force, so the
  // hydrogen bank carries its share even when atmo alone could do the job.
  const totalN = atmoN + ionN + h2N;
  const allOnShareN = totalN > 0 ? requiredN * (h2N / totalN) : 0;
  const allOnBurn = burnFor(hardware, Math.min(allOnShareN, h2N));

  const scope: 'all' | 'up' =
    h2Enabled && hardware.h2UpFacingNames && h2UpFacingNamesCover(hardware, h2GapN) ? 'up' : 'all';

  const cover = (forceN: number) =>
    requiredN > 0 ? Math.round(Math.min(100, (forceN / requiredN) * 100) * 10) / 10 : 0;

  const reasonParts: string[] = [];
  if (emergency) {
    reasonParts.push(`EMERGENCY (${emergencyReason}): all banks enabled`);
  } else if (requiredN <= 0.001) {
    reasonParts.push('zero gravity: no thrust required');
  } else if (h2Enabled) {
    reasonParts.push(
      `atmo ${(atmoN / 1e6).toFixed(2)} MN + ion ${(ionN / 1e6).toFixed(2)} MN below ${(requiredN / 1e6).toFixed(2)} MN; H2 fills ${(h2GapN / 1e6).toFixed(2)} MN`,
    );
  } else {
    reasonParts.push(
      `atmo ${(atmoN / 1e6).toFixed(2)} MN${ionN > 0 ? ` + ion ${(ionN / 1e6).toFixed(2)} MN` : ''} covers ${(requiredN / 1e6).toFixed(2)} MN`,
    );
  }
  if (stockpile) reasonParts.push('parked in zero-g: tanks stockpile');
  if (scope === 'up' && h2Enabled) reasonParts.push('up-facing H2 only');
  if (plannedDescent) reasonParts.push('planned descent: brake bank held on');

  const burnPerHour = stagedBurn * 3600;
  const h2PctPerHour =
    stagedBurn > 0 && hardware.h2TankLitres > 0
      ? Math.round((burnPerHour / hardware.h2TankLitres) * 1000) / 10
      : null;

  return {
    h2Enabled,
    h2Scope: scope,
    stockpile,
    emergency,
    emergencyReason,
    reason: reasonParts.join('; '),
    phase: input.phase,
    altitudeM: Math.round(input.altitudeM),
    gravityMps2: Math.round(gravityMps2 * 1000) / 1000,
    density: Math.round(available.density * 10000) / 10000,
    margin,
    requiredN: Math.round(requiredN),
    availableN: { atmo: Math.round(atmoN), ion: Math.round(ionN), h2: Math.round(h2N) },
    coverPct: {
      atmo: cover(atmoN),
      ion: cover(ionN),
      h2: requiredN > 0 ? cover(Math.max(0, requiredN - atmoN - ionN)) : 0,
    },
    h2GapN: Math.round(h2GapN),
    h2BurnLpsStaged: Math.round(stagedBurn * 10) / 10,
    h2BurnLpsAllOn: Math.round(allOnBurn * 10) / 10,
    fuelSavedLps: Math.round(Math.max(0, allOnBurn - stagedBurn) * 10) / 10,
    h2PctPerHour,
  };
}

function burnFor(hardware: StagingHardware, forceN: number): number {
  if (hardware.thrustN.h2 <= 0 || forceN <= 0) return 0;
  const throttle = Math.min(1, forceN / hardware.thrustN.h2);
  return (throttle * hardware.powerMW.h2) / HYDROGEN_ENERGY_DENSITY_MWH_PER_L;
}

function h2UpFacingNamesCover(hardware: StagingHardware, gapN: number): boolean {
  const names = hardware.h2UpFacingNames;
  if (!names || names.length === 0 || hardware.count.h2 <= 0) return false;
  const share = Math.min(1, names.length / hardware.count.h2);
  return hardware.thrustN.h2 * share >= gapN;
}

export function emergencyFor(input: StagingInput): string | null {
  if (
    input.plannedDescent !== true &&
    input.verticalSpeedMps !== null &&
    input.verticalSpeedMps < EMERGENCY_DESCENT_MPS
  ) {
    return `vertical speed ${input.verticalSpeedMps.toFixed(1)} m/s while ${input.phase === 'climb' ? 'climbing' : 'holding'}`;
  }
  if (input.batteryPct !== null && input.batteryPct < EMERGENCY_BATTERY_PCT) {
    return `battery ${input.batteryPct.toFixed(0)} % below ${EMERGENCY_BATTERY_PCT} %`;
  }
  return null;
}

/**
 * Hysteresis: a non-emergency change is allowed only after the dwell time.
 * Emergency always wins (a falling drone must not wait 10 s).
 */
export function maySwitch(args: {
  previousKey: string | null;
  nextKey: string;
  lastSwitchAt: number | null;
  now: number;
  emergency: boolean;
  minDwellMs?: number;
}): boolean {
  if (args.previousKey === null) return true;
  if (args.previousKey === args.nextKey) return false;
  if (args.emergency) return true;
  const dwell = args.minDwellMs ?? MIN_DWELL_MS;
  return args.lastSwitchAt === null || args.now - args.lastSwitchAt >= dwell;
}

/** Actuator key: only real actuator changes count as a switch. */
export function actuatorKey(decision: Pick<StagingDecision, 'h2Enabled' | 'h2Scope' | 'stockpile'>): string {
  return `${decision.h2Enabled ? 'h2' : 'noh2'}:${decision.h2Scope}:${decision.stockpile ? 'stock' : 'flow'}`;
}

/** Phases: en_route is a climb leg, holding is a hold. */
export function phaseFor(droneState: string): StagingPhase | null {
  if (droneState === 'en_route') return 'climb';
  if (droneState === 'holding') return 'hold';
  return null;
}

export { airDensity };
export type { Planet };
