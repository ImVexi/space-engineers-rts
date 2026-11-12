import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import type { Planet, Vec3 } from '../types';
import type { TerrainPlanet } from '../lib/worldMapTypes';
import { buildCoverageTexture, pointToLatLon, type CoverageResponse } from '../lib/coverage';
import {
  buildCoverageMesh,
  coverageGeometryData,
  coverageTerrainNotice,
  type CoverageMesh,
} from '../lib/coverageMesh';
import { createTerrainRadiusSampler, hasTerrainTiles, subscribeTerrainTiles } from '../lib/terrainSample';

export interface CoverageDatum {
  planet: string;
  response: CoverageResponse;
}

interface CoverageLayerProps {
  planets: Planet[];
  /** terrain metadata for the TEST world; null until /terrain/planets answers */
  terrainPlanets?: TerrainPlanet[] | null;
  data: CoverageDatum | null;
  visible: boolean;
  onCellPick: (planet: Planet, latDeg: number, lonDeg: number) => void;
  /** reports the mesh's own approximate warning so the legend cannot disagree */
  onTerrainReport?: (notice: string | null) => void;
}

/**
 * True once the terrain layer has decoded at least one tile for the planet.
 * The snapshot is a boolean on purpose: useSyncExternalStore only re-renders on
 * a change of value, so hundreds of tile arrivals cost one transition here.
 */
export function useTerrainTileReady(planetId: string | null): boolean {
  return useSyncExternalStore(
    subscribeTerrainTiles,
    () => (planetId ? hasTerrainTiles(planetId) : false),
    () => false,
  );
}

/**
 * Coalesced rebuild counter: tiles stream in one at a time, so the drape is
 * rebuilt at most once per `delayMs` batch instead of once per tile or never
 * at all (a partial face set would leave most of the planet undraped).
 */
function useTerrainTileGeneration(planetId: string | null, delayMs = 300): number {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!planetId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeTerrainTiles(() => {
      if (!hasTerrainTiles(planetId) || timer) return;
      timer = setTimeout(() => {
        timer = null;
        setGeneration((value) => value + 1);
      }, delayMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [planetId, delayMs]);
  return generation;
}

/** Find the terrain planet that matches a demo planet (id first, then name). */
export function terrainPlanetFor(
  terrainPlanets: TerrainPlanet[] | null | undefined,
  planet: Planet | null,
  planetName?: string,
): TerrainPlanet | null {
  if (!terrainPlanets?.length) return null;
  if (planet) {
    const byId = terrainPlanets.find((p) => p.id === planet.id);
    if (byId) return byId;
    const byName = terrainPlanets.find((p) => p.name === planet.name);
    if (byName) return byName;
  }
  const key = planetName ?? planet?.name ?? planet?.id;
  if (!key) return null;
  return terrainPlanets.find((p) => p.name === key || p.id === key) ?? null;
}

/**
 * Coverage heatmap (T44/T51.10). One BufferGeometry of quads, one per cell,
 * placed at the cell's sampled terrain height + bias and tangent to the local
 * surface, so hills can neither hide the overlay nor paint a colour at the
 * wrong altitude. Colours ride on a single DataTexture indexed by quad, so the
 * whole planet is one draw call and one material.
 *
 * Fallback: when the response says `terrain: 'unavailable'` (or no SETR heights
 * have been decoded for the planet yet) the mesh drops to the smooth shell and
 * the layer reports {@link APPROXIMATE_LABEL} — the legend shows it; an
 * approximate heatmap is never presented as exact.
 */
export function CoverageLayer({
  planets,
  terrainPlanets,
  data,
  visible,
  onCellPick,
  onTerrainReport,
}: CoverageLayerProps) {
  const planet = data ? planets.find((p) => p.name === data.planet || p.id === data.planet) ?? null : null;
  const terrainPlanet = useMemo(
    () => terrainPlanetFor(terrainPlanets, planet, data?.planet),
    [terrainPlanets, planet, data?.planet],
  );
  const terrainReady = terrainPlanet ? hasTerrainTiles(terrainPlanet.id) : false;
  const terrainGeneration = useTerrainTileGeneration(terrainPlanet?.id ?? null);
  const notice = data ? coverageTerrainNotice(data.response.terrain, terrainReady) : null;

  const mesh: CoverageMesh | null = useMemo(() => {
    if (!visible || !data || !planet) return null;
    const centre: Vec3 = terrainPlanet?.center ?? planet.center;
    const sampler = !notice && terrainPlanet ? createTerrainRadiusSampler(terrainPlanet.id) : null;
    return buildCoverageMesh({
      cells: data.response.cells ?? [],
      cellDeg: data.response.cellDeg ?? 10,
      center: centre,
      surfaceRadiusM: smoothRadiusKm(planet) * 1000,
      sampleTerrainRadiusM: sampler ? (dir) => sampler.radiusOf(dir) : null,
      maxTerrainRadiusInCellM: sampler ? (dir, halfAngleRad) => sampler.maxRadiusNear(dir, halfAngleRad) : null,
      forceShell: sampler == null,
    });
    // Rebuilt once per response, then once per coalesced terrain batch: the
    // heights are sampled at build time, so a late ridge would otherwise stay
    // hidden under a quad placed from the smooth radius.
  }, [visible, data, planet, terrainPlanet, notice, terrainGeneration]);

  // Smooth-shell fallback keeps the old equirect skin (and its texture).
  const shellMode = !mesh || mesh.mode === 'shell';
  const shellTexture = useMemo(() => {
    if (!visible || !data || !shellMode) return null;
    const { width, height, data: pixels } = buildCoverageTexture(
      data.response.cells ?? [],
      data.response.cellDeg ?? 10,
    );
    const tex = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [visible, data, shellMode]);

  // One RGBA texel per quad: the single material reads it by quad index.
  const quadTexture = useMemo(() => {
    if (!mesh || shellMode || mesh.quads.length === 0) return null;
    const { colors } = coverageGeometryData(mesh);
    const tex = new THREE.DataTexture(colors, mesh.quads.length, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [mesh, shellMode]);

  const quadGeometry = useMemo(() => {
    if (!mesh || shellMode || mesh.quads.length === 0) return null;
    const packed = coverageGeometryData(mesh);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(packed.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(packed.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(packed.indices, 1));
    geometry.computeBoundingSphere();
    geometry.userData.quads = packed.quadCount;
    geometry.userData.triangles = packed.triangleCount;
    return geometry;
  }, [mesh, shellMode]);

  useEffect(
    () => () => {
      shellTexture?.dispose();
    },
    [shellTexture],
  );
  useEffect(
    () => () => {
      quadTexture?.dispose();
    },
    [quadTexture],
  );
  useEffect(
    () => () => {
      quadGeometry?.dispose();
    },
    [quadGeometry],
  );

  // Report the mesh's own verdict upward: the legend must not call a mixed
  // (partly undraped) heatmap exact while the geometry still has smooth cells.
  useEffect(() => {
    if (!onTerrainReport) return;
    onTerrainReport(!visible || !data ? null : mesh?.notice ?? null);
  }, [onTerrainReport, visible, data, mesh]);

  // Test probe: proves which shape the heatmap draws and whether it is exact.
  useEffect(() => {
    (window as unknown as { __demoCoverageLayer?: unknown }).__demoCoverageLayer =
      visible && data
        ? {
            planet: data.planet,
            cells: data.response.cells?.length ?? 0,
            mode: mesh?.mode ?? 'shell',
            quads: mesh?.mode === 'shell' ? 0 : mesh?.quads.length ?? 0,
            terrain: data.response.terrain ?? null,
            approximate: notice != null,
            notice,
          }
        : null;
  }, [visible, data, mesh, notice]);

  if (!visible || !data || !planet) return null;

  const centre: Vec3 = terrainPlanet?.center ?? planet.center;
  const pick = (point: Vec3): void => {
    const local: Vec3 = { x: point.x * 1000, y: point.y * 1000, z: point.z * 1000 };
    const { latDeg, lonDeg } = pointToLatLon(local, centre);
    onCellPick(planet, latDeg, lonDeg);
  };

  return (
    <group name="coverage" position={[centre.x / 1000, centre.y / 1000, centre.z / 1000]}>
      {shellMode ? (
        <mesh
          name="coverage-shell"
          userData={{ approximate: true }}
          onClick={(event) => {
            event.stopPropagation();
            pick(event.point);
          }}
        >
          <sphereGeometry args={[smoothRadiusKm(planet), 96, 64]} />
          <meshBasicMaterial
            map={shellTexture ?? undefined}
            transparent
            opacity={0.82}
            depthWrite={false}
            side={THREE.FrontSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      ) : (
        <mesh
          name="coverage-terrain-quads"
          geometry={quadGeometry ?? undefined}
          renderOrder={2}
          userData={{ approximate: notice != null, quads: mesh?.quads.length ?? 0 }}
          onClick={(event) => {
            event.stopPropagation();
            // The quad is a central projection of the cell, so the hit point's
            // lat/lon is the cell's lat/lon — same conversion as the shell.
            pick(event.point);
          }}
        >
          <meshBasicMaterial
            map={quadTexture ?? undefined}
            transparent
            opacity={0.82}
            depthWrite={false}
            side={THREE.FrontSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}
    </group>
  );
}

/** Old shell radius: just above the surface so it never z-fights the sphere. */
function smoothRadiusKm(planet: Planet): number {
  return ((planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM) / 1000) * 1.004;
}
