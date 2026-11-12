import { describe, expect, it } from 'vitest';
import {
  CLUSTER_PX,
  LABEL_H,
  LABEL_W,
  layoutOverlay,
  layoutPlanetLabels,
  overlaps,
  type ScreenNode,
  type ScreenPlanet,
} from '../src/lib/markers';

function makeNode(over: Partial<ScreenNode> & { id: string }): ScreenNode {
  return {
    name: over.id,
    visible: true,
    x: 400,
    y: 300,
    world: { x: 0, y: 0, z: 0 },
    live: false,
    moving: false,
    speedMps: 0,
    ageSec: 120,
    owner: null,
    isGame: true,
    spof: false,
    isolated: false,
    distance: 1000,
    ...over,
  };
}

const opts = { width: 1000, height: 700, selectedId: null, hoveredId: null, showStale: false };

describe('stale filter', () => {
  it('hides stale grids by default and reports both counts', () => {
    const nodes = [
      makeNode({ id: 'live-1', x: 100, y: 100, live: true, ageSec: 2 }),
      makeNode({ id: 'live-2', x: 800, y: 600, live: true, ageSec: 5 }),
      makeNode({ id: 'stale-1', x: 300, y: 300 }),
      makeNode({ id: 'stale-2', x: 320, y: 300 }),
      makeNode({ id: 'stale-3', x: 340, y: 300 }),
      makeNode({ id: 'sim-1', x: 500, y: 500, isGame: false, live: false }),
    ];
    const layout = layoutOverlay(nodes, opts);
    expect(layout.counts).toEqual({ live: 2, stale: 3 });
    const drawn = new Set([...layout.dots.map((d) => d.id), ...layout.clusters.flatMap((c) => c.ids)]);
    expect(drawn.has('stale-1')).toBe(false);
    expect(drawn.has('stale-2')).toBe(false);
    expect(drawn.has('sim-1')).toBe(true);
  });

  it('draws stale grids as markers when Show stale is on, but never labels them', () => {
    const nodes = [
      makeNode({ id: 'stale-a', x: 200, y: 200 }),
      makeNode({ id: 'stale-b', x: 700, y: 500 }),
    ];
    const layout = layoutOverlay(nodes, { ...opts, showStale: true });
    expect(layout.labels).toHaveLength(0);
    expect(layout.dots.map((d) => d.id).sort()).toEqual(['stale-a', 'stale-b']);
    expect(layout.dots.every((d) => d.kind === 'stale')).toBe(true);
  });

  it('keeps the selected grid visible and labelled even when it is stale', () => {
    const nodes = [makeNode({ id: 'stale-selected', x: 250, y: 250 })];
    const layout = layoutOverlay(nodes, { ...opts, selectedId: 'stale-selected' });
    expect(layout.labels.map((l) => [l.id, l.role])).toEqual([['stale-selected', 'selected']]);
    expect(layout.dots.some((d) => d.id === 'stale-selected')).toBe(true);
  });
});

describe('label priority and declutter', () => {
  it('labels at most 8 live moving drones, nearest to camera first', () => {
    const nodes = Array.from({ length: 12 }, (_, i) =>
      makeNode({
        id: `d${i}`,
        x: 60 + i * 75,
        y: 80 + (i % 3) * 200,
        live: true,
        moving: true,
        speedMps: 40,
        distance: 1000 + i * 100,
      }),
    );
    const layout = layoutOverlay(nodes, opts);
    expect(layout.labels).toHaveLength(8);
    const ids = layout.labels.map((l) => l.id);
    for (let i = 0; i < 8; i += 1) expect(ids).toContain(`d${i}`);
    expect(layout.labels.every((l) => l.role === 'drone')).toBe(true);
  });

  it('gives selected and hovered labels precedence over drones', () => {
    const nodes = [
      makeNode({ id: 'selected', x: 100, y: 100, live: true, moving: true, distance: 10 }),
      makeNode({ id: 'hovered', x: 500, y: 100, live: true, moving: true, distance: 20 }),
      makeNode({ id: 'drone', x: 800, y: 400, live: true, moving: true, distance: 1 }),
    ];
    const layout = layoutOverlay(nodes, { ...opts, selectedId: 'selected', hoveredId: 'hovered' });
    const roles = new Map(layout.labels.map((l) => [l.id, l.role]));
    expect(roles.get('selected')).toBe('selected');
    expect(roles.get('hovered')).toBe('hovered');
    expect(roles.get('drone')).toBe('drone');
  });

  it('drops a lower-priority label that would overlap a higher-priority one', () => {
    const nodes = [
      makeNode({ id: 'near', x: 400, y: 300, live: true, moving: true, distance: 5 }),
      makeNode({ id: 'next', x: 404, y: 302, live: true, moving: true, distance: 50 }),
    ];
    const layout = layoutOverlay(nodes, opts);
    expect(layout.labels).toHaveLength(1);
    expect(layout.labels[0]!.id).toBe('near');
  });

  it('never produces overlapping label rectangles in a crowded viewport', () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      makeNode({
        id: `p${i}`,
        x: 300 + (i % 3) * 30,
        y: 300 + Math.floor(i / 3) * 30,
        live: true,
        moving: true,
        distance: i,
      }),
    );
    const layout = layoutOverlay(nodes, opts);
    for (let a = 0; a < layout.labels.length; a += 1) {
      for (let b = a + 1; b < layout.labels.length; b += 1) {
        expect(overlaps(layout.labels[a]!, layout.labels[b]!, 0)).toBe(false);
      }
    }
    expect(layout.labels.length).toBeGreaterThan(0);
  });

  it('keeps label cards inside the viewport', () => {
    const nodes = [makeNode({ id: 'corner', x: 2, y: 2, live: true, moving: true })];
    const layout = layoutOverlay(nodes, opts);
    const label = layout.labels[0]!;
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.y).toBeGreaterThanOrEqual(0);
    expect(label.x + label.w).toBeLessThanOrEqual(opts.width);
    expect(label.y + label.h).toBeLessThanOrEqual(opts.height);
    expect(label.h).toBe(LABEL_H);
    expect(label.w).toBe(LABEL_W);
  });
});

describe('clustering', () => {
  it('collapses markers within 24 px into one badge with a count and centroid', () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      makeNode({
        id: `c${i}`,
        x: 500 + i * 3,
        y: 400 + (i % 2) * 2,
        world: { x: i * 1000, y: 0, z: 0 },
      }),
    );
    const layout = layoutOverlay(nodes, { ...opts, showStale: true });
    expect(layout.dots).toHaveLength(0);
    expect(layout.clusters).toHaveLength(1);
    const badge = layout.clusters[0]!;
    expect(badge.count).toBe(6);
    expect(badge.ids).toHaveLength(6);
    expect(Math.abs(badge.x - 507.5)).toBeLessThanOrEqual(CLUSTER_PX);
    expect(badge.world.x).toBeCloseTo(2500, 5);
    expect(badge.spreadM).toBeCloseTo(2500, 5);
  });

  it('keeps well-separated markers as individual dots', () => {
    const nodes = [
      makeNode({ id: 'a', x: 100, y: 100 }),
      makeNode({ id: 'b', x: 400, y: 400 }),
      makeNode({ id: 'c', x: 700, y: 200 }),
    ];
    const layout = layoutOverlay(nodes, { ...opts, showStale: true });
    expect(layout.clusters).toHaveLength(0);
    expect(layout.dots).toHaveLength(3);
  });

  it('does not absorb a labelled drone into a cluster', () => {
    const nodes = [
      makeNode({ id: 'drone', x: 500, y: 400, live: true, moving: true, distance: 1 }),
      makeNode({ id: 's1', x: 502, y: 402 }),
      makeNode({ id: 's2', x: 504, y: 400 }),
    ];
    const layout = layoutOverlay(nodes, { ...opts, showStale: true });
    expect(layout.labels.map((l) => l.id)).toEqual(['drone']);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]!.ids.sort()).toEqual(['s1', 's2']);
  });
});

describe('planet labels', () => {
  const planets: ScreenPlanet[] = [
    { id: 'earth', name: 'EARTHLIKE', x: 500, y: 350, radiusPx: 80, selected: false },
    { id: 'moon', name: 'MOON', x: 650, y: 330, radiusPx: 4, selected: false },
  ];

  it('places labels on the limb, not on top of the planet centre', () => {
    const labels = layoutPlanetLabels(planets, 1000, 700, []);
    const earth = labels.find((l) => l.id === 'earth')!;
    // Centre is the viewport centre, so the limb direction is ambiguous → label
    // is pushed to the top limb by the fallback, not over the middle.
    expect(earth).toBeTruthy();
    expect(Math.abs(earth.y - 350)).toBeGreaterThan(20);
    for (const l of labels) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(1000);
    }
  });

  it('yields to grid label cards instead of covering them', () => {
    const grid = { x: 20, y: 140, w: 176, h: 34 };
    const labels = layoutPlanetLabels(
      [{ id: 'earth', name: 'EARTHLIKE', x: 100, y: 180, radiusPx: 40, selected: false }],
      1000,
      700,
      [grid],
    );
    for (const l of labels) {
      expect(overlaps(l, grid, 0)).toBe(false);
    }
  });

  it('drops a planet label when every candidate slot is blocked', () => {
    const labels = layoutPlanetLabels(planets, 1000, 700, [{ x: 0, y: 0, w: 1000, h: 700 }]);
    expect(labels).toHaveLength(0);
  });
});
