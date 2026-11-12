/**
 * Alerts settings. One kv record (`alerts:settings`), audited on write.
 *
 * Discord delivery is OFF by default: the open-source default is an empty
 * webhook, and an empty webhook means the delivery step only writes audit.
 */
import type { Store } from '../../store.js';

export interface AlertsSettings {
  /** Discord webhook URL; '' disables network delivery. */
  discordWebhook: string;
  /** Warn when the projected energy runway is below this many hours. */
  runwayHours: number;
  /** A runway below this many minutes is critical, not warn. */
  runwayCriticalMin: number;
  /** Uncovered cells (plan grid) above which a coverage hole is raised. */
  coverageHoleCells: number;
  /** Percentage points of coverage lost between evaluations that fires. */
  coverageDropPct: number;
  /** Only compare coverage samples inside this window, ms. */
  coverageDropWindowMs: number;
  /** Coverage below this percentage of a planned planet raises a warning. */
  coverageGoalPct: number;
  /** No telemetry for this long means the grid is gone (2 x the 30 s poll). */
  gridLostAfterMs: number;
  /** Owner-tagged grid with no telemetry for this long is stale. */
  telemetryStaleMs: number;
  /** SimSpeed below threshold for at least this long fires. */
  simSpeedHoldMs: number;
  /** How long a failed/aborted mission stays alertable. */
  missionFailWindowMs: number;
  /** Batch window for non-critical Discord messages, ms. */
  batchMs: number;
  /** Skip a power snapshot older than this (a stale reading is not a reading). */
  readingStaleMs: number;
}

export const ALERTS_SETTINGS_DEFAULTS: AlertsSettings = {
  discordWebhook: '',
  runwayHours: 6,
  runwayCriticalMin: 60,
  coverageHoleCells: 25,
  coverageDropPct: 2,
  coverageDropWindowMs: 30 * 60_000,
  coverageGoalPct: 90,
  gridLostAfterMs: 60_000,
  telemetryStaleMs: 120_000,
  simSpeedHoldMs: 60_000,
  missionFailWindowMs: 15 * 60_000,
  batchMs: 5_000,
  readingStaleMs: 10 * 60_000,
};

const KEY = 'alerts:settings';

function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Only http(s) URLs are accepted; anything else silently disables delivery. */
export function validWebhook(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : '';
}

export function validateAlertsSettings(
  input: Partial<Record<keyof AlertsSettings, unknown>>,
  fallback: AlertsSettings = ALERTS_SETTINGS_DEFAULTS,
): AlertsSettings {
  return {
    discordWebhook: input.discordWebhook === undefined ? fallback.discordWebhook : validWebhook(input.discordWebhook),
    runwayHours: Math.round(num(input.runwayHours, 0.5, 168, fallback.runwayHours) * 10) / 10,
    runwayCriticalMin: Math.round(num(input.runwayCriticalMin, 1, 1_440, fallback.runwayCriticalMin)),
    coverageHoleCells: Math.round(num(input.coverageHoleCells, 1, 100_000, fallback.coverageHoleCells)),
    coverageDropPct: Math.round(num(input.coverageDropPct, 0.1, 100, fallback.coverageDropPct) * 10) / 10,
    coverageDropWindowMs: Math.round(num(input.coverageDropWindowMs, 60_000, 24 * 3_600_000, fallback.coverageDropWindowMs)),
    coverageGoalPct: Math.round(num(input.coverageGoalPct, 0, 100, fallback.coverageGoalPct) * 10) / 10,
    gridLostAfterMs: Math.round(num(input.gridLostAfterMs, 10_000, 3_600_000, fallback.gridLostAfterMs)),
    telemetryStaleMs: Math.round(num(input.telemetryStaleMs, 30_000, 24 * 3_600_000, fallback.telemetryStaleMs)),
    simSpeedHoldMs: Math.round(num(input.simSpeedHoldMs, 10_000, 3_600_000, fallback.simSpeedHoldMs)),
    missionFailWindowMs: Math.round(num(input.missionFailWindowMs, 60_000, 24 * 3_600_000, fallback.missionFailWindowMs)),
    batchMs: Math.round(num(input.batchMs, 0, 60_000, fallback.batchMs)),
    readingStaleMs: Math.round(num(input.readingStaleMs, 60_000, 24 * 3_600_000, fallback.readingStaleMs)),
  };
}

export function readAlertsSettings(store: Store): AlertsSettings {
  const raw = store.getKv(KEY);
  if (!raw) return { ...ALERTS_SETTINGS_DEFAULTS };
  try {
    return validateAlertsSettings(JSON.parse(raw) as Partial<Record<keyof AlertsSettings, unknown>>);
  } catch {
    return { ...ALERTS_SETTINGS_DEFAULTS };
  }
}

export function writeAlertsSettings(
  store: Store,
  input: Partial<Record<keyof AlertsSettings, unknown>>,
  actor: string,
  now = Date.now(),
): AlertsSettings {
  const previous = readAlertsSettings(store);
  const next = validateAlertsSettings({ ...previous, ...input }, previous);
  store.setKv(KEY, JSON.stringify(next));
  store.audit({
    actor,
    action: 'alerts_settings',
    subject: 'alerts',
    // Never write the webhook value itself into the audit log.
    detail: {
      previous: { ...previous, discordWebhook: previous.discordWebhook ? '[set]' : '' },
      next: { ...next, discordWebhook: next.discordWebhook ? '[set]' : '' },
    },
    at: now,
  });
  return next;
}
