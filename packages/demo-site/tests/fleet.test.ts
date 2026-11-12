import { describe, expect, it } from 'vitest';
import type { DemoNode, DemoState, NamingGrid } from '../src/types';
import {
  EMPTY_FILTER,
  FUEL_ALERT_PCT,
  alertsFor,
  buildFleetRows,
  expectedLife,
  filterFleet,
  fleetCsv,
  fmtPct,
  fmtRunway,
  fuelRunwayMinutes,
  powerRunwayMinutes,
  readPower,
  roleFromNaming,
  sortFleet,
  stockRunwayMinutes,
} from '../src/lib/fleet';

const NOW = 1_794_000_000_000;

function node(over: Partial<DemoNode> & { id: string; name?: string }): DemoNode {
  const id = over.id;
  const name = over.name ?? id;
  const base: DemoNode = {
    id,
    name,
    prefab: 'DRONE',
    planet: null,
    position: { x: 0, y: 59_400 + 50_000, z: 0 },
    controlSource: false,
    status: 'alive',
    origin: 'fixture',
    note: '',
    source: 'GAME',
    telemetry: {
      name: over.name ?? over.id,
      lastSeen: NOW - 1000,
      ageMs: 1000,
      fresh: true,
      pos: { x: 0, y: 109_400, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      speedMps: 0,
      moving: false,
      linkStatus: 'up',
      ownership: null,
    },
    capabilityKnown: true,
    capability: {
      role: 'drone',
      radioRadiusM: 50_000,
      laserRangeM: null,
      laserPorts: 0,
      controllable: true,
      sizeClass: 'large',
      isStatic: false,
      sourceNote: '',
    },
    links: [],
    ports: { used: 0, capacity: 0 },
    reachable: true,
    gate: null,
  };
  return { ...base, ...over, id, name };
}

function stateWith(nodes: DemoNode[], extra: Partial<DemoState> = {}): DemoState {
  return {
    schemaVersion: 1,
    now: NOW,
    env: { name: 'test', locked: true, rtsEnv: 'test', marker: 'test', productionFallback: false },
    planets: [
      {
        id: 'earthlike',
        name: 'EarthLike',
        center: { x: 0, y: 0, z: 0 },
        surfaceRadiusM: 59_400,
        maxHillRadiusM: 67_200,
        hasAtmosphere: true,
      },
    ],
    world: { snapshot: 's', nodes: nodes.length, planned: 0 },
    nodes,
    telemetry: {
      source: 'plugin',
      connected: true,
      gridCount: nodes.length,
      freshCount: nodes.length,
      movingCount: 0,
      latestAgeMs: 1000,
      pollMs: 2000,
      note: '',
    },
    graph: { schemaVersion: 1, nodes: [], edges: [], articulationPoints: [], bridges: [], components: [], config: {} },
    reachability: { reachable: nodes.map((n) => n.id), isolated: [], sources: [] },
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
    labels: [],
    ...extra,
  };
}

const naming = (gridId: string, name: string, cls: string): NamingGrid => ({
  gridId,
  name,
  kind: 'SAT',
  cls,
  number: 1,
  tag: '[HERMES-TEST]',
  ownerOverride: false,
});

describe('role detection', () => {
  it('reads R/L/M/H from the naming payload', () => {
    expect(roleFromNaming(naming('g', 'SAT-R-0001', 'R'))).toBe('R');
    expect(roleFromNaming(naming('g', 'SAT-L-0001', 'L'))).toBe('L');
    expect(roleFromNaming(naming('g', 'SAT-M-0001', 'M'))).toBe('M');
    expect(roleFromNaming(naming('g', 'SAT-H-0001', 'H'))).toBe('H');
  });

  it('falls back to the name when cls is missing, and null when untagged', () => {
    expect(roleFromNaming({ ...naming('g', 'SAT-H-0007', ''), cls: '' })).toBe('H');
    expect(roleFromNaming({ ...naming('g', 'BASE-01', ''), cls: '' })).toBeNull();
    expect(roleFromNaming(undefined)).toBeNull();
  });
});

describe('fleet rows', () => {
  it('derives planet and altitude from the nearest planet surface', () => {
    const rows = buildFleetRows(stateWith([node({ id: 'a' })]), [node({ id: 'a' })], []);
    expect(rows[0]!.planet).toBe('EarthLike');
    expect(rows[0]!.altitudeM).toBeCloseTo(50_000, 0);
    expect(rows[0]!.zeroG).toBe(true);
  });

  it('counts links, names them and reports free laser ports', () => {
    const a = node({
      id: 'a',
      name: 'SAT-L-0001',
      capability: {
        role: 'relay',
        radioRadiusM: 50_000,
        laserRangeM: 10_000,
        laserPorts: 3,
        controllable: true,
        sizeClass: 'large',
        isStatic: false,
        sourceNote: 'sim',
      },
      links: [
        { to: 'b', kind: 'radio', distanceM: 1000 },
        { to: 'b', kind: 'laser', distanceM: 1000 },
        { to: 'c', kind: 'laser', distanceM: 2000 },
      ],
    });
    const b = node({ id: 'b', name: 'BASE-01' });
    const c = node({ id: 'c', name: 'SAT-R-0002' });
    const rows = buildFleetRows(stateWith([a, b, c]), [a, b, c], [naming('a', 'SAT-L-0001', 'L')]);
    expect(rows[0]!.links).toBe(3);
    expect(rows[0]!.linkNames).toEqual(['BASE-01', 'BASE-01', 'SAT-R-0002']);
    expect(rows[0]!.laserPortsCapacity).toBe(3);
    expect(rows[0]!.laserPortsUsed).toBe(2);
    expect(rows[0]!.laserPortsFree).toBe(1);
    expect(rows[0]!.linkKinds).toEqual({ radio: 1, laser: 2 });
  });

  it('marks a static grid as a station and gives it no fuel limit', () => {
    const a = node({ id: 'a' });
    a.capability = { ...a.capability!, isStatic: true };
    a.telemetry = { ...a.telemetry!, h2Pct: 4 } as never;
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(rows[0]!.state).toBe('station');
    expect(rows[0]!.expectedLife.kind).toBe('no-limit');
    // A station with low H2 is not "needs fuel"; it burns nothing.
    expect(alertsFor(rows).some((x) => x.kind === 'needs-fuel')).toBe(false);
  });

  it('uses the executor mission state for en-route, holding and failed', () => {
    const a = node({ id: 'a' });
    const b = node({ id: 'b' });
    const c = node({ id: 'c' });
    const state = stateWith([a, b, c], {
      executions: {
        enabled: true,
        killSwitch: false,
        speedLimitMps: 100,
        maxDronesPerMission: 4,
        maxActiveStandIns: 4,
        legM: 1000,
        lastTickAt: NOW,
        lastError: null,
        active: 1,
        labels: [],
        executions: [
          {
            missionId: 'm1',
            state: 'running',
            scaled: false,
            total: 3,
            cap: 4,
            note: null,
            counts: { queued: 0, spawning: 0, securing: 0, enRoute: 1, holding: 1, stopped: 0, failed: 1, skipped: 0 },
            drones: [
              { idx: 0, label: 'a', prefab: 'd', role: null, planet: null, state: 'en_route', gridId: 'a', reason: null, attempts: 1, planSlot: { x: 0, y: 0, z: 0 }, execSlot: { x: 0, y: 0, z: 0 }, spawn: { x: 0, y: 0, z: 0 }, position: null, remainingM: 10, speedMps: 5, etaSec: 2, holdSince: null, updatedAt: NOW },
              { idx: 1, label: 'b', prefab: 'd', role: null, planet: null, state: 'holding', gridId: 'b', reason: null, attempts: 1, planSlot: { x: 0, y: 0, z: 0 }, execSlot: { x: 0, y: 0, z: 0 }, spawn: { x: 0, y: 0, z: 0 }, position: null, remainingM: 0, speedMps: 0, etaSec: null, holdSince: NOW, updatedAt: NOW },
              { idx: 2, label: 'c', prefab: 'd', role: null, planet: null, state: 'failed', gridId: 'c', reason: 'no fuel', attempts: 2, planSlot: { x: 0, y: 0, z: 0 }, execSlot: { x: 0, y: 0, z: 0 }, spawn: { x: 0, y: 0, z: 0 }, position: null, remainingM: null, speedMps: 0, etaSec: null, holdSince: null, updatedAt: NOW },
            ],
          },
        ],
      },
    });
    const rows = buildFleetRows(state, [a, b, c], []);
    expect(rows.map((r) => r.state)).toEqual(['en-route', 'holding', 'failed']);
  });

  it('reports needs-fuel below the alert threshold and does not fake missing values', () => {
    const a = node({ id: 'a' });
    a.telemetry = { ...a.telemetry!, h2Pct: FUEL_ALERT_PCT - 1 } as never;
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(rows[0]!.state).toBe('needs-fuel');
    expect(rows[0]!.batteryPct).toBeNull();
    expect(rows[0]!.power.missing).toContain('battery');
    expect(rows[0]!.power.missing).toContain('solar');
  });
});


describe('BUG-B: unread telemetry is never 0 %', () => {
  it('shows "—" and raises no fuel alert when the backend says unread', () => {
    const a = node({ id: 'a' });
    a.telemetry = {
      ...a.telemetry!,
      h2Pct: null,
      h2State: 'unread',
      h2UnreadReason: 'profile did not return a fuel section',
    } as never;
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(rows[0]!.h2Pct).toBeNull();
    expect(rows[0]!.power.h2State).toBe('unread');
    expect(rows[0]!.power.h2UnreadReason).toBe('profile did not return a fuel section');
    expect(rows[0]!.state).not.toBe('needs-fuel');
    expect(fmtPct(rows[0]!.h2Pct)).toBe('—');
    expect(alertsFor(rows).some((x) => x.kind === 'needs-fuel')).toBe(false);
  });

  it('shows "—" and raises no fuel alert when no H2 field arrived at all', () => {
    const a = node({ id: 'a' });
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(rows[0]!.h2Pct).toBeNull();
    expect(rows[0]!.power.h2State).not.toBe('read');
    expect(alertsFor(rows).some((x) => x.kind === 'needs-fuel')).toBe(false);
  });

  it('still alerts on a real 0 % (read, empty tank)', () => {
    const a = node({ id: 'a' });
    a.telemetry = { ...a.telemetry!, h2Pct: 0, h2State: 'read' } as never;
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(rows[0]!.state).toBe('needs-fuel');
    expect(alertsFor(rows).some((x) => x.kind === 'needs-fuel')).toBe(true);
  });

  it('does not raise a low-power alert for an unread battery', () => {
    const a = node({ id: 'a' });
    a.telemetry = {
      ...a.telemetry!,
      batteryPct: null,
      batteryState: 'unread',
      batteryUnreadReason: 'battery read threw',
      chargeState: 'discharging',
      netMw: -0.5,
    } as never;
    const rows = buildFleetRows(stateWith([a]), [a], []);
    expect(alertsFor(rows).some((x) => x.kind === 'low-power')).toBe(false);
  });
});

describe('power feature detection', () => {
  it('reads the flat plugin telemetry fields when present', () => {
    const a = node({ id: 'a' });
    a.telemetry = {
      ...a.telemetry!,
      batteryPct: 82,
      solarOutputMw: 0.42,
      solarMaxMw: 0.64,
      h2Pct: 61,
      uraniumKg: 4,
      uraniumCapacityKg: 5,
      netMw: -0.2,
    } as never;
    const p = readPower(a);
    expect(p.batteryPct).toBe(82);
    expect(p.solarPct).toBeCloseTo(65.625, 3);
    expect(p.h2Pct).toBe(61);
    expect(p.uraniumPct).toBeCloseTo(80, 6);
    expect(p.charge).toBe('draining');
    expect(p.missing).not.toContain('battery');
  });

  it('reads the nested power block spelling as a fallback', () => {
    const a = node({ id: 'a' });
    a.telemetry = {
      ...a.telemetry!,
      power: {
        battery: { pct: 44, storedMWh: 1.2, capacityMWh: 2.7 },
        solar: { actualMw: 0.1, maxMw: 0.5 },
        h2: { pct: 12 },
        reactors: [{ uraniumKg: 1.5, capacityKg: 3 }],
      },
      currentInputMw: 0,
      currentOutputMw: 0.3,
    } as never;
    const p = readPower(a);
    expect(p.batteryPct).toBe(44);
    expect(p.solarPct).toBeCloseTo(20, 6);
    expect(p.uraniumKg).toBe(1.5);
    expect(p.charge).toBe('draining');
  });
});

describe('runway maths', () => {
  it('computes battery minutes from stored energy and net draw', () => {
    expect(powerRunwayMinutes(2, -0.5)).toBe(240);
    expect(powerRunwayMinutes(2, 0.5)).toBeNull();
    expect(powerRunwayMinutes(null, -0.5)).toBeNull();
  });

  it('computes fuel minutes from a fill and a burn rate', () => {
    expect(fuelRunwayMinutes(50, 10)).toBe(300);
    expect(fuelRunwayMinutes(50, 0)).toBeNull();
    expect(stockRunwayMinutes(10, 2)).toBe(300);
  });

  it('expected life is the minimum known runway', () => {
    expect(expectedLife({ isStation: false, zeroG: false, runways: [240, 300, null], provided: null })).toEqual({
      kind: 'minutes',
      minutes: 240,
    });
    expect(expectedLife({ isStation: true, zeroG: false, runways: [10], provided: null }).kind).toBe('no-limit');
    expect(expectedLife({ isStation: false, zeroG: true, runways: [10], provided: null }).kind).toBe('no-limit');
    expect(expectedLife({ isStation: false, zeroG: false, runways: [null], provided: null }).kind).toBe('unknown');
    // A backend-provided runway also participates.
    expect(expectedLife({ isStation: false, zeroG: false, runways: [600], provided: 120 })).toEqual({ kind: 'minutes', minutes: 120 });
  });

  it('formats runways as h:mm, no limit and unknown', () => {
    expect(fmtRunway({ kind: 'minutes', minutes: 130 })).toBe('2:10');
    expect(fmtRunway({ kind: 'no-limit', minutes: null })).toBe('no limit');
    expect(fmtRunway({ kind: 'unknown', minutes: null })).toBe('—');
  });
});

describe('sorting', () => {
  const rows = buildFleetRows(
    stateWith([
      node({ id: 'a', name: 'SAT-R-0002' }),
      node({ id: 'b', name: 'SAT-R-0001' }),
      node({ id: 'c', name: 'SAT-R-0003' }),
    ]),
    [node({ id: 'a', name: 'SAT-R-0002' }), node({ id: 'b', name: 'SAT-R-0001' }), node({ id: 'c', name: 'SAT-R-0003' })],
    [naming('a', 'SAT-R-0002', 'R'), naming('b', 'SAT-R-0001', 'R'), naming('c', 'SAT-R-0003', 'H')],
  );

  it('sorts names naturally in both directions', () => {
    expect(sortFleet(rows, 'name', 'asc').map((r) => r.name)).toEqual(['SAT-R-0001', 'SAT-R-0002', 'SAT-R-0003']);
    expect(sortFleet(rows, 'name', 'desc').map((r) => r.name)).toEqual(['SAT-R-0003', 'SAT-R-0002', 'SAT-R-0001']);
  });

  it('sorts H2 numerically and keeps unknown values last in both directions', () => {
    const withFuel = rows.map((r, i) => ({ ...r, h2Pct: i === 0 ? 60 : i === 1 ? 12 : null }));
    expect(sortFleet(withFuel, 'h2', 'asc').map((r) => r.h2Pct)).toEqual([12, 60, null]);
    expect(sortFleet(withFuel, 'h2', 'desc').map((r) => r.h2Pct)).toEqual([60, 12, null]);
  });

  it('sorts stations as no-limit above finite runways', () => {
    const mixed = rows.map((r, i) => ({
      ...r,
      expectedLife: i === 0 ? { kind: 'no-limit' as const, minutes: null } : { kind: 'minutes' as const, minutes: 60 * (i + 1) },
    }));
    expect(sortFleet(mixed, 'life', 'desc')[0]!.expectedLife.kind).toBe('no-limit');
  });
});

describe('filters', () => {
  const rows = buildFleetRows(
    stateWith([
      node({ id: 'a', name: 'SAT-R-0001' }),
      node({ id: 'b', name: 'SAT-L-0002' }),
      node({ id: 'c', name: 'BASE-01' }),
    ]),
    [node({ id: 'a', name: 'SAT-R-0001' }), node({ id: 'b', name: 'SAT-L-0002' }), node({ id: 'c', name: 'BASE-01' })],
    [naming('a', 'SAT-R-0001', 'R'), naming('b', 'SAT-L-0002', 'L')],
  ).map((r, i) => ({ ...r, h2Pct: i === 0 ? 10 : i === 1 ? 50 : null }));

  it('filters by role', () => {
    expect(filterFleet(rows, { ...EMPTY_FILTER, roles: ['L'] }).map((r) => r.name)).toEqual(['SAT-L-0002']);
  });

  it('filters by state', () => {
    expect(filterFleet(rows, { ...EMPTY_FILTER, states: ['ship'] })).toHaveLength(3);
    expect(filterFleet(rows, { ...EMPTY_FILTER, states: ['failed'] })).toHaveLength(0);
  });

  it('filters fuel below 30 % but keeps unknown-fuel rows', () => {
    const out = filterFleet(rows, { ...EMPTY_FILTER, maxFuelPct: 30 });
    expect(out.map((r) => r.name)).toEqual(['SAT-R-0001', 'BASE-01']);
  });

  it('searches names, planets and states', () => {
    expect(filterFleet(rows, { ...EMPTY_FILTER, query: 'sat-l' }).map((r) => r.name)).toEqual(['SAT-L-0002']);
    expect(filterFleet(rows, { ...EMPTY_FILTER, query: 'earthlike' })).toHaveLength(3);
  });
});

describe('alerts', () => {
  it('raises needs-fuel, low power, link lost, drifting and stale alerts with a why and an action', () => {
    const fuel = node({ id: 'fuel' });
    fuel.telemetry = { ...fuel.telemetry!, h2Pct: 8, batteryPct: 8, netMw: -0.4 } as never;
    const lost = node({
      id: 'lost',
      reachable: false,
      links: [],
      telemetry: {
        ...(node({ id: 'lost' }).telemetry as NonNullable<DemoNode['telemetry']>),
        ageMs: 120_000,
        lastSeen: NOW - 120_000,
        moving: true,
        speedMps: 12,
      },
    });
    const rows = buildFleetRows(stateWith([fuel, lost]), [fuel, lost], []);
    const alerts = alertsFor(rows);
    const kinds = new Set(alerts.map((a) => a.kind));
    for (const kind of ['needs-fuel', 'low-power', 'link-lost', 'drifting', 'stale']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    for (const alert of alerts) {
      expect(alert.why.length).toBeGreaterThan(3);
      expect(alert.action.length).toBeGreaterThan(3);
      expect(alert.title).toContain(alert.name);
    }
    expect(alerts[0]!.kind).toBe('needs-fuel');
  });

  it('reports no alerts for a fresh, powered, linked station', () => {
    const a = node({ id: 'a' });
    a.capability = { ...a.capability!, isStatic: true, radioRadiusM: 50_000 };
    a.telemetry = { ...a.telemetry!, batteryPct: 96, chargeState: 'charging', h2Pct: 90, linkStatus: 'up' } as never;
    expect(alertsFor(buildFleetRows(stateWith([a]), [a], []))).toEqual([]);
  });
});

describe('csv export', () => {
  it('writes a header plus one line per row and escapes commas and quotes', () => {
    const a = node({ id: 'a', name: 'SAT,"quoted",0001' });
    const rows = buildFleetRows(stateWith([a]), [a], []);
    const csv = fleetCsv(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('name,role,state');
    expect(lines[1]!.startsWith('"SAT,""quoted"",0001"')).toBe(true);
  });
});
