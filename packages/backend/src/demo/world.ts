import fs from 'node:fs';
import {
  LinkModelConfigSchema,
  type LinkGraph,
  type NetworkNode,
  type Planet,
} from '@se-rts/schemas';
import { PLANET_CATALOG, buildGraph, loadPlanetCatalog, linkGraph } from '../planner/index.js';
import type { StandIn } from './standins.js';
import { getStandIn } from './standins.js';

/**
 * Stand-in world for the demo. Positions are planner output (SIMULATED);
 * nothing here is read from the game. The test server's plugin may later
 * overwrite a node's position by id (source becomes GAME).
 */
export interface DemoNode {
  id: string;
  name: string;
  prefab: string;
  /** Planet the grid is anchored to, or null in deep space. */
  planet: string | null;
  position: { x: number; y: number; z: number };
  controlSource: boolean;
  origin: 'fixture' | 'spawn';
  status: 'alive' | 'planned';
  /** Free-text provenance, shown in the UI. */
  note: string;
}

export interface DemoWorld {
  schemaVersion: 1;
  snapshot: string;
  nodes: DemoNode[];
  planned: DemoNode[];
  updatedAt: number;
}

const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const ALIEN = PLANET_CATALOG.find((p) => p.name === 'Alien')!;

/** Radio-chain anchor positions, taken from the deterministic planner. */
function seedNodes(): DemoNode[] {
  const p0 = { x: 1581.8056214219257, y: 1581.8056214219257, z: 69163.83290385283 };
  const p1 = { x: 2605.0727314791748, y: 2605.0727314791748, z: 113905.7875773912 };
  const p2 = { x: 3628.339841536424, y: 3628.339841536424, z: 158647.74225092953 };
  // 60 km from the EarthLike anchor, off the relay line so it shares no radio
  // edge with relay-1 (the fixture's intended single point of failure).
  const bridge = { x: p0.x + 60_000, y: p0.y, z: p0.z };
  return [
    {
      id: 'earthlike-hq',
      name: 'EarthLike HQ',
      prefab: 'EarthEasyStation',
      planet: EARTH.name,
      position: p0,
      controlSource: true,
      origin: 'fixture',
      status: 'alive',
      note: 'control source; radio 50 km, 1 laser port (SIMULATED fixture)',
    },
    {
      id: 'relay-1',
      name: 'Eradicator 1',
      prefab: 'Eradicator_mk.1',
      planet: null,
      position: p1,
      controlSource: false,
      origin: 'fixture',
      status: 'alive',
      note: 'single point of failure for relay-2 in the fixture (SIMULATED)',
    },
    {
      id: 'relay-2',
      name: 'Eradicator 2',
      prefab: 'Eradicator_mk.1',
      planet: null,
      position: p2,
      controlSource: false,
      origin: 'fixture',
      status: 'alive',
      note: '90 km from HQ: only reachable via relay-1 (SIMULATED)',
    },
    {
      id: 'laser-bridge-1',
      name: 'Citadel laser bridge',
      prefab: 'EncounterCitadelStation',
      planet: null,
      position: bridge,
      controlSource: false,
      origin: 'fixture',
      status: 'alive',
      note: '2 laser ports, 60 km from HQ (SIMULATED)',
    },
    {
      id: 'alien-outpost',
      name: 'Alien outpost',
      prefab: 'AlienEasyStation',
      planet: ALIEN.name,
      position: { x: 129490.19437857807, y: 129490.19437857807, z: 5661908.167096147 },
      controlSource: false,
      origin: 'fixture',
      status: 'alive',
      note: 'isolated: 5.66 Mm from HQ, no relay chain (SIMULATED)',
    },
  ];
}

export function seedWorld(now = Date.now()): DemoWorld {
  return {
    schemaVersion: 1,
    snapshot: 'builtin-standin-world',
    nodes: seedNodes(),
    planned: [],
    updatedAt: now,
  };
}

const WORLD_KEY = 'demo:world';

export function worldFromFixture(file: string, now = Date.now()): DemoWorld {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DemoWorld> & { nodes?: unknown };
  if (!raw || !Array.isArray(raw.nodes)) throw new Error(`demo fixture ${file} must contain a nodes array`);
  const nodes = raw.nodes.map((n) => validateNode(n as DemoNode));
  return {
    schemaVersion: 1,
    snapshot: typeof raw.snapshot === 'string' ? raw.snapshot : file,
    nodes,
    planned: [],
    updatedAt: now,
  };
}

function validateNode(n: DemoNode): DemoNode {
  if (!n || typeof n.id !== 'string' || !n.id.trim()) throw new Error('demo fixture node needs an id');
  if (!n.prefab || !getStandIn(n.prefab)) throw new Error(`demo fixture node ${n.id}: unknown stand-in prefab ${n.prefab}`);
  if (!n.position || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y) || !Number.isFinite(n.position.z)) {
    throw new Error(`demo fixture node ${n.id}: position must be finite`);
  }
  return {
    ...n,
    name: n.name || n.id,
    planet: n.planet ?? null,
    controlSource: Boolean(n.controlSource),
    origin: 'fixture',
    status: 'alive',
    note: n.note ?? 'fixture (SIMULATED)',
  };
}

export interface WorldStoreLike {
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
}

export function loadWorld(store: WorldStoreLike, fixturePath: string | null, now = Date.now()): DemoWorld {
  const saved = store.getKv(WORLD_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as DemoWorld;
      if (Array.isArray(parsed.nodes)) return parsed;
    } catch {
      /* fall through to reseed */
    }
  }
  const world = fixturePath ? worldFromFixture(fixturePath, now) : seedWorld(now);
  store.setKv(WORLD_KEY, JSON.stringify(world));
  return world;
}

export function saveWorld(store: WorldStoreLike, world: DemoWorld): void {
  store.setKv(WORLD_KEY, JSON.stringify({ ...world, updatedAt: Date.now() }));
}

export function planetByName(name: string): Planet | undefined {
  return loadPlanetCatalog().find((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name);
}

export function nodeStandIn(node: DemoNode): StandIn | null {
  return getStandIn(node.prefab);
}

export function toNetworkNode(node: DemoNode): NetworkNode {
  const cap = nodeStandIn(node);
  return {
    id: node.id,
    position: node.position,
    radioRadiusM: cap?.radioRadiusM ?? null,
    laserRangeM: cap?.laserRangeM ?? null,
    laserUnlimited: false,
    controlSource: node.controlSource,
  };
}

export function aliveNodes(world: DemoWorld): DemoNode[] {
  return world.nodes.filter((n) => n.status === 'alive');
}

export function demoGraph(world: DemoWorld): LinkGraph {
  return linkGraph(aliveNodes(world).map(toNetworkNode), loadPlanetCatalog());
}

/** Unique undirected laser pairs per node; used for laser-port accounting. */
export function laserPortUsage(world: DemoWorld): Record<string, { used: number; capacity: number }> {
  const graph = demoGraph(world);
  const pairs = new Set<string>();
  const used: Record<string, number> = {};
  for (const edge of graph.edges) {
    if (edge.kind !== 'laser') continue;
    const key = [edge.from, edge.to].sort().join('|');
    if (pairs.has(key)) continue;
    pairs.add(key);
    used[edge.from] = (used[edge.from] ?? 0) + 1;
    used[edge.to] = (used[edge.to] ?? 0) + 1;
  }
  const out: Record<string, { used: number; capacity: number }> = {};
  for (const node of aliveNodes(world)) {
    out[node.id] = { used: used[node.id] ?? 0, capacity: nodeStandIn(node)?.laserPorts ?? 0 };
  }
  return out;
}

export const DEMO_LINK_CONFIG = LinkModelConfigSchema.parse({
  radioDirectional: true,
  laserBlockedByPlanets: true,
});

export function graphWith(world: DemoWorld, extra: DemoNode[]): LinkGraph {
  return linkGraph([...aliveNodes(world).map(toNetworkNode), ...extra.map(toNetworkNode)], loadPlanetCatalog());
}
