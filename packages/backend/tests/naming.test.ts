import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import { loadProfiles, BASE_TAG, TEST_TAG, type TaggedGrid } from '../src/demo/provision/index.js';
import {
  NamingService,
  bestLaserPair,
  isDefaultName,
  resetNamingForTests,
  satClassOf,
} from '../src/demo/naming/index.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;

interface Call {
  action: string;
  params: Record<string, unknown>;
}

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

function fakeHub(
  store: Store,
  responder: (action: string, params: Record<string, unknown>) => { ok: boolean; result?: Record<string, unknown>; error?: string },
  calls: Call[] = [],
  connected = true,
) {
  return {
    isConnected: () => connected,
    agentId: () => 'fake-plugin',
    send: (message: unknown) => {
      const msg = message as { orderId: string; params: { action: string } & Record<string, unknown> };
      const action = msg.params.action;
      calls.push({ action, params: msg.params });
      const answer = responder(action, msg.params);
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: msg.orderId,
        detail: { eventType: 'order_result', data: { orderId: msg.orderId, ...answer } },
        at: NOW,
      });
      return true;
    },
  } as never;
}

function sat(overrides: Partial<TaggedGrid> = {}): TaggedGrid {
  return {
    gridId: 'grid:1001',
    name: 'Small Grid 1774',
    tags: [TEST_TAG],
    owner: OWNER,
    owners: [OWNER],
    pbName: 'PB [HERMES-TEST]',
    position: { x: 0, y: 0, z: 0 },
    blocksTotal: 59,
    radioCount: 1,
    laserCount: 2,
    massKg: 18965,
    ...overrides,
  };
}

/** Fake plugin: rename + laser state, with a real connect transition. */
function pluginAnsweringTags(grids: TaggedGrid[], calls: Call[] = []) {
  const connected = new Map<string, string>();
  return (action: string, params: Record<string, unknown>) => {
    if (action === 'list_tagged') return { ok: true, result: { tag: `${BASE_TAG}|${TEST_TAG}`, count: grids.length, grids } };
    if (action === 'rename_grid') {
      const g = grids.find((x) => x.gridId === params.entityId);
      if (g) g.name = String(params.name);
      return { ok: true, result: { ok: true, after: params.name } };
    }
    if (action === 'rename_block') {
      return { ok: true, result: { renamed: 1, blocks: [{ entityId: params.blockEntityId ?? '2001', after: params.name }] } };
    }
    if (action === 'laser_state') {
      const wanted = Array.isArray(params.gridIds) ? (params.gridIds as string[]) : [params.gridId as string];
      const out = grids
        .filter((g) => wanted.includes(g.gridId) && (g.laserCount ?? 0) > 0)
        .map((g) => ({
          gridId: g.gridId,
          name: g.name,
          laserCount: g.laserCount ?? 0,
          lasers: Array.from({ length: g.laserCount ?? 0 }, (_, i) => {
            const entityId = g.gridId === 'grid:1001' ? String(5001 + i) : String(6001 + i);
            const partner = g.gridId === 'grid:1001' ? 'grid:1002' : 'grid:1001';
            return {
              entityId,
              name: `laser ${i + 1}`,
              position: {
                x: g.gridId === 'grid:1001' ? i * 5 : 100 + i * 5,
                y: 0,
                z: 0,
              },
              status: connected.has(entityId) ? 'Connected' : 'Idle',
              rangeM: 5000,
              maxRangeM: 10000,
              isPermanent: false,
              otherGridId: connected.get(entityId) ?? null,
              otherAntennaId: connected.has(entityId) ? (g.gridId === 'grid:1001' ? '6001' : '5001') : null,
              powerDrawMw: { idle: 0.01, turning: 0.1, lasing: 1.5 },
              _partner: partner,
            };
          }),
        }));
      return { ok: true, result: { count: out.length, grids: out } };
    }
    if (action === 'laser_target') return { ok: true, result: { status: 'RotatingToTarget' } };
    if (action === 'laser_connect') {
      const id = String(params.laserBlockId);
      connected.set(id, id.startsWith('5') ? 'grid:1002' : 'grid:1001');
      return { ok: true, result: { status: 'Connected' } };
    }
    if (action === 'laser_disconnect') {
      connected.delete(String(params.laserBlockId));
      return { ok: true, result: { status: 'Idle' } };
    }
    if (action === 'set_block_props') return { ok: true, result: { count: 1, applied: 1, blocks: [] } };
    return { ok: false, error: `unexpected action ${action}` };
  };
}

afterEach(() => resetNamingForTests());

describe('naming scheme', () => {
  it('classifies satellites by radio/laser counts', () => {
    expect(satClassOf(1, 2)).toBe('L');
    expect(satClassOf(0, 2)).toBe('L');
    expect(satClassOf(1, 1)).toBe('M');
    expect(satClassOf(1, 0)).toBe('R');
    expect(satClassOf(0, 1)).toBe('L');
  });

  it('treats stock grid names as defaults, not owner renames', () => {
    expect(isDefaultName('Small Grid 1774')).toBe(true);
    expect(isDefaultName('Static Grid 9763')).toBe(true);
    expect(isDefaultName('')).toBe(true);
    expect(isDefaultName('SAT-L-0001')).toBe(false);
    expect(isDefaultName('the owner Flagship')).toBe(false);
  });
});

describe('NamingService', () => {
  it('assigns SAT-L-0001 and names grid, radio, both lasers and the PB', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const grids = [sat()];
    const hub = fakeHub(store, pluginAnsweringTags(grids, calls), calls);
    const naming = new NamingService({ config, store, hub, clock: () => NOW });

    const run = await naming.sync(grids);
    expect(run.assigned).toBe(1);
    expect(run.errors).toEqual([]);
    expect(naming.record('grid:1001')?.name).toBe('SAT-L-0001');
    expect(naming.record('grid:1001')?.renameOk).toBe(true);

    const renames = calls.filter((c) => c.action === 'rename_block');
    const names = renames.map((c) => String(c.params.name));
    expect(names).toContain('SAT-L-0001');
    expect(names).toContain('SAT-L-0001 L1');
    expect(names).toContain('SAT-L-0001 L2');
    expect(names).toContain('[HERMES-TEST] SAT-L-0001');

    // Every rename is audited.
    const audit = store.listAudit(50).filter((a) => a.action === 'naming_rename');
    expect(audit.length).toBe(1);
    expect(audit[0]?.subject).toBe('grid:1001');
  });

  it('never reuses a number and persists across instances', async () => {
    const { store, config } = makeStore();
    const grids = [sat({ gridId: 'grid:1001' }), sat({ gridId: 'grid:1002', radioCount: 1, laserCount: 0 })];
    const hub = fakeHub(store, pluginAnsweringTags(grids));
    const first = new NamingService({ config, store, hub, clock: () => NOW });
    await first.sync(grids);
    expect(first.record('grid:1001')?.name).toBe('SAT-L-0001');
    expect(first.record('grid:1002')?.name).toBe('SAT-R-0001');

    // New instance reads the SQLite kv row: the same grid keeps its name.
    const second = new NamingService({ config, store, hub, clock: () => NOW });
    await second.sync(grids);
    expect(second.record('grid:1001')?.name).toBe('SAT-L-0001');

    // A new grid gets the next number, not 0001 again.
    const third = sat({ gridId: 'grid:1003', radioCount: 1, laserCount: 1 });
    await second.sync([...grids, third]);
    expect(second.record('grid:1003')?.name).toBe('SAT-M-0001');
    // And the L counter advanced independently.
    expect(second.state().counters['SAT-L']).toBe(1);
  });

  it('marks an in-game rename as an owner override and stops touching it', async () => {
    const { store, config } = makeStore();
    const grids = [sat()];
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags(grids, calls), calls);
    const naming = new NamingService({ config, store, hub, clock: () => NOW });
    await naming.sync(grids);

    // Owner renames in game; the next scan sees a non-default name.
    grids[0]!.name = 'the owner Relay One';
    const before = calls.length;
    const run = await naming.sync(grids);
    expect(run.overrides).toBe(1);
    expect(naming.record('grid:1001')?.ownerOverride).toBe(true);
    expect(calls.length).toBe(before);
    expect(store.listAudit(50).some((a) => a.action === 'naming_owner_override')).toBe(true);
  });

  it('does not treat an unchanged default name as an override', async () => {
    const { store, config } = makeStore();
    const grids = [sat()];
    const hub = fakeHub(store, pluginAnsweringTags(grids));
    const naming = new NamingService({ config, store, hub, clock: () => NOW });
    await naming.sync(grids);
    // Simulate a grid whose DisplayName stays stock after our rename.
    grids[0]!.name = 'Small Grid 1774';
    const run = await naming.sync(grids);
    expect(run.overrides).toBe(0);
    expect(naming.record('grid:1001')?.ownerOverride).toBe(false);
  });

  it('site rename applies the name and marks the override', async () => {
    const { store, config } = makeStore();
    const grids = [sat()];
    const hub = fakeHub(store, pluginAnsweringTags(grids));
    const naming = new NamingService({ config, store, hub, clock: () => NOW });
    await naming.sync(grids);

    const res = await naming.manualRename('grid:1001', 'Owner Pick');
    expect(res.record.name).toBe('Owner Pick');
    expect(res.record.ownerOverride).toBe(true);
    const audit = store.listAudit(50).find((a) => a.action === 'naming_rename' && a.actor === 'owner-request');
    expect(audit?.subject).toBe('grid:1001');
  });
});

describe('laser pair selection', () => {
  it('picks the longest pair that fits inside both ranges', () => {
    const mk = (id: string, x: number, maxRangeM: number) => ({
      gridId: id,
      name: id,
      laserCount: 1,
      lasers: [{ entityId: `${id}:l`, name: `${id} L1`, position: { x, y: 0, z: 0 }, maxRangeM }],
    });
    const pair = bestLaserPair([mk('grid:a', 0, 5000), mk('grid:b', 100, 5000), mk('grid:c', 9000, 5000)]);
    expect(pair?.a.gridId).toBe('grid:a');
    expect(pair?.b.gridId).toBe('grid:b');
  });
});

describe('laser test', () => {
  it('aims, connects, records the link and cleans up', async () => {
    const { store, config } = makeStore();
    const grids = [sat({ gridId: 'grid:1001' }), sat({ gridId: 'grid:1002' })];
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags(grids, calls), calls);
    const naming = new NamingService({ config, store, hub, clock: () => NOW });

    const result = await naming.runLaserTest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.distanceM).toBe(100);
    expect(result.finalStatus).toEqual({ a: 'Connected', b: 'Connected' });
    expect(result.connectedTo).toEqual({ a: 'grid:1002', b: 'grid:1001' });
    expect(result.cleanup?.disconnects).toBe(2);
    expect(result.cleanup?.lasersOff).toBe(2);

    const acts = calls.map((c) => c.action);
    expect(acts).toContain('laser_target');
    expect(acts).toContain('laser_connect');
    expect(acts).toContain('laser_disconnect');
    expect(store.listAudit(80).some((a) => a.action === 'laser_test')).toBe(true);
    expect(naming.laserTest()?.ok).toBe(true);
  });
});
