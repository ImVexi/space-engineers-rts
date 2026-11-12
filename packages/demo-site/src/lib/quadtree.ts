import type { TerrainPlanet } from './worldMapTypes'
import { TERRAIN_FACES, directionFor, tileDirection, type TerrainFace } from './terrainFaces'

/**
 * Quadtree LOD over the six cubesphere faces, with hysteresis.
 *
 * A node splits while the camera is closer than `splitFactor × nodeSize` and
 * — once split — only merges again beyond `mergeFactor × nodeSize`,
 * `mergeFactor > splitFactor`. That dead band is what stops tiles from
 * flipping when the camera hovers exactly on a threshold.
 */
export interface TileKey {
  face: TerrainFace
  level: number
  tx: number
  ty: number
}

export interface TileNode extends TileKey {
  key: string
  /** world-space centre of the tile in scene km */
  x: number
  y: number
  z: number
  /** approximate edge length in km */
  sizeKm: number
  distanceKm: number
}

export interface TerrainPlan {
  leaves: TileNode[]
  /** internal nodes, fed back as `prevExpanded` to keep the dead band */
  expanded: string[]
  /** deepest level reached */
  maxLevelReached: number
}

export interface PlanOptions {
  splitFactor: number
  mergeFactor: number
  maxLevel: number
  /** hard limit on rendered leaves (memory cap) */
  maxTiles: number
}

export const TERRAIN_LOD = {
  splitFactor: 2.4,
  mergeFactor: 3.4,
  maxTiles: 220,
  /** fetch concurrency (owner review: six tiles in flight, not four) */
  maxConcurrent: 6,
}

export function tileKey(face: TerrainFace, level: number, tx: number, ty: number): string {
  return `${face}:${level}:${tx}:${ty}`
}

export function parseTileKey(key: string): TileKey | null {
  const m = /^(front|back|left|right|up|down):(\d+):(\d+):(\d+)$/.exec(key)
  if (!m) return null
  return { face: m[1] as TerrainFace, level: Number(m[2]), tx: Number(m[3]), ty: Number(m[4]) }
}

function dist(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(ax - bx, ay - by, az - bz)
}

/** Does any previously rendered leaf live under `key`? */
function hasDescendant(prevLeaves: Set<string>, key: string): boolean {
  const prefix = key + ':'
  for (const k of prevLeaves) if (k.startsWith(prefix)) return true
  return false
}

export function planTerrain(
  planet: TerrainPlanet,
  camera: { x: number; y: number; z: number },
  prevLeaves: Set<string>,
  prevExpanded: Set<string>,
  opts: Partial<PlanOptions> = {},
): TerrainPlan {
  const o: PlanOptions = {
    splitFactor: opts.splitFactor ?? TERRAIN_LOD.splitFactor,
    mergeFactor: opts.mergeFactor ?? TERRAIN_LOD.mergeFactor,
    maxLevel: opts.maxLevel ?? 5,
    maxTiles: opts.maxTiles ?? TERRAIN_LOD.maxTiles,
  }
  const radiusKm = (planet.radius_min_m + planet.radius_max_m) / 2000
  const cx = planet.center.x / 1000
  const cy = planet.center.y / 1000
  const cz = planet.center.z / 1000
  const rootSizeKm = radiusKm * 2

  const leaves: TileNode[] = []
  const expanded: string[] = []
  let maxLevelReached = 0

  const visit = (face: TerrainFace, level: number, tx: number, ty: number): void => {
    const key = tileKey(face, level, tx, ty)
    const sizeKm = rootSizeKm / Math.pow(2, level)
    const dir = tileDirection(face, level, tx, ty)
    const px = cx + dir.x * radiusKm
    const py = cy + dir.y * radiusKm
    const pz = cz + dir.z * radiusKm
    const d = dist(px, py, pz, camera.x, camera.y, camera.z)

    const canSplit = level < o.maxLevel
    const wasExpanded = prevExpanded.has(key) || hasDescendant(prevLeaves, key)
    const split = canSplit && (wasExpanded ? d < sizeKm * o.mergeFactor : d < sizeKm * o.splitFactor)
    if (split) {
      expanded.push(key)
      const next = level + 1
      visit(face, next, tx * 2, ty * 2)
      visit(face, next, tx * 2 + 1, ty * 2)
      visit(face, next, tx * 2, ty * 2 + 1)
      visit(face, next, tx * 2 + 1, ty * 2 + 1)
      return
    }
    if (level > maxLevelReached) maxLevelReached = level
    leaves.push({ key, face, level, tx, ty, x: px, y: py, z: pz, sizeKm, distanceKm: d })
  }

  const faces = (planet.faces?.length ? planet.faces : TERRAIN_FACES).filter((f): f is TerrainFace =>
    (TERRAIN_FACES as readonly string[]).includes(f),
  )
  for (const face of faces) visit(face, 0, 0, 0)

  // Memory cap: keep the leaves closest to the camera, but never drop a face
  // entirely (that would punch a hole in the planet).
  if (leaves.length > o.maxTiles) {
    const byFace = new Map<TerrainFace, TileNode[]>()
    for (const leaf of leaves) {
      const arr = byFace.get(leaf.face) ?? []
      arr.push(leaf)
      byFace.set(leaf.face, arr)
    }
    const kept: TileNode[] = []
    const perFace = Math.max(1, Math.floor(o.maxTiles / Math.max(1, faces.length)))
    for (const arr of byFace.values()) {
      arr.sort((a, b) => a.distanceKm - b.distanceKm)
      kept.push(...arr.slice(0, perFace))
    }
    kept.sort((a, b) => a.distanceKm - b.distanceKm)
    return { leaves: kept.slice(0, o.maxTiles), expanded, maxLevelReached }
  }

  void directionFor
  return { leaves, expanded, maxLevelReached }
}
