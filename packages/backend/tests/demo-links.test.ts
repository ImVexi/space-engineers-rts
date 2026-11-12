import { describe, expect, it } from 'vitest';
import type { Planet } from '@se-rts/schemas';
import { buildLinksView, nodeMatchesPlanet, radioGroupsFromPlugin, type LinkNode } from '../src/demo/links.js';

const node = (id: string, z: number, over: Partial<LinkNode> = {}): LinkNode => ({
  id,
  name: id.toUpperCase(),
  position: { x: 0, y: 0, z },
  radioRadiusM: 50_000,
  laserPorts: 0,
  laserUsedPorts: 0,
  laserRangeM: null,
  ...over,
});

/** A planet far off the test line, plus one that sits between two grids. */
const PLANETS: Planet[] = [
  {
    id: 'earthlike',
    name: 'EarthLike',
    center: { x: 0, y: 0, z: 0 },
    surfaceRadiusM: 60_000,
    maxHillRadiusM: 67_200,
    hasAtmosphere: true,
  },
];

/** +X off to the side of every test node. */
function farAway(): Planet {
  return {
    id: 'far',
    name: 'Far',
    center: { x: 400_000, y: 0, z: 0 },
    surfaceRadiusM: 10_000,
    maxHillRadiusM: 11_200,
    hasAtmosphere: false,
  };
}

describe('buildLinksView', () => {
  it('separates GAME current from SIMULATED current and possible', async () => {
    const nodes = [
      node('a', 0),
      node('b', 30_000),
      node('d', 20_000, { radioRadiusM: 50_000, laserPorts: 2 }),
      node('e', 26_000, { radioRadiusM: null, laserPorts: 1 }),
    ];
    const view = await buildLinksView({
      nodes,
      planets: [farAway()],
      radioGroups: [{ id: 'rep:1', members: ['a', 'b'] }],
      liveLaserPairs: [{ a: 'b', b: 'd', distanceM: 10_000 }],
      simulatedEdges: [{ from: 'a', to: 'd', kind: 'radio', distanceM: 20_000 }],
    });

    const game = view.current.filter((l) => l.label === 'GAME');
    const sim = view.current.filter((l) => l.label === 'SIMULATED');
    expect(game).toHaveLength(2);
    expect(game.find((l) => l.kind === 'radio')).toMatchObject({ a: 'a', b: 'b', kind: 'radio' });
    expect(game.find((l) => l.kind === 'laser')).toMatchObject({ a: 'b', b: 'd', kind: 'laser' });
    expect(sim).toHaveLength(1);
    expect(sim[0]).toMatchObject({ a: 'a', b: 'd', kind: 'radio' });

    // possible: every radio pair inside 0.9 x min(50k) = 45 km
    const radio = view.possible.filter((l) => l.kind === 'radio');
    expect(radio.every((l) => l.feasible)).toBe(true);
    expect(radio.map((l) => `${l.a}-${l.b}`).sort()).toEqual(['a-b', 'a-d', 'b-d'].sort());
    // d<->e: 6 km, both have a free laser port, no planet in the way, and no
    // asteroid probe -> feasible but explicitly "LOS unchecked".
    const laser = view.possible.find((l) => l.kind === 'laser' && l.a === 'd' && l.b === 'e');
    expect(laser).toMatchObject({ feasible: true, reason: 'laser LOS unchecked' });

    expect(view.summary).toMatchObject({
      radioEdges: 2,
      laserEdges: 1,
      possibleRadio: 3,
      possibleLaser: 1,
    });
    expect(view.summary.isolated).toEqual([]);
    expect(view.labels.possible.join(' ')).toContain('LOS unchecked');
  });

  it('explains infeasible pairs instead of dropping them', async () => {
    const nodes = [
      node('a', 0, { laserPorts: 2 }),
      node('used', 5_000, { radioRadiusM: null, laserPorts: 1, laserUsedPorts: 1 }),
      node('far', 150_000, { radioRadiusM: null, laserPorts: 1 }),
      node('edge', 48_000),
    ];
    const view = await buildLinksView({ nodes, planets: [farAway()] });

    const byPair = (a: string, b: string): string | undefined => {
      const hit = view.possible.find(
        (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a),
      );
      return hit?.reason;
    };
    expect(byPair('a', 'edge')).toContain('beyond radio range');
    expect(view.possible.find((l) => l.a === 'a' && l.b === 'edge')?.feasible).toBe(false);
    expect(byPair('a', 'used')).toBe('laser no free port');
    // Lasers are not range-limited (measured): 150 km apart with a free port is
    // only "LOS unchecked" until probe_los exists, never "out of range".
    expect(byPair('a', 'far')).toBe('laser LOS unchecked');
    // A hardware override still tightens it: give `far` a real 100 km laser.
    const tight = [
      node('a', 0, { laserPorts: 2 }),
      node('used', 5_000, { radioRadiusM: null, laserPorts: 1, laserUsedPorts: 1 }),
      node('far', 150_000, { radioRadiusM: null, laserPorts: 1, laserRangeM: 100_000 }),
      node('edge', 48_000),
    ];
    const tightView = await buildLinksView({ nodes: tight, planets: [farAway()] });
    const tightFar = tightView.possible.find(
      (l) => (l.a === 'a' && l.b === 'far') || (l.a === 'far' && l.b === 'a'),
    );
    expect(tightFar?.reason).toContain('out of laser range');
    // The 150 km pair is a POSSIBLE laser link now (LOS unchecked), so it counts.
    expect(view.summary.possibleLaser).toBe(1);
    // With lasers range-free, `a` and `far` are no longer isolated (they have a
    // possible laser pairing); `used` has no free port and `edge` is out of radio.
    expect(view.summary.isolated).toEqual(['edge', 'used']);
  });

  it('marks planet occlusion and reports the body name', async () => {
    const blocker: Planet = {
      id: 'moon',
      name: 'Moon',
      center: { x: 0, y: 0, z: 50_000 },
      surfaceRadiusM: 9_000,
      maxHillRadiusM: 10_000,
      hasAtmosphere: false,
    };
    const view = await buildLinksView({
      nodes: [node('a', 0, { laserPorts: 1 }), node('b', 100_000, { laserPorts: 1 })],
      planets: [blocker],
    });
    const laser = view.possible.find((l) => l.kind === 'laser');
    expect(laser).toMatchObject({ feasible: false, reason: 'occluded by Moon' });
  });

  it('uses probe_los for asteroids when the plugin offers it', async () => {
    const view = await buildLinksView({
      nodes: [
        node('a', 0, { radioRadiusM: null, laserPorts: 1 }),
        node('b', 10_000, { radioRadiusM: null, laserPorts: 1 }),
        node('c', 12_000, { radioRadiusM: null, laserPorts: 1 }),
      ],
      planets: [farAway()],
      probeLos: (from, to) =>
        to.z === 10_000 ? { clear: false, body: 'asteroid 7' } : { clear: true },
    });
    const ab = view.possible.find((l) => l.a === 'a' && l.b === 'b');
    const kept = view.possible.find((l) => l.b === 'c');
    expect(ab).toMatchObject({ feasible: false, reason: 'occluded by asteroid 7' });
    expect(kept).toMatchObject({ feasible: true, reason: 'laser LOS clear' });
    expect(view.notes.join(' ')).toContain('probed for 3');
  });
});

describe('radioGroupsFromPlugin', () => {
  it('groups readable logical representatives and drops UNVERIFIED rows', () => {
    const groups = radioGroupsFromPlugin({
      grids: [
        { gridId: 'grid:1', logicalGroupRepresentative: { state: 'readable', value: 'grid:9' } },
        { gridId: 'grid:2', logicalGroupRepresentative: { state: 'readable', value: 'grid:9' } },
        { gridId: 'grid:3', logicalGroupRepresentative: { state: 'UNVERIFIED', reason: 'no cube grid' } },
      ],
    });
    expect(groups).toEqual([{ id: 'grid:9', members: ['grid:1', 'grid:2'] }]);
  });
});

describe('nodeMatchesPlanet', () => {
  it('filters by nearest named planet', () => {
    const earth: Planet = PLANETS[0]!;
    const n = node('a', 0);
    n.position = { x: 0, y: 70_000, z: 0 };
    expect(nodeMatchesPlanet(n, [earth, farAway()], 'EarthLike')).toBe(true);
    expect(nodeMatchesPlanet(n, [earth, farAway()], 'Far')).toBe(false);
  });
});
