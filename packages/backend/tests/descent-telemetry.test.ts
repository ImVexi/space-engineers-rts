/**
 * FAILURE 1 of the overnight in-game run (2026-11-10): the controlled-fall
 * descent never started.
 *
 * On the test server SAT-R-0002 was ordered from 5 000 m AGL to 200 m and sat
 * at 5 000.0 m with speed 0 for 360 s. The audit showed a repeating
 * `demo:probe hit:false`: `probe_ground` cannot hit procedural planet terrain
 * on this build (MyVoxelBase.GetIntersectionWithLine -> Storage.GetGeometry()
 * is null), so a descent that needs the probe never leaves `measuring`.
 *
 * These tests pin the replacement: the altitude comes from telemetry —
 * AGL = |position - planetCentre| - surfaceRadiusM — and the probe is
 * opportunistic only. The world is Mars, whose centre is NOT the origin
 * (1031 km, 131 km, 1631 km), so an origin-referenced `|position|` gives a
 * ~1.9 million metre altitude and the descent is refused outright: exactly the
 * "descent never starts" symptom, with no game server needed.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { computeDescentProfile } from '../src/demo/flight.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import { planetGravity, gravityAtAltitude } from '../src/demo/designer/gravity.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('Mars')!;
const CENTRE = PLANET.center as { x: number; y: number; z: number };
const SURFACE = Number(PLANET.surfaceRadiusM);
const MASS_KG = 37_609;
/** SAT-R-0002's measured upward thrust. */
const LIFT_N = 982_956;
const START_AGL = 5_000;
const TARGET_AGL = 200;

/**
 * Flat-ground terrain fixture for Mars: the height field reports the catalogue
 * mean at every column. That keeps this file about the PROBE (which cannot hit
 * procedural terrain) while the ground datum is known ('terrain'); the mean
 * band is covered by descent-ground-datum.test.ts.
 */
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

function makeStore() {
  const config = makeConfig();
  config.demo.speedLimitMps = 100;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  return { store, config };
}

function mission(store: Store, slot: { x: number; y: number; z: number }) {
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
        notes: '[SIMULATED] descent-telemetry test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/** The drone is one `move` step from START_AGL to TARGET_AGL on Mars. */
function setupDescent(opts: { planet: string | null } = { planet: 'Mars' }) {
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
  const slot = { x: CENTRE.x, y: CENTRE.y, z: CENTRE.z + SURFACE + TARGET_AGL };
  const m = mission(store, slot);
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:r2': 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity, everything it sends is discarded
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:r2', planet = ?,
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:r2'
       WHERE mission_id = ?`,
    )
    .run(opts.planet, JSON.stringify(slot), m.id);

  const place = (radius: number, vertical = 0, now = clock.now) => {
    store.upsertUnit({
      id: 'grid:r2',
      name: 'SAT-R-0002',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: { x: CENTRE.x, y: CENTRE.y, z: CENTRE.z + radius },
      vel: { x: 0, y: 0, z: vertical },
      meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
  };
  place(SURFACE + START_AGL);
  return { store, config, sent, executor, mission: m, clock, place, slot };
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
function audit(store: Store, action: string) {
  return store.listAudit(600).filter((row) => row.action === action);
}
function answerInspect(store: Store, orderId: string, thrusters: unknown, now: number) {
  store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: { eventType: 'order_result', data: { orderId, ok: true, result: { thrusters } } },
    at: now,
  });
}
/** `probe_ground` cannot hit procedural planet terrain: answer every probe with a miss. */
function answerProbesMissed(store: Store, sent: Record<string, unknown>[], now: number): number {
  let answered = 0;
  for (const m of orders(sent)) {
    if (actionOf(m) !== 'probe_ground') continue;
    const id = String(m.orderId);
    if ((m as { __answered?: boolean }).__answered) continue;
    (m as { __answered?: boolean }).__answered = true;
    store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: {
        eventType: 'order_result',
        data: { orderId: id, ok: true, result: { hit: false, isGrid: false } },
      },
      at: now,
    });
    answered += 1;
  }
  return answered;
}

describe('descent from telemetry AGL (FAILURE 1, 2026-11-10)', () => {
  it('(a) starts with probe_ground answering hit:false and reaches the brake phase on telemetry AGL', () => {
    const ctx = setupDescent();
    ctx.executor.tick();

    // 1. The descent is planned from telemetry, not from a ground probe.
    const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect');
    expect(inspect, 'descent must start with the measured-lift inspect').toBeTruthy();
    const measured = audit(ctx.store, 'demo_descent_measure');
    expect(measured).toHaveLength(1);
    const measureDetail = measured[0]!.detail as {
      groundSource?: string;
      groundUncertaintyM?: number;
      altitudeAglM?: number;
      dropM?: number;
    };
    expect(measureDetail.groundSource).toBe('terrain');
    expect(measureDetail.groundUncertaintyM).toBe(0);
    expect(measureDetail.altitudeAglM).toBe(START_AGL);
    expect(measureDetail.dropM).toBe(START_AGL - TARGET_AGL);

    // 2. Measured lift + a long drop => the controlled fall is accepted.
    answerInspect(ctx.store, String(inspect!.orderId), satThrusters(), ctx.clock.now);
    ctx.executor.tick();
    const fall = audit(ctx.store, 'demo_descent_fall');
    expect(fall, 'a measured 4 800 m drop must enter fall mode').toHaveLength(1);
    const fallDetail = fall[0]!.detail as {
      groundSource?: string;
      groundUncertaintyM?: number;
      altitudeAglM?: number;
      brakeAltAglM?: number;
      vFallMps?: number;
    };
    expect(fallDetail.groundSource).toBe('terrain');
    expect(fallDetail.groundUncertaintyM).toBe(0);
    expect(fallDetail.altitudeAglM).toBe(START_AGL);

    // The plan is the same one the pure model computes for Mars.
    const expected = computeDescentProfile({
      massKg: MASS_KG,
      measuredUpThrustN: LIFT_N,
      measuredAtAglM: START_AGL,
      altitudeAglM: START_AGL,
      targetAglM: TARGET_AGL,
      planet: PLANET,
      maxCruiseMps: 100,
    });
    expect(expected.mode).toBe('controlled-fall');
    expect(fallDetail.brakeAltAglM).toBeCloseTo(expected.brakeAltAglM, 0);
    expect(fallDetail.vFallMps).toBe(expected.vFallMps);

    // 3. Ballistic fall. Every probe the executor fires is answered hit:false,
    //    exactly as the real plugin does on procedural planet terrain.
    const g = planetGravity(PLANET);
    let radius = SURFACE + START_AGL;
    let v = 0;
    let probesAnswered = 0;
    let fallSeconds = 0;
    let braking = false;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.2;
      ctx.clock.now += dt * 1_000;
      const altitude = radius - SURFACE;
      v = Math.min(expected.vFallMps, v + gravityAtAltitude(g, altitude) * dt);
      radius -= v * dt;
      ctx.place(radius, -v, ctx.clock.now);
      ctx.executor.tick();
      probesAnswered += answerProbesMissed(ctx.store, ctx.sent, ctx.clock.now);
      if (!braking) fallSeconds += dt;
      if (moves(ctx.sent).length > 0) {
        braking = true;
        break;
      }
    }
    expect(probesAnswered, 'the probe must really have been fired and missed').toBeGreaterThan(0);
    expect(braking, 'the fall must reach the brake phase (a brake move order)').toBe(true);
    const brakeMove = moves(ctx.sent)[moves(ctx.sent).length - 1]!;
    expect((brakeMove.params as { speed?: number }).speed).toBe(expected.finalApproachMps);
    expect(brakeMove.orderType).toBe('move');
    // ~31 s of ballistic fall for a 4 800 m drop at 100 m/s; a `measuring` hang
    // would never reach the brake move at all.
    expect(fallSeconds).toBeLessThan(expected.fallS * 2);

    // 4. No hang, no rejection: the descent used telemetry the whole way.
    const row = ctx.store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { state: string; reason: string | null };
    expect(row.state).toBe('en_route');
    expect(String(row.reason)).toMatch(/descent brake/);
    expect(audit(ctx.store, 'demo_descent_rejected')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_late_brake')).toHaveLength(0);
    // The probe misses are audited once, and say plainly that nothing waits on them.
    const misses = audit(ctx.store, 'demo_ground_probe_miss');
    expect(misses).toHaveLength(1);
    expect(String((misses[0]!.detail as { note?: string }).note)).toMatch(/terrain height field/i);
  });

  it('(b) with no planet / no usable telemetry it flies the dampened descent and records why', () => {
    const ctx = setupDescent({ planet: null });
    // 3 000 km from every planet centre: the nearest-planet lookup still
    // returns a planet, but the grid is nowhere near it, so there is no AGL.
    const far = { x: 3_000_000, y: 0, z: 0 };
    ctx.store.upsertUnit({
      id: 'grid:r2',
      name: 'SAT-R-0002',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: ctx.clock.now,
      pos: far,
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
    // A 4 km drop toward the planet centre (in the fixture's frame) so the leg
    // genuinely looks like a descent.
    ctx.store.db
      .prepare(`UPDATE demo_drones SET exec_slot_json = ? WHERE mission_id = ?`)
      .run(JSON.stringify({ x: far.x - 4_000, y: far.y, z: far.z }), ctx.mission.id);

    ctx.executor.tick();

    // No controller fall is planned and nothing waits for a measurement.
    expect(orders(ctx.sent).find((m) => actionOf(m) === 'inspect')).toBeUndefined();
    expect(audit(ctx.store, 'demo_descent_measure')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    const rejected = audit(ctx.store, 'demo_descent_rejected');
    expect(rejected).toHaveLength(1);
    const reason = String((rejected[0]!.detail as { reason?: string }).reason);
    expect(reason).toMatch(/altitude AGL cannot be computed/);
    expect(reason).toMatch(/not near this grid|no planet known/);

    // The old dampened move is still flown (the audit row above is the record
    // of why), and the drone never sits in `measuring`.
    expect(moves(ctx.sent)).toHaveLength(1);
    expect(audit(ctx.store, 'demo_leg_profile')).toHaveLength(1);
    const row = ctx.store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { state: string; reason: string | null };
    expect(row.state).toBe('en_route');
    expect(String(row.reason)).toMatch(/move sent/);
    expect(String(row.reason)).not.toMatch(/measuring/);
    // Nothing lingers in `measuring` even after a dozen more ticks.
    for (let i = 0; i < 12; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    const after = ctx.store.db
      .prepare(`SELECT reason FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { reason: string | null };
    expect(String(after.reason)).not.toMatch(/measuring/);
  });

  it('(c) never re-enables dampeners while a controlled fall is running', () => {
    const ctx = setupDescent();
    ctx.executor.tick();
    // Answer the measured-lift inspect so the fall can be planned.
    const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect');
    expect(inspect).toBeTruthy();
    answerInspect(ctx.store, String(inspect!.orderId), satThrusters(), ctx.clock.now);
    ctx.clock.now += 500;
    ctx.executor.tick();
    for (let i = 0; i < 6; i += 1) {
      answerProbesMissed(ctx.store, ctx.sent, ctx.clock.now);
      ctx.clock.now += 500;
      ctx.executor.tick();
    }
    // Regression: the collision-avoidance write used to hard-code
    // DampenersOverride:true in the same tick as "dampeners off", so the ship
    // hovered and the fall phase no-opped forever.
    const dampenerWrites = orders(ctx.sent)
      .filter((m) => actionOf(m) === 'set_block_props')
      .map((m) => (m.params as { props?: Record<string, unknown> })?.props ?? {})
      .filter((props) => 'DampenersOverride' in props);
    for (const props of dampenerWrites) {
      expect(props.DampenersOverride).not.toBe(true);
    }
  });

});
