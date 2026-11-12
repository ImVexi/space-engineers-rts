/**
 * Relay-layer geometry for the T16/T17 planner modes.
 *
 * Pure geometry: the caller supplies the measured radio range, the zero-g
 * altitude and the atmosphere ceiling, so this module has no dependency on the
 * demo hull catalog or the game. Every position is planner math (SIMULATED):
 *
 *   * `planRadioChain`  — a radio-only "station in the sky": the first node is
 *     placed so the radial gap from the base stays inside `0.9 * radio`, then
 *     the chain climbs in hops of at most the same length until it reaches the
 *     zero-g altitude; an optional extension continues horizontally at zero-g.
 *   * `planLayered`     — atmo/station tier, H2 station tier, zero-g bridge.
 *
 * Hops are measured as straight-line 3D distances (the radio model has no
 * terrain: a hop through the planet is reported as blocked, not hidden).
 */
import type { Planet } from '@se-rts/schemas';
import { add, anyPerpendicular, cross, dist, dot, normalize, scale, sub, v3, type V3 } from './geometry.js';

export type RelayTier = 'atmo' | 'in-gravity' | 'zero-g';

export interface RelayNode {
  id: string;
  position: V3;
  /** Altitude above `planet.surfaceRadiusM` (AGL over the minimum surface). */
  altitudeM: number;
  tier: RelayTier;
  /** Distance to the previous node in the chain; null for the first node. */
  linkToPreviousM: number | null;
  /** True when the node sits inside gravity: hover costs fuel unless stationed. */
  stationPreferred: boolean;
  role: 'relay' | 'apex' | 'bridge';
  latDeg: number;
  lonDeg: number;
}

export interface RelayHop {
  from: string;
  to: string;
  lengthM: number;
  withinLimit: boolean;
}

export interface SkyCoverage {
  /** Fraction (0..1) of the surface seen by at least `k` nodes. */
  fraction: number;
  coveragePct: number;
  /** Footprint radius of one node at its own altitude (metres, flat approx). */
  footprintRadiusM: number;
  samples: number;
  coveredSamples: number;
}

export interface RadioChainPlan {
  kind: 'radio-chain';
  planet: string;
  base: { position: V3; altitudeM: number };
  nodes: RelayNode[];
  hops: RelayHop[];
  count: number;
  /** Effective hop ceiling: min(requested max hop, margin * radio). */
  hopLimitM: number;
  radioRangeM: number;
  rangeMargin: number;
  maxHopM: number;
  firstHopM: number | null;
  baseLinked: boolean;
  reachesZeroG: boolean;
  zeroGAltitudeM: number;
  atmoCeilingM: number;
  maxGapM: number;
  climbingM: number;
  coverage: SkyCoverage;
  warnings: string[];
  reasons: string[];
}

export interface RadioChainOptions {
  radioRangeM: number;
  /** Zero-g boundary for this planet, metres AGL (from the gravity model). */
  zeroGAltitudeM: number;
  /** Hard atmo ceiling for tier labels/hull hints (default 10,000 m). */
  atmoCeilingM?: number;
  /** Base (ground station) altitude, default BASE-01 at 1,800 m AGL. */
  baseAltitudeM?: number;
  /** Radial direction of the base from the planet centre; default +Y. */
  baseDirection?: V3;
  /** Requested hop ceiling, default 45,000 m (T16). */
  maxHopM?: number;
  /** Range safety margin, default 0.9. */
  rangeMargin?: number;
  /** Keep the first hop on the base (default true, T16 default). */
  keepFirstHopOnBase?: boolean;
  /** Horizontal extension at zero-g, metres (default 0 = pure climb). */
  reachM?: number;
  /** Bearing of the horizontal extension, degrees clockwise from the base normal. */
  bearingDeg?: number;
}

const DEFAULT_BASE_ALTITUDE_M = 1_800;
const DEFAULT_MAX_HOP_M = 45_000;
const DEFAULT_ATMO_CEILING_M = 10_000;

function unitFrom(planet: Planet, direction?: V3): V3 {
  const raw = direction ? sub(direction, planet.center) : v3(0, 1, 0);
  const unit = normalize(raw);
  return Math.hypot(unit.x, unit.y, unit.z) > 0 ? unit : v3(0, 1, 0);
}

export function altitudeOf(planet: Planet, position: V3): number {
  return Math.hypot(position.x - planet.center.x, position.y - planet.center.y, position.z - planet.center.z) - planet.surfaceRadiusM;
}

export function latLonOf(planet: Planet, position: V3): { latDeg: number; lonDeg: number } {
  const d = normalize(sub(position, planet.center));
  return {
    latDeg: Math.round((Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI * 10) / 10,
    lonDeg: Math.round(((Math.atan2(d.z, d.x) * 180) / Math.PI) * 10) / 10,
  };
}

/** Rotate `dir` around `axis` by `angle` radians (Rodrigues, axis unit). */
function rotate(dir: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(dir, c), scale(cross(axis, dir), s)), scale(axis, dot(axis, dir) * (1 - c)));
}

/** Rotate a radial direction along a great circle by `angle` radians. */
function arcDirection(dir: V3, angle: number, bearingDeg: number): V3 {
  if (angle === 0) return dir;
  const reference = Math.abs(dir.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
  const axis = normalize(cross(dir, reference));
  const safeAxis = Math.hypot(axis.x, axis.y, axis.z) > 0 ? axis : anyPerpendicular(dir);
  const sign = bearingDeg < 0 ? -1 : 1;
  return normalize(rotate(dir, safeAxis, Math.abs(angle) * sign));
}

/** Great-circle angle whose chord at `radiusM` is `chordM`. */
function angleForChord(chordM: number, radiusM: number): number {
  if (radiusM <= 0 || chordM <= 0) return 0;
  return 2 * Math.asin(Math.min(1, chordM / (2 * radiusM)));
}

function pointAt(planet: Planet, dir: V3, altitudeM: number): V3 {
  return add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM));
}

function tierOf(altitudeM: number, zeroGAltitudeM: number, atmoCeilingM: number): RelayTier {
  if (zeroGAltitudeM > 0 && altitudeM >= zeroGAltitudeM) return 'zero-g';
  if (altitudeM <= atmoCeilingM) return 'atmo';
  return 'in-gravity';
}

function hopLimitOf(options: RadioChainOptions): number {
  const margin = options.rangeMargin ?? 0.9;
  const requested = options.maxHopM ?? DEFAULT_MAX_HOP_M;
  return Math.max(1, Math.min(requested, options.radioRangeM * margin));
}

function toNode(
  planet: Planet,
  id: string,
  position: V3,
  linkToPreviousM: number | null,
  role: RelayNode['role'],
  zeroGAltitudeM: number,
  atmoCeilingM: number,
): RelayNode {
  const altitudeM = Math.round(altitudeOf(planet, position) * 10) / 10;
  const { latDeg, lonDeg } = latLonOf(planet, position);
  return {
    id,
    position,
    altitudeM,
    tier: tierOf(altitudeM, zeroGAltitudeM, atmoCeilingM),
    linkToPreviousM: linkToPreviousM === null ? null : Math.round(linkToPreviousM * 10) / 10,
    stationPreferred: !(zeroGAltitudeM > 0 && altitudeM >= zeroGAltitudeM),
    role,
    latDeg,
    lonDeg,
  };
}

function hopsFor(nodes: RelayNode[], limit: number): RelayHop[] {
  const out: RelayHop[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const lengthM = dist(a.position, b.position);
    out.push({ from: a.id, to: b.id, lengthM: Math.round(lengthM * 10) / 10, withinLimit: lengthM <= limit + 0.5 });
  }
  return out;
}

/**
 * Fraction of the sphere seen by at least `k` of the nodes. Each node's cap is
 * computed from its own radius, so a mixed-altitude chain is handled exactly
 * (still a pure line-of-sight model: terrain is not modelled).
 */
export function skyCoverage(
  planet: Pick<Planet, 'center' | 'surfaceRadiusM'>,
  nodes: { position: V3 }[],
  rangeM: number,
  k: 1 | 2 = 1,
  sampleCount = 1_200,
): SkyCoverage {
  const surface = planet.surfaceRadiusM;
  const golden = Math.PI * (3 - Math.sqrt(5));
  let covered = 0;
  let bestFootprint = 0;
  const caps = nodes.map((node) => {
    const rn = dist(planet.center, node.position);
    const usable = rangeM * 1;
    if (rangeM <= 0 || rn <= surface) return null;
    const cosPhi = (rn * rn + surface * surface - usable * usable) / (2 * rn * surface);
    if (cosPhi >= 1) return null;
    const phi = cosPhi <= -1 ? Math.PI : Math.acos(cosPhi);
    bestFootprint = Math.max(bestFootprint, Math.sqrt(Math.max(0, rangeM * rangeM - Math.pow(rn - surface, 2))));
    return {
      dir: normalize(sub(node.position, planet.center)),
      cosPhi: Math.cos(phi),
    };
  });
  for (let i = 0; i < sampleCount; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / sampleCount;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const d = v3(Math.cos(theta) * r, y, Math.sin(theta) * r);
    let count = 0;
    for (const cap of caps) {
      if (cap && dot(cap.dir, d) >= cap.cosPhi) {
        count += 1;
        if (count >= k) break;
      }
    }
    if (count >= k) covered += 1;
  }
  return {
    fraction: sampleCount > 0 ? covered / sampleCount : 0,
    coveragePct: Math.round((sampleCount > 0 ? (covered / sampleCount) * 100 : 0) * 10) / 10,
    footprintRadiusM: Math.round(bestFootprint),
    samples: sampleCount,
    coveredSamples: covered,
  };
}

/**
 * Radio-only chain from a base station up to the zero-g altitude (T16).
 *
 * The first node's altitude is chosen so that the radial gap from the base is
 * at most the hop limit, and every following hop is at most the same length.
 * With a 50 km radio and a 0.9 margin the hop limit is 45 km, so a base at
 * 1.8 km reaches the 43.7 km zero-g edge in a single node — the chain only grows
 * when the radio is shorter or the zero-g altitude is higher.
 */
export function planRadioChain(planet: Planet, options: RadioChainOptions): RadioChainPlan {
  const margin = options.rangeMargin ?? 0.9;
  const hopLimit = hopLimitOf(options);
  const baseAltitudeM = options.baseAltitudeM ?? DEFAULT_BASE_ALTITUDE_M;
  const atmoCeilingM = options.atmoCeilingM ?? DEFAULT_ATMO_CEILING_M;
  const zeroGAltitudeM = Math.max(0, options.zeroGAltitudeM);
  const dir = unitFrom(planet, options.baseDirection);
  const basePos = pointAt(planet, dir, baseAltitudeM);
  const warnings: string[] = [];
  const reasons: string[] = [];

  const climbTo = Math.max(baseAltitudeM, zeroGAltitudeM);
  const climbM = Math.max(0, climbTo - baseAltitudeM);
  const keepOnBase = options.keepFirstHopOnBase ?? true;

  const nodes: RelayNode[] = [];
  if (keepOnBase) {
    const steps = climbM <= hopLimit ? 1 : Math.ceil(climbM / hopLimit);
    for (let i = 1; i <= steps; i += 1) {
      const altitudeM = i === steps ? climbTo : baseAltitudeM + (climbM * i) / steps;
      const position = pointAt(planet, dir, altitudeM);
      const previous = nodes.length ? nodes[nodes.length - 1]! : null;
      const link = previous ? dist(previous.position, position) : dist(basePos, position);
      nodes.push(
        toNode(planet, `r${i}`, position, link, i === steps && climbM > 0 ? 'apex' : 'relay', zeroGAltitudeM, atmoCeilingM),
      );
    }
  } else {
    // Sky-start variant: the first node is displaced horizontally by one hop so
    // the base link is no longer part of the chain (it is reported separately).
    const startRadius = planet.surfaceRadiusM + climbTo;
    const startDir = arcDirection(dir, angleForChord(hopLimit, startRadius), options.bearingDeg ?? 0);
    const position = pointAt(planet, startDir, climbTo);
    nodes.push(toNode(planet, 'r1', position, dist(basePos, position), 'apex', zeroGAltitudeM, atmoCeilingM));
  }

  const reachM = Math.max(0, options.reachM ?? 0);
  if (reachM > 0) {
    const apex = nodes[nodes.length - 1]!;
    const apexDir = normalize(sub(apex.position, planet.center));
    const apexRadius = planet.surfaceRadiusM + apex.altitudeM;
    // `reachM` is measured along the shell at the apex altitude.
    const totalAngle = reachM / apexRadius;
    const stepAngle = angleForChord(hopLimit, apexRadius);
    const steps = Math.max(1, Math.ceil(totalAngle / Math.max(1e-6, stepAngle)));
    let previous = apex;
    for (let i = 1; i <= steps; i += 1) {
      const angle = (totalAngle * i) / steps;
      const position = pointAt(planet, arcDirection(apexDir, angle, options.bearingDeg ?? 0), apex.altitudeM);
      const link = dist(previous.position, position);
      const node = toNode(planet, `x${i}`, position, link, 'relay', zeroGAltitudeM, atmoCeilingM);
      nodes.push(node);
      previous = node;
    }
  }

  const hops = hopsFor(nodes, hopLimit);
  const firstHopM = nodes.length ? Math.round(dist(basePos, nodes[0]!.position) * 10) / 10 : null;
  const baseLinked = keepOnBase ? nodes.length > 0 : firstHopM !== null && firstHopM <= hopLimit + 0.5;
  if (!nodes.length) reasons.push('the chain has no nodes: the base is already at or above the zero-g altitude');
  if (keepOnBase && nodes.length && !baseLinked) {
    reasons.push(
      `the first node is ${((firstHopM ?? 0) / 1000).toFixed(1)} km from the base, beyond the ${(hopLimit / 1000).toFixed(1)} km hop limit`,
    );
  }
  if (!keepOnBase && !baseLinked) {
    reasons.push(
      `keepFirstHopOnBase is off: the sky-start node is ${((firstHopM ?? 0) / 1000).toFixed(1)} km from the base, beyond the hop limit`,
    );
  }
  const badHops = hops.filter((h) => !h.withinLimit);
  if (badHops.length) {
    reasons.push(`${badHops.length} hop(s) exceed ${(hopLimit / 1000).toFixed(1)} km`);
  }
  const reachesZeroG =
    zeroGAltitudeM === 0 || nodes.some((n) => n.altitudeM >= zeroGAltitudeM - 0.5) || climbM === 0;
  if (!reachesZeroG) {
    reasons.push(
      `the chain tops out at ${(Math.max(...nodes.map((n) => n.altitudeM), 0) / 1000).toFixed(1)} km, below the ${(zeroGAltitudeM / 1000).toFixed(1)} km zero-g edge`,
    );
  }
  const maxGapM = hops.reduce((max, h) => Math.max(max, h.lengthM), 0);
  for (const node of nodes) {
    if (node.stationPreferred) {
      warnings.push(
        `node ${node.id} at ${(node.altitudeM / 1000).toFixed(1)} km is inside gravity: it must hover (fuel/power) or be stationed (free hold, T18)`,
      );
    }
  }
  if (firstHopM !== null && firstHopM > 0) {
    if (!(firstHopM <= hopLimit + 0.5) && keepOnBase) {
      warnings.push('the base link is longer than one hop; add a relay or raise the base antenna range');
    }
  }
  if (zeroGAltitudeM === 0) {
    warnings.push('this planet has no atmosphere and no zero-g edge above the surface; every tier is free-hold only when stationed');
  }
  const nodePositions = nodes.map((n) => ({ position: n.position }));
  // T28: the coverage footprint uses the measured range; the margin applies to links.
  const coverage = skyCoverage(planet, nodePositions, options.radioRangeM, 1);

  return {
    kind: 'radio-chain',
    planet: planet.name,
    base: { position: basePos, altitudeM: baseAltitudeM },
    nodes,
    hops,
    count: nodes.length,
    hopLimitM: Math.round(hopLimit * 10) / 10,
    radioRangeM: options.radioRangeM,
    rangeMargin: margin,
    maxHopM: options.maxHopM ?? DEFAULT_MAX_HOP_M,
    firstHopM,
    baseLinked,
    reachesZeroG,
    zeroGAltitudeM,
    atmoCeilingM,
    maxGapM: Math.round(maxGapM * 10) / 10,
    climbingM: Math.round(climbM * 10) / 10,
    coverage,
    warnings,
    reasons,
  };
}

export interface LayeredTier {
  id: 'atmo' | 'h2' | 'zero-g';
  altitudeM: number;
  /** Hull class this tier exists for; informational for the assignment. */
  hullHint: 'atmo' | 'h2' | 'any';
  stationFree: boolean;
  gravityMps2: number;
  count: number;
  nodes: RelayNode[];
  coverage: SkyCoverage;
}

export interface LayeredPlan {
  kind: 'layered';
  planet: string;
  base: { position: V3; altitudeM: number };
  tiers: LayeredTier[];
  nodes: RelayNode[];
  hops: RelayHop[];
  links: { a: string; b: string; lengthM: number }[];
  count: number;
  hopLimitM: number;
  radioRangeM: number;
  rangeMargin: number;
  maxGapM: number;
  connected: boolean;
  zeroGAltitudeM: number;
  atmoCeilingM: number;
  coveragePct: number;
  warnings: string[];
  reasons: string[];
}

export interface LayeredOptions {
  radioRangeM: number;
  zeroGAltitudeM: number;
  atmoCeilingM?: number;
  baseAltitudeM?: number;
  baseDirection?: V3;
  maxHopM?: number;
  rangeMargin?: number;
  atmoAltitudeM?: number;
  atmoCount?: number;
  h2AltitudeM?: number;
  h2Count?: number;
  zeroGCount?: number;
  /** Gravity at an altitude, for tier reporting (caller's verified model). */
  gravityAtAltitudeMps2?: (altitudeM: number) => number;
  /**
   * Build a horizontal ring at a tier. When false every tier is a single
   * vertical spine (cheapest, still a valid chain).
   */
  rings?: boolean;
}

/**
 * Ring placement angle (radians) so consecutive nodes at `radiusM` are within
 * the hop limit (including the vertical gap to the tier below) and the ring
 * stays within a 30 km ground radius.
 */
function ringAngleFor(count: number, hopLimitM: number, verticalGapM: number, radiusM: number): number {
  if (count < 2 || radiusM <= 0) return 0;
  const chordLimit = Math.min(hopLimitM, Math.sqrt(Math.max(0, hopLimitM * hopLimitM - verticalGapM * verticalGapM)));
  const ringChordLimit = 2 * radiusM * Math.sin(Math.PI / count);
  const chord = Math.min(chordLimit, ringChordLimit);
  return Math.min(2 * Math.asin(Math.min(1, chord / (2 * radiusM))), 30_000 / radiusM);
}

/**
 * Layered network (T17): an atmo/station tier, an H2 station tier and a zero-g
 * bridge. Each tier is a horizontal ring (or a single node when `rings` is
 * false); every hop is at most the radio hop limit, and the base is part of the
 * link graph so the whole network must stay attached to it.
 */
export function planLayered(planet: Planet, options: LayeredOptions): LayeredPlan {
  const margin = options.rangeMargin ?? 0.9;
  const hopLimit = hopLimitOf(options);
  const baseAltitudeM = options.baseAltitudeM ?? DEFAULT_BASE_ALTITUDE_M;
  const atmoCeilingM = options.atmoCeilingM ?? DEFAULT_ATMO_CEILING_M;
  const zeroG = Math.max(0, options.zeroGAltitudeM);
  const dir = unitFrom(planet, options.baseDirection);
  const basePos = pointAt(planet, dir, baseAltitudeM);
  const rings = options.rings ?? true;
  const gravityAt = options.gravityAtAltitudeMps2 ?? (() => 0);
  const warnings: string[] = [];
  const reasons: string[] = [];

  const atmoAltitude = Math.max(100, Math.min(options.atmoAltitudeM ?? 8_000, atmoCeilingM));
  const h2Altitude = Math.max(atmoAltitude + 100, options.h2AltitudeM ?? 15_000);
  const zeroGAltitude = Math.max(h2Altitude + 100, zeroG > 0 ? zeroG : 45_000, 45_000);

  const tiers: LayeredTier[] = [];
  const allNodes: RelayNode[] = [];
  const makeTier = (
    id: LayeredTier['id'],
    altitudeM: number,
    count: number,
    hullHint: LayeredTier['hullHint'],
    verticalGapM: number,
    startId: number,
  ): void => {
    const n = rings ? Math.max(1, Math.round(count)) : 1;
    const radius = planet.surfaceRadiusM + altitudeM;
    const ringAngle = rings ? ringAngleFor(n, hopLimit, verticalGapM, radius) : 0;
    const nodes: RelayNode[] = [];
    for (let i = 0; i < n; i += 1) {
      const bearingDeg = (360 * i) / Math.max(1, n);
      const nodeDir = ringAngle === 0 ? dir : arcDirection(dir, ringAngle, bearingDeg);
      const nodePos = pointAt(planet, nodeDir, altitudeM);
      const previous = nodes[nodes.length - 1] ?? null;
      const link = previous ? dist(previous.position, nodePos) : null;
      nodes.push(toNode(planet, `t${startId + i + 1}`, nodePos, link, 'relay', zeroG, atmoCeilingM));
    }
    // The first node of a ring has no in-tier predecessor; the spine hops are
    // reported separately below.
    const coverage = skyCoverage(
      planet,
      nodes.map((node) => ({ position: node.position })),
      options.radioRangeM,
      1,
    );
    tiers.push({
      id,
      altitudeM: Math.round(altitudeM),
      hullHint,
      // A station is free at any altitude (T18); zero-g needs no station at all.
      stationFree: true,
      gravityMps2: Math.round(gravityAt(altitudeM) * 1000) / 1000,
      count: nodes.length,
      nodes,
      coverage,
    });
    allNodes.push(...nodes);
  };

  makeTier('atmo', atmoAltitude, options.atmoCount ?? 3, 'atmo', 0, 0);
  makeTier('h2', h2Altitude, options.h2Count ?? 1, 'h2', h2Altitude - atmoAltitude, 100);
  makeTier('zero-g', zeroGAltitude, options.zeroGCount ?? 4, 'any', zeroGAltitude - h2Altitude, 200);

  const positions = [{ id: 'base', position: basePos }, ...allNodes.map((n) => ({ id: n.id, position: n.position }))];
  const links: { a: string; b: string; lengthM: number }[] = [];
  const adjacency = new Map<string, Set<string>>(positions.map((p) => [p.id, new Set<string>()]));
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i]!;
      const b = positions[j]!;
      const lengthM = dist(a.position, b.position);
      if (lengthM <= hopLimit + 0.5) {
        links.push({ a: a.id, b: b.id, lengthM: Math.round(lengthM * 10) / 10 });
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
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
  const orphaned = positions.filter((p) => !seen.has(p.id)).map((p) => p.id);
  const connected = orphaned.length === 0;
  if (!connected) {
    reasons.push(
      `${orphaned.length} node(s) are not linked to the base within ${(hopLimit / 1000).toFixed(1)} km: ${orphaned.slice(0, 6).join(', ')}`,
    );
  }
  const hops: RelayHop[] = [];
  const addHop = (fromId: string, fromPos: V3, toId: string, toPos: V3): void => {
    const lengthM = dist(fromPos, toPos);
    hops.push({
      from: fromId,
      to: toId,
      lengthM: Math.round(lengthM * 10) / 10,
      withinLimit: lengthM <= hopLimit + 0.5,
    });
  };
  const firstAtmo = tiers[0]?.nodes[0];
  if (firstAtmo) addHop('base', basePos, firstAtmo.id, firstAtmo.position);
  for (let t = 0; t < tiers.length; t += 1) {
    const tier = tiers[t]!;
    for (let i = 1; i < tier.nodes.length; i += 1) {
      addHop(tier.nodes[i - 1]!.id, tier.nodes[i - 1]!.position, tier.nodes[i]!.id, tier.nodes[i]!.position);
    }
    const nextTier = tiers[t + 1];
    if (nextTier?.nodes[0]) {
      addHop(tier.nodes[0]!.id, tier.nodes[0]!.position, nextTier.nodes[0]!.id, nextTier.nodes[0]!.position);
    }
  }
  const badHops = hops.filter((h) => !h.withinLimit);
  if (badHops.length) reasons.push(`${badHops.length} tier hop(s) exceed ${(hopLimit / 1000).toFixed(1)} km`);
  const maxGapM = links.reduce((max, l) => Math.max(max, l.lengthM), 0);
  for (const tier of tiers) {
    if (tier.id === 'zero-g') continue;
    warnings.push(
      `${tier.id} tier at ${(tier.altitudeM / 1000).toFixed(1)} km: hover costs fuel unless stationed; convert_to_station makes the hold free (T18)`,
    );
  }
  if (zeroGAltitude - h2Altitude > hopLimit) {
    warnings.push(
      `the zero-g bridge spans ${((zeroGAltitude - h2Altitude) / 1000).toFixed(1)} km, more than one hop; add an intermediate H2 station`,
    );
  }
  const coverage = skyCoverage(
    planet,
    allNodes.map((node) => ({ position: node.position })),
    options.radioRangeM,
    1,
  );
  if (!allNodes.length) reasons.push('the layered plan has no nodes');

  return {
    kind: 'layered',
    planet: planet.name,
    base: { position: basePos, altitudeM: baseAltitudeM },
    tiers,
    nodes: allNodes,
    hops,
    links,
    count: allNodes.length,
    hopLimitM: Math.round(hopLimit * 10) / 10,
    radioRangeM: options.radioRangeM,
    rangeMargin: margin,
    maxGapM: Math.round(maxGapM * 10) / 10,
    connected,
    zeroGAltitudeM: zeroG,
    atmoCeilingM,
    coveragePct: coverage.coveragePct,
    warnings,
    reasons,
  };
}
