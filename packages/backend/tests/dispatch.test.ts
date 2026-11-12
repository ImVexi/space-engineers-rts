import { describe, expect, it } from 'vitest';
import { Dispatcher, type OrderSender } from '../src/dispatcher.js';
import { createMission, approveMission, cancelMission } from '../src/missions.js';
import { recordLoss } from '../src/budgets.js';
import type { Store } from '../src/store.js';
import { makeClock, memoryStore, missionInput, unit } from './helpers.js';

class RecordingSender implements OrderSender {
  sent: Record<string, unknown>[] = [];
  connected = true;
  send(message: unknown): boolean {
    if (!this.connected) return false;
    this.sent.push(message as Record<string, unknown>);
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  agentId(): string | null {
    return this.connected ? 'fake-plugin' : null;
  }
}

const CTX = { autoMissionTypes: [] as string[], maxQueuedBuilds: 8 };

function setup(overrides: { maxOrdersPerMinute?: number } = {}) {
  const clock = makeClock();
  const store = memoryStore(clock.now);
  const sender = new RecordingSender();
  const dispatcher = new Dispatcher(
    store,
    sender,
    {
      maxAttempts: 3,
      backoffMs: 500,
      maxOrdersPerMinute: overrides.maxOrdersPerMinute ?? 60,
      comms: {},
    },
    clock.now,
  );
  return { clock, store, sender, dispatcher };
}

function approvedMission(
  store: Store,
  now: number,
  assignedUnits: string[],
  overrides: Record<string, unknown> = {},
) {
  const created = createMission(store, missionInput({ assignedUnits, ...overrides }), {
    now,
    actor: 'test',
    ...CTX,
  });
  if (!created.ok) throw new Error(`mission create failed: ${created.message}`);
  const approved = approveMission(store, created.mission.id, 'test', now);
  if (!approved.ok) throw new Error('approve failed');
  return approved.mission;
}

function runtimeOrderCount(store: Store, missionId: string): number {
  return store.listOrders(missionId).length;
}

function seedUnits(store: Store, now: number) {
  store.upsertUnit(unit({ id: 'grid:a', name: 'A', lastSeen: now }));
  store.upsertUnit(unit({ id: 'grid:b', name: 'B', linkStatus: 'down', lastSeen: now }));
  store.upsertUnit(unit({ id: 'grid:c', name: 'C', linkStatus: 'up', lastSeen: now - 31_000 }));
}

describe('dispatcher: comms authority', () => {
  it('only sends orders to reachable units', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a', 'grid:b', 'grid:c']);

    const result = dispatcher.cycle();
    expect(result.sent).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.entityId).toBe('grid:a');
    expect(result.suppressed).toEqual(
      expect.arrayContaining(['grid:b', 'grid:c'].map((u) => expect.stringContaining(u))),
    );
    expect(store.countAudit('order_suppressed')).toBeGreaterThanOrEqual(2);
    expect(store.listOrders()).toHaveLength(1);
  });

  it('sends nothing when the plugin is offline', () => {
    const { clock, store, sender, dispatcher } = setup();
    sender.connected = false;
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a']);

    dispatcher.cycle();
    expect(sender.sent).toHaveLength(0);
    const orders = store.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe('pending');
    expect(orders[0]!.attempts).toBe(0);
  });
});

describe('dispatcher: idempotency and retries', () => {
  it('does not duplicate an order across cycles', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a']);

    dispatcher.cycle();
    clock.advance(100);
    const second = dispatcher.cycle();

    expect(second.sent).toHaveLength(0);
    expect(sender.sent).toHaveLength(1);
    expect(store.listOrders()).toHaveLength(1);
  });

  it('resends the same orderId after backoff (lost message path)', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a']);

    dispatcher.cycle();
    const firstId = sender.sent[0]!.orderId as string;
    clock.advance(600);
    dispatcher.cycle();

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]!.orderId).toBe(firstId);
    expect(store.listOrders()).toHaveLength(1);
    expect(store.listOrders()[0]!.attempts).toBe(2);
  });

  it('escalates after the third attempt and pauses the mission', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    const mission = approvedMission(store, clock.now(), ['grid:a']);

    dispatcher.cycle(); // attempt 1
    clock.advance(600);
    dispatcher.cycle(); // attempt 2
    clock.advance(1200);
    dispatcher.cycle(); // attempt 3
    clock.advance(2400);
    const escalated = dispatcher.cycle();

    expect(escalated.escalated).toHaveLength(1);
    expect(sender.sent).toHaveLength(3);
    const stored = store.getMission(mission.id)!;
    expect(stored.status).toBe('paused');
    expect(stored.pauseReason).toBe('retry_cap_exhausted');
    expect(store.listAlerts().some((a) => a.kind === 'order_retry_cap')).toBe(true);

    clock.advance(30_000);
    expect(dispatcher.cycle().sent).toHaveLength(0);
  });

  it('uses a new orderId after an explicit nack', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a']);

    dispatcher.cycle();
    const first = store.listOrders()[0]!;
    dispatcher.onAck(first.orderId, false, 'stale tick');
    expect(store.getOrder(first.orderId)!.status).toBe('failed');

    clock.advance(600);
    dispatcher.cycle();
    const orders = store.listOrders();
    expect(orders).toHaveLength(2);
    expect(orders[1]!.orderId).not.toBe(first.orderId);
    expect(orders[1]!.attempts).toBe(2);
  });

  it('handles duplicate and reordered acks idempotently', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    const mission = approvedMission(store, clock.now(), ['grid:a']);

    // Reordered: ack for an order the backend has not persisted yet.
    dispatcher.onAck('ord:never-seen:a1', true, undefined);
    expect(store.countAudit('ack_unknown')).toBe(1);

    dispatcher.cycle();
    const orderId = sender.sent[0]!.orderId as string;
    dispatcher.onAck(orderId, true, undefined);
    dispatcher.onAck(orderId, true, undefined);

    expect(store.getOrder(orderId)!.status).toBe('acked');
    expect(store.getMission(mission.id)!.status).toBe('executing');
    expect(store.countAudit('ack_duplicate')).toBe(1);
  });
});

describe('dispatcher: caps, priority and kill switch', () => {
  it('enforces the orders-per-minute cap', () => {
    const { clock, store, sender, dispatcher } = setup({ maxOrdersPerMinute: 1 });
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    store.upsertUnit(unit({ id: 'grid:b', lastSeen: clock.now() }));
    approvedMission(store, clock.now(), ['grid:a'], { idempotencyKey: 'm1' });
    approvedMission(store, clock.now(), ['grid:b'], { idempotencyKey: 'm2', priority: 40 });

    const result = dispatcher.cycle();
    expect(sender.sent).toHaveLength(1);
    expect(result.rateLimited).toBe(true);
    expect(store.countAudit('order_rate_limited')).toBe(1);
  });

  it('holds a new build until repair work is done, then releases it', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());

    const repair = createMission(
      store,
      missionInput({ type: 'repair', assignedUnits: ['grid:a'], approval: 'auto' }),
      { now: clock.now(), actor: 'test', autoMissionTypes: ['repair'], maxQueuedBuilds: 8 },
    );
    if (!repair.ok) throw new Error('repair create failed');
    expect(repair.mission.status).toBe('approved');

    const build = approvedMission(store, clock.now(), ['grid:a'], { idempotencyKey: 'build-1' });
    expect(build.blockedBy).toBe('repair_pending');

    dispatcher.cycle();
    // The repair order may go out; the new build order must not.
    expect(sender.sent.some((s) => s.missionId === build.id)).toBe(false);
    expect(runtimeOrderCount(store, build.id)).toBe(0);

    cancelMission(store, repair.mission.id, 'test', clock.now());
    const released = dispatcher.cycle();
    expect(released.sent.some((id) => id.includes(build.id))).toBe(true);
    expect(store.getMission(build.id)!.blockedBy).toBeUndefined();
    expect(runtimeOrderCount(store, build.id)).toBe(1);
  });

  it('is OFF until the dispatch feature flag is enabled', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    store.ensureFlags(['dispatch']);
    const sender = new RecordingSender();
    const dispatcher = new Dispatcher(
      store,
      sender,
      {
        maxAttempts: 3,
        backoffMs: 500,
        maxOrdersPerMinute: 60,
        enabled: () => store.getFlags().dispatch === true,
      },
      clock.now,
    );
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    approvedMission(store, clock.now(), ['grid:a']);

    expect(dispatcher.cycle().skipped).toBe('disabled');
    expect(sender.sent).toHaveLength(0);

    store.setFlag('dispatch', true, 'test');
    expect(dispatcher.cycle().sent).toHaveLength(1);
  });

  it('sends nothing while the kill switch is on', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    approvedMission(store, clock.now(), ['grid:a']);
    store.setKillSwitch(true, 'test');

    const result = dispatcher.cycle();
    expect(result.skipped).toBe('kill_switch');
    expect(sender.sent).toHaveLength(0);
  });

  it('does not send orders for a mission paused by its loss limit', () => {
    const { clock, store, sender, dispatcher } = setup();
    seedUnits(store, clock.now());
    const mission = approvedMission(store, clock.now(), ['grid:a']);
    recordLoss(store, mission.id, 1, clock.now());

    dispatcher.cycle();
    expect(sender.sent).toHaveLength(0);
    expect(store.getMission(mission.id)!.status).toBe('paused');
  });
});
