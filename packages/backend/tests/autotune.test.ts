import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { applyTune } from '../src/demo/autotune/apply.js';
import { readPins, writePin } from '../src/demo/autotune/pins.js';
import { tuneNode, tunePlan, type TuneNodeInput } from '../src/demo/autotune/index.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

const NOW = 1_800_000_000_000;
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const BASE = 'grid:76941937918779763';
const SAT = 'grid:107519913664561774';
const SAT2 = 'grid:115081011520040319';

function node(overrides: Partial<TuneNodeInput> = {}): TuneNodeInput {
  return {
    gridId: SAT,
    name: 'SAT-L-0002',
    role: 'backbone',
    radioRadiusM: 50_000,
    laserRangeM: null,
    radioLinks: [{ to: SAT2, distanceM: 10_000 }],
    laserLinks: [],
    antennaDrawMw: 0.2,
    ...overrides,
  };
}

describe('T29 range maths', () => {
  it('shrinks a backbone node to the longest link x 1.15', () => {
    const plan = tuneNode(node());
    expect(plan.radio.neededM).toBe(11_500);
    expect(plan.radio.action).toBe('shrink');
    expect(plan.radio.savedMw).toBeCloseTo(0.154, 3);
    expect(plan.warnings).toEqual([]);
  });

  it('never shrinks below a link in use, even with a small footprint', () => {
    const plan = tuneNode(node({ role: 'coverage', footprintM: 4_000 }));
    expect(plan.radio.neededM).toBe(11_500);
    expect(plan.radio.reason).toContain('coverage');
    expect(plan.radio.neededM! * 0.87).toBeGreaterThanOrEqual(10_000);
  });

  it('keeps a coverage footprint when it is the larger need', () => {
    const plan = tuneNode(node({ role: 'coverage', footprintM: 30_000 }));
    expect(plan.radio.neededM).toBe(30_000);
    expect(plan.radio.action).toBe('shrink');
  });

  it('keeps a base at max range', () => {
    const plan = tuneNode(node({ gridId: BASE, role: 'base', name: 'BASE-01', antennaDrawMw: 0.5 }));
    expect(plan.radio.action).toBe('keep');
    expect(plan.radio.neededM).toBe(50_000);
    expect(plan.radio.savedMw).toBe(0);
  });

  it('honours an owner pin exactly and reports it', () => {
    const plan = tuneNode(node({ pinRadioM: 40_000 }));
    expect(plan.radio.action).toBe('pinned');
    expect(plan.radio.neededM).toBe(40_000);
  });

  it('computes laser range per link and reports zero laser savings', () => {
    const plan = tuneNode(node({ laserRangeM: 100_000, laserLinks: [{ to: BASE, distanceM: 30_000 }] }));
    expect(plan.laser.neededM).toBe(34_500);
    expect(plan.laser.action).toBe('shrink');
    expect(plan.laser.savedMw).toBe(0);
  });

  it('blocks instead of exceeding the antenna maximum', () => {
    const plan = tuneNode(node({ radioRadiusM: 20_000, radioLinks: [{ to: SAT2, distanceM: 19_000 }] }));
    expect(plan.radio.action).toBe('blocked');
    expect(plan.radio.neededM).toBe(20_000);
    expect(plan.warnings.join(' ')).toContain('exceeds');
  });

  it('emits one apply change per node that actually moves', () => {
    const plan = tunePlan([
      node(),
      node({ gridId: BASE, role: 'base', name: 'BASE-01', radioLinks: [] }),
      node({ gridId: 'grid:near', name: 'near', radioRadiusM: 12_000, radioLinks: [{ to: SAT2, distanceM: 10_000 }] }),
    ], NOW);
    expect(plan.changes).toEqual([{ gridId: SAT, kind: 'radio', fromM: 50_000, toM: 11_500 }]);
    expect(plan.totals.savedMw).toBeCloseTo(0.162, 3);
  });
});

describe('T29 apply', () => {
  function storeWithPins(pins = false) {
    const store = new Store(openDb(':memory:', { memory: true }));
    if (pins) writePin(store, { gridId: SAT, radioM: 45_000, laserM: null, footprintM: null, at: NOW, by: 'test', note: null });
    return store;
  }

  it('writes Radius, then proves the change from live profiles', async () => {
    const store = storeWithPins();
    const plan = tunePlan([node()], NOW);
    let profiles = 0;
    const writes: { id: string; radius: number }[] = [];
    const result = await applyTune(
      {
        store,
        hub: { isConnected: () => true, send: () => true },
        clock: () => NOW,
        profile: async (id) => {
          profiles += 1;
          return profiles === 1
            ? { gridId: id, radio: [{ name: 'A', radiusM: 50_000, drawMw: 0.2, enabled: true }], power: { antennaDrawMw: 0.2, netMw: -0.2 } }
            : { gridId: id, radio: [{ name: 'A', radiusM: 11_500, drawMw: 0.046, enabled: true }], power: { antennaDrawMw: 0.046, netMw: 0 } };
        },
        writeRadius: async (id, radius) => {
          writes.push({ id, radius });
          return { ok: true, appliedM: radius, error: null };
        },
      },
      plan,
    );
    expect(writes).toEqual([{ id: SAT, radius: 11_500 }]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.ok).toBe(true);
    expect(result.applied[0]!.fromM).toBe(50_000);
    expect(result.applied[0]!.appliedM).toBe(11_500);
    expect(result.applied[0]!.drawDropMw).toBeCloseTo(0.154, 3);
    expect(result.savedMw).toBeCloseTo(0.154, 3);
  });

  it('skips a pinned node without writing', async () => {
    const store = storeWithPins(true);
    const plan = tunePlan([node()], NOW);
    let wrote = false;
    const result = await applyTune(
      {
        store,
        hub: { isConnected: () => true, send: () => true },
        clock: () => NOW,
        profile: async (id) => ({ gridId: id, radio: [{ name: 'A', radiusM: 50_000, drawMw: 0.2, enabled: true }] }),
        writeRadius: async () => {
          wrote = true;
          return { ok: true, appliedM: 11_500, error: null };
        },
      },
      plan,
      { pins: readPins(store) },
    );
    expect(wrote).toBe(false);
    expect(result.skipped[0]?.reason).toContain('owner pin');
  });
});

// ---------------------------------------------------------------- HTTP routes

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const saved: Record<string, string | undefined> = {};

function setDemoEnv(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
}

function ground(metersEast: number) {
  return { x: EARTH.center.x + EARTH.surfaceRadiusM + 300, y: EARTH.center.y, z: EARTH.center.z + metersEast };
}

describe('power + autotune HTTP routes', () => {
  let runtime: Runtime;
  let port: number;
  const clock = makeClock(NOW);

  beforeAll(async () => {
    setDemoEnv();
    runtime = createRuntime({ config: makeConfig({ port: 0 }), memory: true, clock: clock.now });
    port = await runtime.listen(0);
    runtime.store.setKv(PROVISION_CAPABILITIES_KV, JSON.stringify({
      at: NOW,
      grids: [
        { gridId: BASE, name: 'BASE-01', profile: 'BASE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 0, isStatic: true },
        { gridId: SAT, name: 'SAT-L-0002', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 19_000, isStatic: false },
        { gridId: SAT2, name: 'SAT-L-0003', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 19_000, isStatic: false },
      ],
    }));
    for (const [id, name, pos] of [
      [BASE, 'BASE-01', ground(0)],
      [SAT, 'SAT-L-0002', ground(10_000)],
      [SAT2, 'SAT-L-0003', ground(20_000)],
    ] as const) {
      runtime.store.upsertUnit({ id, name, specId: null, station: null, linkStatus: 'up', lastSeen: NOW, pos, vel: null, meta: {} });
    }
    runtime.store.setKv('telemetry:sun', JSON.stringify({ sun: { x: 0, y: 0, z: 1 }, at: NOW }));
    runtime.power!.ingest(SAT, {
      gridId: SAT,
      name: 'SAT-L-0002',
      isStatic: false,
      control: { underControl: false },
      radio: [{ name: 'Antenna', radiusM: 50_000, drawMw: 0.2, enabled: true }],
      laser: [],
      power: {
        batteryStoredMWh: 1.8, batteryCapacityMWh: 3, batteryPct: 60,
        batteryInputMw: 0, batteryOutputMw: 0.4, chargeState: 'discharging', netMw: -0.28,
        solarActualMw: 0.1, solarMaxMw: 0.64, solarEfficiency: 0.156,
        antennaDrawMw: 0.2, laserDrawMw: 0, deviceDrawMw: 0.28,
        uraniumKg: 0, uraniumCapacityKg: 0, uraniumPct: -1, reactors: [],
        solar: [{ name: 'S1', actualMw: 0.1, maxMw: 0.64 }],
      },
      fuel: { h2FillPct: 55, tanks: [{ name: 'H2', subtype: 'LargeHydrogenTank', filledRatio: 0.55, filledL: 8_250_000, capacity: 15_000_000, stockpile: false }] },
    }, NOW);
  });

  afterAll(async () => {
    await runtime.close();
    restoreEnv();
  });

  it('merges battery/solar/H2/uranium into node telemetry with Fleet field names', async () => {
    const res = await httpRequest<{ nodes: { id: string; telemetry: Record<string, unknown> }[]; power: { enabled: boolean; grids: unknown[] } }>(
      port, 'GET', '/api/demo/state',
    );
    expect(res.status).toBe(200);
    const tel = res.body.nodes.find((n) => n.id === SAT)?.telemetry ?? {};
    expect(tel.batteryPct).toBe(60);
    expect(tel.chargeState).toBe('discharging');
    expect(tel.solarActualMw).toBe(0.1);
    expect(tel.solarMaxMw).toBe(0.64);
    expect(tel.h2Pct).toBe(55);
    expect(tel.h2Litres).toBe(8_250_000);
    expect(tel.runwayMin).toBeGreaterThan(0);
    expect(tel.power).toBeTruthy();
    expect(res.body.power.enabled).toBe(true);
    expect(res.body.power.grids.length).toBe(1);
  });

  it('serves the 24 h history endpoint in 1-minute buckets', async () => {
    runtime.power!.ingest(SAT, {
      gridId: SAT, name: 'SAT-L-0002',
      power: { batteryStoredMWh: 1.7, batteryCapacityMWh: 3, batteryPct: 56, netMw: -0.3, solarActualMw: 0, solarMaxMw: 0.64, chargeState: 'discharging' },
      fuel: { h2FillPct: 54, tanks: [] },
    }, NOW + 60_000);
    const res = await httpRequest<{ series: { minute: number; samples: number }[]; bucketMs: number }>(
      port, 'GET', `/api/demo/power/${encodeURIComponent(SAT)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.bucketMs).toBe(60_000);
    expect(res.body.series.length).toBe(2);
    expect(res.body.series[0]!.minute % 60_000).toBe(0);
  });

  it('returns a per-slot power budget with a verdict and a design suggestion', async () => {
    const res = await httpRequest<{ verdict: string; need: { avgMw: number }; suggestion: { blocks: Record<string, number> }; summary: string }>(
      port, 'GET', `/api/demo/power/budget?gridId=${encodeURIComponent(SAT)}&slotAltM=45000&lat=0`,
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toMatch(/ok-24-7|short-at-night|generation-short|no-storage/);
    expect(res.body.need.avgMw).toBeGreaterThan(0);
    expect(res.body.suggestion.blocks.radio).toBeGreaterThan(0);
    expect(res.body.summary.length).toBeGreaterThan(10);
  });

  it('previews a tune plan and explains per-node savings', async () => {
    const res = await httpRequest<{ plan: { nodes: { gridId: string; radio: { neededM: number; action: string } }[]; changes: unknown[] } }>(
      port, 'POST', '/api/demo/autotune/preview', {},
    );
    expect(res.status).toBe(200);
    const sat = res.body.plan.nodes.find((n) => n.gridId === SAT);
    expect(sat?.radio.action).toBe('shrink');
    expect(sat?.radio.neededM).toBe(11_500);
    expect(res.body.plan.changes.length).toBeGreaterThanOrEqual(1);
  });

  it('stores an owner pin and reports it in the preview', async () => {
    const pin = await httpRequest<{ pin: { radioM: number } }>(
      port, 'POST', '/api/demo/autotune/pins', { gridId: SAT, radioM: 42_000, note: 'max uplink' },
    );
    expect(pin.status).toBe(200);
    expect(pin.body.pin.radioM).toBe(42_000);
    const preview = await httpRequest<{ plan: { nodes: { gridId: string; radio: { action: string; neededM: number } }[] } }>(
      port, 'POST', '/api/demo/autotune/preview', {},
    );
    const sat = preview.body.plan.nodes.find((n) => n.gridId === SAT);
    expect(sat?.radio.action).toBe('pinned');
    expect(sat?.radio.neededM).toBe(42_000);
    const del = await httpRequest<{ cleared: boolean }>(port, 'POST', '/api/demo/autotune/pins', { gridId: SAT, clear: true });
    expect(del.body.cleared).toBe(true);
  });
});
