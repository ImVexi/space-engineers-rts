import { describe, expect, it } from 'vitest';
import { pointToLatLon, type CoverageCell } from '../src/lib/coverage';
import {
  APPROXIMATE_LABEL,
  COVERAGE_QUAD_BIAS_M,
  MAX_COVERAGE_QUADS,
  buildCoverageMesh,
  coverageGeometryData,
  coverageTerrainNotice,
} from '../src/lib/coverageMesh';

/**
 * T51.10: the heatmap must sit on the terrain, not on a perfect sphere.
 * These tests exercise the pure builder only — no WebGL context is needed.
 */

/** EarthLike save centre: planet position + 131072 m on each axis. */
const CENTRE = { x: 131_072, y: 251_072, z: 1_072 };
const SURFACE_M = 59_400;
const HILL_M = 67_200;
/** what the old single sphere used: just above the *surface* radius */
const SMOOTH_RADIUS_M = SURFACE_M * 1.004;

function cell(latDeg: number, lonDeg: number, coveredBy: number): CoverageCell {
  return { latDeg, lonDeg, coveredBy };
}

/** World point of a local offset (the builder works relative to the centre). */
function world(local: { x: number; y: number; z: number }) {
  return { x: CENTRE.x + local.x, y: CENTRE.y + local.y, z: CENTRE.z + local.z };
}

function latLonOf(local: { x: number; y: number; z: number }) {
  return pointToLatLon(world(local), CENTRE);
}

function lonDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

function length(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Direction helper matching the builder's lat/lon convention. */
function dir(latDeg: number, lonDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon) };
}

describe('coverage mesh: one quad per cell', () => {
  it('builds a quad for every cell that carries data and skips empty entries', () => {
    const cells = [cell(-45, -45, 0), cell(-45, 45, 1), cell(45, -45, 2), cell(45, 45, 3), cell(0, 0, Number.NaN)];
    const mesh = buildCoverageMesh({ cells, cellDeg: 10, center: CENTRE, surfaceRadiusM: SMOOTH_RADIUS_M });
    expect(mesh.quads).toHaveLength(4);
    expect(mesh.quads.map((q) => q.coveredBy)).toEqual([0, 1, 2, 3]);
    // no terrain sampler supplied -> smooth shell, and it says so
    expect(mesh.mode).toBe('shell');
    expect(mesh.notice).toBe(APPROXIMATE_LABEL);
    expect(mesh.quads.every((q) => q.fromTerrain === false)).toBe(true);
  });

  it('packs one texel and two triangles per quad into the geometry arrays', () => {
    const cells = [cell(-75, -135, 0), cell(-15, 15, 1), cell(45, 105, 2), cell(75, -45, 2)];
    const mesh = buildCoverageMesh({
      cells,
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: () => 61_000,
    });
    const packed = coverageGeometryData(mesh);
    expect(packed.quadCount).toBe(4);
    expect(packed.triangleCount).toBe(8);
    expect(packed.positions).toHaveLength(4 * 4 * 3);
    expect(packed.indices).toHaveLength(4 * 6);
    expect(packed.colors).toHaveLength(4 * 4);
    // red 0 / amber 1 / green 2+
    expect(Array.from(packed.colors.slice(0, 4))).toEqual([192, 57, 43, 205]);
    expect(Array.from(packed.colors.slice(4, 8))).toEqual([224, 176, 114, 200]);
    expect(Array.from(packed.colors.slice(8, 12))).toEqual([63, 143, 104, 195]);
    // every quad owns exactly one texel, centred in its column
    for (let q = 0; q < 4; q += 1) {
      expect(packed.uvs[q * 8]).toBeCloseTo((q + 0.5) / 4, 6);
      expect(packed.uvs[q * 8 + 1]).toBeCloseTo(0.5, 6);
    }
    // positions are kilometres (scene units), never metres
    expect(Math.max(...Array.from(packed.positions).map(Math.abs))).toBeLessThan(100);
  });
});

describe('coverage mesh: picking stays honest', () => {
  it('converts every quad centre back to its own cell lat/lon within 0.5 deg', () => {
    const cells = [
      cell(-85, -175, 0),
      cell(-85, 175, 1),
      cell(-5, -5, 2),
      cell(5, 5, 1),
      cell(85, 175, 0),
      cell(0, 179, 2), // date line
      cell(60, 30, 1),
    ];
    const mesh = buildCoverageMesh({
      cells,
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: (d) => 60_000 + 1_000 * d.y,
    });
    expect(mesh.quads).toHaveLength(cells.length);
    for (const quad of mesh.quads) {
      const { latDeg, lonDeg } = latLonOf(quad.centre);
      expect(Math.abs(latDeg - quad.latDeg)).toBeLessThanOrEqual(0.5);
      expect(lonDelta(lonDeg, quad.lonDeg)).toBeLessThanOrEqual(0.5);
    }
  });

  it('winds every quad outward so the front face is the one you see and click', () => {
    const mesh = buildCoverageMesh({
      cells: [cell(0, 0, 2), cell(40, 120, 0), cell(-60, -30, 1)],
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: () => 61_500,
    });
    for (const quad of mesh.quads) {
      const [a, b, c] = quad.corners;
      const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const n = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
      const dot = n.x * quad.normal.x + n.y * quad.normal.y + n.z * quad.normal.z;
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('coverage mesh: terrain heights', () => {
  it('puts a cell over a hill at hill height + bias, not at the smooth radius', () => {
    const hillLat = 10;
    const hillLon = 20;
    const sampler = (d: { x: number; y: number; z: number }) => {
      const hill = dir(hillLat, hillLon);
      const dot = d.x * hill.x + d.y * hill.y + d.z * hill.z;
      // a 6-degree-tall ridge centred on the cell
      return dot > Math.cos((8 * Math.PI) / 180) ? HILL_M : SURFACE_M;
    };
    const mesh = buildCoverageMesh({
      cells: [cell(hillLat, hillLon, 2), cell(-70, 140, 0)],
      cellDeg: 5,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: sampler,
    });
    const onHill = mesh.quads.find((q) => q.latDeg === hillLat)!;
    const offHill = mesh.quads.find((q) => q.latDeg === -70)!;
    expect(onHill.radiusM).toBe(HILL_M + COVERAGE_QUAD_BIAS_M);
    expect(onHill.radiusM).toBeGreaterThan(SMOOTH_RADIUS_M);
    expect(length(onHill.centre)).toBeCloseTo(HILL_M + COVERAGE_QUAD_BIAS_M, 6);
    expect(offHill.radiusM).toBe(SURFACE_M + COVERAGE_QUAD_BIAS_M);
    expect(mesh.mode).toBe('terrain');
    expect(mesh.notice).toBeNull();
  });

  it('never places a quad under the terrain it covers (ridge between samples included)', () => {
    // Linear ramp in latitude: the peak of every cell is its north edge, which
    // the builder's 5x5 taps always include, so the invariant is checkable.
    const sampler = (d: { x: number; y: number; z: number }) => {
      const lat = (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI;
      return SURFACE_M + (lat + 90) * 40; // up to 3.6 km of relief
    };
    const cells: CoverageCell[] = [];
    for (let lat = -20; lat <= 20; lat += 10) for (let lon = 0; lon < 360; lon += 10) cells.push(cell(lat, lon, 1));
    const mesh = buildCoverageMesh({
      cells,
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: sampler,
    });
    expect(mesh.quads).toHaveLength(cells.length);

    const step = 10;
    const half = step / 2;
    let lowest = Infinity;
    for (const quad of mesh.quads) {
      // dense check: 7x7 taps across the whole cell, not just the builder's grid
      for (let i = 0; i <= 6; i += 1) {
        for (let j = 0; j <= 6; j += 1) {
          const dLat = -half + (i / 6) * step;
          const dLon = -half + (j / 6) * step;
          const r = sampler(dir(quad.latDeg + dLat, quad.lonDeg + dLon));
          expect(quad.radiusM).toBeGreaterThanOrEqual(r);
          lowest = Math.min(lowest, quad.radiusM - r);
        }
      }
      // and the planar quad bulges outward, so its corners are above the face
      for (const corner of quad.corners) expect(length(corner)).toBeGreaterThanOrEqual(quad.radiusM - 1e-6);
    }
    expect(lowest).toBeGreaterThan(0);
  });

  it('prefers the cell maximum when the terrain sampler can supply one', () => {
    const mesh = buildCoverageMesh({
      cells: [cell(10, 20, 2), cell(-40, 100, 0)],
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      // deliberately pessimistic: the point sampler alone would say "valley"
      sampleTerrainRadiusM: () => SURFACE_M,
      maxTerrainRadiusInCellM: (d) => (d.y > 0 ? HILL_M : SURFACE_M),
    });
    const onHill = mesh.quads.find((q) => q.latDeg === 10)!;
    expect(onHill.radiusM).toBe(HILL_M + COVERAGE_QUAD_BIAS_M);
    expect(onHill.radiusM).toBeGreaterThan(SMOOTH_RADIUS_M);
    expect(mesh.mode).toBe('terrain');
  });

  it('reports mixed mode when only some cells have heights, and keeps those quads exact', () => {
    const sampler = (d: { x: number; y: number; z: number }) => (d.y > 0 ? HILL_M : null);
    const mesh = buildCoverageMesh({
      cells: [cell(45, 0, 2), cell(-45, 0, 0)],
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: sampler,
    });
    expect(mesh.mode).toBe('mixed');
    expect(mesh.notice).toBe(APPROXIMATE_LABEL);
    expect(mesh.quads.find((q) => q.latDeg === 45)!.fromTerrain).toBe(true);
    expect(mesh.quads.find((q) => q.latDeg === -45)!.fromTerrain).toBe(false);
    expect(mesh.quads.find((q) => q.latDeg === -45)!.radiusM).toBe(SMOOTH_RADIUS_M);
  });
});

describe('coverage mesh: terrain-unavailable fallback', () => {
  it('forces the smooth shell and the approximate label when there are no heights', () => {
    const cells = [cell(0, 0, 0), cell(30, 60, 2)];
    const ready = buildCoverageMesh({
      cells,
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: () => HILL_M,
    });
    const fallback = buildCoverageMesh({
      cells,
      cellDeg: 10,
      center: CENTRE,
      surfaceRadiusM: SMOOTH_RADIUS_M,
      sampleTerrainRadiusM: null,
      forceShell: true,
    });
    expect(ready.mode).toBe('terrain');
    expect(ready.notice).toBeNull();
    expect(fallback.mode).toBe('shell');
    expect(fallback.notice).toBe(APPROXIMATE_LABEL);
    expect(fallback.quads.every((q) => q.radiusM === SMOOTH_RADIUS_M)).toBe(true);
  });

  it('shows the label for an unavailable response even when heights exist', () => {
    expect(coverageTerrainNotice('unavailable', true)).toBe(APPROXIMATE_LABEL);
    expect(coverageTerrainNotice('unavailable', false)).toBe(APPROXIMATE_LABEL);
    // corrected but nothing decoded yet: still approximate, never "exact"
    expect(coverageTerrainNotice('corrected', false)).toBe(APPROXIMATE_LABEL);
    expect(coverageTerrainNotice('corrected', true)).toBeNull();
    expect(coverageTerrainNotice(undefined, true)).toBeNull();
  });
});

describe('coverage mesh: whole-planet budget', () => {
  it('keeps a 5 degree planet under a few thousand quads and stays conservative above the cap', () => {
    const cells5: CoverageCell[] = [];
    for (let lat = -87.5; lat <= 90; lat += 5) for (let lon = -177.5; lon <= 180; lon += 5) cells5.push(cell(lat, lon, 1));
    const mesh5 = buildCoverageMesh({ cells: cells5, cellDeg: 5, center: CENTRE, surfaceRadiusM: SMOOTH_RADIUS_M });
    expect(mesh5.quads.length).toBe(2592);
    expect(mesh5.stride).toBe(1);
    expect(mesh5.droppedCells).toBe(0);

    const cells2: CoverageCell[] = [];
    for (let lat = -89; lat <= 90; lat += 2) for (let lon = -179; lon <= 180; lon += 2) cells2.push(cell(lat, lon, lon > 0 ? 2 : 0));
    const mesh2 = buildCoverageMesh({ cells: cells2, cellDeg: 2, center: CENTRE, surfaceRadiusM: SMOOTH_RADIUS_M });
    expect(cells2.length).toBeGreaterThan(MAX_COVERAGE_QUADS);
    expect(mesh2.quads.length).toBeLessThanOrEqual(MAX_COVERAGE_QUADS);
    expect(mesh2.droppedCells).toBeGreaterThan(0);
    // thinned groups keep their least covered cell: a group spanning 0 and 2
    // is drawn red, never green
    const reds = mesh2.quads.filter((q) => q.coveredBy === 0).length;
    expect(reds).toBeGreaterThan(0);
  });
});
