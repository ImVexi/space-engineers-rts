/**
 * 2026-11-11 comms-gate flap (data/flight-proof-20261111.md, defect 1).
 *
 * Mid-run every move returned `403 comms_denied: "no provisioned base with a
 * broadcasting radio is registered"` although the same ship had been cleared a
 * few minutes earlier "reachable from BASE-01 over the provisioned 50 km radio".
 * Two things were true at once:
 *
 *   1. BASE-01 really has ZERO antenna blocks (`get_block_props` with a
 *      RadioAntenna|Beacon|LaserAntenna filter answers `count: 0`, and `inspect`
 *      lists 60 blocks with a `[HERMES-BASE]` Programmable Block and no antenna).
 *      That is a WORLD FACT: the base must have an antenna built on it, and the
 *      gate must say so by name instead of claiming a model problem.
 *   2. The authorisation that had allowed the earlier climb came from a CACHED
 *      provisioning record (`record.radio` from an older apply), republished on
 *      every 10 s poll as if it were fresh, and corrected to null when a
 *      signature change forced a re-apply. A record must never be able to say
 *      "50 km radio" for a grid whose last read saw no antenna.
 *
 * The defence for the OTHER failure mode is here too: an UNREAD antenna state
 * (the step threw, the plugin did not answer) is unknown, not absent, so it
 * keeps the last good reading for PROVISION_RADIO_GOOD_MS and is audited both
 * when it holds authority and when the grace runs out.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import {
  BASE_TAG,
  Provisioner,
  loadProfiles,
  resetProvisionerForTests,
} from '../src/demo/provision/index.js';
import { PROVISION_RADIO_GOOD_MS } from '../src/demo/provision/provisioner.js';
import { PROVISION_CAPABILITIES_KV, capabilitiesFromStore, networkSnapshot } from '../src/demo/network.js';
import { evaluateGate } from '../src/demo/gate.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;
const BASE = 'grid:76941937918779763';
const SAT = 'grid:87929829394037977';
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;

interface Call {
  action: string;
  params: Record<string, unknown>;
}

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

function taggedGrid(overrides: Record<string, unknown> = {}) {
  return {
    gridId: BASE,
    name: 'BASE-01',
    tags: [BASE_TAG],
    owner: OWNER,
    owners: [OWNER],
    pbName: 'PB [HERMES-BASE] BASE-01',
    position: { x: 10, y: 20, z: 30 },
    blocksTotal: 60,
    radioCount: 0,
    laserCount: 0,
    massKg: 12_000,
    isStatic: true,
    ...overrides,
  };
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

/** `set_block_props` answer with a real antenna block and its read-back props. */
function antennaAnswer(params: Record<string, unknown>) {
  const props = (params.props as Record<string, unknown>) ?? {};
  const blocks = [
    {
      entityId: '2001',
      name: 'Antenna',
      subtype: 'RadioAntenna',
      type: 'MyObjectBuilder_RadioAntenna',
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
  return { ok: true, result: { gridId: params.entityId, count: blocks.length, applied: 1, blocksWithErrors: 0, blocks } };
}

function pluginAnswering(grids: Record<string, unknown>[], radio: (params: Record<string, unknown>) => { ok: boolean; result?: Record<string, unknown>; error?: string }) {
  return (action: string, params: Record<string, unknown>) => {
    if (action === 'list_tagged') return { ok: true, result: { tag: BASE_TAG, count: grids.length, grids } };
    if (action === 'set_block_props') {
      const filter = (params.filter as { type?: string }) ?? {};
      if (filter.type === 'RadioAntenna') return radio(params);
      return { ok: true, result: { gridId: params.entityId, count: 1, applied: 1, blocksWithErrors: 0, blocks: [{ name: 'Block', props: [], errors: [] }] } };
    }
    if (action === 'laser_state') return { ok: true, result: { grids: [] } };
    return { ok: false, error: `unexpected action ${action}` };
  };
}

function capabilities(store: Store): Record<string, unknown>[] {
  const raw = JSON.parse(store.getKv(PROVISION_CAPABILITIES_KV) ?? '{}') as { grids?: Record<string, unknown>[] };
  return raw.grids ?? [];
}

function audits(store: Store, action: string) {
  return store.listAudit(500).filter((row) => row.action === action);
}

afterEach(() => resetProvisionerForTests());

describe('BASE-01 has no antenna: a world fact, named plainly', () => {
  it('publishes radioState absent, never a cached 50 km, and tells the owner to build one', async () => {
    const { store, config } = makeStore();
    // The scan says 0 antennas and the radio step answers with no blocks - the
    // measured BASE-01 case.
    const hub = fakeHub(
      store,
      pluginAnswering([taggedGrid()], () => ({
        ok: true,
        result: { gridId: BASE, count: 0, applied: 0, blocksWithErrors: 0, blocks: [] },
      })),
    );
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });
    await provisioner.runOnce();

    const row = capabilities(store)[0]!;
    expect(row.radioState).toBe('absent');
    expect(row.broadcasting).toBe(false);
    expect(row.radioRadiusM).toBeNull();
    const caps = capabilitiesFromStore(store);
    expect(caps.get(BASE)!.controlSource).toBe(false);
    expect(caps.get(BASE)!.radioState).toBe('absent');

    // The world fact is audited once, in plain language, and raised as an issue.
    const fact = audits(store, 'provision_base_no_antenna');
    expect(fact).toHaveLength(1);
    expect(String((fact[0]!.detail as { note?: string }).note)).toMatch(/not a control source/);
    expect(provisioner.state().issues.map((i) => i.reason).join(' ')).toMatch(/NO antenna block/);

    // And the gate names the base and says what to do, instead of blaming a model.
    const world = seedWorld(NOW);
    store.upsertUnit({
      id: SAT,
      name: 'SAT-R-0001',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: { x: 1_000, y: 500, z: EARTH.surfaceRadiusM + 2_000 },
      vel: null,
      meta: {},
    });
    store.setKv(
      PROVISION_CAPABILITIES_KV,
      JSON.stringify({
        at: NOW,
        grids: [
          ...capabilities(store),
          { gridId: SAT, name: 'SAT-R-0001', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, radioState: 'read', laserCount: 0, massKg: 37_609, isStatic: false, updatedAt: NOW },
        ],
      }),
    );
    const gate = evaluateGate({ store, world, now: NOW, nodeId: SAT });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/BASE-01/);
    expect(gate.reason).toMatch(/NO antenna block/);
    expect(gate.reason).toMatch(/build an antenna/);
    expect(gate.source).toBe('GAME');
    const snap = networkSnapshot({ store, world, now: NOW, freshMs: 30_000 });
    expect(snap.noAntennaBases.map((b) => b.name)).toEqual(['BASE-01']);
  });

  it('never republishes a cached radio radius for a grid whose read now sees no antenna', async () => {
    // Poll 1: a real antenna, read back at 50 km. Poll 2: the antenna is GONE
    // and a signature change forces a re-apply. The old code kept publishing
    // poll 1's radius from the record and then dropped it, mid-mission.
    const { store, config } = makeStore();
    let hasAntenna = true;
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') {
          return {
            ok: true,
            result: { count: 1, grids: [taggedGrid({ radioCount: hasAntenna ? 1 : 0 })] },
          };
        }
        if (action !== 'set_block_props') return { ok: action === 'laser_state', result: { grids: [] } };
        const filter = (params.filter as { type?: string }) ?? {};
        if (filter.type === 'RadioAntenna') {
          return hasAntenna
            ? antennaAnswer(params)
            : { ok: true, result: { gridId: BASE, count: 0, applied: 0, blocks: [], blocksWithErrors: 0 } };
        }
        return { ok: true, result: { gridId: BASE, count: 1, applied: 1, blocksWithErrors: 0, blocks: [{ name: 'Block', props: [], errors: [] }] } };
      },
    );
    const clock = { now: NOW };
    const provisioner = new Provisioner({ config, store, hub, clock: () => clock.now });
    await provisioner.runOnce();
    expect(capabilities(store)[0]).toMatchObject({ radioState: 'read', radioRadiusM: 50_000 });

    hasAntenna = false;
    clock.now += 10_000;
    await provisioner.runOnce();
    // The scan now reports radioCount 0 and the step answers nothing: absent.
    expect(capabilities(store)[0]).toMatchObject({ radioState: 'absent', radioRadiusM: null });
    expect(audits(store, 'provision_base_no_antenna')).toHaveLength(1);
  });
});

describe('an unread antenna state is unknown, not absent', () => {
  it('holds the last good reading for the grace, then revokes it with an audit', async () => {
    const { store, config } = makeStore();
    let radioOk = true;
    // A SIGNATURE change on every poll would re-apply; instead grow the grid's
    // mass so the second poll re-runs the profile.
    let massKg = 12_000;
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') {
          return { ok: true, result: { count: 1, grids: [taggedGrid({ radioCount: 1, massKg })] } };
        }
        if (action === 'set_block_props') {
          const filter = (params.filter as { type?: string }) ?? {};
          if (filter.type === 'RadioAntenna') {
            return radioOk
              ? antennaAnswer(params)
              : { ok: false as const, error: 'plugin did not answer the radio step' };
          }
          return { ok: true, result: { gridId: BASE, count: 1, applied: 1, blocksWithErrors: 0, blocks: [{ name: 'Block', props: [], errors: [] }] } };
        }
        if (action === 'laser_state') return { ok: true, result: { grids: [] } };
        return { ok: false, error: `unexpected ${action}` };
      },
    );
    const clock = { now: NOW };
    const provisioner = new Provisioner({ config, store, hub, clock: () => clock.now });
    await provisioner.runOnce();
    expect(capabilities(store)[0]).toMatchObject({ radioState: 'read', radioRadiusM: 50_000 });
    const goodAt = clock.now;

    // The read fails on a re-apply 20 s later: the gate must still see the base.
    radioOk = false;
    massKg = 12_500;
    clock.now = goodAt + 20_000;
    await provisioner.runOnce();
    expect(capabilities(store)[0]).toMatchObject({
      radioState: 'last-known-good',
      broadcasting: true,
      radioRadiusM: 50_000,
    });
    expect(audits(store, 'provision_radio_unread')).toHaveLength(1);
    expect(capabilitiesFromStore(store).get(BASE)!.controlSource).toBe(true);

    // The read keeps failing past the grace: authority is revoked, with a row.
    clock.now = goodAt + PROVISION_RADIO_GOOD_MS + 5_000;
    await provisioner.runOnce();
    const row = capabilities(store)[0]!;
    expect(row.radioState).toBe('unread');
    expect(row.broadcasting).toBeNull();
    expect(row.radioRadiusM).toBeNull();
    expect(capabilitiesFromStore(store).get(BASE)!.controlSource).toBe(false);
    const revoked = audits(store, 'provision_capability_revoked');
    expect(revoked).toHaveLength(1);
    expect(String((revoked[0]!.detail as { reason?: string }).reason)).toMatch(/unreadable for longer than the last-known-good grace/);

    // A base that is merely unread must NOT be reported as having no antenna:
    // presence/absence is a different fact.
    expect(audits(store, 'provision_base_no_antenna')).toHaveLength(0);
  });
});
