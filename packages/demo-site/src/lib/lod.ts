/**
 * LOD state machine + load scheduling for the block layer.
 *
 * Levels: far (existing marker) → mid (bbox wireframe) → near (instanced blocks).
 * Thresholds are configurable constants and deliberately hysteretic so a camera
 * hovering on a boundary cannot thrash. Near unloads at 1.5× the enter radius
 * (CONTRACT-BLOCKS).
 */
export type LodLevel = 'far' | 'mid' | 'near'

export interface LodThresholds {
  /** legacy distance rule, used only when an entry has no bbox */
  nearKm: number
  nearUnloadKm: number
  midKm: number
  midUnloadKm: number
  maxConcurrent: number
  maxInstances: number
  /** decoded-asset LRU budget, in instances */
  cacheBudget: number
  /** near when the grid's bbox covers at least this many pixels ... */
  nearPx: number
  /** ... and stays near until it shrinks below this (hysteresis) */
  nearPxUnload: number
  /** below this the bbox is a few pixels wide: only the HTML marker reads */
  midPx: number
  midPxUnload: number
  /** near also when the camera is closer than factor × bbox diagonal */
  nearDiagFactor: number
}

export const LOD: LodThresholds = {
  nearKm: 8,
  nearUnloadKm: 12,
  midKm: 50,
  midUnloadKm: 56,
  maxConcurrent: 3,
  maxInstances: 200_000,
  cacheBudget: 200_000,
  // A 10.8 m satellite is ~5 px at 2 km: blocks only read once the hull is
  // 40 px across (≈260 m), not at the old blanket 8 km. A 130 m warship
  // reaches 40 px at ~3.1 km, so large grids still show blocks early.
  nearPx: 40,
  nearPxUnload: 30,
  midPx: 8,
  midPxUnload: 6.5,
  nearDiagFactor: 30,
}

export interface LodEntry {
  id: string
  /** scene units (km) */
  x: number
  y: number
  z: number
  /** bbox diagonal in km, when the save manifest supplied one */
  bboxKm?: number
}

export interface LodPlan {
  levels: Record<string, LodLevel>
  /** newly near — fetch their asset */
  enterNear: string[]
  /** were near, no longer — unload meshes (cache may retain bytes) */
  leaveNear: string[]
  counts: { far: number; mid: number; near: number }
}

/** Classify one grid, honouring which level it had last frame. */
export function classifyLod(
  distanceKm: number,
  prev: LodLevel = 'far',
  t: LodThresholds = LOD,
): LodLevel {
  if (!Number.isFinite(distanceKm)) return 'far'
  const d = Math.max(0, distanceKm)
  if (prev === 'near') {
    if (d <= t.nearUnloadKm) return 'near'
    return d <= t.midUnloadKm ? 'mid' : 'far'
  }
  if (prev === 'mid') {
    if (d <= t.nearKm) return 'near'
    return d <= t.midUnloadKm ? 'mid' : 'far'
  }
  if (d <= t.nearKm) return 'near'
  if (d <= t.midKm) return 'mid'
  return 'far'
}

/** Classify one grid by projected bbox size (the close-range rule). */
export function classifyLodSized(
  distanceKm: number,
  bboxKm: number,
  pixelsPerKm: number,
  prev: LodLevel = 'far',
  t: LodThresholds = LOD,
): LodLevel {
  if (!Number.isFinite(distanceKm)) return 'far'
  const d = Math.max(0, distanceKm)
  const diag = Math.max(1e-6, bboxKm)
  // px at this distance; distance 0 is inside the hull, which is near.
  const px = d <= 1e-9 ? Number.POSITIVE_INFINITY : (diag * pixelsPerKm) / d
  const close = d <= diag * t.nearDiagFactor
  if (prev === 'near') {
    if (px >= t.nearPxUnload || d <= diag * t.nearDiagFactor * 1.4) return 'near'
    return px >= t.midPxUnload ? 'mid' : 'far'
  }
  if (prev === 'mid') {
    if (px >= t.nearPx || close) return 'near'
    return px >= t.midPxUnload ? 'mid' : 'far'
  }
  if (px >= t.nearPx || close) return 'near'
  if (px >= t.midPx) return 'mid'
  return 'far'
}

function distanceKm(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Apply the LOD state machine to every rendered grid for the current camera. */
export function planLod(
  entries: LodEntry[],
  camera: { x: number; y: number; z: number },
  prevLevels: Record<string, LodLevel> = {},
  t: LodThresholds = LOD,
  /** pixels per km at 1 km, from fov + viewport height; enables bbox sizing */
  pixelsPerKm = 0,
): LodPlan {
  const levels: Record<string, LodLevel> = {}
  const enterNear: string[] = []
  const leaveNear: string[] = []
  const counts = { far: 0, mid: 0, near: 0 }

  for (const e of entries) {
    const prev = prevLevels[e.id] ?? 'far'
    const d = distanceKm(e, camera)
    const next =
      e.bboxKm && e.bboxKm > 0 && pixelsPerKm > 0
        ? classifyLodSized(d, e.bboxKm, pixelsPerKm, prev, t)
        : classifyLod(d, prev, t)
    levels[e.id] = next
    counts[next]++
    if (next === 'near' && prev !== 'near') enterNear.push(e.id)
    if (prev === 'near' && next !== 'near') leaveNear.push(e.id)
  }
  return { levels, enterNear, leaveNear, counts }
}

/**
 * Concurrency gate: at most `limit` tasks run at once; the rest queue.
 * A task returns its own cancel function; `cancel()` aborts and frees a slot.
 */
export class LoadScheduler {
  private running = new Map<string, { done: () => void; cancel: () => void }>()
  private waiting: Array<{ key: string; task: (done: () => void) => () => void }> = []
  private limit: number

  constructor(limit = LOD.maxConcurrent) {
    this.limit = Math.max(1, limit)
  }

  /** Queue a task unless it is already running/queued. Returns true when queued. */
  schedule(key: string, task: (done: () => void) => () => void): boolean {
    if (this.running.has(key) || this.waiting.some((w) => w.key === key)) return false
    this.waiting.push({ key, task })
    this.pump()
    return true
  }

  cancel(key: string): boolean {
    const before = this.waiting.length
    this.waiting = this.waiting.filter((w) => w.key !== key)
    const running = this.running.get(key)
    if (running) {
      running.cancel()
      running.done()
      return true
    }
    return this.waiting.length !== before
  }

  cancelAll(): void {
    this.waiting = []
    for (const r of [...this.running.values()]) {
      r.cancel()
      r.done()
    }
  }

  has(key: string): boolean {
    return this.running.has(key) || this.waiting.some((w) => w.key === key)
  }

  get size(): number {
    return this.running.size
  }

  get queued(): number {
    return this.waiting.length
  }

  private pump(): void {
    while (this.running.size < this.limit && this.waiting.length > 0) {
      const item = this.waiting.shift()
      if (!item || this.running.has(item.key)) continue
      let finished = false
      const slot: { done: () => void; cancel: () => void } = { done: () => undefined, cancel: () => undefined }
      const done = () => {
        if (finished) return
        finished = true
        this.running.delete(item.key)
        this.pump()
      }
      slot.done = done
      this.running.set(item.key, slot)
      slot.cancel = item.task(done)
    }
  }
}

/** Tiny LRU keyed cache with a weight budget (used for decoded instances). */
export class LruCache<T> {
  private map = new Map<string, { value: T; weight: number }>()
  private budget: number

  constructor(budget: number) {
    this.budget = Math.max(0, budget)
  }

  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    // refresh recency
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  peek(key: string): T | undefined {
    return this.map.get(key)?.value
  }

  set(key: string, value: T, weight: number): void {
    this.map.delete(key)
    this.map.set(key, { value, weight })
    this.evict()
  }

  delete(key: string): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  get totalWeight(): number {
    let n = 0
    for (const v of this.map.values()) n += v.weight
    return n
  }

  get size(): number {
    return this.map.size
  }

  private evict(): void {
    while (this.totalWeight > this.budget && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}
