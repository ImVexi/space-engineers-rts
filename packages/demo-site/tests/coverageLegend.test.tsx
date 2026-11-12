import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LayersPanel } from '../src/components/LayersPanel';
import { APPROXIMATE_LABEL } from '../src/lib/coverageMesh';
import type { Overlays } from '../src/components/Scene';
import type { Planet } from '../src/types';
import type { LinksResponse } from '../src/lib/links';
import type { CoverageDatum } from '../src/components/CoverageLayer';

/**
 * T51.10 legend: k-aware colours, the SIMULATED source label, and a visible
 * warning when the heatmap is NOT terrain-corrected. Rendered to static markup,
 * so no WebGL or DOM is needed.
 */

const PLANETS: Planet[] = [
  { id: 'p1', name: 'EarthLike', center: { x: 0, y: 0, z: 0 }, surfaceRadiusM: 59_400, maxHillRadiusM: 67_200, hasAtmosphere: true },
];

const OVERLAYS: Overlays = {
  radioSpheres: false,
  radioRings: false,
  coverage: true,
  linkMode: 'off',
  laserLinks: false,
  reachableColours: false,
  labels: true,
  terrain: true,
  shapes: false,
  blockByFunction: false,
};

const LINKS: LinksResponse = { current: [], possible: [], available: true } as unknown as LinksResponse;

const COVERAGE: CoverageDatum = {
  planet: 'EarthLike',
  response: {
    planet: 'EarthLike',
    mode: 'cover-planet',
    k: 1,
    cellDeg: 10,
    cells: [
      { latDeg: -5, lonDeg: -5, coveredBy: 0 },
      { latDeg: 5, lonDeg: -5, coveredBy: 1 },
      { latDeg: -5, lonDeg: 5, coveredBy: 2 },
    ],
  },
};

function render(coverageApproximate: string | null): string {
  return renderToStaticMarkup(
    <LayersPanel
      planets={PLANETS}
      overlays={OVERLAYS}
      onOverlays={() => {}}
      linksMode="off"
      onLinksMode={() => {}}
      links={LINKS}
      linksAvailable="ok"
      coveragePlanet="EarthLike"
      onCoveragePlanet={() => {}}
      coverageData={COVERAGE}
      coverageAvailable="ok"
      coverageApproximate={coverageApproximate}
      names={{}}
      onClose={() => {}}
    />,
  );
}

describe('coverage legend', () => {
  it('shows the k-aware colours and the SIMULATED source label', () => {
    const html = render(null);
    expect(html).toContain('0 uncovered');
    expect(html).toContain('1 relay');
    expect(html).toContain('2+ relays');
    expect(html).toContain('rgb(192, 57, 43)'); // red 0
    expect(html).toContain('rgb(224, 176, 114)'); // amber 1
    expect(html).toContain('rgb(63, 143, 104)'); // green 2+
    expect(html).toContain('SIMULATED');
    // exact heatmap: no warning
    expect(html).not.toContain('heatmap approximate');
  });

  it('shows the approximate warning when the heatmap is not terrain-corrected', () => {
    const html = render(APPROXIMATE_LABEL);
    expect(html).toContain('terrain unavailable - heatmap approximate');
    expect(html).toContain('data-testid="coverage-approximate"');
  });
});
