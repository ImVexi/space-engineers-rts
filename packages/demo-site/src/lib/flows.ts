/**
 * Plain-language glue for the two flows the owner actually uses:
 * "move a ship somewhere" and "launch satellites".
 *
 * No React, no fetch: target specs, the exact wire shape the backend accepts,
 * preflight rows and launch-orbit cards are pure and unit-tested.
 */
import type { MovePreflight, MoveTargetInfo, Vec3 } from '../types';
import { formatGpsString } from './designer';

/** Low orbit: inside gravity, so the ship has to hover and burn fuel. */
export const LOW_ORBIT_KM = 20;
/** Zero-g: above the gravity shelf; the backend never picks less than 60 km. */
export const ZERO_G_ORBIT_KM = 60;
/** Shortest gravity-free altitude the brief allows on EarthLike. */
export const ZERO_G_MIN_KM = 44;

export type MovePreset = 'orbit-zero-g' | 'orbit-low';

export type TargetSpec =
  | { kind: 'preset'; preset: MovePreset }
  | { kind: 'planet'; planet: string; altitudeM: number }
  | { kind: 'gps'; pos: Vec3 };

/** What the backend expects in `target`. */
export function wireTarget(spec: TargetSpec): string | { planet: string; altitudeM: number } | { gps: Vec3 } {
  if (spec.kind === 'preset') return spec.preset;
  if (spec.kind === 'planet') return { planet: spec.planet, altitudeM: spec.altitudeM };
  return { gps: spec.pos };
}

export function targetSpecLabel(spec: TargetSpec | null): string {
  if (!spec) return 'No destination yet';
  if (spec.kind === 'preset') {
    return spec.preset === 'orbit-zero-g'
      ? `Zero-g orbit (~${ZERO_G_ORBIT_KM} km)`
      : `Low orbit (~${LOW_ORBIT_KM} km)`;
  }
  if (spec.kind === 'planet') return `${Math.round(spec.altitudeM / 1000)} km above ${spec.planet}`;
  return `GPS ${Math.round(spec.pos.x / 1000)}, ${Math.round(spec.pos.y / 1000)}, ${Math.round(spec.pos.z / 1000)} km`;
}

export interface OrbitCard {
  id: 'low' | 'zero';
  title: string;
  headline: string;
  detail: string;
  caution: string | null;
}

/** The two orbit cards; `holdText` comes from the planner when it knows. */
export function orbitCards(holdLow: string | null = null, holdZero: string | null = null): OrbitCard[] {
  return [
    {
      id: 'low',
      title: 'Low orbit',
      headline: `${LOW_ORBIT_KM} km above the surface`,
      detail: 'Still inside gravity: the ship hovers under thrust, so it keeps using hydrogen.',
      caution: `Hold time limited by fuel${holdLow ? ` (est. ${holdLow})` : ''}.`,
    },
    {
      id: 'zero',
      title: 'Zero-g orbit',
      headline: `${ZERO_G_ORBIT_KM} km (gravity-free above ${ZERO_G_MIN_KM} km)`,
      detail: 'Above the gravity shelf: the ship holds station for free, no hover burn.',
      caution: holdZero ? `Hold ${holdZero}.` : 'Free hold; solar and batteries keep it alive.',
    },
  ];
}

export interface PreflightRow {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
}

/** Rows for the preflight card. Refusals surface message + hint, never a code. */
export function preflightRows(preflight: MovePreflight | null): PreflightRow[] {
  if (!preflight) return [];
  const rows: PreflightRow[] = [
    {
      label: 'Link to base',
      value: preflight.canReach ? 'Yes — ' + preflight.linkText : 'No — ' + preflight.linkText,
      tone: preflight.canReach ? 'ok' : 'bad',
    },
    { label: 'Fuel', value: preflight.fuelText, tone: preflight.fuelPct !== null && preflight.fuelPct < 20 ? 'warn' : 'muted' },
    { label: 'ETA', value: preflight.etaText, tone: 'muted' },
  ];
  return rows;
}

/** One sentence for a toast after a successful mission request. */
export function moveQueuedText(name: string, target: MoveTargetInfo | null): string {
  if (!target) return `Move queued for ${name}.`;
  return `Moving ${name} to ${target.label}.`;
}

/** First blocking problem, in plain words, with the backend's fix hint. */
export function blockText(preflight: MovePreflight | null): { message: string; hint: string } | null {
  if (!preflight || preflight.ok || !preflight.block) return null;
  return {
    message: preflight.block.message || 'This move is blocked.',
    hint: preflight.block.hint || 'Pick a closer destination or add a relay.',
  };
}

/** Space Engineers GPS string for copy-to-clipboard. */
export function gpsStringFor(name: string, pos: Vec3): string {
  return formatGpsString(name, pos);
}

/** Human name for a live grid: naming-service name beats the prefab label. */
export function gridDisplayName(node: { name: string; id: string }, named?: string | null): string {
  return named?.trim() || node.name || node.id;
}

/** Owner-tagged grids are hull ids of the form `tagged:<gridId>`. */
export function hullIdForGrid(gridId: string, hullIds: Set<string>, prefab: string): string | null {
  const tagged = `tagged:${gridId}`;
  if (hullIds.has(tagged)) return tagged;
  const prefabId = `prefab:${prefab}`;
  if (hullIds.has(prefabId)) return prefabId;
  return hullIds.values().next().value ?? null;
}

/** Filename-safe stamp for a screenshot, used only by the demo script. */
export function moveSummaryLine(preflight: MovePreflight | null): string {
  if (!preflight) return 'Checking the destination…';
  if (!preflight.ok && preflight.block) return preflight.block.message;
  return preflight.summary || `${preflight.linkText}. ${preflight.etaText}.`;
}
