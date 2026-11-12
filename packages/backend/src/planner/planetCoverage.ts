/**
 * Whole-planet coverage planner (T28).
 *
 * For one or more relay layers it computes a small relay set that covers the
 * surface, using the curvature-corrected footprint of a node at height h with
 * radio range R (law of cosines, not the flat `sqrt(R^2 - h^2)` approximation;
 * both are reported). Selection is a deterministic greedy set cover over a
 * lat/long grid, so the output doubles as a heatmap: every cell carries how
 * many planned sky nodes see it.
 *
 * Additions that matter for a real network:
 *   * the base is part of the link graph; components that do not reach it get
 *     bridge nodes along the great circle until every station is linked with
 *     hops <= `0.9 * radio`;
 *   * k=2 asks for two independent sky nodes per cell, not one;
 *   * cells no sky node reaches become rover-laser fallback spots (T28).
 *
 * Terrain is modelled when a `TerrainField` is supplied (T49) **and the medium
 * needs line of sight**. Radio does not (measured 2026-11-10, see
 * `mediumRules.ts`): with the measured rule a cell behind a ridge is covered as
 * long as it is in range, and terrain is only reported as a counterfactual.
 * Set `radioRule: 'range+los'` (or `RTS_RADIO_LOS=1`) to get the old, pessimistic
 * behaviour back; `laser` stays LOS either way.
 */
import type { Planet } from '@se-rts/schemas';
import { add, dist, dot, normalize, scale, sub, v3, type V3 } from './geometry.js';
import { MEDIUM_RULES, radioRuleFromEnv, type RadioRule } from './mediumRules.js';
import type { TerrainField } from './terrainField.js';

export type CoverageTierId = 'atmo' | 'station' | 'h2' | 'zero-g';

/** Terrain provenance of a coverage grid: never conflate corrected and smooth. */
export type TerrainStatus = 'corrected' | 'unavailable' | 'none';

/** Samples along one relay -> cell slant path. */
export const TERRAIN_SAMPLES_PER_PATH = 12;
/** Below this many metres of clearance the path counts as blocked. */
const TERRAIN_TOLERANCE_M = 0.5;

export interface CoverageTierSpec {
  id: CoverageTierId;
  /** Node altitude AGL, metres. */
  altitudeM: number;
  /** Node radio range, metres (measured profile, not a guess). */
  radioRangeM: number;
}

export interface CoverageNode {
  id: string;
  position: V3;
  altitudeM: number;
  latDeg: number;
  lonDeg: number;
  role: 'coverage' | 'bridge';
}

export interface CoverageCell {
  latDeg: number;
  lonDeg: number;
  /** Number of sky nodes (all tiers) that can see this cell through terrain. */
  coveredBy: number;
  /** Per-tier visible-node counts (terrain-corrected when terrain is active). */
  byTier: Partial<Record<CoverageTierId, number>>;
  /** The threshold this grid was counted against. */
  k?: 1 | 2;
  /** Relay whose path clears the terrain with the most margin; null when uncovered. */
  bestRelayId?: string | null;
  /** True when terrain blocked a path the smooth footprint counted as covering. */
  blockedByTerrain?: boolean;
  /** Smooth-sphere count before terrain correction (equal to coveredBy without terrain). */
  geometricCoveredBy?: number;
}

export interface CoverageTierResult {
  id: CoverageTierId;
  altitudeM: number;
  radioRangeM: number;
  rangeMargin: number;
  /** Flat approximation sqrt(R^2 - h^2), metres (reported for comparison). */
  flatFootprintRadiusM: number;
  /** Curvature-corrected ground footprint radius R * phi, metres. */
  footprintRadiusM: number;
  /** Ground half-angle of the footprint, degrees. */
  footprintAngleDeg: number;
  count: number;
  bridgeCount: number;
  nodes: CoverageNode[];
  coveragePct: number;
  coveredCells: number;
  totalCells: number;
  /** Articulation points in the node+base link graph, slot ids. */
  spofs: string[];
  connectedToBase: boolean;
  links: { a: string; b: string; lengthM: number }[];
  maxGapM: number;
  warnings: string[];
  reasons: string[];
  /** Cells this tier covers on the smooth sphere (before terrain). */
  geometricCoveredCells: number;
  /** Cells the active radio rule removed from this tier's footprint (0 without terrain). */
  terrainBlockedCells: number;
  /** Radio obstruction rule this tier was counted with. */
  radioRule: RadioRule;
  /**
   * Counterfactual: cells the smooth footprint covers that terrain would block
   * if radio needed LOS. Only present when `counterfactual` was requested.
   */
  losCounterfactualBlockedCells?: number;
}

export interface RoverSpot {
  latDeg: number;
  lonDeg: number;
  position: V3;
  altitudeM: number;
  reason: string;
}

export interface PlanetCoveragePlan {
  planet: string;
  k: 1 | 2;
  cellDeg: number;
  surfaceRadiusM: number;
  base: { position: V3; altitudeM: number };
  tiers: CoverageTierResult[];
  /** Tier the planner recommends (lowest count that still links to the base). */
  recommendedTier: CoverageTierId | null;
  recommendation: string;
  cells: CoverageCell[];
  uncoveredCells: number;
  /** Cells no sky node in any tier reaches (union coverage). */
  uncoveredPct: number;
  rovers: RoverSpot[];
  roverFallback: boolean;
  labels: string[];
  reasons: string[];
  createdAt: number;
  /** Where the cell counts came from: terrain-corrected, unavailable, or not requested. */
  terrain: TerrainStatus;
  terrainReason: string | null;
  /** Radio obstruction rule the cells were counted with ('range' by default). */
  radioRule: RadioRule;
  /** Laser obstruction rule (always 'los'). */
  laserRule: 'los';
  /** Cells terrain removed from the union of all tiers (0 when radio is range-only). */
  terrainBlockedCells: number;
  /** Counterfactual union count when `counterfactual` was requested. */
  losCounterfactualBlockedCells?: number;
  /** How the terrain test was run (null when terrain was not used). */
  sampling: { samplesPerPath: number; tiles: number } | null;
}

export interface PlanetCoverageOptions {
  k?: 1 | 2;
  /** Heatmap cell size in degrees (default 10, minimum 2). */
  cellDeg?: number;
  rangeMargin?: number;
  /** Maximum hop for station-to-station / station-to-base links (default 45 km). */
  maxHopM?: number;
  baseAltitudeM?: number;
  baseDirection?: V3;
  /** Add rover-laser fallback spots where no sky node reaches (default true). */
  roverFallback?: boolean;
  /** Cap the greedy selection (default 400 nodes per tier). */
  maxNodesPerTier?: number;
  now?: number;
  /** Terrain field for the slant-path test; null/undefined leaves the smooth sphere. */
  terrain?: TerrainField | null;
  /**
   * Radio obstruction rule. Defaults to the measured rule (`MEDIUM_RULES.radio`
   * = 'range', or 'range+los' when `RTS_RADIO_LOS=1`). 'range+los' reproduces
   * the pre-2026-11-10 model so the two can be compared.
   */
  radioRule?: RadioRule;
  /**
   * Also report what terrain would block *if* radio needed LOS. Costs one full
   * terrain pass, so it is off by default.
   */
  counterfactual?: boolean;
  /** Set false to silence the one-line timing log (default true). */
  timing?: boolean;
}

const DEFAULT_BASE_ALTITUDE_M = 1_800;
const DEFAULT_MAX_HOP_M = 45_000;

function unitDir(planet: Planet, direction?: V3): V3 {
  const raw = direction ? sub(direction, planet.center) : v3(0, 1, 0);
  const unit = normalize(raw);
  return Math.hypot(unit.x, unit.y, unit.z) > 0 ? unit : v3(0, 1, 0);
}

function latLonOf(dir: V3): { latDeg: number; lonDeg: number } {
  return {
    latDeg: Math.round((Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI * 10) / 10,
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

/** Ground half-angle a node at `nodeRadius` covers with range `rangeM`. */
export function footprintAngle(surfaceRadiusM: number, nodeRadiusM: number, rangeM: number): number {
  if (rangeM <= 0 || nodeRadiusM <= surfaceRadiusM) return 0;
  const cosPhi =
    (nodeRadiusM * nodeRadiusM + surfaceRadiusM * surfaceRadiusM - rangeM * rangeM) /
    (2 * nodeRadiusM * surfaceRadiusM);
  if (cosPhi >= 1) return 0;
  if (cosPhi <= -1) return Math.PI;
  return Math.acos(cosPhi);
}

function slerp(a: V3, b: V3, t: number): V3 {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  const angle = Math.acos(d);
  if (angle < 1e-9) return a;
  const s = Math.sin(angle);
  return normalize(add(scale(a, Math.sin((1 - t) * angle) / s), scale(b, Math.sin(t * angle) / s)));
}

/** Structured lat/long cells; deterministic order (lat asc, lon asc). */
export function buildCells(cellDeg: number): { latDeg: number; lonDeg: number; dir: V3 }[] {
  const step = Math.max(2, cellDeg);
  const out: { latDeg: number; lonDeg: number; dir: V3 }[] = [];
  for (let lat = -90 + step / 2; lat < 90; lat += step) {
    for (let lon = -180 + step / 2; lon < 180; lon += step) {
      const latR = (lat * Math.PI) / 180;
      const lonR = (lon * Math.PI) / 180;
      out.push({
        latDeg: Math.round(lat * 10) / 10,
        lonDeg: Math.round(lon * 10) / 10,
        dir: v3(Math.cos(latR) * Math.cos(lonR), Math.sin(latR), Math.cos(latR) * Math.sin(lonR)),
      });
    }
  }
  return out;
}

interface CellPoint {
  latDeg: number;
  lonDeg: number;
  dir: V3;
}

/** A cell centre as the coverage core wants it (exported for the placement planner). */
export type CoverageCellPoint = CellPoint;

/**
 * Cell centres are pure geometry, so they are computed once per
 * (planet, cellDeg) and reused by every plan and every heatmap request.
 * Bounded so a long-lived process cannot accumulate grids.
 */
const CELL_CACHE_LIMIT = 24;
const cellCache = new Map<string, CellPoint[]>();

function cellsFor(planet: Planet, cellDeg: number): CellPoint[] {
  const key = `${planet.id ?? planet.name}:${cellDeg}`;
  const cached = cellCache.get(key);
  if (cached) {
    cellCache.delete(key);
    cellCache.set(key, cached);
    return cached;
  }
  const cells = buildCells(cellDeg);
  cellCache.set(key, cells);
  while (cellCache.size > CELL_CACHE_LIMIT) {
    const oldest = cellCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cellCache.delete(oldest);
  }
  return cells;
}

/** Grid cell centres for a planet (cached); exported for the placement planner. */
export function coverageCellsFor(planet: Planet, cellDeg: number): CoverageCellPoint[] {
  return cellsFor(planet, Math.max(2, Math.min(30, cellDeg)));
}

interface NodeCap {
  id: string;
  dir: V3;
  radius: number;
  cosPhi: number;
  phi: number;
}

/** Visible-capability of one relay at one range (shared by both grid paths). */
function capsFor(
  planet: Planet,
  nodes: { id: string; position: V3 }[],
  rangeM: number,
  horizonLimited = false,
): NodeCap[] {
  return nodes.map((node) => {
    const radius = dist(planet.center, node.position);
    const radio = footprintAngle(planet.surfaceRadiusM, radius, rangeM);
    // T52: a cell below the relay's horizon is never seen, whatever the radio
    // range says. `horizonLimited` is opt-in so the legacy smooth-sphere
    // numbers stay comparable.
    const horizon = horizonLimited && radius > planet.surfaceRadiusM
      ? Math.acos(Math.max(-1, Math.min(1, planet.surfaceRadiusM / radius)))
      : Math.PI;
    const phi = Math.min(radio, horizon);
    return {
      id: node.id,
      dir: normalize(sub(node.position, planet.center)),
      radius,
      cosPhi: Math.cos(phi),
      phi,
    };
  });
}

/**
 * Worst clearance (metres) of the straight 3D slant path from a relay to a
 * cell over the terrain: min over ~12 samples of (path radius - terrain
 * radius). Negative means the path passes below the drawn surface.
 *
 * Only terrain that rises above `MinimumSurfaceRadius` counts as a terrain
 * feature. The smooth footprint already ignores the planet horizon (a low relay
 * beyond ~14 km on EarthLike is over-credited by the T28 model); that known
 * optimism is NOT relabelled as terrain here, otherwise a perfectly flat field
 * would disagree with the smooth plan. A sample on the smooth sphere is
 * therefore skipped; a ridge or hill is not.
 */
function pathClearance(
  planet: Planet,
  field: TerrainField,
  nodeDir: V3,
  nodeRadius: number,
  cellDir: V3,
  cellRadius: number,
): number {
  const sx = nodeDir.x * nodeRadius;
  const sy = nodeDir.y * nodeRadius;
  const sz = nodeDir.z * nodeRadius;
  const ex = cellDir.x * cellRadius;
  const ey = cellDir.y * cellRadius;
  const ez = cellDir.z * cellRadius;
  let worst = Number.POSITIVE_INFINITY;
  for (let i = 1; i <= TERRAIN_SAMPLES_PER_PATH; i += 1) {
    const t = i / TERRAIN_SAMPLES_PER_PATH;
    const px = sx + (ex - sx) * t;
    const py = sy + (ey - sy) * t;
    const pz = sz + (ez - sz) * t;
    const r = Math.hypot(px, py, pz);
    if (!(r > 0)) continue;
    const terrain = field.radiusAt(v3(px / r, py / r, pz / r)) ?? planet.surfaceRadiusM;
    if (terrain <= planet.surfaceRadiusM + TERRAIN_TOLERANCE_M) continue; // smooth sphere, not terrain
    const clearance = r - terrain;
    if (clearance < worst) worst = clearance;
    if (worst < -TERRAIN_TOLERANCE_M) return worst; // already blocked: stop sampling
  }
  return worst;
}

interface TerrainCellCounts {
  count: number[];
  geometric: number[];
  bestRelayId: (string | null)[];
  bestClearance: number[];
  blocked: boolean[];
}

/**
 * Count visible relays per cell through terrain. The terrain radii of the cell
 * centres are computed once, not per relay.
 */
function terrainCellCounts(
  planet: Planet,
  cells: CellPoint[],
  caps: NodeCap[],
  field: TerrainField,
): TerrainCellCounts {
  const n = cells.length;
  const count = new Array<number>(n).fill(0);
  const geometric = new Array<number>(n).fill(0);
  const bestRelayId = new Array<string | null>(n).fill(null);
  const bestClearance = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  const blockedFlag = new Array<boolean>(n).fill(false);
  const cellRadius = cells.map((cell) => field.radiusAt(cell.dir) ?? planet.surfaceRadiusM);
  for (const cap of caps) {
    if (cap.phi <= 0) continue;
    for (let i = 0; i < n; i += 1) {
      const cell = cells[i]!;
      if (dot(cap.dir, cell.dir) < cap.cosPhi) continue;
      geometric[i] = geometric[i]! + 1;
      const clearance = pathClearance(planet, field, cap.dir, cap.radius, cell.dir, cellRadius[i]!);
      if (clearance >= -TERRAIN_TOLERANCE_M) {
        count[i] = count[i]! + 1;
        if (clearance > bestClearance[i]!) {
          bestClearance[i] = clearance;
          bestRelayId[i] = cap.id;
        }
      } else {
        blockedFlag[i] = true;
      }
    }
  }
  return { count, geometric, bestRelayId, bestClearance, blocked: blockedFlag };
}

function tierSelect(
  planet: Planet,
  spec: CoverageTierSpec,
  cells: CellPoint[],
  k: 1 | 2,
  rangeM: number,
  maxNodes: number,
): { nodeDirs: V3[]; counts: number[]; warnings: string[]; reasons: string[] } {
  const surface = planet.surfaceRadiusM;
  const nodeRadius = surface + spec.altitudeM;
  const phi = footprintAngle(surface, nodeRadius, rangeM);
  const warnings: string[] = [];
  const reasons: string[] = [];
  if (phi <= 0) {
    reasons.push(
      `a ${(spec.radioRangeM / 1000).toFixed(0)} km radio at ${(spec.altitudeM / 1000).toFixed(0)} km altitude has an empty ground footprint`,
    );
    return { nodeDirs: [], counts: new Array(cells.length).fill(0), warnings, reasons };
  }
  const solid = 2 * Math.PI * (1 - Math.cos(phi));
  const estimate = solid > 0 ? Math.ceil((4 * Math.PI) / solid) : cells.length;
  const candidateCount = Math.max(64, Math.min(4000, Math.ceil(estimate * 3)));
  const candidates = fibonacci(candidateCount).map((dir) => ({
    dir,
    cosPhi: Math.cos(phi),
  }));

  const counts = new Array<number>(cells.length).fill(0);
  const lists: number[][] = candidates.map((candidate) => {
    const list: number[] = [];
    for (let i = 0; i < cells.length; i += 1) {
      if (dot(candidate.dir, cells[i]!.dir) >= candidate.cosPhi) list.push(i);
    }
    return list;
  });

  const selected: number[] = [];
  const used = new Set<number>();
  let covered = 0;
  for (const count of counts) if (count >= k) covered += 1;
  while (covered < cells.length && selected.length < maxNodes) {
    let best = -1;
    let bestGain = 0;
    for (let c = 0; c < lists.length; c += 1) {
      if (used.has(c)) continue;
      let gain = 0;
      for (const index of lists[c]!) if (counts[index]! < k) gain += 1;
      if (gain > bestGain) {
        bestGain = gain;
        best = c;
      }
    }
    if (best < 0 || bestGain === 0) break;
    used.add(best);
    selected.push(best);
    for (const index of lists[best]!) {
      if (counts[index]! < k) {
        counts[index] = counts[index]! + 1;
        if (counts[index] === k) covered += 1;
      }
    }
  }
  if (covered < cells.length) {
    reasons.push(
      `${cells.length - covered} cell(s) are still below k=${k} after ${selected.length} node(s)`,
    );
  }
  if (selected.length >= maxNodes) warnings.push(`node selection hit the cap of ${maxNodes}`);
  return { nodeDirs: selected.map((c) => candidates[c]!.dir), counts, warnings, reasons };
}

/**
 * Add bridge nodes so every selected coverage node reaches the base with hops
 * of at most `hopLimit`. Returns the bridges plus the final node list.
 */
function bridgeToBase(
  planet: Planet,
  baseDir: V3,
  basePosition: V3,
  tierId: CoverageTierId,
  altitudeM: number,
  coverageDirs: V3[],
  hopLimitM: number,
): CoverageNode[] {
  const surface = planet.surfaceRadiusM;
  const radius = surface + altitudeM;
  const nodes: CoverageNode[] = coverageDirs.map((dir, index) => {
    const ll = latLonOf(dir);
    return {
      id: `${tierId}-${index + 1}`,
      position: add(planet.center, scale(dir, radius)),
      altitudeM,
      latDeg: ll.latDeg,
      lonDeg: ll.lonDeg,
      role: 'coverage',
    };
  });

  const bridges: CoverageNode[] = [];
  // Components over coverage nodes, then attach each component to the base.
  // A bridge chain is built in one pass: walking the orphan toward the base in
  // hop-sized steps, so the next pass does not pick the same orphan again.
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 128) break;
    const all = [...nodes, ...bridges];
    const adjacency = new Map<string, Set<string>>();
    for (const node of all) adjacency.set(node.id, new Set());
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        if (dist(all[i]!.position, all[j]!.position) <= hopLimitM + 0.5) {
          adjacency.get(all[i]!.id)!.add(all[j]!.id);
          adjacency.get(all[j]!.id)!.add(all[i]!.id);
        }
      }
    }
    const baseLinkedIds = new Set<string>();
    for (const node of all) {
      if (dist(node.position, basePosition) <= hopLimitM + 0.5) baseLinkedIds.add(node.id);
    }
    const seen = new Set<string>(baseLinkedIds);
    const queue = [...baseLinkedIds];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    const orphan = all.find((node) => !seen.has(node.id));
    if (!orphan) break;
    let cursorDir = normalize(sub(orphan.position, planet.center));
    let placedAny = false;
    for (let step = 0; step < 256; step += 1) {
      const totalAngle = Math.acos(Math.max(-1, Math.min(1, dot(cursorDir, baseDir))));
      const stepAngle = hopLimitM / radius;
      if (totalAngle <= stepAngle * 0.5) break; // the last hop reaches the base
      const dir = slerp(cursorDir, baseDir, Math.min(1, stepAngle / totalAngle));
      const position = add(planet.center, scale(dir, radius));
      const ll = latLonOf(dir);
      bridges.push({
        id: `${tierId}-bridge-${bridges.length + 1}`,
        position,
        altitudeM,
        latDeg: ll.latDeg,
        lonDeg: ll.lonDeg,
        role: 'bridge',
      });
      cursorDir = dir;
      placedAny = true;
      if (dist(position, basePosition) <= hopLimitM + 0.5) break;
    }
    if (!placedAny) break;
  }
  return [...nodes, ...bridges];
}

function graphOf(
  nodes: CoverageNode[],
  basePosition: V3,
  hopLimitM: number,
): { links: { a: string; b: string; lengthM: number }[]; connectedToBase: boolean; spofs: string[]; maxGapM: number } {
  const ids = ['base', ...nodes.map((node) => node.id)];
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const positions = new Map<string, V3>(
    [['base', basePosition] as [string, V3], ...nodes.map((node) => [node.id, node.position] as [string, V3])],
  );
  const links: { a: string; b: string; lengthM: number }[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const lengthM = dist(positions.get(ids[i]!)!, positions.get(ids[j]!)!);
      if (lengthM <= hopLimitM + 0.5) {
        adjacency.get(ids[i]!)!.add(ids[j]!);
        adjacency.get(ids[j]!)!.add(ids[i]!);
        links.push({ a: ids[i]!, b: ids[j]!, lengthM: Math.round(lengthM * 10) / 10 });
      }
    }
  }
  const seen = new Set<string>(['base']);
  const queue = ['base'];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  // Tarjan articulation points (same semantics as the constellation graph).
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
  for (const id of ids) {
    if (disc.has(id)) continue;
    parent.set(id, null);
    visit(id);
  }
  const maxGapM = links.reduce((max, link) => Math.max(max, link.lengthM), 0);
  return {
    links,
    connectedToBase: nodes.every((node) => seen.has(node.id)),
    spofs: [...points].filter((id) => id !== 'base').sort(),
    maxGapM: Math.round(maxGapM * 10) / 10,
  };
}

export interface CoverageGrid {
  cellDeg: number;
  k: 1 | 2;
  cells: CoverageCell[];
  coveredCells: number;
  totalCells: number;
  coveragePct: number;
  /** Smooth-sphere covered cells before terrain (equal when terrain is off). */
  geometricCoveredCells: number;
  /** Uncovered cells the active radio rule removed (0 when radio is range-only). */
  blockedCells: number;
  terrain: TerrainStatus;
  terrainReason: string | null;
  /** Radio rule the grid was counted with. */
  radioRule: RadioRule;
  /** What terrain would have blocked under the old LOS rule, when requested. */
  blockedCellsIfLos?: number;
  sampling: { samplesPerPath: number; tiles: number } | null;
}

function terrainStatusOf(field: TerrainField | null | undefined): {
  status: TerrainStatus;
  reason: string | null;
} {
  if (!field) return { status: 'none', reason: null };
  if (field.status !== 'available') {
    return { status: 'unavailable', reason: field.reason ?? 'terrain field is not available' };
  }
  return { status: 'corrected', reason: null };
}

export interface CellCoverageResult {
  cells: CoverageCell[];
  coveredCells: number;
  totalCells: number;
  coveragePct: number;
  geometricCoveredCells: number;
  blockedCells: number;
  terrain: TerrainStatus;
  terrainReason: string | null;
  /** Radio rule these cells were counted with. */
  radioRule: RadioRule;
  /** Counterfactual blocked count when `counterfactual` is on. */
  blockedCellsIfLos?: number;
  sampling: { samplesPerPath: number; tiles: number } | null;
}

/**
 * Core: count coverage for an explicit cell set and node set, with or without
 * terrain. `rangeM` is already the effective range (callers apply the margin).
 * Exported so the cell-driven placement planner reports numbers with exactly
 * the same slant-path test the heatmap uses.
 *
 * `radioRule` decides whether the slant path is tested at all. With the measured
 * rule ('range') a cell behind a ridge is covered when it is in range — the
 * game does not consult terrain for radio — so the terrain field is used only
 * for the `blockedCellsIfLos` counterfactual.
 */
export function coverageCellsForNodes(
  planet: Planet,
  cells: CellPoint[],
  nodes: { id: string; position: V3 }[],
  rangeM: number,
  k: 1 | 2,
  terrainInput: TerrainField | null | undefined,
  horizonLimited = false,
  radioRule: RadioRule = radioRuleFromEnv(),
  counterfactual = false,
): CellCoverageResult {
  const caps = capsFor(planet, nodes, rangeM, horizonLimited);
  const terrain = terrainStatusOf(terrainInput);
  const field = terrain.status === 'corrected' ? (terrainInput as TerrainField) : null;
  const useTerrain = field !== null && radioRule === 'range+los';

  if (useTerrain && field) {
    const corrected = terrainCellCounts(planet, cells, caps, field);
    let covered = 0;
    let geometricCovered = 0;
    let blockedCells = 0;
    const out: CoverageCell[] = cells.map((cell, i) => {
      const count = corrected.count[i]!;
      const geometric = corrected.geometric[i]!;
      if (count >= k) covered += 1;
      if (geometric >= k) geometricCovered += 1;
      const blocked = corrected.blocked[i]! && count < k;
      if (blocked) blockedCells += 1;
      return {
        latDeg: cell.latDeg,
        lonDeg: cell.lonDeg,
        coveredBy: count,
        byTier: {},
        k,
        bestRelayId: corrected.bestRelayId[i] ?? null,
        blockedByTerrain: blocked,
        geometricCoveredBy: geometric,
      };
    });
    return {
      cells: out,
      coveredCells: covered,
      totalCells: cells.length,
      coveragePct: cells.length ? Math.round((covered / cells.length) * 1000) / 10 : 0,
      geometricCoveredCells: geometricCovered,
      blockedCells,
      terrain: terrain.status,
      terrainReason: terrain.reason,
      radioRule,
      sampling: { samplesPerPath: TERRAIN_SAMPLES_PER_PATH, tiles: field.tiles },
    };
  }

  let covered = 0;
  const out: CoverageCell[] = cells.map((cell) => {
    let count = 0;
    let bestId: string | null = null;
    for (const cap of caps) {
      if (cap.phi > 0 && dot(cap.dir, cell.dir) >= cap.cosPhi) {
        count += 1;
        if (bestId === null) bestId = cap.id;
      }
    }
    if (count >= k) covered += 1;
    return {
      latDeg: cell.latDeg,
      lonDeg: cell.lonDeg,
      coveredBy: count,
      byTier: {},
      k,
      bestRelayId: bestId,
      blockedByTerrain: false,
      geometricCoveredBy: count,
    };
  });
  // Counterfactual: what the old LOS rule would have removed. Same cells, same
  // nodes, one extra terrain pass — never mixed into `coveredCells`.
  let blockedCellsIfLos: number | undefined;
  if (counterfactual && field) {
    const test = terrainCellCounts(planet, cells, caps, field);
    blockedCellsIfLos = test.blocked.filter((blocked, i) => blocked && test.count[i]! < k).length;
  }
  return {
    cells: out,
    coveredCells: covered,
    totalCells: cells.length,
    coveragePct: cells.length ? Math.round((covered / cells.length) * 1000) / 10 : 0,
    geometricCoveredCells: covered,
    blockedCells: 0,
    terrain: terrain.status,
    terrainReason: terrain.reason,
    radioRule,
    ...(blockedCellsIfLos === undefined ? {} : { blockedCellsIfLos }),
    sampling: null,
  };
}

/** Cells covered by an explicit set of nodes (used by radio-chain/layered views). */
export function coverageGridFromNodes(
  planet: Planet,
  nodes: { id: string; position: V3; altitudeM: number }[],
  rangeM: number,
  options: {
    k?: 1 | 2;
    cellDeg?: number;
    rangeMargin?: number;
    terrain?: TerrainField | null;
    radioRule?: RadioRule;
  } = {},
): CoverageGrid {
  const k = options.k ?? 1;
  const cellDeg = Math.max(2, Math.min(30, options.cellDeg ?? 10));
  const margin = options.rangeMargin ?? 0.9;
  const result = coverageCellsForNodes(
    planet,
    cellsFor(planet, cellDeg),
    nodes,
    rangeM * margin,
    k,
    options.terrain,
    false,
    options.radioRule ?? radioRuleFromEnv(),
  );
  return { cellDeg, k, ...result };
}


/**
 * Plan surface coverage for every requested tier and return the heatmap grid.
 * Tiers are independent (each gets its own minimum relay set); the union of
 * their footprints decides which cells need a rover fallback.
 */
export function planPlanetCoverage(
  planet: Planet,
  tierSpecs: CoverageTierSpec[],
  options: PlanetCoverageOptions = {},
): PlanetCoveragePlan {
  const startedAt = Date.now();
  const k = options.k ?? 1;
  const margin = options.rangeMargin ?? 0.9;
  const cellDeg = Math.max(2, Math.min(30, options.cellDeg ?? 10));
  const maxHop = options.maxHopM ?? DEFAULT_MAX_HOP_M;
  const baseAltitudeM = options.baseAltitudeM ?? DEFAULT_BASE_ALTITUDE_M;
  const baseDir = unitDir(planet, options.baseDirection);
  const basePosition = add(planet.center, scale(baseDir, planet.surfaceRadiusM + baseAltitudeM));
  const cells = cellsFor(planet, cellDeg);
  const hopLimitM = Math.min(maxHop, Math.max(...tierSpecs.map((t) => t.radioRangeM), 0) * margin);
  const terrain = terrainStatusOf(options.terrain);
  const field = terrain.status === 'corrected' ? (options.terrain as TerrainField) : null;
  const radioRule = options.radioRule ?? radioRuleFromEnv();
  // Terrain only decides cells when the medium needs LOS (radio does not).
  const useTerrain = field !== null && radioRule === 'range+los';
  const counterfactual = Boolean(options.counterfactual) && field !== null && radioRule === 'range';
  const reasons: string[] = [];
  const aggregate = cells.map(() => ({
    coveredBy: 0,
    geometricCoveredBy: 0,
    bestRelayId: null as string | null,
    bestClearance: Number.NEGATIVE_INFINITY,
    blocked: false,
    byTier: {} as Partial<Record<CoverageTierId, number>>,
  }));
  const tiers: CoverageTierResult[] = [];

  const seen = new Set<CoverageTierId>();
  for (const spec of tierSpecs) {
    if (seen.has(spec.id)) reasons.push(`duplicate tier ${spec.id} ignored`);
    seen.add(spec.id);
    // T28 footprint uses the measured radio range; the safety margin applies to
    // node-to-node hops, not to the coverage footprint.
    const rangeM = spec.radioRangeM;
    const nodeRadius = planet.surfaceRadiusM + spec.altitudeM;
    const phi = footprintAngle(planet.surfaceRadiusM, nodeRadius, rangeM);
    const selected = tierSelect(planet, spec, cells, k, rangeM, options.maxNodesPerTier ?? 400);
    const nodes = bridgeToBase(planet, baseDir, basePosition, spec.id, spec.altitudeM, selected.nodeDirs, hopLimitM);
    const graph = graphOf(nodes, basePosition, hopLimitM);
    // Terrain (T49): recount this tier's coverage over the actual slant paths.
    // The relay set itself was chosen on the smooth footprint, so a corrected
    // count can only be lower; that is reported, never hidden.
    const coverageNodes = nodes.filter((node) => node.role === 'coverage');
    const caps = capsFor(planet, coverageNodes, rangeM);
    const corrected = useTerrain ? terrainCellCounts(planet, cells, caps, field as TerrainField) : null;
    // Counterfactual (radio range-only only): what terrain would have blocked.
    const asIfLos = counterfactual ? terrainCellCounts(planet, cells, caps, field as TerrainField) : null;
    let coveredCells = 0;
    let geometricCoveredCells = 0;
    let terrainBlockedCells = 0;
    let losCounterfactualBlockedCells: number | undefined;
    for (let i = 0; i < cells.length; i += 1) {
      const count = corrected ? corrected.count[i]! : (selected.counts[i] ?? 0);
      const geometric = selected.counts[i] ?? 0;
      if (count >= k) coveredCells += 1;
      if (geometric >= k) geometricCoveredCells += 1;
      const blocked = Boolean(corrected?.blocked[i]) && count < k;
      if (blocked) terrainBlockedCells += 1;
      aggregate[i]!.coveredBy += count;
      aggregate[i]!.geometricCoveredBy += geometric;
      aggregate[i]!.byTier[spec.id] = count;
      if (blocked) aggregate[i]!.blocked = true;
      if (corrected) {
        const clearance = corrected.bestClearance[i]!;
        if (corrected.bestRelayId[i] !== null && clearance > aggregate[i]!.bestClearance) {
          aggregate[i]!.bestRelayId = corrected.bestRelayId[i] ?? null;
          aggregate[i]!.bestClearance = clearance;
        }
      } else if (aggregate[i]!.bestRelayId === null && geometric > 0) {
        const first = coverageNodes.find((node) => {
          const radius = dist(planet.center, node.position);
          const angle = footprintAngle(planet.surfaceRadiusM, radius, rangeM);
          return dot(normalize(sub(node.position, planet.center)), cells[i]!.dir) >= Math.cos(angle);
        });
        aggregate[i]!.bestRelayId = first?.id ?? null;
      }
    }
    const coveragePct = cells.length ? Math.round((coveredCells / cells.length) * 1000) / 10 : 0;
    if (asIfLos) {
      losCounterfactualBlockedCells = 0;
      for (let i = 0; i < cells.length; i += 1) {
        if (asIfLos.blocked[i] && asIfLos.count[i]! < k) losCounterfactualBlockedCells += 1;
      }
    }
    const warnings = [...selected.warnings];
    if (nodes.length === 0) warnings.push('no node in this tier: the footprint is empty or the cap was hit');
    if (!graph.connectedToBase) warnings.push('not every node reaches the base within the hop limit');
    if (spec.altitudeM >= planet.surfaceRadiusM + spec.radioRangeM) {
      warnings.push('altitude is at or above the radio range: the footprint is empty');
    }
    if (terrainBlockedCells > 0) {
      warnings.push(
        `${terrainBlockedCells} cell(s) are inside the smooth footprint but blocked by terrain; the relay set is geometric, so add a relay or a rover there`,
      );
    }
    if (losCounterfactualBlockedCells !== undefined && losCounterfactualBlockedCells > 0) {
      warnings.push(
        `radio is range-limited only, so ${losCounterfactualBlockedCells} cell(s) behind terrain are still covered; they would need a laser (LOS) if radio were blocked`,
      );
    }
    tiers.push({
      id: spec.id,
      altitudeM: spec.altitudeM,
      radioRangeM: spec.radioRangeM,
      rangeMargin: margin,
      flatFootprintRadiusM: Math.round(Math.sqrt(Math.max(0, rangeM * rangeM - spec.altitudeM * spec.altitudeM))),
      footprintRadiusM: Math.round(planet.surfaceRadiusM * phi),
      footprintAngleDeg: Math.round(((phi * 180) / Math.PI) * 10) / 10,
      count: coverageNodes.length,
      bridgeCount: nodes.filter((node) => node.role === 'bridge').length,
      nodes,
      coveragePct,
      coveredCells,
      totalCells: cells.length,
      spofs: graph.spofs,
      connectedToBase: graph.connectedToBase,
      links: graph.links,
      maxGapM: graph.maxGapM,
      warnings,
      reasons: selected.reasons,
      geometricCoveredCells,
      terrainBlockedCells,
      radioRule,
      ...(losCounterfactualBlockedCells === undefined ? {} : { losCounterfactualBlockedCells }),
    });
  }
  for (const tier of tiers) reasons.push(...tier.reasons.map((r) => `${tier.id}: ${r}`));

  const coveredCells = aggregate.filter((cell) => cell.coveredBy >= 1).length;
  const uncoveredCells = cells.length - coveredCells;
  const terrainBlockedCells = aggregate.filter((cell) => cell.blocked && cell.coveredBy === 0).length;
  const rovers: RoverSpot[] = [];
  const roverFallback = options.roverFallback ?? true;
  if (roverFallback && uncoveredCells > 0) {
    const buckets = new Set<string>();
    for (let i = 0; i < cells.length && rovers.length < 24; i += 1) {
      if (aggregate[i]!.coveredBy > 0) continue;
      const cell = cells[i]!;
      const bucket = `${Math.floor((cell.latDeg + 90) / 20)}:${Math.floor((cell.lonDeg + 180) / 20)}`;
      if (buckets.has(bucket)) continue;
      buckets.add(bucket);
      rovers.push({
        latDeg: cell.latDeg,
        lonDeg: cell.lonDeg,
        position: add(planet.center, scale(cell.dir, planet.surfaceRadiusM)),
        altitudeM: 0,
        reason: aggregate[i]!.blocked
          ? 'terrain blocks every sky path to this cell: place a ground laser rover here with line of sight to a relay'
          : 'no sky node reaches this cell: place a ground laser rover here and aim it at a sky node with line of sight',
      });
    }
  }

  const ordered = ['station', 'atmo', 'h2', 'zero-g'] as CoverageTierId[];
  const ranked = [...tiers].sort((a, b) => {
    const ia = ordered.indexOf(a.id);
    const ib = ordered.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.count - b.count;
  });
  const recommended = ranked.find((tier) => tier.connectedToBase && tier.coveragePct > 0) ?? ranked[0] ?? null;
  const recommendation = recommended
    ? `${recommended.id} layer at ${(recommended.altitudeM / 1000).toFixed(0)} km covers ${recommended.coveragePct.toFixed(1)} % with ${recommended.count} relay(s)` +
      (recommended.bridgeCount ? ` plus ${recommended.bridgeCount} bridge(s)` : '') +
      (recommended.count > 0 ? `; ${recommended.count} ship(s)` : '')
    : 'no tier yields a usable footprint';

  const labels = ['SIMULATED', 'COVERAGE-GEOMETRY', roverFallback ? 'ROVER-FALLBACK' : 'ROVER-FALLBACK-OFF'];
  labels.push(radioRule === 'range' ? 'RADIO-RANGE-ONLY' : 'RADIO-LOS');
  if (terrain.status === 'corrected') {
    labels.push(useTerrain ? 'TERRAIN-CORRECTED' : 'TERRAIN-NOT-USED-RADIO');
  } else if (terrain.status === 'unavailable') {
    labels.push('TERRAIN-UNAVAILABLE');
  }
  let losCounterfactualBlockedCells: number | undefined;
  if (counterfactual) {
    losCounterfactualBlockedCells = tiers.reduce(
      (sum, tier) => sum + (tier.losCounterfactualBlockedCells ?? 0),
      0,
    );
  }

  const plan: PlanetCoveragePlan = {
    planet: planet.name,
    k,
    cellDeg,
    surfaceRadiusM: planet.surfaceRadiusM,
    base: { position: basePosition, altitudeM: baseAltitudeM },
    tiers: ranked,
    recommendedTier: recommended?.id ?? null,
    recommendation,
    cells: cells.map((cell, i) => ({
      latDeg: cell.latDeg,
      lonDeg: cell.lonDeg,
      coveredBy: aggregate[i]!.coveredBy,
      byTier: aggregate[i]!.byTier,
      k,
      bestRelayId: aggregate[i]!.bestRelayId,
      blockedByTerrain: aggregate[i]!.blocked,
      geometricCoveredBy: aggregate[i]!.geometricCoveredBy,
    })),
    uncoveredCells,
    uncoveredPct: cells.length ? Math.round((uncoveredCells / cells.length) * 1000) / 10 : 0,
    rovers,
    roverFallback,
    labels,
    reasons,
    createdAt: options.now ?? Date.now(),
    terrain: terrain.status,
    terrainReason: terrain.reason,
    radioRule,
    laserRule: MEDIUM_RULES.laser,
    terrainBlockedCells,
    ...(losCounterfactualBlockedCells === undefined ? {} : { losCounterfactualBlockedCells }),
    sampling: useTerrain && field ? { samplesPerPath: TERRAIN_SAMPLES_PER_PATH, tiles: field.tiles } : null,
  };
  if (options.timing !== false) {
    const elapsed = Date.now() - startedAt;
    console.info(
      `[coverage] planet=${planet.name} cellDeg=${cellDeg} k=${k} tiers=${tierSpecs.length} ` +
        `cells=${cells.length} terrain=${terrain.status} ms=${elapsed}`,
    );
  }
  return plan;
}
