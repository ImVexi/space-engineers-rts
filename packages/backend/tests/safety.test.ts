import { describe, expect, it } from 'vitest';
import {
  BRAKE_MARGIN,
  HARD_CAP_10M_MPS,
  HARD_CAP_100M_MPS,
  MAX_AUTOPILOT_SPEED_MPS,
  achievableDecelMps2,
  approachVerdict,
  brakingDistanceM,
  flightGuardVerdict,
  groundVerdict,
  normalizeSpeedLimitMps,
  reserveVerdict,
  safeApproachSpeedMps,
} from '../src/demo/safety.js';

const hull = { atmo: 1_152_000, ion: 0, h2: 984_000 };
const base = { massKg: 19_000, thrustN: hull, h2Pct: 50, gravityMps2: 9.81, hasAtmosphere: true };

describe('speed cap validation', () => {
  it('defaults to 100 (the autopilot ceiling) and clamps to it', () => {
    expect(MAX_AUTOPILOT_SPEED_MPS).toBe(100);
    expect(normalizeSpeedLimitMps(undefined)).toBe(100);
    expect(normalizeSpeedLimitMps('100')).toBe(100);
    expect(normalizeSpeedLimitMps(250)).toBe(100); // SE ignores >100
    expect(normalizeSpeedLimitMps(60)).toBe(60); // still available as an override
    expect(normalizeSpeedLimitMps(0)).toBe(100);
    expect(normalizeSpeedLimitMps('garbage')).toBe(100);
  });

  it('keeps the 1.5x margin and the 5/1 m/s arrival caps at a 100 cap', () => {
    // 100 m/s at 6 m/s² needs 833 m; with the margin 1250 m is exactly enough.
    expect(safeApproachSpeedMps(1_250, 6, 100)).toBeCloseTo(100, 5);
    expect(safeApproachSpeedMps(1_249, 6, 100)).toBeLessThan(100);
    expect(safeApproachSpeedMps(100, 50, 100)).toBe(HARD_CAP_100M_MPS);
    expect(safeApproachSpeedMps(10, 50, 100)).toBe(HARD_CAP_10M_MPS);
  });
});

describe('approach braking profile', () => {
  it('computes v²/(2a) braking distance and the 1.5x margin', () => {
    expect(brakingDistanceM(60, 6)).toBeCloseTo(300, 6);
    expect(brakingDistanceM(0, 6)).toBe(0);
    expect(brakingDistanceM(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(BRAKE_MARGIN).toBe(1.5);
    // 60 m/s needs 1.5 * 300 = 450 m to stop with the margin.
    expect(safeApproachSpeedMps(450, 6, 60)).toBeCloseTo(60, 5);
  });

  it('caps speed near the slot: 5 m/s inside 100 m, 1 m/s inside 10 m', () => {
    expect(safeApproachSpeedMps(150, 20, 60)).toBeLessThanOrEqual(60);
    expect(safeApproachSpeedMps(100, 20, 60)).toBe(HARD_CAP_100M_MPS);
    expect(safeApproachSpeedMps(50, 20, 60)).toBe(HARD_CAP_100M_MPS);
    expect(safeApproachSpeedMps(10, 20, 60)).toBe(HARD_CAP_10M_MPS);
    expect(safeApproachSpeedMps(2, 20, 60)).toBeLessThanOrEqual(HARD_CAP_10M_MPS);
  });

  it('flags the real overshoot: 80 m/s at 272 m was never a braking approach', () => {
    const out = approachVerdict({ ...base, distanceM: 272, speedMps: 80, speedLimitMps: 60 });
    expect(out.ok).toBe(false);
    // The measured hull brakes hard, so the allowed speed is the 60 m/s limit,
    // not an assumed crawl; 80 m/s still exceeds what the guard allows.
    expect(out.targetSpeedMps).toBeLessThanOrEqual(60);
    expect(out.reason).toMatch(/approach too fast/);
  });

  it('accepts a slow approach and reports the decel numbers', () => {
    const out = approachVerdict({ ...base, distanceM: 300, speedMps: 4, speedLimitMps: 60 });
    expect(out.ok).toBe(true);
    expect(out.targetSpeedMps).toBeLessThanOrEqual(60);
    expect(out.availableDecelMps2).toBeGreaterThan(0);
  });

  it('ignores hydrogen force when the tank is empty', () => {
    const withFuel = achievableDecelMps2({ massKg: 19_000, thrustN: hull, h2Pct: 50, gravityMps2: 9.81 });
    const empty = achievableDecelMps2({ massKg: 19_000, thrustN: hull, h2Pct: 0, gravityMps2: 9.81 });
    expect(withFuel).toBeGreaterThan(empty);
    expect(empty).toBeGreaterThan(0); // atmosphere alone still brakes
    expect(achievableDecelMps2({ massKg: 19_000, thrustN: { atmo: 0, ion: 0, h2: 0 }, h2Pct: 100, gravityMps2: 9.81 })).toBe(0);
  });
});

describe('ground proximity guard', () => {
  it('aborts below the floor while descending and brakes on a fast low descent', () => {
    expect(groundVerdict({ altitudeM: 20, verticalSpeedMps: -3 }).action).toBe('abort');
    expect(groundVerdict({ altitudeM: 100, verticalSpeedMps: -6 }).action).toBe('brake');
    expect(groundVerdict({ altitudeM: 100, verticalSpeedMps: -2 }).action).toBe('ok');
    expect(groundVerdict({ altitudeM: 500, verticalSpeedMps: -9 }).action).toBe('ok');
  });
});

describe('fuel/charge reserve guard', () => {
  it('refuses a vacuum leg that would eat the 15 % reserve', () => {
    const out = reserveVerdict({ h2Pct: 18, batteryPct: 100, remainingM: 200_000, speedMps: 20, massKg: 19_000, gravityMps2: 0, hasAtmosphere: false });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/hydrogen/);
  });

  it('refuses a battery below 15 %', () => {
    const out = reserveVerdict({ h2Pct: 50, batteryPct: 9, remainingM: 100, speedMps: 5, massKg: 19_000, gravityMps2: 9.81, hasAtmosphere: true });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/battery/);
  });

  it('accepts a short atmospheric hop on an empty tank', () => {
    const out = reserveVerdict({ h2Pct: 0, batteryPct: 100, remainingM: 300, speedMps: 10, massKg: 19_000, gravityMps2: 9.81, hasAtmosphere: true });
    expect(out.ok).toBe(true);
  });
});

describe('executor flight guard', () => {
  const guard = (over: Partial<Parameters<typeof flightGuardVerdict>[0]> = {}) =>
    flightGuardVerdict({
      ...base,
      distanceM: 300,
      speedMps: 2,
      speedLimitMps: 60,
      verticalSpeedMps: 0,
      altitudeAglM: 300,
      targetAglM: 400,
      batteryPct: 100,
      ...over,
    });

  it('aborts and stops when thrust cannot lift the mass', () => {
    const out = guard({ thrustN: { atmo: 10_000, ion: 0, h2: 0 }, h2Pct: 0 });
    expect(out.action).toBe('abort-stop');
    expect(out.code).toBe('thrust-loss');
  });

  it('aborts and holds on the battery reserve, hydrogen reserve or ground floor', () => {
    expect(guard({ batteryPct: 9 }).action).toBe('abort-hold');
    expect(guard({ batteryPct: 9 }).code).toBe('reserve');
    const vacuum = guard({ hasAtmosphere: false, h2Pct: 16, thrustN: { atmo: 0, ion: 0, h2: 984_000 } });
    expect(vacuum.action).toBe('abort-hold');
    const floor = guard({ altitudeAglM: 20, verticalSpeedMps: -3 });
    expect(floor.action).toBe('abort-hold');
    expect(floor.code).toBe('ground-floor');
  });

  it('estimates the vacuum reserve from the leg plan, not the first tick speed', () => {
    // 5 km at 0.5 m/s reads as ~10 000 s of hover; the planned 60 m/s is 83 s.
    const firstTick = guard({
      distanceM: 5_000,
      speedMps: 0.5,
      plannedSpeedMps: 60,
      hasAtmosphere: false,
      h2Pct: 100,
      thrustN: { atmo: 0, ion: 0, h2: 984_000 },
    });
    expect(firstTick.action).not.toBe('abort-hold');
    expect(firstTick.code).not.toBe('reserve');
    const noPlan = guard({
      distanceM: 5_000,
      speedMps: 0.5,
      hasAtmosphere: false,
      h2Pct: 100,
      thrustN: { atmo: 0, ion: 0, h2: 984_000 },
    });
    expect(noPlan.code).toBe('reserve');
  });

  it('lowers the floor for a deliberate landing waypoint', () => {
    // Waypoint 5 m AGL -> floor 2 m: 4 m at -3 m/s is an abort, 6 m is fine.
    expect(guard({ targetAglM: 5, altitudeAglM: 1, verticalSpeedMps: -3 }).action).toBe('abort-hold');
    expect(guard({ targetAglM: 5, altitudeAglM: 6, verticalSpeedMps: -1 }).action).not.toBe('abort-hold');
  });

  it('brakes a fast low descent and throttles a fast approach', () => {
    expect(guard({ altitudeAglM: 100, verticalSpeedMps: -8 }).code).toBe('ground-descent');
    const fast = guard({ distanceM: 100, speedMps: 25 });
    expect(fast.action).toBe('brake');
    expect(fast.targetSpeedMps).toBeLessThanOrEqual(HARD_CAP_100M_MPS);
    const close = guard({ distanceM: 10, speedMps: 4 });
    expect(close.targetSpeedMps).toBeLessThanOrEqual(HARD_CAP_10M_MPS);
  });

  it('accepts a slow approach with a comfortable braking distance', () => {
    const out = guard({ distanceM: 300, speedMps: 4 });
    expect(out.action).toBe('ok');
    expect(out.brakingDistanceM).toBeLessThan(300);
    expect(out.availableDecelMps2).toBeGreaterThan(0);
  });
});
