import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { decodeSegb, encodeSegb } from '../../src/lib/segB'
import {
  blockMeta,
  blockWorldCentre,
  buildShapeGroups,
  pickBlock,
  type ShapeGroup,
} from '../../src/lib/shapesInstances'
import { resolveSubtypeTable } from '../../src/lib/subtypeInfo'
import { orientationQuaternion } from '../../src/lib/orient'
import type { SubtypeInfo, WorldGrid } from '../../src/lib/worldMapTypes'

const table: SubtypeInfo[] = resolveSubtypeTable([
  'LargeBlockArmorBlock',
  'LargeBlockArmorSlope2Base',
  'LargeBlockArmorWindow',
], [
  {
    name: 'LargeBlockArmorBlock',
    display: 'Armour Block',
    type: 'CubeBlock',
    category: 'armor',
    shape: 'cube',
    size: [1, 1, 1],
    center: null,
  },
  {
    name: 'LargeBlockArmorSlope2Base',
    display: 'Armour Slope 2 Base',
    type: 'CubeBlock',
    category: 'armor',
    shape: 'slope2base',
    size: [2, 1, 1],
    center: null,
  },
  {
    name: 'LargeBlockArmorWindow',
    display: 'Armour Window',
    type: 'Window',
    category: 'window',
    shape: 'window',
    size: [1, 1, 1],
    center: null,
  },
])

const asset = decodeSegb(
  encodeSegb(2.5, [
    { x: 0, y: 0, z: 0, subtype: 0, r: 200, g: 10, b: 10, orient: 0 },
    { x: 10, y: 0, z: 0, subtype: 1, r: 10, g: 200, b: 10, orient: 9 },
    { x: 20, y: 0, z: 0, subtype: 2, r: 10, g: 10, b: 200, orient: 0 },
  ]),
)

describe('shape grouping and placement', () => {
  it('creates one group per shape class present', () => {
    const groups = buildShapeGroups(asset, table)
    expect(groups.map((g) => g.shape)).toEqual(['cube', 'slope2base', 'window'])
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(asset.count)
  })

  it('positions multi-cell blocks by Min + size/2 and scales by cell size', () => {
    const groups = buildShapeGroups(asset, table)
    const slope = groups.find((g) => g.shape === 'slope2base') as ShapeGroup
    expect(slope.count).toBe(1)
    const m = new THREE.Matrix4().fromArray(Array.from(slope.matrices))
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    m.decompose(pos, quat, scale)
    const cell = 2.5 / 1000
    // Min=(10,0,0), size=(2,1,1) -> centre cell (11, 0.5, 0.5)
    expect(pos.x).toBeCloseTo(11 * cell, 9)
    expect(pos.y).toBeCloseTo(0.5 * cell, 9)
    expect(pos.z).toBeCloseTo(0.5 * cell, 9)
    expect(scale.x).toBeCloseTo(cell, 9)
    expect(scale.y).toBeCloseTo(cell, 9)
  })

  it('applies the orient table to instances', () => {
    const groups = buildShapeGroups(asset, table)
    const slope = groups.find((g) => g.shape === 'slope2base') as ShapeGroup
    const m = new THREE.Matrix4().fromArray(Array.from(slope.matrices))
    const quat = new THREE.Quaternion()
    m.decompose(new THREE.Vector3(), quat, new THREE.Vector3())
    const expected = orientationQuaternion(9)
    const dot = Math.abs(
      quat.x * expected.x + quat.y * expected.y + quat.z * expected.z + quat.w * expected.w,
    )
    expect(dot).toBeCloseTo(1, 6)
  })

  it('switches paint colours for category colours', () => {
    const paint = buildShapeGroups(asset, table, false).find((g) => g.shape === 'cube') as ShapeGroup
    const fn = buildShapeGroups(asset, table, true).find((g) => g.shape === 'cube') as ShapeGroup
    expect([...paint.colors.slice(0, 3)]).not.toEqual([...fn.colors.slice(0, 3)])
    expect(paint.colors[0]).toBeCloseTo(200 / 255, 4)
  })
})

describe('raycast instance id -> block record', () => {
  it('picks the correct asset index and metadata', () => {
    const groups = buildShapeGroups(asset, table)
    const cube = groups.find((g) => g.shape === 'cube') as ShapeGroup
    // Two cubes so instanceId is meaningful: build a synthetic group of two
    const two: ShapeGroup = {
      ...cube,
      count: 2,
      indices: Int32Array.from([0, 2]),
      matrices: new Float32Array(32),
    }
    const cell = 2.5 / 1000
    const place = (slot: number, x: number) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0.5 * cell, 0.5 * cell),
        new THREE.Quaternion(),
        new THREE.Vector3(cell, cell, cell),
      )
      m.toArray(two.matrices, slot * 16)
    }
    place(0, 0.5 * cell)
    place(1, 20.5 * cell)

    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2)
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(two.matrices, 16)
    mesh.count = 2
    mesh.updateMatrixWorld(true)

    const raycaster = new THREE.Raycaster(new THREE.Vector3(20.5 * cell, 5, 0.5 * cell), new THREE.Vector3(0, -1, 0))
    const hits = raycaster.intersectObject(mesh)
    expect(hits.length).toBeGreaterThan(0)
    const id = hits[0].instanceId
    expect(id).toBe(1)
    const blockIndex = pickBlock(two, id)
    expect(blockIndex).toBe(2)
    const meta = blockMeta(asset, table, blockIndex as number)
    expect(meta.shape).toBe('window')
    expect(meta.display).toBe('Armour Window')
    expect(pickBlock(two, 99)).toBeNull()
  })
})

describe('block world centres', () => {
  it('rotates grid-local centres into world metres', () => {
    const grid: WorldGrid = {
      id: 'g',
      name: 'g',
      size_class: 'Large',
      grid_size_m: 2.5,
      pos: { x: 1000, y: 0, z: -500 },
      quat: { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, // 90° yaw
      bbox_local: { min: [0, 0, 0], max: [2.5, 2.5, 2.5] },
      block_count: 1,
      asset: '/x',
      subtypes: ['LargeBlockArmorBlock'],
    }
    const world = blockWorldCentre(grid, { x: 0, y: 0, z: 0 }, [1, 1, 1])
    // local (1.25,1.25,1.25) yawed +90° -> (1.25, 1.25, -1.25)
    expect(world.x).toBeCloseTo(1001.25, 5)
    expect(world.y).toBeCloseTo(1.25, 5)
    expect(world.z).toBeCloseTo(-501.25, 5)
  })
})
