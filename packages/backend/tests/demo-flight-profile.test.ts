import { describe, expect, it } from 'vitest';
import { computeLegProfile, shouldResendMove, type FlightHardware } from '../src/demo/flight.js';
import { flightGuardVerdict } from '../src/demo/safety.js';

const ORIGIN = { x: 0, y: 0, z: 0 };
const at = (z: number) => ({ x: 0, y: 0, z });

/** 100 t grid with 600 kN ion thrust: 6 m/s² in vacuum. */
const VACUUM_SHIP: FlightHardware = {
  massKg: 100_000,
  thrustN: { atmo: 0, ion: 600_000, h2: 0 },
  powerMW: { atmo: 0, ion: 5, h2: 0 },
  h2Fraction: 1,
  batteryFraction: 1,
};

describe('computeLegProfile', () => {
  it('flies a 5 km vacuum leg at the 60 m/s cap with dampeners off', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(5_000), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.vCruiseMps).toBe(60);
    expect(p.dampeners).toBe('off');
    expect(p.flightMode).toBe('OneWay');
    expect(p.accelMps2).toBeCloseTo(6, 2);
    // brake = 60² / (2*6) = 300 m, held back from the 5 km waypoint.
    expect(p.brakeStartDistM).toBe(300);
    // 10 s burn + 73.3 s coast + 10 s brake
    expect(p.etaS).toBeCloseTo(93.3, 0);
    expect(p.fuelL).toBe(0); // no hydrogen on this hull
  });

  it('derives v_cruise from a_brake for a leg too short to reach the cap', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(500), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    // sqrt(2 * 6 * (500 - 50)) = 73.5 > 60, so still capped; a 200 m leg is not.
    const short = computeLegProfile(VACUUM_SHIP, ORIGIN, at(200), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.vCruiseMps).toBe(60);
    expect(short.vCruiseMps).toBeCloseTo(42.4, 1);
    expect(short.brakeStartDistM).toBe(150);
  });

  it('uses Precision inside 100 m and still produces a flyable order', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(80), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.flightMode).toBe('Precision');
    expect(p.vCruiseMps).toBeCloseTo(19, 1);
    expect(p.vCruiseMps).toBeGreaterThanOrEqual(1);
  });

  it('caps a huge leg at cruise and coasts for most of it', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(500_000), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.vCruiseMps).toBe(60);
    expect(p.brakeStartDistM).toBe(300);
    expect(p.etaS).toBeGreaterThan(8_000);
    expect(p.etaS).toBeLessThan(9_000);
  });

  it('flies atmosphere dampeners-on with a 30 m/s climb floor', () => {
    const atmoShip: FlightHardware = {
      ...VACUUM_SHIP,
      thrustN: { atmo: 1_200_000, ion: 40_000, h2: 0 },
      powerMW: { atmo: 6, ion: 1, h2: 0 },
      h2Fraction: 0,
    };
    const climb = computeLegProfile(atmoShip, { x: 0, y: 60_000, z: 0 }, { x: 0, y: 60_080, z: 0 }, {
      maxCruiseMps: 60,
      gravityMps2: 9.81,
      hasAtmosphere: true,
      altitudeAglM: 2_000,
      targetAglM: 4_000,
    });
    // Distance 80 m allows ~sqrt(2*3*30)=13 m/s, but climbing in air must not
    // go below 30 m/s.
    expect(climb.dampeners).toBe('on');
    expect(climb.climbFloorMps).toBe(30);
    expect(climb.vCruiseMps).toBeGreaterThanOrEqual(30);
    expect(climb.accelMps2).toBeCloseTo(2.59, 1); // (1.2M+40k)/100t - 9.81

    const level = computeLegProfile(atmoShip, ORIGIN, at(5_000), {
      maxCruiseMps: 60,
      gravityMps2: 9.81,
      hasAtmosphere: true,
      altitudeAglM: 2_000,
      targetAglM: 2_000,
    });
    expect(level.climbFloorMps).toBe(0);
    expect(level.dampeners).toBe('on');
  });

  it('predicts hydrogen burn only while thrusting in vacuum', () => {
    const h2Ship: FlightHardware = {
      massKg: 50_000,
      thrustN: { atmo: 0, ion: 0, h2: 500_000 },
      powerMW: { atmo: 0, ion: 0, h2: 4 },
      h2Fraction: 0.8,
      batteryFraction: 1,
    };
    const coast = computeLegProfile(h2Ship, ORIGIN, at(20_000), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    const hover = computeLegProfile(h2Ship, ORIGIN, at(100), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(coast.fuelL).toBeGreaterThan(0);
    // Same ship, shorter leg: fewer thrust-seconds -> less fuel.
    expect(hover.fuelL).toBeLessThan(coast.fuelL);
    const noFuel = computeLegProfile({ ...h2Ship, h2Fraction: 0 }, ORIGIN, at(20_000), {
      maxCruiseMps: 60,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(noFuel.fuelL).toBe(0);
  });
});

describe('100 m/s cruise (SE autopilot maximum)', () => {
  it('flies a 5 km vacuum leg at 100 m/s: brake 833 m, ETA 66.7 s', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(5_000), {
      maxCruiseMps: 100,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.vCruiseMps).toBe(100);
    expect(p.brakeStartDistM).toBe(833); // 100² / (2*6)
    // 16.7 s burn + 33.3 s coast + 16.7 s brake
    expect(p.etaS).toBeCloseTo(66.7, 1);
    expect(p.dampeners).toBe('off');
  });

  it('flies a 40 km vacuum leg at 100 m/s: brake 833 m, ETA 416.7 s', () => {
    const p = computeLegProfile(VACUUM_SHIP, ORIGIN, at(40_000), {
      maxCruiseMps: 100,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    expect(p.vCruiseMps).toBe(100);
    expect(p.brakeStartDistM).toBe(833);
    expect(p.etaS).toBeCloseTo(416.7, 1);
    expect(p.flightMode).toBe('OneWay');
  });

  it('the guard refuses 100 m/s when this hull cannot stop inside the remaining distance', () => {
    // 50 t with 100 kN ion = 2 m/s²: 100 m/s needs 2500 m raw, 3750 m with 1.5x.
    // h2Pct > 0 is only to satisfy the vacuum reserve guard; thrustN.h2 is 0.
    const slow = { massKg: 50_000, thrustN: { atmo: 0, ion: 100_000, h2: 0 }, h2Pct: 50, gravityMps2: 0, hasAtmosphere: false };
    const out = flightGuardVerdict({
      ...slow,
      distanceM: 1_000,
      speedMps: 100,
      speedLimitMps: 100,
      verticalSpeedMps: 0,
      altitudeAglM: 40_000,
      targetAglM: 40_000,
      batteryPct: 100,
    });
    expect(out.action).toBe('brake');
    expect(out.code).toBe('braking-distance');
    expect(out.targetSpeedMps).toBeLessThan(60);
    expect(out.brakingDistanceM).toBe(3_750);
    // With enough room the same 100 m/s is allowed.
    const roomy = flightGuardVerdict({
      ...slow,
      distanceM: 4_000,
      speedMps: 100,
      speedLimitMps: 100,
      verticalSpeedMps: 0,
      altitudeAglM: 40_000,
      targetAglM: 40_000,
      batteryPct: 100,
    });
    expect(roomy.action).toBe('ok');
  });
});

describe('shouldResendMove', () => {
  it('keeps one move per leg until the required speed changes >20%', () => {
    expect(shouldResendMove(60, 70, false)).toBe(false); // 16.7 %
    expect(shouldResendMove(60, 75, false)).toBe(true); // 25 %
    expect(shouldResendMove(60, 60, true)).toBe(true); // guard tripped
  });
});
