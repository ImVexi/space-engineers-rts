import { z } from 'zod';
import { EpochMs, IdString, ParamBag, SchemaVersion, Vec3Schema } from './common.js';

export const IncidentState = z.enum(['detected', 'responding', 'escalated', 'closed']);
export type IncidentState = z.infer<typeof IncidentState>;

export const IncidentSchema = z.object({
  schemaVersion: SchemaVersion,
  id: IdString,
  state: IncidentState,
  severity: z.number().int().min(1).max(5),
  kind: z.enum(['link_lost', 'damage', 'hostile', 'budget', 'production', 'other']).default('other'),
  subject: IdString.optional(),
  lastKnown: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      at: EpochMs,
    })
    .optional(),
  uncertaintyRadiusM: z.number().nonnegative().default(0),
  budget: z.object({
    resources: z.record(z.string(), z.number().nonnegative()).default({}),
    lossLimit: z.number().int().nonnegative().default(0),
  }),
  timeline: z
    .array(
      z.object({
        at: EpochMs,
        event: z.string().max(200),
        detail: ParamBag.optional(),
      }),
    )
    .default([]),
  createdAt: EpochMs,
  updatedAt: EpochMs,
});
export type Incident = z.infer<typeof IncidentSchema>;

export const LedgerEntrySchema = z.object({
  schemaVersion: SchemaVersion,
  site: IdString,
  item: z.string().min(1).max(64),
  qty: z.number().nonnegative(),
  reserved: z.number().nonnegative(),
  inTransit: z.number().nonnegative(),
  available: z.number().nonnegative(),
  asOf: EpochMs,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const BehaviorTrigger = z.object({
  on: z.enum(['threat_detected', 'link_lost', 'low_power', 'low_stock', 'manual', 'schedule']),
  withinM: z.number().positive().optional(),
  cron: z.string().max(64).optional(),
});

export const BehaviorStep = z.object({
  capability: IdString,
  params: ParamBag.default({}),
  /** Do not abort the recipe when this step fails (logged regardless). */
  optional: z.boolean().default(false),
});

export const BehaviorConfigSchema = z.object({
  schemaVersion: SchemaVersion,
  id: IdString,
  version: z.number().int().positive(),
  enabled: z.boolean().default(false),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  trigger: BehaviorTrigger,
  steps: z.array(BehaviorStep).min(1),
  /** Capabilities that need code, not just data, must stay disabled. */
  requiresRestart: z.boolean().default(false),
});
export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;

export const CapabilityIoSchema = z.record(
  z.string(),
  z.enum(['number', 'bool', 'string', 'vec3', 'json', 'entityId', 'orderId']),
);

export const CapabilitySchema = z.object({
  schemaVersion: SchemaVersion,
  id: IdString,
  version: z.number().int().positive(),
  inputs: CapabilityIoSchema.default({}),
  outputs: CapabilityIoSchema.default({}),
  risk: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  requiresTest: z.boolean().default(true),
  enabled: z.boolean().default(false),
  description: z.string().max(500).optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

