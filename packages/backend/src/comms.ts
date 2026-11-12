import { PROTOCOL_LIMITS, type PluginLink } from '@se-rts/schemas';
import type { LinkRecord, UnitRecord } from './store.js';

/**
 * Comms authority stub ("no connection, no control").
 *
 * A unit is commandable only when its latest telemetry marks the link up and
 * is younger than `freshMs` (30 s). Optionally the caller supplies control
 * sources; then a unit must additionally be graph-reachable from one of them
 * across `up` links. The real range/LOS graph lands in P5; this function is
 * the single gate every order already goes through.
 */
export interface CommsOptions {
  freshMs?: number;
  sources?: string[];
}

export function isFresh(unit: Pick<UnitRecord, 'linkStatus' | 'lastSeen'>, now: number, freshMs: number): boolean {
  return unit.linkStatus === 'up' && now - unit.lastSeen < freshMs;
}

export function reachableUnits(
  units: Pick<UnitRecord, 'id' | 'linkStatus' | 'lastSeen'>[],
  links: Pick<LinkRecord, 'a' | 'b' | 'status'>[],
  now: number,
  opts: CommsOptions = {},
): Set<string> {
  const freshMs = opts.freshMs ?? PROTOCOL_LIMITS.telemetryFreshMs;
  const fresh = new Set(units.filter((u) => isFresh(u, now, freshMs)).map((u) => u.id));

  if (!opts.sources?.length) return fresh;

  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (link.status !== 'up') continue;
    adjacency.set(link.a, [...(adjacency.get(link.a) ?? []), link.b]);
    adjacency.set(link.b, [...(adjacency.get(link.b) ?? []), link.a]);
  }

  const queue = opts.sources.filter((s) => fresh.has(s));
  const seen = new Set(queue);
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next) && fresh.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  // Even when a graph path exists, stale or down telemetry means no control.
  return new Set([...seen].filter((id) => fresh.has(id)));
}

export function isUnitReachable(
  units: Pick<UnitRecord, 'id' | 'linkStatus' | 'lastSeen'>[],
  links: Pick<LinkRecord, 'a' | 'b' | 'status'>[],
  unitId: string,
  now: number,
  opts: CommsOptions = {},
): boolean {
  return reachableUnits(units, links, now, opts).has(unitId);
}

/** Normalises plugin-reported links for storage (dedupes A-B / B-A). */
export function normaliseLinks(links: PluginLink[]): PluginLink[] {
  const seen = new Set<string>();
  const out: PluginLink[] = [];
  for (const link of links) {
    const [a, b] = [link.a, link.b].sort();
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, a: a!, b: b! });
  }
  return out;
}
