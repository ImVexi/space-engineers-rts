import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Reconciler } from '../src/reconciler.js';
import { createMission } from '../src/missions.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeClock, memoryStore, missionInput, tempDir, unit } from './helpers.js';

const OPTS = { minIntervalMs: 5000, maxQueuedBuilds: 8, autoMissionTypes: [] };

function seedDesired(store: Store, overrides: Record<string, unknown> = {}) {
  return store.upsertDesired({
    id: 'orbit-A-sats',
    spec: 'sat-relay-mk1',
    station: 'orbit-A',
    count: 1,
    formation: 'ring',
    budget: null,
    enabled: true,
    ...overrides,
  });
}

describe('reconciler', () => {
  it('emits exactly one mission for a gap of one', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    const reconciler = new Reconciler(store, OPTS, clock.now);

    const result = reconciler.cycle();

    expect(result.created).toHaveLength(1);
    const mission = result.created[0]!;
    expect(mission.type).toBe('build_deploy');
    expect(mission.approval).toBe('approve');
    expect(mission.status).toBe('queued');
    expect(mission.desiredState).toMatchObject({ shipSpec: 'sat-relay-mk1', station: 'orbit-A', qty: 1 });
    expect(mission.budget.lossLimit).toBe(1);
    expect(mission.budget.resources.iron).toBe(12000);
    expect(store.countMissions({})).toBe(1);
  });

  it('never duplicates a mission across repeated cycles', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    const reconciler = new Reconciler(store, OPTS, clock.now);

    const first = reconciler.cycle();
    const second = reconciler.cycle();
    clock.advance(60_000);
    const third = reconciler.cycle();

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(third.created).toHaveLength(0);
    expect(second.skipped[0]?.reason).toBe('dedupe');
    expect(store.countMissions({})).toBe(1);
  });

  it('resumes without duplication after a restart (state in SQLite)', () => {
    const clock = makeClock();
    const dir = tempDir();
    const dbPath = path.join(dir, 'rts.db');

    const store1 = new Store(openDb(dbPath), clock.now);
    seedDesired(store1);
    expect(new Reconciler(store1, OPTS, clock.now).cycle().created).toHaveLength(1);
    store1.close();

    const store2 = new Store(openDb(dbPath), clock.now);
    const again = new Reconciler(store2, OPTS, clock.now).cycle();
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]?.reason).toBe('dedupe');
    expect(store2.countMissions({})).toBe(1);
    store2.close();
  });

  it('emits nothing when the desired state is satisfied', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    store.upsertUnit(unit({ id: 'grid:sat1', lastSeen: clock.now() }));
    const reconciler = new Reconciler(store, OPTS, clock.now);

    const result = reconciler.cycle();
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('satisfied');
  });

  it('covers a gap larger than one with a single mission carrying qty', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store, { count: 3 });
    store.upsertUnit(unit({ id: 'grid:sat1', lastSeen: clock.now() }));

    const result = new Reconciler(store, OPTS, clock.now).cycle();
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.desiredState.qty).toBe(2);
    expect(result.created[0]!.budget.resources.iron).toBe(24000);
  });

  it('holds new builds while repair/replacement work is open', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    const repair = createMission(
      store,
      missionInput({ type: 'repair', approval: 'auto' }),
      { now: clock.now(), actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    expect(repair.ok).toBe(true);

    const result = new Reconciler(store, OPTS, clock.now).cycle();
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('repair_pending');
  });

  it('respects the queued-build cap', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    // One build is already open and occupies the only slot.
    const existing = createMission(store, missionInput({ idempotencyKey: 'manual:build' }), {
      now: clock.now(),
      actor: 'test',
      autoMissionTypes: [],
      maxQueuedBuilds: 1,
    });
    expect(existing.ok).toBe(true);

    const result = new Reconciler(store, { ...OPTS, maxQueuedBuilds: 1 }, clock.now).cycle();
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('cap_reached');
    expect(store.countMissions({})).toBe(1);
  });

  it('rate-limits re-emission for the same desired entry', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    const reconciler = new Reconciler(store, OPTS, clock.now);

    const first = reconciler.cycle();
    expect(first.created).toHaveLength(1);
    store.updateMission(first.created[0]!.id, { status: 'cancelled' }, clock.now());

    const blocked = reconciler.cycle();
    expect(blocked.created).toHaveLength(0);
    expect(blocked.skipped[0]?.reason).toBe('rate_limited');

    clock.advance(OPTS.minIntervalMs + 1);
    const allowed = reconciler.cycle();
    expect(allowed.created).toHaveLength(1);
  });

  it('does nothing while the global kill switch is engaged', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    seedDesired(store);
    store.setKillSwitch(true, 'test');

    const result = new Reconciler(store, OPTS, clock.now).cycle();
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('kill_switch');
    expect(store.countMissions({})).toBe(0);
  });
});
