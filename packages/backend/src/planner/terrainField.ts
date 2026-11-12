/**
 * Terrain height field for link planning (T49).
 *
 * The planner footprint in `planetCoverage.ts` is a smooth sphere. Real terrain
 * turns a `covered` cell into a shadow when a ridge crosses the slant path, so
 * the coverage planner needs one number per direction: the terrain radius
 * (distance from the planet centre) of the drawn surface.
 *
 * This module is the pure half of that: the SETR tile codec, the cubesphere
 * face/uv mapping (identical to `packages/demo-site/src/lib/terrainFaces.ts`,
 * validated against real grounded grids) and a bounded LRU of decoded tiles.
 * It never touches the network; `demo/terrain.ts` fetches tiles through the
 * backend's GET-only proxy to the test-world telemetry instance.
 *
 * Heights stay backend-side: callers only receive booleans/counts, never the
 * height arrays.
 */
import type { Planet } from '@se-rts/schemas';
import { normalize, sub, v3, type V3 } from './geometry.js';

export const SETR_MAGIC = 'SETR';
export const SETR_VERSION = 1;
export const SETR_HEADER_BYTES = 16;

export const TERRAIN_FACES = ['front', 'back', 'left', 'right', 'up', 'down'] as const;
export type TerrainFace = (typeof TERRAIN_FACES)[number];

/** Planet-local -> world axis mirror applied by the backend terrain module. */
const PLANET_LOCAL_MIRROR = v3(-1, 1, 1);

interface FaceBasis {
  normal: V3;
  u: V3;
  v: V3;
}

const FACE_BASIS: Record<TerrainFace, FaceBasis> = {
  // SE "Forward" is -Z.
  front: { normal: v3(0, 0, -1), u: v3(1, 0, 0), v: v3(0, 1, 0) },
  back: { normal: v3(0, 0, 1), u: v3(-1, 0, 0), v: v3(0, 1, 0) },
  right: { normal: v3(1, 0, 0), u: v3(0, 0, 1), v: v3(0, 1, 0) },
  left: { normal: v3(-1, 0, 0), u: v3(0, 0, -1), v: v3(0, 1, 0) },
  up: { normal: v3(0, 1, 0), u: v3(1, 0, 0), v: v3(0, 0, 1) },
  down: { normal: v3(0, -1, 0), u: v3(-1, 0, 0), v: v3(0, 0, 1) },
};

function mirror(v: V3): V3 {
  return v3(v.x * PLANET_LOCAL_MIRROR.x, v.y * PLANET_LOCAL_MIRROR.y, v.z * PLANET_LOCAL_MIRROR.z);
}

export function isTerrainFace(name: string): name is TerrainFace {
  return (TERRAIN_FACES as readonly string[]).includes(name);
}

/** Face + (s,t) in [-1,1]² of a world direction (inverse of `directionFor`). */
export function faceUvFromDirection(direction: V3): { face: TerrainFace; s: number; t: number } {
  const dir = mirror(direction);
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  let face: TerrainFace;
  let denom: number;
  if (ay >= ax && ay >= az) {
    face = dir.y >= 0 ? 'up' : 'down';
    denom = Math.abs(dir.y);
  } else if (ax >= az) {
    face = dir.x >= 0 ? 'right' : 'left';
    denom = Math.abs(dir.x);
  } else {
    face = dir.z >= 0 ? 'back' : 'front';
    denom = Math.abs(dir.z);
  }
  const b = FACE_BASIS[face];
  const k = 1 / Math.max(denom, 1e-12);
  const px = dir.x * k;
  const py = dir.y * k;
  const pz = dir.z * k;
  return {
    face,
    s: px * b.u.x + py * b.u.y + pz * b.u.z,
    t: px * b.v.x + py * b.v.y + pz * b.v.z,
  };
}

/** Unit world direction on the sphere for face-local (s,t) in [-1,1]². */
export function directionFor(face: TerrainFace, s: number, t: number): V3 {
  const b = FACE_BASIS[face];
  return mirror(
    normalize({
      x: b.normal.x + b.u.x * s + b.v.x * t,
      y: b.normal.y + b.u.y * s + b.v.y * t,
      z: b.normal.z + b.u.z * s + b.v.z * t,
    }),
  );
}

export interface DecodedSetr {
  version: number;
  /** vertices per tile side */
  n: number;
  heights: Uint16Array;
}

/** SETR header (16 B) + n*n u16 heights + n*n u8 materials. */
export function decodeSetr(buffer: ArrayBuffer | ArrayBufferView): DecodedSetr {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < SETR_HEADER_BYTES) throw new Error(`SETR too short: ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== SETR_MAGIC) throw new Error(`bad SETR magic: ${JSON.stringify(magic)}`);
  const version = view.getUint32(4, true);
  if (version !== SETR_VERSION) throw new Error(`unsupported SETR version: ${version}`);
  const n = view.getUint32(8, true);
  if (n < 2 || n > 1024) throw new Error(`bad SETR n: ${n}`);
  const samples = n * n;
  const expected = SETR_HEADER_BYTES + samples * 3;
  if (bytes.byteLength !== expected) {
    throw new Error(`SETR length ${bytes.byteLength} != expected ${expected} for n=${n}`);
  }
  const heights = new Uint16Array(samples);
  let off = SETR_HEADER_BYTES;
  for (let i = 0; i < samples; i += 1) {
    heights[i] = view.getUint16(off, true);
    off += 2;
  }
  return { version, n, heights };
}

export interface TerrainTile {
  planetId: string;
  face: TerrainFace;
  level: number;
  tx: number;
  ty: number;
  n: number;
  heights: Uint16Array;
  radiusMinM: number;
  radiusMaxM: number;
}

export function terrainTileKey(tile: Pick<TerrainTile, 'face' | 'level' | 'tx' | 'ty'>): string {
  return `${tile.face}:${tile.level}:${tile.tx}:${tile.ty}`;
}

/** Bilinear height inside one tile, mapped to a radius in metres. */
export function sampleTileRadius(tile: TerrainTile, s: number, t: number): number {
  const div = Math.pow(2, tile.level);
  const lx = Math.min(1, Math.max(0, ((s + 1) / 2) * div - tile.tx));
  const ly = Math.min(1, Math.max(0, ((t + 1) / 2) * div - tile.ty));
  const gx = lx * (tile.n - 1);
  const gy = ly * (tile.n - 1);
  const x0 = Math.min(tile.n - 1, Math.floor(gx));
  const y0 = Math.min(tile.n - 1, Math.floor(gy));
  const x1 = Math.min(tile.n - 1, x0 + 1);
  const y1 = Math.min(tile.n - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const h00 = tile.heights[y0 * tile.n + x0]!;
  const h10 = tile.heights[y0 * tile.n + x1]!;
  const h01 = tile.heights[y1 * tile.n + x0]!;
  const h11 = tile.heights[y1 * tile.n + x1]!;
  const h = (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  return tile.radiusMinM + (h / 65535) * (tile.radiusMaxM - tile.radiusMinM);
}

/** Bounded LRU for decoded tiles (heights are ~12 KB each; keep the planet small). */
export class TerrainTileCache {
  private readonly limit: number;
  private readonly map = new Map<string, TerrainTile>();

  constructor(limit = 96) {
    this.limit = Math.max(1, limit);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): TerrainTile | undefined {
    const tile = this.map.get(key);
    if (tile) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, tile);
    }
    return tile;
  }

  set(key: string, tile: TerrainTile): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, tile);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * One queryable height field. `radiusAt` returns metres from the planet centre
 * along a unit world direction, or null when no cached tile covers it.
 */
export interface TerrainField {
  planet: string;
  planetId: string | null;
  status: 'available' | 'unavailable';
  reason: string | null;
  /** tiles backing this field (0 when unavailable) */
  tiles: number;
  /**
   * Cube-sphere tile level behind `radiusAt`, when the field knows it. 0 is the
   * planning grade (~1.5 km per sample on a 59 km body); a field that does not
   * say is treated as 0, because coarse-and-labelled is the safe default.
   */
  level?: number;
  radiusAt(dir: V3): number | null;
}

export function unavailableTerrainField(planet: Pick<Planet, 'name' | 'id'>, reason: string): TerrainField {
  return {
    planet: planet.name,
    planetId: planet.id ?? null,
    status: 'unavailable',
    reason,
    tiles: 0,
    radiusAt: () => null,
  };
}

/** Field backed by decoded SETR tiles (one tile per face is enough at level 0). */
export function terrainFieldFromTiles(
  planet: Pick<Planet, 'name' | 'id'>,
  tiles: TerrainTile[],
): TerrainField {
  const byFace = new Map<TerrainFace, TerrainTile[]>();
  for (const tile of tiles) {
    const list = byFace.get(tile.face);
    if (list) list.push(tile);
    else byFace.set(tile.face, [tile]);
  }
  // Finest level wins, exactly like the demo-site sampler.
  for (const list of byFace.values()) list.sort((a, b) => b.level - a.level);
  const level = tiles.reduce((best, tile) => Math.min(best, tile.level), Number.POSITIVE_INFINITY);
  return {
    planet: planet.name,
    planetId: planet.id ?? null,
    status: 'available',
    reason: null,
    tiles: tiles.length,
    level: Number.isFinite(level) ? level : undefined,
    radiusAt(direction: V3): number | null {
      const { face, s, t } = faceUvFromDirection(direction);
      const list = byFace.get(face);
      if (!list || list.length === 0) return null;
      for (const tile of list) {
        const local = Math.pow(2, tile.level);
        const u0 = (tile.tx / local) * 2 - 1;
        const v0 = (tile.ty / local) * 2 - 1;
        const u1 = ((tile.tx + 1) / local) * 2 - 1;
        const v1 = ((tile.ty + 1) / local) * 2 - 1;
        if (s < u0 - 1e-9 || s > u1 + 1e-9 || t < v0 - 1e-9 || t > v1 + 1e-9) continue;
        return sampleTileRadius(tile, s, t);
      }
      return null;
    },
  };
}

/**
 * Field backed by an arbitrary radius function. Used by tests to place a ridge
 * exactly where the plan needs one, and by callers that already have heights.
 */
export function terrainFieldFromRadiusFn(
  planet: Pick<Planet, 'name' | 'id'>,
  radiusFor: (direction: V3) => number | null,
  tiles = 1,
): TerrainField {
  return {
    planet: planet.name,
    planetId: planet.id ?? null,
    status: 'available',
    reason: null,
    tiles,
    radiusAt: radiusFor,
  };
}

/** Terrain radius along the direction of a world point, or null. */
export function terrainRadiusAtPoint(field: TerrainField, point: V3, center: V3): number | null {
  const dir = normalize(sub(point, center));
  if (!(Math.hypot(dir.x, dir.y, dir.z) > 0)) return null;
  return field.radiusAt(dir);
}
