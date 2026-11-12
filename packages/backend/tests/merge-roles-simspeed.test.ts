/**
 * Merge contract: ship-roles + simspeed both rewrote the plugin's `list_tagged`.
 *
 * The merged action is ONE cheap `GetBlocks` pass (simspeed: no nested
 * `profile`, `blocks[]` rows instead) that ALSO parses every block's
 * CustomName/CustomData for role tags (ship-roles: `roleHints`/`roleTags`/
 * `role`, and role-hinted grids listed with no explicit tag filter).
 *
 * These tests pin the seam, not the plugin internals: the backend must resolve
 * a `[PERSONAL]` in a NON-programmable block's CustomName and a
 * `HERMES_ROLE=off` in its CustomData, from whichever fields the merged plugin
 * returns (`list_tagged.roleHints`, its `blocks[]` rows, or `inspect`'s
 * `taggedBlocks`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import { hintsFromInspect, hintsFromPluginGrid, resolveRole, shipRoles } from '../src/demo/roles.js';
import {
  Provisioner,
  loadProfiles,
  resetProvisionerForTests,
} from '../src/demo/provision/index.js';
import { profileForGrid } from '../src/demo/provision/provisioner.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;

function makeStore() {
  return { store: new Store(openDb(':memory:', { memory: true })), config: makeConfig() };
}

interface Call {
  action: string;
  params: Record<string, unknown>;
}

/** Same fake as simspeed.test.ts: answers through the audit cursor. */
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
      calls.push({ action: msg.params.action, params: msg.params });
      const answer = responder(msg.params.action, msg.params);
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

/** A block row as the merged single pass emits it (`list_tagged.blocks[]`). */
const blockRow = (name: string, customData = '', subtype = 'LargeCargoContainer') => ({
  id: `block:${name.length}${subtype.length}`,
  name,
  customName: name,
  customData,
  subtype,
});

const personalHint = {
  role: 'personal',
  token: '[PERSONAL]',
  source: 'block-name',
  block: '[PERSONAL] the owner tug',
};
const offHint = {
  role: 'off',
  token: 'HERMES_ROLE=off',
  source: 'custom-data',
  block: 'Timer',
};

/**
 * The merged plugin's `list_tagged` row, both halves present: the cheap scan
 * fields (counts, mass, blocks[]) AND the role fields computed in that pass.
 */
function mergedGrid(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gridId: 'grid:tug',
    name: 'the owner tug',
    tags: [],
    owner: OWNER,
    owners: [OWNER],
    pbName: null,
    position: { x: 1, y: 2, z: 3 },
    blocksTotal: 3,
    radioCount: 1,
    laserCount: 0,
    massKg: 9000,
    isStatic: false,
    profiled: false,
    thrust: null,
    twr: null,
    gravityMs2: null,
    canGroundLaunch: null,
    // The tag sits on a cargo container, NOT on a programmable block.
    blocks: [blockRow('[PERSONAL] the owner tug')],
    roleHints: [personalHint],
    roleTags: ['personal'],
    role: 'personal',
    ...overrides,
  };
}

const offGrid = mergedGrid({
  gridId: 'grid:hidden',
  name: 'Hidden timer hull',
  blocks: [blockRow('Timer', '# config\nHERMES_ROLE=off\n', 'TimerBlock')],
  roleHints: [offHint],
  roleTags: ['off'],
  role: 'off',
});

beforeEach(() => {
  shipRoles.reset();
  resetProvisionerForTests();
});

afterEach(() => {
  resetProvisionerForTests();
});

describe('merge contract — role tags inside the cheap list_tagged scan', () => {
  it('resolves [PERSONAL] from a non-PB block CustomName in the merged payload', () => {
    const hints = hintsFromPluginGrid(mergedGrid());
    expect(hints).toEqual([personalHint]);
    expect(resolveRole({ hints })).toMatchObject({ role: 'personal', roleSource: 'in-game-tag' });
  });

  it('resolves HERMES_ROLE=off from a block CustomData in the merged payload', () => {
    const hints = hintsFromPluginGrid(offGrid);
    expect(hints).toEqual([offHint]);
    expect(resolveRole({ hints })).toMatchObject({ role: 'off', roleSource: 'in-game-tag' });
  });

  it('still resolves both tags when only blocks[] is present (roleHints dropped)', () => {
    const bare = mergedGrid({ roleHints: undefined, roleTags: undefined, role: undefined });
    expect(resolveRole({ hints: hintsFromPluginGrid(bare) }).role).toBe('personal');
    const bareOff = { ...offGrid, roleHints: undefined, roleTags: undefined, role: undefined };
    expect(resolveRole({ hints: hintsFromPluginGrid(bareOff) }).role).toBe('off');
  });

  it('resolve the same roles from an inspect result (roleHints or taggedBlocks)', () => {
    expect(resolveRole({ hints: hintsFromInspect({ roleHints: [personalHint] }) }).role).toBe('personal');
    expect(resolveRole({ hints: hintsFromInspect({ taggedBlocks: mergedGrid().blocks }) }).role).toBe('personal');
    expect(resolveRole({ hints: hintsFromInspect({ taggedBlocks: offGrid.blocks }) }).role).toBe('off');
  });

  it('keeps OFF > PERSONAL when both tags land on one grid', () => {
    const both = mergedGrid({
      gridId: 'grid:both',
      blocks: [blockRow('[PERSONAL] the owner tug'), blockRow('Timer', 'HERMES_ROLE=off', 'TimerBlock')],
      roleHints: [personalHint, offHint],
      roleTags: ['personal', 'off'],
      role: 'off',
    });
    expect(resolveRole({ hints: hintsFromPluginGrid(both) })).toMatchObject({ role: 'off', conflict: true });
  });
});

describe('merge contract — the provisioner poll uses that same payload', () => {
  it('registers PERSONAL and OFF grids and applies no profile to either', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(store, (action) => {
      if (action === 'list_tagged') return { ok: true, result: { count: 2, grids: [mergedGrid(), offGrid] } };
      return { ok: false, error: `unexpected action ${action}` };
    }, calls);

    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    const run = await provisioner.runOnce();

    // One cheap scan, no per-grid `profile`, and no tag filter (so role-only
    // grids are listed at all).
    expect(calls.filter((c) => c.action === 'list_tagged')).toHaveLength(1);
    expect(calls.some((c) => c.action === 'profile')).toBe(false);
    expect(calls[0]?.params.withProfile).toBeUndefined();
    expect(calls[0]?.params.tags).toBeUndefined();

    // Both roles made it into the process-wide registry through the seam.
    expect(shipRoles.roleOf('grid:tug')).toBe('personal');
    expect(shipRoles.roleOf('grid:hidden')).toBe('off');
    expect(shipRoles.resolution('grid:tug').reason).toContain('[PERSONAL]');
    expect(shipRoles.resolution('grid:hidden').reason).toContain('HERMES_ROLE=off');
    // PERSONAL is never provisioned; OFF is untouched.
    expect(run.provisioned).toBe(0);
    expect(run.scanned).toBe(2);
  });

  it('gates profileForGrid on the same hints the poll registered', () => {
    const profiles = loadProfiles();
    expect(profileForGrid(profiles, mergedGrid() as never)).toBeNull();
    expect(profileForGrid(profiles, offGrid as never)).toBeNull();
    // A plain [HERMES-TEST] grid keeps the legacy DRONE mapping.
    const managed = mergedGrid({
      gridId: 'grid:drone',
      tags: ['[HERMES-TEST]'],
      blocks: [blockRow('PB [HERMES-TEST]', '', 'MyProgrammableBlock')],
      roleHints: [],
      roleTags: [],
      role: null,
    });
    expect(profileForGrid(profiles, managed as never)).toBe('DRONE');
  });
});
