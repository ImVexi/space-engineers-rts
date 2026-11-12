import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { NetworkNode, NodeTemplate, Planet } from '@se-rts/schemas';
import {
  buildGraph,
  coverageAngle,
  linkGraph,
  minimumChainNodes,
  planChain,
  planCoverage,
  PLANET_CATALOG,
  planetRegion,
  resolveTemplate,
  whatIfRemove,
} from '../src/planner/index.js';
import { dist, segmentIntersectsSphere } from '../src/planner/geometry.js';

const planet = (id: string, center: { x: number; y: number; z: number }, r: number): Planet => ({
  id,
  name: id,
  center,
  surfaceRadiusM: r,
  maxHillRadiusM: r,
  hasAtmosphere: true,
});

const node = (id: string, x: number, y: number, z: number, radio: number | null, control = false): NetworkNode => ({
  id,
  position: { x, y, z },
  radioRadiusM: radio,
  laserRangeM: null,
  laserUnlimited: false,
  controlSource: control,
});

const radio = (radius: number): NodeTemplate => ({
  id: `radio-${radius}`,
  radioRadiusM: radius,
  laserRangeM: null,
  laserUnlimited: false,
});

describe('link graph', () => {
  it('builds directional radio edges and finds the articulation point', () => {
    const nodes = [node('a', 0, 0, 0, 60, true), node('b', 50, 0, 0, 60), node('c', 100, 0, 0, 60)];
    const graph = linkGraph(nodes);
    expect(graph.edges.filter((e) => e.kind === 'radio')).toHaveLength(4);
    expect(graph.articulationPoints).toEqual(['b']);
    expect(graph.bridges).toEqual([{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }]);
    expect(graph.components).toEqual([['a', 'b', 'c']]);
    expect(graph.nodes.every((n) => n.reachable)).toBe(true);
  });

  it('honours one-way reception', () => {
    // A loud, B deaf: A can send to B, B cannot send to A.
    const nodes = [
      node('a', 0, 0, 0, 100, false),
      { ...node('b', 50, 0, 0, null, true) },
    ];
    const graph = linkGraph(nodes);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['a->b']);
    expect(graph.nodes.find((n) => n.id === 'b')?.reachable).toBe(true);
    expect(graph.nodes.find((n) => n.id === 'a')?.reachable).toBe(false);
  });

  it('blocks radio and laser through a planet when configured', () => {
    const blocker = planet('blocker', { x: 0, y: 0, z: 0 }, 30000);
    const nodes = [
      { ...node('a', -50000, 0, 0, 100000), laserUnlimited: true },
      { ...node('b', 50000, 0, 0, 100000), laserUnlimited: true },
    ];
    const blocked = linkGraph(nodes, [blocker], { radioBlockedByPlanets: true });
    expect(blocked.edges).toHaveLength(0);
    const radioOnly = linkGraph(nodes, [blocker]);
    expect(radioOnly.edges.some((e) => e.kind === 'radio')).toBe(true);
    expect(radioOnly.edges.some((e) => e.kind === 'laser')).toBe(false);
  });

  it('what-if removal reports newly isolated nodes', () => {
    const nodes = [node('a', 0, 0, 0, 60, true), node('b', 50, 0, 0, 60), node('c', 100, 0, 0, 60)];
    const result = whatIfRemove('b', nodes);
    expect(result.reachableBefore).toEqual(['a', 'b', 'c']);
    expect(result.reachableAfter).toEqual(['a']);
    expect(result.newlyIsolated).toEqual(['c']);
  });

  it('is deterministic for the same input', () => {
    const nodes = [node('a', 0, 0, 0, 100, true), node('b', 50, 0, 0, 100)];
    expect(JSON.stringify(buildGraph(nodes).graph)).toBe(JSON.stringify(buildGraph(nodes).graph));
  });
});

describe('chain planner', () => {
  const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
  const alien = PLANET_CATALOG.find((p) => p.name === 'Alien')!;

  it('brute-force minimal node count matches the closed form', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 400000, noNaN: true }),
        fc.double({ min: 1000, max: 60000, noNaN: true }),
        (distance, spacing) => {
          let hops = 0;
          while (hops * spacing < distance) hops += 1;
          const brute = Math.max(2, hops + 1);
          expect(minimumChainNodes(distance, spacing)).toBe(brute);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('plans EarthLike -> Alien with every hop within range and LOS-clear', () => {
    const plan = planChain(earth, alien, radio(50000), { planets: PLANET_CATALOG });
    expect(plan.count).toBeGreaterThan(100);
    expect(plan.detour).toBe(false);
    expect(plan.maxGapM).toBeLessThanOrEqual(plan.spacingM + 1e-6);
    for (const hop of plan.hops) expect(hop.losClear).toBe(true);
    expect(plan.nodes[0]?.kind).toBe('anchor');
    expect(plan.nodes.at(-1)?.kind).toBe('anchor');
    expect(plan.relayCount).toBe(plan.count - 2);
  });

  it('routes around a blocking planet without entering its sphere', () => {
    const a = planet('A', { x: 0, y: 0, z: 0 }, 10000);
    const b = planet('B', { x: 400000, y: 0, z: 0 }, 10000);
    const blocker = { ...planet('Blocking', { x: 200000, y: 0, z: 0 }, 50000), name: 'Blocking' };
    const plan = planChain(a, b, radio(50000), { planets: [a, b, blocker] });
    expect(plan.detour).toBe(true);
    expect(plan.blockedBy).toEqual(['Blocking']);
    expect(plan.waypoints.length).toBeGreaterThan(2);
    for (const hop of plan.hops) {
      expect(hop.losClear).toBe(true);
      expect(segmentIntersectsSphere(
        plan.nodes.find((n) => n.id === hop.from)!.position,
        plan.nodes.find((n) => n.id === hop.to)!.position,
        blocker.center,
        blocker.maxHillRadiusM,
      )).toBe(false);
    }
  });

  it('is deterministic', () => {
    const one = planChain(earth, alien, radio(10000), { planets: PLANET_CATALOG });
    const two = planChain(earth, alien, radio(10000), { planets: PLANET_CATALOG });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('never emits a gap larger than the template spacing (property)', () => {
    const pairs = PLANET_CATALOG.flatMap((p, i) =>
      PLANET_CATALOG.slice(i + 1).map((q) => [p, q] as const),
    );
    fc.assert(
      fc.property(fc.constantFrom(...pairs), fc.integer({ min: 5000, max: 50000 }), (pair, radius) => {
        const plan = planChain(pair[0], pair[1], radio(radius), { planets: PLANET_CATALOG });
        expect(plan.maxGapM).toBeLessThanOrEqual(plan.spacingM + 1e-6);
        expect(plan.count).toBe(plan.nodes.length);
        for (let i = 0; i + 1 < plan.nodes.length; i += 1) {
          expect(dist(plan.nodes[i]!.position, plan.nodes[i + 1]!.position)).toBeLessThanOrEqual(
            plan.spacingM + 1e-6,
          );
        }
        for (const hop of plan.hops) expect(hop.losClear).toBe(true);
      }),
      { numRuns: 8 },
    );
  });
});

describe('coverage planner', () => {
  const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;

  it('computes a sane coverage angle', () => {
    expect(coverageAngle(60000, 62000, 50000)).toBeGreaterThan(0);
    expect(coverageAngle(60000, 62000, 1000)).toBe(0);
  });

  it('covers a planet with radio nodes and scales with k', () => {
    const one = planCoverage(planetRegion(earth), radio(50000), { k: 1 });
    expect(one.count).toBeGreaterThan(0);
    expect(one.uncoveredSamples).toBe(0);
    expect(one.sampleCoverage).toBe(one.samples);
    const two = planCoverage(planetRegion(earth), radio(50000), { k: 2 });
    expect(two.count).toBeGreaterThanOrEqual(one.count);
    expect(two.uncoveredSamples).toBe(0);
  });

  it('reuses existing nodes and subtracts their coverage first', () => {
    const first = planCoverage(planetRegion(earth), radio(50000), { k: 1 });
    const existing: NetworkNode[] = first.positions.map((p) => ({
      id: p.id,
      position: p.position,
      radioRadiusM: 50000,
      laserRangeM: null,
      laserUnlimited: false,
      controlSource: false,
    }));
    const second = planCoverage(planetRegion(earth), radio(50000), { k: 1, reuseExisting: existing });
    expect(second.existingCoverage).toBe(second.samples);
    expect(second.count).toBe(0);
  });

  it('is deterministic', () => {
    const a = planCoverage(planetRegion(earth), radio(20000), { k: 1 });
    const b = planCoverage(planetRegion(earth), radio(20000), { k: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('templates', () => {
  it('resolves presets and rejects unknown ids', () => {
    expect(resolveTemplate('radio-50km').radioRadiusM).toBe(50000);
    expect(() => resolveTemplate('nope')).toThrow(/unknown template/);
  });
});
