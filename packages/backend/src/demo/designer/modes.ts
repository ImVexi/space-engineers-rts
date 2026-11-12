/**
 * Planner modes for T16/T17/T28, wired into the designer plan endpoint:
 *
 *   * `radio-chain`  — no lasers, first hop on the base, hops <= 0.9 x radio,
 *     climbing to zero-g (T16);
 *   * `layered`      — atmo/station tier, H2 station tier, zero-g bridge (T17);
 *   * `cover-planet` — minimum relay set per tier with a lat/long heatmap and
 *     rover-laser fallback spots (T28).
 *
 * Every option carries the heterogeneous assignment (T22) and plain-language
 * reasons. It is all SIMULATED geometry over measured hull profiles.
 */
import type { Planet } from '@se-rts/schemas';
import { add, dist, normalize, scale, v3, type V3 } from '../../planner/geometry.js';
import { planRadioChain, planLayered, type RadioChainPlan } from '../../planner/relay.js';
import {
  planPlanetCoverage,
  type CoverageTierId,
  type CoverageTierSpec,
} from '../../planner/planetCoverage.js';
import { positionGraph, toSlot, type SlotPosition } from './patterns.js';
import type { DesignerHull } from './hulls.js';
import { gravityAtAltitude, gravityFreeAltitudeM, planetGravity } from './gravity.js';
import { atmosphereTopAltitudeM } from '../endurance/model.js';
import { enduranceView, type OptionEndurance } from './enduranceView.js';
import {
  assignHullsToSlots,
  requirementsFromLinks,
  type HeteroAssignment,
  type SlotPowerCheck,
  type SlotRequirement,
  type Vec3,
} from './hetero.js';
import { BASE_ALTITUDE_M, classifyHulls } from './classification.js';
import { spacingReport } from './placement.js';
import { buildSlotSpecs } from './slotSpec.js';
import type { TerrainField } from '../../planner/terrainField.js';
import type { CoverageOptionSummary, DesignerOption, DesignerPlanInput, OptionTier } from './plan.js';
import { solveCoverGoal } from './coverGoal.js';
import type { AltitudeMode } from './altitude.js';

export interface ModeIntegration {
  powerCheck?: SlotPowerCheck | null;
  powerNote?: string | null;
  /** T49: terrain field for slant-path coverage (null = smooth sphere). */
  terrain?: TerrainField | null;
}

export interface ModeBuildResult {
  option: DesignerOption;
  planetName: string;
}

const STATION_TIER_ALTITUDE_M = 15_000;
const ATMO_TIER_ALTITUDE_M = 8_000;

function planetFor(input: DesignerPlanInput, planets: Planet[]): Planet {
  const name = input.base?.planet ?? input.planet;
  if (!name) throw new Error('this planner mode needs a planet (or base.planet)');
  const planet = planets.find((p) => p.name === name || p.id === name);
  if (!planet) throw new Error(`unknown planet ${name}`);
  return planet;
}

function baseDirection(planet: Planet, input: DesignerPlanInput): V3 | undefined {
  if (!input.base?.gps) return undefined;
  return {
    x: input.base.gps.x - planet.center.x,
    y: input.base.gps.y - planet.center.y,
    z: input.base.gps.z - planet.center.z,
  };
}

function atmoCeilingFor(planet: Planet): number {
  // The endurance model derives the atmosphere top from the planet generator
  // data (EarthLike 15 km); atmo thrust is already ~0 above ~10 km.
  return Math.min(10_000, Math.round(atmosphereTopAltitudeM(planet)));
}

function zeroGFor(planet: Planet): number {
  // Round up: at exactly the cutoff the model can still read a residual g.
  return Math.ceil(gravityFreeAltitudeM(planetGravity(planet)));
}

/** Hull pool for the assignment: requested ids or every available hull. */
export function hullPool(input: DesignerPlanInput, hulls: DesignerHull[]): DesignerHull[] {
  if (!input.hullIds || input.hullIds.length === 0) return hulls;
  const wanted = new Set(input.hullIds);
  const pool = hulls.filter((hull) => wanted.has(hull.id));
  if (pool.length === 0) return hulls;
  return pool;
}

function livePositions(hulls: DesignerHull[]): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const hull of hulls) {
    if (hull.source === 'owner-tagged' && hull.position) out[hull.id] = hull.position;
  }
  return out;
}

function assign(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  requirements: SlotRequirement[],
  integration: ModeIntegration,
): HeteroAssignment {
  const pool = hullPool(input, hulls);
  return assignHullsToSlots(pool, requirements, {
    rangeMargin: input.rangeMargin,
    positions: livePositions(pool),
    powerCheck: integration.powerCheck ?? null,
    powerNote: integration.powerNote ?? null,
    maxNewBuilds: input.maxNewBuilds,
  });
}

function gravityMax(planet: Planet, altitudes: number[]): number {
  const g = planetGravity(planet);
  const max = altitudes.reduce((value, altitude) => Math.max(value, gravityAtAltitude(g, altitude)), 0);
  return Math.round(max * 1000) / 1000;
}

function sumByTier(nodes: { tier: string; altitudeM: number }[]): OptionTier[] {
  const groups = new Map<string, { altitudeM: number; count: number }>();
  for (const node of nodes) {
    const key = node.tier;
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { altitudeM: node.altitudeM, count: 1 });
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].altitudeM - b[1].altitudeM)
    .map(([id, group]) => ({
      id: id as OptionTier['id'],
      altitudeM: Math.round(group.altitudeM),
      count: group.count,
      gravityMps2: 0,
      stationFree: id !== 'zero-g',
      radioRangeM: 0,
      coveragePct: 0,
    }));
}

function gapLines(assignment: HeteroAssignment): string[] {
  const lines = assignment.unfilled.map((slot) => `${slot.gap} (${slot.hint})`);
  if (assignment.carriedCount > 0) {
    lines.push(
      `${assignment.carriedCount} slot(s) need a carrier: no self-deploying hull in the pool fits that tier (plan the tow or add an H2 relay)`,
    );
  }
  return lines;
}

function assignmentLabels(assignment: HeteroAssignment): string[] {
  const labels = ['ASSIGNMENT'];
  if (assignment.carriedCount > 0) labels.push('CARRIED');
  if (assignment.unfilled.length > 0) labels.push('MISSING-HULLS');
  if (assignment.power.skipped) labels.push('POWER-SKIPPED');
  return labels;
}

function enduranceText(option: { endurance: OptionEndurance }): string {
  const e = option.endurance;
  if (!e.available) return 'Endurance: not modelled (no definitions-derived plant/fuel data).';
  if (e.canReachSlot === false) return `Endurance: CANNOT REACH — ${e.failureReason ?? 'unknown reason'}.`;
  return `Endurance: ${e.holdEnduranceText}. ${e.recommendation}`;
}

/**
 * Radio relay chain (T16). The first node is placed so the radial gap from the
 * base is within the hop limit; with a 50 km radio and BASE-01 at 1.8 km this
 * is a single node at the zero-g edge (43.7 km), which is free to hold.
 */
export function buildRadioChainOption(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  planets: Planet[],
  integration: ModeIntegration,
): ModeBuildResult {
  const planet = planetFor(input, planets);
  const zeroG = zeroGFor(planet);
  const atmoCeiling = atmoCeilingFor(planet);
  const baseAltitude = input.base?.altitudeM ?? BASE_ALTITUDE_M;
  const pool = hullPool(input, hulls);
  const hull = hulls.find((h) => h.id === input.hullId) ?? pool[0]!;
  const radio = hull.radioRangeM ?? 0;
  const reasons: string[] = [];
  const labels = ['SIMULATED', 'RADIO-UNVERIFIED', 'NO-LASER-REQUIRED', 'STATION-IN-THE-SKY'];

  if (!(radio > 0)) {
    const endurance = enduranceView(hull, planet, zeroG, 0);
    return {
      planetName: planet.name,
      option: {
        id: 'o1',
        pattern: 'radio-chain',
        mode: 'radio-chain',
        hullId: hull.id,
        count: 0,
        altitudeM: 0,
        positions: [],
        links: [],
        spofs: [],
        redundancyAchieved: 1,
        coveragePct: 0,
        maxGapM: 0,
        gravityAtSlotMps2: 0,
        feasible: false,
        reasons: [`hull ${hull.name} has no radio antenna: a radio-only chain cannot use it`],
        summary: `Radio relay chain infeasible: ${hull.name} has no radio antenna.`,
        labels,
        endurance,
      },
    };
  }

  const plan = planRadioChain(planet, {
    radioRangeM: radio,
    zeroGAltitudeM: zeroG,
    atmoCeilingM: atmoCeiling,
    baseAltitudeM: baseAltitude,
    baseDirection: baseDirection(planet, input),
    maxHopM: input.maxHopM ?? 45_000,
    rangeMargin: input.rangeMargin,
    keepFirstHopOnBase: input.keepFirstHopOnBase ?? true,
    reachM: input.reachM ?? 0,
    bearingDeg: input.bearingDeg ?? 0,
  });

  const positions = plan.nodes.map((node) => toSlot(node.id, node.position));
  const links = chainLinks(plan);
  const requirements = requirementsFromLinks({
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      altitudeM: node.altitudeM,
      role: node.tier,
    })),
    links,
    zeroGAltitudeM: zeroG,
    gravityAt: (altitude) => gravityAtAltitude(planetGravity(planet), altitude),
    baseId: 'base',
  });
  const assignment = assign(input, hulls, requirements, integration);
  const baseLinkM = plan.firstHopM;
  const maxGapM = Math.max(plan.maxGapM, plan.firstHopM ?? 0);
  const coveragePct = plan.coverage.coveragePct;
  const apex = plan.nodes[plan.nodes.length - 1] ?? null;
  const endurance = apex
    ? enduranceView(hull, planet, apex.altitudeM, maxGapM)
    : enduranceView(hull, planet, zeroG, 0);

  reasons.push(...plan.reasons, ...gapLines(assignment));
  if (plan.warnings.length) reasons.push(...plan.warnings.map((warning) => `note: ${warning}`));
  if (plan.zeroGAltitudeM > 0 && plan.nodes.every((node) => node.stationPreferred)) {
    reasons.push('every node is inside gravity: station them for a free hold (T18) or budget hover fuel');
  }
  if (assignment.power.skipped) reasons.push(`note: ${assignment.power.note}`);
  if (assignment.assignments.some((a) => a.hullId !== hull.id)) {
    reasons.push(
      'heterogeneous assignment: at least one slot is filled by a different hull than the requested one; execute that slot individually (plan-only in this build)',
    );
    labels.push('HETERO-ASSIGNMENT', 'PLAN-ONLY');
  }
  const feasible =
    plan.baseLinked &&
    plan.hops.every((hop) => hop.withinLimit) &&
    plan.reachesZeroG &&
    plan.nodes.length > 0 &&
    assignment.unfilled.length === 0;
  if (!plan.baseLinked) reasons.push('the first node does not reach the base within the hop limit');
  if (assignment.unfilled.length > 0) reasons.push(`${assignment.unfilled.length} slot(s) have no eligible hull`);

  const hopKm = (plan.hopLimitM / 1000).toFixed(1);
  const summary =
    `Radio relay chain (no lasers): ${plan.count} relay(s) from BASE-01 at ${(baseAltitude / 1000).toFixed(1)} km ` +
    `up to ${apex ? (apex.altitudeM / 1000).toFixed(1) : '0'} km; first hop ` +
    `${baseLinkM === null ? 'n/a' : `${(baseLinkM / 1000).toFixed(1)} km`}, hop limit ${hopKm} km ` +
    `(min(max hop ${(plan.maxHopM / 1000).toFixed(0)} km, ${(radio / 1000).toFixed(0)} km radio x ${input.rangeMargin})), ` +
    `max gap ${(maxGapM / 1000).toFixed(1)} km, ${coveragePct.toFixed(1)} % surface footprint. ` +
    `${assignment.shipCount} ship(s): ${assignment.newBuilds} new build(s), ${assignment.existingUsed} existing` +
    (assignment.carriedCount ? `, ${assignment.carriedCount} carried` : '') +
    (assignment.unfilled.length ? `, ${assignment.unfilled.length} unfilled` : '') +
    `. ${enduranceText({ endurance })}`;
  const tiers = sumByTier(plan.nodes).map((tier) => ({
    ...tier,
    gravityMps2: gravityMax(planet, [tier.altitudeM]),
    radioRangeM: radio,
    coveragePct: tier.id === 'zero-g' ? coveragePct : 0,
  }));

  return {
    planetName: planet.name,
    option: {
      id: 'o1',
      pattern: 'radio-chain',
      mode: 'radio-chain',
      hullId: hull.id,
      count: plan.count,
      altitudeM: apex?.altitudeM ?? 0,
      positions,
      links,
      spofs: spofsOf(positions, plan.hopLimitM),
      redundancyAchieved: 1,
      coveragePct,
      maxGapM: Math.round(maxGapM * 10) / 10,
      gravityAtSlotMps2: gravityMax(planet, plan.nodes.map((node) => node.altitudeM)),
      feasible,
      reasons,
      summary,
      labels: [...new Set([...labels, ...assignmentLabels(assignment)])],
      endurance,
      base: { ...plan.base.position, altitudeM: plan.base.altitudeM },
      tiers,
      assignment,
      slots: buildSlotSpecs(
        planet,
        plan.nodes.map((node) => ({ slotId: node.id, position: node.position, altitudeM: node.altitudeM })),
        hull,
        radio,
        hulls.filter((candidate) => candidate.source === 'owner-tagged'),
        maxGapM,
      ),
    },
  };
}

/** All radio links among the chain nodes plus the base downlink. */
function chainLinks(plan: RadioChainPlan): { a: string; b: string; lengthM: number; kind: 'radio' }[] {
  const out: { a: string; b: string; lengthM: number; kind: 'radio' }[] = [];
  for (const hop of plan.hops) out.push({ a: hop.from, b: hop.to, lengthM: hop.lengthM, kind: 'radio' });
  const first = plan.nodes[0];
  if (first && plan.firstHopM !== null) {
    out.push({ a: 'base', b: first.id, lengthM: plan.firstHopM, kind: 'radio' });
  }
  // Cross links within the hop limit (redundancy the radio actually provides).
  for (let i = 0; i < plan.nodes.length; i += 1) {
    for (let j = i + 1; j < plan.nodes.length; j += 1) {
      const a = plan.nodes[i]!;
      const b = plan.nodes[j]!;
      const lengthM = dist(a.position, b.position);
      if (lengthM <= plan.hopLimitM + 0.5 && j > i + 1) {
        out.push({ a: a.id, b: b.id, lengthM: Math.round(lengthM * 10) / 10, kind: 'radio' });
      }
    }
  }
  return out;
}

function spofsOf(positions: SlotPosition[], rangeM: number): string[] {
  return positionGraph(positions, rangeM).articulationPoints;
}

/**
 * Layered network (T17): atmo/station tier, H2 station tier, zero-g bridge.
 */
export function buildLayeredOption(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  planets: Planet[],
  integration: ModeIntegration,
): ModeBuildResult {
  const planet = planetFor(input, planets);
  const zeroG = zeroGFor(planet);
  const atmoCeiling = atmoCeilingFor(planet);
  const baseAltitude = input.base?.altitudeM ?? BASE_ALTITUDE_M;
  const pool = hullPool(input, hulls);
  const hull = hulls.find((h) => h.id === input.hullId) ?? pool[0]!;
  const radio = hull.radioRangeM ?? 0;
  const labels = ['SIMULATED', 'RADIO-UNVERIFIED', 'LAYERED'];
  const reasons: string[] = [];
  if (!(radio > 0)) {
    return {
      planetName: planet.name,
      option: emptyOption(hull, planet, 'layered', `${hull.name} has no radio antenna: a layered radio network cannot use it`),
    };
  }
  const plan = planLayered(planet, {
    radioRangeM: radio,
    zeroGAltitudeM: zeroG > 0 ? zeroG : 45_000,
    atmoCeilingM: atmoCeiling,
    baseAltitudeM: baseAltitude,
    baseDirection: baseDirection(planet, input),
    maxHopM: input.maxHopM ?? 45_000,
    rangeMargin: input.rangeMargin,
    atmoAltitudeM: input.atmoAltitudeM ?? ATMO_TIER_ALTITUDE_M,
    atmoCount: input.atmoCount ?? 3,
    h2AltitudeM: input.h2AltitudeM ?? STATION_TIER_ALTITUDE_M,
    h2Count: input.h2Count ?? 1,
    zeroGCount: input.zeroGCount ?? 4,
    gravityAtAltitudeMps2: (altitude) => gravityAtAltitude(planetGravity(planet), altitude),
    rings: input.count !== 1,
  });
  const positions = plan.nodes.map((node) => toSlot(node.id, node.position));
  const links = plan.links
    .filter((link) => link.a !== 'base' && link.b !== 'base')
    .map((link) => ({ a: link.a, b: link.b, lengthM: link.lengthM, kind: 'radio' as const }));
  const baseLinks = plan.links
    .filter((link) => link.a === 'base' || link.b === 'base')
    .map((link) => ({ a: 'base', b: link.a === 'base' ? link.b : link.a, lengthM: link.lengthM, kind: 'radio' as const }));
  const requirements = requirementsFromLinks({
    nodes: plan.nodes.map((node) => ({ id: node.id, position: node.position, altitudeM: node.altitudeM, role: node.role })),
    links: [...links, ...baseLinks],
    zeroGAltitudeM: zeroG,
    gravityAt: (altitude) => gravityAtAltitude(planetGravity(planet), altitude),
    baseId: 'base',
  });
  const assignment = assign(input, hulls, requirements, integration);
  reasons.push(...plan.reasons, ...gapLines(assignment), ...plan.warnings.map((w) => `note: ${w}`));
  if (assignment.power.skipped) reasons.push(`note: ${assignment.power.note}`);
  if (assignment.assignments.some((a) => a.hullId !== hull.id)) {
    reasons.push('heterogeneous assignment fills some slots with other hulls (plan-only in this build)');
    labels.push('HETERO-ASSIGNMENT', 'PLAN-ONLY');
  }
  const apex = plan.nodes[plan.nodes.length - 1] ?? null;
  const endurance = apex ? enduranceView(hull, planet, apex.altitudeM, plan.maxGapM) : enduranceView(hull, planet, zeroG, 0);
  const feasible =
    plan.connected &&
    plan.hops.every((hop) => hop.withinLimit) &&
    plan.nodes.length > 0 &&
    assignment.unfilled.length === 0;
  if (assignment.unfilled.length > 0) reasons.push(`${assignment.unfilled.length} slot(s) have no eligible hull`);

  const tierText = plan.tiers
    .map((tier) => `${tier.id} ${tier.count}@${(tier.altitudeM / 1000).toFixed(0)} km (${tier.coverage.coveragePct.toFixed(1)} %)`)
    .join(' + ');
  const summary =
    `Layered network: ${tierText} = ${plan.count} ship(s); hop limit ${(plan.hopLimitM / 1000).toFixed(1)} km, ` +
    `max gap ${(plan.maxGapM / 1000).toFixed(1)} km, base linked ${plan.connected ? 'yes' : 'NO'}, ` +
    `whole-network footprint ${plan.coveragePct.toFixed(1)} %. ` +
    `${assignment.shipCount} assigned: ${assignment.newBuilds} new build(s), ${assignment.existingUsed} existing` +
    (assignment.carriedCount ? `, ${assignment.carriedCount} carried` : '') +
    (assignment.unfilled.length ? `, ${assignment.unfilled.length} unfilled` : '') +
    `. ${enduranceText({ endurance })}`;
  const tiers: OptionTier[] = plan.tiers.map((tier) => ({
    id: tier.id,
    altitudeM: tier.altitudeM,
    count: tier.count,
    gravityMps2: tier.gravityMps2,
    stationFree: tier.stationFree,
    radioRangeM: radio,
    coveragePct: tier.coverage.coveragePct,
  }));

  return {
    planetName: planet.name,
    option: {
      id: 'o1',
      pattern: 'layered',
      mode: 'layered',
      hullId: hull.id,
      count: plan.count,
      altitudeM: apex?.altitudeM ?? 0,
      positions,
      links,
      spofs: spofsOf(positions, plan.hopLimitM),
      redundancyAchieved: 1,
      coveragePct: plan.coveragePct,
      maxGapM: plan.maxGapM,
      gravityAtSlotMps2: gravityMax(planet, plan.nodes.map((node) => node.altitudeM)),
      feasible,
      reasons,
      summary,
      labels: [...new Set([...labels, ...assignmentLabels(assignment)])],
      endurance,
      base: { ...plan.base.position, altitudeM: plan.base.altitudeM },
      tiers,
      assignment,
      slots: buildSlotSpecs(
        planet,
        plan.nodes.map((node) => ({ slotId: node.id, position: node.position, altitudeM: node.altitudeM })),
        hull,
        radio,
        hulls.filter((candidate) => candidate.source === 'owner-tagged'),
        plan.maxGapM,
      ),
    },
  };
}

/**
 * Whole-planet coverage, coverage-first (T28 + T49 + T52 + T53).
 *
 * The slot set comes from `solveCoverGoal`: cells first, per-slot altitude by
 * the requested mode, real k=2 redundancy and an auto ship count. The legacy
 * per-tier computation is kept only as comparison context (`coverage.tiers`),
 * never as the plan itself.
 */
export function buildCoverPlanetOption(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  planets: Planet[],
  integration: ModeIntegration,
): ModeBuildResult {
  const planet = planetFor(input, planets);
  const zeroG = zeroGFor(planet);
  const pool = hullPool(input, hulls);
  const hull = hulls.find((h) => h.id === input.hullId) ?? pool[0]!;
  const labels = ['SIMULATED', 'COVERAGE-FIRST'];
  const caps = classifyHulls(pool);
  const bestRadio = (predicate: (cap: (typeof caps)[number]) => boolean): number => {
    const ranges = caps.filter(predicate).map((cap) => cap.radioRangeM ?? 0).filter((value) => value > 0);
    return ranges.length ? Math.max(...ranges) : 0;
  };
  const anyRadio = bestRadio(() => true);
  if (!(anyRadio > 0)) {
    return {
      planetName: planet.name,
      option: emptyOption(hull, planet, 'cover-planet', 'no hull in the pool has a radio antenna'),
    };
  }

  const altitudeMode: AltitudeMode = input.altitudeMode ?? 'cheapest';
  const targetKind: 'whole' | 'hemisphere' | 'radius' = input.target ?? 'whole';
  // Hemisphere / radius centre: an explicit planet, else the base direction.
  let centerDir = baseDirection(planet, input);
  if (input.facing) {
    const facingPlanet = planets.find((p) => p.name === input.facing || p.id === input.facing);
    if (facingPlanet) centerDir = { x: facingPlanet.center.x - planet.center.x, y: facingPlanet.center.y - planet.center.y, z: facingPlanet.center.z - planet.center.z };
  }
  const goal = solveCoverGoal({
    planet,
    k: input.k ?? 1,
    cellDeg: input.cellDeg ?? 10,
    rangeMargin: input.rangeMargin,
    altitudeMode,
    manualAltitudeM: input.altitudeM ?? null,
    count: input.count ?? null,
    hull,
    target: targetKind === 'whole' ? { kind: 'whole' } : { kind: targetKind, centerDir, radiusM: input.targetRadiusM ?? 50_000 },
    baseDirection: centerDir,
    baseAltitudeM: input.base?.altitudeM ?? BASE_ALTITUDE_M,
    terrain: integration.terrain ?? null,
    costWeights: input.costWeights ?? null,
    minSpacingM: input.minSpacingM ?? null,
  });

  if (goal.slots.length === 0) {
    return {
      planetName: planet.name,
      option: emptyOption(hull, planet, 'cover-planet', goal.reasons[0] ?? 'no usable coverage slot was found'),
    };
  }

  // Legacy per-tier comparison (T28): kept as context, not as the plan.
  const tierSpecs: CoverageTierSpec[] = [
    { id: 'atmo', altitudeM: 8_000, radioRangeM: anyRadio },
    { id: 'station', altitudeM: 15_000, radioRangeM: anyRadio },
    { id: 'zero-g', altitudeM: Math.max(45_000, zeroG), radioRangeM: anyRadio },
  ];
  const tierPlan = planPlanetCoverage(planet, tierSpecs, {
    k: input.k ?? 1,
    cellDeg: input.cellDeg ?? 10,
    rangeMargin: input.rangeMargin,
    maxHopM: input.maxHopM ?? 45_000,
    baseAltitudeM: input.base?.altitudeM ?? BASE_ALTITUDE_M,
    baseDirection: centerDir,
    roverFallback: input.roverFallback ?? true,
    terrain: integration.terrain ?? null,
    timing: false,
  });

  const positions = goal.slots.map((slot) => toSlot(slot.id, slot.position));
  const links = goal.links.map((link) => ({ ...link, kind: 'radio' as const }));
  const requirements = requirementsFromLinks({
    nodes: goal.slots.map((slot) => ({
      id: slot.id,
      position: slot.position,
      altitudeM: slot.altitudeM,
      role: slot.role,
    })),
    links,
    zeroGAltitudeM: zeroG,
    gravityAt: (altitude) => gravityAtAltitude(planetGravity(planet), altitude),
    baseId: 'base',
  });
  const assignment = assign(input, hulls, requirements, integration);
  const reasons: string[] = [...goal.reasons, ...gapLines(assignment)];
  for (const tier of tierPlan.tiers) reasons.push(...tier.warnings.map((warning) => `${tier.id}: ${warning}`));
  if (assignment.power.skipped) reasons.push(`note: ${assignment.power.note}`);
  if (assignment.assignments.some((a) => a.hullId !== hull.id)) {
    reasons.push('heterogeneous assignment fills some slots with other hulls (plan-only in this build)');
    labels.push('HETERO-ASSIGNMENT', 'PLAN-ONLY');
  }
  if (assignment.unfilled.length > 0) reasons.push(`${assignment.unfilled.length} slot(s) have no eligible hull`);
  if (goal.countNeeded !== null && goal.requestedCount !== null && goal.requestedCount < goal.countNeeded) {
    reasons.push(
      `you asked for ${goal.requestedCount} ship(s); the goal needs ${goal.countNeeded}, so ${goal.uncoveredPct.toFixed(1)} % of the target stays uncovered`,
    );
  }
  if (goal.surplus.length > 0) {
    reasons.push(`${goal.surplus.length} ship(s) are surplus: the goal needs ${goal.countNeeded}`);
  }
  labels.push(...goal.labels.filter((label) => !labels.includes(label)));
  if (goal.terrain === 'unavailable') {
    reasons.push(`terrain is unavailable for ${planet.name}: coverage is the smooth-sphere footprint (${goal.terrainReason})`);
  }

  const mixedAltitudes = [...new Set(goal.slots.map((slot) => slot.altitudeM))].sort((a, b) => a - b);
  const maxGapM = goal.maxGapM;
  const endurance = enduranceView(hull, planet, goal.slots[0]!.altitudeM, maxGapM);
  const feasible = goal.coveragePct > 0 && assignment.unfilled.length === 0;
  const tierText = mixedAltitudes
    .map((altitudeM) => `${(altitudeM / 1000).toFixed(1)} km x ${goal.slots.filter((slot) => slot.altitudeM === altitudeM).length}`)
    .join(', ');
  const summary =
    `Cover ${planet.name}: ${goal.countUsed} relay(s) at ${tierText} for k=${goal.k} on a ${goal.cellDeg}° grid; ` +
    `${goal.coveragePct.toFixed(1)} % of the target covered` +
    (goal.uncoveredPct > 0 ? ` (${goal.uncoveredPct.toFixed(1)} % uncovered)` : '') +
    `, altitude mode ${altitudeMode}` +
    (goal.k === 2 ? `, redundancy achieved k=${goal.achievedK}` : '') +
    (goal.relaysWithoutSecondPath.length ? ` (${goal.relaysWithoutSecondPath.length} relay(s) lack a second path)` : '') +
    `. The goal needs ${goal.countNeeded} ship(s); this plan uses ${goal.countUsed}` +
    (goal.surplus.length ? `, ${goal.surplus.length} surplus` : '') +
    `. Total ${goal.totals.h2L.toFixed(1)} L H2, ${goal.totals.antennaMW.toFixed(2)} MW antenna` +
    `. ${enduranceText({ endurance })}`;

  const spacing = spacingReport({
    nodes: positions.map((position) => ({ id: position.id, position })),
    basePosition: add(planet.center, scale(normalize(centerDir ?? planetVec(planet)), planet.surfaceRadiusM + (input.base?.altitudeM ?? BASE_ALTITUDE_M))),
    hopLimitM: Math.min(input.maxHopM ?? 45_000, (hull.radioRangeM ?? 0) * input.rangeMargin),
    radioRangeM: hull.radioRangeM ?? 0,
  });
  const slotSpecs = buildSlotSpecs(
    planet,
    goal.slots.map((slot) => ({
      slotId: slot.id,
      position: slot.position,
      altitudeM: slot.altitudeM,
      requiredRadioM: slot.radioRadiusM,
      altitudeReason: slot.altitudeReason,
      radioRadiusM: slot.radioRadiusM,
      radioSavedMW: slot.radioSavedMW,
    })),
    hull,
    hull.radioRangeM,
    hulls.filter((candidate) => candidate.source === 'owner-tagged'),
    maxGapM,
  );

  const coverage: CoverageOptionSummary = {
    cellDeg: goal.cellDeg,
    recommendedTier: mixedAltitudes.every((altitudeM) => altitudeM >= zeroG) ? 'zero-g' : 'station',
    recommendation: `${goal.countUsed} relay(s) cover ${goal.coveragePct.toFixed(1)} % of the target (${altitudeMode})`,
    uncoveredCells: goal.totalCells - goal.coveredCells,
    uncoveredPct: goal.uncoveredPct,
    roverSpots: tierPlan.rovers.map((rover) => ({ latDeg: rover.latDeg, lonDeg: rover.lonDeg, reason: rover.reason })),
    tiers: tierPlan.tiers.map((tier) => ({
      id: tier.id,
      altitudeM: tier.altitudeM,
      count: tier.count,
      bridgeCount: tier.bridgeCount,
      coveragePct: tier.coveragePct,
      footprintRadiusM: tier.footprintRadiusM,
      flatFootprintRadiusM: tier.flatFootprintRadiusM,
      connectedToBase: tier.connectedToBase,
      spofs: tier.spofs,
    })),
    cells: goal.cells,
    terrain: goal.terrain,
    terrainReason: goal.terrainReason,
    blockedCells: goal.cells.filter((cell) => cell.blockedByTerrain).length,
    geometricCoveragePct: goal.cells.length
      ? Math.round((goal.cells.filter((cell) => (cell.geometricCoveredBy ?? cell.coveredBy) >= 1).length / goal.cells.length) * 1000) / 10
      : 0,
    sampling: goal.sampling,
  };
  const tiers: OptionTier[] = tierPlan.tiers.map((tier) => ({
    id: tier.id,
    altitudeM: tier.altitudeM,
    count: tier.count + tier.bridgeCount,
    gravityMps2: gravityMax(planet, [tier.altitudeM]),
    stationFree: true,
    radioRangeM: tier.radioRangeM,
    coveragePct: tier.coveragePct,
  }));

  return {
    planetName: planet.name,
    option: {
      id: 'o1',
      pattern: 'cover-planet',
      mode: 'cover-planet',
      hullId: hull.id,
      count: positions.length,
      altitudeM: Math.round(mixedAltitudes.reduce((sum, value) => sum + value, 0) / Math.max(1, mixedAltitudes.length)),
      positions,
      links,
      spofs: goal.spofs,
      redundancyAchieved: goal.achievedK,
      coveragePct: goal.coveragePct,
      maxGapM,
      gravityAtSlotMps2: gravityMax(planet, mixedAltitudes),
      feasible,
      reasons,
      summary,
      labels: [...new Set([...labels, ...assignmentLabels(assignment)])],
      endurance,
      base: {
        x: add(planet.center, scale(normalize(centerDir ?? planetVec(planet)), planet.surfaceRadiusM + (input.base?.altitudeM ?? BASE_ALTITUDE_M))).x,
        y: add(planet.center, scale(normalize(centerDir ?? planetVec(planet)), planet.surfaceRadiusM + (input.base?.altitudeM ?? BASE_ALTITUDE_M))).y,
        z: add(planet.center, scale(normalize(centerDir ?? planetVec(planet)), planet.surfaceRadiusM + (input.base?.altitudeM ?? BASE_ALTITUDE_M))).z,
        altitudeM: input.base?.altitudeM ?? BASE_ALTITUDE_M,
      },
      tiers,
      assignment,
      coverage,
      slots: slotSpecs,
      spacingM: spacing.spacingM,
      minSpacingM: goal.minSpacingM,
      spacingRuleM: goal.spacingRuleM,
      meanSpacingM: goal.meanSpacingM,
      bunching: goal.bunching,
      spacingRelaxed: goal.spacingRelaxed,
      spacingRelaxedReason: goal.spacingRelaxedReason,
      overlapMetric: goal.overlapMetric,
      spareShips: goal.surplus,
      spareReason: goal.surplus.length ? `${goal.surplus.length} surplus ship(s)` : undefined,
      shipsRequested: goal.requestedCount,
      altitudeMode,
      countNeeded: goal.countNeeded,
      countUsed: goal.countUsed,
      uncoveredPct: goal.uncoveredPct,
      goal,
      alternatives: goal.alternatives,
      terrain: goal.terrain,
      blockedCells: goal.cells.filter((cell) => cell.blockedByTerrain).length,
    },
  };
}

function planetVec(planet: Planet): V3 {
  return v3(0, 1, 0);
}

/** Empty, infeasible option used when the primary hull cannot serve the mode. */
function emptyOption(
  hull: DesignerHull,
  planet: Planet,
  mode: 'layered' | 'cover-planet',
  reason: string,
): DesignerOption {
  return {
    id: 'o1',
    pattern: mode,
    mode,
    hullId: hull.id,
    count: 0,
    altitudeM: 0,
    positions: [],
    links: [],
    spofs: [],
    redundancyAchieved: 1,
    coveragePct: 0,
    maxGapM: 0,
    gravityAtSlotMps2: 0,
    feasible: false,
    reasons: [reason],
    summary: `${mode} infeasible: ${reason}.`,
    labels: ['SIMULATED', 'INFEASIBLE'],
    endurance: enduranceView(hull, planet, 0, 0),
  };
}

/** Dispatch used by `buildDesignerPlan`; throws for a non-mode call. */
export function buildRelayModeOption(
  input: DesignerPlanInput,
  hulls: DesignerHull[],
  planets: Planet[],
  integration: ModeIntegration,
): ModeBuildResult {
  if (input.mode === 'radio-chain') return buildRadioChainOption(input, hulls, planets, integration);
  if (input.mode === 'layered') return buildLayeredOption(input, hulls, planets, integration);
  if (input.mode === 'cover-planet') return buildCoverPlanetOption(input, hulls, planets, integration);
  throw new Error(`not a relay mode: ${input.mode}`);
}
