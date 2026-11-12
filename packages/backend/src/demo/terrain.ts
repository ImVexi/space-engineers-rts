/**
 * Terrain height field loader (T49).
 *
 * Reads SETR tiles through the backend's existing GET-only proxy to the
 * world-geometry service (`demo/worldProxy.ts` -> RTS_TELEMETRY_TEST_BASE,
 * `/api/terrain/*`). Nothing is invented: if the service has no tiles for a
 * planet (Alien/Mars/Titan/Europa today) or cannot be reached, the caller gets
 * a field with `status: 'unavailable'` and a reason, and the planner labels the
 * result `terrain: 'unavailable'` instead of silently falling back.
 *
 * Cost control: one level-0 tile per face (65x65 heights, ~12 KB each) is the
 * whole planet at ~1.5 km resolution on a 59.4 km body, which is enough to
 * catch ridges between relays and cells. Tiles live in a bounded in-process
 * LRU (`TerrainTileCache`), whole fields in a small TTL map, and concurrent
 * loads for the same planet share one promise.
 */
import type { Planet } from '@se-rts/schemas';
import { fetchUpstream } from './worldProxy.js';
import {
  TERRAIN_FACES,
  TerrainTileCache,
  decodeSetr,
  faceUvFromDirection,
  sampleTileRadius,
  terrainFieldFromTiles,
  terrainTileKey,
  unavailableTerrainField,
  type TerrainField,
  type TerrainFace,
  type TerrainTile,
} from '../planner/terrainField.js';

/** Level used for planning; level 0 is one tile per cube face. */
export const PLANNING_TERRAIN_LEVEL = 0;
const TILE_CACHE_LIMIT = 96;
const FIELD_TTL_MS = 5 * 60_000;
const UNAVAILABLE_TTL_MS = 30_000;
const PLANETS_TTL_MS = 60_000;
const FIELD_CACHE_LIMIT = 8;
const TILE_TIMEOUT_MS = 3_000;

interface TerrainPlanetSummary {
  id: string;
  name: string;
  radius_min_m: number;
  radius_max_m: number;
  available: boolean;
  reason: string | null;
  /** Stable per-save render key; part of the tile cache key. */
  key?: string;
  /** Finest cube-sphere tile level the service can serve (0 = 65x65 per face). */
  max_level?: number;
}

interface FieldCacheEntry {
  at: number;
  field: TerrainField;
}

const tileCache = new TerrainTileCache(TILE_CACHE_LIMIT);
const fieldCache = new Map<string, FieldCacheEntry>();
const inFlight = new Map<string, Promise<TerrainField>>();
let planetsCache: { at: number; base: string; planets: TerrainPlanetSummary[] } | null = null;

function terrainDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env.RTS_TERRAIN ?? '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'disabled';
}

async function terrainPlanets(base: string): Promise<TerrainPlanetSummary[]> {
  const now = Date.now();
  if (planetsCache && planetsCache.base === base && now - planetsCache.at < PLANETS_TTL_MS) {
    return planetsCache.planets;
  }
  const reply = await fetchUpstream('/api/terrain/planets', base, TILE_TIMEOUT_MS);
  if (reply.status !== 200) throw new Error(`terrain planet list returned ${reply.status}`);
  const parsed = JSON.parse(reply.body.toString('utf8')) as { planets?: TerrainPlanetSummary[] };
  const planets = Array.isArray(parsed.planets) ? parsed.planets : [];
  planetsCache = { at: now, base, planets };
  return planets;
}

async function loadTile(
  base: string,
  planetId: string,
  face: TerrainFace,
  summary: TerrainPlanetSummary,
): Promise<TerrainTile> {
  const key = `${planetId}:${summary.key ?? 'na'}:${terrainTileKey({ face, level: PLANNING_TERRAIN_LEVEL, tx: 0, ty: 0 })}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const query = new URLSearchParams({
    level: String(PLANNING_TERRAIN_LEVEL),
    tx: '0',
    ty: '0',
  });
  const path = `/api/terrain/${encodeURIComponent(planetId)}/${face}?${query.toString()}`;
  const reply = await fetchUpstream(path, base, TILE_TIMEOUT_MS);
  if (reply.status !== 200) throw new Error(`terrain tile ${planetId}/${face} returned ${reply.status}`);
  const decoded = decodeSetr(reply.body);
  const tile: TerrainTile = {
    planetId,
    face,
    level: PLANNING_TERRAIN_LEVEL,
    tx: 0,
    ty: 0,
    n: decoded.n,
    heights: decoded.heights,
    radiusMinM: summary.radius_min_m,
    radiusMaxM: summary.radius_max_m,
  };
  tileCache.set(key, tile);
  return tile;
}

async function loadField(planet: Planet, base: string): Promise<TerrainField> {
  const summaries = await terrainPlanets(base);
  const summary =
    summaries.find((entry) => entry.id === planet.id) ??
    summaries.find((entry) => entry.name.toLowerCase() === planet.name.toLowerCase()) ??
    null;
  if (!summary) {
    return unavailableTerrainField(planet, `the test-world terrain service has no tiles for ${planet.name}`);
  }
  if (!summary.available) {
    return unavailableTerrainField(
      planet,
      summary.reason ?? `the test-world terrain service reports ${planet.name} as unavailable`,
    );
  }
  const tiles = await Promise.all(TERRAIN_FACES.map((face) => loadTile(base, summary.id, face, summary)));
  return terrainFieldFromTiles(planet, tiles);
}

/**
 * Terrain field for one planet. Never throws: a failure becomes an explicitly
 * unavailable field so the planner can label it instead of guessing. A failed
 * lookup is cached briefly too, so an offline telemetry service does not add a
 * timeout to every plan request.
 */
export async function loadTerrainField(
  planet: Planet,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerrainField> {
  if (terrainDisabled(env)) {
    return unavailableTerrainField(planet, 'terrain correction is disabled (RTS_TERRAIN=off)');
  }
  const key = planet.id ?? planet.name;
  const now = Date.now();
  const cached = fieldCache.get(key);
  const ttl = cached?.field.status === 'available' ? FIELD_TTL_MS : UNAVAILABLE_TTL_MS;
  if (cached && now - cached.at < ttl) return cached.field;
  const running = inFlight.get(key);
  if (running) return running;
  const base = (env.RTS_TELEMETRY_TEST_BASE?.trim() || 'http://127.0.0.1:8786').replace(/\/+$/, '');
  const promise = loadField(planet, base)
    .then((field) => {
      fieldCache.set(key, { at: Date.now(), field });
      while (fieldCache.size > FIELD_CACHE_LIMIT) {
        const oldest = fieldCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        fieldCache.delete(oldest);
      }
      return field;
    })
    .catch((err: unknown) =>
      unavailableTerrainField(planet, `terrain tiles could not be read: ${err instanceof Error ? err.message : String(err)}`),
    )
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Test/ops hook: drop every cached tile and field. */
export function clearTerrainCaches(): void {
  tileCache.clear();
  fieldCache.clear();
  planetsCache = null;
  inFlight.clear();
}

export function terrainCacheStats(): { tiles: number; fields: number } {
  return { tiles: tileCache.size, fields: fieldCache.size };
}

// ---------------------------------------------------- precision terrain sample

/**
 * Level used for LANDING altimetry, and the coarsest level that is still good
 * enough to call "measured" rather than "planning".
 *
 * Measured 2026-11-10 at BASE-01 and at SAT-R-0001's column on EarthLike: the
 * level-0 planning tile (one 65x65 tile per cube face, ~1.5 km per sample) is
 * 17 m low at BASE-01 and 31 m low at the ship's column, while level 5 (~30 m
 * per sample) puts a station resting on the ground at -0.8 m and puts the
 * ship's terrain contact within 0.2 m of the geometry-predicted radius. A
 * landing flare sized on the coarse datum brakes inside the hill.
 */
export const FINE_TERRAIN_LEVEL = 5;
/** Below this level a sample is planning-grade, not landing-grade. */
export const FINE_TERRAIN_MIN_LEVEL = 3;

export interface FineTerrainSample {
  /** Terrain radius along the direction, m. */
  radiusM: number;
  /** Tile level actually sampled. */
  level: number;
  /** Tiles fetched for this sample (0 when cached). */
  tilesFetched: number;
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Terrain radius at one direction from the FINEST available tile, for landing
 * altimetry. Returns null when the service has no tiles for the planet or the
 * fetch fails; callers fall back to the level-0 field and say so.
 *
 * Bounded cost: one tile (16 KB) per column, cached in the module LRU, plus a
 * neighbour when the point sits within one sample of a tile edge (bilinear
 * needs the un-clamped neighbourhood).
 */
export async function loadFineTerrainRadiusAt(
  planet: Planet,
  dir: { x: number; y: number; z: number },
  level: number = FINE_TERRAIN_LEVEL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FineTerrainSample | null> {
  if (terrainDisabled(env)) return null;
  const base = (env.RTS_TELEMETRY_TEST_BASE?.trim() || 'http://127.0.0.1:8786').replace(/\/+$/, '');
  let summaries: TerrainPlanetSummary[];
  try {
    summaries = await terrainPlanets(base);
  } catch {
    return null;
  }
  const summary =
    summaries.find((entry) => entry.id === planet.id) ??
    summaries.find((entry) => entry.name.toLowerCase() === planet.name.toLowerCase()) ??
    null;
  if (!summary || !summary.available) return null;
  const maxLevel = Math.min(level, Math.max(0, Math.trunc(summary.max_level ?? 0)) || level);
  if (maxLevel < FINE_TERRAIN_MIN_LEVEL) return null;

  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const unit = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  const { face, s, t } = faceUvFromDirection(unit);
  const div = Math.pow(2, maxLevel);
  const cell = 1 / div;
  const tx0 = clampInt(Math.floor(((s + 1) / 2) * div), 0, div - 1);
  const ty0 = clampInt(Math.floor(((t + 1) / 2) * div), 0, div - 1);
  // Within-tile position in [0,1); which edges (if any) sit under one sample.
  const lx = ((s + 1) / 2) * div - tx0;
  const ly = ((t + 1) / 2) * div - ty0;
  const near = 1 / 64; // one sample of a 65-vertex tile
  const xNeighbour = lx < near ? -1 : lx > 1 - near ? 1 : 0;
  const yNeighbour = ly < near ? -1 : ly > 1 - near ? 1 : 0;

  const wanted: { tx: number; ty: number }[] = [{ tx: tx0, ty: ty0 }];
  if (xNeighbour !== 0) wanted.push({ tx: tx0 + xNeighbour, ty: ty0 });
  if (yNeighbour !== 0) wanted.push({ tx: tx0, ty: ty0 + yNeighbour });
  if (xNeighbour !== 0 && yNeighbour !== 0) wanted.push({ tx: tx0 + xNeighbour, ty: ty0 + yNeighbour });

  let fetched = 0;
  let best: number | null = null;
  for (const coords of wanted) {
    if (coords.tx < 0 || coords.ty < 0 || coords.tx >= div || coords.ty >= div) continue;
    const key = `${summary.id}:${summary.key ?? 'na'}:${terrainTileKey({ face, level: maxLevel, tx: coords.tx, ty: coords.ty })}`;
    let tile = tileCache.get(key);
    if (!tile) {
      try {
        const query = new URLSearchParams({
          level: String(maxLevel),
          tx: String(coords.tx),
          ty: String(coords.ty),
        });
        const reply = await fetchUpstream(
          `/api/terrain/${encodeURIComponent(summary.id)}/${face}?${query.toString()}`,
          base,
          TILE_TIMEOUT_MS,
        );
        if (reply.status !== 200) continue;
        const decoded = decodeSetr(reply.body);
        tile = {
          planetId: summary.id,
          face,
          level: maxLevel,
          tx: coords.tx,
          ty: coords.ty,
          n: decoded.n,
          heights: decoded.heights,
          radiusMinM: summary.radius_min_m,
          radiusMaxM: summary.radius_max_m,
        };
        tileCache.set(key, tile);
        fetched += 1;
      } catch {
        continue;
      }
    }
    const sampled = sampleTileRadius(tile, s, t);
    if (!Number.isFinite(sampled)) continue;
    // Prefer a tile in which this point is NOT clamped to an edge.
    const insideX = ((s + 1) / 2) * div - coords.tx;
    const insideY = ((t + 1) / 2) * div - coords.ty;
    const unclamped = insideX > near * 0.5 && insideX < 1 - near * 0.5 && insideY > near * 0.5 && insideY < 1 - near * 0.5;
    if (best === null || unclamped) {
      best = sampled;
      if (unclamped) break;
    }
  }
  if (best === null) return null;
  const surface = Number(planet.surfaceRadiusM ?? 0) || 0;
  const hill = Math.max(Number(planet.maxHillRadiusM ?? 0) || 0, surface);
  if (best < surface - 1 || best > hill * 2) return null;
  return { radiusM: best, level: maxLevel, tilesFetched: fetched };
}
