import type { CoveragePlan, LinkModelConfig, NetworkNode, NodeTemplate } from '@se-rts/schemas';
import { dist, fibonacciDirections, type V3 } from './geometry.js';
import { resolveConfig } from './graph.js';

export interface CoverageRegion {
  id?: string;
  center: V3;
  surfaceRadiusM: number;
}

export interface CoverageOptions {
  /** 1 = at least one node sees every sample; 2 = two independent nodes. */
  k?: 1 | 2;
  /** Node altitude above the region surface. Defaults to config minimum. */
  altitudeM?: number;
  reuseExisting?: NetworkNode[];
  sampleCount?: number;
  config?: Partial<LinkModelConfig>;
  /** Required when the template is a laser with unlimited range and no radio. */
  maxSpacingM?: number;
}

export function planetRegion(planet: { name: string; center: V3; maxHillRadiusM: number }): CoverageRegion {
  return { id: planet.name, center: planet.center, surfaceRadiusM: planet.maxHillRadiusM };
}

const COST_NOTE = 'cost model placeholder: node build/launch price is not modelled yet';

function rangeOf(template: NodeTemplate, options: CoverageOptions): number {
  if (template.radioRadiusM !== null) return template.radioRadiusM;
  if (template.laserRangeM !== null) return template.laserRangeM;
  if (options.maxSpacingM !== undefined) return options.maxSpacingM;
  throw new Error(`template ${template.id} has unlimited laser range; pass maxSpacingM`);
}

/** Angular cap a node at radius `nodeRadius` covers on a sphere `surface`. */
export function coverageAngle(surfaceRadiusM: number, nodeRadiusM: number, rangeM: number): number {
  if (rangeM <= 0 || nodeRadiusM <= surfaceRadiusM) return 0;
  const cosPhi =
    (nodeRadiusM * nodeRadiusM + surfaceRadiusM * surfaceRadiusM - rangeM * rangeM) /
    (2 * nodeRadiusM * surfaceRadiusM);
  if (cosPhi >= 1) return 0;
  if (cosPhi <= -1) return Math.PI;
  return Math.acos(cosPhi);
}

/**
 * Deterministic coverage placement on a spherical shell. Samples are a
 * Fibonacci sphere; candidates are a denser Fibonacci sphere; a greedy set
 * cover picks nodes until every sample is seen by `k` nodes. Existing nodes
 * count toward coverage first when `reuseExisting` is supplied.
 */
export function planCoverage(
  region: CoverageRegion,
  template: NodeTemplate,
  options: CoverageOptions = {},
): CoveragePlan {
  const config = resolveConfig(options.config);
  const k = options.k ?? 1;
  const range = rangeOf(template, options);
  const altitude = Math.max(options.altitudeM ?? config.minNodeAltitudeM, config.minNodeAltitudeM);
  const surface = region.surfaceRadiusM;
  const nodeRadius = surface + altitude;
  const phi = coverageAngle(surface, nodeRadius, range);

  const estimate = phi > 0 ? Math.ceil(2 / (1 - Math.cos(phi))) : 0;
  const sampleCount = options.sampleCount ?? Math.max(1024, Math.min(20000, estimate * 4));
  const candidateCount = Math.max(64, Math.min(20000, Math.ceil(Math.max(estimate, 1) * 2)));

  const sampleDirs = fibonacciDirections(sampleCount);
  const samplePoints = sampleDirs.map((d) => ({
    x: region.center.x + d.x * surface,
    y: region.center.y + d.y * surface,
    z: region.center.z + d.z * surface,
  }));

  const counts = new Array<number>(samplePoints.length).fill(0);
  let existingCoverage = 0;
  for (const node of options.reuseExisting ?? []) {
    const nodeRange = node.laserUnlimited
      ? Number.POSITIVE_INFINITY
      : node.radioRadiusM ?? node.laserRangeM ?? 0;
    for (let i = 0; i < samplePoints.length; i += 1) {
      if (counts[i]! < k && dist(node.position, samplePoints[i]!) <= nodeRange) counts[i] = counts[i]! + 1;
    }
  }
  for (const c of counts) if (c >= k) existingCoverage += 1;

  // Candidate -> samples it can see (O(candidates * samples), built once).
  const candDirs = fibonacciDirections(candidateCount);
  const coverageLists: number[][] = candDirs.map((d) => {
    const p = {
      x: region.center.x + d.x * nodeRadius,
      y: region.center.y + d.y * nodeRadius,
      z: region.center.z + d.z * nodeRadius,
    };
    const list: number[] = [];
    for (let i = 0; i < samplePoints.length; i += 1) {
      if (dist(p, samplePoints[i]!) <= range) list.push(i);
    }
    return list;
  });

  const selected: number[] = [];
  const used = new Set<number>();
  let covered = existingCoverage;
  const total = samplePoints.length;

  while (covered < total) {
    let best = -1;
    let bestGain = 0;
    for (let c = 0; c < coverageLists.length; c += 1) {
      if (used.has(c)) continue;
      let gain = 0;
      for (const sampleIndex of coverageLists[c]!) {
        if (counts[sampleIndex]! < k) gain += 1;
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = c;
      }
    }
    if (best < 0 || bestGain === 0) break;
    used.add(best);
    selected.push(best);
    for (const sampleIndex of coverageLists[best]!) {
      if (counts[sampleIndex]! < k) {
        counts[sampleIndex] = counts[sampleIndex]! + 1;
        if (counts[sampleIndex] === k) covered += 1;
      }
    }
  }

  const positions = selected.map((c, index) => ({
    id: `cov-${index}`,
    position: {
      x: region.center.x + candDirs[c]!.x * nodeRadius,
      y: region.center.y + candDirs[c]!.y * nodeRadius,
      z: region.center.z + candDirs[c]!.z * nodeRadius,
    },
  }));

  return {
    schemaVersion: 1,
    center: region.center,
    surfaceRadiusM: surface,
    nodeAltitudeM: altitude,
    templateId: template.id,
    requiredK: k,
    reuseExisting: (options.reuseExisting?.length ?? 0) > 0,
    positions,
    count: positions.length,
    samples: total,
    sampleCoverage: covered,
    uncoveredSamples: total - covered,
    existingCoverage,
    cost: { perNodeCredits: null, totalCredits: null, note: COST_NOTE },
  };
}
