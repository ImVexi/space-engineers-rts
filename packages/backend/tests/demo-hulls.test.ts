import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName, seedWorld } from '../src/demo/world.js';
import { FixedFlightGate, SimSpeedMonitor } from '../src/demo/simSpeed.js';
import { selectHull } from '../src/demo/hulls.js';
import { createMission } from '../src/missions.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { makeConfig } from './helpers.js';

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

describe('hull selection', () => {
  it('keeps a gravity hull on the surface', () => {
    const c = selectHull('Large Control Drone', { name: 'EarthLike', hasAtmosphere: true });
    expect(c.spawnMode).toBe('surface');
    expect(c.prefab).toBe('Large Control Drone');
    expect(c.reason).toMatch(/GRAVITY HULL/);
  });

  it('moves an ion-only hull to an orbital spawn above an atmosphere', () => {
    const c = selectHull('Eradicator_mk.1', { name: 'EarthLike', hasAtmosphere: true });
    expect(c.spawnMode).toBe('orbital');
    expect(c.reason).toMatch(/ORBITAL SPAWN/);
    expect(c.reason).toMatch(/ion-only/);
  });

  it('keeps an ion hull on the surface of an airless body', () => {
    const c = selectHull('Eradicator_mk.1', { name: 'Moon', hasAtmosphere: false });
    expect(c.spawnMode).toBe('surface');
    expect(c.reason).toMatch(/no atmosphere/);
  });

  it('substitutes the opt-in gravity hull for atmospheric slots', () => {
    const c = selectHull('Eradicator_mk.1', { name: 'EarthLike', hasAtmosphere: true }, {
      gravityHull: 'Escort TT-420',
    });
    expect(c.prefab).toBe('Escort TT-420');
    expect(c.spawnMode).toBe('surface');
    expect(c.reason).toMatch(/NO antenna/);
  });

  it('labels an unmeasured hull UNKNOWN instead of assuming it can fly', () => {
    const c = selectHull('Some Mystery Ship', { name: 'EarthLike', hasAtmosphere: true });
    expect(c.spawnMode).toBe('surface');
    expect(c.reason).toMatch(/UNKNOWN hull/);
  });
});

describe('orbit spawn geometry', () => {
  it('spawns an ion hull 40 km above the surface and keeps the slot at altitude', () => {
    const { store, config } = makeStore();
    const executor = new DemoExecutor({
      store,
      hub: fakeHub([]),
      config,
      clock: () => NOW,
      fixturePath: null,
    });
    const mission = connectMission(store, 2);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    const rows = store.db
      .prepare(`SELECT spawn_json, exec_slot_json, spawn_mode FROM demo_drones WHERE mission_id = ? ORDER BY idx`)
      .all(mission.id) as { spawn_json: string; exec_slot_json: string; spawn_mode: string }[];
    expect(rows).toHaveLength(2);
    const surface = Number(planetByName('EarthLike')?.surfaceRadiusM ?? 0);
    expect(surface).toBeGreaterThan(0);
    const expected = surface + config.demo.orbitAglM;
    for (const row of rows) {
      expect(row.spawn_mode).toBe('orbital');
      const spawn = JSON.parse(row.spawn_json) as { x: number; y: number; z: number };
      const slot = JSON.parse(row.exec_slot_json) as { x: number; y: number; z: number };
      // The spawn is high above the planet centre...
      expect(Math.hypot(spawn.x, spawn.y, spawn.z)).toBeCloseTo(expected, 0);
      // ...and the compressed slot stays at (or slightly above) the same
      // radius instead of diving back into the atmosphere.
      const slotR = Math.hypot(slot.x, slot.y, slot.z);
      expect(slotR).toBeGreaterThan(expected - 1);
      expect(slotR).toBeLessThan(expected + 400);
      expect(Math.hypot(slot.x - spawn.x, slot.y - spawn.y, slot.z - spawn.z)).toBeGreaterThan(100);
    }
  });
});

describe('SimSpeed flight gate', () => {
  it('withholds move orders while SimSpeed is below the threshold', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({
      store,
      hub: fakeHub(sent),
      config,
      clock: () => NOW,
      fixturePath: null,
      simSpeed: new FixedFlightGate(false),
    });
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(NOW);
    // First tick resolves the cached identity while the drone is still queued.
    executor.tick();
    sent.length = 0;
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = 'grid:t1', pending_order = NULL WHERE mission_id = ?`,
      )
      .run(mission.id);
    executor.tick();
    expect(sent.some((m) => m.orderType === 'move')).toBe(false);
    const row = store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string };
    expect(row.state).toBe('securing');
    expect(String(row.reason)).toMatch(/SIMSPEED HOLD/);
    const summary = executor.summary() as { flightGate: string; simSpeed: { value: number } };
    expect(summary.flightGate).toBe('SIMSPEED HOLD');
    expect(summary.simSpeed.value).toBeLessThan(config.demo.simSpeedMin);
  });

  it('lets move orders through when SimSpeed is healthy', () => {
    const { store, config } = makeStore();
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({
      store,
      hub: fakeHub(sent),
      config,
      clock: () => NOW,
      fixturePath: null,
      simSpeed: new FixedFlightGate(true),
    });
    const mission = connectMission(store, 1);
    store.updateMission(mission.id, { status: 'approved' }, NOW);
    store.setKv('demo:identityId', '10000000000000001');
    executor.sync(NOW);
    executor.tick();
    sent.length = 0;
    const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
    store.upsertUnit({
      id: 'grid:t1',
      name: 'demo',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z },
      vel: null,
      meta: { prefab: 'Eradicator_mk.1' },
    });
    store.db
      .prepare(
        `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = 'grid:t1', pending_order = NULL WHERE mission_id = ?`,
      )
      .run(mission.id);
    executor.tick();
    const move = sent.find((m) => m.orderType === 'move');
    expect(move).toBeTruthy();
    expect((move!.params as Record<string, unknown>).speed).toBe(config.demo.speedLimitMps);
  });
});

describe('SimSpeed monitor', () => {
  function credsFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simspeed-'));
    const file = path.join(dir, 'remote.env');
    fs.writeFileSync(
      file,
      'SE_TEST_REMOTE_HOST=127.0.0.1\nSE_TEST_REMOTE_PORT=8082\nSE_TEST_REMOTE_KEY=' +
        Buffer.from('secret').toString('base64') +
        '\n',
    );
    return file;
  }

  function monitor(value: () => number, clock: () => number) {
    return new SimSpeedMonitor({
      envPath: credsFile(),
      min: 0.95,
      sampleMs: 5_000,
      holdMs: 30_000,
      clock,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ data: { SimSpeed: value(), SimulationCpuLoad: 120 } }),
      })) as unknown as typeof fetch,
    });
  }

  it('blocks new flights on a fresh low sample and flags 30 s sustained low', async () => {
    let now = NOW;
    const m = monitor(() => 0.42, () => now);
    await m.refresh();
    expect(m.flightsAllowed()).toBe(false);
    expect(m.status().blocked).toBe(false);
    now += 31_000;
    expect(m.status().blocked).toBe(true);
    expect(m.status().belowForMs).toBeGreaterThanOrEqual(30_000);
    expect(m.status().threshold).toBe(0.95);
  });

  it('reopens when a healthy sample arrives', async () => {
    let now = NOW;
    let speed = 0.5;
    const m = monitor(() => speed, () => now);
    await m.refresh();
    expect(m.flightsAllowed()).toBe(false);
    speed = 1.0;
    now += 5_000;
    await m.refresh();
    expect(m.flightsAllowed()).toBe(true);
    expect(m.status().blocked).toBe(false);
    expect(m.status().value).toBe(1);
  });

  it('never blocks on an unknown sample', async () => {
    const m = new SimSpeedMonitor({
      envPath: '/nonexistent/remote.env',
      min: 0.95,
      sampleMs: 5_000,
      holdMs: 30_000,
      clock: () => NOW,
    });
    await m.refresh();
    expect(m.flightsAllowed()).toBe(true);
    expect(m.status().value).toBeNull();
    expect(m.status().error).toMatch(/credentials not found/);
  });
});
