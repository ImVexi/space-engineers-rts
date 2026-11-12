import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest, tempDir, waitFor } from './helpers.js';
import { FakePlugin } from './fakePlugin.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const saved: Record<string, string | undefined> = {};

function setDemoEnv(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

interface GroupWire {
  id: string;
  name: string;
  color: string | null;
  members: string[];
  createdAt: number;
  updatedAt: number;
}

interface GroupList {
  groups: GroupWire[];
}

/** SE grid ids exceed 2^53: this exact string must survive every round trip. */
const BIG_GRID = 'grid:9007199254740993';

const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const BASE = 'grid:76941937918779763';
const SAT = 'grid:107519913664561774';

const clock = makeClock();

async function withRuntime<T>(
  opts: { dbPath?: string; memory?: boolean },
  fn: (ctx: { runtime: Runtime; port: number }) => Promise<T>,
): Promise<T> {
  const runtime = createRuntime({
    config: makeConfig({ port: 0 }),
    ...(opts.memory ? { memory: true } : { dbPath: opts.dbPath }),
    clock: clock.now,
  });
  const port = await runtime.listen(0);
  try {
    return await fn({ runtime, port });
  } finally {
    await runtime.close();
  }
}

describe('demo groups', () => {
  beforeAll(() => setDemoEnv());
  afterAll(() => restoreEnv());
  afterEach(() => clock.advance(1_000));

  it('round-trips CRUD, multi-membership and string grid ids over HTTP', async () => {
    await withRuntime({ memory: true }, async ({ port }) => {
      const created = await httpRequest<{ group: GroupWire }>(port, 'POST', '/api/demo/groups', {
        id: 'g-alpha',
        name: 'Alpha',
        color: '#74d3c4',
        members: [BIG_GRID, 'grid:2', BIG_GRID],
      });
      expect(created.status).toBe(201);
      expect(created.body.group).toMatchObject({
        id: 'g-alpha',
        name: 'Alpha',
        color: '#74d3c4',
        members: [BIG_GRID, 'grid:2'],
      });
      // The huge id stays a string; no precision loss anywhere.
      expect(created.body.group.members[0]).toBe(BIG_GRID);

      // The same grid may live in a second group.
      const second = await httpRequest<{ group: GroupWire }>(port, 'POST', '/api/demo/groups', {
        id: 'g-beta',
        name: 'Beta',
        color: '#9eb7ff',
        members: [BIG_GRID],
      });
      expect(second.status).toBe(201);

      const list = await httpRequest<GroupList>(port, 'GET', '/api/demo/groups');
      expect(list.status).toBe(200);
      expect(list.body.groups.map((g) => g.id).sort()).toEqual(['g-alpha', 'g-beta']);
      expect(list.body.groups.filter((g) => g.members.includes(BIG_GRID))).toHaveLength(2);

      const patched = await httpRequest<{ group: GroupWire }>(port, 'PATCH', '/api/demo/groups/g-alpha', {
        name: 'Alpha renamed',
        members: [BIG_GRID],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.group.name).toBe('Alpha renamed');
      expect(patched.body.group.members).toEqual([BIG_GRID]);
      expect(patched.body.group.color).toBe('#74d3c4');

      // The legacy PUT alias updates the same row.
      const viaPut = await httpRequest<{ group: GroupWire }>(port, 'PUT', '/api/demo/groups/g-alpha', {
        color: '#e0b072',
      });
      expect(viaPut.status).toBe(200);
      expect(viaPut.body.group.color).toBe('#e0b072');

      const deleted = await httpRequest<{ deleted: boolean }>(port, 'DELETE', '/api/demo/groups/g-beta');
      expect(deleted.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);
      const after = await httpRequest<GroupList>(port, 'GET', '/api/demo/groups');
      expect(after.body.groups.map((g) => g.id)).toEqual(['g-alpha']);
    });
  });

  it('rejects duplicates and malformed bodies instead of silently succeeding', async () => {
    await withRuntime({ memory: true }, async ({ port }) => {
      const body = { id: 'g-dup', name: 'Dup', color: '#fff', members: ['grid:1'] };
      expect((await httpRequest(port, 'POST', '/api/demo/groups', body)).status).toBe(201);
      const dup = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/groups', body);
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('group_exists');

      expect((await httpRequest(port, 'POST', '/api/demo/groups', { name: 'No members', members: [123] })).status).toBe(400);
      expect((await httpRequest(port, 'POST', '/api/demo/groups', { name: '   ', members: [] })).status).toBe(400);
      expect((await httpRequest(port, 'PATCH', '/api/demo/groups/g-dup', {})).status).toBe(400);
      expect((await httpRequest(port, 'PATCH', '/api/demo/groups/missing', { name: 'X' })).status).toBe(404);
      expect((await httpRequest(port, 'DELETE', '/api/demo/groups/missing')).status).toBe(404);
    });
  });

  it('persists groups across a simulated backend restart (same sqlite file)', async () => {
    const dbPath = path.join(tempDir('se-rts-groups-'), 'rts.db');
    await withRuntime({ dbPath }, async ({ port }) => {
      const created = await httpRequest<{ group: GroupWire }>(port, 'POST', '/api/demo/groups', {
        id: 'g-persist',
        name: 'Persisted',
        color: '#c9a6ff',
        members: [BIG_GRID, 'grid:42'],
      });
      expect(created.status).toBe(201);
    });

    // A fresh runtime opens the identical file: the row must still be there.
    await withRuntime({ dbPath }, async ({ port }) => {
      const list = await httpRequest<GroupList>(port, 'GET', '/api/demo/groups');
      expect(list.status).toBe(200);
      expect(list.body.groups).toHaveLength(1);
      expect(list.body.groups[0]).toMatchObject({
        id: 'g-persist',
        name: 'Persisted',
        color: '#c9a6ff',
        members: [BIG_GRID, 'grid:42'],
      });
      expect(list.body.groups[0]!.members[0]).toBe(BIG_GRID);
    });
  });

  it('scoped stop sends a stop order only to members the gate allows', async () => {
    await withRuntime({ memory: true }, async ({ runtime, port }) => {
      const now = clock.now();
      runtime.store.setKv(
        PROVISION_CAPABILITIES_KV,
        JSON.stringify({
          at: now,
          grids: [
            {
              gridId: BASE,
              name: 'BASE-01',
              profile: 'BASE',
              broadcasting: true,
              radioRadiusM: 50_000,
              laserCount: 0,
              massKg: 0,
              isStatic: true,
              updatedAt: now,
            },
            {
              gridId: SAT,
              name: 'SAT-L-0001',
              profile: 'DRONE',
              broadcasting: true,
              radioRadiusM: 50_000,
              laserCount: 2,
              massKg: 19_003.6,
              isStatic: false,
              updatedAt: now,
            },
          ],
        }),
      );
      for (const [id, name, pos] of [
        [BASE, 'BASE-01', { x: 0, y: 0, z: EARTH.surfaceRadiusM + 300 }],
        [SAT, 'SAT-L-0001', { x: 1_000, y: 0, z: EARTH.surfaceRadiusM + 300 }],
      ] as const) {
        runtime.store.upsertUnit({
          id,
          name,
          specId: null,
          station: null,
          linkStatus: 'up',
          lastSeen: now,
          pos,
          vel: null,
          meta: {},
        });
      }

      const created = await httpRequest<{ group: GroupWire }>(port, 'POST', '/api/demo/groups', {
        id: 'g-stop',
        name: 'Stop me',
        color: '#ff9aa2',
        members: [SAT, 'grid:unknown'],
      });
      expect(created.status).toBe(201);

      const plugin = await FakePlugin.connect(port);
      plugin.hello();
      await waitFor(() => runtime.hub.isConnected(), (connected) => connected === true);

      const stopped = await httpRequest<{
        stopped: number;
        stoppedGrids: string[];
        skipped: { gridId: string; reason: string; stage: string }[];
        note: string;
      }>(port, 'POST', '/api/demo/groups/g-stop/stop', {});
      expect(stopped.status).toBe(200);
      expect(stopped.body.stopped).toBe(1);
      expect(stopped.body.stoppedGrids).toEqual([SAT]);
      // The unknown grid is refused by the comms gate, with its reason - never
      // counted as stopped.
      const refused = stopped.body.skipped.find((s) => s.gridId === 'grid:unknown');
      expect(refused).toBeDefined();
      expect(refused!.stage).toBe('comms');
      expect(refused!.reason.length).toBeGreaterThan(0);
      expect(stopped.body.note).toContain('1 of 2');

      const order = await plugin.nextMessage(
        (m) => m.type === 'order' && (m as { orderType?: string }).orderType === 'stop' && (m as { entityId?: string }).entityId === SAT,
      );
      expect(order).toMatchObject({ type: 'order', orderType: 'stop', entityId: SAT });
      const stored = runtime.store.listOrders('group-stop:g-stop');
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ unitId: SAT, orderType: 'stop' });

      // A grid the owner is piloting by hand is never commanded.
      runtime.store.setKv(`demo:control:${SAT}`, JSON.stringify({ underControl: true, by: 'the owner', at: now }));
      const manual = await httpRequest<{ stopped: number; skipped: { gridId: string; stage: string }[] }>(
        port,
        'POST',
        '/api/demo/groups/g-stop/stop',
        { gridIds: [SAT] },
      );
      expect(manual.body.stopped).toBe(0);
      expect(manual.body.skipped[0]).toMatchObject({ gridId: SAT, stage: 'manual' });

      // A grid outside the group is reported as a membership skip.
      const outsider = await httpRequest<{ stopped: number; skipped: { gridId: string; stage: string }[] }>(
        port,
        'POST',
        '/api/demo/groups/g-stop/stop',
        { gridIds: ['grid:not-a-member'] },
      );
      expect(outsider.body.stopped).toBe(0);
      expect(outsider.body.skipped[0]).toMatchObject({ gridId: 'grid:not-a-member', stage: 'membership' });

      await plugin.close();
      await waitFor(() => runtime.hub.isConnected(), (connected) => connected === false);
      runtime.store.db.prepare('DELETE FROM kv WHERE k = ?').run(`demo:control:${SAT}`);
      const offline = await httpRequest<{ stopped: number; skipped: { gridId: string; stage: string; reason: string }[] }>(
        port,
        'POST',
        '/api/demo/groups/g-stop/stop',
        { gridIds: [SAT] },
      );
      expect(offline.body.stopped).toBe(0);
      expect(offline.body.skipped[0]).toMatchObject({ gridId: SAT, stage: 'send' });
      expect(offline.body.skipped[0]!.reason).toContain('plugin_offline');
      expect(offline.body.skipped[0]!.reason).not.toContain('stopped');
    });
  });
});
