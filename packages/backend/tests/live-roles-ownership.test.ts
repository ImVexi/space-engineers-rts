/**
 * T79: the LIVE (survival) instance is safe on a shared multiplayer world.
 *
 * Three properties, pinned here so a later edit cannot quietly undo them:
 *
 *   1. ROLE DEFAULT BY ENV. On `RTS_ENV=live` an untagged grid is OFF
 *      (`roleSource: 'default-live'`) - never MANAGED. The test instance keeps
 *      today's MANAGED default, so no existing test flow changes.
 *   2. OWNERSHIP. On the live instance any non-OFF role requires the grid's big
 *      owner to be a configured owner identity (default: the owner) or in his faction;
 *      a foreign/NPC grid is OFF with the reason `not owned by you`, whatever tag
 *      it carries - including at the executor's send boundary.
 *   3. SIM-SPEED SOURCE. The live server has RemoteApiEnabled=false, so the
 *      Remote API sampler has nothing to read. The monitor falls back to the
 *      plugin's in-process simulation ratio; the test server still asks the
 *      Remote API first. Threshold stays 0.95.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor, gridMoveMission } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import {
  mostRestrictive,
  orderDecision,
  parseRoleText,
  resolveRole,
  shipRoles,
  type RoleHint,
} from '../src/demo/roles.js';
import {
  buildOwnerPolicy,
  ownershipVerdict,
  parseOwnerSteamIds,
  type OwnerPolicy,
} from '../src/demo/ownership.js';
import { SimSpeedMonitor } from '../src/demo/simSpeed.js';
import { makeConfig } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = 1_800_000_000_000;
/** Test-only Steam ids; the shipped default is an empty allow-list. */
const OWNER_STEAM_ID = '10000000000000001';
const FRIEND_STEAM_ID = '10000000000000002';
const OUR_IDENTITY = '144115188075855926';
const FRIEND_IDENTITY = '144115188075855999';
const NPC_IDENTITY = '144115188075857777';
const TARGET = { x: 59_402_000, y: 0, z: 0 };

function hint(role: RoleHint['role'], token = `[${role.toUpperCase()}]`): RoleHint {
  return { role, token, source: 'block-name', block: 'Tag PB' };
}

function livePolicy(extra: Partial<{ identityIds: string[]; factionTags: string[]; steamIds: string[] }> = {}): OwnerPolicy {
  return {
    live: true,
    steamIds: extra.steamIds ?? [OWNER_STEAM_ID],
    identityIds: new Set(extra.identityIds ?? [OUR_IDENTITY]),
    factionTags: new Set((extra.factionTags ?? []).map((t) => t.toUpperCase())),
  };
}

describe('T79 role default by environment', () => {
  it('untagged on the live instance is OFF with the default-live source and the runbook sentence', () => {
    const res = resolveRole({ live: true });
    expect(res.role).toBe('off');
    expect(res.roleSource).toBe('default-live');
    expect(res.reason).toBe(
      'untagged on the live server: add [HERMES-MANAGED] or [HERMES-TEST] to automate it',
    );
  });

  it('untagged on the test instance keeps the MANAGED default, unchanged', () => {
    const res = resolveRole({ live: false });
    expect(res).toMatchObject({ role: 'managed', roleSource: 'default' });
  });

  it('the default follows RTS_ENV=live when no explicit flag is passed', () => {
    const saved = process.env.RTS_ENV;
    try {
      process.env.RTS_ENV = 'live';
      expect(resolveRole({})).toMatchObject({ role: 'off', roleSource: 'default-live' });
      process.env.RTS_ENV = 'test';
      expect(resolveRole({})).toMatchObject({ role: 'managed', roleSource: 'default' });
    } finally {
      if (saved === undefined) delete process.env.RTS_ENV;
      else process.env.RTS_ENV = saved;
    }
  });

  it('an explicit managed tag still resolves MANAGED on the live instance (owner grid)', () => {
    const res = resolveRole({
      hints: [hint('managed', '[HERMES-MANAGED]')],
      live: true,
      owners: [OUR_IDENTITY],
      policy: livePolicy(),
    });
    expect(res).toMatchObject({ role: 'managed', roleSource: 'in-game-tag' });
  });
});

describe('T79 explicit managed tags', () => {
  it.each([
    ['[HERMES-MANAGED]', '[HERMES-MANAGED]'],
    ['[MANAGED]', '[MANAGED]'],
    ['[HERMES-TEST]', '[HERMES-TEST]'],
    ['HERMES_ROLE=managed', 'HERMES_ROLE=managed'],
  ])('%s is MANAGED', (text, token) => {
    const parsed = parseRoleText(text);
    expect(parsed.some((h) => h.role === 'managed')).toBe(true);
    const res = resolveRole({
      hints: parsed.map((p) => ({ ...p, source: 'custom-data' as const })),
      live: true,
      owners: [OUR_IDENTITY],
      policy: livePolicy(),
    });
    expect(res.role).toBe('managed');
    expect(res.hints.map((h) => h.token)).toContain(token);
  });

  it('does not let [MANAGED] hide inside [HERMES-MANAGED] as a second token', () => {
    const tokens = parseRoleText('[HERMES-MANAGED]').map((h) => h.token);
    expect(tokens).toEqual(['[HERMES-MANAGED]']);
    expect(mostRestrictive(parseRoleText('[HERMES-MANAGED] [OFF]'))).toBe('off');
  });

  it('automation can see an explicit managed tag where an untagged grid is OFF', () => {
    const taggedHints = parseRoleText('[MANAGED]').map((p) => ({ ...p, source: 'block-name' as const }));
    const tagged = resolveRole({ hints: taggedHints, live: true, owners: [OUR_IDENTITY], policy: livePolicy() });
    const untagged = resolveRole({ live: true, owners: [OUR_IDENTITY], policy: livePolicy() });
    expect(tagged.role).toBe('managed');
    expect(untagged.role).toBe('off');
  });
});

describe('T79 ownership on the live instance', () => {
  it('a foreign-owned grid with a MANAGED tag is OFF: not owned by you', () => {
    const res = resolveRole({
      hints: [hint('managed', '[HERMES-MANAGED]')],
      live: true,
      owners: [NPC_IDENTITY],
      policy: livePolicy(),
    });
    expect(res.role).toBe('off');
    expect(res.roleSource).toBe('ownership');
    expect(res.reason).toBe('not owned by you');
    expect(res.ownershipDetail).toContain('not you or your faction');
  });

  it('an owner grid with the tag is MANAGED', () => {
    const res = resolveRole({
      hints: [hint('managed', '[HERMES-MANAGED]')],
      live: true,
      owners: [OUR_IDENTITY],
      ownerFactions: [null],
      policy: livePolicy(),
    });
    expect(res.role).toBe('managed');
    expect(res.ownershipDetail).toContain('is you');
  });

  it('a faction-mate grid is MANAGED when the plugin reports the faction tag', () => {
    const res = resolveRole({
      hints: [hint('managed', '[HERMES-MANAGED]')],
      live: true,
      owners: [FRIEND_IDENTITY],
      ownerFactions: ['OURFAC'],
      policy: livePolicy({ factionTags: ['OURFAC'] }),
    });
    expect(res.role).toBe('managed');
    expect(res.ownershipDetail).toContain('your faction');
  });

  it('a PERSONAL tag on a foreign grid is also OFF (no non-OFF role survives)', () => {
    const res = resolveRole({ hints: [hint('personal')], live: true, owners: [NPC_IDENTITY], policy: livePolicy() });
    expect(res).toMatchObject({ role: 'off', roleSource: 'ownership' });
  });

  it('an explicit OFF tag stays OFF with its own reason, not the ownership one', () => {
    const res = resolveRole({ hints: [hint('off')], live: true, owners: [NPC_IDENTITY], policy: livePolicy() });
    expect(res).toMatchObject({ role: 'off', roleSource: 'in-game-tag' });
  });

  it('fails closed: no policy, no identity, or no owner all mean not ours', () => {
    expect(ownershipVerdict([OUR_IDENTITY], null, null, true).owned).toBe(false);
    expect(ownershipVerdict([OUR_IDENTITY], null, livePolicy({ identityIds: [] })).owned).toBe(false);
    expect(ownershipVerdict([], null, livePolicy()).owned).toBe(false);
    expect(ownershipVerdict([OUR_IDENTITY], null, livePolicy()).owned).toBe(true);
  });

  it('does not gate ownership on the test instance', () => {
    const res = resolveRole({ hints: [hint('managed')], live: false, owners: [NPC_IDENTITY], policy: null });
    expect(res.role).toBe('managed');
  });
});

describe('T79 owner Steam id list', () => {
  it('ships empty: no owner is assumed', () => {
    expect(parseOwnerSteamIds({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(parseOwnerSteamIds({ RTS_OWNER_STEAM_IDS: ' ' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('accepts a co-owner only when listed', () => {
    const ids = parseOwnerSteamIds({ RTS_OWNER_STEAM_IDS: `${OWNER_STEAM_ID}, ${FRIEND_STEAM_ID}` } as NodeJS.ProcessEnv);
    expect(ids).toEqual([OWNER_STEAM_ID, FRIEND_STEAM_ID]);
    expect(parseOwnerSteamIds({ RTS_OWNER_STEAM_IDS: OWNER_STEAM_ID } as NodeJS.ProcessEnv)).not.toContain(FRIEND_STEAM_ID);
  });

  it('resolves identities and factions from the existing reads', () => {
    const policy = buildOwnerPolicy(
      { RTS_ENV: 'live', RTS_OWNER_STEAM_IDS: OWNER_STEAM_ID } as NodeJS.ProcessEnv,
      {
        identityForSteam: (steam) => (steam === OWNER_STEAM_ID ? OUR_IDENTITY : null),
        factionTagForSteam: () => 'ourfac',
      },
    );
    expect(policy.live).toBe(true);
    expect(policy.identityIds.has(OUR_IDENTITY)).toBe(true);
    expect(policy.factionTags.has('OURFAC')).toBe(true);
  });
});

describe('T79 send boundary: a foreign grid receives no order', () => {
  beforeEach(() => {
    shipRoles.reset();
  });
  afterEach(() => {
    shipRoles.reset();
  });

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

  function run(gridId: string, hinted: RoleHint[] | null): Record<string, unknown>[] {
    const store = new Store(openDb(':memory:', { memory: true }));
    store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
    shipRoles.configureOwnerPolicy(livePolicy());
    shipRoles.noteInGame(
      store,
      [{ gridId, name: gridId, hints: hinted, owners: [NPC_IDENTITY] }],
      NOW,
    );
    const sent: Record<string, unknown>[] = [];
    const executor = new DemoExecutor({ store, hub: hub(sent), config: makeConfig(), clock: () => NOW, fixturePath: null });
    const created = createMission(store, gridMoveMission({ gridId, target: TARGET, gateNodeId: 'earthlike-hq' }), {
      now: NOW,
      actor: 'test',
      autoMissionTypes: [],
      maxQueuedBuilds: 8,
    });
    if (!created.ok) throw new Error(created.message);
    store.updateMission(created.mission.id, { status: 'approved' }, NOW);
    executor.sync(NOW);
    for (let i = 0; i < 4; i++) executor.tick();
    return sent.filter(
      (m) =>
        (m.entityId === gridId || (m.params as { entityId?: string } | undefined)?.entityId === gridId) &&
        (m.params as { action?: string } | undefined)?.action !== 'is_under_control',
    );
  }

  it('a tagged but foreign grid is refused at the send boundary', () => {
    const sent = run('grid:9001', [hint('managed', '[HERMES-MANAGED]')]);
    expect(sent).toHaveLength(0);
    expect(shipRoles.roleOf('grid:9001')).toBe('off');
  });

  it('the registry explains the refusal as ownership, not as an in-game OFF tag', () => {
    const store = new Store(openDb(':memory:', { memory: true }));
    shipRoles.configureOwnerPolicy(livePolicy());
    shipRoles.noteInGame(store, [{ gridId: 'grid:9002', hints: [hint('managed')], owners: [NPC_IDENTITY] }], NOW);
    const res = shipRoles.resolution('grid:9002');
    expect(res.roleSource).toBe('ownership');
    const decision = orderDecision(res, 'automatic', { action: 'move' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('role_off');
    expect(decision.reason).toContain('not owned by you');
  });
});

describe('T79 sim-speed source: plugin fallback when the Remote API is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-simspeed-'));
  const missingEnv = path.join(dir, 'no-remote.env');

  function monitor(extra: Partial<ConstructorParameters<typeof SimSpeedMonitor>[0]> = {}) {
    return new SimSpeedMonitor({
      envPath: extra.envPath ?? missingEnv,
      min: 0.95,
      sampleMs: 5_000,
      holdMs: 30_000,
      clock: () => NOW,
      ...extra,
    });
  }

  it('uses the plugin simulation ratio when there are no Remote API credentials', async () => {
    const m = monitor({ pluginSample: async () => 0.4 });
    await m.refresh();
    const status = m.status();
    expect(status.value).toBe(0.4);
    expect(status.source).toContain('plugin');
    expect(status.error).toBeNull();
    expect(status.threshold).toBe(0.95);
    expect(m.flightsAllowed()).toBe(false);
  });

  it('a low plugin reading blocks new flights at the unchanged 0.95 threshold', async () => {
    const m = monitor({ pluginSample: async () => 0.949 });
    await m.refresh();
    expect(m.flightsAllowed()).toBe(false);
    const fresh = monitor({ pluginSample: async () => 0.951 });
    await fresh.refresh();
    expect(fresh.flightsAllowed()).toBe(true);
  });

  it('keeps the Remote API first on the test server', async () => {
    const envPath = path.join(dir, 'remote.env');
    fs.writeFileSync(envPath, 'SE_TEST_REMOTE_KEY=AAAA\n');
    let pluginCalls = 0;
    const m = monitor({
      envPath,
      fetchImpl: (async () => new Response(JSON.stringify({ data: { SimSpeed: 0.99, SimulationCpuLoad: 0.1 } }), { status: 200 })) as unknown as typeof fetch,
      pluginSample: async () => {
        pluginCalls++;
        return 0.1;
      },
    });
    await m.refresh();
    expect(m.status().value).toBe(0.99);
    expect(m.status().source).toBe('remote-api');
    expect(pluginCalls).toBe(0);
  });

  it('falls back to the plugin when the Remote API answers without SimSpeed', async () => {
    const envPath = path.join(dir, 'remote2.env');
    fs.writeFileSync(envPath, 'SE_TEST_REMOTE_KEY=AAAA\n');
    const m = monitor({
      envPath,
      fetchImpl: (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch,
      pluginSample: async () => 0.7,
    });
    await m.refresh();
    expect(m.status().value).toBe(0.7);
    expect(m.status().source).toBe('plugin-action');
  });

  it('reports an unavailable source instead of inventing a value', async () => {
    const m = monitor({ pluginSample: async () => null });
    await m.refresh();
    expect(m.status().value).toBeNull();
    expect(m.status().error).toMatch(/no simulation ratio/);
    expect(m.flightsAllowed()).toBe(true); // unknown never blocks, as before
  });

  it('takes a pushed telemetry simRatio as it arrives, before any poll', () => {
    // Verify #4: the frame field was never ingested, so the live fallback could
    // not work even though the plugin sends it every tick.
    const m = monitor({ pluginSample: async () => 1.0 });
    expect(m.observeTelemetry(0.8, NOW)).toBe(true);
    const status = m.status();
    expect(status.value).toBe(0.8);
    expect(status.source).toBe('plugin-telemetry');
    expect(status.sourceDetail).toMatch(/telemetry simRatio/);
    expect(m.flightsAllowed()).toBe(false); // 0.95 gate, threshold unchanged
    m.observeTelemetry(1.0, NOW + 1_000);
    expect(m.flightsAllowed()).toBe(true);
  });

  it('a late frame never overwrites a newer sample', () => {
    const m = monitor({ pluginSample: async () => 1.0 });
    m.observeTelemetry(1.0, NOW);
    expect(m.observeTelemetry(0.8, NOW - 5_000)).toBe(false);
    expect(m.status().value).toBe(1.0);
  });

  it('refresh uses fresh telemetry instead of spending an action order', async () => {
    let pluginCalls = 0;
    const m = monitor({
      pluginSample: async () => {
        pluginCalls++;
        return 1.0;
      },
    });
    m.observeTelemetry(0.8, NOW);
    await m.refresh();
    expect(m.status().value).toBe(0.8);
    expect(m.status().source).toBe('plugin-telemetry');
    expect(pluginCalls).toBe(0);
  });

  it('refresh asks the action channel when the telemetry frame is stale', async () => {
    let pluginCalls = 0;
    const m = monitor({
      pluginSample: async () => {
        pluginCalls++;
        return 1.0;
      },
    });
    m.observeTelemetry(0.8, NOW - 60_000);
    await m.refresh();
    expect(pluginCalls).toBe(1);
    expect(m.status().value).toBe(1.0);
    expect(m.status().source).toBe('plugin-action');
  });

  it('the Remote API sample still wins when it is the freshest', async () => {
    const envPath = path.join(dir, 'remote3.env');
    fs.writeFileSync(envPath, 'SE_TEST_REMOTE_KEY=AAAA\n');
    const m = monitor({
      envPath,
      fetchImpl: (async () => new Response(JSON.stringify({ data: { SimSpeed: 0.99 } }), { status: 200 })) as unknown as typeof fetch,
      pluginSample: async () => 0.1,
    });
    m.observeTelemetry(0.5, NOW - 2_000);
    await m.refresh();
    expect(m.status().value).toBe(0.99);
    expect(m.status().source).toBe('remote-api');
  });
});
