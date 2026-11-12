import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeConfig } from './helpers.js';
import { evaluateGate } from '../src/demo/gate.js';
import { seedWorld } from '../src/demo/world.js';
import {
  PROVISION_CAPABILITIES_KV,
  PROVISION_LASERS_KV,
  capabilitiesFromStore,
  liveGraph,
  liveLaserPairs,
  networkSnapshot,
} from '../src/demo/network.js';
import { reachAtPoint, resolveMoveTarget, preflightMove, type ShipState } from '../src/demo/moveTo.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

const NOW = 1_800_000_000_000;
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const BASE = 'grid:76941937918779763';
const SAT1 = 'grid:107519913664561774';
const SAT2 = 'grid:115081011520040319';

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

function ground(offsetX: number, offsetY = 0) {
  return { x: offsetX, y: offsetY, z: EARTH.surfaceRadiusM + 300 };
}

function seedNetwork(store: Store) {
  store.setKv(
    PROVISION_CAPABILITIES_KV,
    JSON.stringify({
      at: NOW,
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
          updatedAt: NOW,
        },
        {
          gridId: SAT1,
          name: 'SAT-L-0001',
          profile: 'DRONE',
          broadcasting: true,
          radioRadiusM: 50_000,
          laserCount: 2,
          massKg: 19_003.6,
          isStatic: false,
          updatedAt: NOW,
        },
        {
          gridId: SAT2,
          name: 'SAT-L-0004',
          profile: 'DRONE',
          broadcasting: true,
          radioRadiusM: 50_000,
          laserCount: 2,
          massKg: 19_003.6,
          isStatic: false,
          updatedAt: NOW,
        },
      ],
    }),
  );
  for (const [id, name, position] of [
    [BASE, 'BASE-01', ground(0)],
    [SAT1, 'SAT-L-0001', ground(1_000, 500)],
    [SAT2, 'SAT-L-0004', ground(120_000)],
  ] as const) {
    store.upsertUnit({
      id,
      name,
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: position,
      vel: null,
      meta: {},
    });
  }
}

function snapshot(store: Store) {
  return networkSnapshot({ store, world: seedWorld(NOW), now: NOW, freshMs: 30_000 });
}

describe('live network model', () => {
  it('uses the provisioned base as the control source, not earthlike-hq', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const snap = snapshot(store);
    expect(snap.provisioned).toBe(true);
    expect(snap.nodes.map((n) => n.id)).toContain(BASE);
    expect(snap.nodes.map((n) => n.id)).not.toContain('earthlike-hq');
    expect(snap.excludedFixtures).toContain('earthlike-hq');
    const caps = capabilitiesFromStore(store);
    expect(caps.get(BASE)).toMatchObject({ controlSource: true, radioRadiusM: 50_000 });
  });

  it('allows a tagged satellite with a fresh up-link and a provisioned profile', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const world = seedWorld(NOW);
    const gate = evaluateGate({ store, world, now: NOW, nodeId: SAT1 });
    expect(gate.allowed).toBe(true);
    expect(gate.labels).toContain('GAME');
    expect(gate.antennaSource).toBe('GAME');
    expect(gate.capability).toMatchObject({ radioRadiusM: 50_000, laserCount: 2, profile: 'DRONE' });
    expect(gate.reason).toContain('BASE-01');
    expect(gate.reason).toContain('SIMULATED');
  });

  it('refuses an untagged grid instead of assuming it is reachable', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const world = seedWorld(NOW);
    store.upsertUnit({
      id: 'grid:untagged',
      name: 'Small Grid 1234',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: NOW,
      pos: ground(500),
      vel: null,
      meta: {},
    });
    const gate = evaluateGate({ store, world, now: NOW, nodeId: 'grid:untagged' });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('no capability profile');
  });

  it('reports an old fixture node as unknown once the live network exists', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const gate = evaluateGate({ store, world: seedWorld(NOW), now: NOW, nodeId: 'earthlike-hq' });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('not in the provisioned network');
  });

  it('move-to reach names BASE-01 and reaches ground, misses a 60 km orbit', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const snap = snapshot(store);
    const nodes = snap.nodes.map((n) => ({
      id: n.id,
      name: snap.capability.get(n.id)?.name ?? n.id,
      position: n.position,
      radioRangeM: n.radioRadiusM,
      controlSource: n.controlSource,
    }));
    const groundPoint = { x: 5_000, y: 1_000, z: EARTH.surfaceRadiusM + 200 };
    const near = reachAtPoint(groundPoint, nodes);
    expect(near.reachable).toBe(true);
    expect(near.via).toBe(BASE);

    const target = resolveMoveTarget({
      target: 'orbit-zero-g',
      ship: ground(0),
      planets: PLANET_CATALOG,
    });
    if ('error' in target) throw new Error(target.error.message);
    expect(target.target.altitudeM).toBeGreaterThanOrEqual(60_000);
    const far = reachAtPoint(target.target.position, nodes);
    expect(far.reachable).toBe(false);
    expect(far.via).toBe(BASE);
    expect(far.reason).toContain('radio reaches 50 km');

    const ship: ShipState = {
      gridId: SAT1,
      name: 'SAT-L-0001',
      position: ground(0),
      altitudeM: 300,
      massKg: 19_003.6,
      fuelPct: 50,
      batteryPct: 100,
      thrust: { atmo: 1, ion: 0, h2: 1 },
    };
    const preflight = preflightMove({ ship, target: target.target, reach: far, speedMps: 100, ignoreReach: false });
    expect(preflight.ok).toBe(false);
    expect(preflight.block?.code).toBe('not_reachable');
    expect(preflight.block?.hint).toContain('BASE-01');
    expect(preflight.block?.hint).toContain('relay');
    expect(preflight.block?.hint).toContain('Admin override');
  });

  it('counts a Connected laser pair as a GAME edge and a reachable link', () => {
    const { store } = makeStore();
    seedNetwork(store);
    store.setKv(
      PROVISION_LASERS_KV,
      JSON.stringify({
        at: NOW,
        grids: [
          {
            gridId: SAT1,
            name: 'SAT-L-0001',
            lasers: [
              {
                entityId: '5001',
                name: 'SAT-L-0001 L1',
                status: 'Connected',
                position: ground(1_000, 500),
                otherGridId: SAT2,
                otherAntennaId: '6001',
              },
            ],
          },
          {
            gridId: SAT2,
            name: 'SAT-L-0004',
            lasers: [
              {
                entityId: '6001',
                name: 'SAT-L-0004 L1',
                status: 'Connected',
                position: ground(120_000),
                otherGridId: SAT1,
                otherAntennaId: '5001',
              },
            ],
          },
        ],
      }),
    );

    const pairs = liveLaserPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: SAT1, b: SAT2, mutual: true });

    const graph = liveGraph(snapshot(store));
    const edge = graph.edges.find((e) => e.kind === 'laser' && e.from === SAT1 && e.to === SAT2);
    expect(edge).toBeTruthy();
    expect(edge?.source).toBe('GAME');
    expect(graph.nodes.find((n) => n.id === SAT2)?.reachable).toBe(true);
    expect(graph.nodes.find((n) => n.id === BASE)?.controlSource).toBe(true);
  });

  it('does not invent a laser edge from range alone', () => {
    const { store } = makeStore();
    seedNetwork(store);
    const image = liveGraph(snapshot(store));
    expect(image.edges.some((e) => e.kind === 'laser')).toBe(false);
    // SAT2 is 120 km from the base: radio cannot reach it without the beam.
    expect(image.nodes.find((n) => n.id === SAT2)?.reachable).toBe(false);
  });
});
