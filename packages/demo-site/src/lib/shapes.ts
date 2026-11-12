import * as THREE from 'three'

/**
 * Approximate block shapes (CONTRACT-SHAPES §A/§D).
 *
 * Every geometry is authored in *unit-cell space*: one cell = 1 unit, the
 * shape's full `size` box is centred on the origin, +Y is Up and the slope
 * faces rise towards +Z (SE "Forward" is -Z, so a slope descends forward).
 * No game assets are used — these are hand-built boxes, wedges and prisms.
 */
export const SHAPE_CLASSES = [
  'cube',
  'half',
  'slope',
  'corner',
  'invcorner',
  'slope2base',
  'slope2tip',
  'corner2base',
  'corner2tip',
  'halfslope',
  'panel',
  'halfpanel',
  'beam',
  'catwalk',
  'window',
  'cylinder',
  'machine',
] as const

export type ShapeClass = (typeof SHAPE_CLASSES)[number]

export const MACHINE_CORE_SHAPE = 'machine-core'

/** Default footprint in cells for shapes whose SE definition is multi-cell. */
export const SHAPE_DEFAULT_SIZE: Record<ShapeClass, [number, number, number]> = {
  cube: [1, 1, 1],
  half: [1, 1, 1],
  slope: [1, 1, 1],
  corner: [1, 1, 1],
  invcorner: [1, 1, 1],
  slope2base: [2, 1, 1],
  slope2tip: [2, 1, 1],
  corner2base: [2, 1, 2],
  corner2tip: [2, 1, 2],
  halfslope: [1, 1, 1],
  panel: [1, 1, 1],
  halfpanel: [1, 1, 1],
  beam: [1, 1, 1],
  catwalk: [1, 1, 1],
  window: [1, 1, 1],
  cylinder: [1, 1, 1],
  machine: [1, 1, 1],
}

export function isShapeClass(name: string): name is ShapeClass {
  return (SHAPE_CLASSES as readonly string[]).includes(name)
}

/* ------------------------------------------------------------------ helpers */

function box(w: number, h: number, d: number, cx = 0, cy = 0, cz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(cx, cy, cz)
  return g
}

/** Merge geometries that all carry position/normal/uv attributes. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  const nonIndexed = parts.map((p) => (p.index ? p.toNonIndexed() : p))
  for (const p of nonIndexed) total += p.getAttribute('position').count
  const pos = new Float32Array(total * 3)
  const nrm = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  let o = 0
  for (const p of nonIndexed) {
    const pa = p.getAttribute('position')
    const na = p.getAttribute('normal')
    const ua = p.getAttribute('uv')
    pos.set(pa.array as ArrayLike<number>, o * 3)
    if (na) nrm.set(na.array as ArrayLike<number>, o * 3)
    if (ua) uv.set(ua.array as ArrayLike<number>, o * 2)
    o += pa.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/**
 * Extruded-profile wedge: a full-width slab whose top face slopes from
 * y = y0 at z = -d/2 to y = y1 at z = +d/2.
 */
function wedge(w: number, d: number, y0: number, y1: number): THREE.BufferGeometry {
  const hw = w / 2
  const hd = d / 2
  // 8 corners: bottom quad at y0, top edge at z=+hd at y1, and the front edge
  // stays at y0 (zero-thickness front face).
  const p = {
    a: [-hw, y0, -hd],
    b: [hw, y0, -hd],
    c: [hw, y0, hd],
    d: [-hw, y0, hd],
    e: [hw, y1, hd],
    f: [-hw, y1, hd],
  } as const
  const verts: number[] = []
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[]) => {
    verts.push(...a, ...b, ...c)
  }
  // bottom (outside is -Y)
  tri(p.a, p.b, p.c)
  tri(p.a, p.c, p.d)
  // back face (z = +hd, outside +Z)
  tri(p.d, p.c, p.e)
  tri(p.d, p.e, p.f)
  // left side (x = -hw, outside -X)
  tri(p.a, p.d, p.f)
  // right side (x = +hw, outside +X)
  tri(p.b, p.e, p.c)
  // sloped top (outside +Y)
  tri(p.a, p.f, p.e)
  tri(p.a, p.e, p.b)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  g.computeVertexNormals()
  return g
}

/** Four-sided pyramid over a square footprint, apex over one corner. */
function cornerPyramid(size: number, apexX = 0.5, apexZ = 0.5, fullHeight = true): THREE.BufferGeometry {
  const h = size / 2
  const y = 0.5
  const baseY = fullHeight ? -0.5 : 0
  const apex = [apexX * h, y, apexZ * h]
  const c = [
    [-h, baseY, -h],
    [h, baseY, -h],
    [h, baseY, h],
    [-h, baseY, h],
  ]
  const verts: number[] = []
  const tri = (a: number[], b: number[], d: number[]) => verts.push(...a, ...b, ...d)
  // bottom (outside is -Y)
  tri(c[0], c[2], c[3])
  tri(c[0], c[1], c[2])
  for (let i = 0; i < 4; i++) tri(c[i], c[(i + 1) % 4], apex)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  g.computeVertexNormals()
  return g
}

/* ------------------------------------------------------------- shape catalog */

const cache = new Map<string, THREE.BufferGeometry>()

function build(shape: ShapeClass): THREE.BufferGeometry {
  switch (shape) {
    case 'cube':
      return box(1, 1, 1)
    case 'half':
      return box(1, 0.5, 1, 0, -0.25, 0)
    case 'slope':
      return wedge(1, 1, -0.5, 0.5)
    case 'corner':
      return cornerPyramid(1)
    case 'invcorner':
      return merge([box(0.5, 1, 1, -0.25, 0, 0), box(0.5, 1, 0.5, 0.25, 0, -0.25)])
    case 'slope2base':
      return wedge(2, 1, -0.5, 0.5)
    case 'slope2tip':
      return wedge(2, 1, 0, 0.5)
    case 'corner2base':
      return cornerPyramid(2)
    case 'corner2tip':
      return cornerPyramid(2, 0.5, 0.5, false)
    case 'halfslope':
      return wedge(1, 1, -0.5, 0)
    case 'panel':
      return box(0.12, 1, 1, -0.44, 0, 0)
    case 'halfpanel':
      return box(0.12, 0.5, 1, -0.44, -0.25, 0)
    case 'beam':
      return box(0.4, 0.4, 1)
    case 'catwalk':
      return merge([
        box(1, 0.12, 0.6, 0, -0.44, 0),
        box(1, 0.22, 0.05, 0, -0.33, 0.28),
        box(1, 0.22, 0.05, 0, -0.33, -0.28),
      ])
    case 'window':
      return box(0.16, 1, 1, -0.42, 0, 0)
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(0.45, 0.45, 1, 12, 1)
      g.computeBoundingBox()
      return g
    }
    case 'machine':
      return box(1, 1, 1)
    default:
      return box(1, 1, 1)
  }
}

/** Prebuilt geometry for a shape (cached; never mutate the returned object). */
export function shapeGeometry(shape: ShapeClass): THREE.BufferGeometry {
  const hit = cache.get(shape)
  if (hit) return hit
  const g = build(shape)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  cache.set(shape, g)
  return g
}

/** Small category-coloured core drawn inside machine shells. */
export function machineCoreGeometry(): THREE.BufferGeometry {
  const hit = cache.get(MACHINE_CORE_SHAPE)
  if (hit) return hit
  const g = box(0.55, 0.55, 0.55)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  cache.set(MACHINE_CORE_SHAPE, g)
  return g
}

/** Transparent shapes get their own material settings. */
export function isTransparentShape(shape: ShapeClass): boolean {
  return shape === 'window'
}

/** Geometry bounds expressed in cells (for tests/telemetry). */
export function shapeBounds(shape: ShapeClass): { min: [number, number, number]; max: [number, number, number] } {
  const g = shapeGeometry(shape)
  g.computeBoundingBox()
  const b = g.boundingBox as THREE.Box3
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }
}
