import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { dot, normalize, sub, type V3 } from '../src/planner/geometry.js';
import { taggedHull, type DesignerHull } from '../src/demo/designer/hulls.js';
import { HARD_MIN_SPACING_M, solveCoverGoal, type CoverGoalPlan } from '../src/demo/designer/coverGoal.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;

/** A 50 km hydrogen relay — the same model the altitude suite uses. */
function hydrogenRelay(h2Litres = 400_000): DesignerHull {
  return taggedHull({
    gridId: 'grid:h2-relay',
    name: 'H2 relay',
    radioRangeM: 50_000,
    thrust: { atmo: 0, ion: 0, h2: 12_000_000 },
    massKg: 260_000,
    canGroundLaunch: true,
    power: { reactorMW: 0, batteryMWh: 3, solarPeakMW: 1.2 },
    fuel: { h2Litres, h2FillPct: 100, batteryFillPct: 100 },
  });
}

/** Ground (surface-arc) distance between two slots, from their positions. */
function groundGapM(a: V3, b: V3): number {
  const dirA = normalize(sub(a, earth.center));
  const dirB = normalize(sub(b, earth.center));
  return Math.acos(Math.max(-1, Math.min(1, dot(dirA, dirB)))) * earth.surfaceRadiusM;
}

/** Smallest ground distance over every slot pair — independent of the solver. */
function minPairGroundM(plan: CoverGoalPlan): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < plan.slots.length; i += 1) {
    for (let j = i + 1; j < plan.slots.length; j += 1) {
      min = Math.min(min, groundGapM(plan.slots[i]!.position, plan.slots[j]!.position));
    }
  }
  return min;
}

const base = {
  planet: earth,
  k: 1 as const,
  cellDeg: 10,
  rangeMargin: 0.9,
  hull: hydrogenRelay(),
  target: { kind: 'whole' as const },
};

describe('T53 spacing enforcement in the coverage solver', () => {
  it('a whole-planet max-reach plan keeps every pair past 0.5 x radio', () => {
    const plan = solveCoverGoal({ ...base, altitudeMode: 'max-reach' });
    // Rule: 0.5 x 50 km radio, on the ground.
    expect(plan.spacingRuleM).toBe(25_000);
    expect(plan.bunching).toBe(false);
    expect(plan.spacingRelaxed).toBe(false);
    expect(plan.spacingRelaxedReason).toBeNull();
    expect(plan.minSpacingM).toBeGreaterThanOrEqual(25_000);
    // The chord metric `spacingReport` publishes clears it too, so bunching
    // cannot reappear downstream through the older reporting path.
    expect(plan.minChordSpacingM).toBeGreaterThanOrEqual(25_000);
    // Independent re-measurement from the reported positions.
    expect(minPairGroundM(plan)).toBeCloseTo(plan.minSpacingM, 0);
    // 27 was the pre-spacing count on this grid; enforcing spacing must not
    // more than roughly double it.
    expect(plan.countUsed).toBeGreaterThan(15);
    expect(plan.countUsed).toBeLessThanOrEqual(35);
    expect(plan.coveragePct).toBeGreaterThanOrEqual(95);
  });

  it('a geometry that cannot honour the rule relaxes it, says so, and never breaks the 8 km floor', () => {
    // 3 km is horizon-limited (a ~19 km footprint), so full coverage needs
    // centres closer together than 25 km: the rule has to bend somewhere.
    const plan = solveCoverGoal({ ...base, altitudeMode: 'manual', manualAltitudeM: 3_000 });
    expect(plan.spacingRelaxed).toBe(true);
    expect(plan.bunching).toBe(true);
    expect(plan.spacingRelaxedReason).toMatch(/spacing rule relaxed/);
    expect(plan.spacingRelaxedReason).toMatch(/0\.5 x 50 km radio/);
    expect(plan.spacingRelaxedReason).toMatch(/8 km same-altitude floor held/);
    // Hard floor: 8 km, checked on every pair independently.
    expect(plan.minSpacingM).toBeGreaterThanOrEqual(HARD_MIN_SPACING_M);
    expect(minPairGroundM(plan)).toBeGreaterThanOrEqual(HARD_MIN_SPACING_M);
    // Closing the rule gap is done by ADDING relays, not by dropping coverage.
    expect(plan.coveragePct).toBeGreaterThanOrEqual(95);
    expect(plan.countUsed).toBeGreaterThan(27);
  });

  it('enforcing spacing lowers the overlap metric on the bunched fixture', () => {
    // Same solver, spacing effectively off (the 8 km floor is the real limit).
    const loose = solveCoverGoal({ ...base, altitudeMode: 'max-reach', minSpacingM: 1_000 });
    const strict = solveCoverGoal({ ...base, altitudeMode: 'max-reach' });
    expect(loose.spacingRuleM).toBe(HARD_MIN_SPACING_M);
    expect(loose.minSpacingM).toBeLessThan(strict.minSpacingM);
    expect(strict.minSpacingM).toBeGreaterThanOrEqual(25_000);
    // Fewer relays hear each cell past k, so the constellation is less cluttered.
    expect(strict.overlapMetric.sum).toBeLessThan(loose.overlapMetric.sum);
    expect(strict.overlapMetric.mean).toBeLessThan(loose.overlapMetric.mean);
    // ... and overlap is accounted honestly: recount from the reported cells.
    const recounted = strict.cells.reduce((sum, cell) => sum + Math.max(0, cell.coveredBy - strict.k), 0);
    expect(recounted).toBe(strict.overlapMetric.sum);
    expect(strict.overlapMetric.maxPerCell).toBeGreaterThan(0);
    expect(loose.coveragePct).toBeGreaterThanOrEqual(95);
    expect(strict.coveragePct).toBeGreaterThanOrEqual(95);
  });

  it('the spacing rule is an input option and is reported back', () => {
    const plan = solveCoverGoal({ ...base, altitudeMode: 'max-reach', minSpacingM: 30_000 });
    expect(plan.spacingRuleM).toBe(30_000);
    // Either it held, or it bent for coverage and said so — never silently.
    expect(plan.minSpacingM >= 30_000 || plan.spacingRelaxed).toBe(true);
    expect(plan.minSpacingM).toBeGreaterThanOrEqual(HARD_MIN_SPACING_M);
    expect(plan.coveragePct).toBeGreaterThanOrEqual(95);
  });

  it('k=2 still delivers two relays per cell with spacing in play', () => {
    const plan = solveCoverGoal({ ...base, k: 2, altitudeMode: 'cheapest' });
    expect(plan.achievedK).toBe(2);
    expect(plan.relaysWithoutSecondPath).toEqual([]);
    expect(plan.counts.coveredK2).toBe(plan.totalCells);
    expect(plan.coveragePct).toBeGreaterThanOrEqual(95);
    expect(plan.minSpacingM).toBeGreaterThanOrEqual(HARD_MIN_SPACING_M);
    expect(minPairGroundM(plan)).toBeGreaterThanOrEqual(HARD_MIN_SPACING_M);
  });
});
