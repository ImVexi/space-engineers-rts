import { describe, expect, it } from 'vitest'
import type { TerrainPlanet } from '../../src/lib/worldMapTypes'
import { TERRAIN_LOD, planTerrain, parseTileKey, tileKey } from '../../src/lib/quadtree'
import { classifyLod } from '../../src/lib/lod'

const planet: TerrainPlanet = {
  id: 'p1',
  name: 'EarthLike',
  generator: 'EarthLike',
  center: { x: 0, y: 0, z: 0 },
  radius_min_m: 60_000,
  radius_max_m: 60_000,
  sea_level_m: null,
  faces: ['up'],
  res: 65,
  available: true,
  reason: null,
}

const opts = { splitFactor: 2.4, mergeFactor: 3.4, maxLevel: 2, maxTiles: 100 }

describe('terrain quadtree', () => {
  it('splits the face while the camera is close', () => {
    // 10 km above the up-face centre (0,60,0) km: level 0 (120 km) and
    // level 1 (60 km) tiles both split, level 2 is capped by opts.maxLevel.
    const plan = planTerrain(planet, { x: 0, y: 70, z: 0 }, new Set(), new Set(), opts)
    expect(plan.maxLevelReached).toBe(2)
    expect(plan.leaves.every((l) => l.level === 2)).toBe(true)
    expect(plan.leaves).toHaveLength(16)
    expect(plan.expanded).toContain(tileKey('up', 0, 0, 0))
  })

  it('keeps an expanded node inside the merge dead band (hysteresis)', () => {
    // 200 km from the surface: level 0 splits (200 < 288), level 1 does not
    const warm = planTerrain(planet, { x: 0, y: 260, z: 0 }, new Set(), new Set(), opts)
    // Move to 400 km: below neither the split (288) nor the merge (408) limit.
    const kept = planTerrain(
      planet,
      { x: 0, y: 460, z: 0 },
      new Set(warm.leaves.map((l) => l.key)),
      new Set(warm.expanded),
      opts,
    )
    const cold = planTerrain(planet, { x: 0, y: 460, z: 0 }, new Set(), new Set(), opts)
    expect(kept.leaves.some((l) => l.level > 0)).toBe(true)
    expect(kept.expanded).toContain(tileKey('up', 0, 0, 0))
    // cold start at the same distance stays at the root tile
    expect(cold.leaves).toHaveLength(1)
    expect(cold.leaves[0].level).toBe(0)
  })

  it('merges once the camera passes the merge threshold', () => {
    const warm = planTerrain(planet, { x: 0, y: 260, z: 0 }, new Set(), new Set(), opts)
    const far = planTerrain(
      planet,
      { x: 0, y: 700, z: 0 },
      new Set(warm.leaves.map((l) => l.key)),
      new Set(warm.expanded),
      opts,
    )
    expect(far.leaves).toHaveLength(1)
    expect(far.leaves[0].level).toBe(0)
  })

  it('respects the memory cap and always keeps every face', () => {
    const multi: TerrainPlanet = {
      ...planet,
      faces: ['front', 'back', 'left', 'right', 'up', 'down'],
    }
    const plan = planTerrain(multi, { x: 0, y: 60.5, z: 0 }, new Set(), new Set(), {
      ...opts,
      maxLevel: 5,
      maxTiles: 12,
    })
    expect(plan.leaves.length).toBeLessThanOrEqual(12)
    expect(new Set(plan.leaves.map((l) => l.face)).size).toBe(6)
  })

  it('exposes the contract concurrency cap and parses tile keys', () => {
    expect(TERRAIN_LOD.maxConcurrent).toBe(6)
    const key = tileKey('front', 3, 5, 2)
    expect(parseTileKey(key)).toEqual({ face: 'front', level: 3, tx: 5, ty: 2 })
    expect(parseTileKey('nope')).toBeNull()
  })
})

describe('block LOD boundary (8 km / 12 km)', () => {
  it('promotes at 8 km and keeps near until 12 km', () => {
    expect(classifyLod(7.99, 'far')).toBe('near')
    expect(classifyLod(8.0, 'far')).toBe('near')
    expect(classifyLod(8.01, 'far')).toBe('mid')
    expect(classifyLod(11.99, 'near')).toBe('near')
    expect(classifyLod(12.0, 'near')).toBe('near')
    expect(classifyLod(12.01, 'near')).toBe('mid')
  })

  it('does not oscillate when the camera jitters on the boundary', () => {
    let level: 'far' | 'mid' | 'near' = 'far'
    const samples = [8.0, 8.4, 7.9, 8.2, 9.5, 11.9, 11.8]
    for (const d of samples) level = classifyLod(d, level)
    expect(level).toBe('near')
    expect(classifyLod(12.5, 'near')).toBe('mid')
    expect(classifyLod(11.9, 'mid')).toBe('mid')
  })
})
