/**
 * Landing mode (owner request, 2026-11-10): "have a ship actually land on the
 * ground, going as fast as possible then slowing down to land, based on how
 * heavy it is; tell it to go to XYZ and park".
 *
 * Phases under test:
 *   (a) controlled fall at up to the cruise cap, dampeners off;
 *   (b) brake burn timed so the ship STOPS at a flare above the TRUE ground,
 *       planned from measured up-thrust / mass - g, so a heavier hull brakes
 *       higher up than a light one with the same thrust;
 *   (c) dampened final descent: <= 5 m/s to 15 m, <= 1 m/s below;
 *   (d) touchdown on true AGL + vertical speed, gear locked, STAYS a ship.
 *
 * A landing on a ground that is only the catalogue mean is REFUSED with a plain
 * reason (SAT-R-0002 was destroyed exactly that way) and the dampened slow
 * descent is offered instead. A `park` on an airborne point holds there and
 * says which; a descent that settles 19 m above its slot completes; and a hull
 * that crawls a climb at ~1.5 m/s is aborted as `hull-crawl` within 30 s.
 */
import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_CRAWL_CLOSING_MPS,
  ARRIVAL_CRAWL_GRACE_MS,
  ARRIVAL_CRAWL_MS,
  GROUND_CLEARANCE_M,
  LANDING_APPROACH_DESCENT_MPS,
  LANDING_FINAL_DESCENT_AGL_M,
  LANDING_FINAL_DESCENT_MPS,
  LANDING_FLARE_AGL_M,
  LANDING_HANDOVER_AGL_M,
  LANDING_MIN_BRAKE_AGL_M,
  LANDING_MIN_BRAKE_MPS2,
  LANDING_MIN_BRAKE_DROP_M,
  LANDING_CONTACT_MPS,
  LANDING_SHED_DECEL_MPS2,
  LANDING_SHED_MAX_MPS2,
  LANDING_TOUCHDOWN_AGL_M,
  LANDING_TOUCHDOWN_MPS,
  computeLandingProfile,
  landingApproachSpeedMps,
  readLandingIntent,
} from '../src/demo/flight.js';
import {
  PLANET,
  SURFACE,
  TRUE_GROUND_M,
  ackAll,
  answerInspect,
  audit,
  dampenerWrites,
  gearWrites,
  moves,
  orders,
  setup,
  actionOf,
} from './landing-support.js';

/** ~1.0 local g on the measured hull: 983 kN of lift on 37.6 t. */
const SAT_LIFT_N = 982_956;

describe('landing mode: the plan (pure maths)', () => {
  it('brakes a heavier hull higher up for the same thrust, and both stop at the flare', () => {
    // The fall is capped at the same 30 m/s for both hulls: the comparison is
    // "same thrust, same entry speed, different mass", so the only difference
    // in the brake point is the hull's own authority. (With a 100 m/s cruise
    // cap the light hull's 39 m/s² authority reaches the flare faster than the
    // heavy one, and that entry speed masks the mass effect.)
    const base = {
      measuredUpThrustN: SAT_LIFT_N,
      measuredAtAglM: 3_000,
      verticalSpeedMps: 0,
      planet: PLANET,
      maxCruiseMps: 30,
      groundUncertaintyM: 0,
    };
    const light = computeLandingProfile({ ...base, massKg: 20_000 });
    const heavy = computeLandingProfile({ ...base, massKg: 72_000 });
    expect(light.ok).toBe(true);
    expect(heavy.ok).toBe(true);
    // Light: 983 kN - 20 t·g = 786 kN → 39 m/s² of authority, planned at 70 %
    // of it and bounded by LANDING_SHED_MAX_MPS2 (10), NOT the old blanket 4.
    expect(light.brakeShedMps2).toBe(LANDING_SHED_MAX_MPS2);
    // Heavy: 983 kN - 72 t·g = 276 kN → 3.8 m/s²; 70 % of that is 2.7 and its
    // own thrust is the limit, so it must brake from higher up.
    expect(heavy.brakeShedMps2).toBeGreaterThan(LANDING_MIN_BRAKE_MPS2);
    expect(heavy.brakeShedMps2).toBeLessThan(LANDING_SHED_DECEL_MPS2);
    // Both fall at the same capped speed, so the heavy hull (slower shed) needs
    // more height and must start braking HIGHER.
    expect(light.entryDescentMps).toBe(30);
    expect(heavy.entryDescentMps).toBe(30);
    expect(heavy.stopDistanceM).toBeGreaterThan(light.stopDistanceM);
    expect(heavy.brakeStopAglM).toBeGreaterThan(light.brakeStopAglM);
    // Both plan to stop at the same HANDOVER height above the true ground: the
    // backend owns fall + brake down to it, and the final descent (dampener
    // pulses today, a plugin `land_controller` later) owns everything below it.
    expect(light.flareAglM).toBe(LANDING_HANDOVER_AGL_M);
    expect(heavy.flareAglM).toBe(LANDING_HANDOVER_AGL_M);
    expect(light.flareAglM).toBeGreaterThanOrEqual(LANDING_MIN_BRAKE_AGL_M);
    expect(light.flareAglM).toBeGreaterThanOrEqual(LANDING_FLARE_AGL_M);
    expect(light.brakeStopAglM).toBeGreaterThanOrEqual(LANDING_MIN_BRAKE_AGL_M);
    expect(heavy.brakeStopAglM).toBeGreaterThanOrEqual(LANDING_MIN_BRAKE_AGL_M);
    // A fall speed cap exists for both (they are not asked to fall at 100
    // m/s into a 40 m flare).
    expect(light.maxFallMps).toBeLessThan(100);
    expect(heavy.maxFallMps).toBeLessThan(100);
  });

  it('refuses a landing on an unknown (mean) ground with a plain reason', () => {
    const plan = computeLandingProfile({
      massKg: 37_609,
      measuredUpThrustN: SAT_LIFT_N,
      measuredAtAglM: 3_000,
      verticalSpeedMps: 0,
      planet: PLANET,
      maxCruiseMps: 100,
      groundUncertaintyM: 7_800,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/ground height at this column is unknown/);
    expect(plan.reason).toMatch(/catalogue mean radius/);
    expect(plan.reason).toMatch(/dampened slow descent instead/);
    expect(plan.maxFallMps).toBe(0);
  });

  it('reads the landing request from the words an operator would use', () => {
    expect(readLandingIntent({ land: true })).toEqual({ kind: 'land', flareAglM: LANDING_FLARE_AGL_M });
    expect(readLandingIntent({ mode: 'land' })).toEqual({ kind: 'land', flareAglM: LANDING_FLARE_AGL_M });
    expect(readLandingIntent({ landing: { flareAglM: 120 } })?.flareAglM).toBe(120);
    expect(readLandingIntent({ landing: {} })).toEqual({ kind: 'land', flareAglM: LANDING_FLARE_AGL_M });
    // "0 m" is NOT a landing: an operator has to ask for one.
    expect(readLandingIntent({ altitudeM: 0 })).toBeNull();
    expect(readLandingIntent({ mode: 'hold' })).toBeNull();
    expect(readLandingIntent(null)).toBeNull();
    // park is the softer request: stop at the point, land only if it is ground.
    expect(readLandingIntent({ park: true })).toEqual({ kind: 'park', flareAglM: LANDING_FLARE_AGL_M });
    expect(readLandingIntent({ mode: 'park' })?.kind).toBe('park');
    // An explicit land wins over park (a landing is park-on-the-ground).
    expect(readLandingIntent({ land: true, park: true })?.kind).toBe('land');
  });

  it('pins the descent speeds of phase (c) and the falling-clearance floor', () => {
    expect(landingApproachSpeedMps(40)).toBe(LANDING_APPROACH_DESCENT_MPS);
    expect(landingApproachSpeedMps(LANDING_FINAL_DESCENT_AGL_M)).toBe(LANDING_FINAL_DESCENT_MPS);
    expect(landingApproachSpeedMps(3)).toBe(LANDING_FINAL_DESCENT_MPS);
    expect(LANDING_MIN_BRAKE_AGL_M).toBe(GROUND_CLEARANCE_M);
    expect(LANDING_APPROACH_DESCENT_MPS).toBe(5);
    expect(LANDING_FINAL_DESCENT_MPS).toBe(0.4);
    // Touchdown is measured on the HULL BOTTOM, and the final descent is slower
    // than the touchdown threshold so the strict rule is what fires.
    expect(LANDING_TOUCHDOWN_AGL_M).toBe(2);
    expect(LANDING_TOUCHDOWN_MPS).toBe(0.5);
    expect(LANDING_FINAL_DESCENT_MPS).toBeLessThan(LANDING_TOUCHDOWN_MPS);
    // A hull that is on the ground but still settling is also down.
    expect(LANDING_CONTACT_MPS).toBeGreaterThan(LANDING_TOUCHDOWN_MPS);
    expect(LANDING_CONTACT_MPS).toBeLessThanOrEqual(1);
    expect(LANDING_MIN_BRAKE_DROP_M).toBeGreaterThan(LANDING_FLARE_AGL_M);
  });

  it('pins the crawl guard to the measured numbers: a 1.5 m/s close is crawling', () => {
    // The measured climb: 100 m/s commanded, ~1.5 m/s achieved, ~1.5 m/s
    // closing, 1.7 km to go. The OLD bar (closing < 1 m/s) never armed.
    expect(ARRIVAL_CRAWL_CLOSING_MPS).toBe(2);
    expect(1.5).toBeLessThan(ARRIVAL_CRAWL_CLOSING_MPS);
    // Grace + dwell is what bounds the abort: under 30 s from the leg order.
    expect(ARRIVAL_CRAWL_GRACE_MS + ARRIVAL_CRAWL_MS).toBeLessThan(30_000);
  });
});

describe('landing mode: flown on the fake hub', () => {
  it('(a) flares, brakes above 100 m of TRUE AGL and touches down; the mission completes and the gear is locked', () => {
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 3_000,
      startRadiusM: TRUE_GROUND_M + 3_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
    });
    // The drone's slot is the GROUND POINT at the true terrain radius.
    expect(JSON.parse(ctx.droneRow().exec_slot_json).z).toBeCloseTo(TRUE_GROUND_M, 0);

    ctx.executor.tick();
    const measure = audit(ctx.store, 'demo_descent_measure')[0]!.detail as { groundSource?: string; targetAglM?: number };
    expect(measure.groundSource).toBe('terrain');
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();

    const flare = audit(ctx.store, 'demo_landing_flare');
    expect(flare, 'a landing must start with its flare plan').toHaveLength(1);
    const plan = flare[0]!.detail as {
      groundSource?: string;
      flareAglM: number;
      brakeStopAglM: number;
      brakeShedMps2: number;
      maxFallMps: number;
      approachMps: number;
      entryDescentMps: number;
    };
    expect(plan.groundSource).toBe('terrain');
    expect(plan.flareAglM).toBeGreaterThanOrEqual(LANDING_FLARE_AGL_M);
    expect(plan.brakeStopAglM).toBeGreaterThanOrEqual(LANDING_MIN_BRAKE_AGL_M);
    // (a) the fall is with dampeners OFF and capped below the cruise cap.
    expect(dampenerWrites(ctx.sent).at(-1)).toBe(false);
    expect(plan.maxFallMps).toBeLessThan(100);

    // Fall: gravity with dampeners off. NOTHING limits the speed (measured
    // 2026-11-10: the "48 m/s cap" was text only and the hull free-fell past
    // 104 m/s), so the executor's live brake has to fire from the actual speed.
    // Sample every 0.25 s; the brake command must arrive before the ship is
    // under 100 m.
    let radius = TRUE_GROUND_M + 3_000;
    let vDown = 0;
    let brakeAgl: number | null = null;
    let brakeMps = 0;
    let peak = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.25;
      ctx.clock.now += dt * 1_000;
      vDown += 9.81 * dt;
      radius -= vDown * dt;
      const agl = radius - TRUE_GROUND_M;
      peak = Math.max(peak, vDown);
      ctx.place(radius, -vDown);
      ctx.executor.tick();
      ackAll(ctx);
      if (audit(ctx.store, 'demo_landing_brake').length > 0) {
        brakeAgl = agl;
        brakeMps = vDown;
        break;
      }
      expect(agl, 'the fall must never be commanded below the clearance').toBeGreaterThan(GROUND_CLEARANCE_M);
    }
    expect(brakeAgl, 'the flare brake must fire').not.toBeNull();
    expect(brakeAgl as number).toBeGreaterThan(GROUND_CLEARANCE_M);
    expect(peak).toBeGreaterThan(5); // it really goes fast first
    // The brake came from the LIVE speed, not from the plan's entry speed.
    expect(brakeMps).toBeGreaterThanOrEqual(plan.entryDescentMps);
    // Dampeners came back ON for the brake.
    const brakeWrites = dampenerWrites(ctx.sent);
    expect(brakeWrites.slice(-3)).toContain(true);

    // (b) brake: dampened stop at the hull's shed rate, then the approach speed
    // down to the flare (the brake order is a dampened move at 5 m/s, not a
    // zero-speed hold: the ship still has ~2 km to descend).
    const stopAgl = plan.brakeStopAglM;
    for (let i = 0; i < 8_000; i += 1) {
      const dt = 0.25;
      ctx.clock.now += dt * 1_000;
      // Dampeners shed vertical speed at the planned rate, then the 5 m/s
      // setpoint holds, never overshooting up.
      vDown = Math.max(plan.approachMps, vDown - plan.brakeShedMps2 * dt);
      radius -= vDown * dt;
      ctx.place(radius, -vDown);
      ctx.executor.tick();
      ackAll(ctx);
      if (audit(ctx.store, 'demo_landing_brake_done').length > 0) break;
    }
    const brakeDone = audit(ctx.store, 'demo_landing_brake_done');
    expect(brakeDone, 'the brake must finish at the flare').toHaveLength(1);
    expect(Number((brakeDone[0]!.detail as { altitudeAglM?: number }).altitudeAglM)).toBeGreaterThanOrEqual(
      plan.flareAglM - 25,
    );
    expect(Number((brakeDone[0]!.detail as { altitudeAglM?: number }).altitudeAglM)).toBeLessThanOrEqual(stopAgl + 5);
    // It reached the flare SLOW: the handover requires both altitude and speed.
    expect(Math.abs(Number((brakeDone[0]!.detail as { verticalSpeedMps?: number }).verticalSpeedMps))).toBeLessThanOrEqual(
      LANDING_APPROACH_DESCENT_MPS,
    );

    // (c) dampened final descent: place the ship at the flare, then walk it
    // down at the speeds the landing commands. 5 m/s until 15 m, 1 m/s below,
    // and the GROUND stops it (a resting ship is at 0 m/s, not still sinking:
    // with no contact model the walk-down held 1 m/s all the way into the
    // floor and the |v| <= 0.5 m/s touchdown test could never be met).
    radius = TRUE_GROUND_M + plan.flareAglM;
    vDown = 0;
    ctx.place(radius, 0);
    ctx.executor.tick();
    ackAll(ctx);
    const finalPhaseSpeeds: number[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const dt = 0.5;
      ctx.clock.now += dt * 1_000;
      const agl = radius - TRUE_GROUND_M;
      const want = landingApproachSpeedMps(agl);
      vDown = want;
      radius -= vDown * dt;
      // Contact: the terrain holds the hull, and dampeners keep it there.
      if (radius <= TRUE_GROUND_M + 0.1) {
        radius = TRUE_GROUND_M + 0.1;
        vDown = 0;
      }
      ctx.place(radius, -vDown);
      ctx.executor.tick();
      ackAll(ctx);
      if (agl <= LANDING_FINAL_DESCENT_AGL_M) finalPhaseSpeeds.push(want);
      if (audit(ctx.store, 'demo_touchdown').length > 0) break;
    }
    // The final descent commands no waypoint inside 40 m: it is flown by the
    // dampener state (autopilot off), because the autopilot will not fly a
    // point below the ship. The commands below the flare are all safety
    // orders. (Landing-mode's kinematic walk-down drives the ship itself.)
    const underFlare = moves(ctx.sent).filter((m) => {
      const z = (m.params as { z?: number }).z;
      return typeof z === 'number' && z < TRUE_GROUND_M + plan.flareAglM;
    });
    expect(underFlare, 'no waypoint may be sent below the flare').toHaveLength(0);
    expect(audit(ctx.store, 'demo_landing_pulse').length).toBeGreaterThan(0);
    const finalWrites = dampenerWrites(ctx.sent);
    expect(finalWrites.length).toBeGreaterThan(0);
    expect(finalWrites.at(-1), 'the descent ends with dampeners on (a brake)').toBe(true);
    expect(finalPhaseSpeeds.length).toBeGreaterThan(0);

    // (d) touchdown: gear locked, the grid STAYS a ship, the mission is done.
    const touchdown = audit(ctx.store, 'demo_touchdown');
    expect(touchdown, 'touchdown must complete the landing').toHaveLength(1);
    const td = touchdown[0]!.detail as { altitudeAglM: number; verticalSpeedMps: number; groundSource?: string };
    expect(td.altitudeAglM).toBeLessThanOrEqual(LANDING_TOUCHDOWN_AGL_M + 1);
    expect(Math.abs(td.verticalSpeedMps)).toBeLessThanOrEqual(LANDING_TOUCHDOWN_MPS);
    expect(td.groundSource).toBe('terrain');
    const gear = gearWrites(ctx.sent).find((w) => (w.props as { Autolock?: boolean })?.Autolock === true);
    expect(gear, 'the landing gear must be locked').toBeTruthy();
    expect((gear!.props as { Lock?: boolean }).Lock).toBe(true);
    expect((gear!.filter as { type?: unknown }).type).toEqual(['LandingGear', 'MagneticPlate']);
    // Never converted to a station.
    expect(ctx.sent.filter((m) => actionOf(m) === 'convert_to_station')).toHaveLength(0);
    expect(ctx.droneRow().state).toBe('holding');
    // The landing step is persisted on the drone row: the gear lock was sent.
    expect(ctx.droneRow().step).toBe('landed');
    ctx.executor.tick();
    expect(ctx.store.getMission(ctx.mission.id)?.status).toBe('done');
  });

  it('(e) refuses a landing on a mean-only ground, with the reason, and offers the dampened descent', () => {
    // No terrain field and no probe hit: the ground below is only the catalogue
    // mean radius. This is the ground SAT-R-0002 was destroyed on.
    const ctx = setup({
      slotRadiusM: SURFACE + 3_000,
      startRadiusM: SURFACE + 3_000,
      terrainRadiusM: null,
      desired: { land: true },
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    const measure = audit(ctx.store, 'demo_descent_measure')[0]!.detail as { groundSource?: string };
    expect(measure.groundSource).toBe('mean');
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();

    // No fall, no flare: the landing is refused before anything is flown.
    expect(audit(ctx.store, 'demo_landing_flare')).toHaveLength(0);
    expect(dampenerWrites(ctx.sent)).not.toContain(false);

    const refused = audit(ctx.store, 'demo_landing_refused');
    expect(refused, 'the refusal must be recorded').toHaveLength(1);
    const detail = refused[0]!.detail as { reason?: string; offered?: string | null; offer?: string; groundSource?: string };
    expect(detail.groundSource).toBe('mean');
    expect(String(detail.reason)).toMatch(/ground height at this column is unknown/);
    expect(String(detail.reason)).toMatch(/catalogue mean radius/);
    expect(detail.offered).toBe('dampened slow descent');
    expect(String(detail.offer)).toMatch(/dampened slow descent instead/);

    // The offer is a real flight: a dampened move at the landing approach speed
    // to a hold GROUND_CLEARANCE_M above the ground — never a fall.
    const offered = moves(ctx.sent).at(-1)!;
    expect((offered.params as { speed?: number }).speed).toBe(LANDING_APPROACH_DESCENT_MPS);
    expect((offered.params as { collisionAvoidance?: boolean }).collisionAvoidance).toBe(true);
    expect((offered.params as { z?: number }).z).toBeCloseTo(SURFACE + GROUND_CLEARANCE_M, 0);
    // The ship is still a ship, still flying, told why it is not landing.
    expect(String(ctx.droneRow().reason)).toMatch(/landing refused: .*dampened slow descent/);
    expect(audit(ctx.store, 'demo_touchdown')).toHaveLength(0);
  });

  it('(f) parks on an airborne point with no measured ground below: it holds, and says which', () => {
    const ctx = setup({
      slotRadiusM: SURFACE + 3_000,
      startRadiusM: SURFACE + 2_800,
      terrainRadiusM: null,
      desired: { park: true },
      speedLimitMps: 100,
    });
    // The park decision is recorded when the drone is seeded: held in the air,
    // not landed, and why it cannot station either.
    const park = audit(ctx.store, 'demo_park');
    expect(park, 'a park must say what it did').toHaveLength(1);
    const detail = park[0]!.detail as { decision?: string; reason?: string; altitudeAglM?: number | null };
    expect(detail.decision).toBe('hold');
    expect(String(detail.reason)).toMatch(/held in the air at the point instead of landing/);
    expect(String(detail.reason)).toMatch(/no ground is measured below it/);
    expect(String(detail.reason)).toMatch(/station mode/);
    expect(String(detail.reason)).toMatch(/so it holds/);
    expect(detail.altitudeAglM).toBeNull();

    // It flies the ordinary leg to the point: no flare, no fall, no gear lock.
    ctx.executor.tick();
    const slotRadius = Number(JSON.parse(ctx.droneRow().exec_slot_json).z);
    expect(slotRadius).toBeCloseTo(SURFACE + 3_000, 0);
    expect(String(ctx.droneRow().reason)).toMatch(/move sent/);
    ctx.place(slotRadius, 0);
    ackAll(ctx);
    ctx.executor.tick();
    ackAll(ctx);
    ctx.executor.tick();
    expect(ctx.droneRow().state).toBe('holding');
    expect(audit(ctx.store, 'demo_landing_flare')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_touchdown')).toHaveLength(0);
    expect(gearWrites(ctx.sent)).toHaveLength(0);
  });

  it('(f) parks ON the ground as a landing, so the audit says which of the two it chose', () => {
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M,
      startRadiusM: TRUE_GROUND_M + 3_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { park: true },
      speedLimitMps: 100,
    });
    const park = audit(ctx.store, 'demo_park');
    expect(park).toHaveLength(1);
    const detail = park[0]!.detail as { decision?: string; reason?: string; altitudeAglM?: number };
    expect(detail.decision).toBe('land');
    expect(detail.altitudeAglM).toBe(0);
    expect(String(detail.reason)).toMatch(/on the ground .*parking means landing/);
    // A ground park is the landing slot: the flare plan follows the measurement.
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_landing_flare')).toHaveLength(1);
  });

  it('(g) a descent that settles 19 m above its slot completes instead of hovering', () => {
    // The measured 2026-11-10 case: the ship stopped 19 m above the slot with
    // ~0.4 m/s left. The 10 m radius never accepted it and the 1 m/s terminal
    // hold could not fly the last 19 m, so it hovered until the watchdog.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 500,
      startRadiusM: TRUE_GROUND_M + 519,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    ackAll(ctx);
    expect(ctx.droneRow().state).toBe('en_route');
    // 19 m of radius, 0.4 m/s of trim: settled on the slot vertically.
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + 519, -0.4);
    ctx.executor.tick();
    ackAll(ctx);
    expect(ctx.droneRow().state).toBe('holding');
    expect(String(ctx.droneRow().reason)).toMatch(/arrived 19\.0 m from slot/);
    expect(orders(ctx.sent).filter((m) => m.orderType === 'hold').length).toBeGreaterThan(0);
    expect(audit(ctx.store, 'demo_flight_abort')).toHaveLength(0);
    // It is still exactly where it settled: nothing flew it further.
    expect(ctx.store.getUnit('grid:land')?.pos?.z).toBeCloseTo(TRUE_GROUND_M + 519, 0);
  });

  it('(h) aborts the measured climb crawl within 30 s with `hull-crawl` and both numbers', () => {
    // The measured leg: 100 m/s commanded on a 2 km ascent, the hull achieved
    // ~1.5 m/s and closed at ~1.5 m/s with 1.7 km to go. The old stuck detector
    // needed closing < 1 m/s, so it never armed and the leg died on the 300 s
    // arrival timeout.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_700,
      startRadiusM: TRUE_GROUND_M + 1_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    ackAll(ctx);
    const commanded = Number((moves(ctx.sent)[0]!.params as { speed?: number }).speed);
    expect(commanded).toBe(100);

    let radius = TRUE_GROUND_M + 1_000;
    let abortedAt = -1;
    for (let i = 1; i <= 60; i += 1) {
      ctx.clock.now += 1_000;
      radius += 1.5; // 100 commanded, ~1.5 m/s achieved
      ctx.place(radius, 1.5);
      ctx.executor.tick();
      ackAll(ctx);
      if (ctx.droneRow().state === 'aborted') {
        abortedAt = i;
        break;
      }
    }
    expect(abortedAt, 'the crawl must be aborted, not left to the 300 s watchdog').toBeGreaterThan(0);
    expect(abortedAt).toBeLessThan(30);

    const crawl = audit(ctx.store, 'demo_arrival_crawl');
    expect(crawl, 'the crawl must be recorded with its numbers').toHaveLength(1);
    const detail = crawl[0]!.detail as {
      commandedSpeedMps?: number;
      achievedSpeedMps?: number;
      closingRateMps?: number;
      crawlSeconds?: number;
      remainingM?: number;
    };
    expect(Number(detail.commandedSpeedMps)).toBeCloseTo(100, 0);
    expect(Number(detail.achievedSpeedMps)).toBeCloseTo(1.5, 1);
    expect(Number(detail.closingRateMps)).toBeCloseTo(1.5, 1);
    expect(Number(detail.remainingM)).toBeGreaterThan(1_500);
    expect(Number(detail.crawlSeconds)).toBeGreaterThanOrEqual(ARRIVAL_CRAWL_MS / 1_000);

    const aborts = audit(ctx.store, 'demo_flight_abort');
    expect(aborts).toHaveLength(1);
    const abort = aborts[0]!.detail as { code?: string; reason?: string };
    expect(abort.code).toBe('hull-crawl');
    expect(String(abort.reason)).toMatch(/commanded 100\.0 m\/s/);
    expect(String(abort.reason)).toMatch(/achieved 1\.5 m\/s/);
    expect(String(abort.reason)).toMatch(/closing on the slot at 1\.5 m\/s/);
    // Held, never arrived.
    expect(ctx.droneRow().state).toBe('aborted');
    expect(orders(ctx.sent).filter((m) => m.orderType === 'hold').length).toBeGreaterThan(0);
  });
});
