import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SETR_HEADER_BYTES, SetrError, decodeSetr, encodeSetr } from '../../src/lib/setr'
import { buildTerrainGeometry } from '../../src/lib/tileMesh'
import type { TerrainPlanet } from '../../src/lib/worldMapTypes'

const planet: TerrainPlanet = {
  id: 'p1',
  name: 'EarthLike',
  generator: 'EarthLike',
  center: { x: 0, y: 0, z: 0 },
  radius_min_m: 59_000,
  radius_max_m: 61_000,
  sea_level_m: 60_100,
  faces: ['front', 'back', 'left', 'right', 'up', 'down'],
  res: 5,
  available: true,
  reason: null,
}

function sampleTile(n: number) {
  const heights = new Uint16Array(n * n)
  const materials = new Uint8Array(n * n)
  for (let i = 0; i < n * n; i++) {
    heights[i] = (i * 4096) % 65536
    materials[i] = i % 4
  }
  return { heights, materials }
}

describe('SETR codec', () => {
  it('round-trips heights and materials', () => {
    const n = 5
    const { heights, materials } = sampleTile(n)
    const buf = encodeSetr(n, heights, materials)
    expect(buf.byteLength).toBe(SETR_HEADER_BYTES + n * n * 3)
    const tile = decodeSetr(buf)
    expect(tile.n).toBe(n)
    expect(tile.version).toBe(1)
    expect(Array.from(tile.heights)).toEqual(Array.from(heights))
    expect(Array.from(tile.materials)).toEqual(Array.from(materials))
  })

  it('rejects malformed input like the SEGB decoder does', () => {
    expect(() => decodeSetr(new ArrayBuffer(4))).toThrow(SetrError)
    const good = encodeSetr(3, new Uint16Array(9))
    const badMagic = new Uint8Array(good.slice(0))
    badMagic[0] = 0x58
    expect(() => decodeSetr(badMagic)).toThrow(/magic/)
    const short = new Uint8Array(good).slice(0, good.byteLength - 1)
    expect(() => decodeSetr(short)).toThrow(/length/)
  })
})

describe('terrain tile geometry', () => {
  it('maps heights into the radius band and adds skirt vertices', () => {
    const n = 5
    const { heights, materials } = sampleTile(n)
    const tile = decodeSetr(encodeSetr(n, heights, materials))
    const g = buildTerrainGeometry({ planet, face: 'up', level: 1, tx: 0, ty: 0, tile })
    const positions = g.getAttribute('position')
    expect(positions.count).toBe(n * n + 4 * (n - 1))
    expect(g.userData.skirt).toBe(true)
    expect(g.userData.skirtVertices).toBe(4 * (n - 1))
    // every vertex lies within the radius band (km), including the skirt
    for (let i = 0; i < positions.count; i++) {
      const r = Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i))
      expect(r).toBeGreaterThanOrEqual(59 - 4.1)
      expect(r).toBeLessThanOrEqual(61 + 1e-3)
    }
    expect(g.getAttribute('color')).toBeTruthy()
    expect(g.index?.count).toBe((n - 1) * (n - 1) * 6 + 4 * (n - 1) * 6)
  })

  it('winds surface and skirt triangles outward after the planet mirror', () => {
    const n = 5
    const tile = decodeSetr(encodeSetr(n, new Uint16Array(n * n).fill(30_000)))
    const g = buildTerrainGeometry({ planet, face: 'front', level: 0, tx: 0, ty: 0, tile })
    const p = g.getAttribute('position')
    const idx = g.index as THREE.BufferAttribute
    // Surface triangles face radially outward; skirt walls face away from the
    // tile centre in the tangent plane (their normal is radial-perpendicular).
    const radius = 60
    const centre = new THREE.Vector3(0, 0, -radius)
    let surface = 0
    let skirt = 0
    for (let t = 0; t < idx.count; t += 3) {
      const ia = idx.getX(t)
      const ax = p.getX(ia)
      const ay = p.getY(ia)
      const az = p.getZ(ia)
      const bx = p.getX(idx.getX(t + 1)) - ax
      const by = p.getY(idx.getX(t + 1)) - ay
      const bz = p.getZ(idx.getX(t + 1)) - az
      const cx = p.getX(idx.getX(t + 2)) - ax
      const cy = p.getY(idx.getX(t + 2)) - ay
      const cz = p.getZ(idx.getX(t + 2)) - az
      const nx = by * cz - bz * cy
      const ny = bz * cx - bx * cz
      const nz = bx * cy - by * cx
      const radial = nx * ax + ny * ay + nz * az
      const away = nx * (ax - centre.x) + ny * (ay - centre.y) + nz * (az - centre.z)
      if (Math.abs(radial) > Math.abs(away) * 1e-6) {
        if (radial > 0) surface++
      } else if (away > 0) {
        skirt++
      }
    }
    expect(surface).toBe(32)
    expect(skirt).toBe(32)
  })

  it('places tile vertices on the face and shares edges between neighbours', () => {
    const n = 5
    // neighbouring SETR tiles agree on the shared edge, so use a flat tile
    const heights = new Uint16Array(n * n).fill(30_000)
    const tile = decodeSetr(encodeSetr(n, heights))
    const a = buildTerrainGeometry({ planet, face: 'front', level: 1, tx: 0, ty: 0, tile })
    const b = buildTerrainGeometry({ planet, face: 'front', level: 1, tx: 1, ty: 0, tile })
    const ap = a.getAttribute('position')
    const bp = b.getAttribute('position')
    // right edge of tile (0,0) and left edge of tile (1,0) must coincide
    for (let j = 0; j < n; j++) {
      const ai = j * n + (n - 1)
      const bi = j * n
      expect(ap.getX(ai)).toBeCloseTo(bp.getX(bi), 6)
      expect(ap.getY(ai)).toBeCloseTo(bp.getY(bi), 6)
      expect(ap.getZ(ai)).toBeCloseTo(bp.getZ(bi), 6)
    }
  })
})
