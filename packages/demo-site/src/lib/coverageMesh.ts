/**
 * Coverage heatmap geometry (T51.10): one flat quad per coverage cell, draped
 * on the terrain the scene actually draws instead of a perfect sphere.
 *
 * Why quads and not a texture on a sphere: the EarthLike surface radius is
 * 59.4 km but hills reach 67.2 km, so a 59.64 km shell sits *inside* the
 * mountains — the terrain hides the heatmap and every cell is painted at the
 * wrong altitude. Each quad here is placed at the highest sampled terrain
 * radius inside the cell (+ a small bias) and lies in the plane tangent to the
 * planet at the cell centre, so the corners of the quad are the exact angular
 * corners of the cell: a hit anywhere on the quad converts back to its own
 * lat/lon with the existing `pointToLatLon`, and the quad can never sit under
 * the ridge it covers.
 *
 * Everything in this file is pure (no three.js, no DOM) so the geometry can be
 * unit-tested without a WebGL context: build once per response, then hand the
 * arrays to one BufferGeometry with one material.
 */
import type { Vec3 } from '../types';
import { coverageRgb, type CoverageCell } from './coverage';

/** Metres above the sampled surface: keeps the quad off the terrain mesh. */
export const COVERAGE_QUAD_BIAS_M = 40;

/** Contract label for a heatmap that is NOT terrain-corrected. */
export const APPROXIMATE_LABEL = 'terrain unavailable - heatmap approximate';

/**
 * Ceiling on quad count. 5° cells are 2592 quads (the fine end we ship); the
 * backend's minimum is 2° (16200 cells), so anything finer is thinned in
 * groups that keep the *least* covered cell — the picture may get coarser but
 * it never claims more coverage than the data has.
 */
export const MAX_COVERAGE_QUADS = 3000;

export type CoverageMeshMode = 'terrain' | 'mixed' | 'shell';

export interface CoverageQuad {
  latDeg: number;
  lonDeg: number;
  coveredBy: number;
  /** placement radius from the planet centre, metres (terrain + bias) */
  radiusM: number;
  /** quad centre in world metres */
  centre: Vec3;
  /** SW, NW, NE, SE — outward-wound, coplanar, tangent to the planet */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** outward normal (unit, world space) */
  normal: Vec3;
  /** RGBA 0..255, contract colours (0 red / 1 amber / >=2 green) */
  color: [number, number, number, number];
  /** false when this cell fell back to the smooth radius */
  fromTerrain: boolean;
}

export interface CoverageMeshInput {
  cells: readonly CoverageCell[];
  /** grid step in degrees (the cell's angular size) */
  cellDeg: number;
  /** planet centre, world metres (the terrain/save centre, not the origin) */
  center: Vec3;
  /** smooth-shell radius, metres — used for cells with no height sample */
  surfaceRadiusM: number;
  /** metres above the sampled surface (default 40) */
  biasM?: number;
  /** terrain radius in a direction, metres; null/absent = smooth shell */
  sampleTerrainRadiusM?: ((dir: Vec3) => number | null) | null;
  /**
   * Highest terrain radius within `halfAngleRad` of a direction. Preferred over
   * `sampleTerrainRadiusM` because it is an upper bound for the drawn surface
   * in the cell, not just the value at a handful of taps.
   */
  maxTerrainRadiusInCellM?: ((dir: Vec3, halfAngleRad: number) => number | null) | null;
  /** true when the response says terrain is unavailable: never sample */
  forceShell?: boolean;
}

export interface CoverageMesh {
  mode: CoverageMeshMode;
  quads: CoverageQuad[];
  /** quads dropped by the cap (>0 means the picture is coarser than the data) */
  droppedCells: number;
  /** group stride used by the cap, 1 = every cell drawn */
  stride: number;
  /** lowest / highest placement radius, metres */
  minRadiusM: number;
  maxRadiusM: number;
  /** approximate-heatmap warning, or null when the mesh is terrain-corrected */
  notice: string | null;
}

/**
 * The one place that decides whether a heatmap may be called exact. Both the
 * layer and its legend call this, so the mesh and the label can never disagree.
 */
export function coverageTerrainNotice(
  responseTerrain: string | null | undefined,
  terrainReady: boolean,
): string | null {
  if (responseTerrain === 'unavailable' || !terrainReady) return APPROXIMATE_LABEL;
  return null;
}

const DEG = Math.PI / 180;

function dirOf(latDeg: number, lonDeg: number): Vec3 {
  const lat = Math.max(-90, Math.min(90, latDeg)) * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  return { x: c * Math.cos(lon), y: Math.sin(lat), z: c * Math.sin(lon) };
}

/** Point on the plane {x · n = radius} along direction `c`. */
function projectOntoPlane(c: Vec3, n: Vec3, radius: number): Vec3 {
  const denom = c.x * n.x + c.y * n.y + c.z * n.z;
  const k = radius / (Math.abs(denom) < 1e-9 ? 1e-9 : denom);
  return { x: c.x * k, y: c.y * k, z: c.z * k };
}

function isEmptyCell(cell: CoverageCell): boolean {
  return !Number.isFinite(cell.latDeg) || !Number.isFinite(cell.lonDeg) || !Number.isFinite(cell.coveredBy);
}

/**
 * Thin a too-fine grid to at most `cap` cells. Groups are square blocks of the
 * original grid and each keeps its least-covered member, so the reduced picture
 * errs on the side of "less covered", never on the side of a false green.
 */
function capCells(
  cells: readonly CoverageCell[],
  cellDeg: number,
  cap: number,
): { cells: CoverageCell[]; dropped: number; stride: number } {
  if (cells.length <= cap) return { cells: [...cells], dropped: 0, stride: 1 };
  const step = Math.max(0.5, cellDeg);
  for (let stride = 2; stride < 64; stride += 1) {
    const kept = new Map<string, CoverageCell>();
    for (const cell of cells) {
      const key = `${Math.floor((cell.latDeg + 90) / (step * stride))}|${Math.floor((cell.lonDeg + 180) / (step * stride))}`;
      const seen = kept.get(key);
      if (!seen || cell.coveredBy < seen.coveredBy) kept.set(key, cell);
    }
    if (kept.size <= cap) {
      return { cells: [...kept.values()], dropped: cells.length - kept.size, stride };
    }
  }
  return { cells: [...cells].slice(0, cap), dropped: Math.max(0, cells.length - cap), stride: 64 };
}

export function buildCoverageMesh(input: CoverageMeshInput): CoverageMesh {
  const step = Number.isFinite(input.cellDeg) && input.cellDeg > 0 ? input.cellDeg : 10;
  const half = step / 2;
  const bias = input.biasM != null && Number.isFinite(input.biasM) ? Math.max(0, input.biasM) : COVERAGE_QUAD_BIAS_M;
  const sampler = input.forceShell ? null : input.sampleTerrainRadiusM ?? null;
  const cellMax = input.forceShell ? null : input.maxTerrainRadiusInCellM ?? null;
  const smoothRadius = input.surfaceRadiusM > 0 ? input.surfaceRadiusM : 1;

  const usable = input.cells.filter((cell) => !isEmptyCell(cell));
  const capped = capCells(usable, step, MAX_COVERAGE_QUADS);

  const quads: CoverageQuad[] = [];
  let sampledCells = 0;
  let minRadiusM = Infinity;
  let maxRadiusM = 0;
  // 5x5 taps across the cell (centre, edges, corners, and the quarter points
  // between them). Denser than the visible quad grid on purpose: a ridge just
  // inside the border has to set the placement height, or it pokes through.
  const taps = [-half, -half / 2, 0, half / 2, half];

  for (const cell of capped.cells) {
    const normal = dirOf(cell.latDeg, cell.lonDeg);
    let highest: number | null = null;
    if (cellMax) {
      // Preferred path: the highest terrain grid node inside the cell window.
      const r = cellMax(normal, half * DEG);
      if (r != null && Number.isFinite(r)) highest = r;
    } else if (sampler) {
      for (const dLat of taps) {
        for (const dLon of taps) {
          const r = sampler(dirOf(cell.latDeg + dLat, cell.lonDeg + dLon));
          if (r != null && Number.isFinite(r) && (highest == null || r > highest)) highest = r;
        }
      }
    }
    const fromTerrain = highest != null;
    if (fromTerrain) sampledCells += 1;
    const radiusM = fromTerrain ? (highest as number) + bias : smoothRadius;

    // Angular corners, projected onto the plane at `radiusM`: the quad spans
    // exactly this cell's lat/lon box and every point on it maps back to the
    // cell through pointToLatLon.
    const sw = dirOf(cell.latDeg - half, cell.lonDeg - half);
    const nw = dirOf(cell.latDeg + half, cell.lonDeg - half);
    const ne = dirOf(cell.latDeg + half, cell.lonDeg + half);
    const se = dirOf(cell.latDeg - half, cell.lonDeg + half);
    const corners: [Vec3, Vec3, Vec3, Vec3] = [
      projectOntoPlane(sw, normal, radiusM),
      projectOntoPlane(nw, normal, radiusM),
      projectOntoPlane(ne, normal, radiusM),
      projectOntoPlane(se, normal, radiusM),
    ];

    quads.push({
      latDeg: cell.latDeg,
      lonDeg: cell.lonDeg,
      coveredBy: cell.coveredBy,
      radiusM,
      centre: { x: normal.x * radiusM, y: normal.y * radiusM, z: normal.z * radiusM },
      corners,
      normal,
      color: coverageRgb(cell.coveredBy),
      fromTerrain,
    });
    if (radiusM < minRadiusM) minRadiusM = radiusM;
    if (radiusM > maxRadiusM) maxRadiusM = radiusM;
  }

  const mode: CoverageMeshMode =
    quads.length > 0 && sampledCells === quads.length ? 'terrain' : sampledCells > 0 ? 'mixed' : 'shell';

  return {
    mode,
    quads,
    droppedCells: capped.dropped,
    stride: capped.stride,
    minRadiusM: quads.length ? minRadiusM : smoothRadius,
    maxRadiusM: quads.length ? maxRadiusM : smoothRadius,
    notice: mode === 'terrain' ? null : APPROXIMATE_LABEL,
  };
}

export interface CoverageGeometryData {
  /** positions in kilometres, relative to the planet centre (scene units) */
  positions: Float32Array;
  /** uv per vertex: one texel per quad, so one DataTexture colours the mesh */
  uvs: Float32Array;
  indices: Uint32Array;
  /** RGBA per quad, ready for a DataTexture of width = quadCount */
  colors: Uint8Array<ArrayBuffer>;
  quadCount: number;
  triangleCount: number;
}

/**
 * Pack the quads into flat typed arrays for a single BufferGeometry: 4 vertices
 * and 2 triangles per quad, one UV texel per quad index for the colour map.
 */
export function coverageGeometryData(mesh: CoverageMesh): CoverageGeometryData {
  const count = mesh.quads.length;
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const indices = new Uint32Array(count * 6);
  const colors = new Uint8Array(new ArrayBuffer(count * 4));
  const order = [0, 1, 2, 0, 2, 3]; // SW,NW,NE / SW,NE,SE — outward wound

  mesh.quads.forEach((quad, q) => {
    for (let v = 0; v < 4; v += 1) {
      const corner = quad.corners[v];
      const p = (q * 4 + v) * 3;
      positions[p] = corner.x / 1000;
      positions[p + 1] = corner.y / 1000;
      positions[p + 2] = corner.z / 1000;
      const u = (q * 4 + v) * 2;
      uvs[u] = (q + 0.5) / Math.max(1, count);
      uvs[u + 1] = 0.5;
    }
    for (let i = 0; i < 6; i += 1) indices[q * 6 + i] = q * 4 + order[i];
    colors[q * 4] = quad.color[0];
    colors[q * 4 + 1] = quad.color[1];
    colors[q * 4 + 2] = quad.color[2];
    colors[q * 4 + 3] = quad.color[3];
  });

  return { positions, uvs, indices, colors, quadCount: count, triangleCount: count * 2 };
}
