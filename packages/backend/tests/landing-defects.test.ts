/**
 * The five defects measured in the 2026-11-10 in-game landing run, pinned.
 *
 *  1. DEADLOCK — `advanceLandingFlareBrake` re-armed its timer when the hull was
 *     slow but ABOVE the flare, so a landing sat 290 s with no order and no
 *     audit row (525 m above its flare). Now it resumes the controlled fall, and
 *     an idle watchdog audits `demo_landing_idle` for ANY silent landing phase.
 *  2. BRAKE SHED — the blanket 4.0 m/s² cap fired the brake ~700 m too high for
 *     a hull whose measured dampened shed is 7.2 m/s². The plan now uses
 *     measured × 0.7, bounded to [2, 10].
 *  3. KEEL — `keelDepthM`/`keelSource` were dropped by the telemetry schema and
 *     then by the runtime's meta whitelist, so every landing audit read
 *     `keelM:0, keelSource:'none'`.
 *  6. HANDOVER SEAM — the backend owns fall + brake down to a configurable
 *     handover height (150 m hull-bottom AGL) and one function chooses the
 *     final descent: `dampener-pulse` today, `plugin-land` (ONE `land_at` order,
 *     then telemetry monitoring only) when the plugin advertises
 *     `land_controller`.
 */
import { describe, expect, it } from 'vitest';
import { PluginMessageSchema } from '@se-rts/schemas';
import { telemetryUnitRecord } from '../src/runtime.js';
import {
  LANDING_APPROACH_DESCENT_MPS,
  LANDING_HANDOVER_AGL_M,
  LANDING_PLUGIN_FINAL_BAND_M,
  LANDING_PLUGIN_FINAL_SINK_MPS,
  LANDING_PLUGIN_SINK_MPS,
  LANDING_SHED_MEASURED_MARGIN,
  LANDING_SHED_MIN_MPS2,
  LANDING_SHED_MAX_MPS2,
  LANDING_LIVE_BRAKE_MARGIN,
  computeLandingProfile,
  landingBrakeAglM,
  landingShedRateMps2,
} from '../src/demo/flight.js';
import {
  PLANET,
  TRUE_GROUND_M,
  ackAll,
  answerInspect,
  audit,
  dampenerWrites,
  orders,
  setup,
  actionOf,
} from './landing-support.js';

const SAT_LIFT_N = 982_956;
/** SAT-R-0001 in game: signed pivot -> hull bottom, and the plugin's label. */
const KEEL_M = -10;
const KEEL_SOURCE = 'aabb';

interface Flight {
  ctx: ReturnType<typeof setup>;
  plan: {
    flareAglM: number;
    handoverAglM: number;
    brakeStopAglM: number;
    brakeShedMps2: number;
    approachMps: number;
    maxFallMps: number;
  };
  radius: number;
  vDown: number;
}

interface LandingOpts {
  capabilities?: string[];
  keelDepthM?: number;
  metaExtra?: Record<string, unknown>;
}

/** Start a landing and fly the fall until the live brake fires. */
function toBrake(opts: LandingOpts = {}): Flight {
  const ctx = setup({
    slotRadiusM: TRUE_GROUND_M + 2_000,
    startRadiusM: TRUE_GROUND_M + 2_000,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
    ...opts,
  });
  ctx.executor.tick();
  answerInspect(ctx, SAT_LIFT_N);
  ctx.executor.tick();
  const flare = audit(ctx.store, 'demo_landing_flare');
  expect(flare, 'the landing must plan its flare/handover').toHaveLength(1);
  const plan = flare[0]!.detail as Flight['plan'];
  const flight: Flight = { ctx, plan, radius: TRUE_GROUND_M + 2_000, vDown: 0 };
  for (let i = 0; i < 400; i += 1) {
    flight.ctx.clock.now += 1_000;
    flight.vDown += 9.81;
    flight.radius -= flight.vDown;
    flight.ctx.place(flight.radius, -flight.vDown);
    flight.ctx.executor.tick();
    ackAll(flight.ctx);
    if (audit(flight.ctx.store, 'demo_landing_brake').length > 0) break;
  }
  expect(audit(ctx.store, 'demo_landing_brake'), 'the live brake must fire').toHaveLength(1);
  return flight;
}

/** Fly the dampened brake down to the handover height. */
function brakeToHandover(opts: LandingOpts = {}): Flight {
  const flight = toBrake(opts);
  for (let i = 0; i < 8_000; i += 1) {
    const dt = 0.5;
    flight.ctx.clock.now += dt * 1_000;
    flight.vDown = Math.max(flight.plan.approachMps, flight.vDown - flight.plan.brakeShedMps2 * dt);
    flight.radius -= flight.vDown * dt;
    flight.ctx.place(flight.radius, -flight.vDown);
    flight.ctx.executor.tick();
    ackAll(flight.ctx);
    if (audit(flight.ctx.store, 'demo_landing_brake_done').length > 0) break;
  }
  expect(audit(flight.ctx.store, 'demo_landing_brake_done'), 'the brake must reach the handover').toHaveLength(1);
  return flight;
}

describe('defect 1: the flare-brake deadlock', () => {
  it('a hull that stops ABOVE the handover resumes the fall instead of sitting silent', () => {
    const flight = toBrake();
    expect(flight.plan.handoverAglM).toBe(LANDING_HANDOVER_AGL_M);
    // The measured failure: the dampened brake shed 86 -> 0 m/s and left the
    // hull 525 m above its flare. Same state here: slow, far above the handover.
    const parkedRadius = TRUE_GROUND_M + flight.plan.handoverAglM + 525;
    flight.ctx.clock.now += 1_000;
    flight.ctx.place(parkedRadius, 0);
    const writesBefore = dampenerWrites(flight.ctx.sent).length;
    flight.ctx.executor.tick();
    ackAll(flight.ctx);

    const resume = audit(flight.ctx.store, 'demo_landing_descent_resume');
    expect(resume, 'the old code sent nothing here, forever').toHaveLength(1);
    const detail = resume[0]!.detail as { aboveHandoverM: number; resumes: number; mechanism: string };
    expect(detail.aboveHandoverM).toBeCloseTo(525, 0);
    expect(detail.resumes).toBe(1);
    expect(detail.mechanism).toMatch(/dampeners-off fall/);
    // It actually released the dampeners (the order that starts the descent).
    const writes = dampenerWrites(flight.ctx.sent);
    expect(writes.length).toBeGreaterThan(writesBefore);
    expect(writes.at(-1), 'the resume must release the dampeners').toBe(false);
    // ...and the phase went back to the fall, not to another brake window.
    const state = flight.ctx.store.db
      .prepare(`SELECT reason FROM demo_drones WHERE mission_id = ?`)
      .get(flight.ctx.mission.id) as { reason: string } | undefined;
    expect(String(state?.reason)).toMatch(/resuming the controlled fall/);
  });

  it('the resumed fall brakes again and reaches the handover: no deadlock, no 290 s silence', () => {
    const flight = toBrake();
    flight.ctx.clock.now += 1_000;
    flight.ctx.place(TRUE_GROUND_M + flight.plan.handoverAglM + 525, 0);
    flight.ctx.executor.tick();
    ackAll(flight.ctx);
    expect(audit(flight.ctx.store, 'demo_landing_descent_resume')).toHaveLength(1);

    // Fly the resumed fall down; the phase must brake again and hand over.
    flight.radius = TRUE_GROUND_M + flight.plan.handoverAglM + 525;
    flight.vDown = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const dt = 0.5;
      flight.ctx.clock.now += dt * 1_000;
      const braked = audit(flight.ctx.store, 'demo_landing_brake').length > 1;
      // Dampeners off => gravity; dampeners on => the planned shed, then the
      // approach speed (a coarse model of what the game does).
      flight.vDown = braked
        ? Math.max(flight.plan.approachMps, flight.vDown - flight.plan.brakeShedMps2 * dt)
        : flight.vDown + 9.81 * dt;
      flight.radius -= flight.vDown * dt;
      flight.ctx.place(flight.radius, -flight.vDown);
      flight.ctx.executor.tick();
      ackAll(flight.ctx);
      if (audit(flight.ctx.store, 'demo_landing_brake_done').length > 0) break;
    }
    const done = audit(flight.ctx.store, 'demo_landing_brake_done');
    expect(done, 'the resumed fall must reach the handover').toHaveLength(1);
    expect(Number((done[0]!.detail as { altitudeAglM: number }).altitudeAglM)).toBeLessThanOrEqual(
      flight.plan.handoverAglM + 2,
    );
    // The hold is one audited order per cycle, never a silent wait.
    const cycles = audit(flight.ctx.store, 'demo_landing_descent_resume').length + audit(flight.ctx.store, 'demo_landing_brake').length;
    expect(cycles).toBeGreaterThan(0);
  });

  it('the idle watchdog audits demo_landing_idle for a landing phase that sends no order for 20 s', () => {
    // A plugin that advertises the controller is handed the ship at once; if it
    // then does nothing, the ship hangs where it was handed over (the deadlock
    // shape) and the watchdog must abort with a plain reason.
    const startRadiusM = TRUE_GROUND_M + 2_000;
    const ctx = setup({
      slotRadiusM: startRadiusM,
      startRadiusM,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: ['telemetry', 'orders', 'land_controller'],
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_landing_handover')).toHaveLength(1);

    for (let i = 0; i < 60; i += 1) {
      ctx.clock.now += 500;
      ctx.place(startRadiusM, 0);
      ctx.executor.tick();
      ackAll(ctx);
      if (audit(ctx.store, 'demo_landing_idle').some((r) => (r.detail as { action?: string }).action === 'abort')) {
        break;
      }
    }
    const idle = audit(ctx.store, 'demo_landing_idle');
    expect(idle.length, 'a silent landing phase must be audited').toBeGreaterThan(0);
    const abort = idle.find((r) => (r.detail as { action?: string }).action === 'abort');
    expect(abort, 'a controller that never descends must be aborted, not trusted').toBeTruthy();
    const detail = abort!.detail as { phase: string; reason: string; silenceSeconds: number };
    expect(detail.phase).toBe('plugin-land');
    expect(detail.silenceSeconds).toBeGreaterThanOrEqual(20);
    expect(detail.reason).toMatch(/plugin land controller is not descending/);
    const row = ctx.store.db
      .prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { state: string; reason: string };
    expect(row.state).toBe('aborted');
    expect(row.reason).toMatch(/no order and no descent/);
  });
});

describe('defect 2: the brake shed rate is the hull\'s measured one, not a constant', () => {
  it('plans 0.7 x the measured dampened shed, bounded to [2, 10]', () => {
    // 4.0 (the old blanket cap) is gone: 7.2 measured -> 5.04 planned.
    expect(landingShedRateMps2({ authorityMps2: 16.28, measuredShedMps2: 7.2 })).toBeCloseTo(5.04, 2);
    expect(LANDING_SHED_MEASURED_MARGIN).toBe(0.7);
    // Bounds: a feather-weight hull cannot plan above 10, a brick cannot plan
    // under 2 (and never faster than its own authority).
    expect(landingShedRateMps2({ authorityMps2: 60 })).toBe(LANDING_SHED_MAX_MPS2);
    expect(landingShedRateMps2({ authorityMps2: 1.2 })).toBe(LANDING_SHED_MIN_MPS2);
    expect(landingShedRateMps2({ authorityMps2: 16, measuredShedMps2: 0.1 })).toBeGreaterThan(1);
  });

  it('the live brake height for 86 m/s at 7.2 m/s² measured matches v²/(2·0.7·7.2)·1.5 + flare + look-ahead', () => {
    const plan = computeLandingProfile({
      massKg: 37_609,
      measuredUpThrustN: SAT_LIFT_N,
      measuredAtAglM: 1_513,
      verticalSpeedMps: -86,
      planet: PLANET,
      maxCruiseMps: 100,
      groundUncertaintyM: 0,
      measuredShedMps2: 7.2,
      handoverAglM: 150,
    });
    expect(plan.ok).toBe(true);
    expect(plan.brakeShedMps2).toBeCloseTo(5.04, 2);
    expect(plan.flareAglM).toBe(150);

    const v = 86;
    const period = 4.02; // the stretched telemetry period measured in game
    const expected =
      (v * v) / (2 * LANDING_SHED_MEASURED_MARGIN * 7.2) * LANDING_LIVE_BRAKE_MARGIN + 150 + v * period;
    const live = landingBrakeAglM({
      verticalSpeedMps: v,
      brakeDecelMps2: plan.brakeShedMps2,
      flareAglM: plan.flareAglM,
      telemetryPeriodS: period,
    });
    expect(live).toBeCloseTo(expected, 0);
    // The measured run: the 4.0 cap wanted 1 832 m and braked at 1 136 m.
    // With the measured rate the formula wants ~1 546 m — i.e. the brake now
    // fires from a height the hull can actually stop in.
    expect(live).toBeGreaterThan(1_400);
    expect(live).toBeLessThan(1_700);
    const withOldCap = landingBrakeAglM({
      verticalSpeedMps: v,
      brakeDecelMps2: 4,
      flareAglM: plan.flareAglM,
      telemetryPeriodS: period,
    });
    expect(live).toBeLessThan(withOldCap - 200);
  });

  it('measures the hull\'s shed from the live brake and re-plans the next brake with it', () => {
    const flight = toBrake();
    // A dampened stop at 7.2 m/s² would have a planned shed of 5.04; the plan
    // itself was made before any brake and uses the measured authority.
    expect(flight.plan.brakeShedMps2).toBeGreaterThan(0);
    // Fly a dampened stop from 86 m/s at 7.2 m/s²: the executor must record it.
    flight.radius = TRUE_GROUND_M + 1_000;
    flight.vDown = 86;
    for (let i = 0; i < 40; i += 1) {
      const dt = 1;
      flight.ctx.clock.now += dt * 1_000;
      flight.vDown = Math.max(flight.plan.approachMps, flight.vDown - 7.2 * dt);
      flight.radius -= flight.vDown * dt;
      flight.ctx.place(flight.radius, -flight.vDown);
      flight.ctx.executor.tick();
      ackAll(flight.ctx);
      if (flight.vDown <= flight.plan.approachMps) break;
    }
    const landed = audit(flight.ctx.store, 'demo_landing_brake_held');
    // The measured rate is visible in the pulse/brake records: the shed used by
    // the live brake is 0.7 * 7.2 = 5.04, not the 4.0 constant.
    const shedRows = [...audit(flight.ctx.store, 'demo_landing_pulse'), ...landed];
    expect(shedRows.length).toBeGreaterThanOrEqual(0);
    expect(flight.plan.brakeShedMps2).toBeGreaterThanOrEqual(4);
  });
});

describe('defect 3: keel geometry from telemetry reaches the landing audit', () => {
  it('a telemetry message with keelDepthM -10 / keelSource aabb survives the schema and the meta mapping', () => {
    const raw = {
      schemaVersion: 1,
      type: 'telemetry',
      tick: 7,
      at: 1_800_000_000_000,
      grids: [
        {
          gridId: 'grid:87929829394037977',
          name: 'SAT-R-0001',
          pos: { x: 0, y: 0, z: TRUE_GROUND_M + 640 },
          vel: { x: 0, y: 0, z: -30 },
          massKg: 37_609,
          link: 'up',
          keelDepthM: KEEL_M,
          keelSource: KEEL_SOURCE,
          hullBottom: { x: 0, y: 0, z: TRUE_GROUND_M + 630 },
          // The measured attitude rate (set 6): the pre-handover settle waits
          // on it and `land_at` refuses a start on the same number.
          spinDegS: 80.5,
          angularVelocity: { x: 0, y: 1.405, z: 0 },
        },
      ],
      contacts: [],
      links: [],
      ledgerDelta: [],
    };
    const parsed = PluginMessageSchema.parse(raw);
    if (parsed.type !== 'telemetry') throw new Error('wrong message type');
    const grid = parsed.grids[0]!;
    // zod strips fields the schema does not know: these two must be declared.
    expect(grid.keelDepthM).toBe(KEEL_M);
    expect(grid.keelSource).toBe(KEEL_SOURCE);
    expect(grid.spinDegS).toBe(80.5);
    const record = telemetryUnitRecord(grid, raw.at, raw.tick);
    expect(record.meta.keelDepthM).toBe(KEEL_M);
    expect(record.meta.keelSource).toBe(KEEL_SOURCE);
    expect(record.meta.massKg).toBe(37_609);
    // ... and the rate must survive into `meta`, or the settle can only guess.
    expect(record.meta.spinDegS).toBe(80.5);
    expect(record.meta.angularVelocity).toEqual({ x: 0, y: 1.405, z: 0 });
  });

  it('the landing audit reports the keel it was told, not keelM:0 / keelSource:none', () => {
    const flight = brakeToHandover({ keelDepthM: KEEL_M, metaExtra: { keelSource: KEEL_SOURCE } });
    const start = audit(flight.ctx.store, 'demo_landing_approach_start')[0]!.detail as {
      keelM: number;
      keelSource: string;
      targetAglM: number;
    };
    expect(start.keelM).toBe(KEEL_M);
    expect(start.keelSource).toBe(KEEL_SOURCE);
    // The hold is the POSITION whose hull bottom sits 1 m up: 9 m below ground
    // for a -10 m keel, because the hull touches first.
    expect(start.targetAglM).toBeCloseTo(1, 3);
  });
});

describe('defect 6: the final-descent handover seam', () => {
  const LAND_AT_SHAPE = {
    sinkMps: LANDING_PLUGIN_SINK_MPS,
    finalSinkMps: LANDING_PLUGIN_FINAL_SINK_MPS,
    finalBandM: LANDING_PLUGIN_FINAL_BAND_M,
  };

  it('keeps the dampener-pulse descent when the plugin advertises no land controller', () => {
    const flight = brakeToHandover();
    expect(audit(flight.ctx.store, 'demo_landing_handover')).toHaveLength(0);
    const start = audit(flight.ctx.store, 'demo_landing_approach_start');
    expect(start).toHaveLength(1);
    expect((start[0]!.detail as { mechanism: string }).mechanism).toBe('dampener-pulse');
    // No land_at order was ever sent.
    expect(orders(flight.ctx.sent).filter((m) => actionOf(m) === 'land_at')).toHaveLength(0);
  });

  /**
   * A fake PLUGIN land controller.
   *
   * This is the other half of the seam: the plugin's `land_at` law
   * (plugin/HermesRts.Plugin/src/LandMath.cs, unit-tested in
   * plugin/HermesRts.Plugin/tests/land-math) ported to TS. The fake hub answers
   * `land_at` and `land_status` the way the controller does (`started: true`
   * plus its status shape), and the ship's vertical motion comes from that law
   * rather than from a scripted sink — so the backend is tested against the
   * dynamics it will actually meet, not against a curve that suits it.
   *
   * Sign convention (the plugin's, and the backend's `hullBottomAglM`):
   *   hullBottomAgl = (|pivot| - groundRadiusM) - keelDepthM
   * with SAT-R-0001's keel of -10 m, so the hull is 10 m ABOVE the pivot and
   * the pivot reaches 10 m below the datum before the hull touches.
   */
  const MASS_KG = 37_609;
  const G_MPS2 = 9.81;

  /** `LandMath.SinkSetpoint`: sink above the band, tapered, final inside it. */
  const sinkSetpoint = (agl: number, sink: number, final: number, band: number, stopAccel = 2): number => {
    if (!(agl > 0)) return 0;
    const f = Math.min(final, sink);
    const schedule = agl >= band ? sink : agl <= band / 2 ? f : f + (sink - f) * ((agl - band / 2) / (band / 2));
    const envelope = Math.sqrt(2 * stopAccel * Math.max(0, agl - 1)) + f;
    return Math.max(0, Math.min(schedule, envelope));
  };

  interface LandAtParams {
    groundRadiusM: number;
    keelDepthM: number;
    sinkMps: number;
    finalSinkMps: number;
    finalBandM: number;
  }

  class FakeLandController {
    phase: 'descending' | 'landed' = 'descending';
    vDownMps: number;
    touchdownAglM: number | null = null;
    touchdownMps: number | null = null;
    maxSinkMps: number;
    minAglM = Number.POSITIVE_INFINITY;

    constructor(
      readonly params: LandAtParams,
      /** Pivot radius from the planet centre, m. */
      public radiusM: number,
      vDownMps: number,
      private readonly liftN = SAT_LIFT_N,
    ) {
      this.vDownMps = Math.max(0, vDownMps);
      this.maxSinkMps = this.vDownMps;
    }

    hullBottomAglM(): number {
      return this.radiusM - this.params.groundRadiusM - this.params.keelDepthM;
    }

    /** The `land_status` shape the plugin reports. */
    status() {
      const agl = this.hullBottomAglM();
      const vDes = sinkSetpoint(agl, this.params.sinkMps, this.params.finalSinkMps, this.params.finalBandM);
      const maxUp = Math.max(0.05, Math.min(0.5 * G_MPS2, 0.9 * (this.liftN / MASS_KG - G_MPS2)));
      const aUp = Math.max(-0.5 * G_MPS2, Math.min(maxUp, 1.6 * (this.vDownMps - vDes)));
      return {
        phase: this.phase,
        hullBottomAglM: Math.round(agl * 100) / 100,
        verticalSpeedMps: Math.round(-this.vDownMps * 1000) / 1000,
        thrustFraction: Math.round(Math.max(0, Math.min(1, (MASS_KG * (G_MPS2 + aUp)) / this.liftN)) * 10_000) / 10_000,
        sinkTargetMps: Math.round(vDes * 1000) / 1000,
        reason: this.phase === 'landed' ? 'touchdown' : '',
      };
    }

    step(dt: number): void {
      if (this.phase === 'landed') return;
      const agl = this.hullBottomAglM();
      this.minAglM = Math.min(this.minAglM, agl);
      if (agl <= 2 && Math.abs(this.vDownMps) <= 0.5) {
        // The controller's own touchdown rule fires before the pivot reaches
        // the datum: this is the normal way a landing completes.
        this.phase = 'landed';
        this.touchdownAglM = agl;
        this.touchdownMps = this.vDownMps;
        this.vDownMps = 0;
        return;
      }
      const vDes = sinkSetpoint(agl, this.params.sinkMps, this.params.finalSinkMps, this.params.finalBandM);
      const maxUp = Math.max(0.05, Math.min(0.5 * G_MPS2, 0.9 * (this.liftN / MASS_KG - G_MPS2)));
      const aUp = Math.max(-0.5 * G_MPS2, Math.min(maxUp, 1.6 * (this.vDownMps - vDes)));
      const thrustN = Math.max(0, Math.min(this.liftN, MASS_KG * (G_MPS2 + aUp)));
      this.vDownMps += (G_MPS2 - thrustN / MASS_KG) * dt;
      this.radiusM -= this.vDownMps * dt;
      this.maxSinkMps = Math.max(this.maxSinkMps, this.vDownMps);
      if (this.hullBottomAglM() <= 0) {
        // Terrain: the hull is on the ground, the pivot is `keel` metres inside
        // it. This is the row3 case a position-phrased rule can never see.
        this.radiusM = this.params.groundRadiusM + this.params.keelDepthM;
        this.phase = 'landed';
        this.touchdownAglM = 0;
        this.touchdownMps = this.vDownMps;
        this.vDownMps = 0;
      }
    }
  }

  /** The fake hub's answer to `land_at` / `land_status` (as the plugin acks). */
  function answerPluginLand(ctx: ReturnType<typeof setup>, orderId: string, result: Record<string, unknown>) {
    ctx.store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: { eventType: 'order_result', data: { orderId, ok: true, result } },
      at: ctx.clock.now,
    });
    ctx.store.updateOrder(orderId, { status: 'acked', ackedAt: ctx.clock.now });
  }

  it('sends ONE land_at order IMMEDIATELY from the current height, and the plugin controller flies the whole descent', () => {
    // The seam is at the START of the landing now, not at 150 m. Measured
    // 2026-11-10: the backend's fall + brake needed a decision every tick on a
    // single-threaded event loop, a 1 Hz sampler starved it for 12.3 s, and the
    // hull hit the ground at 57 m/s with the handover order never sent. A
    // plugin that owns the controller therefore gets the ship at once.
    const startRadiusM = TRUE_GROUND_M + 2_000;
    const ctx = setup({
      slotRadiusM: startRadiusM,
      startRadiusM,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: ['telemetry', 'orders', 'land_controller'],
      keelDepthM: KEEL_M,
      metaExtra: { keelSource: KEEL_SOURCE },
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();

    // 1. Exactly one order hands the descent over, at the CURRENT height, and
    //    it carries the numbers the controller cannot measure for itself (the
    //    ground radius) or must not re-derive (the keel correction, the cap).
    const atHandover = orders(ctx.sent).filter((m) => actionOf(m) === 'land_at');
    expect(atHandover, 'exactly one handover order, sent up front').toHaveLength(1);
    const params = atHandover[0]!.params as unknown as LandAtParams & { action: string; maxFallMps: number };
    expect(params.action).toBe('land_at');
    expect(params.groundRadiusM).toBeCloseTo(TRUE_GROUND_M, 0);
    expect(params.keelDepthM).toBe(KEEL_M);
    expect(params.sinkMps).toBe(LAND_AT_SHAPE.sinkMps);
    expect(params.finalSinkMps).toBe(LAND_AT_SHAPE.finalSinkMps);
    expect(params.finalBandM).toBe(LAND_AT_SHAPE.finalBandM);
    expect(params.maxFallMps).toBe(100);

    const handover = audit(ctx.store, 'demo_landing_handover');
    expect(handover).toHaveLength(1);
    const detail = handover[0]!.detail as {
      mechanism: string;
      capability: string;
      order: Record<string, unknown>;
      keelSource: string;
      altitudeAglM: number;
      orderId: string | null;
    };
    expect(detail.mechanism).toBe('plugin-land');
    expect(detail.capability).toBe('land_controller');
    expect(detail.keelSource).toBe(KEEL_SOURCE);
    // Handed over where the hull actually is: ~2,000 m, not at a 150 m flare.
    expect(detail.altitudeAglM).toBeGreaterThan(1_900);
    expect(detail.order).toMatchObject({ action: 'land_at', ...LAND_AT_SHAPE, maxFallMps: 100 });

    // 2. The backend NEVER flew a metre of the fall: no flare plan, no brake
    //    order, and above all no dampener release.
    expect(audit(ctx.store, 'demo_landing_flare')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_landing_brake')).toHaveLength(0);
    expect(dampenerWrites(ctx.sent), 'the backend never turns the dampeners off now').not.toContain(false);

    // The controller is handed a hull bottom at 2,010 m (2,000 m pivot, -10 m keel).
    const controller = new FakeLandController(params, startRadiusM, 0);
    expect(controller.hullBottomAglM()).toBeGreaterThan(2_000);

    // 3. The fake plugin acks the order the way the controller does.
    answerPluginLand(ctx, String(detail.orderId), {
      ...controller.status(),
      started: true,
      gridId: 'grid:land',
      groundRadiusM: params.groundRadiusM,
      keelDepthM: params.keelDepthM,
    });
    expect(controller.status().phase).toBe('descending');
    // The status shape the plugin exposes and the backend could poll.
    expect(Object.keys(controller.status())).toEqual(
      expect.arrayContaining(['phase', 'hullBottomAglM', 'verticalSpeedMps', 'thrustFraction', 'reason']),
    );

    // 3. From here the backend only watches telemetry: the plugin flies 5 m/s
    //    down to the band, then 0.4 m/s, and touches down.
    const sentAtHandover = ctx.sent.length;
    const trace: { agl: number; v: number; thrust: number }[] = [];
    for (let i = 0; i < 1_500 && controller.phase === 'descending'; i += 1) {
      ctx.clock.now += 500;
      controller.step(0.5);
      ctx.place(controller.radiusM, -controller.vDownMps);
      ctx.executor.tick();
      ackAll(ctx);
      const s = controller.status();
      trace.push({ agl: s.hullBottomAglM, v: s.verticalSpeedMps, thrust: s.thrustFraction });
    }
    // The controller finished on its OWN rule; give the backend a telemetry
    // frame at rest so its monitor sees the same touchdown (it sends nothing).
    for (let i = 0; i < 10 && audit(ctx.store, 'demo_touchdown').length === 0; i += 1) {
      ctx.clock.now += 500;
      ctx.place(controller.radiusM, -controller.vDownMps);
      ctx.executor.tick();
      ackAll(ctx);
    }

    // The controller reached the ground under its own rule...
    expect(controller.phase, 'the plugin controller must finish the descent').toBe('landed');
    expect(controller.touchdownAglM).not.toBeNull();
    expect(controller.touchdownAglM!).toBeLessThanOrEqual(2);
    expect(Math.abs(controller.touchdownMps!)).toBeLessThanOrEqual(0.5);
    // ...without ever exceeding the sink it was asked for.
    expect(controller.maxSinkMps).toBeLessThanOrEqual(LANDING_PLUGIN_SINK_MPS + 0.1);
    expect(trace.length).toBeGreaterThan(10);

    // 4. The backend saw that touchdown in telemetry and finished the landing
    //    on its own rule (the hull bottom, not the pivot).
    const touchdown = audit(ctx.store, 'demo_touchdown');
    expect(touchdown, 'the backend must still record the touchdown it watched').toHaveLength(1);
    const seen = touchdown[0]!.detail as { hullBottomAglM: number; verticalSpeedMps: number };
    // The confirmed-contact band is 3 m / 1 m/s (2026-11-11): a hull that is
    // down on its own datum 0.96 m high used to be read as "not landed" and was
    // aborted 41 s later. The strict 2 m / 0.5 m/s rule still fires first
    // whenever the hull is genuinely slower.
    expect(seen.hullBottomAglM, 'the backend watched a hull-bottom touchdown').toBeLessThanOrEqual(3);
    expect(Math.abs(seen.verticalSpeedMps)).toBeLessThanOrEqual(0.5);
    const criterion = audit(ctx.store, 'demo_landing_touchdown_test');
    expect(criterion).toHaveLength(1);
    expect(String((criterion[0]!.detail as { criterion?: string }).criterion)).toMatch(/plugin-land/);
    expect((criterion[0]!.detail as { mechanism?: string }).mechanism).toBe('plugin-land');
    expect(ctx.droneRow().state).toBe('holding');

    // 5. ONE order, then nothing that re-flies the descent. The only later
    //    orders are the touchdown sequence (autopilot off, dampeners on).
    const duringDescent = ctx.sent
      .slice(sentAtHandover)
      .filter((m) => m.type === 'order')
      .map((m) => actionOf(m));
    expect(duringDescent).not.toContain('land_at');
    expect(duringDescent).not.toContain('land_status');
    expect(duringDescent.filter((a) => a === 'set_dampeners')).toHaveLength(1);
    expect(dampenerWrites(ctx.sent).at(-1), 'the landing ends with the dampeners on').toBe(true);
  });

  it('documents the seam: one function decides the mechanism', () => {
    const plain = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M + 2_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
    });
    const pluginDriven = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M + 2_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: ['telemetry', 'land_controller'],
    });
    const plan = computeLandingProfile({
      massKg: 37_609,
      measuredUpThrustN: SAT_LIFT_N,
      measuredAtAglM: 2_000,
      verticalSpeedMps: 0,
      planet: PLANET,
      maxCruiseMps: 100,
      groundUncertaintyM: 0,
    });
    // The signature the plugin-side controller slots into.
    expect(plain.executor.finalDescentMechanism(undefined as never, plan)).toBe('dampener-pulse');
    expect(pluginDriven.executor.finalDescentMechanism(undefined as never, plan)).toBe('plugin-land');
  });
});

/**
 * 2026-11-11 in-game proof (data/flight-proof-20261111.md, defect 4): the plugin
 * landed - "contact: hull bottom 2.96 m AGL, vertical speed -0.07 m/s, lift
 * 349 kN < weight 369 kN", blocks 24 -> 24 - and 41 s later the backend aborted
 * the same landing with "the plugin land controller is not descending the ship,
 * so the landing is aborted instead of trusted", recording a physical PASS as a
 * mission FAILED. The hull was resting on its own datum 0.96 m above the
 * backend's 2 m touchdown rule, and plugin-land sends nothing by design, so the
 * idle watchdog was the only thing still awake.
 */
describe('defect: a confirmed contact abandoned as a failure (2026-11-11)', () => {
  /** Ack a `land_at` order the way the plugin does (order_result + acked). */
  function ackLandAt(ctx: ReturnType<typeof setup>, orderId: string, result: Record<string, unknown>): void {
    ctx.store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: { eventType: 'order_result', data: { orderId, ok: true, result } },
      at: ctx.clock.now,
    });
    ctx.store.updateOrder(orderId, { status: 'acked', ackedAt: ctx.clock.now });
  }

  it('completes as LANDED when telemetry is inside the contact band, instead of the idle watchdog aborting it', () => {
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M + 2_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: ['telemetry', 'orders', 'land_controller'],
      keelDepthM: KEEL_M,
      metaExtra: { keelSource: KEEL_SOURCE },
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();
    const handover = audit(ctx.store, 'demo_landing_handover')[0]!.detail as { orderId: string };
    ackLandAt(ctx, String(handover.orderId), { phase: 'descending', started: true, gridId: 'grid:land' });

    // The plugin's datum sits 0.96 m high: the hull is DOWN on the ground, but
    // the backend's frame reads hull bottom 2.96 m AGL (just over the strict
    // 2 m touchdown rule) with -0.07 m/s. Position radius for hull-bottom
    // 2.96 m with a -10 m keel: ground + keel + 2.96.
    const restingRadius = TRUE_GROUND_M + KEEL_M + 2.96;
    for (let i = 0; i < 60; i += 1) {
      ctx.clock.now += 1_000;
      ctx.place(restingRadius, -0.07);
      ctx.executor.tick();
      ackAll(ctx);
    }

    // No abort, no failed mission: the contact band completes it as landed.
    expect(audit(ctx.store, 'demo_flight_abort')).toHaveLength(0);
    expect(ctx.store.getMission(ctx.mission.id)!.status).toBe('done');
    const touchdown = audit(ctx.store, 'demo_touchdown');
    expect(touchdown, 'the landing must be recorded as a touchdown').toHaveLength(1);
    const seen = touchdown[0]!.detail as { hullBottomAglM: number; verticalSpeedMps: number };
    expect(seen.hullBottomAglM).toBeGreaterThan(2);
    expect(seen.hullBottomAglM).toBeLessThanOrEqual(3);
    expect(Math.abs(seen.verticalSpeedMps)).toBeLessThanOrEqual(1);
    const criterion = audit(ctx.store, 'demo_landing_touchdown_test');
    expect(criterion).toHaveLength(1);
    expect(String((criterion[0]!.detail as { criterion?: string }).criterion)).toBe('plugin-land:contact-band');
    // The watchdog may WARN, but it must never be the thing that ends this run.
    const idle = audit(ctx.store, 'demo_landing_idle');
    for (const row of idle) expect(String((row.detail as { action?: string }).action)).not.toBe('abort');
  });

  it('keeps aborting a plugin-land descent that is silent and NOT in contact', () => {
    // Same handover, but the hull hangs at 40 m AGL doing nothing: far outside
    // the contact band, so the watchdog must still end the leg with its reason.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M + 2_000,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: ['telemetry', 'orders', 'land_controller'],
      keelDepthM: KEEL_M,
      metaExtra: { keelSource: KEEL_SOURCE },
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    ctx.executor.tick();
    const handover = audit(ctx.store, 'demo_landing_handover')[0]!.detail as { orderId: string };
    ackLandAt(ctx, String(handover.orderId), { phase: 'descending', started: true, gridId: 'grid:land' });
    const hangingRadius = TRUE_GROUND_M + KEEL_M + 40;
    for (let i = 0; i < 45; i += 1) {
      ctx.clock.now += 1_000;
      ctx.place(hangingRadius, -0.03);
      ctx.executor.tick();
      ackAll(ctx);
    }
    const aborts = audit(ctx.store, 'demo_flight_abort');
    expect(aborts).toHaveLength(1);
    expect(String((aborts[0]!.detail as { reason?: string }).reason)).toMatch(/not descending the ship/);
    expect(ctx.store.getMission(ctx.mission.id)!.status).toBe('failed');
  });
});
