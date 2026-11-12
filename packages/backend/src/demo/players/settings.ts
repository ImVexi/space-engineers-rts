/**
 * T61 player-map settings. Kept separate from the designer settings so a
 * privacy default can be changed (or audited) without touching flight limits.
 *
 * The rule the owner agreed: on the map show players of the OWNER'S FACTION
 * only, never any other faction, and never on the world-geometry service. So the default
 * is `filterToOwnerFaction: true`; turning it off is an explicit, audited
 * decision by an authenticated caller.
 */
import type { Store } from '../../store.js';

export interface PlayerSettings {
  /** When true (default) only the owner's faction is published. */
  filterToOwnerFaction: boolean;
  /**
   * Explicit faction tag to use as "owner's faction". Empty = derive it from
   * the owner's own live telemetry sample (steam id from config.owner).
   */
  ownerFactionTag: string;
  /**
   * Also publish players with no faction at all. Default true: on a private
   * single-player-test world the owner is often not in a faction, and hiding
   * him would make the feature look broken.
   */
  includeNoFaction: boolean;
  /** A position older than this is labelled stale/history, not live. */
  staleAfterMs: number;
}

export const PLAYER_SETTINGS_DEFAULTS: PlayerSettings = {
  filterToOwnerFaction: true,
  ownerFactionTag: '',
  includeNoFaction: true,
  staleAfterMs: 30_000,
};

const KEY = 'players:settings';

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function validatePlayerSettings(
  input: Partial<Record<keyof PlayerSettings, unknown>>,
  fallback: PlayerSettings = PLAYER_SETTINGS_DEFAULTS,
): PlayerSettings {
  return {
    filterToOwnerFaction:
      typeof input.filterToOwnerFaction === 'boolean' ? input.filterToOwnerFaction : fallback.filterToOwnerFaction,
    ownerFactionTag:
      typeof input.ownerFactionTag === 'string' ? input.ownerFactionTag.trim().slice(0, 64) : fallback.ownerFactionTag,
    includeNoFaction: typeof input.includeNoFaction === 'boolean' ? input.includeNoFaction : fallback.includeNoFaction,
    staleAfterMs: clamp(input.staleAfterMs, 5_000, 600_000, fallback.staleAfterMs),
  };
}

export function readPlayerSettings(store: Store): PlayerSettings {
  const raw = store.getKv(KEY);
  if (!raw) return { ...PLAYER_SETTINGS_DEFAULTS };
  try {
    return validatePlayerSettings(JSON.parse(raw) as Partial<Record<keyof PlayerSettings, unknown>>);
  } catch {
    return { ...PLAYER_SETTINGS_DEFAULTS };
  }
}

export function writePlayerSettings(
  store: Store,
  input: Partial<Record<keyof PlayerSettings, unknown>>,
  actor: string,
  now = Date.now(),
): PlayerSettings {
  const previous = readPlayerSettings(store);
  const next = validatePlayerSettings({ ...previous, ...input }, previous);
  store.setKv(KEY, JSON.stringify(next));
  store.audit({
    actor,
    action: 'player_settings',
    subject: 'players',
    detail: { previous, next },
    at: now,
  });
  return next;
}
