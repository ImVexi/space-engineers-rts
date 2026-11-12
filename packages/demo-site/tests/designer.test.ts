import { describe, expect, it } from 'vitest';
import {
  GRAVITY_FREE_ALTITUDE_M,
  approvalBlock,
  buildPlanRequest,
  coverageLabel,
  designerReducer,
  formatGpsString,
  formatGravity,
  formatKm,
  hullOptionLabel,
  initialDesignerForm,
  optionPreview,
  parseGpsString,
  pointLabel,
  redundancyLabel,
  sortHulls,
  type DesignerForm,
  type DesignerOption,
  type Hull,
} from '../src/lib/designer';
import planFixture from './fixtures/designer/plan-constellation.json';
import hullFixture from './fixtures/designer/hulls.json';

const hulls = (hullFixture as { hulls: Hull[] }).hulls;
const plan = planFixture as unknown as { options: DesignerOption[] };
const ring = plan.options[0]!;

function form(overrides: Partial<DesignerForm> = {}): DesignerForm {
  return { ...initialDesignerForm, planet: 'EarthLike', hullId: 'owner-eagle', ...overrides };
}

describe('SE GPS parsing and formatting', () => {
  it('parses a full GPS marker string with a colour field', () => {
    expect(parseGpsString('GPS:Home Base:1000:-2000:3000:#FF0000:')).toEqual({
      name: 'Home Base',
      pos: { x: 1000, y: -2000, z: 3000 },
    });
  });

  it('parses decimals and bare coordinate triples', () => {
    expect(parseGpsString('GPS:P:1.5:2.25:-3.75:')?.pos).toEqual({ x: 1.5, y: 2.25, z: -3.75 });
    expect(parseGpsString('123456 654321 -100')?.pos).toEqual({ x: 123456, y: 654321, z: -100 });
  });

  it('rejects malformed strings instead of guessing', () => {
    expect(parseGpsString('')).toBeNull();
    expect(parseGpsString('GPS:OnlyName:1:2')).toBeNull();
    expect(parseGpsString('GPS:Bad:1:x:3')).toBeNull();
    expect(parseGpsString('not a gps')).toBeNull();
  });

  it('formats a string that parses back to the same point', () => {
    const text = formatGpsString('Drone: A', { x: 1234.6, y: -5678.4, z: 9 }, '#75FF75');
    expect(text.startsWith('GPS:Drone- A:1235:-5678:9:#75FF75:')).toBe(true);
    const parsed = parseGpsString(text);
    expect(parsed?.pos).toEqual({ x: 1235, y: -5678, z: 9 });
  });
});

describe('designer form state', () => {
  it('clamps altitude, count, spacing and margin into contract ranges', () => {
    let state = designerReducer(initialDesignerForm, { type: 'altitude', altitudeM: 10 });
    expect(state.altitudeM).toBe(500);
    state = designerReducer(state, { type: 'altitude', altitudeM: 10_000_000 });
    expect(state.altitudeM).toBe(500_000);
    expect(designerReducer(state, { type: 'count', count: 1 }).count).toBe(3);
    expect(designerReducer(state, { type: 'count', count: 9999 }).count).toBe(400);
    expect(designerReducer(state, { type: 'margin', rangeMargin: 0.1 }).rangeMargin).toBe(0.5);
    expect(designerReducer(state, { type: 'margin', rangeMargin: 3 }).rangeMargin).toBe(1);
  });

  it('applies the gravity-free preset at or above 60 km', () => {
    const low = designerReducer(initialDesignerForm, { type: 'altitude', altitudeM: 5_000 });
    const preset = designerReducer(low, { type: 'gravity-free' });
    expect(preset.altitudeM).toBeGreaterThanOrEqual(GRAVITY_FREE_ALTITUDE_M);
    expect(GRAVITY_FREE_ALTITUDE_M).toBe(60_000);
  });

  it('switches modes, points and redundancy', () => {
    let state = designerReducer(form(), { type: 'mode', mode: 'connect' });
    state = designerReducer(state, { type: 'point', which: 'a', point: { planet: 'EarthLike' } });
    state = designerReducer(state, { type: 'point', which: 'b', point: { gps: { x: 1, y: 2, z: 3 } } });
    state = designerReducer(state, { type: 'redundancy', redundancy: 'no-spof' });
    expect(state.mode).toBe('connect');
    expect(state.a).toEqual({ planet: 'EarthLike' });
    expect(state.b).toEqual({ gps: { x: 1, y: 2, z: 3 } });
    expect(state.redundancy).toBe('no-spof');
  });
});

describe('plan request builder', () => {
  it('builds a constellation body with planet, altitude and count', () => {
    const { body, error } = buildPlanRequest(form({ altitudeM: 60_000, count: 18 }));
    expect(error).toBeNull();
    expect(body).toMatchObject({
      mode: 'constellation',
      planet: 'EarthLike',
      altitudeM: 60_000,
      count: 18,
      hullId: 'owner-eagle',
      rangeMargin: 0.9,
      redundancy: 1,
    });
    expect(body?.a).toBeUndefined();
    expect(body?.spacingM).toBeUndefined();
  });

  it('sends spacing instead of count when spacing mode is selected', () => {
    const { body } = buildPlanRequest(form({ sizing: 'spacing', spacingM: 42_000 }));
    expect(body?.spacingM).toBe(42_000);
    expect(body?.count).toBeUndefined();
  });

  it('builds a connect body with both endpoints and no altitude', () => {
    const { body } = buildPlanRequest(
      form({
        mode: 'connect',
        a: { planet: 'EarthLike' },
        b: { gps: { x: 1031072, y: 131072, z: 1631072 } },
      }),
    );
    expect(body).toMatchObject({ mode: 'connect', a: { planet: 'EarthLike' } });
    expect(body?.b).toEqual({ gps: { x: 1031072, y: 131072, z: 1631072 } });
    expect(body?.altitudeM).toBeUndefined();
    expect(body?.planet).toBeUndefined();
  });

  it('refuses incomplete plans with a human reason', () => {
    expect(buildPlanRequest(form({ hullId: '' })).error).toMatch(/hull/i);
    expect(buildPlanRequest(form({ planet: '' })).error).toMatch(/planet/i);
    expect(buildPlanRequest(form({ mode: 'connect', a: null, b: null })).error).toMatch(/point A/i);
    expect(
      buildPlanRequest(form({ mode: 'connect', a: { planet: 'EarthLike' }, b: { planet: 'EarthLike' } })).error,
    ).toMatch(/same planet/i);
  });
});

describe('approval gate', () => {
  const owner = hulls.find((h) => h.id === 'owner-eagle')!;
  const ionOnly = hulls.find((h) => h.id === 'prefab-eradicator')!;
  const unknownLaunch = hulls.find((h) => h.id === 'prefab-large-control')!;

  it('allows an orbital launch for a feasible option and verified hull', () => {
    expect(approvalBlock(ring, owner, 'orbital')).toBeNull();
    expect(approvalBlock(ring, owner, 'surface')).toBeNull();
  });

  it('blocks surface launch when the hull cannot ground-launch or it is unknown', () => {
    expect(approvalBlock(ring, ionOnly, 'surface')).toMatch(/cannot ground-launch/i);
    expect(approvalBlock(ring, unknownLaunch, 'surface')).toMatch(/UNVERIFIED/i);
    expect(approvalBlock(ring, ionOnly, 'orbital')).toBeNull();
  });

  it('blocks infeasible options and explains why', () => {
    const infeasible = plan.options.find((o) => !o.feasible)!;
    expect(approvalBlock(infeasible, owner, 'orbital')).toMatch(/TWR|gap/i);
    expect(approvalBlock(null, owner, 'orbital')).toMatch(/plan an option/i);
  });
});

describe('preview geometry', () => {
  it('maps planner slots and only links whose ends exist', () => {
    const preview = optionPreview({ ...ring, links: [...ring.links, { a: 'slot-0', b: 'ghost', kind: 'radio', lengthM: 1 }] })!;
    expect(preview.slots).toHaveLength(ring.count);
    expect(preview.links).toHaveLength(ring.links.length);
    expect(preview.links.some((l) => l.to === 'ghost')).toBe(false);
    expect(preview.slots[0]!.pos).toEqual({ x: ring.positions[0]!.x, y: ring.positions[0]!.y, z: ring.positions[0]!.z });
    expect(optionPreview(null)).toBeNull();
  });

  it('marks every ring link radio and keeps metric lengths positive', () => {
    const preview = optionPreview(ring)!;
    expect(preview.links.every((l) => l.kind === 'radio')).toBe(true);
    expect(preview.links.length).toBe(ring.count);
  });
});

describe('pretty printers and hull ordering', () => {
  it('orders owner-tagged hulls first and labels them with range + launch', () => {
    const sorted = sortHulls(hulls);
    expect(sorted[0]!.source).toBe('owner-tagged');
    expect(hullOptionLabel(sorted[0]!)).toContain('[HERMES-TEST]');
    expect(hullOptionLabel(sorted[0]!)).toContain('radio 50');
    expect(hullOptionLabel(sorted[0]!)).toContain('ground launch yes');
  });

  it('formats units without inventing precision', () => {
    expect(formatKm(41_467)).toBe('41.5 km');
    expect(formatKm(null)).toBe('—');
    expect(formatGravity(2.86)).toBe('2.86 m/s²');
    expect(formatGravity(null)).toBe('—');
    expect(coverageLabel(null)).toBe('n/a (point-to-point)');
    expect(coverageLabel(99.6)).toBe('100%');
    expect(redundancyLabel(2)).toBe('Two node-disjoint paths');
    expect(redundancyLabel('no-spof')).toBe('No single point of failure');
    expect(pointLabel({ gps: { x: 1, y: 2, z: 3 } })).toContain('GPS 1, 2, 3');
  });
});
