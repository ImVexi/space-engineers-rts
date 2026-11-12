import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { demoRoutesFor } from '../src/demo/routes.js';
import { designerRoutesFor } from '../src/demo/designer/index.js';
import { memoryStore, makeClock, makeConfig, httpRequest } from './helpers.js';
import type { Store } from '../src/store.js';
import {
  AlertsService,
  ALERT_ACTION_ROUTES,
  ALERT_COOLDOWNS_MS,
  buildAlertContext,
  evaluateConditions,
  readAlertsSettings,
  readCoverageBaseline,
  readDeletedGridIds,
  readKnownGrids,
  writeAlertsSettings,
  type AlertContext,
  type AlertGrid,
  type AlertKnownGrid,
} from '../src/demo/alerts/index.js';
import { computeRunway, estimateRates, parseProfileResult } from '../src/demo/power/index.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { coverageCellsFor, coverageCellsForNodes, loadPlanetCatalog } from '../src/planner/index.js';

const NOW = 1_800_000_000_000;
const GRID = 'grid:100';
const GRID_B = 'grid:200';

/** A profile result shaped like the plugin's read-only `profile` action. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gridId: GRID,
    name: 'SAT-R-0001',
    isStatic: false,
    massKg: 19_000,
    control: { underControl: false, by: null },
    radio: [{ name: 'Antenna', radiusM: 50_000, drawMw: 0.2, enabled: true }],
    laser: [],
    power: {
      batteryStoredMWh: 1.8,
      batteryCapacityMWh: 3,
      batteryPct: 60,
      batteryInputMw: 0.12,
      batteryOutputMw: 0.4,
      chargeState: 'discharging',
      netMw: -0.28,
      solarActualMw: 0.32,
      solarMaxMw: 0.64,
      solarEfficiency: 0.5,
      reactorOutputMw: 0,
      reactorMaxMw: 0,
      antennaDrawMw: 0.2,
      laserDrawMw: 0,
      deviceDrawMw: 0.28,
      uraniumKg: 0,
      uraniumCapacityKg: 0,
      uraniumPct: -1,
      reactors: [],
      solar: [{ name: 'Solar', actualMw: 0.32, maxMw: 0.64 }],
    },
    fuel: {
      h2FillPct: 50,
      tanks: [
        {
          name: 'H2 Tank',
          subtype: 'LargeHydrogenTank',
          filledRatio: 0.5,
          filledL: 7_500_000,
          capacity: 15_000_000,
          stockpile: false,
        },
      ],
    },
    ...overrides,
  };
}

function grid(over: Partial<AlertGrid> = {}): AlertGrid {
  return {
    id: GRID,
    name: 'SAT-R-0001',
    planet: 'EarthLike',
    altitudeM: 45_000,
    zeroG: true,
    isStatic: true,
    reachable: true,
    isBase: false,
    shouldReport: true,
    underControl: false,
    controlledBy: null,
    gate: null,
    lastSeenAt: NOW - 2_000,
    power: parseProfileResult(GRID, profile(), NOW),
    rates: estimateRates([]),
    runwayMin: null,
    powerRunwayMin: null,
    fuelRunwayMin: null,
    uraniumRunwayMin: null,
    radioRangeM: 50_000,
    position: { x: 0, y: 73_000, z: 0 },
    ...over,
  };
}

function context(over: Partial<AlertContext> = {}): AlertContext {
  return {
    now: NOW,
    grids: [grid()],
    executions: [],
    coverage: [],
    simSpeed: null,
    pluginConnected: true,
    baseCount: 1,
    ...over,
  };
}

interface SentMessage {
  url: string;
  body: { content: string; allowed_mentions?: { parse: string[] } };
}

function harness(opts: { ctx: () => AlertContext; webhook?: string; store?: Store; clock?: () => number }) {
  const clock = opts.clock ?? (() => NOW);
  const store = opts.store ?? memoryStore(clock);
  if (opts.webhook) writeAlertsSettings(store, { discordWebhook: opts.webhook }, 'test', clock());
  const sent: SentMessage[] = [];
  const service = new AlertsService({
    store,
    clock,
    context: opts.ctx,
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) as SentMessage['body'] });
      return { ok: true, status: 204 };
    },
    logger: () => {
      /* tests assert audit, not console output */
    },
  });
  return { store, service, sent };
}

describe('T68 alerts: conditions and dedupe', () => {
  it('fires a runway alert, then auto-resolves when the fuel reading recovers', async () => {
    const clock = makeClock(NOW);
    const ctx = context({
      grids: [
        grid({
          runwayMin: 45,
          powerRunwayMin: 45,
          power: parseProfileResult(
            GRID,
            profile({ power: { batteryStoredMWh: 0.4, batteryPct: 14, netMw: -0.55, chargeState: 'discharging' } }),
            NOW,
          ),
        }),
      ],
    });
    const { store, service } = harness({ ctx: () => ctx, clock: clock.now });

    const first = await service.evaluate();
    expect(first.opened).toHaveLength(1);
    const alert = first.opened[0]!;
    expect(alert.kind).toBe('energy-runway');
    expect(alert.severity).toBe('critical');
    expect(alert.state).toBe('open');
    expect(alert.count).toBe(1);
    expect(alert.subjectId).toBe(GRID);
    expect(alert.message).toContain('runs out of battery');
    // Evidence carries the numbers, and the audit log has the opening event.
    expect(alert.evidence.runwayMin).toBe(45);
    expect(store.countAudit('alert_opened', alert.id)).toBe(1);

    // Fuel/battery return: no runway condition any more.
    clock.advance(30_000);
    ctx.now = clock.now();
    ctx.grids = [
      grid({
        runwayMin: null,
        powerRunwayMin: null,
        power: parseProfileResult(
          GRID,
          profile({ power: { batteryStoredMWh: 2.9, batteryPct: 96, netMw: 0.4, chargeState: 'charging' } }),
          clock.now(),
        ),
      }),
    ];

    const second = await service.evaluate();
    expect(second.resolved).toHaveLength(1);
    expect(second.resolved[0]!.id).toBe(alert.id);
    expect(second.resolved[0]!.state).toBe('resolved');
    expect(second.resolved[0]!.resolvedAt).toBe(clock.now());
    expect(store.countAudit('alert_resolved', alert.id)).toBe(1);
    expect(store.listAlertRecords({ state: 'open' })).toHaveLength(0);
  });

  it('never alerts on a null fuel reading (null is not zero)', async () => {
    const unread = parseProfileResult(
      GRID,
      profile({
        power: {
          batteryPct: -1,
          batteryStoredMWh: -1,
          batteryCapacityMWh: -1,
          batteryInputMw: -1,
          batteryOutputMw: -1,
          netMw: -1,
          chargeState: 'unknown',
          solarActualMw: -1,
          solarMaxMw: 0,
          uraniumPct: -1,
        },
        fuel: {},
      }),
      NOW,
    );
    expect(unread.batteryPct).toBeNull();
    expect(unread.h2Pct).toBeNull();
    const runway = computeRunway(unread, estimateRates([]), { zeroG: false });
    expect(runway.runwayMin).toBeNull();

    const ctx = context({
      grids: [
        grid({
          power: unread,
          runwayMin: runway.runwayMin,
          powerRunwayMin: runway.powerRunwayMin,
          fuelRunwayMin: runway.fuelRunwayMin,
          uraniumRunwayMin: runway.uraniumRunwayMin,
        }),
      ],
    });
    const candidates = evaluateConditions(ctx, readAlertsSettings(memoryStore(() => NOW)));
    expect(candidates.filter((c) => c.kind === 'energy-runway')).toHaveLength(0);

    const { store, service } = harness({ ctx: () => ctx });
    const result = await service.evaluate();
    expect(result.opened).toHaveLength(0);
    expect(store.listAlertRecords()).toHaveLength(0);
  });

  it('updates one open alert (count 2) instead of inserting a duplicate', async () => {
    const clock = makeClock(NOW);
    const ctx = context({
      grids: [grid({ runwayMin: 300, powerRunwayMin: 300 })],
    });
    const { store, service } = harness({ ctx: () => ctx, clock: clock.now });

    const first = await service.evaluate();
    expect(first.opened).toHaveLength(1);
    const id = first.opened[0]!.id;
    expect(first.opened[0]!.severity).toBe('warn');

    clock.advance(30_000);
    ctx.now = clock.now();
    const second = await service.evaluate();
    expect(second.opened).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(second.updated[0]!.id).toBe(id);
    expect(second.updated[0]!.count).toBe(2);
    expect(second.updated[0]!.lastSeenAt).toBe(clock.now());

    const rows = store.listAlertRecords();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.firstSeenAt).toBe(NOW);
    expect(store.countAudit('alert_opened', id)).toBe(1);
  });

  it('delivers a critical alert immediately while a warn alert waits for the batch window', async () => {
    const clock = makeClock(NOW);
    const ctx = context({
      grids: [
        grid({ id: GRID, name: 'SAT-R-0001', runwayMin: 30, powerRunwayMin: 30 }),
        grid({
          id: GRID_B,
          name: 'SAT-R-0002',
          runwayMin: 300,
          powerRunwayMin: 300,
          power: parseProfileResult(GRID_B, profile({ gridId: GRID_B, name: 'SAT-R-0002' }), NOW),
        }),
      ],
    });
    const { store, service, sent } = harness({ ctx: () => ctx, clock: clock.now, webhook: 'http://hook.test/alerts' });

    const result = await service.evaluate();
    const opened = result.opened;
    expect(opened.map((a) => a.severity).sort()).toEqual(['critical', 'warn']);
    // One message per alert; the critical one has already left the queue.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.content).toContain('[CRITICAL] energy-runway');
    expect(sent[0]!.body.content).toContain('SAT-R-0001');
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(service.pendingDeliveries).toBe(1);

    expect(await service.flushDelivery(NOW + 4_999)).toBe(0);
    expect(sent).toHaveLength(1);

    expect(await service.flushDelivery(NOW + 5_000)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.content).toContain('[WARN] energy-runway');
    expect(sent[1]!.body.content).toContain('SAT-R-0002');
    expect(service.pendingDeliveries).toBe(0);

    // Audit is written whether or not Discord is configured.
    expect(store.countAudit('alert_delivered', opened[0]!.id)).toBe(1);
  });

  it('audits delivery even with the webhook disabled (default)', async () => {
    const ctx = context({ grids: [grid({ runwayMin: 120, powerRunwayMin: 120 })] });
    const { store, service, sent } = harness({ ctx: () => ctx });
    const result = await service.evaluate();
    expect(result.opened).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(result.delivered[0]!.mode).toBe('disabled');
    expect(store.countAudit('alert_delivered', result.opened[0]!.id)).toBe(1);
    expect(readAlertsSettings(store).discordWebhook).toBe('');
  });

  it('evaluates every required condition and maps each action to a real route', async () => {
    const ctx = context({
      baseCount: 1,
      grids: [
        grid({ id: 'grid:1', name: 'ENERGY', runwayMin: 30, powerRunwayMin: 30 }),
        grid({ id: 'grid:2', name: 'LONELY', reachable: false }),
        grid({ id: 'grid:3', name: 'PILOTED', underControl: true, controlledBy: 'owner' }),
        grid({ id: 'grid:4', name: 'MUTE', lastSeenAt: NOW - 10 * 60_000 }),
        grid({
          id: 'grid:5',
          name: 'LOWFUEL',
          power: parseProfileResult('grid:5', profile({ gridId: 'grid:5', fuel: { h2FillPct: 5 } }), NOW),
        }),
      ],
      executions: [
        { missionId: 'm-failed', gridId: 'grid:6', name: 'FAILED', state: 'failed', reason: 'guard', at: NOW - 1_000 },
        { missionId: 'm-abort', gridId: 'grid:7', name: 'ABORTED', state: 'aborted', reason: 'brake', at: NOW - 1_000 },
      ],
      coverage: [
        {
          planet: 'EarthLike',
          planId: 'plan-1',
          uncoveredCells: 40,
          totalCells: 648,
          coveragePct: 93.8,
          cellDeg: 10,
          k: 1,
          nodeIds: ['grid:1'],
          terrain: 'unavailable',
        },
      ],
      simSpeed: { value: 0.62, threshold: 0.95, belowForMs: 90_000, sampleAt: NOW },
    });

    const candidates = evaluateConditions(ctx, readAlertsSettings(memoryStore(() => NOW)));
    const kinds = new Set(candidates.map((c) => c.kind));
    for (const kind of [
      'energy-runway',
      'grid-isolated',
      'coverage-hole',
      'grid-under-control',
      'mission-failed',
      'mission-aborted',
      'telemetry-stale',
      'sim-speed',
      'needs-refuel',
    ]) {
      expect(kinds.has(kind as never), `missing ${kind}`).toBe(true);
    }

    // Every recommended action names an endpoint that exists in the router.
    const rt = routeRuntime();
    const routes = [
      ...demoRoutesFor({
        config: rt.config,
        store: rt.store,
        hub: rt.hub,
        stateHub: rt.stateHub,
        clock: () => NOW,
        alerts: rt.alerts,
      }),
      ...designerRoutesFor({
        config: rt.config,
        store: rt.store,
        hub: rt.hub,
        stateHub: rt.stateHub,
        clock: () => NOW,
      }),
    ];
    const allActions = candidates.flatMap((c) => c.actions);
    expect(allActions.length).toBeGreaterThan(0);
    for (const action of allActions) {
      const path = new URL(action.endpoint, 'http://localhost').pathname;
      const match = routes.find((r) => r.method === action.method && r.pattern.test(path));
      expect(match, `${action.method} ${action.endpoint} has no route`).toBeTruthy();
      // And the path is one of the declared constants, not a one-off string.
      expect(
        Object.values(ALERT_ACTION_ROUTES).some((r) => r.endpoint === action.endpoint && r.method === action.method),
      ).toBe(true);
    }
  });

  it('has a cooldown per kind and never re-opens a cleared condition inside it', async () => {
    expect(ALERT_COOLDOWNS_MS['energy-runway']).toBeGreaterThan(0);
    expect(ALERT_COOLDOWNS_MS['coverage-hole']).toBeGreaterThan(ALERT_COOLDOWNS_MS['mission-failed']);

    const clock = makeClock(NOW);
    const ctx = context({ grids: [grid({ runwayMin: 30, powerRunwayMin: 30 })] });
    const { store, service } = harness({ ctx: () => ctx, clock: clock.now });

    const fired = await service.evaluate();
    expect(fired.opened).toHaveLength(1);
    const id = fired.opened[0]!.id;

    // Condition clears, then immediately returns (flapping).
    clock.advance(30_000);
    ctx.now = clock.now();
    ctx.grids = [grid({ runwayMin: null })];
    await service.evaluate();
    expect(store.getAlert(id)!.state).toBe('resolved');

    clock.advance(30_000);
    ctx.now = clock.now();
    ctx.grids = [grid({ runwayMin: 30, powerRunwayMin: 30 })];
    const flapped = await service.evaluate();
    expect(flapped.opened).toHaveLength(0);
    expect(store.listAlertRecords()).toHaveLength(1);

    // After the cooldown a fresh alert is allowed.
    clock.advance(ALERT_COOLDOWNS_MS['energy-runway']);
    ctx.now = clock.now();
    ctx.grids = [grid({ runwayMin: 30, powerRunwayMin: 30, lastSeenAt: clock.now() - 1_000 })];
    const again = await service.evaluate();
    expect(again.opened).toHaveLength(1);
    expect(again.opened[0]!.id).not.toBe(id);
  });
});

// ------------------------------------------------- node loss / coverage drops
function knownGrid(over: Partial<AlertKnownGrid> = {}): AlertKnownGrid {
  return {
    id: GRID,
    name: 'SAT-R-0001',
    planet: 'EarthLike',
    altitudeM: 6_091,
    position: { x: -60_537, y: -26_950, z: 4_666 },
    lastSeenAt: NOW - 2_000,
    linkedTo: [{ id: GRID_B, name: 'SAT-R-0002', kind: 'radio', distanceM: 4_735 }],
    ...over,
  };
}

function coverageView(over: Partial<AlertContext['coverage'][number]> = {}): AlertContext['coverage'][number] {
  return {
    planet: 'EarthLike',
    planId: 'plan-1',
    uncoveredCells: 389,
    totalCells: 648,
    coveragePct: 40,
    cellDeg: 10,
    k: 1,
    nodeIds: [GRID],
    terrain: 'unavailable',
    ...over,
  };
}

/** Minimal hub stand-in: no socket, no live server, just the liveness bit. */
function fakeHub(connected: boolean) {
  return {
    isConnected: () => connected,
    send: () => true,
    agentId: () => (connected ? 'fake-agent' : null),
    lastStatus: () => null,
  };
}

describe('T68 alerts: lost node and coverage drop', () => {
  it('raises grid-lost once when a known grid stops reporting, then increments its count', async () => {
    const clock = makeClock(NOW);
    const ctx = context({
      grids: [grid({ lastSeenAt: NOW - 2_000 })],
      knownGrids: [knownGrid()],
      deletedGridIds: [],
    });
    const { store, service } = harness({ ctx: () => ctx, clock: clock.now });

    // 2 s old: the grid is alive; nothing fires.
    const alive = await service.evaluate();
    expect(alive.opened).toHaveLength(0);

    clock.advance(61_000);
    ctx.now = clock.now();
    // Still listed by the plugin, but no telemetry since NOW-2s: 63 s > 2 polls.
    ctx.grids = [grid({ lastSeenAt: NOW - 2_000, reachable: false })];
    const first = await service.evaluate();
    expect(first.opened).toHaveLength(1);
    const alert = first.opened[0]!;
    expect(alert.kind).toBe('grid-lost');
    expect(alert.severity).toBe('critical');
    expect(alert.subjectId).toBe(GRID);
    expect(alert.message).toContain('SAT-R-0001');
    expect(alert.message).toContain('(-60537, -26950, 4666)');
    expect(alert.message).toContain('6091 m AGL over EarthLike');
    expect(alert.message).toContain('SAT-R-0002');
    expect(alert.evidence.lastSeenAt).toBe(NOW - 2_000);
    expect((alert.evidence.linkedTo as { id: string }[])[0]!.id).toBe(GRID_B);

    // Still missing: the same row increments; no duplicate.
    clock.advance(30_000);
    ctx.now = clock.now();
    const second = await service.evaluate();
    expect(second.opened).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(second.updated[0]!.id).toBe(alert.id);
    expect(second.updated[0]!.count).toBe(2);

    // Past the 120 s telemetry-stale limit too: grid-lost owns the grid, so no
    // second telemetry-stale row appears for the same disappearance.
    clock.advance(60_000);
    ctx.now = clock.now();
    const third = await service.evaluate();
    expect(third.opened).toHaveLength(0);
    expect(third.updated[0]!.count).toBe(3);
    expect(store.listAlertRecords()).toHaveLength(1);
    expect(store.listAlertRecords({ kind: 'telemetry-stale' })).toHaveLength(0);
  });

  it('does not raise grid-lost for a grid deleted through our own API', async () => {
    const store = memoryStore(() => NOW);
    // Exactly what the designer delete_grid route writes on success.
    store.audit({
      actor: 'designer',
      action: 'designer_plugin_action',
      subject: 'delete_grid',
      detail: { params: { action: 'delete_grid', entityId: GRID }, ok: true },
      at: NOW - 1_000,
    });
    const deleted = readDeletedGridIds(store);
    expect(deleted.has(GRID)).toBe(true);

    const ctx = context({
      now: NOW + 300_000,
      grids: [], // gone from the list entirely
      knownGrids: [knownGrid()],
      deletedGridIds: [...deleted],
    });
    const { service } = harness({ ctx: () => ctx, store, clock: () => ctx.now });
    const result = await service.evaluate();
    expect(result.opened.filter((row) => row.kind === 'grid-lost')).toHaveLength(0);

    // A FAILED delete must not suppress a real loss.
    const failedStore = memoryStore(() => NOW);
    failedStore.audit({
      actor: 'designer',
      action: 'designer_plugin_action',
      subject: 'delete_grid',
      detail: { params: { entityId: GRID }, ok: false },
      at: NOW - 1_000,
    });
    expect(readDeletedGridIds(failedStore).has(GRID)).toBe(false);
  });

  it('raises coverage-drop with delta -7 when coverage falls 40 % -> 33 %', async () => {
    const store = memoryStore(() => NOW);
    // Isolate the delta from the under-goal branch.
    writeAlertsSettings(store, { coverageGoalPct: 0 }, 'test', NOW);
    const ctx = context({
      coverage: [coverageView({ coveragePct: 33, uncoveredCells: 434 })],
      coverageBaseline: [{ planet: 'EarthLike', coveragePct: 40, at: NOW - 60_000 }],
    });
    const { service } = harness({ ctx: () => ctx, store });
    const result = await service.evaluate();
    const alert = result.opened.find((row) => row.kind === 'coverage-drop')!;
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warn');
    expect(alert.subjectId).toBe('EarthLike');
    expect(alert.evidence.deltaPct).toBe(-7);
    expect(alert.evidence.previousPct).toBe(40);
    expect(alert.message).toContain('-7.0');
    expect(alert.message).toContain('EarthLike');

    // A sample older than the 30 min window is not a baseline for a drop.
    ctx.coverageBaseline = [{ planet: 'EarthLike', coveragePct: 40, at: NOW - 31 * 60_000 }];
    const candidates = evaluateConditions(ctx, readAlertsSettings(store));
    expect(candidates.filter((row) => row.kind === 'coverage-drop')).toHaveLength(0);
  });

  it('suppresses grid-lost while the plugin link is down and raises the link alert instead', () => {
    const ctx = context({
      pluginConnected: false,
      grids: [grid({ lastSeenAt: NOW - 300_000, reachable: false })],
      knownGrids: [knownGrid({ lastSeenAt: NOW - 300_000 })],
    });
    const candidates = evaluateConditions(ctx, readAlertsSettings(memoryStore(() => NOW)));
    const kinds = candidates.map((row) => row.kind);
    expect(kinds).toContain('plugin-link-down');
    expect(kinds).not.toContain('grid-lost');
    expect(kinds).not.toContain('telemetry-stale');
    const link = candidates.find((row) => row.kind === 'plugin-link-down')!;
    expect(link.severity).toBe('critical');
    expect(link.subjectType).toBe('system');
    expect(link.subjectId).toBe('plugin');
  });

  it('raises coverage-drop below the goal for a planet with an active plan, and not without one', () => {
    const settings = readAlertsSettings(memoryStore(() => NOW));
    const withPlan = evaluateConditions(
      context({ coverage: [coverageView({ coveragePct: 40, planId: 'plan-1' })] }),
      settings,
    );
    const drop = withPlan.find((row) => row.kind === 'coverage-drop')!;
    expect(drop).toBeDefined();
    expect(drop.severity).toBe('warn');
    expect(drop.evidence.underGoal).toBe(true);
    expect(drop.message).toContain('goal');

    // No active plan: the same percentage is not an under-goal alert.
    const noPlan = evaluateConditions(
      context({ coverage: [coverageView({ coveragePct: 40, planId: null })] }),
      settings,
    );
    expect(noPlan.filter((row) => row.kind === 'coverage-drop')).toHaveLength(0);
  });

  it('stores the coverage sample and the grid registry, and an API deletion survives a real context pass', () => {
    const EARTH = loadPlanetCatalog().find((planet) => planet.name === 'EarthLike')!;
    const BASE = 'grid:900';
    const SAT1 = 'grid:901';
    const SAT2 = 'grid:902';
    const at = (latDeg: number, lonDeg: number, altitudeM: number) => {
      const lat = (latDeg * Math.PI) / 180;
      const lon = (lonDeg * Math.PI) / 180;
      const radius = EARTH.surfaceRadiusM + altitudeM;
      return {
        x: EARTH.center.x + radius * Math.cos(lat) * Math.cos(lon),
        y: EARTH.center.y + radius * Math.sin(lat),
        z: EARTH.center.z + radius * Math.cos(lat) * Math.sin(lon),
      };
    };
    const clock = makeClock(NOW);
    const store = memoryStore(clock.now);
    store.setKv(
      PROVISION_CAPABILITIES_KV,
      JSON.stringify({
        at: NOW,
        grids: [
          { gridId: BASE, name: 'BASE-01', profile: 'BASE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 0, isStatic: true, updatedAt: NOW },
          { gridId: SAT1, name: 'SAT-L-0001', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 2, massKg: 19_000, isStatic: false, updatedAt: NOW },
          { gridId: SAT2, name: 'SAT-L-0002', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 2, massKg: 19_000, isStatic: false, updatedAt: NOW },
        ],
      }),
    );
    const place = [
      { id: BASE, name: 'BASE-01', position: at(0, 0, 500) },
      { id: SAT1, name: 'SAT-L-0001', position: at(10, 10, 6_000) },
      { id: SAT2, name: 'SAT-L-0002', position: at(-10, -10, 6_000) },
    ];
    const touch = (gridSpec: (typeof place)[number], atMs: number): void => {
      store.upsertUnit({
        id: gridSpec.id,
        name: gridSpec.name,
        specId: null,
        station: null,
        linkStatus: 'up',
        lastSeen: atMs,
        pos: gridSpec.position,
        vel: null,
        meta: {},
      });
    };
    for (const gridSpec of place) touch(gridSpec, clock.now());
    store.setKv(
      'designer:lastPlan',
      JSON.stringify({ id: 'plan-live', input: { planet: 'EarthLike', cellDeg: 10, k: 1, rangeMargin: 0.9 } }),
    );

    const hub = fakeHub(true);
    const deps = {
      store,
      clock: clock.now,
      fixturePath: null,
      settings: () => readAlertsSettings(store),
      pluginConnected: () => hub.isConnected(),
    };

    const first = buildAlertContext(deps);
    expect(first.pluginConnected).toBe(true);
    expect(first.knownGrids?.map((row) => row.id)).toEqual(expect.arrayContaining([BASE, SAT1, SAT2]));
    expect(first.coverageBaseline).toEqual([]);
    expect(first.coverage[0]?.nodeIds).toEqual(expect.arrayContaining([SAT1, SAT2]));
    expect(first.coverage[0]?.totalCells).toBe(648);
    const stored = readCoverageBaseline(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.planet).toBe('EarthLike');
    expect(stored[0]!.coveragePct).toBe(first.coverage[0]!.coveragePct);
    expect(stored[0]!.at).toBe(NOW);

    // SAT2's telemetry stops and the owner deletes it through our API.
    clock.advance(61_000);
    touch(place[0]!, clock.now());
    touch(place[1]!, clock.now());
    store.audit({
      actor: 'designer',
      action: 'designer_plugin_action',
      subject: 'delete_grid',
      detail: { params: { entityId: SAT2 }, ok: true },
      at: clock.now(),
    });

    const second = buildAlertContext(deps);
    expect(second.deletedGridIds).toContain(SAT2);
    expect(second.knownGrids?.map((row) => row.id)).not.toContain(SAT2);
    // The lost node no longer contributes to live coverage either.
    expect(second.coverage[0]?.nodeIds).not.toContain(SAT2);
    expect(second.coverageBaseline?.[0]?.coveragePct).toBe(first.coverage[0]!.coveragePct);
    const lost = evaluateConditions(second, readAlertsSettings(store)).filter((row) => row.kind === 'grid-lost');
    expect(lost).toHaveLength(0);
    expect(readKnownGrids(store).map((row) => row.id)).not.toContain(SAT2);
  });

  it('shows why a deleted relay can change zero cells: any-node coverage', () => {
    const EARTH = loadPlanetCatalog().find((planet) => planet.name === 'EarthLike')!;
    const at = (latDeg: number, lonDeg: number, altitudeM: number) => {
      const lat = (latDeg * Math.PI) / 180;
      const lon = (lonDeg * Math.PI) / 180;
      const radius = EARTH.surfaceRadiusM + altitudeM;
      return {
        x: EARTH.center.x + radius * Math.cos(lat) * Math.cos(lon),
        y: EARTH.center.y + radius * Math.sin(lat),
        z: EARTH.center.z + radius * Math.cos(lat) * Math.sin(lon),
      };
    };
    const cells = coverageCellsFor(EARTH, 10);
    const relay = { id: 'relay', position: at(0, 0, 6_000) };
    const duplicate = { id: 'duplicate', position: at(0, 0, 6_000) };
    const unique = { id: 'unique', position: at(55, 130, 6_000) };

    const withBoth = coverageCellsForNodes(EARTH, cells, [relay, duplicate], 45_000, 1, null);
    const withoutDuplicate = coverageCellsForNodes(EARTH, cells, [relay], 45_000, 1, null);
    // A fully overlapped relay is redundant: removing it changes 0 cells.
    expect(withoutDuplicate.coveredCells).toBe(withBoth.coveredCells);

    const withUnique = coverageCellsForNodes(EARTH, cells, [relay, unique], 45_000, 1, null);
    const withoutUnique = coverageCellsForNodes(EARTH, cells, [relay], 45_000, 1, null);
    // A relay covering cells nobody else reaches does change the number.
    expect(withoutUnique.coveredCells).toBeLessThan(withUnique.coveredCells);
  });
});

// ------------------------------------------------------------------ HTTP routes
const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const savedEnv: Record<string, string | undefined> = {};
let runtime: Runtime;
let port = 0;

function routeRuntime(): Runtime {
  if (!runtime) {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
    runtime = createRuntime({ config: makeConfig(), clock: () => NOW });
  }
  return runtime;
}

describe('T68 alerts: HTTP routes', () => {
  beforeAll(async () => {
    const rt = routeRuntime();
    port = await rt.listen(0);
  });

  afterAll(async () => {
    if (runtime) await runtime.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('GET /api/alerts filters by state and severity', async () => {
    const store = runtime.store;
    const warn = store.createAlert({
      kind: 'energy-runway',
      severity: 'warn',
      subjectType: 'grid',
      subjectId: 'grid:filter-warn',
      message: 'warn alert',
      evidence: { runwayMin: 120 },
      actions: [],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    const critical = store.createAlert({
      kind: 'sim-speed',
      severity: 'critical',
      subjectType: 'system',
      subjectId: 'sim',
      message: 'critical alert',
      evidence: { value: 0.5 },
      actions: [],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });

    const open = await httpRequest<{ alerts: { id: string }[]; counts: { open: number } }>(
      port,
      'GET',
      '/api/alerts?state=open',
    );
    expect(open.status).toBe(200);
    const openIds = open.body.alerts.map((a) => a.id);
    expect(openIds).toContain(warn.id);
    expect(openIds).toContain(critical.id);

    const criticalOnly = await httpRequest<{ alerts: { id: string; severity: string }[] }>(
      port,
      'GET',
      '/api/alerts?severity=critical',
    );
    expect(criticalOnly.body.alerts.map((a) => a.id)).toEqual([critical.id]);

    const bad = await httpRequest(port, 'GET', '/api/alerts?severity=nope');
    expect(bad.status).toBe(400);
  });

  it('POST /api/alerts/:id/ack sets the state and writes an audit line', async () => {
    const store = runtime.store;
    const alert = store.createAlert({
      kind: 'grid-isolated',
      severity: 'warn',
      subjectType: 'grid',
      subjectId: 'grid:ack',
      message: 'isolated',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    expect(store.countAudit('alert_acked', alert.id)).toBe(0);

    const res = await httpRequest<{ alert: { state: string; ackedBy: string }; audit: string }>(
      port,
      'POST',
      `/api/alerts/${alert.id}/ack`,
      { by: 'vexx' },
      'token',
    );
    expect(res.status).toBe(200);
    expect(res.body.alert.state).toBe('acked');
    expect(res.body.alert.ackedBy).toBe('vexx');
    expect(res.body.audit).toBe('alert_acked');
    expect(store.getAlert(alert.id)!.state).toBe('acked');
    expect(store.countAudit('alert_acked', alert.id)).toBe(1);

    const resolved = await httpRequest<{ alert: { state: string; resolvedAt: number } }>(
      port,
      'POST',
      `/api/alerts/${alert.id}/resolve`,
      { by: 'vexx' },
      'token',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.alert.state).toBe('resolved');
    expect(store.getAlert(alert.id)!.resolvedAt).not.toBeNull();
    expect(store.countAudit('alert_resolved', alert.id)).toBe(1);

    // Resolved alerts cannot be acknowledged (no fake ack on a cleared one).
    const late = await httpRequest(port, 'POST', `/api/alerts/${alert.id}/ack`, {}, 'token');
    expect(late.status).toBe(409);
    expect((late.body as { error: { code: string } }).error.code).toBe('alert_resolved');

    const missing = await httpRequest(port, 'POST', '/api/alerts/nope/ack', {}, 'token');
    expect(missing.status).toBe(404);
  });

  it('POST /api/alerts/evaluate runs the engine on demand', async () => {
    const res = await httpRequest<{ evaluatedAt: number; opened: unknown[]; summary: { open: number } }>(
      port,
      'POST',
      '/api/alerts/evaluate',
      {},
      'token',
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.evaluatedAt).toBe('number');
    expect(Array.isArray(res.body.opened)).toBe(true);
    expect(typeof res.body.summary.open).toBe('number');
  });

  it('alerts settings default to disabled and reject a non-http webhook', async () => {
    const defaults = await httpRequest<{ settings: { webhookConfigured: boolean; discordWebhook: string } }>(
      port,
      'GET',
      '/api/alerts/settings',
      undefined,
      'token',
    );
    expect(defaults.status).toBe(200);
    expect(defaults.body.settings.webhookConfigured).toBe(false);
    expect(defaults.body.settings.discordWebhook).toBe('');

    const bad = await httpRequest(port, 'PUT', '/api/alerts/settings', { discordWebhook: 'javascript:alert(1)' }, 'token');
    // zod accepts the string, the validator maps it to '' (disabled), never a bad URL.
    expect(bad.status).toBe(200);
    expect((bad.body as { settings: { webhookConfigured: boolean } }).settings.webhookConfigured).toBe(false);

    const set = await httpRequest<{ settings: { webhookConfigured: boolean } }>(
      port,
      'PUT',
      '/api/alerts/settings',
      { discordWebhook: 'https://discord.example/api/webhooks/1/abc', batchMs: 5_000 },
      'token',
    );
    expect(set.status).toBe(200);
    expect(set.body.settings.webhookConfigured).toBe(true);
    expect(readAlertsSettings(runtime.store).discordWebhook).toBe('https://discord.example/api/webhooks/1/abc');
  });
});
