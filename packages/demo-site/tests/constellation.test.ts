import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  assignToSlots,
  backendPattern,
  buildConstellationPlan,
  constellationReducer,
  constellationSentence,
  DEFAULT_CONSTELLATION,
  estimateCost,
  ghostSlots,
  groundReachM,
  matchHullId,
  MIN_CONSTELLATION_COUNT,
  type ConstellationForm,
} from '../src/lib/constellation';
import {
  alternativeLines,
  applyGuard,
  countLabel,
  decidePlannedShips,
  formatCoverage,
  memberEstimatesFromMoves,
  coverageNumber,
  slotLines,
} from '../src/lib/constellationView';
import { previewCoverage } from '../src/lib/coverage';
import type { DesignerOption } from '../src/lib/designer';
import type { OptimisePlan } from '../src/lib/optimise';
import { ConstellationPanel } from '../src/components/ConstellationPanel';
import type { DemoState } from '../src/types';
import type { ShipGroup } from '../src/lib/groups';

const planet = { center: { x: 1_000_000, y: 0, z: 0 }, surfaceRadiusM: 59_400 };
const form = (patch: Partial<ConstellationForm> = {}): ConstellationForm => ({
  ...DEFAULT_CONSTELLATION,
  planet: 'EarthLike',
  hullId: 'tagged:grid:1',
  ...patch,
});

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('ghost slots', () => {
  it('puts every ring slot at one altitude above the surface', () => {
    const slots = ghostSlots(planet, { count: 8, altitudeM: 60_000, pattern: 'ring', inclinationDeg: 0 });
    expect(slots).toHaveLength(8);
    for (const slot of slots) expect(dist(slot, planet.center)).toBeCloseTo(59_400 + 60_000, 3);
    expect(slots[0]!.y).toBeCloseTo(planet.center.y, 6);
    expect(dist(slots[0]!, slots[4]!)).toBeCloseTo((59_400 + 60_000) * 2, 3);
  });

  it('tilts two rings in opposite directions', () => {
    const slots = ghostSlots(planet, { count: 8, altitudeM: 60_000, pattern: 'inclined', inclinationDeg: 30 });
    expect(slots).toHaveLength(8);
    const ys = slots.map((s) => s.y - planet.center.y);
    expect(Math.max(...ys)).toBeGreaterThan(40_000);
    expect(Math.min(...ys)).toBeLessThan(-40_000);
  });

  it('spreads the arc over 140 degrees and the shell over both hemispheres', () => {
    const arc = ghostSlots(planet, { count: 5, altitudeM: 20_000, pattern: 'arc', inclinationDeg: 0 });
    expect(arc).toHaveLength(5);
    expect(arc[0]!.z).toBeLessThan(arc[4]!.z);
    const shell = ghostSlots(planet, { count: 12, altitudeM: 40_000, pattern: 'shell', inclinationDeg: 0 });
    expect(shell).toHaveLength(12);
    expect(Math.max(...shell.map((s) => s.y))).toBeGreaterThan(0);
    expect(Math.min(...shell.map((s) => s.y))).toBeLessThan(0);
  });

  it('clamps a fixed count but leaves the AUTO count alone', () => {
    const next = constellationReducer(form(), { type: 'patch', patch: { count: 0, altitudeM: -5 } });
    expect(next.count).toBe(2);
    expect(MIN_CONSTELLATION_COUNT).toBe(2);
    expect(next.altitudeM).toBe(100);
    expect(constellationReducer(form(), { type: 'patch', patch: { count: 999 } }).count).toBe(20);
    // Auto survives: the solver, not the reducer, picks the number.
    expect(constellationReducer(form({ count: 9 }), { type: 'patch', patch: { count: null } }).count).toBeNull();
  });

  it('never builds a manual-shape plan the backend would reject for count < 2', () => {
    expect(buildConstellationPlan(form({ goal: 'pattern', count: 1 })).body).toBeNull();
    expect(buildConstellationPlan(form({ goal: 'pattern', count: 1 })).error).toContain('at least 2');
    expect(buildConstellationPlan(form({ goal: 'pattern', count: 2 })).body).not.toBeNull();
  });
});

describe('plan request (T53 cover goal)', () => {
  it('defaults to the coverage goal, NOT a geometric constellation', () => {
    const { body, error } = buildConstellationPlan(form());
    expect(error).toBeNull();
    expect(body).toMatchObject({
      mode: 'cover-planet',
      planet: 'EarthLike',
      hullId: 'tagged:grid:1',
      altitudeMode: 'cheapest',
      target: 'whole',
      redundancy: 1,
    });
    // AUTO count means the request carries no count at all.
    expect(body && 'count' in body).toBe(false);
    expect(DEFAULT_CONSTELLATION.goal).toBe('cover');
    expect(DEFAULT_CONSTELLATION.count).toBeNull();
  });

  it('sends the target, radius, fixed count and manual altitude when the operator sets them', () => {
    const radius = buildConstellationPlan(form({ target: 'radius', targetRadiusM: 75_000 })).body;
    expect(radius).toMatchObject({ mode: 'cover-planet', target: 'radius', targetRadiusM: 75_000 });
    const fixed = buildConstellationPlan(form({ count: 14, altitudeMode: 'max-reach' })).body;
    expect(fixed).toMatchObject({ count: 14, altitudeMode: 'max-reach' });
    const manual = buildConstellationPlan(form({ altitudeMode: 'manual', altitudeM: 12_000 })).body;
    expect(manual).toMatchObject({ altitudeMode: 'manual', altitudeM: 12_000 });
    const hemisphere = buildConstellationPlan(form({ target: 'hemisphere' })).body;
    expect(hemisphere).toMatchObject({ target: 'hemisphere' });
    expect(hemisphere && 'targetRadiusM' in hemisphere).toBe(false);
  });

  it('maps the panel patterns onto the planner patterns for a manual shape', () => {
    expect(backendPattern('ring')).toBe('ring');
    expect(backendPattern('inclined')).toBe('inclined-rings');
    expect(backendPattern('shell')).toBe('shell');
    expect(backendPattern('arc')).toBe('chain');
    expect(buildConstellationPlan(form({ goal: 'pattern', pattern: 'inclined', count: 6 })).body).toMatchObject({
      mode: 'constellation',
      pattern: 'inclined-rings',
      count: 6,
    });
  });

  it('writes one plain sentence naming the auto count', () => {
    expect(constellationSentence(form({ count: 8, target: 'whole' }), 'EarthLike')).toContain('Covers whole planet');
    expect(constellationSentence(form(), 'EarthLike', 13)).toContain('13 relays needed');
  });

  it('matches an owner-tagged hull by member grid id', () => {
    expect(matchHullId(['grid:123'], ['prefab:X', 'tagged:grid:123'])).toBe('tagged:grid:123');
    expect(matchHullId(['grid:999'], ['prefab:X'])).toBeNull();
  });
});

describe('T52 ground reach', () => {
  it('peaks near 18.5 km for a 50 km radio and drops to zero above the radio', () => {
    const peak = groundReachM(59_400, 18_500, 50_000);
    expect(peak / 1000).toBeGreaterThan(40);
    expect(peak / 1000).toBeLessThan(43);
    expect(groundReachM(59_400, 10_000, 50_000) / 1000).toBeCloseTo(32.2, 0);
    expect(groundReachM(59_400, 60_000, 50_000)).toBe(0);
  });
});

describe('assignment + cost line (T51.9c/d)', () => {
  const slots = [
    { x: 0, y: 0, z: 0 },
    { x: 10_000, y: 0, z: 0 },
    { x: 20_000, y: 0, z: 0 },
  ];

  it('pairs each ship with its nearest free slot, deterministically', () => {
    const members = [
      { id: 'a', position: { x: 19_500, y: 0, z: 0 } },
      { id: 'b', position: { x: 100, y: 0, z: 0 } },
      { id: 'c', position: { x: 10_100, y: 0, z: 0 } },
    ];
    const pairs = assignToSlots(members, slots);
    expect(pairs).toHaveLength(3);
    expect(pairs.find((p) => p.gridId === 'a')!.slotIndex).toBe(2);
    expect(pairs.find((p) => p.gridId === 'b')!.slotIndex).toBe(0);
    expect(pairs.find((p) => p.gridId === 'c')!.slotIndex).toBe(1);
    expect(assignToSlots(members, slots)).toEqual(pairs);
  });

  it('sums per-member estimates and never gives up on the whole line', () => {
    const move = (id: string, distanceM: number, h2L: number | null) => ({
      gridId: id,
      name: id,
      from: { pos: { x: 0, y: 0, z: 0 }, altitudeM: 5_000, latDeg: 0, lonDeg: 0 },
      to: { pos: { x: 0, y: 0, z: 0 }, altitudeM: 15_000, latDeg: 0, lonDeg: 0 },
      distanceM,
      etaS: distanceM / 100,
      fuel: { h2L, batteryMWh: null, reservePct: 40 },
      thrustClassNeeded: 'hydrogen',
      holdMode: 'station',
      reason: 'covers more cells per ship',
      substitution: {
        basis: 'x',
        cellsCovered: 1,
        coversTotal: 1,
        uncoveredDuringTransit: false,
        uncoveredCellCount: 0,
        uncoveredCells: [],
        uncoveredTruncated: false,
        transitEtaS: 10,
      },
    });
    const estimates = memberEstimatesFromMoves([move('a', 41_900, 12), move('b', 10_000, 3)], {});
    const cost = estimateCost(estimates, { gainPct: 16, fromPct: 78, toPct: 94 });
    expect(cost.moves).toBe(2);
    expect(cost.totalM).toBeCloseTo(51_900, 3);
    expect(cost.h2L).toBeCloseTo(15, 5);
    expect(cost.text).toContain('2 moves · 52 km total');
    expect(cost.text).toContain('15.0 L H2');
    expect(cost.text).toContain('+16.0 pts');
    expect(cost.text).not.toContain('fuel estimate unavailable');

    // One member with no fuel model names itself; the priced ones still count.
    const partial = estimateCost(memberEstimatesFromMoves([move('a', 41_900, 12), move('no-model', 10_000, null)], {}));
    expect(partial.text).toContain('12.0 L H2');
    expect(partial.text).toContain('no estimate for no-model');
    expect(partial.unestimated).toEqual(['no-model']);
  });

  it('says everything is in place when nothing needs to move', () => {
    const cost = estimateCost([
      { id: 'a', name: 'Alpha', distanceM: 10, etaS: 0, h2L: null, batteryMWh: null, altitudeChangeM: 0, reason: '' },
    ]);
    expect(cost.moves).toBe(0);
    expect(cost.etaS).toBe(0);
    expect(cost.text).toContain('already in place');
  });
});

describe('planned count + Apply guard (T51.9a/b)', () => {
  it('Apply label is the planned count, not the group size', () => {
    const members = Array.from({ length: 18 }, (_, i) => ({ id: `grid:${i + 1}` }));
    const optimise = { moves: [{ gridId: 'grid:3', distanceM: 100 }, { gridId: 'grid:9', distanceM: 50 }], staying: [{ gridId: 'grid:1', reason: 'already covers its cells' }] } as unknown as OptimisePlan;
    const planned = decidePlannedShips({ members, optimise, option: null });
    expect(planned.count).toBe(2);
    expect(planned.ships.map((s) => s.gridId)).toEqual(['grid:9', 'grid:3']);
    expect(planned.staying).toHaveLength(16);
    expect(planned.staying.find((s) => s.gridId === 'grid:1')?.reason).toBe('already covers its cells');
  });

  it('a zero-coverage plan is not applyable without relay-only', () => {
    const base = { members: 18, planet: true, hull: true, overLimit: false, planning: false, planError: null, manualAltitudeM: null, radioRangeM: 50_000, surfaceRadiusM: 59_400 };
    const blocked = applyGuard({ ...base, coveragePct: 0, relayOnly: false });
    expect(blocked.disabled).toBe(true);
    expect(blocked.reason).toMatch(/Coverage is 0.0%/);
    expect(applyGuard({ ...base, coveragePct: 0, relayOnly: true }).disabled).toBe(false);
    expect(applyGuard({ ...base, coveragePct: 42, relayOnly: false }).disabled).toBe(false);
  });

  it('a manual altitude above the radio ground reach is blocked with a reason', () => {
    const guard = applyGuard({
      members: 4,
      planet: true,
      hull: true,
      overLimit: false,
      planning: false,
      planError: null,
      coveragePct: 90,
      manualAltitudeM: 60_000,
      radioRangeM: 50_000,
      surfaceRadiusM: 59_400,
      relayOnly: false,
    });
    expect(guard.disabled).toBe(true);
    expect(guard.reason).toMatch(/above the 50 km radio's ground reach/);
    expect(applyGuard({ members: 4, planet: true, hull: true, overLimit: false, planning: false, planError: null, coveragePct: 90, manualAltitudeM: 60_000, radioRangeM: 50_000, surfaceRadiusM: 59_400, relayOnly: true }).disabled).toBe(false);
  });
});

describe('labels and readouts (T51.3, T53)', () => {
  it('Auto count rendering names the solver number', () => {
    expect(countLabel(null, 13)).toBe('Auto (13)');
    expect(countLabel(18, 13)).toBe('18');
  });

  it('every coverage number is SIMULATED and terrain-unavailable is stated', () => {
    const coverage = coverageNumber(91.4, 'unavailable', 'no terrain tiles', ['SIMULATED']);
    expect(formatCoverage(coverage)).toBe('91.4% · SIMULATED · terrain unavailable (no terrain tiles)');
    expect(formatCoverage(coverageNumber(80, 'corrected', null, ['SIMULATED']))).toBe('80.0% · SIMULATED · terrain-corrected');
    expect(coverageNumber(null, 'none', null, [])).toBeNull();
  });

  it('renders each alternative on one line with ships/H2/MW/coverage', () => {
    const lines = alternativeLines([
      { id: 'all-low', label: 'all-low', ships: 32, h2L: 12.5, batteryMWh: 1, antennaMW: 3.2, coveragePct: 96, terrain: 'corrected', altitudeRangeM: [3_000, 3_000], cost: 32, note: '' },
      { id: 'best-mixed', label: 'best-mixed (cheapest)', ships: 13, h2L: 40, batteryMWh: 2, antennaMW: 2.1, coveragePct: 97.1, terrain: 'unavailable', altitudeRangeM: [5_000, 18_500], cost: 20, note: '' },
    ]);
    expect(lines[0]).toBe('all-low: 32 ships, 96.0% cover, 12.5 L H2, 3.20 MW, 3.0 km · SIMULATED');
    expect(lines[1]).toContain('5.0–18.5 km');
    expect(lines[1]).toContain('terrain unavailable');
    expect(slotLines(null)).toEqual([]);
  });

  it('previews the proposed layout k-aware: amber at k=2 where one relay hears it', () => {
    const centers = [
      { latDeg: 0, lonDeg: 0 },
      { latDeg: 30, lonDeg: 0 },
    ];
    const cells = centers.map((cell) => ({ ...cell, coveredBy: 0 }));
    const one = previewCoverage(cells, [{ id: 'c1', position: { x: 1_000_000 + 59_400 + 18_500, y: 0, z: 0 }, altitudeM: 18_500, radioRangeM: 50_000 }], planet.center, 59_400);
    expect(one.pct).toBe(100);
    expect(one.pctK2).toBe(0);
    expect(one.cells[0]!.coveredBy).toBe(1);
    const two = previewCoverage(cells, [
      { id: 'c1', position: { x: 1_000_000 + 59_400 + 18_500, y: 0, z: 0 }, altitudeM: 18_500, radioRangeM: 50_000 },
      { id: 'c2', position: { x: 1_000_000 + 59_400 + 18_500, y: 0, z: 0 }, altitudeM: 18_500, radioRangeM: 50_000 },
    ], planet.center, 59_400);
    expect(two.cells[0]!.coveredBy).toBe(2);
    expect(two.pctK2).toBe(100);
  });
});

describe('ConstellationPanel render', () => {
  const memberIds = ['grid:1', 'grid:2', 'grid:3'];
  const state = {
    planets: [{ id: 'EarthLike', name: 'EarthLike', center: planet.center, surfaceRadiusM: 59_400, maxHillRadiusM: 67_200 }],
    nodes: memberIds.map((id) => ({
      id,
      name: id,
      position: { x: 1_000_000 + 59_400 + 5_000, y: 0, z: 0 },
      capability: { radioRadiusM: 50_000 },
    })),
    executions: { executions: [] },
  } as unknown as DemoState;
  const group = { id: 'g1', name: 'Group 1', color: '#fff', members: memberIds } as unknown as ShipGroup;

  it('shows Auto (N) from countNeeded and an Apply label of the planned count', () => {
    const option = {
      id: 'o1',
      pattern: 'cover-planet',
      hullId: 'tagged:grid:1',
      count: 2,
      countNeeded: 13,
      countUsed: 2,
      altitudeM: 15_000,
      positions: [
        { id: 's1', x: 1_000_000 + 59_400 + 15_000, y: 0, z: 0 },
        { id: 's2', x: 1_000_000, y: 59_400 + 15_000, z: 0 },
      ],
      links: [],
      spofs: [],
      redundancyAchieved: 1,
      coveragePct: 12.5,
      maxGapM: 1,
      gravityAtSlotMps2: 1,
      feasible: true,
      reasons: [],
      summary: '',
      labels: ['SIMULATED'],
      terrain: 'unavailable',
    } as unknown as DesignerOption;
    // A tiny harness renders the view-model helpers the panel binds to.
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement('span', { 'data-testid': 'count' }, countLabel(null, option.countNeeded ?? null)),
        createElement('span', { 'data-testid': 'apply-label' }, `Apply to ${decidePlannedShips({ members: memberIds.map((id) => ({ id })), optimise: null, option }).count} ships`),
        createElement('span', { 'data-testid': 'coverage' }, formatCoverage(coverageNumber(option.coveragePct, option.terrain, null, option.labels))),
      ),
    );
    expect(html).toContain('Auto (13)');
    expect(html).toContain('Apply to 2 ships');
    expect(html).toContain('SIMULATED · terrain unavailable');
    // Guard proof without a browser: 0 % coverage blocks Apply with a reason.
    const guard = applyGuard({ members: 3, planet: true, hull: true, overLimit: false, planning: false, planError: null, coveragePct: 0, manualAltitudeM: null, radioRangeM: 50_000, surfaceRadiusM: 59_400, relayOnly: false });
    expect(guard.disabled).toBe(true);
    expect(guard.reason).toContain('relay-only');
    expect(typeof ConstellationPanel).toBe('function');
  });
});
