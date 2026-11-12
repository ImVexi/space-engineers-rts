/**
 * Landed missions recorded FAILED (2026-11-11).
 *
 * In game a hull touched down, the touchdown rule fired, `finishLanding` sent
 * the gear-lock `set_block_props`, and the plugin REJECTED it (the deployed
 * build cast the `type` array to a string, fixed plugin-side in cf3e70b). The
 * backend then retried the housekeeping order, hit `MAX_SAVE_ATTEMPTS` and
 * marked the mission FAILED — for a ship sitting on the ground.
 *
 * The rule these tests pin: AFTER a confirmed touchdown, a failed/rejected
 * housekeeping order (gear lock, magnetic plate, save attempt) is a WARNING
 * recorded on a completed landing (audit row + mission note naming the step).
 * A failure BEFORE touchdown is still a real FAILED mission.
 */
import { describe, expect, it } from 'vitest';
import { TRUE_GROUND_M, actionOf, ackAll, answerInspect, audit, orders, setup } from './landing-support.js';

const SAT_LIFT_N = 982_956;
/** The plugin's hello that switches the final descent to `land_at`. */
const LAND_CONTROLLER = ['telemetry', 'orders', 'land_controller'];

interface Ctx {
  ctx: ReturnType<typeof setup>;
  /** The touchdown gear/plate lock order (filter.type is an array). */
  gear: Record<string, unknown>;
}

/** Drive one plugin-land mission to a CONFIRMED touchdown (ship at rest, 1.4 m). */
function landWithPlugin(): Ctx {
  const ctx = setup({
    slotRadiusM: TRUE_GROUND_M + 2_000,
    startRadiusM: TRUE_GROUND_M + 2_000,
    terrainRadiusM: TRUE_GROUND_M,
    desired: { land: true },
    speedLimitMps: 100,
    capabilities: LAND_CONTROLLER,
  });
  ctx.executor.tick();
  answerInspect(ctx, SAT_LIFT_N);
  ctx.executor.tick();
  // The plugin acks the handover the way the land controller does; until an
  // order resolves the executor does not advance the flight.
  const landAt = orders(ctx.sent).find((m) => actionOf(m) === 'land_at');
  if (!landAt) throw new Error('no land_at handover order was sent');
  ctx.store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: {
      eventType: 'order_result',
      data: { orderId: String(landAt.orderId), ok: true, result: { started: true, gridId: 'grid:land', phase: 'descending' } },
    },
    at: ctx.clock.now,
  });
  ctx.store.updateOrder(String(landAt.orderId), { status: 'acked', ackedAt: ctx.clock.now });
  // Telemetry: the hull bottom is 1.4 m above the true ground, at rest. This is
  // the touchdown the backend watched in game (<= 2 m, <= 0.5 m/s).
  ctx.clock.now += 1_000;
  ctx.place(TRUE_GROUND_M + 1.4, 0);
  ctx.executor.tick();
  const gear = orders(ctx.sent).find(
    (m) => actionOf(m) === 'set_block_props' && Array.isArray((m.params as { filter?: { type?: unknown } }).filter?.type),
  );
  if (!gear) throw new Error('no gear-lock order was sent at touchdown');
  return { ctx, gear };
}

/** Answer one order the way the plugin does: acked, with `ok:false`. */
function nack(ctx: ReturnType<typeof setup>, orderId: string, error: string): void {
  ctx.store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: { eventType: 'order_result', data: { orderId, ok: false, error } },
    at: ctx.clock.now,
  });
  ctx.store.updateOrder(orderId, { status: 'acked', ackedAt: ctx.clock.now });
}

const execRow = (ctx: ReturnType<typeof setup>) =>
  ctx.store.db.prepare('SELECT state, note FROM demo_exec WHERE mission_id = ?').get(ctx.mission.id) as {
    state: string;
    note: string | null;
  };

describe('landed missions: a rejected housekeeping order is a WARNING', () => {
  it('records the warning, keeps the landing and completes the mission as done', () => {
    const { ctx, gear } = landWithPlugin();
    // Touchdown is already on the record, and the hull is a landed ship.
    expect(audit(ctx.store, 'demo_touchdown')).toHaveLength(1);
    expect(ctx.droneRow().state).toBe('holding');
    expect(ctx.droneRow().step).toBe('landed');

    // The plugin rejects the gear lock and the executor is out of attempts.
    ctx.store.db.prepare('UPDATE demo_drones SET attempts = 3 WHERE mission_id = ?').run(ctx.mission.id);
    nack(ctx, String(gear.orderId), 'set_block_props: unknown filter type (expected string)');
    ctx.clock.now += 1_000;
    ctx.executor.tick();

    // Not FAILED: the mission completes as landed, with a warning that names
    // the step that failed.
    expect(ctx.droneRow().state, 'a landed hull must never be marked failed').toBe('holding');
    expect(ctx.droneRow().step).toBe('landed');
    const warning = audit(ctx.store, 'demo_landing_housekeeping_warning');
    expect(warning, 'exactly one warning row').toHaveLength(1);
    const detail = warning[0]!.detail as { failedAction: string; level: string; gridId: string };
    expect(detail.failedAction).toBe('set_block_props');
    expect(detail.level).toBe('warning');
    expect(detail.gridId).toBe('grid:land');
    // The mission note names it too (executions[].note).
    const exec = execRow(ctx);
    expect(String(exec.note)).toMatch(/housekeeping order set_block_props failed/);
    expect(String(exec.note)).toMatch(/unknown filter type/);
    // ...and the mission itself is done, not failed.
    expect(exec.state).toBe('done');
    expect(ctx.store.getMission(ctx.mission.id)?.status).toBe('done');
    expect(audit(ctx.store, 'demo_drone_state').filter((r) => (r.detail as { state?: string }).state === 'failed')).toHaveLength(0);
  });

  it('a housekeeping order that never acks is the same warning, not a failure', () => {
    const { ctx, gear } = landWithPlugin();
    ctx.store.db.prepare('UPDATE demo_drones SET attempts = 3 WHERE mission_id = ?').run(ctx.mission.id);
    // Accepted by the plugin but never answered, past ORDER_TIMEOUT_MS (25 s).
    ctx.store.updateOrder(String(gear.orderId), { status: 'sent', ackedAt: null });
    ctx.clock.now += 30_000;
    ctx.executor.tick();
    expect(ctx.droneRow().state).toBe('holding');
    const warning = audit(ctx.store, 'demo_landing_housekeeping_warning');
    expect(warning).toHaveLength(1);
    expect(String((warning[0]!.detail as { reason?: string }).reason)).toMatch(/no ack/);
    expect(execRow(ctx).state).toBe('done');
  });

  it('a failure BEFORE touchdown is still a FAILED mission (the rule is not a blanket amnesty)', () => {
    // An ordinary move mission; the move is rejected three times by the plugin.
    const ctx = setup({
      slotRadiusM: TRUE_GROUND_M + 2_000,
      startRadiusM: TRUE_GROUND_M,
      terrainRadiusM: TRUE_GROUND_M,
      desired: {},
      speedLimitMps: 100,
    });
    ctx.executor.tick();
    const move = orders(ctx.sent).find((m) => m.orderType === 'move');
    if (!move) throw new Error('no move order was sent');
    ctx.store.db.prepare('UPDATE demo_drones SET attempts = 3 WHERE mission_id = ?').run(ctx.mission.id);
    nack(ctx, String(move.orderId), 'move refused: no remote control');
    ctx.executor.tick();
    // No touchdown happened, so the old rule applies: the flight failed.
    expect(audit(ctx.store, 'demo_landing_housekeeping_warning')).toHaveLength(0);
    expect(ctx.droneRow().state).toBe('failed');
    expect(String(ctx.droneRow().reason)).toMatch(/move failed 3x/);
  });
});
