/**
 * Links view (contract §1): what exists now vs what could exist.
 *
 * `GET /api/demo/links` exposes this. The split matters because the two halves
 * come from different sources and the UI must not blur them:
 *
 *   current  GAME      radio groups the plugin reports for its antennas, and
 *                      laser pairs whose blocks both read `Connected`
 *   current  SIMULATED planner range maths (radio radius / laser cap)
 *   possible SIMULATED range + LOS + free-port maths, each row carrying the
 *                      reason it is or is not feasible
 *
 * Nothing here invents a link: a laser pair is only GAME when the plugin says
 * the beam is up. Asteroid occlusion is not in the planet model, so when the
 * plugin has no `probe_los` the row is marked `LOS unchecked` instead of being
 * silently treated as clear.
 */
import type { Planet } from '@se-rts/schemas';
import { segmentIntersectsSphere, type V3 } from '../planner/geometry.js';

/**
 * Laser reach is effectively unlimited in engine terms: the laser antenna
 * reports a 99 764 km limit, which is the integer ceiling rather than a range
 * anyone can exceed in a planet system. The only real constraint is LINE OF
 * SIGHT (measured 2026-11-10; see docs/reality-check.md). This constant exists
 * only as a sanity ceiling so a nonsense coordinate cannot produce a link, and
 * so a per-node hardware override can still tighten it.
 */
export const LASER_MODEL_CAP_M = 2_000_000;
/** Contract radio safety factor: pairs must fit inside 0.9 x min(radius). */
export const RADIO_SAFETY_FACTOR = 0.9;
/** Added to a planet's max hill radius when testing occlusion. */
export const LOS_MARGIN_M = 1_000;

export interface LinkNode {
  id: string;
  name?: string;
  position: V3;
  radioRadiusM: number | null;
  /** Laser antennas on the grid (ports). */
  laserPorts: number;
  /** Ports already consumed by a connected beam. */
  laserUsedPorts?: number;
  /** Per-end laser range; null = unknown (demo cap applies). */
  laserRangeM?: number | null;
  /** Radio present and broadcasting; null = unknown. */
  radioBroadcasting?: boolean | null;
}

export interface RadioGroup {
  id: string;
  members: string[];
}

export interface LiveLaserPair {
  a: string;
  b: string;
  distanceM?: number;
  mutual?: boolean;
}

export interface SimulatedEdge {
  from: string;
  to: string;
  kind: 'radio' | 'laser';
  distanceM: number;
}

export interface LosProbe {
  clear: boolean;
  /** Body/asteroid name when blocked. */
  body?: string | null;
}

export interface LinksInput {
  nodes: LinkNode[];
  planets: Planet[];
  /** Game-reported antenna group membership (plugin `radio_links`). */
  radioGroups?: RadioGroup[];
  /** `Connected` laser pairs from the plugin's `laser_state` sample. */
  liveLaserPairs?: LiveLaserPair[];
  /** Range edges the planner graph already derived. */
  simulatedEdges?: SimulatedEdge[];
  /**
   * Optional `probe_los` raycast against asteroid voxels. Absent = the game
   * cannot answer yet; laser rows then say `LOS unchecked`.
   */
  probeLos?: (from: V3, to: V3) => Promise<LosProbe> | LosProbe;
  /** Caps the number of live raycasts per request. */
  maxProbes?: number;
}

export interface CurrentLink {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  label: 'GAME' | 'SIMULATED';
  lengthM: number;
  /** Where the GAME fact came from. */
  source?: string;
}

export interface PossibleLink {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  lengthM: number;
  reason: string;
  feasible: boolean;
}

export interface LinksSummary {
  radioEdges: number;
  laserEdges: number;
  possibleRadio: number;
  possibleLaser: number;
  isolated: string[];
}

export interface LinksView {
  current: CurrentLink[];
  possible: PossibleLink[];
  summary: LinksSummary;
  labels: { current: string[]; possible: string[] };
  notes: string[];
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pairKey = (a: string, b: string, kind: string): string =>
  [kind, ...[a, b].sort()].join('|');

function nodeIndex(nodes: LinkNode[]): Map<string, LinkNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** First planet sphere that blocks the segment, or null. */
export function blockingPlanet(from: V3, to: V3, planets: Planet[]): Planet | null {
  for (const planet of planets) {
    if (segmentIntersectsSphere(from, to, planet.center, planet.maxHillRadiusM + LOS_MARGIN_M)) return planet;
  }
  return null;
}

/** Neighbouring planet used by the `?planet=` filter (nearest centre wins). */
export function nodeMatchesPlanet(node: LinkNode, planets: Planet[], needle: string): boolean {
  const target = needle.trim().toLowerCase();
  if (!target) return true;
  const named = planets.filter((p) => p.name.toLowerCase() === target || p.id.toLowerCase() === target);
  const candidates = named.length ? named : planets.filter((p) => p.name.toLowerCase().includes(target));
  if (!candidates.length) return false;
  let best = candidates[0]!;
  let bestDist = dist(node.position, best.center);
  for (const p of candidates.slice(1)) {
    const d = dist(node.position, p.center);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return bestDist <= best.maxHillRadiusM * 2;
}

/**
 * Build the links view. Pure except for the optional LOS probe, which is
 * awaited per otherwise-feasible laser pair (bounded by `maxProbes`).
 */
export async function buildLinksView(input: LinksInput): Promise<LinksView> {
  const nodes = input.nodes;
  const byId = nodeIndex(nodes);
  const planets = input.planets;

  // ---- current -----------------------------------------------------------
  const current: CurrentLink[] = [];
  const currentSeen = new Set<string>();
  const pushCurrent = (link: CurrentLink): void => {
    const key = pairKey(link.a, link.b, link.kind);
    if (currentSeen.has(key)) return;
    const a = byId.get(link.a);
    const b = byId.get(link.b);
    if (!a || !b) return;
    currentSeen.add(key);
    current.push({ ...link, lengthM: round1(link.lengthM || dist(a.position, b.position)) });
  };

  // GAME: game-reported antenna groups.
  for (const group of input.radioGroups ?? []) {
    const members = group.members.filter((id) => byId.has(id));
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = byId.get(members[i]!)!;
        const b = byId.get(members[j]!)!;
        pushCurrent({ a: a.id, b: b.id, kind: 'radio', label: 'GAME', lengthM: dist(a.position, b.position), source: `antenna group ${group.id}` });
      }
    }
  }

  // GAME: connected laser pairs.
  for (const pair of input.liveLaserPairs ?? []) {
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (!a || !b) continue;
    pushCurrent({ a: a.id, b: b.id, kind: 'laser', label: 'GAME', lengthM: pair.distanceM ?? dist(a.position, b.position), source: 'laser_state Connected' });
  }

  // SIMULATED: planner-derived range edges.
  for (const edge of input.simulatedEdges ?? []) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    pushCurrent({ a: a.id, b: b.id, kind: edge.kind, label: 'SIMULATED', lengthM: edge.distanceM, source: 'planner range maths' });
  }
  current.sort((x, y) => `${x.kind}|${x.a}|${x.b}`.localeCompare(`${y.kind}|${y.a}|${y.b}`));

  // ---- possible ----------------------------------------------------------
  const possible: PossibleLink[] = [];
  const feasiblePairs = new Set<string>();
  let probes = 0;
  const maxProbes = input.maxProbes ?? 24;

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const lengthM = dist(a.position, b.position);

      // Radio: interesting only if it fits at least the larger nominal radius.
      if (a.radioRadiusM !== null && b.radioRadiusM !== null) {
        const limit = RADIO_SAFETY_FACTOR * Math.min(a.radioRadiusM, b.radioRadiusM);
        const nominal = Math.max(a.radioRadiusM, b.radioRadiusM);
        if (lengthM <= limit) {
          possible.push({ a: a.id, b: b.id, kind: 'radio', lengthM: round1(lengthM), reason: 'in radio range', feasible: true });
          feasiblePairs.add(`${a.id}|${b.id}|radio`);
        } else if (lengthM <= nominal) {
          possible.push({
            a: a.id,
            b: b.id,
            kind: 'radio',
            lengthM: round1(lengthM),
            reason: `beyond radio range: ${Math.round(lengthM)} m > ${Math.round(limit)} m (0.9 x ${Math.min(a.radioRadiusM, b.radioRadiusM)} m)`,
            feasible: false,
          });
        }
      }

      // Laser: every pair that has a port on each end is worth explaining.
      if (a.laserPorts > 0 && b.laserPorts > 0) {
        const base = { a: a.id, b: b.id, kind: 'laser' as const, lengthM: round1(lengthM) };
        const aUsed = a.laserUsedPorts ?? 0;
        const bUsed = b.laserUsedPorts ?? 0;
        if (aUsed >= a.laserPorts || bUsed >= b.laserPorts) {
          possible.push({ ...base, reason: 'laser no free port', feasible: false });
          continue;
        }
        const rangeA = a.laserRangeM ?? LASER_MODEL_CAP_M;
        const rangeB = b.laserRangeM ?? LASER_MODEL_CAP_M;
        const limit = Math.min(rangeA, rangeB);
        if (lengthM > limit) {
          possible.push({ ...base, reason: `out of laser range: ${Math.round(lengthM)} m > ${Math.round(limit)} m`, feasible: false });
          continue;
        }
        const blocker = blockingPlanet(a.position, b.position, planets);
        if (blocker) {
          possible.push({ ...base, reason: `occluded by ${blocker.name}`, feasible: false });
          continue;
        }
        if (input.probeLos && probes < maxProbes) {
          probes += 1;
          let probe: LosProbe;
          try {
            probe = await input.probeLos(a.position, b.position);
          } catch {
            probe = { clear: true, body: null };
          }
          if (!probe.clear) {
            possible.push({ ...base, reason: `occluded by ${probe.body ?? 'asteroid'}`, feasible: false });
            continue;
          }
          possible.push({ ...base, reason: 'laser LOS clear', feasible: true });
        } else {
          possible.push({ ...base, reason: 'laser LOS unchecked', feasible: true });
        }
        feasiblePairs.add(`${a.id}|${b.id}|laser`);
      }
    }
  }
  possible.sort(
    (x, y) =>
      Number(y.feasible) - Number(x.feasible) ||
      `${x.kind}|${x.a}|${x.b}`.localeCompare(`${y.kind}|${y.a}|${y.b}`),
  );

  // ---- summary -----------------------------------------------------------
  const connected = new Set<string>();
  for (const link of current) {
    connected.add(link.a);
    connected.add(link.b);
  }
  const isolated = nodes
    .map((n) => n.id)
    .filter((id) => {
      if (connected.has(id)) return false;
      for (const key of feasiblePairs) {
        const [a, b] = key.split('|');
        if (a === id || b === id) return false;
      }
      return true;
    })
    .sort();

  const summary: LinksSummary = {
    radioEdges: current.filter((l) => l.kind === 'radio').length,
    laserEdges: current.filter((l) => l.kind === 'laser').length,
    possibleRadio: possible.filter((l) => l.kind === 'radio' && l.feasible).length,
    possibleLaser: possible.filter((l) => l.kind === 'laser' && l.feasible).length,
    isolated,
  };

  return {
    current,
    possible,
    summary,
    labels: {
      current: [
        'GAME: radio groups and Connected laser pairs come from the plugin',
        'SIMULATED: planner range maths over provisioned antenna radii',
      ],
      possible: [
        'SIMULATED: range, planet-sphere LOS and free-port maths',
        input.probeLos ? 'GAME: asteroid LOS from the plugin probe_los raycast' : 'UNVERIFIED: asteroid LOS is not probed; rows say LOS unchecked',
      ],
    },
    notes: input.probeLos
      ? [`asteroid LOS probed for ${probes} pair(s)`]
      : ['no probe_los action available: laser rows are marked LOS unchecked'],
  };
}

interface PluginReadable {
  state?: string;
  value?: unknown;
}

/**
 * Turn the plugin's `radio_links` read into groups of grid ids that the game
 * says share one logical antenna group. That is the only connectivity fact SE
 * exposes without a player: grids whose antennas can reach each other, direct
 * or relayed, share a representative. UNVERIFIED reads are dropped, not guessed.
 */
export function radioGroupsFromPlugin(result: unknown): RadioGroup[] {
  const grids = (result as { grids?: Array<Record<string, unknown>> } | null)?.grids;
  if (!Array.isArray(grids)) return [];
  const buckets = new Map<string, string[]>();
  for (const row of grids) {
    const gridId = typeof row.gridId === 'string' ? row.gridId : null;
    if (!gridId) continue;
    const rep = row.logicalGroupRepresentative as PluginReadable | undefined;
    if (!rep || rep.state !== 'readable' || typeof rep.value !== 'string') continue;
    const members = buckets.get(rep.value) ?? [];
    members.push(gridId);
    buckets.set(rep.value, members);
  }
  return [...buckets.entries()].map(([id, members]) => ({ id, members: members.sort() }));
}
