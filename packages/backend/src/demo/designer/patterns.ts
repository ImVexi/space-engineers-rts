/**
 * Constellation geometry for the T6 designer.
 *
 * Every position is deterministic planner math (SIMULATED): a slot sits at
 * `surfaceRadiusM + altitudeM` from the planet centre. `altitudeM` is AGL over
 * the minimum surface radius, which is also what the gravity model uses.
 */
import type { Planet } from '@se-rts/schemas';
import {
  add,
  anyPerpendicular,
  cross,
  dist,
  fibonacciDirections,
  len,
  normalize,
  scale,
  sub,
  type V3,
} from '../../planner/geometry.js';

export type Pattern = 'ring' | 'inclined-rings' | 'shell' | 'chain' | 'auto';
export type Redundancy = 1 | 2 | 'no-spof';

export interface SlotPosition {
  id: string;
  x: number;
  y: number;
  z: number;
}

export function slotRadiusM(planet: Pick<Planet, 'surfaceRadiusM'>, altitudeM: number): number {
  return planet.surfaceRadiusM + Math.max(0, altitudeM);
}

export function toSlot(id: string, p: V3): SlotPosition {
  return { id, ...p };
}

/** Points on a circle of radius `r` in the plane whose normal is `normal`. */
export function circlePositions(center: V3, radius: number, count: number, normal: V3, phase = 0): V3[] {
  const n = Math.max(1, Math.floor(count));
  const e1 = anyPerpendicular(normal);
  const e2 = normalize(cross(normal, e1));
  const out: V3[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = phase + (2 * Math.PI * i) / n;
    out.push(add(center, add(scale(e1, Math.cos(a) * radius), scale(e2, Math.sin(a) * radius))));
  }
  return out;
}

/** Equatorial ring around a planet. */
export function ringPositions(planet: Planet, altitudeM: number, count: number, phase = 0): V3[] {
  const r = slotRadiusM(planet, altitudeM);
  return circlePositions(planet.center, r, count, { x: 0, y: 1, z: 0 }, phase);
}

/** Two equal rings whose planes are tilted `inclinationDeg` around the X axis. */
export function inclinedRingPositions(
  planet: Planet,
  altitudeM: number,
  count: number,
  inclinationDeg = 55,
): V3[] {
  const r = slotRadiusM(planet, altitudeM);
  const perRing = Math.max(1, Math.ceil(count / 2));
  const incl = (inclinationDeg * Math.PI) / 180;
  const normalA = normalize({ x: 0, y: Math.cos(incl), z: Math.sin(incl) });
  const normalB = normalize({ x: 0, y: Math.cos(incl), z: -Math.sin(incl) });
  const a = circlePositions(planet.center, r, perRing, normalA, 0);
  const b = circlePositions(planet.center, r, perRing, normalB, Math.PI / perRing);
  return [...a, ...b].slice(0, Math.max(2, count));
}

/** Fibonacci shell around a planet. */
export function shellPositions(planet: Planet, altitudeM: number, count: number): V3[] {
  const r = slotRadiusM(planet, altitudeM);
  return fibonacciDirections(Math.max(1, count)).map((d) => add(planet.center, scale(d, r)));
}

/** Great-circle arc: a "string of pearls" across one hemisphere (constellation chain). */
export function chainPositions(planet: Planet, altitudeM: number, count: number, fromAngle = 0): V3[] {
  const r = slotRadiusM(planet, altitudeM);
  const n = Math.max(2, count);
  // Arc from the equator over the north pole to the opposite equator.
  const out: V3[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const theta = fromAngle + Math.PI * t;
    out.push(
      add(planet.center, {
        x: Math.cos(theta) * r,
        y: Math.sin(theta) * r,
        z: 0,
      }),
    );
  }
  return out;
}

/**
 * Points along a straight segment, resampled so no gap exceeds `spacingM`.
 * Used for connect routes between two arbitrary GPS points.
 */
export function linePositions(a: V3, b: V3, spacingM: number): V3[] {
  const d = dist(a, b);
  const hops = Math.max(1, Math.ceil(d / Math.max(1, spacingM)));
  const out: V3[] = [];
  for (let i = 0; i <= hops; i += 1) out.push(add(a, scale(sub(b, a), i / hops)));
  return out;
}

/** Offset a straight route sideways so a second path can be node-disjoint. */
export function offsetLinePositions(a: V3, b: V3, spacingM: number, offsetM: number): V3[] {
  const d = sub(b, a);
  const direction = normalize(d);
  const side = anyPerpendicular(direction);
  const midpoint = add(a, scale(d, 0.5));
  const waypoint = add(midpoint, scale(side, offsetM));
  return [...linePositions(a, waypoint, spacingM).slice(0, -1), ...linePositions(waypoint, b, spacingM)];
}

export interface PositionGraph {
  /** Undirected adjacency over slot ids. */
  adjacency: Map<string, Set<string>>;
  /** True when every node is connected to every other. */
  connected: boolean;
  /** Articulation points (node ids); empty means the graph is 2-connected. */
  articulationPoints: string[];
  /** Nodes with degree < 2. */
  lowDegree: string[];
  /** Longest nearest-neighbour gap, metres. */
  maxGapM: number;
  /** Pairs that have a link (undirected, de-duplicated). */
  links: { a: string; b: string; lengthM: number }[];
}

/** Link graph from slot positions and one radio range (metres). */
export function positionGraph(positions: { id: string; x: number; y: number; z: number }[], rangeM: number): PositionGraph {
  const adjacency = new Map<string, Set<string>>();
  for (const p of positions) adjacency.set(p.id, new Set());
  const links: { a: string; b: string; lengthM: number }[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i]!;
      const b = positions[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d <= rangeM) {
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
        links.push({ a: a.id, b: b.id, lengthM: d });
      }
    }
  }

  // Connected components via BFS.
  const ids = positions.map((p) => p.id);
  const seen = new Set<string>();
  let components = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    components += 1;
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }

  // Tarjan articulation points.
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
    for (const v of adjacency.get(u) ?? []) {
      if (!disc.has(v)) {
        parent.set(v, u);
        children += 1;
        visit(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
        if (!parent.has(u) || parent.get(u) === null) {
          if (children > 1) points.add(u);
        } else if (low.get(v)! >= disc.get(u)!) {
          points.add(u);
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  };
  for (const id of ids) if (!disc.has(id)) {
    parent.set(id, null);
    visit(id);
  }

  const lowDegree = ids.filter((id) => (adjacency.get(id)?.size ?? 0) < 2);
  let maxGapM = 0;
  for (const id of ids) {
    let nearest = Infinity;
    for (const other of adjacency.get(id) ?? []) {
      const a = positions.find((p) => p.id === id)!;
      const b = positions.find((p) => p.id === other)!;
      nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    if (Number.isFinite(nearest)) maxGapM = Math.max(maxGapM, nearest);
  }

  return {
    adjacency,
    connected: components === 1,
    articulationPoints: [...points].sort(),
    lowDegree: lowDegree.sort(),
    maxGapM,
    links,
  };
}

/** Shortest path between two ids, or null. */
export function shortestPath(adjacency: Map<string, Set<string>>, from: string, to: string, banned = new Set<string>()): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next) || banned.has(next)) continue;
      seen.add(next);
      prev.set(next, current);
      if (next === to) {
        const path = [to];
        let cursor = to;
        while (prev.has(cursor)) {
          cursor = prev.get(cursor)!;
          path.unshift(cursor);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Two node-disjoint paths between `from` and `to` (endpoints shared).
 *
 * Unit-capacity max flow on a node-split graph: every internal node has
 * capacity 1, so a flow of 2 is exactly two paths that share no internal node.
 * This is a correctness check, not a heuristic BFS retry.
 */
export function twoNodeDisjointPaths(
  adjacency: Map<string, Set<string>>,
  from: string,
  to: string,
): { first: string[]; second: string[] } | null {
  if (from === to) return null;
  const cap = new Map<string, Map<string, number>>();
  const ensure = (a: string): Map<string, number> => {
    let m = cap.get(a);
    if (!m) {
      m = new Map();
      cap.set(a, m);
    }
    return m;
  };
  for (const [u, neighbours] of adjacency) {
    ensure(`${u}|in`);
    ensure(`${u}|out`);
    ensure(`${u}|in`).set(`${u}|out`, u === from || u === to ? 2 : 1);
    for (const v of neighbours) {
      ensure(`${u}|out`).set(`${v}|in`, 1);
      ensure(`${v}|out`).set(`${u}|in`, 1);
    }
  }
  const source = `${from}|out`;
  const sink = `${to}|in`;
  const residual = new Map<string, Map<string, number>>();
  const original = new Map<string, Map<string, number>>();
  const edgeMap = (map: Map<string, Map<string, number>>, a: string): Map<string, number> => {
    let m = map.get(a);
    if (!m) {
      m = new Map();
      map.set(a, m);
    }
    return m;
  };
  for (const [u, m] of cap) {
    for (const [v, c] of m) {
      edgeMap(original, u).set(v, c);
      edgeMap(residual, u).set(v, c);
      edgeMap(residual, v); // reverse edge with zero capacity
    }
  }

  let flow = 0;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const prev = new Map<string, string>();
    const seen = new Set([source]);
    const queue = [source];
    while (queue.length && !seen.has(sink)) {
      const u = queue.shift()!;
      for (const [v, c] of residual.get(u) ?? []) {
        if (c <= 0 || seen.has(v)) continue;
        seen.add(v);
        prev.set(v, u);
        queue.push(v);
        if (v === sink) break;
      }
    }
    if (!prev.has(sink)) break;
    let cursor = sink;
    while (cursor !== source) {
      const p = prev.get(cursor)!;
      residual.get(p)!.set(cursor, (residual.get(p)!.get(cursor) ?? 0) - 1);
      residual.get(cursor)!.set(p, (residual.get(cursor)!.get(p) ?? 0) + 1);
      cursor = p;
    }
    flow += 1;
  }
  if (flow < 2) return null;

  // Recover the two s->t paths from saturated original forward arcs.
  const usedByNode = new Map<string, string[]>();
  for (const [u, m] of original) {
    if (!u.endsWith('|out')) continue;
    for (const [v, capValue] of m) {
      if (!v.endsWith('|in') || capValue <= 0) continue;
      if ((residual.get(u)?.get(v) ?? 0) !== 0) continue;
      const list = usedByNode.get(u) ?? [];
      list.push(v);
      usedByNode.set(u, list);
    }
  }
  const walk = (): string[] | null => {
    const path = [from];
    let cursor = `${from}|out`;
    for (let guard = 0; guard < 256; guard += 1) {
      const outs = usedByNode.get(cursor) ?? [];
      const next = outs.pop();
      if (!next) return null;
      const node = next.slice(0, -3); // strip |in
      path.push(node);
      if (node === to) return path;
      cursor = `${node}|out`;
    }
    return null;
  };
  const first = walk();
  const second = walk();
  if (!first || !second) return null;
  const internal = new Set([...first.slice(1, -1), ...second.slice(1, -1)]);
  if (internal.size !== first.length - 2 + (second.length - 2)) return null;
  return { first, second };
}

/**
 * Fraction (0..1) of the planet surface covered by at least `k` radio
 * footprints. Deterministic Fibonacci sampling on the surface sphere.
 */
export function coverageFraction(
  planet: Pick<Planet, 'center' | 'surfaceRadiusM'>,
  altitudeM: number,
  positions: { x: number; y: number; z: number }[],
  rangeM: number,
  k: 1 | 2 = 1,
  sampleCount = 1500,
): number {
  if (!positions.length) return 0;
  const r = slotRadiusM(planet, altitudeM);
  const surface = planet.surfaceRadiusM;
  // Cap half-angle of a footprint on the surface (law of cosines).
  const phi = (() => {
    if (rangeM <= 0 || r <= surface) return 0;
    const cosPhi = (r * r + surface * surface - rangeM * rangeM) / (2 * r * surface);
    if (cosPhi >= 1) return 0;
    if (cosPhi <= -1) return Math.PI;
    return Math.acos(cosPhi);
  })();
  if (phi <= 0) return 0;
  const cosPhi = Math.cos(phi);
  let covered = 0;
  const dirs = fibonacciDirections(sampleCount);
  for (const d of dirs) {
    let count = 0;
    for (const p of positions) {
      const v = sub(p, planet.center);
      const unit = normalize(v);
      if (unit.x * d.x + unit.y * d.y + unit.z * d.z >= cosPhi) {
        count += 1;
        if (count >= k) break;
      }
    }
    if (count >= k) covered += 1;
  }
  return covered / sampleCount;
}

/** Minimum ring count so consecutive slots are within `spacingM`. */
export function ringCountForSpacing(planet: Planet, altitudeM: number, spacingM: number): number {
  const r = slotRadiusM(planet, altitudeM);
  return Math.max(2, Math.ceil((2 * Math.PI * r) / Math.max(1, spacingM)));
}

/** Minimum shell count so the mean neighbour spacing is within `spacingM`. */
export function shellCountForSpacing(planet: Planet, altitudeM: number, spacingM: number): number {
  const r = slotRadiusM(planet, altitudeM);
  return Math.max(2, Math.ceil((4 * Math.PI * r * r) / Math.max(1, spacingM) ** 2));
}
