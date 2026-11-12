import { describe, expect, it } from 'vitest';
import {
  DOT_MAX_PX,
  DOT_MIN_PX,
  clusterPxFor,
  layoutOverlay,
  markerPxFor,
  type ScreenNode,
} from '../src/lib/markers';

function node(over: Partial<ScreenNode> & { id: string }): ScreenNode {
  return {
    name: over.id,
    visible: true,
    x: 400,
    y: 300,
    world: { x: 0, y: 0, z: 0 },
    live: true,
    moving: false,
    speedMps: 0,
    ageSec: 1,
    owner: null,
    isGame: true,
    spof: false,
    isolated: false,
    distance: 1,
    ...over,
  };
}

const opts = { width: 1200, height: 900, selectedId: null, hoveredId: null, showStale: false };

describe('distance-aware marker size', () => {
  it('follows the projection and is clamped to 4–14 px', () => {
    expect(markerPxFor(200_000)).toBe(DOT_MIN_PX); // 200 km: a far speck
    expect(markerPxFor(50_000)).toBe(DOT_MIN_PX);
    expect(markerPxFor(2_000)).toBeCloseTo(12.5, 1); // close: readable, not a blob
    expect(markerPxFor(300)).toBe(DOT_MAX_PX);
    expect(markerPxFor(10)).toBe(DOT_MAX_PX);
    for (const d of [1, 10, 300, 2_000, 20_000, 200_000, 5_000_000]) {
      const px = markerPxFor(d);
      expect(px).toBeGreaterThanOrEqual(DOT_MIN_PX);
      expect(px).toBeLessThanOrEqual(16);
    }
  });

  it('shrinks monotonically as the camera pulls away', () => {
    const near = markerPxFor(1_000);
    const mid = markerPxFor(5_000);
    const far = markerPxFor(150_000);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });

  it('grows the merge radius with marker size, so big dots never overlap', () => {
    expect(clusterPxFor(14)).toBeGreaterThan(clusterPxFor(4));
    expect(clusterPxFor(14)).toBeGreaterThan(DOT_MAX_PX);
  });
});

describe('close-range declutter', () => {
  it('keeps 14 px markers 20 px apart as separate, clickable dots', () => {
    const layout = layoutOverlay(
      [
        node({ id: 'a', x: 400, y: 300, sizePx: 14 }),
        node({ id: 'b', x: 420, y: 300, sizePx: 14 }),
      ],
      opts,
    );
    expect(layout.clusters).toHaveLength(0);
    expect(layout.dots.map((d) => d.id).sort()).toEqual(['a', 'b']);
    expect(layout.dots.every((d) => d.size === 14)).toBe(true);
  });

  it('still clusters markers that would physically overlap', () => {
    const layout = layoutOverlay(
      [
        node({ id: 'a', x: 400, y: 300, sizePx: 14 }),
        node({ id: 'b', x: 408, y: 300, sizePx: 14 }),
      ],
      opts,
    );
    expect(layout.dots).toHaveLength(0);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]!.count).toBe(2);
  });

  it('never draws a marker for a grid whose block model is on screen', () => {
    const layout = layoutOverlay(
      [
        node({ id: 'drawn', x: 400, y: 300 }),
        node({ id: 'free', x: 800, y: 500 }),
        node({ id: 'also-drawn', x: 402, y: 302 }),
      ],
      { ...opts, drawnIds: ['drawn', 'also-drawn'] },
    );
    const ids = [...layout.dots.map((d) => d.id), ...layout.clusters.flatMap((c) => c.ids)];
    expect(ids).toEqual(['free']);
  });

  it('does not leave a dot sitting on a cluster badge', () => {
    const layout = layoutOverlay(
      [
        node({ id: 'c1', x: 400, y: 300, sizePx: 9 }),
        node({ id: 'c2', x: 404, y: 302, sizePx: 9 }),
        node({ id: 'solo', x: 412, y: 300, sizePx: 9 }),
      ],
      opts,
    );
    expect(layout.dots).toHaveLength(0);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]!.ids.sort()).toEqual(['c1', 'c2', 'solo']);
  });
});
