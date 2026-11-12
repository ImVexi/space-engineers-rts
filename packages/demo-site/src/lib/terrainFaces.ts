import type { Vec3 } from './worldMapTypes'

/**
 * Cubesphere face mapping, in SPACE ENGINEERS axes (Y up, -Z forward).
 *
 * Each face has an outward normal `n` and in-plane axes `u`, `v` exactly as
 * fitted in `backend/app/terrain.py::FACE_BASIS`. The cube point for a face
 * parameter (s,t) ∈ [-1,1]² is `n + u*s + v*t`, normalised onto the sphere,
 * then mirrored by {@link PLANET_LOCAL_MIRROR} to go from planet-local to
 * world axes (the backend validated this against real grounded grids).
 * Note `u × v = -n` for every face in local axes; the mirror reverses
 * handedness, so terrain triangles are wound (a, b, c) to stay outward.
 */
export const TERRAIN_FACES = ['front', 'back', 'left', 'right', 'up', 'down'] as const
export type TerrainFace = (typeof TERRAIN_FACES)[number]

export interface FaceBasis {
  face: TerrainFace
  normal: Vec3
  u: Vec3
  v: Vec3
}

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

/** Planet-local -> world axis mirror applied by the backend terrain module. */
export const PLANET_LOCAL_MIRROR: Vec3 = { x: -1, y: 1, z: 1 }

export const FACE_BASIS: Record<TerrainFace, FaceBasis> = {
  // SE "Forward" is -Z.
  front: { face: 'front', normal: vec(0, 0, -1), u: vec(1, 0, 0), v: vec(0, 1, 0) },
  back: { face: 'back', normal: vec(0, 0, 1), u: vec(-1, 0, 0), v: vec(0, 1, 0) },
  right: { face: 'right', normal: vec(1, 0, 0), u: vec(0, 0, 1), v: vec(0, 1, 0) },
  left: { face: 'left', normal: vec(-1, 0, 0), u: vec(0, 0, -1), v: vec(0, 1, 0) },
  up: { face: 'up', normal: vec(0, 1, 0), u: vec(1, 0, 0), v: vec(0, 0, 1) },
  down: { face: 'down', normal: vec(0, -1, 0), u: vec(-1, 0, 0), v: vec(0, 0, 1) },
}

export function isTerrainFace(name: string): name is TerrainFace {
  return (TERRAIN_FACES as readonly string[]).includes(name)
}

function normalise(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len < 1e-12) return { x: 0, y: 1, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function toLocal(v: Vec3): Vec3 {
  return { x: v.x * PLANET_LOCAL_MIRROR.x, y: v.y * PLANET_LOCAL_MIRROR.y, z: v.z * PLANET_LOCAL_MIRROR.z }
}

function toWorld(v: Vec3): Vec3 {
  return toLocal(v) // the mirror is its own inverse
}

/** Unit world direction on the sphere for face-local (s,t) in [-1,1]². */
export function directionFor(face: TerrainFace, s: number, t: number): Vec3 {
  const b = FACE_BASIS[face]
  return toWorld(
    normalise({
      x: b.normal.x + b.u.x * s + b.v.x * t,
      y: b.normal.y + b.u.y * s + b.v.y * t,
      z: b.normal.z + b.u.z * s + b.v.z * t,
    }),
  )
}

/** Face + (s,t) of a world direction (the inverse of {@link directionFor}). */
export function faceUvFromDirection(direction: Vec3): { face: TerrainFace; s: number; t: number } {
  const dir = toLocal(direction)
  const ax = Math.abs(dir.x)
  const ay = Math.abs(dir.y)
  const az = Math.abs(dir.z)
  let face: TerrainFace
  let denom: number
  if (ay >= ax && ay >= az) {
    face = dir.y >= 0 ? 'up' : 'down'
    denom = Math.abs(dir.y)
  } else if (ax >= az) {
    face = dir.x >= 0 ? 'right' : 'left'
    denom = Math.abs(dir.x)
  } else {
    face = dir.z >= 0 ? 'back' : 'front'
    denom = Math.abs(dir.z)
  }
  const b = FACE_BASIS[face]
  const k = 1 / Math.max(denom, 1e-12)
  const px = dir.x * k
  const py = dir.y * k
  const pz = dir.z * k
  return {
    face,
    s: px * b.u.x + py * b.u.y + pz * b.u.z,
    t: px * b.v.x + py * b.v.y + pz * b.v.z,
  }
}

/** Centre direction of tile (level, tx, ty) on one face. */
export function tileDirection(face: TerrainFace, level: number, tx: number, ty: number): Vec3 {
  const div = Math.pow(2, level)
  const s = ((tx + 0.5) / div) * 2 - 1
  const t = ((ty + 0.5) / div) * 2 - 1
  return directionFor(face, s, t)
}

/** Per-planet terrain palette: bands by normalised height + biome colours. */
export interface TerrainPalette {
  bands: [number, number, number][]
  biomes: [number, number, number][]
  sea: [number, number, number]
}

const PALETTES: Record<string, TerrainPalette> = {
  earthlike: {
    bands: [
      [0.24, 0.34, 0.22],
      [0.31, 0.42, 0.25],
      [0.45, 0.44, 0.31],
      [0.52, 0.5, 0.44],
      [0.72, 0.73, 0.75],
    ],
    biomes: [
      [0.31, 0.42, 0.25],
      [0.24, 0.4, 0.18],
      [0.44, 0.4, 0.26],
      [0.55, 0.53, 0.46],
      [0.35, 0.3, 0.24],
      [0.62, 0.62, 0.6],
      [0.28, 0.35, 0.24],
      [0.5, 0.45, 0.32],
    ],
    sea: [0.09, 0.2, 0.3],
  },
  mars: {
    bands: [
      [0.36, 0.2, 0.14],
      [0.45, 0.26, 0.17],
      [0.53, 0.33, 0.21],
      [0.6, 0.42, 0.3],
      [0.72, 0.63, 0.54],
    ],
    biomes: [
      [0.45, 0.26, 0.17],
      [0.38, 0.22, 0.15],
      [0.55, 0.35, 0.23],
      [0.62, 0.46, 0.32],
      [0.33, 0.19, 0.13],
      [0.68, 0.58, 0.5],
      [0.5, 0.3, 0.2],
      [0.42, 0.25, 0.18],
    ],
    sea: [0.2, 0.12, 0.1],
  },
  alien: {
    bands: [
      [0.24, 0.28, 0.2],
      [0.32, 0.38, 0.24],
      [0.4, 0.42, 0.3],
      [0.5, 0.38, 0.4],
      [0.62, 0.55, 0.6],
    ],
    biomes: [
      [0.32, 0.38, 0.24],
      [0.24, 0.34, 0.28],
      [0.44, 0.36, 0.4],
      [0.52, 0.42, 0.46],
      [0.3, 0.26, 0.22],
      [0.6, 0.56, 0.58],
      [0.36, 0.42, 0.3],
      [0.46, 0.4, 0.34],
    ],
    sea: [0.12, 0.2, 0.18],
  },
  moon: {
    bands: [
      [0.34, 0.34, 0.36],
      [0.4, 0.4, 0.42],
      [0.48, 0.48, 0.5],
      [0.56, 0.56, 0.58],
      [0.68, 0.68, 0.7],
    ],
    biomes: [
      [0.4, 0.4, 0.42],
      [0.35, 0.35, 0.38],
      [0.45, 0.45, 0.47],
      [0.5, 0.5, 0.52],
      [0.3, 0.3, 0.33],
      [0.6, 0.6, 0.63],
      [0.42, 0.42, 0.44],
      [0.46, 0.46, 0.48],
    ],
    sea: [0.18, 0.18, 0.2],
  },
}

function paletteFor(planet: string, generator?: string): TerrainPalette {
  const hay = `${planet} ${generator ?? ''}`.toLowerCase()
  if (hay.includes('alien') || hay.includes('pertam')) return PALETTES.alien
  if (hay.includes('mars') || hay.includes('marslike') || hay.includes('red')) return PALETTES.mars
  if (hay.includes('moon') || hay.includes('titan') || hay.includes('europa')) return PALETTES.moon
  return PALETTES.earthlike
}

const BAND_STOPS = [0, 0.28, 0.44, 0.6, 0.78, 1.0001]

/** Height/biome colour for one terrain sample (0..1 height). */
export function terrainColor(
  planet: string,
  generator: string | undefined,
  heightNorm: number,
  biome: number,
  seaNorm: number | null,
): [number, number, number] {
  const p = paletteFor(planet, generator)
  const h = Math.min(1, Math.max(0, heightNorm))
  if (seaNorm != null && h < seaNorm) {
    const depth = seaNorm > 0 ? h / seaNorm : 0
    return [
      p.sea[0] * (0.55 + depth * 0.45),
      p.sea[1] * (0.55 + depth * 0.45),
      p.sea[2] * (0.55 + depth * 0.45),
    ]
  }
  if (biome > 0) {
    const b = p.biomes[biome % p.biomes.length]
    const shade = 0.85 + h * 0.3
    return [Math.min(1, b[0] * shade), Math.min(1, b[1] * shade), Math.min(1, b[2] * shade)]
  }
  let i = 0
  while (i < p.bands.length - 1 && h > BAND_STOPS[i + 1]) i++
  const a = p.bands[i]
  const b = p.bands[Math.min(p.bands.length - 1, i + 1)]
  const span = BAND_STOPS[i + 1] - BAND_STOPS[i]
  const k = span > 0 ? Math.min(1, Math.max(0, (h - BAND_STOPS[i]) / span)) : 0
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}
