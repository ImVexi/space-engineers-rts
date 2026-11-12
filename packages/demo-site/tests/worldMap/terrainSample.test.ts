import { describe, expect, it, beforeEach } from 'vitest'
import type { TerrainPlanet } from '../../src/lib/worldMapTypes'
import { directionFor } from '../../src/lib/terrainFaces'
import {
  createTerrainRadiusSampler,
  registerTerrainTile,
  resetTerrainTiles,
  resolveSurfacePoint,
  sampleTerrainRadius,
  terrainTileCount,
} from '../../src/lib/terrainSample'

const PLANET: TerrainPlanet = {
  id: 'p1',
  name: 'EarthLike',
  generator: 'EarthLike',
  center: { x: 0, y: 0, z: 0 },
  radius_min_m: 59_400,
  radius_max_m: 67_200,
  sea_level_m: 60_000,
  faces: ['front', 'back', 'left', 'right', 'up', 'down'],
  res: 2048,
  available: true,
  reason: null,
}

/** 5x5 checkerboard: the coarse triangle edge cuts straight through it. */
function checkerTile() {
  const n = 5
  const heights = new Uint16Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = (i + j) % 2 ? 65_535 : 0
  return { n, heights }
}

function radiusAtHeight(h: number): number {
  return PLANET.radius_min_m + (h / 65_535) * (PLANET.radius_max_m - PLANET.radius_min_m)
}

describe('terrainSample', () => {
  beforeEach(() => resetTerrainTiles())

  it('tapping the coarse mesh returns the sampled terrain radius (within 1 m)', () => {
    const { n, heights } = checkerTile()
    registerTerrainTile({
      planetId: PLANET.id,
      face: 'front',
      level: 0,
      tx: 0,
      ty: 0,
      n,
      heights,
      radiusMinM: PLANET.radius_min_m,
      radiusMaxM: PLANET.radius_max_m,
    })

    // Midpoint of one coarse quad diagonal: the GPU triangle interpolates the
    // two opposite corners only, while the heightgrid has four samples there.
    const s0 = -1
    const t0 = -1
    const s1 = -0.5
    const t1 = -0.5
    const d0 = directionFor('front', s0, t0)
    const d1 = directionFor('front', s1, t1)
    const h0 = heights[0]
    const h1 = heights[n + 1]
    const hit = {
      x: (d0.x * radiusAtHeight(h0) + d1.x * radiusAtHeight(h1)) / 2,
      y: (d0.y * radiusAtHeight(h0) + d1.y * radiusAtHeight(h1)) / 2,
      z: (d0.z * radiusAtHeight(h0) + d1.z * radiusAtHeight(h1)) / 2,
    }
    const hitRadius = Math.hypot(hit.x, hit.y, hit.z)

    const sample = sampleTerrainRadius(PLANET, hit)
    expect(sample).not.toBeNull()
    const resolved = resolveSurfacePoint(PLANET, hit)
    expect(resolved).not.toBeNull()
    const resolvedRadius = Math.hypot(resolved!.x, resolved!.y, resolved!.z)

    // the point is rebuilt at the heightgrid radius, not the mesh radius
    expect(Math.abs(resolvedRadius - sample!.radius)).toBeLessThan(1e-6)
    expect(Math.abs(sample!.radius - radiusAtHeight(0))).toBeGreaterThan(100)
    // ...and the raw coarse hit is visibly wrong, which is the bug being fixed
    expect(Math.abs(hitRadius - sample!.radius)).toBeGreaterThan(100)
  })

  it('uses the finest cached level that covers the direction', () => {
    const coarse = checkerTile()
    const fine = checkerTile()
    registerTerrainTile({
      planetId: PLANET.id,
      face: 'front',
      level: 0,
      tx: 0,
      ty: 0,
      ...coarse,
      radiusMinM: PLANET.radius_min_m,
      radiusMaxM: PLANET.radius_max_m,
    })
    registerTerrainTile({
      planetId: PLANET.id,
      face: 'front',
      level: 1,
      tx: 1,
      ty: 1,
      ...fine,
      radiusMinM: PLANET.radius_min_m,
      radiusMaxM: PLANET.radius_max_m,
    })
    expect(terrainTileCount(PLANET.id)).toBe(2)
    // direction inside both the level-0 tile and the level-1 tile (1,1)
    const dir = directionFor('front', 0.4, 0.4)
    const point = { x: dir.x * 60_000, y: dir.y * 60_000, z: dir.z * 60_000 }
    expect(sampleTerrainRadius(PLANET, point)!.level).toBe(1)
    resetTerrainTiles(PLANET.id)
    expect(sampleTerrainRadius(PLANET, point)).toBeNull()
  })

  it('bounds the highest drawn radius in a cell window (not just at its centre)', () => {
    // One 3x3 tile: flat valley, with a single spike at the far corner node.
    const n = 5
    const heights = new Uint16Array(n * n)
    const spikeGx = 3
    const spikeGy = 3
    heights[spikeGy * n + spikeGx] = 65_535
    registerTerrainTile({
      planetId: PLANET.id,
      face: 'front',
      level: 0,
      tx: 0,
      ty: 0,
      n,
      heights,
      radiusMinM: PLANET.radius_min_m,
      radiusMaxM: PLANET.radius_max_m,
    })
    const sampler = createTerrainRadiusSampler(PLANET.id)
    expect(sampler).not.toBeNull()

    // Node (3,3) sits near face s = -0.5, t = -0.5 (front face, mirrored).
    const nodeDir = directionFor('front', (spikeGx / (n - 1)) * 2 - 1, (spikeGy / (n - 1)) * 2 - 1)
    // A cell centred ~2 deg away in latitude: the spike is inside the window
    // but NOT one of the sampled directions.
    const cellCentre = directionFor('front', (2 / (n - 1)) * 2 - 1, (2 / (n - 1)) * 2 - 1)
    const centreRadius = sampler!.radiusOf(cellCentre)
    const maxRadius = sampler!.maxRadiusNear(cellCentre, (3 * Math.PI) / 180)

    expect(maxRadius).not.toBeNull()
    expect(centreRadius).not.toBeNull()
    expect(maxRadius!).toBeGreaterThan(centreRadius!)
    // the bound is exactly the spike's radius, so an overlay there sits above it
    expect(maxRadius!).toBeCloseTo(radiusAtHeight(65_535), 6)
    // and the spike direction really is the peak the window was looking for
    expect(sampler!.radiusOf(nodeDir)).toBeCloseTo(radiusAtHeight(65_535), 6)
  })
})
