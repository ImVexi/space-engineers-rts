/**
 * Landing 2026-11-11 flight set 6: the handover seam, the slot datum and the
 * hold column.
 *
 * WHAT WAS MEASURED (data/flight-proof-20261111.md, "Run set 6"):
 *
 *  1. SPIN AT HANDOVER. Run 2c flew the lateral leg from 200.5 m to 4.6 m of
 *     the requested column at 772 m AGL, then the plugin refused the start —
 *     `spinning at 80.5 deg/s (over 30 deg/s)` — because the last autopilot
 *     turn onto the waypoint was still unwinding. Eight seconds later the idle
 *     watchdog aborted the mission at 793 m AGL; the hull was intact and
 *     hovering. Nothing ever held the hull between the leg and `land_at`.
 *  2. COARSE SLOT DATUM. Run 2a: a `land:true` target's ground radius came from
 *     the level-0 planning field, 47 m under the real terrain, so the executor
 *     flew a plain 5 m/s move to an underground point, crawled 17 m and tripped
 *     `guard-stuck`. No landing.
 *  3. LAND:TRUE AT THE SLOT. Run 2f: nine metres above its own column with
 *     `land:true`, the executor sent one `move` and one `hold` in 1.3 s and
 *     never handed over. A landing that is already low did not land.
 *  4. holdTarget*. The plugin writes `holdTargetSource`,
 *     `holdTargetFromHandoverM` and `holdTargetRefusal` into the `land_status`
 *     JSON payload only (`LandController.cs`): the human log line did not print
 *     them and the backend never read them, so no flight could say which column
 *     the hold was on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LANDING_SETTLE_MAX_MS,
  LANDING_SETTLE_SPIN_MAX_DEG_S,
  LANDING_SLOT_DATUM_WAITS,
} from '../src/demo/flight.js';
import { clearGroundCache, groundColumnKey, rememberColumnGround } from '../src/demo/ground.js';
import {
  PLANET,
  TRUE_GROUND_M,
  ackAll,
  actionOf,
  answerInspect,
  audit,
  moves,
  orders,
  setup,
} from './landing-support.js';

const SAT_LIFT_N = 982_956;
const LAND_CONTROLLER = ['telemetry', 'orders', 'land_controller'];
const START_AGL = 300;

type Ctx = ReturnType<typeof setup>;

function tick(ctx: Ctx): void {
  ctx.executor.tick();
  ackAll(ctx);
}

const landAtOrders = (ctx: Ctx) => orders(ctx.sent).filter((m) => actionOf(m) === 'land_at');
/** Every `hold` order (the move+hold shape a low landing must never produce). */
const holds = (sent: Record<string, unknown>[]) =>
  orders(sent).filter((m) => m.orderType === 'hold' || actionOf(m) === 'hold');
const settleRows = (ctx: Ctx) => audit(ctx.store, 'demo_landing_settle');
const settleAction = (row: { detail: unknown }) => (row.detail as { action?: string }).action;
const idleAborts = (ctx: Ctx) =>
  audit(ctx.store, 'demo_landing_idle').filter(
    (r) => (r.detail as { action?: string }).action === 'abort',
  );

/** Answer the measured-lift inspect the way the fake hub does. */
function measure(ctx: Ctx): void {
  answerInspect(ctx, SAT_LIFT_N);
}

/** A plugin landing 180 m off the requested column, at 300 m AGL. */
function start(offsetM = 180, opts: { spinDegS?: number; speedMps?: number } = {}): Ctx {
  const radius = TRUE_GROUND_M + START_AGL;
  const ctx = setup({
    slotRadiusM: radius,
    startRadiusM: radius,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
    capabilities: LAND_CONTROLLER,
  });
  ctx.place(radius, opts.speedMps ?? 0, ctx.clock.now, offsetM, 'up', {
    spinDegS: opts.spinDegS ?? 0.5,
  });
  tick(ctx);
  measure(ctx);
  ctx.place(radius, opts.speedMps ?? 0, ctx.clock.now, offsetM, 'up', {
    spinDegS: opts.spinDegS ?? 0.5,
  });
  tick(ctx);
  return ctx;
}

/** Fly the hull onto the requested column (the lateral leg's arrival). */
function arriveOnColumn(ctx: Ctx, opts: { spinDegS?: number; speedMps?: number } = {}): void {
  ctx.clock.now += 10_000;
  ctx.place(TRUE_GROUND_M + START_AGL, opts.speedMps ?? 0, ctx.clock.now, 4, 'up', {
    spinDegS: opts.spinDegS ?? 0.5,
  });
  tick(ctx);
}

/** Push the plugin's `order_result` for an order id, the way the hub does. */
function orderResult(ctx: Ctx, orderId: string, ok: boolean, result: Record<string, unknown> | null, error?: string): void {
  ctx.store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: {
      eventType: 'order_result',
      data: { orderId, ok, ...(error !== undefined ? { error } : {}), ...(result ? { result } : {}) },
    },
    at: ctx.clock.now,
  });
}

/**
 * Overwrite the execution slot. `landingSlotFor` computes it from the terrain
 * field at mission creation, so the only way to model a slot that was pushed
 * out on a COARSE datum is to write the number the old code would have written.
 */
function setExecSlot(ctx: Ctx, point: { x: number; y: number; z: number }): void {
  ctx.store.db
    .prepare('UPDATE demo_drones SET exec_slot_json = ? WHERE mission_id = ?')
    .run(JSON.stringify(point), ctx.mission.id);
}

beforeEach(() => {
  clearGroundCache();
});

describe('set 6 / 1: a spinning hull is settled before land_at, never aborted', () => {
  it('holds the hull after the lateral leg and only hands over once the rate is damped', () => {
    const ctx = start(180, { spinDegS: 80.5, speedMps: 12 });
    // The lateral leg's arrival is the moment the plugin refused the start.
    ctx.clock.now += 10_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 12, ctx.clock.now, 4, 'up', { spinDegS: 80.5 });
    tick(ctx);

    expect(audit(ctx.store, 'demo_landing_lateral_done'), 'the leg arrived').toHaveLength(1);
    expect(landAtOrders(ctx), 'a spinning hull is NOT handed over').toHaveLength(0);
    const begin = settleRows(ctx).find((r) => settleAction(r) === 'start');
    expect(begin, 'the settle must start').toBeTruthy();
    const detail = begin!.detail as {
      spinDegS: number;
      speedMps: number;
      spinLimitDegS: number;
      maxSettleS: number;
      mechanism: string;
    };
    expect(detail.spinDegS).toBeCloseTo(80.5, 1);
    expect(detail.speedMps).toBeCloseTo(12, 1);
    expect(detail.spinLimitDegS).toBe(LANDING_SETTLE_SPIN_MAX_DEG_S);
    expect(detail.maxSettleS).toBe(LANDING_SETTLE_MAX_MS / 1000);
    expect(detail.mechanism).toBe('autopilot-off+dampeners-on');

    // Held: the dampeners are re-asserted, nothing is declared dead.
    ctx.clock.now += 3_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 2, ctx.clock.now, 4, 'up', { spinDegS: 40 });
    tick(ctx);
    expect(landAtOrders(ctx), 'still spinning at 40 deg/s: no handover').toHaveLength(0);
    expect(settleRows(ctx).filter((r) => settleAction(r) === 'hold').length).toBeGreaterThan(0);
    expect(idleAborts(ctx), 'the settle must never be read as a dead landing phase').toHaveLength(0);

    // Damped: hand over, exactly once.
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0.2, ctx.clock.now, 4, 'up', { spinDegS: 0.8 });
    tick(ctx);
    const settled = settleRows(ctx).find((r) => settleAction(r) === 'settled');
    expect(settled, 'the settle records why it let go').toBeTruthy();
    expect((settled!.detail as { spinDegS: number }).spinDegS).toBeCloseTo(0.8, 1);
    expect(landAtOrders(ctx), 'one land_at after the settle').toHaveLength(1);
    expect(audit(ctx.store, 'demo_landing_handover')).toHaveLength(1);
  });

  it('hands over anyway when the settle budget runs out (the plugin gate decides)', () => {
    const ctx = start(180, { spinDegS: 80.5, speedMps: 12 });
    ctx.clock.now += 10_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 12, ctx.clock.now, 4, 'up', { spinDegS: 80.5 });
    tick(ctx);
    expect(landAtOrders(ctx)).toHaveLength(0);
    ctx.clock.now += LANDING_SETTLE_MAX_MS + 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 12, ctx.clock.now, 4, 'up', { spinDegS: 80.5 });
    tick(ctx);
    expect(landAtOrders(ctx), 'a bounded settle never blocks a landing forever').toHaveLength(1);
    expect(settleRows(ctx).find((r) => settleAction(r) === 'timeout')).toBeTruthy();
    expect(idleAborts(ctx)).toHaveLength(0);
  });

  it('retries land_at ONCE after settling instead of aborting on a spin refusal', () => {
    const ctx = start(180, { spinDegS: 0.5 });
    arriveOnColumn(ctx, { spinDegS: 0.5 });
    const first = landAtOrders(ctx);
    expect(first, 'a settled hull is handed over immediately').toHaveLength(1);
    const orderId = String(first[0]!.orderId);

    // The refusal the set-6 run produced.
    orderResult(ctx, orderId, false, { started: false }, 'spinning at 80.5 deg/s (over 30 deg/s): settle the hull before landing');
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 8, ctx.clock.now, 4, 'up', { spinDegS: 80.5 });
    tick(ctx);

    const retry = audit(ctx.store, 'demo_landing_start_retry');
    expect(retry, 'one settle-and-retry, not an abort').toHaveLength(1);
    expect((retry[0]!.detail as { retry: number; of: number }).of).toBe(1);
    expect(audit(ctx.store, 'demo_landing_handover_aborted')).toHaveLength(0);
    expect(droneState(ctx)).not.toBe('aborted');
    expect(settleRows(ctx).some((r) => settleAction(r) === 'start')).toBe(true);

    // Settled again: the second land_at goes out.
    ctx.clock.now += 2_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0.1, ctx.clock.now, 4, 'up', { spinDegS: 0.4 });
    tick(ctx);
    expect(landAtOrders(ctx), 'the retry re-issues land_at').toHaveLength(2);
  });

  it('does NOT retry an in-flight spin abort (the 10 deg/s rule is the plugin own)', () => {
    const ctx = start(180, { spinDegS: 0.5 });
    arriveOnColumn(ctx, { spinDegS: 0.5 });
    const orderId = String(landAtOrders(ctx)[0]!.orderId);
    orderResult(ctx, orderId, false, null, 'spinning at 18 deg/s in descending: the hull is not under attitude control');
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL - 60, 5, ctx.clock.now, 4, 'up', { spinDegS: 18 });
    tick(ctx);
    expect(audit(ctx.store, 'demo_landing_start_retry')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_landing_handover_aborted')).toHaveLength(1);
  });
});

function droneState(ctx: Ctx): string {
  return ctx.droneRow().state;
}

describe('set 6 / 2: the landing slot is put on a landing-grade datum', () => {
  it('moves the slot onto the level-5 sample instead of flying to a point 47 m underground', () => {
    // The slot was pushed out on the coarse planning field: 47 m low.
    const coarseSlot = TRUE_GROUND_M - 47;
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M,
      startRadiusM: TRUE_GROUND_M + START_AGL,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: LAND_CONTROLLER,
    });
    setExecSlot(ctx, { x: 0, y: 0, z: coarseSlot });
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 120, 'up', { spinDegS: 0.5 });
    tick(ctx);
    measure(ctx);
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 120, 'up', { spinDegS: 0.5 });
    tick(ctx);

    const refine = audit(ctx.store, 'demo_landing_slot_datum').find(
      (r) => (r.detail as { action?: string }).action === 'refined',
    );
    expect(refine, 'the slot must be moved onto the measured ground').toBeTruthy();
    const detail = refine!.detail as { fromRadiusM: number; toRadiusM: number; deltaM: number; level: number };
    expect(detail.fromRadiusM).toBeCloseTo(coarseSlot, 0);
    expect(detail.toRadiusM).toBeCloseTo(TRUE_GROUND_M, 0);
    expect(detail.deltaM).toBeCloseTo(47, 0);
    expect(detail.level).toBe(5);
    // And the leg now targets the real ground point, not the underground one.
    const slot = JSON.parse(ctx.droneRow().exec_slot_json) as { z: number };
    expect(slot.z).toBeCloseTo(TRUE_GROUND_M, 0);
    expect(audit(ctx.store, 'demo_hold_refused'), 'the underground slot is never flown').toHaveLength(0);
  });

  it('waits a bounded number of ticks and then REFUSES when only the slot column is coarse', () => {
    // The hull's column has a landing-grade sample; the target column only has
    // the level-0 planning field, 47 m low. That is the set-6 disagreement.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M - 47,
      startRadiusM: TRUE_GROUND_M + START_AGL,
      terrainRadiusM: TRUE_GROUND_M - 47,
      terrainRadius: () => TRUE_GROUND_M - 47,
      terrainLevel: 0,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: LAND_CONTROLLER,
    });
    setExecSlot(ctx, { x: 0, y: 0, z: TRUE_GROUND_M - 47 });
    // The ship's own column is cached as landing grade (the level-5 SETR sample
    // an operator takes), the slot column is left on the coarse field.
    const radius = TRUE_GROUND_M + START_AGL;
    const shipDir = { x: 120 / radius, y: 0, z: Math.sqrt(1 - (120 / radius) ** 2) };
    rememberColumnGround(PLANET, shipDir, { radiusM: TRUE_GROUND_M, source: 'terrain-l5', level: 5 });
    ctx.place(radius, 0, ctx.clock.now, 120, 'up', { spinDegS: 0.5 });
    expect(groundColumnKey(PLANET, shipDir)).toBeTruthy();

    tick(ctx);
    for (let i = 0; i < LANDING_SLOT_DATUM_WAITS + 2; i += 1) {
      ctx.clock.now += 1_000;
      ctx.place(radius, 0, ctx.clock.now, 120, 'up', { spinDegS: 0.5 });
      tick(ctx);
    }
    const wait = audit(ctx.store, 'demo_landing_slot_datum_wait');
    expect(wait.length, 'the fine read is awaited, not assumed').toBeGreaterThan(0);
    const refused = audit(ctx.store, 'demo_landing_slot_datum').find(
      (r) => (r.detail as { action?: string }).action === 'refused',
    );
    expect(refused, 'a knowingly-wrong datum is refused with both numbers').toBeTruthy();
    const detail = refused!.detail as { slotLevel: number; shipLevel: number; belowM: number; reason: string };
    expect(detail.shipLevel).toBe(5);
    expect(detail.belowM).toBeCloseTo(47, 0);
    expect(detail.reason).toMatch(/planning grade/);
    expect(detail.reason).toMatch(/refusing to fly the descent/);
    // Nothing was flown onto the underground slot: the only move is the
    // refusal's own dampened hold, which targets a point ABOVE the ground.
    for (const move of moves(ctx.sent)) {
      const point = move.params as { z: number };
      expect(point.z).toBeGreaterThan(TRUE_GROUND_M);
    }
    expect(landAtOrders(ctx), 'no land_at onto a refused datum').toHaveLength(0);
  });
});

describe('set 6 / 3: land:true at the slot runs the landing sequence', () => {
  it('hands a low hull to land_at instead of sending move + hold', () => {
    const radius = TRUE_GROUND_M + 9;
    const ctx = setup({
      slotRadiusM: radius,
      startRadiusM: radius,
      terrainRadiusM: TRUE_GROUND_M,
      desired: { land: true },
      speedLimitMps: 100,
      capabilities: LAND_CONTROLLER,
    });
    ctx.place(radius, 0, ctx.clock.now, 0, 'up', { spinDegS: 0.4 });
    tick(ctx);
    measure(ctx);
    ctx.place(radius, 0, ctx.clock.now, 0, 'up', { spinDegS: 0.4 });
    tick(ctx);

    const low = audit(ctx.store, 'demo_landing_low');
    expect(low, 'the low landing is recorded').toHaveLength(1);
    expect((low[0]!.detail as { mechanism: string }).mechanism).toBe('plugin-land');
    expect(landAtOrders(ctx), 'the low landing hands over to land_at').toHaveLength(1);
    expect(moves(ctx.sent), 'no move-to-the-slot-then-hold').toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(0);
    expect(droneState(ctx)).not.toBe('aborted');
  });
});

describe('set 6 / 4: the hold column the plugin reports reaches the audit', () => {
  it('records holdTargetSource / holdTargetFromHandoverM from the land_at result', () => {
    const ctx = start(180, { spinDegS: 0.5 });
    arriveOnColumn(ctx, { spinDegS: 0.5 });
    const orderId = String(landAtOrders(ctx)[0]!.orderId);
    expect(audit(ctx.store, 'demo_landing_hold_target')).toHaveLength(0);

    orderResult(ctx, orderId, true, {
      phase: 'settling',
      holdTargetSource: 'order',
      holdTargetFromHandoverM: 4.6,
    });
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 4, 'up', { spinDegS: 0.5 });
    tick(ctx);

    const row = audit(ctx.store, 'demo_landing_hold_target');
    expect(row, 'the backend must ingest the fields it used to drop').toHaveLength(1);
    const detail = row[0]!.detail as { source: string; fromHandoverM: number; refusal: string | null; note: string };
    expect(detail.source).toBe('order');
    expect(detail.fromHandoverM).toBeCloseTo(4.6, 1);
    expect(detail.refusal).toBeNull();
    expect(detail.note).toMatch(/REQUESTED landing column/);

    // Once per order, not once per tick.
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL - 10, 1, ctx.clock.now, 4, 'up', { spinDegS: 0.5 });
    tick(ctx);
    expect(audit(ctx.store, 'demo_landing_hold_target')).toHaveLength(1);
  });

  it('records a refused hold target with the plugin own sentence', () => {
    const ctx = start(180, { spinDegS: 0.5 });
    arriveOnColumn(ctx, { spinDegS: 0.5 });
    const orderId = String(landAtOrders(ctx)[0]!.orderId);
    orderResult(ctx, orderId, true, {
      phase: 'settling',
      holdTargetSource: 'handover',
      holdTargetFromHandoverM: 182,
      holdTargetRefusal: 'target too far for hold (182 m > 30 m): holding the handover column',
    });
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 4, 'up', { spinDegS: 0.5 });
    tick(ctx);
    const detail = audit(ctx.store, 'demo_landing_hold_target')[0]!.detail as {
      source: string;
      refusal: string | null;
      note: string;
    };
    expect(detail.source).toBe('handover');
    expect(detail.refusal).toMatch(/target too far for hold/);
    expect(detail.note).toMatch(/REFUSED the ordered column/);
  });

  it('stays silent when the plugin does not report the fields at all (an old build)', () => {
    const ctx = start(180, { spinDegS: 0.5 });
    arriveOnColumn(ctx, { spinDegS: 0.5 });
    const orderId = String(landAtOrders(ctx)[0]!.orderId);
    orderResult(ctx, orderId, true, { phase: 'settling' });
    ctx.clock.now += 1_000;
    ctx.place(TRUE_GROUND_M + START_AGL, 0, ctx.clock.now, 4, 'up', { spinDegS: 0.5 });
    tick(ctx);
    expect(audit(ctx.store, 'demo_landing_hold_target')).toHaveLength(0);
  });
});
