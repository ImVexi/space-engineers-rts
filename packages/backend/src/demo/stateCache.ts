/**
 * A 1-second cache for `GET /api/demo/state`, and the reason it exists.
 *
 * MEASURED FAILURE (2026-11-10). The demo executor makes its flight decisions
 * on the Node event loop. A 1 Hz external sampler (`/api/demo/state` +
 * `/api/audit` + `land_status`) saturated that single thread: 79 % CPU, health
 * checks timing out, and NO control decision for 12.3 s. A hull mid-fall hit
 * the ground at 57 m/s with the handover order never sent.
 *
 * The fix that makes the ship safe is elsewhere (the plugin owns the whole
 * descent on the game thread). This cache is the second half: a burst of state
 * reads - a browser polling, a test sampler, several demo tabs - must not be
 * able to consume the loop the flight tick needs.
 *
 * A one-second-old map read is honest: positions change at metres per second
 * and the map already renders telemetry that arrives seconds apart. Staleness
 * is bounded twice over, because a hit also requires an unchanged
 * `fingerprint` of the tables the body was built from - so a write of any kind
 * (HTTP, executor, telemetry ingestion, a test touching the store) is never
 * masked by the cache.
 *
 * `RTS_DEMO_STATE_CACHE_MS` overrides the TTL (0 disables it, for a measured
 * before/after in tests). The value is read at request time so a test can
 * compare both paths in one process.
 */
export interface CachedDemoState {
  /** When the body was computed, ms (real clock: the loop is real). */
  atMs: number;
  /** The already-serialized body: a cache hit must not re-run JSON.stringify. */
  payload: string;
  /** Fingerprint of the source rows at computation time. */
  fingerprint: string;
}

export function demoStateCacheTtlMs(): number {
  const raw = process.env.RTS_DEMO_STATE_CACHE_MS;
  if (raw === undefined || raw === '') return 1000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1000;
  return Math.max(0, Math.min(30_000, Math.floor(n)));
}

export class DemoStateCache {
  private entries = new Map<string, CachedDemoState>();
  private hits = 0;
  private misses = 0;

  /** Cache key: the only query flag that changes the body. */
  static key(includeArchived: boolean): string {
    return includeArchived ? 'archived' : 'current';
  }

  get(key: string, nowMs: number, fingerprint: string): string | null {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses += 1;
      return null;
    }
    if (hit.fingerprint !== fingerprint || nowMs - hit.atMs >= demoStateCacheTtlMs()) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return hit.payload;
  }

  set(key: string, payload: string, nowMs: number, fingerprint: string): void {
    this.entries.set(key, { atMs: nowMs, payload, fingerprint });
    // One entry per key: the map can never grow with traffic.
    if (this.entries.size > 8) {
      for (const k of this.entries.keys()) {
        if (k !== key) this.entries.delete(k);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { hits: number; misses: number; entries: number; ttlMs: number } {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, ttlMs: demoStateCacheTtlMs() };
  }
}
