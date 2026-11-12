import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';
import { resolveDemoEnv } from '../src/demo/env.js';
import {
  ADMIN_ACTIONS,
  ADMIN_FEATURES,
  isAdminAction,
  isTestEnvironment,
  resolveSurvivalMode,
  decideTestIgnoreReach,
  survivalGate,
  survivalRefusal,
} from '../src/demo/survival.js';

/**
 * T74 survival mode. The rule has two halves - the plugin refuses to compile the
 * admin actions into the live build, and the backend refuses to *send* them
 * outside the marked test world. These tests are the backend half: an env lock
 * when the process is hosted, a plain 409 + audit row from every route that
 * would have sent a cheat, and a station conversion that stops on dampeners
 * instead of teleporting the hull to a standstill.
 */

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER', 'RTS_TOKEN', 'RTS_FLAGS'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function hostedEnv(): void {
  // A hosted/vanilla deployment: demo on (so the routes exist and are gated),
  // but NO test marker. RTS_ENV absent would make the demo lock refuse at boot,
  // so the honest hosted case here is RTS_ENV=test with the wrong marker, the
  // way a copied service would run.
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  delete process.env.RTS_TEST_SERVER_MARKER;
}

function testEnv(): void {
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
}

/**
 * `httpRequest` in helpers cannot see a 409 with a body on this box: undici
 * reports EPIPE ("other side closed") instead. Raw node:http reads the same
 * answer the server wrote, so the refusal body is what gets asserted.
 */
function rawPost(port: number, route: string, body: unknown, token: string): Promise<{ status: number; json: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const PORT = 8851;
const TOKEN = 't74-token';

describe('T74 survival mode: the flag', () => {
  it('is ON by default, with no environment at all', () => {
    expect(resolveSurvivalMode({})).toBe(true);
    expect(isTestEnvironment({})).toBe(false);
  });

  it('is ON when the env says test but the marker is missing (a copied service)', () => {
    expect(resolveSurvivalMode({ RTS_ENV: 'test' })).toBe(true);
    expect(resolveSurvivalMode({ RTS_TEST_SERVER_MARKER: 'se-rts-test' })).toBe(true);
  });

  it('is OFF only for the marked test world', () => {
    expect(resolveSurvivalMode({ RTS_ENV: 'test', RTS_TEST_SERVER_MARKER: 'se-rts-test' })).toBe(false);
  });

  it('treats production as survival with the marker present', () => {
    expect(resolveSurvivalMode({ RTS_ENV: 'production', RTS_TEST_SERVER_MARKER: 'se-rts-test' })).toBe(true);
  });

  it('lists every admin action the spec names', () => {
    for (const action of [
      'spawn_prefab',
      'clone_grid',
      'delete_grid',
      'refill_grid',
      'teleport',
      'zero_velocity',
      'set_orientation',
      'ownership',
      'delete_planets',
      'snap_dock',
    ]) {
      expect(isAdminAction(action), action).toBe(true);
    }
    for (const legit of ['move', 'set_dampeners', 'set_block_props', 'convert_to_station', 'land_at']) {
      expect(isAdminAction(legit), legit).toBe(false);
    }
    expect(ADMIN_FEATURES).toContain('fillWithClones');
  });

  it('gives a plain reason, not a generic error', () => {
    const refusal = survivalRefusal('spawn_prefab');
    expect(refusal.reason).toBe('survival_mode');
    expect(refusal.status).toBe(409);
    expect(refusal.message).toMatch(/not available in survival build/);

    const gated = survivalGate(true);
    expect(gated.refuse('spawn_prefab')?.reason).toBe('survival_mode');
    expect(gated.allowsAction('spawn_prefab')).toBe(false);
    expect(gated.allowsAction('move')).toBe(true);
    expect(gated.allowsFeature('fillWithClones')).toBe(false);

    const test = survivalGate(false);
    expect(test.refuse('spawn_prefab')).toBeNull();
    expect(test.allowsAction('spawn_prefab')).toBe(true);
    expect(test.allowsFeature('fillWithClones')).toBe(true);
  });

  it('audits an admin action set that a later edit cannot quietly shrink', () => {
    expect(ADMIN_ACTIONS.size).toBeGreaterThanOrEqual(10);
  });
});

describe('T74 survival mode: routes refuse the cheats', () => {
  let runtime: Runtime | null = null;

  async function boot(env: () => void): Promise<Runtime> {
    restoreEnv();
    env();
    process.env.RTS_TOKEN = TOKEN;
    const clock = makeClock();
    const rt = createRuntime({ config: makeConfig({ port: PORT, token: TOKEN }), clock: clock.now, memory: true });
    await rt.listen(PORT);
    return rt;
  }

  afterEach(async () => {
    if (runtime) await runtime.close();
    runtime = null;
    restoreEnv();
  });

  afterAll(() => restoreEnv());

  it('survival: /api/health says survivalMode true', async () => {
    runtime = await boot(hostedEnv);
    const res = await httpRequest<{ survivalMode: boolean }>(PORT, 'GET', '/api/health', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.survivalMode).toBe(true);
  });

  it('test env: /api/health says survivalMode false', async () => {
    runtime = await boot(testEnv);
    const res = await httpRequest<{ survivalMode: boolean }>(PORT, 'GET', '/api/health', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.survivalMode).toBe(false);
  });

  it('survival: /api/demo/state exposes survivalMode', async () => {
    runtime = await boot(hostedEnv);
    const res = await httpRequest<{ survivalMode: boolean }>(PORT, 'GET', '/api/demo/state', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.survivalMode).toBe(true);
  });

  it('survival: designer plugin proxy refuses clone_grid and delete_grid with 409 survival_mode', async () => {
    runtime = await boot(hostedEnv);
    for (const action of ['clone_grid', 'delete_grid']) {
      const res = await httpRequest<{ error: { code: string; message: string } }>(
        PORT,
        'POST',
        '/api/demo/designer/plugin',
        { action, params: {} },
        TOKEN,
      );
      expect(res.status, action).toBe(409);
      expect(res.body.error.code, action).toBe('survival_mode');
      expect(res.body.error.message, action).toMatch(/not available in survival build/);
    }
    // The audit row is what proves the refusal happened on purpose.
    const audit = runtime.store.listAudit(50) as { action: string; subject: string }[];
    const refused = audit.filter((a) => a.action === 'survival_refused');
    expect(refused.map((r) => r.subject).sort()).toEqual(['clone_grid', 'delete_grid']);
  });

  it('survival: no admin action can reach the plugin (the set cannot quietly shrink)', async () => {
    runtime = await boot(hostedEnv);
    const gateRefusals: string[] = [];
    for (const action of [...ADMIN_ACTIONS]) {
      // rawPost, not httpRequest: this box's undici reports EPIPE for a 409 body.
      const res = await rawPost(PORT, '/api/demo/designer/plugin', { action, params: {} }, TOKEN);
      const code = (res.json as { error?: { code?: string; message?: string } }).error?.code ?? null;
      // The proxy's whitelist is narrow: an admin action it does not carry is a
      // 400 action_not_allowed, one it does carry is the survival gate's 409.
      // Neither may reach the plugin, and the gate's own answer is the one that
      // proves the policy (not a missing route, not a 404).
      expect([400, 409], action).toContain(res.status);
      expect(code, action).toBe(res.status === 409 ? 'survival_mode' : 'action_not_allowed');
      if (res.status === 409) {
        expect((res.json as { error: { message: string } }).error.message, action).toMatch(/not available in survival build/);
        gateRefusals.push(action);
      }
    }
    expect(gateRefusals.sort()).toEqual(['clone_grid', 'delete_grid']);
    const audit = runtime.store.listAudit(200) as { action: string; subject: string }[];
    // Nothing admin was forwarded, and the two the route carries are audited.
    expect(audit.filter((a) => a.action === 'designer_plugin_action')).toHaveLength(0);
    expect(audit.filter((a) => a.action === 'survival_refused').map((a) => a.subject).sort()).toEqual([
      'clone_grid',
      'delete_grid',
    ]);
  });

  it('survival: an honest non-cheat action is NOT refused by the gate', async () => {
    runtime = await boot(hostedEnv);
    const res = await httpRequest<{ error?: { code?: string } }>(
      PORT,
      'POST',
      '/api/demo/designer/plugin',
      { action: 'identity', params: {} },
      TOKEN,
    );
    // It fails at the transport (no plugin), not at the policy.
    expect(res.body.error?.code ?? null).not.toBe('survival_mode');
    expect(res.body.error?.code).toBe('plugin_offline');
  });

  it('survival: a process with no RTS_ENV at all cannot boot the demo runtime', () => {
    // Step 4: without RTS_ENV=test the demo routes are never mounted, so there
    // is no admin action to refuse - the boot lock still holds. Only the MARKER
    // stopped being a boot requirement (T74).
    expect(() => resolveDemoEnv({ RTS_DEMO: '1' })).toThrow(/RTS_ENV/);
    const markerOnly = resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: 'test' });
    expect(markerOnly?.testLocked).toBe(false);
    expect(markerOnly?.badge).toMatch(/SURVIVAL MODE/);
    expect(resolveSurvivalMode({})).toBe(true);
    expect(resolveSurvivalMode({ RTS_ENV: 'test' })).toBe(true);
    expect(resolveDemoEnv({ RTS_DEMO: '1', RTS_ENV: 'test', RTS_TEST_SERVER_MARKER: 'se-rts-test' })?.testLocked).toBe(true);
  });

  it('survival: the designer execute route refuses fillWithClones', async () => {
    runtime = await boot(hostedEnv);
    const res = await rawPost(PORT, '/api/demo/designer/execute', { optionId: 'nope', launch: 'orbital', fillWithClones: true }, TOKEN);
    expect(res.status).toBe(409);
    const error = (res.json as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('survival_mode');
    expect(error.message).toMatch(/fillWithClones/);
  });

  it('test env: the same proxy accepts an allow-listed non-cheat action past the survival gate', async () => {
    runtime = await boot(testEnv);
    // The plugin is not connected, so the call fails at the transport, but the
    // refusal must NOT be survival_mode: that is the difference this pins.
    const res = await httpRequest<{ error: { code: string; message: string } }>(
      PORT,
      'POST',
      '/api/demo/designer/plugin',
      { action: 'clone_grid', params: {} },
      TOKEN,
    );
    expect(res.body.error?.code ?? null).not.toBe('survival_mode');
  });

  it('survival: the designer execute route does not refuse fillWithClones=false', async () => {
    runtime = await boot(hostedEnv);
    const res = await httpRequest<{ error?: { code: string } }>(
      PORT,
      'POST',
      '/api/demo/designer/execute',
      { optionId: 'missing-option', launch: 'orbital', fillWithClones: false },
      TOKEN,
    );
    // 404 no_plan / 400 invalid is fine; survival_mode is not.
    expect(res.body.error?.code).not.toBe('survival_mode');
  });
});

/**
 * T77: the survival loop's `testIgnoreReach` setting is refused by a survival
 * backend (409 survival_mode + audit) and accepted on the marked test world,
 * which is the only place BASE-01's missing antenna can be bypassed.
 */
describe('T77 testIgnoreReach: settings route policy', () => {
  let runtime: Runtime | null = null;
  // Its own port: a 409 body read on the shared port leaves a socket that the
  // next boot in the same file trips over (socket hang up).
  const PORT77 = PORT + 7;

  async function boot(env: () => void): Promise<Runtime> {
    restoreEnv();
    env();
    process.env.RTS_TOKEN = TOKEN;
    const clock = makeClock();
    const rt = createRuntime({ config: makeConfig({ port: PORT, token: TOKEN }), clock: clock.now, memory: true });
    await rt.listen(PORT77);
    return rt;
  }

  afterEach(async () => {
    if (runtime) await runtime.close();
    runtime = null;
    restoreEnv();
  });

  afterAll(() => restoreEnv());

  it('survival: the override is 409 survival_mode + audited, a normal write still works', async () => {
    runtime = await boot(hostedEnv);
    const res = await rawPost(PORT77, '/api/demo/survival/settings', { testIgnoreReach: true }, TOKEN);
    expect(res.status).toBe(409);
    const body = res.json as { error?: { code?: string } };
    expect(body.error?.code).toBe('survival_mode');
    // The attempt is audited, never silently dropped.
    const audit = await httpRequest<{ entries?: { action: string; detail?: Record<string, unknown> }[] }>(
      PORT77, 'GET', '/api/audit?limit=50', undefined, TOKEN,
    );
    const rows = (audit.body.entries ?? []).filter((r) => r.action === 'survival_refused');
    expect(rows.some((r) => r.detail?.flag === 'testIgnoreReach')).toBe(true);
    // Only the override is refused: the loop's ordinary settings still write.
    const normal = await rawPost(PORT77, '/api/demo/survival/settings', { testIgnoreReach: false }, TOKEN);
    expect(normal.status).toBe(200);
  });

  it('the verdict table: allowed only on the marked test world', () => {
    // Not requested: nothing changes anywhere.
    expect(decideTestIgnoreReach({ requested: false, survivalMode: true, demoEnv: false }).allow).toBe(true);
    // Survival: refused with the survival code, whatever the request.
    const refused = decideTestIgnoreReach({ requested: true, survivalMode: true, demoEnv: true });
    expect(refused.allow).toBe(false);
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('survival_mode');
    // Demo off (hosted, not the marked world): also refused, different code.
    const noDemo = decideTestIgnoreReach({ requested: true, survivalMode: false, demoEnv: false });
    expect(noDemo.allow).toBe(false);
    expect(noDemo.code).toBe('admin_override_not_allowed');
    // The marked test world: the only place it is accepted.
    expect(decideTestIgnoreReach({ requested: true, survivalMode: false, demoEnv: true }).allow).toBe(true);
  });

});
