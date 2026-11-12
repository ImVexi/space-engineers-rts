/**
 * Satellite groups (CONTRACT-FEATURES §4).
 *
 * A group is a named, coloured set of grid ids. Grids may belong to more than
 * one group. Everything here is pure so the reducer and the map bracket can be
 * tested without React, and so the same rules apply to localStorage and to the
 * backend copy.
 */
import type { Vec3 } from '../types';

export interface ShipGroup {
  id: string;
  name: string;
  color: string;
  members: string[];
}

export type GroupEvent =
  | { type: 'add'; id: string; name: string; color: string; members: string[] }
  | { type: 'rename'; id: string; name: string }
  | { type: 'recolor'; id: string; color: string }
  | { type: 'delete'; id: string }
  | { type: 'members'; id: string; members: string[] }
  | { type: 'toggleMember'; id: string; gridId: string }
  | { type: 'replace'; groups: ShipGroup[] };

/** Palette chosen for contrast on the dark map; brass is reserved for actions. */
export const GROUP_COLORS = ['#74d3c4', '#9eb7ff', '#e0b072', '#c9a6ff', '#8fbf9e', '#ff9aa2'];

export const GROUP_STORAGE_KEY = 'se-rts-demo-groups';

export function groupColor(index: number): string {
  return GROUP_COLORS[Math.abs(index) % GROUP_COLORS.length]!;
}

function uniqMembers(members: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of members) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function groupsReducer(groups: ShipGroup[], event: GroupEvent): ShipGroup[] {
  switch (event.type) {
    case 'add': {
      const name = event.name.trim();
      if (!name || event.members.length === 0) return groups;
      if (groups.some((g) => g.id === event.id)) return groups;
      return [...groups, { id: event.id, name, color: event.color, members: uniqMembers(event.members) }];
    }
    case 'rename': {
      const name = event.name.trim();
      if (!name) return groups;
      return groups.map((g) => (g.id === event.id ? { ...g, name } : g));
    }
    case 'recolor':
      return groups.map((g) => (g.id === event.id ? { ...g, color: event.color } : g));
    case 'delete':
      return groups.filter((g) => g.id !== event.id);
    case 'members':
      return groups.map((g) => (g.id === event.id ? { ...g, members: uniqMembers(event.members) } : g));
    case 'toggleMember':
      return groups.map((g) => {
        if (g.id !== event.id) return g;
        const has = g.members.includes(event.gridId);
        return { ...g, members: has ? g.members.filter((m) => m !== event.gridId) : [...g.members, event.gridId] };
      });
    case 'replace':
      return event.groups.map((g) => ({ ...g, members: uniqMembers(g.members) }));
    default:
      return groups;
  }
}

export function nextGroupName(groups: ShipGroup[]): string {
  const used = new Set(groups.map((g) => g.name.toLowerCase()));
  for (let i = 1; i < 200; i += 1) {
    const name = `Group ${i}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `Group ${groups.length + 1}`;
}

export function newGroupId(now: number = Date.now()): string {
  return `g-${now.toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Which groups a grid belongs to (a grid may be in several). */
export function membershipOf(groups: ShipGroup[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of groups) {
    for (const id of group.members) {
      const list = map.get(id) ?? [];
      list.push(group.id);
      map.set(id, list);
    }
  }
  return map;
}

/** Drops ids that no longer exist in the live state. */
export function pruneGroups(groups: ShipGroup[], liveIds: string[]): ShipGroup[] {
  const live = new Set(liveIds);
  let changed = false;
  const next = groups.map((g) => {
    const members = g.members.filter((id) => live.has(id));
    if (members.length !== g.members.length) changed = true;
    return members.length === g.members.length ? g : { ...g, members };
  });
  return changed ? next : groups;
}

export interface GroupBracket {
  center: Vec3;
  /** full box dimensions, metres, never smaller than 200 m */
  size: Vec3;
  members: number;
}

/**
 * Axis-aligned bracket around the group's members. A single member gets a
 * small box so the colour chip still points at something; an empty group has
 * no bracket at all.
 */
export function bracketFor(points: Vec3[]): GroupBracket | null {
  if (points.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  const span = (lo: number, hi: number) => Math.max(200, hi - lo) * 1.15;
  const size = { x: span(min.x, max.x), y: span(min.y, max.y), z: span(min.z, max.z) };
  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    size,
    members: points.length,
  };
}

interface WireGroup {
  id?: unknown;
  name?: unknown;
  color?: unknown;
  members?: unknown;
}

/** Tolerant parser: the backend may still be rolling the route out. */
export function parseGroups(body: unknown): ShipGroup[] {
  const wire = body as { groups?: unknown } | null;
  const list = Array.isArray(wire?.groups) ? wire.groups : Array.isArray(body) ? body : [];
  const out: ShipGroup[] = [];
  for (const raw of list as WireGroup[]) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue;
    out.push({
      id: raw.id,
      name: raw.name,
      color: typeof raw.color === 'string' && raw.color ? raw.color : groupColor(out.length),
      members: Array.isArray(raw.members) ? uniqMembers(raw.members.filter((m): m is string => typeof m === 'string')) : [],
    });
  }
  return out;
}

export function loadLocalGroups(storage: Pick<Storage, 'getItem'> | null): ShipGroup[] {
  if (!storage) return [];
  try {
    return parseGroups(JSON.parse(storage.getItem(GROUP_STORAGE_KEY) ?? 'null'));
  } catch {
    return [];
  }
}

export function saveLocalGroups(storage: Pick<Storage, 'setItem'> | null, groups: ShipGroup[]): void {
  if (!storage) return;
  try {
    storage.setItem(GROUP_STORAGE_KEY, JSON.stringify({ groups }));
  } catch {
    /* private mode: groups stay in memory this session */
  }
}
