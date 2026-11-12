/**
 * Coverage-first constellation solver (T53) with per-slot altitudes (T52).
 *
 * The old solve divided N ships evenly over an arc and called it a
 * constellation. This one starts from the coverage grid:
 *
 *   1. candidate slots are (direction x altitude) pairs; the altitude comes
 *      from the requested mode — manual, max-reach (maximise the terrain-cleared
 *      footprint) or cheapest (lowest total cost per km of ground reach, mixed
 *      altitudes allowed);
 *   2. greedy selection by coverage gained per unit cost, never adding a slot
 *      that cannot join the base within 0.9 x radio, and never adding one
 *      closer than `minSpacingM` (default 0.5 x radio, on the ground) to a
 *      slot already chosen. When no compliant candidate adds coverage the
 *      rule bends once — recorded as `spacingRelaxed` with a plain reason —
 *      but the 8 km same-altitude floor never does. Coverage still wins:
 *      extra relays are added until the goal is met or the cap is reached;
 *   3. k=2 is real redundancy: every target cell needs two relays and every
 *      relay needs two node-disjoint paths to the base. Missing second paths
 *      are repaired with explicit bridge slots, and any relay that still has
 *      one path is reported by name instead of being papered over;
 *   4. auto count: the solver reports how many ships the goal needs; a fixed
 *      lower count maximises coverage and reports what is left uncovered.
 *
 * All coverage numbers go through `coverageCellsForNodes`, the same slant-path
 * test the heatmap uses, so terrain correction cannot drift between views.
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
import type { DesignerHull } from './hulls.js';
import {
  DEFAULT_COST_WEIGHTS,
  MIN_STATION_ALTITUDE_M,
  altitudeLadderM,
  bestFlatAltitudeM,
  groundFootprintFraction,
  reliefAround,
  groundFootprintRadiusM,
  normaliseCostWeights,
  slotCostAt,
  tuneSlotRadio,
  type AltitudeMode,
  type CostWeights,
} from './altitude.js';
import { RIDGE_LADDER_M } from './altitude.js';
import { hullForDesigner } from '../endurance/index.js';
import { evaluateHullAtSlot } from '../endurance/model.js';

export type CoverTargetKind = 'whole' | 'hemisphere' | 'radius';

export interface CoverTarget {
  kind: CoverTargetKind;
  /** Direction the coverage region faces (hemisphere / radius centre). */
  centerDir?: V3;
  radiusM?: number;
}

export interface CoverGoalInput {
  planet: Planet;
  k: 1 | 2;
  cellDeg: number;
  rangeMargin: number;
  altitudeMode: AltitudeMode;
  manualAltitudeM?: number | null;
  /** Fixed ship count; null/undefined = auto. */
  count?: number | null;
  hull: DesignerHull;
  target?: CoverTarget;
  baseDirection?: V3;
  baseAltitudeM?: number;
  terrain?: TerrainField | null;
  costWeights?: Partial<CostWeights> | null;
  maxSlots?: number;
  /**
   * Minimum ground spacing between any two chosen slots, metres.
   *
   * Default 0.5 x the hull's radio range (25 km for a 50 km radio): the same
   * rule `spacingReport` uses to flag `bunching`. It is measured along the
   * ground (surface arc), because that is the distance a user means by "these
   * two are too close" — an arc of 25 km on a 59 km planet is a big chord once
   * the slots are 18 km up. Override it to ask for tighter or wider
   * constellations; the hard floor (8 km at one altitude) still applies.
   */
  minSpacingM?: number | null;
}

export interface CoverGoalSlot {
  id: string;
  latDeg: number;
  lonDeg: number;
  altitudeM: number;
  position: V3;
  role: 'coverage' | 'bridge' | 'redundancy';
  altitudeReason: string;
  footprintRadiusM: number;
  footprintPct: number;
  radioRadiusM: number;
  antennaMW: number;
  radioSavedMW: number;
  antennaReason: string;
  cellsCovered: number;
}

export interface CoverAlternative {
  id: 'all-low' | 'all-max-reach' | 'best-mixed';
  label: string;
  ships: number;
  h2L: number;
  batteryMWh: number;
  antennaMW: number;
  coveragePct: number;
  terrain: TerrainStatus;
  altitudeRangeM: [number, number];
  cost: number;
  note: string;
}

export interface CoverGoalPlan {
  planet: string;
  k: 1 | 2;
  cellDeg: number;
  target: CoverTargetKind;
  altitudeMode: AltitudeMode;
  slots: CoverGoalSlot[];
  cells: CoverageCell[];
  counts: { coveredK1: number; coveredK2: number };
  coveredCells: number;
  totalCells: number;
  coveragePct: number;
  uncoveredPct: number;
  countNeeded: number;
  countUsed: number;
  requestedCount: number | null;
  surplus: { id: string; reason: string }[];
  achievedK: 1 | 2;
  relaysWithoutSecondPath: string[];
  disjointPathPairs: { relayId: string; paths: number }[];
  alternatives: CoverAlternative[];
  links: { a: string; b: string; lengthM: number }[];
  maxGapM: number;
  connectedToBase: boolean;
  spofs: string[];
  /** Spacing rule the solver enforced between any two slots, metres. */
  spacingRuleM: number;
  /** Smallest ground (surface arc) distance between two slots, metres. */
  minSpacingM: number;
  /** Mean ground distance over every slot pair, metres. */
  meanSpacingM: number;
  /** Smallest straight-line distance between two slots (what spacingReport reads), metres. */
  minChordSpacingM: number;
  /** True when two slots ended up closer than `spacingRuleM`. */
  bunching: boolean;
  /** True when the spacing rule had to be broken to keep the coverage goal. */
  spacingRelaxed: boolean;
  /** Plain words for the relaxation, null when the rule held. */
  spacingRelaxedReason: string | null;
  /**
   * Overlap accounting: for every target cell, how many relays beyond `k`
   * hear it. Redundancy past k is what makes a constellation "cluttered";
   * k itself is required so the radios can talk.
   */
  overlapMetric: { sum: number; mean: number; maxPerCell: number };
  totals: { h2L: number; batteryMWh: number; antennaMW: number; cost: number };
  terrain: TerrainStatus;
  terrainReason: string | null;
  sampling: { samplesPerPath: number; tiles: number } | null;
  reasons: string[];
  labels: string[];
}

const HOP_FACTOR = 0.9;
const MAX_REPAIR_ATTEMPTS = 40;
/** The "0.5 x radio range" spacing rule, as a fraction of the radio range. */
export const SPACING_RULE_FACTOR = 0.5;
/**
 * Hard floor: two slots at the SAME altitude may never sit closer than this,
 * even when the spacing rule is relaxed. Anything below is physically silly
 * (two relays shadowing each other's antennas and sharing one debris cloud).
 */
export const HARD_MIN_SPACING_M = 8_000;

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function latLonOf(dir: V3): { latDeg: number; lonDeg: number } {
  return {
    latDeg: Math.round(((Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI) * 10) / 10,
    lonDeg: Math.round(((Math.atan2(dir.z, dir.x) * 180) / Math.PI) * 10) / 10,
  };
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

function groundDistanceM(a: V3, b: V3, surfaceRadiusM: number): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * surfaceRadiusM;
}

/**
 * Min/mean ground spacing and min straight-line spacing over every slot pair.
 * Ground (surface arc) is the distance the spacing rule talks about; the chord
 * minimum is what `spacingReport` publishes, so both are reported.
 */
export function slotSpacingStats(
  planet: Planet,
  slots: { dir: V3; position: V3 }[],
): { minSpacingM: number; meanSpacingM: number; minChordSpacingM: number } {
  let minGround = Number.POSITIVE_INFINITY;
  let minChord = Number.POSITIVE_INFINITY;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const ground = groundDistanceM(slots[i]!.dir, slots[j]!.dir, planet.surfaceRadiusM);
      const chord = dist(slots[i]!.position, slots[j]!.position);
      if (ground < minGround) minGround = ground;
      if (chord < minChord) minChord = chord;
      sum += ground;
      pairs += 1;
    }
  }
  if (pairs === 0) return { minSpacingM: 0, meanSpacingM: 0, minChordSpacingM: 0 };
  return {
    minSpacingM: Math.round(minGround * 10) / 10,
    meanSpacingM: Math.round((sum / pairs) * 10) / 10,
    minChordSpacingM: Math.round(minChord * 10) / 10,
  };
}

/** Target cells for a whole planet, a hemisphere or a ground radius. */
export function coverGoalCells(planet: Planet, cellDeg: number, target: CoverTarget): CoverageCellPoint[] {
  const all = coverageCellsFor(planet, cellDeg);
  if (target.kind === 'whole' || !target.centerDir) return all;
  const center = normalize(target.centerDir);
  if (target.kind === 'hemisphere') {
    return all.filter((cell) => dot(cell.dir, center) > 0);
  }
  const radiusM = Math.max(1_000, target.radiusM ?? 0);
  return all.filter((cell) => groundDistanceM(cell.dir, center, planet.surfaceRadiusM) <= radiusM);
}

/** Node-disjoint path count from `from` to `to` (unit node capacities, max flow). */
export function nodeDisjointPathCount(adjacency: Map<string, Set<string>>, from: string, to: string): number {
  if (from === to) return Number.POSITIVE_INFINITY;
  const ids = [...adjacency.keys()];
  if (!adjacency.has(from) || !adjacency.has(to)) return 0;
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const n = ids.length;
  // node split: in = 2*i, out = 2*i+1
  const size = n * 2;
  const capacity = new Float64Array(size * size);
  const read = (a: number, b: number): number => capacity[a * size + b] ?? 0;
  const write = (a: number, b: number, value: number): void => {
    capacity[a * size + b] = value;
  };
  const edge = (a: number, b: number, cap: number): void => {
    write(a, b, read(a, b) + cap);
  };
  for (const id of ids) {
    const i = index.get(id)!;
    const cap = id === from || id === to ? 1_000 : 1;
    edge(i * 2, i * 2 + 1, cap);
  }
  for (const [id, neighbours] of adjacency) {
    for (const next of neighbours) {
      if (!index.has(next)) continue;
      edge(index.get(id)! * 2 + 1, index.get(next)! * 2, 1);
    }
  }
  const source = index.get(from)! * 2 + 1;
  const sink = index.get(to)! * 2;
  let flow = 0;
  for (;;) {
    // BFS augmenting path on residuals
    const parent = new Int32Array(size).fill(-1);
    const queue = [source];
    parent[source] = source;
    while (queue.length && parent[sink] === -1) {
      const current = queue.shift()!;
      for (let next = 0; next < size; next += 1) {
        if (parent[next] !== -1) continue;
        if (read(current, next) <= 1e-9) continue;
        parent[next] = current;
        queue.push(next);
        if (next === sink) break;
      }
    }
    if (parent[sink] === -1) break;
    let bottleneck = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source; node = parent[node]!) {
      bottleneck = Math.min(bottleneck, read(parent[node]!, node));
    }
    for (let node = sink; node !== source; node = parent[node]!) {
      write(parent[node]!, node, read(parent[node]!, node) - bottleneck);
      write(node, parent[node]!, read(node, parent[node]!) + bottleneck);
    }
    flow += bottleneck;
    if (flow >= 2) break;
  }
  return flow;
}

interface Layout {
  candidates: { dir: V3; altitudeM: number; position: V3; list: number[]; cost: number; costDetail: ReturnType<typeof slotCostAt> | null }[];
  selected: number[];
  counts: number[];
  covered: number;
  slots: { dir: V3; altitudeM: number; position: V3 }[];
  /** Extra slots added to give every relay a second path (k=2 only). */
  repaired: { dir: V3; altitudeM: number; position: V3 }[];
  failures: string[];
  robust: boolean;
  /** True when a slot had to break the spacing rule to keep coverage. */
  spacingRelaxed: boolean;
  /** Nearest-neighbour ground distance at the relaxed pick, metres. */
  relaxedNearestM: number | null;
  /** 1-based ordinal of the first relaxed pick. */
  relaxedAtSlot: number;
  /**
   * Set when the greedy stopped short of the goal with ships to spare because
   * every remaining candidate that hears the uncovered cells sits inside the
   * 8 km hard floor. Reported, never hidden.
   */
  shortfallReason: string | null;
}

interface SolveOptions {
  planet: Planet;
  cells: CoverageCellPoint[];
  k: 1 | 2;
  rangeM: number;
  hopM: number;
  basePosition: V3;
  hull: DesignerHull;
  terrain: TerrainField | null;
  weights: Required<CostWeights>;
  maxShips: number;
  /** Fixed altitude (all-low / all-max-reach) or null for the mixed ladder. */
  fixedAltitudeM: number | null;
  altitudeMode: AltitudeMode;
  manualAltitudeM?: number | null;
  candidateDirs: V3[];
  repair: boolean;
  /** Minimum ground spacing between slots (hard floor already applied). */
  minSpacingM: number;
}

function solveLayout(options: SolveOptions): Layout {
  const { planet, cells, k, rangeM, hopM, basePosition, hull, terrain, weights, maxShips } = options;
  const ladder = options.fixedAltitudeM !== null
    ? [Math.max(MIN_STATION_ALTITUDE_M + 1, Math.round(options.fixedAltitudeM))]
    : altitudeLadderM(planet, rangeM, RIDGE_LADDER_M);

  // Cost of one ship at each candidate altitude (once, not per direction).
  const costByAltitude = new Map<number, ReturnType<typeof slotCostAt> | null>();
  for (const altitudeM of ladder) {
    try {
      costByAltitude.set(altitudeM, slotCostAt({ planet, hull, altitudeM, rangeM, weights }));
    } catch {
      costByAltitude.set(altitudeM, null);
    }
  }

  const candidates: Layout['candidates'] = [];
  for (const dir of options.candidateDirs) {
    for (const altitudeM of ladder) {
      const radio = footprintAngle(planet.surfaceRadiusM, planet.surfaceRadiusM + altitudeM, rangeM);
      if (!(radio > 0)) continue;
      const horizon = Math.acos(Math.max(-1, Math.min(1, planet.surfaceRadiusM / (planet.surfaceRadiusM + altitudeM))));
      const phi = Math.min(radio, horizon);
      const cosPhi = Math.cos(phi);
      const list: number[] = [];
      for (let i = 0; i < cells.length; i += 1) {
        if (dot(dir, cells[i]!.dir) >= cosPhi) list.push(i);
      }
      if (list.length === 0) continue;
      const detail = costByAltitude.get(altitudeM) ?? null;
      candidates.push({
        dir,
        altitudeM,
        position: add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM)),
        list,
        cost: detail ? Math.max(0.05, detail.total) : 1,
        costDetail: detail,
      });
    }
  }

  const counts = new Array<number>(cells.length).fill(0);
  const selectedIndices: number[] = [];
  const selectedPositions: V3[] = [];
  const used = new Set<number>();
  let covered = 0;
  const total = cells.length;
  const minSpacingM = options.minSpacingM;

  const baseReach = hopM;
  /** How many nodes already in the network this candidate could reach directly. */
  const connectionCount = (position: V3): number => {
    let count = dist(position, basePosition) <= baseReach + 0.5 ? 1 : 0;
    for (const other of selectedPositions) {
      if (dist(position, other) <= baseReach + 0.5) count += 1;
    }
    return count;
  };

  interface Pick {
    index: number;
    /** True when this pick broke the spacing rule because nothing else could cover. */
    relaxed: boolean;
    /** Nearest-neighbour ground distance at this pick, metres. */
    nearestM: number;
  }

  /**
   * Best still-unused candidate that adds coverage. With `allowCloser` false
   * the 0.5 x radio spacing rule is a hard filter; with it true only the 8 km
   * same-altitude floor applies (the spacing rule is relaxed, never the floor).
   */
  const pickBest = (allowCloser: boolean): Pick | null => {
    let bestIndex = -1;
    let bestScore = -Infinity;
    let bestGain = 0;
    let bestCost = Infinity;
    let bestConnections = 0;
    let bestSpread = -Infinity;
    for (let c = 0; c < candidates.length; c += 1) {
      if (used.has(c)) continue;
      const candidate = candidates[c]!;
      let gain = 0;
      for (const index of candidate.list) if (counts[index]! < k) gain += 1;
      if (gain <= 0) continue;
      // k=2 is built as a mesh, not a chain with bridges: a new relay must
      // reach at least two existing nodes (or the base plus one), so its second
      // path exists by construction. The first relay only has the base.
      const connections = connectionCount(candidate.position);
      const neededConnections = k === 2 ? Math.min(2, 1 + selectedPositions.length) : 1;
      if (connections < neededConnections) continue;
      // Spacing: ground distance to every already-selected slot.
      let nearestM = Number.POSITIVE_INFINITY;
      for (const index of selectedIndices) {
        const other = candidates[index]!;
        const groundM = groundDistanceM(candidate.dir, other.dir, planet.surfaceRadiusM);
        if (groundM < nearestM) nearestM = groundM;
      }
      // The hard floor is never relaxed: 8 km is the point where two relays
      // stop being two relays. It also stops the same ground position being
      // stacked at two altitudes, which the ladder would otherwise allow.
      if (nearestM < HARD_MIN_SPACING_M - 1e-6) continue;
      if (!allowCloser && nearestM < minSpacingM - 1e-6) continue;
      const score = (gain / candidate.cost)
        // When the rule has to bend, the least-bad pick is the one that keeps
        // the most air: a 0.5..1 multiplier on spacing among relaxed candidates
        // prefers the widest one without letting a tiny gain beat a big one.
        * (allowCloser ? 0.5 + 0.5 * Math.min(1, nearestM / minSpacingM) : 1);
      // Near-equal cost per covered cell is resolved in favour of the CHEAPER
      // ship (lower climb), which is what makes a high H2 weight buy more, lower
      // relays while a high ship weight buys fewer, higher ones.
      const clearlyBetter = bestIndex < 0 || score > bestScore * 1.02;
      const nearTie = bestIndex >= 0 && score >= bestScore * 0.98 && score <= bestScore * 1.02;
      const better = clearlyBetter
        || (nearTie && candidate.cost < bestCost - 1e-9)
        || (nearTie && Math.abs(candidate.cost - bestCost) <= 1e-9 && gain > bestGain)
        || (nearTie && Math.abs(candidate.cost - bestCost) <= 1e-9 && gain === bestGain && connections > bestConnections)
        // Same gain and same links: prefer the one that keeps the most air
        // between itself and its neighbours (the anti-clutter tie-break).
        || (nearTie && Math.abs(candidate.cost - bestCost) <= 1e-9 && gain === bestGain
          && connections === bestConnections && nearestM > bestSpread + 1e-6);
      if (better) {
        bestScore = score;
        bestIndex = c;
        bestGain = gain;
        bestCost = candidate.cost;
        bestConnections = connections;
        bestSpread = nearestM;
      }
    }
    return bestIndex >= 0 ? { index: bestIndex, relaxed: allowCloser, nearestM: bestSpread } : null;
  };

  let spacingRelaxed = false;
  let relaxedNearestM: number | null = null;
  let relaxedAtSlot = 0;

  while (selectedIndices.length < maxShips) {
    // Strict pass first: a spacing-compliant candidate that covers new ground
    // always wins. Only when none exists does the coverage goal outrank the
    // spacing rule for this one slot — and that fact is recorded, not hidden.
    const pick = pickBest(false) ?? pickBest(true);
    if (!pick) break;
    if (pick.relaxed) {
      spacingRelaxed = true;
      relaxedNearestM = relaxedNearestM === null ? pick.nearestM : Math.min(relaxedNearestM, pick.nearestM);
      if (!relaxedAtSlot) relaxedAtSlot = selectedIndices.length + 1;
    }
    used.add(pick.index);
    const chosen = candidates[pick.index]!;
    selectedIndices.push(pick.index);
    selectedPositions.push(chosen.position);
    for (const index of chosen.list) {
      if (counts[index]! < k) {
        counts[index] = counts[index]! + 1;
        if (counts[index] === k) covered += 1;
      }
    }
  }
  const slots = selectedIndices.map((index) => {
    const candidate = candidates[index]!;
    return { dir: candidate.dir, altitudeM: candidate.altitudeM, position: candidate.position };
  });
  // Coverage honesty: if the greedy ran out of candidates below the cap while
  // cells are still short, say so. Spacing may add relays; it may not silently
  // drop coverage, and the floor may leave a cell honest and unreachable.
  const shortfallReason = covered < total && selectedIndices.length < maxShips
    ? `${total - covered} cell(s) stay below k=${k}: every remaining candidate that hears them is closer than the ` +
      `${(HARD_MIN_SPACING_M / 1000).toFixed(0)} km hard floor to a chosen slot`
    : null;

  if (process.env.RTS_COVER_DEBUG === '1') {
    console.info('[cover:debug] selected', slots.length, 'alts', slots.map((s) => s.altitudeM).join(','), 'covered', covered, '/', cells.length);
  }
  const layout: Layout = {
    candidates,
    selected: selectedIndices,
    counts,
    covered,
    slots,
    repaired: [],
    failures: [],
    robust: true,
    spacingRelaxed,
    relaxedNearestM,
    relaxedAtSlot,
    shortfallReason,
  };
  if (k === 2 && options.repair) repairSecondPaths(layout, options);
  layout.covered = layout.counts.reduce((sum, value) => sum + (value >= k ? 1 : 0), 0);
  void total;
  return layout;
}

/** Build the hop graph (base + slots) at 0.9 x radio. */
function hopAdjacency(
  planet: Planet,
  basePosition: V3,
  slots: { id: string; position: V3 }[],
  hopM: number,
): Map<string, Set<string>> {
  const all = [{ id: 'base', position: basePosition }, ...slots];
  const adjacency = new Map<string, Set<string>>(all.map((node) => [node.id, new Set<string>()]));
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (dist(all[i]!.position, all[j]!.position) <= hopM + 0.5) {
        adjacency.get(all[i]!.id)!.add(all[j]!.id);
        adjacency.get(all[j]!.id)!.add(all[i]!.id);
      }
    }
  }
  void planet;
  return adjacency;
}

/**
 * Give every relay a second node-disjoint path to the base by adding explicit
 * bridge slots. A relay that still cannot get one is named in `failures`.
 */
function repairSecondPaths(layout: Layout, options: SolveOptions): void {
  const { planet, basePosition, hopM } = options;
  const idsOf = (): { id: string; position: V3 }[] => [
    ...layout.slots.map((slot, i) => ({ id: `s${i + 1}`, position: slot.position })),
    ...layout.repaired.map((slot, i) => ({ id: `r${i + 1}`, position: slot.position })),
  ];
  const dirOfPosition = (position: V3): V3 => normalize(sub(position, planet.center));
  const groundGap = (a: V3, b: V3): number =>
    groundDistanceM(dirOfPosition(a), dirOfPosition(b), planet.surfaceRadiusM);
  const altitudeOf = (position: V3): number =>
    Math.round(dist(planet.center, position) - planet.surfaceRadiusM);
  /**
   * A bridge may be closer than the 0.5 x radio rule (its whole job is to sit
   * between two nodes), but never closer than the 8 km same-altitude floor:
   * that is the point where it stops being a separate relay at all.
   */
  const floorOk = (nodes: { position: V3 }[], position: V3, altitudeM: number): boolean =>
    nodes.every((node) => {
      const gap = groundGap(position, node.position);
      if (gap < 500) return false;
      return !(altitudeOf(node.position) === altitudeM && gap < HARD_MIN_SPACING_M);
    });
  const nearestGap = (nodes: { position: V3 }[], position: V3): number =>
    nodes.reduce((min, node) => Math.min(min, groundGap(position, node.position)), Number.POSITIVE_INFINITY);
  const slerp = (a: V3, b: V3, t: number): V3 => {
    const d = Math.max(-1, Math.min(1, dot(a, b)));
    const angle = Math.acos(d);
    if (angle < 1e-9) return a;
    const s = Math.sin(angle);
    return normalize(add(scale(a, Math.sin((1 - t) * angle) / s), scale(b, Math.sin(t * angle) / s)));
  };
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const nodes = idsOf();
    const adjacency = hopAdjacency(planet, basePosition, nodes, hopM);
    const pathCount = new Map(nodes.map((node) => [node.id, nodeDisjointPathCount(adjacency, node.id, 'base')]));
    const failing = nodes
      .filter((node) => (pathCount.get(node.id) ?? 0) < 2)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (failing.length === 0) return;
    const victim = failing[0]!;
    const victimNeighbours = adjacency.get(victim.id) ?? new Set<string>();
    // A bridge is only worth placing when it itself has two paths home: it must
    // sit within one hop of the victim AND of two nodes that already have two
    // paths (the base counts). Otherwise each repair would need its own repair.
    const good = [
      { id: 'base', position: basePosition },
      ...nodes.filter((node) => node.id !== victim.id && (pathCount.get(node.id) ?? 0) >= 2),
    ];
    const victimDir = normalize(sub(victim.position, planet.center));
    const victimAltitudeM = Math.round(dist(planet.center, victim.position) - planet.surfaceRadiusM);
    let added: { dir: V3; altitudeM: number; position: V3 } | null = null;
    outer: for (let i = 0; i < good.length; i += 1) {
      for (let j = i + 1; j < good.length; j += 1) {
        const a = good[i]!;
        const b = good[j]!;
        const pairDistance = dist(a.position, b.position);
        if (pairDistance > 2 * hopM) continue;
        const aDir = normalize(sub(a.position, planet.center));
        const bDir = normalize(sub(b.position, planet.center));
        const aAltitudeM = Math.round(dist(planet.center, a.position) - planet.surfaceRadiusM);
        const bAltitudeM = Math.round(dist(planet.center, b.position) - planet.surfaceRadiusM);
        const altitudes = [victimAltitudeM, Math.round((aAltitudeM + bAltitudeM) / 2), aAltitudeM, bAltitudeM];
        for (const altitudeM of altitudes) {
          for (const t of [0.5, 0.35, 0.65, 0.25, 0.75]) {
            const dir = slerp(aDir, bDir, t);
            const position = add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM));
            if (dist(position, victim.position) > hopM + 0.5) continue;
            if (dist(position, a.position) > hopM + 0.5) continue;
            if (dist(position, b.position) > hopM + 0.5) continue;
            if (!floorOk(nodes, position, altitudeM)) continue;
            added = { dir, altitudeM, position };
            break outer;
          }
        }
      }
    }
    if (!added) {
      // Fallback: a relay between the victim and one good node. It fixes the
      // victim now and becomes a candidate for repair on the next pass; the
      // outer loop gives up if the failing set stops shrinking.
      for (const other of good) {
        if (dist(victim.position, other.position) > 2 * hopM) continue;
        const otherDir = normalize(sub(other.position, planet.center));
        const otherAltitudeM = Math.round(dist(planet.center, other.position) - planet.surfaceRadiusM);
        for (const altitudeM of [victimAltitudeM, otherAltitudeM]) {
          for (const t of [0.5, 0.4, 0.6]) {
            const dir = slerp(victimDir, otherDir, t);
            const position = add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM));
            if (dist(position, victim.position) > hopM + 0.5) continue;
            if (dist(position, other.position) > hopM + 0.5) continue;
            if (!floorOk(nodes, position, altitudeM)) continue;
            added = { dir, altitudeM, position };
            break;
          }
          if (added) break;
        }
        if (added) break;
      }
    }
    if (!added) {
      layout.failures.push(victim.id);
      layout.robust = false;
      break;
    }
    // A repair bridge may sit inside the spacing rule (that is what makes it a
    // bridge); when it does, the relaxation is reported, not hidden.
    const bridgeGap = nearestGap(nodes, added.position);
    if (bridgeGap < options.minSpacingM - 1e-6) {
      layout.spacingRelaxed = true;
      layout.relaxedNearestM = layout.relaxedNearestM === null
        ? bridgeGap
        : Math.min(layout.relaxedNearestM, bridgeGap);
    }
    layout.repaired.push(added);
  }
}

function terrainOf(terrain: TerrainField | null | undefined): { status: TerrainStatus; reason: string | null; sampling: { samplesPerPath: number; tiles: number } | null } {
  if (!terrain) return { status: 'none', reason: null, sampling: null };
  if (terrain.status !== 'available') {
    return { status: 'unavailable', reason: terrain.reason ?? 'terrain field is not available', sampling: null };
  }
  return { status: 'corrected', reason: null, sampling: { samplesPerPath: 12, tiles: terrain.tiles } };
}

interface CandidateSet {
  dirs: V3[];
}

function candidateSet(planet: Planet, rangeM: number): CandidateSet {
  const lowAlt = 3_000;
  const phi = Math.min(
    footprintAngle(planet.surfaceRadiusM, planet.surfaceRadiusM + lowAlt, rangeM),
    Math.acos(planet.surfaceRadiusM / (planet.surfaceRadiusM + lowAlt)),
  );
  const solid = phi > 0 ? 2 * Math.PI * (1 - Math.cos(phi)) : 0;
  const estimate = solid > 0 ? Math.ceil((4 * Math.PI) / solid) : 64;
  const wanted = Math.max(128, Math.min(480, Math.ceil(estimate * 2.5)));
  return { dirs: fibonacci(wanted) };
}

export function solveCoverGoal(input: CoverGoalInput): CoverGoalPlan {
  const { planet, k, rangeMargin } = input;
  const cellDeg = Math.max(2, Math.min(30, input.cellDeg));
  const rangeM = input.hull.radioRangeM ?? 0;
  const margin = Math.max(0.5, Math.min(1, rangeMargin || 0.9));
  /** Effective coverage range: the hardware range with the safety margin applied. */
  const coverRangeM = rangeM * margin;
  const hopM = rangeM * HOP_FACTOR;
  const baseDirection = input.baseDirection ? normalize(input.baseDirection) : v3(0, 1, 0);
  const baseAltitudeM = input.baseAltitudeM ?? 1_800;
  const basePosition = add(planet.center, scale(baseDirection, planet.surfaceRadiusM + baseAltitudeM));
  const terrain = input.terrain ?? null;
  const weights = normaliseCostWeights(input.costWeights);
  const target: CoverTarget = input.target ?? { kind: 'whole' };
  const cells = coverGoalCells(planet, cellDeg, target);
  const reasons: string[] = [];
  const labels = ['SIMULATED', 'COVERAGE-FIRST', 'AUTO-COUNT'];
  if (terrain?.status === 'available') labels.push('TERRAIN-CORRECTED');
  else if (terrain) labels.push('TERRAIN-UNAVAILABLE');

  if (!(rangeM > 0)) {
    return {
      planet: planet.name,
      k,
      cellDeg,
      target: target.kind,
      altitudeMode: input.altitudeMode,
      slots: [],
      cells: cells.map((cell) => ({ latDeg: cell.latDeg, lonDeg: cell.lonDeg, coveredBy: 0, byTier: {}, k })),
      counts: { coveredK1: 0, coveredK2: 0 },
      coveredCells: 0,
      totalCells: cells.length,
      coveragePct: 0,
      uncoveredPct: 100,
      countNeeded: 0,
      countUsed: 0,
      requestedCount: input.count ?? null,
      surplus: [],
      achievedK: k,
      relaysWithoutSecondPath: [],
      disjointPathPairs: [],
      alternatives: [],
      links: [],
      maxGapM: 0,
      connectedToBase: false,
      spofs: [],
      spacingRuleM: 0,
      minSpacingM: 0,
      meanSpacingM: 0,
      minChordSpacingM: 0,
      bunching: false,
      spacingRelaxed: false,
      spacingRelaxedReason: null,
      overlapMetric: { sum: 0, mean: 0, maxPerCell: 0 },
      totals: { h2L: 0, batteryMWh: 0, antennaMW: 0, cost: 0 },
      terrain: terrainOf(terrain).status,
      terrainReason: terrainOf(terrain).reason,
      sampling: terrainOf(terrain).sampling,
      reasons: [
        `hull ${input.hull.name} has no radio antenna: a coverage plan cannot use it`,
      ],
      labels: ['SIMULATED', 'INFEASIBLE'],
    };
  }

  const requestCount = typeof input.count === 'number' && Number.isFinite(input.count) ? Math.max(0, Math.round(input.count)) : null;
  const hardCap = input.maxSlots ?? 120;
  const candidates = candidateSet(planet, coverRangeM).dirs;
  // The 0.5 x radio spacing rule, on the GROUND. It uses the hardware range,
  // not the coverage margin: spacing is a physical fact about two ships, not a
  // link-quality margin, and `spacingReport`/`bunching` measure the same thing.
  const spacingRuleM = Math.max(
    HARD_MIN_SPACING_M,
    typeof input.minSpacingM === 'number' && Number.isFinite(input.minSpacingM) && input.minSpacingM > 0
      ? input.minSpacingM
      : rangeM * SPACING_RULE_FACTOR,
  );

  const solveOpts = (fixedAltitudeM: number | null, maxShips: number, repair: boolean): SolveOptions => ({
    planet,
    cells,
    k,
    rangeM: coverRangeM,
    hopM,
    basePosition,
    hull: input.hull,
    terrain,
    weights,
    maxShips,
    fixedAltitudeM,
    altitudeMode: input.altitudeMode,
    manualAltitudeM: input.manualAltitudeM,
    candidateDirs: candidates,
    repair,
    minSpacingM: spacingRuleM,
  });

  // 1. How many ships does the goal actually need, at the requested mode?
  let fixedAltitudeM: number | null = null;
  if (input.altitudeMode === 'manual') {
    fixedAltitudeM = Math.max(MIN_STATION_ALTITUDE_M + 1, Math.round(input.manualAltitudeM ?? bestFlatAltitudeM(planet, rangeM)));
  } else if (input.altitudeMode === 'max-reach') {
    fixedAltitudeM = bestFlatAltitudeM(planet, rangeM);
  }
  const neededLayout = solveLayout(solveOpts(fixedAltitudeM, hardCap, k === 2));
  const countNeeded = neededLayout.slots.length + neededLayout.repaired.length;

  // 2. The layout we actually return.
  const capped = requestCount !== null && requestCount < countNeeded;
  const layout = capped
    ? solveLayout(solveOpts(fixedAltitudeM, Math.max(0, requestCount), false))
    : neededLayout;
  const surplusCount = requestCount !== null && requestCount > countNeeded ? requestCount - countNeeded : 0;

  // 3. Per-slot altitude: the mixed mode refines each coverage slot to the
  // LOWEST ladder height that still covers the cells it is assigned. The
  // layout's own altitude is the starting point; positions move with it so the
  // reported slot and the reported cell counts cannot disagree.
  const layoutSlots = [
    ...layout.slots.map((slot, index) => ({ ...slot, id: `s${index + 1}`, role: 'coverage' as const })),
    ...layout.repaired.map((slot, index) => ({ ...slot, id: `r${index + 1}`, role: 'redundancy' as const })),
  ];
  const contributors = contributorMap(planet, cells, layoutSlots, rangeM, k);
  const refinedSlots =
    input.altitudeMode === 'cheapest'
      ? refineSlotAltitudes({
          planet,
          hull: input.hull,
          cells,
          slots: layoutSlots,
          contributors,
          rangeM,
          terrain,
          weights,
          k,
          basePosition,
          hopM,
        })
      : layoutSlots;
  // Guard: a cheaper rung that cannot hold its assigned cells drops coverage
  // (refinement falls back to partial cover rather than refusing). Coverage is
  // the goal here, so a lossy refinement is rejected wholesale and reported.
  let finalSlots = refinedSlots;
  if (refinedSlots !== layoutSlots) {
    const before = coverageCellsForNodes(planet, cells, layoutSlots.map((slot) => ({ id: slot.id, position: slot.position })), coverRangeM, k, terrain, true);
    const after = coverageCellsForNodes(planet, cells, refinedSlots.map((slot) => ({ id: slot.id, position: slot.position })), coverRangeM, k, terrain, true);
    if (after.coveredCells < before.coveredCells) {
      reasons.push(
        `kept the layout heights: the cheaper rungs would have lost ${before.coveredCells - after.coveredCells} ` +
          `cell(s) of k=${k} coverage`,
      );
      finalSlots = layoutSlots;
    }
  }
  const finalContributors = contributorMap(planet, cells, finalSlots, rangeM, k);

  // Longest link per slot (used as the tuned-radius floor).
  const linkMap = new Map<string, { to: string; distanceM: number }[]>(finalSlots.map((slot) => [slot.id, []]));
  const linkRows: { a: string; b: string; lengthM: number }[] = [];
  for (let i = 0; i < finalSlots.length; i += 1) {
    for (let j = i + 1; j < finalSlots.length; j += 1) {
      const distanceM = dist(finalSlots[i]!.position, finalSlots[j]!.position);
      if (distanceM <= hopM + 0.5) {
        linkMap.get(finalSlots[i]!.id)!.push({ to: finalSlots[j]!.id, distanceM });
        linkMap.get(finalSlots[j]!.id)!.push({ to: finalSlots[i]!.id, distanceM });
        linkRows.push({ a: finalSlots[i]!.id, b: finalSlots[j]!.id, lengthM: Math.round(distanceM * 10) / 10 });
      }
    }
    const baseDistance = dist(finalSlots[i]!.position, basePosition);
    if (baseDistance <= hopM + 0.5) {
      linkMap.get(finalSlots[i]!.id)!.push({ to: 'base', distanceM: baseDistance });
    }
  }
  const slotRecords: CoverGoalSlot[] = finalSlots.map((slot) => {
    const ll = latLonOf(slot.dir);
    const own = [...(finalContributors.get(slot.id) ?? [])].map((index) => ({
      latDeg: cells[index]!.latDeg,
      lonDeg: cells[index]!.lonDeg,
    }));
    const tuned = tuneSlotRadio({
      planet,
      hull: input.hull,
      slotId: slot.id,
      position: slot.position,
      coveredCells: own,
      links: linkMap.get(slot.id) ?? [],
    });
    const relief = reliefAround(planet, terrain, slot.dir);
    const footprintRadiusM = Math.round(groundFootprintRadiusM(planet, slot.altitudeM, rangeM));
    const altitudeReason = altitudeReasonFor({
      mode: input.altitudeMode,
      altitudeM: slot.altitudeM,
      footprintRadiusM,
      rangeM,
      relief,
      role: slot.role,
      cellsCovered: own.length,
    });
    return {
      id: slot.id,
      latDeg: ll.latDeg,
      lonDeg: ll.lonDeg,
      altitudeM: slot.altitudeM,
      position: slot.position,
      role: slot.role,
      altitudeReason,
      footprintRadiusM,
      footprintPct: round(groundFootprintFraction(planet, slot.altitudeM, rangeM) * 100, 2),
      radioRadiusM: tuned.radioRadiusM,
      antennaMW: tuned.antennaMW,
      radioSavedMW: tuned.savedMW,
      antennaReason: tuned.reason,
      cellsCovered: own.length,
    };
  });

  // 4. Final coverage from the actual slots (terrain-corrected where possible).
  const coverage = coverageCellsForNodes(
    planet,
    cells,
    slotRecords.map((slot) => ({ id: slot.id, position: slot.position })),
    coverRangeM,
    k,
    terrain,
    true,
  );
  const counts = { coveredK1: 0, coveredK2: 0 };
  for (const cell of coverage.cells) {
    if (cell.coveredBy >= 1) counts.coveredK1 += 1;
    if (cell.coveredBy >= 2) counts.coveredK2 += 1;
  }
  const coveredK = coverage.coveredCells;
  const coveragePct = coverage.coveragePct;
  const uncoveredPct = cells.length ? round(((cells.length - coveredK) / cells.length) * 100, 1) : 0;

  // 4b. Spacing and overlap accounting, measured on the FINAL slot set.
  //     Ground distance is the spacing a user can see; the chord minimum is
  //     what `spacingReport` reports, so both are published.
  const spacingStats = slotSpacingStats(planet, finalSlots);
  const bunching = slotRecords.length > 1 && spacingStats.minSpacingM < spacingRuleM - 1e-6;
  const relaxedPick = layout.spacingRelaxed || bunching;
  const relaxedWhere = layout.relaxedAtSlot > 0
    ? ` at slot ${layout.relaxedAtSlot}`
    : layout.spacingRelaxed
      ? ' on a redundancy bridge'
      : '';
  const spacingRelaxedReason = relaxedPick
    ? `spacing rule relaxed${relaxedWhere}: the nearest neighbour is ` +
      `${(Math.min(spacingStats.minSpacingM, layout.relaxedNearestM ?? Number.POSITIVE_INFINITY) / 1000).toFixed(1)} km, ` +
      `under the ${(spacingRuleM / 1000).toFixed(1)} km rule (0.5 x ${(rangeM / 1000).toFixed(0)} km radio); ` +
      `coverage took priority over the rule and the 8 km same-altitude floor held`
    : null;
  // Overlap: how many relays beyond k hear each target cell. k is required
  // (the radios must talk); anything above k is clutter.
  const overlapSum = coverage.cells.reduce((sum, cell) => sum + Math.max(0, cell.coveredBy - k), 0);
  const overlapMetric = {
    sum: overlapSum,
    mean: cells.length ? round(overlapSum / cells.length, 3) : 0,
    maxPerCell: coverage.cells.reduce((max, cell) => Math.max(max, Math.max(0, cell.coveredBy - k)), 0),
  };
  if (spacingRelaxedReason) reasons.push(spacingRelaxedReason);
  if (layout.shortfallReason && coveredK < cells.length) reasons.push(layout.shortfallReason);
  if (layout.slots.length + layout.repaired.length >= hardCap && coveredK < cells.length) {
    reasons.push(
      `${cells.length - coveredK} cell(s) stay uncovered: the plan is at the ${hardCap}-ship cap, ` +
        `so the spacing rule cannot be traded for more relays here`,
    );
  }

  // 5. Real redundancy accounting (node-disjoint paths to the base).
  const disjointPairs: { relayId: string; paths: number }[] = [];
  const adjacency = hopAdjacency(planet, basePosition, slotRecords.map((slot) => ({ id: slot.id, position: slot.position })), hopM);
  for (const slot of slotRecords) {
    disjointPairs.push({ relayId: slot.id, paths: nodeDisjointPathCount(adjacency, slot.id, 'base') });
  }
  const relaysWithoutSecondPath = disjointPairs.filter((entry) => entry.paths < 2).map((entry) => entry.relayId);
  const achievedK: 1 | 2 = k === 2 && relaysWithoutSecondPath.length === 0 && counts.coveredK2 === cells.length ? 2 : 1;
  if (k === 2 && achievedK === 1) {
    if (relaysWithoutSecondPath.length) {
      reasons.push(`${relaysWithoutSecondPath.length} relay(s) have only one node-disjoint path to the base: ${relaysWithoutSecondPath.join(', ')}`);
    }
    if (counts.coveredK2 < cells.length) {
      reasons.push(`${cells.length - counts.coveredK2} cell(s) are heard by fewer than 2 relays`);
    }
  }
  const spofs = [...adjacency.entries()]
    .filter(([id, neighbours]) => id !== 'base' && neighbours.size === 0)
    .map(([id]) => id);

  // 6. Alternatives: all-low, all-max-reach, best mixed — each one real solve.
  const alternatives: CoverAlternative[] = [];
  const circle = labels.includes('TERRAIN-CORRECTED');
  const alternativeSpecs: { id: CoverAlternative['id']; label: string; altitudeM: number | null; note: string }[] = [
    {
      id: 'all-low',
      label: 'all-low',
      altitudeM: altitudeLadderM(planet, rangeM, [])[0] ?? 3_000,
      note: 'every relay low and cheap to reach; the horizon limits each footprint, so it needs the most ships',
    },
    {
      id: 'all-max-reach',
      label: 'all-max-reach',
      altitudeM: bestFlatAltitudeM(planet, rangeM),
      note: 'every relay at the footprint peak; fewest ships, but the climb needs hydrogen or ion',
    },
  ];
  for (const spec of alternativeSpecs) {
    const alt = spec.altitudeM;
    const solved = alt === null ? null : solveLayout(solveOpts(alt, hardCap, false));
    if (!solved || alt === null) continue;
    const result = coverageCellsForNodes(
      planet,
      cells,
      solved.slots.map((slot, index) => ({ id: `a${index + 1}`, position: slot.position })),
      coverRangeM,
      k,
      terrain,
      true,
    );
    const totals = sumTotals(solved.slots, input.hull, planet, rangeM, weights);
    alternatives.push({
      id: spec.id,
      label: spec.label,
      ships: solved.slots.length,
      h2L: totals.h2L,
      batteryMWh: totals.batteryMWh,
      antennaMW: totals.antennaMW,
      coveragePct: result.coveragePct,
      terrain: coverage.terrain,
      altitudeRangeM: [alt, alt],
      cost: totals.cost,
      note: spec.note,
    });
  }
  const mixedTotals = sumTotals(layout.slots, input.hull, planet, rangeM, weights);
  alternatives.push({
    id: 'best-mixed',
    label: `best-mixed (${input.altitudeMode})`,
    ships: layout.slots.length,
    h2L: mixedTotals.h2L,
    batteryMWh: mixedTotals.batteryMWh,
    antennaMW: mixedTotals.antennaMW,
    coveragePct,
    terrain: coverage.terrain,
    altitudeRangeM: [
      Math.min(...slotRecords.map((slot) => slot.altitudeM)),
      Math.max(...slotRecords.map((slot) => slot.altitudeM)),
    ],
    cost: mixedTotals.cost,
    note: 'the layout this plan uses: each slot own height for its own terrain',
  });
  void circle;

  const totals = sumTotals(slotRecords, input.hull, planet, rangeM, weights);
  const hopLinks = linkRows;
  const maxGapM = hopLinks.reduce((max, link) => Math.max(max, link.lengthM), 0);
  const connectedToBase = slotRecords.every((slot) => disjointPairs.find((entry) => entry.relayId === slot.id)!.paths >= 1);
  const surplus = Array.from({ length: surplusCount }, (_, i) => ({
    id: `surplus-${i + 1}`,
    reason: `the goal needs ${countNeeded} ship(s); this one stays put (you asked for ${requestCount})`,
  }));

  if (target.kind !== 'whole') {
    reasons.push(`coverage target is ${target.kind === 'hemisphere' ? 'the hemisphere facing the base' : `${Math.round((target.radiusM ?? 0) / 1000)} km around the base`}: ${cells.length} cell(s)`);
  }
  if (input.altitudeMode === 'cheapest') {
    reasons.push(
      `CHEAPEST cost weights: ship ${weights.ship}, H2 ${weights.h2PerL}/L, battery ${weights.batteryPerMWh}/MWh, power ${weights.mw}/MW`,
    );
  }
  if (coverage.terrain === 'unavailable') {
    reasons.push(`terrain is unavailable for ${planet.name}: coverage is the smooth-sphere footprint (${coverage.terrainReason})`);
  }

  return {
    planet: planet.name,
    k,
    cellDeg,
    target: target.kind,
    altitudeMode: input.altitudeMode,
    slots: slotRecords,
    cells: coverage.cells,
    counts,
    coveredCells: coveredK,
    totalCells: cells.length,
    coveragePct,
    uncoveredPct,
    countNeeded,
    countUsed: slotRecords.length,
    requestedCount: requestCount,
    surplus,
    achievedK,
    relaysWithoutSecondPath,
    disjointPathPairs: disjointPairs,
    alternatives,
    links: hopLinks,
    maxGapM: Math.round(maxGapM * 10) / 10,
    connectedToBase,
    spofs,
    spacingRuleM,
    minSpacingM: spacingStats.minSpacingM,
    meanSpacingM: spacingStats.meanSpacingM,
    minChordSpacingM: spacingStats.minChordSpacingM,
    bunching,
    spacingRelaxed: relaxedPick,
    spacingRelaxedReason,
    overlapMetric,
    totals,
    terrain: coverage.terrain,
    terrainReason: coverage.terrainReason,
    sampling: coverage.sampling,
    reasons,
    labels,
  };
}

function kindOfMode(mode: AltitudeMode): AltitudeMode {
  return mode;
}

function sumTotals(
  slots: { altitudeM: number }[],
  hull: DesignerHull,
  planet: Planet,
  rangeM: number,
  weights: Required<CostWeights>,
): { h2L: number; batteryMWh: number; antennaMW: number; cost: number } {
  let h2L = 0;
  let batteryMWh = 0;
  let antennaMW = 0;
  let cost = 0;
  const cache = new Map<number, ReturnType<typeof slotCostAt>>();
  for (const slot of slots) {
    let detail = cache.get(slot.altitudeM);
    if (!detail) {
      detail = slotCostAt({ planet, hull, altitudeM: slot.altitudeM, rangeM, weights });
      cache.set(slot.altitudeM, detail);
    }
    h2L += detail.h2L ?? 0;
    batteryMWh += detail.batteryMWh ?? 0;
    antennaMW += detail.antennaMW;
    cost += detail.total;
  }
  return {
    h2L: round(h2L, 1),
    batteryMWh: round(batteryMWh, 3),
    antennaMW: round(antennaMW, 3),
    cost: round(cost, 2),
  };
}

/** Exported for tests: the default ladder used by the alternatives block. */
export const COVER_ALTITUDE_LADDER_M = [...RIDGE_LADDER_M];

/** Which cells each slot currently provides (the first k coverers win). */
function contributorMap(
  planet: Planet,
  cells: CoverageCellPoint[],
  slots: { id: string; dir: V3; altitudeM: number; position: V3 }[],
  rangeM: number,
  k: 1 | 2,
): Map<string, Set<number>> {
  const contributors = new Map<string, Set<number>>(slots.map((slot) => [slot.id, new Set<number>()]));
  const counts = new Array<number>(cells.length).fill(0);
  for (const slot of slots) {
    const phi = Math.min(
      footprintAngle(planet.surfaceRadiusM, planet.surfaceRadiusM + slot.altitudeM, rangeM),
      Math.acos(Math.max(-1, Math.min(1, planet.surfaceRadiusM / (planet.surfaceRadiusM + slot.altitudeM)))),
    );
    const cosPhi = Math.cos(phi);
    for (let i = 0; i < cells.length; i += 1) {
      if (dot(slot.dir, cells[i]!.dir) < cosPhi) continue;
      if (counts[i]! < k) {
        counts[i] = counts[i]! + 1;
        contributors.get(slot.id)!.add(i);
      }
    }
  }
  return contributors;
}

/**
 * CHEAPEST per-slot height: the lowest ladder rung that still covers every
 * cell the slot is assigned (terrain-tested), never breaking its base path.
 */
function refineSlotAltitudes(args: {
  planet: Planet;
  hull: DesignerHull;
  cells: CoverageCellPoint[];
  slots: { id: string; dir: V3; altitudeM: number; position: V3; role: 'coverage' | 'redundancy' }[];
  contributors: Map<string, Set<number>>;
  rangeM: number;
  terrain: TerrainField | null;
  weights: Required<CostWeights>;
  k: 1 | 2;
  basePosition: V3;
  hopM: number;
}): typeof args.slots {
  const { planet, hull, cells, contributors, rangeM, terrain } = args;
  const ladder = altitudeLadderM(planet, rangeM, RIDGE_LADDER_M);
  const original = args.slots.map((slot) => ({ ...slot }));
  const out = args.slots.map((slot) => ({ ...slot }));
  /** The assigned hull must be able to fly to and hold at this height. */
  const reachableCache = new Map<number, boolean>();
  const reachableAt = (altitudeM: number): boolean => {
    const cached = reachableCache.get(altitudeM);
    if (cached !== undefined) return cached;
    const adapted = hullForDesigner(hull);
    const report = adapted.hull
      ? evaluateHullAtSlot({ hull: adapted.hull, planet, altitudeM, transitDistanceM: Math.round(Math.min(rangeM, 10_000)) })
      : null;
    const ok = report ? report.canReachSlot && report.reservePct >= 10 : false;
    reachableCache.set(altitudeM, ok);
    return ok;
  };
  // The highest rung the hull can actually reach from its own budget: a scarcer
  // H2 budget lowers this, so CHEAPEST buys more, lower relays instead of
  // silently claiming a height the ship cannot get to.
  let reachFloor = ladder[0]!;
  for (const altitudeM of ladder) if (reachableAt(altitudeM)) reachFloor = altitudeM;
  for (const slot of out) {
    if (slot.role !== 'coverage') continue;
    const assigned = [...(contributors.get(slot.id) ?? [])];
    if (assigned.length === 0) continue;
    const l = ladder;
    // Rung order: the hull's cheapest rung first, then the ladder ascending.
    // A cheap-but-unreachable rung loses to the next reachable one.
    const cheapest = l.reduce((bestAlt, alt) => {
      const a = slotCostAt({ planet, hull, altitudeM: alt, rangeM, weights: args.weights });
      const b = slotCostAt({ planet, hull, altitudeM: bestAlt, rangeM, weights: args.weights });
      return a.total < b.total - 1e-9 ? alt : bestAlt;
    }, Math.max(reachFloor, l[0]!));
    let best: typeof slot | null = null;
    let bestCount = -1;
    for (const altitudeM of [cheapest, ...l.filter((alt) => alt >= reachFloor)]) {
      // A hull with no atmospheric thrust cannot climb through the air: the
      // slot keeps the layout height instead of inventing a low station.
      const canAtmo = (hull.thrust.atmo ?? 0) > 0;
      const canH2 = (hull.thrust.h2 ?? 0) > 0;
      const canIon = (hull.thrust.ion ?? 0) > 0;
      // The assigned hull must be able to climb and hold at the height: atmo
      // thrust works low, ion above the air, H2 anywhere it has tanks.
      if (altitudeM <= 10_000 && !canAtmo && !canH2) continue;
      if (altitudeM > 10_000 && !canH2 && !canIon) continue;
      const position = add(planet.center, scale(slot.dir, planet.surfaceRadiusM + altitudeM));
      const subset = assigned.map((index) => cells[index]!);
      const result = coverageCellsForNodes(planet, subset, [{ id: slot.id, position }], rangeM, 1, terrain, true);
      if (result.coveredCells >= assigned.length) {
        // Prefer a height the hull can actually reach and hold, but never
        // trade away coverage for reachability.
        const reachable = reachableAt(altitudeM);
        if (best === null || reachable || bestCount < assigned.length) {
          best = { ...slot, altitudeM, position };
          bestCount = result.coveredCells;
        }
        if (reachable) break; // ladder is ascending: the first full, reachable cover wins
        continue;
      }
      if (result.coveredCells > bestCount) {
        bestCount = result.coveredCells;
        best = { ...slot, altitudeM, position };
      }
    }
    if (best) {
      slot.altitudeM = best.altitudeM;
      slot.position = best.position;
    }
  }
  // Connectivity guard: a cheaper height must not break the path home.
  for (let pass = 0; pass < 2; pass += 1) {
    const adjacency = hopAdjacency(planet, args.basePosition, out.map((slot) => ({ id: slot.id, position: slot.position })), args.hopM);
    let changed = false;
    out.forEach((slot, index) => {
      const need = args.k === 2 ? 2 : 1;
      if (nodeDisjointPathCount(adjacency, slot.id, 'base') >= need) return;
      slot.altitudeM = original[index]!.altitudeM;
      slot.position = original[index]!.position;
      changed = true;
    });
    if (!changed) break;
  }
  void args.weights;
  return out;
}

/** Plain words for a slot's chosen height. */
function altitudeReasonFor(args: {
  mode: AltitudeMode;
  altitudeM: number;
  footprintRadiusM: number;
  rangeM: number;
  relief: { reliefM: number; bearing: string } | null;
  role: 'coverage' | 'redundancy';
  cellsCovered: number;
}): string {
  const km = (args.altitudeM / 1000).toFixed(1);
  const reachKm = (args.footprintRadiusM / 1000).toFixed(1);
  if (args.role === 'redundancy') {
    return `redundancy bridge at ${km} km: it gives a neighbour a second node-disjoint path to the base`;
  }
  const ridge = args.relief
    ? `${args.relief.bearing} ridge ${(args.relief.reliefM / 1000).toFixed(1)} km high`
    : null;
  if (ridge && args.altitudeM > 10_000) {
    return `${ridge} blocks the low path: raised to ${km} km to clear it (${args.cellsCovered} cell(s), ${reachKm} km ground reach)`;
  }
  if (args.altitudeM <= 10_000) {
    return `low basin: ${km} km in atmosphere${ridge ? `, below the ${ridge}` : ''}; radio ${reachKm} km, ` +
      `${args.cellsCovered} cell(s), an atmospheric hull can reach and station it`;
  }
  if (args.mode === 'max-reach') {
    return `open ground: ${km} km maximises the ground footprint (${reachKm} km, ${args.cellsCovered} cell(s))`;
  }
  return `${km} km is the cheapest height that still covers its ${args.cellsCovered} cell(s) ` +
    `(radio ${reachKm} km${ridge ? `, ${ridge} cleared` : ''})`;
}
