import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignerOptionCards } from '../src/components/DesignerOptionCards';
import type { DesignerOption } from '../src/lib/designer';
import planFixture from './fixtures/designer/plan-constellation.json';
import connectFixture from './fixtures/designer/plan-connect.json';

const plan = planFixture as unknown as { options: DesignerOption[] };
const connect = connectFixture as unknown as { options: DesignerOption[] };

describe('DesignerOptionCards', () => {
  it('renders up to four options side by side with counts', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={plan.options} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain('data-testid="designer-options"');
    expect(html).toContain('data-option-count="4"');
    for (const option of plan.options) {
      expect(html).toContain(`data-testid="designer-option-${option.id}"`);
      expect(html).toContain(`data-count="${option.count}"`);
    }
    expect(html.match(/data-testid="designer-option-count"/g)).toHaveLength(4);
  });

  it('shows redundancy, SPOFs, coverage, gravity and max gap', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={plan.options} selectedId="ring-18" onSelect={() => {}} />);
    expect(html).toContain('Single path');
    expect(html).toContain('Two node-disjoint paths');
    expect(html).toContain('No single point of failure');
    expect(html).toContain('2.86 m/s²');
    expect(html).toContain('41.5 km');
    expect(html).toContain('100%');
    // The ring is a single path: every slot is listed as a SPOF.
    expect(html).toContain('slot-0');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-testid="designer-select-ring-18"');
  });

  it('marks an infeasible option and lists the planner reasons', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={plan.options} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain('data-testid="designer-option-chain-6"');
    expect(html).toMatch(/data-feasible="false"/);
    expect(html).toContain('data-testid="designer-option-reasons"');
    expect(html).toContain('TWR 0.42');
    expect(html).toContain('infeasible');
  });

  it('renders point-to-point coverage as n/a instead of a fake percentage', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={connect.options} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain('n/a (point-to-point)');
    expect(html).not.toContain('undefined');
  });

  it('always prints the SIMULATED label from the planner payload', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={plan.options} selectedId={null} onSelect={() => {}} />);
    expect(html.match(/SIMULATED/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('shows endurance facts and the launch recommendation', () => {
    const option: DesignerOption = {
      ...plan.options[0]!,
      endurance: {
        available: true,
        enforced: true,
        modelReason: null,
        canReachSlot: true,
        launch: 'orbital',
        ascentTimeS: 205,
        transitTimeS: 2378,
        etaS: 2583,
        fuelUsedPct: 0,
        batteryUsedPct: 0,
        reservePct: 100,
        holdEnduranceS: 'indefinite',
        holdEnduranceText: 'indefinite',
        holdLimiting: 'gravity-free',
        holdPowerMW: 0,
        holdH2BurnLps: 0,
        twrAtSlot: null,
        failureReason: null,
        recommendation: 'park above 44 km: zero gravity, no fuel needed to hold',
      },
    };
    const html = renderToStaticMarkup(<DesignerOptionCards options={[option]} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain('data-testid="designer-option-endurance"');
    expect(html).toContain('data-testid="designer-option-reserve"');
    expect(html).toContain('100.0%');
    expect(html).toContain('indefinite');
    expect(html).toContain('zero gravity');
  });

  it('renders an empty state before any plan exists', () => {
    const html = renderToStaticMarkup(<DesignerOptionCards options={[]} selectedId={null} onSelect={() => {}} />);
    expect(html).toContain('data-testid="designer-options-empty"');
  });
});
