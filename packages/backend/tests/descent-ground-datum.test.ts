/**
 * Ground datum fix (2026-11-10 in-game crash).
 *
 * SAT-R-0002 was destroyed because every altitude was measured from the
 * CATALOGUE MEAN radius (59,400 m on EarthLike) instead of the real terrain. At
 * the test column the ground is at 61,016.7 m — 1,616.7 m higher — so every AGL
 * read 1,616.7 m too optimistic, the planned brake point at "1,201 m AGL" was
 * 415 m UNDERGROUND, braking never happened and the ship hit the hill at
 * 104.4 m/s.
 *
 * These tests pin the replacement:
 *
 *   * the ground reference is the terrain height field's radius at the column
 *     (`groundSource: 'terrain'`), the probe hit, or the catalogue mean;
 *   * a descent whose brake point would sit inside the real ground (or inside
 *     the band the terrain could occupy when only the mean is known) is
 *     REFUSED before anything is sent: the ship is held, nothing falls;
 *   * a fall that is already running brakes immediately when the terrain under
 *     it turns out to be higher than the plan assumed;
 *   * a hold waypoint inside the ground is never planned.
 *
 * The fake plugin hub stands in for the game server; the terrain field is
 * injected through the executor's `terrainField` seam so the numbers are exact
 * and do not depend on a running terrain service.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { GROUND_CLEARANCE_M, computeDescentProfile } from '../src/demo/flight.js';
import { unavailableTerrainField, type TerrainField } from '../src/planner/terrainField.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('EarthLike')!;
const SURFACE = Number(PLANET.surfaceRadiusM); // 59 400 m, the catalogue mean
const UNCERTAINTY = Number(PLANET.maxHillRadiusM) - SURFACE; // 7 800 m
/** Measured in game at the failing column (SAT-R-0002). */
const TRUE_GROUND_M = 61_016.7;
const MASS_KG = 37_609;
const LIFT_N = 982_956;
const G = 9.81;

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
 * A terrain field whose ground radius can be changed mid-flight: the fall that
 * starts over one column and crosses a higher ridge is exactly the case that
 * must brake.
 */
function mutableTerrain(radiusM: number | null): { field: TerrainField; state: { radiusM: number | null } } {
  const state = { radiusM };
  const field: TerrainField = {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    get status(): 'available' | 'unavailable' {
      return state.radiusM === null ? 'unavailable' : 'available';
    },
    reason: null,
    tiles: 1,
    radiusAt: () => state.radiusM,
  };
  return { field, state };
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
          {
            id: 'deploy-0',
            kind: 'print',
            params: { prefab: 'Eradicator_mk.1', role: 'relay', position: { x: 0, y: 0, z: SURFACE + 500 } },
            done: false,
          },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' } },
        ],
        notes: '[SIMULATED] ground-datum test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/** One `move` step, ship and slot at absolute radii from the planet centre. */
function setup(opts: {
  slotRadiusM: number;
  startRadiusM: number;
  terrain: TerrainField;
  startSpeedMps?: number;
}) {
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
    terrainField: () => opts.terrain,
  });
  const m = mission(store);
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:r2': 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity, everything it sends is discarded
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:r2', planet = 'EarthLike',
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:r2'
       WHERE mission_id = ?`,
    )
    .run(JSON.stringify({ x: 0, y: 0, z: opts.slotRadiusM }), m.id);

  const place = (radius: number, vertical = 0, now = clock.now) => {
    store.upsertUnit({
      id: 'grid:r2',
      name: 'SAT-R-0002',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: { x: 0, y: 0, z: radius },
      vel: { x: 0, y: 0, z: vertical },
      meta: { massKg: MASS_KG, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
  };
  place(opts.startRadiusM, opts.startSpeedMps ?? 0);
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
function dampenersOff(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => actionOf(m) === 'set_dampeners' && (m.params as { on?: boolean }).on === false);
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

/** Answer the measured-lift inspect and take the one step into fall mode. */
function startFall(ctx: ReturnType<typeof setup>) {
  ctx.executor.tick();
  const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect');
  expect(inspect, 'descent must start with the measured-lift inspect').toBeTruthy();
  answerInspect(ctx.store, String(inspect!.orderId), satThrusters(), ctx.clock.now);
  ctx.executor.tick();
  const fall = audit(ctx.store, 'demo_descent_fall');
  expect(fall, 'measured lift and a long drop must enter fall mode').toHaveLength(1);
  return fall[0]!.detail as Record<string, number | string>;
}

function droneState(store: Store, missionId: string): { state: string; reason: string | null } {
  return store.db.prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`).get(missionId) as {
    state: string;
    reason: string | null;
  };
}

describe('ground datum: AGL measured from the real terrain', () => {
  it('(a) a descent to 1 900 m AGL brakes above the real ground and is audited as terrain', () => {
    const { field } = mutableTerrain(TRUE_GROUND_M);
    const ctx = setup({ slotRadiusM: TRUE_GROUND_M + 1_900, startRadiusM: TRUE_GROUND_M + 6_000, terrain: field });

    // Planning: the measure audit says which ground the AGL came from.
    ctx.executor.tick();
    const measured = audit(ctx.store, 'demo_descent_measure');
    expect(measured).toHaveLength(1);
    const measure = measured[0]!.detail as {
      groundSource?: string;
      groundUncertaintyM?: number;
      groundRadiusM?: number;
      altitudeAglM?: number;
      targetAglM?: number;
      note?: string;
    };
    expect(measure.groundSource).toBe('terrain');
    expect(measure.groundUncertaintyM).toBe(0);
    expect(measure.groundRadiusM).toBe(Math.round(TRUE_GROUND_M));
    expect(measure.altitudeAglM).toBe(6_000);
    expect(measure.targetAglM).toBe(1_900);
    expect(String(measure.note)).toMatch(/terrain height field/);

    // Fall mode, planned against the terrain datum.
    const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect')!;
    answerInspect(ctx.store, String(inspect.orderId), satThrusters(), ctx.clock.now);
    ctx.clock.now += 500;
    ctx.executor.tick();
    const fall = audit(ctx.store, 'demo_descent_fall');
    expect(fall).toHaveLength(1);
    const fallDetail = fall[0]!.detail as {
      groundSource?: string;
      groundUncertaintyM?: number;
      brakeAltAglM?: number;
      vFallMps?: number;
    };
    expect(fallDetail.groundSource).toBe('terrain');
    expect(fallDetail.groundUncertaintyM).toBe(0);
    // The independent model, over the same true AGL numbers.
    const expected = computeDescentProfile({
      massKg: MASS_KG,
      measuredUpThrustN: LIFT_N,
      measuredAtAglM: 6_000,
      altitudeAglM: 6_000,
      targetAglM: 1_900,
      planet: PLANET,
      maxCruiseMps: 100,
    });
    expect(expected.mode).toBe('controlled-fall');
    expect(fallDetail.brakeAltAglM).toBeCloseTo(expected.brakeAltAglM, 0);
    expect(fallDetail.brakeAltAglM as number).toBeGreaterThan(1_900);

    // Ballistic fall to the brake move; every probe is answered with a miss.
    let radius = TRUE_GROUND_M + 6_000;
    let v = 0;
    let brakeAltitude = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.2;
      ctx.clock.now += dt * 1_000;
      v = Math.min(expected.vFallMps, v + G * dt);
      radius -= v * dt;
      ctx.place(radius, -v, ctx.clock.now);
      for (const m of orders(ctx.sent)) {
        if (actionOf(m) !== 'probe_ground') continue;
        if ((m as { __answered?: boolean }).__answered) continue;
        (m as { __answered?: boolean }).__answered = true;
        ctx.store.audit({
          actor: 'plugin',
          action: 'plugin_event',
          subject: 'order_result',
          detail: {
            eventType: 'order_result',
            data: { orderId: String(m.orderId), ok: true, result: { hit: false, isGrid: false } },
          },
          at: ctx.clock.now,
        });
      }
      ctx.executor.tick();
      if (moves(ctx.sent).length > 0) {
        brakeAltitude = radius - TRUE_GROUND_M;
        break;
      }
    }
    expect(brakeAltitude, 'the fall must reach a brake move').toBeGreaterThan(0);
    // The brake point is above the REAL ground, with clearance to spare, not the
    // 415 m underground point that destroyed the ship in game.
    expect(brakeAltitude).toBeGreaterThan(1_900);
    expect(brakeAltitude).toBeGreaterThan(GROUND_CLEARANCE_M);
    expect(Math.abs(brakeAltitude - (fallDetail.brakeAltAglM as number)) / (fallDetail.brakeAltAglM as number)).toBeLessThan(0.1);
    expect(audit(ctx.store, 'demo_descent_ground_unsafe')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_rejected')).toHaveLength(0);
  });

  it('(b) a descent to 200 m AGL the mean radius would allow is refused; nothing falls', () => {
    const { field } = mutableTerrain(TRUE_GROUND_M);
    // 200 m above the CATALOGUE MEAN — 1 416.7 m under the real ground.
    const ctx = setup({ slotRadiusM: SURFACE + 200, startRadiusM: TRUE_GROUND_M + 6_000, terrain: field });

    ctx.executor.tick();

    const rejected = audit(ctx.store, 'demo_descent_rejected');
    expect(rejected).toHaveLength(1);
    const reason = String((rejected[0]!.detail as { reason?: string }).reason);
    expect(reason).toMatch(/^descent to 200 m above the catalogue mean is unsafe/);
    expect(reason).toMatch(/the ground at this column is 1617 m above that mean/);
    expect(reason).toMatch(/61017 m vs 59400 m/);
    // Plain language, one datum per number: the clearance is the real -1 417 m
    // measured from the terrain, and the 200 m is named as a mean-relative
    // altitude (verify #4: the sentence used to print both as "AGL").
    expect(reason).toMatch(/the clearance above the measured ground is -1417 m \(100 m required\)/);

    // Nothing falls and no descent is ever planned.
    expect(audit(ctx.store, 'demo_descent_measure')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    expect(orders(ctx.sent).find((m) => actionOf(m) === 'inspect')).toBeUndefined();
    expect(dampenersOff(ctx.sent)).toHaveLength(0);
    expect(moves(ctx.sent)).toHaveLength(0);
    // The ship is held where it is.
    expect(holds(ctx.sent)).toHaveLength(1);
    expect(droneState(ctx.store, ctx.mission.id).state).toBe('aborted');

    // A dozen more ticks: still no fall, still no move into the hill.
    for (let i = 0; i < 12; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    expect(moves(ctx.sent)).toHaveLength(0);
  });

  it('(c) terrain unavailable and a target inside the uncertain band is refused with the plain reason', () => {
    const ctx = setup({
      slotRadiusM: SURFACE + 1_900,
      startRadiusM: SURFACE + 6_000,
      terrain: unavailableTerrainField(PLANET, 'test: no tiles for this column'),
    });

    ctx.executor.tick();

    const rejected = audit(ctx.store, 'demo_descent_rejected');
    expect(rejected).toHaveLength(1);
    const detail = rejected[0]!.detail as {
      reason?: string;
      groundSource?: string;
      groundUncertaintyM?: number;
      requiredAglM?: number;
    };
    expect(String(detail.reason)).toBe(
      'ground height unknown at this column; a descent to 1900 m could brake inside terrain',
    );
    expect(detail.groundSource).toBe('mean');
    expect(detail.groundUncertaintyM).toBe(UNCERTAINTY);
    expect(detail.requiredAglM).toBe(UNCERTAINTY + GROUND_CLEARANCE_M);

    expect(audit(ctx.store, 'demo_descent_measure')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_fall')).toHaveLength(0);
    expect(dampenersOff(ctx.sent)).toHaveLength(0);
    expect(moves(ctx.sent)).toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(1);
    expect(droneState(ctx.store, ctx.mission.id).state).toBe('aborted');
  });

  it('(d) terrain unavailable and a target above the uncertain band flies, labelled mean', () => {
    const ctx = setup({
      slotRadiusM: SURFACE + 8_500,
      startRadiusM: SURFACE + 10_000,
      terrain: unavailableTerrainField(PLANET, 'test: no tiles for this column'),
    });

    // 8 500 m AGL is above 7 800 m (the hill range) + 100 m, so the mean datum
    // can still vouch for the brake point.
    ctx.executor.tick();
    const measured = audit(ctx.store, 'demo_descent_measure');
    expect(measured).toHaveLength(1);
    const measure = measured[0]!.detail as {
      groundSource?: string;
      groundUncertaintyM?: number;
      groundRadiusM?: number;
      note?: string;
    };
    expect(measure.groundSource).toBe('mean');
    expect(measure.groundUncertaintyM).toBe(UNCERTAINTY);
    expect(measure.groundRadiusM).toBe(Math.round(SURFACE));
    expect(String(measure.note)).toMatch(/could be up to 7800 m higher/);

    const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect')!;
    answerInspect(ctx.store, String(inspect.orderId), satThrusters(), ctx.clock.now);
    ctx.clock.now += 500;
    ctx.executor.tick();
    const fall = audit(ctx.store, 'demo_descent_fall');
    expect(fall).toHaveLength(1);
    expect((fall[0]!.detail as { groundSource?: string }).groundSource).toBe('mean');
    expect(audit(ctx.store, 'demo_descent_rejected')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_descent_ground_unsafe')).toHaveLength(0);
    // The fall is real: the brake point sits at the band's outer edge or above.
    expect((fall[0]!.detail as { brakeAltAglM?: number }).brakeAltAglM as number).toBeGreaterThan(
      UNCERTAINTY + GROUND_CLEARANCE_M,
    );
  });

  it('(e) a running fall whose terrain resolves higher than assumed brakes to full stop', () => {
    const { field, state } = mutableTerrain(TRUE_GROUND_M);
    const ctx = setup({ slotRadiusM: TRUE_GROUND_M + 1_900, startRadiusM: TRUE_GROUND_M + 6_000, terrain: field });
    const plan = startFall(ctx);

    // Fall for a few seconds over the column the plan was made on.
    let radius = TRUE_GROUND_M + 6_000;
    let v = 0;
    for (let i = 0; i < 6; i += 1) {
      const dt = 0.2;
      ctx.clock.now += dt * 1_000;
      v = Math.min(plan.vFallMps as number, v + G * dt);
      radius -= v * dt;
      ctx.place(radius, -v, ctx.clock.now);
      ctx.executor.tick();
    }
    expect(audit(ctx.store, 'demo_descent_ground_unsafe')).toHaveLength(0);

    // The terrain under the fall resolves 2 483.3 m higher than the plan
    // assumed: the planned brake point is now inside the hill.
    state.radiusM = 63_500;
    ctx.clock.now += 1_000;
    radius -= 100;
    ctx.place(radius, -100, ctx.clock.now);
    ctx.executor.tick();

    const unsafe = audit(ctx.store, 'demo_descent_ground_unsafe');
    expect(unsafe, 'the higher terrain must be caught on the next tick').toHaveLength(1);
    const detail = unsafe[0]!.detail as {
      brakeClearanceM?: number;
      groundRadiusM?: number;
      groundSource?: string;
      requiredClearanceM?: number;
      reason?: string;
    };
    expect(detail.groundSource).toBe('terrain');
    expect(detail.groundRadiusM).toBe(63_500);
    expect(detail.requiredClearanceM).toBe(GROUND_CLEARANCE_M);
    expect(detail.brakeClearanceM as number).toBeLessThan(GROUND_CLEARANCE_M);
    expect(String(detail.reason)).toMatch(/brake point is inside terrain/);

    // Full brake: dampeners ON, the late-brake phase, and no move order.
    const dampenersOn = orders(ctx.sent).filter(
      (m) => actionOf(m) === 'set_dampeners' && (m.params as { on?: boolean }).on === true,
    );
    expect(dampenersOn).toHaveLength(1);
    expect(audit(ctx.store, 'demo_descent_late_brake')).toHaveLength(1);
    expect(moves(ctx.sent)).toHaveLength(0);
    expect(droneState(ctx.store, ctx.mission.id).state).toBe('en_route');
    expect(String(droneState(ctx.store, ctx.mission.id).reason)).toMatch(/FULL BRAKE/);
  });

  it('(f) a hold waypoint inside the real ground is never planned', () => {
    const { field } = mutableTerrain(TRUE_GROUND_M);
    // A 250 m drop (below the 300 m controlled-fall minimum), so this is an
    // ordinary leg: the ship is 150 m above the real ground and the waypoint is
    // 100 m inside the hill.
    const ctx = setup({ slotRadiusM: TRUE_GROUND_M - 100, startRadiusM: TRUE_GROUND_M + 150, terrain: field });

    ctx.executor.tick();

    const refused = audit(ctx.store, 'demo_hold_refused');
    expect(refused).toHaveLength(1);
    const reason = String((refused[0]!.detail as { reason?: string }).reason);
    expect(reason).toMatch(/^hold at 1517 m above the catalogue mean is unsafe/);
    expect(reason).toMatch(/1617 m above that mean/);
    expect(reason).toMatch(/the clearance above the measured ground is -100 m \(100 m required\)/);
    expect(moves(ctx.sent)).toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(1);
    expect(droneState(ctx.store, ctx.mission.id).state).toBe('aborted');
  });
});
