import { z } from 'zod';
import { SchemaVersion, Vec3Schema } from './common.js';

/**
 * Deterministic relay/network planner types. Everything here is pure data;
 * the planner has no side effects. Link-model assumptions are documented in
 * docs/reality-check.md and marked UNVERIFIED where the game is the authority.
 */

export const PlanetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  center: Vec3Schema,
  /** `MinimumSurfaceRadius` in metres (the deepest valley). */
  surfaceRadiusM: z.number().positive(),
  /** `MaximumHillRadius` in metres (the highest peak). */
  maxHillRadiusM: z.number().positive(),
  hasAtmosphere: z.boolean().default(true),
});
export type Planet = z.infer<typeof PlanetSchema>;

export const NodeTemplateSchema = z
  .object({
    id: z.string().min(1),
    radioRadiusM: z.number().positive().nullable().default(null),
    laserRangeM: z.number().positive().nullable().default(null),
    laserUnlimited: z.boolean().default(false),
  })
  .refine((t) => t.radioRadiusM !== null || t.laserRangeM !== null || t.laserUnlimited, {
    message: 'template needs a radio radius, a laser range, or unlimited laser',
  });
export type NodeTemplate = z.infer<typeof NodeTemplateSchema>;

export const NetworkNodeSchema = z.object({
  id: z.string().min(1),
  position: Vec3Schema,
  radioRadiusM: z.number().positive().nullable().default(null),
  laserRangeM: z.number().positive().nullable().default(null),
  laserUnlimited: z.boolean().default(false),
  controlSource: z.boolean().default(false),
});
export type NetworkNode = z.infer<typeof NetworkNodeSchema>;

export const LinkModelConfigSchema = z.object({
  /** Radio edges are directional: A can hear B without B hearing A. */
  radioDirectional: z.boolean().default(true),
  /**
   * Whether planets block radio. Default false: UNVERIFIED in-game, and the
   * conservative default is to over-connect rather than miss a link.
   */
  radioBlockedByPlanets: z.boolean().default(false),
  /** Laser pairs need line of sight; planets are spheres of max hill + margin. */
  laserBlockedByPlanets: z.boolean().default(true),
  /** Added to `maxHillRadiusM` when testing a blocking sphere. */
  planetMarginM: z.number().nonnegative().default(1000),
  /** Planner uses `radioRadiusM * safetyFactor` as the maximum gap. */
  spacingSafetyFactor: z.number().positive().max(1).default(0.9),
  /** Relay altitude above `maxHillRadiusM` for endpoints and waypoints. */
  minNodeAltitudeM: z.number().nonnegative().default(2000),
});
export type LinkModelConfig = z.infer<typeof LinkModelConfigSchema>;

export const LinkEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['radio', 'laser']),
  distanceM: z.number().nonnegative(),
});
export type LinkEdge = z.infer<typeof LinkEdgeSchema>;

export const LinkGraphSchema = z.object({
  schemaVersion: SchemaVersion,
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      controlSource: z.boolean(),
      reachable: z.boolean(),
    }),
  ),
  edges: z.array(LinkEdgeSchema),
  articulationPoints: z.array(z.string()),
  bridges: z.array(z.object({ a: z.string(), b: z.string() })),
  components: z.array(z.array(z.string())),
  config: LinkModelConfigSchema,
});
export type LinkGraph = z.infer<typeof LinkGraphSchema>;

export const WhatIfResultSchema = z.object({
  schemaVersion: SchemaVersion,
  removed: z.string().min(1),
  reachableBefore: z.array(z.string()),
  reachableAfter: z.array(z.string()),
  newlyIsolated: z.array(z.string()),
});
export type WhatIfResult = z.infer<typeof WhatIfResultSchema>;

export const ChainNodeSchema = z.object({
  id: z.string().min(1),
  position: Vec3Schema,
  kind: z.enum(['anchor', 'relay']),
  planet: z.string().nullable(),
});
export type ChainNode = z.infer<typeof ChainNodeSchema>;

export const ChainHopSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  distanceM: z.number().nonnegative(),
  losClear: z.boolean(),
});
export type ChainHop = z.infer<typeof ChainHopSchema>;

export const ChainCostSchema = z.object({
  perNodeCredits: z.number().nullable(),
  totalCredits: z.number().nullable(),
  note: z.string(),
});

export const ChainPlanSchema = z.object({
  schemaVersion: SchemaVersion,
  from: z.string().min(1),
  to: z.string().min(1),
  templateId: z.string().min(1),
  nodes: z.array(ChainNodeSchema),
  count: z.number().int().nonnegative(),
  relayCount: z.number().int().nonnegative(),
  hops: z.array(ChainHopSchema),
  spacingM: z.number().positive(),
  maxGapM: z.number().nonnegative(),
  totalDistanceM: z.number().nonnegative(),
  detour: z.boolean(),
  waypoints: z.array(Vec3Schema),
  blockedBy: z.array(z.string()),
  cost: ChainCostSchema,
});
export type ChainPlan = z.infer<typeof ChainPlanSchema>;

export const CoveragePlanSchema = z.object({
  schemaVersion: SchemaVersion,
  center: Vec3Schema,
  surfaceRadiusM: z.number().positive(),
  nodeAltitudeM: z.number().nonnegative(),
  templateId: z.string().min(1),
  requiredK: z.number().int().min(1).max(2),
  reuseExisting: z.boolean(),
  positions: z.array(z.object({ id: z.string().min(1), position: Vec3Schema })),
  count: z.number().int().nonnegative(),
  samples: z.number().int().nonnegative(),
  sampleCoverage: z.number().int().nonnegative(),
  uncoveredSamples: z.number().int().nonnegative(),
  existingCoverage: z.number().int().nonnegative(),
  cost: ChainCostSchema,
});
export type CoveragePlan = z.infer<typeof CoveragePlanSchema>;
