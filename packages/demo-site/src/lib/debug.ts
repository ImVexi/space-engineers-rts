export interface LodDebug {
  far: number
  mid: number
  near: number
  loadedGrids: number
  instances: number
  inflight: number
}

export interface ShapesDebug {
  /** instanced meshes (one per grid+shape, plus machine cores) */
  meshCount: number
  /** total block instances rendered */
  instances: number
  byShape: Record<string, number>
}

export interface TerrainDebug {
  planets: number
  available: number
  unavailable: number
  tiles: number
  smooth: number
  pending: number
  /** approximate GPU memory of decoded tiles, MB */
  memoryMb: number
  maxLevel: number
  label: string
  /** highest decoded tile level rendered on each camera-facing face */
  visibleFaceLevels?: Record<string, number>
}

export interface Readout {
  name: string | null
  x: number
  y: number
  z: number
  source: 'block' | 'terrain' | 'planet' | 'space'
  planet: string | null
  altitude: number | null
  seaLevel: number | null
}

export interface MapDebugState {
  ready: boolean
  /** performance.now() at first ready publish (ms since navigation) */
  readyAt: number | null
  entityCount: number
  visibleCount: number
  planetCount: number
  gridCount: number
  playerCount: number
  clusterCount: number
  clustersActive: boolean
  selectedId: string | null
  avgFrameMs: number
  lastFrameMs: number
  fps: number
  drawCalls: number
  triangles: number
  cameraDistance: number
  webgl: boolean
  filters: { types: number; statuses: number; factions: number; owner: string; hasAntenna: boolean; q: string }
  lod: LodDebug
  commsSpheres: number
  worldState: string | null
  shapes: ShapesDebug
  terrain: TerrainDebug
  colourByFunction: boolean
  hoverName: string | null
  readout: Readout | null
  gps: string | null
  /** 'mobile' <= 900 px (bottom sheets); 'desktop' unchanged */
  layout: 'mobile' | 'desktop'
  coarse: boolean
  mobileSheetExpanded: boolean
  /** three-state bottom sheet: peek | half | full */
  mobileSheetSnap: 'peek' | 'half' | 'full'
  menuOpen: boolean
  touchOrbit: Record<string, unknown> | null
  budgets: {
    dpr: number
    instanceCap: number
    terrainTiles: number
    terrainConcurrent: number
    antialias: boolean
    blockConcurrent: number
    stars: number
  } | null
  /** devicePixelRatio actually used by the WebGL renderer */
  renderDpr: number
  glLost: boolean
}

declare global {
  interface Window {
    __rtsMap?: MapDebugState
  }
}

export const debugState: MapDebugState = {
  ready: false,
  readyAt: null,
  entityCount: 0,
  visibleCount: 0,
  planetCount: 0,
  gridCount: 0,
  playerCount: 0,
  clusterCount: 0,
  clustersActive: false,
  selectedId: null,
  avgFrameMs: 0,
  lastFrameMs: 0,
  fps: 0,
  drawCalls: 0,
  triangles: 0,
  cameraDistance: 0,
  webgl: false,
  filters: { types: 0, statuses: 0, factions: 0, owner: '', hasAntenna: false, q: '' },
  lod: { far: 0, mid: 0, near: 0, loadedGrids: 0, instances: 0, inflight: 0 },
  commsSpheres: 0,
  worldState: null,
  shapes: { meshCount: 0, instances: 0, byShape: {} },
  terrain: {
    planets: 0,
    available: 0,
    unavailable: 0,
    tiles: 0,
    smooth: 0,
    pending: 0,
    memoryMb: 0,
    maxLevel: 0,
    label: 'Terrain: procedural (no player edits)',
  },
  colourByFunction: false,
  hoverName: null,
  readout: null,
  gps: null,
  layout: 'desktop',
  coarse: false,
  mobileSheetExpanded: false,
  mobileSheetSnap: 'peek',
  menuOpen: false,
  touchOrbit: null,
  budgets: null,
  renderDpr: 0,
  glLost: false,
}

/** Publish a snapshot for e2e assertions (read-only for tests). */
export function publishDebug(patch: Partial<MapDebugState>): void {
  Object.assign(debugState, patch)
  if (typeof window !== 'undefined') {
    window.__rtsMap = {
      ...debugState,
      filters: { ...debugState.filters },
      lod: { ...debugState.lod },
      shapes: { ...debugState.shapes, byShape: { ...debugState.shapes.byShape } },
      terrain: { ...debugState.terrain },
      readout: debugState.readout ? { ...debugState.readout } : null,
      budgets: debugState.budgets ? { ...debugState.budgets } : null,
    }
  }
}
