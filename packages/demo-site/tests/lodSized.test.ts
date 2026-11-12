import { describe, expect, it } from 'vitest';
import { LOD, classifyLodSized, planLod } from '../src/lib/lod';

/** pixels per km at 1 km for a 950 px viewport at 50° fov */
const PX_PER_KM = 950 / (2 * Math.tan((50 * Math.PI) / 360));

describe('bbox-based block LOD', () => {
  it('keeps a 10.8 m satellite as a marker until its hull is a few px wide', () => {
    const sat = 0.0108; // km diagonal
    expect(classifyLodSized(50, sat, PX_PER_KM)).toBe('far'); // 0.2 px
    expect(classifyLodSized(2, sat, PX_PER_KM)).toBe('far'); // 5.1 px, still a marker
    expect(classifyLodSized(0.6, sat, PX_PER_KM)).toBe('mid'); // 17 px → bbox
    expect(classifyLodSized(0.3, sat, PX_PER_KM)).toBe('near'); // 34 px / close rule
  });

  it('promotes a 130 m warship at a few km, where its hull really reads', () => {
    const warship = 0.1297;
    expect(classifyLodSized(40, warship, PX_PER_KM)).toBe('far'); // 3.3 px
    expect(classifyLodSized(10, warship, PX_PER_KM)).toBe('mid'); // 13 px
    expect(classifyLodSized(3, warship, PX_PER_KM)).toBe('near'); // 41 px
  });

  it('uses the close rule: distance < 30 x bbox diagonal is near', () => {
    expect(LOD.nearDiagFactor).toBe(30);
    expect(classifyLodSized(0.3, 0.0108, 1)).toBe('near'); // 27.8x, even at 1 px
  });

  it('hysteresis stops a camera on the boundary from thrashing', () => {
    const sat = 0.0108;
    const near = classifyLodSized(0.3, sat, PX_PER_KM);
    expect(near).toBe('near');
    // 28 px is below the 40 px enter rule but above the 30 px keep rule ...
    expect(classifyLodSized(0.37, sat, PX_PER_KM, 'near')).toBe('near');
    // ... and only the 6.5 px far band demotes it further out.
    expect(classifyLodSized(0.5, sat, PX_PER_KM, 'near')).toBe('mid');
    expect(classifyLodSized(0.5, sat, PX_PER_KM, 'mid')).toBe('mid');
    expect(classifyLodSized(12, sat, PX_PER_KM, 'near')).toBe('far');
  });

  it('planLod applies the bbox rule when an entry has a diagonal', () => {
    const plan = planLod(
      [
        { id: 'sat-far', x: 2, y: 0, z: 0, bboxKm: 0.0108 },
        { id: 'sat-mid', x: 0.8, y: 0, z: 0, bboxKm: 0.0108 },
        { id: 'sat-near', x: 0.3, y: 0, z: 0, bboxKm: 0.0108 },
        { id: 'no-bbox', x: 0.4, y: 0, z: 0 },
      ],
      { x: 0, y: 0, z: 0 },
      {},
      LOD,
      PX_PER_KM,
    );
    expect(plan.levels['sat-far']).toBe('far');
    expect(plan.levels['sat-mid']).toBe('mid');
    expect(plan.levels['sat-near']).toBe('near');
    // Legacy distance rule still applies when no bbox was supplied.
    expect(plan.levels['no-bbox']).toBe('near');
  });
});
