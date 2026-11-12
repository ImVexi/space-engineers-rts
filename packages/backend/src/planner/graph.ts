import {
  LinkModelConfigSchema,
  type LinkEdge,
  type LinkGraph,
  type LinkModelConfig,
  type NetworkNode,
  type Planet,
  type WhatIfResult,
} from '@se-rts/schemas';
import { dist, segmentIntersectsSphere } from './geometry.js';
import { MEDIUM_RULES, type MediumRule } from './mediumRules.js';

export const LINK_MODEL_DEFAULTS: LinkModelConfig = LinkModelConfigSchema.parse({
  // `mediumRules.ts` is the authority on which obstacles each medium respects
  // (radio: measured range-only on 2026-11-10; laser: line of sight). The schema
  // already defaults this way; state it here so the two cannot drift apart.
  radioBlockedByPlanets: (MEDIUM_RULES.radio as MediumRule) === 'range+los',
  laserBlockedByPlanets: (MEDIUM_RULES.laser as MediumRule) === 'los',
});

export function resolveConfig(overrides?: Partial<LinkModelConfig>): LinkModelConfig {
  return LinkModelConfigSchema.parse({ ...LINK_MODEL_DEFAULTS, ...(overrides ?? {}) });
}

function radioAllowed(a: NetworkNode, b: NetworkNode, planets: Planet[], config: LinkModelConfig): boolean {
  if (a.radioRadiusM === null) return false;
  const d = dist(a.position, b.position);
  if (d > a.radioRadiusM) return false;
  if (!config.radioBlockedByPlanets) return true;
  return planets.every(
    (p) => !segmentIntersectsSphere(a.position, b.position, p.center, p.maxHillRadiusM + config.planetMarginM),
  );
}

function laserAllowed(a: NetworkNode, b: NetworkNode, planets: Planet[], config: LinkModelConfig): boolean {
  const aHas = a.laserUnlimited || a.laserRangeM !== null;
  const bHas = b.laserUnlimited || b.laserRangeM !== null;
  if (!aHas || !bHas) return false;
  const d = dist(a.position, b.position);
  // A laser pair is a two-ended link: both ends must be able to reach.
  if (!a.laserUnlimited && (a.laserRangeM ?? 0) < d) return false;
  if (!b.laserUnlimited && (b.laserRangeM ?? 0) < d) return false;
  if (!config.laserBlockedByPlanets) return true;
  return planets.every(
    (p) => !segmentIntersectsSphere(a.position, b.position, p.center, p.maxHillRadiusM + config.planetMarginM),
  );
}

export interface BuiltGraph {
  graph: LinkGraph;
  /** Directed adjacency (radio is directional by config). */
  adjacency: Map<string, Set<string>>;
  /** Undirected structural adjacency used for articulation/bridges. */
  undirected: Map<string, Set<string>>;
  edges: LinkEdge[];
}

export function buildGraph(
  nodes: NetworkNode[],
  planets: Planet[] = [],
  configOverrides?: Partial<LinkModelConfig>,
): BuiltGraph {
  const config = resolveConfig(configOverrides);
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Set<string>>();
  const undirected = new Map<string, Set<string>>();
  for (const id of ids) {
    adjacency.set(id, new Set());
    undirected.set(id, new Set());
  }

  const edges: LinkEdge[] = [];
  const seen = new Set<string>();
  const push = (a: NetworkNode, b: NetworkNode, kind: 'radio' | 'laser', d: number): void => {
    const key = `${kind}|${a.id}|${b.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: a.id, to: b.id, kind, distanceM: d });
    adjacency.get(a.id)?.add(b.id);
    undirected.get(a.id)?.add(b.id);
    undirected.get(b.id)?.add(a.id);
  };

  for (const a of nodes) {
    for (const b of nodes) {
      if (a.id === b.id) continue;
      const d = dist(a.position, b.position);
      if (radioAllowed(a, b, planets, config)) {
        push(a, b, 'radio', d);
        if (!config.radioDirectional) push(b, a, 'radio', d);
      }
      if (laserAllowed(a, b, planets, config)) {
        // Laser edges are represented once per direction from the canonical
        // sorted pair so reverse iteration does not duplicate them.
        if (a.id < b.id) {
          push(a, b, 'laser', d);
          push(b, a, 'laser', d);
        }
      }
    }
  }
  edges.sort((x, y) => (x.from + '|' + x.to + '|' + x.kind).localeCompare(y.from + '|' + y.to + '|' + y.kind));

  const reachable = reachableFrom(adjacency, ids, nodes.filter((n) => n.controlSource).map((n) => n.id));
  const articulationPoints = findArticulationPoints(ids, undirected);
  const bridges = findBridges(ids, undirected);
  const components = connectedComponents(ids, undirected);

  const graph: LinkGraph = {
    schemaVersion: 1,
    nodes: ids.map((id) => ({
      id,
      controlSource: byId.get(id)?.controlSource ?? false,
      reachable: reachable.has(id),
    })),
    edges,
    articulationPoints,
    bridges,
    components,
    config,
  };
  return { graph, adjacency, undirected, edges };
}

export function reachableFrom(
  adjacency: Map<string, Set<string>>,
  ids: string[],
  sources: string[],
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of [...sources].sort()) {
    if (!adjacency.has(s) || seen.has(s)) continue;
    seen.add(s);
    queue.push(s);
  }
  while (queue.length) {
    const current = queue.shift()!;
    const next = [...(adjacency.get(current) ?? [])].sort();
    for (const n of next) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

export function linkGraph(
  nodes: NetworkNode[],
  planets: Planet[] = [],
  configOverrides?: Partial<LinkModelConfig>,
): LinkGraph {
  return buildGraph(nodes, planets, configOverrides).graph;
}

export function articulationPoints(nodes: NetworkNode[], planets: Planet[] = []): string[] {
  return buildGraph(nodes, planets).graph.articulationPoints;
}

export function findArticulationPoints(ids: string[], undirected: Map<string, Set<string>>): string[] {
  let clock = 0;
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const points = new Set<string>();

  const visit = (u: string): void => {
    disc.set(u, clock);
    low.set(u, clock);
    clock += 1;
    let children = 0;
    for (const v of [...(undirected.get(u) ?? [])].sort()) {
      if (!disc.has(v)) {
        children += 1;
        parent.set(v, u);
        visit(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (parent.get(u) === null && children > 1) points.add(u);
        if (parent.get(u) !== null && low.get(v)! >= disc.get(u)!) points.add(u);
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  };

  for (const id of [...ids].sort()) {
    if (disc.has(id)) continue;
    parent.set(id, null);
    visit(id);
  }
  return [...points].sort();
}

export function findBridges(
  ids: string[],
  undirected: Map<string, Set<string>>,
): { a: string; b: string }[] {
  let clock = 0;
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges: { a: string; b: string }[] = [];

  const visit = (u: string, parent: string | null): void => {
    disc.set(u, clock);
    low.set(u, clock);
    clock += 1;
    for (const v of [...(undirected.get(u) ?? [])].sort()) {
      if (v === parent) continue;
      if (!disc.has(v)) {
        visit(v, u);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (low.get(v)! > disc.get(u)!) {
          bridges.push({ a: u < v ? u : v, b: u < v ? v : u });
        }
      } else {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  };

  for (const id of [...ids].sort()) {
    if (!disc.has(id)) visit(id, null);
  }
  bridges.sort((x, y) => (x.a + '|' + x.b).localeCompare(y.a + '|' + y.b));
  return bridges;
}

export function connectedComponents(ids: string[], undirected: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of [...ids].sort()) {
    if (seen.has(id)) continue;
    const component: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const u = stack.pop()!;
      component.push(u);
      for (const v of [...(undirected.get(u) ?? [])].sort()) {
        if (seen.has(v)) continue;
        seen.add(v);
        stack.push(v);
      }
    }
    out.push(component.sort());
  }
  return out.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

export function whatIfRemove(
  nodeId: string,
  nodes: NetworkNode[],
  planets: Planet[] = [],
  configOverrides?: Partial<LinkModelConfig>,
): WhatIfResult {
  const before = buildGraph(nodes, planets, configOverrides);
  const beforeReachable = before.graph.nodes.filter((n) => n.reachable).map((n) => n.id);
  const remaining = nodes.filter((n) => n.id !== nodeId);
  const after = buildGraph(remaining, planets, configOverrides);
  const afterReachable = after.graph.nodes.filter((n) => n.reachable).map((n) => n.id);
  const afterSet = new Set(afterReachable);
  return {
    schemaVersion: 1,
    removed: nodeId,
    reachableBefore: beforeReachable.sort(),
    reachableAfter: afterReachable.sort(),
    newlyIsolated: beforeReachable.filter((id) => id !== nodeId && !afterSet.has(id)).sort(),
  };
}
