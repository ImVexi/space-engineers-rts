import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Dispatcher, type OrderSender } from '../src/dispatcher.js';
import { approveMission, createMission } from '../src/missions.js';
import { recordSpend } from '../src/budgets.js';
import { memoryStore, makeClock, missionInput, unit } from './helpers.js';

/**
 * Build-plan §8.2 "never should happen" checks that are enforceable at this
 * layer. Each test is named after the invariant it protects.
 */

class Sender implements OrderSender {
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
    return 'fake';
  }
}

function env() {
  const clock = makeClock();
  const store = memoryStore(clock.now);
  const sender = new Sender();
  const dispatcher = new Dispatcher(
    store,
    sender,
    { maxAttempts: 3, backoffMs: 500, maxOrdersPerMinute: 60, comms: {} },
    clock.now,
  );
  const ctx = { now: clock.now(), actor: 'test', autoMissionTypes: [] as string[], maxQueuedBuilds: 8 };
  const create = (units: string[], overrides: Record<string, unknown> = {}) => {
    const result = createMission(store, missionInput({ assignedUnits: units, ...overrides }), ctx);
    if (!result.ok) throw new Error(result.message);
    const approved = approveMission(store, result.mission.id, 'test', clock.now());
    if (!approved.ok) throw new Error(approved.message);
    return approved.mission;
  };
  return { clock, store, sender, dispatcher, create };
}

describe('invariant: no command is sent to an unreachable unit', () => {
  it('every persisted order targets a unit that was reachable', () => {
    const { clock, store, sender, dispatcher, create } = env();
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    store.upsertUnit(unit({ id: 'grid:b', linkStatus: 'down', lastSeen: clock.now() }));
    store.upsertUnit(unit({ id: 'grid:c', linkStatus: 'up', lastSeen: clock.now() - 60_000 }));
    create(['grid:a', 'grid:b', 'grid:c']);

    dispatcher.cycle();

    const targets = new Set(store.listOrders().map((o) => o.unitId));
    expect([...targets]).toEqual(['grid:a']);
    for (const order of store.listOrders()) {
      const target = sender.sent.find((s) => s.orderId === order.orderId);
      expect(target).toBeDefined();
      expect(order.unitId).toBe('grid:a');
    }
  });
});

describe('invariant: a reconcile/dispatch cycle never duplicates a mission or order', () => {
  it('holds under repeated cycles and retries', () => {
    const { clock, store, dispatcher, create } = env();
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    const mission = create(['grid:a'], { idempotencyKey: 'desired:one' });

    dispatcher.cycle();
    for (let i = 0; i < 10; i++) {
      clock.advance(250);
      dispatcher.cycle();
    }

    const orders = store.listOrders(mission.id);
    const ids = orders.map((o) => o.orderId);
    expect(new Set(ids).size).toBe(ids.length);
    // One logical order per (mission, unit, attempt); retries reuse the id.
    expect(orders).toHaveLength(1);
    expect(store.countMissions({})).toBe(1);
  });
});

describe('invariant: no build starts while repair/replacement is pending', () => {
  it('build orders are withheld until repair work closes', () => {
    const { clock, store, sender, dispatcher, create } = env();
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    const repair = createMission(
      store,
      missionInput({ type: 'repair', assignedUnits: ['grid:a'], approval: 'auto' }),
      { now: clock.now(), actor: 'test', autoMissionTypes: ['repair'], maxQueuedBuilds: 8 },
    );
    if (!repair.ok) throw new Error('repair setup failed');
    const build = create(['grid:a'], { idempotencyKey: 'build-x' });

    dispatcher.cycle();
    // The repair order may be dispatched, but never the build order.
    expect(sender.sent.some((s) => s.missionId === build.id)).toBe(false);
    expect(store.listOrders(build.id)).toHaveLength(0);

    // Repair closes; only then does the build order leave.
    store.updateMission(repair.mission.id, { status: 'done' }, clock.now());
    dispatcher.cycle();
    const buildOrders = store.listOrders(build.id);
    expect(buildOrders).toHaveLength(1);
    expect(sender.sent.some((s) => s.missionId === build.id)).toBe(true);
  });
});

describe('invariant: a mission never exceeds budget without a pause', () => {
  it('over-spend pauses and alerts instead of continuing', () => {
    const { clock, store, create } = env();
    const mission = create([], { budget: { resources: { iron: 100 }, timeMin: 10, lossLimit: 5 } });
    recordSpend(store, mission.id, { iron: 101 }, clock.now());
    const stored = store.getMission(mission.id)!;
    expect(stored.status).toBe('paused');
    expect(store.listAlerts().some((a) => a.missionId === mission.id)).toBe(true);
    expect(store.countAudit('mission_paused')).toBe(1);
  });
});

describe('invariant: every operation is logged with an id and outcome', () => {
  it('mission create -> approve -> order -> ack leaves a full audit trail', () => {
    const { clock, store, sender, dispatcher, create } = env();
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    create(['grid:a']);
    dispatcher.cycle();
    const orderId = sender.sent[0]!.orderId as string;
    dispatcher.onAck(orderId, true, undefined, clock.now());

    const actions = store.listAudit(100).map((a) => a.action);
    for (const required of ['mission_created', 'mission_approved', 'order_sent', 'order_acked']) {
      expect(actions, required).toContain(required);
    }
    for (const entry of store.listAudit(100)) {
      expect(entry.id).toMatch(/^aud-/);
      expect(entry.at).toBeGreaterThan(0);
      expect(entry.subject.length).toBeGreaterThan(0);
    }
  });
});

describe('invariant: kill switch stops all control', () => {
  it('blocks reconcile and dispatch', () => {
    const { clock, store, sender, dispatcher, create } = env();
    store.upsertUnit(unit({ id: 'grid:a', lastSeen: clock.now() }));
    create(['grid:a']);
    store.upsertDesired({
      id: 'orbit-A',
      spec: 'sat-relay-mk1',
      station: 'orbit-A',
      count: 1,
      formation: 'none',
      budget: null,
      enabled: true,
    });
    store.setKillSwitch(true, 'operator');

    expect(dispatcher.cycle().skipped).toBe('kill_switch');
    expect(sender.sent).toHaveLength(0);
    expect(store.countAudit('kill_switch_on')).toBe(1);
  });
});

describe('invariant: malformed input never crashes mission creation', () => {
  it('arbitrary JSON is rejected or accepted cleanly (fuzz)', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = createMission(store, value, {
          now: clock.now(),
          actor: 'fuzz',
          autoMissionTypes: [],
          maxQueuedBuilds: 50,
        });
        expect(result.ok === true || result.ok === false).toBe(true);
        if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
