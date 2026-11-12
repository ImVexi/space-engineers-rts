import type { ChainPlan, LinkModelConfig, NodeTemplate, Planet } from '@se-rts/schemas';
import { arcAroundSphere, dist, lerp, segmentIntersectsSphere, type V3 } from './geometry.js';
import { resolveConfig } from './graph.js';

export interface ChainOptions {
  config?: Partial<LinkModelConfig>;
  /** Required only for a laser-only template that declares unlimited range. */
  maxSpacingM?: number;
  /** Full planet catalog; blockers not in this list cannot be routed around. */
  planets?: Planet[];
}

export function maxSpacing(template: NodeTemplate, safetyFactor = 0.9): number {
  if (template.radioRadiusM !== null) return template.radioRadiusM * safetyFactor;
  if (template.laserRangeM !== null) return template.laserRangeM * safetyFactor;
  throw new Error(`template ${template.id} has unlimited laser range; pass an explicit spacing`);
}

/**
 * Minimum node count for a straight chain with fixed endpoints:
 * `ceil(distance / spacing) + 1` (both anchors included).
 */
export function minimumChainNodes(distanceM: number, spacingM: number): number {
  if (spacingM <= 0) throw new Error('spacing must be positive');
  return Math.max(2, Math.ceil(distanceM / spacingM) + 1);
}

const COST_NOTE = 'cost model placeholder: node build/launch price is not modelled yet';

export function planChain(
  from: Planet,
  to: Planet,
  template: NodeTemplate,
  options: ChainOptions = {},
): ChainPlan {
  const config = resolveConfig(options.config);
  const spacing =
    options.maxSpacingM !== undefined
      ? options.maxSpacingM
      : maxSpacing(template, config.spacingSafetyFactor);
  if (!(spacing > 0)) throw new Error('max spacing must be positive');

  const catalog = options.planets ?? [from, to];
  const blockers = catalog.filter((p) => p.id !== from.id && p.id !== to.id && p.name !== from.name && p.name !== to.name);

  const anchorFrom = addAnchor(from, to.center, config.minNodeAltitudeM);
  const anchorTo = addAnchor(to, from.center, config.minNodeAltitudeM);

  const blockedBy = new Set<string>();
  const waypoints: V3[] = [];
  let vertices: V3[] = [anchorFrom, anchorTo];

  // Route around any planet whose blocking sphere the current polyline crosses.
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let hit: { index: number; planet: Planet } | null = null;
    for (let i = 0; i + 1 < vertices.length && !hit; i += 1) {
      const a = vertices[i]!;
      const b = vertices[i + 1]!;
      for (const planet of blockers) {
        const radius = planet.maxHillRadiusM + config.planetMarginM;
        if (segmentIntersectsSphere(a, b, planet.center, radius)) {
          hit = { index: i, planet };
          break;
        }
      }
    }
    if (!hit) break;
    const a = vertices[hit.index]!;
    const b = vertices[hit.index + 1]!;
    const radius = hit.planet.maxHillRadiusM + config.planetMarginM;
    const arc = arcAroundSphere(a, b, hit.planet.center, radius, config.minNodeAltitudeM, spacing);
    vertices.splice(hit.index + 1, 0, ...arc);
    waypoints.push(...arc);
    blockedBy.add(hit.planet.name);
  }

  // Resample the polyline so every consecutive pair is within `spacing`.
  const positions: V3[] = [vertices[0]!];
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const length = dist(a, b);
    if (length < 1e-6) continue;
    const hops = Math.max(1, Math.ceil(length / spacing));
    for (let h = 1; h <= hops; h += 1) positions.push(lerp(a, b, h / hops));
  }

  const nodes = positions.map((position, index) => ({
    id: `node-${index}`,
    position,
    kind: index === 0 || index === positions.length - 1 ? ('anchor' as const) : ('relay' as const),
    planet: index === 0 ? from.name : index === positions.length - 1 ? to.name : null,
  }));

  const hops = nodes.slice(0, -1).map((node, i) => {
    const next = nodes[i + 1]!;
    const d = dist(node.position, next.position);
    const losClear = catalog.every(
      (p) => !segmentIntersectsSphere(node.position, next.position, p.center, p.maxHillRadiusM + config.planetMarginM),
    );
    return { from: node.id, to: next.id, distanceM: d, losClear };
  });

  const totalDistanceM = hops.reduce((sum, h) => sum + h.distanceM, 0);
  const maxGapM = hops.reduce((max, h) => Math.max(max, h.distanceM), 0);

  return {
    schemaVersion: 1,
    from: from.name,
    to: to.name,
    templateId: template.id,
    nodes,
    count: nodes.length,
    relayCount: Math.max(0, nodes.length - 2),
    hops,
    spacingM: spacing,
    maxGapM,
    totalDistanceM,
    detour: blockedBy.size > 0,
    waypoints,
    blockedBy: [...blockedBy].sort(),
    cost: { perNodeCredits: null, totalCredits: null, note: COST_NOTE },
  };
}

function addAnchor(planet: Planet, toward: V3, altitudeM: number): V3 {
  const dx = toward.x - planet.center.x;
  const dy = toward.y - planet.center.y;
  const dz = toward.z - planet.center.z;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const radius = planet.maxHillRadiusM + altitudeM;
  return {
    x: planet.center.x + (dx / l) * radius,
    y: planet.center.y + (dy / l) * radius,
    z: planet.center.z + (dz / l) * radius,
  };
}
