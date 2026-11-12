import { describe, expect, it, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { Store, type UnitRecord } from '../src/store.js';
import { openDb } from '../src/db.js';
import { shipRoles, type RoleHint } from '../src/demo/roles.js';
import { planetByName } from '../src/demo/world.js';
import type { PowerPoller, PowerSnapshot } from '../src/demo/power/index.js';
import type { PowerSample } from '../src/demo/power/rates.js';
import { DemoHttpError, demoRoutesFor } from '../src/demo/routes.js';
import {
  BASE_HULL_CLEARANCE_M,
  HOME_POINT_MAX_AGL_M,
  SURVIVAL_DEFAULT_MARGIN_PCT,
  SURVIVAL_RESERVE_PCT,
  SURVIVAL_TEST_RUNWAY_TTL_MS,
  bankTotals,
  chooseLandingSpot,
  distanceM,
  evaluateResourceNeed,
  evaluateReturnNeed,
  formatHomePointKey,
  normaliseSettings,
  parseHomePointKey,
  readiness,
  retryReason,
  runwayOverrideActive,
  testIgnoreReachActive,
  resolveHome,
  survivalView,
  tripResources,
  validateHomePoint,
  blankRecord,
} from '../src/demo/survival/loop.js';
import { SurvivalService } from '../src/demo/survival/service.js';
import { PREFAB_HARDWARE } from '../src/demo/endurance/index.js';

const NOW = 1_700_000_000_000;
const SURVIVAL_SRC = new URL('../src/demo/survival/', import.meta.url).pathname;

function memStore(): Store {
  return new Store(openDb(':memory:', { memory: true }), () => NOW);
}

/** A grid at `altitudeM` AGL on EarthLike, `offsetM` east of the base column. */
function grid(id: string, name: string, altitudeM: number, offsetM = 0): UnitRecord {
  const planet = planetByName('EarthLike')!;
  const r = planet.surfaceRadiusM + altitudeM;
  return {
    id,
    name,
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: planet.center.x + offsetM, y: planet.center.y + r, z: planet.center.z },
    vel: { x: 0, y: 0, z: 0 },
    meta: {},
  };
}

const hint = (role: RoleHint['role']): RoleHint => ({ role, source: 'block-name', token: `[${role}]` });

function baseSnapshot(patch: Partial<PowerSnapshot> = {}): PowerSnapshot {
  return {
    gridId: 'G-SAT',
    name: 'SAT-L-0007',
    at: NOW,
    gameAt: NOW,
    isStatic: true,
    massKg: 10_000,
    underControl: false,
    controlledBy: null,
    batteryStoredMWh: 2,
    batteryMaxMWh: 2,
    batteryPct: 100,
    batteryState: 'read',
    batteryUnreadReason: null,
    batteryInputMw: 0,
    batteryOutputMw: 0,
    charge: 'idle',
    netMw: 0,
    generationMw: 0,
    consumerDrawMw: 0,
    batteryChargeMw: 0,
    solarActualMw: 0,
    solarMaxMw: 0,
    solarEfficiency: null,
    reactorOutputMw: 0,
    reactorMaxMw: 0,
    antennaDrawMw: 0.01,
    laserDrawMw: 0,
    deviceDrawMw: 0.01,
    h2Litres: 19_000,
    h2CapacityLitres: 50_000,
    h2Pct: 38,
    h2State: 'read',
    h2UnreadReason: null,
    h2TankCount: 1,
    uraniumKg: null,
    uraniumCapacityKg: null,
    uraniumPct: null,
    radioRangeM: 50_000,
    laserRangeM: null,
    radio: [],
    lasers: [],
    reactors: [],
    tanks: [],
    solar: [],
    missing: [],
    ...patch,
  };
}

/** -1 %/h H2 so `computeRunway` gives 38/1*60 = 2280 min at 38 %. */
function samples(): PowerSample[] {
  return [
    { at: NOW - 120_000, batteryPct: 100, h2Pct: 40, h2Litres: 20_000, uraniumKg: null, solarPct: 0, netMw: 0 },
    { at: NOW, batteryPct: 100, h2Pct: 38, h2Litres: 19_000, uraniumKg: null, solarPct: 0, netMw: 0 },
  ];
}

function fakePower(snap: PowerSnapshot, series: PowerSample[] = samples()): PowerPoller {
  return {
    snapshot: (gridId: string) => (gridId === snap.gridId ? snap : gridId === 'G-BASE' ? baseSnapshot({ gridId: 'G-BASE', name: 'BASE-01', h2Pct: 100, batteryPct: 100, h2CapacityLitres: 1_000_000, batteryMaxMWh: 10 }) : null),
    series: () => series,
  } as unknown as PowerPoller;
}

function service(args: {
  store: Store;
  power?: PowerPoller | null;
  summary?: () => Record<string, unknown>;
  gate?: boolean;
  now?: number;
  /** Default: the demo/test world (survival OFF), like the test LXC. */
  survivalMode?: boolean;
  demoEnv?: boolean;
  /** Ground seam for a home POINT; default: a level-5 sample at the surface. */
  ground?: { radiusM: number; level: number | null; source: string } | null;
}): SurvivalService {
  const planet = planetByName('EarthLike')!;
  return new SurvivalService({
    store: args.store,
    power: args.power ?? null,
    executor: { summary: args.summary ?? (() => ({ executions: [] })) },
    clock: () => args.now ?? NOW,
    survivalMode: () => args.survivalMode ?? false,
    demoEnv: () => args.demoEnv ?? true,
    homePointGround: () =>
      args.ground === undefined
        ? { radiusM: planet.surfaceRadiusM, level: 5, source: 'terrain-l5' }
        : args.ground,
    gateFor: () => ({ allowed: args.gate ?? true, nodeId: 'G-SAT', reason: args.gate === false ? 'no path to a control source' : 'ok' }),
  });
}

function seed(store: Store, opts: { shipRole?: RoleHint['role']; shipAltM?: number; offsetM?: number; shipSnapshot?: Partial<PowerSnapshot> } = {}): void {
  // 4 km from the base: a low tank still covers the trip (the launch gate).
  store.upsertUnit(grid('G-SAT', 'SAT-L-0007', opts.shipAltM ?? 30_000, opts.offsetM ?? 4_000));
  store.upsertUnit(grid('G-BASE', 'BASE-01', 1_800));
  shipRoles.noteInGame(
    store,
    [
      { gridId: 'G-BASE', name: 'BASE-01', hints: [hint('base')] },
      ...(opts.shipRole ? [{ gridId: 'G-SAT', name: 'SAT-L-0007', hints: [hint(opts.shipRole)] }] : []),
    ],
    NOW,
  );
}

/** The demo routes with just the survival service attached (route contract tests). */
function routesFor(store: Store, survival: SurvivalService) {
  return demoRoutesFor({
    config: {} as never,
    store,
    hub: { isConnected: () => false } as never,
    stateHub: { broadcast: () => undefined } as never,
    clock: () => NOW,
    survival,
  });
}

/** Call a POST route with a JSON body, capturing the status and body or error. */
async function post(
  routes: ReturnType<typeof demoRoutesFor>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const route = routes.find((candidate) => candidate.method === 'POST' && candidate.pattern.test(path));
  if (!route) throw new Error(`no POST route for ${path}; have ${routes.filter((r) => r.method === 'POST').map((r) => r.pattern.source).join(', ')}`);
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(code: number) {
      captured.status = code;
      return res;
    },
    end(payload?: string | Buffer) {
      captured.body = String(payload ?? '');
    },
  } as unknown as http.ServerResponse;
  try {
    await route.handler({ req, res, params: [], url: new URL(`http://x${path}`) });
  } catch (err) {
    const failure = err as DemoHttpError;
    captured.status = failure.status ?? 500;
    captured.body = JSON.stringify({ code: failure.code, message: failure.message, raw: failure.message ?? String(err) });
  }
  return captured;
}

beforeEach(() => shipRoles.reset());
describe('T66 trigger: runway vs the trip home plus reserve', () => {
  it('gives the requirement in percent, with the trip, the 15 % reserve and the margin', () => {
    // runway 60 min at 18 % -> the tank is worth 333 min; 60 km at 100 m/s =
    // 10 min transit + 3 min landing = 13 min = 3.9 % of the tank.
    const need = evaluateResourceNeed({
      reading: { pct: 18, runwayMin: 118.3 },
      distanceM: 60_000,
      homeAltitudeM: null,
      altitudeM: null,
      marginPct: SURVIVAL_DEFAULT_MARGIN_PCT,
      homeLabel: 'BASE-01',
      resource: 'fuel',
    });
    expect(need.tripMin).toBeCloseTo(13, 5);
    // full tank = 118.3 / 18 * 100 = 657.2 min, so 13 min is 1.98 %.
    expect(need.tripPct).toBeCloseTo((13 / ((118.3 / 18) * 100)) * 100, 5);
    expect(need.requiredPct).toBeCloseTo(need.tripPct! + SURVIVAL_RESERVE_PCT, 5);
    expect(need.thresholdPct).toBeCloseTo(need.requiredPct! * 1.2, 5);
  });

  it('triggers below threshold and not above it, and the margin is what moves the line', () => {
    const args = {
      reading: { pct: 20, runwayMin: 240 }, // 1200 min tank
      distanceM: 60_000,
      homeAltitudeM: 1_800,
      altitudeM: 0,
      homeLabel: 'BASE-01',
      resource: 'fuel' as const,
    };
    const tight = evaluateResourceNeed({ ...args, marginPct: 0 });
    const loose = evaluateResourceNeed({ ...args, marginPct: 100 });
    // trip = 10 + 0.3 + 3 = 13.3 min -> 1.11 % + 15 = 16.1 %; 20 % is enough.
    expect(tight.trigger).toBe(false);
    expect(loose.trigger).toBe(true);
    expect(loose.reason).toContain('needs 16');
  });

  it('never fires on an unknown reading (null is not zero)', () => {
    const need = evaluateResourceNeed({
      reading: { pct: null, runwayMin: null },
      distanceM: 60_000,
      homeAltitudeM: null,
      altitudeM: null,
      marginPct: 20,
      homeLabel: 'BASE-01',
      resource: 'fuel',
    });
    expect(need.trigger).toBe(false);
    expect(need.reason).toContain('unknown reading');
    const both = evaluateReturnNeed({
      fuel: { pct: null, runwayMin: null },
      power: { pct: null, runwayMin: null },
      distanceM: 60_000,
      homeAltitudeM: null,
      altitudeM: null,
      marginPct: 20,
      homeLabel: 'BASE-01',
    });
    expect(both.trigger).toBe(false);
    expect(both.resource).toBeNull();
  });

  it('a resource with no projected drain is not judged, and the draining one decides', () => {
    const need = evaluateReturnNeed({
      fuel: { pct: 8, runwayMin: 480 }, // draining
      power: { pct: 100, runwayMin: null }, // net positive, no runway
      distanceM: 300_000,
      homeAltitudeM: 1_800,
      altitudeM: 30_000,
      marginPct: 20,
      homeLabel: 'BASE-01',
    });
    expect(need.resource).toBe('fuel');
    expect(need.trigger).toBe(true);
    expect(need.reason).toContain('H2 8 %');
  });

  it('clamps settings to honest ranges', () => {
    expect(normaliseSettings({ marginPct: -5, relaunchPct: 300 }).marginPct).toBe(0);
    expect(normaliseSettings({ relaunchPct: 300 }).relaunchPct).toBe(100);
    expect(normaliseSettings(null).approvalMode).toBe('auto');
    expect(normaliseSettings({ approvalMode: 'approve' }).approvalMode).toBe('approve');
  });

  it('READY requires every known reading to cross, and no reading is not ready', () => {
    expect(readiness({ fuelPct: 91, batteryPct: 95, relaunchPct: 90 }).ready).toBe(true);
    expect(readiness({ fuelPct: 91, batteryPct: 70, relaunchPct: 90 }).ready).toBe(false);
    expect(readiness({ fuelPct: null, batteryPct: 95, relaunchPct: 90 }).ready).toBe(true);
    // But a grid that came home on H2 is not ready on an unread H2 tank.
    expect(readiness({ fuelPct: null, batteryPct: 95, relaunchPct: 90, required: ['fuel'] }).ready).toBe(false);
    expect(readiness({ fuelPct: null, batteryPct: null, relaunchPct: 90 }).ready).toBe(false);
  });
});

describe('T66 home: override, flagged home, nearest charging base', () => {
  const base = (id: string, name: string, offsetM: number, hasCharge = true) => ({
    gridId: id,
    name,
    position: { x: offsetM, y: 0, z: 0 },
    altitudeM: 1_800,
    hasCharge,
  });

  it('a per-ship override beats the flagged home', () => {
    const res = resolveHome({
      gridId: 'ship',
      position: { x: 0, y: 0, z: 0 },
      candidates: [base('b1', 'BASE-01', 100), base('b2', 'BASE-02', 900)],
      overrides: { ship: 'BASE-02' },
      defaultHomeId: 'b1',
    });
    expect(res.home?.name).toBe('BASE-02');
    expect(res.source).toBe('override');
  });

  it('defaults to BASE-01 when nothing is flagged', () => {
    const res = resolveHome({
      gridId: 'ship',
      position: { x: 0, y: 0, z: 0 },
      candidates: [base('b2', 'BASE-02', 10), base('b1', 'BASE-01', 900)],
    });
    expect(res.home?.name).toBe('BASE-01');
    expect(res.source).toBe('named');
  });

  it('falls back to the nearest base with a charging bay, and refuses plainly when there is none', () => {
    const near = resolveHome({
      gridId: 'ship',
      position: { x: 0, y: 0, z: 0 },
      candidates: [base('b2', 'FAR', 9000), base('b3', 'NEAR', 100)],
    });
    expect(near.home?.name).toBe('NEAR');
    expect(near.source).toBe('nearest');
    const none = resolveHome({ gridId: 'ship', position: { x: 0, y: 0, z: 0 }, candidates: [] });
    expect(none.home).toBeNull();
    expect(none.reason).toContain('no home');
  });
});

describe('T66 landing spot: beside the base, clear of hulls and other grids', () => {
  const planetCenter = { x: 0, y: -60_000, z: 0 };
  const home = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: 0 };

  it('keeps the base hull clearance and picks a free bearing', () => {
    const res = chooseLandingSpot({ home, planetCenter, baseHullRadiusM: 40, incomingFrom: { x: 1000, y: 0, z: 0 } });
    expect(res.spot).not.toBeNull();
    expect(res.spot!.point).not.toEqual(up);
    const dist = Math.hypot(res.spot!.point.x, res.spot!.point.y, res.spot!.point.z);
    expect(dist).toBeGreaterThanOrEqual(40 + BASE_HULL_CLEARANCE_M);
    expect(res.spot!.clearanceM).toBeGreaterThanOrEqual(0);
  });

  it('skips a bearing occupied by another landed grid and still reports the clearance', () => {
    // Block every point on the first ring except the +x side by putting a big
    // keep-out right on the west half.
    const res = chooseLandingSpot({
      home,
      planetCenter,
      baseHullRadiusM: 40,
      incomingFrom: { x: 1000, y: 0, z: 0 },
      obstacles: [{ gridId: 'other', position: { x: -200, y: 0, z: 0 }, radiusM: 200 }],
    });
    expect(res.spot).not.toBeNull();
    expect(res.spot!.point.x).toBeGreaterThan(0);
    expect(res.spot!.clearanceM).toBeGreaterThan(0);
  });

  it('refuses honestly when every ring is blocked', () => {
    const obstacles = Array.from({ length: 8 }, (_, i) => ({
      gridId: `g${i}`,
      position: {
        x: Math.cos((i * 45 * Math.PI) / 180) * 150,
        y: Math.sin((i * 45 * Math.PI) / 180) * 150,
        z: 0,
      },
      radiusM: 400,
    }));
    const res = chooseLandingSpot({ home, planetCenter, baseHullRadiusM: 40, obstacles, rings: [150], bearings: [0, 45, 90, 135, 180, 225, 270, 315] });
    expect(res.spot).toBeNull();
    expect(res.reason).toContain('no free landing spot');
  });
});

describe('T66 service: roles, pilot, state machine, relaunch approval', () => {
  it('auto-starts a MANAGED return, lands, flags NEEDS_REFUEL, then waits for the owner', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    const tick = svc.tick(NOW);
    expect(tick.started).toEqual(['G-SAT']);

    const rec = svc.record('G-SAT')!;
    expect(rec.state).toBe('RETURNING');
    expect(rec.need?.trigger).toBe(true);
    expect(rec.home?.name).toBe('BASE-01');
    // The landing point is beside the base, not on it.
    expect(Math.hypot(rec.landing!.point.x - (planetByName('EarthLike')!.center.x), rec.landing!.point.y - (planetByName('EarthLike')!.center.y + planetByName('EarthLike')!.surfaceRadiusM + 1800))).toBeGreaterThan(BASE_HULL_CLEARANCE_M);

    const missions = store.listMissions();
    expect(missions).toHaveLength(1);
    expect(missions[0]!.status).toBe('approved');
    expect(missions[0]!.desiredState.land).toBe(true);
    expect(String(missions[0]!.plan.notes)).toContain('nothing is spawned or teleported');

    // Touchdown: the executor reports the drone holding and the mission done.
    const missionId = rec.missionId!;
    store.updateMission(missionId, { status: 'done' }, NOW + 60_000);
    const done = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 12 })),
      now: NOW + 60_000,
      summary: () => ({ executions: [{ missionId, drones: [{ state: 'holding', gridId: 'G-SAT' }] }] }),
    });
    done.tick(NOW + 60_000);
    const landed = done.record('G-SAT')!;
    expect(landed.state).toBe('NEEDS_REFUEL');
    expect(landed.needsRefuel).toBe(true);
    expect(survivalView(landed).slotStatus).toBe('vacant (refuelling)');
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_needs_refuel')).toBe(true);

    // Refuelled -> READY, and still no flight until the owner confirms.
    const refuelled = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 95 })),
      now: NOW + 120_000,
      summary: () => ({ executions: [] }),
    });
    refuelled.tick(NOW + 120_000);
    expect(refuelled.record('G-SAT')!.state).toBe('READY_TO_RELAUNCH');
    expect(store.listMissions()).toHaveLength(1);
    const noConfirm = refuelled.relaunch('G-SAT', false, 'owner');
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.reason).toContain('confirmation');
    const go = refuelled.relaunch('G-SAT', true, 'owner');
    expect(go.ok).toBe(true);
    expect(refuelled.record('G-SAT')!.state).toBe('RETURNING');
    expect(refuelled.record('G-SAT')!.phase).toBe('relaunch');
    expect(store.listMissions()).toHaveLength(2);
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_relaunch')).toBe(true);
  });

  it('approval-first mode recommends, starts nothing, and the owner can approve it', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    svc.writeSettings({ approvalMode: 'approve' }, 'owner');
    svc.tick(NOW);
    expect(svc.record('G-SAT')!.state).toBe('RETURN_PENDING');
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.reason).toContain('awaiting owner approval');
    expect(svc.approveReturn('G-SAT', 'owner').ok).toBe(true);
    expect(svc.record('G-SAT')!.state).toBe('RETURNING');
    expect(store.listMissions()).toHaveLength(1);
  });

  it('rebuilds the retry sentence every evaluation instead of appending (verify #4)', () => {
    // The measured text was "… (retry in 10 min) (retry in 9 min) (retry in 9
    // min) (retry in 8 min)": each pass appended to the record's own reason.
    const store = memStore();
    seed(store);
    const first = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    first.tick(NOW);
    const missionId = first.record('G-SAT')!.missionId!;
    store.updateMission(missionId, { status: 'failed', pauseReason: 'mission failed with the drone aborted' }, NOW + 30_000);
    const afterFail = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), now: NOW + 30_000 });
    afterFail.tick(NOW + 30_000);
    expect(afterFail.record('G-SAT')!.reason).toContain('return flight did not land');

    const passes = [90_000, 150_000, 210_000].map((dt) => {
      const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), now: NOW + dt });
      svc.tick(NOW + dt);
      return svc.record('G-SAT')!.reason;
    });
    for (const reason of passes) {
      expect(reason.match(/\(retry in \d+ min\)/g), `one retry suffix in "${reason}"`).toHaveLength(1);
      expect(reason.match(/return flight did not land/g), `the base reason once in "${reason}"`).toHaveLength(1);
    }
    // The wait counts DOWN, and only the number changes.
    const minutes = passes.map((r) => Number(/\(retry in (\d+) min\)/.exec(r)![1]));
    expect(minutes[0]!).toBeGreaterThan(minutes[2]!);
    expect(retryReason('landed nowhere (retry in 9 min) (retry in 8 min)', 7)).toBe(
      'landed nowhere (retry in 7 min)',
    );
    expect(retryReason(null, 10)).toBe('retrying (retry in 10 min)');
  });

  it('PERSONAL: alert only, never an automatic action', () => {
    const store = memStore();
    seed(store, { shipRole: 'personal' });
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    const rec = svc.record('G-SAT')!;
    expect(rec.state).toBe('OK');
    expect(rec.recommendation).toContain('personal ship: no automatic action');
    const alert = store.listAlertRecords({ kind: 'return-home' })[0];
    expect(alert?.message).toContain('personal ship: no automatic action');
  });

  it('BASE and OFF grids are not evaluated at all', () => {
    const store = memStore();
    seed(store, { shipRole: 'off' });
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    const tick = svc.tick(NOW);
    expect(tick.grids).toBe(0);
    expect(svc.record('G-SAT')).toBeNull();
  });

  it('postpones a return while a pilot is seated, and audits it once', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12, underControl: true, controlledBy: 'the owner' })) });
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.reason).toContain('a pilot is aboard');
    expect(store.listAudit(50).filter((a) => a.action === 'demo_survival_postponed')).toHaveLength(1);
    // A second pass inside the audit window does not repeat the row.
    svc.tick(NOW + 10_000);
    expect(store.listAudit(50).filter((a) => a.action === 'demo_survival_postponed')).toHaveLength(1);
  });

  it('notes a pilot boarding mid-return and keeps following the mission', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    svc.tick(NOW);
    const missionId = svc.record('G-SAT')!.missionId!;
    const withPilot = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 12, underControl: true, controlledBy: 'the owner' })),
      now: NOW + 30_000,
      summary: () => ({ executions: [{ missionId, drones: [{ state: 'en_route', gridId: 'G-SAT' }] }] }),
    });
    withPilot.tick(NOW + 30_000);
    expect(withPilot.record('G-SAT')!.reason).toContain('a pilot is aboard');
    expect(withPilot.record('G-SAT')!.state).toBe('RETURNING');
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_postponed')).toBe(true);
  });

  it('does not fire on a snapshot the idle cadence has not refreshed (older than 6 min)', () => {
    // Simspeed merge: idle grids are re-read every 5 min, so a reading up to
    // ~5 min old is normal and still counts. Ten minutes old is unknown: an
    // 8 % tank measured ten minutes ago must not launch a return.
    const fresh = memStore();
    seed(fresh);
    const freshSvc = service({ store: fresh, power: fakePower(baseSnapshot({ h2Pct: 12, at: NOW - 5 * 60_000 })) });
    expect(freshSvc.tick(NOW).started).toEqual(['G-SAT']);

    const stale = memStore();
    seed(stale);
    const staleSvc = service({ store: stale, power: fakePower(baseSnapshot({ h2Pct: 12, at: NOW - 10 * 60_000 })) });
    const tick = staleSvc.tick(NOW);
    expect(tick.started).toEqual([]);
    expect(stale.listMissions()).toHaveLength(0);
    const rec = staleSvc.record('G-SAT')!;
    expect(rec.state).toBe('OK');
    expect(rec.need).toBeNull();
    expect(rec.reason).toContain('10 min old');
    expect(rec.reason).toContain('treated as unknown');
  });

  it('never fires on a null tank reading, and refuses without a reachable home', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: null, h2State: 'unread', h2Litres: null })) });
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.need?.trigger ?? false).toBe(false);

    const noHome = memStore();
    noHome.upsertUnit(grid('G-SAT', 'SAT-L-0007', 30_000, 4_000));
    shipRoles.noteInGame(noHome, [], NOW);
    const svc2 = service({ store: noHome, power: fakePower(baseSnapshot({ h2Pct: 12 })) });
    svc2.tick(NOW);
    expect(noHome.listMissions()).toHaveLength(0);
    expect(svc2.record('G-SAT')!.reason).toContain('no home');
  });

  it('a denied comms gate stops the move with a plain reason (movement is gated)', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false });
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.reason).toContain('comms gate denied');
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_return_refused')).toBe(true);
  });
});

describe('T66 survival rules: no spawn, no teleport, no physics writes', () => {
  it('the loop never names a spawning or teleporting action', () => {
    const files = readdirSync(SURVIVAL_SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    // Quoted action names only: prose may say "nothing is teleported".
    const banned = ["'spawn_prefab'", "'clone_grid'", "'delete_grid'", "'zero_velocity'", "'teleport'", "'set_orientation'"];
    for (const file of files) {
      const text = readFileSync(join(SURVIVAL_SRC, file), 'utf8');
      for (const name of banned) expect(text, `${file} must not name ${name}`).not.toContain(name);
    }
  });

  it('the survival module sends no plugin order of its own', () => {
    for (const file of readdirSync(SURVIVAL_SRC).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(SURVIVAL_SRC, file), 'utf8');
      expect(text).not.toMatch(/callPlugin\(|\bhub\.send\(|sendRaw\(|orderChannel\(/);
    }
  });

  it('a blank record is OK with no recommendation', () => {
    const rec = blankRecord('g', 'name', NOW);
    expect(rec.state).toBe('OK');
    expect(survivalView(rec).slotStatus).toBeNull();
  });
});

/**
 * T77: the loop's TEST-ENV-ONLY ignoreReach override. The test world's BASE-01
 * has no antenna block, so the comms gate refuses every move and the loop could
 * never be exercised. The setting is off by default, refused in survival mode,
 * and ignored there even if a value is already persisted.
 */
describe('T77 testIgnoreReach: test-env loop override', () => {
  it('is off by default and only a real boolean turns it on', () => {
    expect(normaliseSettings({}).testIgnoreReach).toBe(false);
    expect(normaliseSettings(undefined).testIgnoreReach).toBe(false);
    expect(normaliseSettings({ testIgnoreReach: true }).testIgnoreReach).toBe(true);
    // A string or a number is not consent.
    expect(normaliseSettings({ testIgnoreReach: 'true' as unknown as boolean }).testIgnoreReach).toBe(false);
    expect(normaliseSettings({ testIgnoreReach: 1 as unknown as boolean }).testIgnoreReach).toBe(false);
    const store = memStore();
    const svc = service({ store, power: fakePower(baseSnapshot()) });
    expect(svc.settings().testIgnoreReach).toBe(false);
    expect(svc.testIgnoreReach()).toBe(false);
  });

  it('needs the setting AND the demo env AND survival off', () => {
    expect(testIgnoreReachActive({ settings: { testIgnoreReach: true }, survivalMode: false, demoEnv: true })).toBe(true);
    expect(testIgnoreReachActive({ settings: { testIgnoreReach: false }, survivalMode: false, demoEnv: true })).toBe(false);
    expect(testIgnoreReachActive({ settings: { testIgnoreReach: true }, survivalMode: true, demoEnv: true })).toBe(false);
    expect(testIgnoreReachActive({ settings: { testIgnoreReach: true }, survivalMode: false, demoEnv: false })).toBe(false);
    expect(testIgnoreReachActive({ settings: null, survivalMode: false, demoEnv: true })).toBe(false);
  });

  it('carries the audited override on the return mission in the test env', () => {
    const store = memStore();
    seed(store);
    // The test world: BASE-01 has no antenna, so the gate denies everything.
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false });
    svc.writeSettings({ testIgnoreReach: true }, 'owner');
    expect(svc.testIgnoreReach()).toBe(true);
    expect(svc.settingsState().testIgnoreReachActive).toBe(true);

    const tick = svc.tick(NOW);
    expect(tick.started).toEqual(['G-SAT']);
    const mission = store.listMissions()[0]!;
    // Same field the executor reads off a step param (T10 admin override).
    expect(mission.plan.steps.some((s) => s.params?.adminOverride === true)).toBe(true);
    expect(String(mission.plan.notes)).toContain('ADMIN OVERRIDE (test server)');
    const audit = store.listAudit(50).find((a) => a.action === 'demo_survival_return_started')!;
    expect(audit.detail.adminOverride).toBe(true);
    expect(String(audit.detail.gateBypassed)).toContain('no path to a control source');
  });

  it('without the setting the same denied gate still refuses the return', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false });
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.state).toBe('OK');
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_return_refused')).toBe(true);
  });

  it('is IGNORED in survival mode even when persisted true', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false, survivalMode: true });
    // Persist the value anyway (an old settings row, or a hand-edited kv).
    svc.writeSettings({ testIgnoreReach: true }, 'owner');
    expect(svc.settings().testIgnoreReach).toBe(true); // stored...
    expect(svc.testIgnoreReach()).toBe(false); // ...but never in force
    expect(svc.settingsState().testIgnoreReachActive).toBe(false);
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.state).toBe('OK');
    expect(svc.record('G-SAT')!.reason).toContain('comms gate denied');
  });

  it('is ignored outside the demo env (a hosted-but-not-demo backend)', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false, demoEnv: false });
    svc.writeSettings({ testIgnoreReach: true }, 'owner');
    expect(svc.testIgnoreReach()).toBe(false);
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
  });

  it('carries the override on an owner-approved relaunch too', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12 })), gate: false });
    svc.writeSettings({ testIgnoreReach: true }, 'owner');
    svc.tick(NOW);
    const rec = svc.record('G-SAT')!;
    const missionId = rec.missionId!;
    // Touchdown, then refuelled.
    store.updateMission(missionId, { status: 'done' }, NOW + 60_000);
    const landed = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 12 })),
      gate: false,
      now: NOW + 60_000,
      summary: () => ({ executions: [{ missionId, drones: [{ state: 'holding', gridId: 'G-SAT' }] }] }),
    });
    landed.tick(NOW + 60_000);
    expect(landed.record('G-SAT')!.state).toBe('NEEDS_REFUEL');
    const refuelled = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 95 })),
      gate: false,
      now: NOW + 120_000,
      summary: () => ({ executions: [] }),
    });
    refuelled.tick(NOW + 120_000);
    expect(refuelled.record('G-SAT')!.state).toBe('READY_TO_RELAUNCH');
    const go = refuelled.relaunch('G-SAT', true, 'owner');
    expect(go.ok).toBe(true);
    const relaunchMission = store.getMission(go.missionId!)!;
    expect(relaunchMission.plan.steps.some((s) => s.params?.adminOverride === true)).toBe(true);
    const audit = store.listAudit(50).find((a) => a.action === 'demo_survival_relaunch')!;
    expect(audit.detail.adminOverride).toBe(true);
  });
});

/**
 * T78 STRANDED: a trigger is permission to *consider* the return, not proof it
 * can be flown. The launch gate is `remainingPct >= tripPct` (the flight itself,
 * no reserve, no margin). Below it: STRANDED, an alert, no mission — and a
 * static grid stays a station.
 */
describe('T78 STRANDED: never launch a return the ship cannot complete', () => {
  const args = {
    // 60 km at 100 m/s = 10 min + 0.3 climb + 3 landing = 13.3 min.
    // runway 12.9 min at 1.29 % -> the tank is worth 1000 min -> trip = 1.33 %.
    reading: { pct: 1.29, runwayMin: 12.9 },
    distanceM: 60_000,
    homeAltitudeM: 1_800,
    altitudeM: 0,
    marginPct: SURVIVAL_DEFAULT_MARGIN_PCT,
    homeLabel: 'BASE-01',
    resource: 'fuel' as const,
  };

  it('states the shortfall when the tank is below the trip (no reserve counted)', () => {
    const need = evaluateResourceNeed(args);
    expect(need.tripPct).toBeCloseTo(1.33, 5);
    expect(need.launchPct).toBeCloseTo(need.tripPct!, 10);
    expect(need.launchable).toBe(false);
    expect(need.trigger).toBe(true);
    expect(need.shortfallPct).toBeCloseTo(0.04, 2);
    expect(need.reason).toContain('cannot return');
    expect(need.reason).toContain('refuel it where it is or send a tanker');
  });

  it('is launchable just above the trip need, still just below it', () => {
    const above = evaluateResourceNeed({ ...args, reading: { pct: 1.34, runwayMin: 13.4 } });
    expect(above.launchable).toBe(true);
    expect(above.trigger).toBe(true); // above the trip, below the reserve line
    expect(above.reason).toContain('returning');
    const below = evaluateResourceNeed({ ...args, reading: { pct: 1.32, runwayMin: 13.2 } });
    expect(below.launchable).toBe(false);
  });

  it('an empty tank is stranded, never launchable, with the burn in minutes', () => {
    const empty = evaluateResourceNeed({ ...args, reading: { pct: 0, runwayMin: 0 } });
    expect(empty.trigger).toBe(true);
    expect(empty.launchable).toBe(false);
    expect(empty.reason).toContain('empty');
    expect(empty.reason).toContain('cannot return');
    expect(empty.tripMin).toBeCloseTo(13.3, 5);
    // An unread tank is NOT stranded: unknown is not empty.
    const unknown = evaluateResourceNeed({ ...args, reading: { pct: null, runwayMin: null } });
    expect(unknown.launchable).toBeNull();
    expect(unknown.trigger).toBe(false);
  });

  it('service: 0 % beside a base is STRANDED with an alert and no mission; a static grid keeps station', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 0, h2Litres: 0, isStatic: true })) });
    const tick = svc.tick(NOW);
    expect(tick.started).toEqual([]);
    expect(tick.stranded).toEqual(['G-SAT']);
    expect(store.listMissions()).toHaveLength(0);
    const rec = svc.record('G-SAT')!;
    expect(rec.state).toBe('STRANDED');
    expect(rec.reason).toContain('cannot return');
    expect(rec.reason).toContain('it stays a station');
    expect(rec.recommendation).toBeNull();
    const alert = store.listAlertRecords({ kind: 'stranded' })[0]!;
    expect(alert.message).toContain('refuel it where it is or send a tanker');
    const audit = store.listAudit(50).find((a) => a.action === 'demo_survival_stranded')!;
    expect(audit.detail.keptStation).toBe(true);
    // The grid itself was not touched: it is still the same static hull.
    expect(store.getUnit('G-SAT')!.pos).toEqual(grid('G-SAT', 'SAT-L-0007', 30_000, 4_000).pos);
  });

  it('service: below the trip need is STRANDED; a little more fuel launches the return', () => {
    const store = memStore();
    seed(store);
    // The fixture burns 60 %/h (100 min tank); the 28 km slant trip from 30 km
    // altitude is ~7.8 %. 3.5 % is below it.
    const stranded = service({ store, power: fakePower(baseSnapshot({ h2Pct: 3.5, h2Litres: 700 })) });
    stranded.tick(NOW);
    expect(stranded.record('G-SAT')!.state).toBe('STRANDED');
    expect(store.listMissions()).toHaveLength(0);

    const refuelled = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12, h2Litres: 6_000 })), now: NOW + 60_000 });
    const tick = refuelled.tick(NOW + 60_000);
    expect(tick.started).toEqual(['G-SAT']);
    expect(refuelled.record('G-SAT')!.state).toBe('RETURNING');
    expect(store.listMissions()).toHaveLength(1);
    // The stranded alert is resolved by the recovery.
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_alert_resolved' && (a.detail as { kind?: string }).kind === 'stranded')).toBe(true);
  });
});

/**
 * T78 home points: the API accepted any string as `homeGridId` and ignored what
 * did not resolve, so a point was stored and BASE-01 kept being used. Points are
 * now first class and validated, or refused with a plain 400.
 */
describe('T78 home point: validated, stored, resolved — never silently ignored', () => {
  const planet = planetByName('EarthLike')!;
  // A point ON the sphere: offset the east angle, not the x axis, or the point
  // would stand hundreds of metres above the ground at a 60 km radius.
  const surface = (eastM: number, aglM = 0, northM = 0) => {
    const r = planet.surfaceRadiusM + aglM;
    const theta = eastM / planet.surfaceRadiusM;
    return {
      x: planet.center.x + r * Math.sin(theta),
      y: planet.center.y + r * Math.cos(theta),
      z: planet.center.z + northM,
    };
  };
  const planets = [planet];

  it('encodes and parses point: and GPS: keys, and leaves grid ids alone', () => {
    const point = { x: 1.23456, y: -7.891, z: 1721.1024 };
    const key = formatHomePointKey(point);
    expect(key).toBe('point:1.235,-7.891,1721.102');
    expect(parseHomePointKey(key)).toEqual({ x: 1.235, y: -7.891, z: 1721.102 });
    expect(parseHomePointKey('GPS:home:1.5:-2.5:1721.1:#FF75C9F1:')).toEqual({ x: 1.5, y: -2.5, z: 1721.1 });
    expect(parseHomePointKey('grid:87929829394037977')).toBeNull();
    expect(parseHomePointKey('point:300m-ground-2026')).toBeNull();
  });

  it('accepts a level-5 surface point clear of grids', () => {
    const check = validateHomePoint({
      point: surface(5_000),
      planets,
      ground: { radiusM: planet.surfaceRadiusM, level: 5, source: 'terrain-l5' },
      grids: [{ gridId: 'b', name: 'BASE-01', position: surface(-8_000, 1_800) }],
    });
    expect(check.ok).toBe(true);
    expect(check.code).toBeNull();
    expect(check.altitudeM).toBe(0);
    expect(check.reason).toContain('level-5');
  });

  it('refuses coarse ground, a point in the air, and a point on top of a grid', () => {
    const coarse = validateHomePoint({
      point: surface(5_000),
      planets,
      ground: { radiusM: planet.surfaceRadiusM, level: 0, source: 'terrain-l0' },
      grids: [],
    });
    expect(coarse.ok).toBe(false);
    expect(coarse.code).toBe('coarse_ground');

    const air = validateHomePoint({
      point: surface(5_000, HOME_POINT_MAX_AGL_M + 200),
      planets,
      ground: { radiusM: planet.surfaceRadiusM, level: 5, source: 'terrain-l5' },
      grids: [],
    });
    expect(air.ok).toBe(false);
    expect(air.code).toBe('above_surface');

    const crowded = validateHomePoint({
      point: surface(5_000),
      planets,
      ground: { radiusM: planet.surfaceRadiusM, level: 5, source: 'terrain-l5' },
      grids: [{ gridId: 'g', name: 'PAD-01', position: surface(5_040) }],
    });
    expect(crowded.ok).toBe(false);
    expect(crowded.code).toBe('too_close_to_grid');
    expect(crowded.reason).toContain('PAD-01');

    const none = validateHomePoint({ point: surface(0), planets, ground: null, grids: [] });
    expect(none.ok).toBe(false);
    expect(none.code).toBe('coarse_ground');
  });

  it('resolveHome uses the point override instead of falling through to BASE-01', () => {
    const point = surface(12_000);
    const res = resolveHome({
      gridId: 'ship',
      position: surface(0, 30_000),
      candidates: [{ gridId: 'b1', name: 'BASE-01', position: surface(-1_000, 1_800), altitudeM: 1_800, hasCharge: true }],
      overrides: { ship: formatHomePointKey(point) },
    });
    expect(res.source).toBe('override');
    expect(res.home?.gridId).toBe(formatHomePointKey(point));
    expect(res.home?.position).toEqual(parseHomePointKey(formatHomePointKey(point)));
    expect(res.home?.hasCharge).toBe(false);
    expect(res.home?.distanceM).toBeCloseTo(distanceM(surface(0, 30_000), point), 3);
  });

  it('a point can be the one home too, and it beats the BASE-01 default', () => {
    const point = surface(15_000);
    const res = resolveHome({
      gridId: 'ship',
      position: surface(0, 30_000),
      candidates: [{ gridId: 'b1', name: 'BASE-01', position: surface(-1_000, 1_800), altitudeM: 1_800, hasCharge: true }],
      defaultHomeId: formatHomePointKey(point),
    });
    expect(res.source).toBe('default');
    expect(res.home?.name).toContain('point');
    expect(res.home?.position).toEqual(parseHomePointKey(formatHomePointKey(point)));
  });

  it('service: stores a valid point per ship, refuses the rest with a reason', async () => {
    const store = memStore();
    seed(store);
    const svc = service({ store });
    const point = parseHomePointKey(formatHomePointKey(surface(9_000)))!;

    const ok = await svc.setHome({ gridId: 'G-SAT', homePoint: point, homeGridId: null }, 'owner');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.flags.overrides['G-SAT']).toBe(formatHomePointKey(point));
    const audit = store.listAudit(50).find((a) => a.action === 'demo_survival_home')!;
    expect(audit.detail.homePoint).toEqual(point);

    // The global home can be a point as well.
    const global = await svc.setHome({ homePoint: surface(15_000) }, 'owner');
    expect(global.ok).toBe(true);
    if (!global.ok) return;
    expect(global.flags.defaultHomeId).toBe(formatHomePointKey(surface(15_000)));

    const coarse = service({ store, ground: { radiusM: planet.surfaceRadiusM, level: 4, source: 'terrain-l4' } });
    const refused = await coarse.setHome({ gridId: 'G-SAT', homePoint: surface(9_000) }, 'owner');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('coarse_ground');
    expect(refused.reason).toContain('not landing grade');

    const unknown = await svc.setHome({ homeGridId: 'grid:does-not-exist' }, 'owner');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('unknown_home');

    const notBase = await svc.setHome({ homeGridId: 'SAT-L-0007' }, 'owner');
    expect(notBase.ok).toBe(false);
    if (notBase.ok) return;
    expect(notBase.code).toBe('home_not_base');
    // Nothing invalid was stored: the point override from the first call is intact.
    expect(svc.homeFlags().overrides['G-SAT']).toBe(formatHomePointKey(point));
  });

  it('route: POST /home accepts homePoint, and a 400 for a bad point (never a silent store)', async () => {
    const store = memStore();
    seed(store);
    const svc = service({ store });
    // The demo routes only exist inside the demo env; resolveDemoEnv reads it.
    const saved = { demo: process.env.RTS_DEMO, env: process.env.RTS_ENV, marker: process.env.RTS_TEST_SERVER_MARKER };
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
    try {
      const routes = routesFor(store, svc);
      expect(routes.length).toBeGreaterThan(0);

      const good = await post(routes, '/api/demo/survival/home', { gridId: 'G-SAT', homePoint: surface(9_000) });
      expect(good.status).toBe(200);
      expect(JSON.parse(good.body).overrides['G-SAT']).toBe(formatHomePointKey(surface(9_000)));

      const bad = await post(routes, '/api/demo/survival/home', { gridId: 'G-SAT', homePoint: surface(9_000, 300) });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body).code).toBe('above_surface');
      expect(svc.homeFlags().overrides['G-SAT']).toBe(formatHomePointKey(surface(9_000)));

      // Verify #4: `homePoint: null` clears the per-ship override (200, audited)
      // — the doc always said so, the schema answered 400 "Expected object".
      const clearedPoint = await post(routes, '/api/demo/survival/home', { gridId: 'G-SAT', homePoint: null });
      expect(clearedPoint.status).toBe(200);
      expect(JSON.parse(clearedPoint.body).overrides['G-SAT']).toBeUndefined();
      const clearAudit = store.listAudit(50).find(
        (a) => a.action === 'demo_survival_home' && (a.detail as { note?: string }).note === 'return home override cleared',
      );
      expect(clearAudit, 'clearing a home override is audited').toBeTruthy();

      // ...and a default point home too.
      const globalPoint = await post(routes, '/api/demo/survival/home', { homePoint: surface(15_000) });
      expect(globalPoint.status).toBe(200);
      const clearedDefault = await post(routes, '/api/demo/survival/home', { homePoint: null });
      expect(clearedDefault.status).toBe(200);
      expect(JSON.parse(clearedDefault.body).defaultHomeId).toBeNull();
      // A clear-only body is still a valid request; an empty one is not.
      const empty = await post(routes, '/api/demo/survival/home', {});
      expect(empty.status).toBe(400);

      // TEST-ENV-ONLY runway route: accepted in the demo env, refused in survival.
      const set = await post(routes, '/api/demo/survival/test-runway', { gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8 });
      expect(set.status).toBe(200);
      expect(JSON.parse(set.body).override.pct).toBe(8);
      const cleared = await post(routes, '/api/demo/survival/test-runway/clear', { gridId: 'G-SAT' });
      expect(cleared.status).toBe(200);
      expect(JSON.parse(cleared.body).testRunway).toEqual({});

      // Survival (no test marker): the route refuses it by name and audits it.
      delete process.env.RTS_TEST_SERVER_MARKER;
      const refused = await post(routes, '/api/demo/survival/test-runway', { gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8 });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).code).toBe('survival_mode');
      expect(store.listAudit(50).some((a) => a.action === 'survival_refused')).toBe(true);
    } finally {
      for (const [key, value] of [
        ['RTS_DEMO', saved.demo],
        ['RTS_ENV', saved.env],
        ['RTS_TEST_SERVER_MARKER', saved.marker],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

/**
 * T78 test-env runway override: the only way to exercise the loop on a world
 * where every ship is full. Per grid, gated, audited, expiring, and it changes
 * no threshold.
 */
describe('T78 testRunwayOverride: exercise the flight, one grid at a time', () => {
  const planet = planetByName('EarthLike')!;

  it('is refused in survival mode and ignored when a value is already persisted', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, survivalMode: true, power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })) });
    const refused = svc.setTestRunway({ gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8 }, 'owner');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('survival_mode');

    // Persisted by hand (as an old kv row or a copied config would be).
    store.setKv(
      'survival:test-runway',
      JSON.stringify({ 'G-SAT': { gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8, setAt: NOW, expiresAt: NOW + 60_000, by: 'owner' } }),
    );
    expect(svc.testRunwayState(NOW)).toEqual({});
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(0);
    expect(svc.record('G-SAT')!.state).toBe('OK'); // live 100 % is enough: no trigger
  });

  it('replaces the reading for that grid only, and is audited on set and on use', () => {
    const store = memStore();
    seed(store);
    store.upsertUnit(grid('G-SAT2', 'SAT-L-0008', 30_000, 4_500));
    shipRoles.noteInGame(store, [
      { gridId: 'G-BASE', name: 'BASE-01', hints: [hint('base')] },
      { gridId: 'G-SAT2', name: 'SAT-L-0008', hints: [hint('managed')] },
    ], NOW);
    const power = {
      snapshot: (gridId: string) =>
        gridId === 'G-SAT' || gridId === 'G-SAT2'
          ? baseSnapshot({ gridId, name: gridId === 'G-SAT2' ? 'SAT-L-0008' : 'SAT-L-0007', h2Pct: 12, h2Litres: 6_000 })
          : gridId === 'G-BASE'
            ? baseSnapshot({ gridId: 'G-BASE', name: 'BASE-01', h2Pct: 100, h2CapacityLitres: 1_000_000, batteryMaxMWh: 10 })
            : null,
      series: () => samples(),
    } as unknown as PowerPoller;
    const withPower = service({ store, power });
    expect(withPower.setTestRunway({ gridId: 'G-SAT', resource: 'h2', runwayMin: 6000, pct: 100 }, 'owner').ok).toBe(true);
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_test_runway')).toBe(true);
    expect(withPower.testRunwayState()['G-SAT']?.pct).toBe(100);

    const tick = withPower.tick(NOW);
    // G-SAT reads the injected 100 % (no trigger); G-SAT2 still reads live 5 %.
    expect(tick.started).toEqual(['G-SAT2']);
    expect(withPower.record('G-SAT')!.state).toBe('OK');
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_test_runway_used')).toBe(true);
  });

  it('expires on its own and the trigger goes back to live readings', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })) });
    expect(svc.setTestRunway({ gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8, ttlMin: 1 }, 'owner').ok).toBe(true);
    expect(Object.keys(svc.testRunwayState(NOW))).toEqual(['G-SAT']);
    svc.tick(NOW);
    expect(store.listMissions()).toHaveLength(1); // exercised on the injected reading
    expect(SURVIVAL_TEST_RUNWAY_TTL_MS).toBe(30 * 60_000);

    const later = service({ store, power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })), now: NOW + 120_000 });
    expect(later.testRunwayState(NOW + 120_000)).toEqual({});
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_test_runway_expired')).toBe(true);
  });

  it('runs the whole flight, and live high readings make READY once it is cleared', () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })) });
    svc.setTestRunway({ gridId: 'G-SAT', resource: 'h2', runwayMin: 480, pct: 8 }, 'owner');
    expect(svc.tick(NOW).started).toEqual(['G-SAT']);

    const missionId = svc.record('G-SAT')!.missionId!;
    store.updateMission(missionId, { status: 'done' }, NOW + 60_000);
    const landed = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })),
      now: NOW + 60_000,
      summary: () => ({ executions: [{ missionId, drones: [{ state: 'holding', gridId: 'G-SAT' }] }] }),
    });
    landed.tick(NOW + 60_000);
    expect(landed.record('G-SAT')!.state).toBe('NEEDS_REFUEL');

    landed.clearTestRunway('G-SAT', 'owner');
    const refuelled = service({
      store,
      power: fakePower(baseSnapshot({ h2Pct: 100, h2Litres: 50_000 })),
      now: NOW + 120_000,
      summary: () => ({ executions: [] }),
    });
    refuelled.tick(NOW + 120_000);
    expect(refuelled.record('G-SAT')!.state).toBe('READY_TO_RELAUNCH');
    expect(refuelled.relaunch('G-SAT', true, 'owner').ok).toBe(true);
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_test_runway_cleared')).toBe(true);
  });
});

/**
 * Verify #3 defect 2: the eight H2 relays read `h2Pct 0` with NO projected
 * drain, so `runwayMin` was null and the runway-null early return swallowed the
 * empty case: they read OK on their 100 % battery instead of STRANDED. An empty
 * resource the ship needs for the trip is STRANDED whatever the runway says.
 */
describe('T79 trip resources: an empty resource the ship needs is STRANDED', () => {
  const args = {
    fuel: { pct: 0, runwayMin: null as number | null },
    power: { pct: 100, runwayMin: null as number | null },
    distanceM: 4_000,
    homeAltitudeM: 1_800,
    altitudeM: 30_000,
    marginPct: SURVIVAL_DEFAULT_MARGIN_PCT,
    homeLabel: 'BASE-01',
  };

  it('classifies the lift from the prefab thruster banks (no parallel physics)', () => {
    const escort = tripResources({ counts: bankTotals(PREFAB_HARDWARE['Escort TT-420']!.thrustCounts) });
    expect(escort).toMatchObject({ fuel: true, power: true, source: 'prefab-profile' });
    expect(escort.reason).toContain('H2 thruster');
    // Eradicator mk.1 is ion only: an empty H2 tank is not what grounds it.
    const eradicator = tripResources({ counts: bankTotals(PREFAB_HARDWARE['Eradicator_mk.1']!.thrustCounts) });
    expect(eradicator).toMatchObject({ fuel: false, power: true });
    // Unknown propulsion is judged conservatively, and says why.
    const unknown = tripResources({ counts: null });
    expect(unknown).toMatchObject({ fuel: true, power: true, source: 'unknown-conservative' });
    expect(unknown.reason).toContain('conservative');
  });

  it('0 % H2 with a null runway (nothing draining) is STRANDED, not unjudged', () => {
    const need = evaluateReturnNeed({ ...args, needed: { fuel: true, power: true } });
    expect(need.resource).toBe('fuel');
    expect(need.trigger).toBe(true);
    expect(need.launchable).toBe(false);
    expect(need.reason).toContain('empty');
    expect(need.reason).toContain('cannot return');
    expect(need.reason).toContain('refuel it where it is or send a tanker');
    // An unknown reading is still unknown, never empty.
    const unread = evaluateReturnNeed({ ...args, fuel: { pct: null, runwayMin: null }, needed: { fuel: true, power: true } });
    expect(unread.trigger).toBe(false);
    expect(unread.reason).not.toContain('empty');
  });

  it('0 % of a resource the trip does not burn is not a grounding failure', () => {
    const empty = evaluateResourceNeed({
      reading: { pct: 0, runwayMin: null },
      distanceM: args.distanceM,
      homeAltitudeM: args.homeAltitudeM,
      altitudeM: args.altitudeM,
      marginPct: args.marginPct,
      homeLabel: args.homeLabel,
      resource: 'fuel',
      needed: false,
    });
    expect(empty.trigger).toBe(false);
    expect(empty.launchable).toBeNull();
    expect(empty.reason).toContain('not what lifts the ship');
    // The aggregate never fires on it either (nothing else has a runway here).
    const need = evaluateReturnNeed({ ...args, needed: { fuel: false, power: true } });
    expect(need.trigger).toBe(false);
    expect(need.launchable).toBeNull();
  });

  it('service: the verify #3 relay (0 % H2, static, no drain) is STRANDED with no mission', () => {
    const store = memStore();
    seed(store);
    const flat: PowerSample[] = [
      { at: NOW - 120_000, batteryPct: 100, h2Pct: 0, h2Litres: 0, uraniumKg: null, solarPct: 0, netMw: 0 },
      { at: NOW, batteryPct: 100, h2Pct: 0, h2Litres: 0, uraniumKg: null, solarPct: 0, netMw: 0 },
    ];
    const snap = baseSnapshot({ h2Pct: 0, h2Litres: 0, netMw: 0, isStatic: true });
    const svc = service({ store, power: fakePower(snap, flat) });
    const tick = svc.tick(NOW);
    // Nothing draining, so the runway really is null for BOTH resources.
    expect(tick.stranded).toEqual(['G-SAT']);
    expect(tick.started).toEqual([]);
    const rec = svc.record('G-SAT')!;
    expect(rec.state).toBe('STRANDED');
    expect(rec.reason).toContain('H2 0 %');
    expect(rec.reason).toContain('cannot return');
    expect(store.listMissions()).toHaveLength(0);
    expect(store.listAudit(50).some((a) => a.action === 'demo_survival_stranded')).toBe(true);
  });

  it('service: an ion hull with a dry H2 tank is NOT stranded on the tank', () => {
    const store = memStore();
    seed(store);
    // A radio radius gives the grid a known hardware profile (Eradicator mk.1,
    // ion only), so the dry H2 tank it carries is not what lifts it.
    store.setKv('designer:gridRadios', JSON.stringify({ 'G-SAT': 50_000 }));
    const flat: PowerSample[] = [
      { at: NOW - 120_000, batteryPct: 100, h2Pct: 0, h2Litres: 0, uraniumKg: null, solarPct: 0, netMw: 0 },
      { at: NOW, batteryPct: 100, h2Pct: 0, h2Litres: 0, uraniumKg: null, solarPct: 0, netMw: 0 },
    ];
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 0, h2Litres: 0, netMw: 0 }), flat) });
    const tick = svc.tick(NOW);
    expect(tick.stranded).toEqual([]);
    expect(svc.record('G-SAT')!.state).toBe('OK');
    expect(store.listMissions()).toHaveLength(0);
  });
});

/**
 * Verify #3 defect 3: the return picked a landing spot 150 m from the home point
 * on bearing 90 deg although the point itself had been validated clear. A point
 * home has no hull: land ON it, and offset only when something blocks it.
 */
describe('T79 landing spot: a clear point home is landed on, not offset', () => {
  const planet = planetByName('EarthLike')!;
  const home = { x: planet.center.x, y: planet.center.y + planet.surfaceRadiusM, z: planet.center.z };

  it('lands at the home point when it is clear, and says so', () => {
    const picked = chooseLandingSpot({
      home,
      planetCenter: planet.center,
      incomingFrom: { x: home.x, y: home.y + 30_000, z: home.z },
      baseHullRadiusM: 40,
      obstacles: [],
      homeIsPoint: true,
    });
    expect(picked.spot!.distanceM).toBe(0);
    expect(picked.spot!.atHome).toBe(true);
    expect(picked.spot!.point).toEqual(home);
    expect(picked.reason).toContain('home point itself');
  });

  it('offsets only when another grid blocks the point, and records why', () => {
    const picked = chooseLandingSpot({
      home,
      planetCenter: planet.center,
      incomingFrom: { x: home.x, y: home.y + 30_000, z: home.z },
      baseHullRadiusM: 40,
      obstacles: [{ gridId: 'grid:tanker', position: { x: home.x + 20, y: home.y, z: home.z }, radiusM: 90 }],
      homeIsPoint: true,
    });
    expect(picked.spot!.distanceM).toBeGreaterThan(0);
    expect(picked.spot!.atHome).toBeUndefined();
    expect(picked.reason).toContain('home point itself is blocked by grid:tanker');
  });

  it('a base grid home is still landed beside, never on', () => {
    const picked = chooseLandingSpot({
      home,
      planetCenter: planet.center,
      incomingFrom: { x: home.x, y: home.y + 30_000, z: home.z },
      baseHullRadiusM: 40,
      obstacles: [],
    });
    expect(picked.spot!.distanceM).toBeGreaterThanOrEqual(150);
    expect(picked.spot!.atHome).toBeUndefined();
  });

  it('service: a point home is the return target itself', async () => {
    const store = memStore();
    seed(store);
    const svc = service({ store, power: fakePower(baseSnapshot({ h2Pct: 12, h2Litres: 6_000 })) });
    const r = planet.surfaceRadiusM + 5;
    const point = { x: planet.center.x, y: planet.center.y + r, z: planet.center.z };
    const stored = await svc.setHome({ gridId: 'G-SAT', homePoint: point, homeGridId: null }, 'owner');
    expect(stored.ok).toBe(true);
    svc.tick(NOW);
    const rec = svc.record('G-SAT')!;
    expect(rec.state).toBe('RETURNING');
    expect(rec.landing!.atHome).toBe(true);
    expect(distanceM(rec.landing!.point, point)).toBeLessThan(5);
    const mission = store.getMission(rec.missionId!)!;
    const move = mission.plan.steps.find((s) => s.kind === 'move')!;
    expect(distanceM(move.params.target as { x: number; y: number; z: number }, point)).toBeLessThan(5);
    expect(store.listAudit(50).find((a) => a.action === 'demo_survival_return_started')!.detail).toMatchObject({
      landing: { atHome: true },
    });
  });
});
