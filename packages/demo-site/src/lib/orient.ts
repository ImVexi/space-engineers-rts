import * as THREE from 'three'
import type { Quat, Vec3 } from './worldMapTypes'

/**
 * SE `BlockOrientation` (Forward, Up) pair -> 0..23 index.
 *
 * The order MUST match `backend/app/blocks.py::ORIENTATIONS` exactly:
 *   Forward in (Forward, Backward, Left, Right, Up, Down)
 *   Up      in (Up, Down, Forward, Backward, Left, Right), skipping
 *           Up == Forward and Up == opposite(Forward).
 * Index 0 is the identity (Forward/Up).
 */
export const SE_FACES = ['Forward', 'Backward', 'Left', 'Right', 'Up', 'Down'] as const
export type SeFace = (typeof SE_FACES)[number]

/** Unit vectors in SE/three axes (right-handed, Y up, -Z forward). No flip. */
export const FACE_VECTOR: Record<SeFace, Vec3> = {
  Forward: { x: 0, y: 0, z: -1 },
  Backward: { x: 0, y: 0, z: 1 },
  Left: { x: -1, y: 0, z: 0 },
  Right: { x: 1, y: 0, z: 0 },
  Up: { x: 0, y: 1, z: 0 },
  Down: { x: 0, y: -1, z: 0 },
}

const OPPOSITE: Record<SeFace, SeFace> = {
  Forward: 'Backward',
  Backward: 'Forward',
  Left: 'Right',
  Right: 'Left',
  Up: 'Down',
  Down: 'Up',
}

export interface OrientationPair {
  forward: SeFace
  up: SeFace
}

/** The 24 valid (Forward, Up) pairs, in backend order. */
export const ORIENTATION_PAIRS: OrientationPair[] = SE_FACES.flatMap((forward) =>
  (['Up', 'Down', 'Forward', 'Backward', 'Left', 'Right'] as SeFace[])
    .filter((up) => up !== forward && up !== OPPOSITE[forward])
    .map((up) => ({ forward, up })),
)

if (ORIENTATION_PAIRS.length !== 24 || ORIENTATION_PAIRS[0].forward !== 'Forward' || ORIENTATION_PAIRS[0].up !== 'Up') {
  throw new Error('orientation table is not the backend 24-entry table')
}

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z)
}

/**
 * Rotation taking the authored shape basis to the block's orientation.
 *
 * A block's local axes are right-handed with local +Y = Up and local forward
 * (-Z) = Forward. Given the world-space images f and u of those axes:
 *   right = f × u,  up = u,  back = -f
 * which is a proper rotation (det +1) for every valid pair.
 */
export function orientationQuaternion(index: number): Quat {
  const pair = ORIENTATION_PAIRS[normaliseIndex(index)]
  const f = FACE_VECTOR[pair.forward]
  const u = FACE_VECTOR[pair.up]
  const fv = v(f.x, f.y, f.z)
  const uv = v(u.x, u.y, u.z)
  const right = fv.clone().cross(uv)
  const m = new THREE.Matrix4().makeBasis(right, uv, fv.clone().negate())
  const q = new THREE.Quaternion().setFromRotationMatrix(m)
  return { x: q.x, y: q.y, z: q.z, w: q.w }
}

/** Clamp any byte to a valid index (unknown values use the identity). */
export function normaliseIndex(index: number): number {
  if (!Number.isFinite(index)) return 0
  const i = Math.trunc(index)
  return i >= 0 && i < 24 ? i : 0
}

/** Reusable THREE quaternion for instance building. */
export function orientationThreeQuat(index: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const q = orientationQuaternion(index)
  return out.set(q.x, q.y, q.z, q.w)
}

/** Forward axis after applying orientation `index` (used by tests). */
export function orientedForward(index: number): Vec3 {
  return FACE_VECTOR[ORIENTATION_PAIRS[normaliseIndex(index)].forward]
}

/** Up axis after applying orientation `index`. */
export function orientedUp(index: number): Vec3 {
  return FACE_VECTOR[ORIENTATION_PAIRS[normaliseIndex(index)].up]
}
