export type EntityType =
  | 'grid_static'
  | 'grid_large'
  | 'grid_small'
  | 'player'
  | 'planet'
  | 'asteroid'

export type EntityStatus = 'online' | 'stale' | 'offline'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface FactionRef {
  id: string
  tag: string
  name: string
}

export interface FactionInfo extends FactionRef {
  member_count: number
}

/** Resolved block owner (CONTRACT-BLOCKS: name from Sandbox.sbc identities). */
export interface OwnerRef {
  id: string
  name: string
}

export interface OwnerInfo extends OwnerRef {
  faction_tag: string | null
  grid_count: number
}

export interface AntennaInfo {
  type: 'antenna' | 'beacon'
  radius_m: number
  broadcasting: boolean
  enabled: boolean
}

export interface Entity {
  id: string
  type: EntityType
  name: string
  faction: FactionRef | null
  owner_id: string | null
  /** additive from CONTRACT-BLOCKS */
  owner?: OwnerRef | null
  pos: Vec3
  velocity: Vec3 | null
  radius: number | null
  status: EntityStatus
  first_seen: number
  last_seen: number
  extra?: Record<string, unknown>
}

export interface OwnersResponse {
  owners: OwnerInfo[]
}

export type WorldRenderState = 'idle' | 'rendering' | 'error'

export interface WorldStatus {
  save_hash: string | null
  save_mtime: number | null
  rendered_at: number | null
  state: WorldRenderState
  error: string | null
  grid_count: number
  block_count: number
  skipped_subtypes: Record<string, number>
}

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export interface GridBBox {
  min: [number, number, number]
  max: [number, number, number]
}

/** Approximate block shape class (CONTRACT-SHAPES §A). */
export type ShapeName =
  | 'cube'
  | 'half'
  | 'slope'
  | 'corner'
  | 'invcorner'
  | 'slope2base'
  | 'slope2tip'
  | 'corner2base'
  | 'corner2tip'
  | 'halfslope'
  | 'panel'
  | 'halfpanel'
  | 'beam'
  | 'catwalk'
  | 'window'
  | 'cylinder'
  | 'machine'

export interface SubtypeInfo {
  name: string
  display: string
  type: string
  category: string
  shape: ShapeName
  /** footprint in cells */
  size: [number, number, number]
  /** definition centre offset in cells, if the game definition had one */
  center: [number, number, number] | null
}

export interface WorldGrid {
  id: string
  name: string
  size_class: 'Large' | 'Small'
  /** metres per cell */
  grid_size_m: number
  /** world metres, corner of cell (0,0,0) */
  pos: Vec3
  quat: Quat
  /** grid-local metres */
  bbox_local: GridBBox
  block_count: number
  asset: string
  subtypes: string[]
  /** additive from CONTRACT-SHAPES, parallel to subtypes */
  subtype_info?: SubtypeInfo[]
}

/** GET /api/terrain/planets */
export interface TerrainPlanet {
  id: string
  name: string
  generator: string
  center: Vec3
  radius_min_m: number
  radius_max_m: number
  sea_level_m: number | null
  faces: string[]
  res: number
  available: boolean
  reason: string | null
  /** terrain render key: stable per save, used as the immutable cache tag */
  key?: string
}

export interface TerrainPlanetsResponse {
  planets: TerrainPlanet[]
}

export interface BlocksCatalogResponse {
  subtypes: SubtypeInfo[]
  coverage: { resolved: number; total: number }
}

export interface WorldManifest {
  save_hash: string
  save_mtime: number
  generated_at: number
  grids: WorldGrid[]
}

export interface Health {
  ok: boolean
  source_ok: boolean
  last_poll_ts: number | null
  last_error: string | null
  poll_interval_s: number
  entity_count: number
  save_mtime: number | null
}

export interface HistoryPoint {
  ts: number
  x: number
  y: number
  z: number
}

export interface HistoryResponse {
  id: string
  points: HistoryPoint[]
}

export interface EntitiesResponse {
  entities: Entity[]
}

export interface FactionsResponse {
  factions: FactionInfo[]
}

export type ServerMessage =
  | { type: 'hello'; entities: Entity[]; health: Health }
  | { type: 'upsert'; entities: Entity[] }
  | { type: 'status'; health: Health }
  | { type: 'delete'; ids: string[] }
  | { type: 'world'; status: WorldStatus }

export const GRID_TYPES: EntityType[] = ['grid_static', 'grid_large', 'grid_small']
export const ALL_TYPES: EntityType[] = [...GRID_TYPES, 'player', 'planet', 'asteroid']
export const ALL_STATUSES: EntityStatus[] = ['online', 'stale', 'offline']

export function isGridType(t: EntityType): boolean {
  return t === 'grid_static' || t === 'grid_large' || t === 'grid_small'
}

export function typeLabel(t: EntityType): string {
  switch (t) {
    case 'grid_static':
      return 'Static grid'
    case 'grid_large':
      return 'Large grid'
    case 'grid_small':
      return 'Small grid'
    case 'player':
      return 'Player'
    case 'planet':
      return 'Planet'
    case 'asteroid':
      return 'Asteroid'
    default:
      return t
  }
}
