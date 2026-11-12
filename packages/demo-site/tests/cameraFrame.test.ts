import { describe, expect, it } from 'vitest';
import type { Planet } from '../src/types';
import {
  CameraRig,
  SYSTEM_FRAME,
  directionIn,
  frameFromUp,
  lookBy,
  orbitBy,
  rigBasis,
  rigFromPosition,
  rigPosition,
  type RigState,
} from '../src/lib/camera';
import {
  contextKey,
  gravityUp,
  gridUp,
  planetAtPoint,
  planetOwning,
  resolveContext,
  systemTarget,
  type ContextWorld,
} from '../src/lib/cameraContext';

const KM = 1000;

const planet: Planet = {
  id: 'p1',
  name: 'EarthLike',
  center: { x: 0, y: 0, z: 0 },
  surfaceRadiusM: 59_400,
  maxHillRadiusM: 67_200,
  hasAtmosphere: true,
};

/** A ship on the planet's flank (equator, +X side), 1 km above the surface. */
const sideShip = {
  id: 'grid:side',
  name: 'SAT-L-0003',
  position: { x: 60_400, y: 0, z: 0 },   // metres: 60.4 km
  planet: 'EarthLike',
};
/** A second ship 45 deg along the equator, for the group centroid. */
const sideShip2 = {
  id: 'grid:side2',
  name: 'SAT-L-0004',
  position: { x: 0, y: 0, z: 60_400 },
  planet: 'EarthLike',
};
/** A deep-space ship, outside the planet's hill sphere, with a tilted grid. */
const spaceShip = {
  id: 'grid:space',
  name: 'SAT-R-0009',
  position: { x: 200_000, y: 20_000, z: 0 },   // 200 km: outside the hill sphere
  planet: null,
  // 90 deg about +Z: the grid's local +Y becomes world +X.
  telemetry: { quat: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } },
};

const world: ContextWorld = {
  planets: [planet],
  nodes: [sideShip, sideShip2, spaceShip],
  groups: [{ id: 'g1', name: 'Group 1', members: ['grid:side', 'grid:side2'] }],
  names: { 'grid:side': 'SAT-L-0003' },
};

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

const state = (over: Partial<RigState> = {}): RigState => ({
  target: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  distance: 100,
  ...over,
});

describe('local up per camera context', () => {
  it('system level orbits the planets centroid with world up', () => {
    const ctx = resolveContext(systemTarget(), world)!;
    expect(ctx.key).toBe('system');
    expect(ctx.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(ctx.pivot).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('planet level orbits the planet centre with its polar axis as up', () => {
    const ctx = resolveContext({ kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, world)!;
    expect(contextKey(ctx)).toBe('planet:EarthLike');
    expect(ctx.pivot).toEqual({ x: 0, y: 0, z: 0 });
    expect(ctx.up).toEqual({ x: 0, y: 1, z: 0 });
    expect(ctx.label).toBe('EarthLike');
  });

  it('ship level on the planet SIDE uses radial gravity up, not world Y', () => {
    const ctx = resolveContext({ kind: 'ship', id: 'grid:side', upMode: 'gravity' }, world)!;
    expect(ctx.label).toBe('SAT-L-0003');
    expect(ctx.up.x).toBeCloseTo(1, 9);
    expect(ctx.up.y).toBeCloseTo(0, 9);
    expect(ctx.up.z).toBeCloseTo(0, 9);
    expect(ctx.pivot.x).toBeCloseTo(60.4, 9);
  });

  it('group level pivots on the member centroid with planet-radial up there', () => {
    const ctx = resolveContext({ kind: 'group', id: 'g1', upMode: 'gravity' }, world)!;
    expect(ctx.members).toEqual(['grid:side', 'grid:side2']);
    expect(ctx.pivot.x).toBeCloseTo(30.2, 6);
    expect(ctx.pivot.z).toBeCloseTo(30.2, 6);
    // radial at 45 deg along the equator: (1, 0, 1)/sqrt2
    expect(ctx.up.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(ctx.up.z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(ctx.up.y).toBeCloseTo(0, 9);
  });

  it('ship in deep space falls back to the grid up ("ship" mode) or world up', () => {
    const gravity = resolveContext({ kind: 'ship', id: 'grid:space', upMode: 'gravity' }, world)!;
    const ship = resolveContext({ kind: 'ship', id: 'grid:space', upMode: 'ship' }, world)!;
    // No planet defines a horizon; the grid's own up (rotated +Y) does.
    // +90 deg about +Z takes grid +Y to world -X, so a right-handed rotation
    // must land exactly there (a flipped sign would land on +X).
    expect(gravity.up.x).toBeCloseTo(-1, 9);
    expect(ship.up.x).toBeCloseTo(-1, 9);
    expect(gridUp({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 }).x).toBeCloseTo(1, 9);
    // Identity quaternion means the grid up IS world up.
    expect(gridUp(null)).toEqual({ x: 0, y: 1, z: 0 });
    expect(gridUp({ x: 0, y: 0, z: 0, w: 1 })).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('knows which planet owns a point and which one a surface click hit', () => {
    expect(planetOwning({ x: 0, y: 60, z: 0 }, [planet])?.name).toBe('EarthLike');
    expect(planetOwning({ x: 0, y: 500, z: 0 }, [planet])).toBeNull();
    expect(planetAtPoint({ x: 0, y: 59.5, z: 0 }, [planet])?.name).toBe('EarthLike');
    expect(planetAtPoint({ x: 0, y: 400, z: 0 }, [planet])).toBeNull();
    const { up } = gravityUp({ x: 0, y: 0, z: 70 }, [planet]);
    expect(up).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('keeps the legacy frame identical for up = +Y', () => {
    const s = state({ yaw: Math.PI / 2, pitch: 0, distance: 10 });
    const p = rigPosition(s, SYSTEM_FRAME);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(10, 12);
    const basis = rigBasis(s, SYSTEM_FRAME);
    expect(basis.right.x).toBeCloseTo(1, 9);
    expect(basis.up.y).toBeCloseTo(1, 9);
  });
});

describe('orbit turns about the local up (ship on the planet side)', () => {
  const shipCtx = resolveContext({ kind: 'ship', id: 'grid:side', upMode: 'gravity' }, world)!;
  const frame = frameFromUp(shipCtx.up);

  it('holds a constant elevation above the local horizon, unlike a world-Y orbit', () => {
    const s = state({ target: shipCtx.pivot, yaw: 0, pitch: 0.3, distance: 0.4 });
    const before = directionIn(frame, s.yaw, s.pitch);
    const after = orbitBy(s, 600, 0); // ~3 rad of yaw
    const afterDir = directionIn(frame, after.yaw, after.pitch);
    // Elevation relative to LOCAL up is unchanged: the camera stays level to
    // the planet's horizon at this spot.
    expect(dot(afterDir, frame.up)).toBeCloseTo(dot(before, frame.up), 9);
    expect(dot(afterDir, frame.up)).toBeCloseTo(Math.sin(0.3), 9);
    // The old world-Y frame would have swung it down toward the planet.
    const worldBefore = directionIn(SYSTEM_FRAME, s.yaw, s.pitch);
    const worldAfter = directionIn(SYSTEM_FRAME, after.yaw, after.pitch);
    expect(Math.abs(dot(worldAfter, frame.up) - dot(worldBefore, frame.up))).toBeGreaterThan(0.3);
  });

  it('keeps camera roll at zero relative to the local up', () => {
    for (const yaw of [0, 0.7, 2.1, -1.9]) {
      const s = state({ yaw, pitch: 0.4, distance: 0.5 });
      const basis = rigBasis(s, frame);
      // A roll-free camera has its own up in the plane of (local up, view dir)
      // and its right vector perpendicular to the local up.
      expect(dot(basis.right, frame.up)).toBeCloseTo(0, 9);
      expect(dot(basis.up, frame.up)).toBeCloseTo(Math.cos(0.4), 9);
    }
  });

  it('keeps the camera at the same altitude above the planet while orbiting', () => {
    const s = state({ target: shipCtx.pivot, yaw: 0.2, pitch: 0.25, distance: 0.5 });
    const r1 = Math.hypot(rigPosition(s, frame).x, rigPosition(s, frame).y, rigPosition(s, frame).z);
    const turned = orbitBy(s, -420, 0);
    const p2 = rigPosition(turned, frame);
    const r2 = Math.hypot(p2.x, p2.y, p2.z);
    expect(r2).toBeCloseTo(r1, 9);
  });
});

describe('free-look rotates in place', () => {
  const frame = frameFromUp({ x: 0.6, y: 0.8, z: 0 });

  it('changes the view direction but not the camera position or the target', () => {
    const rig = new CameraRig(state({ target: { x: 5, y: 1, z: -2 }, yaw: 0.4, pitch: 0.1, distance: 3 }), frame);
    const posBefore = rig.position;
    const targetBefore = { ...rig.state.target };
    const forwardBefore = rig.basis.forward;
    rig.lookBy(-180, 40); // drag left and down
    expect(rig.position).toEqual(posBefore);
    expect(rig.state.target).toEqual(targetBefore);
    expect(rig.look.yaw).toBeCloseTo(0.9, 9);
    expect(rig.look.pitch).toBeCloseTo(0.2, 9); // 40 px * 0.005 rad
    const forwardAfter = rig.basis.forward;
    expect(dot(forwardAfter, forwardBefore)).toBeLessThan(1);
  });

  it('never orbits: yaw/pitch/distance and the placed position are untouched', () => {
    const s = state({ yaw: 0.4, pitch: -0.2, distance: 12 });
    const rig = new CameraRig(s, SYSTEM_FRAME);
    const posBefore = rig.position;
    const dirBefore = directionIn(SYSTEM_FRAME, s.yaw, s.pitch);
    rig.lookBy(500, -300);
    expect(rig.state.yaw).toBe(0.4);
    expect(rig.state.pitch).toBe(-0.2);
    expect(rig.state.distance).toBe(12);
    expect(rig.position).toEqual(posBefore);
    // The VIEW turned, the pose did not (this is the assertion that a look
    // drag cannot be silently applied as an orbit).
    expect(dot(rig.basis.forward, { x: -dirBefore.x, y: -dirBefore.y, z: -dirBefore.z })).toBeLessThan(0.99);
  });

  it('clamps look pitch just short of the poles', () => {
    const look = lookBy({ yaw: 0, pitch: 0 }, 0, 10_000);
    expect(look.pitch).toBeCloseTo(1.45, 9);
  });
});

describe('pose seeding in a local frame', () => {
  it('round-trips a camera position through rigFromPosition', () => {
    const frame = frameFromUp({ x: 1, y: 0, z: 0 });
    const target = { x: 10, y: 0, z: 0 };
    const pos = { x: 10.2, y: -0.1, z: 0.3 };
    const s = rigFromPosition(pos, target, frame);
    const back = rigPosition(s, frame);
    expect(back.x).toBeCloseTo(pos.x, 9);
    expect(back.y).toBeCloseTo(pos.y, 9);
    expect(back.z).toBeCloseTo(pos.z, 9);
  });
});
