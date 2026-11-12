import { z } from 'zod';
import { SchemaVersion } from './common.js';

/**
 * Scenario catalog from build plan §8.1. These are stubs: the steps and
 * assertions are recorded so the test-lab runner and the website can list
 * them, but nothing executes them yet.
 */
export const ScenarioSchema = z.object({
  schemaVersion: SchemaVersion,
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /** Ladder rung this scenario gates, when it maps to one. */
  rung: z.number().int().min(1).max(10).optional(),
  status: z.enum(['stub', 'implemented', 'disabled']),
  steps: z.array(z.string().min(1).max(300)).min(1),
  assertions: z.array(z.string().min(1).max(300)).min(1),
  requiresApproval: z.boolean().default(false),
  /** Real-time scenario; keep short and snapshot-based, never brute force. */
  slow: z.boolean().default(false),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const SCENARIOS: Scenario[] = [
  {
    schemaVersion: 1,
    id: 'sat_space_to_xyz',
    name: 'Satellite: space to XYZ',
    rung: 4,
    status: 'stub',
    steps: ['Spawn a sat in space', 'Issue move to XYZ', 'Wait for arrival'],
    assertions: ['Arrival within T', 'Fuel/charge within ±15% of prediction'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'sat_ground_launch',
    name: 'Satellite: ground launch',
    rung: 7,
    status: 'stub',
    steps: ['Spawn a sat on an Earth-like planet', 'Launch to a space point'],
    assertions: ['Ascent succeeds', 'Link established'],
    requiresApproval: false,
    slow: true,
  },
  {
    schemaVersion: 1,
    id: 'distress_dispatch',
    name: 'Distress dispatch',
    status: 'stub',
    steps: ['Cut a unit link or damage it', 'Observe incident and dispatcher'],
    assertions: ['Incident created', 'Responders dispatched within T', 'Budget respected'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'losing_fight_escalation_stop',
    name: 'Losing fight: escalation stop',
    status: 'stub',
    steps: ['Send insufficient force at a hostile', 'Keep feeding contacts'],
    assertions: ['Escalation stops at budget/loss limit', 'Alert raised, no further dispatch'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'link_cut_scouting',
    name: 'Link cut: reroute or scout',
    status: 'stub',
    steps: ['Cut a relay', 'Observe reroute and scout dispatch'],
    assertions: ['Route restored or scout dispatched', 'Uncertainty bubble grows'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'restart_mid_print',
    name: 'Restart mid-print',
    status: 'stub',
    steps: ['Start a print', 'Restart the backend mid-print'],
    assertions: ['Print resumes', 'No duplicate grid', 'No lost materials'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'partial_stock_production',
    name: 'Partial stock production',
    status: 'stub',
    steps: ['Order more ships than materials allow'],
    assertions: ['Partial build', '"Awaiting materials" reported', 'ETA reported'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'hotspot_suggestion',
    name: 'Hotspot suggestion',
    status: 'stub',
    steps: ['Generate 3 incidents in one cell'],
    assertions: ['Suggestion produced', 'No automatic build'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'jump_limits',
    name: 'Jump limits',
    rung: 9,
    status: 'stub',
    steps: ['Verify R2-R4 jump limits', 'Attempt an illegal jump'],
    assertions: ['Planner refuses jumps inside gravity', 'Planner refuses jumps below min range'],
    requiresApproval: false,
    slow: false,
  },
  {
    schemaVersion: 1,
    id: 'authority_gate',
    name: 'Authority gate',
    rung: 6,
    status: 'stub',
    steps: ['Attempt to command an unreachable unit'],
    assertions: ['Order rejected', 'Unit stays observe-only', 'Rejection is audited'],
    requiresApproval: false,
    slow: false,
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
