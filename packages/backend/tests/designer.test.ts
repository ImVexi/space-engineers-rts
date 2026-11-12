import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { makeConfig } from './helpers.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import {
  buildDesignerPlan,
  gravityAtAltitude,
  gravityFreeAltitudeM,
  planetGravity,
  positionGraph,
  ringPositions,
  inclinedRingPositions,
  shellPositions,
  slotRadiusM,
  twoNodeDisjointPaths,
  prefabHulls,
  taggedHull,
  assignGridsToSlots,
  preflightGridLaunch,
  readDesignerSettings,
  writeDesignerSettings,
} from '../src/demo/designer/index.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const moon = PLANET_CATALOG.find((p) => p.name === 'Moon')!;
const planets = PLANET_CATALOG;
const hulls = prefabHulls();
const ERADICATOR = 'prefab:Eradicator_mk.1';
const NOW = 1_800_000_000_000;

afterEach(() => {
  delete process.env.RTS_DEMO;
  delete process.env.RTS_ENV;
  delete process.env.RTS_TEST_SERVER_MARKER;
});

describe('SE gravity model', () => {
  it('matches the measured EarthLike 40 km probe and cuts off above ~43.7 km', () => {
    const g = planetGravity(earth);
    expect(gravityAtAltitude(g, 0)).toBeCloseTo(9.81, 2);
    // Measured 0.665 m/s2 (one vector axis) at 40 km AGL.
    expect(gravityAtAltitude(g, 40_000)).toBeGreaterThan(0.6);
    expect(gravityAtAltitude(g, 40_000)).toBeLessThan(0.7);
    expect(gravityAtAltitude(g, 60_000)).toBe(0);
    expect(Math.round(gravityFreeAltitudeM(g))).toBe(43_693);
    expect(Math.round(gravityFreeAltitudeM(g))).toBeLessThan(60_000);
  });

  it('uses the planet generator values, not a guessed falloff', () => {
    const g = planetGravity(moon);
    expect(g.maxRadiusM).toBe(moon.maxHillRadiusM);
    expect(g.falloff).toBe(7);
    expect(g.intensity).toBe(0.25);
  });
});

describe('constellation patterns', () => {
  it('places a ring at the requested altitude with spacing inside the range margin', () => {
    const altitude = 60_000;
    const count = 17;
    const positions = ringPositions(earth, altitude, count);
    expect(positions).toHaveLength(count);
    for (const p of positions) {
      const r = Math.hypot(p.x - earth.center.x, p.y - earth.center.y, p.z - earth.center.z);
      expect(r).toBeCloseTo(slotRadiusM(earth, altitude), 3);
      // No planet intersection: every slot is outside the hill sphere.
      expect(r).toBeGreaterThan(earth.maxHillRadiusM);
      expect(gravityAtAltitude(planetGravity(earth), altitude)).toBe(0);
    }
    const graph = positionGraph(positions.map((p, i) => ({ id: `s${i}`, ...p })), 50_000 * 0.9);
    expect(graph.connected).toBe(true);
    expect(graph.maxGapM).toBeLessThanOrEqual(50_000 * 0.9);
    expect(graph.articulationPoints).toHaveLength(0);
    expect(graph.lowDegree).toHaveLength(0);
  });

  it('grows count from spacing so consecutive slots stay within the margin', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 60_000,
        count: 6,
        spacingM: 40_000,
        hullId: ERADICATOR,
        rangeMargin: 0.9,
        redundancy: 2,
      },
      hulls,
      planets,
      NOW,
    );
    const ring = plan.options[0]!;
    expect(ring.pattern).toBe('ring');
    expect(ring.count).toBeGreaterThan(6);
    expect(ring.maxGapM).toBeLessThanOrEqual(45_000);
    expect(ring.redundancyAchieved).toBe(2);
    expect(ring.spofs).toHaveLength(0);
    expect(ring.feasible).toBe(true);
  });

  it('builds inclined rings and a Fibonacci shell at the requested altitude', () => {
    const inclined = inclinedRingPositions(earth, 80_000, 20, 55);
    expect(inclined).toHaveLength(20);
    for (const p of inclined) {
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(slotRadiusM(earth, 80_000), 3);
    }
    const shell = shellPositions(earth, 80_000, 25);
    expect(shell).toHaveLength(25);
    for (const p of shell) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(slotRadiusM(earth, 80_000), 3);
  });

  it('returns up to 4 options, requested pattern first and cheapest alternatives next', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'shell',
        altitudeM: 80_000,
        count: 40,
        hullId: ERADICATOR,
        rangeMargin: 0.9,
        redundancy: 'no-spof',
      },
      hulls,
      planets,
      NOW,
    );
    expect(plan.options.length).toBeGreaterThan(1);
    expect(plan.options.length).toBeLessThanOrEqual(4);
    // Endurance preflight can make the requested pattern infeasible; feasible
    // options are always listed first, and the requested pattern is retained.
    expect(plan.options.some((o) => o.pattern === 'shell')).toBe(true);
    const firstInfeasible = plan.options.findIndex((o) => !o.feasible);
    const feasible = firstInfeasible === -1 ? plan.options : plan.options.slice(0, firstInfeasible);
    expect(feasible.length).toBeGreaterThan(0);
    const rest = feasible.slice(1).map((o) => o.count);
    expect([...rest].sort((a, b) => a - b)).toEqual(rest);
    if (firstInfeasible === -1) expect(plan.options[0]!.pattern).toBe('shell');
  });

  it('marks a hull without an antenna infeasible instead of inventing a range', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 60_000,
        count: 12,
        hullId: 'prefab:Escort TT-420',
        rangeMargin: 0.9,
        redundancy: 1,
      },
      hulls,
      planets,
      NOW,
    );
    expect(plan.options[0]!.feasible).toBe(false);
    expect(plan.options[0]!.reasons.join(' ')).toMatch(/no radio antenna/i);
  });
});

describe('redundancy', () => {
  it('k=2 constellation is 2-connected: every degree >= 2 and no articulation points', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'constellation',
        planet: 'EarthLike',
        pattern: 'ring',
        altitudeM: 60_000,
        count: 24,
        hullId: ERADICATOR,
        rangeMargin: 0.9,
        redundancy: 2,
      },
      hulls,
      planets,
      NOW,
    );
    const option = plan.options[0]!;
    expect(option.redundancyAchieved).toBe(2);
    expect(option.spofs).toEqual([]);
    const graph = positionGraph(option.positions, 45_000);
    expect(graph.lowDegree).toEqual([]);
    expect(graph.articulationPoints).toEqual([]);
  });

  it('connect k=2 finds two node-disjoint paths between the anchors', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'connect',
        a: { planet: 'EarthLike' },
        b: { planet: 'Moon' },
        pattern: 'chain',
        hullId: ERADICATOR,
        rangeMargin: 0.9,
        redundancy: 2,
      },
      hulls,
      planets,
      NOW,
    );
    const option = plan.options[0]!;
    expect(option.feasible).toBe(true);
    expect(option.redundancyAchieved).toBe(2);
    expect(option.spofs).toEqual([]);
    const graph = positionGraph(option.positions, 45_000);
    const from = option.positions[0]!.id;
    const to = option.positions[option.positions.length - 1]!.id;
    const disjoint = twoNodeDisjointPaths(graph.adjacency, from, to);
    expect(disjoint).not.toBeNull();
    const first = new Set(disjoint!.first.slice(1, -1));
    const second = new Set(disjoint!.second.slice(1, -1));
    for (const id of first) expect(second.has(id)).toBe(false);
  });

  it('connect k=1 reports its inevitable single-path SPOFs', () => {
    const plan = buildDesignerPlan(
      {
        mode: 'connect',
        a: { planet: 'EarthLike' },
        b: { planet: 'Moon' },
        pattern: 'chain',
        hullId: ERADICATOR,
        rangeMargin: 0.9,
        redundancy: 1,
      },
      hulls,
      planets,
      NOW,
    );
    const option = plan.options[0]!;
    expect(option.redundancyAchieved).toBe(1);
    expect(option.spofs.length).toBeGreaterThan(0);
    expect(option.feasible).toBe(true);
  });

  it('k=2 needs more drones than k=1 on EarthLike -> Moon', () => {
    const base = {
      mode: 'connect' as const,
      a: { planet: 'EarthLike' },
      b: { planet: 'Moon' },
      pattern: 'chain' as const,
      hullId: ERADICATOR,
      rangeMargin: 0.9,
    };
    const one = buildDesignerPlan({ ...base, redundancy: 1 }, hulls, planets, NOW);
    const two = buildDesignerPlan({ ...base, redundancy: 2 }, hulls, planets, NOW + 1);
    expect(two.options[0]!.count).toBeGreaterThan(one.options[0]!.count);
    expect(two.options[1]!.count).toBe(one.options[0]!.count);
    expect(two.options[1]!.redundancyAchieved).toBe(1);
  });
});

describe('designer settings', () => {
  function store(): Store {
    const db = openDb(':memory:', { memory: true });
    const s = new Store(db);
    const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
    s.ensureFlags(FEATURE_FLAGS, all as never);
    return s;
  }

  it('defaults to 0.95 / 5 and persists clamped values with an audit entry', () => {
    const s = store();
    expect(readDesignerSettings(s)).toEqual({ simSpeedMin: 0.95, maxActive: 5, launchReservePct: 15 });
    const next = writeDesignerSettings(s, { simSpeedMin: 0.7, maxActive: 99 }, 'tester', NOW);
    expect(next).toEqual({ simSpeedMin: 0.7, maxActive: 10, launchReservePct: 15 });
    expect(readDesignerSettings(s)).toEqual(next);
    const audit = s.listAudit(10).find((a) => a.action === 'designer_settings');
    expect(audit).toBeTruthy();
    expect((audit!.detail as { next: unknown }).next).toEqual(next);
    // Invalid values are ignored in favour of the current value.
    expect(writeDesignerSettings(s, { simSpeedMin: Number.NaN }, 'tester', NOW + 1).simSpeedMin).toBe(0.7);
  });
});

describe('executor cap reads the designer setting live', () => {
  it('scales a designer mission to maxActive and marks the rest skipped', () => {
    const config = makeConfig({ flags: { demo_execute: true } });
    const db = openDb(':memory:', { memory: true });
    const s = new Store(db);
    const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
    s.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true } as never);
    writeDesignerSettings(s, { maxActive: 2 }, 'test', NOW);
    const slots = [0, 1, 2, 3].map((i) => ({
      id: `slot-${i + 1}`,
      kind: 'print',
      params: { prefab: 'Eradicator_mk.1', hullId: ERADICATOR, position: { x: i * 10_000, y: 0, z: 120_000 }, role: 'slot' },
      done: false,
    }));
    const created = createMission(
      s,
      {
        type: 'build_deploy',
        priority: 70,
        desiredState: {
          shipSpec: 'designer-constellation',
          station: 'designer:constellation:ring:' + ERADICATOR,
          designer: true,
          planet: 'EarthLike',
          launch: 'orbital',
          qty: 4,
        },
        budget: { resources: {}, timeMin: 1, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [],
        plan: { steps: slots, notes: '' },
      } as never,
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) throw new Error(created.message);
    s.updateMission(created.mission.id, { status: 'approved' }, NOW);
    const executor = new DemoExecutor({
      store: s,
      hub: { send: () => false, isConnected: () => false, agentId: () => null } as never,
      config,
      clock: () => NOW,
      fixturePath: null,
    });
    executor.sync(NOW);
    const rows = db.prepare('SELECT state FROM demo_drones ORDER BY idx').all() as { state: string }[];
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'skipped')).toHaveLength(2);
  });
});

describe('designer route env lock', () => {
  it('registers no designer routes unless the demo env lock is satisfied', async () => {
    const { designerRoutesFor } = await import('../src/demo/designer/routes.js');
    const deps = { config: makeConfig(), store: null, hub: null, stateHub: null } as never;
    delete process.env.RTS_DEMO;
    expect(designerRoutesFor(deps)).toEqual([]);
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
    expect(designerRoutesFor(deps).length).toBeGreaterThan(0);
  });
});

describe('T10 existing drones -> planned slots', () => {
  const slot = (id: string, x: number, y: number, z: number) => ({ id, x, y, z });

  it('assigns each grid to the nearest free slot and reports distances', () => {
    const slots = [slot('s1', 0, 0, 0), slot('s2', 0, 10_000, 0), slot('s3', 0, 20_000, 0)];
    const grid = (gridId: string, y: number) => ({
      gridId,
      name: gridId,
      position: { x: 0, y, z: 0 },
    });
    const out = assignGridsToSlots([grid('grid:a', 19_000), grid('grid:b', 1_000)], slots);
    expect(out.map((a) => [a.gridId, a.slotId])).toEqual([
      ['grid:b', 's1'],
      ['grid:a', 's3'],
    ]);
    expect(out[0]!.distanceM).toBe(1_000);
    expect(out[1]!.distanceM).toBe(1_000);
    // The nearest pair wins even when that leaves the other far away.
    const greedy = assignGridsToSlots([grid('grid:c', 0), grid('grid:d', 10_500)], slots.slice(0, 2));
    expect(greedy.map((a) => a.slotId)).toEqual(['s1', 's2']);
  });

  it('refuses a grid with 0 % hydrogen and no ion bank, and does not refuse the rest', () => {
    const hull = taggedHull({
      gridId: 'grid:x',
      name: 'SAT-X',
      radioRangeM: 50_000,
      thrust: { atmo: 1_152_000, ion: 0, h2: 984_000 },
      massKg: 19_000,
      canGroundLaunch: true,
    });
    const slot = { x: 0, y: 0, z: earth.surfaceRadiusM + 60_000 };
    const gridPos = { x: 0, y: 0, z: earth.surfaceRadiusM + 2_000 };
    const dry = preflightGridLaunch({ hull, planet: earth, slot, gridPosition: gridPos, requiredReservePct: 15, liveFuelPct: 0 });
    expect(dry.status).toBe('refused');
    expect(dry.reason).toContain('0 % hydrogen');
    // Without the live fuel reading the same grid is unverified, not refused.
    const unknown = preflightGridLaunch({ hull, planet: earth, slot, gridPosition: gridPos, requiredReservePct: 15, liveFuelPct: null });
    expect(unknown.status).toBe('unverified');
    expect(unknown.canReachSlot).toBeNull();
  });

  it('seeds an in-place mission from useGridId and never registers the grid as debris', () => {
    const config = makeConfig({ flags: { demo_execute: true } });
    const db = openDb(':memory:', { memory: true });
    const s = new Store(db);
    const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
    s.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true } as never);
    writeDesignerSettings(s, { maxActive: 2 }, 'test', NOW);
    const steps = [
      { id: 'validate', kind: 'validate_spec', params: {}, done: false },
      ...[1, 2, 3].map((i) => ({
        id: `slot-${i}`,
        kind: 'print',
        params: {
          prefab: 'SAT-X',
          hullId: 'tagged:grid:x',
          position: { x: 0, y: 0, z: 60_000 + i * 1_000 },
          role: 'slot',
          useGridId: `grid:own-${i}`,
          gridName: `SAT-X-${i}`,
        },
        done: false,
      })),
    ];
    const created = createMission(
      s,
      {
        type: 'build_deploy',
        priority: 70,
        desiredState: {
          shipSpec: 'designer-constellation',
          station: 'designer:constellation:ring:tagged:grid:x',
          designer: true,
          inPlace: true,
          planet: 'EarthLike',
          launch: 'orbital',
          qty: 3,
        },
        budget: { resources: {}, timeMin: 1, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [],
        plan: { steps, notes: '' },
      } as never,
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) throw new Error(created.message);
    s.updateMission(created.mission.id, { status: 'approved' }, NOW);
    const executor = new DemoExecutor({
      store: s,
      hub: { send: () => false, isConnected: () => false, agentId: () => null } as never,
      config,
      clock: () => NOW,
      fixturePath: null,
    });
    executor.sync(NOW);
    const seeded = db
      .prepare('SELECT idx, prefab, state FROM demo_drones WHERE mission_id = ? ORDER BY idx')
      .all(created.mission.id) as { idx: number; prefab: string; state: string }[];
    expect(seeded.filter((r) => r.state === 'queued')).toHaveLength(2);
    expect(seeded.filter((r) => r.state === 'deferred')).toHaveLength(1);
    expect(seeded[0]!.prefab).toBe('existing:grid:own-1');
    // One tick starts the release chain and binds the real grid id.
    executor.tick();
    const bound = db
      .prepare('SELECT idx, grid_id, state, step FROM demo_drones WHERE mission_id = ? ORDER BY idx')
      .all(created.mission.id) as { idx: number; grid_id: string | null; state: string; step: string | null }[];
    expect(bound[0]!.grid_id).toBe('grid:own-1');
    expect(bound[0]!.state).toBe('securing');
    expect(bound[0]!.step).toBe('release_gears');
    // Never registered for debris cleanup.
    const spawned = db.prepare('SELECT COUNT(*) AS n FROM demo_spawned').get() as { n: number };
    expect(spawned.n).toBe(0);
  });
});
