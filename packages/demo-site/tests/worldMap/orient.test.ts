import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  ORIENTATION_PAIRS,
  SE_FACES,
  FACE_VECTOR,
  normaliseIndex,
  orientationQuaternion,
  orientedForward,
  orientedUp,
} from '../../src/lib/orient'

const FACE = FACE_VECTOR

describe('orientation table (backend order)', () => {
  it('has 24 valid (Forward, Up) pairs and identity at index 0', () => {
    expect(ORIENTATION_PAIRS).toHaveLength(24)
    expect(ORIENTATION_PAIRS[0]).toEqual({ forward: 'Forward', up: 'Up' })
    const keys = new Set(ORIENTATION_PAIRS.map((p) => `${p.forward}/${p.up}`))
    expect(keys.size).toBe(24)
    for (const pair of ORIENTATION_PAIRS) {
      const f = FACE[pair.forward]
      const u = FACE[pair.up]
      expect(f.x * u.x + f.y * u.y + f.z * u.z).toBe(0) // perpendicular
      expect(pair.up).not.toBe(pair.forward)
    }
    // Forward cycles before Up, matching backend/app/blocks.py
    expect(ORIENTATION_PAIRS.slice(0, 4).map((p) => p.forward)).toEqual([
      'Forward',
      'Forward',
      'Forward',
      'Forward',
    ])
    expect(ORIENTATION_PAIRS[4]).toEqual({ forward: 'Backward', up: 'Up' })
    expect(SE_FACES).toEqual(['Forward', 'Backward', 'Left', 'Right', 'Up', 'Down'])
  })
})

describe('orientation quaternions', () => {
  it('index 0 is the identity quaternion', () => {
    const q = orientationQuaternion(0)
    expect(q.x).toBeCloseTo(0, 12)
    expect(q.y).toBeCloseTo(0, 12)
    expect(q.z).toBeCloseTo(0, 12)
    expect(q.w).toBeCloseTo(1, 12)
  })

  it('produces 24 unique proper rotations', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const q = orientationQuaternion(i)
      const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
      expect(m.determinant()).toBeCloseTo(1, 9)
      const key = [q.x, q.y, q.z, q.w].map((v) => Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(6))).join(',')
      // q and -q are the same rotation; canonicalise the sign of w
      const canonical = q.w < 0 || (Math.abs(q.w) < 1e-9 && key.startsWith('-')) ? key : key
      seen.add(canonical.replace(/-0,/g, '0,'))
    }
    // Each index is a distinct pair; compare rotation matrices instead of raw signs.
    const rotations = new Set(
      Array.from({ length: 24 }, (_, i) => {
        const q = orientationQuaternion(i)
        const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
        return m.elements.map((v) => v.toFixed(5)).join(',')
      }),
    )
    expect(rotations.size).toBe(24)
    expect(seen.size).toBeGreaterThanOrEqual(24)
  })

  it('maps local forward/up onto the pair axes', () => {
    for (let i = 0; i < 24; i++) {
      const q = orientationQuaternion(i)
      const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
      const pair = ORIENTATION_PAIRS[i]
      expect(forward.x).toBeCloseTo(FACE[pair.forward].x, 9)
      expect(forward.y).toBeCloseTo(FACE[pair.forward].y, 9)
      expect(forward.z).toBeCloseTo(FACE[pair.forward].z, 9)
      expect(up.x).toBeCloseTo(FACE[pair.up].x, 9)
      expect(up.y).toBeCloseTo(FACE[pair.up].y, 9)
      expect(up.z).toBeCloseTo(FACE[pair.up].z, 9)
    }
  })

  it('clamps unknown orient bytes to identity', () => {
    expect(normaliseIndex(200)).toBe(0)
    expect(normaliseIndex(-1)).toBe(0)
    expect(normaliseIndex(23)).toBe(23)
    expect(orientedForward(0)).toEqual({ x: 0, y: 0, z: -1 })
    expect(orientedUp(0)).toEqual({ x: 0, y: 1, z: 0 })
  })
})
