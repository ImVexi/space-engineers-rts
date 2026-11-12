import { describe, expect, it } from 'vitest';
import { gridKey, livePos, poseQuat } from '../src/lib/pose';
import type { DemoNode } from '../src/types';
import type { WorldGrid } from '../src/lib/worldMapTypes';
import { hoverLabelBoxFor, labelBoxFor, LABEL_H, LABEL_W } from '../src/lib/markers';

const grid = {
  id: '107519913664561774',
  name: 'SAT-L-0001',
  size_class: 'Large',
  grid_size_m: 2.5,
  pos: { x: 1, y: 2, z: 3 },
  quat: { x: 0.1, y: 0.2, z: 0.3, w: 0.927 },
  bbox_local: { min: [0, 0, 0], max: [1, 1, 1] },
  block_count: 59,
  asset: '/api/demo/world/grid/107519913664561774?h=h',
  subtypes: [],
} as unknown as WorldGrid;

function node(over: Partial<DemoNode> = {}): DemoNode {
  return {
    id: 'grid:107519913664561774',
    name: 'SAT-L-0001',
    prefab: 'x',
    planet: 'EarthLike',
    position: { x: 10, y: 20, z: 30 },
    controlSource: false,
    status: 'alive',
    origin: 'spawn',
    note: '',
    source: 'GAME',
    capabilityKnown: true,
    capability: null,
    links: [],
    ports: { used: 0, capacity: 0 },
    reachable: true,
    gate: null,
    ...over,
  } as DemoNode;
}

describe('live pose for block shapes', () => {
  it('maps telemetry ids to save manifest ids', () => {
    expect(gridKey('grid:107519913664561774')).toBe('107519913664561774');
    expect(gridKey('107519913664561774')).toBe('107519913664561774');
  });

  it('places the model at the live telemetry position, not the save position', () => {
    const n = node({
      telemetry: {
        name: 'SAT-L-0001',
        lastSeen: 1,
        ageMs: 300,
        fresh: true,
        pos: { x: 400, y: 500, z: 600 },
        vel: null,
        speedMps: 0,
        moving: false,
        linkStatus: 'up',
        ownership: 'owner',
      },
    });
    expect(livePos(n, grid)).toEqual({ x: 400, y: 500, z: 600 });
  });

  it('falls back to the save orientation while telemetry has no quat', () => {
    expect(poseQuat(node(), grid)).toEqual([0.1, 0.2, 0.3, 0.927]);
  });

  it('uses a telemetry quat when the plugin reports one', () => {
    const n = node({
      telemetry: {
        name: 'x',
        lastSeen: 1,
        ageMs: 100,
        fresh: true,
        pos: { x: 0, y: 0, z: 0 },
        vel: null,
        speedMps: 0,
        moving: false,
        linkStatus: 'up',
        ownership: null,
        quat: { x: 0, y: 0, z: 0, w: 1 },
      } as DemoNode['telemetry'],
    });
    expect(poseQuat(n, grid)).toEqual([0, 0, 0, 1]);
  });
});

describe('hover tooltip placement', () => {
  it('sits beside the marker instead of on top of it', () => {
    const point = { x: 400, y: 300 };
    const box = hoverLabelBoxFor(point, 1200, 800);
    // Fully to the right: the card never covers the dot itself.
    expect(box.x).toBeGreaterThan(point.x + 10);
    expect(box.w).toBe(LABEL_W);
    expect(box.h).toBe(LABEL_H);
    expect(box.y + box.h / 2).toBeCloseTo(point.y, 5);
  });

  it('flips to the left near the right edge, still clear of the marker', () => {
    const point = { x: 1180, y: 300 };
    const box = hoverLabelBoxFor(point, 1200, 800);
    expect(box.x + box.w).toBeLessThan(point.x - 10);
  });

  it('keeps the non-hover label above the marker (unchanged)', () => {
    const box = labelBoxFor({ x: 400, y: 300 }, 1200, 800);
    expect(box.y + box.h).toBeLessThan(300);
  });
});
