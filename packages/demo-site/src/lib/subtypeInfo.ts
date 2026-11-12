import type { SubtypeInfo } from './worldMapTypes'
import { SHAPE_CLASSES, SHAPE_DEFAULT_SIZE, isShapeClass, type ShapeClass } from './shapes'

/**
 * Subtype metadata (CONTRACT-SHAPES §A).
 *
 * `manifest.grids[].subtype_info` is authoritative once the backend ships it.
 * Until then (and for any subtype the backend leaves unresolved) we infer the
 * same fields from the SubtypeId so the layer still renders sensibly.
 */
export const CATEGORIES = [
  'armor',
  'structure',
  'thruster',
  'power',
  'production',
  'storage',
  'conveyor',
  'weapon',
  'control',
  'comms',
  'sensor',
  'door',
  'light',
  'window',
  'mechanical',
  'wheel',
  'medical',
  'decor',
  'other',
] as const

export type BlockCategory = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  armor: 'Armour',
  structure: 'Structure',
  thruster: 'Thruster',
  power: 'Power',
  production: 'Production',
  storage: 'Storage',
  conveyor: 'Conveyor',
  weapon: 'Weapon',
  control: 'Control',
  comms: 'Comms',
  sensor: 'Sensor',
  door: 'Door',
  light: 'Light',
  window: 'Window',
  mechanical: 'Mechanical',
  wheel: 'Wheel',
  medical: 'Medical',
  decor: 'Decor',
  other: 'Other',
}

/** Distinguishable colours, tuned for the dark scene background. */
export const CATEGORY_COLORS: Record<BlockCategory, string> = {
  armor: '#9fb3c8',
  structure: '#6b7d93',
  thruster: '#ff8f5e',
  power: '#ffd357',
  production: '#c084fc',
  storage: '#4fd1c5',
  conveyor: '#7dd3fc',
  weapon: '#ef4444',
  control: '#60a5fa',
  comms: '#34d399',
  sensor: '#a3e635',
  door: '#f472b6',
  light: '#fef08a',
  window: '#93e6ff',
  mechanical: '#fb923c',
  wheel: '#94a3b8',
  medical: '#f9a8d4',
  decor: '#22d3ee',
  other: '#7c8698',
}

const SIZE_PREFIX = /^(LargeBlock|SmallBlock|Large|Small)/

/** "LargeBlockArmorSlope2Tip" -> "Armor Slope 2 Tip". */
export function humanizeSubtype(subtype: string): string {
  const bare = subtype.replace(SIZE_PREFIX, '')
  const spaced = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return spaced || subtype
}

/** Shape inference from the SubtypeId. Mirrors the documented backend rules. */
export function inferShape(subtype: string, typeId = ''): ShapeClass {
  const s = subtype.toLowerCase()
  if (s.includes('halfslope')) return 'halfslope'
  if (s.includes('slope2tip')) return 'slope2tip'
  if (s.includes('slope2base')) return 'slope2base'
  if (s.includes('corner2tip')) return 'corner2tip'
  if (s.includes('corner2base')) return 'corner2base'
  if (s.includes('invcorner') || s.includes('invertedcorner')) return 'invcorner'
  if (s.includes('corner')) return 'corner'
  if (s.includes('slope')) return 'slope'
  if (s.includes('halfpanel')) return 'halfpanel'
  if (s.includes('panel') || s.includes('interiorwall')) return 'panel'
  if (s.includes('window') || typeId === 'Window') return 'window'
  if (s.includes('catwalk')) return 'catwalk'
  if (s.includes('beam') || s.includes('girder')) return 'beam'
  if (s.includes('cylinder') || s.includes('tube') || s.includes('pipe') || typeId === 'Cylinder')
    return 'cylinder'
  if (s.includes('half')) return 'half'
  return 'cube'
}

const CATEGORY_RULES: Array<{ cat: BlockCategory; keys: string[] }> = [
  { cat: 'thruster', keys: ['thrust'] },
  { cat: 'power', keys: ['reactor', 'battery', 'solar', 'hydrogenengine', 'generator'] },
  { cat: 'production', keys: ['refinery', 'assembler', 'production', 'oxygengenerator', 'survivalkit'] },
  { cat: 'storage', keys: ['cargo', 'container', 'storage', 'tank'] },
  { cat: 'conveyor', keys: ['conveyor', 'junction', 'collector', 'connector', 'pistonhead'] },
  { cat: 'weapon', keys: ['turret', 'gun', 'weapon', 'missile', 'warhead', 'cannon', 'rifle', 'gatling'] },
  { cat: 'control', keys: ['cockpit', 'controller', 'remotecontrol', 'flightseat', 'seat', 'programmable', 'timer', 'button', 'switch', 'terminal', 'keypad'] },
  { cat: 'comms', keys: ['antenna', 'beacon', 'laserantenna', 'radio'] },
  { cat: 'sensor', keys: ['camera', 'sensor', 'detector', 'oredetector'] },
  { cat: 'door', keys: ['door', 'airlock', 'hatch'] },
  { cat: 'light', keys: ['light', 'lamp', 'spotlight', 'floodlight'] },
  { cat: 'window', keys: ['window', 'glass', 'cockpitglass'] },
  { cat: 'wheel', keys: ['wheel'] },
  { cat: 'mechanical', keys: ['piston', 'rotor', 'hinge', 'suspension', 'magnet', 'mechanical'] },
  { cat: 'medical', keys: ['medical', 'medbay', 'cryo'] },
  { cat: 'decor', keys: ['decor', 'plant', 'desk', 'chair', 'table', 'lcd', 'poster', 'banner', 'sign', 'ladder'] },
  { cat: 'armor', keys: ['armor', 'armour', 'heavyarmor'] },
  { cat: 'structure', keys: ['wall', 'block', 'framework', 'column', 'grate', 'catwalk', 'beam', 'stairs', 'pistonbase'] },
]

/** Category inference from SubtypeId (+ TypeId when the backend provides it). */
export function inferCategory(subtype: string, typeId = ''): BlockCategory {
  const hay = `${subtype} ${typeId}`.toLowerCase()
  for (const rule of CATEGORY_RULES) {
    if (rule.keys.some((k) => hay.includes(k))) return rule.cat
  }
  return 'other'
}

/** Structural shapes are drawn with paint colours; functional ones may be machines. */
export function isStructural(category: BlockCategory): boolean {
  return category === 'armor' || category === 'structure' || category === 'window'
}

export function fallbackSubtypeInfo(subtype: string): SubtypeInfo {
  const category = inferCategory(subtype)
  const shape = inferShape(subtype)
  const size = [...SHAPE_DEFAULT_SIZE[shape]] as [number, number, number]
  return {
    name: subtype,
    display: humanizeSubtype(subtype),
    type: '',
    category,
    shape,
    size,
    center: null,
  }
}

function normaliseSize(size: unknown, shape: ShapeClass): [number, number, number] {
  const fallback = SHAPE_DEFAULT_SIZE[shape]
  if (!Array.isArray(size) || size.length !== 3) return [...fallback]
  const out = size.map((v, i) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : fallback[i]
  })
  return [out[0], out[1], out[2]]
}

/** Coerce one backend entry, falling back per-field rather than rejecting it. */
export function normaliseSubtypeInfo(raw: unknown, subtype: string): SubtypeInfo {
  const base = fallbackSubtypeInfo(subtype)
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const category = CATEGORIES.includes(r.category as BlockCategory)
    ? (r.category as BlockCategory)
    : base.category
  const shape: ShapeClass =
    typeof r.shape === 'string' && isShapeClass(r.shape) ? r.shape : base.shape
  return {
    name: typeof r.name === 'string' && r.name ? r.name : subtype,
    display: typeof r.display === 'string' && r.display ? r.display : base.display,
    type: typeof r.type === 'string' ? r.type : '',
    category,
    shape,
    size: normaliseSize(r.size, shape),
    center: Array.isArray(r.center) && r.center.length === 3 ? (r.center as [number, number, number]) : null,
  }
}

/**
 * Resolve one metadata array parallel to a grid's `subtypes` index table.
 * Backend `subtype_info` wins where present; gaps are inferred.
 */
export function resolveSubtypeTable(subtypes: string[], subtypeInfo?: SubtypeInfo[] | null): SubtypeInfo[] {
  return subtypes.map((name, i) => normaliseSubtypeInfo(subtypeInfo?.[i], name))
}

/** Shape list actually present in a table (used for draw-call telemetry). */
export function shapesUsed(table: SubtypeInfo[]): ShapeClass[] {
  const set = new Set<ShapeClass>()
  for (const info of table) set.add(info.shape)
  return SHAPE_CLASSES.filter((s) => set.has(s))
}
