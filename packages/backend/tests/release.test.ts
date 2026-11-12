import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import type { FeatureFlag } from '../src/config.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { makeConfig } from './helpers.js';
import {
  STATIC_CONVERT_PENDING,
  connectorReleaseOrder,
  isGroundTarget,
  landingGearRelockOrder,
  landingGearReleaseOrder,
  parseReleaseReadout,
  releaseVerdict,
} from '../src/demo/release.js';

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
        notes: '[SIMULATED] release test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  return result.mission;
}

/** Drive one drone straight to the release preflight, skipping spawn/gate. */
function armRelease(store: Store, missionId: string): void {
  store.db
    .prepare(
      `UPDATE demo_drones SET state = 'securing', grid_id = 'grid:test1', step = 'release_gears',
         reason = 'armed for release test', pending_order = NULL, pending_action = NULL, pending_at = NULL
       WHERE mission_id = ?`,
    )
    .run(missionId);
}

function lastOrder(store: Store, missionId: string) {
  return store.latestOrderFor(missionId, 'grid:test1');
}

function ack(store: Store, orderId: string, result: unknown, ok = true, error?: string): void {
  store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
  store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: {
      eventType: 'order_result',
      data: { orderId, ok, result, ...(error ? { error } : {}) },
    },
    at: NOW,
  });
}

function actionsOf(sent: Record<string, unknown>[]): string[] {
  return sent.map((m) => String((m.params as Record<string, unknown>).action));
}

describe('release preflight orders', () => {
  it('unlocks landing gears with Autolock off', () => {
    const order = landingGearReleaseOrder();
    expect(order.filter).toEqual({ type: 'LandingGear' });
    expect(order.props).toEqual({ Autolock: false });
    expect(order.actions).toEqual(['Unlock']);
  });

  it('unlocks and disconnects connectors', () => {
    const order = connectorReleaseOrder();
    expect(order.filter).toEqual({ type: 'ShipConnector' });
    expect(order.actions).toEqual(['Unlock', 'Disconnect']);
  });

  it('re-arms Autolock for the optional arrival step', () => {
    expect(landingGearRelockOrder().props).toEqual({ Autolock: true });
    expect(landingGearRelockOrder().actions).toEqual([]);
  });
});

describe('release verification', () => {
  it('parses diag physics state and profile mass', () => {
    const diag = parseReleaseReadout({
      isStatic: false,
      physics: { present: true, enabled: true, active: true, massKg: 18_965 },
    });
    expect(diag).toMatchObject({ isStatic: false, massKg: 18_965, physicsPresent: true, source: 'diag' });
    expect(releaseVerdict(diag!).ok).toBe(true);

    const profile = parseReleaseReadout({ isStatic: false, massKg: 1_500 });
    expect(profile).toMatchObject({ massKg: 1_500, physicsPresent: true, source: 'profile' });
    expect(releaseVerdict(profile!).ok).toBe(true);
  });

  it('asks for convert_to_ship when the grid is static', () => {
    const readout = parseReleaseReadout({ isStatic: true, physics: { present: true, enabled: false, massKg: 0 } })!;
    const verdict = releaseVerdict(readout);
    expect(verdict).toMatchObject({ ok: false, needsConvert: true, reason: STATIC_CONVERT_PENDING });
  });

  it('refuses a grid with no mass or no physics body', () => {
    const zero = releaseVerdict(parseReleaseReadout({ isStatic: false, massKg: 0 })!);
    expect(zero.ok).toBe(false);
    expect(zero.reason).toMatch(/mass is 0 kg/);

    const noBody = releaseVerdict(
      parseReleaseReadout({ isStatic: false, physics: { present: false, enabled: false, massKg: 12_000 } })!,
    );
    expect(noBody.ok).toBe(false);
    expect(noBody.reason).toMatch(/physics body is not present\/enabled/);
  });

  it('returns null for an unreadable result', () => {
    expect(parseReleaseReadout({})).toBeNull();
    expect(parseReleaseReadout(null)).toBeNull();
  });

  it('only relocks on a low-altitude ground target', () => {
    expect(isGroundTarget(30, 9.81)).toBe(true);
    expect(isGroundTarget(5_000, 9.81)).toBe(false);
    expect(isGroundTarget(30, 0)).toBe(false);
    expect(isGroundTarget(null, 9.81)).toBe(false);
  });
});

describe('executor launch preflight', () => {
  it('releases gears, connectors, reads the grid, then refuses a static grid until convert exists', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick(); // loads the cached identity while queued
    armRelease(store, mission.id);
    sent.length = 0;

    // 1. landing gears
    executor.tick();
    let order = lastOrder(store, mission.id);
    expect(order).toBeTruthy();
    let params = order!.payload.params as Record<string, unknown>;
    expect(params.action).toBe('set_block_props');
    expect(params.filter).toEqual({ type: 'LandingGear' });
    expect(params.actions).toEqual(['Unlock']);
    ack(store, order!.orderId, { count: 2, blocksWithErrors: 0 });
    executor.tick();
    let step = (store.db.prepare(`SELECT step FROM demo_drones WHERE mission_id = ?`).get(mission.id) as { step: string }).step;
    expect(step).toBe('release_connectors');

    // 2. connectors
    executor.tick();
    order = lastOrder(store, mission.id);
    params = order!.payload.params as Record<string, unknown>;
    expect(params.filter).toEqual({ type: 'ShipConnector' });
    expect(params.actions).toEqual(['Unlock', 'Disconnect']);
    ack(store, order!.orderId, { count: 1, blocksWithErrors: 1 }); // Disconnect may be unknown
    executor.tick();
    step = (store.db.prepare(`SELECT step FROM demo_drones WHERE mission_id = ?`).get(mission.id) as { step: string }).step;
    expect(step).toBe('release_profile');

    // 3. static diag -> convert
    executor.tick();
    order = lastOrder(store, mission.id);
    expect((order!.payload.params as Record<string, unknown>).action).toBe('diag');
    ack(store, order!.orderId, { isStatic: true, physics: { present: true, enabled: false, active: false, massKg: 0 } });
    executor.tick();
    step = (store.db.prepare(`SELECT step FROM demo_drones WHERE mission_id = ?`).get(mission.id) as { step: string }).step;
    expect(step).toBe('release_convert');

    // 4. convert_to_ship is not in the plugin build yet -> exact refusal
    executor.tick();
    order = lastOrder(store, mission.id);
    expect((order!.payload.params as Record<string, unknown>).action).toBe('convert_to_ship');
    ack(store, order!.orderId, null, false, 'unknown test action: convert_to_ship');
    executor.tick();

    const row = store.db
      .prepare(`SELECT state, reason, step FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string; step: string };
    expect(row.state).toBe('failed');
    expect(row.reason).toBe(STATIC_CONVERT_PENDING);
    const audits = store.listAudit(200).map((e) => e.action);
    expect(audits).toContain('launch_release');
    expect(audits).toContain('launch_release_verify');
    expect(audits).toContain('launch_release_convert');
  });

  it('advances to the move step when the grid has mass and an enabled physics body', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    const mission = connectMission(store);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.tick(); // loads the cached identity while queued
    armRelease(store, mission.id);
    sent.length = 0;

    executor.tick(); // gears
    let order = lastOrder(store, mission.id)!;
    ack(store, order.orderId, { count: 2, blocksWithErrors: 0 });

    executor.tick(); // connectors
    order = lastOrder(store, mission.id)!;
    ack(store, order.orderId, { count: 1, blocksWithErrors: 0 });

    executor.tick(); // diag
    order = lastOrder(store, mission.id)!;
    expect(actionsOf(sent)).toContain('diag');
    ack(store, order.orderId, {
      isStatic: false,
      physics: { present: true, enabled: true, active: true, massKg: 305_085 },
    });
    executor.tick();

    const row = store.db.prepare(`SELECT step FROM demo_drones WHERE mission_id = ?`).get(mission.id) as {
      step: string;
    };
    expect(row.step).toBe('move');
  });
});
