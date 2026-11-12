/**
 * Cell-driven slot placement (T49).
 *
 * The old ring/constellation path divided N ships evenly over an arc and never
 * read a coverage cell, so ships bunched over one meridian and left half the
 * planet empty. This planner starts from the coverage grid instead:
 *
 *   1. greedily add the relay that covers the most still-uncovered cells, so
 *      the slot set is a set cover rather than an even division;
 *   2. only accept a candidate that is inside one radio hop (<= 0.9 x range) of
 *      a node already on the path back to the base, so the network stays
 *      connected while it grows;
 *   3. keep nodes at least 0.5 x radio apart unless the cells demand otherwise
 *      (prefer the widest useful spacing), and report `spacingM` per hop plus a
 *      `bunching` flag when the rule had to be broken;
 *   4. one local-improvement pass moves one node at a time while it reduces the
 *      number of uncovered cells;
 *   5. if N exceeds what the target needs, only the useful slots are returned
 *      and the rest are `spareShips` with a plain reason.
 *
 * Coverage is counted by `coverageCellsForNodes` (the same slant-path test the
 * heatmap uses), so terrain correction and the reported numbers cannot drift.
 */
import type { Planet } from '@se-rts/schemas';
import { add, dist, dot, normalize, scale, sub, v3, type V3 } from '../../planner/geometry.js';
import {
  coverageCellsFor,
  coverageCellsForNodes,
  footprintAngle,
  type CoverageCell,
  type CoverageCellPoint,
  type TerrainStatus,
} from '../../planner/planetCoverage.js';
import type { TerrainField } from '../../planner/terrainField.js';

export interface SlotPlacementInput {
  planet: Planet;
  altitudeM: number;
  /** Ships offered by the owner; the planner may use fewer and report spares. */
  ships: number;
  radioRangeM: number;
  rangeMargin?: number;
  /** Planet grid cell size; ignored when `cells` is given. */
  cellDeg?: number;
  k?: 1 | 2;
  baseAltitudeM?: number;
  baseDirection?: V3;
  /** Explicit coverage target (e.g. one region); defaults to the planet grid. */
  cells?: { latDeg: number; lonDeg: number }[];
  /** Cylinder the slots must sit in, measured on the ground from a centre. */
  region?: { latDeg: number; lonDeg: number; radiusM: number };
  maxSlots?: number;
  terrain?: TerrainField | null;
}

export interface PlacementNode {
  id: string;
  position: V3;
  altitudeM: number;
  latDeg: number;
  lonDeg: number;
  role: 'coverage';
}

export interface SlotPlacement {
  planet: string;
  altitudeM: number;
  shipsRequested: number;
  slotsUsed: number;
  positions: PlacementNode[];
  /** Distances between nodes joined on the path back to the base, metres. */
  spacingM: number[];
  minSpacingM: number;
  /** True when two nodes ended up closer than 0.5 x radio range. */
  bunching: boolean;
  connectedToBase: boolean;
  spareShips: { id: string; reason: string }[];
  spareReason: string;
  coverage: {
    cellDeg: number | null;
    k: 1 | 2;
    coveredCells: number;
    totalCells: number;
    coveragePct: number;
    geometricCoveredCells: number;
    blockedCells: number;
  };
  cells: CoverageCell[];
  terrain: TerrainStatus;
  terrainReason: string | null;
  reasons: string[];
}

/** Ground distance between two unit directions, metres. */
function groundDistanceM(a: V3, b: V3, surfaceRadiusM: number): number {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(d) * surfaceRadiusM;
}

function latLonOf(dir: V3): { latDeg: number; lonDeg: number } {
  return {
    latDeg: Math.round((Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI * 10) / 10,
    lonDeg: Math.round(((Math.atan2(dir.z, dir.x) * 180) / Math.PI) * 10) / 10,
  };
}

function dirOf(latDeg: number, lonDeg: number): V3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
}

/** Unit tangent at `dir` for a compass bearing (radians, 0 = north). */
function tangentFor(dir: V3, bearingRad: number): V3 {
  const up = v3(0, 1, 0);
  let north = sub(up, scale(dir, dot(up, dir)));
  if (Math.hypot(north.x, north.y, north.z) < 1e-6) {
    const fallback = v3(1, 0, 0);
    north = sub(fallback, scale(dir, dot(fallback, dir)));
  }
  north = normalize(north);
  const east = v3(
    dir.y * north.z - dir.z * north.y,
    dir.z * north.x - dir.x * north.z,
    dir.x * north.y - dir.y * north.x,
  );
  return normalize(add(scale(north, Math.cos(bearingRad)), scale(east, Math.sin(bearingRad))));
}

/** Direction `distanceM` along the ground from `dir` on a sphere. */
function offsetDir(dir: V3, bearingRad: number, distanceM: number, surfaceRadiusM: number): V3 {
  const angle = distanceM / surfaceRadiusM;
  const tangent = tangentFor(dir, bearingRad);
  return normalize(add(scale(dir, Math.cos(angle)), scale(tangent, Math.sin(angle))));
}

function fibonacci(count: number): V3[] {
  const n = Math.max(1, Math.floor(count));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: V3[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push(v3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return out;
}

function regionCandidates(centerDir: V3, radiusM: number, surfaceRadiusM: number): V3[] {
  const out: V3[] = [centerDir];
  const rings = [0.25, 0.5, 0.75, 1];
  for (const fraction of rings) {
    const ringRadius = Math.max(50, radiusM * fraction);
    const bearings = fraction >= 1 ? 12 : 8;
    for (let i = 0; i < bearings; i += 1) {
      out.push(offsetDir(centerDir, (i / bearings) * Math.PI * 2, ringRadius, surfaceRadiusM));
    }
  }
  return out;
}

function cellsFrom(input: SlotPlacementInput): { cells: CoverageCellPoint[]; cellDeg: number | null } {
  if (input.cells && input.cells.length > 0) {
    return {
      cells: input.cells.map((cell) => ({ latDeg: cell.latDeg, lonDeg: cell.lonDeg, dir: dirOf(cell.latDeg, cell.lonDeg) })),
      cellDeg: null,
    };
  }
  const cellDeg = Math.max(2, Math.min(30, input.cellDeg ?? 5));
  return { cells: coverageCellsFor(input.planet, cellDeg), cellDeg };
}

interface Candidate {
  dir: V3;
  position: V3;
  cells: number[];
}

/** Indices of cells inside a candidate's footprint (same law of cosines). */
function visibleCells(candidateDir: V3, cells: CoverageCellPoint[], cosPhi: number, phi: number): number[] {
  if (phi <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (dot(candidateDir, cells[i]!.dir) >= cosPhi) out.push(i);
  }
  return out;
}

function minPairDistance(positions: V3[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const d = dist(positions[i]!, positions[j]!);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Spanning tree from the base over the hop graph; the edges are the "hops back
 * to the base" whose lengths are reported as `spacingM`. Null when some node
 * cannot reach the base within the hop limit.
 */
function hopTree(
  baseId: string,
  basePosition: V3,
  nodes: { id: string; position: V3 }[],
  hopLimitM: number,
): { hops: { from: string; to: string; lengthM: number }[]; connected: boolean } {
  const all = [{ id: baseId, position: basePosition }, ...nodes];
  const adjacency = new Map<string, { id: string; lengthM: number }[]>(all.map((node) => [node.id, []]));
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const lengthM = dist(all[i]!.position, all[j]!.position);
      if (lengthM <= hopLimitM + 0.5) {
        adjacency.get(all[i]!.id)!.push({ id: all[j]!.id, lengthM });
        adjacency.get(all[j]!.id)!.push({ id: all[i]!.id, lengthM });
      }
    }
  }
  const hops: { from: string; to: string; lengthM: number }[] = [];
  const seen = new Set<string>([baseId]);
  const queue = [baseId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      hops.push({ from: current, to: next.id, lengthM: Math.round(next.lengthM * 10) / 10 });
      queue.push(next.id);
    }
  }
  return { hops, connected: nodes.every((node) => seen.has(node.id)) };
}

/** Spacing report for an existing slot set (used by cover-planet and ring). */
export function spacingReport(args: {
  nodes: { id: string; position: V3 }[];
  basePosition: V3;
  hopLimitM: number;
  radioRangeM: number;
}): {
  hops: { from: string; to: string; lengthM: number }[];
  spacingM: number[];
  minSpacingM: number;
  bunching: boolean;
  connected: boolean;
} {
  const tree = hopTree('base', args.basePosition, args.nodes, args.hopLimitM);
  const positions = args.nodes.map((node) => node.position);
  const pairwise = positions.length > 1 ? minPairDistance(positions) : Number.POSITIVE_INFINITY;
  return {
    hops: tree.hops,
    spacingM: tree.hops.map((hop) => hop.lengthM),
    minSpacingM: Number.isFinite(pairwise) ? Math.round(pairwise * 10) / 10 : 0,
    bunching: pairwise < 0.5 * args.radioRangeM,
    connected: tree.connected,
  };
}

/**
 * Plan slot positions for N ships over a coverage target. Deterministic: no
 * randomness, ties resolve by widest spacing then candidate order.
 */
export function planSlotPlacement(input: SlotPlacementInput): SlotPlacement {
  const planet = input.planet;
  const altitudeM = Math.max(0, Math.round(input.altitudeM));
  const ships = Math.max(0, Math.round(input.ships));
  const rangeM = Math.max(1, input.radioRangeM);
  const margin = Math.max(0.5, Math.min(1, input.rangeMargin ?? 0.9));
  const k = input.k ?? 1;
  const hopLimitM = rangeM * 0.9;
  const minSpacingM = rangeM * 0.5;
  const baseAltitudeM = input.baseAltitudeM ?? 1_800;
  const baseDir = input.baseDirection ? normalize(sub(input.baseDirection, planet.center)) : v3(0, 1, 0);
  const basePosition = add(planet.center, scale(baseDir, planet.surfaceRadiusM + baseAltitudeM));
  const slotRadius = planet.surfaceRadiusM + altitudeM;
  const nodePosition = (dir: V3): V3 => add(planet.center, scale(dir, slotRadius));
  const { cells, cellDeg } = cellsFrom(input);
  const reasons: string[] = [];

  const phi = footprintAngle(planet.surfaceRadiusM, slotRadius, rangeM * margin);
  const cosPhi = Math.cos(phi);

  // Candidate slots: the whole sphere, or only the requested region.
  let candidateDirs: V3[];
  if (input.region) {
    const centerDir = dirOf(input.region.latDeg, input.region.lonDeg);
    candidateDirs = regionCandidates(centerDir, input.region.radiusM, planet.surfaceRadiusM);
    reasons.push(
      `slots are confined to a ${(input.region.radiusM / 1000).toFixed(1)} km radius around ` +
        `${input.region.latDeg.toFixed(1)}°, ${input.region.lonDeg.toFixed(1)}°`,
    );
  } else {
    const count = Math.min(2_000, Math.max(256, Math.round(cells.length / 2)));
    candidateDirs = fibonacci(count);
  }

  const candidates: Candidate[] = candidateDirs.map((dir) => ({
    dir,
    position: nodePosition(dir),
    cells: visibleCells(dir, cells, cosPhi, phi),
  }));

  const counts = new Array<number>(cells.length).fill(0);
  const selected: { candidate: number; dir: V3; position: V3; id: string }[] = [];
  const used = new Set<number>();
  let coveredCells = 0;
  const totalCells = cells.length;

  const connectedPositions = (): V3[] => [basePosition, ...selected.map((node) => node.position)];
  const distanceToConnected = (position: V3): number => {
    let min = Number.POSITIVE_INFINITY;
    for (const other of connectedPositions()) min = Math.min(min, dist(position, other));
    return min;
  };
  const minDistanceToSelected = (position: V3, except?: V3): number => {
    let min = Number.POSITIVE_INFINITY;
    for (const node of selected) {
      if (except && node.position === except) continue;
      min = Math.min(min, dist(position, node.position));
    }
    return min;
  };

  const maxSlots = Math.min(ships, input.maxSlots ?? 400);
  for (let slot = 0; slot < maxSlots; slot += 1) {
    let bestIndex = -1;
    let bestGain = 0;
    let bestSpread = Number.NEGATIVE_INFINITY;
    // First pass honours the spacing rule; the second runs only if no spacing-
    // compliant candidate adds coverage, i.e. the cell math demands closeness.
    for (const allowClose of [false, true]) {
      for (let c = 0; c < candidates.length; c += 1) {
        if (used.has(c)) continue;
        const candidate = candidates[c]!;
        if (candidate.cells.length === 0) continue;
        if (distanceToConnected(candidate.position) > hopLimitM) continue;
        const spread = minDistanceToSelected(candidate.position);
        if (!allowClose && selected.length > 0 && spread < minSpacingM) continue;
        let gain = 0;
        for (const index of candidate.cells) if (counts[index]! < k) gain += 1;
        if (gain <= 0) continue;
        if (gain > bestGain || (gain === bestGain && spread > bestSpread + 1e-6)) {
          bestIndex = c;
          bestGain = gain;
          bestSpread = spread;
        }
      }
      if (bestIndex >= 0) {
        if (allowClose) reasons.push('the cells needed a relay closer than 0.5 x radio range: spacing rule relaxed');
        break;
      }
    }
    if (bestIndex < 0) break;
    used.add(bestIndex);
    const candidate = candidates[bestIndex]!;
    const id = `s${selected.length + 1}`;
    selected.push({ candidate: bestIndex, dir: candidate.dir, position: candidate.position, id });
    for (const index of candidate.cells) {
      if (counts[index]! < k) {
        counts[index] = counts[index]! + 1;
        if (counts[index] === k) coveredCells += 1;
      }
    }
  }

  // Local improvement: move one node at a time while it covers strictly more
  // still-uncovered cells and keeps the network connected.
  if (coveredCells < totalCells && selected.length > 1) {
    const offsets = [0.5, 1, 2].flatMap((km) =>
      Array.from({ length: 8 }, (_, i) => ({ distanceM: km * 1000, bearing: (i / 8) * Math.PI * 2 })),
    );
    for (const node of selected) {
      const withoutNode = counts.map((value, index) => (candidates[node.candidate]!.cells.includes(index) ? value - 1 : value));
      const oldGain = candidates[node.candidate]!.cells.reduce((sum, index) => sum + (withoutNode[index]! < k ? 1 : 0), 0);
      let best: { dir: V3; position: V3; cells: number[]; gain: number } | null = null;
      for (const offset of offsets) {
        const dir = offsetDir(node.dir, offset.bearing, offset.distanceM, planet.surfaceRadiusM);
        const position = nodePosition(dir);
        if (minDistanceToSelected(position, node.position) < minSpacingM) continue;
        const list = visibleCells(dir, cells, cosPhi, phi);
        const gain = list.reduce((sum, index) => sum + (withoutNode[index]! < k ? 1 : 0), 0);
        if (gain <= oldGain) continue;
        // Connectivity: the moved node must still hop to the base or a peer,
        // and the rest of the network must stay connected without it.
        const peers = selected.filter((other) => other !== node);
        const nodeLinked =
          dist(position, basePosition) <= hopLimitM + 0.5 ||
          peers.some((other) => dist(position, other.position) <= hopLimitM + 0.5);
        if (!nodeLinked) continue;
        const trial = [...peers.map((other) => ({ id: other.id, position: other.position })), { id: node.id, position }];
        if (!hopTree('base', basePosition, trial, hopLimitM).connected) continue;
        if (!best || gain > best.gain) best = { dir, position, cells: list, gain };
      }
      if (best) {
        for (const index of candidates[node.candidate]!.cells) counts[index] = counts[index]! - 1;
        for (const index of best.cells) counts[index] = counts[index]! + 1;
        node.dir = best.dir;
        node.position = best.position;
        node.candidate = -1;
        // Keep the candidate list in sync for later nodes.
        candidates.push({ dir: best.dir, position: best.position, cells: best.cells });
        node.candidate = candidates.length - 1;
      }
    }
    coveredCells = counts.filter((value) => value >= k).length;
  }

  const positions: PlacementNode[] = selected.map((node) => {
    const ll = latLonOf(node.dir);
    return {
      id: node.id,
      position: node.position,
      altitudeM,
      latDeg: ll.latDeg,
      lonDeg: ll.lonDeg,
      role: 'coverage',
    };
  });

  const tree = hopTree('base', basePosition, positions, hopLimitM);
  const pairwise = positions.length > 1 ? minPairDistance(positions.map((node) => node.position)) : Number.POSITIVE_INFINITY;
  const bunching = pairwise < minSpacingM;
  if (bunching) {
    reasons.push(
      `two slots are ${(pairwise / 1000).toFixed(1)} km apart, under the 0.5 x radio rule ` +
        `(${(minSpacingM / 1000).toFixed(1)} km); the cells here do not need more spread`,
    );
  }

  // Final report: the same slant-path test the heatmap uses.
  const report = coverageCellsForNodes(planet, cells, positions, rangeM * margin, k, input.terrain);
  if (report.terrain === 'unavailable') {
    reasons.push(`terrain is unavailable for ${planet.name}: coverage is the smooth-sphere footprint`);
  } else if (report.terrain === 'corrected') {
    reasons.push(`coverage is terrain-corrected along ${report.sampling?.samplesPerPath ?? 12} samples per path`);
  }

  const spare = Math.max(0, ships - positions.length);
  const scope = input.region ? 'this region' : 'this coverage target';
  const spacingKm = Number.isFinite(pairwise) ? Math.max(1, Math.round(pairwise / 1000)) : Math.round(minSpacingM / 1000);
  const spareReason = spare
    ? `${scope} needs ${positions.length} at ${spacingKm} km spacing; ${spare} spare`
    : `${scope} uses all ${positions.length} ship(s)`;
  if (spare) reasons.push(spareReason);
  if (!tree.connected && positions.length > 0) {
    reasons.push('not every slot reaches the base within one 0.9 x radio hop');
  }

  return {
    planet: planet.name,
    altitudeM,
    shipsRequested: ships,
    slotsUsed: positions.length,
    positions,
    spacingM: tree.hops.map((hop) => hop.lengthM),
    minSpacingM: Number.isFinite(pairwise) ? Math.round(pairwise * 10) / 10 : 0,
    bunching,
    connectedToBase: tree.connected,
    spareShips: Array.from({ length: spare }, (_, i) => ({ id: `spare-${i + 1}`, reason: spareReason })),
    spareReason,
    coverage: {
      cellDeg,
      k,
      coveredCells: report.coveredCells,
      totalCells: report.totalCells,
      coveragePct: report.coveragePct,
      geometricCoveredCells: report.geometricCoveredCells,
      blockedCells: report.blockedCells,
    },
    cells: report.cells,
    terrain: report.terrain,
    terrainReason: report.terrainReason,
    reasons,
  };
}
