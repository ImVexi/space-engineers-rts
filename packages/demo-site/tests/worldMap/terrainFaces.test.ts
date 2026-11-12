import { describe, expect, it } from 'vitest'
import {
  FACE_BASIS,
  TERRAIN_FACES,
  directionFor,
  faceUvFromDirection,
  terrainColor,
  tileDirection,
} from '../../src/lib/terrainFaces'

describe('cubesphere face mapping', () => {
  it('defines the six contract faces with orthogonal bases', () => {
    expect(TERRAIN_FACES).toEqual(['front', 'back', 'left', 'right', 'up', 'down'])
    for (const face of TERRAIN_FACES) {
      const b = FACE_BASIS[face]
      const dot = (a: typeof b.u, c: typeof b.u) => a.x * c.x + a.y * c.y + a.z * c.z
      expect(dot(b.normal, b.u)).toBeCloseTo(0, 9)
      expect(dot(b.normal, b.v)).toBeCloseTo(0, 9)
      expect(dot(b.u, b.v)).toBeCloseTo(0, 9)
      // backend convention: u × v = -normal (left-handed pixel grid)
      const cross = {
        x: b.u.y * b.v.z - b.u.z * b.v.y,
        y: b.u.z * b.v.x - b.u.x * b.v.z,
        z: b.u.x * b.v.y - b.u.y * b.v.x,
      }
      expect(cross.x).toBeCloseTo(-b.normal.x, 9)
      expect(cross.y).toBeCloseTo(-b.normal.y, 9)
      expect(cross.z).toBeCloseTo(-b.normal.z, 9)
    }
    // SE axes: front is -Z, right is +X, up is +Y
    expect(FACE_BASIS.front.normal).toEqual({ x: 0, y: 0, z: -1 })
    expect(FACE_BASIS.front.u.x).toBe(1)
    expect(FACE_BASIS.right.normal).toEqual({ x: 1, y: 0, z: 0 })
    expect(FACE_BASIS.right.u.z).toBe(1)
    expect(FACE_BASIS.up.normal).toEqual({ x: 0, y: 1, z: 0 })
    expect(FACE_BASIS.up.v.z).toBe(1)
  })

  it('round-trips direction -> face/uv -> direction', () => {
    const samples = [
      [0.1, 0.2],
      [-0.9, 0.4],
      [0.5, -0.5],
      [0.999, 0.001],
      [-0.3, -0.8],
    ]
    for (const face of TERRAIN_FACES) {
      for (const [s, t] of samples) {
        const dir = directionFor(face, s, t)
        expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 9)
        const back = faceUvFromDirection(dir)
        expect(back.face).toBe(face)
        expect(back.s).toBeCloseTo(s, 6)
        expect(back.t).toBeCloseTo(t, 6)
      }
    }
  })

  it('round-trips tile centres and normalises corners', () => {
    for (const face of TERRAIN_FACES) {
      const dir = tileDirection(face, 3, 5, 2)
      const back = faceUvFromDirection(dir)
      expect(back.face).toBe(face)
      expect(back.s).toBeCloseTo(((5 + 0.5) / 8) * 2 - 1, 6)
      expect(back.t).toBeCloseTo(((2 + 0.5) / 8) * 2 - 1, 6)
    }
  })

  it('matches the backend mapping including PLANET_LOCAL_MIRROR', () => {
    // Hard-coded from backend/app/terrain.py (direction_to_face_uv /
    // face_uv_to_direction) — one-off python call, mirrored table included.
    const dirs: Array<[number, number, number, string, number, number]> = [
      [1, 0, 0, 'left', 0, 0],
      [-1, 0, 0, 'right', 0, 0],
      [0.303045763366, 0.808122035642, 0.505076272276, 'up', -0.375, 0.625],
      [-0.199007438042, -0.895533471189, 0.398014876084, 'down', -0.222222222222, 0.444444444444],
      [0.100458129113, 0.200916258226, -0.974443852398, 'front', -0.103092783505, 0.20618556701],
      [0.639602149067, -0.426401432711, -0.639602149067, 'left', 1, -0.666666666667],
      [0, -1, 0, 'down', 0, 0],
    ]
    for (const [x, y, z, face, s, t] of dirs) {
      const out = faceUvFromDirection({ x, y, z })
      expect(out.face).toBe(face)
      expect(out.s).toBeCloseTo(s, 6)
      expect(out.t).toBeCloseTo(t, 6)
    }
    const uvs: Array<[string, number, number, [number, number, number]]> = [
      ['front', 0.25, -0.5, [-0.218217890236, -0.436435780472, -0.872871560944]],
      ['up', -0.75, 0.4, [0.57145448832, 0.761939317759, 0.304775727104]],
      ['left', 0.1, 0.9, [0.741249316661, 0.667124384995, -0.074124931666]],
      ['down', 0.5, 0.5, [0.408248290464, -0.816496580928, 0.408248290464]],
    ]
    for (const [face, u, v, expected] of uvs) {
      const dir = directionFor(face as never, u, v)
      expect(dir.x).toBeCloseTo(expected[0], 7)
      expect(dir.y).toBeCloseTo(expected[1], 7)
      expect(dir.z).toBeCloseTo(expected[2], 7)
    }
  })

  it('colours sea below sea level and land above it', () => {
    const sea = terrainColor('EarthLike', 'EarthLike', 0.1, 0, 0.3)
    const land = terrainColor('EarthLike', 'EarthLike', 0.6, 0, 0.3)
    expect(sea[2]).toBeGreaterThan(sea[0]) // water is blue-dominant
    expect(land[1]).toBeGreaterThan(sea[1])
    // biome class overrides the height band but stays in gamut
    const biome = terrainColor('Mars', 'Mars', 0.7, 3, null)
    for (const c of biome) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThanOrEqual(1)
  })
})
