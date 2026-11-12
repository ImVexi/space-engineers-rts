/**
 * Relaunch to a GROUND origin (verify #4, 2026-11-11).
 *
 * R-0001 came home, refuelled and was approved for relaunch. Its remembered
 * slot was the point it had been resting on, but the executor treated every
 * relaunch slot as an airborne hold: the ground-hold guard measured 1 m of
 * clearance and aborted the flight before it lifted —
 *
 *   "hold at 1809 m AGL is unsafe: the ground at this column is 1808 m above the
 *    catalogue mean radius (61208 m vs 59400 m), leaving 1 m of clearance
 *    (100 m required)"
 *
 * Two defects: a ground point flown as a station, and one sentence reporting an
 * AGL and a clearance measured on two different datums. A relaunch slot on the
 * ground is now a landing (lateral -> settle -> `land_at`); an air slot keeps
 * the hold/station path. The threshold (100 m) is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { GROUND_ORIGIN_AGL_M } from '../src/demo/flight.js';
import { TRUE_GROUND_M, audit, setup } from './landing-support.js';

const GRID = 'grid:land';
const STATION = `survival:relaunch:${GRID}`;

/** The survival mission's `move` step (the builder reads the target off it). */
function mission(slotRadiusM: number, terrainRadiusM: number | null) {
  return setup({
    slotRadiusM,
    startRadiusM: TRUE_GROUND_M + 40,
    terrainRadiusM,
    desired: {},
    station: STATION,
    assignedUnits: [GRID],
    steps: [
      { id: 'move', kind: 'move', params: { gridId: GRID, target: { x: 0, y: 0, z: slotRadiusM } } },
    ],
  });
}

describe('a relaunch whose remembered slot is on the ground lands there', () => {
  it('plans a landing, not a hold, for a slot 1 m above the terrain', () => {
    const ctx = mission(TRUE_GROUND_M + 1, TRUE_GROUND_M);
    const row = ctx.droneRow();
    const landing = row.landing_json ? (JSON.parse(row.landing_json) as { kind?: string }) : null;
    expect(landing?.kind).toBe('land');

    const decision = audit(ctx.store, 'demo_relaunch_ground');
    expect(decision).toHaveLength(1);
    const detail = decision[0]!.detail as { decision: string; targetAglM: number; groundSource: string };
    expect(detail.decision).toBe('land');
    expect(detail.targetAglM).toBeLessThanOrEqual(GROUND_ORIGIN_AGL_M);
    expect(detail.groundSource).toMatch(/^terrain/);

    // The execution slot is the GROUND point (the terrain radius), so the
    // landing sequence owns the last leg instead of the 100 m station rule.
    const slot = JSON.parse(row.exec_slot_json) as { z: number };
    expect(slot.z).toBeCloseTo(TRUE_GROUND_M, 0);

    for (let i = 0; i < 3; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
    expect(ctx.droneRow().state).not.toBe('aborted');
  });

  it('keeps the hold/station path for an air slot 300 m up', () => {
    const ctx = mission(TRUE_GROUND_M + 300, TRUE_GROUND_M);
    expect(ctx.droneRow().landing_json).toBeNull();
    expect(audit(ctx.store, 'demo_relaunch_ground')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
  });

  it('does not guess: with only the catalogue mean there is no ground to land on', () => {
    const ctx = mission(TRUE_GROUND_M + 1, null);
    expect(ctx.droneRow().landing_json).toBeNull();
    expect(audit(ctx.store, 'demo_relaunch_ground')).toHaveLength(0);
  });
});
