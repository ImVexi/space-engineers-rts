import { describe, expect, it, vi } from 'vitest'
import {
  classifyLod,
  LOD,
  LoadScheduler,
  LruCache,
  planLod,
  type LodLevel,
} from '../../src/lib/lod'

describe('LOD thresholds', () => {
  it('promotes far → mid → near by camera distance', () => {
    expect(classifyLod(1000)).toBe('far')
    expect(classifyLod(51)).toBe('far')
    expect(classifyLod(50)).toBe('mid')
    expect(classifyLod(20)).toBe('mid')
    expect(classifyLod(8)).toBe('near')
    expect(classifyLod(0.4)).toBe('near')
  })

  it('keeps near until 1.5× the near threshold (hysteresis)', () => {
    expect(LOD.nearUnloadKm).toBe(LOD.nearKm * 1.5)
    expect(classifyLod(11.9, 'near')).toBe('near')
    expect(classifyLod(12.1, 'near')).toBe('mid')
    expect(classifyLod(30, 'near')).toBe('mid')
    expect(classifyLod(60, 'near')).toBe('far')
  })

  it('does not demote mid until its unload band', () => {
    expect(classifyLod(55, 'mid')).toBe('mid')
    expect(classifyLod(56.1, 'mid')).toBe('far')
    expect(classifyLod(9, 'mid')).toBe('mid')
    expect(classifyLod(7.9, 'mid')).toBe('near')
  })

  it('treats non-finite distances as far', () => {
    expect(classifyLod(Number.NaN, 'near')).toBe('far')
    expect(classifyLod(Number.POSITIVE_INFINITY)).toBe('far')
  })
})

describe('planLod', () => {
  const entries = [
    { id: 'near', x: 0, y: 0, z: 0 },
    { id: 'mid', x: 20, y: 0, z: 0 },
    { id: 'far', x: 500, y: 0, z: 0 },
  ]

  it('classifies every entry and reports counts + entrance events', () => {
    const plan = planLod(entries, { x: 0, y: 0, z: 0 })
    expect(plan.levels).toEqual({ near: 'near', mid: 'mid', far: 'far' })
    expect(plan.counts).toEqual({ far: 1, mid: 1, near: 1 })
    expect(plan.enterNear).toEqual(['near'])
    expect(plan.leaveNear).toEqual([])
  })

  it('reports leave events when the camera pulls away', () => {
    const prev: Record<string, LodLevel> = { near: 'near', mid: 'mid', far: 'far' }
    const plan = planLod(entries, { x: 100, y: 0, z: 0 }, prev)
    expect(plan.levels.near).toBe('far')
    expect(plan.leaveNear).toEqual(['near'])
    expect(plan.enterNear).toEqual([])
  })

  it('only fires enterNear on the transition, not every frame', () => {
    const first = planLod(entries, { x: 0, y: 0, z: 0 })
    const second = planLod(entries, { x: 0, y: 0, z: 0 }, first.levels)
    expect(second.enterNear).toEqual([])
    expect(second.leaveNear).toEqual([])
  })
})

describe('LoadScheduler', () => {
  function deferred() {
    let done!: () => void
    const task = (finish: () => void) => {
      done = finish
      return () => undefined
    }
    return { task, finish: () => done() }
  }

  it('runs at most 3 tasks concurrently and promotes the queue as slots free', () => {
    const s = new LoadScheduler(3)
    const tasks = Array.from({ length: 5 }, () => deferred())
    tasks.forEach((t, i) => s.schedule(String(i), t.task))

    expect(s.size).toBe(3)
    expect(s.queued).toBe(2)

    tasks[0].finish()
    expect(s.size).toBe(3)
    expect(s.queued).toBe(1)

    tasks[1].finish()
    tasks[2].finish()
    tasks[3].finish()
    tasks[4].finish()
    expect(s.size).toBe(0)
    expect(s.queued).toBe(0)
  })

  it('ignores duplicate keys and can cancel queued and running work', () => {
    const s = new LoadScheduler(1)
    const a = deferred()
    const b = deferred()
    expect(s.schedule('a', a.task)).toBe(true)
    expect(s.schedule('a', a.task)).toBe(false)
    expect(s.has('a')).toBe(true)

    s.schedule('b', b.task)
    expect(s.queued).toBe(1)
    s.cancel('b')
    expect(s.has('b')).toBe(false)

    s.cancel('a')
    expect(s.size).toBe(0)
  })

  it('uses 3 concurrent fetches by contract', () => {
    expect(LOD.maxConcurrent).toBe(3)
    expect(LOD.maxInstances).toBeGreaterThanOrEqual(200_000)
  })
})

describe('LruCache', () => {
  it('evicts least-recently-used entries to stay inside the instance budget', () => {
    const c = new LruCache<number>(100)
    c.set('a', 1, 40)
    c.set('b', 2, 40)
    c.set('c', 3, 40)
    expect(c.totalWeight).toBe(80)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('c')).toBe(3)

    c.get('b')
    c.set('d', 4, 40)
    // c was used least recently -> evicted
    expect(c.get('c')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('d')).toBe(4)
    expect(c.totalWeight).toBeLessThanOrEqual(100)
  })

  it('keeps a single oversized entry so the near grid can still render', () => {
    const c = new LruCache<number>(10)
    c.set('big', 1, 1000)
    expect(c.get('big')).toBe(1)
  })

  it('delete and clear reset the weight', () => {
    const c = new LruCache<number>(100)
    c.set('a', 1, 10)
    expect(c.delete('a')).toBe(true)
    expect(c.totalWeight).toBe(0)
    c.set('b', 2, 10)
    c.clear()
    expect(c.size).toBe(0)
  })

  it('keeps the 200k block budget as the cache default', () => {
    expect(LOD.cacheBudget).toBe(200_000)
    const c = new LruCache<number>(LOD.cacheBudget)
    c.set('one', 1, 100_000)
    c.set('two', 2, 100_000)
    c.set('three', 3, 100_000)
    expect(c.get('one')).toBeUndefined()
    expect(c.totalWeight).toBe(200_000)
    vi.restoreAllMocks()
  })
})
