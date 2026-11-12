import * as THREE from 'three'
import type { SegbAsset } from './segB'
import type { ShapeName, SubtypeInfo, Vec3, WorldGrid } from './worldMapTypes'
import { orientationThreeQuat } from './orient'
import { SHAPE_DEFAULT_SIZE, shapeGeometry, type ShapeClass } from './shapes'
import { CATEGORY_COLORS, isStructural, type BlockCategory } from './subtypeInfo'

/**
 * Instance building for the near LOD.
 *
 * Blocks are grouped per (grid, shape) so each shape class is exactly one
 * InstancedMesh per grid. Placement uses the documented assumption
 *
 *   centre_local_cells = Min + size / 2
 *   world              = gridPos + R(grid quat) · centre_local_cells · gridSize
 *
 * i.e. `Min` is the corner of the block's footprint and multi-cell blocks
 * extend `size` cells from it. Nothing world-space is baked into instance
 * matrices; they stay grid-local (km).
 */
export interface GridBlockMeta {
  display: string
  category: BlockCategory
  shape: ShapeClass
  size: [number, number, number]
  type: string
  /** paint colour from the SEGB record (0..1) */
  paint: [number, number, number]
}

export interface ShapeGroup {
  shape: ShapeName
  /** asset block indices, parallel to the instance slots */
  indices: Int32Array
  /** 16 floats per instance */
  matrices: Float32Array
  /** 3 floats per instance (paint or category colour) */
  colors: Float32Array
  count: number
  /** cell size in scene units (grid_size_m / 1000) */
  cell: number
}

export function blockMeta(asset: SegbAsset, table: SubtypeInfo[], i: number): GridBlockMeta {
  const info = table[asset.subtype[i]] ?? table[0]
  const shape = (info?.shape ?? 'cube') as ShapeClass
  const size: [number, number, number] = info?.size ?? [...SHAPE_DEFAULT_SIZE[shape]]
  return {
    display: info?.display ?? `Block ${i}`,
    category: (info?.category ?? 'other') as BlockCategory,
    shape,
    size,
    type: info?.type ?? '',
    paint: [asset.color[i * 3] / 255, asset.color[i * 3 + 1] / 255, asset.color[i * 3 + 2] / 255],
  }
}

function colorOf(meta: GridBlockMeta, byFunction: boolean): [number, number, number] {
  if (!byFunction) return meta.paint
  const c = new THREE.Color(CATEGORY_COLORS[meta.category] ?? CATEGORY_COLORS.other)
  return [c.r, c.g, c.b]
}

/** Build one ShapeGroup per shape present in the asset. */
export function buildShapeGroups(
  asset: SegbAsset,
  table: SubtypeInfo[],
  byFunction = false,
): ShapeGroup[] {
  const cell = asset.gridSizeM / 1000
  const buckets = new Map<ShapeName, number[]>()
  for (let i = 0; i < asset.count; i++) {
    const meta = blockMeta(asset, table, i)
    const arr = buckets.get(meta.shape) ?? []
    arr.push(i)
    buckets.set(meta.shape, arr)
  }

  const out: ShapeGroup[] = []
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const m = new THREE.Matrix4()

  for (const [shape, indices] of buckets) {
    const count = indices.length
    const matrices = new Float32Array(count * 16)
    const colors = new Float32Array(count * 3)
    const fallbackSize = SHAPE_DEFAULT_SIZE[shape] ?? [1, 1, 1]
    for (let slot = 0; slot < count; slot++) {
      const i = indices[slot]
      const meta = blockMeta(asset, table, i)
      const size = meta.size
      const minX = asset.min[i * 3]
      const minY = asset.min[i * 3 + 1]
      const minZ = asset.min[i * 3 + 2]
      p.set((minX + size[0] / 2) * cell, (minY + size[1] / 2) * cell, (minZ + size[2] / 2) * cell)
      s.set(
        cell * (size[0] / fallbackSize[0]),
        cell * (size[1] / fallbackSize[1]),
        cell * (size[2] / fallbackSize[2]),
      )
      orientationThreeQuat(asset.orient[i], q)
      m.compose(p, q, s)
      m.toArray(matrices, slot * 16)
      const [r, g, b] = colorOf(meta, byFunction)
      colors[slot * 3] = r
      colors[slot * 3 + 1] = g
      colors[slot * 3 + 2] = b
    }
    out.push({ shape, indices: Int32Array.from(indices), matrices, colors, count, cell })
  }
  out.sort((a, b) => a.shape.localeCompare(b.shape))
  return out
}

/** Which asset block a hit instance belongs to (raycast id -> record). */
export function pickBlock(group: ShapeGroup, instanceId: number | null | undefined): number | null {
  if (instanceId == null || instanceId < 0 || instanceId >= group.indices.length) return null
  return group.indices[instanceId]
}

/**
 * Line-segment positions for every instance's shape edges, in grid-local km.
 *
 * InstancedMesh cannot host LineSegments per instance, so the edge geometry is
 * flattened once: one EdgesGeometry of the unit shape, transformed by each
 * instance matrix. This is what gives a 40 px hull readable block boundaries
 * at close range; without it flat-lit cubes merge into one silhouette.
 */
export function buildEdgePositions(group: ShapeGroup, shape: ShapeClass): Float32Array {
  const base = shapeGeometry(shape)
  const edges = new THREE.EdgesGeometry(base, 28)
  const src = edges.getAttribute('position')
  const count = group.count
  const out = new Float32Array(count * src.count * 3)
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  let o = 0
  for (let i = 0; i < count; i++) {
    m.fromArray(group.matrices, i * 16)
    for (let j = 0; j < src.count; j++) {
      v.fromBufferAttribute(src as THREE.BufferAttribute, j).applyMatrix4(m)
      out[o++] = v.x
      out[o++] = v.y
      out[o++] = v.z
    }
  }
  edges.dispose()
  return out
}

/** World-space centre of a block, in metres, mirroring the backend maths. */
export function blockWorldCentre(grid: WorldGrid, min: Vec3, size: [number, number, number]): Vec3 {
  const gs = grid.grid_size_m
  const v = new THREE.Vector3(
    (min.x + size[0] / 2) * gs,
    (min.y + size[1] / 2) * gs,
    (min.z + size[2] / 2) * gs,
  )
  v.applyQuaternion(new THREE.Quaternion(grid.quat.x, grid.quat.y, grid.quat.z, grid.quat.w))
  return { x: grid.pos.x + v.x, y: grid.pos.y + v.y, z: grid.pos.z + v.z }
}

/**
 * Category colours for the legend. Structural categories are displayed with
 * their paint colours even in "colour by function" mode is NOT true: the
 * legend shows every category that can appear, so the toggle is predictable.
 */
export function legendEntries(): Array<{ category: BlockCategory; color: string }> {
  return (Object.keys(CATEGORY_COLORS) as BlockCategory[]).map((category) => ({
    category,
    color: CATEGORY_COLORS[category],
  }))
}

/** Functional blocks (machines) always get a category-coloured core. */
export function needsCore(meta: { shape: ShapeClass; category: BlockCategory }): boolean {
  return meta.shape === 'machine' && !isStructural(meta.category)
}
