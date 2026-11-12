import { describe, expect, it } from 'vitest';
import { approveMission, cancelMission, createMission, pauseMission } from '../src/missions.js';
import { checkBudget, recordLoss, recordSpend } from '../src/budgets.js';
import { makeClock, memoryStore, missionInput } from './helpers.js';

const ctx = (clock: ReturnType<typeof makeClock>, overrides: { auto?: string[]; cap?: number } = {}) => ({
  now: clock.now(),
  actor: 'test',
  autoMissionTypes: overrides.auto ?? [],
  maxQueuedBuilds: overrides.cap ?? 8,
});

describe('approval policy', () => {
  it('defaults to approve and queues the mission', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const result = createMission(store, missionInput(), ctx(clock));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.approval).toBe('approve');
    expect(result.mission.status).toBe('queued');
  });

  it('never grants auto because a client asked for it', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const result = createMission(store, missionInput({ approval: 'auto' }), ctx(clock));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.approval).toBe('approve');
    expect(store.countAudit('approval_coerced')).toBe(1);
  });

  it('honours auto only when the mission type is explicitly allowlisted', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const result = createMission(
      store,
      missionInput({ approval: 'auto' }),
      ctx(clock, { auto: ['build_deploy'] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.approval).toBe('auto');
    expect(result.mission.status).toBe('approved');
  });

  it('approve and cancel are audited with a rollback point', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');

    const approved = approveMission(store, created.mission.id, 'owner', clock.now());
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.mission.status).toBe('approved');

    const audit = store.listAudit(50).find((a) => a.action === 'mission_approved');
    expect(audit?.actor).toBe('owner');
    expect(audit?.rollbackPoint).toBe(`mission:${created.mission.id}:cancel`);

    const cancelled = cancelMission(store, created.mission.id, 'owner', clock.now());
    expect(cancelled.ok).toBe(true);
    expect(cancelMission(store, created.mission.id, 'owner', clock.now()).ok).toBe(false);
  });

  it('rejects a second approval of the same mission', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');
    expect(approveMission(store, created.mission.id, 'a', clock.now()).ok).toBe(true);
    const second = approveMission(store, created.mission.id, 'a', clock.now());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('conflict');
  });

  it('caps queued builds and raises an alert', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    expect(createMission(store, missionInput(), ctx(clock, { cap: 1 })).ok).toBe(true);
    const second = createMission(store, missionInput({ idempotencyKey: 'second' }), ctx(clock, { cap: 1 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('cap_reached');
    expect(store.listAlerts().some((a) => a.kind === 'cap_reached')).toBe(true);
  });

  it('is idempotent on idempotencyKey (no duplicate mission)', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const a = createMission(store, missionInput({ idempotencyKey: 'desired:x' }), ctx(clock));
    const b = createMission(store, missionInput({ idempotencyKey: 'desired:x' }), ctx(clock));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.created).toBe(false);
    expect(b.mission.id).toBe(a.mission.id);
    expect(store.countMissions({})).toBe(1);
  });
});

describe('budgets and loss limits', () => {
  it('pauses and alerts when the loss limit is hit', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');

    const result = recordLoss(store, created.mission.id, 1, clock.now());
    expect(result.paused).toBe(true);
    const mission = store.getMission(created.mission.id)!;
    expect(mission.status).toBe('paused');
    expect(mission.pauseReason).toBe('loss_limit');
    expect(store.listAlerts().some((a) => a.kind === 'loss_limit' && a.missionId === mission.id)).toBe(true);
  });

  it('treats lossLimit 0 as "any loss pauses"', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(
      store,
      missionInput({ budget: { resources: {}, timeMin: 10, lossLimit: 0 } }),
      ctx(clock),
    );
    if (!created.ok) throw new Error('setup failed');
    expect(recordLoss(store, created.mission.id, 1, clock.now()).paused).toBe(true);
  });

  it('allows losses below the limit then pauses exactly at it', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(
      store,
      missionInput({ budget: { resources: {}, timeMin: 10, lossLimit: 2 } }),
      ctx(clock),
    );
    if (!created.ok) throw new Error('setup failed');
    expect(recordLoss(store, created.mission.id, 1, clock.now()).paused).toBe(false);
    expect(store.getMission(created.mission.id)!.status).toBe('queued');
    expect(recordLoss(store, created.mission.id, 1, clock.now()).paused).toBe(true);
  });

  it('pauses when the resource budget is exceeded', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');

    expect(recordSpend(store, created.mission.id, { iron: 5000 }, clock.now()).paused).toBe(false);
    const over = recordSpend(store, created.mission.id, { iron: 8000 }, clock.now());
    expect(over.paused).toBe(true);
    expect(store.getMission(created.mission.id)!.pauseReason).toBe('resource_budget');
  });

  it('flags an elapsed time budget', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');
    const mission = store.getMission(created.mission.id)!;

    const later = clock.now() + 91 * 60_000;
    const check = checkBudget(mission, { spent: {}, losses: 0 }, later);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('time');
  });

  it('never dispatches a paused mission (pause survives later cycles)', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const created = createMission(store, missionInput(), ctx(clock));
    if (!created.ok) throw new Error('setup failed');
    pauseMission(store, created.mission.id, 'manual', { kind: 'manual', message: 'hold' }, 'test', clock.now());
    expect(store.listMissions({ status: ['approved', 'executing'] })).toHaveLength(0);
  });
});
