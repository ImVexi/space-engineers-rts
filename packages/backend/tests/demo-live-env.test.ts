import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig } from './helpers.js';
import { resolveDemoEnv, DemoEnvError, DEMO_MARKER, HOSTED_ENV, HOSTED_OPT_IN } from '../src/demo/env.js';
import { resolveSurvivalMode } from '../src/demo/survival.js';

/**
 * T78: the LIVE survival instance.
 *
 * A second backend pointed at the owner's live server may not claim
 * `RTS_ENV=test` just to mount the demo runtime - that name mounts the test
 * channel and is one copied env line away from a cheat-enabled backend. The
 * hosted env is explicit (`RTS_ENV=live` + `RTS_DEMO_SURVIVAL=1`) and it
 * refuses the two things that could turn it into a test world: the marker and a
 * world fixture.
 *
 * These tests pin the four combinations so a later edit cannot make
 * `RTS_ENV=live` behave like the test world, and a boot proves the runtime
 * really serves with survivalMode true.
 */

const ENV_KEYS = [
  'RTS_DEMO',
  'RTS_ENV',
  'RTS_TEST_SERVER_MARKER',
  'RTS_DEMO_SURVIVAL',
  'RTS_DEMO_STATE',
  'RTS_TOKEN',
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function liveEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { RTS_DEMO: '1', RTS_ENV: HOSTED_ENV, [HOSTED_OPT_IN]: '1', ...extra } as NodeJS.ProcessEnv;
}

describe('T78 live instance: the hosted env mounts survival, never the test world', () => {
  it('mounts the demo runtime in survival mode', () => {
    const env = resolveDemoEnv(liveEnv());
    expect(env).not.toBeNull();
    expect(env?.testLocked).toBe(false);
    expect(env?.fixturePath).toBeNull();
    expect(env?.badge).toMatch(/SURVIVAL MODE/);
    expect(resolveSurvivalMode(liveEnv())).toBe(true);
  });

  it('requires the explicit opt-in - RTS_ENV=live alone is a boot error', () => {
    expect(() => resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: HOSTED_ENV } as NodeJS.ProcessEnv)).toThrow(DemoEnvError);
    expect(() =>
      resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: HOSTED_ENV, [HOSTED_OPT_IN]: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/RTS_DEMO_SURVIVAL=1/);
  });

  it('refuses to boot with the test marker on a live deployment', () => {
    expect(() => resolveDemoEnv(liveEnv({ RTS_TEST_SERVER_MARKER: DEMO_MARKER }))).toThrow(/must not carry RTS_TEST_SERVER_MARKER/);
    // Any marker at all, not just the real one: a typo must not be tolerated.
    expect(() => resolveDemoEnv(liveEnv({ RTS_TEST_SERVER_MARKER: 'hermes-test-la' }))).toThrow(/RTS_TEST_SERVER_MARKER/);
  });

  it('refuses a world fixture on a live deployment', () => {
    expect(() => resolveDemoEnv(liveEnv({ RTS_DEMO_STATE: '/tmp/world.json' }))).toThrow(/test-server only/);
  });

  it('keeps the marked test world exactly as it was', () => {
    const test = resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: 'test', RTS_TEST_SERVER_MARKER: DEMO_MARKER } as NodeJS.ProcessEnv);
    expect(test?.testLocked).toBe(true);
    expect(test?.badge).toMatch(/TEST SERVER/);
    expect(resolveSurvivalMode({ RTS_ENV: 'test', RTS_TEST_SERVER_MARKER: DEMO_MARKER })).toBe(false);
  });

  it('still refuses an unmarked RTS_ENV=test at boot only when nothing opts in (test/survival split unchanged)', () => {
    // T74 behaviour: RTS_ENV=test without the marker is a hosted deployment.
    const hosted = resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(hosted?.testLocked).toBe(false);
    expect(resolveSurvivalMode({ RTS_ENV: 'test' })).toBe(true);
    // Some other env name is still a boot error.
    expect(() => resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/RTS_ENV must be/);
  });

  it('is null when the demo is not requested at all', () => {
    expect(resolveDemoEnv({ RTS_ENV: HOSTED_ENV, [HOSTED_OPT_IN]: '1' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('T78 live instance: a booted live backend serves in survival mode', () => {
  let runtime: Runtime | null = null;
  let port = 0;

  beforeAll(async () => {
    restoreEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = HOSTED_ENV;
    process.env[HOSTED_OPT_IN] = '1';
    process.env.RTS_TOKEN = 't78-live-token';
    delete process.env.RTS_TEST_SERVER_MARKER;
    delete process.env.RTS_DEMO_STATE;
    runtime = createRuntime({ config: makeConfig({ port: 0, token: 't78-live-token' }), memory: true, clock: makeClock().now });
    port = await runtime.listen(0);
    runtime.startLoops();
  });

  afterAll(async () => {
    runtime?.stopLoops();
    await runtime?.close();
    runtime = null;
    restoreEnv();
  });

  afterEach(() => {
    // Each test asserts facts about the same boot; nothing mutates env mid-run.
  });

  it('reports survivalMode true on /api/health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: 'Bearer t78-live-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { survivalMode?: boolean };
    expect(body.survivalMode).toBe(true);
  });

  it('mounts the demo routes and reports survivalMode true there too', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/demo/state`, {
      headers: { authorization: 'Bearer t78-live-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { survivalMode?: boolean; badge?: string };
    expect(body.survivalMode).toBe(true);
    expect(body.badge ?? '').not.toMatch(/TEST SERVER/);
  });

  it('refuses the test channel on the live instance', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/test/order`, {
      method: 'POST',
      headers: { authorization: 'Bearer t78-live-token', 'content-type': 'application/json' },
      body: JSON.stringify({ gridId: 'grid:1', orderType: 'test', params: { action: 'spawn_prefab' } }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; message?: string; hint?: string } };
    expect(body.error?.code).toBe('survival_mode');
    expect(body.error?.message ?? '').toMatch(/not available in survival build/);
  });
});

/**
 * T79: the LIVE sim-speed source, end to end.
 *
 * The live server runs `RemoteApiEnabled=false`, so the Remote API sampler has
 * nothing to read there (`simSpeedEnvPath` is a missing file in this test, which
 * is the same state). The plugin's `simRatio` telemetry frame must therefore be
 * enough on its own: a real frame through the runtime's telemetry handler, the
 * value read back from `executions.simSpeed`, and the 0.95 flight gate blocking
 * at 0.80 and opening at 1.0.
 */
describe('T79 live sim-speed: telemetry simRatio drives the flight gate without the Remote API', () => {
  let runtime: Runtime | null = null;
  const NOW = 1_800_000_000_000;

  beforeAll(async () => {
    restoreEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = HOSTED_ENV;
    process.env[HOSTED_OPT_IN] = '1';
    process.env.RTS_TOKEN = 't79-live-token';
    delete process.env.RTS_TEST_SERVER_MARKER;
    delete process.env.RTS_DEMO_STATE;
    const config = makeConfig({ port: 0, token: 't79-live-token' });
    // The live shape: no Remote API credentials to read (RemoteApiEnabled=false
    // there), so the only source is the plugin.
    config.demo = { ...config.demo, simSpeedEnvPath: '/nonexistent/remote.env' };
    runtime = createRuntime({ config, memory: true, clock: () => NOW });
    await runtime.listen(0);
  });

  afterAll(async () => {
    runtime?.stopLoops();
    await runtime?.close();
    runtime = null;
    restoreEnv();
  });

  /** One frame exactly as the plugin builds it (`TelemetryCollector`). */
  const frame = (simRatio: number | null, sampledAt = NOW): Parameters<Runtime['ingestTelemetry']>[0] => ({
    schemaVersion: 1,
    type: 'telemetry',
    tick: 1,
    at: NOW,
    grids: [],
    players: [],
    contacts: [],
    links: [],
    ledgerDelta: [],
    simRatio: {
      value: simRatio,
      simulationRatio: simRatio,
      serverSimulationRatio: simRatio,
      source: 'MyAPIGateway.Physics',
      state: simRatio === null ? 'UNVERIFIED: test' : 'readable',
      sampledAt,
    },
  });

  it('boots the sampler with no Remote API credentials (the live shape)', () => {
    expect(runtime?.simSpeed).not.toBeNull();
    expect(runtime?.simSpeed?.status().value).toBeNull();
  });

  it('a 0.80 frame blocks the flight gate at the unchanged 0.95 threshold', () => {
    runtime!.ingestTelemetry(frame(0.8));
    const summary = runtime!.executor!.summary() as {
      simSpeed: { value: number | null; threshold: number; source: string };
      flightGate: string;
    };
    expect(summary.simSpeed.value).toBe(0.8);
    expect(summary.simSpeed.threshold).toBe(0.95);
    expect(summary.simSpeed.source).toBe('plugin-telemetry');
    expect(summary.flightGate).toBe('SIMSPEED HOLD');
  });

  it('a 1.0 frame opens it again', () => {
    runtime!.ingestTelemetry(frame(1.0, NOW + 1_000));
    const summary = runtime!.executor!.summary() as {
      simSpeed: { value: number | null; source: string };
      flightGate: string;
    };
    expect(summary.simSpeed.value).toBe(1);
    expect(summary.simSpeed.source).toBe('plugin-telemetry');
    expect(summary.flightGate).toBe('open');
  });

  it('a frame whose read failed changes nothing (never a fake 1.0)', () => {
    runtime!.ingestTelemetry(frame(null, NOW + 2_000));
    const summary = runtime!.executor!.summary() as { simSpeed: { value: number | null } };
    expect(summary.simSpeed.value).toBe(1);
  });
});
