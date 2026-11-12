import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import {
  coverageCellsFor,
  coverageCellsForNodes,
  coverageGridFromNodes,
  planPlanetCoverage,
  type CoverageTierSpec,
} from '../src/planner/planetCoverage.js';
import {
  TERRAIN_FACES,
  TerrainTileCache,
  decodeSetr,
  directionFor,
  faceUvFromDirection,
  terrainFieldFromRadiusFn,
  terrainFieldFromTiles,
  unavailableTerrainField,
  type TerrainTile,
} from '../src/planner/terrainField.js';
import { add, normalize, scale, v3, type V3 } from '../src/planner/geometry.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const SURFACE = earth.surfaceRadiusM;

function dirOf(latDeg: number, lonDeg: number): V3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
}

function angleBetween(a: V3, b: V3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
}

function setrBuffer(n: number, heights: number[]): Buffer {
  const buf = Buffer.alloc(16 + n * n * 3);
  buf.write('SETR', 0, 'ascii');
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(n, 8);
  buf.writeFloatLE(0, 12);
  for (let i = 0; i < heights.length; i += 1) buf.writeUInt16LE(heights[i]!, 16 + i * 2);
  return buf;
}

/** Ridge across the middle of the relay -> cell path, everything else smooth. */
function ridgeField(peakRadiusM: number, centerDir: V3, halfWidthM: number) {
  return terrainFieldFromRadiusFn(earth, (dir) => {
    const distanceM = angleBetween(dir, centerDir) * SURFACE;
    return distanceM <= halfWidthM ? peakRadiusM : SURFACE;
  });
}

describe('terrain-corrected coverage (T49)', () => {
  const relayDir = v3(0, 1, 0);
  const relayNode = { id: 'relay-1', position: scale(relayDir, SURFACE + 1_800), altitudeM: 1_800 };
  const cellAngle = 25_000 / SURFACE;
  const cellDir = v3(Math.sin(cellAngle), Math.cos(cellAngle), 0);
  const cellPoint = { latDeg: (Math.asin(cellDir.y) * 180) / Math.PI, lonDeg: 0, dir: cellDir };
  const pathMid = normalize(add(relayDir, cellDir));

  it('marks a cell blocked by a ridge that the smooth-sphere model calls covered', () => {
    const smooth = coverageCellsForNodes(earth, [cellPoint], [relayNode], 45_000, 1, null);
    expect(smooth.terrain).toBe('none');
    expect(smooth.cells[0]!.coveredBy).toBe(1);
    expect(smooth.cells[0]!.blockedByTerrain).toBe(false);
    expect(smooth.cells[0]!.bestRelayId).toBe('relay-1');

    const ridge = ridgeField(SURFACE + 2_600, pathMid, 3_500);
    // The measured rule is radio = range-only, so a ridge does NOT block a radio
    // cell. The LOS behaviour stays reachable for lasers/comparison and is pinned
    // here explicitly.
    const rangeOnly = coverageCellsForNodes(earth, [cellPoint], [relayNode], 45_000, 1, ridge);
    expect(rangeOnly.cells[0]!.coveredBy).toBe(1);
    expect(rangeOnly.cells[0]!.blockedByTerrain).toBe(false);

    const corrected = coverageCellsForNodes(earth, [cellPoint], [relayNode], 45_000, 1, ridge, false, 'range+los');
    expect(corrected.terrain).toBe('corrected');
    expect(corrected.cells[0]!.geometricCoveredBy).toBe(1);
    expect(corrected.cells[0]!.coveredBy).toBe(0);
    expect(corrected.cells[0]!.blockedByTerrain).toBe(true);
    expect(corrected.cells[0]!.bestRelayId).toBeNull();
    expect(corrected.coveredCells).toBe(0);
    expect(corrected.geometricCoveredCells).toBe(1);
    expect(corrected.blockedCells).toBe(1);
    expect(corrected.sampling?.samplesPerPath).toBe(12);
  });

  it('keeps the per-cell payload small: no height arrays cross the boundary', () => {
    const corrected = coverageCellsForNodes(earth, [cellPoint], [relayNode], 45_000, 1, ridgeField(SURFACE + 2_600, pathMid, 3_500));
    const cell = corrected.cells[0]! as unknown as Record<string, unknown>;
    expect(Object.keys(cell).sort()).toEqual(
      ['bestRelayId', 'blockedByTerrain', 'byTier', 'coveredBy', 'geometricCoveredBy', 'k', 'latDeg', 'lonDeg'].sort(),
    );
  });

  it('reports terrain as unavailable instead of silently using the smooth sphere', () => {
    const field = unavailableTerrainField(earth, 'no tiles for this planet');
    const grid = coverageGridFromNodes(earth, [relayNode], 50_000, { cellDeg: 30, terrain: field });
    expect(grid.terrain).toBe('unavailable');
    expect(grid.terrainReason).toContain('no tiles');
    expect(grid.blockedCells).toBe(0);
    expect(grid.coveredCells).toBe(grid.geometricCoveredCells);
    for (const cell of grid.cells) expect(cell.blockedByTerrain).toBe(false);

    const specs: CoverageTierSpec[] = [{ id: 'station', altitudeM: 15_000, radioRangeM: 50_000 }];
    const smooth = planPlanetCoverage(earth, specs, { cellDeg: 30, timing: false });
    const missing = planPlanetCoverage(earth, specs, { cellDeg: 30, terrain: field, timing: false });
    expect(missing.terrain).toBe('unavailable');
    expect(missing.labels).toContain('TERRAIN-UNAVAILABLE');
    expect(missing.labels).not.toContain('TERRAIN-CORRECTED');
    expect(missing.terrainReason).toContain('no tiles');
    expect(missing.tiers[0]!.coveragePct).toBe(smooth.tiers[0]!.coveragePct);
    expect(missing.terrainBlockedCells).toBe(0);
  });

  it('counts a constant-radius terrain field exactly like the smooth sphere', () => {
    const specs: CoverageTierSpec[] = [{ id: 'station', altitudeM: 15_000, radioRangeM: 50_000 }];
    const flat = terrainFieldFromRadiusFn(earth, () => SURFACE);
    const smooth = planPlanetCoverage(earth, specs, { cellDeg: 20, timing: false });
    const corrected = planPlanetCoverage(earth, specs, { cellDeg: 20, terrain: flat, timing: false });
    // Radio is range-only, so a flat terrain field changes nothing: the numbers
    // must match the smooth sphere and the plan must say terrain was not used
    // for radio rather than claiming a correction that never happened.
    expect(corrected.tiers[0]!.coveragePct).toBe(smooth.tiers[0]!.coveragePct);
    expect(corrected.terrainBlockedCells).toBe(0);
    // No sampling under the range-only rule: nothing was raycast for radio, and
    // the plan must not pretend otherwise.
    expect(corrected.sampling).toBeFalsy();
  });

  it('reuses cell centres per (planet, cellDeg)', () => {
    expect(coverageCellsFor(earth, 5)).toBe(coverageCellsFor(earth, 5));
    expect(coverageCellsFor(earth, 10)).not.toBe(coverageCellsFor(earth, 5));
    expect(coverageCellsFor(earth, 5).length).toBe(72 * 36);
  });

  it('plans a full planet at cellDeg 5 inside a few seconds', () => {
    const specs: CoverageTierSpec[] = [
      { id: 'atmo', altitudeM: 8_000, radioRangeM: 50_000 },
      { id: 'station', altitudeM: 15_000, radioRangeM: 50_000 },
      { id: 'zero-g', altitudeM: 45_000, radioRangeM: 50_000 },
    ];
    const started = Date.now();
    const plan = planPlanetCoverage(earth, specs, { cellDeg: 5, timing: false });
    const elapsed = Date.now() - started;
    expect(plan.cells.length).toBe(72 * 36);
    expect(plan.recommendedTier).toBe('station');
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('SETR terrain field (T49)', () => {
  it('decodes a SETR tile and refuses a bad magic', () => {
    const buf = setrBuffer(3, new Array(9).fill(1234));
    const decoded = decodeSetr(buf);
    expect(decoded.n).toBe(3);
    expect(decoded.heights[0]).toBe(1234);
    const bad = Buffer.from(buf);
    bad.write('XXXX', 0, 'ascii');
    expect(() => decodeSetr(bad)).toThrow(/magic/);
  });

  it('maps heights to radii through the cubesphere face mapping', () => {
    const n = 3;
    const heights: number[] = [];
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) heights.push(x * 10_000);
    const tile: TerrainTile = {
      planetId: earth.id,
      face: 'up',
      level: 0,
      tx: 0,
      ty: 0,
      n,
      heights: Uint16Array.from(heights),
      radiusMinM: 59_400,
      radiusMaxM: 67_200,
    };
    const field = terrainFieldFromTiles(earth, [tile]);
    expect(field.status).toBe('available');
    const sample = (s: number): number => field.radiusAt(directionFor('up', s, 0))!;
    expect(sample(-0.5)).toBeLessThan(sample(0));
    expect(sample(0)).toBeLessThan(sample(0.5));
    // The all-zero height column maps to the tile's minimum radius.
    expect(sample(-1)).toBeCloseTo(59_400, 0);
    // Directions on other faces have no tile in this field.
    expect(field.radiusAt(v3(0, 0, -1))).toBeNull();
    // The uv inversion is the exact inverse of the face mapping.
    const uv = faceUvFromDirection(directionFor('up', 0.3, -0.7));
    expect(uv.face).toBe('up');
    expect(uv.s).toBeCloseTo(0.3, 6);
    expect(uv.t).toBeCloseTo(-0.7, 6);
    expect(TERRAIN_FACES).toHaveLength(6);
  });

  it('bounds the decoded-tile cache', () => {
    const cache = new TerrainTileCache(2);
    const tile = (face: (typeof TERRAIN_FACES)[number]): TerrainTile => ({
      planetId: earth.id,
      face,
      level: 0,
      tx: 0,
      ty: 0,
      n: 2,
      heights: Uint16Array.from([0, 0, 0, 0]),
      radiusMinM: SURFACE,
      radiusMaxM: earth.maxHillRadiusM,
    });
    cache.set('front', tile('front'));
    cache.set('back', tile('back'));
    cache.set('left', tile('left'));
    expect(cache.size).toBe(2);
    expect(cache.get('front')).toBeUndefined();
    expect(cache.get('left')).toBeDefined();
  });
});

describe('terrain provenance labels', () => {
  it('never claims corrected terrain when only the smooth sphere was used', () => {
    const specs: CoverageTierSpec[] = [{ id: 'station', altitudeM: 15_000, radioRangeM: 50_000 }];
    const plan = planPlanetCoverage(earth, specs, { cellDeg: 30, timing: false });
    expect(plan.terrain).toBe('none');
    expect(plan.labels).not.toContain('TERRAIN-CORRECTED');
    expect(plan.labels).not.toContain('TERRAIN-UNAVAILABLE');
    expect(plan.sampling).toBeNull();
  });

  it('uses the planet-centre offset when comparing path height to terrain', () => {
    // Moon has a non-zero centre (131072, 251072, 1072); a missing offset would
    // make every sampled radius wrong, so a flat field must still be smooth.
    const moon = PLANET_CATALOG.find((p) => p.name === 'Moon')!;
    const field = terrainFieldFromRadiusFn(moon, () => moon.surfaceRadiusM);
    const grid = coverageGridFromNodes(
      moon,
      [{ id: 'm1', position: add(moon.center, scale(v3(0, 1, 0), moon.surfaceRadiusM + 2_000)), altitudeM: 2_000 }],
      50_000,
      { cellDeg: 30, terrain: field },
    );
    expect(grid.terrain).toBe('corrected');
    expect(grid.blockedCells).toBe(0);
    expect(grid.coveredCells).toBe(grid.geometricCoveredCells);
    expect(grid.coveredCells).toBeGreaterThan(0);
  });
});
