/**
 * Landing fixes after the first REAL landing (SAT-R-0001, 2026-11-10).
 *
 * The in-game run measured four defects, and each test here reproduces the
 * measured numbers rather than a happy path:
 *
 *  1. the "fall capped at 48 m/s" was text only: nothing limited the speed,
 *     the hull free-fell to -104.4 m/s, the brake fired at 427 m while doing
 *     -104.4 (sized for 44 m/s) and `demo_landing_brake_done` fired on
 *     ALTITUDE (99 m AGL) while still doing -58.7 m/s;
 *  2. the approach targeted the FLARE altitude, so the ship settled at ~78 m,
 *     v = 0.00, and `demo_landing_touchdown` / `demo_landing_approach` never
 *     produced a row;
 *  3. with 2 s telemetry and a 1 s tick the per-tick closing rate alternated
 *     0.0 / 3.0 m/s, so the 20 s "under 2 m/s" crawl dwell never held;
 *  4. a purely vertical climb crawled (256 m at 1.5 m/s average, 10.9 m/s
 *     peak) where a diagonal on the same hull flew at 99.9 m/s.
 */
import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_CRAWL_CLOSING_MPS,
  ARRIVAL_SAMPLE_WINDOW_MS,
  CLIMB_MAX_ELEVATION_DEG,
  CLIMB_STEP_RISE_M,
  LANDING_APPROACH_TARGET_AGL_M,
  LANDING_FINAL_DESCENT_AGL_M,
  LANDING_LIVE_BRAKE_MARGIN,
  climbLadder,
  landingApproachSpeedMps,
  landingBrakeAglM,
} from '../src/demo/flight.js';
import {
  TRUE_GROUND_M,
  ackAll,
  answerInspect,
  audit,
  dampenerWrites,
  moves,
  orders,
  setup,
  actionOf,
} from './landing-support.js';

/** ~1.0 local g on the measured hull: 983 kN of lift on 37.6 t. */
const SAT_LIFT_N = 982_956;

interface LandingCtx {
  ctx: ReturnType<typeof setup>;
  plan: {
    flareAglM: number;
    brakeStopAglM: number;
    brakeShedMps2: number;
    approachMps: number;
    maxFallMps: number;
    entryDescentMps: number;
    stopDistanceM: number;
  };
  radius: number;
  vDown: number;
}

/** Start the landing, answer the lift measurement, and return the flare plan. */
function startLanding(): LandingCtx {
  const ctx = setup({
    slotRadiusM: TRUE_GROUND_M + 3_000,
    startRadiusM: TRUE_GROUND_M + 3_000,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
  });
  ctx.executor.tick(); // sends the lift measurement
  answerInspect(ctx, SAT_LIFT_N);
  ctx.executor.tick(); // plans the flare
  const flare = audit(ctx.store, 'demo_landing_flare');
  expect(flare, 'the landing must plan a flare').toHaveLength(1);
  const plan = flare[0]!.detail as LandingCtx['plan'];
  return { ctx, plan, radius: TRUE_GROUND_M + 3_000, vDown: 0 };
}

/**
 * Free fall exactly as measured: dampeners off, nothing limiting the speed,
 * and telemetry that only lands every 2 s (so the executor's picture is up to
 * two seconds and ~200 m behind the ship).
 */
function fallUntilBrake(state: LandingCtx): { peakMps: number; brake: Record<string, unknown> | null } {
  let peakMps = 0;
  for (let i = 0; i < 400; i += 1) {
    state.ctx.clock.now += 1_000;
    state.vDown += 9.81;
    state.radius -= state.vDown;
    peakMps = Math.max(peakMps, state.vDown);
    if (i % 2 === 1) state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    const brake = audit(state.ctx.store, 'demo_landing_brake');
    if (brake.length > 0) return { peakMps, brake: brake[0]!.detail as Record<string, unknown> };
  }
  return { peakMps, brake: null };
}

/** The dampened brake: shed to the approach speed, then descend at it. */
function brakeUntilDone(state: LandingCtx): Record<string, unknown> | null {
  for (let i = 0; i < 8_000; i += 1) {
    const dt = 0.5;
    state.ctx.clock.now += dt * 1_000;
    state.vDown = Math.max(state.plan.approachMps, state.vDown - state.plan.brakeShedMps2 * dt);
    state.radius -= state.vDown * dt;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    const done = audit(state.ctx.store, 'demo_landing_brake_done');
    if (done.length > 0) return done[0]!.detail as Record<string, unknown>;
  }
  return null;
}

/** The approach: 5 m/s to 15 m, 1 m/s below, contact pins the hull at rest. */
function approachUntilTouchdown(state: LandingCtx): void {
  for (let i = 0; i < 4_000; i += 1) {
    const dt = 0.5;
    state.ctx.clock.now += dt * 1_000;
    const agl = state.radius - TRUE_GROUND_M;
    state.vDown = landingApproachSpeedMps(agl);
    state.radius -= state.vDown * dt;
    if (state.radius <= TRUE_GROUND_M + 0.1) {
      state.radius = TRUE_GROUND_M + 0.1;
      state.vDown = 0;
    }
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    if (audit(state.ctx.store, 'demo_touchdown').length > 0) return;
  }
}

describe('landing after the first real run: the fall and the brake', () => {
  it('(a) a 104+ m/s free fall brakes from live speed and reaches the flare at <= 5 m/s', () => {
    const state = startLanding();
    const { peakMps, brake } = fallUntilBrake(state);
    expect(brake, 'the live brake must fire').not.toBeNull();

    // BUG 1 reproduced: the plan said 48 m/s, nothing limited the speed, and
    // the hull really did pass the measured 104.4 m/s. (The cap itself now
    // scales with the 150 m handover height instead of the old 100 m flare, so
    // it is ~71 m/s here — still far below what the hull actually reached.)
    expect(state.plan.maxFallMps).toBeLessThan(80);
    expect(peakMps).toBeGreaterThan(104);

    const alt = Number(brake!.altitudeAglM);
    const v = Math.abs(Number(brake!.verticalSpeedMps));
    const period = Number(brake!.telemetryPeriodS);
    const live = landingBrakeAglM({
      verticalSpeedMps: v,
      brakeDecelMps2: state.plan.brakeShedMps2,
      flareAglM: Number(brake!.flareAglM),
      telemetryPeriodS: period,
    });
    // The brake fired where the LIVE formula says, not at 427 m doing 104 m/s.
    // At the sample that trips it the ship is already inside the 1.5× envelope
    // (the two-second cadence spends part of the margin before the decision),
    // but it must still be able to stop above the ground at that speed.
    const physicalStopM = (v * v) / (2 * state.plan.brakeShedMps2) + Number(brake!.flareAglM);
    expect(alt, 'the brake must fire while the ship can still stop above the ground').toBeGreaterThan(physicalStopM);
    // Far above the 427 m the first real run braked at: at 104 m/s and the
    // hull's own measured shed (planned 10 m/s² here) the live formula wants
    // >1 km, so the burn is decided from the speed, not the old constant.
    expect(alt).toBeGreaterThan(1_000);
    expect(Math.abs(Number(brake!.liveBrakeAglM) - live)).toBeLessThan(3);
    // ...and it was a live-speed brake, not the planned 44 m/s one.
    expect(v).toBeGreaterThan(100);
    expect(period).toBeGreaterThanOrEqual(1.9);

    const done = brakeUntilDone(state);
    expect(done, 'the brake must finish at the flare').not.toBeNull();
    expect(Number(done!.altitudeAglM)).toBeLessThanOrEqual(state.plan.flareAglM + 2);
    expect(Math.abs(Number(done!.verticalSpeedMps))).toBeLessThanOrEqual(5);
    expect(LANDING_LIVE_BRAKE_MARGIN).toBe(1.5);
  });

  it('(b) brake_done never fires at 99 m doing 58.7 m/s', () => {
    const state = startLanding();
    // The measured state at the bogus handover: 99 m AGL, -58.7 m/s.
    state.radius = TRUE_GROUND_M + 99;
    state.vDown = 58.7;
    state.ctx.clock.now += 1_000;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    expect(audit(state.ctx.store, 'demo_landing_brake'), 'the live brake fires at 99 m doing 58.7').toHaveLength(1);

    // Next tick: still at the flare altitude, still far too fast.
    state.ctx.clock.now += 1_000;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    expect(audit(state.ctx.store, 'demo_landing_brake_done'), 'altitude alone must never end the brake').toHaveLength(0);

    // Past the 30 s brake window it still does not hand over; it says so.
    state.ctx.clock.now += 31_000;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    const held = audit(state.ctx.store, 'demo_landing_brake_held');
    expect(held, 'a still-fast ship keeps braking and records why').toHaveLength(1);
    expect(Number((held[0]!.detail as { verticalSpeedMps: number }).verticalSpeedMps)).toBeCloseTo(-58.7, 1);
    expect(String((held[0]!.detail as { note?: string }).note)).toMatch(/the final descent is NOT started/);
    expect(audit(state.ctx.store, 'demo_landing_brake_done')).toHaveLength(0);

    // Once it IS slow at the flare, the handover happens.
    state.ctx.clock.now += 1_000;
    state.vDown = 4;
    state.ctx.place(state.radius, -state.vDown);
    state.ctx.executor.tick();
    ackAll(state.ctx);
    const done = audit(state.ctx.store, 'demo_landing_brake_done');
    expect(done).toHaveLength(1);
    expect(Number((done[0]!.detail as { verticalSpeedMps: number }).verticalSpeedMps)).toBeCloseTo(-4, 1);
    expect(Number((done[0]!.detail as { altitudeAglM: number }).altitudeAglM)).toBeLessThanOrEqual(102);
  });
});

describe('landing after the first real run: the approach', () => {
  it('(c) the approach targets the GROUND, descends from the flare and touches down with no gear', () => {
    const state = startLanding();
    fallUntilBrake(state);
    const done = brakeUntilDone(state);
    expect(done, 'the brake must finish before the approach').not.toBeNull();

    // BUG 2 reproduced: the approach used to target the 100 m flare. It now
    // targets the true ground + 1 m.
    const start = audit(state.ctx.store, 'demo_landing_approach_start');
    expect(start).toHaveLength(1);
    const startDetail = start[0]!.detail as { targetAglM: number; target: { z: number }; speedMps: number };
    expect(startDetail.targetAglM).toBe(LANDING_APPROACH_TARGET_AGL_M);
    expect(startDetail.target.z).toBeCloseTo(TRUE_GROUND_M + LANDING_APPROACH_TARGET_AGL_M, 0);
    expect(startDetail.speedMps).toBe(5);

    const fromAgl = state.radius - TRUE_GROUND_M;
    expect(fromAgl).toBeLessThanOrEqual(state.plan.flareAglM + 2);

    approachUntilTouchdown(state);

    const touchdown = audit(state.ctx.store, 'demo_touchdown');
    expect(touchdown, 'the approach must reach the ground').toHaveLength(1);
    const td = touchdown[0]!.detail as {
      altitudeAglM: number;
      verticalSpeedMps: number;
      gearPresent?: boolean;
      groundSource?: string;
    };
    expect(td.altitudeAglM).toBeLessThanOrEqual(3);
    expect(Math.abs(td.verticalSpeedMps)).toBeLessThanOrEqual(0.5);
    // No gear on this hull, and it still completed as a ship.
    expect(td.gearPresent).toBe(false);
    expect(td.groundSource).toBe('terrain');
    expect(state.ctx.droneRow().state).toBe('holding');
    expect(state.ctx.droneRow().step).toBe('landed');
    expect(String(state.ctx.droneRow().reason)).toMatch(/no landing gear or connectors/);
    expect(state.ctx.sent.filter((m) => actionOf(m) === 'convert_to_station')).toHaveLength(0);
    state.ctx.executor.tick();
    expect(state.ctx.store.getMission(state.ctx.mission.id)?.status).toBe('done');

    // The final descent never commands a waypoint under the ship. Measured
    // 2026-11-10 the autopilot climbs AWAY from such a point (1.1-1.2 m/s),
    // which is why the old approach stalled at 26-27 m; the last phase is
    // autopilot OFF + dampener pulses instead.
    const underGroundMoves = moves(state.ctx.sent).filter(
      (m) => typeof (m.params as { z?: number }).z === 'number' && (m.params as { z: number }).z < TRUE_GROUND_M,
    );
    expect(underGroundMoves, 'no waypoint may be sent to the ground point').toHaveLength(0);
    // Every dampener pulse that did fire records the mechanism (none is needed
    // when the hull is already sinking inside its band, as this kinematic walk
    // down is).
    for (const pulse of audit(state.ctx.store, 'demo_landing_pulse')) {
      expect((pulse.detail as { note?: string }).note).toMatch(/no waypoint, autopilot off/);
    }
    expect(dampenerWrites(state.ctx.sent).at(-1)).toBe(true);
  });

  it('(d) a stalled approach aborts within 15 s with a plain reason instead of hovering', () => {
    const state = startLanding();
    fallUntilBrake(state);
    expect(brakeUntilDone(state), 'the brake must finish before the approach').not.toBeNull();

    // The measured hover: 60 m AGL, v = 0.00, forever.
    const heldRadius = TRUE_GROUND_M + 60;
    let stalledAtS: number | null = null;
    for (let i = 1; i <= 40; i += 1) {
      state.ctx.clock.now += 1_000;
      state.ctx.place(heldRadius, 0);
      state.ctx.executor.tick();
      ackAll(state.ctx);
      if (audit(state.ctx.store, 'demo_landing_stalled').length > 0) {
        stalledAtS = i;
        break;
      }
    }
    expect(stalledAtS, 'the hover must be aborted, not left to a watchdog').not.toBeNull();
    expect(stalledAtS as number).toBeLessThanOrEqual(16);

    const stalled = audit(state.ctx.store, 'demo_landing_stalled')[0]!.detail as {
      altitudeAglM: number;
      stallSeconds: number;
      note: string;
    };
    expect(stalled.altitudeAglM).toBe(60);
    expect(stalled.stallSeconds).toBeGreaterThanOrEqual(15);
    expect(stalled.note).toMatch(/no downward progress/);
    const abort = audit(state.ctx.store, 'demo_flight_abort')[0]!.detail as { code: string; reason: string };
    expect(abort.code).toBe('landing-stalled');
    expect(abort.reason).toMatch(/landing approach stalled: no descent for \d+ s at 60 m AGL/);
    expect(state.ctx.droneRow().state).toBe('aborted');
  });
});

describe('landing after the first real run: telemetry cadence', () => {
  it('(e) a crawl sampled from 2 s telemetry (0/3 m/s per tick) is detected inside 30 s', () => {
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_700,
      startRadiusM: TRUE_GROUND_M + 1_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    ackAll(ctx);
    expect(Number((moves(ctx.sent)[0]!.params as { speed?: number }).speed)).toBe(100);

    // Telemetry every 2 s, tick every 1 s: the ship closes 3 m per sample.
    let radius = TRUE_GROUND_M + 1_000;
    let abortedAt = -1;
    const perTickRates: number[] = [];
    let lastSeenRemaining: number | null = null;
    for (let i = 1; i <= 40; i += 1) {
      ctx.clock.now += 1_000;
      if (i % 2 === 0) {
        radius += 3;
        ctx.place(radius, 1.5);
      }
      const remaining = Math.hypot(0, 0, TRUE_GROUND_M + 2_700 - radius);
      if (lastSeenRemaining !== null) perTickRates.push(Number((lastSeenRemaining - remaining).toFixed(1)));
      lastSeenRemaining = remaining;
      ctx.executor.tick();
      ackAll(ctx);
      if (ctx.droneRow().state === 'aborted') {
        abortedAt = i;
        break;
      }
    }
    // The defect itself: half the per-tick rates read 0.0 and half 3.0 m/s.
    expect(perTickRates.slice(0, 8)).toContain(0);
    expect(perTickRates.slice(0, 8)).toContain(3);
    expect(abortedAt, 'the crawl must be aborted inside 30 s').toBeGreaterThan(0);
    expect(abortedAt).toBeLessThan(30);

    const crawl = audit(ctx.store, 'demo_arrival_crawl');
    expect(crawl, 'the crawl must be recorded with its numbers').toHaveLength(1);
    const detail = crawl[0]!.detail as {
      commandedSpeedMps: number;
      achievedSpeedMps: number;
      closingRateMps: number;
      crawlSeconds: number;
      remainingM: number;
    };
    expect(detail.commandedSpeedMps).toBe(100);
    expect(detail.achievedSpeedMps).toBeCloseTo(1.5, 1);
    expect(detail.closingRateMps).toBeCloseTo(1.5, 1);
    expect(detail.crawlSeconds).toBeCloseTo(ARRIVAL_SAMPLE_WINDOW_MS / 1_000, 0);
    expect(detail.remainingM).toBeGreaterThan(1_600);
    expect(detail.closingRateMps).toBeLessThan(ARRIVAL_CRAWL_CLOSING_MPS);
    expect((audit(ctx.store, 'demo_flight_abort')[0]!.detail as { code: string }).code).toBe('hull-crawl');
  });
});

describe('landing after the first real run: near-vertical legs', () => {
  it('(f) a near-vertical climb is flown as a ladder, never straight up', () => {
    // Measured 2026-11-10: one 1 672 m waypoint straight up peaked at 37.6 m/s
    // and decayed; the same hull held 99.9 m/s on a diagonal leg and 20 m/s on
    // a horizontal one. The dogleg only displaced the first 120 m, leaving
    // 1 552 m at 85.6 deg, so the whole leg is now split.
    const up = { x: 0, y: 0, z: 1 };
    const from = { x: 0, y: 0, z: 1_000 };
    const to = { x: 0, y: 0, z: 2_672 };
    const ladder = climbLadder(from, to, up);
    expect(ladder, 'a 1 672 m vertical climb needs a ladder').not.toBeNull();
    expect(ladder!.waypoints.length).toBeGreaterThan(1);
    // Every leg, including the first from the ship and the last to the real
    // target, is at or under the 60 deg ceiling.
    expect(ladder!.maxElevationDeg).toBeLessThanOrEqual(CLIMB_MAX_ELEVATION_DEG + 0.01);
    expect(ladder!.maxElevationDeg).toBeGreaterThan(CLIMB_MAX_ELEVATION_DEG - 1);
    for (const leg of ladder!.legs) expect(leg.elevationDeg).toBeLessThanOrEqual(CLIMB_MAX_ELEVATION_DEG + 0.01);
    // The last waypoint IS the leg's own target.
    expect(ladder!.waypoints.at(-1)).toEqual(to);
    // Monotonic rise, alternating sides, and never further than one step's
    // lateral offset from the column (a landing must stay over its slot).
    let prevRise = 0;
    let lastSign = 0;
    const sides = ladder!.waypoints.slice(0, -1).map((p) => Math.sign(p.x));
    for (const point of ladder!.waypoints.slice(0, -1)) {
      expect(point.z).toBeGreaterThan(prevRise + from.z - 1);
      prevRise = point.z - from.z;
      expect(Math.abs(point.x)).toBeLessThanOrEqual(CLIMB_STEP_RISE_M + 1);
    }
    for (const sign of sides) {
      expect(sign).not.toBe(0);
      expect(sign).not.toBe(lastSign);
      lastSign = sign;
    }
    expect(new Set(sides).size).toBe(2);
    // A diagonal leg is already flyable, and so is a short hop.
    expect(climbLadder(from, { x: 3_500, y: 0, z: 3_800 }, up)).toBeNull();
    expect(climbLadder(from, { x: 0.5, y: 0, z: 1_050 }, up)).toBeNull();
    expect(climbLadder(from, { x: 0, y: 0, z: 2_000 }, up, { stepRiseM: 100 })!.waypoints.length).toBeGreaterThan(
      ladder!.waypoints.length,
    );

    // Flown: the first move is the first ladder waypoint, and reaching it sends
    // the next one instead of the slot.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_700,
      startRadiusM: TRUE_GROUND_M + 1_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    ackAll(ctx);
    const ladderAudit = audit(ctx.store, 'demo_leg_climb_ladder');
    expect(ladderAudit, 'the near-vertical leg must record its ladder').toHaveLength(1);
    const ladderDetail = ladderAudit[0]!.detail as {
      maxElevationDeg: number;
      steps: number;
      first: { x: number; y: number; z: number };
    };
    expect(ladderDetail.maxElevationDeg).toBeLessThanOrEqual(CLIMB_MAX_ELEVATION_DEG + 0.01);
    expect(ladderDetail.steps).toBeGreaterThan(1);
    const firstMove = moves(ctx.sent)[0]!.params as { x: number; y: number; z: number; speed: number };
    expect(firstMove.z).toBeGreaterThan(TRUE_GROUND_M + 1_000);
    expect(firstMove.z).toBeLessThan(TRUE_GROUND_M + 2_700);
    expect(Math.abs(firstMove.x)).toBeGreaterThan(0);
    expect(firstMove.speed).toBe(100);

    // Standing on ladder waypoint 1 sends waypoint 2, on the other side.
    ctx.clock.now += 1_000;
    ctx.store.upsertUnit({
      id: 'grid:land',
      name: 'LAND-01',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: ctx.clock.now,
      pos: ladderDetail.first,
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
    });
    ctx.executor.tick();
    ackAll(ctx);
    const steps = audit(ctx.store, 'demo_leg_climb_step');
    expect(steps, 'reaching a ladder waypoint must send the next one').toHaveLength(1);
    const step = steps[0]!.detail as { step: number; of: number; elevationDeg: number; target: { x: number } };
    expect(step.step).toBe(2);
    expect(step.elevationDeg).toBeLessThanOrEqual(CLIMB_MAX_ELEVATION_DEG + 0.01);
    expect(Math.sign(step.target.x)).toBe(-Math.sign(ladderDetail.first.x));
    const lastMove = moves(ctx.sent).at(-1)!.params as { x: number; y: number; z: number };
    expect(lastMove.z).toBeGreaterThan(ladderDetail.first.z);
    expect(lastMove.z).toBeLessThan(TRUE_GROUND_M + 2_700);
  });
});
