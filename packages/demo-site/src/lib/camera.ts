/**
 * Camera rig: ONE owner of the demo camera, no OrbitControls.
 *
 * State is a spherical pose { target (km), yaw, pitch, distance }. Every frame
 * the component derives the camera from that state; nothing else writes the
 * camera. Input mutates the pose directly (no damping, no inertia), a focus
 * request runs exactly one 350 ms tween, and any input cancels that tween.
 * Polling never touches the pose.
 *
 * Everything here is pure (no three.js) so the rig math is unit-testable.
 */
import type { FocusTarget, Planet, Vec3 } from '../types';
import { METERS_PER_UNIT, toScene } from './sceneMath';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface CameraPose {
  pos: Vec3Like;
  target: Vec3Like;
}

/** Zoom envelope shared with the wheel clamp (km). */
export const MIN_CAMERA_DISTANCE = 0.01;
export const MAX_CAMERA_DISTANCE = 40_000;
/** One wheel notch changes distance by 13 %. */
export const ZOOM_PER_NOTCH = 0.87;
/** A focus tween is short and one-shot. */
export const RIG_TWEEN_MS = 350;
/** Keep the camera off the poles so "up" never flips. */
export const PITCH_LIMIT = 1.48;
/** Left-drag orbit sensitivity, radians per pixel. */
export const ORBIT_SENSITIVITY = 0.005;
export const PAN_FOV_DEG = 50;
/** Free-look (in-place) pitch envelope: just short of straight up/down. */
export const LOOK_PITCH_LIMIT = 1.45;

/**
 * A local tangent frame. Orbit always turns about `up`, so the camera keeps a
 * constant height above the local horizon instead of swinging on a world-Y arc
 * that is skewed for anything away from the equator.
 */
export interface CameraFrame {
  /** local up (unit): the axis orbit rotates about */
  up: Vec3Like;
  /** local east, unit and perpendicular to `up` */
  east: Vec3Like;
  /** local north = east x up, unit and perpendicular to `up` */
  north: Vec3Like;
}

export interface LookState {
  yaw: number;
  pitch: number;
}

export const ZERO_LOOK: LookState = { yaw: 0, pitch: 0 };
export const WORLD_UP: Vec3Like = { x: 0, y: 1, z: 0 };

function dotv(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossv(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Unit vector, or `fallback` for a zero/NaN input. */
export function unitVector(v: Vec3Like, fallback: Vec3Like = WORLD_UP): Vec3Like {
  const n = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(n) || n < 1e-12) return { ...fallback };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/**
 * Build the tangent frame for a local up. `east` is the horizontal (world-Y)
 * cross product, with a stable fallback at the world poles; `north` completes
 * the basis. With up = +Y this is exactly (east, north, up) = (X, Z, Y), which
 * keeps the legacy spherical camera identical.
 */
export function frameFromUp(up: Vec3Like): CameraFrame {
  const u = unitVector(up);
  const raw = crossv(WORLD_UP, u);
  const east = Math.hypot(raw.x, raw.y, raw.z) < 1e-6 ? { x: 1, y: 0, z: 0 } : unitVector(raw, { x: 1, y: 0, z: 0 });
  const north = unitVector(crossv(east, u), { x: 0, y: 0, z: 1 });
  return { up: u, east, north };
}

/** The world frame: up = +Y. Used whenever no context frame is supplied. */
export const SYSTEM_FRAME: CameraFrame = frameFromUp(WORLD_UP);

/** Compose a direction from yaw/pitch in a frame: (cos p cos y, cos p sin y, sin p). */
export function directionIn(frame: CameraFrame, yaw: number, pitch: number): Vec3Like {
  const cp = Math.cos(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const sp = Math.sin(pitch);
  return {
    x: frame.east.x * cp * cy + frame.north.x * cp * sy + frame.up.x * sp,
    y: frame.east.y * cp * cy + frame.north.y * cp * sy + frame.up.y * sp,
    z: frame.east.z * cp * cy + frame.north.z * cp * sy + frame.up.z * sp,
  };
}

const FOCUS_DIR = (() => {
  const v = { x: 0.68, y: 0.52, z: 1 };
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
})();

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function len(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x > Math.PI) x -= twoPi;
  if (x < -Math.PI) x += twoPi;
  return x;
}

export function distanceBetween(a: Vec3Like, b: Vec3Like): number {
  return len(a, b);
}

/** Symmetric ease-in-out; monotonic, so a tween always reaches its goal. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export interface FocusPoseOptions {
  /** camera pull-back multiplier applied to the framed radius */
  spread?: number;
  minDistance?: number;
  maxDistance?: number;
}

function normalise(v: Vec3Like): Vec3Like {
  const n = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(n) || n < 1e-9) return FOCUS_DIR;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/**
 * Where the camera should end up for a focus target (direction + framed
 * distance). Surface targets are framed from above their own ground, never
 * through the globe; a target buried under the surface is lifted just outside.
 */
export function planFocusPose(
  target: FocusTarget,
  planets: (Pick<Planet, 'center' | 'maxHillRadiusM'> & { surfaceRadiusM?: number })[] = [],
  options: FocusPoseOptions = {},
): CameraPose {
  const spread = options.spread ?? 4;
  const minDistance = options.minDistance ?? MIN_CAMERA_DISTANCE;
  const maxDistance = options.maxDistance ?? MAX_CAMERA_DISTANCE;
  const c = toScene(target.pos);
  const radius = Math.max(target.radiusKm, 0.012);

  let dir = FOCUS_DIR;
  let floor = 0;
  for (const planet of planets) {
    const centre = toScene(planet.center);
    const hill = planet.maxHillRadiusM / METERS_PER_UNIT;
    // Older callers only supply the hill radius; it is the outer bound, so use
    // it as the solid-body radius when the real surface radius is unknown.
    const surfaceM = planet.surfaceRadiusM && planet.surfaceRadiusM > 0 ? planet.surfaceRadiusM : planet.maxHillRadiusM;
    const surface = surfaceM / METERS_PER_UNIT;
    const fromCentre = len(c, centre);
    if (fromCentre >= hill) continue;
    // Frame surface targets from above their own ground, never through the globe.
    if (fromCentre > 1e-3) dir = normalise({ x: c.x - centre.x, y: c.y - centre.y, z: c.z - centre.z });
    // Only lift the camera when the target itself is at/under the surface.
    floor = Math.max(floor, surface * 1.02 - fromCentre);
  }

  const distance = clamp(Math.max(radius * spread, floor), minDistance, maxDistance);

  return {
    pos: {
      x: c.x + dir.x * distance,
      y: c.y + dir.y * distance,
      z: c.z + dir.z * distance,
    },
    target: { x: c.x, y: c.y, z: c.z },
  };
}

/**
 * Per-event wheel notches, normalised across deltaMode (pixels / lines /
 * pages). Positive = zoom in. One event is capped at 1.2 notches so a single
 * trackpad flick or Firefox line-mode wheel can never cross the scene.
 */
export function wheelNotches(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return clamp(-px / 100, -1.2, 1.2);
}

/** Multiplicative dolly factor for a wheel event (<1 zoom in, >1 zoom out). */
export function zoomFactorForWheel(deltaY: number, deltaMode = 0): number {
  return Math.pow(ZOOM_PER_NOTCH, wheelNotches(deltaY, deltaMode));
}

/** Dolly camera and target about `anchor` (legacy helper, exercised by tests). */
export function dollyAboutAnchor(
  pos: Vec3Like,
  target: Vec3Like,
  anchor: Vec3Like,
  factor: number,
): CameraPose {
  const mix = (p: Vec3Like) => ({
    x: anchor.x + (p.x - anchor.x) * factor,
    y: anchor.y + (p.y - anchor.y) * factor,
    z: anchor.z + (p.z - anchor.z) * factor,
  });
  return { pos: mix(pos), target: mix(target) };
}

/** Free-flight speed in km/s, scaled to the rig distance. */
export function logFlightSpeed(distanceKm: number, shift = false): number {
  const d = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
  const base = Math.min(4000, Math.max(0.35, d * 0.35));
  return shift ? base * 4 : base;
}

/** Compose a free-flight velocity from camera-relative basis vectors. */
export function flightVelocity(
  forward: Vec3Like,
  right: Vec3Like,
  up: Vec3Like,
  keys: { w?: boolean; s?: boolean; a?: boolean; d?: boolean; q?: boolean; e?: boolean },
  speed: number,
): Vec3Like {
  const f = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const r = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  const u = (keys.e ? 1 : 0) - (keys.q ? 1 : 0);
  return {
    x: (forward.x * f + right.x * r + up.x * u) * speed,
    y: (forward.y * f + right.y * r + up.y * u) * speed,
    z: (forward.z * f + right.z * r + up.z * u) * speed,
  };
}

// ---------------------------------------------------------------------------
// Rig state
// ---------------------------------------------------------------------------

export interface RigState {
  /** orbit centre (scene km) */
  target: Vec3Like;
  /** radians; position = target + distance*(cos p cos y, sin p, cos p sin y) */
  yaw: number;
  /** radians, clamped to ±PITCH_LIMIT */
  pitch: number;
  /** km, clamped to [MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE] */
  distance: number;
}

export interface RigBasis {
  /** from camera toward the target */
  forward: Vec3Like;
  right: Vec3Like;
  up: Vec3Like;
}

export interface FlyKeys {
  w?: boolean;
  s?: boolean;
  a?: boolean;
  d?: boolean;
  q?: boolean;
  e?: boolean;
}

/** Unit vector from target toward camera, in the given local frame. */
export function rigDirection(state: RigState, frame: CameraFrame = SYSTEM_FRAME): Vec3Like {
  return directionIn(frame, state.yaw, state.pitch);
}

/** The one formula that places the camera (target + distance along the frame direction). */
export function rigPosition(state: RigState, frame: CameraFrame = SYSTEM_FRAME): Vec3Like {
  const d = rigDirection(state, frame);
  return {
    x: state.target.x + d.x * state.distance,
    y: state.target.y + d.y * state.distance,
    z: state.target.z + d.z * state.distance,
  };
}

/** Camera basis from the spherical pose in the local frame. */
export function rigBasis(state: RigState, frame: CameraFrame = SYSTEM_FRAME): RigBasis {
  const d = rigDirection(state, frame);
  const sp = Math.sin(state.pitch);
  const cp = Math.cos(state.pitch);
  const sy = Math.sin(state.yaw);
  const cy = Math.cos(state.yaw);
  return {
    forward: { x: -d.x, y: -d.y, z: -d.z },
    right: {
      x: sy * frame.east.x - cy * frame.north.x,
      y: sy * frame.east.y - cy * frame.north.y,
      z: sy * frame.east.z - cy * frame.north.z,
    },
    up: {
      x: cp * frame.up.x - sp * (cy * frame.east.x + sy * frame.north.x),
      y: cp * frame.up.y - sp * (cy * frame.east.y + sy * frame.north.y),
      z: cp * frame.up.z - sp * (cy * frame.east.z + sy * frame.north.z),
    },
  };
}

/** Pose angles with the free-look offsets folded in (position stays put). */
export function lookedState(state: RigState, look: LookState = ZERO_LOOK): RigState {
  return {
    ...state,
    yaw: wrapAngle(state.yaw + look.yaw),
    pitch: clamp(state.pitch + look.pitch, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT),
  };
}

/**
 * Orientation basis for the CURRENT camera position: `look` only rotates the
 * view about the camera, so it changes these vectors and never the position.
 */
export function viewBasis(state: RigState, frame: CameraFrame = SYSTEM_FRAME, look: LookState = ZERO_LOOK): RigBasis {
  return rigBasis(lookedState(state, look), frame);
}

/** Free-look: rotate the view about the camera position. Position is untouched. */
export function lookBy(look: LookState, dxPx: number, dyPx: number): LookState {
  return {
    yaw: wrapAngle(look.yaw - dxPx * ORBIT_SENSITIVITY),
    pitch: clamp(look.pitch + dyPx * ORBIT_SENSITIVITY, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT),
  };
}

/**
 * Left-drag / middle-drag orbit: yaw and pitch only, stops instantly. Yaw turns
 * about the frame's `up`, so a ship on the planet's flank orbits level to its
 * own horizon.
 */
export function orbitBy(state: RigState, dxPx: number, dyPx: number): RigState {
  return {
    ...state,
    yaw: wrapAngle(state.yaw - dxPx * ORBIT_SENSITIVITY),
    pitch: clamp(state.pitch + dyPx * ORBIT_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

/**
 * Right-drag pan: translate the target in the camera's screen plane, scaled by
 * distance so panning feels the same at every zoom level. Yaw/pitch/distance
 * are untouched.
 */
export function panBy(
  state: RigState,
  dxPx: number,
  dyPx: number,
  viewHeightPx: number,
  fovDeg = PAN_FOV_DEG,
  frame: CameraFrame = SYSTEM_FRAME,
  look: LookState = ZERO_LOOK,
): RigState {
  const height = Math.max(1, viewHeightPx);
  const scale = (2 * state.distance * Math.tan((fovDeg * Math.PI) / 360)) / height;
  const { right, up } = viewBasis(state, frame, look);
  return {
    ...state,
    target: {
      x: state.target.x - right.x * dxPx * scale + up.x * dyPx * scale,
      y: state.target.y - right.y * dxPx * scale + up.y * dyPx * scale,
      z: state.target.z - right.z * dxPx * scale + up.z * dyPx * scale,
    },
  };
}

/**
 * Wheel zoom. Distance is clamped into [MIN, MAX]; when the cursor hit a world
 * point, the target moves toward it by exactly the fraction the distance
 * shrank. That keeps `hit` on the same camera ray (so it stays under the
 * cursor) and shrinks the camera→hit distance by the same factor.
 */
export function zoomBy(state: RigState, notches: number, hit: Vec3Like | null = null): RigState {
  const before = state.distance;
  const after = clamp(before * Math.pow(ZOOM_PER_NOTCH, notches), MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
  const factor = before > 0 ? after / before : 1;
  if (!hit || factor >= 1 - 1e-9) return { ...state, distance: after };
  const k = 1 - factor;
  return {
    ...state,
    target: {
      x: state.target.x + (hit.x - state.target.x) * k,
      y: state.target.y + (hit.y - state.target.y) * k,
      z: state.target.z + (hit.z - state.target.z) * k,
    },
    distance: after,
  };
}

/** WASD/QE in the camera basis, km/s scaled by distance, Shift ×4. */
export function flyBy(
  state: RigState,
  keys: FlyKeys,
  dtSeconds: number,
  shift = false,
  moving = true,
  frame: CameraFrame = SYSTEM_FRAME,
  look: LookState = ZERO_LOOK,
): RigState {
  if (!moving) return state;
  const speed = logFlightSpeed(state.distance, shift) * Math.max(0, dtSeconds);
  const { forward, right, up } = viewBasis(state, frame, look);
  const velocity = flightVelocity(forward, right, up, keys, speed);
  return {
    ...state,
    target: {
      x: state.target.x + velocity.x,
      y: state.target.y + velocity.y,
      z: state.target.z + velocity.z,
    },
  };
}

/** Interpolate the one-shot focus tween (target linear, distance geometric). */
export function tweenRig(
  from: RigState,
  toTarget: Vec3Like,
  toDistance: number,
  t: number,
): RigState {
  const e = easeInOut(t);
  const ratio = toDistance > 0 && from.distance > 0 ? toDistance / from.distance : 1;
  return {
    ...from,
    target: {
      x: from.target.x + (toTarget.x - from.target.x) * e,
      y: from.target.y + (toTarget.y - from.target.y) * e,
      z: from.target.z + (toTarget.z - from.target.z) * e,
    },
    distance: t >= 1 ? toDistance : from.distance * Math.pow(ratio, e),
  };
}

interface Tween {
  from: RigState;
  toTarget: Vec3Like;
  toDistance: number;
  elapsedMs: number;
  durationMs: number;
}

/**
 * The rig. Input methods mutate state and cancel any tween; `update` is the
 * only method that advances a tween. There is no damping and no idle writer.
 *
 * `frame` is the active context frame (up + tangent basis). Orbit turns about
 * its `up`; `look` is a separate view offset that never moves the camera.
 */
export class CameraRig {
  state: RigState;
  tween: Tween | null = null;
  frame: CameraFrame;
  look: LookState = { ...ZERO_LOOK };

  constructor(initial: RigState, frame: CameraFrame = SYSTEM_FRAME) {
    this.state = {
      target: { ...initial.target },
      yaw: initial.yaw,
      pitch: clamp(initial.pitch, -PITCH_LIMIT, PITCH_LIMIT),
      distance: clamp(initial.distance, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE),
    };
    this.frame = frame;
  }

  get flying(): boolean {
    return this.tween !== null;
  }

  get position(): Vec3Like {
    return rigPosition(this.state, this.frame);
  }

  /** Camera orientation basis, including the free-look offset. */
  get basis(): RigBasis {
    return viewBasis(this.state, this.frame, this.look);
  }

  /** Swap the local frame (context change). Pose angles are kept as-is. */
  setFrame(frame: CameraFrame): void {
    this.frame = frame;
  }

  /**
   * Context switch that does not teleport: keep the camera where it is and
   * re-derive yaw/pitch/distance around the NEW pivot in the NEW frame, then
   * tween to the framed distance.
   */
  retarget(pivot: Vec3Like, frame: CameraFrame, framedDistance: number): void {
    this.cancel();
    const pos = rigPosition(this.state, this.frame);
    this.frame = frame;
    const before = this.state.yaw;
    this.state = rigFromPosition(pos, pivot, frame);
    // Keep the previous bearing when it is degenerate (camera on the pivot).
    if (distanceBetween(pos, pivot) < 1e-6) this.state.yaw = before;
    this.look = { ...ZERO_LOOK };
    this.focusTo(pivot, framedDistance);
  }

  /** Restore a saved pose exactly (Esc / breadcrumb): no tween, no drift. */
  applyPose(
    pivot: Vec3Like,
    frame: CameraFrame,
    pose: { yaw: number; pitch: number; distance: number; target?: Vec3Like },
  ): void {
    this.cancel();
    this.frame = frame;
    this.look = { ...ZERO_LOOK };
    this.state = {
      // A pan/fly inside the level moved the target: restore where it was.
      target: { ...(pose.target ?? pivot) },
      yaw: wrapAngle(pose.yaw),
      pitch: clamp(pose.pitch, -PITCH_LIMIT, PITCH_LIMIT),
      distance: clamp(pose.distance, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE),
    };
  }

  /** Any user input cancels an in-flight focus tween. */
  cancel(): void {
    this.tween = null;
  }

  orbit(dxPx: number, dyPx: number): void {
    this.cancel();
    this.state = orbitBy(this.state, dxPx, dyPx);
  }

  /** Free-look: rotate the view about the camera. Never orbits the target. */
  lookBy(dxPx: number, dyPx: number): void {
    this.cancel();
    this.look = lookBy(this.look, dxPx, dyPx);
  }

  pan(dxPx: number, dyPx: number, viewHeightPx: number): void {
    this.cancel();
    this.state = panBy(this.state, dxPx, dyPx, viewHeightPx, PAN_FOV_DEG, this.frame, this.look);
  }

  wheel(notches: number, hit: Vec3Like | null): void {
    this.cancel();
    this.state = zoomBy(this.state, notches, hit);
  }

  fly(keys: FlyKeys, dtSeconds: number, shift: boolean): void {
    this.state = flyBy(this.state, keys, dtSeconds, shift, true, this.frame, this.look);
  }

  translate(dx: number, dy: number, dz: number): void {
    this.state = {
      ...this.state,
      target: { x: this.state.target.x + dx, y: this.state.target.y + dy, z: this.state.target.z + dz },
    };
  }

  /** A focus request: one tween, never re-run by polling. */
  focusTo(toTarget: Vec3Like, toDistance: number, durationMs = RIG_TWEEN_MS): void {
    this.tween = {
      from: { ...this.state, target: { ...this.state.target } },
      toTarget: { ...toTarget },
      toDistance: clamp(toDistance, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE),
      elapsedMs: 0,
      durationMs: Math.max(1, durationMs),
    };
  }

  /** Advance the tween. Returns true while it is still animating. */
  update(dtMs: number): boolean {
    const tween = this.tween;
    if (!tween) return false;
    tween.elapsedMs += Math.max(0, dtMs);
    const t = Math.min(1, tween.elapsedMs / tween.durationMs);
    this.state = tweenRig(tween.from, tween.toTarget, tween.toDistance, t);
    if (t >= 1) {
      this.tween = null;
      return false;
    }
    return true;
  }
}

/** Initial spherical pose from a camera position and a look-at target. */
export function rigFromPosition(pos: Vec3Like, target: Vec3Like, frame: CameraFrame = SYSTEM_FRAME): RigState {
  const off = { x: pos.x - target.x, y: pos.y - target.y, z: pos.z - target.z };
  const distance = clamp(Math.hypot(off.x, off.y, off.z), MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
  if (distance < 1e-6) return { target: { ...target }, yaw: 0, pitch: 0, distance: 1000 };
  return {
    target: { ...target },
    yaw: wrapAngle(Math.atan2(dotv(off, frame.north), dotv(off, frame.east))),
    pitch: clamp(Math.asin(clamp(dotv(off, frame.up) / distance, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT),
    distance,
  };
}

/** Convenience for callers that only have metres (API data). */
export function scenePoint(pos: Vec3): Vec3Like {
  return toScene(pos);
}
