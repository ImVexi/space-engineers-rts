/**
 * Designer settings (T6). Persisted in SQLite kv, audited on every write, and
 * read live by the executor (SimSpeed threshold) and the execute route
 * (active-drone cap). Defaults match the owner's rule: SimSpeed >= 0.95,
 * at most 5 active drones.
 */
import type { Store } from '../../store.js';

export interface DesignerSettings {
  simSpeedMin: number;
  maxActive: number;
  /** Minimum fuel/charge reserve required by the launch preflight. */
  launchReservePct: number;
}

export const DESIGNER_SETTINGS_DEFAULTS: DesignerSettings = { simSpeedMin: 0.95, maxActive: 5, launchReservePct: 15 };
const KEY = 'designer:settings';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function validateSettings(
  input: Partial<Record<keyof DesignerSettings, unknown>>,
  fallback: DesignerSettings = DESIGNER_SETTINGS_DEFAULTS,
): DesignerSettings {
  return {
    simSpeedMin: Math.round(clampNumber(input.simSpeedMin, 0.5, 1, fallback.simSpeedMin) * 1000) / 1000,
    maxActive: Math.round(clampNumber(input.maxActive, 1, 10, fallback.maxActive)),
    launchReservePct: Math.round(clampNumber(input.launchReservePct, 0, 50, fallback.launchReservePct) * 10) / 10,
  };
}

export function readDesignerSettings(store: Store): DesignerSettings {
  const raw = store.getKv(KEY);
  if (!raw) return { ...DESIGNER_SETTINGS_DEFAULTS };
  try {
    return validateSettings(JSON.parse(raw) as Partial<Record<keyof DesignerSettings, unknown>>);
  } catch {
    return { ...DESIGNER_SETTINGS_DEFAULTS };
  }
}

export function writeDesignerSettings(
  store: Store,
  input: Partial<Record<keyof DesignerSettings, unknown>>,
  actor: string,
  now = Date.now(),
): DesignerSettings {
  const previous = readDesignerSettings(store);
  const next = validateSettings({ ...previous, ...input }, previous);
  store.setKv(KEY, JSON.stringify(next));
  store.audit({
    actor,
    action: 'designer_settings',
    subject: 'designer',
    detail: { previous, next },
    at: now,
  });
  return next;
}
