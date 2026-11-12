import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  MACHINE_CORE_SHAPE,
  SHAPE_CLASSES,
  SHAPE_DEFAULT_SIZE,
  isTransparentShape,
  machineCoreGeometry,
  shapeBounds,
  shapeGeometry,
} from '../../src/lib/shapes'

describe('shape geometries', () => {
  it('builds one geometry for every shape class', () => {
    expect(SHAPE_CLASSES).toHaveLength(17)
    for (const shape of SHAPE_CLASSES) {
      const g = shapeGeometry(shape)
      const pos = g.getAttribute('position')
      expect(pos, shape).toBeTruthy()
      expect(pos.count, shape).toBeGreaterThan(0)
      const drawn = g.index ? g.index.count : pos.count
      expect(drawn % 3, shape).toBe(0)
      expect(Number.isFinite(g.boundingSphere?.radius ?? NaN), shape).toBe(true)
    }
  })

  it('keeps every shape inside its unit-cell footprint', () => {
    for (const shape of SHAPE_CLASSES) {
      const size = SHAPE_DEFAULT_SIZE[shape]
      const b = shapeBounds(shape)
      for (let axis = 0; axis < 3; axis++) {
        expect(b.min[axis]).toBeGreaterThanOrEqual(-size[axis] / 2 - 1e-6)
        expect(b.max[axis]).toBeLessThanOrEqual(size[axis] / 2 + 1e-6)
        expect(b.max[axis] - b.min[axis]).toBeGreaterThan(0)
      }
    }
  })

  it('caches geometries and reserves the multi-cell footprint', () => {
    expect(shapeGeometry('cube')).toBe(shapeGeometry('cube'))
    expect(SHAPE_DEFAULT_SIZE.slope2base).toEqual([2, 1, 1])
    expect(SHAPE_DEFAULT_SIZE.corner2base).toEqual([2, 1, 2])
    const b = shapeBounds('slope2base')
    expect(b.max[0] - b.min[0]).toBeCloseTo(2, 6)
    // slopes are asymmetric in Y: a wedge does not fill the cell top
    const slope = shapeBounds('slope')
    expect(slope.min[1]).toBeCloseTo(-0.5, 6)
    expect(slope.max[1]).toBeCloseTo(0.5, 6)
  })

  it('machine cores are smaller boxes inside the shell', () => {
    const core = machineCoreGeometry()
    const b = core.boundingBox as THREE.Box3
    expect(b.max.x - b.min.x).toBeLessThan(1)
    expect(MACHINE_CORE_SHAPE).toBe('machine-core')
    expect(isTransparentShape('window')).toBe(true)
    expect(isTransparentShape('cube')).toBe(false)
  })
})
