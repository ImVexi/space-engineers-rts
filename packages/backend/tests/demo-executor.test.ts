import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { evaluateGate } from '../src/demo/gate.js';
import { seedWorld } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import type { FeatureFlag } from '../src/config.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { makeConfig } from './helpers.js';

function makeStore(flags: Partial<Record<FeatureFlag, boolean>> = {}) {
  const config = makeConfig({ flags: { demo_execute: true, ...flags } });
  const db = openDb(':memory:', { memory: true });
  const store = new Store(db);
  const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  store.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true, ...flags });
  return { store, config };
}

function fakeHub(sent: Record<string, unknown>[]) {
  return {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
  } as never;
}

const NOW = 1_800_000_000_000;

describe('authority gate (SIMULATED link source)', () => {
  it('allows a fresh grid that is planner-reachable from a control source', () => {
    const { store } = makeStore();
    const world = seedWorld(NOW);
    const hq = world.nodes.find((n) => n.controlSource)!;
    store.upsertUnit({
      id: 'grid:near',
      name: 'near',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z },
      vel: null,
      meta: { prefab: 'Eradicator_mk.1' },
    });
    const gate = evaluateGate({ store, world, now: NOW, nodeId: 'grid:near' });
    expect(gate.allowed).toBe(true);
    expect(gate.source).toBe('SIMULATED');
    expect(gate.gameLink).toBe('up');
    expect(gate.plannerPath).toBe(true);
  });

  it('rejects a fresh grid with no planner path to a control source', () => {
    const { store } = makeStore();
    const world = seedWorld(NOW);
    store.upsertUnit({
      id: 'grid:far',
      name: 'far',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: { x: 4_000_000, y: 0, z: 0 },
      vel: null,
      meta: { prefab: 'Eradicator_mk.1' },
    });
    const gate = evaluateGate({ store, world, now: NOW, nodeId: 'grid:far' });
    expect(gate.allowed).toBe(false);
    expect(gate.plannerPath).toBe(false);
    expect(gate.reason).toMatch(/no planner path/i);
  });

  it('rejects stale telemetry even when the planner path exists', () => {
    const { store } = makeStore();
    const world = seedWorld(NOW);
    const hq = world.nodes.find((n) => n.controlSource)!;
    store.upsertUnit({
      id: 'grid:stale',
      name: 'stale',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW - 120_000,
      pos: hq.position,
      vel: null,
      meta: { prefab: 'Eradicator_mk.1' },
    });
    const gate = evaluateGate({ store, world, now: NOW, nodeId: 'grid:stale' });
    expect(gate.allowed).toBe(false);
    expect(gate.source).toBe('GAME');
    expect(gate.reason).toMatch(/stale/i);
  });

  it('allows virtual fixture nodes and rejects unknown ids', () => {
    const { store } = makeStore();
    const world = seedWorld(NOW);
    const virtual = evaluateGate({ store, world, now: NOW, nodeId: 'earthlike-hq' });
    expect(virtual.allowed).toBe(true);
    expect(virtual.virtual).toBe(true);
    expect(virtual.labels).toContain('SIMULATED');

    const unknown = evaluateGate({ store, world, now: NOW, nodeId: 'grid:nope' });
    expect(unknown.allowed).toBe(false);
  });
});

describe('demo executor', () => {
  function connectMission(store: Store, count: number) {
    const result = createMission(
      store,
      {
        type: 'build_deploy',
        priority: 60,
        desiredState: {
          shipSpec: 'relay-chain-radio',
          station: 'chain:EarthLike:Moon:radio',
          formation: 'line',
          qty: count,
          position: { x: 0, y: 0, z: 60_000 },
        },
        budget: { resources: {}, timeMin: 60, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [],
        plan: {
          steps: [
            { id: 'validate', kind: 'validate_spec', params: {}, done: false },
            ...Array.from({ length: count }, (_, i) => ({
              id: `deploy-${i}`,
              kind: 'print',
              params: {
                prefab: 'Eradicator_mk.1',
                role: 'radio-relay',
                position: { x: 0, y: 0, z: 60_000 + 45_000 * (i + 1) },
              },
              done: false,
            })),
            { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
          ],
          notes: '[SIMULATED] test',
        },
      },
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!result.ok) throw new Error(result.message);
    return result.mission;
  }

  it('caps a mission at 6 drones and marks the rest skipped', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store, 9);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    const summary = executor.summary() as {
      executions: { total: number; cap: number; counts: { skipped: number; queued: number }; scaled: boolean }[];
    };
    expect(summary.executions).toHaveLength(1);
    expect(summary.executions[0]!.total).toBe(9);
    expect(summary.executions[0]!.cap).toBe(6);
    expect(summary.executions[0]!.counts.queued).toBe(6);
    expect(summary.executions[0]!.counts.skipped).toBe(3);
    expect(summary.executions[0]!.scaled).toBe(true);
  });

  it('sends spawn first, with orientation and a unique name, then moves only through the gate', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store, 2);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.tick();

    const spawn = sent.find((m) => (m.params as Record<string, unknown>)?.action === 'spawn_prefab');
    expect(spawn).toBeTruthy();
    const params = spawn!.params as Record<string, unknown>;
    expect(params.prefab).toBe('Eradicator_mk.1');
    expect(params.name).toMatch(/^demo-/);
    const up = params.up as { x: number; y: number; z: number };
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 3);
    // No flight order before the grid exists.
    expect(sent.some((m) => m.orderType === 'move')).toBe(false);
  });

  it('advances the securing chain from the step column, never from the reason note', () => {
    // Regression: setState() writes the human note into `reason`, so reading the
    // securing sub-step from `reason` stalled every drone in `securing` forever.
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    executor.sync(NOW);
    // One tick while queued loads the cached identity from kv (numeric Steam id).
    executor.tick();
    store.db
      .prepare(`UPDATE demo_drones SET state = 'securing', grid_id = 'grid:test1', reason = 'grid grid:test1 found', pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`)
      .run(mission.id);
    sent.length = 0;
    executor.tick();
    const actions = sent.map((m) => (m.params as Record<string, unknown>).action);
    // The first securing action is now the READ-ONLY ownership check (the
    // takeover is only sent when the grid is not ours), but the point of this
    // regression stands: the chain advanced from the `step` column.
    expect(actions).toContain('ownership_check');
    expect(actions).not.toContain('list_grids');
    const row = store.db.prepare(`SELECT step FROM demo_drones WHERE mission_id = ?`).get(mission.id) as { step: string | null };
    expect(row.step).toBeNull();
  });

  it('hands hydrogen to staging after wake instead of leaving every thruster on', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    executor.sync(NOW);
    executor.tick();
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'securing', step = 'wake', grid_id = 'grid:test1',
           pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
      )
      .run(mission.id);

    sent.length = 0;
    executor.tick();
    const wake = sent.find((m) => (m.params as Record<string, unknown>).action === 'wake');
    expect(wake).toBeTruthy();

    const ack = (orderId: string) => {
      store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: 'order_result',
        detail: { eventType: 'order_result', data: { orderId, ok: true, result: { gridId: 'grid:test1' } } },
        at: NOW,
      });
    };
    ack(wake!.orderId as string);
    sent.length = 0;
    executor.tick();

    // The wake result must not go straight to ai_off: hydrogen is switched off
    // first, and staging owns it from that point (the plugin `wake` turns every
    // thruster on, which is what emptied SAT-L-0009's tank at ~9 km).
    const handoff = sent.find((m) => (m.params as Record<string, unknown>).action === 'set_block_props');
    expect(handoff).toBeTruthy();
    expect((handoff!.params as Record<string, unknown>).filter).toEqual({ type: 'Thruster', subtype: 'Hydrogen' });
    expect((handoff!.params as Record<string, unknown>).props).toEqual({ OnOff: false });
    expect(sent.some((m) => (m.params as Record<string, unknown>).action === 'ai_off')).toBe(false);

    ack(handoff!.orderId as string);
    sent.length = 0;
    executor.tick();
    expect(sent.map((m) => (m.params as Record<string, unknown>).action)).toContain('ai_off');
  });

  it('queues a new climb while the climb cap is saturated', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    executor.sync(NOW);
    executor.tick();
    const ready = () =>
      store.db
        .prepare(
          `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = 'grid:test1',
             pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
        )
        .run(mission.id);
    ready();
    const addClimbers = (n: number) => {
      store.db.prepare(`DELETE FROM demo_drones WHERE mission_id = 'other'`).run();
      for (let i = 0; i < n; i++) {
        store.db
          .prepare(
            `INSERT INTO demo_drones (mission_id, idx, label, prefab, plan_slot_json, exec_slot_json,
               spawn_json, state, grid_id, updated_at)
             VALUES ('other', ?, 'x', 'existing', '{}', '{}', '{}', 'en_route', ?, ?)`,
          )
          .run(i, `grid:other${i}`, NOW);
      }
    };

    addClimbers(3);
    sent.length = 0;
    executor.tick();
    expect(sent.some((m) => m.orderType === 'move')).toBe(false);
    const queued = store.db.prepare(`SELECT reason FROM demo_drones WHERE mission_id = ?`).get(mission.id) as {
      reason: string | null;
    };
    expect(String(queued.reason)).toMatch(/QUEUED: climb cap 3/);

    // One slot frees up: the same drone is admitted past the cap on the next
    // tick (it then waits on link telemetry in this fixture, which is enough to
    // prove the cap no longer holds it).
    addClimbers(2);
    sent.length = 0;
    executor.tick();
    const after = store.db.prepare(`SELECT reason FROM demo_drones WHERE mission_id = ?`).get(mission.id) as {
      reason: string | null;
    };
    expect(String(after.reason)).not.toMatch(/QUEUED: climb cap/);
  });

  it('does not send anything when the flag is off or the kill switch is on', () => {
    const off = makeStore({ demo_execute: false });
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store: off.store, hub: fakeHub(sent), config: off.config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(off.store, 1);
    off.store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.tick();
    expect(sent).toHaveLength(0);

    const on = makeStore();
    const sent2: Record<string, unknown>[] = [];
    const executor2 = new DemoExecutor({ store: on.store, hub: fakeHub(sent2), config: on.config, clock: () => NOW, fixturePath: null });
    const mission2 = connectMission(on.store, 1);
    on.store.updateMission(mission2.id, { status: 'approved' }, NOW);
    on.store.setKillSwitch(true);
    executor2.tick();
    expect(sent2).toHaveLength(0);
  });
describe('flight profile in the executor (contract §3)', () => {
  it('sends ONE move per leg and flips dampeners off for a vacuum coast', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const world = seedWorld(NOW);
    const hq = world.nodes.find((n) => n.controlSource)!;
    const start = { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z };
    const slot = { x: start.x + 5_000, y: start.y, z: start.z };
    store.upsertUnit({
      id: 'grid:coast',
      name: 'coast',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: start,
      vel: { x: 60, y: 0, z: 0 },
      meta: { prefab: 'Eradicator_mk.1', massKg: 20_000, fuelFraction: 0.9, powerFraction: 0.9 },
    });
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(now);
    // One queued tick caches the identity; then jump straight to the move step.
    executor.tick();
    sent.length = 0;
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = 'grid:coast', exec_slot_json = ?,
           pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
      )
      .run(JSON.stringify(slot), mission.id);

    // First tick sends the single move (plus the dampener flip, which is not a
    // move order) and a profile audit row.
    executor.tick();
    const moves = () => sent.filter((m) => m.orderType === 'move');
    expect(moves()).toHaveLength(1);
    const moveParams = moves()[0]!.params as { speed: number };
    expect(moveParams.speed).toBe(60);
    const dampeners = sent.find((m) => (m.params as Record<string, unknown>).action === 'set_dampeners');
    expect(dampeners).toBeTruthy();
    expect((dampeners!.params as Record<string, unknown>).on).toBe(false);
    const profileAudit = store
      .db.prepare(`SELECT detail FROM audit WHERE action = 'demo_leg_profile' LIMIT 1`)
      .get() as { detail: string } | undefined;
    expect(profileAudit).toBeTruthy();
    expect(JSON.parse(profileAudit!.detail)).toMatchObject({ dampeners: 'off', flightMode: 'OneWay' });

    // Coast: the ship closes 60 m/s. The required speed stays 60, so no new
    // move order is sent (the old executor re-sent on every guard delta).
    for (let i = 0; i < 10; i += 1) {
      now += 1_000;
      const pos = { x: start.x + 60 * (i + 1), y: start.y, z: start.z };
      store.upsertUnit({
        id: 'grid:coast', name: 'coast', specId: null, station: null, linkStatus: 'up',
        lastSeen: now, pos, vel: { x: 60, y: 0, z: 0 },
        meta: { prefab: 'Eradicator_mk.1', massKg: 20_000, fuelFraction: 0.9, powerFraction: 0.9 },
      });
      executor.tick();
    }
    expect(moves()).toHaveLength(1);
  });

  it('flies an unmeasured 37.6 t hull at the cap, not the 5 m/s arrival cap', () => {
    // Regression for the owner's crawl: a hull with no staging profile and a
    // mass outside the known 15–26 t family used to be pinned to 5 m/s for the
    // whole leg (the arrival cap applied from the start).
    const { store, config } = makeStore();
    config.demo.speedLimitMps = 100;
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const world = seedWorld(NOW);
    const hq = world.nodes.find((n) => n.controlSource)!;
    const start = { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z };
    const slot = { x: start.x + 5_000, y: start.y, z: start.z };
    // Telemetry prefab gives the comms gate a capability profile; the drone row
    // prefab is the unmeasured one the flight model sees.
    const meta = { prefab: 'Eradicator_mk.1', massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9 };
    store.upsertUnit({
      id: 'grid:unknown',
      name: 'unknown',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: start,
      vel: { x: 100, y: 0, z: 0 },
      meta,
    });
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(now);
    executor.tick();
    sent.length = 0;
    // The gate derives its capability from demo_drones.prefab; `existing:` makes
    // it fall back to the persisted radio map, which keeps the grid reachable
    // while the flight model still has no staging hardware for it.
    store.setKv('designer:gridRadios', JSON.stringify({ 'grid:unknown': 50_000 }));
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = 'grid:unknown', prefab = 'existing:grid:unknown',
           exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
      )
      .run(JSON.stringify(slot), mission.id);

    executor.tick();
    const moves = () => sent.filter((m) => m.orderType === 'move');
    expect(moves()).toHaveLength(1);
    const speed = (moves()[0]!.params as { speed: number }).speed;
    expect(speed).toBe(100);
    expect(speed).toBeGreaterThan(5);

    // Coast at 100 m/s for ten ticks: the cruise does not move, so the leg
    // keeps its single move order.
    for (let i = 0; i < 10; i += 1) {
      now += 1_000;
      store.upsertUnit({
        id: 'grid:unknown',
        name: 'unknown',
        specId: null,
        station: null,
        linkStatus: 'up',
        lastSeen: now,
        pos: { x: start.x + 100 * (i + 1), y: start.y, z: start.z },
        vel: { x: 100, y: 0, z: 0 },
        meta,
      });
      executor.tick();
    }
    expect(moves()).toHaveLength(1);
  });

});
});

describe('the securing handshake asks before it takes (2026-11-11 set 3)', () => {
  const GRID = 'grid:87929829394037977';
  const IDENTITY = '10000000000000001';

  /**
   * A move mission for a grid the executor must secure. The drone is dropped
   * straight onto the first securing sub-step, so each test drives exactly one
   * answer of the handshake.
   */
  function setup(survivalMode: boolean) {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const clock = { now: NOW };
    const executor = new DemoExecutor({
      store,
      hub: fakeHub(sent),
      config,
      clock: () => clock.now,
      fixturePath: null,
      survivalMode,
    });
    const result = createMission(
      store,
      {
        type: 'move',
        priority: 50,
        desiredState: {
          shipSpec: 'stand-in-grid',
          station: `move:${GRID.replace(/[^0-9]/g, '')}`,
          formation: 'none',
          position: { x: 0, y: 0, z: 60_000 },
          targetLabel: 'test slot',
          altitudeM: 100,
          planet: 'EarthLike',
        },
        budget: { resources: {}, timeMin: 60, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [GRID],
        plan: {
          steps: [
            { id: 'validate', kind: 'validate_spec', params: {}, done: false },
            { id: 'move', kind: 'move', params: { gridId: GRID, target: { x: 0, y: 0, z: 60_000 } }, done: false },
            { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq', action: 'move' }, done: false },
          ],
          notes: 'test: securing handshake',
        },
      },
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!result.ok) throw new Error(`${result.message}: ${JSON.stringify((result as { issues?: unknown }).issues ?? {})}`);
    const missionId = result.mission.id;
    store.updateMission(missionId, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', IDENTITY);
    executor.sync(NOW);
    executor.tick();
    store.db
      .prepare(
        `UPDATE demo_drones
           SET state = 'securing', step = 'ownership_check', grid_id = ?,
               pending_order = NULL, pending_action = NULL, pending_at = NULL
         WHERE mission_id = ?`,
      )
      .run(GRID, missionId);
    sent.length = 0;
    return { store, sent, clock, executor, missionId };
  }

  const pending = (store: Store, missionId: string) =>
    store.db
      .prepare(`SELECT pending_order, pending_action FROM demo_drones WHERE mission_id = ?`)
      .get(missionId) as { pending_order: string | null; pending_action: string | null };
  const droneRow = (store: Store, missionId: string) =>
    store.db.prepare(`SELECT state, reason, step FROM demo_drones WHERE mission_id = ?`).get(missionId) as {
      state: string;
      reason: string | null;
      step: string | null;
    };
  const actions = (sent: Record<string, unknown>[]) =>
    sent.map((m) => (m.params as Record<string, unknown> | undefined)?.action as string | undefined);

  /** The plugin's answer to one order (what `plugin_event` carries). */
  function answer(store: Store, orderId: string, result: Record<string, unknown>): void {
    store.audit({
      actor: 'fake-plugin',
      action: 'plugin_event',
      subject: orderId,
      detail: { eventType: 'order_result', data: { orderId, ok: true, result } },
      at: NOW,
    });
    store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
  }

  it('asks with the READ-ONLY ownership_check and never takes over a grid that is already ours', () => {
    const ctx = setup(false);
    ctx.executor.tick();
    expect(actions(ctx.sent)).toContain('ownership_check');
    expect(actions(ctx.sent)).not.toContain('ownership');
    const row = pending(ctx.store, ctx.missionId);
    expect(row.pending_action).toBe('ownership_check');
    answer(ctx.store, row.pending_order!, { applied: true });
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    // The takeover is an admin write and the grid was already ours: never sent.
    expect(actions(ctx.sent)).not.toContain('ownership');
    expect(droneRow(ctx.store, ctx.missionId).step).not.toBe('ownership');
    expect(droneRow(ctx.store, ctx.missionId).state).not.toBe('failed');
  });

  it('in survival, says plainly that the grid is not owned and never attempts the takeover', () => {
    const ctx = setup(true);
    ctx.executor.tick();
    expect(actions(ctx.sent)).toContain('ownership_check');
    expect(actions(ctx.sent)).not.toContain('ownership');
    const row = pending(ctx.store, ctx.missionId);
    answer(ctx.store, row.pending_order!, { applied: false });
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    const drone = droneRow(ctx.store, ctx.missionId);
    expect(drone.state).toBe('failed');
    expect(String(drone.reason)).toMatch(/not owned by you/);
    expect(String(drone.reason)).toMatch(/claimed in game/);
    expect(actions(ctx.sent)).not.toContain('ownership');
  });

  it('in the test world, still takes over a grid that is not ours and re-checks it', () => {
    const ctx = setup(false);
    ctx.executor.tick();
    const row = pending(ctx.store, ctx.missionId);
    answer(ctx.store, row.pending_order!, { applied: false });
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    expect(droneRow(ctx.store, ctx.missionId).step).toBe('ownership');
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    expect(actions(ctx.sent)).toContain('ownership');
  });
});
