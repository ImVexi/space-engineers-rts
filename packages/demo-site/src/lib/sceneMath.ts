import type { Vec3 } from '../types'

/** Scene units are kilometres: SE coordinates are metres and span 1e6..1e8. */
export const METERS_PER_UNIT = 1000

export function metersToUnits(m: number): number {
  return m / METERS_PER_UNIT
}

export function toScene(pos: Vec3): { x: number; y: number; z: number } {
  return { x: pos.x / METERS_PER_UNIT, y: pos.y / METERS_PER_UNIT, z: pos.z / METERS_PER_UNIT }
}

export function distance3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export interface PlanetLike {
  id: string
  name: string
  pos: Vec3
  radius: number | null
}

export interface NearestPlanet {
  planet: PlanetLike
  /** centre distance, metres */
  distance: number
  /** distance above surface, metres (negative when inside the sphere) */
  altitude: number
}

export function nearestPlanet(pos: Vec3, planets: PlanetLike[]): NearestPlanet | null {
  let best: NearestPlanet | null = null
  for (const p of planets) {
    const d = distance3(pos, p.pos)
    if (!best || d < best.distance) {
      best = { planet: p, distance: d, altitude: d - (p.radius ?? 0) }
    }
  }
  return best
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** OrbitControls zoom speed scaled by camera distance (km). */
export function zoomSpeedForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0.05
  return clamp(distance / 400, 0.05, 6)
}

/** Camera pull-back distance that frames an object of the given radius (km). */
export function focusDistanceFor(radius: number | null | undefined): number {
  const r = radius && radius > 0 ? radius : 1
  return clamp(r * 3.2, 4, 2.5e5)
}

export interface ClusterPoint {
  id: string
  x: number
  y: number
  z: number
}

export interface Cluster {
  key: string
  x: number
  y: number
  z: number
  count: number
  ids: string[]
}

/**
 * Bucket points into axis-aligned cells of `cell` scene units. Because the
 * cell size is derived from camera distance / viewport height (see
 * adaptiveCellUnits) this is a screen-space bucket when zoomed out.
 */
export function clusterByCell(points: ClusterPoint[], cell: number): Cluster[] {
  const size = Math.max(cell, 1e-6)
  const map = new Map<string, Cluster>()
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
    const ix = Math.floor(p.x / size)
    const iy = Math.floor(p.y / size)
    const iz = Math.floor(p.z / size)
    const key = `${ix},${iy},${iz}`
    let c = map.get(key)
    if (!c) {
      c = { key, x: 0, y: 0, z: 0, count: 0, ids: [] }
      map.set(key, c)
    }
    c.x += p.x
    c.y += p.y
    c.z += p.z
    c.count++
    c.ids.push(p.id)
  }
  const out: Cluster[] = []
  for (const c of map.values()) {
    out.push({ ...c, x: c.x / c.count, y: c.y / c.count, z: c.z / c.count })
  }
  return out
}

/** Screen-space cell size in scene units for a pixel target at a distance. */
export function adaptiveCellUnits(
  cameraDistance: number,
  fovDeg: number,
  viewportHeightPx: number,
  targetPx = 12,
): number {
  if (!Number.isFinite(cameraDistance) || cameraDistance <= 0) return 1
  const heightPx = Math.max(viewportHeightPx, 1)
  const worldHeight = 2 * cameraDistance * Math.tan((fovDeg * Math.PI) / 360)
  return Math.max((worldHeight / heightPx) * targetPx, 1e-4)
}

/** Clusters are only drawn when they contain more than one point. */
export function shouldCluster(cameraDistance: number, threshold = 400): boolean {
  return cameraDistance > threshold
}

/**
 * True when a sphere (planet) blocks the segment camera→point. Used to hide
 * HTML markers that would otherwise float in front of the planet limb.
 */
export function segmentBlockedBySphere(
  camera: { x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
  centre: { x: number; y: number; z: number },
  radius: number,
): boolean {
  if (!(radius > 0)) return false;
  const dx = point.x - camera.x;
  const dy = point.y - camera.y;
  const dz = point.z - camera.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return false;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const ox = camera.x - centre.x;
  const oy = camera.y - centre.y;
  const oz = camera.z - centre.z;
  const b = ox * ux + oy * uy + oz * uz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  // Point is inside the sphere (surface/terrain view): not occluded.
  if (c < 0) return false;
  const disc = b * b - c;
  if (disc <= 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < len - 1e-6;
}
