/**
 * Landing 2026-11-10, in game: what the autopilot cannot do, and what the
 * backend does instead.
 *
 * Measured on SAT-R-0001/SAT-R-0002:
 *
 *   * the SE autopilot will not fly to a waypoint straight below the ship — it
 *     climbs AWAY from it at 1.1-1.2 m/s, and a waypoint straight up crawls
 *     (37.6 m/s peak then decay) while horizontal legs hold 20-99.9 m/s. Every
 *     landing therefore stalled at 26-27 m, wherever the old code sent a move
 *     to the ground point under the hull;
 *   * with the autopilot OFF and dampeners ON an already-descending hull
 *     reproduces a controlled 4.2-4.4 m/s descent to ground contact;
 *   * a brake order was REFUSED by the comms gate (HTTP 409) during a free
 *     fall at 142 m / -47 m/s and the hull was destroyed on the ground.
 *
 * These tests pin the replacements: the final descent is dampeners (no
 * waypoint at all), the waypoint guard is a single function every move goes
 * through, and an order that can only reduce a ship's energy is never refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIMB_MAX_ELEVATION_DEG,
  LANDING_APPROACH_TARGET_AGL_M,
  LANDING_DAMPENED_CONTACT_MPS,
  LANDING_FINAL_DESCENT_AGL_M,
  LANDING_TOUCHDOWN_AGL_M,
  WAYPOINT_MIN_GUARD_M,
  landingDescentCommand,
  waypointAngleVerdict,
  waypointElevationDeg,
} from '../src/demo/flight.js';
import { safetyOrderReason } from '../src/demo/safety-order.js';
import { safetyOrderReason as exportedSafetyOrderReason } from '../src/demo/index.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakePlugin } from './fakePlugin.js';
import { httpRequest, makeClock, makeConfig } from './helpers.js';
import { TRUE_GROUND_M, ackAll, answerInspect, audit, dampenerWrites, moves, orders, setup } from './landing-support.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SAT_LIFT_N = 982_956;
const SHED_MPS2 = 4;
/** The measured dampened descent floor of this hull (2026-11-10), m/s. */
const DAMPENED_SINK_MPS = 4.3;

describe('the waypoint guard (single function, every move)', () => {
  const up = { x: 0, y: 0, z: 1 };
  const from = { x: 0, y: 0, z: 61_000 };

  it('measures elevation from the horizon, signed, and refuses both verticals', () => {
    expect(waypointElevationDeg(from, { x: 0, y: 0, z: 61_100 }, up)).toBeCloseTo(90, 6);
    expect(waypointElevationDeg(from, { x: 1_000, y: 0, z: 61_000 }, up)).toBeCloseTo(0, 6);
    expect(waypointElevationDeg(from, { x: 0, y: 0, z: 60_900 }, up)).toBeCloseTo(-90, 6);
    // A 45 deg leg is fine, a 65 deg climb is not, and the refusal says why.
    expect(waypointAngleVerdict({ from, to: { x: 100, y: 0, z: 61_100 }, up }).ok).toBe(true);
    const steepClimb = waypointAngleVerdict({ from, to: { x: 100, y: 0, z: 61_214 }, up });
    expect(steepClimb.ok).toBe(false);
    expect(steepClimb.elevationDeg).toBeGreaterThan(CLIMB_MAX_ELEVATION_DEG);
    expect(String(steepClimb.reason)).toMatch(/autopilot cannot fly this leg/);
    // ...and the measured killer: a waypoint straight below the ship.
    const below = waypointAngleVerdict({ from, to: { x: 0, y: 0, z: 60_900 }, up });
    expect(below.ok).toBe(false);
    expect(below.elevationDeg).toBeCloseTo(-90, 6);
    expect(String(below.reason)).toMatch(/below the horizon/);
    // Inside the terminal nudge distance the guard does not apply: below 10 m
    // the arrival logic owns the ship, not the autopilot's cruise controller.
    const nudge = waypointAngleVerdict({ from, to: { x: 0.2, y: 0, z: from.z + 1 }, up });
    expect(nudge.distanceM).toBeLessThan(WAYPOINT_MIN_GUARD_M);
    expect(nudge.ok).toBe(true);
  });

  it('no move built anywhere in the executor skips it', () => {
    // Structural test: every `this.send(..., 'move', ...)` in the executor must
    // pass params built by `buildMove`, which is the only place the angle is
    // checked. A new move path that builds its own params fails here.
    const file = fileURLToPath(new URL('../src/demo/executor.ts', import.meta.url));
    const source = readFileSync(file, 'utf8');
    const calls = source.match(/this\.send\([\s\S]*?\n\s*\);/g) ?? [];
    const moveCalls = calls.filter((call) => /\n\s*'move',\n/.test(call));
    expect(moveCalls.length, 'the executor must still send moves').toBeGreaterThan(0);
    for (const call of moveCalls) {
      expect(call, `a move order was built without buildMove():\n${call}`).toContain('buildMove(');
    }
    // The builder itself is where the guard lives.
    expect(source).toContain('waypointAngleVerdict({');
  });

  it('every move actually sent over a climb and a landing is inside the limit', () => {
    // A near-vertical climb (the ladder path) and a full landing, checked on the
    // orders that really went out.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_700,
      startRadiusM: TRUE_GROUND_M + 950,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    ackAll(ctx);
    const sent = moves(ctx.sent).map((m) => m.params as { x: number; y: number; z: number });
    expect(sent.length).toBeGreaterThan(0);
    const up = { x: 0, y: 0, z: 1 };
    let checked = 0;
    for (const point of sent) {
      const verdict = waypointAngleVerdict({ from: { x: 0, y: 0, z: TRUE_GROUND_M + 950 }, to: point, up });
      if (verdict.distanceM < WAYPOINT_MIN_GUARD_M) continue;
      checked += 1;
      expect(Math.abs(verdict.elevationDeg)).toBeLessThanOrEqual(CLIMB_MAX_ELEVATION_DEG + 0.01);
    }
    expect(checked).toBeGreaterThan(0);
    // Any leg the guard had to re-aim is recorded, with its original angle.
    for (const row of audit(ctx.store, 'demo_move_angle_clamped')) {
      const detail = row.detail as { elevationDeg: number; maxElevationDeg: number };
      expect(Math.abs(detail.elevationDeg)).toBeGreaterThan(detail.maxElevationDeg);
      expect(detail.maxElevationDeg).toBe(CLIMB_MAX_ELEVATION_DEG);
    }
  });
});

describe('the final descent control law', () => {
  const base = {
    shedMps2: SHED_MPS2,
    gravityMps2: 9.81,
    periodS: 1,
    dampenersOff: false,
  };

  it('leaves a hull alone while it sinks inside its band', () => {
    const verdict = landingDescentCommand({ ...base, altitudeAglM: 60, sinkMps: 4.5 });
    expect(verdict.bandMps).toBe(5);
    expect(verdict.dampeners).toBeNull();
  });

  it('releases the dampeners when the hull has arrested (the measured 26 m hover)', () => {
    // Measured: three landings settled at 26/27/26 m with v = 0. Never again.
    const verdict = landingDescentCommand({ ...base, altitudeAglM: 26, sinkMps: 0 });
    expect(verdict.dampeners).toBe(false);
    expect(verdict.reason).toMatch(/26 m hover/);
  });

  it('brakes a hull that is sinking faster than its band', () => {
    // Dampeners released (a pulse running) and the sink above the band: the
    // pulse is over, dampeners back on.
    const verdict = landingDescentCommand({ ...base, dampenersOff: true, altitudeAglM: 80, sinkMps: 12 });
    expect(verdict.dampeners).toBe(true);
    expect(verdict.stopHeightM).toBeGreaterThan(0);
    // With the dampeners already on there is nothing stronger to command: the
    // dampened descent is the measured 4.2-4.4 m/s and it is left alone.
    const onAlready = landingDescentCommand({ ...base, altitudeAglM: 80, sinkMps: 12 });
    expect(onAlready.dampeners).toBeNull();
    expect(onAlready.reason).toMatch(/brake is already applied/);
  });

  it('never starts a pulse it cannot arrest above the ground', () => {
    const low = landingDescentCommand({ ...base, altitudeAglM: 4, sinkMps: 0 });
    expect(low.dampeners).toBeNull();
    expect(low.reason).toMatch(/cannot absorb|cannot be arrested|holding the dampeners|remaining/);
    // And below 15 m the band is the final-descent speed.
    const finalBand = landingDescentCommand({ ...base, altitudeAglM: 10, sinkMps: 0 });
    expect(finalBand.bandMps).toBe(0.4);
  });
});

describe('final descent in the executor: dampeners, never a waypoint', () => {
  interface Ctx {
    ctx: ReturnType<typeof setup>;
    plan: { flareAglM: number; brakeStopAglM: number; brakeShedMps2: number; approachMps: number };
    radius: number;
    sink: number;
  }

  /** Start a landing and fly it down to the final descent (dampener model). */
  function toFinalDescent(): Ctx {
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M + 2_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();
    const plan = (audit(ctx.store, 'demo_landing_flare')[0]!.detail as unknown) as Ctx['plan'];
    const state: Ctx = { ctx, plan, radius: TRUE_GROUND_M + 2_000, sink: 0 };
    // Gravity fall until the live brake fires.
    for (let i = 0; i < 400; i += 1) {
      state.ctx.clock.now += 1_000;
      state.sink += 9.81;
      state.radius -= state.sink;
      if (i % 2 === 1) state.ctx.place(state.radius, -state.sink);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_landing_brake').length > 0) break;
    }
    // The dampened brake: shed to the approach speed at the hull's own rate.
    for (let i = 0; i < 8_000; i += 1) {
      const dt = 0.5;
      state.ctx.clock.now += dt * 1_000;
      state.sink = Math.max(state.plan.approachMps, state.sink - state.plan.brakeShedMps2 * dt);
      state.radius -= state.sink * dt;
      state.ctx.place(state.radius, -state.sink);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_landing_approach_start').length > 0) return state;
    }
    throw new Error('the landing never reached its final descent');
  }

  it('turns the autopilot off, flies to contact on dampeners and lands', () => {
    const state = toFinalDescent();
    const start = audit(state.ctx.store, 'demo_landing_approach_start')[0]!.detail as {
      autopilot: string;
      mechanism: string;
      targetAglM: number;
      note: string;
    };
    expect(start.autopilot).toBe('off');
    expect(start.mechanism).toBe('dampener-pulse');
    // The audit's AGL is the HULL BOTTOM's (keel 0 here): the ground point.
    expect(start.targetAglM).toBe(LANDING_APPROACH_TARGET_AGL_M);
    expect(start.note).toMatch(/waypoint below the ship cannot be flown/);
    // The orders that started the phase are the two safety orders.
    expect(orders(state.ctx.sent).filter((m) => m.orderType === 'stop').length).toBeGreaterThan(0);
    expect(dampenerWrites(state.ctx.sent).at(-1)).toBe(true);

    // The measured dampened descent: with the dampeners holding, the hull sinks
    // at ~4.3 m/s and reaches the ground. The test model is the measurement.
    let dampenersOn = true;
    let touchdown = 0;
    for (let i = 0; i < 400; i += 1) {
      const dt = 1;
      const writes = dampenerWrites(state.ctx.sent);
      dampenersOn = writes.length > 0 ? writes.at(-1)! : true;
      // Dampeners ON: the hull holds a ~4.3 m/s descent (measured). OFF:
      // gravity takes over.
      state.sink = dampenersOn
        ? Math.max(DAMPENED_SINK_MPS, state.sink - state.plan.brakeShedMps2 * dt)
        : state.sink + 9.81 * dt;
      state.radius -= state.sink * dt;
      if (state.radius <= TRUE_GROUND_M) {
        state.radius = TRUE_GROUND_M;
        state.sink = Math.min(state.sink, DAMPENED_SINK_MPS);
      }
      state.ctx.clock.now += dt * 1_000;
      state.ctx.place(state.radius, -state.sink);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_touchdown').length > 0) {
        touchdown = i;
        break;
      }
    }
    expect(touchdown, 'the descent must complete at the ground').toBeGreaterThan(0);
    const test = audit(state.ctx.store, 'demo_landing_touchdown_test')[0]!.detail as {
      criterion: string;
      verticalSpeedMps: number;
      hullBottomAglM: number;
    };
    expect(test.hullBottomAglM).toBeLessThanOrEqual(LANDING_TOUCHDOWN_AGL_M);
    expect(Math.abs(test.verticalSpeedMps)).toBeLessThanOrEqual(LANDING_DAMPENED_CONTACT_MPS);
    expect(['bottom-agl+slow', 'bottom-agl+contact', 'bottom-agl+dampened-contact']).toContain(test.criterion);
    expect(state.ctx.droneRow().state).toBe('holding');
    // No waypoint was ever sent below the flare, and none under the ground.
    const downMoves = moves(state.ctx.sent).filter((m) => {
      const z = (m.params as { z?: number }).z;
      return typeof z === 'number' && z < TRUE_GROUND_M + state.plan.flareAglM;
    });
    expect(downMoves).toHaveLength(0);
    // The ship stayed a ship and the mission completed on the next tick.
    state.ctx.executor.tick();
    expect(state.ctx.sent.filter((m) => (m.params as { action?: string }).action === 'convert_to_station')).toHaveLength(0);
  });

  it('breaks the measured 26 m hover with a dampener pulse instead of hovering', () => {
    const state = toFinalDescent();
    // The measured stall: 26 m of hull-bottom AGL, v = 0.00.
    const hoverRadius = TRUE_GROUND_M + 26;
    const before = audit(state.ctx.store, 'demo_landing_pulse').length;
    state.ctx.clock.now += 1_000;
    state.ctx.place(hoverRadius, 0);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    const pulses = audit(state.ctx.store, 'demo_landing_pulse');
    expect(pulses.length, 'the hover must be broken by a pulse').toBeGreaterThan(before);
    const pulse = pulses.at(-1)!.detail as { dampenersOn: boolean; reason: string; bandMps: number };
    expect(pulse.dampenersOn).toBe(false);
    expect(pulse.reason).toMatch(/26 m hover|band edge/);
    expect(dampenerWrites(state.ctx.sent).at(-1)).toBe(false);
  });
});

describe('safety orders are exempt from the comms gate', () => {
  it('classifies only energy-reducing orders as safety orders', () => {
    expect(safetyOrderReason({ orderType: 'stop', params: { action: 'stop' } })).toMatch(/autopilot/);
    expect(safetyOrderReason({ orderType: 'test', params: { action: 'set_dampeners', on: true } })).toMatch(
      /dampeners on/,
    );
    expect(safetyOrderReason({ orderType: 'test', params: { action: 'zero_velocity' } })).toMatch(/velocity/);
    expect(safetyOrderReason({ orderType: 'hold', params: {} })).toMatch(/current position/);
    expect(
      safetyOrderReason({ orderType: 'hold', params: { x: 10, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } }),
    ).toMatch(/safe/i);
    // Everything that can add energy stays gated.
    expect(safetyOrderReason({ orderType: 'test', params: { action: 'set_dampeners', on: false } })).toBeNull();
    expect(safetyOrderReason({ orderType: 'move', params: { x: 0, y: 0, z: 1, speed: 10 } })).toBeNull();
    expect(
      safetyOrderReason({ orderType: 'hold', params: { x: 5_000, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } }),
    ).toBeNull();
    expect(safetyOrderReason({ orderType: 'test', params: { action: 'level_hold', altitudeAglM: 500 } })).toBeNull();
    // The executor and the API share one policy module (re-exported by demo/).
    expect(exportedSafetyOrderReason).toBe(safetyOrderReason);
  });

  describe('over HTTP (the 409 that destroyed the hull)', () => {
    const PORT = 8921;
    const GRID = 'grid:safety-brake-test';
    let runtime: Runtime;
    let plugin: FakePlugin;

    beforeAll(async () => {
      const clock = makeClock();
      runtime = createRuntime({ config: makeConfig({ port: PORT }), clock: clock.now });
      await runtime.listen(PORT);
      plugin = await FakePlugin.connect(PORT);
      plugin.hello();
      await plugin.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
      // A ship mid-fall whose gate status is unknown: telemetry exists but the
      // link state is not up, which is what the gate refuses on.
      runtime.store.upsertUnit({
        id: GRID,
        name: 'SAT-R-FALL',
        specId: null,
        station: null,
        linkStatus: 'unknown',
        lastSeen: clock.now(),
        pos: { x: 0, y: 0, z: 61_158 },
        vel: { x: 0, y: 0, z: -47 },
        meta: { massKg: 37_609 },
      });
    });

    afterAll(async () => {
      await plugin.close();
      await runtime.close();
    });

    it('sends the brake and records why the gate was bypassed', async () => {
      const res = await httpRequest<{ sent: boolean; orderId: string; safetyBypass: { exempt: boolean; reason: string } }>(
        PORT,
        'POST',
        '/api/test/order',
        { orderType: 'stop', entityId: GRID, params: { action: 'stop' } },
      );
      expect(res.status, 'a brake must never be 409 refused').toBe(200);
      expect(res.body.sent).toBe(true);
      expect(res.body.safetyBypass.exempt).toBe(true);
      const received = await plugin.nextMessage((m) => m.type === 'order' && m.orderId === res.body.orderId);
      expect(received.orderType).toBe('stop');

      const rows = runtime.store.listAudit(200).filter((row) => row.action === 'safety_order_bypassed_gate');
      expect(rows).toHaveLength(1);
      const detail = rows[0]!.detail as {
        reason?: string;
        orderType?: string;
        gate?: { allowed?: boolean };
        note?: string;
      };
      expect(detail.orderType).toBe('stop');
      expect(String(detail.reason)).toMatch(/autopilot|energy/i);
      expect(detail.gate?.allowed, 'the gate really would have refused it').toBe(false);
      expect(String(detail.note)).toMatch(/never blocks it/);

      // Dampeners on is the same kind of order.
      const damp = await httpRequest<{ sent: boolean }>(PORT, 'POST', '/api/test/order', {
        orderType: 'test',
        entityId: GRID,
        params: { action: 'set_dampeners', on: true },
      });
      expect(damp.status).toBe(200);
      expect(damp.body.sent).toBe(true);
      expect(runtime.store.listAudit(200).filter((row) => row.action === 'safety_order_bypassed_gate')).toHaveLength(
        2,
      );
    });

    it('still refuses movement from a gate it cannot prove', async () => {
      const res = await httpRequest<{ error: { code: string } }>(PORT, 'POST', '/api/test/order', {
        orderType: 'move',
        entityId: GRID,
        params: { x: 0, y: 0, z: 61_100, speed: 20 },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('comms_rejected');
      // And releasing the brake is not exempt either: it can add energy.
      const off = await httpRequest<{ error: { code: string } }>(PORT, 'POST', '/api/test/order', {
        orderType: 'hold',
        entityId: GRID,
        params: { x: 5_000, y: 0, z: 61_300, speed: 5 },
      });
      expect(off.status).toBe(409);
    });
  });
});
