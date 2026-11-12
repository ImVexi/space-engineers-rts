/**
 * T20 power & fuel telemetry: backend model.
 *
 * The plugin's `profile` action already reads everything from the live grid
 * (battery flows, per-reactor uranium, per-tank hydrogen, solar actual vs
 * installed). What was missing is a backend that samples it on a schedule,
 * stores a short history, derives rates/runways and merges the result into
 * `/api/demo/state` with the field names the Fleet page feature-detects
 * (`packages/demo-site/src/lib/fleet.ts`).
 *
 * Everything here is read-only: the poller only sends the read-only `profile`
 * test order. No block is changed and no ship is touched.
 */
export type ChargeState = 'charging' | 'discharging' | 'idle' | 'unknown';

export interface PowerTank {
  name: string;
  subtype: string;
  filledRatio: number | null;
  filledL: number | null;
  capacityL: number | null;
  stockpile: boolean;
  /** `unread` means the plugin saw the block but could not read its fill. */
  readState: 'read' | 'unread';
  unreadReason: string | null;
  /** Grid that physically owns the tank (a sub-grid is not the root grid). */
  container: string | null;
}

/**
 * Read state of one telemetry section. `absent` is a fact about the grid (no
 * battery / no hydrogen tank); `unread` is a fact about the read and must be
 * rendered as "—" with the reason, never as 0.
 */
export type SectionState = 'read' | 'unread' | 'absent';

export interface PowerReactor {
  name: string;
  outputMw: number | null;
  maxOutputMw: number | null;
  uraniumKg: number | null;
  uraniumCapacityKg: number | null;
}

export interface PowerSolar {
  name: string;
  actualMw: number | null;
  maxMw: number | null;
}

export interface PowerSnapshot {
  gridId: string;
  name: string | null;
  /** Backend clock when the profile result arrived. */
  at: number;
  /** Plugin clock (`sampledAt`), may differ by a few ms. */
  gameAt: number | null;
  isStatic: boolean | null;
  massKg: number | null;
  underControl: boolean;
  controlledBy: string | null;

  batteryStoredMWh: number | null;
  batteryMaxMWh: number | null;
  batteryPct: number | null;
  batteryState: SectionState;
  batteryUnreadReason: string | null;
  batteryInputMw: number | null;
  batteryOutputMw: number | null;
  charge: ChargeState;
  netMw: number | null;
  /**
   * The plugin's power breakdown: what the generators make now, what the
   * non-battery consumers draw now, and what the batteries take in. A
   * discharging battery is storage, not generation (`netMw = generation -
   * consumerDraw`), so these three answer "why is the net negative?".
   */
  generationMw: number | null;
  consumerDrawMw: number | null;
  batteryChargeMw: number | null;

  solarActualMw: number | null;
  solarMaxMw: number | null;
  solarEfficiency: number | null;
  reactorOutputMw: number | null;
  reactorMaxMw: number | null;

  antennaDrawMw: number | null;
  laserDrawMw: number | null;
  deviceDrawMw: number | null;

  h2Litres: number | null;
  h2CapacityLitres: number | null;
  h2Pct: number | null;
  h2State: SectionState;
  h2UnreadReason: string | null;
  h2TankCount: number | null;

  uraniumKg: number | null;
  uraniumCapacityKg: number | null;
  uraniumPct: number | null;

  radioRangeM: number | null;
  laserRangeM: number | null;
  radio: { name: string; radiusM: number | null; drawMw: number | null; enabled: boolean }[];
  lasers: { name: string; rangeM: number | null; drawMw: number | null; status: string | null }[];
  reactors: PowerReactor[];
  tanks: PowerTank[];
  solar: PowerSolar[];

  /** Which fields the profile did not report (UI shows "—"). */
  missing: string[];
}

export const POWER_DEFAULTS = {
  /** Poll every tagged grid no faster than this. */
  intervalMs: 30_000,
  /** Hard cap on profile orders per second (T20: max 3/s). */
  maxOrdersPerSec: 3,
  /** Do not wait longer than this for a profile result. */
  timeoutMs: 4_000,
  /** History kept for the per-grid chart endpoint. */
  historyMs: 24 * 60 * 60 * 1000,
  /** Rate estimates need at least this much wall time between samples. */
  minRateSpanMs: 120_000,
} as const;
