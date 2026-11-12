import type { TerrainPlanet, Vec3 } from './worldMapTypes'
import { faceUvFromDirection, type TerrainFace } from './terrainFaces'

/**
 * Height sampling from the terrain tiles the scene already fetched.
 *
 * A tap raycast hits a *mesh*: the coarse planet sphere, a coarse quadtree
 * tile, or a tile skirt that hangs below the surface. Those radii are wrong
 * by up to a kilometre on rugged terrain, so the reported point must be
 * rebuilt from the heightgrid the frontend actually draws (the SETR tiles),
 * not from the hit point.
 */
export interface TerrainTileSample {
  planetId: string
  face: TerrainFace
  level: number
  tx: number
  ty: number
  /** vertices per tile side */
  n: number
  /** row-major 0..65535 heights, same layout as SETR */
  heights: Uint16Array
  radiusMinM: number
  radiusMaxM: number
}

const registry = new Map<string, Map<string, TerrainTileSample>>()

// A version + listener set so a renderer (the coverage heatmap) can rebuild its
// geometry once when heights for a planet arrive or refine. Cheap: a boolean
// snapshot means React only re-renders on the transition, not per tile.
let version = 0
const listeners = new Set<() => void>()

export function subscribeTerrainTiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function terrainTileVersion(): number {
  return version
}

export function terrainTileKey(t: Pick<TerrainTileSample, 'face' | 'level' | 'tx' | 'ty'>): string {
  return `${t.face}:${t.level}:${t.tx}:${t.ty}`
}

export function registerTerrainTile(tile: TerrainTileSample): void {
  let byKey = registry.get(tile.planetId)
  if (!byKey) {
    byKey = new Map()
    registry.set(tile.planetId, byKey)
  }
  byKey.set(terrainTileKey(tile), tile)
  version += 1
  for (const listener of listeners) listener()
}

export function resetTerrainTiles(planetId?: string): void {
  if (planetId == null) registry.clear()
  else registry.delete(planetId)
  version += 1
  for (const listener of listeners) listener()
}

export function terrainTileCount(planetId: string): number {
  return registry.get(planetId)?.size ?? 0
}

function sampleTile(tile: TerrainTileSample, u: number, v: number): number {
  const div = Math.pow(2, tile.level)
  const lx = Math.min(1, Math.max(0, ((u + 1) / 2) * div - tile.tx))
  const ly = Math.min(1, Math.max(0, ((v + 1) / 2) * div - tile.ty))
  const gx = lx * (tile.n - 1)
  const gy = ly * (tile.n - 1)
  const x0 = Math.min(tile.n - 1, Math.floor(gx))
  const y0 = Math.min(tile.n - 1, Math.floor(gy))
  const x1 = Math.min(tile.n - 1, x0 + 1)
  const y1 = Math.min(tile.n - 1, y0 + 1)
  const fx = gx - x0
  const fy = gy - y0
  const h00 = tile.heights[y0 * tile.n + x0]
  const h10 = tile.heights[y0 * tile.n + x1]
  const h01 = tile.heights[y1 * tile.n + x0]
  const h11 = tile.heights[y1 * tile.n + x1]
  const h = (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
  return tile.radiusMinM + (h / 65535) * (tile.radiusMaxM - tile.radiusMinM)
}

export interface TerrainSample {
  /** radius from the planet centre, metres */
  radius: number
  face: TerrainFace
  u: number
  v: number
  level: number
}

/**
 * Radius of the drawn terrain surface in the direction of `pointM`.
 * Uses the finest cached tile that covers the direction; null when no tile
 * for that face is loaded yet.
 */
export function sampleTerrainRadius(planet: TerrainPlanet, pointM: Vec3): TerrainSample | null {
  const byKey = registry.get(planet.id)
  if (!byKey || byKey.size === 0) return null
  const dx = pointM.x - planet.center.x
  const dy = pointM.y - planet.center.y
  const dz = pointM.z - planet.center.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return null
  const { face, s, t } = faceUvFromDirection({ x: dx / len, y: dy / len, z: dz / len })
  let best: TerrainTileSample | null = null
  for (const tile of byKey.values()) {
    if (tile.face !== face) continue
    const div = Math.pow(2, tile.level)
    const u0 = (tile.tx / div) * 2 - 1
    const v0 = (tile.ty / div) * 2 - 1
    const u1 = ((tile.tx + 1) / div) * 2 - 1
    const v1 = ((tile.ty + 1) / div) * 2 - 1
    if (s < u0 - 1e-9 || s > u1 + 1e-9 || t < v0 - 1e-9 || t > v1 + 1e-9) continue
    if (!best || tile.level > best.level) best = tile
  }
  if (!best) return null
  return { radius: sampleTile(best, s, t), face, u: s, v: t, level: best.level }
}

/** True once at least one decoded tile exists for the planet. */
export function hasTerrainTiles(planetId: string): boolean {
  return (registry.get(planetId)?.size ?? 0) > 0
}

/**
 * Direction-only sampler for anything that needs many heights at once (the
 * coverage heatmap builds thousands of vertices). It indexes the cached tiles
 * by face once, finest level first, so a sample is a face lookup plus one
 * bilinear read instead of a scan of every tile. Returns null when the planet
 * has no decoded tiles at all — the caller must then label its result as
 * approximate rather than invent a height.
 *
 * `maxRadiusNear` is the important one for overlays: the height grid's nodes
 * are the mesh's own vertices, and a triangle cannot rise above the highest of
 * its corners, so the maximum over these nodes is a hard upper bound for the
 * drawn surface inside the window. A quad placed there can never be swallowed
 * by a ridge that the sparse taps happened to miss.
 */
export interface TerrainRadiusSampler {
  /** drawn surface radius (metres from the centre) in this direction */
  radiusOf(dir: Vec3): number | null
  /** highest drawn radius within `halfAngleRad` of `dir` */
  maxRadiusNear(dir: Vec3, halfAngleRad: number): number | null
}

export function createTerrainRadiusSampler(planetId: string): TerrainRadiusSampler | null {
  const byKey = registry.get(planetId)
  if (!byKey || byKey.size === 0) return null
  const byFace = new Map<TerrainFace, TerrainTileSample[]>()
  for (const tile of byKey.values()) {
    const list = byFace.get(tile.face) ?? []
    list.push(tile)
    byFace.set(tile.face, list)
  }
  for (const list of byFace.values()) list.sort((a, b) => b.level - a.level)

  function radiusOf(dir: Vec3): number | null {
    const { face, s, t } = faceUvFromDirection(dir)
    const candidates = byFace.get(face)
    if (!candidates) return null
    for (const tile of candidates) {
      const div = Math.pow(2, tile.level)
      const u0 = (tile.tx / div) * 2 - 1
      const v0 = (tile.ty / div) * 2 - 1
      const u1 = ((tile.tx + 1) / div) * 2 - 1
      const v1 = ((tile.ty + 1) / div) * 2 - 1
      if (s < u0 - 1e-9 || s > u1 + 1e-9 || t < v0 - 1e-9 || t > v1 + 1e-9) continue
      return sampleTile(tile, s, t)
    }
    return null
  }

  function maxRadiusNear(dir: Vec3, halfAngleRad: number): number | null {
    const half = Math.abs(halfAngleRad)
    // Orthonormal basis around the cell centre so probes can be placed at a
    // known angular distance in every azimuth.
    const ref = Math.abs(dir.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
    const eastRaw = {
      x: ref.y * dir.z - ref.z * dir.y,
      y: ref.z * dir.x - ref.x * dir.z,
      z: ref.x * dir.y - ref.y * dir.x,
    }
    const eastLen = Math.hypot(eastRaw.x, eastRaw.y, eastRaw.z) || 1
    const east = { x: eastRaw.x / eastLen, y: eastRaw.y / eastLen, z: eastRaw.z / eastLen }
    const north = {
      x: dir.y * east.z - dir.z * east.y,
      y: dir.z * east.x - dir.x * east.z,
      z: dir.x * east.y - dir.y * east.x,
    }
    const probe = (theta: number, azimuth: number): Vec3 => {
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      const ax = Math.cos(azimuth) * s
      const ay = Math.sin(azimuth) * s
      const x = dir.x * c + east.x * ax + north.x * ay
      const y = dir.y * c + east.y * ax + north.y * ay
      const z = dir.z * c + east.z * ax + north.z * ay
      const len = Math.hypot(x, y, z) || 1
      return { x: x / len, y: y / len, z: z / len }
    }

    // Boxes in cube-face (s,t) space, one per face the cell window touches, so
    // a cell straddling a cube edge still sees the neighbour's heights.
    const boxes = new Map<TerrainFace, { s0: number; s1: number; t0: number; t1: number }>()
    let best: number | null = null
    const pad = 2 / 64 + 0.005 // one level-0 grid node, plus a hair
    const addProbe = (theta: number, azimuth: number): void => {
      const p = probe(theta, azimuth)
      const surface = radiusOf(p)
      if (surface != null && (best == null || surface > best)) best = surface
      const { face, s, t } = faceUvFromDirection(p)
      const box = boxes.get(face)
      if (!box) boxes.set(face, { s0: s - pad, s1: s + pad, t0: t - pad, t1: t + pad })
      else {
        box.s0 = Math.min(box.s0, s - pad)
        box.s1 = Math.max(box.s1, s + pad)
        box.t0 = Math.min(box.t0, t - pad)
        box.t1 = Math.max(box.t1, t + pad)
      }
    }
    const reach = half * 1.1 + 1e-4
    addProbe(0, 0)
    for (let i = 0; i < 8; i += 1) addProbe(reach, (i / 8) * Math.PI * 2)
    for (let i = 0; i < 8; i += 1) addProbe(reach * 0.55, (i / 8) * Math.PI * 2 + Math.PI / 8)

    for (const [face, box] of boxes) {
      const candidates = byFace.get(face)
      if (!candidates) continue
      for (const tile of candidates) {
        const div = Math.pow(2, tile.level)
        const u0 = (tile.tx / div) * 2 - 1
        const v0 = (tile.ty / div) * 2 - 1
        const u1 = ((tile.tx + 1) / div) * 2 - 1
        const v1 = ((tile.ty + 1) / div) * 2 - 1
        const s0 = Math.max(box.s0, u0)
        const s1 = Math.min(box.s1, u1)
        const t0 = Math.max(box.t0, v0)
        const t1 = Math.min(box.t1, v1)
        if (s0 > s1 || t0 > t1) continue
        const span = tile.radiusMaxM - tile.radiusMinM
        const toGridX = (value: number): number => (((value + 1) / 2) * div - tile.tx) * (tile.n - 1)
        const toGridY = (value: number): number => (((value + 1) / 2) * div - tile.ty) * (tile.n - 1)
        const gx0 = Math.max(0, Math.floor(toGridX(s0)))
        const gx1 = Math.min(tile.n - 1, Math.ceil(toGridX(s1)))
        const gy0 = Math.max(0, Math.floor(toGridY(t0)))
        const gy1 = Math.min(tile.n - 1, Math.ceil(toGridY(t1)))
        for (let gy = gy0; gy <= gy1; gy += 1) {
          const row = gy * tile.n
          for (let gx = gx0; gx <= gx1; gx += 1) {
            const r = tile.radiusMinM + (tile.heights[row + gx] / 65535) * span
            if (best == null || r > best) best = r
          }
        }
      }
    }
    return best
  }

  return { radiusOf, maxRadiusNear }
}

/** Surface point (world metres) from sampled heights instead of the hit mesh. */
export function resolveSurfacePoint(planet: TerrainPlanet, pointM: Vec3): Vec3 | null {
  const sample = sampleTerrainRadius(planet, pointM)
  if (!sample) return null
  const dx = pointM.x - planet.center.x
  const dy = pointM.y - planet.center.y
  const dz = pointM.z - planet.center.z
  const len = Math.hypot(dx, dy, dz) || 1
  return {
    x: planet.center.x + (dx / len) * sample.radius,
    y: planet.center.y + (dy / len) * sample.radius,
    z: planet.center.z + (dz / len) * sample.radius,
  }
}
