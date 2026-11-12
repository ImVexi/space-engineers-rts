/**
 * T19 relay lifecycle: station only when deployed, unstation before any move.
 *
 * A `station` (static grid) has no physics drive: it holds position for free,
 * burns no hydrogen and costs almost no simulation. That is exactly what an
 * in-gravity relay needs — but only once it is actually parked:
 *
 *   * at its assigned slot (the executor only calls this from `holding`),
 *   * speed <= 0.5 m/s,
 *   * at least 100 m above the ground (never station on the ground: a landed
 *     grid must stay dynamic so it can be refuelled and picked up),
 *   * stable for 30 s,
 *   * nobody piloting it by hand (T27 manual handoff wins),
 *   * no pending order.
 *
 * Any new order on a stationed grid goes through the launch preflight, which
 * reads `diag` and sends `convert_to_ship` first (docs/station-mode.md).
 *
 * Pure functions only: the executor owns the order plumbing, this file owns
 * the decision so it can be unit-tested without a server.
 */

export interface StationConfig {
  /** Master switch. Default on for the test server (config flag). */
  enabled: boolean;
  /** How long a drone must be stable in `holding` before it is stationed. */
  afterMs: number;
  /** Faster than this and it is still flying (the ideal park). */
  maxSpeedMps: number;
  /**
   * Up to this speed a residual drift is zeroed by the plugin before the
   * conversion instead of waiting for the autopilot to settle (a hovering relay
   * sits at ~1 m/s and otherwise never stations).
   */
  zeroSpeedMps: number;
  /** Ground floor: never station below this AGL. */
  minAglM: number;
}

export const DEFAULT_STATION_CONFIG: StationConfig = {
  enabled: true,
  afterMs: 30_000,
  maxSpeedMps: 0.5,
  zeroSpeedMps: 5,
  minAglM: 100,
};

export type StationAction = 'station' | 'wait' | 'skip';

export interface StationDecision {
  action: StationAction;
  reason: string;
}

export interface StationInput {
  enabled: boolean;
  state: string;
  /** ms since the drone reached its hold. null = never held. */
  holdMs: number | null;
  speedMps: number | null;
  aglM: number | null;
  hasPendingOrder: boolean;
  /** Player piloting the grid (T27). */
  underControl: boolean;
  isStatic: boolean;
  /** Already stationed in this mission (step === 'stationed'). */
  alreadyStationed: boolean;
  config: StationConfig;
}

export function stationDecision(input: StationInput): StationDecision {
  const c = input.config;
  if (!c.enabled || !input.enabled) return { action: 'skip', reason: 'station mode disabled (RTS_STATION=0)' };
  if (input.alreadyStationed) return { action: 'skip', reason: 'already stationed' };
  if (input.state !== 'holding') return { action: 'skip', reason: `state ${input.state} is not holding` };
  if (input.isStatic) return { action: 'skip', reason: 'grid is already static' };
  if (input.hasPendingOrder) return { action: 'wait', reason: 'pending order' };
  if (input.underControl) return { action: 'skip', reason: 'manual control: a player is piloting the grid' };
  if (input.holdMs === null || input.holdMs < c.afterMs) {
    return { action: 'wait', reason: `holding for ${Math.max(0, input.holdMs ?? 0)} ms < ${c.afterMs} ms` };
  }
  if (input.speedMps === null) return { action: 'wait', reason: 'speed unreadable' };
  if (input.speedMps > c.zeroSpeedMps) {
    return { action: 'wait', reason: `speed ${round(input.speedMps)} m/s > ${c.zeroSpeedMps} m/s (too fast to zero safely)` };
  }
  if (input.aglM === null) return { action: 'wait', reason: 'altitude AGL unreadable (no ground probe)' };
  if (input.aglM < c.minAglM) {
    return { action: 'skip', reason: `AGL ${round(input.aglM)} m < ${c.minAglM} m: never station on the ground` };
  }
  if (input.speedMps > c.maxSpeedMps) {
    return {
      action: 'station',
      reason: `residual ${round(input.speedMps, 2)} m/s at ${round(input.aglM, 0)} m AGL: zero velocity, hold 2 s, then convert`,
    };
  }
  return { action: 'station', reason: `stable ${round(input.speedMps, 2)} m/s at ${round(input.aglM, 0)} m AGL for ${round((input.holdMs ?? 0) / 1000, 0)} s` };
}

/** Order payload for the plugin action. `force` is never used by the executor. */
export function convertToStationOrder(gridId: string): Record<string, unknown> {
  return { gridId, force: false };
}

/** Zero linear + angular velocity on the grid (game thread). */
export function zeroVelocityOrder(gridId: string): Record<string, unknown> {
  return { gridId };
}

/** How long the executor lets the zeroed velocity settle before converting. */
export const STATION_SETTLE_MS = 2_000;
/**
 * T74: SE refuses `IsStatic = true` while the body still moves. In survival the
 * dampeners (never a zeroing) must bring the hull under this speed first.
 */
export const STATION_CONVERT_MAX_SPEED_MPS = 0.5;
/** Survival: how long the dampener stop may take before the drone gives up. */
export const STATION_SURVIVAL_STOP_TIMEOUT_MS = 30_000;
/** Zero + convert attempts before the drone is left as a ship. */
export const STATION_MAX_ATTEMPTS = 3;

/** One-line status for the drone row / site. */
export function stationLine(decision: StationDecision): string {
  return decision.action === 'station' ? `station: ${decision.reason}` : `ship: ${decision.reason}`;
}

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
