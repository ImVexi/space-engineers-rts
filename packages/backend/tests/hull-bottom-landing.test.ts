/**
 * Landing on the HULL BOTTOM (measured in game, 2026-11-10).
 *
 * SAT-R-0001 (24 blocks, 37 609 kg) stalled at 26 / 27 / 26 m of POSITION AGL on
 * three landings from 45 m, 1.55 km and 1.88 km, drifting up ~0.7 m/s, and
 * `landing-stalled` aborted every one. Two things were wrong, and both are
 * needed:
 *
 *   1. the grid's reported position is its PIVOT: the plugin now reports
 *      `keelDepthM` = -10.0 for this hull, i.e. the block envelope ends 10 m
 *      ABOVE the pivot, so a touchdown rule phrased on the position's altitude
 *      is 10 m optimistic;
 *   2. the level-0 terrain field is a ~1.5 km bilinear and measured 31 m LOW at
 *      that column (level 5 puts the ship's contact within 0.2 m), so the
 *      "true ground" the brake was sized against was 31 m below the hill.
 *
 * These tests pin the arithmetic and fly the landing with a keel that is not
 * zero, which is the case that used to be untestable.
 */
import { describe, expect, it } from 'vitest';
import {
  GROUND_CLEARANCE_M,
  LANDING_APPROACH_TARGET_AGL_M,
  LANDING_TOUCHDOWN_AGL_M,
  LANDING_TOUCHDOWN_MPS,
  groundSafetyVerdict,
  hullBottomAglM,
  pivotRadiusForHullBottomAgl,
} from '../src/demo/flight.js';
import {
  PLANET,
  TRUE_GROUND_M,
  ackAll,
  actionOf,
  answerInspect,
  audit,
  moves,
  orders,
  setup,
} from './landing-support.js';

const SAT_LIFT_N = 982_956;

interface Ctx {
  ctx: ReturnType<typeof setup>;
  plan: { flareAglM: number; brakeStopAglM: number; brakeShedMps2: number; approachMps: number };
  radius: number;
  vDown: number;
}

/** Fly the flare + brake, then leave the landing in its approach phase. */
function toApproach(keelDepthM: number): Ctx {
  const ctx = setup({
    slotRadiusM: TRUE_GROUND_M + 2_000,
    startRadiusM: TRUE_GROUND_M + 2_000,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
    keelDepthM,
  });
  ctx.executor.tick();
  answerInspect(ctx, SAT_LIFT_N);
  ctx.executor.tick();
  const flare = audit(ctx.store, 'demo_landing_flare');
  expect(flare, 'the landing must plan a flare').toHaveLength(1);
  const plan = flare[0]!.detail as Ctx['plan'];
  const state: Ctx = { ctx, plan, radius: TRUE_GROUND_M + 2_000, vDown: 0 };
  // Fall, then brake, exactly as the phases expect.
  for (let i = 0; i < 400; i += 1) {
    state.ctx.clock.now += 1_000;
    state.vDown += 9.81;
    state.radius -= state.vDown;
    if (i % 2 === 1) state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    if (audit(state.ctx.store, 'demo_landing_brake').length > 0) break;
  }
  for (let i = 0; i < 8_000; i += 1) {
    const dt = 0.5;
    state.ctx.clock.now += dt * 1_000;
    state.vDown = Math.max(state.plan.approachMps, state.vDown - state.plan.brakeShedMps2 * dt);
    state.radius -= state.vDown * dt;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    if (audit(state.ctx.store, 'demo_landing_brake_done').length > 0) break;
  }
  expect(audit(ctx.store, 'demo_landing_approach_start'), 'the approach must start').toHaveLength(1);
  return state;
}

describe('hull bottom vs the grid pivot', () => {
  it('converts position altitude to hull-bottom altitude with the signed keel', () => {
    // SAT-R-0001: the hull ends 10 m above the pivot, so the belly is HIGHER
    // than the reported position.
    expect(hullBottomAglM(21.4, -10)).toBeCloseTo(31.4, 6);
    // A normal hull whose belly hangs below the pivot is the other way round.
    expect(hullBottomAglM(21.4, 10)).toBeCloseTo(11.4, 6);
    expect(hullBottomAglM(21.4, 0)).toBeCloseTo(21.4, 6);
    // Unreadable telemetry is zero, never NaN (a NaN AGL would poison a guard).
    expect(hullBottomAglM(21.4, Number.NaN)).toBeCloseTo(21.4, 6);
    expect(hullBottomAglM(Number.NaN, -10)).toBeCloseTo(10, 6);
  });

  it('aims the hold radius at the HULL BOTTOM, not the position', () => {
    // The position that puts the belly 1 m above the ground for SAT-R-0001 is
    // 9 m BELOW the terrain — unreachable, which is the point: the hull touches
    // first and the touchdown rule finishes the landing.
    expect(pivotRadiusForHullBottomAgl(TRUE_GROUND_M, -10, LANDING_APPROACH_TARGET_AGL_M)).toBeCloseTo(
      TRUE_GROUND_M - 9,
      6,
    );
    expect(pivotRadiusForHullBottomAgl(TRUE_GROUND_M, 10, 1)).toBeCloseTo(TRUE_GROUND_M + 11, 6);
    expect(pivotRadiusForHullBottomAgl(TRUE_GROUND_M, 0, 0)).toBeCloseTo(TRUE_GROUND_M, 6);
    // A negative "above ground" is never a reason to aim underground further.
    expect(pivotRadiusForHullBottomAgl(TRUE_GROUND_M, -10, -5)).toBeCloseTo(TRUE_GROUND_M - 10, 6);
  });

  it('keeps the 100 m clearance rule on the hull bottom, with the keel sign respected', () => {
    const hullBelow = (targetPositionAgl: number, keel: number) =>
      groundSafetyVerdict({
        targetAglM: hullBottomAglM(targetPositionAgl, keel),
        source: 'terrain',
        groundUncertaintyM: 0,
        intent: 'hold',
      });
    // The rule is phrased on the BELLY, and `keelDepthM` is signed: positive
    // means the hull extends BELOW the pivot (the belly is lower than the
    // position), negative means the pivot sits below the hull (SAT-R-0001's
    // belly is 10 m HIGHER than the position it reports).
    //
    // 105 m of position AGL with a 5 m belly below the pivot: 100 m of
    // clearance, exactly the rule — allowed.
    expect(hullBelow(105, 5).ok).toBe(true);
    // 10 m below the pivot: the belly is at 95 m and the hold is refused. This
    // is the direction the rule exists for.
    expect(hullBelow(105, 10).ok).toBe(false);
    expect(hullBelow(105, 10).requiredAglM).toBe(GROUND_CLEARANCE_M);
    expect(hullBelow(110, 10).ok).toBe(true);
    // A negative keel makes the same position SAFER, never less safe: the hull
    // ends 10 m above the pivot, so the belly has 115 m of clearance. Refusing
    // it would be refusing a hold that is 15 m *higher* than the rule requires,
    // and the arithmetic is already expressed on the belly (see the
    // conversion test above), so the rule needs no special case for it.
    expect(hullBottomAglM(105, -10)).toBe(115);
    expect(hullBelow(105, -10).ok).toBe(true);
    // The refusal is decided on the belly, not the pivot.
    expect(hullBelow(100, 0).ok).toBe(true);
    expect(hullBelow(99.9, 0).ok).toBe(false);
  });
});

describe('landing with a real keel depth', () => {
  it('targets the ground point that puts SAT-R-0001\'s belly 1 m up, and touches down on the belly', () => {
    const keel = -10;
    const state = toApproach(keel);
    const start = audit(state.ctx.store, 'demo_landing_approach_start')[0]!.detail as {
      target: { z: number };
      targetAglM: number;
      positionTargetAglM: number;
      keelM: number;
      keelSource: string;
      mechanism: string;
      autopilot: string;
      note: string;
    };
    // AGL in the audit is the BELLY's; the waypoint z is the POSITION, which has
    // to sit the keel depth lower.
    expect(start.targetAglM).toBe(LANDING_APPROACH_TARGET_AGL_M);
    expect(start.target.z).toBeCloseTo(TRUE_GROUND_M + keel + LANDING_APPROACH_TARGET_AGL_M, 3);

    // Fly down to the height the hull actually comes to rest at: the belly on
    // the ground means the position is 10 m BELOW the terrain radius.
    const restRadius = TRUE_GROUND_M + keel;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.5;
      state.ctx.clock.now += dt * 1_000;
      state.vDown = 0.3;
      state.radius = Math.max(restRadius, state.radius - state.vDown * dt);
      state.ctx.place(state.radius, state.radius <= restRadius ? 0 : -state.vDown);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_touchdown').length > 0) break;
    }
    const touchdown = audit(state.ctx.store, 'demo_touchdown');
    expect(touchdown, 'the landing must complete on the belly, not on the pivot').toHaveLength(1);
    const detail = touchdown[0]!.detail as { hullBottomAglM: number; keelM: number; keelSource: string };
    expect(detail.hullBottomAglM).toBeLessThanOrEqual(LANDING_TOUCHDOWN_AGL_M + 0.5);
    expect(detail.keelM).toBe(keel);
    expect(detail.keelSource).toBe('telemetry');
    // A touchdown test row records which criterion fired.
    const test = audit(state.ctx.store, 'demo_landing_touchdown_test')[0]!.detail as {
      criterion: string;
      verticalSpeedMps: number;
    };
    expect(Math.abs(test.verticalSpeedMps)).toBeLessThanOrEqual(LANDING_TOUCHDOWN_MPS + 0.1);
    expect(audit(state.ctx.store, 'demo_touchdown')).toHaveLength(1);
    expect(state.ctx.droneRow().state).toBe('holding');
    // The descent never asks the autopilot for a waypoint under the ship: the
    // last phase is autopilot-off + dampeners (measured 2026-11-10, a waypoint
    // below the ship makes it climb AWAY at 1.1-1.2 m/s).
    expect(start.autopilot).toBe('off');
    expect(start.mechanism).toBe('dampener-pulse');
    expect(start.keelM).toBe(keel);
    expect(start.keelSource).toBe('telemetry');
    // The audit's AGL is the BELLY's; the pivot figure is the diagnostic one.
    expect(start.positionTargetAglM).toBe(keel + LANDING_APPROACH_TARGET_AGL_M);
    const sentAfterFlare = state.ctx.sent.filter((m) => {
      const z = (m.params as { z?: number }).z;
      return m.type === 'order' && m.orderType === 'move' && typeof z === 'number' && z < TRUE_GROUND_M;
    });
    expect(sentAfterFlare, 'no move may be sent to a point under the ground').toHaveLength(0);
    const stops = orders(state.ctx.sent).filter((m) => m.orderType === 'stop');
    expect(stops.length, 'the final descent turns the autopilot off').toBeGreaterThan(0);
  });

  it('a hull whose belly hangs below the pivot aims its hold above the ground and still lands', () => {
    const keel = 6;
    const state = toApproach(keel);
    const start = audit(state.ctx.store, 'demo_landing_approach_start')[0]!.detail as { target: { z: number } };
    expect(start.target.z).toBeCloseTo(TRUE_GROUND_M + keel + LANDING_APPROACH_TARGET_AGL_M, 3);
    // The belly is already 6 m lower than the position, so the position comes
    // to rest 6 m ABOVE the ground.
    const restRadius = TRUE_GROUND_M + keel;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.5;
      state.ctx.clock.now += dt * 1_000;
      state.vDown = 0.3;
      state.radius = Math.max(restRadius, state.radius - state.vDown * dt);
      state.ctx.place(state.radius, state.radius <= restRadius ? 0 : -state.vDown);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_touchdown').length > 0) break;
    }
    expect(audit(state.ctx.store, 'demo_touchdown')).toHaveLength(1);
    expect(PLANET.name).toBe('EarthLike');
  });

  it('records the keel source so a hull with no geometry reading is labelled', () => {
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
    const measure = audit(ctx.store, 'demo_descent_measure')[0]!.detail as {
      groundSource: string;
      altitudeAglM: number;
    };
    // No keel in telemetry and none in the inspect reply: 0, i.e. the old
    // position-based altitude, and the touchdown test says so.
    expect(measure.groundSource).toBe('terrain');
    expect(measure.altitudeAglM).toBeCloseTo(2_000, 0);
  });
});
