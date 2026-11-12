import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { approveMission, createMission, supersedeGridMissions } from '../src/missions.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;

function makeStore() {
  const config = makeConfig({ flags: { demo_execute: true } });
  const db = openDb(':memory:', { memory: true });
  const store = new Store(db);
  const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  store.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true });
  return { store, config };
}

function moveMission(store: Store, id: string, gridId: string, at: number) {
  const result = createMission(
    store,
    {
      type: 'move',
      priority: 50,
      desiredState: { shipSpec: 'stand-in-grid', station: `move:${gridId}`, formation: 'none', position: { x: 0, y: 0, z: 0 } },
      budget: { resources: {}, timeMin: 30, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: [gridId],
      plan: { steps: [{ id: 'move', kind: 'move', params: { gridId }, done: false }], notes: 'test' },
      idempotencyKey: id,
    },
    { now: at, actor: 'test', autoMissionTypes: ['move'], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  const approved = approveMission(store, result.mission.id, 'test', at);
  if (!approved.ok) throw new Error(approved.message);
  return approved.mission;
}

describe('supersede rule: one grid, one mission', () => {
  it('cancels an older active mission on the same grid and audits it', () => {
    const { store } = makeStore();
    const first = moveMission(store, 'first', 'grid:shared', NOW);
    const second = moveMission(store, 'second', 'grid:shared', NOW + 1_000);

    const cancelled = supersedeGridMissions(store, 'grid:shared', second.id, 'test', NOW + 2_000);

    expect(cancelled).toEqual([first.id]);
    expect(store.getMission(first.id)?.status).toBe('cancelled');
    expect(store.getMission(second.id)?.status).toBe('approved');
    const audit = store.listAudit(50).find((e) => e.action === 'mission_superseded' && e.subject === first.id);
    expect(audit).toBeTruthy();
    expect((audit!.detail as { supersededBy?: string }).supersededBy).toBe(second.id);
  });

  it('leaves missions on other grids and the kept mission untouched', () => {
    const { store } = makeStore();
    const other = moveMission(store, 'other', 'grid:other', NOW);
    const keep = moveMission(store, 'keep', 'grid:shared', NOW + 1_000);
    const older = moveMission(store, 'older', 'grid:shared', NOW + 2_000);

    const cancelled = supersedeGridMissions(store, 'grid:shared', keep.id, 'test', NOW + 3_000);
    expect(cancelled).toEqual([older.id]);
    expect(store.getMission(other.id)?.status).toBe('approved');
    expect(store.getMission(keep.id)?.status).toBe('approved');
  });

  it('finds a mission that only owns the grid through a demo drone row', () => {
    const { store } = makeStore();
    const droneMission = moveMission(store, 'drone-only', 'grid:shared', NOW);
    // Simulate a designer/spawn mission whose assignedUnits is empty but whose
    // drone already carries the grid id.
    store.updateMission(droneMission.id, { assignedUnits: [] }, NOW);
    store.db
      .prepare(
        `INSERT INTO demo_drones (mission_id, idx, label, prefab, plan_slot_json, exec_slot_json, spawn_json, state, grid_id, updated_at)
         VALUES (?, 0, ?, 'existing', '{}', '{}', '{}', 'en_route', ?, ?)`,
      )
      .run(droneMission.id, 'drone-only', 'grid:shared', NOW);
    const newer = moveMission(store, 'newer', 'grid:elsewhere', NOW + 1_000);

    const cancelled = supersedeGridMissions(store, 'grid:shared', newer.id, 'test', NOW + 2_000);
    expect(cancelled).toContain(droneMission.id);
    expect(store.getMission(droneMission.id)?.status).toBe('cancelled');
  });
});
