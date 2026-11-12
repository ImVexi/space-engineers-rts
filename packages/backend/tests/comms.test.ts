import { describe, expect, it } from 'vitest';
import { isFresh, isUnitReachable, normaliseLinks, reachableUnits } from '../src/comms.js';

const NOW = 1_700_000_000_000;
const units = [
  { id: 'grid:fresh', linkStatus: 'up' as const, lastSeen: NOW - 1_000 },
  { id: 'grid:down', linkStatus: 'down' as const, lastSeen: NOW - 1_000 },
  { id: 'grid:stale', linkStatus: 'up' as const, lastSeen: NOW - 30_001 },
  { id: 'grid:edge', linkStatus: 'up' as const, lastSeen: NOW - 30_000 },
];

describe('comms authority', () => {
  it('requires link up and telemetry younger than 30 s', () => {
    const reachable = reachableUnits(units, [], NOW);
    expect(reachable.has('grid:fresh')).toBe(true);
    expect(reachable.has('grid:down')).toBe(false);
    expect(reachable.has('grid:stale')).toBe(false);
    expect(reachable.has('grid:edge')).toBe(false);
  });

  it('isFresh treats the 30 s boundary as stale', () => {
    expect(isFresh({ linkStatus: 'up', lastSeen: NOW - 29_999 }, NOW, 30_000)).toBe(true);
    expect(isFresh({ linkStatus: 'up', lastSeen: NOW - 30_000 }, NOW, 30_000)).toBe(false);
  });

  it('expands reachability across up links when control sources are set', () => {
    const nodes = [
      { id: 'station:home', linkStatus: 'up' as const, lastSeen: NOW },
      { id: 'grid:relay', linkStatus: 'up' as const, lastSeen: NOW },
      { id: 'grid:sat', linkStatus: 'up' as const, lastSeen: NOW },
      { id: 'grid:island', linkStatus: 'up' as const, lastSeen: NOW },
    ];
    const links = [
      { a: 'station:home', b: 'grid:relay', status: 'up' as const },
      { a: 'grid:relay', b: 'grid:sat', status: 'up' as const },
    ];
    const reachable = reachableUnits(nodes, links, NOW, { sources: ['station:home'] });
    expect([...reachable].sort()).toEqual(['grid:relay', 'grid:sat', 'station:home']);
    expect(reachable.has('grid:island')).toBe(false);
  });

  it('a down link blocks reachability even if the graph path exists', () => {
    const nodes = [
      { id: 'station:home', linkStatus: 'up' as const, lastSeen: NOW },
      { id: 'grid:relay', linkStatus: 'up' as const, lastSeen: NOW },
      { id: 'grid:sat', linkStatus: 'down' as const, lastSeen: NOW },
    ];
    const links = [
      { a: 'station:home', b: 'grid:relay', status: 'up' as const },
      { a: 'grid:relay', b: 'grid:sat', status: 'up' as const },
    ];
    expect(isUnitReachable(nodes, links, 'grid:sat', NOW, { sources: ['station:home'] })).toBe(false);
  });

  it('normalises A-B / B-A links and dedupes', () => {
    const links = normaliseLinks([
      { a: 'b', b: 'a', status: 'up' },
      { a: 'a', b: 'b', status: 'up' },
      { a: 'a', b: 'c', status: 'down' },
    ]);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ a: 'a', b: 'b' });
  });
});
