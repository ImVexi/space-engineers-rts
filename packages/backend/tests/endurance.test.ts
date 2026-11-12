import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import {
  PREFAB_HARDWARE,
  SMALL_GRID_EXAMPLES,
  bankFromCounts,
  HYDROGEN_ENERGY_DENSITY_MWH_PER_L,
} from '../src/demo/endurance/definitions.js';
import {
  airDensity,
  allocateThrust,
  atmosphereTopAltitudeM,
  canSurfaceLaunch,
  effectiveness,
  evaluateHullAtSlot,
  formatDuration,
  hullFromSpec,
  preflightLaunch,
  simulateAscent,
  slotPhysics,
  thrustAtAltitude,
} from '../src/demo/endurance/model.js';
import { gravityFreeAltitudeM, planetGravity } from '../src/demo/designer/gravity.js';
import { buildDesignerPlan, prefabHulls } from '../src/demo/designer/index.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const eradicator = hullFromSpec(PREFAB_HARDWARE['Eradicator_mk.1']!);
const escort = hullFromSpec(PREFAB_HARDWARE['Escort TT-420']!);
const drone = hullFromSpec(PREFAB_HARDWARE['Large Control Drone']!);
const ionSat = hullFromSpec(SMALL_GRID_EXAMPLES['example:ion-solar-sat']!);
const h2Sat = hullFromSpec(SMALL_GRID_EXAMPLES['example:h2-sat']!);

describe('atmosphere and thrust-vs-altitude curves', () => {
  it('uses the definition air-density ramp (linear to the atmosphere top)', () => {
    // EarthLike: 60 km average radius, HillParams.Max 0.12, LimitAltitude 2.0.
    expect(Math.round(atmosphereTopAltitudeM(earth))).toBe(15_000);
    expect(airDensity(earth, 0)).toBeCloseTo(1, 3);
    expect(airDensity(earth, 5_000)).toBeGreaterThan(0.5);
    expect(airDensity(earth, 20_000)).toBe(0);
  });

  it('scales atmospheric thrust to zero and ion to its vacuum value', () => {
    expect(effectiveness('atmo', 1)).toBeCloseTo(1, 6);
    expect(effectiveness('atmo', 0.3)).toBeCloseTo(0, 6);
    expect(effectiveness('atmo', 0)).toBe(0);
    expect(effectiveness('ion', 1)).toBeCloseTo(0.2, 6);
    expect(effectiveness('ion', 0)).toBeCloseTo(1, 6);
    expect(effectiveness('h2', 1)).toBeCloseTo(1, 6);

    const surface = thrustAtAltitude(eradicator, earth, 0);
    const space = thrustAtAltitude(eradicator, earth, 30_000);
    expect(surface.forceN.ion / eradicator.thrust.ion.forceN).toBeCloseTo(0.2, 2);
    expect(space.forceN.ion).toBeCloseTo(eradicator.thrust.ion.forceN, 0);
    expect(surface.forceN.atmo).toBe(0);
  });

  it('keeps hydrogen thrust constant with altitude', () => {
    const low = thrustAtAltitude(escort, earth, 2_000);
    const high = thrustAtAltitude(escort, earth, 40_000);
    expect(low.forceN.h2).toBeCloseTo(high.forceN.h2, 0);
    expect(high.forceN.h2).toBeGreaterThan(0);
  });

  it('resolves the mixed Escort thrust split from definitions, not from a total', () => {
    const atmo = bankFromCounts(PREFAB_HARDWARE['Escort TT-420']!.thrustCounts.atmo).forceN;
    const h2 = bankFromCounts(PREFAB_HARDWARE['Escort TT-420']!.thrustCounts.h2).forceN;
    expect(atmo).toBe(18_144_000);
    expect(h2).toBe(13_680_000);
    expect(atmo + h2).toBe(31_824_000);
  });
});

describe('hover and hold cost', () => {
  it('derives the hydrogen burn rate from the fuel converter, not a guessed flow', () => {
    const slot = slotPhysics(h2Sat, earth, 30_000);
    expect(slot.canHover).toBe(true);
    const required = h2Sat.massKg * slot.gravityMps2;
    expect(slot.requiredThrustN).toBeCloseTo(required, 3);
    const throttle = required / h2Sat.thrust.h2.forceN;
    const expected = (throttle * h2Sat.thrust.h2.powerMW) / HYDROGEN_ENERGY_DENSITY_MWH_PER_L;
    expect(slot.hover!.h2BurnLps).toBeCloseTo(expected, 6);
    // 10 t at 1.33 m/s2 needs ~13.3 kN of a 480 kN thruster.
    expect(slot.hover!.h2BurnLps).toBeGreaterThan(9);
    expect(slot.hover!.h2BurnLps).toBeLessThan(13);
  });

  it('limits a hydrogen hold by the tank and an ion+solar hold by the battery', () => {
    const h2Hold = slotPhysics(h2Sat, earth, 30_000);
    expect(typeof h2Hold.holdEnduranceS).toBe('number');
    const hours = (h2Hold.holdEnduranceS as number) / 3600;
    expect(hours).toBeGreaterThan(10);
    expect(hours).toBeLessThan(20);

    const ionHold = slotPhysics(ionSat, earth, 30_000);
    expect(ionHold.hover!.powerMW).toBeGreaterThan(0);
    expect(ionHold.limiting).toBe('battery');
    expect(typeof ionHold.holdEnduranceS).toBe('number');
  });

  it('reports an indefinite hold when gravity is zero', () => {
    const slot = slotPhysics(eradicator, earth, 60_000);
    expect(slot.gravityMps2).toBe(0);
    expect(slot.requiredThrustN).toBe(0);
    expect(slot.holdEnduranceS).toBe('indefinite');
    expect(slot.limiting).toBe('gravity-free');
  });

  it('allocates atmosphere first, then ion, then hydrogen', () => {
    const available = thrustAtAltitude(escort, earth, 1_000);
    const allocation = allocateThrust(escort, available, 10_000_000);
    expect(allocation.forceN.atmo).toBeGreaterThan(0);
    expect(allocation.forceN.h2).toBe(0);
  });
});

describe('ascent simulation', () => {
  it('lifts a hydrogen hull from the surface to 60 km with fuel to spare', () => {
    expect(canSurfaceLaunch(escort, earth)).toBe(true);
    const ascent = simulateAscent({ hull: escort, planet: earth, targetAltitudeM: 60_000 });
    expect(ascent.ok).toBe(true);
    expect(ascent.timeS).toBeGreaterThan(300);
    expect(ascent.timeS).toBeLessThan(1_200);
    expect(ascent.h2UsedL).toBeGreaterThan(0);
    expect(ascent.h2UsedL / escort.h2CapacityL).toBeLessThan(0.05);
  });

  it('fails with "H2 exhausted at ... km" when the tank is too small', () => {
    const small = hullFromSpec({
      ...SMALL_GRID_EXAMPLES['example:h2-sat']!,
      massKg: 40_000,
      h2TankCounts: { SmallHydrogenTankSmall: 1 },
      h2Fill: 1,
    });
    const ascent = simulateAscent({ hull: small, planet: earth, targetAltitudeM: 60_000 });
    expect(ascent.ok).toBe(false);
    expect(ascent.failureReason).toMatch(/H2 exhausted at \d+(\.\d+)? km/);
  });

  it('fails with an ion TWR reason when an ion hull tries to lift from the ground', () => {
    expect(canSurfaceLaunch(eradicator, earth)).toBe(false);
    const ascent = simulateAscent({ hull: eradicator, planet: earth, targetAltitudeM: 60_000 });
    expect(ascent.ok).toBe(false);
    expect(ascent.failureReason).toMatch(/ion TWR 0\.\d+ at 0\.0 km/);
  });

  it('cannot lift an atmospheric hull above its atmosphere', () => {
    const ascent = simulateAscent({ hull: drone, planet: earth, targetAltitudeM: 60_000 });
    expect(ascent.ok).toBe(false);
    expect(ascent.failureReason).toMatch(/atmo TWR/);
  });
});

describe('slot report and launch gate', () => {
  it('reaches the 60 km ring from an orbital spawn and holds for free', () => {
    const report = evaluateHullAtSlot({
      hull: eradicator,
      planet: earth,
      altitudeM: 60_000,
      transitDistanceM: 200_000,
    });
    expect(report.canReachSlot).toBe(true);
    expect(report.launch).toBe('orbital');
    expect(report.holdEnduranceS).toBe('indefinite');
    expect(report.reservePct).toBeGreaterThanOrEqual(15);
    expect(report.gravityMps2).toBe(0);
    expect(report.recommendation).toMatch(/zero gravity/);
  });

  it('refuses a surface launch of an ion-only hull with the model reason', () => {
    const report = evaluateHullAtSlot({ hull: eradicator, planet: earth, altitudeM: 60_000, launch: 'surface' });
    expect(report.canReachSlot).toBe(false);
    expect(report.failureReason).toMatch(/ion TWR/);
    const gate = preflightLaunch({ hull: eradicator, planet: earth, altitudeM: 60_000, launch: 'surface' });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/cannot reach 60 km/);
  });

  it('refuses an arrival below the configured reserve', () => {
    // 500,000 L tank at 3 % = 15,000 L: enough to fly, not enough reserve.
    const thin = hullFromSpec({ ...SMALL_GRID_EXAMPLES['example:h2-sat']!, h2Fill: 0.034 });
    const gate = preflightLaunch({ hull: thin, planet: earth, altitudeM: 60_000, requiredReservePct: 15 });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/reserve/);
    expect(gate.reservePct).toBeLessThan(15);
  });

  it('accepts the same hull with a full tank', () => {
    const gate = preflightLaunch({ hull: h2Sat, planet: earth, altitudeM: 60_000, requiredReservePct: 15 });
    expect(gate.ok).toBe(true);
    expect(gate.reservePct).toBeGreaterThan(80);
  });

  it('formats durations for the UI', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(3_600)).toBe('1 h 00 min');
    expect(formatDuration('indefinite')).toBe('indefinite');
  });
});

describe('designer integration', () => {
  it('adds endurance fields and sorts feasible options first', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 60_000,
        count: 18,
        hullId: 'prefab:Eradicator_mk.1',
        rangeMargin: 0.9,
        redundancy: 1,
      },
      prefabHulls(),
      PLANET_CATALOG,
    );
    expect(plan.options.length).toBeGreaterThan(0);
    for (const option of plan.options) {
      expect(option.endurance).toBeDefined();
      expect(option.endurance.available).toBe(true);
    }
    const flags = plan.options.map((o) => o.feasible);
    expect(flags).toContain(true);
    const firstInfeasible = flags.indexOf(false);
    if (firstInfeasible >= 0) expect(flags.slice(firstInfeasible).every((f) => !f)).toBe(true);
  });

  it('reports an atmo-only hull as unable to reach a 60 km slot', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 60_000,
        count: 4,
        hullId: 'prefab:Large Control Drone',
        rangeMargin: 0.9,
        redundancy: 1,
      },
      prefabHulls(),
      PLANET_CATALOG,
    );
    const ring = plan.options[0]!;
    expect(ring.endurance.canReachSlot).toBe(false);
    expect(ring.feasible).toBe(false);
    expect(ring.reasons.join(' ')).toMatch(/endurance preflight/);
  });

  it('keeps the gravity-free example consistent with the designer gravity model', () => {
    expect(Math.round(gravityFreeAltitudeM(planetGravity(earth)))).toBe(43_693);
  });
});
