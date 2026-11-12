import { afterAll, afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor, type ExecRow } from '../src/demo/executor.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { callPlugin } from '../src/demo/provision/provisioner.js';
import {
  NATIVE_ORDER_TYPES,
  PRODUCTION_ACTIONS,
  PRODUCTION_ORDER_TYPE,
  decideOrderChannel,
  isProductionAction,
  survivalChannelRefusal,
} from '../src/demo/channel.js';
import { ADMIN_ACTIONS, survivalRefusal } from '../src/demo/survival.js';
import { hintForCode } from '../src/demo/routes.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakePlugin } from './fakePlugin.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';

/**
 * T75 order channels.
 *
 * The live plugin build has no `test` channel at all, so a legitimate action
 * sent as `orderType: 'test'` dies on every hosted server. These tests pin the
 * backend half of the split: `action` carries legitimate actions in BOTH modes,
 * `test` keeps the admin cheats and is test-world only, and a survival refusal
 * happens before `hub.send` (with an audit row), never at the plugin.
 */

const NOW = 1_800_000_000_000;
const TOKEN = 't75-channel-token';

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER', 'RTS_TOKEN'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function survivalEnv(): void {
  // Hosted/vanilla: demo mounted, RTS_ENV=test as a copied service would run,
  // but NO test marker -> survival mode.
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  delete process.env.RTS_TEST_SERVER_MARKER;
}

function testEnv(): void {
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
}

const TEST_ONLY_ACTIONS = [
  'save',
  'damage',
  'wave',
  'reset',
  'reset_world',
  'despawn_state',
  'refill',
];

/**
 * 2026-11-11 reclassification: reads a player can make, HUD markers a player
 * can add, a grid's own autopilot switch, and ownership-guarded naming. None of
 * them spawns, deletes, teleports, refills or steals a grid, so they are
 * legitimate capabilities the executor/naming/players features need in
 * survival. They ride the PRODUCTION channel in both modes.
 */
const RECLASSIFIED_PRODUCTION = [
  'ai_off',
  'list_players',
  'gps_add',
  'gps_remove',
  'gps_list',
  'rename_grid',
  'dock_state',
  'planets',
  'suit_radio',
];

describe('T75 order channels: the rule', () => {
  it('names the production channel "action"', () => {
    expect(PRODUCTION_ORDER_TYPE).toBe('action');
  });

  it('lists every legitimate action and no admin action', () => {
    for (const action of [
      'inspect',
      'profile',
      'set_dampeners',
      'set_block_props',
      'land_ground',
      'land_at',
      'convert_to_station',
      'is_under_control',
      'probe_ground',
      'diag',
      'list_grids',
    ]) {
      expect(isProductionAction(action), action).toBe(true);
    }
    // Unknown/absent is never a production action.
    expect(isProductionAction('save')).toBe(false);
    expect(isProductionAction('')).toBe(false);
    expect(isProductionAction(null)).toBe(false);
    // The two sets must never overlap: an admin cheat may not ride the
    // channel the live build compiles.
    for (const admin of ADMIN_ACTIONS) {
      expect(PRODUCTION_ACTIONS.has(admin), admin).toBe(false);
    }
    // The production list is the bigger set and cannot quietly shrink.
    expect(PRODUCTION_ACTIONS.size).toBeGreaterThanOrEqual(35);
  });

  it('treats the reclassified reads/HUD/naming/ai_off actions as production', () => {
    expect(RECLASSIFIED_PRODUCTION.length).toBeGreaterThanOrEqual(9);
    for (const action of RECLASSIFIED_PRODUCTION) {
      // Never confused with an admin cheat: the sets are disjoint.
      expect(ADMIN_ACTIONS.has(action), action).toBe(false);
      expect(PRODUCTION_ACTIONS.has(action), action).toBe(true);
      for (const survivalMode of [true, false]) {
        const decision = decideOrderChannel('test', action, survivalMode);
        expect(decision.orderType, `${action} survival=${survivalMode}`).toBe('action');
        expect(decision.refused, `${action} survival=${survivalMode}`).toBe(false);
      }
    }
    // `save` is a server save: it stays on the test channel, by design.
    expect(PRODUCTION_ACTIONS.has('save')).toBe(false);
    expect(decideOrderChannel('test', 'save', true).refused).toBe(true);
  });

  it('sends a legitimate action as "action" in BOTH modes', () => {
    for (const survivalMode of [true, false]) {
      for (const action of ['inspect', 'set_dampeners', 'land_ground', 'profile']) {
        const decision = decideOrderChannel('test', action, survivalMode);
        expect(decision.orderType, `${action} survival=${survivalMode}`).toBe('action');
        expect(decision.refused).toBe(false);
        expect(decision.action).toBe(action);
      }
    }
  });

  it('refuses an admin action in survival, keeps it on "test" in the test world', () => {
    for (const action of [...ADMIN_ACTIONS, ...TEST_ONLY_ACTIONS]) {
      const survival = decideOrderChannel('test', action, true);
      expect(survival.refused, action).toBe(true);
      expect(survival.reason, action).toBe('survival_mode');
      expect(survival.orderType, action).toBe('test');

      const test = decideOrderChannel('test', action, false);
      expect(test.refused, action).toBe(false);
      expect(test.orderType, action).toBe('test');
    }
  });

  it('refuses an unknown action in survival rather than guessing a channel', () => {
    const decision = decideOrderChannel('test', 'not_a_real_action', true);
    expect(decision.refused).toBe(true);
    expect(decision.reason).toBe('survival_mode');
    expect(decideOrderChannel('test', null, true).refused).toBe(true);
  });

  it('passes native order types through unchanged', () => {
    for (const native of ['move', 'hold', 'stop', 'waypoint', 'drive', 'dock', 'undock', 'repair', 'laser']) {
      const decision = decideOrderChannel(native, null, true);
      expect(decision.orderType, native).toBe(native);
      expect(decision.refused, native).toBe(false);
    }
  });

  it('does not mutate the action set or the decision inputs', () => {
    const before = [...PRODUCTION_ACTIONS].sort();
    decideOrderChannel('test', 'spawn_prefab', true);
    decideOrderChannel('test', 'inspect', true);
    expect([...PRODUCTION_ACTIONS].sort()).toEqual(before);
  });

  it('gives a channel refusal the same body shape as survivalRefusal', () => {
    const refusal = survivalChannelRefusal('spawn_prefab');
    const route = survivalRefusal('spawn_prefab');
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('survival_mode');
    expect(refusal.reason).toBe('survival_mode');
    expect(refusal.message).toBe(route.message);
    expect(refusal.message).toMatch(/not available in survival build: spawn_prefab/);
    expect(refusal.action).toBe('spawn_prefab');
    expect(refusal.note).toBe(route.note);
  });
});

/**
 * End-to-end executor send: the station pass sends `is_under_control` (central
 * `send`) and then `set_dampeners` (a standalone payload builder), so one setup
 * covers both kind of site on the real wire.
 */
function executorSetup(survivalMode: boolean) {
  const config = makeConfig({ flags: { demo_execute: true } });
  const db = openDb(':memory:', { memory: true });
  const store = new Store(db);
  const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  store.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true });
  const sent: Record<string, unknown>[] = [];
  const hub = {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
  } as never;
  const executor = new DemoExecutor({ store, hub, config, clock: () => NOW, fixturePath: null, survivalMode });

  const missionId = `channel-${survivalMode ? 'survival' : 'test'}`;
  db.prepare(
    `INSERT INTO demo_exec (mission_id, state, scaled, total, cap, note, created_at, updated_at)
     VALUES (?, 'executing', 0, 1, 10, NULL, ?, ?)`,
  ).run(missionId, NOW - 60_000, NOW - 60_000);
  store.upsertUnit({
    id: 'grid:channel-1',
    name: 'channel-1',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: 0, y: 0, z: 62_000 },
    vel: { x: 1.4, y: 0, z: 0 },
    meta: {},
  });
  db.prepare(
    `INSERT INTO demo_drones (mission_id, idx, label, prefab, role, planet, plan_slot_json, exec_slot_json,
        spawn_json, state, grid_id, attempts, reason, pending_order, pending_action, pending_at, hold_at,
        stop_sent_at, updated_at, step)
     VALUES (?, 0, 'channel-1', 'existing', 'relay', NULL, '{}', '{}', '{}', 'holding', 'grid:channel-1', 0, NULL,
        NULL, NULL, NULL, ?, NULL, ?, NULL)`,
  ).run(missionId, NOW - 120_000, NOW);
  const exec: ExecRow = {
    missionId,
    state: 'executing',
    scaled: false,
    total: 1,
    cap: 10,
    note: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
  };
  return { store, executor, sent, exec };
}

function answerOrder(store: Store, sent: Record<string, unknown>[], result: unknown): void {
  const last = sent[sent.length - 1] as { orderId?: string } | undefined;
  if (!last?.orderId) return;
  const applied = store.db.prepare(`UPDATE orders SET status = 'acked' WHERE order_id = ?`).run(last.orderId);
  if (applied.changes === 0) return;
  store.audit({
    actor: 'fake-plugin',
    action: 'plugin_event',
    subject: last.orderId,
    detail: { eventType: 'order_result', data: { orderId: last.orderId, ok: true, error: null, result } },
    at: NOW,
  });
}

describe('T75 order channels: the executor wire', () => {
  afterEach(() => restoreEnv());

  it('survival: legitimate actions leave as orderType "action"', () => {
    const { store, executor, sent, exec } = executorSetup(true);
    // Pass 1 sends the is_under_control probe through send().
    executor.stationPass(exec, NOW);
    const probe = sent[0] as { orderType: string; params: { action: string } };
    expect(probe.orderType).toBe('action');
    expect(probe.params.action).toBe('is_under_control');
    // The stored order record uses the same channel as the wire.
    const stored = store.db
      .prepare(`SELECT order_type FROM orders WHERE order_id = ?`)
      .get((sent[0] as { orderId: string }).orderId) as { order_type: string };
    expect(stored.order_type).toBe('action');
    answerOrder(store, sent, { underControl: false });
    sent.length = 0;

    // Pass 2 starts the stop with set_dampeners (standalone payload builder).
    executor.stationPass(exec, NOW + 1_000);
    const damp = sent[0] as { orderType: string; params: { action: string } };
    expect(damp.orderType).toBe('action');
    expect(damp.params.action).toBe('set_dampeners');
  });

  it('test env: the same legitimate action also leaves as "action" (never "test")', () => {
    const { store, executor, sent, exec } = executorSetup(false);
    executor.stationPass(exec, NOW);
    const probe = sent[0] as { orderType: string; params: { action: string } };
    expect(probe.orderType).toBe('action');
    expect(probe.params.action).toBe('is_under_control');
    answerOrder(store, sent, { underControl: false });
    sent.length = 0;

    // The test world's stop is still the admin zero_velocity, which keeps the
    // test channel: the split must not move an admin cheat onto production.
    executor.stationPass(exec, NOW + 1_000);
    const zero = sent[0] as { orderType: string; params: { action: string } };
    expect(zero.params.action).toBe('zero_velocity');
    expect(zero.orderType).toBe('test');
  });
});

/** A hub double that records frames and answers every order synchronously. */
function recordingHub(store: Store) {
  const sent: Record<string, unknown>[] = [];
  const hub = {
    isConnected: () => true,
    agentId: () => 'fake-plugin',
    send: (message: unknown) => {
      const frame = message as { orderId?: string };
      sent.push(frame as Record<string, unknown>);
      store.audit({
        actor: 'fake-plugin',
        action: 'plugin_event',
        subject: String(frame.orderId ?? ''),
        detail: { eventType: 'order_result', data: { orderId: frame.orderId, ok: true, error: null, result: { ok: true } } },
        at: NOW,
      });
      return true;
    },
  } as never;
  return { hub, sent };
}

function provisionDeps(store: Store, hub: unknown) {
  return { config: makeConfig(), store, hub: hub as never, clock: () => NOW };
}

describe('T75 order channels: an admin action never reaches hub.send in survival', () => {
  afterEach(() => restoreEnv());

  it('survival: callPlugin refuses teleport before the wire and audits it', async () => {
    survivalEnv();
    const db = openDb(':memory:', { memory: true });
    const store = new Store(db);
    const { hub, sent } = recordingHub(store);
    await expect(callPlugin(provisionDeps(store, hub), 'teleport', { gridId: 'grid:x' }, 1_000)).rejects.toMatchObject({
      status: 409,
      code: 'survival_mode',
      message: expect.stringContaining('not available in survival build: teleport'),
    });
    expect(sent).toHaveLength(0);
    const refused = (store.listAudit(50) as { action: string; subject: string; detail: Record<string, unknown> }[]).filter(
      (a) => a.action === 'survival_refused',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({
      action: 'teleport',
      reason: 'survival_mode',
      note: 'no order was sent to the plugin',
    });
  });

  it('test env: the same admin action keeps its test channel', async () => {
    testEnv();
    const db = openDb(':memory:', { memory: true });
    const store = new Store(db);
    const { hub, sent } = recordingHub(store);
    const result = await callPlugin(provisionDeps(store, hub), 'teleport', { gridId: 'grid:x' }, 1_000);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { orderType: string }).orderType).toBe('test');
    expect(store.listAudit(50).filter((a) => a.action === 'survival_refused')).toHaveLength(0);
  });

  it('both modes: a legitimate action (identity) leaves on the production channel', async () => {
    for (const env of [survivalEnv, testEnv]) {
      env();
      const db = openDb(':memory:', { memory: true });
      const store = new Store(db);
      const { hub, sent } = recordingHub(store);
      await callPlugin(provisionDeps(store, hub), 'identity', {}, 1_000);
      expect((sent[0] as { orderType: string }).orderType).toBe('action');
    }
  });
});

/** Raw node:http for a 409 with a body (undici reports EPIPE on this box). */
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

describe('T75 order channels: routes', () => {
  let runtime: Runtime | null = null;
  let plugin: FakePlugin | null = null;

  async function boot(env: () => void, port: number, withPlugin: boolean): Promise<Runtime> {
    restoreEnv();
    env();
    process.env.RTS_TOKEN = TOKEN;
    const clock = makeClock();
    const rt = createRuntime({ config: makeConfig({ port, token: TOKEN }), clock: clock.now, memory: true });
    await rt.listen(port);
    if (withPlugin) {
      plugin = await FakePlugin.connect(port, { token: TOKEN });
      plugin.hello();
      await plugin.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
    }
    return rt;
  }

  afterEach(async () => {
    if (plugin) await plugin.close();
    plugin = null;
    if (runtime) await runtime.close();
    runtime = null;
    restoreEnv();
  });

  afterAll(() => restoreEnv());

  it('survival: POST /api/test/order is 409 survival_mode before anything is sent', async () => {
    runtime = await boot(survivalEnv, 8861, false);
    const res = await rawPost(
      8861,
      '/api/test/order',
      { orderType: 'test', entityId: 'grid:x', params: { action: 'identity' } },
      TOKEN,
    );
    expect(res.status).toBe(409);
    const error = (res.json as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('survival_mode');
    expect(error.message).toMatch(/not available in survival build/);
    expect(error.message).toMatch(/\/api\/test\/order/);
    const audit = runtime.store.listAudit(100) as { action: string; detail: Record<string, unknown> }[];
    expect(audit.filter((a) => a.action === 'test_order_sent')).toHaveLength(0);
    const refused = audit.filter((a) => a.action === 'survival_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({ route: '/api/test/order', reason: 'survival_mode' });
  });

  it('test env: POST /api/test/order still works (test channel and the new action type)', async () => {
    runtime = await boot(testEnv, 8862, true);
    const viaTest = await httpRequest<{ sent: boolean; orderType: string }>(
      8862,
      'POST',
      '/api/test/order',
      { orderType: 'test', entityId: 'grid:x', params: { action: 'identity' } },
      TOKEN,
    );
    expect(viaTest.status).toBe(200);
    expect(viaTest.body.sent).toBe(true);
    expect(viaTest.body.orderType).toBe('test');

    // The schema now accepts the production channel too.
    const viaAction = await httpRequest<{ sent: boolean; orderType: string; orderId: string }>(
      8862,
      'POST',
      '/api/test/order',
      { orderType: 'action', entityId: 'grid:x', params: { action: 'stop' } },
      TOKEN,
    );
    expect(viaAction.status).toBe(200);
    expect(viaAction.body.orderType).toBe('action');
    const received = await plugin!.nextMessage((m) => m.type === 'order' && m.orderId === viaAction.body.orderId);
    expect(received.orderType).toBe('action');
  });

  it('survival: ignoreReach on POST /api/demo/move-to is 409 survival_mode + audit', async () => {
    runtime = await boot(survivalEnv, 8863, false);
    const res = await rawPost(
      8863,
      '/api/demo/move-to',
      { gridId: 'grid:x', target: { gps: { x: 0, y: 0, z: 62_000 } }, ignoreReach: true, dryRun: true },
      TOKEN,
    );
    expect(res.status).toBe(409);
    const error = (res.json as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('survival_mode');
    expect(error.message).toMatch(/not available in survival build: ignoreReach admin override/);
    const refused = (runtime.store.listAudit(100) as { action: string; detail: Record<string, unknown> }[]).filter(
      (a) => a.action === 'survival_refused',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({ route: '/api/demo/move-to', flag: 'ignoreReach' });
  });

  it('test env: the same ignoreReach request passes the survival gate', async () => {
    runtime = await boot(testEnv, 8864, false);
    const res = await rawPost(
      8864,
      '/api/demo/move-to',
      { gridId: 'grid:no-telemetry', target: { gps: { x: 0, y: 0, z: 62_000 } }, ignoreReach: true, dryRun: true },
      TOKEN,
    );
    // It fails on the missing telemetry (404 unknown_grid), never on policy.
    expect(res.status).toBe(404);
    expect((res.json as { error: { code: string } }).error.code).toBe('unknown_grid');
  });

  it('survival: the designer execute route refuses ignoreReach', async () => {
    runtime = await boot(survivalEnv, 8865, false);
    const res = await rawPost(
      8865,
      '/api/demo/designer/execute',
      { optionId: 'x', launch: 'orbital', ignoreReach: true },
      TOKEN,
    );
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('survival_mode');
    const refused = (runtime.store.listAudit(100) as { action: string; subject: string }[]).filter(
      (a) => a.action === 'survival_refused',
    );
    expect(refused.map((r) => r.subject)).toContain('ignoreReach');
  });
});

describe('T75 order channels: owner hint text', () => {
  it('survival comms_denied names the antenna fix and never the override', () => {
    const hint = hintForCode('comms_denied', { survivalMode: true });
    expect(hint).toMatch(/antenna/i);
    expect(hint).toContain('[HERMES-BASE]');
    expect(hint).not.toMatch(/Admin override/i);
  });

  it('survival not_reachable drops the override advice', () => {
    expect(hintForCode('not_reachable', { survivalMode: true })).not.toMatch(/Admin override/i);
  });

  it('the test world keeps the override advice', () => {
    expect(hintForCode('comms_denied', { survivalMode: false })).toMatch(/Admin override/);
    expect(hintForCode('not_reachable', { survivalMode: false })).toMatch(/Admin override/);
  });
});

/**
 * The plugin's table is the other half of the rule: a name the backend calls
 * "production" that the live build does not classify as production would be
 * sent as `action` and refused at the plugin - exactly the failure the survival
 * rehearsal found. Both tables are plain name lists, so a drift guard is cheap:
 * parse src/ActionChannel.cs and compare.
 */
describe('T75 order channels: the plugin table agrees', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', '..', 'plugin', 'HermesRts.Plugin', 'src', 'ActionChannel.cs'),
    'utf8',
  );

  function namesIn(field: string): string[] {
    const match = new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
    if (!match) throw new Error(`could not find ${field} in ActionChannel.cs`);
    return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  }

  it('classifies exactly the backend production actions as production', () => {
    const plugin = new Set(namesIn('ProductionNames'));
    const backend = new Set(PRODUCTION_ACTIONS);
    const missing = [...backend].filter((a) => !plugin.has(a));
    // A native order type (waypoint/drive/dock/undock) is served by the
    // plugin's own executor, not by an `action` frame, so it may sit in the
    // plugin table without the backend ever naming it as an action.
    const extra = [...plugin].filter((a) => !backend.has(a) && !NATIVE_ORDER_TYPES.has(a));
    expect(missing, `backend sends but the plugin refuses: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `plugin serves but the backend never sends: ${extra.join(', ')}`).toEqual([]);
  });

  it('knows every admin action as admin (and never as production)', () => {
    const pluginAdmin = new Set(namesIn('AdminNames'));
    const pluginProduction = new Set(namesIn('ProductionNames'));
    for (const action of ADMIN_ACTIONS) {
      expect(pluginAdmin.has(action), action).toBe(true);
      expect(pluginProduction.has(action), action).toBe(false);
    }
  });

  it('names the same channel and the same refusal wording', () => {
    expect(source).toContain(`ProductionOrderType = "${PRODUCTION_ORDER_TYPE}"`);
    expect(source).toContain('UnavailablePrefix = "not available in survival build: "');
  });
});
