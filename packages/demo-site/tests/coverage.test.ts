import { describe, expect, it } from 'vitest';
import {
  buildCoverageTexture,
  coverageColor,
  coveragePct,
  coverageRgb,
  explainCell,
  latLonToCell,
  liveCoverage,
  pointToLatLon,
  type CoverageCell,
  type CoverageTier,
} from '../src/lib/coverage';

function cell(latDeg: number, lonDeg: number, coveredBy: number): CoverageCell {
  return { latDeg, lonDeg, coveredBy };
}

describe('coverage colours', () => {
  it('maps 0 red, 1 amber, 2+ green', () => {
    expect(coverageRgb(0)[0]).toBe(192);
    expect(coverageRgb(1)).toEqual([224, 176, 114, 200]);
    expect(coverageRgb(2)).toEqual([63, 143, 104, 195]);
    expect(coverageRgb(7)).toEqual(coverageRgb(2));
    expect(coverageColor(0)).toBe('rgb(192, 57, 43)');
  });

  it('computes the covered share against k', () => {
    const cells = [cell(-5, -5, 0), cell(5, -5, 1), cell(-5, 5, 2), cell(5, 5, 3)];
    expect(coveragePct(cells, 1)).toBe(75);
    expect(coveragePct(cells, 2)).toBe(50);
    expect(coveragePct([], 1)).toBe(0);
  });
});

describe('equirect texture', () => {
  it('sizes itself from the cell step and keeps row 0 at the south pole', () => {
    const cells = [cell(-85, -175, 0), cell(85, 175, 2), cell(-85, 175, 1)];
    const texture = buildCoverageTexture(cells, 10);
    expect(texture.width).toBe(36);
    expect(texture.height).toBe(18);
    // south-west texel = first RGBA pixel
    expect(Array.from(texture.data.slice(0, 4))).toEqual([192, 57, 43, 205]);
    // north-east texel = last pixel
    expect(Array.from(texture.data.slice(-4))).toEqual([63, 143, 104, 195]);
    // a cell with no data stays transparent
    expect(texture.data[4 * 3 + 3]).toBe(0);
  });

  it('finds the cell containing a lat/lon, including the date line', () => {
    const cells = [cell(-85, -175, 0), cell(-85, 175, 1), cell(-5, 5, 2)];
    expect(latLonToCell(cells, -84, -174, 10)!.lonDeg).toBe(-175);
    expect(latLonToCell(cells, -84, 179, 10)!.lonDeg).toBe(175);
    expect(latLonToCell(cells, -4, 6, 10)!.coveredBy).toBe(2);
    expect(latLonToCell([], 0, 0, 10)).toBeNull();
  });

  it('turns a surface point back into lat/lon', () => {
    const centre = { x: 1000, y: 0, z: 0 };
    const north = pointToLatLon({ x: 1000, y: 500, z: 0 }, centre);
    expect(north.latDeg).toBeCloseTo(90, 4);
    const east = pointToLatLon({ x: 1000, y: 0, z: 500 }, centre);
    expect(east.latDeg).toBeCloseTo(0, 4);
    expect(east.lonDeg).toBeCloseTo(90, 4);
  });
});

describe('why uncovered', () => {
  const tiers: CoverageTier[] = [
    {
      id: 'station',
      altitudeM: 15_000,
      radioRangeM: 50_000,
      count: 1,
      footprintRadiusM: 43_590,
      nodes: [{ id: 'station-1', altitudeM: 15_000, latDeg: 0, lonDeg: 0 }],
    },
  ];

  it('names the closest planned relay and how far it misses', () => {
    const why = explainCell(cell(0, 180, 0), { tiers, reasons: [], surfaceRadiusM: 59_400 });
    expect(why.lines[0]).toBe('No relay footprint reaches this cell.');
    expect(why.lines[1]).toContain('Closest planned relay station-1');
    expect(why.lines[1]).toContain('misses it by');
    expect(why.tierId).toBe('station');
    expect(why.altitudeM).toBe(15_000);
  });

  it('reports a covered cell and carries planner reasons through', () => {
    const why = explainCell(cell(0, 0, 3), { tiers, reasons: ['station: no base link'], surfaceRadiusM: 59_400 });
    expect(why.lines[0]).toBe('3 relay footprints reach this cell.');
    expect(why.lines[1]).toBe('station: no base link');
    expect(why.tierId).toBeNull();
  });
});

describe('live coverage', () => {
  it('ticks up as a second ship arrives over an uncovered cell', () => {
    const centre = { x: 0, y: 0, z: 0 };
    const cells = [cell(0, 0, 0), cell(0, 90, 0), cell(0, 180, 0)];
    const at = (lonDeg: number, range: number) => ({
      id: `s${lonDeg}`,
      position: { x: Math.cos((lonDeg * Math.PI) / 180) * 74_400, y: 0, z: Math.sin((lonDeg * Math.PI) / 180) * 74_400 },
      radioRangeM: range,
    });
    const one = liveCoverage(cells, [at(0, 50_000)], centre, 59_400, 1);
    expect(one.pct).toBe(33.3);
    const two = liveCoverage(cells, [at(0, 50_000), at(120, 50_000)], centre, 59_400, 1);
    expect(two.pct).toBeGreaterThan(one.pct);
    expect(two.byId.size).toBe(2);
    expect(liveCoverage(cells, [], centre, 59_400, 1).pct).toBe(0);
  });
});
