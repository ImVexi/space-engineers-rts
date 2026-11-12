/**
 * Flight profile for one leg (contract §3).
 *
 * The old executor sent a move, then re-sent it every time the guard verdict
 * changed by a tenth of a m/s, and always flew with dampeners on. In vacuum
 * that means the autopilot continuously thrusts against its own speed limit,
 * which is slow and burns hydrogen the whole way. A leg is better flown as:
 *
 *   burn to v_cruise -> coast (dampeners OFF) -> brake at v²/(2a)
 *
 * `computeLegProfile` is pure maths over measured hardware (mass, thrust split,
 * fuel fraction) and the planet model (gravity, atmosphere). The executor uses
 * the returned speed for the ONE move it sends, flips dampeners for vacuum
 * cruise and flips them back inside the last 100 m.
 *
 * Numbers are SIMULATED; the executor records predicted vs actual in the audit
 * and mission notes so the model can be checked against the game.
 */
import type { Planet } from '@se-rts/schemas';
import type { ThrustSplit } from './safety.js';
import { BRAKE_MARGIN, DEFAULT_SPEED_LIMIT_MPS, GROUND_GUARD_ALT_M, safeApproachSpeedMps } from './safety.js';
import { HYDROGEN_ENERGY_DENSITY_MWH_PER_L } from './endurance/definitions.js';
import { airDensity, effectiveness, hasAtmosphere as planetHasAtmosphere } from './endurance/model.js';
import { gravityAtAltitude, planetGravity } from './designer/gravity.js';

export interface FlightHardware {
  /** Measured grid mass, kg. */
  massKg: number;
  /** Effective thrust per type at the current altitude, N. */
  thrustN: ThrustSplit;
  /** Full-throttle electric/fuel draw per type, MW (endurance model units). */
  powerMW?: ThrustSplit;
  /** Hydrogen tank fill, 0..1. */
  h2Fraction: number;
  /** Battery charge, 0..1 (ion/atmo legs need it). */
  batteryFraction: number;
}

export interface LegEnv {
  /** Hard cruise cap from config (`RTS_DEMO_SPEED_MPS`). */
  maxCruiseMps: number;
  /** Local gravity magnitude, m/s². */
  gravityMps2: number;
  /** Atmosphere at the ship's altitude; atmospheric legs fly dampeners-on. */
  hasAtmosphere: boolean;
  /** Current altitude above the local ground, m. */
  altitudeAglM?: number;
  /** Waypoint altitude above the same ground, m. */
  targetAglM?: number;
  /** Distance kept in hand before the brake point, m. */
  brakeMarginM?: number;
  /**
   * T61 passenger rule: cap on the acceleration the leg may plan with, m/s².
   * A ship carrying a passenger (or a standing player) is flown at 0.5 g
   * lateral / 1 g vertical, so the braking maths must not assume the hull's
   * full thrust authority.
   */
  maxAccelMps2?: number;
}

export interface LegProfile {
  distanceM: number;
  /** Speed for the single move order, m/s. */
  vCruiseMps: number;
  accelMps2: number;
  brakeMps2: number;
  /** Distance from the waypoint at which the brake burn must start, m. */
  brakeStartDistM: number;
  /** Predicted time from order to hold, s. */
  etaS: number;
  /** Predicted hydrogen burn, litres. */
  fuelL: number;
  /** Vacuum cruise coasts; atmospheric flight stays dampened. */
  dampeners: 'off' | 'on';
  /** OneWay for long legs, Precision inside 100 m. */
  flightMode: 'OneWay' | 'Precision';
  /** Minimum climb rate the leg is flown at (0 outside an atmosphere). */
  climbFloorMps: number;
  /** Human-readable model summary, stored in the audit. */
  reason: string;
}

/** Distance held back from the waypoint before the brake burn starts. */
export const BRAKE_MARGIN_DIST_M = 50;
/**
 * Deceleration assumed for a hull with no measured thrust split (no staging
 * profile and a mass outside the known owner family), m/s². It exists only so
 * an unmeasured ship still gets a braking-limited cruise instead of the old
 * flat 5 m/s for the whole leg; the per-tick guard and the 5/1 m/s terminal
 * caps remain the backstop for its approach.
 */
export const UNKNOWN_HULL_BRAKE_MPS2 = 2;
/** Contract minimum climb rate inside an atmosphere. */
export const MIN_CLIMB_MPS = 30;
/**
 * Controlled-fall descent (T52). A leg must drop at least this far before the
 * fall profile is worth it; short hops keep the precise dampened approach.
 */
export const DESCENT_MIN_DROP_M = 300;
/** Below this net braking authority the ship keeps dampeners on and descends. */
export const DESCENT_MIN_BRAKE_MPS2 = 2;
/** Extra height held above the ballistic brake point, m. */
export const DESCENT_BRAKE_MARGIN_M = 50;
/**
 * The controlled fall is a vertical profile: dampeners off, no lateral thrust.
 * A leg with more than this much horizontal offset is flown as a normal 3D
 * move instead, because the 4.5 m/s final approach would crawl sideways.
 */
export const DESCENT_MAX_HORIZONTAL_M = 300;
/**
 * Terminal descent speed after the brake burn. It is deliberately below the
 * 5 m/s ground-guard trigger so the guard is a last resort, never the flight
 * profile. The 5 m/s arrival cap still applies inside 100 m.
 */
export const DESCENT_FINAL_APPROACH_MPS = 4.5;
/** Inside this distance the autopilot uses Precision (one-way is too coarse). */
export const PRECISION_RADIUS_M = 100;
/** Dampeners come back on inside this distance, even in vacuum. */
export const DAMPENER_FINAL_M = 100;
/** Floors so a nearly-empty tank still yields a flyable order. */
const MIN_FLYABLE_MPS = 1;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Net acceleration available along the flight direction. Same rule as the
 * safety guard: a thrust vector used to brake cannot also hold the ship up,
 * so weight is subtracted once. In vacuum gravity is ~0 and the full ion/H2
 * force is available.
 */
export function legAccelMps2(hw: FlightHardware, gravityMps2: number): number {
  const mass = Math.max(1, hw.massKg);
  const h2Usable = hw.h2Fraction > 0.001 ? hw.thrustN.h2 : 0;
  const force = Math.max(0, hw.thrustN.atmo + hw.thrustN.ion + h2Usable);
  return Math.max(0, (force - mass * Math.max(0, gravityMps2)) / mass);
}

/** Hydrogen litres burned by a thrust-on segment at `forceN`. */
export function hydrogenBurnL(hw: FlightHardware, forceN: number, seconds: number): number {
  if (forceN <= 0 || seconds <= 0 || hw.h2Fraction <= 0.001) return 0;
  const maxForce = Math.max(1, hw.thrustN.h2);
  const powerMw = Math.max(0, hw.powerMW?.h2 ?? 0);
  if (powerMw <= 0) return 0;
  const burnLps = ((forceN / maxForce) * powerMw) / HYDROGEN_ENERGY_DENSITY_MWH_PER_L;
  return burnLps * seconds;
}

/**
 * Compute the profile for one leg.
 *
 * v_cruise = min(maxCruise, sqrt(2a(dist - margin))). A short leg therefore
 * gets a lower speed (it never reaches the cap), a huge leg cruises at the cap
 * and spends most of its time coasting.
 */
export function computeLegProfile(hw: FlightHardware, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, env: LegEnv): LegProfile {
  const distanceM = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const margin = Math.max(0, finite(env.brakeMarginM ?? BRAKE_MARGIN_DIST_M));
  const maxCruise = Math.max(MIN_FLYABLE_MPS, finite(env.maxCruiseMps, DEFAULT_SPEED_LIMIT_MPS));
  const accelCap =
    typeof env.maxAccelMps2 === 'number' && Number.isFinite(env.maxAccelMps2)
      ? Math.max(0, env.maxAccelMps2)
      : Number.POSITIVE_INFINITY;
  const accel = Math.min(legAccelMps2(hw, env.gravityMps2), Math.max(0, accelCap));
  const brake = accel; // symmetrical burn/brake with the same thruster banks
  const usableDist = Math.max(0, distanceM - margin);

  const atmosphere = env.hasAtmosphere === true;
  const climbing =
    atmosphere &&
    typeof env.altitudeAglM === 'number' &&
    typeof env.targetAglM === 'number' &&
    env.targetAglM > env.altitudeAglM + 1;
  const climbFloor = climbing ? Math.min(MIN_CLIMB_MPS, maxCruise) : 0;

  let vCruise: number;
  if (distanceM <= 1) {
    vCruise = MIN_FLYABLE_MPS;
  } else if (brake <= 0) {
    // No usable thrust: the guards abort, but the profile still has to be a
    // valid order. Fly at the floor; the ship will be stopped by the guard.
    vCruise = MIN_FLYABLE_MPS;
  } else {
    vCruise = Math.min(maxCruise, Math.sqrt(2 * brake * usableDist));
    vCruise = Math.max(vCruise, climbFloor, MIN_FLYABLE_MPS);
    vCruise = Math.min(vCruise, maxCruise);
  }
  vCruise = Math.round(vCruise * 10) / 10;

  const brakeStartDistM = brake > 0 ? (vCruise * vCruise) / (2 * brake) : distanceM;
  const tAccel = accel > 0 ? vCruise / accel : 0;
  const tBrake = brake > 0 ? vCruise / brake : 0;
  const dAccel = accel > 0 ? (vCruise * vCruise) / (2 * accel) : 0;
  const dBrake = brake > 0 ? (vCruise * vCruise) / (2 * brake) : 0;
  const dCruise = Math.max(0, distanceM - dAccel - dBrake);
  const tCruise = dCruise / vCruise;
  const etaS = distanceM <= 1 ? 0 : tAccel + tCruise + tBrake;

  // Vacuum coasts between the burns, so hydrogen is only burned while
  // accelerating and braking. Atmospheric flight thrusts the whole leg.
  const thrustSeconds = atmosphere ? etaS : tAccel + tBrake;
  const demand = Math.max(1, hw.massKg) * Math.max(0, accel);
  const h2Force = Math.max(0, demand - hw.thrustN.atmo - hw.thrustN.ion);
  const fuelL = hydrogenBurnL(hw, Math.min(h2Force, hw.thrustN.h2), thrustSeconds);

  const dampeners: 'off' | 'on' = atmosphere ? 'on' : 'off';
  const flightMode = distanceM <= PRECISION_RADIUS_M ? 'Precision' : 'OneWay';
  const reason =
    `${atmosphere ? 'atmosphere' : 'vacuum'} leg ${Math.round(distanceM)} m: ` +
    `v ${vCruise} m/s (cap ${Math.round(maxCruise)}, accel ${accel.toFixed(2)} m/s²), ` +
    `brake at ${Math.round(brakeStartDistM)} m, dampeners ${dampeners}` +
    (climbFloor > 0 ? `, climb >= ${climbFloor} m/s` : '') +
    `; predicted ${Math.round(etaS)} s / ${fuelL.toFixed(1)} L` +
    (Number.isFinite(accelCap) ? `; accel capped at ${accelCap.toFixed(2)} m/s² (passengers aboard)` : '');

  return {
    distanceM: Math.round(distanceM * 10) / 10,
    vCruiseMps: vCruise,
    accelMps2: Math.round(accel * 100) / 100,
    brakeMps2: Math.round(brake * 100) / 100,
    brakeStartDistM: Math.round(brakeStartDistM),
    etaS: Math.round(etaS * 10) / 10,
    fuelL: Math.round(fuelL * 100) / 100,
    dampeners,
    flightMode,
    climbFloorMps: climbFloor,
    reason,
  };
}

/**
 * Controlled-fall descent model.
 *
 * A gravity descent is not a horizontal leg: the ship can simply stop
 * thrusting and let gravity do the work, then brake once. The old profile kept
 * dampeners on for the whole atmospheric leg, so the autopilot held the ship
 * against gravity and crept down at ~5 m/s.
 *
 * The brake point is the height at which a full up-thrust burn stops the fall
 * above the target:
 *
 *   a_brake(h)  = upThrust(h) / mass - g(h)
 *   brakeDist(h)= v² / (2 · a_brake(h)) · 1.5 + 50 m
 *   brakeAlt    = targetAgl + brakeDist
 *
 * Upward thrust is MEASURED (plugin `inspect`, per-thruster axisWorld relative
 * to the local up vector); it is never inferred from a mass/thrust total. The
 * measured value is scaled DOWN to the brake-start density with the endurance
 * model's atmospheric-effectiveness curve, never up: the worst (thinnest) air
 * on the remaining path is the conservative case.
 */
export interface DescentInput {
  massKg: number;
  /** Sum of working thrusters whose force opposes the local up vector, N. */
  measuredUpThrustN: number | null;
  /** Altitude AGL where that lift was measured. */
  measuredAtAglM: number | null;
  /** Current altitude AGL. */
  altitudeAglM: number;
  /** Waypoint altitude AGL. */
  targetAglM: number;
  planet: Planet;
  /** Hard cruise cap; the fall speed never exceeds it. */
  maxCruiseMps: number;
  /** Terminal speed after the brake burn, m/s. */
  finalApproachMps?: number;
  /**
   * Height of the local ground above the planet's MinimumSurfaceRadius, m.
   * AGL is terrain-relative; the air-density and gravity curves are referenced
   * to the planet surface. At BASE-01 the voxel ground is ~1.8 km above it, so
   * ignoring this would over-estimate thrust in thin air.
   */
  surfaceOffsetM?: number;
}

export interface DescentProfile {
  mode: 'controlled-fall' | 'dampened';
  reason: string;
  /** Fall speed cap used for this leg, m/s. */
  vFallMps: number;
  /** Altitude AGL at which the brake burn must start. */
  brakeAltAglM: number;
  /** Height above the target at which braking starts. */
  brakeDistanceM: number;
  /** Net upward deceleration at the brake-start density, m/s². */
  brakeDecelMps2: number;
  /** Upward thrust assumed at the brake-start density, N. */
  upThrustN: number;
  /** Speed commanded for the final approach after the brake, m/s. */
  finalApproachMps: number;
  fallS: number;
  brakeS: number;
  finalS: number;
  etaS: number;
}

function zeroDescent(reason: string): DescentProfile {
  return {
    mode: 'dampened',
    reason,
    vFallMps: 0,
    brakeAltAglM: 0,
    brakeDistanceM: 0,
    brakeDecelMps2: 0,
    upThrustN: 0,
    finalApproachMps: 0,
    fallS: 0,
    brakeS: 0,
    finalS: 0,
    etaS: 0,
  };
}

/**
 * Upward thrust available at `aglM`, given a measurement at `measuredAglM`.
 * Atmospheric thrust weakens as air thins, so a measurement taken lower down
 * is scaled down for a higher brake point; a measurement taken higher up is
 * never scaled up (that would assume more thrust than was measured).
 */
export function measuredUpThrustAt(
  planet: Planet,
  aglM: number,
  measuredUpThrustN: number,
  measuredAglM: number,
  surfaceOffsetM = 0,
): number {
  if (!(measuredUpThrustN > 0)) return 0;
  const from = effectiveness('atmo', airDensity(planet, Math.max(0, measuredAglM + surfaceOffsetM)));
  if (!(from > 0.02)) return 0;
  const to = effectiveness('atmo', airDensity(planet, Math.max(0, aglM + surfaceOffsetM)));
  const ratio = Math.min(1, Math.max(0, to / from));
  return measuredUpThrustN * ratio;
}

/**
 * Decide whether a descent can be flown as a controlled fall. Pure: every
 * measurement is an argument, so the executor and the tests compute the same
 * numbers.
 */
export function computeDescentProfile(input: DescentInput): DescentProfile {
  const drop = input.altitudeAglM - input.targetAglM;
  const mass = Math.max(1, input.massKg);
  const cap = Math.max(1, finite(input.maxCruiseMps, DEFAULT_SPEED_LIMIT_MPS));
  const finalApproachMps = Math.min(
    DESCENT_FINAL_APPROACH_MPS,
    Math.max(1, finite(input.finalApproachMps ?? DESCENT_FINAL_APPROACH_MPS, DESCENT_FINAL_APPROACH_MPS)),
  );
  if (!planetHasAtmosphere(input.planet)) {
    return zeroDescent('no atmosphere: a gravity fall has no atmospheric brake authority');
  }
  if (!(drop >= DESCENT_MIN_DROP_M)) {
    return zeroDescent(
      `descent ${Math.round(Math.max(0, drop))} m is below the ${DESCENT_MIN_DROP_M} m controlled-fall minimum`,
    );
  }
  if (!(input.measuredUpThrustN && input.measuredUpThrustN > 0) || input.measuredAtAglM === null) {
    return zeroDescent('upward thrust not measured: no controlled fall without a measured lift component');
  }

  const gravity = planetGravity(input.planet);
  const surfaceOffsetM = finite(input.surfaceOffsetM ?? 0);
  // Fall acceleration over the ballistic part; g is flat inside the atmo, so
  // the midpoint is enough and stays valid near the hill radius.
  const fallG = Math.max(
    0.1,
    gravityAtAltitude(gravity, Math.max(0, (input.altitudeAglM + input.targetAglM) / 2 + surfaceOffsetM)),
  );
  const usable = Math.max(0, drop - DESCENT_BRAKE_MARGIN_M);

  let brakeAlt = input.targetAglM + DESCENT_BRAKE_MARGIN_M;
  let upThrustN = 0;
  let brakeDecel = 0;
  let vFall = 0;
  let brakeDistanceM = 0;
  for (let i = 0; i < 8; i += 1) {
    upThrustN = measuredUpThrustAt(
      input.planet,
      brakeAlt,
      input.measuredUpThrustN,
      input.measuredAtAglM,
      surfaceOffsetM,
    );
    const gBrake = Math.max(0.1, gravityAtAltitude(gravity, Math.max(0, brakeAlt + surfaceOffsetM)));
    brakeDecel = upThrustN / mass - gBrake;
    if (!(brakeDecel >= DESCENT_MIN_BRAKE_MPS2)) {
      return zeroDescent(
        `upward brake authority ${brakeDecel.toFixed(2)} m/s² at ${Math.round(brakeAlt)} m AGL is below the ` +
          `${DESCENT_MIN_BRAKE_MPS2} m/s² controlled-fall minimum`,
      );
    }
    // Speed whose ballistic fall plus 1.5x brake burn just fits the drop.
    const denom = 1 / (2 * fallG) + BRAKE_MARGIN / (2 * brakeDecel);
    vFall = Math.min(cap, Math.sqrt(usable / denom));
    if (!(vFall >= 1)) {
      return zeroDescent(`descent ${Math.round(drop)} m is too short to build and burn any fall speed`);
    }
    brakeDistanceM = (vFall * vFall) / (2 * brakeDecel) * BRAKE_MARGIN + DESCENT_BRAKE_MARGIN_M;
    const next = input.targetAglM + brakeDistanceM;
    if (Math.abs(next - brakeAlt) < 1) {
      brakeAlt = next;
      break;
    }
    brakeAlt = next;
  }
  // Brake at the higher of the ballistic formula and the ground-guard
  // clearance. Below 150 m AGL the guard brakes any descent faster than
  // 5 m/s; for a low target the brake point is raised until the ship is
  // already at the final approach speed when it crosses that line.
  let vAtBrake = Math.min(cap, Math.sqrt(2 * fallG * Math.max(0, drop - brakeAlt)));
  if (input.targetAglM < GROUND_GUARD_ALT_M) {
    for (let i = 0; i < 4; i += 1) {
      upThrustN = measuredUpThrustAt(
        input.planet,
        brakeAlt,
        input.measuredUpThrustN,
        input.measuredAtAglM,
        surfaceOffsetM,
      );
      const gGuard = Math.max(0.1, gravityAtAltitude(gravity, Math.max(0, brakeAlt + surfaceOffsetM)));
      brakeDecel = upThrustN / mass - gGuard;
      if (!(brakeDecel >= DESCENT_MIN_BRAKE_MPS2)) {
        return zeroDescent(
          `upward brake authority ${brakeDecel.toFixed(2)} m/s² at ${Math.round(brakeAlt)} m AGL is below the ` +
            `${DESCENT_MIN_BRAKE_MPS2} m/s² controlled-fall minimum`,
        );
      }
      vAtBrake = Math.min(cap, Math.sqrt(2 * fallG * Math.max(0, drop - brakeAlt)));
      const slowDistance = Math.max(
        0,
        (vAtBrake * vAtBrake - finalApproachMps * finalApproachMps) / (2 * brakeDecel),
      );
      const clearance = brakeAlt - slowDistance;
      if (clearance >= GROUND_GUARD_ALT_M) break;
      brakeAlt = Math.min(drop, brakeAlt + (GROUND_GUARD_ALT_M - clearance) + 1);
    }
  }
  // Final values at the chosen brake altitude.
  upThrustN = measuredUpThrustAt(
    input.planet,
    brakeAlt,
    input.measuredUpThrustN,
    input.measuredAtAglM,
    surfaceOffsetM,
  );
  const gBrake = Math.max(0.1, gravityAtAltitude(gravity, Math.max(0, brakeAlt + surfaceOffsetM)));
  brakeDecel = upThrustN / mass - gBrake;
  if (!(brakeDecel >= DESCENT_MIN_BRAKE_MPS2)) {
    return zeroDescent(
      `upward brake authority ${brakeDecel.toFixed(2)} m/s² at ${Math.round(brakeAlt)} m AGL is below the ` +
        `${DESCENT_MIN_BRAKE_MPS2} m/s² controlled-fall minimum`,
    );
  }
  // Ballistic height is from the START to the brake point. `drop` is a delta
  // and `brakeAlt` is an absolute AGL, so the old `drop - brakeAlt` mixed units
  // and read 0 for any short descent (brake above the top of the drop): the
  // fall then had no planned speed at all. `altitudeAglM - brakeAlt` is the
  // same number as `drop - brakeDistanceM`.
  vFall = Math.min(cap, Math.sqrt(2 * fallG * Math.max(0, input.altitudeAglM - brakeAlt)));
  brakeDistanceM = Math.max(0, brakeAlt - input.targetAglM);
  const fallDistance = Math.max(0, drop - brakeDistanceM);
  const fallS = Math.sqrt((2 * fallDistance) / fallG);
  const vBrakeEnd = Math.min(finalApproachMps, vFall);
  const brakeS = Math.max(0, (vFall - vBrakeEnd) / brakeDecel);
  const brakeDistanceToFinal = (vFall * vFall - vBrakeEnd * vBrakeEnd) / (2 * brakeDecel);
  const finalDistance = Math.max(0, brakeDistanceM - brakeDistanceToFinal);
  const finalS = finalDistance / Math.max(0.5, vBrakeEnd);
  const etaS = fallS + brakeS + finalS;
  const reason =
    `controlled fall ${Math.round(drop)} m: dampeners off to ${Math.round(brakeAlt)} m AGL, ` +
    `fall ${Math.round(vFall)} m/s, brake ${brakeDecel.toFixed(2)} m/s² ` +
    `(${(upThrustN / 1000).toFixed(0)} kN measured up, ${brakeDistanceM.toFixed(0)} m above target), ` +
    `then ${finalApproachMps} m/s approach; predicted ${Math.round(etaS)} s`;

  return {
    mode: 'controlled-fall',
    reason,
    vFallMps: Math.round(vFall * 10) / 10,
    brakeAltAglM: Math.round(brakeAlt * 10) / 10,
    brakeDistanceM: Math.round(brakeDistanceM * 10) / 10,
    brakeDecelMps2: Math.round(brakeDecel * 100) / 100,
    upThrustN: Math.round(upThrustN),
    finalApproachMps,
    fallS: Math.round(fallS * 10) / 10,
    brakeS: Math.round(brakeS * 10) / 10,
    finalS: Math.round(finalS * 10) / 10,
    etaS: Math.round(etaS * 10) / 10,
  };
}

// ---------------------------------------------------------------- altitude AGL

/**
 * Where the AGL ground reference for a leg came from.
 *
 * `terrain` = the terrain height field's radius at this column: the real
 * ground, which at the BASE-01 test column is 1 616.7 m above the catalogue
 * mean radius. `probe` = a `probe_ground` hit refined the local ground (that
 * probe cannot hit procedural planet terrain on this build, so in practice it
 * never fires). `mean` = nothing better was available and `surfaceRadiusM`
 * was used: the ground could then be up to `groundUncertaintyM` (the planet's
 * hill range) higher than assumed, and the audit says so.
 */
export type AltitudeSource = 'terrain' | 'probe' | 'mean';

export interface TelemetryGroundFrame {
  /** Distance from the planet centre, m. */
  radiusM: number;
  /** Ground radius used for AGL: terrain, else the probe hit, else surfaceRadiusM. */
  groundRadiusM: number;
  /** |position - centre| - groundRadius, m. */
  altitudeAglM: number;
  /** Local up unit vector (away from the planet centre). */
  up: { x: number; y: number; z: number };
  source: AltitudeSource;
  /**
   * How wrong `groundRadiusM` could be, m: `maxHillRadiusM - surfaceRadiusM`
   * when the ground is only the catalogue mean (the terrain may be that much
   * higher at this column), 0 when terrain or a probe fixed the ground.
   */
  groundUncertaintyM: number;
}

/**
 * A grid this many times the planet's hill radius away is not on that planet;
 * the nearest-planet lookup always returns *something*, so deep-space
 * positions must be rejected explicitly rather than given a nonsense AGL.
 */
const OFF_PLANET_FACTOR = 4;

/**
 * Altitude AGL from telemetry plus the terrain height field (overnight run
 * 2026-11-10, FAILURE 1 and the ground-datum crash).
 *
 * `probe_ground` cannot hit procedural planet terrain on this build
 * (MyVoxelBase.GetIntersectionWithLine -> Storage.GetGeometry() is null for
 * planets), so a descent that waits for it never starts. Everything needed is
 * already in telemetry: each grid reports its position and the planet catalog
 * carries the centre (save position + 131072 m per axis) and surfaceRadiusM:
 *
 *   AGL = |position - planetCentre| - groundRadius
 *
 * `surfaceRadiusM` is the CATALOGUE MEAN (MinimumSurfaceRadius), not the
 * terrain at this column: at the BASE-01 test column the real ground is
 * 61 016.7 m, 1 616.7 m above the mean. Measuring from the mean made every AGL
 * that much too optimistic, and a "1 201 m AGL" brake point was 415 m
 * underground. The ground reference is therefore, in priority order:
 *
 *   1. `terrainGroundRadiusM` — the terrain height field's radius along `up`;
 *   2. `probeGroundRadiusM` — a `probe_ground` hit, when one happened;
 *   3. `surfaceRadiusM` — the catalogue mean, flagged `mean` and carrying
 *      `groundUncertaintyM` so a caller can refuse a descent that would brake
 *      inside the possible terrain.
 *
 * Returns null when the grid is not on the planet (outside its hill sphere by
 * a wide margin) or the planet/centre is unknown: the caller records that
 * reason and flies the dampened descent instead of waiting for a measurement
 * that cannot arrive.
 */
export function telemetryGroundFrame(
  pos: { x: number; y: number; z: number } | null | undefined,
  planet: Planet | null | undefined,
  probeGroundRadiusM: number | null = null,
  terrainGroundRadiusM: number | null = null,
): TelemetryGroundFrame | null {
  if (!pos || !planet) return null;
  const centre = planet.center ?? { x: 0, y: 0, z: 0 };
  const dx = pos.x - centre.x;
  const dy = pos.y - centre.y;
  const dz = pos.z - centre.z;
  const radiusM = Math.hypot(dx, dy, dz);
  if (!(radiusM > 1)) return null;
  const surfaceM = Math.max(0, finite(Number(planet.surfaceRadiusM ?? 0)));
  const hillM = Math.max(finite(Number(planet.maxHillRadiusM ?? 0)), surfaceM, 1);
  if (radiusM > hillM * OFF_PLANET_FACTOR) return null;
  // The terrain outranks the probe: a decoded height tile is the ground the
  // ship will actually hit, and a probe ray fired from a fixed offset can miss.
  const terrain = usableRadius(terrainGroundRadiusM);
  const probed = terrain === null ? usableRadius(probeGroundRadiusM) : null;
  const groundRadiusM = terrain ?? probed ?? surfaceM;
  const source: AltitudeSource = terrain !== null ? 'terrain' : probed !== null ? 'probe' : 'mean';
  return {
    radiusM,
    groundRadiusM,
    altitudeAglM: radiusM - groundRadiusM,
    up: { x: dx / radiusM, y: dy / radiusM, z: dz / radiusM },
    source,
    groundUncertaintyM:
      source === 'mean' ? Math.max(0, finite(Number(planet.maxHillRadiusM ?? 0)) - surfaceM) : 0,
  };
}

/** A positive, finite ground radius, else null (an unset option). */
function usableRadius(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// -------------------------------------------------------------- landing mode

/**
 * Landing mode (owner request, 2026-11-10): "have a ship actually land on the
 * ground, going as fast as possible then slowing down to land, based on how
 * heavy it is".
 *
 *   (a) controlled fall at up to the cruise cap, dampeners off
 *   (b) a braking burn timed so the ship STOPS `flareAglM` above the TRUE
 *       ground, computed from the MEASURED up-thrust / mass − g, so a heavier
 *       hull (less net decel) must brake higher up
 *   (c) slow final descent, dampeners on: <= 5 m/s down to 15 m, <= 1 m/s below
 *   (d) touchdown: vertical speed ~0 and AGL < 3 m from TRUE ground (or a
 *       landing-gear lock), then the gear is locked and the grid STAYS a ship.
 */
export const LANDING_FLARE_AGL_M = 40;
/**
 * Never plan a brake point below this while the ship is still falling, m AGL.
 * Same value as `GROUND_CLEARANCE_M` (declared further down), pinned to it by
 * `landing-mode.test.ts` so the two can never drift apart.
 *
 * AGL here and everywhere below is HULL-BOTTOM altitude, not the grid
 * position's altitude: see `hullBottomAglM`.
 */
export const LANDING_MIN_BRAKE_AGL_M = 100;
export const LANDING_APPROACH_DESCENT_MPS = 5;
/**
 * Final descent speed. Below the touchdown threshold on purpose: a hull that
 * descends at 1 m/s can only ever be caught by the "contact while settling"
 * rule, so the last metres are flown at 0.4 m/s and the strict rule
 * (bottom AGL < 2 m, |v| <= 0.5 m/s) is the normal way a landing completes.
 */
export const LANDING_FINAL_DESCENT_MPS = 0.4;
/** (c) switches from the 5 m/s approach to the 1 m/s final descent here. */
export const LANDING_FINAL_DESCENT_AGL_M = 15;
/**
 * (d) touchdown: HULL-BOTTOM AGL below this, m. Measured in game 2026-11-10:
 * SAT-R-0001's block envelope ends ~10 m ABOVE its pivot (`keelDepthM` -10),
 * so a rule phrased on the position's AGL can only fire while the hull is
 * already 10 m inside the hill — the ship rested on terrain three times at
 * 21-26 m of POSITION AGL and never got below it.
 */
export const LANDING_TOUCHDOWN_AGL_M = 2;
/** (d) ...and vertical speed within this of zero, m/s. */
export const LANDING_TOUCHDOWN_MPS = 0.5;
/**
 * A relaunch/return target this low above a measured (landing-grade) surface is
 * ON THE GROUND, not a station: fly it as a landing (lateral -> settle ->
 * land_at) instead of a hold. Verify #4 measured the alternative: R-0001's
 * remembered slot was the point it had been resting on, the executor treated it
 * as an airborne hold target and refused it ("1 m of clearance, 100 m
 * required"), so the relaunch half of the loop could never lift off.
 */
export const GROUND_ORIGIN_AGL_M = 20;
/**
 * A hull that is on the ground may still be moving while it settles (runway
 * contact, a bounce off a slope). Measured 2026-11-10 the approach touched
 * terrain at -4.2 m/s and the contact bounced it back up: that is a landing,
 * not a stall, so contact within this speed also counts as touchdown.
 */
export const LANDING_CONTACT_MPS = 1;
/** Touchdown confirmed but the AGL is unreadable: treat the hull as down. */
export const LANDING_MAX_TOUCHDOWN_AGL_M = 20;

/**
 * A CONFIRMED contact band: hull bottom at or below 3 m above the frame's
 * ground with |v| <= 1 m/s is a landed hull, full stop.
 *
 * Measured 2026-11-11: the plugin's `land_at` reported "landed: hull bottom
 * 2.96 m AGL, vertical speed -0.07 m/s, blocks unchanged", the backend's own
 * frame read the same hull at ~3 m and 0.03 m/s, and the strict touchdown rule
 * (< 2 m) just missed it. Nothing was sent (plugin-land sends nothing by
 * design), so 41 s later the idle watchdog aborted a landing that had already
 * happened. Contact inside this band completes the mission as landed (a warning
 * is allowed) and the "not descending" watchdog must never fire inside it.
 */
export const LANDING_CONTACT_BAND_AGL_M = 3;

/** True when the telemetry is inside the confirmed-contact band. */
export function landingContactBand(input: {
  /** HULL-BOTTOM altitude above the frame's own ground, m. */
  altitudeAglM: number;
  /** Vertical speed along local up, m/s (negative = descending). */
  verticalSpeedMps: number;
  /** The plugin reported touchdown / gear contact for this landing. */
  pluginTouchdown?: boolean;
}): boolean {
  const agl = Number(input.altitudeAglM);
  const v = Math.abs(Number(input.verticalSpeedMps));
  if (!Number.isFinite(agl) || !Number.isFinite(v)) return false;
  if (input.pluginTouchdown === true && agl <= LANDING_MAX_TOUCHDOWN_AGL_M) return true;
  return agl <= LANDING_CONTACT_BAND_AGL_M && v <= LANDING_CONTACT_MPS;
}

/**
 * KEEL SIGN CONVENTION — the only place a pivot radius and a hull-bottom AGL
 * are converted, so the two directions cannot disagree.
 *
 * `keelDepthM` is the SIGNED distance from the grid PIVOT along local down to
 * the lowest point of the hull's local AABB. It is what the plugin's
 * `GridGeometry.KeelDepthM` measures and what telemetry reports:
 *
 *   keelDepthM > 0 -> the hull extends BELOW the pivot (the usual case);
 *   keelDepthM < 0 -> the hull BOTTOM sits ABOVE the pivot.
 *
 * Measured in game (set 4 inspect of SAT-R-0001): `localAABB` y 8.75..18.75
 * with a level hull, `keelDepthM -8.75`, pivot radius 61 264.18 and
 * hull-bottom radius 61 272.93 — the belly is 8.75 m ABOVE the pivot. So a
 * negative keel RAISES the hull bottom relative to the pivot; it does not
 * lower it.
 *
 *   hullBottomAglM(pivotAgl, keel)          = pivotAgl - keel
 *   pivotRadiusForHullBottomAgl(ground, k, agl) = ground + k + agl
 *
 * These two are exact inverses: use them for every ground figure (touchdown,
 * flare, brake, approach target, hover point, 100 m clearances) and for every
 * audit row, and never write the arithmetic out again. Reading
 * `pivotAgl + keel` inverts the sign: it reported a correct 75.1 m hover as
 * "57.6 m" in data/flight-proof-20261111.md.
 */
export function hullBottomAglM(positionAglM: number, keelDepthM: number): number {
  const agl = Number.isFinite(positionAglM) ? positionAglM : 0;
  const keel = Number.isFinite(keelDepthM) ? keelDepthM : 0;
  return agl - keel;
}

/**
 * The pivot radius a grid must hold for its HULL BOTTOM to sit `aglM` above a
 * ground radius. Inverse of `hullBottomAglM`.
 *
 * With a negative keel (SAT-R-0001: -8.74 m) this asks for a position BELOW the
 * terrain — exactly right, and unreachable: the hull touches first and the
 * touchdown rule (hull-bottom AGL) finishes the landing.
 */
export function pivotRadiusForHullBottomAgl(
  groundRadiusM: number,
  keelDepthM: number,
  aglM = 0,
): number {
  const ground = Number.isFinite(groundRadiusM) ? groundRadiusM : 0;
  const keel = Number.isFinite(keelDepthM) ? keelDepthM : 0;
  return ground + keel + Math.max(0, aglM);
}
/** Brake deceleration trust floor; below it the approach is used instead, m/s². */
export const LANDING_MIN_BRAKE_MPS2 = DESCENT_MIN_BRAKE_MPS2;
/**
 * Vertical speed shed rate the flare brake is flown at when the hull has MORE
 * authority than this: SE's dampeners hold a velocity setpoint and stop the
 * descent smoothly, where a full-thrust burn slammed the ship back up ~1 km
 * (measured 2026-11-10). A hull with less authority than this brakes at its own
 * thrust, so it needs more height — that is the "based on how heavy it is" part.
 *
 * Kept only as the documented FLOOR of the old model and for the descent
 * command's default; it is no longer a cap on the flare brake (see
 * `landingShedRateMps2`).
 */
export const LANDING_SHED_DECEL_MPS2 = 4;

/**
 * Safety factor on the hull's MEASURED dampened shed rate. Measured 2026-11-10:
 * SAT-R-0001 shed 86 -> 0 m/s over 546 m with the dampeners holding, i.e.
 * 7.2 m/s², while the planner used a blanket 4.0 m/s². The live brake then
 * fired at 1 136 m for a formula that wanted 1 832 m and the hull stopped
 * ~525 m above its flare, where the old phase logic deadlocked. Planning at
 * 70 % of the measured rate keeps a height margin without the lost 3.2 m/s².
 */
export const LANDING_SHED_MEASURED_MARGIN = 0.7;
/** Absolute bounds on the planned shed rate, m/s² (a hull below 2 cannot land). */
export const LANDING_SHED_MIN_MPS2 = 2;
export const LANDING_SHED_MAX_MPS2 = 10;

/**
 * The shed rate the flare brake is planned with.
 *
 *   shed = clamp(0.7 · measured, 2, 10)   and never more than the hull can do
 *
 * `measured` is the hull's observed dampened deceleration when one has been
 * measured (in game: 7.2 m/s²); otherwise the authority implied by its own
 * measured up-thrust, `(upThrust − m·g) / m`, which is the best measurement
 * available before the first brake. The blanket 4.0 m/s² cap is gone: it was
 * not a measurement of anything.
 */
export function landingShedRateMps2(input: {
  /** (upThrust − m·g) / m from the measured lift, m/s². */
  authorityMps2: number;
  /** Observed dampened shed from a flown brake, m/s²; null/undefined when none. */
  measuredShedMps2?: number | null;
}): number {
  const authority = finite(input.authorityMps2);
  const measured = input.measuredShedMps2;
  const base = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? measured : authority;
  const planned = Math.min(LANDING_SHED_MAX_MPS2, Math.max(LANDING_SHED_MIN_MPS2, LANDING_SHED_MEASURED_MARGIN * base));
  // A hull cannot shed faster than its own thrust allows, margin or not.
  return Math.max(LANDING_SHED_MIN_MPS2, Math.min(planned, authority));
}

/**
 * Height AGL at which the backend hands the ship to the final-descent
 * mechanism: the brake stops the hull here (HULL BOTTOM AGL) and the final
 * descent owns everything below it. Default 150 m, configurable
 * (`RTS_DEMO_HANDOVER_AGL`). Keeping it above the ground also keeps the
 * plugin's own landing controller out of the terrain-uncertain band.
 */
export const LANDING_HANDOVER_AGL_M = 150;

/** Capability a plugin reports in its `hello` to own the final descent. */
export const PLUGIN_LAND_CAPABILITY = 'land_controller';

/**
 * `dampener-pulse`: this backend flies the final descent. `plugin-land`: the
 * plugin's `land_at` controller owns the whole descent from the current height.
 */
export type FinalDescentMechanism = 'dampener-pulse' | 'plugin-land';

/**
 * The one place the final-descent mechanism is chosen. Everything above the
 * handover height (fall + brake) belongs to the backend; below it, either the
 * backend's dampener pulses or the plugin's `land_at` controller fly the ship.
 * A plugin that owns the controller is handed the descent at the FIRST landing
 * tick, from whatever height the hull is at: the backend's event loop must not
 * have to make a control decision mid-fall (measured 2026-11-10: 12.3 s with no
 * decision while a 1 Hz external sampler saturated the loop, 57 m/s into the
 * ground).
 */
export function chooseFinalDescentMechanism(capabilities: readonly string[] | null | undefined): FinalDescentMechanism {
  return Array.isArray(capabilities) && capabilities.includes(PLUGIN_LAND_CAPABILITY)
    ? 'plugin-land'
    : 'dampener-pulse';
}

/** The final descent the plugin is asked for, in the one order it gets. */
export interface LandAtOrder {
  action: 'land_at';
  /** Ground radius at the column the hull is descending onto, m. */
  groundRadiusM: number;
  /** Signed pivot -> hull bottom, m (the correction the plugin must apply). */
  keelDepthM: number;
  /** Descent speed for the approach, m/s (positive DOWN). */
  sinkMps: number;
  /** Sink rate for the last band, m/s. */
  finalSinkMps: number;
  /** Height AGL under which `finalSinkMps` applies, m. */
  finalBandM: number;
  /**
   * Cap on the free-fall speed, m/s. The plugin holds it with a lift override
   * (thrust = m·(g + k(sink − cap)), i.e. 0 below the cap and weight at it).
   * A cap keeps a 1 km drop from arriving at the brake point at 130 m/s.
   */
  maxFallMps: number;
  /**
   * The REQUESTED landing column, world metres (2026-11-11 flight set 5): the
   * ground point of the target the mission asked for. The plugin's horizontal
   * hold flies to it when it is within its own cap, instead of holding the
   * column the handover happened on (which is where the hull already is).
   */
  targetPosition?: { x: number; y: number; z: number };
}

/** Sink the handover order asks for in the open descent, m/s. */
export const LANDING_PLUGIN_SINK_MPS = 5;
/** Sink the handover order asks for in the final band, m/s. */
export const LANDING_PLUGIN_FINAL_SINK_MPS = 0.4;
/** Height AGL under which the final sink applies, m. */
export const LANDING_PLUGIN_FINAL_BAND_M = 15;
/** Default free-fall cap for a plugin-owned descent, m/s. */
export const LANDING_PLUGIN_MAX_FALL_MPS = 100;

/**
 * Horizontal distance from the REQUESTED landing column above which the
 * backend flies a lateral leg before handing over to `land_at` (2026-11-11
 * flight set 5). Both measured landings came to rest 181-185 m from the
 * `land_at` target: the ship climbs a <= 60 deg ladder, so at the top of a
 * 745 m climb it sits ~180 m sideways, and nothing flew the last leg across.
 * Below this the handover happens where it is and the plugin's own hold
 * (which can move a few metres) does the rest.
 */
export const LANDING_LATERAL_ALIGN_M = 15;
/**
 * Horizontal distance to the target column at which the lateral leg is done, m.
 * Inside this the handover happens: the plugin's hold closes the remainder
 * (its cap is `LANDING_TARGET_HOLD_MAX_M`).
 */
export const LANDING_LATERAL_ARRIVE_M = 8;
/**
 * Largest horizontal target offset the plugin's horizontal hold will fly, m
 * (mirrors `LandMath.LateralTargetMaxM`). The backend sends the target in every
 * `land_at`; a target beyond the cap is refused BY THE PLUGIN for the hold, so
 * this constant only documents the seam and is asserted in the tests.
 */
export const LANDING_TARGET_HOLD_MAX_M = 30;
/**
 * Cruise speed of the lateral leg, m/s. A landing is not a race and the leg is
 * flown at altitude with the normal guarded move; 20 m/s crosses a 180 m
 * offset in ~9 s.
 */
export const LANDING_LATERAL_SPEED_MPS = 20;
/**
 * Clearance the lateral leg keeps over the ground AT THE TARGET COLUMN, m: the
 * leg's altitude is the higher of the hull's current radius and the target
 * ground plus this, so the leg never descends and never flies into a hill that
 * is higher at the target than under the ship.
 */
export const LANDING_LATERAL_MIN_CLEARANCE_M = 50;
/** A lateral leg that has not arrived in this long is abandoned, ms. */
export const LANDING_LATERAL_TIMEOUT_MS = 120_000;
/** Re-send interval for the lateral leg's guarded move, ms. */
export const LANDING_LATERAL_RESEND_MS = 3_000;

/** Build the single `land_at` order a plugin landing controller receives. */
export function buildLandAtOrder(input: {
  groundRadiusM: number;
  keelDepthM: number;
  /** Client-side sanity cap on the free fall; defaults to 100 m/s. */
  maxFallMps?: number | null;
  /**
   * The REQUESTED landing column (the target's ground point), world metres.
   * Optional: an order without one asks the plugin to hold the handover
   * column, which is the pre-set-5 behaviour.
   */
  targetPosition?: { x: number; y: number; z: number } | null;
}): LandAtOrder {
  const cap = Number(input.maxFallMps);
  const toTarget = input.targetPosition;
  const target =
    toTarget && [toTarget.x, toTarget.y, toTarget.z].every((v) => Number.isFinite(Number(v)))
      ? {
          x: Math.round(Number(toTarget.x) * 10) / 10,
          y: Math.round(Number(toTarget.y) * 10) / 10,
          z: Math.round(Number(toTarget.z) * 10) / 10,
        }
      : null;
  return {
    action: 'land_at',
    groundRadiusM: Math.round(finite(input.groundRadiusM) * 10) / 10,
    keelDepthM: Math.round(finite(input.keelDepthM) * 100) / 100,
    sinkMps: LANDING_PLUGIN_SINK_MPS,
    finalSinkMps: LANDING_PLUGIN_FINAL_SINK_MPS,
    finalBandM: LANDING_PLUGIN_FINAL_BAND_M,
    maxFallMps:
      Number.isFinite(cap) && cap > 0
        ? Math.round(Math.min(200, Math.max(5, cap)))
        : LANDING_PLUGIN_MAX_FALL_MPS,
    ...(target ? { targetPosition: target } : {}),
  };
}
/**
 * SETTLE GATE between the lateral leg and the `land_at` handover (2026-11-11
 * flight set 6).
 *
 * Measured: the lateral leg arrived on the T1 column at 772 m AGL and the
 * plugin refused the start — `spinning at 80.5 deg/s (over 30 deg/s)` — because
 * the leg's last autopilot turn onto the waypoint was still unwinding. Eight
 * seconds later the idle watchdog aborted the mission at 793 m AGL with the
 * hull intact and hovering. A hull is not handed a descent while it is still
 * rotating: the backend holds it on autopilot-off + dampeners-on and waits for
 * the RATE (not a timer) to come down, bounded so a landing can never stall.
 *
 * The rate is the plugin's own measured sample (`spinDegS` in telemetry, the
 * same number `land_at` refuses on), so the two sides agree by construction.
 */
export const LANDING_SETTLE_SPIN_MAX_DEG_S = 2;
/** Linear speed at or below which the hull counts as held, m/s. */
export const LANDING_SETTLE_SPEED_MAX_MPS = 1;
/** Longest the settle waits for the rate before handing over anyway, ms. */
export const LANDING_SETTLE_MAX_MS = 20_000;
/** Re-assert interval for autopilot-off + dampeners-on during the settle, ms. */
export const LANDING_SETTLE_RESEND_MS = 3_000;
/**
 * Ticks a landing whose TARGET column has no landing-grade ground sample waits
 * for the level-5 read before refusing (2026-11-11 flight set 6). A slot pushed
 * out on the level-0 planning field measured 47 m under the terrain, so the leg
 * crawled to an underground point and the stuck guard fired. Bounded, exactly
 * like the handover's own coarse-datum wait.
 */
export const LANDING_SLOT_DATUM_WAITS = 5;
/** A slot datum correction below this is rounding, not a datum, m. */
export const LANDING_SLOT_DATUM_MIN_FIX_M = 2;
/** Height the brake burn needs at least, m (flare + one metre of burn). */
export const LANDING_MIN_BRAKE_DROP_M = LANDING_FLARE_AGL_M + 1;
/**
 * Live-brake safety factor on the stopping distance, m. Measured 2026-11-10:
 * the planned brake point (sized from the PLANNED 44 m/s entry) sat at 427 m
 * while the hull was actually doing 104.4 m/s, ~700 m too late. The brake is
 * therefore re-derived from the LIVE speed every tick with this factor on the
 * `v²/2a` stop, so a hull that falls faster than planned brakes from further
 * up instead of being trusted to have obeyed a number in the plan.
 */
export const LANDING_LIVE_BRAKE_MARGIN = 1.5;
/** The approach flies to this height above the TRUE ground, m. */
export const LANDING_APPROACH_TARGET_AGL_M = 1;
/**
 * The approach must make downward progress: if the true AGL has not fallen by
 * at least LANDING_APPROACH_STALL_MIN_DROP_M in this long, the landing is
 * aborted with a plain reason instead of hovering forever (measured
 * 2026-11-10: the ship settled at ~78 m, v=0.00, and never touched down).
 */
export const LANDING_APPROACH_STALL_MS = 15_000;
export const LANDING_APPROACH_STALL_MIN_DROP_M = 1;

/**
 * Height AGL at which the flare brake must start, computed from the speed the
 * ship has RIGHT NOW (never from the planned entry speed):
 *
 *   brakeAgl = v_actual² / (2·a_brake) · 1.5
 *            + flare height                 (stop at the flare, not at 0 m)
 *            + v_actual · telemetry period  (the unobserved fall before the
 *                                            next sample: 208 m at 104 m/s
 *                                            with 2 s telemetry)
 *
 * `a_brake` is the hull's own dampened shed rate (never the thrust of a hull
 * that cannot hold its weight — `computeLandingProfile` has already refused
 * those). Evaluating this every tick is what bounds the fall: the faster the
 * ship falls, the higher the brake point climbs, so there is no separate
 * "dampener speed cap" to lose a write and free-fall through.
 */
export function landingBrakeAglM(input: {
  verticalSpeedMps: number;
  brakeDecelMps2: number;
  flareAglM: number;
  telemetryPeriodS: number;
}): number {
  const v = Math.abs(finite(input.verticalSpeedMps));
  const a = Math.max(LANDING_MIN_BRAKE_MPS2, finite(input.brakeDecelMps2, LANDING_MIN_BRAKE_MPS2));
  const stopM = (v * v) / (2 * a) * LANDING_LIVE_BRAKE_MARGIN;
  const lookaheadM = v * Math.max(0, finite(input.telemetryPeriodS, 1));
  return stopM + Math.max(0, finite(input.flareAglM)) + lookaheadM;
}

export interface LandingInput {
  massKg: number;
  /** Measured lift, N (sum of working thrusters opposing local up). */
  measuredUpThrustN: number | null;
  /** Altitude AGL where the lift was measured. */
  measuredAtAglM: number | null;
  /** Current vertical speed; negative is a descent, m/s. */
  verticalSpeedMps: number;
  /** The planet, for its gravity. */
  planet: Planet;
  /** Hard cruise cap for the fall, m/s. */
  maxCruiseMps: number;
  /**
   * How far the ground may be ABOVE the frame that produced the AGL, m. 0 when
   * the ground is known from the terrain field or a probe; the planet's hill
   * range when it is only the catalogue mean. Any figure other than 0 refuses
   * the landing: a fall-to-land on an unknown ground killed SAT-R-0002.
   */
  groundUncertaintyM: number;
  /**
   * Observed dampened shed rate of this hull from a brake that has actually
   * flown, m/s² (measured 7.2 on SAT-R-0001). Omitted before the first brake:
   * the planner then uses the authority implied by the measured up-thrust.
   */
  measuredShedMps2?: number | null;
  /**
   * Height at which the backend hands the ship to the final descent, m HULL
   * BOTTOM AGL (the brake stops here). Default `LANDING_HANDOVER_AGL_M`.
   */
  handoverAglM?: number;
}

export interface LandingProfile {
  ok: boolean;
  /** Plain sentence for the audit, whether the landing is planned or refused. */
  reason: string;
  /** Where the brake burn starts: this far above the true ground, m. */
  flareAglM: number;
  /**
   * Height at which the backend hands the ship to the final-descent mechanism
   * (`finalDescentMechanism`), m HULL BOTTOM AGL. Equal to `flareAglM`: the
   * brake stops the hull here and everything below belongs to the final
   * descent (dampener pulses today, a plugin `land_at` controller when the
   * plugin advertises `land_controller`).
   */
  handoverAglM: number;
  /**
   * Where the descending hull is placed when the burn is over: the flare plus
   * the height the burn needs to shed the entry speed, m AGL.
   */
  brakeStopAglM: number;
  /** Deceleration the flare burn is planned with (the hull's own authority). */
  flareDecelMps2: number;
  /**
   * How the flare burn is actually flown: dampeners shed vertical speed at
   * `brakeShedMps2` when that is less than the hull's authority (a dampened
   * stop, not a full-thrust burn that would throw the ship back up).
   */
  brakeShedMps2: number;
  /** Entry speed assumed for the burn: the measured descent, or the planned fall. */
  entryDescentMps: number;
  /** Height the burn needs to stop the descent, m. */
  stopDistanceM: number;
  /** Fall speed cap for this hull, m/s. */
  maxFallMps: number;
  /** Target descent for the dampened approach and the final descent, m/s. */
  approachMps: number;
  finalMps: number;
}

function refusedLanding(reason: string, maxFallMps = 0): LandingProfile {
  return {
    ok: false,
    reason,
    flareAglM: 0,
    handoverAglM: 0,
    brakeStopAglM: 0,
    flareDecelMps2: 0,
    brakeShedMps2: 0,
    entryDescentMps: 0,
    stopDistanceM: 0,
    maxFallMps,
    approachMps: LANDING_APPROACH_DESCENT_MPS,
    finalMps: LANDING_FINAL_DESCENT_MPS,
  };
}

/** How long the fall is expected to last before the brake, s (diagnostic). */
export const LANDING_FALL_ACCEL_MPS2 = 9.81;

/**
 * Plan where a landing's brake burn must start, from measured numbers only.
 *
 *   a_brake = upThrust / mass − g      (up-thrust measured, gravity modelled
 *                                       at the flare altitude — it is ~flat)
 *   stop    = v_measured² / (2 a_brake) · BRAKE_MARGIN
 *   flare   = max(40 m, 100 m, stop + 1 m)
 *
 * A heavier hull has the same thrust and a bigger weight, so `a_brake` is
 * smaller and it must start braking higher — that is the whole "based on how
 * heavy it is" requirement, and it falls out of the physics rather than a
 * lookup table.
 */
export function computeLandingProfile(input: LandingInput): LandingProfile {
  const mass = Math.max(1, input.massKg);
  const uncertainty = Math.max(0, finite(input.groundUncertaintyM));
  if (uncertainty > 0) {
    return refusedLanding(
      `ground height at this column is unknown (only the catalogue mean radius is available, ±${Math.round(uncertainty)} m); ` +
        'a landing cannot brake above ground it cannot measure — flying the dampened slow descent instead',
    );
  }
  if (!(input.measuredUpThrustN && input.measuredUpThrustN > 0) || input.measuredAtAglM === null) {
    return refusedLanding('upward thrust not measured: no landing brake without a measured lift component');
  }
  const weightN = mass * 9.81;
  // A hull that cannot even hold its own weight cannot stop a descent.
  if (input.measuredUpThrustN <= weightN * 1.02) {
    return refusedLanding(
      `lift ${(input.measuredUpThrustN / 1000).toFixed(0)} kN cannot hold ${(weightN / 1000).toFixed(0)} kN ` +
        `(${Math.round(mass)} kg): no brake authority for a landing`,
    );
  }
  const decel = (input.measuredUpThrustN - weightN) / mass;
  // The brake is what gravity plus the dampeners can do. Plan with the hull's
  // MEASURED shed rate x 0.7 (bounded 2..10), never a blanket constant: the old
  // 4.0 m/s² cap was not a measurement of anything, and measured 2026-11-10 it
  // fired the brake ~700 m too high (formula 1 832 m at 86 m/s) while the hull
  // actually shed at 7.2 m/s² — so the dampeners stopped it 500 m above the
  // flare and the phase deadlocked. A heavy hull is still limited by its own
  // thrust, because the shed can never exceed `decel`.
  const shed = landingShedRateMps2({ authorityMps2: decel, measuredShedMps2: input.measuredShedMps2 });
  if (!(shed >= LANDING_MIN_BRAKE_MPS2)) {
    return refusedLanding(
      `net upward brake ${shed.toFixed(2)} m/s² is below the ${LANDING_MIN_BRAKE_MPS2} m/s² landing minimum`,
    );
  }
  const gravity = gravityOf(input.planet);
  // Fall speed cap: the cruise cap, and no faster than the hull can shed in the
  // height between the brake point and the flare at its best-case authority.
  // The flare is also the HANDOVER height: the backend owns fall + brake down
  // to it, and the final-descent mechanism owns everything below it.
  const handoverAglM = Math.max(
    LANDING_FLARE_AGL_M,
    LANDING_MIN_BRAKE_AGL_M,
    finite(input.handoverAglM ?? NaN, LANDING_HANDOVER_AGL_M),
  );
  const flareAglM = handoverAglM;
  const authorityFallMps = Math.sqrt(2 * (gravity + decel) * Math.max(1, flareAglM - 1)) * 0.8;
  const capFallMps = Math.max(5, Math.min(finite(input.maxCruiseMps, DEFAULT_SPEED_LIMIT_MPS), authorityFallMps));
  // The entry speed the flare must kill: the measured descent if one is
  // running, otherwise the speed a gravity fall reaches at the flare, never
  // more than the cap the fall is flown at.
  const measuredMps = Math.abs(finite(input.verticalSpeedMps));
  const entryMps = Math.max(1, measuredMps, Math.min(capFallMps, Math.sqrt(2 * gravity * flareAglM)));
  // The height the burn needs to shed the entry speed at the dampened rate.
  // No extra 1.5x margin here: the ship is at the brake point when the burn
  // starts and the plan already carries the entry speed's own momentum, so a
  // margin on top is dead height the dampened descent would then have to sit
  // through at 5 m/s.
  const stopDistanceM = (entryMps * entryMps) / (2 * shed);
  const brakeStopAglM = flareAglM + stopDistanceM;
  return {
    ok: true,
    reason:
      `landing: planned fall ${Math.round(capFallMps)} m/s (the LIVE brake re-derives the brake height from the ` +
      `actual speed every tick, so the fall speed is bounded by that formula, not by this number), brake burn at ` +
      `${Math.round(brakeStopAglM)} m true AGL ` +
      `(${shed.toFixed(1)} m/s² dampened shed from ${(input.measuredUpThrustN / 1000).toFixed(0)} kN up on ${Math.round(mass)} kg, ` +
      `stops the ${Math.round(entryMps)} m/s fall in ${stopDistanceM.toFixed(0)} m), flare at ${Math.round(flareAglM)} m, ` +
      `then ${LANDING_APPROACH_DESCENT_MPS} m/s to ${LANDING_FINAL_DESCENT_AGL_M} m and ${LANDING_FINAL_DESCENT_MPS} m/s to touchdown`,
    flareAglM: Math.round(flareAglM),
    handoverAglM: Math.round(handoverAglM),
    brakeStopAglM: Math.round(brakeStopAglM),
    flareDecelMps2: Math.round(decel * 100) / 100,
    brakeShedMps2: Math.round(shed * 100) / 100,
    entryDescentMps: Math.round(entryMps * 10) / 10,
    stopDistanceM: Math.round(stopDistanceM),
    maxFallMps: Math.round(capFallMps * 10) / 10,
    approachMps: LANDING_APPROACH_DESCENT_MPS,
    finalMps: LANDING_FINAL_DESCENT_MPS,
  };
}

/** Local gravity for the landing model, m/s² (~1 g on the owner's planets). */
function gravityOf(_planet: Planet): number {
  return 9.81;
}

/**
 * Which dampened-descent speed the landing phases ask for at a given AGL:
 * <= 5 m/s down to 15 m, <= 1 m/s below it. Independent of the ship, because
 * the flare has already taken the speed out.
 */
export function landingApproachSpeedMps(altitudeAglM: number): number {
  return altitudeAglM <= LANDING_FINAL_DESCENT_AGL_M ? LANDING_FINAL_DESCENT_MPS : LANDING_APPROACH_DESCENT_MPS;
}

/**
 * The owner's landing request, carried in the mission's desiredState. It is
 * applied to the drone's slot when the executor seeds the drone, so every
 * flight path sees one absolute waypoint (the ground point) and one intent.
 */
export interface LandingIntent {
  /**
   * `land`: descend onto the ground point (the four landing phases).
   * `park`: stop at the requested point. A point on the ground is a landing;
   * an airborne point is held there (the executor decides and says which).
   */
  kind: 'land' | 'park';
  flareAglM: number;
}

/**
 * Read a landing request out of a mission's desiredState. Accepted shapes:
 * `{ land: true }`, `{ mode: 'land' }`, `{ landing: { flareAglM } }`, and — for a
 * GPS destination — `position` plus any of those. `{ park: true }` /
 * `{ mode: 'park' }` is the softer request: park at the point, and only land if
 * that point is on the ground. A bare `altitudeM: 0` is NOT a landing: an
 * operator asking for "0 m" gets the refusal the ground datum rule already
 * gives, and must ask for a landing in so many words.
 */
export function readLandingIntent(desiredState: Record<string, unknown> | null | undefined): LandingIntent | null {
  if (!desiredState) return null;
  const landing = desiredState.landing;
  const mode = String(desiredState.mode ?? '').toLowerCase();
  const wantsLand =
    desiredState.land === true ||
    mode === 'land' ||
    (typeof landing === 'object' && landing !== null);
  const wantsPark = desiredState.park === true || mode === 'park';
  if (!wantsLand && !wantsPark) return null;
  const raw = typeof landing === 'object' && landing !== null ? (landing as { flareAglM?: unknown }).flareAglM : null;
  const flare = Number(raw);
  return {
    kind: wantsLand ? 'land' : 'park',
    flareAglM: Number.isFinite(flare) && flare >= LANDING_FLARE_AGL_M ? flare : LANDING_FLARE_AGL_M,
  };
}

// ------------------------------------------------------- ground datum safety

/**
 * Clearance a planned brake point (or hold) must keep above the ground the ship
 * will actually hit, m. Measured 2026-11-10: SAT-R-0002 hit the hill at
 * 104.4 m/s because its brake point was 415 m UNDER the terrain, so the margin
 * is not a nicety.
 */
export const GROUND_CLEARANCE_M = 100;
/**
 * Hold floor for a COME-TO-ME hover (owner decision 2026-11-11): the hull
 * bottom sits 80 m above the TRUE ground, low enough that the hand-flown
 * landing is a short descent and high enough not to be a landing pattern.
 *
 * It is deliberately NOT `GROUND_CLEARANCE_M`: the 100 m figure is the STATION
 * rule (a station needs >=100 m AGL) and stays for stations. A come-to-me
 * hover is never converted to a station, so it must never be judged by the
 * station floor — that mismatch refused a legal 80 m hover before it flew.
 */
export const COME_TO_ME_HOLD_FLOOR_M = 80;

export interface GroundSafetyInput {
  /**
   * Altitude of the point being planned above the frame's own ground
   * reference, m (goes negative when the point is below the real ground).
   */
  targetAglM: number;
  /** Where that ground reference came from. */
  source: AltitudeSource;
  /** `groundUncertaintyM` from the same frame, m. */
  groundUncertaintyM: number;
  /** What is being planned; only used in the refusal sentence. */
  intent?: 'descent' | 'hold';
  /**
   * The same point measured against the catalogue MEAN radius, m. Only used in
   * the refusal sentence: it is the altitude an operator asked for, and it is
   * the number that used to look safe.
   */
  nominalAglM?: number;
  /** Ground radius of the frame, m (for the refusal sentence). */
  groundRadiusM?: number;
  /** Catalogue mean radius, m (for the refusal sentence). */
  surfaceRadiusM?: number;
  /**
   * Clearance this point must keep above the real ground, m. Defaults to
   * `GROUND_CLEARANCE_M` (100, the station rule). A come-to-me hold passes
   * `COME_TO_ME_HOLD_FLOOR_M` (80) instead.
   */
  floorM?: number;
}

export interface GroundSafetyVerdict {
  ok: boolean;
  /** Plain sentence, null when ok. */
  reason: string | null;
  /** Lowest AGL the point may have, m: 100 (known ground) or uncertainty + 100. */
  requiredAglM: number;
}

/**
 * The one ground-datum rule: a brake point or hold must sit at least
 * `GROUND_CLEARANCE_M` above the REAL ground.
 *
 *   * ground known (terrain / probe): target AGL >= 100 m;
 *   * ground unknown (mean): target AGL >= uncertainty + 100 m, i.e. outside
 *     the band the terrain could occupy. Anything inside it is refused with a
 *     plain sentence, long before a fall starts, because a brake point inside
 *     that band may already be inside the hill.
 */
export function groundSafetyVerdict(input: GroundSafetyInput): GroundSafetyVerdict {
  const uncertainty = input.source === 'mean' ? Math.max(0, finite(input.groundUncertaintyM)) : 0;
  // The floor is a parameter, not a constant: the station rule wants 100 m, a
  // come-to-me hover 80 m. Anything non-positive falls back to the station
  // rule rather than silently lowering the bar.
  const requestedFloorM = finite(Number(input.floorM ?? GROUND_CLEARANCE_M));
  const floorM = requestedFloorM > 0 ? requestedFloorM : GROUND_CLEARANCE_M;
  const requiredAglM = uncertainty + floorM;
  if (finite(input.targetAglM) >= requiredAglM) {
    return { ok: true, reason: null, requiredAglM };
  }
  const target = Math.round(finite(input.targetAglM));
  const intent = input.intent ?? 'descent';
  if (input.source === 'mean') {
    return {
      ok: false,
      requiredAglM,
      reason:
        intent === 'hold'
          ? `ground height unknown at this column; a hold at ${target} m could be inside terrain`
          : `ground height unknown at this column; a descent to ${target} m could brake inside terrain`,
    };
  }
  const groundRadiusM = finite(Number(input.groundRadiusM ?? 0));
  const surfaceRadiusM = finite(Number(input.surfaceRadiusM ?? 0));
  const nominalM = Math.round(finite(Number(input.nominalAglM ?? input.targetAglM)));
  // No usable catalogue mean (the drone had no planet, or one without a
  // radius): a "delta from the mean" would be invented, so the sentence only
  // states the clearance that was actually measured.
  if (!(surfaceRadiusM > 0)) {
    return {
      ok: false,
      requiredAglM,
      reason:
        `${intent === 'hold' ? 'hold at' : 'descent to'} ${nominalM} m AGL is unsafe: only ` +
        `${target} m of clearance above the measured ground (${Math.round(floorM)} m required)`,
    };
  }
  const aboveMeanM = Math.round(groundRadiusM - surfaceRadiusM);
  // The clearance (`target`) is measured from the TERRAIN at this column, and
  // `nominalM` from the catalogue mean. Printing both as "AGL" (verify #4: a
  // landed ship read "hold at 1809 m AGL ... leaving 1 m of clearance") reports
  // two different datums in one sentence, so each number is named.
  return {
    ok: false,
    requiredAglM,
    reason:
      `${intent === 'hold' ? 'hold at' : 'descent to'} ${nominalM} m above the catalogue mean is unsafe: the ground at this column is ` +
      `${aboveMeanM} m above that mean (${Math.round(groundRadiusM)} m vs ` +
      `${Math.round(surfaceRadiusM)} m), so the clearance above the measured ground is ${target} m ` +
      `(${Math.round(floorM)} m required)`,
  };
}

// ------------------------------------------------------------- arrival guards

/** A hull below this fraction of its commanded speed is not achieving it. */
export const ARRIVAL_SHORTFALL_RATIO = 0.5;
/** ...for longer than this while the range barely closes: abort. */
export const ARRIVAL_SHORTFALL_MS = 10_000;
/** Closing rate below which the range counts as "not really decreasing", m/s. */
export const ARRIVAL_SHORTFALL_CLOSING_MPS = 1;
/**
 * Grace after the leg order before the shortfall window may arm: a heavy hull
 * accelerating from rest is below half its cruise speed for a while.
 *
 * It matches the crawl grace now that BOTH detectors read the same sliding
 * telemetry window: the closing condition is what protects a slow (but real)
 * acceleration, and the window is what supplies the evidence, so a 15 s grace
 * would make `hull-speed` (a hull that makes a third of its commanded speed
 * and does not close at all) lose to `hull-crawl` purely on timing.
 */
export const ARRIVAL_SHORTFALL_GRACE_MS = 7_000;
/**
 * Inside this range the normal arrival caps (5 m/s -> 1 m/s) command a speed
 * the hull is not expected to match exactly, and the arrival logic owns the
 * ship. The speed-shortfall detector stays out of it.
 */
export const ARRIVAL_SHORTFALL_MIN_RANGE_M = 50;
/**
 * Slow-crawl guard (measured 2026-11-10): a 2 km ascent commanded at 100 m/s
 * held 1.2-1.7 m/s for the whole 300 s leg. The old bar needed the closing rate
 * under 1 m/s, and this hull closed at ~1.5 m/s, so the guard never armed and
 * the mission died on the arrival timeout instead. A leg that is more than
 * ARRIVAL_CRAWL_MIN_RANGE_M from its slot and closing slower than
 * ARRIVAL_CRAWL_CLOSING_MPS for ARRIVAL_CRAWL_MS is crawling, whatever speed it
 * thinks it is achieving.
 */
export const ARRIVAL_CRAWL_CLOSING_MPS = 2;
/** ...only once the slot is at least this far away, m. */
export const ARRIVAL_CRAWL_MIN_RANGE_M = 500;
/**
 * Sliding window the closing rate is measured over, ms.
 *
 * Measured 2026-11-10: with 2 s telemetry and a 1 s tick the per-tick closing
 * rate alternates 0.0 / 3.0 m/s, so "under 2 m/s for 20 s continuously" never
 * held and `demo_arrival_crawl` produced zero rows through a real crawl. The
 * window is a distance change over elapsed TELEMETRY time, so a gap between
 * samples is harmless: what matters is how far the ship actually travelled.
 * Its length is also the dwell the crawl detector used to need — the window
 * IS the evidence, so a 1.5 m/s crawl trips it 20 s after the leg starts, well
 * inside the 30 s the abort must fit in.
 */
export const ARRIVAL_SAMPLE_WINDOW_MS = 20_000;
/**
 * ...but a window shorter than this is not evidence of anything (the ship is
 * still accelerating out of the order): the stuck/shortfall detector waits for
 * at least this much telemetry time before it reads a closing rate. It must
 * stay below half the crawl window, or the slower crawl branch would always
 * reach its (longer) evidence first and a hull that makes a third of its
 * commanded speed but does not close at all would be reported as a crawl
 * instead of a speed shortfall.
 */
export const ARRIVAL_WINDOW_MIN_MS = 5_000;
/** ...for longer than this, then abort with commanded vs achieved. */
export const ARRIVAL_CRAWL_MS = ARRIVAL_SAMPLE_WINDOW_MS;
/**
 * Grace after the leg order before the crawl window may arm, ms. Shorter than
 * the speed-shortfall grace: closing at under 2 m/s with more than 500 m to go
 * is unambiguous after the spin-up, and the 20 s WINDOW is the evidence. The
 * measured 100 m/s command / 1.5 m/s close (~1.7 km out) therefore aborts in
 * under 30 s instead of waiting out the 300 s arrival timeout.
 */
export const ARRIVAL_CRAWL_GRACE_MS = 7_000;

/**
 * Vertical arrival radius (2026-11-10): a descent that stopped 19 m above its
 * slot hovered forever, because the radius was 10 m while the terminal hold
 * refuses to fly faster than 1 m/s. A descent within this many metres
 * VERTICALLY that is below ARRIVAL_VERTICAL_SETTLED_MPS counts as on its slot.
 */
export const ARRIVAL_VERTICAL_RADIUS_M = 25;
/** Vertical speed under which such a descent is settling, not approaching. */
export const ARRIVAL_VERTICAL_SETTLED_MPS = 1;
/** A range that grows this far past its closest approach is one swing. */
export const ARRIVAL_CYCLE_AMPLITUDE_M = 50;
/** This many swings is a limit cycle, not an approach. */
export const ARRIVAL_CYCLE_SWINGS = 2;

/**
 * ...and this close to the slot with the altitude ALREADY made, the leg is in
 * its final settle, not on a cruise.
 *
 * Measured 2026-11-11 (SAT-R-0001, climb to 760 m): the ship reached 761.6 m
 * hull-bottom AGL - its slot's altitude - with 143 m of lateral trim left, and
 * the SE autopilot settled at 2.7 m/s. The speed-shortfall guard compared that
 * 2.7 m/s against the ladder step's cruise command (63.3 m/s = 4 %) for 10 s
 * and aborted a climb that had arrived, holding the hull 143 m from the column
 * it was told to reach. A hull that has made its altitude and is closing the
 * last couple of hundred metres is being flown by the arrival taper (5 m/s
 * inside 100 m), so its speed says nothing about its thrust.
 */
export const ARRIVAL_SETTLE_RANGE_M = 200;
/** Vertical miss, m, under which a slot's altitude counts as already made. */
export const ARRIVAL_SETTLE_VERTICAL_M = ARRIVAL_VERTICAL_RADIUS_M;

/**
 * The speed a leg actually asks for at this range, m/s - the number the speed
 * guards must compare against.
 *
 * A leg is ordered at one cruise speed, but from the moment the arrival taper
 * owns it the autopilot is being asked for far less: `sqrt(2·a·d/1.5)` with the
 * 5 m/s (inside 100 m) and 1 m/s (inside 10 m) cap. Comparing an achieved speed
 * to the cruise command inside that taper charges the hull for obeying us.
 * `legLimitMps` is the speed the last order carried; `plannedCruiseMps` the
 * leg profile's cruise (0/undefined = unknown, ignored).
 */
export function arrivalCommandSpeedMps(input: {
  legLimitMps: number;
  remainingM: number;
  decelMps2?: number;
  plannedCruiseMps?: number | null;
}): number {
  const leg = Number.isFinite(input.legLimitMps) && input.legLimitMps > 0 ? input.legLimitMps : 1;
  const planned = Number(input.plannedCruiseMps ?? 0);
  const cruise = Number.isFinite(planned) && planned > 0 ? Math.min(leg, planned) : leg;
  const decel = Number(input.decelMps2 ?? 0);
  // No usable decel: the leg limit is all we know, and inventing a braking
  // curve would silently raise the command above what was ordered.
  if (!(decel > 0)) return Math.max(1, Math.round(cruise * 10) / 10);
  const safe = safeApproachSpeedMps(Math.max(0.1, input.remainingM), decel, cruise);
  return Math.max(1, Math.round(safe * 10) / 10);
}

/** One telemetry sample of the range to the slot (kept for the sliding window). */
export interface ArrivalWindowSample {
  /** When that position fix arrived (telemetry timestamp), ms. */
  atMs: number;
  remainingM: number;
}

/** Per-drone arrival tracking (persisted in the executor's guard state). */
export interface ArrivalProgressState {
  lastRemainingM: number | null;
  lastAtMs: number | null;
  /** When the achieved speed first fell below half the commanded speed. */
  shortfallSinceMs: number | null;
  /** When the closing rate first fell under the slow-crawl bar, far from the slot. */
  crawlSinceMs: number | null;
  /** Closest range seen since the last counted swing. */
  cycleLowM: number | null;
  cycleTrend: 'shrink' | 'grow' | null;
  cycleSwings: number;
  /** One swing per reversal pair, so a monotone climb counts once. */
  swingCounted: boolean;
  /**
   * Range samples inside the sliding window, oldest first, stamped with the
   * TELEMETRY time they were observed at. Without this the closing rate was a
   * one-tick difference: with 2 s telemetry and a 1 s tick it alternated
   * 0 / 3 m/s and a real crawl never armed (measured 2026-11-10).
   */
  window: ArrivalWindowSample[];
}

export interface ArrivalSample {
  nowMs: number;
  remainingM: number;
  speedMps: number;
  commandedMps: number;
  /** When the leg order went out; the shortfall window cannot arm before the grace. */
  legStartedAtMs?: number | null;
  /**
   * When the position fix behind `remainingM` was observed. Defaults to
   * `nowMs`; the executor passes `unit.lastSeen`, so two ticks on one sample
   * never look like a zero-closing interval.
   */
  observedAtMs?: number | null;
  /**
   * Vertical miss to the slot, m (|hull-bottom AGL now − hull-bottom AGL of the
   * slot|). Together with `remainingM` it tells the final settle of a
   * near-vertical leg (altitude made, lateral trim left) from a hull that
   * cannot fly, which is the 2026-11-11 climb abort. Omitted = unknown, and
   * the settle exemption stays off.
   */
  verticalMissM?: number | null;
}

export interface ArrivalProgress {
  state: ArrivalProgressState;
  /** Range rate, m/s; positive means the ship is closing on its slot. */
  closingMps: number;
  /**
   * True when the leg is in its final settle: inside ARRIVAL_SETTLE_RANGE_M
   * with its altitude already made (|vertical miss| <=
   * ARRIVAL_SETTLE_VERTICAL_M). The speed detectors are silent there because
   * the arrival taper, not the hull, sets the speed (2026-11-11 climb abort).
   */
  settle: boolean;
  /** Set once the hull has failed to make half its commanded speed for long enough. */
  stuck: {
    commandedMps: number;
    achievedMps: number;
    ratio: number;
    dwellS: number;
    closingMps: number;
  } | null;
  /**
   * Set once the leg has been closing slower than ARRIVAL_CRAWL_CLOSING_MPS
   * with more than ARRIVAL_CRAWL_MIN_RANGE_M to go for longer than
   * ARRIVAL_CRAWL_MS. This is the measured 2026-11-10 climb crawl: the ship
   * achieved 1.7 m/s of a 100 m/s command and closed at ~1.5 m/s, just above
   * the old 1 m/s bar, until the 300 s arrival timeout killed the mission.
   */
  crawl: {
    commandedMps: number;
    achievedMps: number;
    closingMps: number;
    dwellS: number;
    remainingM: number;
  } | null;
  /** Set when the range grew this sample by more than the cycle amplitude. */
  swing: { swings: number; amplitudeM: number; lowM: number } | null;
  /** True when the swings add up to a limit cycle. */
  limitCycle: boolean;
}

export function emptyArrivalProgress(): ArrivalProgressState {
  return {
    lastRemainingM: null,
    lastAtMs: null,
    shortfallSinceMs: null,
    crawlSinceMs: null,
    cycleLowM: null,
    cycleTrend: null,
    cycleSwings: 0,
    swingCounted: false,
    window: [],
  };
}

/**
 * Closing rate over the sliding telemetry window, m/s (positive = closing).
 *
 * Only samples observed at least `minSpanMs` apart are evidence; below that the
 * hull is still spinning up and a zero rate means nothing. Returns null when
 * the window is too short to read.
 */
export function windowClosingMps(
  window: ArrivalWindowSample[],
  remainingM: number,
  minSpanMs = ARRIVAL_WINDOW_MIN_MS,
): { closingMps: number; spanMs: number } | null {
  if (window.length === 0) return null;
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const spanMs = last.atMs - first.atMs;
  if (spanMs < minSpanMs || spanMs <= 0) return null;
  return { closingMps: ((first.remainingM - remainingM) / spanMs) * 1000, spanMs };
}

/**
 * Arrival loop detector (overnight run 2026-11-10, FAILURE 2).
 *
 * Two plain failures were measured in the game:
 *
 *  - a hull near its hover ceiling never reached the commanded 92.5 m/s; the
 *    guard kept commanding it and the leg ran for 300 s without arriving, and
 *  - the range oscillated 65 -> 295 m at ~3 m/s: a limit cycle, not an
 *    approach.
 *
 * This is pure bookkeeping over successive telemetry samples; the executor
 * decides what to send. `stuck` trips when the achieved speed stayed below
 * ARRIVAL_SHORTFALL_RATIO of the commanded speed for more than
 * ARRIVAL_SHORTFALL_MS while the range closed by less than
 * ARRIVAL_SHORTFALL_CLOSING_MPS, outside the terminal
 * ARRIVAL_SHORTFALL_MIN_RANGE_M where the arrival caps own the ship. `swing`
 * counts each time the range grows ARRIVAL_CYCLE_AMPLITUDE_M past its closest
 * approach; the second one is a limit cycle.
 */
export function arrivalProgress(prev: ArrivalProgressState, sample: ArrivalSample): ArrivalProgress {
  const state: ArrivalProgressState = { ...prev, window: [...(prev.window ?? [])] };
  const observedAtMs = sample.observedAtMs ?? sample.nowMs;
  // --- sliding telemetry window (2 s samples, 1 s ticks: per-tick rates lie)
  while (state.window.length > 0 && observedAtMs - state.window[0]!.atMs > ARRIVAL_SAMPLE_WINDOW_MS) {
    state.window.shift();
  }
  const lastSample = state.window[state.window.length - 1];
  if (!lastSample || observedAtMs > lastSample.atMs) {
    state.window.push({ atMs: observedAtMs, remainingM: sample.remainingM });
  } else {
    // Same fix seen again (a tick between two telemetry samples): refresh the
    // range of that sample instead of inventing a zero-length interval.
    lastSample.remainingM = sample.remainingM;
  }
  const windowRate = windowClosingMps(state.window, sample.remainingM);
  const closingMps = windowRate?.closingMps ?? 0;

  // --- limit cycle: closest approach, then a climb back out past the amplitude
  if (state.cycleLowM === null || sample.remainingM < state.cycleLowM) {
    state.cycleLowM = sample.remainingM;
  }
  if (state.lastRemainingM !== null) {
    if (sample.remainingM < state.lastRemainingM) state.cycleTrend = 'shrink';
    else if (sample.remainingM > state.lastRemainingM) state.cycleTrend = 'grow';
  }
  let swing: ArrivalProgress['swing'] = null;
  if (state.cycleTrend === 'shrink') {
    // A fresh approach: the next climb back out is a new swing.
    state.swingCounted = false;
  } else if (state.cycleTrend === 'grow' && !state.swingCounted && state.cycleLowM !== null) {
    const amplitudeM = sample.remainingM - state.cycleLowM;
    if (amplitudeM >= ARRIVAL_CYCLE_AMPLITUDE_M) {
      state.cycleSwings += 1;
      state.swingCounted = true;
      swing = { swings: state.cycleSwings, amplitudeM, lowM: state.cycleLowM };
    }
  }

  // --- final settle of a near-vertical leg (2026-11-11 climb abort)
  // The ship made its altitude (within ARRIVAL_SETTLE_VERTICAL_M) and is
  // closing the last ARRIVAL_SETTLE_RANGE_M laterally. Inside that band the
  // arrival taper owns the speed (5 m/s under 100 m), so the hull's speed is
  // not evidence about its thrust.
  const verticalMiss = sample.verticalMissM;
  const settle =
    sample.remainingM <= ARRIVAL_SETTLE_RANGE_M &&
    // Outside the vertical-arrival radius the arrival logic must still own the
    // last metres (a descent 19 m above its slot is an ARRIVAL, not a settle).
    sample.remainingM > ARRIVAL_VERTICAL_RADIUS_M &&
    typeof verticalMiss === 'number' &&
    Number.isFinite(verticalMiss) &&
    Math.abs(verticalMiss) <= ARRIVAL_SETTLE_VERTICAL_M;

  // --- stuck hull: cannot make half the commanded speed, and is not closing
  const commandedMps = Math.max(1, sample.commandedMps);
  const elapsedSinceLeg = sample.legStartedAtMs === null || sample.legStartedAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : sample.nowMs - sample.legStartedAtMs;
  // The shortfall branch reads the SAME windowed rate: a 2 s telemetry cadence
  // made one-tick closing alternate 0/3 m/s here too.
  const shortfall =
    !settle &&
    sample.remainingM > ARRIVAL_SHORTFALL_MIN_RANGE_M &&
    elapsedSinceLeg > ARRIVAL_SHORTFALL_GRACE_MS &&
    sample.speedMps < commandedMps * ARRIVAL_SHORTFALL_RATIO &&
    windowRate !== null &&
    windowRate.closingMps < ARRIVAL_SHORTFALL_CLOSING_MPS;
  if (shortfall) {
    if (state.shortfallSinceMs === null) state.shortfallSinceMs = sample.nowMs;
  } else {
    state.shortfallSinceMs = null;
  }
  const dwellS = state.shortfallSinceMs === null ? 0 : (sample.nowMs - state.shortfallSinceMs) / 1000;
  const stuck =
    state.shortfallSinceMs !== null && dwellS * 1000 > ARRIVAL_SHORTFALL_MS
      ? {
          commandedMps,
          achievedMps: sample.speedMps,
          ratio: sample.speedMps / commandedMps,
          dwellS,
          closingMps,
        }
      : null;

  // --- slow crawl: > 500 m to go and closing at ~1.5 m/s (measured 2026-11-10)
  // The evidence is the WINDOW, not a per-tick rate and not a dwell counted on
  // those rates: 20 s of telemetry whose range changed by less than
  // ARRIVAL_CRAWL_CLOSING_MPS × 20 s. With 2 s samples the tick-to-tick rate
  // alternates 0/3 m/s, but the distance the ship actually covered cannot.
  const crawlWindow =
    windowRate !== null && windowRate.spanMs >= ARRIVAL_SAMPLE_WINDOW_MS ? windowRate : null;
  const crawling =
    crawlWindow !== null &&
    sample.remainingM > ARRIVAL_CRAWL_MIN_RANGE_M &&
    elapsedSinceLeg > ARRIVAL_CRAWL_GRACE_MS &&
    crawlWindow.closingMps < ARRIVAL_CRAWL_CLOSING_MPS;
  if (crawling) {
    if (state.crawlSinceMs === null) state.crawlSinceMs = sample.nowMs;
  } else {
    state.crawlSinceMs = null;
  }
  const crawl =
    crawling && crawlWindow !== null
      ? {
          commandedMps,
          achievedMps: sample.speedMps,
          closingMps: crawlWindow.closingMps,
          dwellS: crawlWindow.spanMs / 1000,
          remainingM: sample.remainingM,
        }
      : null;

  state.lastRemainingM = sample.remainingM;
  state.lastAtMs = sample.nowMs;
  return { state, closingMps, settle, stuck, crawl, swing, limitCycle: state.cycleSwings >= ARRIVAL_CYCLE_SWINGS };
}

/**
 * Re-send policy: one move per leg. A new order is only justified when the
 * required speed moved more than 20 % (the guard is throttling the ship down
 * for the approach) or an explicit guard event asked for it.
 */
export function shouldResendMove(
  sentSpeedMps: number,
  requiredSpeedMps: number,
  guardTriggered: boolean,
  threshold = 0.2,
): boolean {
  if (guardTriggered) return true;
  const sent = Math.max(0.1, sentSpeedMps);
  return Math.abs(requiredSpeedMps - sentSpeedMps) / sent > threshold;
}

// --------------------------------------------------------- climb ladder

/**
 * A near-vertical leg crawls, measured in game 2026-11-10 on SAT-R-0001:
 *
 *   * one waypoint straight up (1 672 m) peaked at 37.6 m/s and decayed, while
 *     the same hull on a diagonal leg held 99.9 m/s and a horizontal move held
 *     20 m/s of a 20 m/s order (re-measured 2026-11-10 on the same grid);
 *   * a waypoint straight DOWN is worse — the hull climbed 1.2 m/s away from a
 *     point 173 m below it, and a 0.8 m/s descent order produced a 0.65 m/s
 *     CLIMB. The autopilot's vertical handling on this hull is not usable at
 *     any commanded speed, so no ground phase may depend on it.
 *
 * The previous fix displaced only the first 120 m of the leg (a dogleg), then
 * flew the remaining 1 552 m of a 1 672 m climb at 85.6 deg above the horizon:
 * the crawl was untouched. The fix is therefore the geometry of the WHOLE leg:
 * a ladder of waypoints, each leg at most CLIMB_MAX_ELEVATION_DEG above the
 * horizon, alternating sides so the ship also stays near the column it started
 * over (a landing needs that) instead of drifting a kilometre away.
 *
 *   rise per step  R = CLIMB_STEP_RISE_M
 *   lateral        L = R / tan(60 deg)      (~0.577 R)
 *   waypoint k     = base + up*k*R + side*(+L or -L, alternating)
 *   final waypoint = the leg's own target
 *
 * Every leg is then either (R, L) = 60 deg, (R, 2L) = 40.9 deg, or the short
 * last leg (remaining <= R, L) <= 60 deg, so no leg ever asks the autopilot for
 * a near-vertical waypoint. The measured horizontal leg is the fast one, so the
 * shallower the better; 60 deg is the task's ceiling and the first step is the
 * only leg at it.
 */
export const CLIMB_MAX_ELEVATION_DEG = 60;
/** Rise per ladder step, m. 1 672 m of climb is 5 steps. */
export const CLIMB_STEP_RISE_M = 350;
/** Lateral offset of a step per metre of its rise: 1/tan(60 deg). */
export const CLIMB_LATERAL_RATIO = 1 / Math.tan((CLIMB_MAX_ELEVATION_DEG * Math.PI) / 180);
/** A ladder waypoint counts as reached inside this distance, m. */
export const CLIMB_WP_ARRIVE_M = 25;
/** Below this rise a leg is not worth a ladder, m. */
export const CLIMB_MIN_VERTICAL_M = 120;
/** Lateral offset floor, so a short final leg is never near-vertical, m. */
export const CLIMB_MIN_LATERAL_M = 20;
export interface FlightVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ClimbLeg {
  /** Elevation of this leg above the horizon, degrees. */
  elevationDeg: number;
  riseM: number;
  lateralM: number;
}

export interface ClimbLadder {
  /** Ordered waypoints; the LAST one is the leg's own target. */
  waypoints: FlightVec3[];
  /** Per-leg geometry, same length as `waypoints`. */
  legs: ClimbLeg[];
  /** Steepest leg in the ladder, degrees (never above the ceiling). */
  maxElevationDeg: number;
  /** Vertical extent of the whole leg, m. */
  verticalM: number;
  /** In-plane horizontal offset the original leg already had, m. */
  baseHorizontalM: number;
}

function unitPerpendicularTo(up: FlightVec3): FlightVec3 {
  // Deterministic: a fixed world axis, made perpendicular to `up` and
  // normalised. Determinism matters — the audit and the tests must see the
  // same ladder for the same leg.
  const axis = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const d = axis.x * up.x + axis.y * up.y + axis.z * up.z;
  const raw = { x: axis.x - up.x * d, y: axis.y - up.y * d, z: axis.z - up.z * d };
  const lenM = Math.hypot(raw.x, raw.y, raw.z) || 1;
  return { x: raw.x / lenM, y: raw.y / lenM, z: raw.z / lenM };
}

/**
 * Elevation of the straight line from `from` to `to` above the local horizon,
 * degrees: +90 is straight up the gravity vector, -90 straight below it, 0 is
 * horizontal. This is the quantity the SE autopilot actually cares about —
 * measured 2026-11-10 on SAT-R-0001 a waypoint straight up crawled at 37.6 m/s
 * peak and one straight below made the ship climb AWAY at 1.1-1.2 m/s, while
 * horizontal legs flew at 99.9 m/s.
 */
export function waypointElevationDeg(from: FlightVec3, to: FlightVec3, up: FlightVec3): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-6)) return 0;
  const upLength = Math.hypot(up.x, up.y, up.z);
  if (!(upLength > 1e-6)) return 0;
  const vertical = (dx * up.x + dy * up.y + dz * up.z) / (length * upLength);
  return (Math.asin(clampUnit(vertical)) * 180) / Math.PI;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

export interface WaypointAngleVerdict {
  /** True when the waypoint is inside the autopilot's usable envelope. */
  ok: boolean;
  /** Elevation of the line to the waypoint above the horizon, degrees. */
  elevationDeg: number;
  /** Length of the leg, m. */
  distanceM: number;
  /** Plain sentence, null when ok. */
  reason: string | null;
}

/**
 * Inside this distance a "move" is a terminal nudge, not a leg the autopilot
 * has to fly: every landing, staging and arrival re-send ends with a sub-10 m
 * waypoint almost straight above/below the ship while the arrival logic (not
 * the autopilot's cruise controller) owns it. Measured legs are therefore
 * measured from this threshold; a real leg is always longer.
 */
export const WAYPOINT_MIN_GUARD_M = 10;

/**
 * THE waypoint guard. Every move order the executor builds passes through
 * this, so no code path can hand the SE autopilot a waypoint within
 * `maxDeg` of the vertical (either direction): measured 2026-11-10 the
 * autopilot cannot fly those legs at all, so a descent has to be flown with
 * dampeners/thrust, never with a waypoint.
 */
export function waypointAngleVerdict(input: {
  from: FlightVec3;
  to: FlightVec3;
  up: FlightVec3;
  maxDeg?: number;
  intent?: string;
}): WaypointAngleVerdict {
  const maxDeg = Math.abs(input.maxDeg ?? CLIMB_MAX_ELEVATION_DEG);
  const elevationDeg = Math.round(waypointElevationDeg(input.from, input.to, input.up) * 10) / 10;
  const distanceM = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y, input.to.z - input.from.z);
  if (distanceM < WAYPOINT_MIN_GUARD_M) return { ok: true, elevationDeg, distanceM, reason: null };
  if (Math.abs(elevationDeg) <= maxDeg) return { ok: true, elevationDeg, distanceM, reason: null };
  const intent = input.intent ?? 'move';
  const direction = elevationDeg > 0 ? 'above the horizon' : 'below the horizon';
  return {
    ok: false,
    elevationDeg,
    distanceM,
    reason:
      `${intent} waypoint is ${absolute(elevationDeg).toFixed(1)} deg ${direction} over the ${maxDeg} deg ` +
      'autopilot limit: the autopilot cannot fly this leg (measured 2026-11-10: it crawls up, and climbs away ' +
      'from a point below), so the waypoint is re-aimed onto the limit',
  };
}

function absolute(value: number): number {
  return value < 0 ? -value : value;
}

/**
 * Split a climb into waypoints no steeper than `CLIMB_MAX_ELEVATION_DEG`, or
 * null when the leg is already flyable as it is (or too short to matter).
 */
export function climbLadder(
  from: FlightVec3,
  to: FlightVec3,
  up: FlightVec3,
  options: { stepRiseM?: number; maxElevationDeg?: number } = {},
): ClimbLadder | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const verticalM = dx * up.x + dy * up.y + dz * up.z;
  if (!(verticalM >= CLIMB_MIN_VERTICAL_M)) return null;
  const horizontalM = Math.hypot(dx - up.x * verticalM, dy - up.y * verticalM, dz - up.z * verticalM);
  const elevationDeg = (Math.atan2(verticalM, horizontalM) * 180) / Math.PI;
  if (elevationDeg <= CLIMB_MAX_ELEVATION_DEG) return null;

  const ceilingDeg = options.maxElevationDeg ?? CLIMB_MAX_ELEVATION_DEG;
  const riseM = Math.max(CLIMB_MIN_VERTICAL_M, options.stepRiseM ?? CLIMB_STEP_RISE_M);
  const steps = Math.max(1, Math.ceil(verticalM / riseM));
  const stepRise = verticalM / steps;
  const lateralM = Math.max(
    CLIMB_MIN_LATERAL_M,
    stepRise / Math.tan((ceilingDeg * Math.PI) / 180),
  );
  const side = unitPerpendicularTo(up);

  // The original leg's own horizontal offset is folded into the last waypoint,
  // which is the target itself.
  const waypoints: FlightVec3[] = [];
  for (let k = 1; k < steps; k += 1) {
    const rise = stepRise * k;
    const sign = k % 2 === 1 ? 1 : -1;
    waypoints.push({
      x: from.x + up.x * rise + side.x * lateralM * sign,
      y: from.y + up.y * rise + side.y * lateralM * sign,
      z: from.z + up.z * rise + side.z * lateralM * sign,
    });
  }
  waypoints.push({ x: to.x, y: to.y, z: to.z });

  // Measure every leg, including the first (from `from`) and the last (to the
  // real target): the audit and the tests both read these.
  const legs: ClimbLeg[] = [];
  let prev = from;
  for (const point of waypoints) {
    const v = (point.x - prev.x) * up.x + (point.y - prev.y) * up.y + (point.z - prev.z) * up.z;
    const h = Math.hypot(
      point.x - prev.x - up.x * v,
      point.y - prev.y - up.y * v,
      point.z - prev.z - up.z * v,
    );
    legs.push({
      elevationDeg: Math.round(((Math.atan2(v, h) * 180) / Math.PI) * 10) / 10,
      riseM: Math.round(v * 10) / 10,
      lateralM: Math.round(h * 10) / 10,
    });
    prev = point;
  }
  return {
    waypoints,
    legs,
    maxElevationDeg: Math.max(...legs.map((leg) => leg.elevationDeg)),
    verticalM,
    baseHorizontalM: Math.round(horizontalM * 10) / 10,
  };
}


// ------------------------------------------------ landing: final descent

/**
 * Contact speed at which a DAMPENED descent counts as a landing, m/s.
 *
 * The strict rule is hull-bottom AGL < 2 m AND |v| <= 0.5 m/s (or a gear lock).
 * That is reachable when the hull comes to rest, but it is not what the game
 * gives: measured 2026-11-10 on SAT-R-0001 a controlled dampened descent
 * reproduced 4.2-4.4 m/s at ground contact repeatedly (dampeners holding, the
 * lift bank only ever pushing up), and the executor's control period is the
 * tick (1 s), so it cannot resolve a 0.4 m/s pulse. A hull that arrives inside
 * the commanded approach band (<= LANDING_APPROACH_DESCENT_MPS) on a KNOWN
 * ground has therefore landed; the strict rule still fires first whenever the
 * hull is genuinely slow.
 */
export const LANDING_DAMPENED_CONTACT_MPS = 5;

export interface LandingDescentInput {
  /** HULL-BOTTOM altitude above the known ground, m. */
  altitudeAglM: number;
  /** Current sink rate, m/s, positive DOWN. */
  sinkMps: number;
  /** Are dampeners off right now (a descent pulse is running)? */
  dampenersOff: boolean;
  /** Measured dampened shed rate of this hull, m/s^2 (`brakeShedMps2`). */
  shedMps2: number;
  /** Local gravity, m/s^2. */
  gravityMps2: number;
  /** Control period: the telemetry cadence the loop can actually observe, s. */
  periodS: number;
  /** Optional band override, m/s (default: the landing's own speed profile). */
  bandMps?: number;
  /** Hysteresis on the band's lower edge, fraction (default 0.85). */
  hysteresis?: number;
}

export interface LandingDescentVerdict {
  /** true = dampeners ON (brake/hold), false = OFF (descend), null = leave. */
  dampeners: boolean | null;
  /** Sink rate this height is allowed to be flown at, m/s. */
  bandMps: number;
  /** Height needed to arrest the current sink with the touchdown margin, m. */
  stopHeightM: number;
  /** How far the hull would fall in one control period if left falling, m. */
  dropThisPeriodM: number;
  /** Plain sentence for the audit. */
  reason: string;
}

/**
 * The final descent, with dampeners as the only actuator.
 *
 * Why this and not the autopilot: measured in game 2026-11-10, the SE
 * autopilot will not fly a waypoint straight below the ship (it climbs away at
 * 1.1-1.2 m/s), which is why every landing stalled at 26-27 m. The plugin's
 * level controller would be the natural owner of the last phase, but as
 * deployed it takes an ALTITUDE setpoint, not a sink rate, its floor is 2 m of
 * POSITION altitude (a lift-dominant hull's belly can be 10 m higher than its
 * pivot), and its depth is a downward ray from the position, not the hull
 * bottom — so it cannot complete this touchdown. Dampeners are what the game
 * actually gives: on a lift-dominant hull they hold a descent at the measured
 * 4.2-4.4 m/s, and releasing them lets gravity take over.
 *
 * Rules, in order:
 *
 *   1. band = the landing speed profile (5 m/s above 15 m, 0.4 m/s below);
 *   2. dampeners OFF and sink >= band            -> ON  (pulse complete);
 *   3. dampeners OFF and one more period of fall would leave less height than
 *      it takes to arrest the resulting sink  -> ON  (never an unarrestable
 *      pulse: this is the rule that keeps a free fall out of the ground);
 *   4. dampeners ON and the sink has fallen below the band's lower edge
 *      (the measured 26 m hover)              -> OFF (start a descent pulse);
 *   5. otherwise leave the state alone: the hull is descending inside its
 *      band, and every extra write is a chance to lose one.
 */
export function landingDescentCommand(input: LandingDescentInput): LandingDescentVerdict {
  const altitude = Math.max(0, finite(input.altitudeAglM));
  const sink = Math.max(0, finite(input.sinkMps));
  const shed = Math.max(0.5, finite(input.shedMps2, LANDING_SHED_DECEL_MPS2));
  const gravity = Math.max(0.5, finite(input.gravityMps2, 9.81));
  const period = Math.min(5, Math.max(0.1, finite(input.periodS, 1)));
  const band = Math.max(0.1, finite(input.bandMps ?? landingApproachSpeedMps(altitude)));
  const hysteresis = Math.min(0.95, Math.max(0.2, finite(input.hysteresis ?? 0.85)));
  const stopHeight = (sink * sink) / (2 * shed) + LANDING_TOUCHDOWN_AGL_M;
  const dropThisPeriodM = sink * period + (gravity * period * period) / 2;
  const predictedSink = sink + gravity * period;
  const predictedStopHeight = (predictedSink * predictedSink) / (2 * shed) + LANDING_TOUCHDOWN_AGL_M;
  const verdict = (dampeners: boolean | null, reason: string): LandingDescentVerdict => ({
    dampeners,
    bandMps: Math.round(band * 100) / 100,
    stopHeightM: Math.round(stopHeight * 100) / 100,
    dropThisPeriodM: Math.round(dropThisPeriodM * 10) / 10,
    reason,
  });
  if (input.dampenersOff) {
    if (sink >= band) {
      return verdict(true, `descending at ${sink.toFixed(2)} m/s, at or above the ${band.toFixed(2)} m/s band: dampeners on to arrest`);
    }
    if (altitude - dropThisPeriodM < predictedStopHeight) {
      return verdict(
        true,
        `at ${altitude.toFixed(1)} m AGL a ${period.toFixed(1)} s pulse would fall ${dropThisPeriodM.toFixed(1)} m and need ` +
          `${predictedStopHeight.toFixed(1)} m to arrest: dampeners on before the pulse reaches the ground`,
      );
    }
    return verdict(null, `pulse running at ${sink.toFixed(2)} m/s toward the ${band.toFixed(2)} m/s band`);
  }
  if (sink <= band * hysteresis) {
    if (altitude - dropThisPeriodM < predictedStopHeight) {
      return verdict(
        null,
        `sink ${sink.toFixed(2)} m/s is under the band but the remaining ${altitude.toFixed(1)} m cannot absorb a ` +
          `${dropThisPeriodM.toFixed(1)} m pulse (${predictedStopHeight.toFixed(1)} m to arrest): holding the dampeners`,
      );
    }
    return verdict(
      false,
      `sink ${sink.toFixed(2)} m/s has fallen under the ${(band * hysteresis).toFixed(2)} m/s band edge (the 26 m hover): ` +
        'dampeners off for one pulse, sized from the gravity and the measured shed rate',
    );
  }
  if (sink > band) {
    return verdict(
      null,
      `dampeners are already on and the hull is still descending at ${sink.toFixed(2)} m/s, above the ` +
        `${band.toFixed(2)} m/s band: the brake is already applied, nothing stronger is available`,
    );
  }
  return verdict(null, `descending at ${sink.toFixed(2)} m/s inside the ${band.toFixed(2)} m/s band: leaving dampeners on`);
}
