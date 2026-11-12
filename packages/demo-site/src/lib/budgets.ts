import type { LodThresholds } from './lod'
import type { PlanOptions } from './quadtree'

/**
 * Rendering budgets for every device class. All performance knobs live here —
 * components read from `budgetsFor(profile)` instead of hard-coding numbers.
 */
export interface RenderProfile {
  /** coarse pointer (touch-first) */
  coarse: boolean
  /** phone-sized viewport */
  small: boolean
  /** mobile layout (bottom sheets) — driven by the CSS breakpoint, not DPR */
  mobile: boolean
}

export interface RenderBudgets {
  profile: RenderProfile
  /** device pixel ratio clamp */
  dpr: number
  antialias: boolean
  /** powerPreference hint for the WebGL context */
  powerPreference: WebGLPowerPreference
  /** total simultaneously rendered block instances (LOD maxInstances) */
  instanceCap: number
  /** decoded-asset LRU weight budget, in instances */
  cacheBudget: number
  /** concurrent block-asset fetches */
  blockConcurrent: number
  /** concurrently live terrain tiles */
  terrainTiles: number
  /** concurrent terrain tile fetches */
  terrainConcurrent: number
  /** starfield point count */
  stars: number
  /** far-LOD marker capacity (instanced markers) */
  markerCapacity: number
  /** cap on devicePixelRatio for the 2D minimap canvas */
  minimapDpr: number
}

export const MOBILE_BREAKPOINT_PX = 900

/** Phones: low pixel budget, small memory, aggressive culling. */
export const MOBILE_BUDGETS: Omit<RenderBudgets, 'profile'> = {
  dpr: 1.5,
  antialias: false,
  powerPreference: 'default',
  instanceCap: 60_000,
  cacheBudget: 120_000,
  blockConcurrent: 2,
  terrainTiles: 80,
  terrainConcurrent: 2,
  stars: 350,
  markerCapacity: 8_000,
  minimapDpr: 2,
}

/** Desktop keeps the proven web budgets (unchanged behaviour). */
export const DESKTOP_BUDGETS: Omit<RenderBudgets, 'profile'> = {
  dpr: 1.5,
  antialias: false,
  powerPreference: 'high-performance',
  instanceCap: 200_000,
  cacheBudget: 200_000,
  blockConcurrent: 3,
  terrainTiles: 220,
  terrainConcurrent: 4,
  stars: 800,
  markerCapacity: 25_000,
  minimapDpr: 2,
}

/** High-end phones (DPR >= 2.5 and plenty of cores) may spend a little more. */
export const MOBILE_HIGH_END_BUDGETS: Omit<RenderBudgets, 'profile'> = {
  ...MOBILE_BUDGETS,
  dpr: 2,
  instanceCap: 80_000,
  terrainTiles: 100,
}

export function isMobileLayout(width: number): boolean {
  return width <= MOBILE_BREAKPOINT_PX
}

export function detectProfile(width: number, coarsePointer: boolean, deviceMemory?: number): RenderProfile {
  const small = width <= MOBILE_BREAKPOINT_PX
  return {
    coarse: coarsePointer,
    small,
    mobile: small || (coarsePointer && width <= 1100),
  }
}

/**
 * Pick budgets for a device. A phone (coarse pointer or small screen) always
 * takes the mobile path, even in landscape where the CSS breakpoint is wide.
 */
export function budgetsFor(profile: RenderProfile, opts: { dpr?: number; cores?: number } = {}): RenderBudgets {
  const phone = profile.small || profile.coarse
  if (!phone) return { profile, ...DESKTOP_BUDGETS }
  const dpr = opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 2)
  const cores = opts.cores ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4)
  const highEnd = dpr >= 2.5 && cores >= 6
  return { profile, ...(highEnd ? MOBILE_HIGH_END_BUDGETS : MOBILE_BUDGETS) }
}

/** LOD thresholds with the budget's instance cap applied. */
export function lodThresholds(base: LodThresholds, b: RenderBudgets): LodThresholds {
  return {
    ...base,
    maxConcurrent: b.blockConcurrent,
    maxInstances: b.instanceCap,
    cacheBudget: b.cacheBudget,
  }
}

export function terrainOptions(b: RenderBudgets): Partial<PlanOptions> {
  return { maxTiles: b.terrainTiles }
}
