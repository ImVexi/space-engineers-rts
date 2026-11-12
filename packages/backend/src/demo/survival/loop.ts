/**
 * T66 survival loop — the pure half.
 *
 * A MANAGED relay that cannot stay on station must come home on its own. This
 * module decides *when* (the energy trigger), *where* (the home base and a free
 * landing spot beside it) and *in what state* the grid is. It reads telemetry
 * values handed to it and returns numbers plus a plain-language reason. It
 * sends nothing and owns no timer: `service.ts` does that, through the normal
 * guarded mission path.
 *
 * Trigger formula (documented in docs/survival-loop.md):
 *
 *   fullTankMin = runwayMin / remainingPct * 100      // what the tank is worth
 *   transitMin  = distanceM / CRUISE_SPEED_MPS / 60
 *   climbMin    = max(0, homeAltitudeM - altitudeM) / CRUISE_SPEED_MPS / 60
 *   tripMin     = transitMin + climbMin + LANDING_ALLOWANCE_MIN
 *   needPct     = tripMin / fullTankMin * 100 + RESERVE_PCT
 *   threshold   = needPct * (1 + marginPct / 100)
 *   trigger     = remainingPct !== null && runwayMin !== null && remainingPct < threshold
 *
 * The runway is the endurance model's answer for *this* grid (hold/transit
 * burn from the live profile rates), so "minutes left" and "percent left" are
 * two views of the same tank. A null reading never triggers: an unread tank is
 * not an empty tank.
 */
import type { Planet } from '@se-rts/schemas';
import { CRUISE_SPEED_MPS, type BankCounts } from '../endurance/index.js';

/** The existing designer reserve: never launch (or arrive) below 15 %. */
export const SURVIVAL_RESERVE_PCT = 15;
/** Default margin on top of the requirement, percent of that requirement. */
export const SURVIVAL_DEFAULT_MARGIN_PCT = 20;
/** Descent + flare + touchdown allowance, minutes. */
export const LANDING_ALLOWANCE_MIN = 3;
/** A landed grid is ready to go back once its tank/charge is at least this. */
export const SURVIVAL_DEFAULT_RELAUNCH_PCT = 90;
/** Clearance kept from the home base hull, metres. */
export const BASE_HULL_CLEARANCE_M = 90;
/** Clearance kept from another landed grid, metres. */
export const LANDED_GRID_CLEARANCE_M = 60;
/** Landing-spot search rings beside the base, metres. */
export const LANDING_SPOT_RINGS_M = [150, 250, 350, 450] as const;
/** Bearings tried on each ring (every 45 degrees). */
export const LANDING_SPOT_BEARINGS_DEG = [0, 45, 90, 135, 180, 225, 270, 315] as const;
/** A return that could not start is retried no sooner than this. */
export const SURVIVAL_RETRY_MS = 10 * 60_000;
/**
 * The retry sentence, rebuilt from the base reason every pass.
 *
 * Verify #4: the old code appended to whatever was already on the record, and
 * the record carries its own previous reason, so one failed relaunch produced
 * "… (retry in 10 min) (retry in 9 min) (retry in 9 min) (retry in 8 min)".
 * Every retry suffix is stripped first, so the text is a function of the
 * current base reason and the current wait — never a history.
 */
export function retryReason(reason: string | null | undefined, retryInMin: number): string {
  const base = String(reason ?? '')
    .replace(/(?:\s*\(retry in \d+ min\))+$/g, '')
    .trim();
  const wait = `(retry in ${Math.max(0, Math.round(retryInMin))} min)`;
  return base ? `${base} ${wait}` : `retrying ${wait}`;
}
/**
 * A power/fuel snapshot older than this is UNKNOWN, not a reading (simspeed
 * merge, 2026-11-11). The power poller re-reads an idle grid every 5 min
 * (`IDLE_REFRESH_MS`), so a legitimate reading can be ~5 min old; 6 min leaves
 * one missed idle refresh of slack and no more. Acting on an older number would
 * fire a return (or a relaunch) on fuel the grid may no longer have.
 */
export const SURVIVAL_SNAPSHOT_MAX_AGE_MS = 6 * 60_000;

export type SurvivalState = 'OK' | 'RETURN_PENDING' | 'RETURNING' | 'NEEDS_REFUEL' | 'READY_TO_RELAUNCH' | 'STRANDED';
export type SurvivalPhase = 'return' | 'relaunch' | null;
export type SurvivalResource = 'fuel' | 'power';

export const SURVIVAL_STATES: SurvivalState[] = [
  'OK',
  'RETURN_PENDING',
  'RETURNING',
  'NEEDS_REFUEL',
  'READY_TO_RELAUNCH',
  'STRANDED',
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SurvivalSettings {
  /**
   * `auto` starts the return for a MANAGED grid without asking (the owner's
   * standing intent for satellites). `approve` raises the recommendation and
   * waits. Relaunch is always owner-approved.
   */
  approvalMode: 'auto' | 'approve';
  /** Extra margin over the requirement, percent of the requirement. */
  marginPct: number;
  /** Fuel/charge percent at which a landed grid is ready to relaunch. */
  relaunchPct: number;
  /**
   * TEST-ENV-ONLY: carry the audited `ignoreReach` admin override on the loop's
   * own return/relaunch missions, so the loop can be exercised on the test world
   * where BASE-01 has no antenna block. Default false; refused with 409
   * `survival_mode` outside the demo env, and IGNORED (not just unset) if a
   * value is already persisted when the backend runs in survival mode.
   */
  testIgnoreReach: boolean;
}

export const SURVIVAL_SETTINGS_DEFAULTS: SurvivalSettings = {
  approvalMode: 'auto',
  marginPct: SURVIVAL_DEFAULT_MARGIN_PCT,
  relaunchPct: SURVIVAL_DEFAULT_RELAUNCH_PCT,
  testIgnoreReach: false,
};

/** Clamp a settings patch; never NaN, never out of range. */
export function normaliseSettings(input: Partial<SurvivalSettings> | null | undefined): SurvivalSettings {
  const d = SURVIVAL_SETTINGS_DEFAULTS;
  const mode = input?.approvalMode === 'approve' ? 'approve' : input?.approvalMode === 'auto' ? 'auto' : d.approvalMode;
  const margin = Number(input?.marginPct);
  const relaunch = Number(input?.relaunchPct);
  return {
    approvalMode: mode,
    marginPct: Number.isFinite(margin) ? Math.min(100, Math.max(0, margin)) : d.marginPct,
    relaunchPct: Number.isFinite(relaunch) ? Math.min(100, Math.max(50, relaunch)) : d.relaunchPct,
    // Strictly boolean: anything else (a string "true", a 1) stays off.
    testIgnoreReach: input?.testIgnoreReach === true,
  };
}

/**
 * The one gate for the test-only override. It needs all three: the setting,
 * the test/demo environment, and NOT survival mode. A persisted `true` on a
 * survival deployment is therefore inert - the setting can never widen the
 * comms gate where no admin override exists.
 */
export function testIgnoreReachActive(args: {
  settings: Pick<SurvivalSettings, 'testIgnoreReach'> | null | undefined;
  survivalMode: boolean;
  demoEnv: boolean;
}): boolean {
  return args.settings?.testIgnoreReach === true && !args.survivalMode && args.demoEnv;
}

// ------------------------------------------------------------------ trigger

export interface ResourceReading {
  /** Percent remaining, null when unread. */
  pct: number | null;
  /** Runway from the endurance/power model, minutes; null = no limit or unknown. */
  runwayMin: number | null;
}

/**
 * Which resources the return trip actually burns, from the hull's thruster mix
 * (the endurance model's `PREFAB_HARDWARE.thrustCounts`, the same table that
 * decides launch/hold endurance).
 *
 * It matters only for the empty case: a tank the ship needs to lift reads
 * `0 %` -> STRANDED even when nothing is draining it (a landed, static grid has
 * no projected drain, so `runwayMin` is null and the runway test cannot judge
 * it). A resource the ship does NOT need for the trip is not a grounding
 * failure when it is empty: an ion relay with a dry H2 tank for its engine
 * still flies home on its batteries.
 */
export interface TripResources {
  /** H2 thrusters are part of the lift: an empty tank grounds the ship. */
  fuel: boolean;
  /** Atmospheric/ion thrust is part of the lift: an empty battery grounds it. */
  power: boolean;
  source: 'prefab-profile' | 'unknown-conservative';
  reason: string;
}

/** Thruster bank counts per kind, from the prefab hardware profile. */
export interface ThrusterCounts {
  h2?: number;
  atmo?: number;
  ion?: number;
}

/**
 * Total thrusters per kind from a prefab's bank counts (`thrustCounts` is
 * `{kind: {subtype: count}}`). Null when the prefab has no hardware profile,
 * which `tripResources` reports as conservative rather than guessing.
 */
export function bankTotals(counts: BankCounts | undefined): ThrusterCounts | null {
  if (!counts) return null;
  const total = (bank: Record<string, number> | undefined): number =>
    bank ? Object.values(bank).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0) : 0;
  return { h2: total(counts.h2), atmo: total(counts.atmo), ion: total(counts.ion) };
}

/**
 * Classify the lift. Counts are the prefab's thruster banks (any H2 bank means
 * hydrogen carries part of the lift; any atmo/ion bank means electric thrust
 * does). Unknown propulsion is judged conservatively: both resources count as
 * needed, because refusing to promise a flight on an unmeasured hull is the
 * safe error and the reason says so.
 */
export function tripResources(args: { counts: ThrusterCounts | null | undefined }): TripResources {
  const counts = args.counts;
  if (!counts) {
    return {
      fuel: true,
      power: true,
      source: 'unknown-conservative',
      reason: 'no hardware profile for this grid: an empty tank or battery is judged as grounding it (conservative)',
    };
  }
  const h2 = Math.max(0, Number(counts.h2 ?? 0));
  const electric = Math.max(0, Number(counts.atmo ?? 0)) + Math.max(0, Number(counts.ion ?? 0));
  const parts: string[] = [];
  if (h2 > 0) parts.push(`${h2} H2 thruster(s)`);
  if (electric > 0) parts.push(`${electric} electric thruster(s)`);
  return {
    fuel: h2 > 0,
    power: electric > 0,
    source: 'prefab-profile',
    reason: parts.length
      ? `lift uses ${parts.join(' + ')}: ${[h2 > 0 ? 'H2' : null, electric > 0 ? 'battery' : null].filter(Boolean).join(' + ')} must be aboard`
      : 'no lift thrusters counted: neither the tank nor the charge is what lifts this grid',
  };
}

export interface ReturnNeed {
  resource: SurvivalResource | null;
  /** Values that produced the verdict, all nullable — a null never triggers. */
  remainingPct: number | null;
  runwayMin: number | null;
  distanceM: number | null;
  transitMin: number | null;
  tripMin: number | null;
  tripPct: number | null;
  /**
   * Fuel the flight itself needs (transit + climb + landing), percent of the
   * tank and WITHOUT the reserve. A ship below this cannot get home at all.
   */
  launchPct: number | null;
  /**
   * `remainingPct >= launchPct`. `false` means the trip is impossible, not just
   * tight: the loop must not launch, it states STRANDED. `null` = unmeasured.
   */
  launchable: boolean | null;
  /** Percent short of `launchPct` when not launchable; 0 when it can fly. */
  shortfallPct: number | null;
  requiredPct: number | null;
  thresholdPct: number | null;
  marginPct: number;
  trigger: boolean;
  /** Plain words with the numbers, e.g. "H2 18 %, needs 12 % to reach BASE-01 and land". */
  reason: string;
}

export function resourceLabel(resource: SurvivalResource): string {
  return resource === 'fuel' ? 'H2' : 'battery';
}

/** One resource's verdict: does its runway cover the trip home plus reserve? */
export function evaluateResourceNeed(args: {
  reading: ResourceReading;
  distanceM: number | null;
  homeAltitudeM: number | null;
  altitudeM: number | null;
  marginPct: number;
  homeLabel: string;
  resource: SurvivalResource;
  /**
   * Does the trip burn this resource (from `tripResources`)? An EMPTY resource
   * the ship needs is STRANDED whatever the runway says; an empty one it does
   * not need is not a grounding failure. Default true: the safe answer for a
   * caller that has not classified the hull.
   */
  needed?: boolean;
}): ReturnNeed {
  const { reading, resource } = args;
  const needed = args.needed ?? true;
  const marginPct = Number.isFinite(args.marginPct) ? args.marginPct : SURVIVAL_DEFAULT_MARGIN_PCT;
  const label = resourceLabel(resource);
  const base = {
    resource,
    remainingPct: reading.pct,
    runwayMin: reading.runwayMin,
    distanceM: args.distanceM,
    marginPct,
  };
  const unknown = (why: string): ReturnNeed => ({
    ...base,
    transitMin: null,
    tripMin: null,
    tripPct: null,
    launchPct: null,
    launchable: null,
    shortfallPct: null,
    requiredPct: null,
    thresholdPct: null,
    trigger: false,
    reason: `${label}: ${why}`,
  });

  if (reading.pct === null || !Number.isFinite(reading.pct)) return unknown('unknown reading: not treating a missing value as empty');
  const climbMin =
    args.homeAltitudeM !== null && args.altitudeM !== null && Number.isFinite(args.homeAltitudeM) && Number.isFinite(args.altitudeM)
      ? Math.max(0, args.homeAltitudeM - args.altitudeM) / CRUISE_SPEED_MPS / 60
      : 0;
  const distanceKnown = args.distanceM !== null && Number.isFinite(args.distanceM) && args.distanceM >= 0;
  const transitMin = distanceKnown ? args.distanceM! / CRUISE_SPEED_MPS / 60 : null;
  if (reading.pct <= 0) {
    // An empty resource cannot fly home. This is judged BEFORE the runway test:
    // a landed/static grid has no projected drain, so `runwayMin` is null and
    // the runway-null early return used to swallow the empty case entirely
    // (the eight dry relays read OK on their battery instead of STRANDED).
    // Runway null only means "not draining now", never "not empty".
    if (!needed) {
      return unknown(
        `${label} 0 %: empty, but this resource is not what lifts the ship (its thruster mix does not use it) — not a grounding failure`,
      );
    }
    const tripMin = transitMin === null ? null : transitMin + climbMin + LANDING_ALLOWANCE_MIN;
    return {
      ...base,
      transitMin,
      tripMin,
      tripPct: null,
      launchPct: null,
      launchable: false,
      shortfallPct: null,
      requiredPct: 100,
      thresholdPct: 100,
      trigger: true,
      reason:
        `${label} ${Math.round(reading.pct)} %: empty — ` +
        (tripMin === null
          ? `the distance to ${args.homeLabel} is unknown, so the burn cannot be stated`
          : `needs ${tripMin.toFixed(1)} min of burn to reach ${args.homeLabel}`) +
        '; cannot return — refuel it where it is or send a tanker',
    };
  }
  if (reading.runwayMin === null || !Number.isFinite(reading.runwayMin)) {
    return unknown('no runway yet (no projected drain): nothing to return from');
  }
  if (!distanceKnown) return unknown(`unknown distance to ${args.homeLabel}`);

  const fullTankMin = (reading.runwayMin / reading.pct) * 100;
  const tripMin = (transitMin ?? 0) + climbMin + LANDING_ALLOWANCE_MIN;
  const tripPct = fullTankMin > 0 ? (tripMin / fullTankMin) * 100 : 100;
  const requiredPct = tripPct + SURVIVAL_RESERVE_PCT;
  const thresholdPct = requiredPct * (1 + marginPct / 100);
  const trigger = reading.pct < thresholdPct;
  // The launch gate: the flight itself (no reserve, no margin) must fit. The
  // trigger says "come home"; this says "it can still get there".
  const launchPct = tripPct;
  const launchable = reading.pct >= launchPct;
  const shortfallPct = launchable ? 0 : Math.round((launchPct - reading.pct) * 100) / 100;
  const need = Math.round(requiredPct);
  const reason = !launchable
    ? `${label} ${Math.round(reading.pct)} %, needs ${Math.ceil(launchPct)} % to reach ${args.homeLabel}; ` +
      'cannot return — refuel it where it is or send a tanker'
    : trigger
      ? `${label} ${Math.round(reading.pct)} %, needs ${need} % to reach ${args.homeLabel} and land` +
        (marginPct > 0 ? ` (+${Math.round(marginPct)} % margin = ${Math.round(thresholdPct)} %)` : '') +
        ', returning'
      : `${label} ${Math.round(reading.pct)} %, needs ${need} % to reach ${args.homeLabel} and land: enough`;
  return {
    ...base,
    transitMin,
    tripMin,
    tripPct,
    launchPct,
    launchable,
    shortfallPct,
    requiredPct,
    thresholdPct,
    trigger,
    reason,
  };
}

/**
 * Both resources: the one with the least headroom decides, because that is the
 * one that runs out first. Unknown readings are ignored, never treated as zero.
 */
export function evaluateReturnNeed(args: {
  fuel: ResourceReading;
  power: ResourceReading;
  distanceM: number | null;
  homeAltitudeM: number | null;
  altitudeM: number | null;
  marginPct: number;
  homeLabel: string;
  /**
   * Which of the two the trip burns (`tripResources`). Only the empty case
   * uses it: an empty resource the ship needs is STRANDED, an empty one it
   * carries for something else is not. Omitted = both needed (safe default).
   */
  needed?: { fuel?: boolean; power?: boolean };
}): ReturnNeed {
  const fuel = evaluateResourceNeed({ ...args, reading: args.fuel, resource: 'fuel', needed: args.needed?.fuel ?? true });
  const power = evaluateResourceNeed({ ...args, reading: args.power, resource: 'power', needed: args.needed?.power ?? true });
  const known = [fuel, power].filter((n) => n.requiredPct !== null && n.remainingPct !== null);
  if (known.length === 0) {
    // Keep one honest line rather than inventing a resource.
    return {
      ...fuel,
      resource: null,
      trigger: false,
      reason: 'no fuel or power runway to judge the return on (readings unknown)',
    };
  }
  const headroom = (n: ReturnNeed): number => {
    if (n.remainingPct === null || n.thresholdPct === null) return Number.POSITIVE_INFINITY;
    return n.remainingPct - n.thresholdPct;
  };
  const worst = [...known].sort((a, b) => headroom(a) - headroom(b))[0]!;
  // A resource that does not trigger must not hide one that does.
  const firing = known.filter((n) => n.trigger);
  return firing.length > 0 ? firing.sort((a, b) => headroom(a) - headroom(b))[0]! : worst;
}

// --------------------------------------------------------------------- home

export interface HomeCandidate {
  gridId: string;
  name: string;
  position: Vec3;
  /** Height above the catalogue surface, metres (null when unknown). */
  altitudeM: number | null;
  /** Has a charging/refuel bay (battery, H2 tank or connector). */
  hasCharge: boolean;
}

export interface HomeResolution {
  home: (HomeCandidate & { distanceM: number }) | null;
  source: 'override' | 'default' | 'named' | 'nearest' | 'none';
  reason: string;
}

export function distanceM(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ------------------------------------------------------- home: a point

/**
 * A home may be a BASE grid OR an explicit point (a map click / GPS copied
 * out of game). Points are persisted as one string per override, so the kv row
 * stays a plain `Record<string, string>`:
 *
 *   point:1234.5,-678.9,1721.1        // x,y,z in world metres
 *   GPS:home:1234.5:-678.9:1721.1:    // a GPS string pasted from the game
 *
 * A point is validated before it is stored (surface, landing-grade ground,
 * clear of grids) so a typo can never silently fall back to BASE-01. The old
 * behaviour — store anything, ignore what does not resolve — is what let the
 * 2026-11-11 test store `point:300m-ground-2026` and keep using BASE-01.
 */
export const HOME_POINT_MIN_LEVEL = 5;
/** A home point must be this far from every grid centre, metres. */
export const HOME_POINT_CLEARANCE_M = 60;
/** "On the surface": accepted altitude band above the ground sample, metres. */
export const HOME_POINT_MAX_AGL_M = 25;
export const HOME_POINT_MIN_AGL_M = -10;

const POINT_KEY = /^point:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
const GPS_KEY = /^GPS:[^:]*:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):?.*$/i;

export function formatHomePointKey(point: Vec3): string {
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return `point:${round(point.x)},${round(point.y)},${round(point.z)}`;
}

/** The point encoded in a home override key, or null for a grid id/name. */
export function parseHomePointKey(key: string | null | undefined): Vec3 | null {
  if (!key) return null;
  const text = key.trim();
  const match = POINT_KEY.exec(text) ?? GPS_KEY.exec(text);
  if (!match) return null;
  const point = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
  return Object.values(point).every((v) => Number.isFinite(v)) ? point : null;
}

export function homePointLabel(point: Vec3): string {
  return `point ${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)}`;
}

export interface HomePointGround {
  /** Ground radius along the point's column, m. */
  radiusM: number;
  /** Terrain tile level behind `radiusM` (5 = finest); null for a mean/probe. */
  level: number | null;
  source: string;
}

export interface HomePointValidation {
  ok: boolean;
  code: 'off_planet' | 'below_surface' | 'above_surface' | 'coarse_ground' | 'too_close_to_grid' | null;
  reason: string;
  altitudeM: number | null;
  level: number | null;
  source: string | null;
}

/**
 * A home point must be a landing-grade spot: on the surface, on level-5
 * terrain, and clear of every grid. Pure — the caller supplies the ground
 * sample (the route reads it once through `ground.ts`, the same cache the
 * executor uses) so the rules are testable without a height field.
 */
export function validateHomePoint(args: {
  point: Vec3;
  planets: Planet[];
  ground: HomePointGround | null;
  grids: Array<{ gridId: string; name: string; position: Vec3 }>;
}): HomePointValidation {
  const { point } = args;
  const altitudeM = (planet: Planet, centre: Vec3, radiusM: number): number => {
    const raw = Math.round((Math.hypot(point.x - centre.x, point.y - centre.y, point.z - centre.z) - radiusM) * 10) / 10;
    return raw + 0; // never report -0 for "exactly on the surface"
  };
  const fail = (code: HomePointValidation['code'], reason: string, extra: Partial<HomePointValidation> = {}): HomePointValidation => ({
    ok: false,
    code,
    reason,
    altitudeM: null,
    level: args.ground?.level ?? null,
    source: args.ground?.source ?? null,
    ...extra,
  });

  let planet: Planet | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of args.planets) {
    const d = Math.abs(
      Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y, point.z - candidate.center.z) -
        candidate.surfaceRadiusM,
    );
    if (d < best) {
      best = d;
      planet = candidate;
    }
  }
  if (!planet) return fail('off_planet', 'that point is not near any planet: it must be on a planet surface');
  if (!args.ground) {
    return fail(
      'coarse_ground',
      `no terrain sample at that point on ${planet.name}; a home needs landing-grade (level ${HOME_POINT_MIN_LEVEL}) ground`,
    );
  }
  const alt = altitudeM(planet, planet.center, args.ground.radiusM);
  if (alt < HOME_POINT_MIN_AGL_M) {
    return fail('below_surface', `that point is ${Math.abs(alt)} m under the ground on ${planet.name}; pick a surface point`, {
      altitudeM: alt,
    });
  }
  if (alt > HOME_POINT_MAX_AGL_M) {
    return fail('above_surface', `that point is ${alt} m above the ground on ${planet.name}; a home must be on the surface`, {
      altitudeM: alt,
    });
  }
  if (args.ground.level === null || args.ground.level < HOME_POINT_MIN_LEVEL) {
    return fail(
      'coarse_ground',
      `the ground there is level ${args.ground.level ?? 'unknown'} (${args.ground.source}), not landing grade ` +
        `(level ${HOME_POINT_MIN_LEVEL}): pick a point on fine terrain`,
      { altitudeM: alt },
    );
  }
  for (const grid of args.grids) {
    const d = distanceM(point, grid.position);
    if (d < HOME_POINT_CLEARANCE_M) {
      return fail(
        'too_close_to_grid',
        `that point is ${Math.round(d)} m from ${grid.name}; keep at least ${HOME_POINT_CLEARANCE_M} m from every grid`,
        { altitudeM: alt },
      );
    }
  }
  return { ok: true, code: null, reason: `home point on ${planet.name} at ${alt} m AGL, level-${args.ground.level} ground`, altitudeM: alt, level: args.ground.level, source: args.ground.source };
}

/**
 * Per-ship override, else the base flagged home (default BASE-01), else the
 * nearest base with a charging/refuel bay. A name may stand in for an id so an
 * operator can write `BASE-01`; the site sends ids.
 */
export function resolveHome(args: {
  gridId: string;
  position: Vec3 | null;
  candidates: HomeCandidate[];
  overrides?: Record<string, string> | null;
  defaultHomeId?: string | null;
}): HomeResolution {
  const { candidates, position } = args;
  const withDistance = (c: HomeCandidate) => ({ ...c, distanceM: position ? distanceM(position, c.position) : Number.NaN });
  const byKey = (key: string | null | undefined): HomeCandidate | null => {
    if (!key) return null;
    return candidates.find((c) => c.gridId === key) ?? candidates.find((c) => c.name.toLowerCase() === key.toLowerCase()) ?? null;
  };

  const overrideKey = args.overrides?.[args.gridId] ?? null;
  const overridePoint = parseHomePointKey(overrideKey);
  if (overridePoint) {
    const name = homePointLabel(overridePoint);
    return {
      home: position
        ? {
            gridId: overrideKey!,
            name,
            position: overridePoint,
            // Filled by the caller from the planet catalogue; unknown here.
            altitudeM: null,
            hasCharge: false,
            distanceM: distanceM(position, overridePoint),
          }
        : null,
      source: 'override',
      reason: `home override: ${name} (a point, not a base)`,
    };
  }
  const override = byKey(overrideKey);
  if (override) {
    const c = withDistance(override);
    return {
      home: position ? c : null,
      source: 'override',
      reason: `home override: ${override.name}`,
    };
  }

  const flagged = byKey(args.defaultHomeId ?? null);
  if (flagged) {
    return {
      home: position ? withDistance(flagged) : null,
      source: args.defaultHomeId ? 'default' : 'named',
      reason: `home base: ${flagged.name}`,
    };
  }

  // A point can be the one home too (`POST …/home {homePoint}`).
  const defaultPoint = parseHomePointKey(args.defaultHomeId);
  if (defaultPoint) {
    const name = homePointLabel(defaultPoint);
    return {
      home: position
        ? {
            gridId: formatHomePointKey(defaultPoint),
            name,
            position: defaultPoint,
            altitudeM: null,
            hasCharge: false,
            distanceM: distanceM(position, defaultPoint),
          }
        : null,
      source: 'default',
      reason: `home point: ${name} (a point, not a base)`,
    };
  }

  const named = byKey('BASE-01');
  if (named) {
    return { home: position ? withDistance(named) : null, source: 'named', reason: 'home base: BASE-01 (the default)' };
  }

  if (!position) {
    return { home: null, source: 'none', reason: 'no home: the grid has no position to measure from' };
  }
  const chargers = candidates.filter((c) => c.hasCharge).map(withDistance);
  if (chargers.length === 0) {
    return {
      home: null,
      source: 'none',
      reason: `no home: no base flagged home and no reachable base with a charging bay (${candidates.length} base candidate(s))`,
    };
  }
  chargers.sort((a, b) => a.distanceM - b.distanceM);
  return {
    home: chargers[0]!,
    source: 'nearest',
    reason: `no flagged home: nearest base with a charging bay is ${chargers[0]!.name} (${Math.round(chargers[0]!.distanceM / 1000)} km)`,
  };
}

// ------------------------------------------------------------ landing spot

export interface LandingObstacle {
  gridId: string;
  position: Vec3;
  /**
   * Keep-out radius: base hull radius, or a landed grid's footprint plus the
   * landed-grid clearance. Callers supply the measured/estimated size.
   */
  radiusM: number;
}

export interface LandingSpot {
  point: Vec3;
  bearingDeg: number;
  distanceM: number;
  /** Closest keep-out surface to the chosen point, metres. */
  clearanceM: number;
  /**
   * The chosen point IS the home point (a validated point home that is clear).
   * A base grid is never landed on, so this is only ever true for a point home.
   */
  atHome?: boolean;
}

export interface LandingSpotResult {
  spot: LandingSpot | null;
  reason: string;
}

/** Unit vector of `v`, or null for a zero vector. */
function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len, z: v.z / len } : null;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/**
 * Where to land: the home point itself when it is clear, otherwise a free spot
 * beside it.
 *
 * A home may be a BASE GRID or a validated POINT. A base has a hull, so the
 * ship lands on a ring clear of it. A point (`point:x,y,z`, validated at store
 * time to be level-5 ground, on the surface and >= 60 m from every grid) has no
 * hull: landing on it IS the request, and offsetting it by a ring only lands
 * the ship in unvalidated terrain (verify #3 landed 150 m away on bearing 90
 * deg although the point was clear). So a clear point home is used as-is and
 * the reason says so; a blocked point falls back to the ring search and the
 * reason records that the home was blocked.
 *
 * The ring search is a polar sweep on the tangent plane at the home (up =
 * radial from the planet centre), closest ring first, bearings ordered by the
 * bearing from the home to the arriving ship so it lands on the side it is
 * coming from. A point is free when it clears every obstacle by its keep-out
 * radius. No random jitter: the same world gives the same spot, so the mission
 * is reproducible and an audit can be re-checked.
 */
export function chooseLandingSpot(args: {
  home: Vec3;
  planetCenter: Vec3 | null;
  /** Direction/side preference; usually the ship's current position. */
  incomingFrom?: Vec3 | null;
  baseHullRadiusM: number;
  obstacles?: LandingObstacle[];
  rings?: readonly number[];
  bearings?: readonly number[];
  /**
   * The home is a validated POINT (ground, level-5, clear of every grid), not
   * a base hull: land at it when it is still clear instead of on a ring.
   */
  homeIsPoint?: boolean;
}): LandingSpotResult {
  const up = unit(
    args.planetCenter
      ? { x: args.home.x - args.planetCenter.x, y: args.home.y - args.planetCenter.y, z: args.home.z - args.planetCenter.z }
      : { x: 0, y: 1, z: 0 },
  ) ?? { x: 0, y: 1, z: 0 };
  // Tangent basis that never collapses for an axis-aligned up.
  const helper = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const east = unit(cross(helper, up)) ?? { x: 1, y: 0, z: 0 };
  const north = unit(cross(up, east)) ?? { x: 0, y: 0, z: 1 };

  const homeRing = args.baseHullRadiusM + BASE_HULL_CLEARANCE_M;
  const rings = (args.rings ?? LANDING_SPOT_RINGS_M).filter((r) => r >= homeRing);
  const obstacles: LandingObstacle[] = [{ gridId: 'home', position: args.home, radiusM: homeRing }, ...(args.obstacles ?? [])];

  let preferred = 0;
  if (args.incomingFrom) {
    const d = { x: args.incomingFrom.x - args.home.x, y: args.incomingFrom.y - args.home.y, z: args.incomingFrom.z - args.home.z };
    const flat = { x: d.x - up.x * (d.x * up.x + d.y * up.y + d.z * up.z), y: d.y - up.y * (d.x * up.x + d.y * up.y + d.z * up.z), z: d.z - up.z * (d.x * up.x + d.y * up.y + d.z * up.z) };
    const dir = unit(flat);
    if (dir) {
      const deg = (Math.atan2(dir.y * north.y + dir.z * north.z + dir.x * north.x, dir.x * east.x + dir.y * east.y + dir.z * east.z) * 180) / Math.PI;
      preferred = ((deg % 360) + 360) % 360;
    }
  }

  const bearings = [...(args.bearings ?? LANDING_SPOT_BEARINGS_DEG)].sort((a, b) => {
    const da = Math.min(Math.abs(a - preferred), 360 - Math.abs(a - preferred));
    const db = Math.min(Math.abs(b - preferred), 360 - Math.abs(b - preferred));
    return da - db;
  });

  // A validated point home is the landing spot when it is still clear: the
  // ship lands ON the point, and the reason records the measured clearance so
  // an audit can re-check it. Only another grid can block it (the point was
  // validated >= 60 m from every grid when it was stored, but a grid may have
  // landed there since).
  let homeBlockedBy: LandingObstacle | null = null;
  if (args.homeIsPoint) {
    let clearance = Number.POSITIVE_INFINITY;
    for (const o of args.obstacles ?? []) {
      const c = distanceM(args.home, o.position) - o.radiusM;
      clearance = Math.min(clearance, c);
      if (c < 0) {
        homeBlockedBy = o;
        break;
      }
    }
    if (!homeBlockedBy) {
      const measured = Number.isFinite(clearance) ? clearance : null;
      return {
        spot: {
          point: args.home,
          bearingDeg: 0,
          distanceM: 0,
          clearanceM: measured === null ? 0 : Math.max(0, Math.round(measured * 10) / 10),
          atHome: true,
        },
        reason:
          'landing at the home point itself: it is a validated point home and ' +
          (measured === null
            ? 'no other grid is within its keep-out radius'
            : `clear of every grid by ${Math.round(measured)} m`),
      };
    }
  }

  for (const ring of rings) {
    for (const bearing of bearings) {
      const rad = (bearing * Math.PI) / 180;
      const offset = {
        x: east.x * Math.cos(rad) * ring + north.x * Math.sin(rad) * ring,
        y: east.y * Math.cos(rad) * ring + north.y * Math.sin(rad) * ring,
        z: east.z * Math.cos(rad) * ring + north.z * Math.sin(rad) * ring,
      };
      const point = { x: args.home.x + offset.x, y: args.home.y + offset.y, z: args.home.z + offset.z };
      let clearance = Number.POSITIVE_INFINITY;
      let blocked = false;
      for (const o of obstacles) {
        const c = distanceM(point, o.position) - o.radiusM;
        clearance = Math.min(clearance, c);
        if (c < 0) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        return {
          spot: { point, bearingDeg: bearing, distanceM: ring, clearanceM: Math.max(0, Math.round(clearance * 10) / 10) },
          reason:
            `free spot ${ring} m from the base on bearing ${bearing} deg (${Math.round(clearance)} m clearance)` +
            (homeBlockedBy
              ? `; the home point itself is blocked by ${homeBlockedBy.gridId}, so it is offset instead`
              : ''),
        };
      }
    }
  }
  return {
    spot: null,
    reason: `no free landing spot: every ${rings.length} ring(s) between ${rings[0] ?? 0} m and ${rings[rings.length - 1] ?? 0} m is inside a keep-out radius`,
  };
}

// ------------------------------------------------- test runway override

/**
 * TEST-ENV-ONLY: a per-grid runway reading that replaces the live one for the
 * trigger, so the whole return -> land -> refuel -> relaunch flight can be
 * exercised on the test world (where every ship is full and a full ship can
 * never trigger: `threshold <= 2 x needPct`, so a 100 % reading needs a trip
 * that eats a third of the tank).
 *
 * It changes NO threshold: the injected numbers go through exactly the same
 * formula. It is refused in survival mode, ignored there even when persisted,
 * audited on set and on use, and it expires by itself.
 */
export const SURVIVAL_TEST_RUNWAY_TTL_MS = 30 * 60_000;
export const SURVIVAL_TEST_RUNWAY_MAX_TTL_MS = 120 * 60_000;

export interface TestRunwayOverride {
  gridId: string;
  /** Which reading the trigger uses for this grid. */
  resource: 'power' | 'h2';
  runwayMin: number;
  pct: number;
  /** Wall clock when it was set (ms). */
  setAt: number;
  /** Wall clock when it stops applying (ms). */
  expiresAt: number;
  by: string | null;
}

/**
 * The override in force for one grid right now, or null. All of: persisted,
 * finite numbers, inside its window, demo/test env, and survival mode off.
 */
export function runwayOverrideActive(args: {
  override: TestRunwayOverride | null | undefined;
  now: number;
  survivalMode: boolean;
  demoEnv: boolean;
}): TestRunwayOverride | null {
  const o = args.override;
  if (!o) return null;
  if (args.survivalMode || !args.demoEnv) return null;
  if (!Number.isFinite(o.pct) || !Number.isFinite(o.runwayMin)) return null;
  if (!Number.isFinite(o.expiresAt) || args.now >= o.expiresAt) return null;
  if (o.resource !== 'power' && o.resource !== 'h2') return null;
  if (o.pct < 0 || o.pct > 100 || o.runwayMin <= 0) return null;
  return o;
}

// ----------------------------------------------------------- state records

export interface SurvivalRecord {
  gridId: string;
  name: string | null;
  state: SurvivalState;
  phase: SurvivalPhase;
  /** Plain-language line shown in state and on the site. */
  reason: string;
  updatedAt: number;
  /** The user-visible recommendation, even when no action was taken. */
  recommendation: string | null;
  need: ReturnNeed | null;
  home: { gridId: string; name: string; distanceM: number } | null;
  landing: LandingSpot | null;
  /** Where it stood when it left, so the relaunch flies back to its slot. */
  slot: { position: Vec3; planet: string | null; altitudeM: number | null } | null;
  missionId: string | null;
  /** The grid is flagged NEEDS_REFUEL from touchdown until it relaunches. */
  needsRefuel: boolean;
  flaggedAt: number | null;
  lastAttemptAt: number | null;
  /** Latest fuel/charge reading that decided readiness, percent. */
  refuelPct: number | null;
}

export function blankRecord(gridId: string, name: string | null, at: number): SurvivalRecord {
  return {
    gridId,
    name,
    state: 'OK',
    phase: null,
    reason: 'no return needed',
    updatedAt: at,
    recommendation: null,
    need: null,
    home: null,
    landing: null,
    slot: null,
    missionId: null,
    needsRefuel: false,
    flaggedAt: null,
    lastAttemptAt: null,
    refuelPct: null,
  };
}

/** What the site shows for a grid: the state label, reason, and slot vacancy. */
export function survivalView(record: SurvivalRecord): {
  state: SurvivalState;
  label: string;
  reason: string;
  phase: SurvivalPhase;
  needsRefuel: boolean;
  slotStatus: string | null;
  recommendation: string | null;
  missionId: string | null;
  refuelPct: number | null;
} {
  const labels: Record<SurvivalState, string> = {
    OK: 'OK',
    RETURN_PENDING: 'RETURNING (awaiting approval)',
    RETURNING: 'RETURNING',
    NEEDS_REFUEL: 'NEEDS_REFUEL',
    READY_TO_RELAUNCH: 'READY_TO_RELAUNCH',
    STRANDED: 'STRANDED (cannot return — no orders)',
  };
  return {
    state: record.state,
    label: labels[record.state],
    reason: record.reason,
    phase: record.phase,
    needsRefuel: record.needsRefuel,
    slotStatus:
      record.slot && (record.state === 'NEEDS_REFUEL' || record.state === 'READY_TO_RELAUNCH')
        ? 'vacant (refuelling)'
        : null,
    recommendation: record.recommendation,
    missionId: record.missionId,
    refuelPct: record.refuelPct,
  };
}

/**
 * Ready to relaunch: every *known* tank/charge reading is at or above the
 * threshold. No reading at all is not ready (null is not zero, and it is not
 * full either).
 */
export function readiness(args: {
  fuelPct: number | null;
  batteryPct: number | null;
  relaunchPct: number;
  /** Resources that must be readable and full (the one that brought it home). */
  required?: SurvivalResource[];
}): { ready: boolean; pct: number | null; reason: string } {
  const known = [args.fuelPct, args.batteryPct].filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) {
    return { ready: false, pct: null, reason: 'no fuel or charge reading yet: cannot tell whether it is refuelled' };
  }
  const lowest = Math.min(...known);
  const requiredReading = (resource: SurvivalResource): number | null =>
    resource === 'fuel' ? args.fuelPct : args.batteryPct;
  const requiredKnown = (args.required ?? []).every((resource) => {
    const value = requiredReading(resource);
    return value !== null && Number.isFinite(value);
  });
  const ready = requiredKnown && known.every((v) => v >= args.relaunchPct);
  return {
    ready,
    pct: Math.round(lowest * 10) / 10,
    reason: ready
      ? `refuelled: ${Math.round(lowest)} % (threshold ${Math.round(args.relaunchPct)} %)`
      : `still refuelling: ${Math.round(lowest)} % (needs ${Math.round(args.relaunchPct)} %)`,
  };
}
