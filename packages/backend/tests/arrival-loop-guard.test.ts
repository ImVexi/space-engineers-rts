/**
 * FAILURE 2 of the overnight in-game run (2026-11-10): the arrival limit cycle.
 *
 * A satellite flew a 5 km leg and then cycled between 65.3 m and 295 m at
 * ~3 m/s for 300 s without ever completing. The guard commanded 92.5 m/s but
 * the hull only ever reached 74.8 m/s — near its hover ceiling — and the
 * executor alternated between a 5 m/s cap and a 92.5 m/s command, so the
 * mission never reached `done`.
 *
 * Two plain detectors now end that state instead of leaving it to run:
 *   - the hull cannot achieve half its commanded speed for more than 10 s
 *     while the range barely closes  -> abort `hull cannot achieve commanded
 *     speed`;
 *   - the range grows more than 50 m past its closest approach twice
 *     -> abort `limit cycle`.
 * Both hold the ship and write the numbers to the audit.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import {
  ARRIVAL_CYCLE_AMPLITUDE_M,
  ARRIVAL_SHORTFALL_GRACE_MS,
  ARRIVAL_SHORTFALL_MS,
  ARRIVAL_SHORTFALL_RATIO,
} from '../src/demo/flight.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const SURFACE = 59_400;
const MASS_KG = 37_609;

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

function setup(opts: { speedLimitMps?: number } = {}) {
  const config = makeConfig();
  config.demo.speedLimitMps = opts.speedLimitMps ?? 100;
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
  });
  const slot = { x: SURFACE + 2_000, y: 0, z: 0 };
  const result = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: { shipSpec: 'relay-chain-radio', station: 'chain:EarthLike:Moon:radio', formation: 'line', qty: 1 },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: [],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: { adminOverride: true }, done: false },
          { id: 'deploy-0', kind: 'print', params: { prefab: 'Eradicator_mk.1', role: 'relay', position: slot }, done: false },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] arrival-loop test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  const mission = result.mission;
  store.updateMission(mission.id, { status: 'approved' }, NOW);
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:g1': 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:g1', planet = 'EarthLike',
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:g1'
       WHERE mission_id = ?`,
    )
    .run(JSON.stringify(slot), mission.id);

  const place = (pos: { x: number; y: number; z: number }, vel = { x: 0, y: 0, z: 0 }) => {
    store.upsertUnit({
      id: 'grid:g1',
      name: 'SAT-L-0006',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: clock.now,
      pos,
      vel,
      meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
  };
  /**
   * Place the ship `distanceM` from its slot on a bearing in the plane
   * PERPENDICULAR to the slot's radial direction (the slot is at (R,0,0)),
   * moving tangentially at `speedMps`. The radius from the planet centre, and
   * therefore the altitude, stays at the slot's: the leg is a level move, not
   * a descent, so the controlled-fall planner stays out of the way.
   */
  const placeAt = (distanceM: number, bearingRad: number, speedMps: number) => {
    const unitX = 0;
    const unitY = Math.cos(bearingRad);
    const unitZ = Math.sin(bearingRad);
    place(
      {
        x: slot.x + unitX * distanceM,
        y: slot.y + unitY * distanceM,
        z: slot.z + unitZ * distanceM,
      },
      { x: 0, y: -unitY * speedMps, z: -unitZ * speedMps },
    );
  };
  const droneRow = () =>
    store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string | null };
  return { store, config, sent, clock, executor, mission, slot, place, placeAt, droneRow };
}

function moves(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order' && m.orderType === 'move');
}
function audit(store: Store, action: string) {
  return store.listAudit(600).filter((row) => row.action === action);
}
/**
 * The fake hub has no dispatcher: mark every sent order acknowledged, or the
 * executor waits on `pendingOrder` and never re-enters its state machine.
 */
function ackAll(store: Store, sent: Record<string, unknown>[], now: number) {
  for (const m of sent) {
    if (m.type !== 'order') continue;
    const id = String(m.orderId);
    const order = store.getOrder(id);
    if (order && order.status !== 'acked') store.updateOrder(id, { status: 'acked', ackedAt: now });
  }
}

/** Dispatch the leg's single move and return the speed the executor commanded. */
function dispatch(ctx: ReturnType<typeof setup>) {
  ctx.placeAt(4_000, 0, 0);
  ctx.executor.tick();
  ackAll(ctx.store, ctx.sent, ctx.clock.now);
  const move = moves(ctx.sent)[0];
  expect(move, 'the leg must send one move').toBeTruthy();
  return Number((move!.params as { speed?: number }).speed);
}

describe('arrival loop guard (FAILURE 2, 2026-11-10)', () => {
  it('(c) aborts a hull that only achieves 30 % of its commanded speed, with both numbers', () => {
    const ctx = setup();
    const commanded = dispatch(ctx);
    expect(commanded).toBeGreaterThan(50); // a real cruise command, not an arrival cap
    const achieved = Math.round(commanded * 0.3);

    // The hull makes 30 % of the commanded speed but does not close: it circles
    // its slot at a constant 4 km (the measured in-game geometry).
    let bearing = 0;
    let abortedAt = -1;
    for (let i = 1; i <= 40; i += 1) {
      ctx.clock.now += 1_000;
      bearing += (achieved / 4_000) * 1; // rad/s: tangential, range constant
      ctx.placeAt(4_000, bearing, achieved);
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent, ctx.clock.now);
      if (ctx.droneRow().state === 'aborted') {
        abortedAt = i;
        break;
      }
    }

    expect(abortedAt, 'the leg must be aborted, not left cycling').toBeGreaterThan(0);
    // Grace for spin-up, then more than 10 s of the shortfall: ~25 s, and far
    // short of the 240 s arrival watchdog.
    expect(abortedAt).toBeGreaterThan(ARRIVAL_SHORTFALL_GRACE_MS / 1_000);
    expect(abortedAt).toBeLessThan(40);

    const aborts = audit(ctx.store, 'demo_flight_abort');
    expect(aborts).toHaveLength(1);
    const detail = aborts[0]!.detail as {
      code?: string;
      reason?: string;
      commandedSpeedMps?: number;
      achievedSpeedMps?: number;
      shortfallSeconds?: number;
    };
    expect(detail.code).toBe('hull-speed');
    expect(String(detail.reason)).toMatch(/hull cannot achieve commanded speed/);
    expect(detail.commandedSpeedMps).toBeCloseTo(commanded, 1);
    expect(detail.achievedSpeedMps).toBeCloseTo(achieved, 1);
    expect(Number(detail.shortfallSeconds)).toBeGreaterThanOrEqual(ARRIVAL_SHORTFALL_MS / 1_000);

    // The explicit stuck row carries commanded vs achieved as well.
    const stuck = audit(ctx.store, 'demo_arrival_stuck');
    expect(stuck).toHaveLength(1);
    const stuckDetail = stuck[0]!.detail as { commandedSpeedMps?: number; achievedSpeedMps?: number };
    expect(stuckDetail.commandedSpeedMps).toBeCloseTo(commanded, 1);
    expect(stuckDetail.achievedSpeedMps).toBeCloseTo(achieved, 1);
    expect(achieved / commanded).toBeLessThan(ARRIVAL_SHORTFALL_RATIO);

    // Held, never arrived: the mission never reaches `done`.
    expect(ctx.droneRow().state).toBe('aborted');
    const holds = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'hold');
    expect(holds.length).toBeGreaterThan(0);
  });

  it('(d) stops and reports a distance limit cycle (65 -> 295 -> 65) instead of cycling', () => {
    // A slow approach the hull CAN fly: commanded 5 m/s, achieved 3 m/s, so the
    // speed-shortfall detector stays quiet and only the range oscillation is
    // being tested.
    const ctx = setup({ speedLimitMps: 5 });
    const commanded = dispatch(ctx);
    expect(commanded).toBe(5);

    // Telemetry every 10 s at 3 m/s: 30 m of travel per sample.
    const distances = [65, 95, 125, 155, 185, 215, 245, 275, 295, 265, 235, 205, 175, 145, 115, 85, 65, 95, 125, 155];
    let swingAtAbort = 0;
    let remainingAtAbort = 0;
    let stopped = false;
    for (let i = 0; i < distances.length; i += 1) {
      ctx.clock.now += 10_000;
      const d = distances[i]!;
      ctx.placeAt(d, 0.1 * i, 3);
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent, ctx.clock.now);
      if (ctx.droneRow().state === 'aborted') {
        remainingAtAbort = d;
        stopped = true;
        const abort = audit(ctx.store, 'demo_flight_abort')[0];
        swingAtAbort = Number((abort?.detail as { code?: string })?.code === 'limit-cycle' ? 1 : 0);
        break;
      }
    }

    expect(stopped, 'the oscillation must be stopped, not flown for 300 s').toBe(true);
    expect(swingAtAbort).toBe(1);

    // Two swings are audited, each with its amplitude, in plain language.
    const swings = audit(ctx.store, 'demo_arrival_swing');
    expect(swings.length).toBeGreaterThanOrEqual(2);
    const first = swings[0]!.detail as { amplitudeM?: number; closestApproachM?: number; note?: string };
    expect(Number(first.amplitudeM)).toBeGreaterThanOrEqual(ARRIVAL_CYCLE_AMPLITUDE_M);
    expect(Number(first.closestApproachM)).toBe(65);
    expect(String(first.note)).toMatch(/came in and went back out/);

    const abort = audit(ctx.store, 'demo_flight_abort')[0]!;
    const detail = abort.detail as { code?: string; reason?: string };
    expect(detail.code).toBe('limit-cycle');
    expect(String(detail.reason)).toMatch(/arrival limit cycle/);
    expect(String(detail.reason)).toMatch(/orbiting the slot instead of arriving/);

    // It stopped on the second climb back out, well before 295 m again.
    expect(remainingAtAbort).toBeLessThan(295);
    expect(ctx.droneRow().state).toBe('aborted');
    const holds = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'hold');
    expect(holds.length).toBeGreaterThan(0);
  });
});
