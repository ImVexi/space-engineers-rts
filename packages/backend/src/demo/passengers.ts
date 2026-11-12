/**
 * T61 passenger rule: who is aboard a managed grid, and how gently to fly it.
 *
 * THE BUG THIS REPLACES. The plugin used to report `underControl` for ANY
 * occupied ship controller (`IMyShipController.IsUnderControl` = "a controller
 * is attached"), so a player sitting in a PASSENGER SEAT made telemetry say
 * "Passenger Seat 2 is piloting" and the executor sent that ship ZERO orders.
 * The owner wants to ride along.
 *
 * THE RULE. Only a real PILOT silences the executor: an occupied controller
 * whose `CanControlShip` is true (cockpit / flight seat / control seat) or a
 * Remote Control a player is actively driving. A seated PASSENGER keeps the
 * ship flying, with gentler limits:
 *
 *   - cruise capped at 60 m/s (instead of the config's 100),
 *   - acceleration capped at 0.5 g lateral / 1 g vertical,
 *   - no dampeners-off vacuum cruise,
 *   - no ballistic free-fall descent (the dampened descent flies it instead).
 *
 * A player standing on/inside the hull but not seated (`aboard[]`) is worse off
 * than a seated one - SE throws loose characters around under thrust - so that
 * case halves the allowance (0.25 g / 0.5 g) and also refuses dampeners-off
 * phases. The plugin reports these classifications; this module is the single
 * place the executor derives limits from them.
 */

export interface CrewMember {
  identityId: string;
  name: string;
  seat: string;
  controllerType: string;
  subtype: string;
  remoteControl: boolean;
  main: boolean;
}

export interface GridCrew {
  /** The real pilot, if any. `underControl` in the report is exactly this. */
  pilot: CrewMember | null;
  /** Every other occupied seat (passenger seats, non-controlling cockpits). */
  passengers: CrewMember[];
  /** Players inside the grid's AABB who are not seated in any controller. */
  aboard: CrewMember[];
}

/** What the plugin sent, with the compatibility boolean resolved. */
export interface CrewReport extends GridCrew {
  underControl: boolean;
  carried: boolean;
  standing: boolean;
}

export interface PassengerLimits {
  /** Cruise cap, m/s. */
  speedCapMps: number;
  lateralAccelMps2: number;
  verticalAccelMps2: number;
  allowDampenersOff: boolean;
  allowFreeFall: boolean;
  standing: boolean;
  carrying: boolean;
  /** Who is aboard, for the audit and the site ('the owner (Passenger Seat 2)'). */
  names: string[];
  reason: string;
}

/** Passenger cruise cap, m/s. The normal cap is the operator's (100 by default). */
export const PASSENGER_SPEED_CAP_MPS = 60;
/** Lateral acceleration cap with a seated passenger, g. */
export const PASSENGER_LATERAL_ACCEL_G = 0.5;
/** Vertical (climb/descent) acceleration cap with a seated passenger, g. */
export const PASSENGER_VERTICAL_ACCEL_G = 1;
/** A standing player gets half a passenger's lateral allowance. */
export const STANDING_LATERAL_ACCEL_G = 0.25;
/** ... and half the vertical allowance. */
export const STANDING_VERTICAL_ACCEL_G = 0.5;
export const STANDARD_GRAVITY_MPS2 = 9.81;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function member(raw: unknown): CrewMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const name = str(row.name);
  const seat = str(row.seat);
  const identityId = str(row.identityId);
  if (!name && !seat && !identityId) return null;
  return {
    identityId,
    name,
    seat,
    controllerType: str(row.controllerType),
    subtype: str(row.subtype),
    remoteControl: row.remoteControl === true,
    main: row.main === true,
  };
}

/**
 * Read the plugin's `control` block (telemetry `grids[].control` or the
 * `is_under_control` action result). Returns null when the plugin did not send
 * one (older plugin): the caller then keeps the pre-T61 behaviour.
 *
 * `underControl` is trusted as the plugin's own classification, and is also
 * re-derived from `pilot` so a half-written payload cannot claim a pilot.
 */
export function crewFromControl(raw: unknown): CrewReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const pilot = member(row.pilot);
  const passengers = Array.isArray(row.passengers)
    ? row.passengers.map((raw: unknown) => member(raw)).filter((m): m is CrewMember => m !== null)
    : [];
  const aboard = Array.isArray(row.aboard)
    ? row.aboard.map((raw: unknown) => member(raw)).filter((m): m is CrewMember => m !== null)
    : [];
  return {
    pilot,
    passengers,
    aboard,
    underControl: pilot !== null,
    carried: passengers.length > 0,
    standing: aboard.length > 0,
  };
}

/** Read the crew out of a unit's telemetry meta. */
export function crewFromMeta(meta: Record<string, unknown> | null | undefined): CrewReport | null {
  if (!meta) return null;
  return crewFromControl(meta.control);
}

/**
 * Limits for a ship with non-pilots aboard, or null when the normal profile
 * applies (nobody aboard, or the plugin sent no crew classification).
 *
 * `gravityMps2` is the local gravity the caps scale with; a non-finite or
 * non-positive value falls back to 1 g so a missing gravity read can never
 * loosen the cap.
 */
export function passengerLimits(crew: GridCrew | null, gravityMps2: number): PassengerLimits | null {
  if (!crew) return null;
  const carrying = crew.passengers.length > 0;
  const standing = crew.aboard.length > 0;
  if (!carrying && !standing) return null;
  const g = Number.isFinite(gravityMps2) && gravityMps2 > 0.1 ? gravityMps2 : STANDARD_GRAVITY_MPS2;
  const lateralG = standing ? STANDING_LATERAL_ACCEL_G : PASSENGER_LATERAL_ACCEL_G;
  const verticalG = standing ? STANDING_VERTICAL_ACCEL_G : PASSENGER_VERTICAL_ACCEL_G;
  const names = [
    ...crew.passengers.map((p) => (p.name ? `${p.name} (${p.seat || 'passenger seat'})` : p.seat || 'unnamed passenger')),
    ...crew.aboard.map((p) => (p.name ? `${p.name} (standing)` : 'unnamed (standing)')),
  ];
  const reason = standing
    ? `a player is standing inside the hull (not seated): dampeners stay on, no free fall, ` +
      `${STANDING_LATERAL_ACCEL_G} g lateral / ${STANDING_VERTICAL_ACCEL_G} g vertical and ${PASSENGER_SPEED_CAP_MPS} m/s`
    : `carrying ${crew.passengers.length === 1 ? 'a passenger' : 'passengers'}: dampeners stay on, no free fall, ` +
      `${PASSENGER_LATERAL_ACCEL_G} g lateral / ${PASSENGER_VERTICAL_ACCEL_G} g vertical and ${PASSENGER_SPEED_CAP_MPS} m/s`;
  return {
    speedCapMps: PASSENGER_SPEED_CAP_MPS,
    lateralAccelMps2: lateralG * g,
    verticalAccelMps2: verticalG * g,
    allowDampenersOff: false,
    allowFreeFall: false,
    standing,
    carrying,
    names,
    reason,
  };
}

/**
 * The gentle envelope an unoccupied PERSONAL ship flies under (owner decision
 * 2026-11-11): exactly the passenger ride-along limits — 60 m/s cruise, 0.5 g
 * lateral / 1 g vertical, dampeners on, no ballistic free fall. Reusing one
 * limit source means a personal landing can never take the fast free-fall
 * profile by accident.
 */
export function personalShipLimits(gravityMps2: number): PassengerLimits {
  const g = Number.isFinite(gravityMps2) && gravityMps2 > 0.1 ? gravityMps2 : STANDARD_GRAVITY_MPS2;
  return {
    speedCapMps: PASSENGER_SPEED_CAP_MPS,
    lateralAccelMps2: PASSENGER_LATERAL_ACCEL_G * g,
    verticalAccelMps2: PASSENGER_VERTICAL_ACCEL_G * g,
    allowDampenersOff: false,
    allowFreeFall: false,
    standing: false,
    carrying: false,
    names: [],
    reason:
      `personal ship: gentle profile, dampeners stay on, no free fall, ` +
      `${PASSENGER_LATERAL_ACCEL_G} g lateral / ${PASSENGER_VERTICAL_ACCEL_G} g vertical and ${PASSENGER_SPEED_CAP_MPS} m/s`,
  };
}

/** The cruise the executor may ask for: the operator's cap, then the passenger cap. */
export function capPassengerSpeed(speedMps: number, limits: PassengerLimits | null): number {
  if (!limits || !Number.isFinite(speedMps)) return speedMps;
  return Math.min(speedMps, limits.speedCapMps);
}

/** Cap an available acceleration along a vertical or lateral axis. */
export function capPassengerAccel(accelMps2: number, vertical: boolean, limits: PassengerLimits | null): number {
  if (!limits || !Number.isFinite(accelMps2)) return accelMps2;
  return Math.min(accelMps2, vertical ? limits.verticalAccelMps2 : limits.lateralAccelMps2);
}

/** 'Carrying the owner (Passenger Seat 2); 0.5 g lateral ...' - one plain sentence. */
export function describePassengers(limits: PassengerLimits | null): string | null {
  if (!limits) return null;
  const who = limits.names.length > 0 ? limits.names.join(', ') : 'unnamed';
  return `${limits.standing ? 'standing aboard' : 'carrying'} ${who}; ${limits.reason}`;
}
