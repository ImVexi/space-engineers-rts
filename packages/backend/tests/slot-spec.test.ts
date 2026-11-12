import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { buildDesignerPlan, type DesignerOption } from '../src/demo/designer/plan.js';
import { planSlotPlacement } from '../src/demo/designer/placement.js';
import { buildSlotSpec } from '../src/demo/designer/slotSpec.js';
import { prefabHulls } from '../src/demo/designer/hulls.js';
import { gravityFreeAltitudeM, planetGravity } from '../src/demo/designer/gravity.js';
import { unavailableTerrainField } from '../src/planner/terrainField.js';
import { v3 } from '../src/planner/geometry.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const hulls = prefabHulls();
const escort = hulls.find((h) => h.id === 'prefab:Escort TT-420')!;
const eradicator = hulls.find((h) => h.id === 'prefab:Eradicator_mk.1')!;

describe('cell-driven placement (T49)', () => {
  // Five target cells spanning ~5 km at the equator; a 50 km radio can cover
  // them all with one relay, so k=2 is what forces a second slot.
  const cells = [
    { latDeg: 0, lonDeg: 0 },
    { latDeg: 0, lonDeg: 2.4 },
    { latDeg: 0, lonDeg: -2.4 },
    { latDeg: 2.4, lonDeg: 0 },
    { latDeg: -2.4, lonDeg: 0 },
  ];

  const placement = planSlotPlacement({
    planet: earth,
    altitudeM: 15_000,
    ships: 6,
    radioRangeM: 50_000,
    rangeMargin: 0.9,
    cellDeg: 2,
    k: 2,
    baseDirection: v3(1, 0, 0),
    region: { latDeg: 0, lonDeg: 0, radiusM: 2_500 },
    cells,
  });

  it('flags a 5 km-apart cluster as bunching', () => {
    expect(placement.slotsUsed).toBe(2);
    expect(placement.bunching).toBe(true);
    // Two slots inside a 2.5 km-radius region cannot be more than 5 km apart.
    expect(placement.minSpacingM).toBeGreaterThan(0);
    expect(placement.minSpacingM).toBeLessThanOrEqual(5_000);
    expect(placement.minSpacingM).toBeLessThan(0.5 * 50_000);
    expect(placement.reasons.join(' ')).toContain('0.5 x radio rule');
  });

  it('returns spare ships instead of using all N', () => {
    expect(placement.shipsRequested).toBe(6);
    expect(placement.spareShips).toHaveLength(4);
    expect(placement.spareShips.every((spare) => spare.reason.length > 0)).toBe(true);
    expect(placement.spareReason).toContain('needs 2');
    expect(placement.spareReason).toContain('4 spare');
    expect(placement.positions).toHaveLength(placement.slotsUsed);
  });

  it('keeps every slot within one hop of the path back to the base', () => {
    expect(placement.connectedToBase).toBe(true);
    for (const spacing of placement.spacingM) expect(spacing).toBeLessThanOrEqual(45_000 + 0.5);
    for (const position of placement.positions) {
      const { x, y, z } = position.position;
      const length = Math.hypot(x, y, z);
      // Base/region centre is +X (lat 0, lon 0) on this world.
      const groundM = Math.acos(Math.max(-1, Math.min(1, x / length))) * earth.surfaceRadiusM;
      expect(groundM).toBeLessThanOrEqual(2_500 + 1);
    }
  });

  it('covers the target and spreads slots over a whole planet', () => {
    const planetWide = planSlotPlacement({
      planet: earth,
      altitudeM: 15_000,
      ships: 20,
      radioRangeM: 50_000,
      cellDeg: 10,
      k: 1,
    });
    expect(planetWide.slotsUsed).toBe(20);
    expect(planetWide.spareShips).toHaveLength(0);
    expect(planetWide.bunching).toBe(false);
    expect(planetWide.minSpacingM).toBeGreaterThanOrEqual(0.5 * 50_000);
    expect(planetWide.coverage.coveragePct).toBeGreaterThan(90);
    expect(planetWide.connectedToBase).toBe(true);
    expect(planetWide.cells.length).toBe(36 * 18);
  });
});

describe('slot specifications (T49)', () => {
  const specAt = (altitudeM: number, hull = escort, requiredRadioM: number | null = 50_000) =>
    buildSlotSpec({
      planet: earth,
      slotId: `slot-${altitudeM}`,
      position: v3(0, earth.surfaceRadiusM + altitudeM, 0),
      altitudeM,
      hull,
      requiredRadioM,
      ownedHulls: [],
    });

  it('chooses atmospheric thrust for a 5 km slot and hydrogen/ion for 45 km', () => {
    const low = specAt(5_000);
    const high = specAt(45_000);
    expect(low.thrustClassNeeded).toBe('atmo');
    expect(low.tier).toBe('atmo');
    expect(low.holdMode).toBe('station');
    expect(low.climbTimeS).toBeGreaterThan(0);
    expect(low.atmoThrustCeilingM).toBeGreaterThanOrEqual(5_000);

    expect(['hydrogen', 'ion']).toContain(high.thrustClassNeeded);
    expect(high.thrustClassNeeded).toBe('hydrogen');
    expect(high.tier).toBe('space');
    expect(high.altitudeM).toBe(45_000);
    expect(high.atmoThrustCeilingM).toBeLessThan(45_000);
    expect(high.climbTimeS).toBeGreaterThan(0);
    expect(high.altitudeM).toBeGreaterThanOrEqual(Math.ceil(gravityFreeAltitudeM(planetGravity(earth))) - 1);
  });

  it('uses the endurance model for climb and fuel, and the T30 model for antenna draw', () => {
    const low = specAt(5_000);
    expect(low.fuelEstimate.source).toBe('demo/endurance/model.ts evaluateHullAtSlot');
    expect(low.fuelEstimate.h2L).toBeGreaterThan(0);
    expect(low.fuelEstimate.reservePct).toBeGreaterThan(0);
    expect(low.antennaDrawMW).toBeCloseTo(0.2, 3); // 50 km x 0.004 MW/km
    expect(low.hoverDrawMW).toBeNull(); // station mode
    expect(low.rationale.endsWith('.')).toBe(true);
    expect(low.rationale).toContain('Station at 5.0 km');
  });

  it('reports a hover draw only when the slot cannot be a station', () => {
    const groundHugging = specAt(50);
    expect(groundHugging.tier).toBe('ground');
    expect(groundHugging.holdMode).toBe('ship');
    expect(groundHugging.hoverDrawMW).not.toBeNull();
    expect(groundHugging.hoverDrawMW!).toBeGreaterThan(0);
  });

  it('emits a build request when no owned hull fits', () => {
    const spec = specAt(45_000);
    expect(spec.ownedFits).toHaveLength(0);
    expect(spec.buildRequest).toContain('BUILD:');
    expect(spec.buildRequest).toContain('45.0 km');
    expect(spec.buildRequest).toContain('hydrogen thrust');
  });

  it('rejects an owned hull whose radio is too short, with a plain reason', () => {
    const shortRadio = { ...eradicator, id: 'owner:short', source: 'owner-tagged' as const, radioRangeM: 10_000 };
    const spec = buildSlotSpec({
      planet: earth,
      slotId: 'o1',
      position: v3(0, earth.surfaceRadiusM + 15_000, 0),
      altitudeM: 15_000,
      hull: eradicator,
      requiredRadioM: 50_000,
      ownedHulls: [shortRadio],
    });
    expect(spec.ownedFits).toHaveLength(1);
    expect(spec.ownedFits[0]!.fits).toBe(false);
    expect(spec.ownedFits[0]!.why).toContain('radio');
  });
});

describe('wiring into the designer plan (T49)', () => {
  const NOW = 1_800_000_000_000;

  it('keeps the ring option API and adds placement fields', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 15_000,
        count: 10,
        hullId: eradicator.id,
        rangeMargin: 0.9,
        redundancy: 1,
      },
      hulls,
      PLANET_CATALOG,
      NOW,
    );
    const option = plan.options.find((candidate) => candidate.pattern === 'ring')!;
    expect(option).toBeTruthy();
    expect(Array.isArray(option.positions)).toBe(true);
    expect(typeof option.count).toBe('number');
    expect(option.count).toBe(option.positions.length);
    expect(option.endurance).toBeDefined();
    // T49 additions.
    expect(option.slots?.length).toBe(option.positions.length);
    expect(option.shipsRequested).toBeGreaterThan(0);
    expect(Array.isArray(option.spacingM)).toBe(true);
    expect(typeof option.bunching).toBe('boolean');
    expect(Array.isArray(option.spareShips)).toBe(true);
    expect(option.terrain).toBe('none');
    expect(option.reasons.join(' ')).toContain('coverage grid');
  });

  it('labels a cover-planet option terrain:unavailable when the field fails', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'cover-planet',
        planet: 'EarthLike',
        pattern: 'auto',
        hullId: eradicator.id,
        rangeMargin: 0.9,
        redundancy: 1,
        k: 1,
        cellDeg: 20,
      },
      hulls,
      PLANET_CATALOG,
      NOW,
      undefined,
      { terrain: unavailableTerrainField(earth, 'terrain service offline') },
    );
    const option: DesignerOption = plan.options[0]!;
    expect(option.terrain).toBe('unavailable');
    expect(option.coverage?.terrain).toBe('unavailable');
    expect(option.coverage?.terrainReason).toContain('terrain service offline');
    expect(option.reasons.join(' ')).toContain('smooth-sphere');
    expect(option.slots?.length).toBe(option.positions.length);
    expect(option.spacingM?.length).toBeGreaterThan(0);
  });
});
