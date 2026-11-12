import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor, type ExecRow } from '../src/demo/executor.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { STATION_SURVIVAL_STOP_TIMEOUT_MS, convertToStationOrder } from '../src/demo/station.js';
import { makeConfig } from './helpers.js';

/**
 * T74: station conversion in survival mode.
 *
 * `zero_velocity` zeroes the physics body - it is a teleport, so the live build
 * may not send it. In survival the executor must stop the hull with dampeners,
 * poll its speed, and convert only under 0.5 m/s (SE refuses to freeze a moving
 * grid). These tests drive the real station pass over a drone that is already
 * `holding`, with a fake hub recording every order, and assert on the wire.
 */

const NOW = 1_800_000_000_000;

function setup(survivalMode: boolean) {
  const config = makeConfig({ flags: { demo_execute: true } });
  const db = openDb(':memory:', { memory: true });
  const store = new Store(db);
  const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  store.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true });
  const sent: Record<string, unknown>[] = [];
  const hub = {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
  } as never;
  const executor = new DemoExecutor({ store, hub, config, clock: () => NOW, fixturePath: null, survivalMode });

  const missionId = `m-${survivalMode ? 'survival' : 'test'}`;
  db.prepare(
    `INSERT INTO demo_exec (mission_id, state, scaled, total, cap, note, created_at, updated_at)
     VALUES (?, 'executing', 0, 1, 10, NULL, ?, ?)`,
  ).run(missionId, NOW - 60_000, NOW - 60_000);
  // A relay parked high above the fixture world: never below the ground floor,
  // so the station decision reaches the conversion rather than a refusal.
  store.upsertUnit({
    id: 'grid:relay-1',
    name: 'relay-1',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: 0, y: 0, z: 62_000 },
    vel: { x: 1.4, y: 0, z: 0 },
    meta: {},
  });
  db.prepare(
    `INSERT INTO demo_drones (mission_id, idx, label, prefab, role, planet, plan_slot_json, exec_slot_json,
        spawn_json, state, grid_id, attempts, reason, pending_order, pending_action, pending_at, hold_at,
        stop_sent_at, updated_at, step)
     VALUES (?, 0, 'relay-1', 'existing', 'relay', NULL, '{}', '{}', '{}', 'holding', 'grid:relay-1', 0, NULL,
        NULL, NULL, NULL, ?, NULL, ?, NULL)`,
  ).run(missionId, NOW - 120_000, NOW);
  const exec: ExecRow = {
    missionId,
    state: 'executing',
    scaled: false,
    total: 1,
    cap: 10,
    note: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
  };
  return { store, executor, sent, exec, missionId };
}

function actions(sent: Record<string, unknown>[]): string[] {
  return sent.map((o) => String((o.params as { action?: unknown } | undefined)?.action ?? o.orderType));
}

function setSpeed(store: Store, v: number): void {
  store.upsertUnit({
    id: 'grid:relay-1',
    name: 'relay-1',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: 0, y: 0, z: 62_000 },
    vel: { x: v, y: 0, z: 0 },
    meta: {},
  });
}

function droneRow(store: Store, missionId: string): { step: string | null; reason: unknown } {
  const row = store.db
    .prepare(`SELECT step, reason FROM demo_drones WHERE mission_id = ? AND idx = 0`)
    .get(missionId) as { step: string | null; reason: unknown };
  let reason: unknown = row.reason;
  if (typeof reason === 'string' && (reason.startsWith('"') || reason.startsWith('{'))) {
    try {
      reason = JSON.parse(reason);
    } catch {
      /* keep the raw string */
    }
  }
  return { step: row.step, reason };
}

/** Point the mission's planet at the fake world's HQ so terrain/gravity resolve. */
function droneAt(store: Store, missionId: string, pos: { x: number; y: number; z: number }, v: number): void {
  store.db.prepare(`UPDATE demo_drones SET planet = NULL WHERE mission_id = ? AND idx = 0`).run(missionId);
  store.upsertUnit({
    id: 'grid:relay-1',
    name: 'relay-1',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos,
    vel: { x: v, y: 0, z: 0 },
    meta: {},
  });
}

/**
 * Answer the `is_under_control` probe the station pass sends first: the drone is
 * put in `station_check` and only continues once the plugin answers. The fake
 * hub cannot round-trip, so write the order_result audit row the executor reads.
 */
function answerOrder(store: Store, sent: Record<string, unknown>[], result: unknown): void {
  const last = sent[sent.length - 1] as { orderId?: string; params?: { action?: string } } | undefined;
  if (!last?.orderId) return;
  const applied = store.db.prepare(`UPDATE orders SET status = 'acked' WHERE order_id = ?`).run(last.orderId);
  if (applied.changes === 0) return;
  store.audit({
    actor: 'fake-plugin',
    action: 'plugin_event',
    subject: last.orderId,
    detail: { eventType: 'order_result', data: { orderId: last.orderId, ok: true, error: null, result } },
    at: NOW,
  });
}

/**
 * One station pass plus the probe answer (not under manual control).
 *
 * The executor consumes an `order_result` on the pass AFTER the order is sent
 * (`stationPass` resolves `pendingOrder` before it decides anything), so a
 * single call here only sends the probe. Every test below therefore advances
 * one extra pass for the answer; nothing is asserted more weakly for it.
 */
function pass(store: Store, executor: DemoExecutor, exec: ExecRow, sent: Record<string, unknown>[], now: number): void {
  executor.stationPass(exec, now);
  answerOrder(store, sent, { underControl: false });
}

function auditActions(store: Store): string[] {
  return (store.listAudit(100) as { action: string }[]).map((a) => a.action);
}

describe('T74 station conversion', () => {
  it('survival: the stop is dampeners, never zero_velocity', () => {
    const { store, executor, sent, exec, missionId } = setup(true);
    setSpeed(store, 1.4);
    // The station decision needs a hold that has settled; the drone is already
    // holding and this drives the probe that gates the stop.
    pass(store, executor, exec, sent, NOW);
    expect(actions(sent)).toEqual(['is_under_control']);
    sent.length = 0;

    // The answer to the probe lands here: this is the pass that starts the stop.
    pass(store, executor, exec, sent, NOW + 1_000);

    expect(actions(sent)).not.toContain('zero_velocity');
    expect(sent.every((o) => (o.params as { action?: string })?.action !== 'zero_velocity')).toBe(true);
    const first = sent[0] as { orderType: string; params: Record<string, unknown> };
    expect(first.params.action).toBe('set_dampeners');
    expect(first.params.on).toBe(true);
    expect(droneRow(store, missionId).step).toBe('station_wait');
    expect(auditActions(store)).toContain('demo_station_stop');
    // The old stop is a teleport: it must never appear in survival.
    expect(auditActions(store)).not.toContain('demo_station_zero');
  });

  it('test build: keeps the zero_velocity path (the survival refusal is not global)', () => {
    const { store, executor, sent, exec } = setup(false);
    setSpeed(store, 1.4);
    pass(store, executor, exec, sent, NOW);
    sent.length = 0;
    pass(store, executor, exec, sent, NOW + 1_000);
    const acts = actions(sent);
    // The test path may reach the zero; what matters is that it is the OLD path.
    expect(acts.includes('set_dampeners') && acts.includes('zero_velocity')).toBe(false);
    expect(acts).toContain('zero_velocity');
    expect(droneRow(store, `m-test`).step).toBe('station_zeroing');
  });

  it('survival: a hull above 0.5 m/s is polled, not converted', () => {
    const { store, executor, sent, exec, missionId } = setup(true);
    setSpeed(store, 1.4);
    pass(store, executor, exec, sent, NOW);          // probe
    pass(store, executor, exec, sent, NOW + 1_000);  // dampeners on
    sent.length = 0;

    // Still creeping: the executor must poll, never convert a moving body.
    pass(store, executor, exec, sent, NOW + 2_000);
    expect(actions(sent)).toEqual([]);
    expect(droneRow(store, missionId).step).toBe('station_wait');
  });

  it('survival: a slow hull is converted with zone=survival and no zeroing in the whole pass', () => {
    const { store, executor, sent, exec, missionId } = setup(true);
    setSpeed(store, 1.4);
    pass(store, executor, exec, sent, NOW);           // probe
    pass(store, executor, exec, sent, NOW + 1_000);   // starts the dampener stop
    sent.length = 0;

    // Dampeners have done their work: the hull now reports 0.2 m/s.
    setSpeed(store, 0.2);
    pass(store, executor, exec, sent, NOW + 2_000);

    expect(actions(sent)).toEqual(['convert_to_station']);
    const order = sent[0] as { params: Record<string, unknown> };
    expect(order.params.zone).toBe('survival');
    // The order the plugin gets is the survival one: dampeners were the stop,
    // so there is no zeroing step to send.
    expect(order.params).not.toHaveProperty('zeroVelocity');
    expect(convertToStationOrder('grid:relay-1')).toMatchObject({ force: false });
    expect(droneRow(store, missionId).step).toBe('stationing');

    // The plugin confirms the freeze: only `isStaticAfter === true` stations it.
    answerOrder(store, sent, { isStaticAfter: true, speedBeforeMs: 0.2, positionDriftM: 0.4, aglM: 62_000 });
    executor.stationPass(exec, NOW + 3_000);
    expect(droneRow(store, missionId).step).toBe('stationed');
    const stationed = (store.listAudit(100) as { action: string; detail?: { static?: boolean; speedMs?: number } }[]).find(
      (a) => a.action === 'demo_station',
    );
    expect(stationed?.detail?.static).toBe(true);
    expect(stationed?.detail?.speedMs).toBe(0.2);
    expect(actions(sent)).not.toContain('zero_velocity');
  });

  it('survival: a refused conversion retries with dampeners, capped at 3 and never zeroing', () => {
    const { store, executor, sent, exec, missionId } = setup(true);
    setSpeed(store, 1.4);
    pass(store, executor, exec, sent, NOW);           // probe
    pass(store, executor, exec, sent, NOW + 1_000);   // dampeners
    setSpeed(store, 0.2);

    // Three conversions, each refused by the plugin (`isStaticAfter` absent ->
    // the grid did not freeze). Every retry is dampeners + wait, never a zero.
    let t = NOW + 2_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pass(store, executor, exec, sent, t);           // convert attempt
      expect(actions(sent).filter((a) => a === 'convert_to_station')).toHaveLength(attempt);
      pass(store, executor, exec, sent, t + 1_000);   // refusal -> dampeners
      t += 2_000;
    }

    const row = droneRow(store, missionId);
    expect(row.step).toBeNull();
    expect(row.reason).toMatch(/station refused after 3 tries/);
    expect(actions(sent)).not.toContain('zero_velocity');
    expect(auditActions(store).filter((a) => a === 'demo_station_retry')).toHaveLength(2);
  });

  it('survival: a hull that never slows gives up honestly after the timeout, still without a zeroing', () => {
    const { store, executor, sent, exec, missionId } = setup(true);
    setSpeed(store, 2.0);
    pass(store, executor, exec, sent, NOW);           // probe
    pass(store, executor, exec, sent, NOW + 1_000);   // dampeners: the stop clock starts
    sent.length = 0;

    // Keep it at 2.0 m/s: dampeners have failed (no controller, blocked thrust).
    setSpeed(store, 2.0);
    pass(store, executor, exec, sent, NOW + 1_000 + STATION_SURVIVAL_STOP_TIMEOUT_MS + 1);

    expect(actions(sent)).not.toContain('zero_velocity');
    expect(actions(sent)).not.toContain('convert_to_station');
    const row = droneRow(store, missionId);
    // A timed-out station attempt ends the step: the ship stays a ship, hovering
    // with dampeners on, instead of lingering in station_wait forever.
    expect(row.step).toBeNull();
    expect(row.reason).toMatch(/dampeners did not bring it under/);
    expect(row.reason).toMatch(/not zeroing the velocity in survival/);
    expect(auditActions(store)).toContain('demo_station_stop_timeout');
  });
});

describe('T74 survival mode: harness spawn, clone and cleanup', () => {
  it('survival: cleanup cannot delete a grid; it is refused and audited once', () => {
    const { store, executor, sent } = setup(true);
    store.db
      .prepare(
        `INSERT INTO demo_spawned (grid_id, mission_id, idx, name, spawned_at, deleted_at)
         VALUES ('grid:debris', 'm-survival', 0, 'debris', ?, NULL)`,
      )
      .run(NOW - 120_000);
    const result = executor.cleanupStale(1, NOW, false);
    expect(result.deleted).toEqual([]);
    expect(actions(sent)).not.toContain('delete_grid');
    const refused = (store.listAudit(50) as { action: string; subject: string }[]).filter(
      (a) => a.action === 'survival_refused' && a.subject === 'grid:debris',
    );
    expect(refused).toHaveLength(1);
  });

  it('test build: cleanup still deletes debris', () => {
    const { store, executor, sent } = setup(false);
    store.db
      .prepare(
        `INSERT INTO demo_spawned (grid_id, mission_id, idx, name, spawned_at, deleted_at)
         VALUES ('grid:debris', 'm-test', 0, 'debris', ?, NULL)`,
      )
      .run(NOW - 120_000);
    const result = executor.cleanupStale(1, NOW, false);
    expect(result.deleted).toEqual(['grid:debris']);
    expect(actions(sent)).toContain('delete_grid');
  });
});
