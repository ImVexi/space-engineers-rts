/**
 * Come to me (owner request 2026-11-11).
 *
 * The owner wants a ship brought low and near them, then landed by hand with
 * Remote Control. Two measured facts shape every rule here:
 *
 *   * the player's suit radio reaches 200 m, so the hover point must be inside
 *     180 m (margin) of the player or the Remote Control link never forms;
 *   * a ship over the player is a ship dropping on the player, so the offset
 *     is always AWAY from the player, along the line the ship is approaching
 *     on, and never closer than 25 m horizontally.
 *
 * Height is phrased on the HULL BOTTOM (the same datum as landing), using the
 * true terrain radius at the hover column when the height field has it. The
 * executor's `groundFrame`/`telemetryGroundFrame` then reads the same datum
 * back, so `targetAglM` at arrival equals the requested clearance.
 */
import type { Planet } from '@se-rts/schemas';
import { hullBottomAglM, pivotRadiusForHullBottomAgl } from './flight.js';
import { isLandingGrade, loadColumnGround } from './ground.js';
import type { Vec3 } from './moveTo.js';

/** Inside the 200 m suit radio with margin. Hard rule, never exceeded. */
export const COME_TO_ME_MAX_DISTANCE_M = 180;
/** Never directly above the player: minimum horizontal offset, m. */
export const COME_TO_ME_MIN_LATERAL_M = 25;
/** A hover this low is a landing pattern, not a hover; refuse below it. */
export const COME_TO_ME_MIN_AGL_M = 25;
/** Above this the player is not standing on the ground; come-to-me is pointless. */
export const COME_TO_ME_MAX_PLAYER_AGL_M = 1_000;
/** A player position older than this is not where they are standing now. */
export const COME_TO_ME_MAX_PLAYER_AGE_MS = 5 * 60_000;

export interface ComeToMeGroundSample {
  radiusM: number;
  /** 'terrain-l5' | 'terrain-l0' | 'mean' - recorded in the mission and audit. */
  source: string;
}

export interface ComeToMePoint {
  /** Position the grid must hold for its HULL BOTTOM to sit `hoverAglM` up. */
  position: Vec3;
  planet: string;
  /** Hover position altitude above the catalogue mean surface, m. */
  altitudeM: number;
  /** HULL-BOTTOM clearance above the true ground at the hover column, m. */
  hoverAglM: number;
  groundRadiusM: number;
  groundSource: string;
  /** The offset actually used (smaller than requested only when shrunk). */
  lateralM: number;
  requestedLateralM: number;
  aboveGroundM: number;
  /** True when the lateral offset was shrunk to keep the 180 m cap. */
  shrunk: boolean;
  /** 3D distance from the hover point to the player/stand-in point, m. */
  distanceToPlayerM: number;
  /** The horizontal component of that distance, m (>= 25 by construction). */
  horizontalM: number;
  directionSource: 'ship-approach' | 'fallback-tangent';
  /** Keel used (signed pivot -> lowest hull point along down). */
  keelDepthM: number;
  label: string;
}

export interface ComeToMeError {
  code: string;
  message: string;
  hint: string;
}

/** Ground sampler: direction from the planet centre -> terrain radius. */
export type GroundSampler = (dir: Vec3) => Promise<ComeToMeGroundSample | null> | ComeToMeGroundSample | null;

const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const mul = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
function norm(v: Vec3): Vec3 {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/**
 * Horizontal (tangential) direction to place a hover offset in, given the
 * player's local up and the direction the ship is currently approaching from.
 *
 * The offset points FROM the player TOWARD the ship, so the ship never has to
 * cross over the player. When the ship is already overhead (no usable
 * horizontal component) a deterministic tangent is used and labelled: the
 * hover still cannot sit over the player.
 */
export function offsetDirection(up: Vec3, shipOffset: Vec3): { dir: Vec3; source: 'ship-approach' | 'fallback-tangent' } {
  const planar = sub(shipOffset, mul(up, dot(shipOffset, up)));
  if (len(planar) > 1) return { dir: norm(planar), source: 'ship-approach' };
  const reference = Math.abs(up.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0.31 };
  let tangent = cross(up, reference);
  if (len(tangent) < 1e-6) tangent = cross(up, { x: 0, y: 0, z: 1 });
  return { dir: norm(tangent), source: 'fallback-tangent' };
}

/**
 * The hover point for one player (or stand-in point) and one ship.
 *
 * The caller supplies the ground sampler, so a test can hand in fake terrain
 * and the route hands in the real height field. Nothing here sends an order or
 * reads the clock.
 */
export async function computeComeToMePoint(input: {
  /** The player (or stand-in) position: the point that must stay inside 180 m. */
  playerPos: Vec3;
  /** The ship's current position: sets the approach direction. */
  shipPos: Vec3;
  planet: Planet;
  /** Signed pivot -> lowest hull point along local down (negative when the AABB ends above the pivot). */
  keelDepthM: number;
  lateralM: number;
  aboveGroundM: number;
  groundAt: GroundSampler;
}): Promise<{ point: ComeToMePoint } | { error: ComeToMeError }> {
  const { playerPos, shipPos, planet } = input;
  const centre = planet.center ?? { x: 0, y: 0, z: 0 };
  const lateralRequested = input.lateralM;
  const agl = input.aboveGroundM;
  const keel = Number.isFinite(input.keelDepthM) ? input.keelDepthM : 0;

  if (!(lateralRequested >= COME_TO_ME_MIN_LATERAL_M)) {
    return {
      error: {
        code: 'standoff_too_close',
        message:
          `a ${Math.round(lateralRequested)} m lateral offset would put the ship over the player; ` +
          `the minimum is ${COME_TO_ME_MIN_LATERAL_M} m horizontally`,
        hint: `Ask for a lateral offset of at least ${COME_TO_ME_MIN_LATERAL_M} m (default 40 m).`,
      },
    };
  }
  if (!(agl >= COME_TO_ME_MIN_AGL_M)) {
    return {
      error: {
        code: 'standoff_too_low',
        message: `a ${Math.round(agl)} m hull-bottom height is a landing pattern, not a hover; the minimum is ${COME_TO_ME_MIN_AGL_M} m`,
        hint: 'Ask for at least 25 m above the ground (default 80 m), or use a landing order instead.',
      },
    };
  }

  const playerRadius = len(sub(playerPos, centre));
  if (!(playerRadius > 1)) {
    return {
      error: {
        code: 'player_position_unknown',
        message: 'the player position is at the planet centre, so no ground frame can be built',
        hint: 'Wait for a fresh telemetry sample, or use a GPS stand-in point.',
      },
    };
  }
  const up = norm(sub(playerPos, centre));
  const playerGround = await input.groundAt(up);
  // Only a real height-field/probe sample can say the player is airborne: the
  // catalogue MEAN ground is 1.6 km below the true ground at the test column,
  // and calling that "1616 m up" would refuse a player standing on a hill.
  if (
    playerGround &&
    playerGround.source !== 'mean' &&
    playerRadius - playerGround.radiusM > COME_TO_ME_MAX_PLAYER_AGL_M
  ) {
    return {
      error: {
        code: 'player_not_on_ground',
        message: `the player is ${Math.round(playerRadius - playerGround.radiusM)} m above the ground; come-to-me parks beside a player on foot or on the ground`,
        hint: 'Wait until they are standing on the ground, or use a GPS stand-in point.',
      },
    };
  }

  const { dir, source } = offsetDirection(up, sub(shipPos, playerPos));

  const build = async (
    lateral: number,
  ): Promise<{ position: Vec3; ground: ComeToMeGroundSample; hoverRadius: number } | { error: ComeToMeError }> => {
    const raw = { x: playerPos.x + dir.x * lateral, y: playerPos.y + dir.y * lateral, z: playerPos.z + dir.z * lateral };
    const column = norm(sub(raw, centre));
    const ground = await input.groundAt(column);
    if (!ground || !(ground.radiusM > 1)) {
      return {
        error: {
          code: 'ground_unknown',
          message: 'the true ground at the hover point could not be resolved for this planet',
          hint: 'Retry when the terrain service has tiles, or ask for a plain GPS move-to instead.',
        },
      };
    }
    const hoverRadius = pivotRadiusForHullBottomAgl(ground.radiusM, keel, agl);
    return {
      position: { x: centre.x + column.x * hoverRadius, y: centre.y + column.y * hoverRadius, z: centre.z + column.z * hoverRadius },
      ground,
      hoverRadius,
    };
  };

  let lateral = lateralRequested;
  let built = await build(lateral);
  if ('error' in built) return built;

  // The offset is tangential, so the 3D distance is sqrt(lateral^2 + vertical^2).
  // Fit by shrinking the lateral component; the requested clearance is never
  // silently lowered (a lower hover is a landing, and that is a different ask).
  let shrunk = false;
  const vertical = built.hoverRadius - playerRadius;
  const distanceOf = (point: Vec3): number => len(sub(point, playerPos));
  if (distanceOf(built.position) > COME_TO_ME_MAX_DISTANCE_M) {
    if (Math.abs(vertical) >= COME_TO_ME_MAX_DISTANCE_M) {
      return {
        error: {
          code: 'standoff_refused',
          message:
            `a ${Math.round(agl)} m hull-bottom hover is ${Math.round(Math.abs(vertical))} m from the player vertically, ` +
            `so no offset of ${COME_TO_ME_MIN_LATERAL_M} m or more fits inside ${COME_TO_ME_MAX_DISTANCE_M} m`,
          hint: `Lower the hover to ${Math.round(COME_TO_ME_MAX_DISTANCE_M - COME_TO_ME_MIN_LATERAL_M)} m or less of hull-bottom height.`,
        },
      };
    }
    // 0.5 m of margin: the offset is tangential, but the terrain radius at a
    // slightly different column makes sqrt(lateral^2 + vertical^2) an
    // approximation - and 180.04 m would fail the hard cap.
    const lateralMax = Math.floor((Math.sqrt(COME_TO_ME_MAX_DISTANCE_M ** 2 - vertical ** 2) - 0.5) * 10) / 10;
    if (lateralMax < COME_TO_ME_MIN_LATERAL_M) {
      return {
        error: {
          code: 'standoff_refused',
          message:
            `the requested standoff does not fit inside ${COME_TO_ME_MAX_DISTANCE_M} m of the player: ` +
            `only ${lateralMax.toFixed(1)} m of lateral room is left after the ${Math.round(Math.abs(vertical))} m of height`,
          hint: 'Lower the hover height or give the ship more room (a closer offset than 25 m is never flown).',
        },
      };
    }
    lateral = lateralMax;
    shrunk = true;
    built = await build(lateral);
    if ('error' in built) return built;
    const final = distanceOf(built.position);
    if (final > COME_TO_ME_MAX_DISTANCE_M) {
      return {
        error: {
          code: 'standoff_refused',
          message:
            `the shrunk standoff (${lateral.toFixed(1)} m lateral) still puts the hover ${Math.round(final)} m from the player ` +
            `(cap ${COME_TO_ME_MAX_DISTANCE_M} m); the terrain at that column is higher than the player's`,
          hint: 'Lower the hover height, or use a stand-in point with more room.',
        },
      };
    }
  }

  const distance = distanceOf(built.position);
  const horizontal = Math.sqrt(Math.max(0, distance ** 2 - vertical ** 2));
  const altitudeM = Math.max(0, Math.round(built.hoverRadius - Number(planet.surfaceRadiusM ?? 0)));
  return {
    point: {
      position: built.position,
      planet: planet.name,
      altitudeM,
      hoverAglM: Math.round(hullBottomAglM(built.hoverRadius - built.ground.radiusM, keel) * 10) / 10,
      groundRadiusM: built.ground.radiusM,
      groundSource: built.ground.source,
      lateralM: Math.round(lateral * 10) / 10,
      requestedLateralM: Math.round(lateralRequested * 10) / 10,
      aboveGroundM: Math.round(agl * 10) / 10,
      shrunk,
      distanceToPlayerM: Math.round(distance * 10) / 10,
      horizontalM: Math.round(horizontal * 10) / 10,
      directionSource: source,
      keelDepthM: keel,
      label:
        `hover ${Math.round(lateral)} m to the side, hull bottom ${Math.round(agl)} m above the ground ` +
        `(${Math.round(distance)} m from the player)`,
    },
  };
}

/**
 * How far a COARSE ground sample is assumed to be wrong, m, when it is the only
 * datum a hover has.
 *
 * Measured 2026-11-11 (set 3) at the come-to-me hover column: the level-0
 * planning field read 61 160.7 m where level 5 reads 61 198.24 m, i.e. the
 * coarse field was **37.5 m LOW** on this hillside. A hover built on the coarse
 * number therefore sat 23 m below its 80 m ask (56.6 m measured on level 5).
 * The margin is that error rounded up, and it is added to the coarse sample so a
 * coarse datum can only ever place the hull HIGHER than asked, never lower.
 */
export const COME_TO_ME_COARSE_DATUM_MARGIN_M = 40;

/**
 * Ticks a hover may wait for the landing-grade read of its own column before it
 * falls back to the coarse datum + margin, exactly like the `land_at` handover
 * waits (`LANDING_HANDOVER_COARSE_WAITS`). 5 ticks at 1 Hz is 5 s, far less than
 * the hover's own settle.
 */
export const COME_TO_ME_COARSE_DATUM_WAITS = 5;

/** The tile level named in a ground `source` (`terrain-l5` -> 5), or null. */
export function levelFromGroundSource(source: string | null | undefined): number | null {
  const match = /-l(\d+)/.exec(source ?? '');
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isFinite(level) ? level : null;
}

/** One resolved hover datum: the sample, the margin applied, and the point. */
export interface HoverHoldDatum {
  /** The ground sample the decision started from, m. */
  sampleRadiusM: number;
  /** Tile level behind `sampleRadiusM` (null when the source has none). */
  level: number | null;
  /** The source, suffixed `+margin` when a coarse sample needed one. */
  source: string;
  /** Ground radius actually used (`sample` when fine, `sample + margin` when coarse), m. */
  datumRadiusM: number;
  /** Conservative margin added because the sample is not landing grade, m. */
  marginM: number;
  /** True when the sample was not landing grade. */
  coarse: boolean;
  /** The pivot radius the hull must hold for its BOTTOM to sit at the ask, m. */
  hoverRadiusM: number;
}

/**
 * The hold radius for a come-to-me hover, from ONE ground sample.
 *
 * The rule (owner decision 2026-11-11, set 3 evidence): a hover height may only
 * be built on a LANDING-GRADE sample - level 3+ from `ground.ts`. A coarse
 * (level-0) sample is ~1.5 km per sample and measured 37.5 m LOW at this hover
 * column, so using it as-is puts the hull 23 m under the requested clearance.
 * When it is all there is, the margin above is added: the error is assumed
 * against us, so the hull can only end up higher than asked. The caller is still
 * expected to wait `COME_TO_ME_COARSE_DATUM_WAITS` ticks for the fine read
 * first; this function is what it falls back to.
 *
 * Pure: no clock, no cache, no terrain service - the whole policy is testable
 * from the logged radii (61 160.7 / 61 198.24 / 80 m).
 */
export function hoverHoldDatum(input: {
  sampleRadiusM: number;
  level: number | null;
  source: string;
  keelDepthM: number;
  requestedAglM: number;
  marginM?: number;
}): HoverHoldDatum {
  const fine = isLandingGrade(input.level);
  const marginM = fine
    ? 0
    : Number.isFinite(input.marginM)
      ? Math.max(0, Number(input.marginM))
      : COME_TO_ME_COARSE_DATUM_MARGIN_M;
  const datumRadiusM = input.sampleRadiusM + marginM;
  const requested = Number.isFinite(input.requestedAglM) ? Math.max(0, input.requestedAglM) : 0;
  return {
    sampleRadiusM: input.sampleRadiusM,
    level: input.level,
    source: fine ? input.source : `${input.source}+margin`,
    datumRadiusM,
    marginM,
    coarse: !fine,
    hoverRadiusM: pivotRadiusForHullBottomAgl(datumRadiusM, input.keelDepthM, requested),
  };
}

/** Real ground sampler for the route: the ONE shared column sampler in
 * `ground.ts` (finest terrain level, then the level-0 planning field, then the
 * catalogue mean - the same order the executor uses, from the same cache), and
 * the source is reported so a `mean` hover is visible and a `terrain-l5` hover
 * is provably landing-grade.
 *
 * Sharing the cache is the fix for the 2026-11-11 disagreement: the hover point
 * and the executor's hold guard were sampling the same column through two
 * caches and read 61 162.9 m and 61 190 m, which refused a legal 80 m hover.
 */
export async function loadComeToMeGround(planet: Planet, dir: Vec3): Promise<ComeToMeGroundSample> {
  const shared = await loadColumnGround(planet, dir);
  if (shared && shared.radiusM > 1) return { radiusM: shared.radiusM, source: shared.source };
  return { radiusM: Number(planet.surfaceRadiusM ?? 0) || 0, source: 'mean' };
}

/** Per-column cache around one resolution (a resolution samples 1-3 columns). */
let groundSamplerOverride: ((planet: Planet) => GroundSampler) | null = null;

/**
 * Test/ops seam: replace the terrain fetch with a fixed sampler. The real
 * sampler reads the :8786 height field; a test must not depend on that service
 * being up (or on which column a save happens to have tiles for).
 */
export function setComeToMeGroundSampler(fn: ((planet: Planet) => GroundSampler) | null): void {
  groundSamplerOverride = fn;
}

export function groundSampler(planet: Planet): GroundSampler {
  if (groundSamplerOverride) return groundSamplerOverride(planet);
  const cache = new Map<string, ComeToMeGroundSample>();
  return async (dir: Vec3): Promise<ComeToMeGroundSample> => {
    const key = `${dir.x.toFixed(4)}:${dir.y.toFixed(4)}:${dir.z.toFixed(4)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const sample = await loadComeToMeGround(planet, dir);
    cache.set(key, sample);
    return sample;
  };
}
