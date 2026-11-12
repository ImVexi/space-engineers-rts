import { describe, expect, it } from 'vitest'
import {
  blockLocalCentre,
  decodeSegb,
  encodeSegb,
  gridWorldCentre,
  rotateByQuat,
  SegbError,
  SEGB_RECORD_BYTES,
} from '../../src/lib/segB'

const BLOCKS = [
  { x: 0, y: 0, z: 0, subtype: 0, r: 120, g: 130, b: 140, orient: 0 },
  { x: -3, y: 7, z: 11, subtype: 401, r: 255, g: 0, b: 64, orient: 23 },
  { x: 1234, y: -5678, z: 42, subtype: 7, r: 1, g: 2, b: 3, orient: 5 },
]

describe('SEGB decoder', () => {
  it('round-trips header and every record field', () => {
    const buf = encodeSegb(2.5, BLOCKS)
    expect(buf.byteLength).toBe(16 + BLOCKS.length * SEGB_RECORD_BYTES)
    const a = decodeSegb(buf)
    expect(a.version).toBe(1)
    expect(a.count).toBe(3)
    expect(a.gridSizeM).toBeCloseTo(2.5, 6)
    expect(Array.from(a.min)).toEqual([0, 0, 0, -3, 7, 11, 1234, -5678, 42])
    expect(Array.from(a.subtype)).toEqual([0, 401, 7])
    expect(Array.from(a.color)).toEqual([120, 130, 140, 255, 0, 64, 1, 2, 3])
    expect(Array.from(a.orient)).toEqual([0, 23, 5])
  })

  it('decodes the empty asset and small-grid sizes', () => {
    const a = decodeSegb(encodeSegb(0.5, []))
    expect(a.count).toBe(0)
    expect(a.gridSizeM).toBeCloseTo(0.5, 6)
    expect(a.min.length).toBe(0)
  })

  it('accepts a typed-array view with an offset', () => {
    const src = new Uint8Array(encodeSegb(2.5, BLOCKS))
    const padded = new Uint8Array(src.length + 8)
    padded.set(src, 8)
    const view = new Uint8Array(padded.buffer, 8, src.length)
    expect(decodeSegb(view).count).toBe(3)
  })

  it('rejects short, mis-magicked, wrong-version and truncated buffers', () => {
    expect(() => decodeSegb(new ArrayBuffer(8))).toThrow(SegbError)

    const badMagic = new Uint8Array(encodeSegb(2.5, BLOCKS))
    badMagic[0] = 0x58
    expect(() => decodeSegb(badMagic)).toThrow(/magic/)

    const badVersion = new Uint8Array(encodeSegb(2.5, BLOCKS))
    new DataView(badVersion.buffer).setUint32(4, 9, true)
    expect(() => decodeSegb(badVersion)).toThrow(/version/)

    const truncated = encodeSegb(2.5, BLOCKS).slice(0, 16 + 12 * 2)
    expect(() => decodeSegb(new Uint8Array(truncated))).toThrow(/length/)

    const badSize = new Uint8Array(encodeSegb(2.5, BLOCKS))
    new DataView(badSize.buffer).setFloat32(12, 0, true)
    expect(() => decodeSegb(badSize)).toThrow(/grid_size_m/)
  })
})

describe('block placement math', () => {
  it('places block centres at (Min + 0.5) * gridSize in km', () => {
    const c0 = blockLocalCentre(0, 0, 0, 2.5)
    expect(c0.x).toBeCloseTo(0.00125, 12)
    expect(c0.y).toBeCloseTo(0.00125, 12)
    expect(c0.z).toBeCloseTo(0.00125, 12)
    const c = blockLocalCentre(-3, 7, 11, 0.5)
    expect(c.x).toBeCloseTo(-0.00125, 9)
    expect(c.y).toBeCloseTo(0.00375, 9)
    expect(c.z).toBeCloseTo(0.00575, 9)
  })

  it('rotates vectors by the save quaternion without handedness flips', () => {
    const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } // +90° about Y
    const r = rotateByQuat({ x: 0, y: 0, z: 1 }, q)
    expect(r.x).toBeCloseTo(1, 6)
    expect(r.y).toBeCloseTo(0, 6)
    expect(r.z).toBeCloseTo(0, 6)
    // Forward/Up contract: R(q)·(0,1,0) = +Up
    expect(rotateByQuat({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 })).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('adds grid position after rotation (gridPos + R(q)·local)', () => {
    const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    const w = gridWorldCentre({ x: 100000, y: 50000, z: -200000 }, q, { x: 2, y: 0, z: 0 }, 2.5)
    // local = (6.25, 1.25, 1.25) m rotated by 90°Y -> (1.25, 1.25, -6.25)
    expect(w.x).toBeCloseTo(100001.25, 6)
    expect(w.y).toBeCloseTo(50001.25, 6)
    expect(w.z).toBeCloseTo(-200006.25, 6)
  })
})
