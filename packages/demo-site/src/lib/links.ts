/**
 * Links overlay: current (game-reported) vs possible (within range/LOS/ports).
 * Possible edges are a planner estimate and always drawn dimmer + dashed.
 */
export type LinkMode = 'off' | 'current' | 'possible' | 'both';

export interface CurrentLink {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  label: 'GAME' | 'SIMULATED' | string;
  lengthM: number;
}

export interface PossibleLink {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  lengthM: number;
  reason: string;
  feasible: boolean;
}

export interface LinksResponse {
  current: CurrentLink[];
  possible: PossibleLink[];
  summary?: {
    radioEdges?: number;
    laserEdges?: number;
    possibleRadio?: number;
    possibleLaser?: number;
    isolated?: string[];
  };
}

export const LINK_MODES: { value: LinkMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Hide the link overlay' },
  { value: 'current', label: 'Current', hint: 'Links the game reports right now' },
  { value: 'possible', label: 'Possible', hint: 'Links that could exist within range, LOS and ports' },
  { value: 'both', label: 'Both', hint: 'Current solid, possible dimmer and dashed' },
];

function edgeKey(link: { a: string; b: string; kind: string }): string {
  return `${[link.a, link.b].sort().join('|')}|${link.kind}`;
}

/** Empty response used while the route is missing (feature-detect 404). */
export const EMPTY_LINKS: LinksResponse = { current: [], possible: [] };

export function filterLinks(
  response: LinksResponse | null,
  mode: LinkMode,
): { current: CurrentLink[]; possible: PossibleLink[] } {
  if (!response || mode === 'off') return { current: [], possible: [] };
  const seen = new Set<string>();
  const current: CurrentLink[] = [];
  for (const link of response.current ?? []) {
    const key = edgeKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(link);
  }
  if (mode === 'current') return { current, possible: [] };
  const existing = new Set(current.map(edgeKey));
  const possible: PossibleLink[] = [];
  const seenPossible = new Set<string>();
  for (const link of response.possible ?? []) {
    const key = edgeKey(link);
    if (existing.has(key) || seenPossible.has(key)) continue;
    seenPossible.add(key);
    possible.push(link);
  }
  return { current: mode === 'possible' ? [] : current, possible };
}

export function countChip(response: LinksResponse | null): string {
  if (!response) return '0 current · 0 possible';
  return `${response.current?.length ?? 0} current · ${response.possible?.length ?? 0} possible`;
}

export function linkHoverText(link: CurrentLink | PossibleLink): string {
  const kind = link.kind === 'laser' ? 'laser' : 'radio';
  const km = link.lengthM >= 1000 ? `${(link.lengthM / 1000).toFixed(1)} km` : `${Math.round(link.lengthM)} m`;
  if ('label' in link) return `${kind} · ${km} · ${link.label}`;
  const why = link.feasible ? 'SIMULATED' : `SIMULATED · not feasible: ${link.reason}`;
  return `${kind} · ${km} · ${why}`;
}

/** Map/CSS style for a possible edge: dimmer, dashed, amber when infeasible. */
export function possibleLinkStyle(link: PossibleLink): { opacity: number; dash: string; color: string } {
  return {
    opacity: link.feasible ? 0.42 : 0.26,
    dash: '6 6',
    color: link.kind === 'laser' ? '#8fa6e8' : '#c9a06a',
  };
}

export interface CurrentLinkStyle {
  provenance: 'GAME' | 'SIMULATED';
  color: string;
  lineWidth: number;
  opacity: number;
  dashed: boolean;
  dashSize: number;
  gapSize: number;
}

/**
 * Map a current link's provenance to its map style. GAME (measured in the
 * game: radio groups + Connected laser pairs) is solid and bright; SIMULATED
 * (planner range math) is dimmer and dashed. Anything not explicitly GAME is
 * treated as SIMULATED so a new label can never masquerade as measured.
 */
export function currentLinkStyle(link: Pick<CurrentLink, 'kind' | 'label'>): CurrentLinkStyle {
  if (link.label === 'GAME') {
    return {
      provenance: 'GAME',
      color: link.kind === 'laser' ? '#dbe7ff' : '#ffd27f',
      lineWidth: 1.9,
      opacity: 0.92,
      dashed: false,
      dashSize: 0,
      gapSize: 0,
    };
  }
  return {
    provenance: 'SIMULATED',
    color: link.kind === 'laser' ? '#7f90ad' : '#9a8f7d',
    lineWidth: 1.0,
    opacity: 0.46,
    dashed: true,
    dashSize: 3,
    gapSize: 2.4,
  };
}

/**
 * Current links that belong on the map. Only `response.current` is a source
 * (possible edges never leak into this layer), duplicates are collapsed, and
 * an edge with an endpoint missing from the scene is skipped rather than drawn
 * to the origin.
 */
export function currentLinkPairs(
  response: LinksResponse | null,
  opts: { nodeIds?: ReadonlySet<string>; laser?: boolean } = {},
): CurrentLink[] {
  const out: CurrentLink[] = [];
  const seen = new Set<string>();
  for (const link of response?.current ?? []) {
    if (link.kind === 'laser' && opts.laser === false) continue;
    if (opts.nodeIds && (!opts.nodeIds.has(link.a) || !opts.nodeIds.has(link.b))) continue;
    const key = edgeKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}
