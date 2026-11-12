/**
 * T6 constellation / connect planner.
 *
 * Positions, links and coverage are deterministic planner geometry over the
 * measured hull profile, so every option is labelled SIMULATED. Radio range is
 * multiplied by the requested `rangeMargin` before a link is allowed; the
 * margin is reported, not hidden.
 */
import type { Planet } from '@se-rts/schemas';
import { dist, type V3 } from '../../planner/geometry.js';
import { planChain } from '../../planner/chain.js';
import {
  coverageFraction,
  inclinedRingPositions,
  linePositions,
  offsetLinePositions,
  positionGraph,
  ringCountForSpacing,
  ringPositions,
  shellCountForSpacing,
  shellPositions,
  slotRadiusM,
  toSlot,
  twoNodeDisjointPaths,
  chainPositions,
  type Pattern,
  type Redundancy,
  type SlotPosition,
} from './patterns.js';
import { findHull, type DesignerHull } from './hulls.js';
import { buildRelayModeOption } from './modes.js';
import { planSlotPlacement, type SlotPlacement } from './placement.js';
import { buildSlotSpecs, type SlotSpec } from './slotSpec.js';
import { gravityAtAltitude, planetGravity } from './gravity.js';
import { ENDURANCE_ASSUMPTIONS, formatDuration } from '../endurance/index.js';
import { enduranceView, type OptionEndurance } from './enduranceView.js';
export type { OptionEndurance } from './enduranceView.js';
import type { HeteroAssignment } from './hetero.js';
import type { CoverageTierId, TerrainStatus } from '../../planner/planetCoverage.js';
import type { TerrainField } from '../../planner/terrainField.js';
import { groundFootprintRadiusM } from './altitude.js';

export interface DesignerPlanInput {
  mode: 'constellation' | 'connect' | 'radio-chain' | 'layered' | 'cover-planet';
  planet?: string;
  a?: { planet?: string; gps?: { x: number; y: number; z: number } };
  b?: { planet?: string; gps?: { x: number; y: number; z: number } };
  /** Base station for the relay modes; default BASE-01 at 1.8 km AGL. */
  base?: { planet?: string; gps?: { x: number; y: number; z: number }; altitudeM?: number };
  pattern: Pattern;
  altitudeM?: number;
  count?: number;
  spacingM?: number;
  hullId: string;
  /** Hull pool for the heterogeneous assignment; default every available hull. */
  hullIds?: string[];
  rangeMargin: number;
  redundancy: Redundancy;
  /** T16 radio-chain: hop ceiling (default 45 km) and base-link policy. */
  maxHopM?: number;
  keepFirstHopOnBase?: boolean;
  /** T16 radio-chain: horizontal extension at zero-g (metres / degrees). */
  reachM?: number;
  bearingDeg?: number;
  /** T17 layered counts per tier. */
  atmoCount?: number;
  h2Count?: number;
  zeroGCount?: number;
  atmoAltitudeM?: number;
  h2AltitudeM?: number;
  /** T28 cover-planet: redundancy, heatmap cell size, rover fallback. */
  k?: 1 | 2;
  cellDeg?: number;
  roverFallback?: boolean;
  /** T52: how each slot's altitude is chosen (default 'cheapest' for cover goals). */
  altitudeMode?: import('./altitude.js').AltitudeMode;
  /** T52: cost weights for CHEAPEST (ship / H2 / battery / antenna MW). */
  costWeights?: Partial<import('./altitude.js').CostWeights>;
  /** T53: coverage target for cover goals. */
  target?: 'whole' | 'hemisphere' | 'radius';
  targetRadiusM?: number;
  /** T53: minimum ground spacing between slots, metres (default 0.5 x radio). */
  minSpacingM?: number;
  /** T53: grid id / name / planet the hemisphere or radius faces (default the base). */
  facing?: string;
  /** T49: 'none' skips terrain correction (default 'auto'). */
  terrain?: 'auto' | 'none';
  /** Hard cap on new prefab builds in the assignment. */
  maxNewBuilds?: number;
}

export interface DesignerPlanMode {
  constellation: 'constellation';
  connect: 'connect';
  'radio-chain': 'radio-chain';
  layered: 'layered';
  'cover-planet': 'cover-planet';
}

export interface DesignerOption {
  id: string;
  pattern: Pattern | 'radio-chain' | 'layered' | 'cover-planet';
  hullId: string;
  count: number;
  altitudeM: number;
  positions: SlotPosition[];
  links: { a: string; b: string; kind: 'radio' | 'laser'; lengthM: number }[];
  spofs: string[];
  redundancyAchieved: Redundancy;
  coveragePct: number | null;
  maxGapM: number;
  gravityAtSlotMps2: number;
  feasible: boolean;
  reasons: string[];
  summary: string;
  labels: string[];
  /** Propulsion/energy reachability at this slot. */
  endurance: OptionEndurance;
  /** T22 modes: set for radio-chain / layered / cover-planet options. */
  mode?: 'radio-chain' | 'layered' | 'cover-planet';
  base?: { x: number; y: number; z: number; altitudeM: number };
  tiers?: OptionTier[];
  assignment?: HeteroAssignment;
  coverage?: CoverageOptionSummary;
  /** T49: one physical spec per produced slot. */
  slots?: SlotSpec[];
  /** T49: distance between nodes joined on the path back to the base, metres. */
  spacingM?: number[];
  /** Smallest ground distance between two slots, metres (spacing solver). */
  minSpacingM?: number;
  /** The spacing rule the solver enforced (0.5 x radio by default), metres. */
  spacingRuleM?: number;
  /** Mean ground distance over every slot pair, metres. */
  meanSpacingM?: number;
  /** T49: true when two nodes sit closer than 0.5 x radio range. */
  bunching?: boolean;
  /** T53: true when the spacing rule had to be relaxed to keep the coverage goal. */
  spacingRelaxed?: boolean;
  /** T53: plain words for a relaxed spacing rule. */
  spacingRelaxedReason?: string | null;
  /** T53: relays beyond k per target cell — how cluttered the constellation is. */
  overlapMetric?: { sum: number; mean: number; maxPerCell: number };
  /** T49: ships offered but not needed (ring/constellation placement). */
  spareShips?: { id: string; reason: string }[];
  spareReason?: string;
  shipsRequested?: number | null;
  /** T52: the altitude policy the plan used. */
  altitudeMode?: import('./altitude.js').AltitudeMode;
  /** T53: auto count — what the goal needs vs what this plan uses. */
  countNeeded?: number;
  countUsed?: number;
  uncoveredPct?: number;
  /** T53: the coverage-first solve (per-slot altitudes, redundancy, cost). */
  goal?: import('./coverGoal.js').CoverGoalPlan;
  /** T53: all-low / all-max-reach / best-mixed comparison. */
  alternatives?: import('./coverGoal.js').CoverAlternative[];
  /** T49: terrain provenance of the option's coverage numbers. */
  terrain?: TerrainStatus;
  blockedCells?: number;
  /** T53: per-slot height + horizon-limited ground reach (preview readout). */
  slotAltitudes?: { id: string; altitudeM: number; groundRadiusM: number; radioRadiusM: number; role: string }[];
}

export interface OptionTier {
  id: CoverageTierId | 'zero-g' | 'in-gravity';
  altitudeM: number;
  count: number;
  gravityMps2: number;
  /** Station hold is free at this tier (T18); zero-g needs no station. */
  stationFree: boolean;
  radioRangeM: number;
  coveragePct: number;
}

export interface CoverageOptionSummary {
  cellDeg: number;
  recommendedTier: CoverageTierId | null;
  recommendation: string;
  uncoveredCells: number;
  uncoveredPct: number;
  roverSpots: { latDeg: number; lonDeg: number; reason: string }[];
  tiers: {
    id: CoverageTierId;
    altitudeM: number;
    count: number;
    bridgeCount: number;
    coveragePct: number;
    footprintRadiusM: number;
    flatFootprintRadiusM: number;
    connectedToBase: boolean;
    spofs: string[];
  }[];
  /** Heatmap grid: lat/long cell + how many sky nodes see it (all tiers). */
  cells: { latDeg: number; lonDeg: number; coveredBy: number; byTier: Partial<Record<CoverageTierId, number>> }[];
  /** T49: how the counts were produced. */
  terrain: TerrainStatus;
  terrainReason: string | null;
  blockedCells: number;
  geometricCoveragePct: number;
  sampling: { samplesPerPath: number; tiles: number } | null;
}

export interface DesignerPlan {
  id: string;
  mode: DesignerPlanInput['mode'];
  input: DesignerPlanInput;
  hull: DesignerHull;
  planets: { a: string | null; b: string | null };
  options: DesignerOption[];
  assumptions: { id: string; text: string; status: string }[];
  labels: string[];
  createdAt: number;
}

const CONSTELLATION_PATTERNS: Pattern[] = ['ring', 'inclined-rings', 'shell', 'chain'];
const ALT_DEFAULT_M = 60_000;
const ALT_MIN_M = 1_000;
const PLANET_CLEARANCE_M = 500;

function patternLabel(p: Pattern): string {
  return p === 'inclined-rings' ? 'two inclined rings' : p === 'chain' ? 'arc / chain' : p;
}

function labelFor(hull: DesignerHull): string[] {
  const labels = ['SIMULATED'];
  if (hull.source === 'owner-tagged') labels.push('OWNER-TAGGED');
  labels.push('RADIO-UNVERIFIED');
  return labels;
}

function hullRange(hull: DesignerHull, margin: number): number | null {
  if (hull.radioRangeM === null || !(hull.radioRangeM > 0)) return null;
  return hull.radioRangeM * margin;
}

function maxChordM(positions: SlotPosition[]): number {
  if (positions.length < 2) return 0;
  const first = positions[0]!;
  let max = 0;
  for (const p of positions.slice(1)) {
    max = Math.max(max, Math.hypot(p.x - first.x, p.y - first.y, p.z - first.z));
  }
  return max;
}

/** Grow the requested count until the pattern's spacing constraint holds. */
function constellationCount(
  pattern: Pattern,
  planet: Planet,
  altitudeM: number,
  count: number,
  spacingM: number | undefined,
): number {
  if (!spacingM || !(spacingM > 0)) return count;
  if (pattern === 'ring' || pattern === 'chain') {
    return Math.max(count, ringCountForSpacing(planet, altitudeM, spacingM));
  }
  if (pattern === 'inclined-rings') {
    const perRing = Math.max(count / 2, ringCountForSpacing(planet, altitudeM, spacingM));
    return Math.max(2, Math.round(perRing * 2));
  }
  return Math.max(count, shellCountForSpacing(planet, altitudeM, spacingM));
}

function constellationPositions(pattern: Pattern, planet: Planet, altitudeM: number, count: number): V3[] {
  switch (pattern) {
    case 'ring':
      return ringPositions(planet, altitudeM, count, 0);
    case 'inclined-rings':
      return inclinedRingPositions(planet, altitudeM, count, 55);
    case 'shell':
      return shellPositions(planet, altitudeM, count);
    default:
      return chainPositions(planet, altitudeM, count);
  }
}

function redundancyVerdict(
  graph: ReturnType<typeof positionGraph>,
  redundancy: Redundancy,
  mode: 'constellation' | 'connect',
): { achieved: Redundancy; reasons: string[] } {
  const reasons: string[] = [];
  if (!graph.connected) reasons.push('the link graph is not connected at this range/margin');
  const spofs = graph.articulationPoints;
  if (redundancy === 1) {
    if (!graph.connected) return { achieved: 1, reasons };
    return { achieved: 1, reasons: [...reasons, 'single path requested (k=1); SPOFs are expected and reported'] };
  }
  if (mode === 'constellation') {
    if (graph.lowDegree.length) reasons.push(`${graph.lowDegree.length} node(s) have fewer than 2 radio neighbours`);
    if (spofs.length) reasons.push(`${spofs.length} articulation point(s) would split the graph`);
    const achieved: Redundancy = graph.connected && graph.lowDegree.length === 0 && spofs.length === 0 ? (redundancy === 'no-spof' ? 'no-spof' : 2) : 1;
    if (achieved === 1) reasons.push('redundancy fell back to 1: the plan is not 2-connected at this range/margin');
    return { achieved, reasons };
  }
  // Connect: redundancy is verified against an actual second node-disjoint path
  // in `connectOption`, so the strongest claim here is 2 unless no-spof was
  // requested and the graph has no articulation points.
  if (spofs.length) reasons.push(`${spofs.length} articulation point(s) in the routed graph`);
  return { achieved: redundancy === 'no-spof' && spofs.length === 0 ? 'no-spof' : 2, reasons };
}

function constellationOption(
  id: string,
  pattern: Pattern,
  input: DesignerPlanInput,
  planet: Planet,
  hull: DesignerHull,
  range: number | null,
  ownedHulls: DesignerHull[],
  terrain: TerrainField | null,
): DesignerOption {
  const reasons: string[] = [];
  const altitude = Math.max(ALT_MIN_M, Math.round(input.altitudeM ?? ALT_DEFAULT_M));
  let count = Math.max(2, Math.round(input.count ?? 8));
  count = constellationCount(pattern, planet, altitude, count, input.spacingM);
  const requestedCount = count;

  // T49: a single-path ring is a coverage problem, not an even division, so it
  // goes through the cell-driven placement. A redundant ring stays a ring: a
  // set-cover tree cannot be 2-connected, and the redundancy contract wins.
  const placement: SlotPlacement | null =
    pattern === 'ring' && range && input.redundancy === 1
      ? planSlotPlacement({
          planet,
          altitudeM: altitude,
          ships: count,
          radioRangeM: hull.radioRangeM ?? 0,
          rangeMargin: input.rangeMargin,
          cellDeg: input.cellDeg ?? 5,
          k: input.k ?? 1,
          baseDirection: input.base?.gps,
          baseAltitudeM: input.base?.altitudeM,
          terrain,
        })
      : null;
  const usedPlacement = Boolean(
    placement && placement.positions.length >= 2 && placement.coverage.coveredCells > 0,
  );
  const positions = usedPlacement
    ? placement!.positions.map((node) => toSlot(node.id, node.position))
    : constellationPositions(pattern, planet, altitude, count).map((p, i) => toSlot(`s${i + 1}`, p));
  count = positions.length;
  if (usedPlacement && placement) {
    reasons.push(
      `slot positions come from the coverage grid (${placement.slotsUsed} useful of ${requestedCount} offered, ` +
        `${placement.coverage.coveragePct.toFixed(1)} % at k=${placement.coverage.k})`,
    );
    reasons.push(...placement.reasons);
  }
  const slotR = slotRadiusM(planet, altitude);
  const intersects = positions.some((p) => Math.hypot(p.x - planet.center.x, p.y - planet.center.y, p.z - planet.center.z) <= planet.maxHillRadiusM + PLANET_CLEARANCE_M);
  if (intersects) reasons.push('one or more slots are inside the planet hill sphere; raise the altitude');

  const effectiveRange = range ?? 0;
  const graph = positionGraph(positions, effectiveRange);
  const verdict = redundancyVerdict(graph, input.redundancy, 'constellation');
  const coverage = usedPlacement && placement
    ? placement.coverage.coveragePct
    : range
      ? Math.round(coverageFraction(planet, altitude, positions, effectiveRange, 1) * 1000) / 10
      : null;
  const gravity = gravityAtAltitude(planetGravity(planet), altitude);
  const maxChord = maxChordM(positions);
  const endurance = enduranceView(hull, planet, altitude, maxChord);
  if (endurance.available && endurance.canReachSlot === false) {
    reasons.push(`endurance preflight: ${endurance.failureReason ?? 'the hull cannot reach this slot'}`);
  }
  const feasible =
    Boolean(range) &&
    graph.connected &&
    (input.redundancy === 1 || verdict.achieved !== 1) &&
    (endurance.canReachSlot !== false);
  if (!range) reasons.push(`hull ${hull.name} has no radio antenna, so no radio constellation is possible`);
  if (range && graph.maxGapM > effectiveRange + 0.5) reasons.push('a slot gap exceeds the effective range');
  if (range && coverage !== null && coverage < 1) {
    reasons.push(
      `coverage is below 1 %: a ${((hull.radioRangeM ?? 0) / 1000).toFixed(0)} km radio cannot see the ground from ${(altitude / 1000).toFixed(0)} km altitude (the footprint radius is smaller than the slant range)`,
    );
  }

  const spofs = graph.articulationPoints;
  const achieved = feasible ? verdict.achieved : 1;
  const summary =
    `${hull.name} radio ${(hull.radioRangeM ?? 0) / 1000} km ` +
    `(margin ${input.rangeMargin} -> ${(effectiveRange / 1000).toFixed(1)} km): ` +
    `${count} satellites in ${patternLabel(pattern)} at ${(altitude / 1000).toFixed(0)} km — ` +
    `${coverage === null ? 'coverage n/a' : `${coverage.toFixed(1)}% of the surface at k=1`}, ` +
    `${graph.links.length} radio links, ${spofs.length} SPOF(s), ` +
    `redundancy ${achieved}. Gravity at slot: ${gravity.toFixed(2)} m/s2` +
    `${gravity === 0 ? ' (gravity-free)' : ''}. ` +
    (usedPlacement && placement
      ? `${placement.coverage.coveredCells}/${placement.coverage.totalCells} cells covered, ` +
        `min spacing ${(placement.minSpacingM / 1000).toFixed(1)} km` +
        (placement.bunching ? ' (BUNCHED)' : '') +
        (placement.spareShips.length ? `, ${placement.spareShips.length} spare` : '') +
        '. '
      : '') +
    enduranceSummary(endurance);

  const slots = buildSlotSpecs(
    planet,
    positions.map((position) => ({ slotId: position.id, position, altitudeM: altitude })),
    hull,
    hull.radioRangeM,
    ownedHulls,
    maxChord,
  );

  return {
    id,
    pattern,
    hullId: hull.id,
    count,
    altitudeM: altitude,
    positions,
    links: graph.links.map((l) => ({ ...l, kind: 'radio' as const })),
    spofs,
    redundancyAchieved: achieved,
    coveragePct: coverage,
    maxGapM: Math.round(graph.maxGapM * 10) / 10,
    gravityAtSlotMps2: Math.round(gravity * 1000) / 1000,
    feasible,
    reasons: [...reasons, ...verdict.reasons],
    summary,
    labels: labelFor(hull),
    endurance,
    slots,
    spacingM: usedPlacement && placement ? placement.spacingM : [],
    minSpacingM: usedPlacement && placement ? placement.minSpacingM : undefined,
    bunching: usedPlacement && placement ? placement.bunching : false,
    spareShips: usedPlacement && placement ? placement.spareShips : [],
    spareReason: usedPlacement && placement ? placement.spareReason : undefined,
    shipsRequested: requestedCount,
    terrain:
      usedPlacement && placement
        ? placement.terrain
        : terrain
          ? terrain.status === 'available'
            ? 'corrected'
            : 'unavailable'
          : 'none',
    blockedCells: usedPlacement && placement ? placement.coverage.blockedCells : 0,
    // T53 preview readout: each pattern slot at its altitude, with the
    // horizon-limited ground radius its radio actually reaches.
    slotAltitudes: positions.map((position) => ({
      id: position.id,
      altitudeM: altitude,
      groundRadiusM: Math.round(groundFootprintRadiusM(planet, altitude, hull.radioRangeM ?? 0)),
      radioRadiusM: hull.radioRangeM ?? 0,
      role: 'coverage',
    })),
  };
}

function enduranceSummary(e: OptionEndurance): string {
  if (!e.available) return 'Endurance: not modelled (no definition-derived plant/fuel data).';
  if (e.canReachSlot === false) return `Endurance: CANNOT REACH — ${e.failureReason ?? 'unknown reason'}.`;
  const eta = e.etaS !== null ? formatDuration(e.etaS) : 'n/a';
  const hold = e.holdEnduranceText;
  return `Endurance: ascent ${e.ascentTimeS !== null ? formatDuration(e.ascentTimeS) : 'n/a'}, transit ${e.transitTimeS !== null ? formatDuration(e.transitTimeS) : 'n/a'} (ETA ${eta}), reserve ${e.reservePct?.toFixed(1) ?? 'n/a'} %; hold ${hold}. ${e.recommendation}`;
}

interface Endpoint {
  position: V3;
  planet: Planet | null;
  label: string;
}

function endpointOf(
  point: { planet?: string; gps?: { x: number; y: number; z: number } } | undefined,
  other: { planet?: string; gps?: { x: number; y: number; z: number } } | undefined,
  planets: Planet[],
  fallback: string,
): Endpoint {
  if (point?.gps) return { position: point.gps, planet: null, label: fallback };
  const planet = point?.planet ? planets.find((p) => p.name === point.planet || p.id === point.planet) ?? null : null;
  if (!planet) throw new Error(`${fallback}: give a planet or gps point`);
  const otherPlanet = other?.planet ? planets.find((p) => p.name === other.planet || p.id === other.planet) : null;
  const toward = other?.gps ?? otherPlanet?.center ?? { x: planet.center.x + 1, y: planet.center.y, z: planet.center.z };
  const dir = {
    x: toward.x - planet.center.x,
    y: toward.y - planet.center.y,
    z: toward.z - planet.center.z,
  };
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const r = planet.maxHillRadiusM + 1_000;
  return {
    position: {
      x: planet.center.x + (dir.x / l) * r,
      y: planet.center.y + (dir.y / l) * r,
      z: planet.center.z + (dir.z / l) * r,
    },
    planet,
    label: planet.name,
  };
}

function routeFor(
  a: Endpoint,
  b: Endpoint,
  planets: Planet[],
  spacing: number,
  hull: DesignerHull,
): { positions: V3[]; detour: boolean; blockedBy: string[] } {
  if (a.planet && b.planet && a.planet.name !== b.planet.name) {
    const plan = planChain(a.planet, b.planet, {
      id: hull.id,
      radioRadiusM: hull.radioRangeM,
      laserRangeM: null,
      laserUnlimited: false,
    }, { planets, maxSpacingM: spacing });
    return {
      positions: plan.nodes.map((n) => n.position),
      detour: plan.detour,
      blockedBy: plan.blockedBy,
    };
  }
  return { positions: linePositions(a.position, b.position, spacing), detour: false, blockedBy: [] };
}

function connectOption(
  id: string,
  input: DesignerPlanInput,
  planets: Planet[],
  hull: DesignerHull,
  range: number | null,
  forceRedundancy: Redundancy,
): DesignerOption {
  const reasons: string[] = [];
  const a = endpointOf(input.a, input.b, planets, 'a');
  const b = endpointOf(input.b, input.a, planets, 'b');
  const effectiveRange = range ?? 0;
  const spacing = Math.max(1_000, Math.min(input.spacingM ?? effectiveRange, effectiveRange));
  const route = routeFor(a, b, planets, spacing, hull);
  const primary = route.positions.map((p, i) => toSlot(`p${i + 1}`, p));

  let positions = primary;
  let secondPathOk = false;
  if (forceRedundancy === 2 || forceRedundancy === 'no-spof') {
    const offset = Math.max(spacing * 3, 20_000);
    const second = offsetLinePositions(a.position, b.position, spacing, offset).map((p, i) => toSlot(`q${i + 1}`, p));
    // The second route starts and ends at the same physical anchors: re-id its
    // endpoints onto the primary anchor ids and keep only its internal nodes.
    const mappedSecond = second.map((p, i) => {
      if (i === 0) return { ...p, id: primary[0]!.id };
      if (i === second.length - 1) return { ...p, id: primary[primary.length - 1]!.id };
      return p;
    });
    const anchorIds = new Set([primary[0]!.id, primary[primary.length - 1]!.id]);
    positions = [...primary, ...mappedSecond.filter((p) => !anchorIds.has(p.id))];
    const graph = positionGraph(positions, effectiveRange);
    secondPathOk = Boolean(twoNodeDisjointPaths(graph.adjacency, primary[0]!.id, primary[primary.length - 1]!.id));
    if (!secondPathOk) reasons.push('the second route is not node-disjoint at this range/margin');
  }

  const graph = positionGraph(positions, effectiveRange);
  const anchorsConnected = graph.connected;
  const anchorPair = twoNodeDisjointPaths(graph.adjacency, primary[0]!.id, primary[primary.length - 1]!.id);
  const spofs = graph.articulationPoints;
  const requestedTwo = forceRedundancy === 2 || forceRedundancy === 'no-spof';
  const achieved: Redundancy = requestedTwo
    ? secondPathOk && anchorPair
      ? forceRedundancy === 'no-spof' && spofs.length === 0
        ? 'no-spof'
        : 2
      : 1
    : 1;
  if (input.pattern !== 'chain' && input.pattern !== 'auto') {
    reasons.push(`connect routes are chains; the requested constellation pattern (${input.pattern}) does not apply here`);
  }
  if (!range) reasons.push(`hull ${hull.name} has no radio antenna, so no radio path is possible`);
  if (!anchorsConnected) reasons.push('the chain is not connected at this range/margin');
  if (requestedTwo && achieved === 1) reasons.push('redundancy fell back to 1: no node-disjoint second path was found');

  const totalDistance = dist(a.position, b.position);
  const gravity = a.planet ? gravityAtAltitude(planetGravity(a.planet), 1_000) : 0;
  const slotPlanet = a.planet ?? b.planet ?? null;
  const slotAltitudeM = slotPlanet
    ? Math.max(
        0,
        Math.round(
          Math.hypot(primary[0]!.x - slotPlanet.center.x, primary[0]!.y - slotPlanet.center.y, primary[0]!.z - slotPlanet.center.z) -
            slotPlanet.surfaceRadiusM,
        ),
      )
    : 0;
  const endurance = slotPlanet
    ? { ...enduranceView(hull, slotPlanet, slotAltitudeM, 0), enforced: false }
    : {
        available: false,
        enforced: false,
        modelReason: 'connect endpoints are raw GPS points with no planet, so altitude and gravity are unknown',
        canReachSlot: null,
        launch: null,
        ascentTimeS: null,
        transitTimeS: null,
        etaS: null,
        fuelUsedPct: null,
        batteryUsedPct: null,
        reservePct: null,
        holdEnduranceS: null,
        holdEnduranceText: 'not modelled',
        holdLimiting: null,
        holdPowerMW: null,
        holdH2BurnLps: null,
        twrAtSlot: null,
        failureReason: null,
        recommendation: 'no endurance estimate: connect endpoints are GPS points',
      };
  if (endurance.available && endurance.canReachSlot === false) {
    reasons.push(
      `endurance (informational): ${endurance.failureReason ?? 'the hull cannot hold at the geometric anchor'}; ` +
        'connect anchors are route waypoints at maximum hill radius + 1 km, not station-keeping slots',
    );
  }
  const feasible = Boolean(range) && anchorsConnected && (!requestedTwo || achieved !== 1);
  const coverage = null;
  const summary =
    `${hull.name} radio ${(hull.radioRangeM ?? 0) / 1000} km ` +
    `(margin ${input.rangeMargin} -> ${(effectiveRange / 1000).toFixed(1)} km): ` +
    `${positions.length} drones ${requestedTwo ? 'in two node-disjoint paths (k=2)' : 'single path (k=1)'} ` +
    `for ${a.label} -> ${b.label} (${(totalDistance / 1000).toFixed(0)} km), ` +
    `${spofs.length} SPOF(s), max gap ${(graph.maxGapM / 1000).toFixed(1)} km.` +
    (route.detour ? ` Routed around ${route.blockedBy.join(', ')}.` : '') +
    ` ${enduranceSummary(endurance)}`;

  return {
    id,
    pattern: 'chain',
    hullId: hull.id,
    count: positions.length,
    altitudeM: 0,
    positions,
    links: graph.links.map((l) => ({ ...l, kind: 'radio' as const })),
    spofs,
    redundancyAchieved: achievable(achieved, feasible),
    coveragePct: coverage,
    maxGapM: Math.round(graph.maxGapM * 10) / 10,
    gravityAtSlotMps2: Math.round(gravity * 1000) / 1000,
    feasible,
    reasons,
    summary,
    labels: labelFor(hull),
    endurance,
  };
}

function achievable(value: Redundancy, feasible: boolean): Redundancy {
  return feasible ? value : 1;
}

export function buildDesignerPlan(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  planets: Planet[],
  now = Date.now(),
  id = `plan-${now.toString(36)}`,
  integration: {
    powerCheck?: import('./hetero.js').SlotPowerCheck | null;
    powerNote?: string | null;
    /** T49: terrain field for slant-path coverage (null = smooth sphere). */
    terrain?: TerrainField | null;
  } = {},
): DesignerPlan {
  const hull = findHull(hulls, input.hullId);
  if (!hull) throw new Error(`unknown hull ${input.hullId}`);
  if (!(input.rangeMargin >= 0.5 && input.rangeMargin <= 1)) throw new Error('rangeMargin must be between 0.5 and 1');
  const range = hullRange(hull, input.rangeMargin);
  const options: DesignerOption[] = [];

  if (input.mode === 'radio-chain' || input.mode === 'layered' || input.mode === 'cover-planet') {
    const built = buildRelayModeOption(input, hulls, planets, integration);
    return {
      id,
      mode: input.mode,
      input,
      hull,
      planets: { a: built.planetName, b: null },
      options: [built.option],
      assumptions: assumptionsFor(input.mode === 'cover-planet' ? 'coverage' : 'relay'),
      labels: [
        'SIMULATED',
        'RADIO-UNVERIFIED',
        'ENDURANCE-MODEL',
        ...(input.mode === 'cover-planet' ? ['COVERAGE-GEOMETRY'] : []),
      ],
      createdAt: now,
    };
  }

  if (input.mode === 'constellation') {
    const planetName = input.planet;
    if (!planetName) throw new Error('constellation mode needs a planet');
    const planet = planets.find((p) => p.name === planetName || p.id === planetName);
    if (!planet) throw new Error(`unknown planet ${planetName}`);
    const requested = input.pattern === 'auto' ? 'ring' : input.pattern;
    const ordered = [requested, ...CONSTELLATION_PATTERNS.filter((p) => p !== requested)];
    const seen = new Set<Pattern>();
    for (const pattern of ordered) {
      const actual = input.pattern === 'auto' ? pattern : pattern;
      if (seen.has(actual)) continue;
      seen.add(actual);
      options.push(
        constellationOption(
          `o${options.length + 1}`,
          actual,
          input,
          planet,
          hull,
          range,
          hulls.filter((candidate) => candidate.source === 'owner-tagged'),
          integration.terrain ?? null,
        ),
      );
      if (options.length >= 4) break;
    }
    // Feasible first (the launch gate must not be buried); within each group the
    // requested option stays first and alternatives follow by slot count.
    const feasibleOptions = options.filter((o) => o.feasible);
    const infeasibleOptions = options.filter((o) => !o.feasible);
    const [first, ...rest] = feasibleOptions;
    rest.sort((x, y) => x.count - y.count);
    const sortedOptions = [...(first ? [first] : []), ...rest, ...infeasibleOptions];
    options.length = 0;
    options.push(...sortedOptions);
    return {
      id,
      mode: input.mode,
      input,
      hull,
      planets: { a: planet.name, b: null },
      options,
      assumptions: assumptionsFor(input.mode),
      labels: ['SIMULATED', 'RADIO-UNVERIFIED', 'ENDURANCE-MODEL'],
      createdAt: now,
    };
  }

  if (input.mode !== 'connect') throw new Error(`unknown mode ${String(input.mode)}`);
  const first = connectOption('o1', input, planets, hull, range, input.redundancy);
  options.push(first);
  if (input.redundancy === 2 || input.redundancy === 'no-spof') {
    // Cheapest alternative: the same route as a single path, clearly marked as
    // not meeting the requested redundancy.
    const cheaper = connectOption('o2', input, planets, hull, range, 1);
    cheaper.reasons.push('alternative only: this option is k=1 and does not meet the requested redundancy');
    options.push(cheaper);
  }
  return {
    id,
    mode: input.mode,
    input,
    hull,
    planets: { a: first.positions.length ? (input.a?.planet ?? null) : null, b: input.b?.planet ?? null },
    options,
    assumptions: assumptionsFor('connect'),
    labels: ['SIMULATED', 'RADIO-UNVERIFIED', 'ENDURANCE-MODEL'],
    createdAt: now,
  };
}

function assumptionsFor(mode: 'constellation' | 'connect' | 'relay' | 'coverage'): { id: string; text: string; status: string }[] {
  const common = [
    {
      id: 'geometry',
      text: 'slot positions, links and coverage are deterministic planner geometry, not game telemetry',
      status: 'SIMULATED',
    },
    {
      id: 'radio_range',
      text: 'radio range comes from the measured hull profile (prefab) or the live plugin profile (owner-tagged); per-pair link quality is unmeasured',
      status: 'UNVERIFIED',
    },
    {
      id: 'planets',
      text: 'planets block links as spheres at maximum hill radius + 1,000 m; real terrain is not modelled',
      status: 'SIMULATED',
    },
  ];
  for (const assumption of ENDURANCE_ASSUMPTIONS) {
    common.push({ id: `endurance_${assumption.id}`, text: assumption.text, status: assumption.status });
  }
  if (mode === 'constellation') {
    common.push({
      id: 'coverage',
      text: 'coverage is a Fibonacci surface sample of circular radio footprints at the planned altitude',
      status: 'SIMULATED',
    });
  }
  if (mode === 'relay' || mode === 'coverage') {
    common.push(
      {
        id: 'atmo_ceiling',
        text: 'atmo thrust is treated as ~0 above 10 km AGL and the atmosphere top comes from the planet generator data; an atmo hull above that must be carried and stationed',
        status: 'MEASURED',
      },
      {
        id: 'zero_g',
        text: 'zero-g altitude comes from the verified gravity model (EarthLike 43.7 km AGL); station hold is free at any altitude (T18)',
        status: 'MODEL',
      },
      {
        id: 'stations',
        text: 'a station costs no hover fuel; every grid is treated as station-capable, and a station at an altitude requires a carrier when the hull cannot self-deploy there',
        status: 'SIMULATED',
      },
    );
  }
  if (mode === 'coverage') {
    common.push({
      id: 'coverage_grid',
      text: 'coverage is a lat/long grid of curvature-corrected line-of-sight footprints; terrain is not modelled, so a cell marked covered may still be blocked by a mountain (rover spots are where no sky node reaches at all)',
      status: 'SIMULATED',
    });
  }
  return common;
}
