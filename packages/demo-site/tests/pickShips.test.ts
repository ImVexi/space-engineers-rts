import { describe, expect, it } from 'vitest';
import {
  PICK_RADIUS_MAX_PX,
  PICK_RADIUS_MIN_PX,
  edgeDistancePx,
  needsDisambiguation,
  pickNodes,
  pickRadiusPx,
  type ScreenNode,
} from '../src/lib/pickShips';

const node = (id: string, x: number, y: number, over: Partial<ScreenNode> = {}): ScreenNode => ({
  id,
  x,
  y,
  depth: 0.1,
  sizePx: 8,
  ...over,
});

describe('zoom-scaled hit radius', () => {
  it('is 14 px close in and grows to 28 px when zoomed out', () => {
    expect(pickRadiusPx(0.1)).toBeCloseTo(PICK_RADIUS_MIN_PX, 9);
    // The zoom envelope tops out far beyond the rig clamp, so the far end is
    // exercised through the max, not by a special case.
    expect(pickRadiusPx(5_000)).toBeCloseTo(PICK_RADIUS_MAX_PX, 9);
    expect(pickRadiusPx(1e9)).toBeCloseTo(PICK_RADIUS_MAX_PX, 9);
  });

  it('grows monotonically with distance', () => {
    let prev = 0;
    for (const d of [0.1, 1, 10, 50, 200, 1000, 4000]) {
      const r = pickRadiusPx(d);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeGreaterThanOrEqual(PICK_RADIUS_MIN_PX);
      expect(r).toBeLessThanOrEqual(PICK_RADIUS_MAX_PX);
      prev = r;
    }
  });

  it('makes a small ship reachable when zoomed out (the reported symptom)', () => {
    // A 3 px drone 20 px away is a miss at 14 px and a hit at 28 px.
    const drone = node('grid:tiny', 100, 100, { sizePx: 3 });
    expect(pickNodes([drone], 120, 100, pickRadiusPx(0.5)).best).toBeNull();
    expect(pickNodes([drone], 120, 100, pickRadiusPx(3_000)).best?.id).toBe('grid:tiny');
  });
});

describe('multi-node disambiguation', () => {
  it('returns every candidate inside the radius, nearest first', () => {
    const near = node('grid:near', 100, 100);
    const mid = node('grid:mid', 108, 100);
    const far = node('grid:far', 140, 100);
    const result = pickNodes([far, mid, near], 100, 100, 16);
    expect(result.candidates.map((n) => n.id)).toEqual(['grid:near', 'grid:mid']);
    expect(result.best?.id).toBe('grid:near');
    expect(needsDisambiguation(result)).toBe(true);
  });

  it('reports a single hit without a list', () => {
    const result = pickNodes([node('grid:a', 100, 100)], 103, 104, 16);
    expect(result.candidates).toHaveLength(1);
    expect(needsDisambiguation(result)).toBe(false);
  });

  it('measures from the marker EDGE so big markers are grabbable', () => {
    const big = node('grid:big', 100, 100, { sizePx: 40 });
    expect(edgeDistancePx(big, 120, 100)).toBeCloseTo(0, 9);
    expect(pickNodes([big], 120, 100, 14).best?.id).toBe('grid:big');
    // ...but a small marker at the same offset is still a miss.
    expect(pickNodes([node('grid:small', 100, 100)], 120, 100, 14).best).toBeNull();
  });

  it('ignores off-screen (projected garbage) nodes and ranks by depth on ties', () => {
    const a = node('grid:a', 100, 100, { depth: 0.4 });
    const b = node('grid:b', 100, 100, { depth: 0.05 });
    const junk = node('grid:junk', Number.NaN, 0);
    const result = pickNodes([a, b, junk], 100, 100, 14);
    expect(result.candidates.map((n) => n.id)).toEqual(['grid:b', 'grid:a']);
  });
});
