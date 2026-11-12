import { describe, expect, it } from 'vitest';
import {
  CameraRig,
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  PITCH_LIMIT,
  RIG_TWEEN_MS,
  distanceBetween,
  easeInOut,
  flightVelocity,
  logFlightSpeed,
  panBy,
  planFocusPose,
  rigBasis,
  rigFromPosition,
  rigPosition,
  wheelNotches,
  zoomBy,
  zoomFactorForWheel,
  type RigState,
} from '../src/lib/camera';

const KM = 1000;
const state = (over: Partial<RigState> = {}): RigState => ({
  target: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  distance: 100,
  ...over,
});

/** Pinhole projection used only to check "stays under the cursor". */
function project(rig: RigState, point: { x: number; y: number; z: number }, heightPx = 900): { x: number; y: number } {
  const { forward, right, up } = rigBasis(rig);
  const pos = rigPosition(rig);
  const v = { x: point.x - pos.x, y: point.y - pos.y, z: point.z - pos.z };
  const depth = v.x * forward.x + v.y * forward.y + v.z * forward.z;
  const tanHalf = Math.tan((50 * Math.PI) / 360);
  const nx = (v.x * right.x + v.y * right.y + v.z * right.z) / (depth * tanHalf);
  const ny = (v.x * up.x + v.y * up.y + v.z * up.z) / (depth * tanHalf);
  return { x: (nx * 0.5 + 0.5) * heightPx, y: (0.5 - ny * 0.5) * heightPx };
}

describe('rig pose', () => {
  it('derives the camera exactly from target/yaw/pitch/distance', () => {
    const s = state({ target: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, distance: 10 });
    expect(rigPosition(s)).toEqual({ x: 11, y: 2, z: 3 });
    const p = rigPosition(state({ yaw: Math.PI / 2, pitch: 0, distance: 10 }));
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(10, 9);
    const up = rigPosition(state({ pitch: Math.PI / 4, distance: Math.SQRT2 }));
    expect(up.y).toBeCloseTo(1, 9);
  });

  it('seeds a spherical pose from a camera position without changing it', () => {
    const pos = { x: 3, y: 4, z: 12 };
    const target = { x: 0, y: 0, z: 0 };
    const s = rigFromPosition(pos, target);
    const back = rigPosition(s);
    expect(back.x).toBeCloseTo(pos.x, 9);
    expect(back.y).toBeCloseTo(pos.y, 9);
    expect(back.z).toBeCloseTo(pos.z, 9);
  });
});

describe('orbit input', () => {
  it('changes yaw and pitch only and stops instantly', () => {
    const rig = new CameraRig(state());
    rig.orbit(40, 20);
    expect(rig.state.yaw).toBeCloseTo(-0.2, 9);
    expect(rig.state.pitch).toBeCloseTo(0.1, 9);
    expect(rig.state.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(rig.state.distance).toBe(100);
    // No damping: an extra frame with no input changes nothing.
    const before = { ...rig.state, target: { ...rig.state.target } };
    rig.update(16);
    expect(rig.state).toEqual(before);
  });

  it('clamps pitch just short of the poles', () => {
    const rig = new CameraRig(state());
    rig.orbit(0, 10_000);
    expect(rig.state.pitch).toBe(PITCH_LIMIT);
    rig.orbit(0, -20_000);
    expect(rig.state.pitch).toBe(-PITCH_LIMIT);
  });
});

describe('pan input', () => {
  it('changes the target only, scaled by distance', () => {
    const s = state({ yaw: 0, pitch: 0, distance: 100 });
    const near = panBy(s, 100, 0, 900);
    const far = panBy({ ...s, distance: 200 }, 100, 0, 900);
    expect(near.yaw).toBe(s.yaw);
    expect(near.pitch).toBe(s.pitch);
    expect(near.distance).toBe(s.distance);
    expect(far.distance).toBe(200);
    // yaw=0: screen right is -Z, so dragging right moves the target toward +Z.
    expect(near.target.z).toBeGreaterThan(0);
    expect(near.target.x).toBeCloseTo(0, 9);
    // Twice the distance pans twice as far in world units.
    expect(far.target.z).toBeCloseTo(near.target.z * 2, 9);
    // Vertical drag moves along the camera up axis (drag down = camera up).
    const down = panBy(s, 0, 100, 900);
    expect(down.target.y).toBeGreaterThan(0);
  });
});

describe('wheel zoom', () => {
  it('normalises deltaMode and caps one event at 1.2 notches', () => {
    expect(wheelNotches(-100, 0)).toBeCloseTo(1, 9);
    expect(wheelNotches(-100, 1)).toBeCloseTo(1.2, 9);
    expect(wheelNotches(-100, 2)).toBeCloseTo(1.2, 9);
    expect(wheelNotches(10_000, 0)).toBe(-1.2);
    expect(zoomFactorForWheel(-100)).toBeCloseTo(0.87, 9);
    expect(zoomFactorForWheel(100)).toBeCloseTo(1 / 0.87, 9);
  });

  it('keeps a fixed world point under the cursor within 30 px over 5 notches', () => {
    const hit = { x: 4, y: 3, z: -2 };
    let s = state({ yaw: 0.4, pitch: 0.25, distance: 120 });
    const before = project(s, hit);
    for (let i = 0; i < 5; i += 1) s = zoomBy(s, 1, hit);
    const after = project(s, hit);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(30);
    // The camera→hit distance shrank by exactly the distance factor per event.
    expect(distanceBetween(rigPosition(s), hit)).toBeCloseTo(
      distanceBetween(rigPosition(state({ yaw: 0.4, pitch: 0.25, distance: 120 })), hit) * Math.pow(0.87, 5),
      6,
    );
  });

  it('clamps distance into [MIN, MAX] km', () => {
    let s = state({ distance: 1 });
    for (let i = 0; i < 100; i += 1) s = zoomBy(s, 1, null);
    expect(s.distance).toBeGreaterThanOrEqual(MIN_CAMERA_DISTANCE);
    expect(s.distance).toBeCloseTo(MIN_CAMERA_DISTANCE, 12);

    s = state({ distance: 1000 });
    for (let i = 0; i < 200; i += 1) s = zoomBy(s, -1, null);
    expect(s.distance).toBeLessThanOrEqual(MAX_CAMERA_DISTANCE);
    expect(s.distance).toBeCloseTo(MAX_CAMERA_DISTANCE, 9);
  });
});

describe('fly input', () => {
  it('moves along the view basis (W forward, D right, E up)', () => {
    const rig = new CameraRig(state({ yaw: 0, pitch: 0, distance: 100 }));
    rig.fly({ w: true }, 1, false);
    // yaw=0 puts the camera at +X looking toward -X.
    expect(rig.state.target.x).toBeCloseTo(-35, 9);
    expect(rig.state.target.y).toBeCloseTo(0, 9);
    expect(rig.state.target.z).toBeCloseTo(0, 9);

    rig.state = state({ yaw: 0, pitch: 0, distance: 100 });
    rig.fly({ d: true }, 1, false);
    expect(rig.state.target.z).toBeCloseTo(-35, 9);

    rig.state = state({ yaw: 0, pitch: 0, distance: 100 });
    rig.fly({ e: true }, 1, false);
    expect(rig.state.target.y).toBeCloseTo(35, 9);
  });

  it('boosts with Shift and clamps speed to 4000 km/s', () => {
    expect(logFlightSpeed(1)).toBe(0.35);
    expect(logFlightSpeed(1, true)).toBe(1.4);
    expect(logFlightSpeed(40_000)).toBe(4000);
    expect(logFlightSpeed(40_000, true)).toBe(16_000);
    const base = flightVelocity({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, { w: true, d: true }, 2);
    expect(base).toEqual({ x: 2, y: 0, z: -2 });
  });
});

describe('focus tween', () => {
  it('lands exactly on the goal and then stops writing', () => {
    const rig = new CameraRig(state({ distance: 300 }));
    rig.focusTo({ x: 10, y: 5, z: -2 }, 1.2);
    expect(rig.flying).toBe(true);
    for (let i = 0; i < 4; i += 1) rig.update(100);
    expect(rig.flying).toBe(false);
    expect(rig.state.target).toEqual({ x: 10, y: 5, z: -2 });
    expect(rig.state.distance).toBe(1.2);
    expect(rig.state.yaw).toBe(0);
    const settled = { ...rig.state, target: { ...rig.state.target } };
    for (let i = 0; i < 120; i += 1) rig.update(16);
    expect(rig.state).toEqual(settled);
  });

  it('is cancelled by any input and never resumes', () => {
    const rig = new CameraRig(state({ distance: 300 }));
    rig.focusTo({ x: 200, y: 0, z: 0 }, 2);
    rig.update(RIG_TWEEN_MS / 2);
    const midway = distanceBetween(rig.state.target, { x: 200, y: 0, z: 0 });
    expect(midway).toBeGreaterThan(0);
    rig.orbit(10, 0);
    expect(rig.flying).toBe(false);
    const afterCancel = { ...rig.state, target: { ...rig.state.target } };
    expect(rig.update(500)).toBe(false);
    expect(rig.state).toEqual(afterCancel);
  });

  it('eases monotonically from 0 to 1', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(easeInOut(t)).toBeGreaterThanOrEqual(prev);
      prev = easeInOut(t);
    }
  });
});

describe('planFocusPose', () => {
  it('clamps the pull-back distance into the zoom envelope', () => {
    const huge = planFocusPose({ id: 'p', label: 'P', pos: { x: 0, y: 0, z: 0 }, radiusKm: 1e6 });
    expect(distanceBetween(huge.pos, huge.target)).toBeLessThanOrEqual(MAX_CAMERA_DISTANCE + 1e-6);

    const tiny = planFocusPose({ id: 'p', label: 'P', pos: { x: 0, y: 0, z: 0 }, radiusKm: 0 });
    expect(distanceBetween(tiny.pos, tiny.target)).toBeGreaterThanOrEqual(MIN_CAMERA_DISTANCE - 1e-6);
  });

  it('frames a grid sitting on a planet from just above the ground', () => {
    const planet = { center: { x: 0, y: 0, z: 0 }, surfaceRadiusM: 59_400, maxHillRadiusM: 67_200 };
    const pos = { x: 55_875, y: 24_853, z: 1_724 };
    const p = planFocusPose({ id: 'b', label: 'BASE-01', pos, radiusKm: 1.2 }, [planet]);
    expect(distanceBetween(p.pos, p.target)).toBeCloseTo(4.8, 6);
    expect(Math.hypot(p.pos.x, p.pos.y, p.pos.z)).toBeGreaterThan(Math.hypot(pos.x, pos.y, pos.z) / KM);
  });

  it('lifts a target buried under the surface to just outside it', () => {
    const planet = { center: { x: 0, y: 0, z: 0 }, surfaceRadiusM: 60_000, maxHillRadiusM: 67_200 };
    const p = planFocusPose({ id: 'g', label: 'g', pos: { x: 59_000, y: 0, z: 0 }, radiusKm: 0.4 }, [planet]);
    expect(Math.hypot(p.pos.x, p.pos.y, p.pos.z)).toBeGreaterThan(60);
  });

  it('targets the requested point exactly', () => {
    const p = planFocusPose({ id: 'g', label: 'g', pos: { x: 3000, y: 4000, z: 0 }, radiusKm: 1 });
    expect(p.target).toEqual({ x: 3, y: 4, z: 0 });
  });
});
