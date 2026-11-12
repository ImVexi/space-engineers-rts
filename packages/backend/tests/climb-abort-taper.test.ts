/**
 * 2026-11-11 in-game climb abort (data/flight-proof-20261111.md, defect 5).
 *
 * SAT-R-0001 climbed to its 760 m slot, reached 761.6 m hull-bottom AGL - the
 * slot's altitude - with 143 m of lateral trim left, and settled at 2.7 m/s.
 * The arrival guard compared that against the ladder step's 63.3 m/s command
 * (4 %) for 10 s while the range closed at 0.5 m/s and aborted a climb that had
 * arrived:
 *
 *   "hull cannot achieve commanded speed: commanded 63.3 m/s, achieved 2.7 m/s
 *    (4 %) for 10 s while the distance closed at 0.5 m/s (143 m to the slot)"
 *
 * Two rules now keep that state from being read as a hull failure:
 *   1. the speed guards compare against the speed the leg is ACTUALLY asking
 *      for at this range (`arrivalCommandSpeedMps`: the order limit tapered by
 *      the braking maths and the 5/1 m/s arrival caps), never the cruise
 *      command on a ship that has arrived; and
 *   2. inside ARRIVAL_SETTLE_RANGE_M with the altitude already made
 *      (|vertical miss| <= ARRIVAL_SETTLE_VERTICAL_M) the speed detectors are
 *      silent - the arrival taper owns the speed there - and the executor
 *      re-issues the leg to the slot so the climb finishes.
 *
 * A hull that is genuinely stuck (4 km out, 30 % of its command, not closing)
 * must still abort: that case is pinned by arrival-loop-guard.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import {
  ARRIVAL_SETTLE_RANGE_M,
  ARRIVAL_SETTLE_VERTICAL_M,
  arrivalCommandSpeedMps,
  arrivalProgress,
  emptyArrivalProgress,
} from '../src/demo/flight.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const SURFACE = 59_400;
const MASS_KG = 37_609;
/** The logged command and settle numbers. */
const LOGGED = { commandedMps: 63.3, achievedMps: 2.7, remainingM: 143, closingMps: 0.5, dwellS: 10 };

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

describe('the arrival taper is the commanded speed (2026-11-11)', () => {
  it('never asks a settled leg for its cruise command, and caps inside 100 m / 10 m', () => {
    // The real hull: 37.6 t with ~2.1 MN of atmospheric lift, so ~46 m/s² of
    // braking authority. At 143 m nothing forces a slow-down, so the order's
    // own 63.3 m/s stands - the guard's command must not EXCEED the order.
    expect(arrivalCommandSpeedMps({ legLimitMps: LOGGED.commandedMps, remainingM: 143, decelMps2: 46 })).toBeCloseTo(63.3, 1);
    // Inside the terminal caps the taper owns the ship: 5 m/s under 100 m,
    // 1 m/s under 10 m - and the achieved speed is then judged against those.
    expect(arrivalCommandSpeedMps({ legLimitMps: 100, remainingM: 90, decelMps2: 46 })).toBe(5);
    expect(arrivalCommandSpeedMps({ legLimitMps: 100, remainingM: 9, decelMps2: 46 })).toBe(1);
    // A weak hull is limited by its own braking distance, not by the order.
    const weak = arrivalCommandSpeedMps({ legLimitMps: 100, remainingM: 400, decelMps2: 1 });
    expect(weak).toBeLessThan(30);
    expect(weak).toBeGreaterThan(10);
    // Unknown deceleration must never RAISE the command above what was ordered.
    expect(arrivalCommandSpeedMps({ legLimitMps: 63.3, remainingM: 5, decelMps2: 0 })).toBe(63.3);
    expect(arrivalCommandSpeedMps({ legLimitMps: 63.3, remainingM: 5, decelMps2: 0, plannedCruiseMps: 40 })).toBe(40);
  });

  it('suppresses the shortfall detector on the final settle, and keeps it everywhere else', () => {
    // The logged state: 143 m to the slot, altitude made, 2.7 of 63.3 m/s.
    let state = emptyArrivalProgress();
    let progress = arrivalProgress(state, {
      nowMs: NOW,
      remainingM: LOGGED.remainingM,
      speedMps: LOGGED.achievedMps,
      commandedMps: LOGGED.commandedMps,
      verticalMissM: 1.6,
      legStartedAtMs: NOW - 120_000,
      observedAtMs: NOW,
    });
    state = progress.state;
    expect(progress.settle).toBe(true);
    for (let i = 1; i <= 20; i += 1) {
      progress = arrivalProgress(state, {
        nowMs: NOW + i * 1_000,
        remainingM: LOGGED.remainingM,
        speedMps: LOGGED.achievedMps,
        commandedMps: LOGGED.commandedMps,
        verticalMissM: 1.6,
        legStartedAtMs: NOW - 120_000,
        observedAtMs: NOW + i * 1_000,
      });
      state = progress.state;
      expect(progress.stuck, 'a settled climb must not be reported as a stuck hull').toBeNull();
    }

    // The same speed 4 km out with its altitude unmade (the measured 2026-11-10
    // hover-ceiling failure) is still a stuck hull.
    let far = emptyArrivalProgress();
    let farProgress = arrivalProgress(far, {
      nowMs: NOW,
      remainingM: 4_000,
      speedMps: LOGGED.achievedMps,
      commandedMps: LOGGED.commandedMps,
      verticalMissM: 3_000,
      legStartedAtMs: NOW - 120_000,
      observedAtMs: NOW,
    });
    far = farProgress.state;
    for (let i = 1; i <= 20; i += 1) {
      farProgress = arrivalProgress(far, {
        nowMs: NOW + i * 1_000,
        remainingM: 4_000,
        speedMps: LOGGED.achievedMps,
        commandedMps: LOGGED.commandedMps,
        verticalMissM: 3_000,
        legStartedAtMs: NOW - 120_000,
        observedAtMs: NOW + i * 1_000,
      });
      far = farProgress.state;
    }
    expect(farProgress.stuck).not.toBeNull();
    expect(farProgress.stuck!.commandedMps).toBeCloseTo(LOGGED.commandedMps, 1);

    // The settle band itself: 200 m, and the altitude has to be made.
    expect(ARRIVAL_SETTLE_RANGE_M).toBe(200);
    expect(ARRIVAL_SETTLE_VERTICAL_M).toBe(25);
  });
});

// ---------------------------------------------------------------- executor

function setup() {
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
        notes: '[SIMULATED] climb-abort taper test',
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
  executor.tick();
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

  /** Place the hull on the slot's own radius (altitude made), `offsetM` to the side. */
  const placeOffset = (offsetM: number, speedMps: number) => {
    store.upsertUnit({
      id: 'grid:g1',
      name: 'SAT-R-0001',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: clock.now,
      pos: { x: slot.x, y: offsetM, z: 0 },
      vel: { x: 0, y: -speedMps, z: 0 },
      meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
  };
  const droneRow = () =>
    store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string | null };
  return { store, sent, clock, executor, mission, slot, placeOffset, droneRow };
}

function audit(store: Store, action: string) {
  return store.listAudit(600).filter((row) => row.action === action);
}

function ackAll(store: Store, sent: Record<string, unknown>[], now: number) {
  for (const m of sent) {
    if (m.type !== 'order') continue;
    const id = String(m.orderId);
    const order = store.getOrder(id);
    if (!order) continue;
    if (order.status !== 'acked') store.updateOrder(id, { status: 'acked', ackedAt: now });
    // The executor clears `pendingOrder` on the plugin's order_result, not on
    // the ack: answer it the way the real plugin does.
    store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: { eventType: 'order_result', data: { orderId: id, ok: true, result: { accepted: true } } },
      at: now,
    });
  }
}

describe('the logged climb finishes instead of aborting (2026-11-11)', () => {
  it('re-issues the leg to the slot and never reports a stuck hull at 143 m with the altitude made', () => {
    const ctx = setup();
    // Dispatch the leg from 300 m away, then reproduce the logged settle: the
    // altitude is made and the hull sits 143 m to the side at 2.7 m/s.
    ctx.placeOffset(300, 0);
    ctx.executor.tick();
    ackAll(ctx.store, ctx.sent, ctx.clock.now);
    const first = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'move');
    expect(first.length, 'the leg must send its move').toBeGreaterThan(0);

    let moves = 0;
    for (let i = 1; i <= 30; i += 1) {
      ctx.clock.now += 1_000;
      ctx.placeOffset(143, 2.7);
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent, ctx.clock.now);
      moves = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'move').length;
      expect(ctx.droneRow().state, 'the climb must not be aborted').not.toBe('aborted');
    }

    // Nothing blamed the hull...
    expect(audit(ctx.store, 'demo_arrival_stuck')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_flight_abort')).toHaveLength(0);
    // ...and the leg to the slot itself was re-issued so the climb can finish.
    const reissue = audit(ctx.store, 'demo_arrival_settle_reissue');
    expect(reissue.length).toBeGreaterThan(0);
    const detail = reissue[0]!.detail as { remainingM: number; verticalMissM: number; note: string };
    expect(detail.remainingM).toBe(143);
    expect(Math.abs(detail.verticalMissM)).toBeLessThanOrEqual(ARRIVAL_SETTLE_VERTICAL_M);
    expect(String(detail.note)).toMatch(/re-issued/);
    expect(moves).toBeGreaterThan(1);

    // (The arrival hold itself needs a provisioned control source, which this
    // fixture world has none of - the leg is proven here by the re-issue and by
    // the mission still flying, not by the hold.)
  });
});
