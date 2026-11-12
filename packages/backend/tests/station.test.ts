import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import type { FeatureFlag } from '../src/config.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { makeConfig } from './helpers.js';
import { planetByName } from '../src/demo/world.js';
import {
  DEFAULT_STATION_CONFIG,
  convertToStationOrder,
  stationDecision,
  stationLine,
  type StationInput,
} from '../src/demo/station.js';

const NOW = 1_800_000_000_000;

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

function connectMission(store: Store) {
  const result = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: {
        shipSpec: 'relay-chain-radio',
        station: 'chain:EarthLike:Moon:radio',
        formation: 'line',
        qty: 1,
        position: { x: 0, y: 0, z: 60_000 },
      },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: [],
      plan: {
        steps: [
          {
            id: 'deploy-0',
            kind: 'print',
            params: { prefab: 'Eradicator_mk.1', role: 'radio-relay', position: { x: 0, y: 0, z: 60_000 } },
            done: false,
          },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] station test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  return result.mission;
}

function ack(store: Store, orderId: string, result: unknown, ok = true, error?: string): void {
  store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
  store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: { eventType: 'order_result', data: { orderId, ok, result, ...(error ? { error } : {}) } },
    at: NOW,
  });
}

/** Latest order for the drone, optionally filtered by plugin action. */
function lastOrder(store: Store, missionId: string, action?: string) {
  const rows = store.listOrders(missionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const params = (row.payload as { params?: { action?: unknown } } | undefined)?.params;
    if (!action || String(params?.action) === action) return row;
  }
  return null;
}

function droneRow(store: Store, missionId: string) {
  return store.db
    .prepare(`SELECT state, step, reason FROM demo_drones WHERE mission_id = ?`)
    .get(missionId) as { state: string; step: string | null; reason: string | null };
}

function baseInput(over: Partial<StationInput> = {}): StationInput {
  return {
    enabled: true,
    state: 'holding',
    holdMs: 45_000,
    speedMps: 0.1,
    aglM: 7_000,
    hasPendingOrder: false,
    underControl: false,
    isStatic: false,
    alreadyStationed: false,
    config: DEFAULT_STATION_CONFIG,
    ...over,
  };
}

describe('station policy (T19)', () => {
  it('stations a stable holding drone at 7 km', () => {
    const d = stationDecision(baseInput());
    expect(d.action).toBe('station');
    expect(d.reason).toMatch(/7000|7,000|7 ?000/);
  });

  it('waits until the 30 s stability window has passed', () => {
    expect(stationDecision(baseInput({ holdMs: 5_000 })).action).toBe('wait');
    expect(stationDecision(baseInput({ holdMs: 29_999 })).action).toBe('wait');
    expect(stationDecision(baseInput({ holdMs: 30_000 })).action).toBe('station');
  });

  it('keeps waiting above the zeroing ceiling', () => {
    const d = stationDecision(baseInput({ speedMps: 6.0 }));
    expect(d.action).toBe('wait');
    expect(d.reason).toMatch(/speed 6 m\/s > 5 m\/s/);
  });

  it('stations a slow residual drift that it can zero first', () => {
    const d = stationDecision(baseInput({ speedMps: 1.2 }));
    expect(d.action).toBe('station');
    expect(d.reason).toMatch(/residual 1.2 m\/s/);
    expect(d.reason).toMatch(/zero velocity/);
  });

  it('never stations on the ground', () => {
    const d = stationDecision(baseInput({ aglM: 12 }));
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/never station on the ground/);
  });

  it('skips when a player is piloting (manual handoff)', () => {
    expect(stationDecision(baseInput({ underControl: true })).action).toBe('skip');
  });

  it('waits while an order is in flight and skips only outside holding', () => {
    expect(stationDecision(baseInput({ hasPendingOrder: true })).action).toBe('wait');
    expect(stationDecision(baseInput({ state: 'en_route' })).action).toBe('skip');
  });

  it('is off with the config flag and idempotent when already static', () => {
    expect(stationDecision(baseInput({ enabled: false })).action).toBe('skip');
    expect(stationDecision(baseInput({ isStatic: true })).action).toBe('skip');
    expect(stationDecision(baseInput({ alreadyStationed: true })).action).toBe('skip');
  });

  it('refuses to guess without a speed or AGL read', () => {
    expect(stationDecision(baseInput({ speedMps: null })).action).toBe('wait');
    expect(stationDecision(baseInput({ aglM: null })).action).toBe('wait');
  });

  it('sends convert_to_station without force', () => {
    expect(convertToStationOrder('grid:1')).toEqual({ gridId: 'grid:1', force: false });
    expect(stationLine({ action: 'station', reason: 'ok' })).toBe('station: ok');
    expect(stationLine({ action: 'wait', reason: 'x' })).toBe('ship: x');
  });
});

describe('executor station lifecycle', () => {
  /** Park a drone in `holding` at its slot with a fresh telemetry row. */
  function armHolding(store: Store, missionId: string, opts: { aglM?: number; speed?: number } = {}) {
    const agl = opts.aglM ?? 7_000;
    const speed = opts.speed ?? 0.1;
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'holding', step = 'move', grid_id = 'grid:test1',
           hold_at = ?, reason = 'arrived', pending_order = NULL, pending_action = NULL, pending_at = NULL
         WHERE mission_id = ?`,
      )
      .run(NOW - 45_000, missionId);
    store.upsertUnit({
      id: 'grid:test1',
      name: 'relay-1',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      // EarthLike centre + its real surface radius + AGL, on the +x axis.
      pos: { x: Number(planetByName('EarthLike')?.surfaceRadiusM ?? 59_400) + agl, y: 0, z: 0 },
      vel: { x: speed, y: 0, z: 0 },
      meta: { massKg: 19_000, prefab: 'Eradicator_mk.1' },
    });
  }

  it('asks for manual control, zeroes velocity, waits 2 s, then converts to a station', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick();
    armHolding(store, mission.id);
    sent.length = 0;

    executor.tick();
    let order = lastOrder(store, mission.id, 'is_under_control')!;
    expect(order).toBeTruthy();
    let row = droneRow(store, mission.id);
    expect(row.step).toBe('station_check');

    ack(store, order.orderId, { underControl: false });
    executor.tick();
    order = lastOrder(store, mission.id, 'zero_velocity')!;
    expect(order).toBeTruthy();
    row = droneRow(store, mission.id);
    expect(row.step).toBe('station_zeroing');

    ack(store, order.orderId, { speedBeforeMs: 1.01, speedAfterMs: 0, zeroed: true });
    executor.tick();
    row = droneRow(store, mission.id);
    expect(row.step).toBe('station_wait');
    // The conversion is not sent in the same tick as the zeroing: 2 s settle.
    expect(lastOrder(store, mission.id, 'convert_to_station')).toBeNull();
    now += 2_000;
    executor.tick();
    order = lastOrder(store, mission.id, 'convert_to_station')!;
    expect(order).toBeTruthy();
    expect((order.payload.params as Record<string, unknown>).force).toBe(false);

    ack(store, order.orderId, { isStaticAfter: true, isStaticBefore: false, positionDriftM: 0.01, aglM: 7_000 });
    executor.tick();
    row = droneRow(store, mission.id);
    expect(row.step).toBe('stationed');
    expect(row.state).toBe('holding');
    expect(row.reason).toMatch(/stationed/);

    // Once stationed, no further hold orders are sent (the grid is static).
    sent.length = 0;
    executor.tick();
    expect(sent.filter((m) => (m.params as Record<string, unknown>).action !== 'probe_ground')).toHaveLength(0);

    const actions = store.listAudit(200).map((e) => e.action);
    expect(actions).toContain('demo_station_decision');
    expect(actions).toContain('demo_station_check');
    expect(actions).toContain('demo_station');

    const view = executor.summary() as { executions: { drones: { stationed: boolean; stationState: string }[] }[] };
    expect(view.executions[0]!.drones[0]!.stationed).toBe(true);
    expect(view.executions[0]!.drones[0]!.stationState).toBe('stationed');
  });

  it('does not station when a player is piloting the grid', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick();
    armHolding(store, mission.id);
    sent.length = 0;

    executor.tick();
    const order = lastOrder(store, mission.id, 'is_under_control')!;
    ack(store, order.orderId, { underControl: true, control: { by: 'Cockpit' } });
    executor.tick();

    const row = droneRow(store, mission.id);
    expect(row.step).toBeNull();
    expect(row.reason).toMatch(/manual control/);
    expect(store.listAudit(200).map((e) => e.action)).toContain('demo_station_skipped');
  });

  it('retries zero + convert three times, then reports the exact speed', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    let now = NOW;
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => now, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick();
    armHolding(store, mission.id);
    sent.length = 0;

    executor.tick();
    let order = lastOrder(store, mission.id, 'is_under_control')!;
    ack(store, order.orderId, { underControl: false });
    executor.tick();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      order = lastOrder(store, mission.id, 'zero_velocity')!;
      expect(order).toBeTruthy();
      ack(store, order.orderId, { speedBeforeMs: 1.4, speedAfterMs: 0, zeroed: true });
      executor.tick();
      now += 2_000;
      executor.tick();
      order = lastOrder(store, mission.id, 'convert_to_station')!;
      expect(order).toBeTruthy();
      ack(store, order.orderId, null, false, 'refused: speed 1.4 m/s > 0.5 m/s');
      executor.tick();
    }

    const row = droneRow(store, mission.id);
    expect(row.step).toBeNull();
    expect(row.reason).toMatch(/station refused after 3 tries/);
    expect(row.reason).toMatch(/1\.40 m\/s/);
    expect(store.listAudit(200).map((e) => e.action)).toContain('demo_station_retry');
  });

  it('does not station below 100 m AGL', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick();
    armHolding(store, mission.id, { aglM: 20 });
    sent.length = 0;

    executor.tick();
    expect(sent.filter((m) => (m.params as Record<string, unknown>).action === 'is_under_control')).toHaveLength(0);
    const row = droneRow(store, mission.id);
    expect(row.step).toBe('move');
    expect(row.reason).not.toMatch(/stationed/);
  });

  it('is inert with RTS_STATION off', () => {
    const { store, config } = makeStore();
    config.demo.station.enabled = false;
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick();
    armHolding(store, mission.id);
    sent.length = 0;

    executor.tick();
    expect(sent.some((m) => (m.params as Record<string, unknown>).action === 'is_under_control')).toBe(false);
  });
});
