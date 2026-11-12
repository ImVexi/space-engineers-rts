/**
 * End-to-end: the survival loop's missions are flown by the REAL executor.
 *
 * Verify #3 proved the decision half (`RETURN_PENDING` -> approve -> `RETURNING`)
 * and then nothing flew: the loop created `station: survival:return:<grid>` and
 * the executor's `seedsFor()` only knew `designer:`, `chain:` and `move:`, so it
 * produced no seeds and `sync()` skipped the mission for 3 min 25 s (mission
 * `approved`, all steps `done:false`, no execution row, no order).
 *
 * These tests use the actual `SurvivalService` (which creates and approves the
 * mission) and the actual `DemoExecutor` (which must turn it into an execution
 * and an order for that grid). Nothing here mocks the seam the defect was in.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Store, type UnitRecord } from '../src/store.js';
import { openDb } from '../src/db.js';
import { shipRoles, type RoleHint } from '../src/demo/roles.js';
import { planetByName } from '../src/demo/world.js';
import type { PowerPoller, PowerSnapshot } from '../src/demo/power/index.js';
import type { PowerSample } from '../src/demo/power/rates.js';
import { SurvivalService } from '../src/demo/survival/service.js';
import { blankRecord, distanceM } from '../src/demo/survival/loop.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { makeConfig } from './helpers.js';

const NOW = 1_700_000_000_000;
const GRID = 'grid:relay-01';
const BASE = 'grid:base-01';

function memStore(flags: Partial<Record<FeatureFlag, boolean>> = {}): Store {
  const store = new Store(openDb(':memory:', { memory: true }), () => NOW);
  const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  store.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true, ...flags });
  return store;
}

/** A grid at `altitudeM` AGL on EarthLike, `offsetM` east of the base column. */
function grid(id: string, name: string, altitudeM: number, offsetM = 0): UnitRecord {
  const planet = planetByName('EarthLike')!;
  const r = planet.surfaceRadiusM + altitudeM;
  return {
    id,
    name,
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: planet.center.x + offsetM, y: planet.center.y + r, z: planet.center.z },
    vel: { x: 0, y: 0, z: 0 },
    meta: {},
  };
}

const hint = (role: RoleHint['role']): RoleHint => ({ role, source: 'block-name', token: `[${role}]` });

function baseSnapshot(patch: Partial<PowerSnapshot> = {}): PowerSnapshot {
  return {
    gridId: GRID,
    name: 'SAT-L-0007',
    at: NOW,
    gameAt: NOW,
    isStatic: true,
    massKg: 10_000,
    underControl: false,
    controlledBy: null,
    batteryStoredMWh: 2,
    batteryMaxMWh: 2,
    batteryPct: 100,
    batteryState: 'read',
    batteryUnreadReason: null,
    batteryInputMw: 0,
    batteryOutputMw: 0,
    charge: 'idle',
    netMw: 0,
    generationMw: 0,
    consumerDrawMw: 0,
    batteryChargeMw: 0,
    solarActualMw: 0,
    solarMaxMw: 0,
    solarEfficiency: null,
    reactorOutputMw: 0,
    reactorMaxMw: 0,
    antennaDrawMw: 0.01,
    laserDrawMw: 0,
    deviceDrawMw: 0.01,
    h2Litres: 19_000,
    h2CapacityLitres: 50_000,
    h2Pct: 38,
    h2State: 'read',
    h2UnreadReason: null,
    h2TankCount: 1,
    uraniumKg: null,
    uraniumCapacityKg: null,
    uraniumPct: null,
    radioRangeM: 50_000,
    laserRangeM: null,
    radio: [],
    lasers: [],
    reactors: [],
    tanks: [],
    solar: [],
    missing: [],
    ...patch,
  };
}

/** -1 %/h H2 so `computeRunway` gives 38/1*60 = 2280 min at 38 %. */
function samples(): PowerSample[] {
  return [
    { at: NOW - 120_000, batteryPct: 100, h2Pct: 40, h2Litres: 20_000, uraniumKg: null, solarPct: 0, netMw: 0 },
    { at: NOW, batteryPct: 100, h2Pct: 38, h2Litres: 19_000, uraniumKg: null, solarPct: 0, netMw: 0 },
  ];
}

function fakePower(snap: PowerSnapshot, series: PowerSample[] = samples()): PowerPoller {
  return {
    snapshot: (gridId: string) =>
      gridId === snap.gridId
        ? snap
        : gridId === BASE
          ? baseSnapshot({ gridId: BASE, name: 'BASE-01', h2Pct: 100, batteryPct: 100, h2CapacityLitres: 1_000_000, batteryMaxMWh: 10 })
          : null,
    series: () => series,
  } as unknown as PowerPoller;
}

function service(store: Store, power: PowerPoller | null): SurvivalService {
  const planet = planetByName('EarthLike')!;
  return new SurvivalService({
    store,
    power,
    executor: { summary: () => ({ executions: [] }) },
    clock: () => NOW,
    survivalMode: () => false,
    demoEnv: () => true,
    homePointGround: () => ({ radiusM: planet.surfaceRadiusM, level: 5, source: 'terrain-l5' }),
    gateFor: () => ({ allowed: true, nodeId: GRID, reason: 'ok' }),
  });
}

function seedWorld(store: Store): void {
  store.upsertUnit(grid(GRID, 'SAT-L-0007', 30_000, 4_000));
  store.upsertUnit(grid(BASE, 'BASE-01', 1_800));
  shipRoles.noteInGame(
    store,
    [
      { gridId: BASE, name: 'BASE-01', hints: [hint('base')] },
      { gridId: GRID, name: 'SAT-L-0007', hints: [hint('managed')] },
    ],
    NOW,
  );
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

interface Harness {
  store: Store;
  sent: Record<string, unknown>[];
  executor: DemoExecutor;
  missionId: string;
}

/** Drive a created+approved mission through the real executor's first ticks. */
function executeMission(store: Store, missionId: string): Harness {
  const sent: Record<string, unknown>[] = [];
  const config = makeConfig({ flags: { demo_execute: true } });
  const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ [GRID]: 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued -> securing (existing grid: no spawn, no order)
  return { store, sent, executor, missionId };
}

function droneRow(store: Store, missionId: string): Record<string, unknown> {
  return store.db
    .prepare(`SELECT * FROM demo_drones WHERE mission_id = ?`)
    .get(missionId) as Record<string, unknown>;
}

/** Distance between two points measured across the planet radius (tangent). */
function lateralM(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const centre = planetByName('EarthLike')!.center;
  const up = { x: b.x - centre.x, y: b.y - centre.y, z: b.z - centre.z };
  const len = Math.hypot(up.x, up.y, up.z) || 1;
  up.x /= len;
  up.y /= len;
  up.z /= len;
  const d = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const radial = d.x * up.x + d.y * up.y + d.z * up.z;
  return Math.hypot(d.x - up.x * radial, d.y - up.y * radial, d.z - up.z * radial);
}

function ordersFor(sent: Record<string, unknown>[], gridId: string): Record<string, unknown>[] {
  return sent.filter((m) => {
    const params = (m.params ?? {}) as Record<string, unknown>;
    return m.type === 'order' && (m.entityId === gridId || params.entityId === gridId);
  });
}

beforeEach(() => shipRoles.reset());

describe('survival return flies (e2e: loop mission -> real executor order)', () => {
  it('a survival:return:<grid> mission gets an execution row and a move order for its grid', () => {
    const store = memStore();
    seedWorld(store);
    // 12 % H2 with a 60 %/h burn: below the threshold, still above the trip.
    const svc = service(store, fakePower(baseSnapshot({ h2Pct: 12, h2Litres: 6_000 })));
    // The test-env audited ignoreReach (the test world's BASE-01 has no antenna),
    // so the mission carries adminOverride and the executor's gate lets the
    // MOVE through. This is the same flag verify #3 flew with.
    svc.writeSettings({ testIgnoreReach: true }, 'test-owner');
    const tick = svc.tick(NOW);
    expect(tick.started).toEqual([GRID]);

    const rec = svc.record(GRID)!;
    expect(rec.state).toBe('RETURNING');
    const mission = store.getMission(rec.missionId!)!;
    expect((mission.desiredState as { station?: string }).station).toBe(`survival:return:${GRID}`);
    expect((mission.desiredState as { land?: boolean }).land).toBe(true);

    const { sent, executor } = executeMission(store, mission.id);

    // 1. The executor built an execution (this is what it never did in verify #3).
    const exec = store.db.prepare(`SELECT * FROM demo_exec`).get() as { mission_id: string } | undefined;
    expect(exec?.mission_id).toBe(mission.id);
    const drone = droneRow(store, mission.id);
    // 2. One drone, on the grid the mission names, in the planet it flies on.
    expect(drone.grid_id).toBe(GRID);
    expect(drone.planet).toBe('EarthLike');
    expect(drone.prefab).toBe('existing');
    // 3. It is carrying a LANDING (land:true -> lateral leg -> settle -> land_at).
    const landing = JSON.parse(String(drone.landing_json)) as { kind?: string };
    expect(landing.kind).toBe('land');
    // 4. The slot is on the loop's chosen landing COLUMN (the executor pushes it
    //    down to the ground radius along that column, so the 3D distance is the
    //    catalogue mean's error, not a different spot).
    const slot = JSON.parse(String(drone.exec_slot_json)) as { x: number; y: number; z: number };
    expect(lateralM(slot, rec.landing!.point)).toBeLessThan(50);

    // 5. Fly the move phase: the first order for the grid goes out (verify #3:
    //    zero orders for 3 min 25 s). The executor reaches 'move' from its own
    //    securing chain; the test only skips the ownership handshake steps.
    store.db
      .prepare(`UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = ? WHERE mission_id = ?`)
      .run(GRID, mission.id);
    sent.length = 0;
    executor.tick();
    const orders = ordersFor(sent, GRID);
    expect(orders.length).toBeGreaterThan(0);
    const actions = orders.map((m) => String((m.params as { action?: unknown }).action ?? ''));
    expect(actions).toContain('move');
  });
});

describe('survival relaunch flies (e2e: loop mission -> real executor order)', () => {
  it('a survival:relaunch:<grid> mission gets an execution row and a move order back to the slot', () => {
    const store = memStore();
    seedWorld(store);
    const planet = planetByName('EarthLike')!;
    const slot = { x: planet.center.x + 4_000, y: planet.center.y + planet.surfaceRadiusM + 30_000, z: planet.center.z };
    // A landed grid, refuelled: READY_TO_RELAUNCH with a remembered slot.
    const rec = {
      ...blankRecord(GRID, 'SAT-L-0007', NOW),
      state: 'READY_TO_RELAUNCH' as const,
      slot: { position: slot, planet: 'EarthLike', altitudeM: 30_000 },
      refuelPct: 95,
      needsRefuel: true,
      reason: 'refuelled: 95 %',
    };
    store.setKv('survival:loop', JSON.stringify({ [GRID]: rec }));
    const svc = service(store, fakePower(baseSnapshot({ h2Pct: 95, h2Litres: 47_500 })));
    svc.writeSettings({ testIgnoreReach: true }, 'test-owner');
    const started = svc.relaunch(GRID, true, 'test-owner');
    expect(started.ok).toBe(true);

    const mission = store.getMission(started.missionId!)!;
    expect((mission.desiredState as { station?: string }).station).toBe(`survival:relaunch:${GRID}`);
    expect((mission.desiredState as { land?: boolean }).land).toBeUndefined();

    const { sent, executor } = executeMission(store, mission.id);
    const exec = store.db.prepare(`SELECT * FROM demo_exec`).get() as { mission_id: string } | undefined;
    expect(exec?.mission_id).toBe(mission.id);
    const drone = droneRow(store, mission.id);
    expect(drone.grid_id).toBe(GRID);
    expect(drone.planet).toBe('EarthLike');
    // No landing: a relaunch climbs back to the slot.
    expect(drone.landing_json).toBeNull();
    const droneSlot = JSON.parse(String(drone.exec_slot_json)) as { x: number; y: number; z: number };
    expect(distanceM(droneSlot, slot)).toBeLessThan(1);

    store.db
      .prepare(`UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = ? WHERE mission_id = ?`)
      .run(GRID, mission.id);
    sent.length = 0;
    executor.tick();
    const orders = ordersFor(sent, GRID);
    expect(orders.length).toBeGreaterThan(0);
    const actions = orders.map((m) => String((m.params as { action?: unknown }).action ?? ''));
    expect(actions).toContain('move');
  });
});

describe('unknown mission source is an audited failure, never a silent skip', () => {
  it('fails the mission, audits "mission source not executable", and sends nothing', () => {
    const store = memStore();
    seedWorld(store);
    const created = createMission(
      store,
      {
        type: 'move',
        priority: 50,
        desiredState: { shipSpec: 'stand-in-grid', station: 'bogus:source:grid:relay-01', formation: 'none' },
        budget: { resources: {}, timeMin: 1, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [GRID],
        plan: {
          steps: [
            { id: 'validate', kind: 'validate_spec', params: {}, done: false },
            { id: 'move', kind: 'move', params: { gridId: GRID, target: { x: 0, y: 0, z: 0 } }, done: false },
            { id: 'gate', kind: 'custom', params: { demoGateNode: GRID, action: 'move' }, done: false },
          ],
          notes: '',
        },
      } as never,
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) throw new Error(created.message);
    store.updateMission(created.mission.id, { status: 'approved' }, NOW);

    const sent: Record<string, unknown>[] = [];
    const config = makeConfig({ flags: { demo_execute: true } });
    const executor = new DemoExecutor({ store, hub: fakeHub(sent), config, clock: () => NOW, fixturePath: null });
    executor.sync(NOW);

    const after = store.getMission(created.mission.id)!;
    expect(after.status).toBe('failed');
    expect(after.pauseReason).toContain('mission source not executable');
    const audit = store.listAudit(50).find((a) => a.action === 'demo_mission_source_not_executable')!;
    expect(audit.subject).toBe(created.mission.id);
    expect(String((audit.detail as { reason?: string }).reason)).toContain('mission source not executable');
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM demo_exec`).get()).toEqual({ n: 0 });
    expect(sent).toHaveLength(0);
  });
});
