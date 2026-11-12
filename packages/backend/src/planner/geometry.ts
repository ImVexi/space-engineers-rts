import type { Planet } from '@se-rts/schemas';

/** Small, dependency-free 3D vector helpers used by the planner. */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: V3): number => Math.sqrt(dot(a, a));
export const dist = (a: V3, b: V3): number => len(sub(a, b));

export function normalize(a: V3): V3 {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}

export function lerp(a: V3, b: V3, t: number): V3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Any unit vector perpendicular to `a` (deterministic fallback). */
export function anyPerpendicular(a: V3): V3 {
  const axis = Math.abs(a.x) < 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  return normalize(cross(a, axis));
}

/** Squared distance from a point to a segment (clamped endpoints). */
export function pointSegmentDistanceSq(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const denom = dot(ab, ab);
  const t = denom > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / denom)) : 0;
  const closest = add(a, scale(ab, t));
  const d = sub(p, closest);
  return dot(d, d);
}

/** True when the closed segment `a`–`b` passes through the sphere. */
export function segmentIntersectsSphere(a: V3, b: V3, center: V3, radius: number): boolean {
  if (radius <= 0) return false;
  return pointSegmentDistanceSq(center, a, b) < radius * radius;
}

/** Anchor on the planet surface facing `toward`, raised by `altitudeM`. */
export function surfaceAnchor(planet: Planet, toward: V3, altitudeM: number): V3 {
  const dir = normalize(sub(toward, planet.center));
  const safe = len(dir) > 0 ? dir : v3(0, 1, 0);
  return add(planet.center, scale(safe, planet.maxHillRadiusM + altitudeM));
}

/**
 * Insert an arc of waypoints around a blocking sphere between segments
 * p->q. The arc sits on a sphere of radius `radius + clearance`; its endpoints
 * are radial projections of p and q. Every connector is radial and therefore
 * outside the sphere.
 */
export function arcAroundSphere(
  p: V3,
  q: V3,
  center: V3,
  radius: number,
  clearanceM: number,
  maxStepM: number,
): V3[] {
  const arcRadius = radius + Math.max(clearanceM, 1);
  const e1 = normalize(sub(p, center));
  const e1safe = len(e1) > 0 ? e1 : v3(1, 0, 0);
  const qv = sub(q, center);
  let e2 = sub(qv, scale(e1safe, dot(qv, e1safe)));
  if (len(e2) < 1e-6) e2 = anyPerpendicular(e1safe);
  e2 = normalize(e2);
  const qx = dot(qv, e1safe);
  const qy = dot(qv, e2);
  let theta = Math.atan2(qy, qx);
  if (theta < 0) theta += Math.PI * 2;
  if (theta > Math.PI) theta = Math.PI * 2 - theta; // shorter arc, mirrored
  const arcLength = arcRadius * theta;
  // Keep each chord clear of the blocking sphere.
  const cosHalf = Math.min(1, (radius + 1) / arcRadius);
  const maxChord = 2 * arcRadius * Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf));
  const step = Math.max(1, Math.min(maxStepM, maxChord));
  const segments = Math.max(1, Math.ceil(arcLength / step));
  const points: V3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (theta * i) / segments;
    points.push(
      add(center, add(scale(e1safe, Math.cos(angle) * arcRadius), scale(e2, Math.sin(angle) * arcRadius))),
    );
  }
  return points;
}

/** Fibonacci-sphere unit directions, deterministic for a given count. */
export function fibonacciDirections(count: number): V3[] {
  const n = Math.max(1, Math.floor(count));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: V3[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return out;
}
