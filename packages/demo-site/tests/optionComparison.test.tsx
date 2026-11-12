import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OptionComparison } from '../src/components/OptionComparison';
import type { DemoOption, DemoPlan } from '../src/types';

function option(id: DemoOption['id'], count: number, overrides: Partial<DemoOption> = {}): DemoOption {
  return {
    id,
    label: id === 'radio' ? 'Radio only' : id === 'laser' ? 'Laser only' : 'Mixed (laser backbone + radio last mile)',
    available: true,
    unavailableReason: null,
    templateId: 'test',
    spacingM: 45_000,
    maxGapM: 44_765,
    totalDistanceM: 5_800_000,
    detour: false,
    blockedBy: [],
    count,
    relayCount: count - 2,
    nodes: [],
    hops: [],
    portUsage: [{ nodeId: 'n0', used: 1, capacity: 1, ok: true }],
    portsOk: true,
    linksOk: true,
    missingLinks: [],
    cost: { perNodeCredits: null, totalCredits: null, note: 'placeholder' },
    assumptions: [
      { id: 'planner', text: 'planner math, not game state', status: 'SIMULATED' },
      { id: 'range', text: 'range unmeasured in game', status: 'UNVERIFIED' },
    ],
    ...overrides,
  };
}

const plan: DemoPlan = {
  from: 'EarthLike',
  to: 'Alien',
  hardware: 'auto',
  preferred: 'laser',
  hardwareSummary: { radio: 'radio relays: Eradicator_mk.1 50 km', laser: 'laser: EncounterCitadelStation (2 lasers)', mixed: 'laser + radio', lasersAvailable: 2, radioRelaysAvailable: 1 },
  options: [option('radio', 126), option('laser', 64), option('mixed', 68)],
  assumptions: [],
  labels: ['SIMULATED', 'UNVERIFIED'],
};

describe('OptionComparison', () => {
  it('renders radio, laser and mixed side by side with their node counts', () => {
    const html = renderToStaticMarkup(<OptionComparison plan={plan} selected="laser" onSelect={() => {}} />);
    expect(html).toContain('data-testid="option-radio"');
    expect(html).toContain('data-testid="option-laser"');
    expect(html).toContain('data-testid="option-mixed"');
    expect(html).toContain('data-testid="count-radio">126<');
    expect(html).toContain('data-testid="count-laser">64<');
    expect(html).toContain('data-testid="count-mixed">68<');
    expect(html).toContain('Radio only');
    expect(html).toContain('Laser only');
    expect(html).toContain('preferred');
    expect(html).toContain('aria-selected="true"');
  });

  it('labels every assumption UNVERIFIED or SIMULATED and exposes cost as a placeholder', () => {
    const html = renderToStaticMarkup(<OptionComparison plan={plan} selected={null} onSelect={() => {}} />);
    expect((html.match(/UNVERIFIED/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((html.match(/SIMULATED/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('placeholder (not modelled)');
    expect(html).toContain('within capacity');
    expect(html).toContain('every hop links');
  });

  it('disables an unavailable option and keeps its reason visible', () => {
    const unavailable: DemoPlan = {
      ...plan,
      options: [option('radio', 126), option('laser', 64, { available: false, unavailableReason: 'no laser-capable stand-in available' }), option('mixed', 68)],
    };
    const html = renderToStaticMarkup(<OptionComparison plan={unavailable} selected="radio" onSelect={() => {}} />);
    expect(html).toContain('no laser-capable stand-in available');
    expect(html).toContain('unavailable');
  });

  it('blocks selection when an option fails its own link check', () => {
    const broken: DemoPlan = {
      ...plan,
      options: [option('radio', 126, { linksOk: false, missingLinks: [{ from: 'a', to: 'b', distanceM: 90_000 }] })],
    };
    const html = renderToStaticMarkup(<OptionComparison plan={broken} selected={null} onSelect={() => {}} />);
    expect(html).toContain('1 broken hop(s)');
    expect(html).toContain('fails its own link/port check');
    expect(html).toContain('disabled=""');
  });
});
