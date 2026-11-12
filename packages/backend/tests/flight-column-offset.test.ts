/**
 * ~600 m column offset from a re-aimed near-vertical leg (2026-11-11).
 *
 * `buildMove` never asks the autopilot for a leg steeper than 60 deg, so a
 * near-vertical DESCENT (the climb ladder only builds climbs) is re-aimed to a
 * point `|vertical| / tan(60)` metres away — 553 m in the measured case. The
 * executor then flew that point as if it were the destination: the arrival test
 * still measured against the real slot, the guard re-issued, and each cycle
 * added another tangential offset. The ship ended up descending over a column
 * ~600 m from the one it was ordered to.
 *
 * The rule these tests pin: a clamped waypoint is an INTERMEDIATE step; once the
 * hull is on it the leg to the REQUESTED column is sent, so the final target is
 * the requested column within a few metres.
 */
import { describe, expect, it } from 'vitest';
import { TRUE_GROUND_M, ackAll, audit, moves, setup } from './landing-support.js';

const COLUMN_X = 0;
const COLUMN_Y = 0;

const horizontalTo = (point: { x: number; y: number }, target: { x: number; y: number }): number =>
  Math.hypot(point.x - target.x, point.y - target.y);

describe('a near-vertical leg is flown to the requested column, not the cone point', () => {
  it('re-aims the descent, then sends the leg to the real slot column (within a few metres)', () => {
    // Slot 1 100 m BELOW the ship, on the same column: the leg is straight down.
    const slotRadiusM = TRUE_GROUND_M + 1_500;
    const startRadiusM = slotRadiusM + 1_100;
    const ctx = setup({
      slotRadiusM,
      startRadiusM,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });

    // The first flight leg is the descent; drive the preflight until it goes out.
    for (let i = 0; i < 15 && moves(ctx.sent).length === 0; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx);
    }
    expect(moves(ctx.sent).length).toBeGreaterThan(0);
    ctx.executor.tick();
    ackAll(ctx);
    const clamped = audit(ctx.store, 'demo_move_angle_clamped');
    expect(clamped.length, 'a straight-down leg must hit the waypoint guard').toBeGreaterThan(0);
    const firstClamp = clamped[0]!.detail as { elevationDeg: number; addedHorizontalM: number };
    expect(firstClamp.elevationDeg).toBeLessThan(-60);
    expect(firstClamp.addedHorizontalM, 'the tangential offset that caused the ~600 m drift').toBeGreaterThan(500);

    // The hull is on the clamped intermediate waypoint, at rest, 1 100 m above
    // the slot's altitude -> the guard re-issues the near-vertical leg.
    const step = audit(ctx.store, 'demo_leg_cone_step').at(-1)?.detail as { conePoint: { x: number; y: number; z: number } } | undefined;
    if (!step) throw new Error('the clamped leg was not tracked as an intermediate cone step');
    // Put the hull ON the cone point: that is the horizontal offset the bug flew,
    // at the slot's own altitude.
    ctx.store.upsertUnit({
      id: 'grid:land',
      name: 'LAND-01',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: ctx.clock.now,
      pos: { ...step.conePoint },
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
    ctx.clock.now += 5_000;
    ctx.executor.tick();

    // The next move is the leg to the REQUESTED column, not another cone point.
    const done = audit(ctx.store, 'demo_leg_cone_step_done');
    expect(done, 'reaching the cone point must send the column leg').toHaveLength(1);
    const finalMove = moves(ctx.sent).at(-1)!.params as { x: number; y: number; z: number };
    expect(horizontalTo(finalMove, { x: COLUMN_X, y: COLUMN_Y })).toBeLessThan(5);
    // ...and it really left the off-column point behind.
    expect(horizontalTo(step.conePoint, { x: COLUMN_X, y: COLUMN_Y })).toBeGreaterThan(500);
    // The final target is the slot itself (its altitude), so the descent that
    // follows happens over the right column.
    expect(finalMove.z).toBeCloseTo(slotRadiusM, 0);
  });

  it('a leg that is already inside the cone is not given an intermediate step', () => {
    // A shallow descent (200 m down over 2 km across) is flyable as it is.
    const slotRadiusM = TRUE_GROUND_M + 1_500;
    const ctx = setup({
      slotRadiusM,
      startRadiusM: slotRadiusM + 200,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.store.upsertUnit({
      id: 'grid:land',
      name: 'LAND-01',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: ctx.clock.now,
      pos: { x: 2_000, y: 0, z: slotRadiusM + 200 },
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_leg_cone_step')).toHaveLength(0);
    const move = moves(ctx.sent).at(-1)!.params as { x: number; y: number; z: number };
    expect(move.x).toBeCloseTo(COLUMN_X, 0);
  });
});
