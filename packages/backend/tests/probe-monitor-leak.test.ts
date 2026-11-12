/**
 * The read-only monitors leaked after a mission finished (measured in game).
 *
 * A demo mission that reaches a terminal state (`done`/`failed`/`cancelled`)
 * keeps its `demo_exec` row and its `holding`/`manual` drone rows, and `tick()`
 * calls `stationPass()` for every exec row unconditionally. So the finished
 * mission re-armed `refreshGround()` every tick and fired a `probe_ground`
 * order every 10 s forever; a `manual` drone did the same for the 5 s
 * `is_under_control` probe. The audit trail of the in-game run shows
 * `demo:probe:<missionId>:<idx>:<epochMs>` repeating after the mission was
 * `done`.
 *
 * These tests pin the arming gate: a terminal mission sends no monitor order of
 * either kind, a live one still does, and the disarm is audited once.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('Mars')!;
const CENTRE = PLANET.center as { x: number; y: number; z: number };
const SURFACE = Number(PLANET.surfaceRadiusM);
const MASS_KG = 37_609;
/** 500 m above the terrain datum: well clear of refreshGround's 60 m gate. */
const START_AGL = 500;
const GRID = 'grid:mon';
/** The only audit action the arming gate may write. */
const DISARM_ACTION = 'demo_probe_disarm';

function flatTerrain(): TerrainField {
  return {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    status: 'available',
    reason: null,
    tiles: 1,
    radiusAt: () => SURFACE,
  };
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

interface Setup {
  droneState: 'holding' | 'manual' | 'en_route';
  missionStatus: 'done' | 'failed' | 'cancelled' | 'executing' | 'paused';
  execState: 'done' | 'failed' | 'running';
}

function setup(opts: Setup) {
  const config = makeConfig();
  config.demo.speedLimitMps = 100;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  const sent: Record<string, unknown>[] = [];
  const clock = { now: NOW };
  const executor = new DemoExecutor({
    store,
    hub: fakeHub(sent),
    config,
    clock: () => clock.now,
    fixturePath: null,
    terrainField: () => flatTerrain(),
  });
  const slot = { x: CENTRE.x, y: CENTRE.y, z: CENTRE.z + SURFACE + START_AGL };
  const created = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: {
        shipSpec: 'relay-chain-radio',
        station: 'chain:EarthLike:Moon:radio',
        formation: 'line',
        qty: 1,
      },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: [],
      plan: {
        steps: [
          // Test-only reach bypass (the grid sits on Mars, far outside any
          // provisioned base's 50 km radio). The game-link half still applies.
          { id: 'validate', kind: 'validate_spec', params: { adminOverride: true }, done: false },
          { id: 'deploy-0', kind: 'print', params: { prefab: 'Eradicator_mk.1', role: 'relay', position: slot }, done: false },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] probe-monitor-leak test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!created.ok) throw new Error(created.message);
  const missionId = created.mission.id;
  store.updateMission(missionId, { status: 'approved' }, NOW);
  store.setKv('demo:identityId', '10000000000000001');
  // sync() inserts demo_exec as 'running' and the drone as 'queued'.
  executor.sync(NOW);
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = ?, step = NULL, grid_id = ?, planet = 'Mars',
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = ?
       WHERE mission_id = ?`,
    )
    .run(opts.droneState, GRID, JSON.stringify(slot), `existing:${GRID}`, missionId);
  // `hold_at` is deliberately left NULL: no station conversion is due for these
  // rows, so what follows measures the read-only monitors and nothing else.
  // Hold the grid 500 m up, stationary, and not under player control: exactly
  // the situation in which refreshGround/controlPass want to probe.
  store.upsertUnit({
    id: GRID,
    name: 'SAT-MON-0001',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: clock.now,
    pos: slot,
    vel: { x: 0, y: 0, z: 0 },
    meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
  });
  store.db.prepare(`UPDATE demo_exec SET state = ?, updated_at = ? WHERE mission_id = ?`).run(opts.execState, NOW, missionId);
  store.updateMission(missionId, { status: opts.missionStatus }, NOW);
  sent.length = 0;
  return { store, config, sent, executor, clock, missionId, slot };
}

/** Advance the clock 1 s per tick, exactly as the live loop does. */
function runFor(ctx: { executor: DemoExecutor; clock: { now: number } }, seconds: number): void {
  for (let i = 0; i < seconds; i += 1) {
    ctx.clock.now += 1_000;
    ctx.executor.tick();
  }
}

function orders(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order');
}
function actionOf(m: Record<string, unknown>): string | null {
  const params = m.params as Record<string, unknown> | undefined;
  return typeof params?.action === 'string' ? params.action : null;
}
function probes(sent: Record<string, unknown>[], action: string) {
  return orders(sent).filter((m) => actionOf(m) === action);
}
function audit(store: Store, action: string) {
  return store.listAudit(600).filter((row) => row.action === action);
}

describe('read-only probes are disarmed for a terminal mission', () => {
  it('(a) a done mission with a holding drone fires no probe_ground for 30 s', () => {
    const ctx = setup({ droneState: 'holding', missionStatus: 'done', execState: 'done' });
    // Sanity: the drone is in the state stationPass()->maybeStation() reaches.
    const row = ctx.store.db
      .prepare(`SELECT state, grid_id FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.missionId) as { state: string; grid_id: string };
    expect(row.state).toBe('holding');
    expect(row.grid_id).toBe(GRID);

    runFor(ctx, 30);

    expect(probes(ctx.sent, 'probe_ground')).toHaveLength(0);
    // Nothing else may leak either: a finished mission commands nothing.
    expect(orders(ctx.sent)).toHaveLength(0);
  });

  it('(b) a done mission with a manual drone sends no is_under_control probe for 30 s', () => {
    const ctx = setup({ droneState: 'manual', missionStatus: 'done', execState: 'done' });
    runFor(ctx, 30);
    expect(probes(ctx.sent, 'is_under_control')).toHaveLength(0);
    expect(probes(ctx.sent, 'probe_ground')).toHaveLength(0);
  });

  it('(b) failed and cancelled missions are disarmed too', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const exec = setup({ droneState: 'holding', missionStatus: status, execState: 'failed' });
      runFor(exec, 30);
      expect(probes(exec.sent, 'probe_ground'), `mission ${status}`).toHaveLength(0);
      const manual = setup({ droneState: 'manual', missionStatus: status, execState: 'failed' });
      runFor(manual, 30);
      expect(probes(manual.sent, 'is_under_control'), `mission ${status}`).toHaveLength(0);
    }
  });

  it('(c) a live mission still fires probe_ground inside 30 s', () => {
    const ctx = setup({ droneState: 'en_route', missionStatus: 'executing', execState: 'running' });
    runFor(ctx, 30);
    expect(probes(ctx.sent, 'probe_ground').length).toBeGreaterThanOrEqual(1);
    expect(audit(ctx.store, DISARM_ACTION)).toHaveLength(0);
  });

  it('(c) a manual drone of a PAUSED mission still gets is_under_control probes', () => {
    // The paused probe is how a released cockpit is noticed: it must survive.
    const ctx = setup({ droneState: 'manual', missionStatus: 'paused', execState: 'running' });
    runFor(ctx, 30);
    expect(probes(ctx.sent, 'is_under_control').length).toBeGreaterThanOrEqual(1);
    expect(audit(ctx.store, DISARM_ACTION)).toHaveLength(0);
  });

  it('(d) the disarm is audited exactly once, not once per tick', () => {
    const ctx = setup({ droneState: 'holding', missionStatus: 'done', execState: 'done' });
    ctx.clock.now += 1_000;
    ctx.executor.tick();
    const afterOne = audit(ctx.store, DISARM_ACTION);
    expect(afterOne).toHaveLength(1);
    const detail = afterOne[0]!.detail as { missionStatus?: string; execState?: string; probes?: string[] };
    expect(detail.missionStatus).toBe('done');
    expect(detail.execState).toBe('done');
    expect(detail.probes?.sort()).toEqual(['control', 'ground']);

    runFor(ctx, 30);
    expect(audit(ctx.store, DISARM_ACTION)).toHaveLength(1);
  });
});
