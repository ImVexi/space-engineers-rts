import { describe, expect, it } from 'vitest';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { planetGravity, gravityFreeAltitudeM } from '../src/demo/designer/gravity.js';
import {
  buildDesignerPlan,
  classifyHull,
  prefabHulls,
  taggedHull,
  assignHullsToSlots,
  requirementsFromLinks,
  type DesignerHull,
} from '../src/demo/designer/index.js';
import { planRadioChain, planLayered } from '../src/planner/relay.js';
import { planPlanetCoverage, coverageGridFromNodes } from '../src/planner/planetCoverage.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const planets = PLANET_CATALOG;
const prefabs = prefabHulls();
const ZERO_G = Math.ceil(gravityFreeAltitudeM(planetGravity(earth)));
const BASE = { planet: 'EarthLike', altitudeM: 1_800 };

function synthetic(partial: Partial<DesignerHull> & { id: string; name: string }): DesignerHull {
  return {
    source: 'prefab',
    radioRangeM: 50_000,
    laserCount: 0,
    thrust: { atmo: 0, ion: 0, h2: 0 },
    canGroundLaunch: true,
    twrAtSurface: 2,
    notes: 'synthetic test hull',
    gridSize: 'large',
    massKg: 20_000,
    power: null,
    tanks: null,
    enduranceSource: 'unavailable',
    ...partial,
  };
}

const ATMO_HULL = synthetic({
  id: 'test:atmo',
  name: 'Test Atmo Relay',
  thrust: { atmo: 2_000_000, ion: 0, h2: 0 },
  massKg: 20_000,
});
const ION_HULL = synthetic({
  id: 'test:ion',
  name: 'Test Ion Relay',
  thrust: { atmo: 0, ion: 5_000_000, h2: 0 },
  massKg: 40_000,
  gridSize: 'small',
});
const H2_HULL = synthetic({
  id: 'test:h2',
  name: 'Test H2 Relay',
  thrust: { atmo: 0, ion: 0, h2: 3_000_000 },
});
const LASER_HUB = synthetic({
  id: 'test:hub',
  name: 'Test Laser Hub',
  thrust: { atmo: 0, ion: 4_000_000, h2: 0 },
  laserCount: 3,
  laserRangeM: 100_000,
  radioRangeM: 30_000,
});
const SHORT_RADIO = synthetic({
  id: 'test:short',
  name: 'Test Short Radio',
  radioRangeM: 10_000,
  thrust: { atmo: 2_000_000, ion: 0, h2: 0 },
});

describe('hull classification v2 (T22)', () => {
  it('classifies the measured Eradicator as an ion space relay', () => {
    const era = prefabs.find((h) => h.id === 'prefab:Eradicator_mk.1')!;
    const cap = classifyHull(era);
    expect(cap.tierEligibility).toEqual({ atmo: false, h2: false, ion: true });
    expect(cap.ceilings.ionFloorM).toBe(45_000);
    expect(cap.roles).toContain('radio-relay');
    expect(cap.radioRangeM).toBe(50_000);
    expect(cap.flightMode).toBe('autopilot');
  });

  it("marks Data's SAT-R-0001 as an atmo, lift-only, level-flight relay", () => {
    const sat = taggedHull({
      gridId: 'grid:87929829394037977',
      name: 'SAT-R-0001',
      radioRangeM: 50_000,
      laserCount: 0,
      thrust: { atmo: 1_500_000, ion: 0, h2: 0 },
      massKg: 37_650,
      gridSize: 'large',
      canGroundLaunch: true,
    });
    const cap = classifyHull(sat);
    expect(cap.tierEligibility.atmo).toBe(true);
    expect(cap.ceilings.atmoM).toBe(10_000);
    expect(cap.carriedAboveM).toBe(10_000);
    expect(cap.flightMode).toBe('level');
    expect(cap.liftDominant).toBe(true);
    expect(cap.tierLabels.join(' ')).toContain('station');
  });

  it('derives lift-dominant flight mode from a per-direction thrust envelope', () => {
    const lift = synthetic({
      id: 'test:lift',
      name: 'Lift Only',
      thrustPerDirection: { upN: 1_000_000, downN: 0, fwdN: 4_000, backN: 2_000, leftN: 1_000, rightN: 1_000 },
    });
    expect(classifyHull(lift).flightMode).toBe('level');
    const balanced = synthetic({
      id: 'test:balanced',
      name: 'Balanced',
      thrustPerDirection: { upN: 1_000_000, downN: 900_000, fwdN: 800_000, backN: 800_000, leftN: 800_000, rightN: 800_000 },
    });
    expect(classifyHull(balanced).flightMode).toBe('autopilot');
  });

  it('assigns laser roles by port count and converter by radio + one laser', () => {
    expect(classifyHull(LASER_HUB).roles).toContain('laser-hub');
    const leaf = synthetic({ id: 'test:leaf', name: 'Leaf', laserCount: 1, laserRangeM: 100_000, radioRangeM: 20_000 });
    const leafCap = classifyHull(leaf);
    expect(leafCap.roles).toContain('laser-leaf');
    expect(leafCap.roles).toContain('converter');
    const relay = synthetic({ id: 'test:l2', name: 'L2', laserCount: 2 });
    expect(classifyHull(relay).roles).toContain('laser-relay');
    const rover = synthetic({ id: 'test:rover', name: 'Rover', laserCount: 1, laserRangeM: 100_000, radioRangeM: 0, thrust: { atmo: 0, ion: 0, h2: 0 } });
    expect(classifyHull(rover).roles).toContain('ground-laser-rover');
  });
});

describe('radio-chain geometry (T16)', () => {
  it('reaches zero-g in one free-hold hop with a 50 km radio from BASE-01', () => {
    const plan = planRadioChain(earth, { radioRangeM: 50_000, zeroGAltitudeM: ZERO_G, baseAltitudeM: 1_800, rangeMargin: 0.9 });
    expect(plan.count).toBe(1);
    expect(plan.firstHopM).not.toBeNull();
    expect(plan.firstHopM!).toBeLessThanOrEqual(plan.hopLimitM);
    expect(plan.baseLinked).toBe(true);
    expect(plan.reachesZeroG).toBe(true);
    expect(plan.nodes[0]!.altitudeM).toBeGreaterThanOrEqual(ZERO_G - 0.5);
    expect(plan.nodes[0]!.tier).toBe('zero-g');
    expect(plan.nodes[0]!.stationPreferred).toBe(false);
    // 1.8 km + 41.9 km radial gap = the documented 45-50 km AGL trade.
    expect(plan.firstHopM!).toBeGreaterThan(40_000);
    expect(plan.firstHopM!).toBeLessThan(45_000);
  });

  it('climbs in hops of at most 0.9 x radio with a short antenna', () => {
    const plan = planRadioChain(earth, { radioRangeM: 20_000, zeroGAltitudeM: ZERO_G, baseAltitudeM: 1_800, rangeMargin: 0.9 });
    expect(plan.hopLimitM).toBeCloseTo(18_000, 0);
    expect(plan.count).toBeGreaterThan(1);
    for (const hop of plan.hops) expect(hop.lengthM).toBeLessThanOrEqual(18_000 + 0.5);
    expect(plan.firstHopM!).toBeLessThanOrEqual(18_000 + 0.5);
    const apex = plan.nodes[plan.nodes.length - 1]!;
    expect(apex.altitudeM).toBeGreaterThanOrEqual(ZERO_G - 0.5);
    // every node is above the base and on the same radial
    for (const node of plan.nodes) {
      expect(node.altitudeM).toBeGreaterThan(1_800);
      expect(node.latDeg).toBeCloseTo(plan.nodes[0]!.latDeg, 3);
    }
  });

  it('reports a broken base link when keepFirstHopOnBase is turned off', () => {
    const plan = planRadioChain(earth, {
      radioRangeM: 50_000,
      zeroGAltitudeM: ZERO_G,
      baseAltitudeM: 1_800,
      rangeMargin: 0.9,
      keepFirstHopOnBase: false,
    });
    expect(plan.baseLinked).toBe(false);
    expect(plan.firstHopM!).toBeGreaterThan(plan.hopLimitM);
    expect(plan.reasons.join(' ')).toContain('beyond the hop limit');
  });

  it('extends at zero-g with hops inside the limit', () => {
    const plan = planRadioChain(earth, {
      radioRangeM: 50_000,
      zeroGAltitudeM: ZERO_G,
      baseAltitudeM: 1_800,
      rangeMargin: 0.9,
      reachM: 150_000,
    });
    expect(plan.count).toBeGreaterThan(3);
    for (const hop of plan.hops) expect(hop.lengthM).toBeLessThanOrEqual(plan.hopLimitM + 0.5);
    for (const node of plan.nodes.slice(1)) expect(node.tier).toBe('zero-g');
  });
});

describe('layered atmo/station/zero-g network (T17)', () => {
  const plan = planLayered(earth, {
    radioRangeM: 50_000,
    zeroGAltitudeM: ZERO_G,
    atmoCeilingM: 10_000,
    baseAltitudeM: 1_800,
    maxHopM: 45_000,
    rangeMargin: 0.9,
    atmoCount: 3,
    h2Count: 1,
    zeroGCount: 4,
    gravityAtAltitudeMps2: (altitude) => 0,
  });

  it('places each tier inside its measured band', () => {
    const atmo = plan.tiers.find((t) => t.id === 'atmo')!;
    const h2 = plan.tiers.find((t) => t.id === 'h2')!;
    const zero = plan.tiers.find((t) => t.id === 'zero-g')!;
    expect(atmo.altitudeM).toBeLessThanOrEqual(10_000);
    expect(atmo.altitudeM).toBeGreaterThanOrEqual(6_000);
    expect(h2.altitudeM).toBeGreaterThanOrEqual(10_000);
    expect(h2.altitudeM).toBeLessThanOrEqual(20_000);
    expect(zero.altitudeM).toBeGreaterThanOrEqual(ZERO_G);
    expect(zero.altitudeM).toBeGreaterThanOrEqual(45_000);
    expect(atmo.count + h2.count + zero.count).toBe(plan.count);
    for (const tier of plan.tiers) expect(tier.stationFree).toBe(true);
  });

  it('keeps every hop inside 0.9 x radio and every node attached to the base', () => {
    expect(plan.connected).toBe(true);
    for (const hop of plan.hops) expect(hop.lengthM).toBeLessThanOrEqual(plan.hopLimitM + 0.5);
    const attached = new Set<string>();
    const queue = ['base'];
    const adjacency = new Map<string, Set<string>>();
    for (const id of ['base', ...plan.nodes.map((n) => n.id)]) adjacency.set(id, new Set());
    for (const link of plan.links) {
      adjacency.get(link.a)?.add(link.b);
      adjacency.get(link.b)?.add(link.a);
    }
    attached.add('base');
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (attached.has(next)) continue;
        attached.add(next);
        queue.push(next);
      }
    }
    for (const node of plan.nodes) expect(attached.has(node.id)).toBe(true);
    expect(plan.maxGapM).toBeLessThanOrEqual(plan.hopLimitM);
  });

  it('warns that in-gravity tiers need stationing', () => {
    expect(plan.warnings.join(' ')).toMatch(/hover costs fuel unless stationed/);
  });
});

describe('whole-planet coverage (T28)', () => {
  const specs = [
    { id: 'station' as const, altitudeM: 15_000, radioRangeM: 50_000 },
    { id: 'atmo' as const, altitudeM: 8_000, radioRangeM: 50_000 },
    { id: 'zero-g' as const, altitudeM: 45_000, radioRangeM: 50_000 },
  ];
  const plan = planPlanetCoverage(earth, specs, { k: 1, cellDeg: 20, rangeMargin: 0.9, maxHopM: 45_000 });

  it('covers every coarse grid cell with a minimum-ish station set', () => {
    expect(plan.cells.length).toBe(18 * 9);
    expect(plan.recommendedTier).toBe('station');
    const station = plan.tiers.find((t) => t.id === 'station')!;
    expect(station.coveragePct).toBe(100);
    expect(station.coveredCells).toBe(station.totalCells);
    expect(station.count).toBeGreaterThanOrEqual(6);
    // T28: a 15 km station layer needs ~10-14 practical nodes, not 26+.
    expect(station.count).toBeLessThanOrEqual(20);
    expect(station.footprintRadiusM).toBeGreaterThan(40_000);
    expect(station.flatFootprintRadiusM).toBeGreaterThan(station.footprintRadiusM - 8_000);
    expect(station.connectedToBase).toBe(true);
    for (const tier of plan.tiers) expect(tier.nodes.length).toBe(tier.count + tier.bridgeCount);
  });

  it('builds a heatmap grid whose counts agree with the per-tier counts', () => {
    const grid = plan.cells;
    const sum = grid.reduce((acc, cell) => acc + cell.coveredBy, 0);
    const tierSum = plan.tiers.reduce((acc, tier) => {
      const byTier = grid.reduce((inner, cell) => inner + (cell.byTier[tier.id] ?? 0), 0);
      expect(byTier).toBeGreaterThanOrEqual(tier.coveredCells * 1);
      return acc + byTier;
    }, 0);
    expect(sum).toBe(tierSum);
    expect(plan.uncoveredCells + grid.filter((cell) => cell.coveredBy >= 1).length).toBe(grid.length);
  });

  it('requires two independent nodes per cell at k=2', () => {
    const k2 = planPlanetCoverage(earth, [specs[0]!], { k: 2, cellDeg: 20, rangeMargin: 0.9, maxHopM: 45_000 });
    const tier = k2.tiers[0]!;
    expect(tier.coveragePct).toBe(100);
    for (const cell of k2.cells) expect(cell.coveredBy).toBeGreaterThanOrEqual(2);
    expect(tier.count).toBeGreaterThanOrEqual(2);
    // k=2 needs at least as many nodes as k=1.
    const k1 = planPlanetCoverage(earth, [specs[0]!], { k: 1, cellDeg: 20, rangeMargin: 0.9, maxHopM: 45_000 });
    expect(tier.count).toBeGreaterThanOrEqual(k1.tiers[0]!.count);
  });

  it('falls back to rover spots when a tier has an empty footprint', () => {
    const empty = planPlanetCoverage(earth, [{ id: 'zero-g', altitudeM: 70_000, radioRangeM: 50_000 }], {
      k: 1,
      cellDeg: 30,
      roverFallback: true,
    });
    expect(empty.tiers[0]!.count).toBe(0);
    expect(empty.tiers[0]!.coveragePct).toBe(0);
    expect(empty.rovers.length).toBeGreaterThan(0);
    expect(empty.rovers[0]!.reason).toContain('no sky node reaches');
    expect(empty.uncoveredPct).toBe(100);
  });

  it('is deterministic', () => {
    const a = planPlanetCoverage(earth, specs, { k: 1, cellDeg: 30, now: 1 });
    const b = planPlanetCoverage(earth, specs, { k: 1, cellDeg: 30, now: 1 });
    expect(a).toEqual(b);
  });

  it('builds a grid for an explicit node set (radio-chain view)', () => {
    const grid = coverageGridFromNodes(earth, [{ id: 'n1', position: { x: 0, y: 61200, z: 0 }, altitudeM: 1_800 }], 50_000, {
      cellDeg: 30,
    });
    expect(grid.cells.length).toBe(12 * 6);
    expect(grid.coveredCells).toBeGreaterThan(0);
    expect(grid.coveredCells).toBeLessThan(grid.totalCells);
  });
});

describe('heterogeneous assignment (T22)', () => {
  const slots = [
    {
      slotId: 'low',
      position: { x: 0, y: 61_000, z: 0 },
      altitudeM: 8_000,
      gravityMps2: 9.6,
      tier: 'atmo' as const,
      requiredRadioM: 40_000,
      requiredLaserPorts: 0,
      laserLinkM: null,
      stationAllowed: true,
    },
    {
      slotId: 'high',
      position: { x: 0, y: 103_400, z: 0 },
      altitudeM: 45_000,
      gravityMps2: 0,
      tier: 'zero-g' as const,
      requiredRadioM: 44_000,
      requiredLaserPorts: 0,
      laserLinkM: null,
      stationAllowed: true,
    },
  ];

  it('assigns the atmo slot to an atmo hull and the zero-g slot to an ion hull', () => {
    const result = assignHullsToSlots([ATMO_HULL, ION_HULL], slots, { rangeMargin: 0.9 });
    expect(result.unfilled).toHaveLength(0);
    const low = result.assignments.find((a) => a.slotId === 'low')!;
    const high = result.assignments.find((a) => a.slotId === 'high')!;
    expect(low.hullId).toBe(ATMO_HULL.id);
    expect(low.flightMode).toBe('autopilot');
    expect(high.hullId).toBe(ION_HULL.id);
    expect(high.tier).toBe('zero-g');
    expect(low.why).toContain('needs 40.0 km');
    expect(low.why).toContain('station hold is free');
  });

  it('refuses a slot whose required radio exceeds every hull', () => {
    const long = [{ ...slots[0]!, slotId: 'long', requiredRadioM: 60_000 }];
    const result = assignHullsToSlots([ATMO_HULL, SHORT_RADIO], long, { rangeMargin: 0.9 });
    expect(result.assignments).toHaveLength(0);
    expect(result.unfilled[0]!.code).toBe('missing_long_range_radio');
    expect(result.unfilled[0]!.gap).toContain('60.0 km');
    expect(result.missingHullTypes[0]!.need).toContain('atmo relay');
  });

  it('honours laser ports and laser range', () => {
    const laserSlot = [
      {
        slotId: 'laser',
        position: { x: 0, y: 70_000, z: 0 },
        altitudeM: 10_000,
        gravityMps2: 9,
        tier: 'atmo' as const,
        requiredRadioM: 0,
        requiredLaserPorts: 2,
        laserLinkM: 80_000,
        stationAllowed: true,
      },
    ];
    const missing = assignHullsToSlots([ATMO_HULL], laserSlot, { rangeMargin: 0.9 });
    expect(missing.unfilled[0]!.code).toBe('missing_laser_ports');
    const ok = assignHullsToSlots([LASER_HUB], laserSlot, { rangeMargin: 0.9 });
    expect(ok.unfilled).toHaveLength(0);
    expect(ok.assignments[0]!.role).toBe('laser-hub');
    const blocked = assignHullsToSlots([LASER_HUB], [{ ...laserSlot[0]!, losClear: false }], { rangeMargin: 0.9 });
    expect(blocked.assignments).toHaveLength(0);
    expect(blocked.unfilled[0]!.code).toBe('laser_los_blocked');
  });

  it('prefers an existing ship and caps new builds', () => {
    const existing = synthetic({
      id: 'tagged:grid:1',
      name: 'Owner Relay',
      source: 'owner-tagged',
      massKg: 500_000,
      thrust: { atmo: 5_000_000, ion: 0, h2: 0 },
      position: { x: 0, y: 62_000, z: 0 },
    });
    const result = assignHullsToSlots([existing, ATMO_HULL], [slots[0]!], {
      rangeMargin: 0.9,
      positions: { [existing.id]: existing.position! },
    });
    const low = result.assignments.find((a) => a.slotId === 'low')!;
    expect(low.reused).toBe(true);
    expect(low.hullId).toBe(existing.id);
    expect(low.why).toContain('reuses an existing ship');
    const capped = assignHullsToSlots([ATMO_HULL, ION_HULL], slots, { rangeMargin: 0.9, maxNewBuilds: 1 });
    expect(capped.assignments).toHaveLength(1);
    expect(capped.unfilled[0]!.code).toBe('new_build_cap');
  });

  it('records that the T30 power budget was skipped when no module supplies it', () => {
    const result = assignHullsToSlots([ATMO_HULL], slots, { rangeMargin: 0.9 });
    expect(result.power.checked).toBe(false);
    expect(result.power.skipped).toBe(true);
    expect(result.power.note).toContain('skipped');
  });

  it('applies a power budget when one is supplied', () => {
    const result = assignHullsToSlots([ATMO_HULL], slots, {
      rangeMargin: 0.9,
      powerCheck: ({ slot }) => (slot.slotId === 'high' ? { ok: false, reason: 'short at night by 2.1 MWh' } : { ok: true, reason: 'ok' }),
    });
    // The high slot cannot use the atmo hull anyway; the low slot must pass.
    expect(result.assignments.map((a) => a.slotId)).toEqual(['low']);
    expect(result.unfilled.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic', () => {
    const a = assignHullsToSlots([ATMO_HULL, ION_HULL, H2_HULL], slots, { rangeMargin: 0.9 });
    const b = assignHullsToSlots([ATMO_HULL, ION_HULL, H2_HULL], slots, { rangeMargin: 0.9 });
    expect(a).toEqual(b);
  });

  it('derives per-slot radio/laser requirements from the link graph', () => {
    const reqs = requirementsFromLinks({
      nodes: [
        { id: 'a', position: { x: 0, y: 0, z: 0 }, altitudeM: 8_000 },
        { id: 'b', position: { x: 10, y: 0, z: 0 }, altitudeM: 45_000 },
      ],
      links: [
        { a: 'base', b: 'a', lengthM: 30_000, kind: 'radio' },
        { a: 'a', b: 'b', lengthM: 12_000, kind: 'laser' },
      ],
      zeroGAltitudeM: ZERO_G,
      baseId: 'base',
    });
    expect(reqs[0]!.requiredRadioM).toBe(30_000);
    expect(reqs[0]!.requiredLaserPorts).toBe(1);
    expect(reqs[1]!.tier).toBe('zero-g');
  });
});

describe('GET /api/demo/designer/coverage', () => {
  it('returns the heatmap grid for cover-planet without a mission', async () => {
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
    try {
      const { designerRoutesFor } = await import('../src/demo/designer/routes.js');
      const deps = {
        config: { demo: true } as never,
        store: {} as never,
        hub: { isConnected: () => false } as never,
        stateHub: { broadcast: () => undefined } as never,
        clock: () => 1_800_000_000_000,
      } as never;
      const route = designerRoutesFor(deps).find((candidate) => candidate.method === 'GET' && candidate.pattern.test('/api/demo/designer/coverage'))!;
      expect(route).toBeTruthy();
      let status = 0;
      let body = '';
      const res = {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload: string) => {
          body = payload;
        },
      };
      await route.handler({
        req: {} as never,
        res: res as never,
        params: [],
        url: new URL('http://x/api/demo/designer/coverage?planet=EarthLike&mode=cover-planet&k=1&cellDeg=30'),
      });
      expect(status).toBe(200);
      const parsed = JSON.parse(body) as {
        mode: string;
        cells: unknown[];
        tiers: { id: string; count: number }[];
        recommendedTier: string;
        labels: string[];
      };
      expect(parsed.mode).toBe('cover-planet');
      expect(parsed.cells).toHaveLength(12 * 6);
      expect(parsed.recommendedTier).toBe('station');
      expect(parsed.tiers.map((t) => t.id)).toEqual(['station', 'atmo', 'zero-g']);
      expect(parsed.labels).toContain('SIMULATED');
    } finally {
      delete process.env.RTS_DEMO;
      delete process.env.RTS_ENV;
      delete process.env.RTS_TEST_SERVER_MARKER;
    }
  });
});

describe('plan modes wired into buildDesignerPlan', () => {
  const hulls = [...prefabs];
  const era = prefabs.find((h) => h.id === 'prefab:Eradicator_mk.1')!;

  it('returns a feasible radio-chain option from BASE-01 to zero-g', () => {
    const plan = buildDesignerPlan(
      { mode: 'radio-chain', planet: 'EarthLike', base: BASE, pattern: 'auto', hullId: era.id, rangeMargin: 0.9, redundancy: 1 },
      hulls,
      planets,
      1_800_000_000_000,
    );
    const option = plan.options[0]!;
    expect(plan.mode).toBe('radio-chain');
    expect(option.mode).toBe('radio-chain');
    expect(option.feasible).toBe(true);
    expect(option.count).toBe(1);
    expect(option.count).toBe(option.positions.length);
    expect(option.assignment).toBeTruthy();
    expect(option.assignment!.unfilled).toHaveLength(0);
    expect(option.summary).toContain('Radio relay chain (no lasers)');
    expect(option.labels).toContain('SIMULATED');
    expect(option.gravityAtSlotMps2).toBe(0);
    expect(option.endurance.available).toBe(true);
  });

  it('returns the three-tier layered network with counts per tier', () => {
    const plan = buildDesignerPlan(
      { mode: 'layered', planet: 'EarthLike', base: BASE, pattern: 'auto', hullId: era.id, rangeMargin: 0.9, redundancy: 1 },
      hulls,
      planets,
      1_800_000_000_000,
    );
    const option = plan.options[0]!;
    expect(option.feasible).toBe(true);
    expect(option.tiers).toHaveLength(3);
    expect(option.tiers!.map((t) => t.id)).toEqual(['atmo', 'h2', 'zero-g']);
    expect(option.count).toBe(8);
    expect(option.summary).toContain('Layered network');
    expect(option.maxGapM).toBeLessThanOrEqual(45_000);
  });

  it('returns a cover-planet heatmap and a recommended station layer', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'cover-planet',
        planet: 'EarthLike',
        base: BASE,
        pattern: 'auto',
        hullId: era.id,
        rangeMargin: 0.9,
        redundancy: 1,
        k: 1,
        cellDeg: 20,
      },
      hulls,
      planets,
      1_800_000_000_000,
    );
    const option = plan.options[0]!;
    expect(option.coverage).toBeTruthy();
    expect(option.coverage!.cells.length).toBe(18 * 9);
    expect(option.coverage!.recommendedTier).toBe('station');
    // Terrain-corrected footprints leave a couple of polar/ridge cells dark at
    // cellDeg 20; the number has to be honest and small, and every dark cell has
    // to carry a reason rather than vanish from the count.
    expect(option.coverage!.uncoveredPct).toBeLessThanOrEqual(5);
    expect(option.coverage!.tiers.map((t) => t.id)).toEqual(['station', 'atmo', 'zero-g']);
    expect(option.feasible).toBe(true);
    expect(option.summary).toContain('Cover EarthLike');
    // T53: the plan itself comes from the coverage-first solver, so the ship
    // count is its own (auto) count, not the legacy per-tier number.
    expect(option.count).toBe(option.countUsed);
    expect(option.countNeeded).toBe(option.countUsed);
    expect(option.altitudeMode).toBe('cheapest');
    expect(option.alternatives?.map((entry) => entry.id)).toEqual(['all-low', 'all-max-reach', 'best-mixed']);
  });
});
