/**
 * Flight safety guards (T13 follow-up, docs/safety.md).
 *
 * The owner's satellites approached their slot at 60–81 m/s and never braked:
 * the executor only reacted inside a 50 m arrival radius, so the ship crossed
 * that radius in under a second and overshot/crashed. These pure functions
 * compute a braking-safe speed for the remaining distance and the fuel/ground
 * abort verdicts. They are unit-tested without network or game.
 */
export const BRAKE_MARGIN = 1.5;
export const HARD_CAP_100M_MPS = 5;
export const HARD_CAP_10M_MPS = 1;
/**
 * SE's Remote Control autopilot tops out at 100 m/s: a higher SpeedLimit is
 * accepted by the API but the controller ignores/floors it. The demo default
 * is therefore 100, not the old 60, and every guard/planner uses this one
 * validated value. The hard caps near the slot are unchanged.
 */
export const MAX_AUTOPILOT_SPEED_MPS = 100;
export const MIN_SPEED_LIMIT_MPS = 1;
/**
 * Shipped default is the autopilot ceiling (100 m/s): the owner wants a ship at
 * full speed whenever the braking maths allows it, and the per-tick guard plus
 * the 5/1 m/s terminal caps are what keep the approach safe. The old 60 default
 * was a fuel-reserve workaround for small atmospheric tanks (the reserve guard
 * aborts a full-throttle climb at 69 % H2), not a flight-physics limit, so it is
 * available again with RTS_DEMO_SPEED_MPS=60 rather than being the default.
 */
export const DEFAULT_SPEED_LIMIT_MPS = 100;
export const GROUND_FLOOR_M = 25;
/** Below this AGL a descent faster than 5 m/s is braked by the ground guard. */
export const GROUND_GUARD_ALT_M = 150;
/** Vertical speed at which the ground guard starts braking inside its altitude. */
export const GROUND_GUARD_DESCENT_MPS = 5;
/** Reserve the model already uses for a launch gate. */
export const RESERVE_PCT = 15;

/**
 * Clamp/validate a configured cruise cap. Anything above the autopilot limit
 * would silently be ignored by SE, so it is capped at 100; garbage falls back
 * to the default instead of producing NaN speeds in a move order.
 */
export function normalizeSpeedLimitMps(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPEED_LIMIT_MPS;
  return Math.min(MAX_AUTOPILOT_SPEED_MPS, Math.max(MIN_SPEED_LIMIT_MPS, n));
}

export interface ThrustSplit {
  atmo: number;
  ion: number;
  h2: number;
}

export interface ApproachInput {
  distanceM: number;
  speedMps: number;
  massKg: number;
  thrustN: ThrustSplit;
  /** 0..100; hydrogen force is only counted when there is fuel. */
  h2Pct: number;
  gravityMps2: number;
  /** Atmosphere present at the current altitude (from the planet model). */
  hasAtmosphere: boolean;
  speedLimitMps?: number;
}

export interface ApproachVerdict {
  ok: boolean;
  /** Speed the executor may command right now, m/s. */
  targetSpeedMps: number;
  /** Deceleration the current approach demands, m/s². */
  requiredDecelMps2: number;
  /** Deceleration the hull can actually produce (thrust − weight) / mass. */
  availableDecelMps2: number;
  /** Distance needed to stop from the current speed with the 1.5x margin. */
  brakingDistanceM: number;
  reason: string | null;
}

export function availableForceN(thrustN: ThrustSplit, h2Pct: number): number {
  return thrustN.atmo + thrustN.ion + (h2Pct > 0.01 ? thrustN.h2 : 0);
}

/** Net braking deceleration: (thrust − weight) / mass, never negative. */
export function achievableDecelMps2(args: {
  massKg: number;
  thrustN: ThrustSplit;
  h2Pct: number;
  gravityMps2: number;
}): number {
  const mass = Math.max(1, args.massKg);
  const force = availableForceN(args.thrustN, args.h2Pct);
  // A thrust vector used for braking cannot also hover, so subtract the weight
  // once: the usable horizontal/retro component is force - m*g.
  return Math.max(0, (force - mass * Math.max(0, args.gravityMps2)) / mass);
}

export function brakingDistanceM(speedMps: number, decelMps2: number): number {
  if (decelMps2 <= 0) return Number.POSITIVE_INFINITY;
  return (speedMps * speedMps) / (2 * decelMps2);
}

/**
 * Highest vertical speed still stoppable in `distanceM` with the 1.5x margin.
 * Used by the controlled-fall monitor before it commits the brake order: at the
 * planned brake altitude it returns ~the planned fall speed, and a late
 * telemetry sample that reads faster than this takes the full-brake path.
 */
export function descentStoppableSpeedMps(distanceM: number, decelMps2: number): number {
  if (!(distanceM > 0) || !(decelMps2 > 0)) return 0;
  return Math.sqrt((2 * decelMps2 * distanceM) / BRAKE_MARGIN);
}

/**
 * Highest speed that still allows a stop within `distanceM` using only
 * `decelMps2` and a 1.5x distance margin. Near the slot hard caps win:
 * ≤ 100 m -> 5 m/s, ≤ 10 m -> 1 m/s.
 */
export function safeApproachSpeedMps(distanceM: number, decelMps2: number, speedLimitMps = DEFAULT_SPEED_LIMIT_MPS): number {
  if (!(distanceM > 0)) return 0;
  const braking = Math.sqrt((2 * Math.max(0, decelMps2) * distanceM) / BRAKE_MARGIN);
  let cap = speedLimitMps;
  if (distanceM <= 10) cap = HARD_CAP_10M_MPS;
  else if (distanceM <= 100) cap = HARD_CAP_100M_MPS;
  return Math.max(0, Math.min(cap, braking));
}

export function approachVerdict(input: ApproachInput): ApproachVerdict {
  const speedLimit = input.speedLimitMps ?? DEFAULT_SPEED_LIMIT_MPS;
  const decel = achievableDecelMps2(input);
  const distance = Math.max(0, input.distanceM);
  const required = distance > 0 ? (input.speedMps * input.speedMps) / (2 * distance) : 0;
  const target = safeApproachSpeedMps(distance, decel, speedLimit);
  const brakeDist = brakingDistanceM(input.speedMps, decel) * BRAKE_MARGIN;
  const tooFast = input.speedMps > target * 1.05;
  const stoppingDanger = Number.isFinite(brakeDist) ? brakeDist > distance : input.speedMps > 0;
  const ok = !tooFast && !stoppingDanger;
  let reason: string | null = null;
  if (!ok) {
    reason =
      `approach too fast: ${input.speedMps.toFixed(1)} m/s at ${distance.toFixed(0)} m; ` +
      `needs ${required.toFixed(2)} m/s², hull can ${decel.toFixed(2)} m/s², ` +
      `braking distance ${Number.isFinite(brakeDist) ? brakeDist.toFixed(0) : 'infinite'} m`;
  }
  return {
    ok,
    targetSpeedMps: Math.round(target * 10) / 10,
    requiredDecelMps2: Math.round(required * 100) / 100,
    availableDecelMps2: Math.round(decel * 100) / 100,
    brakingDistanceM: Number.isFinite(brakeDist) ? Math.round(brakeDist) : Number.POSITIVE_INFINITY,
    reason,
  };
}

export interface FlightGuardInput extends ApproachInput {
  /**
   * Contract §3: the leg's planned cruise speed. The reserve estimate needs a
   * time-to-arrival; the instantaneous speed at the first tick after `move` is
   * ~0, which used to read a 5 km leg as 5000 s of hover and abort it.
   */
  plannedSpeedMps?: number;
  /** Vertical speed along the local up vector, m/s (negative = descending). */
  verticalSpeedMps: number;
  /** Height above the probed local ground, m. */
  altitudeAglM: number;
  /** Height of the waypoint above the same ground, m. */
  targetAglM: number;
  batteryPct: number;
  /**
   * The owner's landing intent (`target.land` / `mode: 'land'`). The waypoint
   * is then BELOW the ground on purpose, so the transit floor (25 m) and its
   * "hover 3 m over a low waypoint" special case do not apply; the landing
   * phases own the ship instead.
   */
  landing?: boolean;
}

export type FlightGuardAction = 'ok' | 'throttle' | 'brake' | 'abort-hold' | 'abort-stop';

export interface FlightGuardVerdict {
  action: FlightGuardAction;
  code: string;
  /** Speed the executor may allow right now (autopilot minimum is 1 m/s). */
  targetSpeedMps: number;
  reason: string | null;
  availableDecelMps2: number;
  brakingDistanceM: number;
  altitudeAglM: number;
  groundFloorM: number;
  /**
   * Arrival-loop guard (overnight run 2026-11-10, FAILURE 2): the speed the
   * executor commanded versus the speed the hull actually achieved. Present
   * only on the `hull-speed` abort, so the audit carries both numbers.
   */
  commandedSpeedMps?: number;
  achievedSpeedMps?: number;
  /** Seconds the hull stayed below half the commanded speed before the abort. */
  shortfallSeconds?: number;
  /** Range rate at the decision, m/s (positive = closing on the slot). */
  closingRateMps?: number;
}

/**
 * The one guard the executor runs every tick while `en_route`.
 *
 * Order matters: losing thrust or the fuel/charge reserve is unrecoverable, so
 * it aborts; a fast low descent is braked; an unsafe approach is throttled.
 * Landing intent (waypoint inside the floor) lowers the floor to 3 m below the
 * waypoint so a deliberate 5 m hover does not trip the transit floor.
 */
export function flightGuardVerdict(input: FlightGuardInput): FlightGuardVerdict {
  const mass = Math.max(1, input.massKg);
  const decel = achievableDecelMps2(input);
  const availableN = availableForceN(input.thrustN, input.h2Pct);
  const weightN = mass * Math.max(0, input.gravityMps2);
  const landing = input.landing === true ? true : input.targetAglM <= GROUND_FLOOR_M;
  const floor = input.landing === true ? 0 : landing ? Math.max(2, input.targetAglM - 3) : GROUND_FLOOR_M;
  const target = Math.max(
    1,
    Math.round(safeApproachSpeedMps(Math.max(0.1, input.distanceM), decel, input.speedLimitMps) * 10) / 10,
  );
  const brakeDist = brakingDistanceM(input.speedMps, decel) * BRAKE_MARGIN;
  const base = {
    targetSpeedMps: target,
    availableDecelMps2: Math.round(decel * 100) / 100,
    brakingDistanceM: Number.isFinite(brakeDist) ? Math.round(brakeDist) : Number.POSITIVE_INFINITY,
    altitudeAglM: Math.round(input.altitudeAglM * 10) / 10,
    groundFloorM: floor,
  };

  // 1. Thrust loss: with less lift than weight the ship cannot hover, so no
  //    waypoint can be flown. Stop the autopilot and say so.
  if (availableN < weightN * 1.02) {
    return {
      ...base,
      action: 'abort-stop',
      code: 'thrust-loss',
      reason:
        `thrust loss: ${(availableN / 1000).toFixed(0)} kN at ${Math.round(input.altitudeAglM)} m cannot lift ` +
        `${Math.round(weightN / 1000)} kN (${Math.round(mass)} kg); autopilot stopped`,
    };
  }
  // 2. Fuel/charge reserve.
  const reserve = reserveVerdict({
    h2Pct: input.h2Pct,
    batteryPct: input.batteryPct,
    remainingM: input.distanceM,
    speedMps: Math.max(input.speedMps, input.plannedSpeedMps ?? 0),
    massKg: mass,
    gravityMps2: input.gravityMps2,
    hasAtmosphere: input.hasAtmosphere,
  });
  if (!reserve.ok) {
    return { ...base, action: 'abort-hold', code: 'reserve', reason: `reserve guard: ${reserve.reason}` };
  }
  // 3. Ground proximity.
  if (input.altitudeAglM <= floor && input.verticalSpeedMps < -2) {
    return {
      ...base,
      action: 'abort-hold',
      code: 'ground-floor',
      reason:
        `ground guard: ${input.altitudeAglM.toFixed(0)} m above ground (floor ${floor} m) ` +
        `while descending at ${input.verticalSpeedMps.toFixed(1)} m/s`,
    };
  }
  if (input.altitudeAglM < GROUND_GUARD_ALT_M && input.verticalSpeedMps < -GROUND_GUARD_DESCENT_MPS) {
    return {
      ...base,
      action: 'brake',
      code: 'ground-descent',
      reason: `ground guard: descending at ${input.verticalSpeedMps.toFixed(1)} m/s at ${Math.round(input.altitudeAglM)} m AGL`,
    };
  }
  // 4. Braking profile and hard caps.
  const tooFast = input.speedMps > target * 1.05 + 0.3;
  const cannotStop = Number.isFinite(brakeDist) ? brakeDist > Math.max(1, input.distanceM) : input.speedMps > 0;
  if (tooFast || cannotStop) {
    return {
      ...base,
      action: 'brake',
      code: cannotStop ? 'braking-distance' : 'speed-cap',
      reason:
        `approach ${input.speedMps.toFixed(1)} m/s at ${input.distanceM.toFixed(0)} m: allowed ${target.toFixed(1)} m/s ` +
        `(decel ${decel.toFixed(1)} m/s², braking distance ${Number.isFinite(brakeDist) ? Math.round(brakeDist) : '∞'} m)`,
    };
  }
  return { ...base, action: 'ok', code: 'ok', reason: null };
}

export type GroundAction = 'ok' | 'brake' | 'abort';

/** Closing on the ground faster than a safe descent -> brake or abort. */
export function groundVerdict(args: { altitudeM: number; verticalSpeedMps: number }): { action: GroundAction; reason: string | null } {
  const { altitudeM, verticalSpeedMps } = args;
  if (altitudeM <= GROUND_FLOOR_M && verticalSpeedMps < -2) {
    return { action: 'abort', reason: `below the ${GROUND_FLOOR_M} m floor and descending at ${verticalSpeedMps.toFixed(1)} m/s` };
  }
  if (altitudeM < GROUND_GUARD_ALT_M && verticalSpeedMps < -GROUND_GUARD_DESCENT_MPS) {
    return { action: 'brake', reason: `descending at ${verticalSpeedMps.toFixed(1)} m/s at ${Math.round(altitudeM)} m` };
  }
  return { action: 'ok', reason: null };
}

/**
 * Fuel/charge reserve guard: refuse a leg that would burn below the 15 %
 * reserve. Without atmosphere hydrogen is the only lift, so an empty tank at
 * altitude is fatal; with atmosphere only the battery draw matters.
 */
export function reserveVerdict(args: {
  h2Pct: number;
  batteryPct: number;
  remainingM: number;
  speedMps: number;
  massKg: number;
  gravityMps2: number;
  hasAtmosphere: boolean;
}): { ok: boolean; reason: string | null } {
  if (args.batteryPct < RESERVE_PCT) {
    return { ok: false, reason: `battery ${args.batteryPct.toFixed(1)} % is below the ${RESERVE_PCT} % reserve` };
  }
  if (!args.hasAtmosphere) {
    // Rough lower bound: burn for the remaining distance at the current speed.
    // A zero-g ship still needs fuel to change speed and trim its approach, so
    // a small manoeuvring floor (0.25 m/s²) replaces m*g = 0.
    const seconds = args.remainingM / Math.max(1, args.speedMps || 20);
    const effectiveG = Math.max(0, args.gravityMps2, 0.25);
    const hoverLps = (args.massKg * effectiveG) / 0.001556 / 1e6; // MN -> L/s at 100 % throttle
    const needPct = ((hoverLps * seconds) / 60_000) * 100;
    if (args.h2Pct - needPct < RESERVE_PCT) {
      return {
        ok: false,
        reason: `hydrogen ${args.h2Pct.toFixed(1)} % cannot cover ${Math.round(seconds)} s of vacuum flight and keep a ${RESERVE_PCT} % reserve`,
      };
    }
  }
  if (args.h2Pct <= 0.01 && !args.hasAtmosphere) {
    return { ok: false, reason: 'hydrogen empty with no atmosphere: no thrust left' };
  }
  return { ok: true, reason: null };
}
