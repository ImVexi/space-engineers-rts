/**
 * Camera contexts: what the rig orbits and which way is "up" there.
 *
 * A context is stored as a tiny descriptor (kind + id + up mode) and resolved
 * against live data on every render, so polling can never make the stack go
 * stale or reset the camera. The frame maths lives in ./camera; this module
 * only decides the pivot point and the up vector for each level.
 *
 *   SYSTEM  pivot = planets' centroid            up = world +Y
 *   PLANET  pivot = planet centre                up = planet polar axis (+Y)
 *   GROUP   pivot = member centroid              up = planet-radial at centroid
 *   SHIP    pivot = the ship                     up = planet-radial (gravity),
 *                                                    or the grid's own up in
 *                                                    zero-g ('ship' mode)
 */
import type { Vec3, DemoNode, Planet } from '../types';
import type { Vec3Like } from './camera';
import { WORLD_UP, unitVector } from './camera';

export type ContextKind = 'system' | 'planet' | 'group' | 'ship';
/** Which up a ship context prefers: local gravity, or the grid's own up. */
export type UpMode = 'gravity' | 'ship';

export interface ContextTarget {
  kind: ContextKind;
  /** planet name / group id / node id; ignored for the system level */
  id: string;
  upMode: UpMode;
}

export interface CameraContext extends ContextTarget {
  /** stable key: 'system' | 'planet:EarthLike' | 'group:g1' | 'ship:grid:7' */
  key: string;
  label: string;
  /** pivot in scene kilometres */
  pivot: Vec3Like;
  /** unit local up */
  up: Vec3Like;
  /** the planet that owns this frame, when there is one */
  planetId: string | null;
  /** group members (ids) for group contexts, else [] */
  members: string[];
  /** framing hint in km (the rig pulls back ~4x this) */
  radiusKm: number;
}

export interface ContextWorld {
  planets: Planet[];
  nodes: (Pick<DemoNode, 'id' | 'name' | 'position' | 'planet'> & {
    /** optional live orientation, used for the ship's own up in zero-g */
    telemetry?: { quat?: { x: number; y: number; z: number; w: number } | null } | null;
  })[];
  groups: { id: string; name: string; members: string[] }[];
  names: Record<string, string>;
}

export function contextKey(target: ContextTarget): string {
  return target.kind === 'system' ? 'system' : `${target.kind}:${target.id}`;
}

export function systemTarget(): ContextTarget {
  return { kind: 'system', id: 'system', upMode: 'gravity' };
}

const KM = 1000;

function toKm(v: Vec3): Vec3Like {
  return { x: v.x / KM, y: v.y / KM, z: v.z / KM };
}

function vec(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

/** Distance from a point to a planet centre, and the planet's influence radius. */
function influence(pos: Vec3Like, planet: Planet): { distance: number; radius: number } {
  const c = toKm(planet.center);
  return {
    distance: Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z),
    radius: Math.max(planet.maxHillRadiusM, planet.surfaceRadiusM) / KM,
  };
}

/**
 * The planet whose sphere of influence contains `pos`, choosing the tightest
 * one. Null in deep space. Pure so the frame tests can run without three.js.
 */
export function planetOwning(pos: Vec3Like, planets: Planet[]): Planet | null {
  let best: { planet: Planet; ratio: number } | null = null;
  for (const planet of planets) {
    const { distance, radius } = influence(pos, planet);
    if (radius <= 0 || distance > radius) continue;
    const ratio = distance / radius;
    if (!best || ratio < best.ratio) best = { planet, ratio };
  }
  return best ? best.planet : null;
}

/**
 * Local gravity up at `pos`: planet centre -> pos. Falls back to world +Y in
 * deep space, where no planet defines a horizon.
 */
export function gravityUp(pos: Vec3Like, planets: Planet[]): { up: Vec3Like; planet: Planet | null } {
  const planet = planetOwning(pos, planets);
  if (!planet) return { up: { ...WORLD_UP }, planet: null };
  const c = toKm(planet.center);
  return { up: unitVector({ x: pos.x - c.x, y: pos.y - c.y, z: pos.z - c.z }), planet };
}

/** Rotate the grid's local +Y by its telemetry quaternion (ship up in zero-g). */
export function gridUp(quat: { x: number; y: number; z: number; w: number } | null | undefined): Vec3Like {
  if (!quat) return { ...WORLD_UP };
  const { x, y, z, w } = quat;
  const n = Math.hypot(x, y, z, w);
  if (!Number.isFinite(n) || n < 1e-9) return { ...WORLD_UP };
  const q = { x: x / n, y: y / n, z: z / n, w: w / n };
  // v' = v + 2*w*(q x v) + 2*(q x (q x v)) for v = grid +Y.
  const v = { x: 0, y: 1, z: 0 };
  const t = {
    x: 2 * (q.y * v.z - q.z * v.y),
    y: 2 * (q.z * v.x - q.x * v.z),
    z: 2 * (q.x * v.y - q.y * v.x),
  };
  return unitVector(
    {
      x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y),
      y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z),
      z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x),
    },
    WORLD_UP,
  );
}

function centroid(points: Vec3Like[]): Vec3Like {
  if (points.length === 0) return vec(0, 0, 0);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return vec(x / points.length, y / points.length, z / points.length);
}

/** Fit a pull-back radius that keeps a group of grids framed. */
function groupRadius(points: Vec3Like[]): number {
  if (points.length <= 1) return 0.15;
  const c = centroid(points);
  let spread = 0;
  for (const p of points) spread = Math.max(spread, Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z));
  return Math.max(0.03, spread * 1.2);
}

/**
 * Resolve a descriptor into a live context. Returns null when the underlying
 * object disappeared (a despawned grid, a deleted group) so callers can fall
 * back one level instead of orbiting a ghost.
 */
export function resolveContext(target: ContextTarget, world: ContextWorld): CameraContext | null {
  const key = contextKey(target);
  switch (target.kind) {
    case 'system': {
      const centres = world.planets.map((p) => toKm(p.center));
      const pivot = centres.length > 0 ? centroid(centres) : vec(0, 0, 0);
      let reach = 0;
      for (const c of centres) reach = Math.max(reach, Math.hypot(c.x - pivot.x, c.y - pivot.y, c.z - pivot.z));
      return {
        ...target,
        key,
        label: 'System',
        pivot,
        up: { ...WORLD_UP },
        planetId: null,
        members: [],
        radiusKm: Math.max(40, reach),
      };
    }
    case 'planet': {
      const planet = world.planets.find((p) => p.name === target.id || p.id === target.id);
      if (!planet) return null;
      return {
        ...target,
        key,
        label: planet.name,
        pivot: toKm(planet.center),
        // SE planets are axis-aligned spheres: the polar axis IS world +Y.
        up: { ...WORLD_UP },
        planetId: planet.id,
        members: [],
        radiusKm: Math.max(0.5, planet.surfaceRadiusM / KM),
      };
    }
    case 'group': {
      const group = world.groups.find((g) => g.id === target.id);
      if (!group) return null;
      const points = group.members
        .map((id) => world.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map((n) => toKm(n.position));
      if (points.length === 0) return null;
      const pivot = centroid(points);
      // Group up is planet-radial at the centroid so the planet stays "below"
      // and WASD/QE move along that local horizon rather than world axes.
      const { up, planet } = gravityUp(pivot, world.planets);
      return {
        ...target,
        key,
        label: group.name,
        pivot,
        up,
        planetId: planet?.id ?? null,
        members: group.members.slice(),
        radiusKm: groupRadius(points),
      };
    }
    case 'ship': {
      const node = world.nodes.find((n) => n.id === target.id);
      if (!node) return null;
      const pivot = toKm(node.position);
      const gravity = gravityUp(pivot, world.planets);
      const quat = (node as { telemetry?: { quat?: { x: number; y: number; z: number; w: number } | null } | null }).telemetry?.quat;
      const up =
        target.upMode === 'ship'
          ? gridUp(quat)
          : gravity.planet
            ? gravity.up
            : gridUp(quat);
      return {
        ...target,
        key,
        label: world.names[node.id] ?? node.name,
        pivot,
        up,
        planetId: gravity.planet?.id ?? null,
        members: [],
        radiusKm: 0.15,
      };
    }
    default:
      return null;
  }
}

/** True when `pos` sits on a planet's shell (used by double-click on terrain). */
export function planetAtPoint(pos: Vec3Like, planets: Planet[], toleranceKm = 6): Planet | null {
  let best: { planet: Planet; gap: number } | null = null;
  for (const planet of planets) {
    const c = toKm(planet.center);
    const radius = (planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM) / KM;
    const gap = Math.abs(Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z) - radius);
    if (gap > toleranceKm) continue;
    if (!best || gap < best.gap) best = { planet, gap };
  }
  return best ? best.planet : null;
}

/**
 * One line of plain words for the current level, shown next to the breadcrumb
 * so the frame change is never a mystery.
 */
export function contextDescription(context: CameraContext): string {
  switch (context.kind) {
    case 'system':
      return 'orbiting the system centre · up is world north';
    case 'planet':
      return `orbiting ${context.label}'s centre · up is its polar axis`;
    case 'group':
      return `orbiting ${context.label}'s centroid · up is local gravity`;
    case 'ship':
      return context.upMode === 'ship'
        ? `orbiting ${context.label} · up is the ship`
        : `orbiting ${context.label} · up is local gravity`;
    default:
      return '';
  }
}
