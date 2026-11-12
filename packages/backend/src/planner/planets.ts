import fs from 'node:fs';
import { PlanetSchema, type Planet } from '@se-rts/schemas';

/**
 * Snapshot of this world's planets (read from the live save via the read-only
 * telemetry API on 2026-11-09). Centres have the 131072 m voxel-map offset
 * already applied; radii are `MinimumSurfaceRadius` / `MaximumHillRadius`.
 * This is world data, not a Keen asset. Override with `RTS_PLANETS_JSON`.
 */
export const PLANET_CATALOG: Planet[] = [
  {
    id: '3737586462974581268',
    name: 'Moon',
    center: { x: 131072, y: 251072, z: 1072 },
    surfaceRadiusM: 9215,
    maxHillRadiusM: 9785,
    hasAtmosphere: false,
  },
  {
    id: '-530204593823256958',
    name: 'Alien',
    center: { x: 131072, y: 131072, z: 5731072 },
    surfaceRadiusM: 59400,
    maxHillRadiusM: 67200,
    hasAtmosphere: true,
  },
  {
    id: '7664035927935629398',
    name: 'Mars',
    center: { x: 1031072, y: 131072, z: 1631072 },
    surfaceRadiusM: 59400,
    maxHillRadiusM: 67200,
    hasAtmosphere: true,
  },
  {
    id: '-7633282249754439910',
    name: 'EarthLike',
    center: { x: 0, y: 0, z: 0 },
    surfaceRadiusM: 59400,
    maxHillRadiusM: 67200,
    hasAtmosphere: true,
  },
  {
    id: '2531259191275190959',
    name: 'Titan',
    center: { x: 151072, y: 341072, z: 5911072 },
    surfaceRadiusM: 9215,
    maxHillRadiusM: 9785,
    hasAtmosphere: true,
  },
  {
    id: '2444517091027573723',
    name: 'Europa',
    center: { x: 1031072, y: 131072, z: 1731072 },
    surfaceRadiusM: 9215,
    maxHillRadiusM: 10070,
    hasAtmosphere: false,
  },
];

export function findPlanet(catalog: Planet[], nameOrId: string): Planet | undefined {
  const needle = nameOrId.toLowerCase();
  return catalog.find((p) => p.id === nameOrId || p.name.toLowerCase() === needle);
}

export function parsePlanetCatalog(value: unknown): Planet[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { planets?: unknown }).planets)
      ? (value as { planets: unknown[] }).planets
      : null;
  if (!raw) throw new Error('planet catalog must be an array or { planets: [] }');
  return raw.map((entry) => PlanetSchema.parse(entry));
}

/** Optional JSON override: `RTS_PLANETS_JSON=/path/to/planets.json`. */
export function loadPlanetCatalog(path?: string): Planet[] {
  const file = path ?? process.env.RTS_PLANETS_JSON;
  if (!file) return PLANET_CATALOG;
  return parsePlanetCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
}
