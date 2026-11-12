import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { FEATURE_FLAGS, type FeatureFlag } from '../src/config.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;

function setup() {
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
  const executor = new DemoExecutor({ store, hub, config, clock: () => NOW, fixturePath: null });
  return { store, config, sent, executor };
}

function register(store: Store, gridId: string, spawnedAt: number) {
  store.db
    .prepare(
      `INSERT INTO demo_spawned (grid_id, mission_id, idx, name, spawned_at, deleted_at)
       VALUES (?, 'm1', 0, 'demo-test', ?, NULL)`,
    )
    .run(gridId, spawnedAt);
}

describe('debris cleanup', () => {
  it('dry-run reports but does not delete, then cleanup deletes the registered grid', () => {
    const { store, sent, executor } = setup();
    register(store, 'grid:111', NOW - 120_000);
    const dry = executor.cleanupStale(1, NOW, true);
    expect(dry.considered).toBe(1);
    expect(dry.deleted).toHaveLength(0);
    expect(sent).toHaveLength(0);

    const real = executor.cleanupStale(1, NOW, false);
    expect(real.deleted).toEqual(['grid:111']);
    expect(sent).toHaveLength(1);
    const order = sent[0] as { orderType: string; params: Record<string, unknown>; entityId: string };
    expect(order.orderType).toBe('test');
    expect(order.params.action).toBe('delete_grid');
    expect(order.entityId).toBe('grid:111');
    // Idempotent: a second pass has nothing left to delete.
    expect(executor.cleanupStale(1, NOW, false).considered).toBe(0);
  });

  it('respects the age window so a fresh spawn is left alone', () => {
    const { store, sent, executor } = setup();
    register(store, 'grid:fresh', NOW - 10_000);
    const result = executor.cleanupStale(5, NOW, false);
    expect(result.considered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('refuses a run when live grids exceed RTS_DEMO_MAX_GRIDS', () => {
    const { store, executor, config } = setup();
    for (let i = 0; i < config.demo.maxGridsBeforeRun + 1; i++) {
      store.upsertUnit({
        id: `grid:${i}`,
        name: `debris-${i}`,
        specId: null,
        station: null,
        linkStatus: 'up',
        lastSeen: NOW,
        pos: { x: 0, y: 0, z: 0 },
        vel: null,
        meta: {},
      });
    }
    const ready = executor.assertWorldReady(NOW);
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.liveGrids).toBe(21);
  });

  it('ignores stale telemetry rows when counting live grids', () => {
    const { store, executor } = setup();
    store.upsertUnit({
      id: 'grid:old',
      name: 'old',
      specId: null,
      station: null,
      linkStatus: 'down',
      lastSeen: NOW - 3_600_000,
      pos: { x: 0, y: 0, z: 0 },
      vel: null,
      meta: {},
    });
    expect(executor.liveGridCount(NOW)).toBe(0);
    expect(executor.assertWorldReady(NOW).ok).toBe(true);
  });
});
