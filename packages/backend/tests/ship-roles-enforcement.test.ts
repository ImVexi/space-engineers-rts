/**
 * Ship roles at the executor's SEND BOUNDARY (owner decision 2026-11-11).
 * The role matrix lives in roles.ts; this pins that the executor actually
 * consults it, so a mission aimed at an OFF or an unconfirmed PERSONAL grid
 * produces no plugin order at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor, gridMoveMission } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import { shipRoles, type RoleHint } from '../src/demo/roles.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const TARGET = { x: 59_402_000, y: 0, z: 0 };

function hub(sent: Record<string, unknown>[]) {
  return {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
  } as never;
}

function hint(role: RoleHint['role']): RoleHint {
  return { role, token: `[${role}]`, source: 'block-name', block: 'PB' };
}

function run(gridId: string, confirmed: boolean, hints: RoleHint[]): Record<string, unknown>[] {
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  shipRoles.reset();
  shipRoles.noteInGame(store, [{ gridId, name: gridId, hints }], NOW);
  const sent: Record<string, unknown>[] = [];
  const executor = new DemoExecutor({ store, hub: hub(sent), config: makeConfig(), clock: () => NOW, fixturePath: null });
  const created = createMission(
    store,
    gridMoveMission({ gridId, target: TARGET, gateNodeId: 'earthlike-hq', ...(confirmed ? { personalConfirmed: true } : {}) }),
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!created.ok) throw new Error(created.message);
  store.updateMission(created.mission.id, { status: 'approved' }, NOW);
  executor.sync(NOW);
  for (let i = 0; i < 4; i++) executor.tick();
  return sent;
}

/** Flight/config orders to a grid; read-only control probes are not actions. */
function ordersTo(sent: Record<string, unknown>[], gridId: string): Record<string, unknown>[] {
  return sent.filter(
    (m) =>
      (m.entityId === gridId || (m.params as { entityId?: string } | undefined)?.entityId === gridId) &&
      (m.params as { action?: string } | undefined)?.action !== 'is_under_control',
  );
}

beforeEach(() => shipRoles.reset());

describe('executor send boundary honours the role', () => {
  it('OFF: zero orders are sent to the grid', () => {
    expect(ordersTo(run('grid:off', false, [hint('off')]), 'grid:off')).toHaveLength(0);
  });

  it('PERSONAL without confirmation: zero orders', () => {
    expect(ordersTo(run('grid:personal', false, [hint('personal')]), 'grid:personal')).toHaveLength(0);
  });

  it('PERSONAL with the owner confirmation reaches the same read probe as MANAGED', () => {
    const personal = run('grid:personal-ok', true, [hint('personal')]);
    const managed = run('grid:managed', false, []);
    const probe = (sent: Record<string, unknown>[]) =>
      sent.some(
        (m) =>
          (m.entityId === 'grid:personal-ok' || m.entityId === 'grid:managed') &&
          (m.params as { action?: string } | undefined)?.action === 'is_under_control',
      );
    expect(probe(personal)).toBe(true);
    expect(probe(managed)).toBe(true);
  });

  it('OFF is refused even for the read probe', () => {
    const sent = run('grid:off-probe', false, [hint('off')]);
    expect(sent.filter((m) => m.entityId === 'grid:off-probe')).toHaveLength(0);
  });
});
