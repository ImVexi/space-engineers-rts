import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { seedWorld } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { StagingController } from '../src/demo/staging/controller.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
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

function mission(store: Store) {
  const result = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: { shipSpec: 'relay-chain-radio', station: 'chain:EarthLike:Moon:radio', formation: 'line', qty: 1 },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      idempotencyKey: `mh-${Math.random().toString(36).slice(2)}`,
      assignedUnits: [],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: {}, done: false },
          { id: 'deploy-0', kind: 'print', params: { prefab: 'Eradicator_mk.1', role: 'radio-relay', position: { x: 0, y: 0, z: 60_000 } }, done: false },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] manual-handoff test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/** Unit telemetry next to the control source so the comms gate passes. */
function placeGrid(store: Store, gridId: string, meta: Record<string, unknown>, now = NOW) {
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  store.upsertUnit({
    id: gridId,
    name: gridId,
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: now,
    pos: { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z },
    vel: { x: 0, y: 0, z: 0 },
    meta: { prefab: 'Eradicator_mk.1', massKg: 20_000, fuelFraction: 0.9, powerFraction: 0.9, ...meta },
  });
}

function readyToMove(store: Store, missionId: string, gridId: string) {
  store.setKv('demo:identityId', '10000000000000001');
  store.db
    .prepare(
      `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = ?,
         pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
    )
    .run(gridId, missionId);
}

describe('T27 manual handoff', () => {
  it('sends no order, marks the drone manual, pauses the mission and skips staging', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const m = mission(store);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(now);
    placeGrid(store, 'grid:piloted', { underControl: true, controlledBy: 'the owner' });
    executor.tick(); // queued pass caches the test identity
    readyToMove(store, m.id, 'grid:piloted');
    sent.length = 0;

    executor.tick();

    expect(sent.filter((x) => x.orderType === 'move' || x.orderType === 'hold' || x.orderType === 'stop')).toHaveLength(0);
    expect(sent.filter((x) => (x.params as Record<string, unknown>)?.action === 'set_block_props')).toHaveLength(0);
    const row = store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(m.id) as { state: string; reason: string };
    expect(row.state).toBe('manual');
    expect(row.reason).toBe('manual control by player');
    expect(store.getMission(m.id)!.status).toBe('paused');
    expect(store.getMission(m.id)!.pauseReason).toBe('manual control by player');
    const summary = executor.summary() as {
      manualControl: { gridId: string }[];
      executions: { counts: { manual: number } }[];
    };
    expect(summary.manualControl.map((c) => c.gridId)).toContain('grid:piloted');
    expect(summary.executions[0]!.counts.manual).toBe(1);
  });

  it('does not resume after the pilot releases control: only a new mission flies', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const m = mission(store);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(now);
    placeGrid(store, 'grid:piloted', { underControl: true });
    executor.tick(); // queued pass caches the test identity
    readyToMove(store, m.id, 'grid:piloted');
    executor.tick();
    // The manual pass asked the plugin once (read-only) and sent no flight order.
    const probe = sent.find((x) => (x.params as Record<string, unknown>)?.action === 'is_under_control');
    expect(probe).toBeTruthy();
    expect(sent.filter((x) => x.orderType === 'move')).toHaveLength(0);
    sent.length = 0;

    // The pilot leaves the cockpit and the plugin answers the outstanding probe
    // through the normal order_result path. The mark clears, but the paused
    // mission must never resume by itself.
    now += 6_000;
    placeGrid(store, 'grid:piloted', {}, now);
    store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: {
        eventType: 'order_result',
        data: { orderId: String(probe!.orderId), ok: true, result: { underControl: false } },
      },
      at: now,
    });
    executor.tick();
    sent.length = 0;
    now += 1_000;
    executor.tick();
    expect(sent.filter((x) => x.orderType === 'move')).toHaveLength(0);
    expect(store.getMission(m.id)!.status).toBe('paused');
    const row = store.db.prepare(`SELECT state FROM demo_drones WHERE mission_id = ?`).get(m.id) as { state: string };
    expect(row.state).toBe('manual');

    // Releasing clears the grid mark so a future owner order is not blocked…
    const summary = executor.summary() as { manualControl: { gridId: string }[] };
    expect(summary.manualControl.map((c) => c.gridId)).not.toContain('grid:piloted');
    // …but the paused mission and its manual row are never auto-resumed.
    expect(store.getMission(m.id)!.status).toBe('paused');
    expect(row.state).toBe('manual');
    expect(sent.filter((x) => x.orderType === 'move' || x.orderType === 'hold' || x.orderType === 'stop')).toHaveLength(0);
  });

  it('normal behaviour when the grid is not under control', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const m = mission(store);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(NOW);
    placeGrid(store, 'grid:free', { underControl: false });
    executor.tick(); // queued pass caches the test identity
    readyToMove(store, m.id, 'grid:free');
    sent.length = 0;
    executor.tick();
    expect(sent.some((x) => x.orderType === 'move')).toBe(true);
    const row = store.db.prepare(`SELECT state FROM demo_drones WHERE mission_id = ?`).get(m.id) as { state: string };
    expect(row.state).toBe('en_route');
  });

  it('staging.suspend stops writes for a grid and reports the manual mode', () => {
    const { store } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const staging = new StagingController({ store, send: (p) => (sent.push(p), true) });
    staging.tick({
      missionId: 'm1',
      idx: 0,
      label: 'grid:x',
      prefab: 'Eradicator_mk.1',
      gridId: 'grid:x',
      state: 'en_route',
      unit: null,
      planet: null,
      now: NOW,
    });
    staging.suspend('grid:x', 'manual control by player');
    expect((staging.view('grid:x') as { mode: string }).mode).toBe('manual');
    sent.length = 0;
    staging.tick({
      missionId: 'm1',
      idx: 0,
      label: 'grid:x',
      prefab: 'Eradicator_mk.1',
      gridId: 'grid:x',
      state: 'en_route',
      unit: null,
      planet: null,
      now: NOW + 5_000,
    });
    expect(sent).toHaveLength(0);
    // A new explicit mission for the same grid releases the latch; the grid is
    // evaluated again (here: no planet telemetry, so still nothing is written).
    staging.tick({
      missionId: 'm2',
      idx: 0,
      label: 'grid:x',
      prefab: 'Eradicator_mk.1',
      gridId: 'grid:x',
      state: 'en_route',
      unit: null,
      planet: null,
      now: NOW + 20_000,
    });
    expect((staging.view('grid:x') as { mode: string }).mode).toBe('no-telemetry');
    expect(sent).toHaveLength(0);
  });
});
