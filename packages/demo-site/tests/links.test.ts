import { describe, expect, it } from 'vitest';
import {
  countChip,
  currentLinkPairs,
  currentLinkStyle,
  EMPTY_LINKS,
  filterLinks,
  linkHoverText,
  possibleLinkStyle,
  type LinksResponse,
} from '../src/lib/links';

const response: LinksResponse = {
  current: [
    { a: 'grid:1', b: 'grid:2', kind: 'radio', label: 'GAME', lengthM: 41_900 },
    { a: 'grid:2', b: 'grid:1', kind: 'radio', label: 'GAME', lengthM: 41_900 },
    { a: 'grid:1', b: 'grid:3', kind: 'laser', label: 'SIMULATED', lengthM: 900 },
  ],
  possible: [
    { a: 'grid:1', b: 'grid:2', kind: 'radio', lengthM: 41_900, reason: 'in radio range', feasible: true },
    { a: 'grid:2', b: 'grid:3', kind: 'laser', lengthM: 12_000, reason: 'laser no free port', feasible: false },
    { a: 'grid:3', b: 'grid:2', kind: 'laser', lengthM: 12_000, reason: 'laser no free port', feasible: false },
  ],
  summary: { radioEdges: 1, laserEdges: 1, possibleRadio: 1, possibleLaser: 2, isolated: [] },
};

describe('link filtering', () => {
  it('shows nothing when the layer is off', () => {
    expect(filterLinks(response, 'off')).toEqual({ current: [], possible: [] });
    expect(filterLinks(null, 'both')).toEqual({ current: [], possible: [] });
  });

  it('shows only current, de-duplicated regardless of endpoint order', () => {
    const { current, possible } = filterLinks(response, 'current');
    expect(current).toHaveLength(2);
    expect(current.map((l) => l.kind)).toEqual(['radio', 'laser']);
    expect(possible).toHaveLength(0);
  });

  it('excludes possible edges that already exist and de-duplicates the rest', () => {
    const { current, possible } = filterLinks(response, 'both');
    expect(current).toHaveLength(2);
    expect(possible).toHaveLength(1);
    expect(possible[0]!.b).toBe('grid:3');
    expect(possible[0]!.feasible).toBe(false);
  });

  it('drops current edges in possible-only mode', () => {
    const { current, possible } = filterLinks(response, 'possible');
    expect(current).toHaveLength(0);
    expect(possible).toHaveLength(1);
  });
});

describe('link labels', () => {
  it('counts both layers for the chip', () => {
    expect(countChip(response)).toBe('3 current · 3 possible');
    expect(countChip(null)).toBe('0 current · 0 possible');
    expect(countChip(EMPTY_LINKS)).toBe('0 current · 0 possible');
  });

  it('describes kind, length and provenance on hover', () => {
    expect(linkHoverText(response.current[0]!)).toBe('radio · 41.9 km · GAME');
    expect(linkHoverText(response.current[2]!)).toBe('laser · 900 m · SIMULATED');
    expect(linkHoverText(response.possible[1]!)).toBe('laser · 12.0 km · SIMULATED · not feasible: laser no free port');
    expect(linkHoverText(response.possible[0]!)).toBe('radio · 41.9 km · SIMULATED');
  });

  it('draws possible edges dimmer, dashed and dimmer still when infeasible', () => {
    const feasible = possibleLinkStyle(response.possible[0]!);
    const infeasible = possibleLinkStyle(response.possible[1]!);
    expect(feasible.dash).toBe('6 6');
    expect(feasible.opacity).toBeGreaterThan(infeasible.opacity);
  });
});

describe('current link provenance on the map', () => {
  it('gives GAME and SIMULATED current links distinct style tokens for both kinds', () => {
    for (const kind of ['radio', 'laser'] as const) {
      const game = currentLinkStyle({ kind, label: 'GAME' });
      const simulated = currentLinkStyle({ kind, label: 'SIMULATED' });
      expect(game.provenance).toBe('GAME');
      expect(simulated.provenance).toBe('SIMULATED');
      // Both the dash pattern and the colour differ, so neither provenance can
      // be mistaken for the other even on a monochrome display.
      expect(game.dashed).toBe(false);
      expect(simulated.dashed).toBe(true);
      expect(game.color).not.toBe(simulated.color);
      expect(game.opacity).not.toBe(simulated.opacity);
      expect(game.lineWidth).not.toBe(simulated.lineWidth);
    }
    // An unknown label is never allowed to look measured.
    expect(currentLinkStyle({ kind: 'radio', label: 'UNVERIFIED' }).provenance).toBe('SIMULATED');
  });

  it('sources current edges from linksData.current, never from possible', () => {
    const pairs = currentLinkPairs(response, { nodeIds: new Set(['grid:1', 'grid:2', 'grid:3']) });
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => `${p.a}-${p.b}-${p.kind}`).sort()).toEqual(['grid:1-grid:2-radio', 'grid:1-grid:3-laser']);
    // The possible-only laser pair (grid:2 <-> grid:3) must not appear.
    expect(pairs.some((p) => p.a === 'grid:2' && p.b === 'grid:3')).toBe(false);
  });

  it('skips current edges whose endpoints are missing from the scene', () => {
    // Only grid:1 and grid:2 are on the map; the laser to grid:3 is dropped.
    const pairs = currentLinkPairs(response, { nodeIds: new Set(['grid:1', 'grid:2']) });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'grid:1', b: 'grid:2', kind: 'radio', label: 'GAME' });
  });

  it('honours the laser switch and the empty response', () => {
    expect(currentLinkPairs(response, { laser: false })).toHaveLength(1);
    expect(currentLinkPairs(null)).toEqual([]);
    expect(currentLinkPairs(EMPTY_LINKS)).toEqual([]);
  });
});
