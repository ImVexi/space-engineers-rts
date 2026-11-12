import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AlertsScreen,
  FleetOpsScreen,
  OpsPanel,
  OptimiseScreen,
  PreflightCard,
  SendToScreen,
  SurvivalBadge,
} from '../src/components/OpsPanel';
import { preflightLines, type AlertsResponse, type OpsAlert } from '../src/lib/ops';
import type { DemoNode, DemoState } from '../src/types';

/**
 * T51/T60 screens, rendered to static markup. The geometry/interaction pass is
 * the Playwright test; these assert the operator-facing promises: severity +
 * reason + fix on every alert, unknown values never shown as 0, the Advanced
 * block collapsed, and an execute button that is disabled with its reason.
 */

const alerts: OpsAlert[] = [
  {
    id: 'a1',
    kind: 'coverage-hole',
    severity: 'critical',
    subjectType: 'planet',
    subjectId: 'EarthLike',
    message: 'Coverage hole of 13.7 % over EarthLike',
    evidence: { coveragePct: 86.3, uncoveredCells: 412 },
    actions: [{ label: 'Plan a coverage fix', endpoint: '/api/demo/designer/optimise', method: 'POST' }],
    state: 'open',
    count: 1,
    firstSeenAt: 1,
    lastSeenAt: 2,
    ackedBy: null,
  },
  {
    id: 'a2',
    kind: 'energy-runway',
    severity: 'warn',
    subjectType: 'grid',
    subjectId: 'g1',
    message: 'SAT-L-0001 has 9 min of power left',
    evidence: {},
    actions: [],
    state: 'open',
    count: 3,
    firstSeenAt: 1,
    lastSeenAt: 2,
    ackedBy: null,
  },
];

const response: AlertsResponse = {
  enabled: true,
  now: 1,
  alerts,
  counts: { open: 2, acked: 0, critical: 1 },
};

function node(over: Partial<DemoNode> & { id: string; name: string }): DemoNode {
  return {
    prefab: 'DRONE',
    planet: 'EarthLike',
    position: { x: 0, y: 61_000, z: 0 },
    controlSource: false,
    status: 'alive',
    origin: 'fixture',
    note: '',
    source: 'GAME',
    telemetry: null,
    capabilityKnown: true,
    capability: null,
    links: [],
    ports: { used: 0, capacity: 0 },
    reachable: true,
    gate: null,
    ...over,
  };
}

const STATE: DemoState = {
  schemaVersion: 1,
  now: 1,
  env: { name: 'test', locked: true, rtsEnv: 'test', marker: 'x', productionFallback: false },
  planets: [
    { id: 'p1', name: 'EarthLike', center: { x: 0, y: 0, z: 0 }, surfaceRadiusM: 59_400, maxHillRadiusM: 67_200, hasAtmosphere: true },
  ],
  world: { snapshot: 's', nodes: 2, planned: 0 },
  nodes: [node({ id: 'g1', name: 'SAT-L-0001' }), node({ id: 'g2', name: 'BASE-01', controlSource: true })],
  telemetry: { source: 'plugin', connected: true, gridCount: 2, freshCount: 2, movingCount: 0, latestAgeMs: 1000, pollMs: 2000, note: '' },
  graph: { nodes: [], edges: [] } as unknown as DemoState['graph'],
  reachability: { reachable: ['g1', 'g2'], isolated: [], sources: ['g2'] },
  spofs: [],
  bridges: [],
  ports: {},
  flags: {},
  killSwitch: false,
  plugin: { connected: true, agentId: 'a', lastStatus: null },
  standins: [],
  hardwareSummary: { radio: '', laser: '', mixed: '', lasersAvailable: 0, radioRelaysAvailable: 0 },
  missions: { open: 0, awaitingApproval: 0, recent: [] },
  assumptions: [],
  labels: ['SIMULATED'],
};

const noop = () => undefined;

describe('AlertsScreen', () => {
  const html = renderToStaticMarkup(
    <AlertsScreen
      response={response}
      error={null}
      busy={false}
      onRefresh={noop}
      onAck={noop}
      onResolve={noop}
      onFixTab={noop}
    />,
  );

  it('shows severity for every alert', () => {
    expect(html).toContain('Critical');
    expect(html).toContain('Warning');
    expect(html).toContain('data-severity="critical"');
  });

  it('shows a plain-language reason and a concrete fix', () => {
    expect(html).toContain('Coverage is 86.3% with 412 cell(s) not heard by any relay.');
    expect(html).toContain('Fix: Plan a coverage fix');
    // No number in evidence: fall back to the backend sentence, never to 0.
    expect(html).toContain('SAT-L-0001 has 9 min of power left');
    expect(html).not.toMatch(/0 %|0 min of power/);
  });

  it('says the engine is off instead of showing an empty green list', () => {
    const off = renderToStaticMarkup(
      <AlertsScreen
        response={{ enabled: false, reason: 'alerts engine not attached', alerts: [], counts: { open: 0, acked: 0, critical: 0 } }}
        error={null}
        busy={false}
        onRefresh={noop}
        onAck={noop}
        onResolve={noop}
        onFixTab={noop}
      />,
    );
    expect(off).toContain('alerts engine not attached');
  });
});

describe('SurvivalBadge', () => {
  it('renders nothing when survivalMode is absent', () => {
    expect(renderToStaticMarkup(<SurvivalBadge survivalMode={null} />)).toBe('');
  });

  it('names the mode in words', () => {
    expect(renderToStaticMarkup(<SurvivalBadge survivalMode={true} />)).toContain('SURVIVAL MODE');
    expect(renderToStaticMarkup(<SurvivalBadge survivalMode={false} />)).toContain('TEST WORLD');
  });
});

describe('OptimiseScreen', () => {
  const html = renderToStaticMarkup(<OptimiseScreen state={STATE} selectedIds={['g1']} onTab={noop} onToast={noop} />);

  it('has exactly one primary goal button and the apply button', () => {
    expect(html).toContain('Optimise my network');
    expect(html).toContain('Apply this layout');
  });

  it('keeps the settings behind a collapsed Advanced block', () => {
    expect(html).toContain('<details class="ops-advanced" data-testid="optimise-advanced">');
    expect(html).toContain('Advanced');
  });

  it('disables Apply with a reason before any plan exists', () => {
    expect(html).toMatch(/Plan first/);
  });
});

describe('SendToScreen', () => {
  const html = renderToStaticMarkup(
    <SendToScreen state={STATE} bases={[{ name: 'BASE-01', position: { x: 0, y: 59_400, z: 0 } }]} selectedIds={[]} onToast={noop} />,
  );

  it('offers destinations by name and ships from live telemetry', () => {
    expect(html).toContain('EarthLike — surface');
    expect(html).toContain('BASE-01 (base)');
    expect(html).toContain('SAT-L-0001');
  });

  it('disables Approve until a route has been previewed', () => {
    expect(html).toMatch(/Approve and send/);
    expect(html).toMatch(/disabled/);
    expect(html).toMatch(/Preview the route/);
  });

  it('states each preflight number, with an em dash when unknown', () => {
    const card = renderToStaticMarkup(<PreflightCard preflight={preflightLines({ ok: true })} />);
    expect(card).toContain('Distance');
    expect(card).toContain('ETA');
    expect(card).toContain('Fuel left');
    expect(card).toContain('Link path');
    expect(card).toContain('—');
  });
});

describe('FleetOpsScreen', () => {
  const html = renderToStaticMarkup(<FleetOpsScreen state={STATE} selectedIds={['g1']} onToast={noop} />);

  it('states the one planning action and the kinds on offer', () => {
    expect(html).toContain('Plan this operation');
    expect(html).toContain('Come home');
    expect(html).toContain('Reshape');
  });

  it('does not offer Execute until a plan exists', () => {
    expect(html).not.toContain('fleet-execute');
  });
});

describe('OpsPanel shell', () => {
  it('renders one panel with four tabs', () => {
    const html = renderToStaticMarkup(
      <OpsPanel state={STATE} selectedIds={[]} bases={[]} tab="alerts" onTab={noop} onClose={noop} onToast={noop} />,
    );
    expect(html).toContain('data-testid="ops-panel"');
    expect(html).toContain('Alerts');
    expect(html).toContain('Optimise');
    expect(html).toContain('Send to');
    expect(html).toContain('Fleet ops');
    expect(html).toContain('Loading alerts');
  });
});
