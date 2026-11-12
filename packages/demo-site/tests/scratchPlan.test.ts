import { describe, it } from 'vitest';
import { planTerrain } from '../src/lib/quadtree';
import type { TerrainPlanet } from '../src/lib/worldMapTypes';

describe('scratch plan', () => {
  it('logs leaves', () => {
    const planet = {
      id: 'e',
      name: 'EarthLike',
      generator: 'EarthLike',
      center: { x: 0, y: 0, z: 0 },
      radius_min_m: 59400,
      radius_max_m: 67200,
      sea_level_m: 60000,
      faces: ['front', 'back', 'left', 'right', 'up', 'down'],
      res: 2048,
      available: true,
      reason: null,
    } as TerrainPlanet;
    const v = [-55.876, -24.853, 1.724];
    const n = Math.hypot(v[0], v[1], v[2]);
    const cam = { x: v[0] + (v[0] / n) * 2, y: v[1] + (v[1] / n) * 2, z: v[2] + (v[2] / n) * 2 };
    const plan = planTerrain(planet, cam, new Set(), new Set(), { maxLevel: 5, maxTiles: 180 });
    const byLevel: Record<number, number> = {};
    for (const l of plan.leaves) byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
    console.log('cam', cam, 'leaves', plan.leaves.length, 'byLevel', byLevel, 'maxReached', plan.maxLevelReached);
    console.log('nearest', plan.leaves.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5).map((l) => [l.face, l.level, +l.distanceKm.toFixed(2)]));
  });
});
