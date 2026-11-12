import { z } from 'zod';
import { SchemaVersion } from './common.js';

/**
 * Escalation ladder (deploy instructions §8). Data only in this build: the
 * test-lab driver that executes rungs lands later, but the rungs, acceptance
 * criteria and retry caps are canonical now so nothing can drift.
 */
export const RetryCapsSchema = z.object({
  /** Attempts allowed per hypothesis (one variable per experiment). */
  perHypothesis: z.number().int().positive(),
  /** Attempts allowed per rung before stopping and escalating. */
  perRung: z.number().int().positive(),
});

export const LadderRungSchema = z.object({
  schemaVersion: SchemaVersion,
  rung: z.number().int().min(1).max(10),
  id: z.enum([
    'handshake',
    'idle_power',
    'hover',
    'short_move',
    'waypoint_route',
    'link',
    'ascent',
    'orbit',
    'interplanetary',
    'crash',
  ]),
  name: z.string().min(1).max(64),
  acceptance: z.array(z.string().min(1).max(300)).min(1),
  retryCaps: RetryCapsSchema,
  /** Rung 10 destroys the asset; it can never run without explicit approval. */
  requiresApproval: z.boolean(),
  destroysAsset: z.boolean().default(false),
});
export type LadderRung = z.infer<typeof LadderRungSchema>;

const caps = { perHypothesis: 3, perRung: 10 };

export const LADDER_RUNGS: LadderRung[] = [
  {
    schemaVersion: 1,
    rung: 1,
    id: 'handshake',
    name: 'Handshake',
    acceptance: [
      'PB compiles and runs the uniform firmware',
      'Firmware reports in with grid identity',
      'Backend recognizes the grid (entity id + per-grid config)',
      '3 clean handshakes in a row',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 2,
    id: 'idle_power',
    name: 'Idle / power',
    acceptance: [
      'All systems on and stable',
      'Battery/solar neither draining nor overflowing',
      'No drift beyond tolerance and no alerts for 5 minutes',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 3,
    id: 'hover',
    name: 'Hover',
    acceptance: [
      'Holds position under gravity for 60 s',
      'Drift under the defined tolerance',
      'Power draw within budget',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 4,
    id: 'short_move',
    name: 'Short move',
    acceptance: [
      'Moves 100 m, stops and holds',
      'Moves 1 km, stops and holds',
      'Fuel/charge within ±15% of prediction',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 5,
    id: 'waypoint_route',
    name: 'Waypoint route',
    acceptance: [
      'Completes a 10 km multi-waypoint route',
      'No collision with the obstacle on the route',
      'Reports every waypoint',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 6,
    id: 'link',
    name: 'Link',
    acceptance: [
      'Establishes laser/radio link to the ground station',
      'Survives a deliberate link cut without a stuck state',
      'Reroutes or holds safely',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 7,
    id: 'ascent',
    name: 'Ascent',
    acceptance: [
      'Ground to 1 km altitude',
      'Holds altitude without crashing',
      'Power/fuel inside budget',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 8,
    id: 'orbit',
    name: 'Orbit (station-keeping)',
    acceptance: [
      'Reaches the target space point',
      'Holds on station within tolerance',
      'Stable link and stable power',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 9,
    id: 'interplanetary',
    name: 'Interplanetary',
    acceptance: [
      'Travels to another planet/moon and arrives (or jump + final flight)',
      'Links after arrival and is not stranded',
      'Loss inside budget',
    ],
    retryCaps: caps,
    requiresApproval: false,
    destroysAsset: false,
  },
  {
    schemaVersion: 1,
    rung: 10,
    id: 'crash',
    name: 'Deliberate impact / crash test',
    acceptance: [
      'Rungs 1-9 already certified',
      'the owner explicitly approved this specific run',
      'Impact damage / warhead detonation / survival limits recorded',
      'Asset destroyed deliberately; never run on a grid the owner needs',
    ],
    retryCaps: caps,
    requiresApproval: true,
    destroysAsset: true,
  },
];

export function getRung(rung: number): LadderRung | undefined {
  return LADDER_RUNGS.find((r) => r.rung === rung);
}
