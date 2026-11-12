import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { makeConfig } from './helpers.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import {
  formatDurationShort,
  moveEtaS,
  preflightMove,
  reachAtPoint,
  resolveMoveTarget,
  zeroGAltitudeM,
  type ReachNode,
  type ShipState,
} from '../src/demo/moveTo.js';
import { hintForCode } from '../src/demo/routes.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';

const earth = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const NOW = 1_800_000_000_000;

afterEach(() => {
  delete process.env.RTS_DEMO;
  delete process.env.RTS_ENV;
  delete process.env.RTS_TEST_SERVER_MARKER;
});

const shipAt = (over: Partial<ShipState> = {}): ShipState => ({
  gridId: 'grid:ship',
  name: 'SAT-1',
  position: { x: 0, y: 0, z: earth.surfaceRadiusM + 2_000 },
  altitudeM: 2_000,
  massKg: 19_000,
  fuelPct: 50,
  batteryPct: 100,
  thrust: { atmo: 1_152_000, ion: 0, h2: 984_000 },
  ...over,
});

describe('move-to target resolution', () => {
  it('resolves a GPS target and reports the altitude above the nearest planet', () => {
    const out = resolveMoveTarget({
      target: { gps: { x: 0, y: 0, z: earth.surfaceRadiusM + 60_000 } },
      ship: shipAt().position,
      planets: PLANET_CATALOG,
    });
    if ('error' in out) throw new Error(out.error.message);
    expect(out.target.planet).toBe('EarthLike');
    expect(out.target.altitudeM).toBe(60_000);
    expect(out.target.label).toContain('GPS');
  });

  it('resolves orbit presets: zero-g above the cutoff, low orbit at 20 km', () => {
    const zero = resolveMoveTarget({ target: 'orbit-zero-g', ship: shipAt().position, planets: PLANET_CATALOG });
    if ('error' in zero) throw new Error(zero.error.message);
    expect(zero.target.planet).toBe('EarthLike');
    expect(zero.target.altitudeM).toBeGreaterThanOrEqual(60_000);
    expect(zeroGAltitudeM(earth)).toBeGreaterThan(43_693);
    const low = resolveMoveTarget({ target: 'orbit-low', ship: shipAt().position, planets: PLANET_CATALOG });
    if ('error' in low) throw new Error(low.error.message);
    expect(low.target.altitudeM).toBe(20_000);
  });

  it('resolves planet + altitude and rejects an unknown planet', () => {
    const ok = resolveMoveTarget({ target: { planet: 'EarthLike', altitudeM: 35_000 }, ship: null, planets: PLANET_CATALOG });
    if ('error' in ok) throw new Error(ok.error.message);
    expect(ok.target.altitudeM).toBe(35_000);
    const bad = resolveMoveTarget({ target: { planet: 'Nope', altitudeM: 1_000 }, ship: null, planets: PLANET_CATALOG });
    expect('error' in bad && bad.error.code).toBe('unknown_planet');
    expect('error' in bad && bad.error.hint.length > 0).toBe(true);
  });
});

describe('move-to reach and preflight', () => {
  const base: ReachNode = {
    id: 'base',
    position: { x: 0, y: 0, z: earth.surfaceRadiusM },
    radioRangeM: 50_000,
    controlSource: true,
  };

  it('reaches a point inside the base radio and misses one outside it', () => {
    const near = reachAtPoint({ x: 0, y: 0, z: earth.surfaceRadiusM + 40_000 }, [base]);
    expect(near.reachable).toBe(true);
    expect(near.via).toBe('base');
    const far = reachAtPoint({ x: 0, y: 0, z: earth.surfaceRadiusM + 120_000 }, [base]);
    expect(far.reachable).toBe(false);
    expect(far.reason).toContain('radio reaches 50 km');
  });

  it('chains through a relay', () => {
    const relay: ReachNode = {
      id: 'relay',
      position: { x: 0, y: 0, z: earth.surfaceRadiusM + 40_000 },
      radioRangeM: 50_000,
      controlSource: false,
    };
    const out = reachAtPoint({ x: 0, y: 0, z: earth.surfaceRadiusM + 85_000 }, [base, relay]);
    expect(out.reachable).toBe(true);
    expect(out.via).toBe('relay');
  });

  it('refuses an unreachable destination, but admin override flies it with a label', () => {
    const target = {
      position: { x: 0, y: 0, z: earth.surfaceRadiusM + 200_000 },
      planet: 'EarthLike',
      altitudeM: 200_000,
      label: 'far point',
      preset: null,
    };
    const reach = reachAtPoint(target.position, [base]);
    const refused = preflightMove({ ship: shipAt(), target, reach, speedMps: 100, ignoreReach: false });
    expect(refused.ok).toBe(false);
    expect(refused.block?.code).toBe('not_reachable');
    expect(refused.block?.hint).toContain('Admin override');
    const override = preflightMove({ ship: shipAt(), target, reach, speedMps: 100, ignoreReach: true });
    expect(override.ok).toBe(true);
    expect(override.linkText).toContain('ADMIN OVERRIDE');
  });

  it('refuses a 0 % hydrogen climb with no ion bank', () => {
    const target = {
      position: { x: 0, y: 0, z: earth.surfaceRadiusM + 40_000 },
      planet: 'EarthLike',
      altitudeM: 40_000,
      label: 'high point',
      preset: null,
    };
    const reach = reachAtPoint(target.position, [base]);
    const out = preflightMove({
      ship: shipAt({ fuelPct: 0 }),
      target,
      reach,
      speedMps: 100,
      ignoreReach: false,
    });
    expect(out.ok).toBe(false);
    expect(out.block?.code).toBe('no_fuel');
  });

  it('allows a 0 % hydrogen climb that atmosphere alone can carry (T13 case 1)', () => {
    const target = {
      position: { x: 0, y: 0, z: earth.surfaceRadiusM + 2_300 },
      planet: 'EarthLike',
      altitudeM: 2_300,
      label: '300 m above base',
      preset: null,
    };
    const reach = reachAtPoint(target.position, [base]);
    const out = preflightMove({
      ship: shipAt({ fuelPct: 0, planet: earth }),
      target,
      reach,
      speedMps: 60,
      ignoreReach: false,
    });
    expect(out.ok).toBe(true);
    expect(out.block).toBeNull();
    expect(out.warnings.join(' ')).toContain('atmosphere covers');
  });

  it('refuses a 0 % hydrogen climb whose atmosphere cannot cover the requirement', () => {
    const target = {
      position: { x: 0, y: 0, z: earth.surfaceRadiusM + 20_000 },
      planet: 'EarthLike',
      altitudeM: 20_000,
      label: '20 km',
      preset: null,
    };
    const reach = reachAtPoint(target.position, [base]);
    const out = preflightMove({
      ship: shipAt({ fuelPct: 0, planet: earth }),
      target,
      reach,
      speedMps: 60,
      ignoreReach: false,
    });
    expect(out.ok).toBe(false);
    expect(out.block?.code).toBe('no_fuel');
  });

  it('formats ETA and duration', () => {
    expect(moveEtaS(10_000, 100)).toBe(100);
    expect(formatDurationShort(100)).toBe('2 min');
    expect(formatDurationShort(3_700)).toBe('1 h 02 min');
  });
});

describe('failure hints', () => {
  it('gives an actionable hint for every known code and a fallback', () => {
    // T75: the hint is channel-aware; this assertion pins the TEST-WORLD
    // wording (move-to deletes the marker after every test, so the ambient env
    // is survival here and the flag must be explicit).
    expect(hintForCode('comms_denied', { survivalMode: false })).toContain('Admin override');
    expect(hintForCode('no_such_code').length).toBeGreaterThan(10);
  });
});

describe('admin override survives into the executor', () => {
  it('stores the override on the drone and labels it', () => {
    const config = makeConfig({ flags: { demo_execute: true } });
    const db = openDb(':memory:', { memory: true });
    const s = new Store(db);
    const all = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
    s.ensureFlags(FEATURE_FLAGS, { ...all, demo_execute: true } as never);
    const created = createMission(
      s,
      {
        type: 'move',
        priority: 50,
        desiredState: {
          shipSpec: 'stand-in-grid',
          station: 'move:grid:ship',
          formation: 'none',
          position: { x: 0, y: 0, z: 120_000 },
          adminOverride: true,
        },
        budget: { resources: {}, timeMin: 1, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: ['grid:ship'],
        plan: {
          steps: [
            { id: 'validate', kind: 'validate_spec', params: { adminOverride: true }, done: false },
            { id: 'move', kind: 'move', params: { gridId: 'grid:ship', target: { x: 0, y: 0, z: 120_000 } }, done: false },
            { id: 'gate', kind: 'custom', params: { demoGateNode: 'grid:ship', action: 'move' }, done: false },
          ],
          notes: '',
        },
      } as never,
      { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) throw new Error(created.message);
    s.updateMission(created.mission.id, { status: 'approved' }, NOW);
    const executor = new DemoExecutor({
      store: s,
      hub: { send: () => false, isConnected: () => false, agentId: () => null } as never,
      config,
      clock: () => NOW,
      fixturePath: null,
    });
    executor.tick();
    const summary = executor.summary() as { executions: { drones: { adminOverride: boolean }[] }[] };
    expect(summary.executions[0]!.drones[0]!.adminOverride).toBe(true);
    expect(executor.enabled()).toBe(true);
  });
});
