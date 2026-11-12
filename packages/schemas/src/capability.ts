import { z } from 'zod';
import { SchemaVersion, Vec3Schema } from './common.js';

/**
 * Grid capability profile (read-only). Every numeric value that came from a
 * block definition carries the definition subtype it was read from. Values
 * that cannot be derived are explicit `null` — the profiler never guesses.
 */

export const DefinitionSourcedNumberSchema = z.object({
  value: z.number().finite(),
  /** `definition` = CubeBlocks .sbc, `save` = serialized block state. */
  source: z.enum(['definition', 'save']),
  /** Subtype the value belongs to (e.g. `LargeBlockSmallGenerator`). */
  subtype: z.string().min(1),
});
export type DefinitionSourcedNumber = z.infer<typeof DefinitionSourcedNumberSchema>;

export const RadioAntennaProfileSchema = z.object({
  subtype: z.string().min(1),
  /** Effective radius from the saved block (`BroadcastRadius`). */
  radiusM: z.number().nonnegative().nullable(),
  /** Ceiling declared by the definition (`MaxBroadcastRadius`), if any. */
  maxRadiusM: DefinitionSourcedNumberSchema.nullable(),
  enabled: z.boolean().nullable(),
  broadcasting: z.boolean().nullable(),
});
export type RadioAntennaProfile = z.infer<typeof RadioAntennaProfileSchema>;

export const LaserAntennaProfileSchema = z.object({
  subtype: z.string().min(1),
  /** `null` when the definition is missing or declares `MaxRange < 0`. */
  maxRangeM: DefinitionSourcedNumberSchema.nullable(),
  /** True when the definition declares `MaxRange < 0` (no coded limit). */
  unlimited: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
});
export type LaserAntennaProfile = z.infer<typeof LaserAntennaProfileSchema>;

export const BeaconProfileSchema = z.object({
  subtype: z.string().min(1),
  radiusM: z.number().nonnegative().nullable(),
  maxRadiusM: DefinitionSourcedNumberSchema.nullable(),
  enabled: z.boolean().nullable(),
  broadcasting: z.boolean().nullable(),
});
export type BeaconProfile = z.infer<typeof BeaconProfileSchema>;

export const ThrusterSubtypeProfileSchema = z.object({
  subtype: z.string().min(1),
  count: z.number().int().nonnegative(),
  forceN: DefinitionSourcedNumberSchema.nullable(),
});
export type ThrusterSubtypeProfile = z.infer<typeof ThrusterSubtypeProfileSchema>;

export const ThrusterGroupSchema = z.object({
  count: z.number().int().nonnegative(),
  /** `null` when any used subtype is missing from the definitions. */
  totalForceN: z.number().nonnegative().nullable(),
  bySubtype: z.array(ThrusterSubtypeProfileSchema).default([]),
});
export type ThrusterGroup = z.infer<typeof ThrusterGroupSchema>;

export const PowerSubtypeProfileSchema = z.object({
  subtype: z.string().min(1),
  count: z.number().int().nonnegative(),
  /** Per-block value from the definition (MWh or MW depending on the field). */
  value: DefinitionSourcedNumberSchema.nullable(),
});
export type PowerSubtypeProfile = z.infer<typeof PowerSubtypeProfileSchema>;

export const BatteryProfileSchema = z.object({
  count: z.number().int().nonnegative(),
  /** Sum of block capacity (MWh). `null` when any subtype is undefined. */
  capacityMWh: z.number().nonnegative().nullable(),
  /** Sum of serialized `CurrentStoredPower` (MWh); `null` when absent. */
  storedMWh: z.number().nonnegative().nullable(),
  bySubtype: z.array(PowerSubtypeProfileSchema).default([]),
});
export type BatteryProfile = z.infer<typeof BatteryProfileSchema>;

export const ReactorProfileSchema = z.object({
  count: z.number().int().nonnegative(),
  maxOutputMW: z.number().nonnegative().nullable(),
  bySubtype: z.array(PowerSubtypeProfileSchema).default([]),
});
export type ReactorProfile = z.infer<typeof ReactorProfileSchema>;

export const SolarProfileSchema = z.object({
  count: z.number().int().nonnegative(),
  maxOutputMW: z.number().nonnegative().nullable(),
  bySubtype: z.array(PowerSubtypeProfileSchema).default([]),
});
export type SolarProfile = z.infer<typeof SolarProfileSchema>;

export const HydrogenTankProfileSchema = z.object({
  count: z.number().int().nonnegative(),
  /** Sum of definition `Capacity` (litres). `null` if a definition is missing. */
  capacityL: z.number().nonnegative().nullable(),
  /** Capacity-weighted `FilledRatio` 0..1, `null` when the save has no value. */
  fillRatio: z.number().min(0).max(1).nullable(),
  filledL: z.number().nonnegative().nullable(),
  /** Per-subtype definition capacity, with its source subtype. */
  bySubtype: z.array(PowerSubtypeProfileSchema).default([]),
});
export type HydrogenTankProfile = z.infer<typeof HydrogenTankProfileSchema>;

export const CapabilityRolesSchema = z.object({
  /** Has an enabled radio antenna that is broadcasting. */
  canRelay: z.boolean(),
  /** Has an enabled laser antenna (definition or unlimited range). */
  canLaserLink: z.boolean(),
  /** Only derivable when grid mass is known. */
  canFlyInGravity: z.union([z.boolean(), z.literal('unknown')]),
  /** Ion or hydrogen thrust > 0; 'unknown' when force is undeterminable. */
  canFlyInSpace: z.union([z.boolean(), z.literal('unknown')]),
  /** Programmable block or remote control present. */
  controllable: z.boolean(),
});
export type CapabilityRoles = z.infer<typeof CapabilityRolesSchema>;

export const CapabilityProfileSchema = z.object({
  schemaVersion: SchemaVersion,
  gridId: z.string().min(1),
  name: z.string(),
  ownerIdentityId: z.string().nullable(),
  ownerName: z.string().nullable(),
  ownerFactionTag: z.string().nullable(),
  ownerKind: z.enum(['player', 'npc', 'unknown']),
  isNpc: z.boolean(),
  sizeClass: z.enum(['large', 'small', 'unknown']),
  isStatic: z.boolean(),
  position: Vec3Schema.nullable(),
  blockCount: z.number().int().nonnegative(),
  massKg: z.number().nonnegative().nullable(),
  radioAntennas: z.array(RadioAntennaProfileSchema).default([]),
  laserAntennas: z.array(LaserAntennaProfileSchema).default([]),
  beacons: z.array(BeaconProfileSchema).default([]),
  programmableBlocks: z.number().int().nonnegative(),
  remoteControls: z.number().int().nonnegative(),
  cockpits: z.number().int().nonnegative(),
  gyros: z.number().int().nonnegative(),
  thrusters: z.object({
    atmo: ThrusterGroupSchema,
    ion: ThrusterGroupSchema,
    hydrogen: ThrusterGroupSchema,
  }),
  power: z.object({
    batteries: BatteryProfileSchema,
    reactors: ReactorProfileSchema,
    solarPanels: SolarProfileSchema,
  }),
  hydrogenTanks: HydrogenTankProfileSchema,
  roles: CapabilityRolesSchema,
  /** Definition subtypes referenced by the grid but absent from the defs. */
  missingDefinitions: z.array(z.string()).default([]),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

export const CapabilityReportSchema = z.object({
  schemaVersion: SchemaVersion,
  generatedAt: z.number().int().nonnegative(),
  savePath: z.string(),
  defsPath: z.string(),
  gridsScanned: z.number().int().nonnegative(),
  gridsExcluded: z.number().int().nonnegative(),
  grids: z.array(CapabilityProfileSchema),
});
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;
