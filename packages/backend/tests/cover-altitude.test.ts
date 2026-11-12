// These fixtures document the LEGACY radio=range+los behaviour (still reachable via
// the flag) because that is the only mode where terrain shapes radio coverage.
// The measured rule is radio = range-only (see docs/reality-check.md): under it a
// ridge changes nothing for radio, which is asserted in terrain-coverage.test.ts.
process.env.RTS_RADIO_LOS = '1';

import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { v3 } from '../src/planner/geometry.js';
import { coverageCellsFor } from '../src/planner/planetCoverage.js';
import { terrainFieldFromRadiusFn } from '../src/planner/terrainField.js';
import { taggedHull, type DesignerHull } from '../src/demo/designer/hulls.js';
import {
  DEFAULT_COST_WEIGHTS,
  analyticPeakAltitudeM,
  bestFlatAltitudeM,
  chooseSlotAltitude,
  groundFootprintRadiusM,
} from '../src/demo/designer/altitude.js';
import { nodeDisjointPathCount, solveCoverGoal } from '../src/demo/designer/coverGoal.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;

/**
 * A modelled hydrogen relay: 50 km radio, H2 thrust and real tanks, so the
 * cost model has climb fuel to weigh (the prefab radio hull is ion/reactor).
 */
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

function ridgeField(reliefM: number, lonFrom: number, lonTo: number) {
  return terrainFieldFromRadiusFn(earth, (dir) => {
    const lonDeg = (Math.atan2(dir.z, dir.x) * 180) / Math.PI;
    const latDeg = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;
    const onRidge = lonDeg > lonFrom && lonDeg < lonTo && Math.abs(latDeg) < 12;
    return onRidge ? earth.surfaceRadiusM + reliefM : earth.surfaceRadiusM;
  });
}

describe('T52 altitude modes', () => {
  it('max-reach lands within 1 km of the analytic footprint peak on flat terrain', () => {
    const analytic = analyticPeakAltitudeM(earth, 50_000);
    // sqrt(surface^2 + range^2) - surface: EarthLike/50 km -> 18.24 km.
    expect(analytic).toBeGreaterThan(18_000);
    expect(analytic).toBeLessThan(18_500);
    const searched = bestFlatAltitudeM(earth, 50_000);
    expect(Math.abs(searched - analytic)).toBeLessThan(1_000);
    // The quoted footprint at 18.5 km is ~41.6 km of ground (11.7 % of the planet).
    const footprint = groundFootprintRadiusM(earth, 18_500, 50_000);
    expect(footprint).toBeGreaterThan(41_000);
    expect(footprint).toBeLessThan(42_000);
    // Whole-planet MAX REACH pins every slot at that peak.
    const plan = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'max-reach',
      hull: hydrogenRelay(),
      target: { kind: 'whole' },
    });
    for (const slot of plan.slots) {
      expect(Math.abs(slot.altitudeM - analytic)).toBeLessThan(1_000);
    }
  });

  it('a ridge raises a slot above the same slot on open ground', () => {
    const hull = hydrogenRelay();
    // Cells west of a ridge; the slot sits east of it, so every low slant path
    // has to cross the ridge.
    const cells = coverageCellsFor(earth, 5).filter(
      (cell) => cell.lonDeg > -25 && cell.lonDeg < -8 && Math.abs(cell.latDeg) < 6,
    );
    const dir = v3(1, 0, 0); // lat 0, lon 0
    const flat = chooseSlotAltitude({
      planet: earth,
      dir,
      rangeM: 50_000,
      mode: 'max-reach',
      cells,
      terrain: null,
      hull,
      costWeights: DEFAULT_COST_WEIGHTS,
    });
    const ridged = chooseSlotAltitude({
      planet: earth,
      dir,
      rangeM: 50_000,
      mode: 'max-reach',
      cells,
      terrain: ridgeField(5_000, -6, -2),
      hull,
      costWeights: DEFAULT_COST_WEIGHTS,
    });
    expect(ridged.raisedByTerrain).toBe(true);
    expect(ridged.altitudeM).toBeGreaterThan(flat.altitudeM);
    // Plain words name the ridge and the height it forced.
    expect(ridged.reason).toMatch(/ridge/i);
    expect(ridged.reason).toMatch(/raised to/i);
  });

  it('CHEAPEST yields a mixed layout including atmospheric-tier slots', () => {
    const plan = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull: hydrogenRelay(),
      target: { kind: 'whole' },
    });
    expect(plan.coveragePct).toBeGreaterThanOrEqual(95);
    const low = plan.slots.filter((slot) => slot.altitudeM <= 10_000);
    expect(low.length).toBeGreaterThan(0);
    for (const slot of plan.slots) {
      expect(slot.altitudeM).toBeGreaterThanOrEqual(100);
      expect(slot.altitudeReason.length).toBeGreaterThan(10);
      // Tuned radius is never below a link the slot carries.
      expect(slot.radioRadiusM).toBeGreaterThan(0);
      expect(slot.radioRadiusM).toBeLessThanOrEqual(50_000);
      expect(slot.antennaMW).toBeGreaterThan(0);
    }
    // Mixed: not every slot sits at the same height.
    expect(new Set(plan.slots.map((slot) => slot.altitudeM)).size).toBeGreaterThan(1);
  });

  it('CHEAPEST buys lower relays than MAX REACH, and both still cover the goal', () => {
    const hull = hydrogenRelay(4_000_000);
    const base = {
      planet: earth,
      k: 1 as const,
      cellDeg: 10,
      rangeMargin: 0.9,
      hull,
      target: { kind: 'whole' as const },
    };
    const cheapest = solveCoverGoal({ ...base, altitudeMode: 'cheapest' as const });
    const maxReach = solveCoverGoal({ ...base, altitudeMode: 'max-reach' as const });
    const mean = (plan: typeof cheapest): number =>
      plan.slots.reduce((sum, slot) => sum + slot.altitudeM, 0) / Math.max(1, plan.slots.length);
    // The trade this mode exists for: lower, cheaper relays instead of the
    // fewest possible high ones.
    expect(mean(cheapest)).toBeLessThan(mean(maxReach));
    expect(cheapest.coveragePct).toBeGreaterThanOrEqual(95);
    expect(maxReach.coveragePct).toBeGreaterThanOrEqual(95);
  });
});

describe('T53 coverage-first constellation', () => {
  it('k=2 gives every cell two relays and every relay two node-disjoint base paths', () => {
    const plan = solveCoverGoal({
      planet: earth,
      k: 2,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull: hydrogenRelay(),
      target: { kind: 'whole' },
    });
    expect(plan.achievedK).toBe(2);
    expect(plan.relaysWithoutSecondPath).toEqual([]);
    for (const cell of plan.cells) {
      expect(cell.coveredBy).toBeGreaterThanOrEqual(2);
    }
    expect(plan.counts.coveredK2).toBe(plan.totalCells);
    // Independent check on the hop graph the plan reports.
    for (const slot of plan.slots) {
      const adjacency = new Map<string, Set<string>>([['base', new Set<string>()]]);
      for (const other of plan.slots) adjacency.set(other.id, new Set<string>());
      const nodes = [{ id: 'base', position: basePosition() }, ...plan.slots.map((slot2) => ({ id: slot2.id, position: slot2.position }))];
      const hop = 50_000 * 0.9;
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
          if (distance <= hop + 0.5) {
            adjacency.get(a.id)!.add(b.id);
            adjacency.get(b.id)!.add(a.id);
          }
        }
      }
      expect(nodeDisjointPathCount(adjacency, slot.id, 'base')).toBeGreaterThanOrEqual(2);
    }
    // k=2 needs strictly more ships than the k=1 goal.
    const single = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull: hydrogenRelay(),
      target: { kind: 'whole' },
    });
    expect(plan.countUsed).toBeGreaterThan(single.countUsed);
  });

  it('auto count reports what the goal needs and lists surplus above it', () => {
    const hull = hydrogenRelay();
    const auto = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull,
      target: { kind: 'whole' },
    });
    expect(auto.requestedCount).toBeNull();
    expect(auto.countUsed).toBe(auto.countNeeded);
    const generous = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull,
      target: { kind: 'whole' },
      count: auto.countNeeded + 3,
    });
    expect(generous.countUsed).toBe(auto.countNeeded);
    expect(generous.surplus).toHaveLength(3);
    expect(generous.uncoveredPct).toBe(0);
  });

  it('a fixed count below the need maximises coverage and reports the shortfall', () => {
    const hull = hydrogenRelay();
    const plan = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull,
      target: { kind: 'whole' },
      count: 5,
    });
    expect(plan.countUsed).toBeLessThanOrEqual(5);
    expect(plan.countUsed).toBeGreaterThan(0);
    expect(plan.uncoveredPct).toBeGreaterThan(0);
    expect(plan.countNeeded).toBeGreaterThan(5);
    expect(plan.coveragePct + plan.uncoveredPct).toBeCloseTo(100, 1);
  });

  it('returns all-low, all-max-reach and best-mixed alternatives', () => {
    const plan = solveCoverGoal({
      planet: earth,
      k: 1,
      cellDeg: 10,
      rangeMargin: 0.9,
      altitudeMode: 'cheapest',
      hull: hydrogenRelay(),
      target: { kind: 'whole' },
    });
    expect(plan.alternatives.map((entry) => entry.id)).toEqual(['all-low', 'all-max-reach', 'best-mixed']);
    const low = plan.alternatives[0]!;
    const max = plan.alternatives[1]!;
    const mixed = plan.alternatives[2]!;
    expect(low.ships).toBeGreaterThan(max.ships);
    expect(mixed.ships).toBe(plan.countUsed);
    for (const entry of plan.alternatives) {
      expect(entry.coveragePct).toBeGreaterThan(0);
      expect(entry.antennaMW).toBeGreaterThan(0);
      expect(typeof entry.h2L).toBe('number');
      expect(['corrected', 'unavailable', 'none']).toContain(entry.terrain);
    }
  });
});

function basePosition() {
  return { x: earth.center.x, y: earth.center.y + earth.surfaceRadiusM + 1_800, z: earth.center.z };
}
