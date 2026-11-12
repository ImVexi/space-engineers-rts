import { z } from 'zod';
import { EpochMs, IdString, ResourceMap, SchemaVersion } from './common.js';

/**
 * ShipSpec — the only thing the LLM is allowed to author. Never raw blueprint
 * XML (build plan R20). The deterministic assembler consumes this later.
 */
export const ShipRole = z.enum([
  'relay',
  'scout',
  'miner',
  'hauler',
  'fighter',
  'bomber',
  'builder',
  'fire_support',
  'energy',
]);
export type ShipRole = z.infer<typeof ShipRole>;

export const Propulsion = z.enum(['ion', 'hydrogen', 'atmospheric', 'mixed']);

export const ShipParameters = z.object({
  solarPanels: z.number().int().nonnegative().optional(),
  batteries: z.number().int().nonnegative().optional(),
  reactors: z.number().int().nonnegative().optional(),
  ionThrusters: z.number().int().nonnegative().optional(),
  hydrogenThrusters: z.number().int().nonnegative().optional(),
  atmosphericThrusters: z.number().int().nonnegative().optional(),
  hydrogenTanks: z.number().int().nonnegative().optional(),
  cargoContainers: z.number().int().nonnegative().optional(),
  gyros: z.number().int().nonnegative().optional(),
  antenna: z.enum(['radio', 'laser', 'none']).optional(),
  laser: z.boolean().optional(),
  camera: z.boolean().optional(),
  armor: z.enum(['none', 'light', 'heavy']).optional(),
});

export const ShipConstraints = z.object({
  maxMassKg: z.number().positive().optional(),
  minTWR: z.number().nonnegative().max(10).optional(),
  maxPCU: z.number().int().positive().optional(),
  minEnduranceMin: z.number().positive().optional(),
  propulsion: Propulsion.optional(),
});

export const ShipSpecSchema = z
  .object({
    schemaVersion: SchemaVersion,
    id: IdString,
    role: ShipRole,
    template: z.string().min(1).max(128),
    parameters: ShipParameters.default({}),
    constraints: ShipConstraints.default({}),
    version: z.number().int().positive(),
    createdAt: EpochMs.optional(),
  })
  .superRefine((spec, ctx) => {
    const p = spec.parameters;
    const thrusters =
      (p.ionThrusters ?? 0) + (p.hydrogenThrusters ?? 0) + (p.atmosphericThrusters ?? 0);
    // A printable ship must have a propulsion source; the detailed TWR/power
    // validation lives in the P3 validator, this is only the sanity floor.
    if (thrusters === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters'],
        message: 'at least one thruster is required',
      });
    }
    if ((p.batteries ?? 0) + (p.solarPanels ?? 0) + (p.reactors ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters'],
        message: 'at least one power source (solar, battery or reactor) is required',
      });
    }
    const propulsion = spec.constraints.propulsion;
    if (propulsion === 'ion' && (p.ionThrusters ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['constraints', 'propulsion'],
        message: 'propulsion=ion requires ionThrusters > 0',
      });
    }
    if (propulsion === 'hydrogen' && (p.hydrogenThrusters ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['constraints', 'propulsion'],
        message: 'propulsion=hydrogen requires hydrogenThrusters > 0',
      });
    }
    if (propulsion === 'atmospheric' && (p.atmosphericThrusters ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['constraints', 'propulsion'],
        message: 'propulsion=atmospheric requires atmosphericThrusters > 0',
      });
    }
  });

export type ShipSpec = z.infer<typeof ShipSpecSchema>;
export type ShipSpecInput = z.input<typeof ShipSpecSchema>;

/** Rough per-unit material cost used by the reconciler budget defaults. */
export const DEFAULT_SHIP_COST: Record<string, Record<string, number>> = {
  'sat-relay-mk1': { iron: 12000, silicon: 900, cobalt: 300 },
};
