/**
 * Live network model for the demo.
 *
 * The gate, move-to preflight and the overlay graph used to read the built-in
 * fixture world (`earthlike-hq`, `relay-1`, ...). Those nodes have no grid in
 * the game, so the answers were about a stand-in planet, not the owner's
 * network. This module builds the network from what the plugin actually
 * reports:
 *
 *   - `provision:capabilities`: a snapshot written by the 10 s provisioning
 *     poll for every owner-tagged grid (radio radius read back from the block,
 *     laser count, mass, static flag).
 *   - plugin telemetry in the unit table: live position and link state.
 *   - `provision:lasers`: the same poll's `laser_state` sample. A pair whose
 *     antennas both report `Connected` is a real (GAME) laser edge.
 *
 * Positions/link state are GAME. Range maths (does this radio reach that
 * point, can a laser span that distance) stays SIMULATED, exactly like the
 * rest of the planner. Unknown hardware still gets no profile: the gate never
 * assumes an unknown grid is reachable.
 */
import type { LinkEdge, LinkGraph, NetworkNode, Planet } from '@se-rts/schemas';
import {
  buildGraph,
  connectedComponents,
  findArticulationPoints,
  findBridges,
  loadPlanetCatalog,
  reachableFrom,
} from '../planner/index.js';
import type { Store } from '../store.js';
import { getStandIn, getStandInByName, type StandIn } from './standins.js';
import { aliveNodes, type DemoWorld } from './world.js';

export const PROVISION_CAPABILITIES_KV = 'provision:capabilities';
export const PROVISION_LASERS_KV = 'provision:lasers';
/** Demo laser model cap (definition says MaxRange -1); in-game range unmeasured. */
export const LASER_MODEL_CAP_M = 100_000;

export type RadioState = 'read' | 'absent' | 'unread' | 'last-known-good';

export interface GridCapability {
  gridId: string;
  name: string;
  /** BASE grids are control sources; DRONE grids are relays/leaves. */
  profile: 'BASE' | 'DRONE' | null;
  /** Broadcasting radio radius read back from the block, or null. */
  radioRadiusM: number | null;
  broadcasting: boolean | null;
  /**
   * WHICH fact the antenna state is (2026-11-11): `absent` = the grid really has
   * no antenna, `unread` = the read failed (unknown, never treated as absent),
   * `last-known-good` = an unread poll inside the grace window, so the previous
   * reading still authorises.
   */
  radioState: RadioState | null;
  /** Age of a `last-known-good` reading, ms. */
  radioAgeMs: number | null;
  laserCount: number;
  /** Demo model cap when the grid carries at least one laser antenna. */
  laserRangeM: number | null;
  massKg: number | null;
  isStatic: boolean | null;
  controlSource: boolean;
  updatedAt: number | null;
  source: 'provisioned-base' | 'provisioned-grid' | 'telemetry-standin' | 'fixture';
}

export interface LiveLaserPair {
  a: string;
  b: string;
  distanceM: number;
  /** True when both ends read back `Connected` to each other. */
  mutual: boolean;
  at: number;
  lasers: { a: string | null; b: string | null };
}

export interface NetworkSnapshot {
  nodes: NetworkNode[];
  capability: Map<string, GridCapability>;
  livePairs: LiveLaserPair[];
  /**
   * Provisioned `[HERMES-BASE]` grids that have NO antenna block. They are a
   * world fact, not a model error: no order can be routed through them until
   * the owner builds an antenna, and the gate says so by name.
   */
  noAntennaBases: { id: string; name: string }[];
  /** True when a provisioning snapshot exists and drives the model. */
  provisioned: boolean;
  /** Fixture nodes that were left out because no grid stands behind them. */
  excludedFixtures: string[];
  /** GAME: antenna state read back; SIMULATED: range maths on top. */
  labels: string[];
}

interface CapabilityRow {
  gridId?: unknown;
  name?: unknown;
  profile?: unknown;
  radioRadiusM?: unknown;
  broadcasting?: unknown;
  radioState?: unknown;
  radioAgeMs?: unknown;
  laserCount?: unknown;
  massKg?: unknown;
  isStatic?: unknown;
  updatedAt?: unknown;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeRow(row: CapabilityRow): GridCapability | null {
  if (typeof row.gridId !== 'string' || !row.gridId) return null;
  const profile = row.profile === 'BASE' || row.profile === 'DRONE' ? row.profile : null;
  const broadcasting = typeof row.broadcasting === 'boolean' ? row.broadcasting : null;
  const radio = asNumber(row.radioRadiusM);
  const radioState: RadioState | null =
    row.radioState === 'read' || row.radioState === 'absent' || row.radioState === 'unread' || row.radioState === 'last-known-good'
      ? row.radioState
      : null;
  const laserCount = Math.max(0, Math.round(asNumber(row.laserCount) ?? 0));
  return {
    gridId: row.gridId,
    name: typeof row.name === 'string' && row.name ? row.name : row.gridId,
    profile,
    radioRadiusM: broadcasting === true && radio !== null && radio > 0 ? radio : null,
    broadcasting,
    radioState,
    radioAgeMs: asNumber(row.radioAgeMs),
    laserCount,
    laserRangeM: laserCount > 0 ? LASER_MODEL_CAP_M : null,
    massKg: asNumber(row.massKg),
    isStatic: typeof row.isStatic === 'boolean' ? row.isStatic : null,
    controlSource: profile === 'BASE' && broadcasting === true && radio !== null && radio > 0,
    updatedAt: asNumber(row.updatedAt),
    source: profile === 'BASE' ? 'provisioned-base' : 'provisioned-grid',
  };
}

/**
 * Capability profiles written by the provisioning poll. Falls back to the raw
 * `provision:grids` records so a backend that starts before the first poll
 * still knows the owner's bases instead of dropping to the old fixture.
 */
export function capabilitiesFromStore(store: Store): Map<string, GridCapability> {
  const out = new Map<string, GridCapability>();
  const raw = store.getKv(PROVISION_CAPABILITIES_KV);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { grids?: CapabilityRow[] } | CapabilityRow[];
      const rows = Array.isArray(parsed) ? parsed : parsed.grids ?? [];
      for (const row of rows) {
        const cap = normalizeRow(row);
        if (cap) out.set(cap.gridId, cap);
      }
      if (out.size) return out;
    } catch {
      /* fall through to the provisioning records */
    }
  }
  const legacy = store.getKv('provision:grids');
  if (!legacy) return out;
  try {
    const records = JSON.parse(legacy) as {
      gridId?: string;
      name?: string;
      profile?: string;
      radio?: { broadcasting?: boolean | null; radiusM?: number | null };
      hardware?: { laserCount?: number; massKg?: number; isStatic?: boolean };
      appliedAt?: number;
    }[];
    for (const rec of records) {
      if (typeof rec.gridId !== 'string' || !rec.gridId) continue;
      const cap = normalizeRow({
        gridId: rec.gridId,
        name: rec.name,
        profile: rec.profile,
        broadcasting: rec.radio?.broadcasting ?? null,
        radioRadiusM: rec.radio?.radiusM ?? null,
        laserCount: rec.hardware?.laserCount ?? 0,
        massKg: rec.hardware?.massKg ?? null,
        isStatic: rec.hardware?.isStatic ?? null,
        updatedAt: rec.appliedAt,
      });
      if (cap) out.set(cap.gridId, cap);
    }
  } catch {
    /* corrupt cache: no profiles, the gate stays conservative */
  }
  return out;
}

interface LaserReadout {
  entityId?: unknown;
  name?: unknown;
  status?: unknown;
  position?: { x?: unknown; y?: unknown; z?: unknown };
  otherGridId?: unknown;
  otherAntennaId?: unknown;
}

interface LaserGridRow {
  gridId?: unknown;
  name?: unknown;
  position?: { x?: unknown; y?: unknown; z?: unknown };
  lasers?: LaserReadout[];
}

function vec(v: { x?: unknown; y?: unknown; z?: unknown } | undefined): { x: number; y: number; z: number } | null {
  if (!v) return null;
  const { x, y, z } = v;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  return { x, y, z };
}

/** Connected laser pairs from the provisioning poll's `laser_state` sample. */
export function liveLaserPairs(store: Store): LiveLaserPair[] {
  const raw = store.getKv(PROVISION_LASERS_KV);
  if (!raw) return [];
  let parsed: { at?: number; grids?: LaserGridRow[] };
  try {
    parsed = JSON.parse(raw) as { at?: number; grids?: LaserGridRow[] };
  } catch {
    return [];
  }
  const at = typeof parsed.at === 'number' ? parsed.at : 0;
  const grids = Array.isArray(parsed.grids) ? parsed.grids : [];
  const byId = new Map<string, LaserGridRow>();
  for (const g of grids) if (typeof g.gridId === 'string') byId.set(g.gridId, g);

  const pairs = new Map<string, LiveLaserPair & { ends: Set<string> }>();
  for (const g of grids) {
    if (typeof g.gridId !== 'string') continue;
    for (const laser of g.lasers ?? []) {
      if (laser.status !== 'Connected') continue;
      // A powered-off block can still report a stale `Connected` status from a
      // previous session; it is not a live beam.
      if ((laser as { enabled?: unknown }).enabled === false) continue;
      const other = typeof laser.otherGridId === 'string' ? laser.otherGridId : null;
      if (!other || other === g.gridId) continue;
      const mate = byId.get(other);
      const mateLaser = (mate?.lasers ?? []).find(
        (l) =>
          l.status === 'Connected' &&
          (l as { enabled?: unknown }).enabled !== false &&
          l.otherGridId === g.gridId,
      );
      const pa = vec(laser.position);
      const pb = vec(mateLaser?.position);
      if (!pa || !pb) continue;
      const key: string = [g.gridId, other].sort().join('|');
      const pair: LiveLaserPair & { ends: Set<string> } = pairs.get(key) ?? {
        a: g.gridId < other ? g.gridId : other,
        b: g.gridId < other ? other : g.gridId,
        distanceM: Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z),
        mutual: false,
        at,
        lasers: { a: null, b: null },
        ends: new Set<string>(),
      };
      pair.ends.add(g.gridId);
      pair.mutual = pair.ends.size >= 2;
      if (g.gridId === pair.a) {
        pair.lasers.a = typeof laser.entityId === 'string' ? laser.entityId : null;
      } else {
        pair.lasers.b = typeof laser.entityId === 'string' ? laser.entityId : null;
      }
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()]
    .filter((p) => p.distanceM >= 0)
    .map(({ ends: _ends, ...p }) => ({ ...p, distanceM: Math.round(p.distanceM * 10) / 10 }));
}

function standinCapability(gridId: string, name: string, standin: StandIn): GridCapability {
  return {
    gridId,
    name,
    profile: null,
    radioRadiusM: standin.radioRadiusM,
    broadcasting: standin.radioRadiusM === null ? null : true,
    radioState: standin.radioRadiusM === null ? 'unread' : 'read',
    radioAgeMs: null,
    laserCount: standin.laserPorts,
    laserRangeM: standin.laserPorts > 0 ? LASER_MODEL_CAP_M : null,
    massKg: null,
    isStatic: standin.isStatic,
    controlSource: false,
    updatedAt: null,
    source: 'telemetry-standin',
  };
}

export interface NetworkInput {
  store: Store;
  world: DemoWorld;
  now: number;
  freshMs: number;
  /** Executor-known prefab for grids it spawned. */
  prefabFor?: (id: string) => string | null;
}

/**
 * Build the current network: provisioned/tagged grids with live telemetry plus
 * fixture nodes that actually have a grid behind them. With no provisioning
 * snapshot at all (offline fixture mode, unit tests) the old fixture world is
 * kept so the planner-only demo still works.
 */
export function networkSnapshot(input: NetworkInput): NetworkSnapshot {
  const { store, world, now, freshMs } = input;
  const capability = capabilitiesFromStore(store);
  const provisioned = capability.size > 0;
  const nodes: NetworkNode[] = [];
  const seen = new Set<string>();

  const pushNode = (cap: GridCapability, position: { x: number; y: number; z: number }): void => {
    if (seen.has(cap.gridId)) return;
    seen.add(cap.gridId);
    nodes.push({
      id: cap.gridId,
      position,
      radioRadiusM: cap.radioRadiusM,
      // In fixture-only mode the planner stand-ins keep their demo laser cap.
      // In the live model lasers never create assumed links: only a Connected
      // pair (GAME) is an edge, added by liveGraph().
      laserRangeM: provisioned ? null : cap.laserRangeM,
      laserUnlimited: false,
      controlSource: cap.controlSource,
    });
  };

  for (const unit of store.listUnits()) {
    if (!unit.pos) continue;
    if (now - unit.lastSeen > freshMs) continue;
    const known = capability.get(unit.id);
    let cap = known ?? null;
    if (!cap) {
      const explicit = input.prefabFor?.(unit.id) ?? (typeof unit.meta?.prefab === 'string' ? unit.meta.prefab : null);
      const standin = (explicit ? getStandIn(explicit) : null) ?? getStandInByName(unit.name);
      if (standin) cap = standinCapability(unit.id, unit.name, standin);
    }
    if (!cap) continue; // unknown hardware: never assumed reachable
    pushNode(cap, unit.pos);
  }

  const excludedFixtures: string[] = [];
  for (const node of aliveNodes(world)) {
    if (seen.has(node.id)) continue;
    if (provisioned) {
      // A fixture node with no live grid is a planner stand-in, not the
      // owner's network. Keep it out so the gate cannot answer about it.
      excludedFixtures.push(node.id);
      continue;
    }
    const standin = getStandIn(node.prefab);
    if (!standin) continue;
    const cap: GridCapability = {
      gridId: node.id,
      name: node.name,
      profile: null,
      radioRadiusM: standin.radioRadiusM,
      broadcasting: standin.radioRadiusM === null ? null : true,
      radioState: standin.radioRadiusM === null ? 'unread' : 'read',
      radioAgeMs: null,
      laserCount: standin.laserPorts,
      laserRangeM: standin.laserPorts > 0 ? LASER_MODEL_CAP_M : null,
      massKg: null,
      isStatic: standin.isStatic,
      controlSource: node.controlSource,
      updatedAt: null,
      source: 'fixture',
    };
    capability.set(node.id, cap);
    pushNode(cap, node.position);
  }

  const noAntennaBases = [...capability.values()]
    .filter((cap) => cap.profile === 'BASE' && cap.radioState === 'absent')
    .map((cap) => ({ id: cap.gridId, name: cap.name }));

  return {
    nodes,
    capability,
    livePairs: liveLaserPairs(store),
    noAntennaBases,
    provisioned,
    excludedFixtures,
    labels: [
      'GAME: grid positions, antenna state and laser status come from the plugin',
      'SIMULATED: radio/laser range maths between grids',
    ],
  };
}

export type SourcedEdge = LinkEdge & { source: 'GAME' | 'SIMULATED' };

export interface LiveLinkGraph extends Omit<LinkGraph, 'edges'> {
  edges: SourcedEdge[];
}

/**
 * Range-math graph over the live nodes, plus one GAME laser edge per pair the
 * plugin reports `Connected`. Reachability is recomputed over both.
 */
export function liveGraph(
  snapshot: NetworkSnapshot,
  planets: Planet[] = loadPlanetCatalog(),
): LiveLinkGraph {
  const built = buildGraph(snapshot.nodes, planets, { laserBlockedByPlanets: true });
  const ids = snapshot.nodes.map((n) => n.id).sort();
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) for (const next of built.adjacency.get(id) ?? []) adjacency.get(id)!.add(next);

  const edges: SourcedEdge[] = built.edges.map((e) => ({ ...e, source: 'SIMULATED' }));
  const undirected = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) for (const next of built.undirected.get(id) ?? []) undirected.get(id)!.add(next);

  for (const pair of snapshot.livePairs) {
    if (!adjacency.has(pair.a) || !adjacency.has(pair.b)) continue;
    adjacency.get(pair.a)!.add(pair.b);
    adjacency.get(pair.b)!.add(pair.a);
    undirected.get(pair.a)!.add(pair.b);
    undirected.get(pair.b)!.add(pair.a);
    for (const [from, to] of [[pair.a, pair.b], [pair.b, pair.a]] as const) {
      if (edges.some((e) => e.from === from && e.to === to && e.kind === 'laser')) continue;
      edges.push({ from, to, kind: 'laser', distanceM: pair.distanceM, source: 'GAME' });
    }
  }
  edges.sort((x, y) => (x.from + '|' + x.to + '|' + x.kind).localeCompare(y.from + '|' + y.to + '|' + y.kind));

  const sources = snapshot.nodes.filter((n) => n.controlSource).map((n) => n.id);
  const reachable = reachableFrom(adjacency, ids, sources);
  return {
    schemaVersion: 1,
    nodes: ids.map((id) => ({
      id,
      controlSource: sources.includes(id),
      reachable: reachable.has(id),
    })),
    edges,
    articulationPoints: findArticulationPoints(ids, undirected),
    bridges: findBridges(ids, undirected),
    components: connectedComponents(ids, undirected),
    config: built.graph.config,
  };
}

/** True when a node id belongs to the live/provisioned model (not a fixture). */
export function isLiveNode(snapshot: NetworkSnapshot, id: string): boolean {
  return snapshot.nodes.some((n) => n.id === id);
}
