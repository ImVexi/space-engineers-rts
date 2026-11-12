/**
 * T52 controlled-fall descent.
 *
 * A gravity descent used to be flown with dampeners on for the whole leg: the
 * autopilot held the ship against gravity and it crept down at ~5 m/s. These
 * tests pin the replacement:
 *
 *   fall (dampeners off, no thrust) -> one brake move at a computed altitude
 *   -> the existing 5/1 m/s arrival caps.
 *
 * The fake plugin answers the read-only `inspect` with SAT-R-0002's measured
 * lift (37,609 kg, 982,956 N up at 2.4 km AGL), so no game server is needed.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { computeDescentProfile } from '../src/demo/flight.js';
import { emergencyFor } from '../src/demo/staging/policy.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('EarthLike')!;
const SURFACE = Number(PLANET.surfaceRadiusM);
const G = 9.81;
const MASS_KG = 37_609;
/** Measured SAT-R-0002 upward thrust at 2.4 km AGL. */
const LIFT_N = 982_956;

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

/**
 * Flat-ground terrain fixture: the height field reports the catalogue mean at
 * every column, so the AGL numbers in these tests are the ones the profile
 * maths produces and the ground datum is KNOWN ('terrain'), not the uncertain
 * mean. Without a field the executor now refuses a 0 m AGL descent outright —
 * on the real test world the ground is 1 616.7 m above the mean.
 */
function flatTerrain(radiusM = SURFACE): TerrainField {
  return {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    status: 'available',
    reason: null,
    tiles: 1,
    radiusAt: () => radiusM,
  };
}

function makeStore() {
  const config = makeConfig();
  // The shipped default is the SE autopilot ceiling (100); the test helper's
  // legacy fixture says 60, so pin the validated value here.
  config.demo.speedLimitMps = 100;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  return { store, config };
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
      assignedUnits: [],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: {}, done: false },
          { id: 'deploy-0', kind: 'print', params: { prefab: 'Eradicator_mk.1', role: 'relay', position: { x: 0, y: 0, z: SURFACE + 500 } }, done: false },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] descent-profile test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/** The drone is one `move` step from `startAgl` to `targetAgl`. */
function setupDescent(
  opts: { startAgl?: number; targetAgl?: number; meta?: Record<string, unknown> } = {},
) {
  const { store, config } = makeStore();
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
  const m = mission(store);
  store.setKv('demo:identityId', '10000000000000001');
  // An owner-tagged grid: no registry hardware, so the executor cannot quietly
  // borrow a thrust split. The gate still gets its measured 50 km radio.
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:r2': 50_000 }));
  executor.sync(NOW);
  // First tick runs `ensureIdentity` while the drone is still queued; it reads
  // the cached test identity. Everything it sends (spawn) is discarded.
  executor.tick();
  sent.length = 0;

  const startAgl = opts.startAgl ?? 5_000;
  // 200 m, not 0: the ground-datum rule (2026-11-10) refuses a controlled fall
  // whose brake point would sit below true ground + 100 m, so a 0 m AGL
  // landing is flown dampened, not as a gravity fall.
  const targetAgl = opts.targetAgl ?? 200;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:r2', planet = 'EarthLike',
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:r2'
       WHERE mission_id = ?`,
    )
    .run(JSON.stringify({ x: 0, y: 0, z: SURFACE + targetAgl }), m.id);

  const place = (radius: number, vertical = 0, now = clock.now, extraMeta: Record<string, unknown> = {}) => {
    store.upsertUnit({
      id: 'grid:r2',
      name: 'SAT-R-0002',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: { x: 0, y: 0, z: radius },
      vel: { x: 0, y: 0, z: vertical },
      meta: {
        massKg: MASS_KG,
        fuelFraction: 0.9,
        powerFraction: 0.9,
        underControl: false,
        ...opts.meta,
        ...extraMeta,
      },
    });
  };
  place(SURFACE + startAgl);
  return { store, config, sent, executor, mission: m, clock, place };
}

function satThrusters(upN = LIFT_N) {
  const each = upN / 12;
  return Array.from({ length: 12 }, (_, i) => ({
    name: `Small Thruster ${i}`,
    enabled: true,
    working: true,
    axisWorld: { x: 0, y: 0, z: -1 },
    maxThrustN: each,
    maxEffectiveThrustN: each,
  }));
}

function answerInspect(store: Store, orderId: string, thrusters: unknown, now: number, ok = true) {
  store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: { eventType: 'order_result', data: { orderId, ok, result: { thrusters } } },
    at: now,
  });
}

function orders(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order');
}
function actionOf(m: Record<string, unknown>): string | null {
  const params = m.params as Record<string, unknown> | undefined;
  return typeof params?.action === 'string' ? params.action : null;
}
function moves(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'move');
}
function holds(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'hold');
}
function dampenerOrders(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => actionOf(m) === 'set_dampeners');
}

function firstInspect(sent: Record<string, unknown>[]) {
  return orders(sent).find((m) => actionOf(m) === 'inspect');
}

function audit(store: Store, action: string) {
  return store.listAudit(400).filter((row) => row.action === action);
}

/** The fake hub has no dispatcher: mark sent orders acknowledged. */
function ackSent(store: Store, sent: Record<string, unknown>[], now: number) {
  for (const m of orders(sent)) {
    const id = String(m.orderId);
    const order = store.getOrder(id);
    if (order && order.status !== 'acked') store.updateOrder(id, { status: 'acked', ackedAt: now });
  }
}

/** The inspect probe -> accepted fall plan. */
function startFall(store: Store, sent: Record<string, unknown>[], executor: DemoExecutor, clock: { now: number }) {
  executor.tick();
  const inspect = firstInspect(sent);
  expect(inspect, 'descent must start with a measured-lift inspect').toBeTruthy();
  answerInspect(store, String(inspect!.orderId), satThrusters(), clock.now);
  executor.tick();
  const fall = audit(store, 'demo_descent_fall');
  expect(fall, 'measured lift and a long drop must enter fall mode').toHaveLength(1);
  return { plan: fall[0]!.detail as Record<string, number>, inspect };
}

/**
 * Ballistic fall with dampeners off: a = g, no drag (SE grids have no
 * meaningful aerodynamic drag). Returns the first brake altitude.
 */
function fallToBrake(
  executor: DemoExecutor,
  sent: Record<string, unknown>[],
  clock: { now: number },
  place: (radius: number, vertical?: number, now?: number) => void,
  startAgl: number,
  targetAgl: number,
) {
  let radius = SURFACE + startAgl;
  let v = 0;
  let maxSpeed = 0;
  for (let i = 0; i < 4_000; i += 1) {
    const before = moves(sent).length;
    const dt = 0.2;
    clock.now += dt * 1_000;
    v = Math.min(100, v + G * dt);
    radius -= v * dt;
    maxSpeed = Math.max(maxSpeed, v);
    place(radius, -v, clock.now);
    executor.tick();
    if (moves(sent).length > before) {
      return { altitudeAgl: radius - SURFACE, speed: v, maxSpeed, move: moves(sent)[moves(sent).length - 1]! };
    }
  }
  throw new Error('fall never reached the brake point');
}

describe('controlled-fall descent (SAT-R-0002 measured numbers)', () => {
  it('(a) falls at the cap and brakes within 10% of the computed altitude', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    const { plan } = startFall(ctx.store, ctx.sent, ctx.executor, ctx.clock);
    // The audit carries the plan; compute the expected value independently.
    const expected = computeDescentProfile({
      massKg: MASS_KG,
      measuredUpThrustN: LIFT_N,
      measuredAtAglM: 5_000,
      altitudeAglM: 5_000,
      targetAglM: 200,
      planet: PLANET,
      maxCruiseMps: ctx.config.demo.speedLimitMps,
    });
    expect(expected.mode).toBe('controlled-fall');
    expect(expected.vFallMps).toBe(100);
    expect(expected.brakeDecelMps2).toBeCloseTo(16.33, 1);
    expect(plan.brakeAltAglM).toBeCloseTo(expected.brakeAltAglM, 0);

    const result = fallToBrake(ctx.executor, ctx.sent, ctx.clock, ctx.place, 5_000, 200);
    expect(result.maxSpeed).toBeGreaterThanOrEqual(expected.vFallMps * 0.995);
    const offline = Math.abs(result.altitudeAgl - expected.brakeAltAglM) / expected.brakeAltAglM;
    expect(offline, `brake at ${result.altitudeAgl} m, planned ${expected.brakeAltAglM} m`).toBeLessThan(0.1);
    const params = result.move.params as { speed?: number };
    expect(params.speed).toBe(expected.finalApproachMps);
  });

  it('(b) sends one order per phase, never one per tick', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    startFall(ctx.store, ctx.sent, ctx.executor, ctx.clock);
    const fallDampeners = dampenerOrders(ctx.sent);
    expect(fallDampeners).toHaveLength(1);
    expect((fallDampeners[0]!.params as { on?: boolean }).on).toBe(false);
    expect(moves(ctx.sent)).toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(0);

    // Ten waiting ticks: the fall monitor may not emit a single order.
    let radius = SURFACE + 5_000;
    let v = 0;
    const before = orders(ctx.sent).length;
    for (let i = 0; i < 10; i += 1) {
      ctx.clock.now += 200;
      v = Math.min(100, v + G * 0.2);
      radius -= v * 0.2;
      ctx.place(radius, -v, ctx.clock.now);
      ctx.executor.tick();
    }
    expect(orders(ctx.sent).length).toBe(before);

    const brake = fallToBrake(ctx.executor, ctx.sent, ctx.clock, ctx.place, radius - SURFACE, 0);
    expect(moves(ctx.sent)).toHaveLength(1);
    // No second move on the very next tick: the resend policy is not per tick.
    const dt = 0.2;
    let v2 = brake.speed;
    let r2 = SURFACE + brake.altitudeAgl;
    ctx.clock.now += dt * 1_000;
    v2 = Math.max(0, v2 - 16.3 * dt);
    r2 -= v2 * dt;
    ctx.place(r2, -v2, ctx.clock.now);
    ctx.executor.tick();
    expect(moves(ctx.sent)).toHaveLength(1);
  });

  it('(c) never falls when upward thrust is unmeasured, and records why', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    ctx.executor.tick();
    const inspect = firstInspect(ctx.sent);
    expect(inspect).toBeTruthy();
    // Thrusters pointing sideways: no lift along the local up vector.
    answerInspect(
      ctx.store,
      String(inspect!.orderId),
      Array.from({ length: 12 }, (_, i) => ({
        name: `Small Thruster ${i}`,
        enabled: true,
        working: true,
        axisWorld: { x: 1, y: 0, z: 0 },
        maxEffectiveThrustN: 100_000,
      })),
      ctx.clock.now,
    );
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    expect(dampenerOrders(ctx.sent)).toHaveLength(0);
    const rejected = audit(ctx.store, 'demo_descent_rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0]!.detail as { reason?: string }).reason)).toMatch(/not measured/);
    // It still flies the leg with today's dampened move.
    expect(moves(ctx.sent)).toHaveLength(1);
  });

  it('(d) never falls when net upward brake authority is below 2 m/s²', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    ctx.executor.tick();
    const inspect = firstInspect(ctx.sent);
    // 37,609 kg * (9.81 + 1.5) -> a_brake 1.5 m/s².
    answerInspect(ctx.store, String(inspect!.orderId), satThrusters(MASS_KG * (G + 1.5)), ctx.clock.now);
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    expect(dampenerOrders(ctx.sent)).toHaveLength(0);
    const rejected = audit(ctx.store, 'demo_descent_rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0]!.detail as { reason?: string }).reason)).toMatch(/below the 2 m\/s²/);
    expect(moves(ctx.sent)).toHaveLength(1);
  });

  it('(e) keeps the precise dampened mode under 300 m', () => {
    const ctx = setupDescent({ startAgl: 200, targetAgl: 0 });
    ctx.executor.tick();
    expect(firstInspect(ctx.sent)).toBeUndefined();
    expect(dampenerOrders(ctx.sent)).toHaveLength(0);
    expect(moves(ctx.sent)).toHaveLength(1);
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
  });

  it('(f) late telemetry at the brake altitude takes the immediate full-brake path', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    const { plan } = startFall(ctx.store, ctx.sent, ctx.executor, ctx.clock);
    // Fall normally to just above the brake altitude, then report a speed well
    // above what the brake can stop (as a late sample would).
    let radius = SURFACE + 5_000;
    let v = 0;
    while (radius - SURFACE > Number(plan.brakeAltAglM) + 40) {
      const dt = 0.2;
      ctx.clock.now += dt * 1_000;
      v = Math.min(100, v + G * dt);
      radius -= v * dt;
      ctx.place(radius, -v, ctx.clock.now);
      ctx.executor.tick();
    }
    expect(moves(ctx.sent)).toHaveLength(0);
    ctx.clock.now += 200;
    ctx.place(radius - 20, -160, ctx.clock.now);
    ctx.executor.tick();
    const late = audit(ctx.store, 'demo_descent_late_brake');
    expect(late).toHaveLength(1);
    expect(String((late[0]!.detail as { reason?: string }).reason)).toMatch(/late telemetry/);
    const fullBrake = dampenerOrders(ctx.sent).filter(
      (m) => (m.params as { on?: boolean }).on === true,
    );
    expect(fullBrake).toHaveLength(1);
    expect(moves(ctx.sent)).toHaveLength(0);
  });

  it('(g) staging does not call a planned fall an emergency, but a holding ship falling still trips', () => {
    const base = { phase: 'climb' as const, altitudeM: 3_000, verticalSpeedMps: -40, batteryPct: 90, massKg: MASS_KG };
    expect(emergencyFor({ ...base, plannedDescent: true })).toBeNull();
    expect(emergencyFor(base)).toMatch(/vertical speed/);
    // A holding ship has no descent plan, so a fall is an emergency.
    expect(emergencyFor({ ...base, phase: 'hold', plannedDescent: false })).toMatch(/holding/);
    // Battery emergency still wins even during a planned fall.
    expect(emergencyFor({ ...base, batteryPct: 10, plannedDescent: true })).toMatch(/battery/);
  });

  it('(h) a piloted grid gets zero orders', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200, meta: { underControl: true, controlledBy: 'the owner' } });
    ctx.executor.tick();
    const forbidden = orders(ctx.sent).filter(
      (m) =>
        m.orderType === 'move' ||
        m.orderType === 'hold' ||
        m.orderType === 'stop' ||
        actionOf(m) === 'set_dampeners' ||
        actionOf(m) === 'set_block_props',
    );
    expect(forbidden).toHaveLength(0);
    expect(firstInspect(ctx.sent)).toBeUndefined();
    const row = ctx.store.db.prepare(`SELECT state FROM demo_drones WHERE mission_id = ?`).get(ctx.mission.id) as {
      state: string;
    };
    expect(row.state).toBe('manual');
  });

  it('(i) the ground guard never fires in the nominal 5 km descent', () => {
    const ctx = setupDescent({ startAgl: 5_000, targetAgl: 200 });
    startFall(ctx.store, ctx.sent, ctx.executor, ctx.clock);
    let radius = SURFACE + 5_000;
    let v = 0;
    let lastMoveSpeed = 0;
    let braked = false;
    for (let i = 0; i < 20_000; i += 1) {
      const dt = 0.25;
      ctx.clock.now += dt * 1_000;
      const beforeMoves = moves(ctx.sent).length;
      const beforeHolds = holds(ctx.sent).length;
      if (!braked) {
        // Ballistic fall until the executor sends the brake move.
        v = Math.min(100, v + G * dt);
        radius -= v * dt;
      } else {
        // Dampeners on: the autopilot closes at its commanded speed and brakes
        // at the measured authority.
        const distance = radius - (SURFACE + 0);
        const targetV = Math.min(lastMoveSpeed, Math.sqrt(2 * 16.33 * Math.max(0, distance)));
        v = v > targetV ? Math.max(targetV, v - 16.33 * dt) : Math.min(targetV, v + 16.33 * dt);
        radius -= v * dt;
      }
      ctx.place(radius, -v, ctx.clock.now);
      ctx.executor.tick();
      ackSent(ctx.store, ctx.sent, ctx.clock.now);
      if (moves(ctx.sent).length > beforeMoves) {
        const speed = Number((moves(ctx.sent)[moves(ctx.sent).length - 1]!.params as { speed?: number }).speed);
        lastMoveSpeed = speed;
        if (!braked) {
          braked = true;
          v = Math.min(v, 100);
        }
      }
      if (holds(ctx.sent).length > beforeHolds) break;
    }
    expect(holds(ctx.sent).length).toBeGreaterThan(0);
    // One hold at arrival, and at most the brake move plus the 10 m arrival
    // throttle: no per-tick re-sends anywhere in the leg.
    expect(holds(ctx.sent)).toHaveLength(1);
    expect(moves(ctx.sent).length).toBeLessThanOrEqual(2);
    expect(audit(ctx.store, 'demo_descent_late_brake')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_guard_brake')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_flight_abort')).toHaveLength(0);
    const row = ctx.store.db.prepare(`SELECT state FROM demo_drones WHERE mission_id = ?`).get(ctx.mission.id) as {
      state: string;
    };
    expect(row.state).toBe('holding');
  });
});
