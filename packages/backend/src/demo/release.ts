/**
 * Launch preflight: release a parked drone before the first move (T8 follow-up).
 *
 * A grid that sits on a landing gear, docked to a connector, or saved as
 * static cannot be flown: the move order is accepted but the grid does not
 * move. The executor therefore runs a release preflight after its securing
 * chain and before the first move:
 *
 *   1. landing gears: `Autolock=false` + terminal action `Unlock`;
 *   2. connectors: terminal actions `Unlock`, `Disconnect`;
 *   3. read the grid (`diag`): static grid -> `convert_to_ship` (plugin action
 *      being added by the plugin owner) then re-read;
 *   4. verify mass > 0 and a physics body present/enabled; refuse the launch
 *      with the reason when the grid still cannot move.
 *
 * This runs only in the executor launch path, never during provisioning: a
 * provisioned grid is allowed to stay parked and stockpiled.
 */

export const STATIC_CONVERT_PENDING = 'static grid: convert pending plugin update';

export const RELEASE_STEP_GEARS = 'release_gears';
export const RELEASE_STEP_CONNECTORS = 'release_connectors';
export const RELEASE_STEP_PROFILE = 'release_profile';
export const RELEASE_STEP_CONVERT = 'release_convert';
export const RELEASE_STEP_VERIFY = 'release_verify';
export const RELEASE_STEP_RELOCK = 'relock_gear';

export interface ReleaseBlockOrder {
  label: string;
  filter: Record<string, unknown>;
  props: Record<string, unknown>;
  actions: string[];
}

/** Landing gear release: autolock off plus the terminal Unlock. */
export function landingGearReleaseOrder(): ReleaseBlockOrder {
  return {
    label: 'LandingGear:Autolock=false,Unlock',
    filter: { type: 'LandingGear' },
    props: { Autolock: false },
    actions: ['Unlock'],
  };
}

/** Connector release: unlock and disconnect every connector on the grid. */
export function connectorReleaseOrder(): ReleaseBlockOrder {
  return {
    label: 'ShipConnector:Unlock,Disconnect',
    filter: { type: 'ShipConnector' },
    props: {},
    actions: ['Unlock', 'Disconnect'],
  };
}

/** Optional arrival step: re-arm autolock when the drone parks on the ground. */
export function landingGearRelockOrder(): ReleaseBlockOrder {
  return {
    label: 'LandingGear:Autolock=true',
    filter: { type: 'LandingGear' },
    props: { Autolock: true },
    actions: [],
  };
}

export interface ReleaseReadout {
  isStatic: boolean;
  massKg: number;
  physicsPresent: boolean;
  physicsEnabled: boolean;
  physicsActive: boolean;
  /** Which plugin read produced this row ('diag' or 'profile'). */
  source: 'diag' | 'profile';
}

/**
 * Parse `diag` (preferred: it reports the physics body) or `profile` (mass and
 * static flag only). Returns null when the row carries neither, so the caller
 * refuses instead of guessing.
 */
export function parseReleaseReadout(result: unknown): ReleaseReadout | null {
  if (!result || typeof result !== 'object') return null;
  const row = result as {
    isStatic?: unknown;
    massKg?: unknown;
    physics?: { present?: unknown; enabled?: unknown; active?: unknown; massKg?: unknown } | null;
  };
  const physics = row.physics && typeof row.physics === 'object' ? row.physics : null;
  const mass = numberOrNull(physics?.massKg) ?? numberOrNull(row.massKg);
  if (typeof row.isStatic !== 'boolean' && mass === null) return null;
  return {
    isStatic: row.isStatic === true,
    massKg: mass ?? 0,
    physicsPresent: physics ? physics.present === true : mass !== null && mass > 0,
    physicsEnabled: physics ? physics.enabled === true : mass !== null && mass > 0,
    physicsActive: physics ? physics.active === true : false,
    source: physics ? 'diag' : 'profile',
  };
}

export interface ReleaseVerdict {
  ok: boolean;
  /** True when the grid is static and needs `convert_to_ship` first. */
  needsConvert: boolean;
  reason: string | null;
}

/** Decide whether the readout proves the grid can be flown. */
export function releaseVerdict(readout: ReleaseReadout): ReleaseVerdict {
  if (readout.isStatic) {
    return { ok: false, needsConvert: true, reason: STATIC_CONVERT_PENDING };
  }
  if (!(readout.massKg > 0)) {
    return {
      ok: false,
      needsConvert: false,
      reason: `launch refused: grid mass is ${readout.massKg} kg after release (no live physics body)`,
    };
  }
  if (!readout.physicsPresent || !readout.physicsEnabled) {
    return {
      ok: false,
      needsConvert: false,
      reason: 'launch refused: physics body is not present/enabled after release',
    };
  }
  return { ok: true, needsConvert: false, reason: null };
}

/** Landing gear should be re-armed only at a genuine ground target. */
export function isGroundTarget(altitudeM: number | null, gravityMps2: number | null): boolean {
  return altitudeM !== null && gravityMps2 !== null && gravityMps2 > 0.01 && altitudeM <= 200;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
