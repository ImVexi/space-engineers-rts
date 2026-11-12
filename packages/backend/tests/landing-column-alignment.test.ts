/**
 * Landing 2026-11-11 flight set 5: the wind-up before `land_at`.
 *
 * WHAT WAS MEASURED. Both set-5 landings came to rest within 3 m of the same
 * point, 181-185 m from the `land_at` target. It was not drift during the
 * descent: the ship climbs a <= 60 deg ladder, so at the top of a 745 m climb it
 * sits ~180 m sideways, and nothing ever flew the leg ACROSS to the requested
 * column. The plugin's horizontal hold was handed the handover column — the
 * column the ship was already on — so `hhold` logged `on=true, err=0` every
 * tick while the hull came down 182 m from the request.
 *
 * THE FIX. Before the handover, if the hull's HORIZONTAL distance from the
 * requested column is over `LANDING_LATERAL_ALIGN_M`, the backend flies a
 * lateral leg at altitude (never descending) with the normal guarded move, then
 * hands over; the `land_at` order carries the requested column as
 * `targetPosition`, and the datum is sampled at that column. The plugin uses the
 * target as its hold column only inside its own cap.
 */
import { describe, expect, it } from 'vitest';
import {
  LANDING_LATERAL_ALIGN_M,
  LANDING_LATERAL_ARRIVE_M,
  LANDING_LATERAL_SPEED_MPS,
  LANDING_TARGET_HOLD_MAX_M,
  buildLandAtOrder,
} from '../src/demo/flight.js';
import {
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
/** Ship altitude above the ground at the handover, m (same column as the slot). */
const START_AGL = 300;

type Ctx = ReturnType<typeof setup>;

/** One executor tick, with every order it sent acknowledged (as the hub does). */
function tick(ctx: Ctx): void {
  ctx.executor.tick();
  ackAll(ctx);
}

/**
 * Run a plugin-owned landing from `offsetM` metres to the side of the requested
 * column, through the first landing tick (the handover attempt).
 */
function start(offsetM: number, linkStatus: 'up' | 'down' = 'up'): Ctx {
  const radius = TRUE_GROUND_M + START_AGL;
  const ctx = setup({
    slotRadiusM: radius,
    startRadiusM: radius,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
    capabilities: ['telemetry', 'orders', 'land_controller'],
  });
  ctx.place(radius, 0, ctx.clock.now, offsetM, linkStatus);
  tick(ctx);
  answerInspect(ctx, SAT_LIFT_N);
  ctx.place(radius, 0, ctx.clock.now, offsetM, linkStatus);
  tick(ctx);
  return ctx;
}

const landAtOrders = (ctx: Ctx) => orders(ctx.sent).filter((m) => actionOf(m) === 'land_at');
const lateralRows = (ctx: Ctx) => audit(ctx.store, 'demo_landing_lateral');
const lateralDone = (ctx: Ctx) => audit(ctx.store, 'demo_landing_lateral_done');
const lateralAction = (row: { detail: unknown }) => (row.detail as { action?: string }).action;
const lateralMoves = (ctx: Ctx) => lateralRows(ctx).filter((r) => lateralAction(r) === 'move');

describe('the land_at order carries the requested column', () => {
  it('builds targetPosition only from a finite point, rounded to 0.1 m', () => {
    const withTarget = buildLandAtOrder({
      groundRadiusM: 61_016.7,
      keelDepthM: -8.75,
      targetPosition: { x: 12.34, y: -5.67, z: 61_016.7 },
    });
    expect(withTarget.targetPosition).toEqual({ x: 12.3, y: -5.7, z: 61_016.7 });
    // Absent or unreadable: no target at all (the pre-set-5 order shape).
    expect(buildLandAtOrder({ groundRadiusM: 61_016.7, keelDepthM: -8.75 }).targetPosition).toBeUndefined();
    expect(
      buildLandAtOrder({
        groundRadiusM: 61_016.7,
        keelDepthM: -8.75,
        targetPosition: { x: Number.NaN, y: 0, z: 0 },
      }).targetPosition,
    ).toBeUndefined();
  });

  it('the plugin cap, the arrive radius and the alignment threshold agree', () => {
    // The plugin cap must be > the threshold, and the arrive radius < the
    // threshold, so a handed-over target is always one the hold will fly.
    expect(LANDING_TARGET_HOLD_MAX_M).toBe(30);
    expect(LANDING_LATERAL_ARRIVE_M).toBeLessThan(LANDING_LATERAL_ALIGN_M);
    expect(LANDING_LATERAL_ALIGN_M).toBeLessThan(LANDING_TARGET_HOLD_MAX_M);
  });
});

describe('a landing 180 m off the requested column flies a lateral leg first', () => {
  it('does not hand over, sends a guarded move to above the column, then lands with the target', () => {
    const ctx = start(180);
    // 1. NO land_at yet: the handover waits for the alignment.
    expect(landAtOrders(ctx)).toHaveLength(0);
    const startRow = lateralRows(ctx).find((r) => lateralAction(r) === 'start');
    expect(startRow, 'a lateral leg must be planned').toBeTruthy();
    const detail = startRow!.detail as { offsetM: number; thresholdM: number; targetAglM: number };
    expect(detail.offsetM).toBeCloseTo(180, 0);
    expect(detail.thresholdM).toBe(LANDING_LATERAL_ALIGN_M);
    // The leg flies at altitude, never below the handover height.
    expect(detail.targetAglM).toBeGreaterThanOrEqual(START_AGL - 1);

    // 2. The move that went out is the guarded move to the column.
    const sentMove = moves(ctx.sent).at(-1)!;
    const point = sentMove.params as { x: number; y: number; z: number; speed: number };
    expect(point.x).toBeCloseTo(0, 0);
    expect(point.y).toBeCloseTo(0, 0);
    expect(point.z).toBeCloseTo(TRUE_GROUND_M + START_AGL, 0);
    expect(point.speed).toBeLessThanOrEqual(LANDING_LATERAL_SPEED_MPS);

    // 3. Fly the ship onto the column and tick: the handover happens once.
    ctx.clock.now += 10_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 4);
    tick(ctx);
    expect(lateralDone(ctx), 'the leg must record its arrival').toHaveLength(1);
    const landAt = landAtOrders(ctx);
    expect(landAt, 'one land_at, after the leg').toHaveLength(1);
    const params = landAt[0]!.params as { targetPosition?: { x: number; y: number; z: number }; groundRadiusM: number };
    expect(params.targetPosition).toBeTruthy();
    // The target is the requested column's ground point.
    expect(params.targetPosition!.x).toBeCloseTo(0, 1);
    expect(params.targetPosition!.y).toBeCloseTo(0, 1);
    expect(params.targetPosition!.z).toBeCloseTo(TRUE_GROUND_M, 1);
    // And the datum is the one sampled at THAT column.
    expect(params.groundRadiusM).toBeCloseTo(TRUE_GROUND_M, 0);
    // Exactly one handover row, and it says what happened.
    const handover = audit(ctx.store, 'demo_landing_handover');
    expect(handover).toHaveLength(1);
    const hand = handover[0]!.detail as {
      targetColumnOffsetM: number;
      lateralLeg: { offsetAtStartM: number } | null;
    };
    expect(hand.targetColumnOffsetM).toBeLessThanOrEqual(LANDING_LATERAL_ARRIVE_M + 0.5);
    expect(hand.lateralLeg?.offsetAtStartM).toBeCloseTo(180, 0);
  });

  it('the lateral leg never commands a descent', () => {
    const ctx = start(180);
    // Every point the leg asked for is at or above the hull's own radius: the
    // target keeps the current radius, so the vertical component is never
    // negative.
    const rows = lateralMoves(ctx);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const d = row.detail as { verticalM: number; offsetM: number };
      expect(d.verticalM).toBeGreaterThanOrEqual(-0.05);
      expect(d.offsetM).toBeGreaterThan(LANDING_LATERAL_ALIGN_M);
    }
    const point = moves(ctx.sent).at(-1)!.params as { z: number };
    expect(point.z).toBeGreaterThanOrEqual(TRUE_GROUND_M + START_AGL - 0.5);
  });

  it('re-sends the leg on the resend interval and keeps flying until it arrives', () => {
    const ctx = start(180);
    const before = lateralMoves(ctx).length;
    ctx.clock.now += 5_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 120);
    tick(ctx);
    expect(lateralMoves(ctx).length).toBe(before + 1);
    expect(landAtOrders(ctx), 'still 120 m off: no handover').toHaveLength(0);
  });

  it('abandons the leg after its timeout and hands over anyway (the plugin caps the target)', () => {
    const ctx = start(180);
    ctx.clock.now += 130_000;
    // The ship has not moved at all: the leg made no progress.
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 180);
    tick(ctx);
    const timeout = lateralRows(ctx).find((r) => lateralAction(r) === 'timeout');
    expect(timeout, 'a leg that never closes must be abandoned, not hovered forever').toBeTruthy();
    const landAt = landAtOrders(ctx);
    expect(landAt, 'the handover still happens').toHaveLength(1);
    // The target is still sent; the PLUGIN refuses it for the hold (its cap is
    // 30 m), which is exactly the "target too far for hold" path.
    expect((landAt[0]!.params as { targetPosition?: unknown }).targetPosition).toBeTruthy();
  });
});

describe('a landing already on the requested column skips the leg', () => {
  it('hands over immediately with the target and no lateral audit', () => {
    for (const offsetM of [0, 10, LANDING_LATERAL_ALIGN_M - 0.5]) {
      const ctx = start(offsetM);
      expect(lateralRows(ctx), 'no leg for ' + offsetM + ' m').toHaveLength(0);
      const landAt = landAtOrders(ctx);
      expect(landAt, 'handover for ' + offsetM + ' m').toHaveLength(1);
      const params = landAt[0]!.params as { targetPosition?: { x: number; y: number; z: number } };
      expect(params.targetPosition!.z).toBeCloseTo(TRUE_GROUND_M, 1);
      expect(params.targetPosition!.x).toBeCloseTo(0, 1);
    }
  });
});

describe('the comms gate still applies to the lateral leg', () => {
  it('sends no move while the link is down, then flies the leg once it is back', () => {
    // The landing starts with the link up (a denied MOVE before the landing is
    // a failed mission, which is the ordinary leg rule); the gate is dropped
    // while the lateral leg is mid-flight, i.e. exactly the case that matters.
    const ctx = start(180);
    const before = moves(ctx.sent).length;
    expect(before).toBeGreaterThan(0);
    ctx.clock.now += 5_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 180, 'down');
    tick(ctx);
    expect(moves(ctx.sent).length, 'the leg must not bypass the gate').toBe(before);
    const held = audit(ctx.store, 'demo_landing_lateral_held');
    expect(held, 'the refusal must be audited').toHaveLength(1);
    expect(String((held[0]!.detail as { gate: { reason?: string } }).gate.reason)).toMatch(/link down/);
    const state = ctx.store.db
      .prepare('SELECT state, reason FROM demo_drones WHERE mission_id = ?')
      .get(ctx.mission.id) as { state: string; reason: string | null };
    expect(state.state, 'a gated leg waits, it does not kill the mission').toBe('en_route');
    expect(landAtOrders(ctx), 'no handover while the leg cannot be flown').toHaveLength(0);

    // Link back: the next tick flies the leg.
    ctx.clock.now += 5_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 180, 'up');
    tick(ctx);
    expect(moves(ctx.sent).length).toBe(before + 1);
  });
});
