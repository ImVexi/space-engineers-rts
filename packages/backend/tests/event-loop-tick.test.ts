/**
 * THE FLIGHT TICK MUST SURVIVE A BURST OF STATE READS.
 *
 * Measured 2026-11-10 (the run that cost SAT-R-0001): the demo executor makes
 * its control decisions on the Node event loop. A 1 Hz external sampler -
 * `/api/demo/state` plus `/api/audit` plus the plugin's `land_status` - pushed
 * that loop to 79 % CPU and health checks timed out. The executor made NO
 * decision for 12.3 s mid-fall and the hull hit the ground at 57 m/s with its
 * handover order never sent.
 *
 * The ship-safety half of the fix is the plugin's game-thread descent (it no
 * longer needs this backend to keep up). This file pins the other half: a
 * burst of `GET /api/demo/state` must not be able to take the loop the flight
 * tick runs on.
 *
 * The measurement is the executor's OWN tick spacing (`tickStats().maxGapMs`,
 * instrumented in `DemoExecutor.start`), not a stand-in timer: it is exactly
 * the cadence at which the executor would have issued an order.
 *
 * `RTS_DEMO_STATE_CACHE_MS` toggles the protection, so this file quotes a real
 * before/after: 0 = every request recomputes and serializes the whole world,
 * 1000 = one computation serves the burst (see `demo/stateCache.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeConfig, makeClock } from './helpers.js';

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER', 'RTS_DEMO_STATE_CACHE_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};
const open: Runtime[] = [];

/** The flight tick's target interval for this measurement, ms. */
const TICK_MS = 200;
/** Grids seeded so the state payload is the size a real map answers with. */
const SEED_UNITS = 50;
/** Concurrent state reads: a demo site tab plus a sampler plus a burst. */
const BURST = 50;

function setEnv(cacheMs: number): void {
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
  process.env.RTS_DEMO_STATE_CACHE_MS = String(cacheMs);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/** A raw GET that resolves when the body is fully read (no keep-alive reuse). */
function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One measured run: seed the store, then watch the executor's tick spacing
 * before, during and after `BURST` concurrent `/api/demo/state` requests.
 */
async function measure(cacheMs: number): Promise<{
  beforeGapMs: number;
  burstGapMs: number;
  afterGapMs: number;
  ticks: number;
  bytes: number;
  stateMs: number;
}> {
  setEnv(cacheMs);
  const clock = makeClock();
  const config = makeConfig({ port: 0, flags: { demo_execute: true } });
  config.demo = { ...config.demo, tickMs: TICK_MS };
  const runtime = createRuntime({ config, clock: clock.now });
  open.push(runtime);
  const port = await runtime.listen(0);
  runtime.startLoops();
  const executor = runtime.executor;
  if (!executor) throw new Error('the demo executor is not attached: cannot measure the flight tick');

  // Seed a world the size the demo map really serves. Every row is a fresh
  // telemetry sample, so `demoState` builds its full node list.
  const base = clock.now();
  for (let i = 0; i < SEED_UNITS; i += 1) {
    runtime.store.upsertUnit({
      id: `grid:burst-${i}`,
      name: `BURST-${i}`,
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: base,
      pos: { x: 1_000 + i, y: 2_000 + i, z: 3_000 + i },
      vel: { x: 0, y: 0, z: 0 },
      meta: { ownerName: 'the owner' },
    });
  }

  // Warm the tick loop up, then measure a quiet window as the baseline.
  await sleep(TICK_MS * 4);
  executor.resetTickStats();
  await sleep(TICK_MS * 8);
  const before = executor.tickStats();

  // ---- the burst ---------------------------------------------------------
  executor.resetTickStats();
  const started = Date.now();
  const statuses = await Promise.all(Array.from({ length: BURST }, () => get(port, '/api/demo/state')));
  const stateMs = Date.now() - started;
  const during = executor.tickStats();
  // A tick must be given the chance to run AFTER the burst as well: the point
  // is the loop, not the request latency.
  await sleep(TICK_MS * 4);
  const after = executor.tickStats();

  expect(statuses.every((s) => s === 200)).toBe(true);
  const body = await new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/demo/state', agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve(text));
      })
      .on('error', reject);
  });

  return {
    beforeGapMs: before.maxGapMs,
    burstGapMs: during.maxGapMs,
    afterGapMs: after.maxGapMs,
    ticks: during.ticks,
    bytes: body.length,
    stateMs,
  };
}

describe('the flight tick survives a burst of /api/demo/state reads', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('keeps the executor tick within 2x its interval under 50 concurrent state requests', async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    try {
      // BEFORE: no cache. Every request recomputes and re-serializes the world.
      const before = await measure(0);
      // AFTER: the 1 s cache.
      const after = await measure(1_000);

      // These numbers are the deliverable of this test: quote them, do not
      // guess them.
      console.info(
        `[flight-tick] payload=${Math.round(before.bytes / 1024)} KiB  ` +
          `no-cache: burst=${before.burstGapMs}ms (${BURST} requests in ${before.stateMs}ms, ` +
          `baseline ${before.beforeGapMs}ms)  ` +
          `cached: burst=${after.burstGapMs}ms (${BURST} requests in ${after.stateMs}ms, ` +
          `baseline ${after.beforeGapMs}ms)  target=${TICK_MS}ms`,
      );

      // History: this assertion required the uncached path to starve the tick,
      // which it did until demoState was found to be O(n^3) (evaluateGate
      // rebuilt the network model per node: 200 units 1,459 ms, 2,000 units
      // 128,689 ms). That fix removed the starvation even without the cache, so
      // the old requirement is no longer a property of the system. What matters
      // now is the guarantee below, plus recording the uncached number so a
      // regression back toward O(n^3) is visible in the test output.
      console.log(
        `[event-loop] uncached burst gap ${before.burstGapMs} ms, cached ${after.burstGapMs} ms (tick ${TICK_MS} ms)`,
      );
      expect(before.burstGapMs, 'the uncached burst gap must be measurable').toBeGreaterThan(0);

      // The guarantee: with the cache the flight tick keeps its cadence.
      expect(
        after.burstGapMs,
        `the executor tick gap under the burst must stay within 2x ${TICK_MS} ms (measured ${after.burstGapMs} ms)`,
      ).toBeLessThanOrEqual(TICK_MS * 2);
      expect(after.afterGapMs).toBeLessThanOrEqual(TICK_MS * 2);
      // With the cache the burst finishes faster than one tick interval, so the
      // cached window can legitimately contain zero ticks - that is the opposite
      // of starvation. Assert the tick kept running during the slower (uncached)
      // window, and that the cached numbers above stayed in band.
      expect(before.ticks, 'the executor must keep ticking through the slower burst').toBeGreaterThan(0);
    } finally {
      await Promise.all(open.map((rt) => rt.close().catch(() => undefined)));
      open.length = 0;
    }
  }, 60_000);
});
