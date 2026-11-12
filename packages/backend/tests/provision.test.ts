import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import {
  BASE_TAG,
  TEST_TAG,
  Provisioner,
  ProvisionError,
  controlSourcesFromState,
  loadProfiles,
  resetProvisionerForTests,
  teleportOwner,
} from '../src/demo/provision/index.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

interface Call {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Fake plugin hub: answers an order synchronously by writing the audit row the
 * real plugin writes, so `callPlugin` resolves on its first poll.
 */
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

function taggedGrid(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gridId: 'grid:1001',
    name: 'the owner Base',
    tags: [BASE_TAG],
    owner: OWNER,
    owners: [OWNER],
    pbName: 'PB [HERMES-BASE]',
    position: { x: 10, y: 20, z: 30 },
    blocksTotal: 40,
    radioCount: 1,
    laserCount: 1,
    massKg: 12000,
    ...overrides,
  };
}

/** Answers `list_tagged` with the supplied grids and every write with a read-back. */
function pluginAnsweringTags(grids: Record<string, unknown>[], calls: Call[] = []) {
  return (action: string, params: Record<string, unknown>) => {
    if (action === 'list_tagged') return { ok: true, result: { tag: `${BASE_TAG}|${TEST_TAG}`, count: grids.length, grids } };
    if (action === 'set_block_props') {
      const props = (params.props as Record<string, unknown>) ?? {};
      const filter = (params.filter as { type?: string }) ?? {};
      const blocks = [
        {
          entityId: '2001',
          name: filter.type === 'RadioAntenna' ? 'Antenna' : 'Block',
          subtype: filter.type ?? '',
          type: `MyObjectBuilder_${filter.type ?? 'Unknown'}`,
          // The real plugin resolves `$max` against the block and reads the number back.
          props: Object.entries(props).map(([id, value]) => ({
            id,
            kind: typeof value === 'boolean' ? 'bool' : 'float',
            before: null,
            after: value === '$max' ? 50000 : value,
          })),
          actions: [],
          errors: [],
        },
      ];
      return { ok: true, result: { gridId: params.entityId, count: blocks.length, applied: Object.keys(props).length, blocksWithErrors: 0, blocks } };
    }
    if (action === 'planets') return { ok: true, result: { planets: [{ entityId: 'grid:9', name: 'EarthLike', position: { x: 0, y: 0, z: 0 }, radiusM: 60000 }] } };
    if (action === 'teleport_player') {
      return { ok: true, result: { teleported: true, identityId: OWNER, position: { x: params.x, y: params.y, z: params.z }, adjustedForSurface: false } };
    }
    return { ok: false, error: `unexpected action ${action}` };
  };
}

afterEach(() => resetProvisionerForTests());

describe('provisioning profiles', () => {
  it('ships BASE and DRONE as data with a $max antenna radius', () => {
    const profiles = loadProfiles();
    expect(profiles.tags.BASE).toBe(BASE_TAG);
    expect(profiles.tags.DRONE).toBe(TEST_TAG);
    const radio = profiles.profiles.BASE.steps.find((s) => s.filter.type === 'RadioAntenna');
    expect(radio?.props).toMatchObject({ OnOff: true, EnableBroadCast: true, Radius: '$max' });
    const drone = profiles.profiles.DRONE.steps.map((s) => s.name).join(' | ');
    expect(drone).toContain('laser antennas idle');
    expect(drone).toContain('autopilot off');
    expect(drone).toContain('batteries on auto');
    expect(drone).toContain('timers off');
  });
});

describe('provisioner', () => {
  it('provisions a BASE grid, uses terminal actions and audits before/after', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid()], calls), calls);
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });

    const run = await provisioner.runOnce();
    expect(run.ok).toBe(true);
    expect(run.provisioned).toBe(1);

    const base = provisioner.state().bases[0]!;
    expect(base.profile).toBe('BASE');
    expect(base.radio).toMatchObject({ count: 1, broadcasting: true, radiusM: 50000 });

    // The battery is switched to Auto with the block's own terminal action.
    const battery = calls.filter((c) => c.action === 'set_block_props' && (c.params.filter as { type?: string }).type === 'Battery');
    expect(battery[0]!.params).toMatchObject({ props: { OnOff: true }, actions: ['Auto'] });

    const audit = store.listAudit(50).find((e) => e.action === 'provision_apply');
    expect(audit?.subject).toBe('grid:1001');
    const detail = audit?.detail as { props: { id: string; before: unknown; after: unknown }[] };
    expect(detail.props.some((p) => p.id === 'EnableBroadCast' && p.after === true)).toBe(true);

    // The gate reads this snapshot: live antenna read-back plus scan counts.
    const caps = JSON.parse(store.getKv('provision:capabilities') ?? '{}') as {
      grids?: { gridId: string; profile: string; radioRadiusM: number; laserCount: number; massKg: number }[];
    };
    expect(caps.grids?.[0]).toMatchObject({
      gridId: 'grid:1001',
      profile: 'BASE',
      radioRadiusM: 50_000,
      laserCount: 1,
      massKg: 12_000,
    });
  });

  it('samples laser_state on the poll and stores Connected pairs', async () => {
    const { store, config } = makeStore();
    const grids = [
      taggedGrid({ gridId: 'grid:1001', name: 'BASE-01' }),
      taggedGrid({ gridId: 'grid:2002', name: 'SAT-L-0001', tags: [TEST_TAG], laserCount: 2 }),
    ];
    const base = pluginAnsweringTags(grids);
    const hub = fakeHub(store, (action, params) => {
      if (action === 'laser_state') {
        return {
          ok: true,
          result: {
            grids: [
              { gridId: 'grid:1001', lasers: [{ entityId: '3001', status: 'Idle' }] },
              { gridId: 'grid:2002', lasers: [{ entityId: '4001', status: 'Connected', otherGridId: 'grid:1001' }] },
            ],
          },
        };
      }
      return base(action, params);
    });
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    await provisioner.runOnce();
    const lasers = JSON.parse(store.getKv('provision:lasers') ?? '{}') as { grids?: { gridId: string }[] };
    expect(lasers.grids?.map((g) => g.gridId)).toEqual(['grid:1001', 'grid:2002']);
  });

  it('is idempotent: an unchanged grid is not re-applied', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid()], calls), calls);
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });

    await provisioner.runOnce();
    const first = calls.length;
    calls.length = 0;
    const second = await provisioner.runOnce();
    expect(second.skipped).toBe(1);
    expect(second.provisioned).toBe(0);
    // Only the read-only list_tagged poll happened; nothing was written again.
    expect(calls.filter((c) => c.action === 'set_block_props')).toHaveLength(0);
    expect(first).toBeGreaterThan(0);
  });

  it('re-applies when the grid changed (block count differs)', async () => {
    const { store, config } = makeStore();
    let blocks = 40;
    const calls: Call[] = [];
    const responder = (action: string, params: Record<string, unknown>) => {
      if (action === 'list_tagged') {
        return { ok: true, result: { grids: [taggedGrid({ blocksTotal: blocks })] } };
      }
      return pluginAnsweringTags([], calls)(action, params);
    };
    const hub = fakeHub(store, responder, calls);
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });

    await provisioner.runOnce();
    blocks = 44;
    const run = await provisioner.runOnce();
    expect(run.provisioned).toBe(1);
  });

  it('skips a grid whose owner is not the owner identity and says why', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid({ owner: '10000000000000001', owners: ['10000000000000001'] })], calls));
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });

    const run = await provisioner.runOnce();
    expect(run.provisioned).toBe(0);
    expect(run.skipped).toBe(1);
    expect(calls.some((c) => c.action === 'set_block_props')).toBe(false);
    const state = provisioner.state();
    expect(state.bases).toHaveLength(0);
    expect(state.issues[0]?.reason).toContain('is not the owner identity');
  });

  it('classifies [HERMES-TEST] grids as drones', async () => {
    const { store, config } = makeStore();
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid({ gridId: 'grid:2002', name: 'Hull', tags: [TEST_TAG] })]));
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    await provisioner.runOnce();
    const state = provisioner.state();
    expect(state.drones).toHaveLength(1);
    expect(state.drones[0]!.profile).toBe('DRONE');
    expect(state.drones[0]!.steps.map((s) => s.name).join(' ')).toContain('remote control');
  });

  it('reports plugin-offline as an issue instead of throwing', async () => {
    const { store, config } = makeStore();
    const hub = fakeHub(store, pluginAnsweringTags([]), [], false);
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    await expect(provisioner.runOnce()).rejects.toThrow(ProvisionError);
  });
});

describe('gate hook', () => {
  it('only exposes bases whose antenna was read back as broadcasting', async () => {
    const { store, config } = makeStore();
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid()]));
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    await provisioner.runOnce();
    const sources = controlSourcesFromState(provisioner.state());
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ gridId: 'grid:1001', antennaBroadcasting: true, labels: { antenna: 'GAME', range: 'SIMULATED' } });

    // A base whose antenna never read back as broadcasting is not a control source.
    expect(controlSourcesFromState({ ...provisioner.state(), bases: [{ ...provisioner.state().bases[0]!, radio: { count: 1, broadcasting: false, radiusM: 1000 } }] })).toHaveLength(0);
  });
});

describe('teleport', () => {
  it('places the owner 300 m above a planet surface radius', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(store, pluginAnsweringTags([], calls), calls);
    const result = await teleportOwner({ config, store, hub, clock: () => NOW }, 'planet:earthlike');
    expect(result.position.x).toBeCloseTo(0, 3);
    expect(result.position.y).toBeCloseTo(60300, 3);
    const call = calls.find((c) => c.action === 'teleport_player');
    expect(call?.params).toMatchObject({ identityId: OWNER, y: 60300 });
  });

  it('places the owner next to a tagged grid', async () => {
    const { store, config } = makeStore();
    const hub = fakeHub(store, pluginAnsweringTags([taggedGrid()]));
    const result = await teleportOwner({ config, store, hub, clock: () => NOW }, 'grid:1001');
    expect(result.position).toMatchObject({ x: 10, y: 45, z: 55 });
  });

  it('refuses when the player is not in the world', async () => {
    const { store, config } = makeStore();
    const hub = fakeHub(store, () => ({ ok: true, result: { teleported: false, reason: 'player is connected but has no character in the world', online: [] } }));
    await expect(teleportOwner({ config, store, hub, clock: () => NOW }, { x: 1, y: 2, z: 3 })).rejects.toThrow(/no character/);
  });
});
