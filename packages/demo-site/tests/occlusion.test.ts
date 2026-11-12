import { describe, expect, it } from 'vitest';
import { segmentBlockedBySphere } from '../src/lib/sceneMath';

const earth = { x: 0, y: 0, z: 0 };
const R = 59_400;

describe('marker occlusion by a planet', () => {
  it('hides a grid on the far side of the planet', () => {
    // Camera above the north pole; grid on the far south side.
    const blocked = segmentBlockedBySphere({ x: 0, y: 80_000, z: 0 }, { x: 0, y: -80_000, z: 0 }, earth, R);
    expect(blocked).toBe(true);
  });

  it('keeps a grid above the visible limb', () => {
    const visible = segmentBlockedBySphere({ x: 0, y: 80_000, z: 0 }, { x: 60_000, y: 60_000, z: 0 }, earth, R);
    expect(visible).toBe(false);
  });

  it('never hides a grid the camera is standing on', () => {
    expect(segmentBlockedBySphere({ x: 0, y: R + 10, z: 0 }, { x: 0, y: R + 20, z: 0 }, earth, R)).toBe(false);
  });
});
