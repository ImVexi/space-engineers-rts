import { z } from 'zod';

/**
 * Canonical schema version. Bumped only for breaking changes; every change
 * must be additive (new optional fields, new enum members behind checks).
 */
export const SCHEMA_VERSION = 1 as const;

export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Epoch milliseconds, UTC. */
export const EpochMs = z.number().int().nonnegative();

/** Stable identifier: letters/digits plus `_.:-`, max 128 chars. */
export const IdString = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'id must be alphanumeric with _.:- separators');

export const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

export const ResourceMap = z.record(z.string().min(1).max(64), z.number().nonnegative());

/** Non-empty, additive-only bag of free-form parameters. */
export const ParamBag = z.record(z.string(), z.unknown());

export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** Normalises zod issues into `path: message` lines for logs and API errors. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`schema validation failed: ${formatIssues(result.error).join('; ')}`);
  }
  return result.data;
}
