/**
 * Cruise-speed regression: a ship must fly a long leg at the configured cap and
 * only taper near the waypoint.
 *
 * These tests encode the owner's complaint ("ships go at 5 metres a second
 * instead of full speed") as assertions, so the failure modes that produced it
 * cannot come back silently:
 *
 *  1. the 5 m/s arrival cap applied from the start of the leg (it used to be
 *     the ceiling for any hull without a measured thrust split), and
 *  2. a leg length that is long enough for a full-speed burn being throttled
 *     down by a braking formula fed the wrong distance.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_CLIMB_MPS,
  UNKNOWN_HULL_BRAKE_MPS2,
  computeLegProfile,
  shouldResendMove,
  type FlightHardware,
} from '../src/demo/flight.js';
import {
  DEFAULT_SPEED_LIMIT_MPS,
  HARD_CAP_10M_MPS,
  HARD_CAP_100M_MPS,
  MAX_AUTOPILOT_SPEED_MPS,
  safeApproachSpeedMps,
  flightGuardVerdict,
} from '../src/demo/safety.js';

const ORIGIN = { x: 0, y: 0, z: 0 };
const at = (z: number) => ({ x: 0, y: 0, z });

/**
 * Realistic mid-size hull: 37.6 t (the live SAT-R-0002 mass) with a 400 kN ion
 * bank — 10.6 m/s² in vacuum, i.e. a hull that needs ~470 m to stop from 100.
 */
const ION_SHIP: FlightHardware = {
  massKg: 37_609,
  thrustN: { atmo: 0, ion: 400_000, h2: 0 },
  powerMW: { atmo: 0, ion: 5, h2: 0 },
  h2Fraction: 0,
  batteryFraction: 1,
};
const ION_ACCEL = 400_000 / 37_609; // 10.64 m/s²

/** Analytic cruise for a leg, exactly as the profile is specified. */
const expectedCruise = (distanceM: number, cap: number, accel = ION_ACCEL, margin = 50) =>
  Math.max(1, Math.min(cap, Math.sqrt(2 * accel * Math.max(0, distanceM - margin))));

describe('cruise speed on a long leg', () => {
  it('defaults to the SE autopilot ceiling of 100 m/s', () => {
    expect(DEFAULT_SPEED_LIMIT_MPS).toBe(100);
    expect(MAX_AUTOPILOT_SPEED_MPS).toBe(100);
  });

  it('commands the cap — not the 5 m/s arrival cap — on a 5 km vacuum leg', () => {
    const p = computeLegProfile(ION_SHIP, ORIGIN, at(5_000), {
      maxCruiseMps: DEFAULT_SPEED_LIMIT_MPS,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    // The crawl regression: 5–6 m/s here is the bug.
    expect(p.vCruiseMps).toBe(100);
    expect(p.vCruiseMps).toBeGreaterThan(HARD_CAP_100M_MPS);
    expect(p.accelMps2).toBeCloseTo(10.64, 2);
    // 100² / (2 * 10.64) = 470 m of brake, held back from the waypoint.
    expect(p.brakeStartDistM).toBe(470);
    expect(p.dampeners).toBe('off');
  });

  it('tapers only near the waypoint, not from the start of the leg', () => {
    const cruise = (d: number) =>
      computeLegProfile(ION_SHIP, ORIGIN, at(d), {
        maxCruiseMps: 100,
        gravityMps2: 0,
        hasAtmosphere: false,
      }).vCruiseMps;
    // Full speed for the whole cruise phase: a 1 km leg still allows 100.
    expect(cruise(1_000)).toBe(100);
    // Inside the brake distance the speed follows sqrt(2a(d - margin)) — the
    // 5 m/s arrival cap must NOT be in force at 120 m.
    expect(cruise(500)).toBeGreaterThan(60);
    expect(cruise(120)).toBeCloseTo(expectedCruise(120, 100), 1);
    expect(cruise(120)).toBeGreaterThan(HARD_CAP_100M_MPS);
  });

  it('yields the braking-limited value, not the cap, on a leg too short for full speed', () => {
    const short = computeLegProfile(ION_SHIP, ORIGIN, at(200), {
      maxCruiseMps: 100,
      gravityMps2: 0,
      hasAtmosphere: false,
    });
    // sqrt(2 * 10.64 * 150) = 56.5 m/s
    expect(short.vCruiseMps).toBeCloseTo(56.5, 1);
    expect(short.vCruiseMps).toBeLessThan(100);
    expect(short.brakeStartDistM).toBe(150);
  });

  it('derives an unmeasured hull cruise from the fallback thrust, not the 5 m/s cap', () => {
    // What the executor feeds a hull with no staging profile: 3x weight of
    // atmospheric thrust (net 2 g) instead of a hard-coded 5 m/s ceiling.
    const g = 9.81;
    const fallback: FlightHardware = {
      massKg: 37_609,
      thrustN: { atmo: 37_609 * g * 3, ion: 0, h2: 0 },
      h2Fraction: 0,
      batteryFraction: 1,
    };
    const long = computeLegProfile(fallback, ORIGIN, at(5_000), {
      maxCruiseMps: 100,
      gravityMps2: g,
      hasAtmosphere: true,
    });
    expect(long.vCruiseMps).toBe(100);
    expect(long.vCruiseMps).toBeGreaterThan(HARD_CAP_100M_MPS);

    const short = computeLegProfile(fallback, ORIGIN, at(120), {
      maxCruiseMps: 100,
      gravityMps2: g,
      hasAtmosphere: true,
    });
    expect(short.vCruiseMps).toBeCloseTo(Math.sqrt(2 * (2 * g) * 70), 0);
    expect(short.vCruiseMps).toBeLessThan(100);

    // The no-profile move fallback uses the conservative 2 m/s² assumption and
    // must not pin a long leg either.
    expect(safeApproachSpeedMps(5_000, UNKNOWN_HULL_BRAKE_MPS2, 100)).toBe(100);
    expect(safeApproachSpeedMps(500, UNKNOWN_HULL_BRAKE_MPS2, 100)).toBeGreaterThan(5);
  });

  it('keeps the atmospheric 30 m/s climb floor and dampeners on', () => {
    const atmo: FlightHardware = {
      ...ION_SHIP,
      thrustN: { atmo: 1_200_000, ion: 0, h2: 0 },
      powerMW: { atmo: 6, ion: 0, h2: 0 },
    };
    const climb = computeLegProfile(atmo, { x: 0, y: 60_000, z: 0 }, { x: 0, y: 60_040, z: 0 }, {
      maxCruiseMps: 100,
      gravityMps2: 9.81,
      hasAtmosphere: true,
      altitudeAglM: 2_000,
      targetAglM: 4_000,
    });
    expect(climb.climbFloorMps).toBe(MIN_CLIMB_MPS);
    expect(climb.vCruiseMps).toBeGreaterThanOrEqual(30);
    expect(climb.dampeners).toBe('on');
  });
});

describe('guard taper (arrival caps fire only inside 100 m / 10 m)', () => {
  const guard = (distanceM: number) =>
    flightGuardVerdict({
      distanceM,
      speedMps: 100,
      massKg: 37_609,
      thrustN: { atmo: 0, ion: 400_000, h2: 0 },
      // h2Pct only satisfies the vacuum reserve guard; thrustN.h2 is 0.
      h2Pct: 50,
      gravityMps2: 0,
      hasAtmosphere: false,
      speedLimitMps: 100,
      plannedSpeedMps: 100,
      verticalSpeedMps: 0,
      altitudeAglM: 40_000,
      targetAglM: 40_000,
      batteryPct: 100,
    });

  it('allows the cap on a long leg and keeps tapering only near the slot', () => {
    expect(guard(5_000).targetSpeedMps).toBe(100);
    expect(guard(5_000).code).toBe('ok');
    expect(guard(1_000).targetSpeedMps).toBeGreaterThan(HARD_CAP_100M_MPS);
    expect(guard(100.1).targetSpeedMps).toBeGreaterThan(HARD_CAP_100M_MPS);
  });

  it('applies 5 m/s at 100 m and 1 m/s at 10 m', () => {
    expect(safeApproachSpeedMps(100, ION_ACCEL, 100)).toBe(HARD_CAP_100M_MPS);
    expect(safeApproachSpeedMps(50, ION_ACCEL, 100)).toBe(HARD_CAP_100M_MPS);
    expect(safeApproachSpeedMps(10, ION_ACCEL, 100)).toBe(HARD_CAP_10M_MPS);
    expect(guard(100).targetSpeedMps).toBe(HARD_CAP_100M_MPS);
    expect(guard(10).targetSpeedMps).toBe(HARD_CAP_10M_MPS);
  });
});

describe('one move order per leg', () => {
  it('does not re-send while the cruise is unchanged', () => {
    expect(shouldResendMove(100, 100, false)).toBe(false);
    // 18 % slower is still inside the 20 % band: no new order.
    expect(shouldResendMove(100, 82, false)).toBe(false);
    // A real guard throttle does re-send.
    expect(shouldResendMove(100, 60, false)).toBe(true);
    expect(shouldResendMove(100, 100, true)).toBe(true);
  });
});

describe('leg distance -> commanded cruise (37.6 t, 400 kN ion, cap 100)', () => {
  it('matches the analytic braking profile over the whole distance range', () => {
    const table = [5_000, 2_000, 1_000, 500, 300, 200, 120, 100, 50, 10].map((distanceM) => ({
      distanceM,
      vCruiseMps: computeLegProfile(ION_SHIP, ORIGIN, at(distanceM), {
        maxCruiseMps: 100,
        gravityMps2: 0,
        hasAtmosphere: false,
      }).vCruiseMps,
    }));
    for (const row of table) {
      expect(row.vCruiseMps).toBeCloseTo(expectedCruise(row.distanceM, 100), 1);
      expect(row.vCruiseMps).toBeGreaterThanOrEqual(1);
    }
    // Monotonic: closer legs are never faster.
    for (let i = 1; i < table.length; i += 1) {
      expect(table[i]!.vCruiseMps).toBeLessThanOrEqual(table[i - 1]!.vCruiseMps);
    }
    expect(table[0]!.vCruiseMps).toBe(100);
  });
});
