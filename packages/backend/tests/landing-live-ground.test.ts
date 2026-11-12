/**
 * Live ground updates during a plugin landing (2026-11-11, defect b).
 *
 * `land_at` carries ONE `groundRadiusM`, sampled at the column the handover
 * happened on. The plugin accepts `land_ground { gridId, groundRadiusM }` during
 * an active job (`LandController.UpdateGround`, refused inside
 * `LandMath.GroundUpdateMinDeltaM`), but the backend never sent it: the brake and
 * the flare ran on the handover column's ground while the hull descended over a
 * different one.
 *
 * What these tests pin:
 *   * a finer sample (the terrain field / a probe hit for the CURRENT column)
 *     that differs by more than 2 m sends exactly ONE `land_ground`, carrying the
 *     plugin's parameter names;
 *   * <= 2 m sends nothing;
 *   * at most one per 5 s, at most 5 per landing;
 *   * nothing after touchdown;
 *   * it is an order to the plugin — no polling of the backend's own HTTP API.
 */
import { describe, expect, it } from 'vitest';
import { TRUE_GROUND_M, ackAll, actionOf, answerInspect, audit, orders, setup } from './landing-support.js';

const SAT_LIFT_N = 982_956;
const LAND_CONTROLLER = ['telemetry', 'orders', 'land_controller'];
const START_AGL_M = 2_000;

/** A plugin-land descent under way, with a ground radius the test can change. */
function descentWith(terrain: { radiusM: number }) {
  const startRadiusM = terrain.radiusM + START_AGL_M;
  const ctx = setup({
    slotRadiusM: startRadiusM,
    startRadiusM,
    terrainRadiusM: TRUE_GROUND_M,
    terrainRadius: () => terrain.radiusM,
    desired: { land: true },
    speedLimitMps: 100,
    capabilities: LAND_CONTROLLER,
  });
  ctx.executor.tick();
  answerInspect(ctx, SAT_LIFT_N);
  ctx.executor.tick();
  const landAt = orders(ctx.sent).find((m) => actionOf(m) === 'land_at');
  if (!landAt) throw new Error('no land_at handover order was sent');
  // The plugin acks the handover; the backend only monitors from here.
  ctx.store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: {
      eventType: 'order_result',
      data: { orderId: String(landAt.orderId), ok: true, result: { started: true, gridId: 'grid:land', phase: 'falling' } },
    },
    at: ctx.clock.now,
  });
  ctx.store.updateOrder(String(landAt.orderId), { status: 'acked', ackedAt: ctx.clock.now });
  return { ctx, landAt, startRadiusM };
}

const groundOrders = (sent: Record<string, unknown>[]) => orders(sent).filter((m) => actionOf(m) === 'land_ground');

/** One telemetry frame at `radiusM`, `dtMs` later, then a tick. */
function step(flight: ReturnType<typeof descentWith>, radiusM: number, dtMs: number, vertical = -4) {
  flight.ctx.clock.now += dtMs;
  flight.ctx.place(radiusM, vertical);
  flight.ctx.executor.tick();
  ackAll(flight.ctx);
}

describe('live ground datum during a plugin landing', () => {
  it('sends ONE land_ground when the column sample moves by more than 2 m', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx, startRadiusM } = flight;
    expect(groundOrders(ctx.sent)).toHaveLength(0);

    // A finer tile / probe hit for THIS column: 4 m higher than the handover
    // column's ground.
    terrain.radiusM = TRUE_GROUND_M + 4;
    step(flight, startRadiusM - 120, 6_000);

    const sent = groundOrders(ctx.sent);
    expect(sent, 'one update, not one per tick').toHaveLength(1);
    const params = sent[0]!.params as { action: string; gridId: string; groundRadiusM: number };
    // The plugin's own parameter names (`land_ground { gridId, groundRadiusM }`).
    expect(params.action).toBe('land_ground');
    expect(params.gridId).toBe('grid:land');
    expect(params.groundRadiusM).toBeCloseTo(TRUE_GROUND_M + 4, 1);

    const rows = audit(ctx.store, 'demo_landing_ground_update');
    expect(rows).toHaveLength(1);
    const detail = rows[0]!.detail as { deltaM: number; update: number; groundRadiusM: number };
    expect(detail.deltaM).toBeCloseTo(4, 1);
    expect(detail.update).toBe(1);
    expect(detail.groundRadiusM).toBeCloseTo(TRUE_GROUND_M + 4, 1);
    // The landing is still the plugin's; nothing else was re-sent.
    expect(orders(ctx.sent).filter((m) => actionOf(m) === 'land_at')).toHaveLength(1);
    expect(ctx.droneRow().state).toBe('en_route');
  });

  it('sends nothing while the sample stays within 2 m of the datum', () => {
    for (const delta of [0, 1.5, -1.9]) {
      const terrain = { radiusM: TRUE_GROUND_M };
      const flight = descentWith(terrain);
      terrain.radiusM = TRUE_GROUND_M + delta;
      step(flight, flight.startRadiusM - 100, 6_000);
      step(flight, flight.startRadiusM - 200, 6_000);
      expect(groundOrders(flight.ctx.sent), `delta ${delta} m must not be pushed`).toHaveLength(0);
      expect(audit(flight.ctx.store, 'demo_landing_ground_update')).toHaveLength(0);
    }
  });

  it('is rate-limited to one update per 5 s', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx, startRadiusM } = flight;
    terrain.radiusM = TRUE_GROUND_M + 5;
    step(flight, startRadiusM - 100, 6_000);
    expect(groundOrders(ctx.sent)).toHaveLength(1);

    // Another 10 m a second later: too soon, so nothing goes out...
    terrain.radiusM = TRUE_GROUND_M + 15;
    step(flight, startRadiusM - 104, 1_000);
    expect(groundOrders(ctx.sent)).toHaveLength(1);
    // ...and at 5.2 s it does.
    step(flight, startRadiusM - 108, 4_200);
    expect(groundOrders(ctx.sent)).toHaveLength(2);
    expect((groundOrders(ctx.sent)[1]!.params as { groundRadiusM: number }).groundRadiusM).toBeCloseTo(
      TRUE_GROUND_M + 15,
      1,
    );
  });

  it('stops after 5 updates for one landing', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx, startRadiusM } = flight;
    let radius = startRadiusM;
    for (let i = 1; i <= 7; i += 1) {
      terrain.radiusM = TRUE_GROUND_M + 3 * i;
      radius -= 6;
      step(flight, radius, 5_500);
    }
    expect(groundOrders(ctx.sent), 'the cap is 5 per landing').toHaveLength(5);
    expect(audit(ctx.store, 'demo_landing_ground_update')).toHaveLength(5);
    expect((groundOrders(ctx.sent).at(-1)!.params as { groundRadiusM: number }).groundRadiusM).toBeCloseTo(
      TRUE_GROUND_M + 15,
      1,
    );
  });

  it('never updates the datum after touchdown', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx } = flight;
    // One update DOES go out mid-descent (so this test is not vacuous)...
    terrain.radiusM = TRUE_GROUND_M + 4;
    step(flight, TRUE_GROUND_M + 500, 6_000);
    expect(groundOrders(ctx.sent)).toHaveLength(1);
    // ...then touchdown: hull bottom 1.4 m above the true ground, at rest.
    step(flight, TRUE_GROUND_M + 5.4, 1_000, 0);
    expect(audit(ctx.store, 'demo_touchdown')).toHaveLength(1);
    const afterTouchdown = groundOrders(ctx.sent).length;
    terrain.radiusM = TRUE_GROUND_M + 25;
    step(flight, TRUE_GROUND_M + 5.4, 6_000, 0);
    step(flight, TRUE_GROUND_M + 5.4, 6_000, 0);
    expect(groundOrders(ctx.sent)).toHaveLength(afterTouchdown);
    expect(ctx.droneRow().step).toBe('landed');
  });
});

/**
 * LATE-DESCENT DATUM GUARD (2026-11-11, run set 2, HEAD 22cac9f).
 *
 * The measured failure: `land_at` handed the plugin 61 197.8 m (level 5) and
 * the backend then pushed 61 160.7 m (the level-0 planning field) while the
 * hull was at 18 m indicated AGL. The indicated AGL became 52.5 m in one tick,
 * the 21.4 m brake stopped being a brake, and the hull flew the last metres at
 * ~5 m/s until a 32.1 deg/s spin forced a safe abort at 39.6 m indicated.
 *
 * The rule now: an update that changes the AGL by more than max(5 m, 25 % of the
 * current AGL) below 150 m AGL is NOT sent - the backend orders `land_stop`
 * (the plugin's safe hover) and audits `ground datum disagreement`.
 */
describe('late-descent ground datum guard (2026-11-11)', () => {
  const JUMP_M = 37.1; // the measured level-5 -> level-0 jump

  it('refuses a 37.1 m datum jump at 18 m AGL and orders a safe hover instead', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx } = flight;
    // The hull is 18 m up; the next sample is the planning field, 37.1 m low.
    terrain.radiusM = TRUE_GROUND_M - JUMP_M;
    step(flight, TRUE_GROUND_M + 18, 6_000);

    expect(groundOrders(ctx.sent), 'the datum must NOT be pushed').toHaveLength(0);
    const holds = orders(ctx.sent).filter((m) => actionOf(m) === 'land_stop');
    expect(holds, 'the plugin is ordered into its safe hover').toHaveLength(1);
    expect(String((holds[0]!.params as { reason: string }).reason)).toContain('ground datum disagreement');

    const rows = audit(ctx.store, 'demo_landing_ground_disagreement');
    expect(rows).toHaveLength(1);
    const detail = rows[0]!.detail as {
      reason: string;
      deltaM: number;
      aglChangeM: number;
      allowedAglChangeM: number;
      hullBottomAglM: number;
      groundLevel: number;
      sent: boolean;
      holdOrderSent: boolean;
    };
    expect(detail.reason).toBe('ground datum disagreement');
    expect(detail.deltaM).toBeCloseTo(-JUMP_M, 1);
    expect(detail.aglChangeM).toBeCloseTo(JUMP_M, 1);
    expect(detail.hullBottomAglM).toBeCloseTo(18, 0);
    expect(detail.allowedAglChangeM).toBeCloseTo(5, 1); // max(5, 25 % of 18) = 5
    expect(detail.groundLevel).toBe(5);
    expect(detail.sent).toBe(false);
    expect(detail.holdOrderSent).toBe(true);
    // It holds once, not once per tick.
    step(flight, TRUE_GROUND_M + 17, 6_000);
    expect(orders(ctx.sent).filter((m) => actionOf(m) === 'land_stop')).toHaveLength(1);
  });

  it('allows the same correction high in the descent, above the 150 m band', () => {
    const terrain = { radiusM: TRUE_GROUND_M };
    const flight = descentWith(terrain);
    const { ctx } = flight;
    terrain.radiusM = TRUE_GROUND_M - JUMP_M;
    step(flight, TRUE_GROUND_M + 300, 6_000);
    expect(groundOrders(ctx.sent), 'a datum correction is legal where there is room').toHaveLength(1);
    expect(audit(ctx.store, 'demo_landing_ground_disagreement')).toHaveLength(0);
    expect(orders(ctx.sent).filter((m) => actionOf(m) === 'land_stop')).toHaveLength(0);
  });

  it('never pushes a planning-grade (level 0) sample as the descent datum', () => {
    // A column with only the level-0 field: the handover waits a bounded number
    // of ticks for the level-5 read, then goes out with the coarse datum
    // LABELLED - and no `land_ground` is ever sent from a coarse sample.
    const terrain = { radiusM: TRUE_GROUND_M };
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 200,
      startRadiusM: TRUE_GROUND_M + 300,
      terrainRadiusM: TRUE_GROUND_M,
      terrainRadius: () => terrain.radiusM,
      terrainLevel: 0,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: LAND_CONTROLLER,
    });
    ctx.executor.tick();
    answerInspect(ctx, SAT_LIFT_N);
    for (let i = 0; i < 8; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx);
    }
    const landAt = orders(ctx.sent).find((m) => actionOf(m) === 'land_at');
    expect(landAt, 'the descent still hands over (a descent never waits on terrain)').toBeTruthy();
    expect(audit(ctx.store, 'demo_landing_handover_deferred').length).toBeGreaterThan(0);
    expect(audit(ctx.store, 'demo_landing_handover_coarse')).toHaveLength(1);
    const handover = audit(ctx.store, 'demo_landing_handover')[0]!.detail as { groundLevel: number };
    expect(handover.groundLevel).toBe(0);

    // A 4 m move in the coarse sample (2 m is the push threshold) is not sent.
    terrain.radiusM = TRUE_GROUND_M + 4;
    ctx.clock.now += 6_000;
    ctx.place(TRUE_GROUND_M + 180, -4);
    ctx.executor.tick();
    ackAll(ctx);
    expect(groundOrders(ctx.sent)).toHaveLength(0);
    const coarse = audit(ctx.store, 'demo_landing_ground_coarse');
    expect(coarse).toHaveLength(1);
    expect((coarse[0]!.detail as { groundLevel: number; sent: boolean }).sent).toBe(false);
  });
});
