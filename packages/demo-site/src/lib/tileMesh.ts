import * as THREE from 'three'
import type { TerrainPlanet } from './worldMapTypes'
import type { SetrTile } from './setr'
import { directionFor, terrainColor, type TerrainFace } from './terrainFaces'

/**
 * Build one terrain tile mesh geometry from a decoded SETR tile.
 *
 * Positions are planet-centre-relative scene km, so the mesh can live in a
 * group at toScene(planet.center). Heights map linearly to
 * radius_min..radius_max; vertex colours come from the planet palette and the
 * tile's biome byte. A skirt drops the outer ring inwards to hide cracks
 * between neighbouring tiles of different LOD.
 */
export interface TileGeometryOptions {
  planet: TerrainPlanet
  face: TerrainFace
  level: number
  tx: number
  ty: number
  tile: SetrTile
  skirtKm?: number
  /** extra inward skirt as a fraction of tile size (0 disables) */
  skirtFraction?: number
}

export function skirtDepthKm(sizeKm: number, fraction = 0.04): number {
  return Math.max(0.02, Math.min(4, sizeKm * fraction))
}

export function buildTerrainGeometry(opts: TileGeometryOptions): THREE.BufferGeometry {
  const { planet, face, level, tx, ty, tile } = opts
  const n = tile.n
  const div = Math.pow(2, level)
  const rMin = planet.radius_min_m / 1000
  const rMax = planet.radius_max_m / 1000
  const seaNorm =
    planet.sea_level_m == null ? null : Math.min(1, Math.max(0, (planet.sea_level_m - rMin) / Math.max(1, rMax - rMin)))
  const radiusKm = (rMin + rMax) / 2
  const sizeKm = (2 * radiusKm) / div
  const skirt = opts.skirtKm ?? skirtDepthKm(sizeKm, opts.skirtFraction ?? 0.04)

  const vertexCount = n * n
  const ringCount = 4 * (n - 1)
  const total = vertexCount + ringCount
  const positions = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  const uvs = new Float32Array(total * 2)

  const dirs = new Float32Array(vertexCount * 3)
  const radii = new Float32Array(vertexCount)

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i
      const s = ((tx + i / (n - 1)) / div) * 2 - 1
      const t = ((ty + j / (n - 1)) / div) * 2 - 1
      const d = directionFor(face, s, t)
      const h = tile.heights[idx] / 65535
      const r = rMin + h * (rMax - rMin)
      dirs[idx * 3] = d.x
      dirs[idx * 3 + 1] = d.y
      dirs[idx * 3 + 2] = d.z
      radii[idx] = r
      positions[idx * 3] = d.x * r
      positions[idx * 3 + 1] = d.y * r
      positions[idx * 3 + 2] = d.z * r
      uvs[idx * 2] = i / (n - 1)
      uvs[idx * 2 + 1] = j / (n - 1)
      const [cr, cg, cb] = terrainColor(planet.name, planet.generator, h, tile.materials[idx], seaNorm)
      colors[idx * 3] = cr
      colors[idx * 3 + 1] = cg
      colors[idx * 3 + 2] = cb
    }
  }

  // Skirt: duplicate the boundary ring pushed inward along the radial normal.
  const ring: number[] = []
  for (let i = 0; i < n - 1; i++) ring.push(i) // top edge, left -> right
  for (let j = 0; j < n - 1; j++) ring.push(j * n + (n - 1)) // right edge, top -> bottom
  for (let i = n - 1; i > 0; i--) ring.push((n - 1) * n + i) // bottom edge, right -> left
  for (let j = n - 1; j > 0; j--) ring.push(j * n) // left edge, bottom -> top
  for (let k = 0; k < ring.length; k++) {
    const src = ring[k]
    const out = vertexCount + k
    const r = Math.max(0.001, radii[src] - skirt)
    positions[out * 3] = dirs[src * 3] * r
    positions[out * 3 + 1] = dirs[src * 3 + 1] * r
    positions[out * 3 + 2] = dirs[src * 3 + 2] * r
    colors[out * 3] = colors[src * 3] * 0.72
    colors[out * 3 + 1] = colors[src * 3 + 1] * 0.72
    colors[out * 3 + 2] = colors[src * 3 + 2] * 0.72
    uvs[out * 2] = uvs[src * 2]
    uvs[out * 2 + 1] = uvs[src * 2 + 1]
  }

  const indices: number[] = []
  const tri = (a: number, b: number, c: number) => indices.push(a, b, c)
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      // planet-local mirror reverses handedness: wind (a,b,c)/(b,d,c)
      tri(a, b, c)
      tri(b, d, c)
    }
  }
  // Skirt walls (towards the planet, so they are hidden from outside but
  // cover any gap against the neighbouring tile).
  for (let k = 0; k < ring.length; k++) {
    const r0 = ring[k]
    const r1 = ring[(k + 1) % ring.length]
    const s0 = vertexCount + k
    const s1 = vertexCount + ((k + 1) % ring.length)
    tri(r0, s0, r1)
    tri(r1, s0, s1)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  geometry.userData.skirt = skirt > 0
  geometry.userData.skirtVertices = ringCount
  geometry.userData.tile = { face, level, tx, ty }
  geometry.userData.vertices = total
  return geometry
}

/** Smooth sphere fallback for planets whose heightmaps are unavailable. */
export function buildSmoothSphereGeometry(planet: TerrainPlanet, segments = 48): THREE.SphereGeometry {
  const radius = (planet.radius_min_m + planet.radius_max_m) / 2000
  const g = new THREE.SphereGeometry(radius, segments, Math.max(12, segments / 2))
  g.userData.smoothFallback = true
  return g
}
