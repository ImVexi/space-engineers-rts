/**
 * Short ship-role tags work everywhere (2026-11-11).
 *
 * The shared resolver in `demo/roles.ts` accepts `[BASE]` / `[MANAGED]` /
 * `[PERSONAL]` / `[OFF]`, the long `[HERMES-*]` spellings and the
 * `HERMES_ROLE=` CustomData line, on ANY block. These tests pin that the
 * PROVISIONER, the capability snapshot, the comms gate and naming all consume
 * that one resolution: a `[BASE]` on a cargo container is a control source, a
 * `[MANAGED]` on a cargo container is provisioned and reachable, and the old
 * long tags keep working. Live ownership still refuses a foreign grid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import {
  BASE_TAG,
  TEST_TAG,
  Provisioner,
  controlSourcesFromState,
  loadProfiles,
  profileForGrid,
  resetProvisionerForTests,
  type TaggedGrid,
} from '../src/demo/provision/index.js';
import { resolveGridRole, shipRoles, type RoleHint } from '../src/demo/roles.js';
import { capabilitiesFromStore, networkSnapshot } from '../src/demo/network.js';
import { evaluateGate } from '../src/demo/gate.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { namingAutoEnabled, pbTagPrefix, NamingService, resetNamingForTests } from '../src/demo/naming/index.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;
const FOREIGN = '10000000000000009';
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

interface Call {
  action: string;
  params: Record<string, unknown>;
}

function fakeHub(
  store: Store,
  responder: (action: string, params: Record<string, unknown>) => { ok: boolean; result?: Record<string, unknown>; error?: string },
  calls: Call[] = [],
) {
  return {
    isConnected: () => true,
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

/** A `list_tagged` grid row exactly as the plugin sends it: tags are the LONG
 *  spellings only, role hints carry whatever the owner actually typed. */
function gridRow(overrides: Partial<TaggedGrid> = {}): TaggedGrid {
  return {
    gridId: 'grid:base',
    name: 'HOME',
    tags: [],
    roleHints: [],
    owner: OWNER,
    owners: [OWNER],
    ownerFactions: [null],
    pbName: null,
    position: { x: 1_000, y: 500, z: EARTH.surfaceRadiusM + 2_000 },
    blocksTotal: 40,
    radioCount: 1,
    laserCount: 0,
    massKg: 12_000,
    ...overrides,
  };
}

function hint(role: RoleHint['role'], token: string, block: string, source: RoleHint['source'] = 'block-name'): RoleHint {
  return { role, token, source, block };
}

/** Generic plugin: every write answers with one block whose props read back. */
function pluginAnswering(grids: TaggedGrid[], calls: Call[] = []) {
  return (action: string, params: Record<string, unknown>) => {
    if (action === 'list_tagged') return { ok: true, result: { tag: `${BASE_TAG}|${TEST_TAG}`, count: grids.length, grids } };
    if (action === 'set_block_props') {
      const props = (params.props as Record<string, unknown>) ?? {};
      const filter = (params.filter as { type?: string }) ?? {};
      const blocks = [
        {
          entityId: '2001',
          name: filter.type === 'RadioAntenna' ? 'Antenna [BASE]' : 'Block',
          subtype: filter.type ?? '',
          type: `MyObjectBuilder_${filter.type ?? 'Unknown'}`,
          props: Object.entries(props).map(([id, value]) => ({
            id,
            kind: typeof value === 'boolean' ? 'bool' : 'float',
            before: null,
            after: value === '$max' ? 50_000 : value,
          })),
          actions: [],
          errors: [],
        },
      ];
      return { ok: true, result: { gridId: params.entityId, count: 1, applied: Object.keys(props).length, blocksWithErrors: 0, blocks } };
    }
    if (action === 'laser_state') return { ok: true, result: { grids: [] } };
    return { ok: false, error: `unexpected action ${action}` };
  };
}

function unit(store: Store, id: string, name: string, x: number): void {
  store.upsertUnit({
    id,
    name,
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x, y: 500, z: EARTH.surfaceRadiusM + 2_000 },
    vel: null,
    meta: {},
  });
}

afterEach(() => {
  resetProvisionerForTests();
  resetNamingForTests();
  shipRoles.reset();
});

describe('short role tags drive provisioning', () => {
  it('[BASE] on a cargo container + antenna is a control source; [MANAGED] on a cargo container is reachable', async () => {
    const { store, config } = makeStore();
    const grids = [
      gridRow({
        gridId: 'grid:base',
        name: 'HOME',
        roleHints: [hint('base', '[BASE]', 'Cargo Container [BASE]')],
        blocks: [{ name: 'Cargo Container [BASE]', customName: 'Cargo Container [BASE]', customData: '', subtype: 'LargeCargoContainer' }],
        radioCount: 1,
      }),
      gridRow({
        gridId: 'grid:ship',
        name: 'HULL',
        roleHints: [hint('managed', '[MANAGED]', 'Cargo Container [MANAGED]')],
        blocks: [{ name: 'Cargo Container [MANAGED]', customName: 'Cargo Container [MANAGED]', customData: '', subtype: 'LargeCargoContainer' }],
        radioCount: 1,
        position: { x: 3_000, y: 500, z: EARTH.surfaceRadiusM + 2_000 },
      }),
    ];
    const hub = fakeHub(store, pluginAnswering(grids));
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    const run = await provisioner.runOnce();

    expect(run.provisioned).toBe(2);
    expect(provisioner.state().bases.map((b) => b.gridId)).toEqual(['grid:base']);
    expect(provisioner.state().drones.map((d) => d.gridId)).toEqual(['grid:ship']);
    // The base's antenna was read back as broadcasting, so it authorises.
    expect(controlSourcesFromState(provisioner.state()).map((s) => s.gridId)).toEqual(['grid:base']);
    expect(capabilitiesFromStore(store).get('grid:base')!.controlSource).toBe(true);
    expect(capabilitiesFromStore(store).get('grid:ship')!.profile).toBe('DRONE');

    // The comms gate reaches the [MANAGED] ship from the [BASE] grid.
    unit(store, 'grid:base', 'HOME', 1_000);
    unit(store, 'grid:ship', 'HULL', 3_000);
    const gate = evaluateGate({ store, world: seedWorld(NOW), now: NOW, nodeId: 'grid:ship' });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain('HOME');
    expect(gate.capability?.profile).toBe('DRONE');
  });

  it('accepts the CustomData form on a non-PB block and keeps the long tags working', async () => {
    const profiles = loadProfiles();
    const viaCustomDataBase = gridRow({
      gridId: 'grid:cd-base',
      roleHints: [hint('base', 'HERMES_ROLE=base', 'Cargo Container', 'custom-data')],
      blocks: [{ name: 'Cargo Container', customData: 'station\nHERMES_ROLE=base', subtype: 'LargeCargoContainer' }],
    });
    const viaCustomDataShip = gridRow({
      gridId: 'grid:cd-ship',
      roleHints: [hint('managed', 'HERMES_ROLE=managed', 'Cargo Container', 'custom-data')],
      blocks: [{ name: 'Cargo Container', customData: 'HERMES_ROLE=managed', subtype: 'LargeCargoContainer' }],
    });
    expect(profileForGrid(profiles, viaCustomDataBase)).toBe('BASE');
    expect(profileForGrid(profiles, viaCustomDataShip)).toBe('DRONE');

    // Long tags: the legacy shape with no roleHints at all still maps by tag.
    expect(profileForGrid(profiles, gridRow({ gridId: 'grid:old-base', tags: [BASE_TAG] }))).toBe('BASE');
    expect(profileForGrid(profiles, gridRow({ gridId: 'grid:old-ship', tags: [TEST_TAG] }))).toBe('DRONE');
    // And the long tags as hints on a non-PB block.
    expect(
      profileForGrid(profiles, gridRow({ gridId: 'grid:long', roleHints: [hint('managed', '[HERMES-MANAGED]', 'Cargo Container')] })),
    ).toBe('DRONE');
  });

  it('never provisions PERSONAL/OFF, nor an untagged grid (test default MANAGED)', async () => {
    const { store, config } = makeStore();
    const grids = [
      gridRow({ gridId: 'grid:mine', roleHints: [hint('personal', '[PERSONAL]', 'Cargo Container')] }),
      gridRow({ gridId: 'grid:off', roleHints: [hint('off', '[OFF]', 'Cargo Container')] }),
      gridRow({ gridId: 'grid:untagged', tags: [], roleHints: [] }),
    ];
    const hub = fakeHub(store, pluginAnswering(grids));
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    const run = await provisioner.runOnce();
    expect(run.provisioned).toBe(0);
    expect(run.skipped).toBe(3);
    expect(capabilitiesFromStore(store).size).toBe(0);
  });

  it('live: a foreign-owned [MANAGED] grid is OFF and gets no profile', async () => {
    const profiles = loadProfiles();
    const policy = { live: true, steamIds: ['10000000000000001'], identityIds: new Set([OWNER]), factionTags: new Set<string>() };
    const foreign = gridRow({
      gridId: 'grid:theirs',
      owner: FOREIGN,
      owners: [FOREIGN],
      ownerFactions: [null],
      roleHints: [hint('managed', '[MANAGED]', 'Cargo Container')],
    });
    const res = resolveGridRole(foreign, { live: true, policy });
    expect(res.role).toBe('off');
    expect(res.roleSource).toBe('ownership');
    expect(profileForGrid(profiles, foreign, res)).toBeNull();

    const mine = gridRow({ gridId: 'grid:mine', roleHints: [hint('managed', '[MANAGED]', 'Cargo Container')] });
    const mineRes = resolveGridRole(mine, { live: true, policy });
    expect(mineRes.role).toBe('managed');
    expect(profileForGrid(profiles, mine, mineRes)).toBe('DRONE');

    // Untagged on live is OFF too, even on a grid we own.
    expect(profileForGrid(profiles, gridRow({ gridId: 'grid:blank', tags: [], roleHints: [] }), resolveGridRole(gridRow(), { live: true, policy }))).toBeNull();
  });
});

describe('naming keeps the owner’s tag form', () => {
  it('keeps [BASE] / [MANAGED] and adds nothing when the mark is CustomData-only', () => {
    expect(pbTagPrefix('BASE', gridRow({ roleHints: [hint('base', '[BASE]', 'PB [BASE]')] }))).toBe('[BASE]');
    expect(pbTagPrefix('SAT', gridRow({ roleHints: [hint('managed', '[MANAGED]', 'PB [MANAGED]')] }))).toBe('[MANAGED]');
    // Long tags are preserved exactly as typed, not normalised.
    expect(pbTagPrefix('BASE', gridRow({ roleHints: [hint('base', '[HERMES-BASE]', 'PB [HERMES-BASE]')] }))).toBe('[HERMES-BASE]');
    // CustomData-only mark: no name tag is minted.
    expect(pbTagPrefix('SAT', gridRow({ roleHints: [hint('managed', 'HERMES_ROLE=managed', 'Cargo', 'custom-data')] }))).toBeNull();
  });

  it('auto-rename is off by default on live and on for the test instance', () => {
    expect(namingAutoEnabled({ RTS_ENV: 'live' } as NodeJS.ProcessEnv)).toBe(false);
    expect(namingAutoEnabled({ RTS_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
    expect(namingAutoEnabled({ RTS_ENV: 'live', RTS_NAMING_AUTO: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('renames the grid but writes the owner’s short tag on the PB', async () => {
    const { store, config } = makeStore();
    const grids = [
      gridRow({
        gridId: 'grid:base',
        name: 'Small Grid 17',
        roleHints: [hint('base', '[BASE]', 'Cargo Container [BASE]')],
        blocksTotal: 40,
        radioCount: 1,
      }),
    ];
    const calls: Call[] = [];
    const hub = fakeHub(store, (action, params) => {
      if (action === 'list_tagged') return { ok: true, result: { grids } };
      if (action === 'rename_grid' || action === 'rename_block') return { ok: true, result: { ok: true, after: params.name, blocks: [] } };
      return { ok: true, result: {} };
    }, calls);
    const naming = new NamingService({ config, store, hub, clock: () => NOW });
    await naming.sync(grids);
    const pb = calls.find((c) => c.action === 'rename_block' && (c.params.filter as { type?: string })?.type === 'ProgrammableBlock');
    expect(String(pb?.params.name)).toMatch(/^\[BASE\] BASE-\d+$/);
    expect(String(pb?.params.name)).not.toContain('[HERMES-BASE]');
  });
});
