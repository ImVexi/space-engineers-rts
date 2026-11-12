import { describe, expect, it } from 'vitest';
import type { DemoNode, DemoState } from '../src/types';
import type { OptimisePlan } from '../src/lib/optimise';
import {
  alertFix,
  alertFixTab,
  alertReason,
  alertsHeadline,
  coverageSource,
  destinations,
  fleetCoverageLine,
  fleetExecuteGate,
  fleetShipLines,
  fmtMeters,
  fmtPct,
  moveLine,
  optimiseApplyGate,
  optimiseCostLine,
  parseGps,
  preflightLines,
  readSurvivalMode,
  severityLabel,
  survivalBadge,
  terrainNotice,
  type AlertsResponse,
  type FleetOperation2,
  type OpsAlert,
} from '../src/lib/ops';

/* ------------------------------------------------------------------ fixtures */

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
  nodes: [
    node({ id: 'g1', name: 'SAT-L-0001' }),
    node({ id: 'g2', name: 'BASE-01', controlSource: true }),
  ],
  telemetry: {
    source: 'plugin',
    connected: true,
    gridCount: 2,
    freshCount: 2,
    movingCount: 0,
    latestAgeMs: 1000,
    pollMs: 2000,
    note: '',
  },
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

function coverage(pct: number, terrain: 'corrected' | 'unavailable' | 'none' = 'corrected') {
  return {
    pct,
    coveredCells: Math.round(pct),
    totalCells: 100,
    cellsByK: { k1: Math.round(pct), k2: 0 },
    blockedCells: 0,
    geometricPct: pct,
    terrain,
    terrainReason: terrain === 'unavailable' ? 'no tiles for this planet' : null,
    sampling: null,
  };
}

function plan(over: Partial<OptimisePlan> = {}): OptimisePlan {
  const move = {
    gridId: 'g1',
    name: 'SAT-L-0001',
    from: { pos: { x: 0, y: 61_000, z: 0 }, altitudeM: 1600, latDeg: 0, lonDeg: 0 },
    to: { pos: { x: 0, y: 70_000, z: 0 }, altitudeM: 10_600, latDeg: 10, lonDeg: 20 },
    distanceM: 12_000,
    etaS: 360,
    fuel: { h2L: 210, batteryMWh: 4, reservePct: 15 },
    thrustClassNeeded: 'hydrogen',
    holdMode: 'hover',
    reason: 'fills the eastern hole',
    substitution: {
      basis: 'nearest movable',
      cellsCovered: 12,
      coversTotal: 40,
      uncoveredDuringTransit: false,
      uncoveredCellCount: 0,
      uncoveredCells: [],
      uncoveredTruncated: false,
      transitEtaS: 360,
    },
  };
  return {
    schemaVersion: 1,
    planId: 'p',
    planet: { id: 'p1', name: 'EarthLike', surfaceRadiusM: 59_400 },
    asOf: 1,
    request: { target: 'hemisphere', k: 1, cellDeg: 5, cellDegUsed: 5, rangeMarginPct: 10, maxMoves: null, dryRun: true, altitudeMode: 'cheapest' },
    base: { gridId: 'g2', name: 'BASE-01', latDeg: 0, lonDeg: 0, altitudeM: 0, source: 'provisioned' },
    fleet: { total: 1, withRadio: 1, commandable: 1, movable: 1, entries: [] },
    excluded: [],
    coverageNow: coverage(78),
    moves: [move],
    staying: [],
    surplus: [],
    coverageAfter: coverage(94),
    gainPct: 16,
    gainCells: 16,
    holes: [],
    holesTotal: 0,
    holesTruncated: false,
    buildRequests: [],
    solver: { candidateSlots: 10, movesEvaluated: 20, altitudesEvaluated: 3, basis: 'hemisphere' },
    assumptions: [],
    labels: ['SIMULATED'],
    limitations: [],
    executable: true,
    operation: null,
    ...over,
  } as OptimisePlan;
}

function alert(over: Partial<OpsAlert> = {}): OpsAlert {
  return {
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
    ...over,
  };
}

function operation(over: Partial<FleetOperation2> = {}): FleetOperation2 {
  return {
    id: 'op1',
    kind: 'recall',
    planetId: 'p1',
    members: ['g1', 'g2'],
    steps: [
      { id: 's1', wave: 1, memberId: 'g1', action: 'return', target: null, status: 'planned' },
      { id: 's2', wave: 2, memberId: 'g2', action: 'hold', target: null, status: 'planned' },
    ],
    status: 'awaiting_approval',
    dryRun: true,
    coverageBefore: { coveragePct: 88, terrain: 'corrected', totalCells: 100 },
    coverageAfter: { coveragePct: 61, terrain: 'unavailable', terrainReason: 'no tiles', totalCells: 100 },
    invariants: {
      ok: true,
      members: [
        { gridId: 'g1', home: null, verdict: 'ok', distanceM: 12_000 },
        { gridId: 'g2', home: null, verdict: 'skipped', reason: 'already home' },
      ],
      failures: [],
      notes: [],
    },
    abortPolicy: 'hold',
    lastError: null,
    ...over,
  };
}

/* -------------------------------------------------------------------- tests */

describe('number formatting never invents a zero', () => {
  it('renders unknown as an em dash', () => {
    expect(fmtMeters(null)).toBe('—');
    expect(fmtPct(undefined)).toBe('—');
    expect(fmtMeters(undefined)).toBe('—');
  });

  it('formats known values', () => {
    expect(fmtMeters(12_000)).toBe('12.0 km');
    expect(fmtMeters(800)).toBe('800 m');
    expect(fmtPct(86.25)).toBe('86.3%');
  });
});

describe('coverage honesty', () => {
  it('reads the source label from the backend labels', () => {
    expect(coverageSource(['GAME', 'DRY-RUN'])).toBe('GAME');
    expect(coverageSource(['SIMULATED'])).toBe('SIMULATED');
    expect(coverageSource([])).toBe('UNKNOWN');
    expect(coverageSource(null)).toBe('UNKNOWN');
  });

  it('states unavailable terrain next to the coverage figure', () => {
    const notice = terrainNotice({ terrain: 'unavailable', terrainReason: 'no tiles for this planet' });
    expect(notice).toContain('terrain unavailable');
    expect(notice).toContain('no tiles');
    expect(terrainNotice({ terrain: 'corrected' })).toBeNull();
  });
});

describe('optimiser cost line', () => {
  it('says nothing to do in words when no ship moves', () => {
    const line = optimiseCostLine(plan({ moves: [], staying: [{ gridId: 'g1', name: 'SAT-L-0001', reason: 'already best' }] }));
    expect(line).toContain('Nothing to move');
    expect(line).toContain('78.0% → 94.0%');
  });

  it('states ships, coverage, time and fuel', () => {
    const line = optimiseCostLine(plan());
    expect(line).toContain('Move 1 ship');
    expect(line).toContain('78.0% → 94.0%');
    expect(line).toContain('6 min');
    expect(line).toContain('210 L H2');
  });

  it('says fuel is unread instead of printing 0 L', () => {
    const p = plan();
    p.moves = [{ ...p.moves[0]!, fuel: { h2L: null, batteryMWh: null, reservePct: 15 } }];
    const line = optimiseCostLine(p);
    expect(line).toContain('fuel unread for every ship');
    expect(line).not.toContain('0 L');
  });

  it('names how many ships have a readable tank', () => {
    const p = plan();
    p.moves = [
      p.moves[0]!,
      { ...p.moves[0]!, gridId: 'g9', name: 'SAT-L-0009', fuel: { h2L: null, batteryMWh: null, reservePct: 15 } },
    ];
    expect(optimiseCostLine(p)).toContain('for 1 of 2 ships (rest unread)');
  });
});

describe('per-move truth', () => {
  it('warns about cells uncovered during transit', () => {
    const p = plan();
    const move = {
      ...p.moves[0]!,
      substitution: { ...p.moves[0]!.substitution, uncoveredDuringTransit: true, uncoveredCellCount: 3 },
    };
    const line = moveLine(move);
    expect(line.transit).toBe('3 cell(s) uncovered during transit');
    expect(line.warn).toBe(true);
    expect(line.detail).toContain('1.6 km → 10.6 km');
    expect(line.detail).toContain('210 L H2');
  });

  it('says who covers the cells when transit is safe', () => {
    expect(moveLine(plan().moves[0]!).warn).toBe(false);
  });
});

describe('apply gate', () => {
  it('refuses with a sentence, not an error code', () => {
    expect(optimiseApplyGate(null, []).enabled).toBe(false);
    expect(optimiseApplyGate(null, []).reason).toMatch(/Plan first/);
    expect(optimiseApplyGate(plan({ executable: false }), ['g1']).reason).toMatch(/not executable/);
    expect(optimiseApplyGate(plan(), ['g2']).reason).toMatch(/Select the ships/);
    expect(optimiseApplyGate(plan(), ['g1']).enabled).toBe(true);
  });
});

describe('alerts: severity, plain reason, concrete fix', () => {
  it('labels every severity the backend can send', () => {
    expect(severityLabel('critical')).toBe('Critical');
    expect(severityLabel('warn')).toBe('Warning');
    expect(severityLabel('info')).toBe('Info');
    expect(severityLabel('weird')).toBe('Unknown severity');
  });

  it('turns evidence into a sentence about cells, not a code', () => {
    expect(alertReason(alert())).toBe('Coverage is 86.3% with 412 cell(s) not heard by any relay.');
  });

  it('falls back to the backend message when evidence has no number', () => {
    expect(alertReason(alert({ evidence: {}, message: 'Grid lost' }))).toBe('Grid lost');
  });

  it('always offers a concrete fix', () => {
    expect(alertFix(alert())).toBe('Plan a coverage fix');
    expect(alertFix(alert({ actions: [], kind: 'telemetry-stale' }))).toMatch(/Check the grid in game/);
    expect(alertFix(alert({ actions: [], kind: 'made-up' }))).toMatch(/No one-click fix/);
  });

  it('routes the fix to the screen that can do it', () => {
    expect(alertFixTab(alert())).toBe('optimise');
    expect(alertFixTab(alert({ kind: 'needs-refuel' }))).toBe('send');
    expect(alertFixTab(alert({ kind: 'mission-failed' }))).toBeNull();
  });

  it('states when the engine is off instead of showing zero alerts', () => {
    const off: AlertsResponse = { enabled: false, reason: 'alerts engine not attached', alerts: [], counts: { open: 0, acked: 0, critical: 0 } };
    expect(alertsHeadline(off)).toMatch(/engine is off/);
    expect(alertsHeadline(null)).toMatch(/Loading/);
    expect(alertsHeadline({ ...off, enabled: true })).toMatch(/No open alerts/);
    expect(alertsHeadline({ ...off, enabled: true, alerts: [alert(), alert({ id: 'a2', severity: 'warn' })] })).toBe(
      '2 open alerts · 1 critical · 1 warning.',
    );
  });
});

describe('send to: destinations by name', () => {
  it('offers planets, bases and ships — never a pixel', () => {
    const list = destinations(STATE, [{ name: 'BASE-01', position: { x: 0, y: 59_400, z: 0 } }]);
    expect(list.filter((d) => d.kind === 'planet')).toHaveLength(3);
    expect(list.find((d) => d.kind === 'base')?.label).toContain('BASE-01');
    expect(list.find((d) => d.kind === 'ship')?.target).toEqual({ gps: { x: 0, y: 61_000, z: 0 } });
  });

  it('parses a real SE GPS string and rejects a bad one', () => {
    expect(parseGps('GPS:Moon base:1000:2000:-3000:#FF75C9F1')).toEqual({ x: 1000, y: 2000, z: -3000 });
    expect(parseGps('GPS:broken')).toBeNull();
    expect(parseGps('Moon 1000 2000 3000')).toBeNull();
  });

  it('shows distance, ETA, fuel and link path from the dry run', () => {
    const lines = preflightLines({
      ok: true,
      distanceM: 58_223,
      etaS: 970,
      fuelText: 'fuel: hydrogen 0 %, battery 100 %',
      linkText: 'linked through BASE-01',
    });
    expect(lines.distance).toBe('58.2 km');
    expect(lines.eta).toBe('16 min');
    expect(lines.fuel).toContain('hydrogen 0 %');
    expect(lines.link).toContain('BASE-01');
    expect(lines.refusal).toBeNull();
  });

  it('words a refusal with the block message and hint', () => {
    const lines = preflightLines({
      ok: false,
      block: { code: 'not_reachable', message: 'The destination is not reachable from your network.', hint: 'Use Admin override.' },
    });
    expect(lines.ok).toBe(false);
    expect(lines.refusal).toContain('not reachable');
    expect(lines.refusal).toContain('Admin override');
  });
});

describe('fleet ops gate', () => {
  it('is disabled with a plain reason while fleet_ops_execute is off', () => {
    const gate = fleetExecuteGate({}, operation());
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('fleet_ops_execute');
  });

  it('is disabled when the operation is no longer awaiting approval', () => {
    expect(fleetExecuteGate({ fleet_ops_execute: true }, operation({ status: 'executing' })).reason).toMatch(/executing/);
  });

  it('surfaces the failing invariant', () => {
    const op = operation();
    op.invariants.failures = [{ invariant: 'separation', reason: 'two slots are 40 m apart', severity: 'hard' }];
    const gate = fleetExecuteGate({ fleet_ops_execute: true }, op);
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('separation');
  });

  it('enables when the flag is on and every invariant passed', () => {
    expect(fleetExecuteGate({ fleet_ops_execute: true }, operation()).enabled).toBe(true);
  });
});

describe('fleet ops: what each ship will do', () => {
  it('lists a verb per member and why a skipped member stays', () => {
    const lines = fleetShipLines(operation(), { g1: 'SAT-L-0001', g2: 'BASE-01' });
    expect(lines[0]).toMatchObject({ name: 'SAT-L-0001', warn: false });
    expect(lines[0]!.will).toContain('fly home');
    expect(lines[1]!.will).toContain('stays put');
    expect(lines[1]!.warn).toBe(true);
  });

  it('carries the terrain warning into the coverage line', () => {
    expect(fleetCoverageLine(operation())).toContain('terrain unavailable');
    expect(fleetCoverageLine(null)).toMatch(/No coverage figure/);
  });
});

describe('survival badge', () => {
  it('renders nothing when the field is absent', () => {
    expect(survivalBadge(undefined)).toBeNull();
    expect(readSurvivalMode({}, {})).toBeNull();
  });

  it('reads the flag from health first, then state', () => {
    expect(readSurvivalMode({ survivalMode: true }, null)).toBe(true);
    expect(readSurvivalMode({}, { survivalMode: false })).toBe(false);
    expect(survivalBadge(true)?.text).toBe('SURVIVAL MODE');
    expect(survivalBadge(false)?.text).toBe('TEST WORLD');
  });
});
