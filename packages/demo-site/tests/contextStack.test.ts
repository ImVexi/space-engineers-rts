import { describe, expect, it } from 'vitest';
import {
  breadcrumb,
  enterContext,
  exitContext,
  initialStack,
  jumpToLevel,
  poseFor,
  savePose,
  sessionAfterClick,
  stackDepth,
  topTarget,
} from '../src/lib/contextStack';
import type { ContextWorld } from '../src/lib/cameraContext';
import { CameraRig, type RigState } from '../src/lib/camera';

const poseA = { yaw: 0.4, pitch: 0.2, distance: 30 };
const poseB = { yaw: -1.1, pitch: -0.35, distance: 0.7 };
const poseC = { yaw: 2.2, pitch: 0.05, distance: 0.12 };

const world: ContextWorld = {
  planets: [
    {
      id: 'p1',
      name: 'EarthLike',
      center: { x: 0, y: 0, z: 0 },
      surfaceRadiusM: 59_400,
      maxHillRadiusM: 67_200,
      hasAtmosphere: true,
    },
  ],
  nodes: [
    { id: 'grid:1', name: 'SAT-L-0003', position: { x: 60_400, y: 0, z: 0 }, planet: 'EarthLike' },
    { id: 'grid:2', name: 'SAT-L-0004', position: { x: 0, y: 0, z: 60_400 }, planet: 'EarthLike' },
  ],
  groups: [{ id: 'g1', name: 'Group 1', members: ['grid:1', 'grid:2'] }],
  names: { 'grid:1': 'SAT-L-0003' },
};

describe('a single click only selects', () => {
  it('returns the same stack and no context entry', () => {
    const start = enterContext(initialStack(), { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    const before = JSON.parse(JSON.stringify(start)) as typeof start;
    const outcome = sessionAfterClick(start, { id: 'grid:1', kind: 'ship', double: false });
    expect(outcome.entered).toBeNull();
    expect(outcome.stack).toBe(start); // identity: not even a copy
    expect(outcome.stack).toEqual(before);
  });

  it('leaves the camera rig byte-identical, mirroring the app guard', () => {
    const start = enterContext(initialStack(), { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    const rig = new CameraRig({ target: { x: 1, y: 2, z: 3 }, ...poseA } satisfies RigState);
    const before = JSON.parse(JSON.stringify(rig.state)) as RigState;
    const outcome = sessionAfterClick(start, { id: 'grid:1', kind: 'ship', double: false });
    // The app only calls rig.retarget/restore when `entered` is non-null.
    if (outcome.entered) rig.retarget({ x: 9, y: 9, z: 9 }, rig.frame, 1);
    expect(rig.state).toEqual(before);
  });

  it('a double click is an explicit entry for the clicked level', () => {
    const start = initialStack();
    const outcome = sessionAfterClick(start, { id: 'grid:1', kind: 'ship', double: true });
    expect(outcome.entered).toEqual({ kind: 'ship', id: 'grid:1', upMode: 'gravity' });
    // Still no camera work until the app resolves the context.
    expect(outcome.stack).toBe(start);
  });
});

describe('context stack: enter, exit, restore', () => {
  it('saves the pose of the level you leave and restores it on Esc', () => {
    let stack = initialStack();
    expect(stackDepth(stack)).toBe(1);

    // system (pose A) -> planet
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    expect(stackDepth(stack)).toBe(2);
    expect(poseFor(stack, topTarget(stack))).toBeNull(); // planet not visited yet

    // planet (pose B) -> ship
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseB);
    expect(stackDepth(stack)).toBe(3);
    expect(stack.stack.map((t) => t.kind)).toEqual(['system', 'planet', 'ship']);

    // Esc #1: back to the planet with pose B
    const first = exitContext(stack, poseC);
    expect(first.parent?.kind).toBe('planet');
    expect(first.restored).toEqual(poseB);
    expect(stackDepth(first.state)).toBe(2);

    // Esc #2: back to the system with pose A (the pose saved before entering)
    const second = exitContext(first.state, poseB);
    expect(second.parent?.kind).toBe('system');
    expect(second.restored).toEqual(poseA);
    expect(stackDepth(second.state)).toBe(1);

    // Esc #3 at the top level is a no-op that still records the pose.
    const third = exitContext(second.state, poseA);
    expect(third.parent).toBeNull();
    expect(third.state.stack).toBe(second.state.stack);
  });

  it('saves the pose of the level you are on when it is first revisited', () => {
    let stack = initialStack();
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    // The pose argument is the pose of the level being LEFT, so entering the
    // group records where the planet view was at that moment.
    stack = savePose(stack, poseB); // move around the planet level
    stack = enterContext(stack, { kind: 'group', id: 'g1', upMode: 'gravity' }, poseB);
    expect(poseFor(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' })).toEqual(poseB);
  });

  it('a breadcrumb jump goes straight to an ancestor with its saved pose', () => {
    let stack = initialStack();
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    stack = enterContext(stack, { kind: 'group', id: 'g1', upMode: 'gravity' }, poseB);
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseC);

    const jump = jumpToLevel(stack, 0, poseC);
    expect(jump.target?.kind).toBe('system');
    expect(jump.restored).toEqual(poseA);
    expect(jump.state.stack.map((t) => t.kind)).toEqual(['system']);

    // Jumping to the level you are already on does nothing.
    const again = jumpToLevel(jump.state, 0, poseA);
    expect(again.target).toBeNull();
    expect(again.state).toBe(jump.state);
  });

  it('re-entering a level already in the stack truncates instead of duplicating', () => {
    let stack = initialStack();
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseB);
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseC);
    expect(stack.stack.map((t) => t.kind)).toEqual(['system', 'planet']);
  });

  it('drops levels that cannot be ancestors (planet picked while inside a ship)', () => {
    let stack = initialStack();
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseA);
    expect(stack.stack.map((t) => t.kind)).toEqual(['system', 'ship']);
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseB);
    // A planet never nests under a ship: the ship level is replaced.
    expect(stack.stack.map((t) => t.kind)).toEqual(['system', 'planet']);
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseC);
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseB);
    expect(stack.stack.map((t) => t.kind)).toEqual(['system', 'planet']);
  });

  it('labels the breadcrumb with live names, never stale ids', () => {
    let stack = initialStack();
    stack = enterContext(stack, { kind: 'planet', id: 'EarthLike', upMode: 'gravity' }, poseA);
    stack = enterContext(stack, { kind: 'group', id: 'g1', upMode: 'gravity' }, poseB);
    stack = enterContext(stack, { kind: 'ship', id: 'grid:1', upMode: 'gravity' }, poseC);
    const items = breadcrumb(stack, world);
    expect(items.map((i) => i.label)).toEqual(['System', 'EarthLike', 'Group 1', 'SAT-L-0003']);
    expect(items.map((i) => i.current)).toEqual([false, false, false, true]);
    expect(items[3]!.kind).toBe('ship');
  });
});
