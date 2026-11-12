import { describe, expect, it } from 'vitest';
import { HULL_PX_MAX, HULL_PX_MIN, clusterBadgePx, hullPxFor, worldRadiusForPx } from '../src/lib/markers';

/**
 * CONTRACT-HULL: a marker is anchored to the grid's real hull, not a fixed
 * 1 km bubble, and is screen-clamped so it can never wrap the model.
 */
describe('hull-anchored marker size', () => {
  it('clamps to 3–18 px at every distance', () => {
    for (const d of [1, 30, 300, 3_000, 30_000, 300_000, 3_000_000]) {
      const px = hullPxFor(11, d, 50, 950);
      expect(px).toBeGreaterThanOrEqual(HULL_PX_MIN);
      expect(px).toBeLessThanOrEqual(HULL_PX_MAX);
    }
  });

  it('a small satellite projects smaller than a big base at the same distance', () => {
    const sat = hullPxFor(11, 400, 50, 950); // 11 m satellite
    const base = hullPxFor(130, 400, 50, 950); // 130 m base
    expect(base).toBeGreaterThan(sat);
  });

  it('is a dot at far zoom and never a screen-filling blob up close', () => {
    expect(hullPxFor(11, 50_000_000, 50, 950)).toBe(HULL_PX_MIN);
    expect(hullPxFor(500, 10, 50, 950)).toBe(HULL_PX_MAX);
  });

  it('world radius for a px target projects back to that px', () => {
    const px = 12;
    const r = worldRadiusForPx(px, 400, 50, 950);
    const pxPerKm = 950 / 2 / (400 * Math.tan((50 * Math.PI) / 360));
    expect(r * pxPerKm).toBeCloseTo(px, 5);
  });
});

describe('cluster badge size', () => {
  it('grows with the count, never with hull size', () => {
    expect(clusterBadgePx(2)).toBeLessThan(clusterBadgePx(9));
    expect(clusterBadgePx(9)).toBeLessThanOrEqual(clusterBadgePx(200));
    expect(clusterBadgePx(1_000_000)).toBe(36);
  });
});
