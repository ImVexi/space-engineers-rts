import { describe, expect, it } from 'vitest';
import {
  RING_HIDE_BELOW_PX,
  RING_MAX_ACTIVE,
  RING_MIN_SCALE,
  RING_MIN_WIDTH_PX,
  PULSE_PERIOD_S,
  RING_MAX_OPACITY,
  phaseForId,
  pickPulsingNodes,
  pulseAt,
  ringInnerRatio,
  ringRadiusUnits,
  ringVisible,
  ringWidthPx,
  screenRadiusPx,
} from '../src/lib/rings';

describe('true scale', () => {
  it('converts metres to scene kilometres without exaggeration', () => {
    expect(ringRadiusUnits(50_000)).toBe(50);
    expect(ringRadiusUnits(5_000)).toBe(5);
    expect(ringRadiusUnits(0)).toBe(0);
    expect(ringRadiusUnits(-1)).toBe(0);
    expect(ringRadiusUnits(50_000, 0.15)).toBeCloseTo(7.5, 9);
  });

  it('shrinks with the pulse but never leaves 15 % of the real radius', () => {
    for (let t = 0; t < PULSE_PERIOD_S * 3; t += 0.07) {
      const pulse = pulseAt(t, 0.37);
      const r = ringRadiusUnits(50_000, pulse.scale);
      expect(pulse.scale).toBeGreaterThanOrEqual(RING_MIN_SCALE - 1e-9);
      expect(pulse.scale).toBeLessThanOrEqual(1 + 1e-9);
      expect(r).toBeGreaterThanOrEqual(50 * RING_MIN_SCALE - 1e-9);
      expect(r).toBeLessThanOrEqual(50 + 1e-9);
    }
  });
});

describe('pulse phase', () => {
  it('starts at 15 % with full opacity and reaches 100 % as it fades out', () => {
    const start = pulseAt(0, 0);
    expect(start.scale).toBeCloseTo(RING_MIN_SCALE, 9);
    expect(start.opacity).toBeCloseTo(RING_MAX_OPACITY, 9);
    const end = pulseAt(PULSE_PERIOD_S * 0.999, 0);
    expect(end.scale).toBeGreaterThan(0.999);
    expect(end.opacity).toBeLessThan(0.005);
  });

  it('moves 85 % of the way in half a period', () => {
    const half = pulseAt(PULSE_PERIOD_S / 2, 0);
    // Ease-out cubic: half the period already covers 87.5 % of the expansion.
    expect(half.scale).toBeCloseTo(0.15 + 0.85 * 0.875, 9);
    expect(half.opacity).toBeCloseTo(RING_MAX_OPACITY * Math.pow(0.5, 1.2), 9);
  });

  it('offsets each node so rings do not sync', () => {
    const a = pulseAt(0, phaseForId('grid:a'));
    const b = pulseAt(0, phaseForId('grid:b'));
    expect(a.scale).not.toBeCloseTo(b.scale, 3);
    // The same id always gets the same phase (stable across polls/renders).
    expect(phaseForId('grid:a')).toBe(phaseForId('grid:a'));
    expect(phaseForId('grid:a')).not.toBe(phaseForId('grid:b'));
    for (const id of ['grid:a', 'grid:b', 'grid:c', '']) {
      const p = phaseForId(id);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('is periodic', () => {
    expect(pulseAt(0.3, 0.2).scale).toBeCloseTo(pulseAt(0.3 + PULSE_PERIOD_S * 4, 0.2).scale, 9);
  });
});

describe('screen size clamp', () => {
  const fov = 50;
  const height = 700;

  it('matches the perspective projection for a 50 km ring', () => {
    const distance = 100;
    const worldHeight = 2 * distance * Math.tan((fov * Math.PI) / 360);
    const expected = (50 / worldHeight) * height;
    expect(screenRadiusPx(50, distance, fov, height)).toBeCloseTo(expected, 6);
    expect(screenRadiusPx(50, distance, fov, height)).toBeCloseTo(375.29, 1);
  });

  it('halves when the camera pulls back twice as far', () => {
    const near = screenRadiusPx(50, 100, fov, height);
    const far = screenRadiusPx(50, 200, fov, height);
    expect(far).toBeCloseTo(near / 2, 6);
  });

  it('hides a ring below 0.5 px and shows it at 0.5 px', () => {
    expect(ringVisible(RING_HIDE_BELOW_PX - 0.01)).toBe(false);
    expect(ringVisible(RING_HIDE_BELOW_PX)).toBe(true);
    expect(ringVisible(Number.NaN)).toBe(false);
    expect(ringVisible(0)).toBe(false);
  });

  it('never draws a stroke thinner than 2 px and caps it at 8 px', () => {
    expect(ringWidthPx(1)).toBe(RING_MIN_WIDTH_PX);
    expect(ringWidthPx(100)).toBe(RING_MIN_WIDTH_PX);
    expect(ringWidthPx(1000)).toBe(8);
    expect(ringWidthPx(400)).toBeCloseTo(4.8, 6);
  });

  it('keeps the annulus a thin band instead of a filled disc', () => {
    expect(ringInnerRatio(1000)).toBeCloseTo(0.992, 6);
    expect(ringInnerRatio(10)).toBeCloseTo(0.8, 6);
    expect(ringInnerRatio(1)).toBeLessThanOrEqual(0.995);
    expect(ringInnerRatio(1)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('pulsing pool', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    id: `n${String(i).padStart(2, '0')}`,
    position: { x: i * 10_000, y: 0, z: 0 },
    radioRadiusM: 50_000,
  }));

  it('caps the pool at 40 nodes', () => {
    expect(pickPulsingNodes(nodes, { x: 0, y: 0, z: 0 }, RING_MAX_ACTIVE)).toHaveLength(40);
  });

  it('picks the nodes nearest to the camera first', () => {
    const picked = pickPulsingNodes(nodes, { x: 59, y: 0, z: 0 }, 5);
    expect(picked.map((n) => n.id)).toEqual(['n06', 'n05', 'n07', 'n04', 'n08']);
  });

  it('ignores nodes without a real radius', () => {
    const picked = pickPulsingNodes(
      [{ id: 'a', position: { x: 0, y: 0, z: 0 }, radioRadiusM: null }, { id: 'b', position: { x: 1, y: 0, z: 0 }, radioRadiusM: 0 }],
      { x: 0, y: 0, z: 0 },
      40,
    );
    expect(picked).toEqual([]);
  });
});
