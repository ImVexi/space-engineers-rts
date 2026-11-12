/**
 * Which ground source is right, and one radius for every consumer
 * (2026-11-11, run set 2 / HEAD 22cac9f).
 *
 * The measurements this file pins come from `data/flight-proof-20261111.md`
 * ("Run set 2") and the raw states in `data/proof-20261111-set2/`, re-sampled
 * offline from the SETR tiles through the read-only telemetry proxy:
 *
 *   come-to-me hover column, hull radius 61 263.83 m, hull bottom 61 255.17 m
 *     level 0 (planning)   61 160.66 m   -> 94.5 m AGL
 *     level 1..4           61 192..61 196 m
 *     level 5 (landing)    61 197.80 m   -> 57.4 m AGL
 *   the datum the plugin was handed, then pushed mid-descent:
 *     61 197.8 -> 61 160.7 = -37.1 m at 18 m indicated AGL (the level-0 value)
 *
 * WHICH SOURCE IS RIGHT: the ship came to rest twice, and at rest the hull
 * bottom IS the ground, so the terrain model must reproduce the DIFFERENCE of
 * the two resting radii (61 191.11 - 61 158.34 = 32.77 m of relief) and cannot
 * do better than a constant bias (a voxel surface is not a smooth heightmap):
 *
 *   level 5: 61 197.82 - 61 164.44 = 33.38 m   (0.6 m off the 32.77 m relief)
 *   level 0: 61 160.68 - 61 163.32 = -2.64 m   (36.4 m off: it flattens the hill)
 *
 * Level 5 is the right source (it also carries a constant ~15 m bias against
 * hull contact at both resting columns, which is a DEM-calibration job, not a
 * LOD bug). Level 0 is unusable for a landing decision, so it must never be
 * pushed as a descent datum and must never be reported as a measured AGL.
 */
import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import {
  bestColumnGround,
  clearGroundCache,
  columnGround,
  groundColumnKey,
  isLandingGrade,
  rememberColumnGround,
} from '../src/demo/ground.js';
import { FINE_TERRAIN_LEVEL, FINE_TERRAIN_MIN_LEVEL } from '../src/demo/terrain.js';

const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const CENTRE = EARTH.center;

type Vec3 = { x: number; y: number; z: number };
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
/** Direction from the planet centre through a world point. */
const dirOf = (p: Vec3): Vec3 => unit({ x: p.x - CENTRE.x, y: p.y - CENTRE.y, z: p.z - CENTRE.z });

/** The measured columns (raw state files, run set 2). */
const HOVER = { x: -55886.91, y: -25036.84, z: 1751.15 };
const REST = { x: -55820.56, y: -25007.16, z: 1748.95 };
/** Landed at rest: hull bottom == ground == radius + keel (-8.66 m). */
const REST_RADIUS_M = 61_191.11;
const LAND1_RADIUS_M = 61_158.34;

/** Offline tile samples for those columns (all levels, backend mapping). */
const HOVER_LEVELS: Record<number, number> = {
  0: 61_160.66,
  1: 61_195.39,
  2: 61_192.06,
  3: 61_194.83,
  4: 61_196.07,
  5: 61_197.8,
};
const REST_LEVELS: Record<number, number> = {
  0: 61_160.68,
  1: 61_195.41,
  2: 61_192.09,
  3: 61_194.86,
  4: 61_196.09,
  5: 61_197.82,
};
const LAND1_LEVELS: Record<number, number> = {
  0: 61_163.32,
  1: 61_170.14,
  2: 61_164.75,
  3: 61_154.38,
  4: 61_160.07,
  5: 61_164.44,
};

function field(radiusM: number, level: number): TerrainField {
  return {
    planet: EARTH.name,
    planetId: EARTH.id ?? null,
    status: 'available',
    reason: null,
    tiles: 1,
    level,
    radiusAt: () => radiusM,
  };
}

describe('which ground source is right (measured, run set 2)', () => {
  it('level 5 reproduces the 32.77 m of relief between two resting columns; level 0 does not', () => {
    const reliefM = REST_RADIUS_M - LAND1_RADIUS_M;
    expect(reliefM).toBeCloseTo(32.77, 2);
    const l5 = REST_LEVELS[FINE_TERRAIN_LEVEL]! - LAND1_LEVELS[FINE_TERRAIN_LEVEL]!;
    const l0 = REST_LEVELS[0]! - LAND1_LEVELS[0]!;
    expect(Math.abs(l5 - reliefM), 'level 5 follows the terrain shape').toBeLessThan(1);
    expect(Math.abs(l0 - reliefM), 'level 0 flattens a 33 m hill').toBeGreaterThan(30);
  });

  it('the -37.1 m jump that hit the descent was level 5 replaced by level 0', () => {
    const jumpM = HOVER_LEVELS[0]! - HOVER_LEVELS[FINE_TERRAIN_LEVEL]!;
    expect(jumpM).toBeCloseTo(-37.14, 2);
    // The plugin recorded "datum 61 197.8 -> 61 160.7 m (-37.1)" at 18 m AGL.
    expect(HOVER_LEVELS[FINE_TERRAIN_LEVEL]).toBeCloseTo(61_197.8, 1);
    expect(HOVER_LEVELS[0]).toBeCloseTo(61_160.7, 1);
    // At 18 m of clearance the same column reads 18 m or 55.1 m depending on
    // the LOD: that is the disagreement the guard has to refuse.
    const hullBottomRadiusM = 61_255.17;
    expect(hullBottomRadiusM - HOVER_LEVELS[FINE_TERRAIN_LEVEL]!).toBeCloseTo(57.37, 2);
    expect(hullBottomRadiusM - HOVER_LEVELS[0]!).toBeCloseTo(94.51, 2);
  });
});

describe('one column key at metre resolution', () => {
  it('buckets at ~6 m on the surface, not at fractions of a millimetre', () => {
    clearGroundCache();
    const base = dirOf(REST);
    const key = groundColumnKey(EARTH, base);
    // 2 m of tangential drift is the SAME column (one descent tick).
    const twoM = groundColumnKey(EARTH, dirOf({ x: REST.x + 2, y: REST.y, z: REST.z }));
    // 40 m away is a different column.
    const fortyM = groundColumnKey(EARTH, dirOf({ x: REST.x + 40, y: REST.y, z: REST.z }));
    expect(twoM).toBe(key);
    expect(fortyM).not.toBe(key);
    // The old key divided a 1e6-scaled direction by the bucket size, i.e. one
    // bucket unit was ~0.4 mm: this pair 2 m apart hashed differently.
    // The old formula, verbatim: bucket = round(ux * 1000 * 1e6) / 6. One
    // bucket unit is 6e-9 of the unit direction = 0.37 mm at this radius.
    const oldKey = (v: Vec3): string => {
      const l = Math.hypot(v.x, v.y, v.z) || 1;
      const b = (c: number): string => (Math.round((c / l) * 1_000 * 1_000_000) / 6).toFixed(0);
      return `${EARTH.id ?? EARTH.name}:${b(v.x)}:${b(v.y)}:${b(v.z)}`;
    };
    const bucketM = (Math.hypot(REST.x, REST.y, REST.z) * 6) / 1e9;
    expect(bucketM).toBeLessThan(0.001);
    expect(oldKey(base)).not.toBe(oldKey({ x: REST.x + 2, y: REST.y, z: REST.z }));
  });

  it('a sample filed at the hover column is the same sample read back at the ship', () => {
    clearGroundCache();
    rememberColumnGround(EARTH, dirOf(HOVER), {
      radiusM: HOVER_LEVELS[FINE_TERRAIN_LEVEL]!,
      source: `terrain-l${FINE_TERRAIN_LEVEL}`,
      level: FINE_TERRAIN_LEVEL,
    });
    // The ship hovered 6.7 m from the hover point: same bucket, same datum.
    const ship = { x: HOVER.x + 5, y: HOVER.y + 4, z: HOVER.z };
    expect(columnGround(EARTH, dirOf(ship))!.radiusM).toBe(HOVER_LEVELS[FINE_TERRAIN_LEVEL]);
    expect(isLandingGrade(columnGround(EARTH, dirOf(ship))!.level)).toBe(true);
  });
});

describe('bestColumnGround: one policy, and the LOD is always labelled', () => {
  it('labels a cold column from the planning field as terrain-l0 and never files it', () => {
    clearGroundCache();
    const dir = dirOf(HOVER);
    const resolved = bestColumnGround(EARTH, dir, field(HOVER_LEVELS[0]!, 0))!;
    expect(resolved.radiusM).toBe(HOVER_LEVELS[0]);
    expect(resolved.source).toBe('terrain-l0');
    expect(resolved.level).toBe(0);
    expect(isLandingGrade(resolved.level)).toBe(false);
    // Coarse is an answer for this tick, never a measurement for the next one.
    expect(columnGround(EARTH, dir)).toBeNull();
  });

  it('prefers the finer filed sample and reports its level', () => {
    clearGroundCache();
    const dir = dirOf(HOVER);
    rememberColumnGround(EARTH, dir, {
      radiusM: HOVER_LEVELS[FINE_TERRAIN_LEVEL]!,
      source: `terrain-l${FINE_TERRAIN_LEVEL}`,
      level: FINE_TERRAIN_LEVEL,
    });
    const resolved = bestColumnGround(EARTH, dir, field(HOVER_LEVELS[0]!, 0))!;
    expect(resolved.radiusM).toBe(HOVER_LEVELS[FINE_TERRAIN_LEVEL]);
    expect(resolved.level).toBe(FINE_TERRAIN_LEVEL);
    expect(isLandingGrade(resolved.level)).toBe(true);
    expect(FINE_TERRAIN_MIN_LEVEL).toBeLessThanOrEqual(FINE_TERRAIN_LEVEL);
  });

  it('returns null (the catalogue mean, said out loud) when there is no terrain at all', () => {
    clearGroundCache();
    expect(bestColumnGround(EARTH, dirOf(HOVER), null)).toBeNull();
  });
});
