import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Planet } from '../types';
import type { TerrainPlanet } from '../lib/worldMapTypes';
import { fetchTerrainTile } from '../lib/worldApi';
import { decodeSetr } from '../lib/setr';
import { TERRAIN_LOD, planTerrain, type TerrainPlan } from '../lib/quadtree';
import { buildSmoothSphereGeometry, buildTerrainGeometry } from '../lib/tileMesh';
import { directionFor, type TerrainFace } from '../lib/terrainFaces';
import { toScene } from '../lib/sceneMath';
import { publishDebug } from '../lib/debug';
import { registerTerrainTile } from '../lib/terrainSample';

/**
 * Planet terrain for the TEST world, ported from the world map's TerrainLayer.
 *
 * Same cubesphere quadtree, SETR tiles, skirts and biome vertex colours; the
 * same PLANET_LOCAL_MIRROR / +131072 planet-centre conventions (they live in
 * terrainFaces.ts and come from the save, not from this file). One unit is a
 * kilometre, identical to the demo scene.
 *
 * Loading is progressive (owner review): level 0 for all six faces is queued
 * first, then level 1, then the quadtree leaves, so a coarse planet appears
 * immediately and refines in place. A parent tile stays on screen until its
 * children are decoded (drawn behind them with a depth offset), which removes
 * the pop-in holes. Concurrency is 6, neighbours and the next level are
 * prefetched around the camera, and decoded tiles are kept in a byte-budgeted
 * LRU (longer client cache) instead of being dropped the moment they leave the
 * plan.
 */
const ENTER_FACTOR = 6;
const EXIT_FACTOR = 9;
const MAX_MEMORY_MB = 96;
const MAX_LEVEL = 5;
const TILE_HZ_MS = 240;

interface CachedTile {
  id: string;
  planetId: string;
  key: string;
  face: TerrainFace;
  level: number;
  tx: number;
  ty: number;
  geometry: THREE.BufferGeometry;
  bytes: number;
  lastUsed: number;
}

interface Job {
  id: string;
  planet: TerrainPlanet;
  key: string;
  face: TerrainFace;
  level: number;
  tx: number;
  ty: number;
  distanceKm: number;
  /** level-major, so the whole planet is coarse before any area refines */
  priority: number;
}

interface DisplayTile {
  key: string;
  tile: CachedTile;
  /** the parent is showing while a deeper tile for this area is in flight */
  refining: boolean;
}

export interface TerrainLayerProps {
  planets: Planet[];
  /** null while the metadata request is still in flight */
  terrainPlanets: TerrainPlanet[] | null;
  visible: boolean;
  /** quality ladder forwarded to the heightmap tiles */
  quality?: 'low' | 'medium' | 'high';
}

function planetRadiusKm(p: TerrainPlanet): number {
  return (p.radius_min_m + p.radius_max_m) / 2000;
}

function ancestors(face: TerrainFace, level: number, tx: number, ty: number): { level: number; tx: number; ty: number }[] {
  const out: { level: number; tx: number; ty: number }[] = [];
  for (let l = level; l >= 0; l--) {
    const shift = level - l;
    out.push({ level: l, tx: tx >> shift, ty: ty >> shift });
  }
  return out;
}

export function TerrainLayer({ planets, terrainPlanets, visible, quality = 'medium' }: TerrainLayerProps) {
  const camera = useThree((s) => s.camera);
  const limits = useMemo(
    () => ({
      maxTiles: quality === 'high' ? TERRAIN_LOD.maxTiles : quality === 'low' ? 90 : 180,
      maxConcurrent: TERRAIN_LOD.maxConcurrent,
    }),
    [quality],
  );
  const [, setVersion] = useState(0);
  const cache = useRef<Map<string, CachedTile>>(new Map());
  const loading = useRef<Map<string, AbortController>>(new Map());
  const failedAt = useRef<Map<string, number>>(new Map());
  const lod = useRef<Map<string, { leaves: Set<string>; expanded: Set<string> }>>(new Map());
  const active = useRef<Set<string>>(new Set());
  const lastTick = useRef(0);
  const dirty = useRef(false);
  const display = useRef<DisplayTile[]>([]);
  const queue = useRef<Job[]>([]);

  const bump = () => {
    dirty.current = true;
  };

  useEffect(() => {
    return () => {
      for (const ac of loading.current.values()) ac.abort();
      for (const t of cache.current.values()) t.geometry.dispose();
      cache.current.clear();
    };
  }, []);

  const startFetch = (job: Job): void => {
    const ac = new AbortController();
    loading.current.set(job.id, ac);
    fetchTerrainTile(job.planet.id, job, ac.signal, job.planet.key)
      .then((buf) => {
        const tile = decodeSetr(buf);
        // Publish the heights the scene is about to draw, so overlays (the
        // coverage heatmap) can drape themselves on this surface instead of a
        // guessed sphere.
        registerTerrainTile({
          planetId: job.planet.id,
          face: job.face,
          level: job.level,
          tx: job.tx,
          ty: job.ty,
          n: tile.n,
          heights: tile.heights,
          radiusMinM: job.planet.radius_min_m,
          radiusMaxM: job.planet.radius_max_m,
        });
        const geometry = buildTerrainGeometry({
          planet: job.planet,
          face: job.face,
          level: job.level,
          tx: job.tx,
          ty: job.ty,
          tile,
        });
        const bytes =
          geometry.userData.vertices * (3 + 3 + 3 + 2) * 4 + (geometry.index?.count ?? 0) * 4;
        cache.current.set(job.id, {
          id: job.id,
          planetId: job.planet.id,
          key: job.key,
          face: job.face,
          level: job.level,
          tx: job.tx,
          ty: job.ty,
          geometry,
          bytes,
          lastUsed: performance.now(),
        });
        failedAt.current.delete(job.id);
        bump();
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          failedAt.current.set(job.id, performance.now());
        }
      })
      .finally(() => {
        loading.current.delete(job.id);
        pump();
      });
  };

  /** Start queued jobs (level-major order) up to the concurrency cap. */
  const pump = (): void => {
    while (loading.current.size < limits.maxConcurrent && queue.current.length > 0) {
      const job = queue.current.shift() as Job;
      if (cache.current.has(job.id) || loading.current.has(job.id)) continue;
      const failed = failedAt.current.get(job.id);
      if (failed != null && performance.now() - failed < 10_000) continue;
      startFetch(job);
    }
  };

  const enqueue = (job: Job): void => {
    if (cache.current.has(job.id) || loading.current.has(job.id)) return;
    if (queue.current.some((q) => q.id === job.id)) return;
    queue.current.push(job);
  };

  useFrame(() => {
    // Tile arrivals only schedule a render; they never block the frame or the
    // HTML marker layer, which is the primary interaction.
    if (dirty.current) {
      dirty.current = false;
      setVersion((v) => v + 1);
    }
    if (!visible || !terrainPlanets?.length) return;
    const now = performance.now();
    if (now - lastTick.current < TILE_HZ_MS) return;
    lastTick.current = now;

    const nextQueue: Job[] = [];
    const nextDisplay = new Map<string, DisplayTile>();
    const levels: Record<string, number> = {};
    const keep = new Set<string>();

    for (const planet of terrainPlanets) {
      const centre = toScene(planet.center);
      const radius = planetRadiusKm(planet);
      const centreV = new THREE.Vector3(centre.x, centre.y, centre.z);
      const distance = camera.position.distanceTo(centreV);
      const isActive = active.current.has(planet.id)
        ? distance < radius * EXIT_FACTOR
        : distance < radius * ENTER_FACTOR;
      if (!isActive) {
        if (active.current.delete(planet.id)) bump();
        lod.current.delete(planet.id);
        continue;
      }
      if (!active.current.has(planet.id)) {
        active.current.add(planet.id);
        bump();
      }
      if (!planet.available) continue;

      const prev = lod.current.get(planet.id);
      const plan: TerrainPlan = planTerrain(
        planet,
        camera.position,
        prev?.leaves ?? new Set(),
        prev?.expanded ?? new Set(),
        { maxLevel: MAX_LEVEL, maxTiles: limits.maxTiles },
      );
      lod.current.set(planet.id, {
        leaves: new Set(plan.leaves.map((l) => l.key)),
        expanded: new Set(plan.expanded),
      });

      // 1. Progressive requirement: every ancestor of every leaf, level-major.
      //    Level 0 for the six faces therefore always goes out first.
      for (const leaf of plan.leaves) {
        for (const a of ancestors(leaf.face, leaf.level, leaf.tx, leaf.ty)) {
          const key = `${a.level}:${a.tx}:${a.ty}`;
          const id = `${planet.id}|${leaf.face}|${key}`;
          keep.add(id);
          nextQueue.push({
            id,
            planet,
            key,
            face: leaf.face,
            level: a.level,
            tx: a.tx,
            ty: a.ty,
            distanceKm: leaf.distanceKm,
            priority: (a.level === 0 ? -1_000_000 : 0) + leaf.distanceKm * 100 + a.level,
          });
        }
      }

      // 2. Prefetch neighbours and the next level around the camera: the next
      //    zoom step is then already in the browser cache.
      const nearest = [...plan.leaves].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 12);
      for (const leaf of nearest) {
        if (leaf.level >= MAX_LEVEL) continue;
        const div = Math.pow(2, leaf.level);
        const candidates: { level: number; tx: number; ty: number }[] = [
          { level: leaf.level + 1, tx: leaf.tx * 2, ty: leaf.ty * 2 },
          { level: leaf.level + 1, tx: leaf.tx * 2 + 1, ty: leaf.ty * 2 },
          { level: leaf.level + 1, tx: leaf.tx * 2, ty: leaf.ty * 2 + 1 },
          { level: leaf.level + 1, tx: leaf.tx * 2 + 1, ty: leaf.ty * 2 + 1 },
          { level: leaf.level, tx: Math.min(div - 1, leaf.tx + 1), ty: leaf.ty },
          { level: leaf.level, tx: Math.max(0, leaf.tx - 1), ty: leaf.ty },
          { level: leaf.level, tx: leaf.tx, ty: Math.min(div - 1, leaf.ty + 1) },
          { level: leaf.level, tx: leaf.tx, ty: Math.max(0, leaf.ty - 1) },
        ];
        for (const c of candidates) {
          const key = `${c.level}:${c.tx}:${c.ty}`;
          const id = `${planet.id}|${leaf.face}|${key}`;
          if (keep.has(id)) continue;
          nextQueue.push({
            id,
            planet,
            key,
            face: leaf.face,
            level: c.level,
            tx: c.tx,
            ty: c.ty,
            distanceKm: leaf.distanceKm + 1,
            priority: 5_000_000 + leaf.distanceKm * 100 + c.level,
          });
        }
      }

      // Camera-facing faces only: those are the ones "level >= 2 on all
      // visible faces" can mean, and the far hemisphere is a coarse base tile.
      const toCam = camera.position.clone().sub(centreV).normalize();
      const visibleFaces = new Set<TerrainFace>();
      for (const face of (planet.faces ?? ['front', 'back', 'left', 'right', 'up', 'down']) as TerrainFace[]) {
        const n = directionFor(face, 0, 0);
        if (n.x * toCam.x + n.y * toCam.y + n.z * toCam.z > 0.15) visibleFaces.add(face);
      }

      // 3. Display set: deepest cached tile per wanted leaf, with its parent
      //    kept underneath while the child is in flight (no holes/flashes).
      for (const leaf of plan.leaves) {
        let shown: CachedTile | null = null;
        let shownLevel = -1;
        for (const a of ancestors(leaf.face, leaf.level, leaf.tx, leaf.ty)) {
          const id = `${planet.id}|${leaf.face}|${a.level}:${a.tx}:${a.ty}`;
          const hit = cache.current.get(id);
          if (hit) {
            shown = hit;
            shownLevel = a.level;
            break;
          }
        }
        if (!shown) {
          // Nothing decoded yet for this area: still show the coarse face tile
          // if it exists in the cache under any ancestor (it is queued first).
          continue;
        }
        keep.add(shown.id);
        const refining = shownLevel < leaf.level;
        const existing = nextDisplay.get(shown.id);
        if (existing) {
          existing.refining = existing.refining || refining;
        } else {
          nextDisplay.set(shown.id, { key: shown.key, tile: shown, refining });
        }
        if (visibleFaces.has(leaf.face)) {
          levels[`${planet.id}/${leaf.face}`] = Math.max(
            levels[`${planet.id}/${leaf.face}`] ?? 0,
            shownLevel,
          );
        }
      }

      for (const face of visibleFaces) {
        const k = `${planet.id}/${face}`;
        levels[k] = levels[k] ?? 0;
      }
    }

    display.current = [...nextDisplay.values()];
    // Queue: level 0 for every face first (a coarse planet immediately), then
    // nearest-first through the whole ancestor chain. Level-major ordering was
    // wrong: it spent the whole budget on level-2 ancestors of every face and
    // starved the close-range tiles, leaving a flat low-res surface at 2 km.
    nextQueue.sort((a, b) => a.priority - b.priority);
    const seen = new Set<string>();
    queue.current = nextQueue
      .filter((j) => {
        if (seen.has(j.id)) return false;
        seen.add(j.id);
        return true;
      })
      .slice(0, 460);

    // Retain decoded tiles until the byte budget: a longer client cache makes
    // a zoom-out/zoom-in cycle instant instead of a re-fetch storm.
    let bytes = 0;
    for (const t of cache.current.values()) bytes += t.bytes;
    if (bytes > MAX_MEMORY_MB * 1024 * 1024) {
      const oldest = [...cache.current.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      for (const tile of oldest) {
        if (bytes <= MAX_MEMORY_MB * 1024 * 1024 * 0.85) break;
        if (keep.has(tile.id)) continue;
        tile.geometry.dispose();
        cache.current.delete(tile.id);
        bytes -= tile.bytes;
      }
    }
    pump();

    const tiles = display.current.length;
    publishDebug({
      terrain: {
        planets: terrainPlanets.length,
        available: terrainPlanets.filter((p) => p.available).length,
        unavailable: terrainPlanets.filter((p) => !p.available).length,
        tiles,
        smooth: 0,
        pending: loading.current.size + queue.current.length,
        memoryMb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
        maxLevel: MAX_LEVEL,
        label: 'Terrain: progressive cubesphere',
        visibleFaceLevels: levels,
      },
    });
  });

  if (!visible || !terrainPlanets?.length) return null;

  const groups = terrainPlanets
    .filter((p) => active.current.has(p.id))
    .map((p) => {
      const centre = toScene(p.center);
      const tiles = display.current.filter((t) => t.tile.planetId === p.id);
      return (
        <group key={p.id} name={`terrain-${p.id}`} position={[centre.x, centre.y, centre.z]}>
          {p.available &&
            tiles.map((d) => (
              <mesh
                key={d.tile.id}
                name={`terrain-tile-${d.tile.key}`}
                geometry={d.tile.geometry}
                renderOrder={d.refining ? -3 : -2}
              >
                {/* The parent stays visible under the arriving children: a
                    depth offset avoids z-fighting and the tint marks the
                    area as still refining instead of flashing a hole. */}
                <meshLambertMaterial
                  vertexColors
                  color={d.refining ? '#8a97a8' : '#ffffff'}
                  polygonOffset={d.refining}
                  polygonOffsetFactor={d.refining ? 1 : 0}
                  polygonOffsetUnits={d.refining ? 1 : 0}
                />
              </mesh>
            ))}
          {!p.available && <SmoothPlanet planet={p} />}
        </group>
      );
    });

  return <group name="terrain">{groups}</group>;
}

function SmoothPlanet({ planet }: { planet: TerrainPlanet }) {
  const geometry = useMemo(() => buildSmoothSphereGeometry(planet), [planet]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh name={`terrain-smooth-${planet.id}`} geometry={geometry}>
      <meshStandardMaterial color="#5a6472" roughness={0.95} metalness={0.02} />
    </mesh>
  );
}

/** Planet ids whose terrain is loaded/available, for hiding the base sphere. */
export function terrainCoveredIds(terrainPlanets: TerrainPlanet[] | null): Set<string> {
  return new Set((terrainPlanets ?? []).filter((p) => p.available).map((p) => p.id));
}
