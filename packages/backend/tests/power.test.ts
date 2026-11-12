import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeClock } from './helpers.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import {
  computeRunway,
  estimateRates,
  evaluatePowerAlerts,
  isDaylight,
  parseProfileResult,
  powerTelemetry,
  sunElevationDeg,
  type PowerSample,
  type PowerSnapshot,
} from '../src/demo/power/index.js';
import { PowerPoller } from '../src/demo/power/poller.js';
import { powerBudget } from '../src/demo/power/budget.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

const NOW = 1_800_000_000_000;
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const GRID = 'grid:100';

/** A profile result shaped exactly like the plugin's `profile` action. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gridId: GRID,
    name: 'SAT-R-0002',
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
      h2FillPct: 55,
      tanks: [{ name: 'H2 Tank', subtype: 'LargeHydrogenTank', filledRatio: 0.55, filledL: 8_250_000, capacity: 15_000_000, stockpile: false }],
    },
    ...overrides,
  };
}

describe('T20 profile parsing', () => {
  it('normalises battery, solar, H2, uranium and charge state', () => {
    const snap = parseProfileResult(GRID, profile(), NOW);
    expect(snap.batteryPct).toBe(60);
    expect(snap.batteryStoredMWh).toBe(1.8);
    expect(snap.charge).toBe('discharging');
    expect(snap.netMw).toBe(-0.28);
    expect(snap.solarEfficiency).toBe(0.5);
    expect(snap.h2Pct).toBe(55);
    expect(snap.h2Litres).toBe(8_250_000);
    expect(snap.radioRangeM).toBe(50_000);
    expect(snap.underControl).toBe(false);
    expect(snap.missing).toEqual([]);
  });

  it('keeps -1 sentinels and absent fields null instead of inventing numbers', () => {
    const snap = parseProfileResult(GRID, profile({ power: { batteryPct: -1, uraniumPct: -1, solarMaxMw: 0 } }), NOW);
    expect(snap.batteryPct).toBeNull();
    expect(snap.uraniumPct).toBeNull();
    expect(snap.solarEfficiency).toBeNull();
    expect(snap.missing).toContain('battery');
    expect(snap.missing).toContain('charge state');
  });

  it('reads manual control from the plugin profile', () => {
    const snap = parseProfileResult(GRID, profile({ control: { underControl: true, by: 'owner' } }), NOW);
    expect(snap.underControl).toBe(true);
    expect(snap.controlledBy).toBe('owner');
  });
});

describe('BUG-A/B: unread is not zero', () => {
  it('marks a profile with no power/fuel section unread, with a reason', () => {
    const snap = parseProfileResult(GRID, { gridId: GRID, name: 'SAT-L-0005' }, NOW);
    expect(snap.h2Pct).toBeNull();
    expect(snap.h2State).toBe('unread');
    expect(snap.h2UnreadReason).toMatch(/fuel section/);
    expect(snap.batteryState).toBe('unread');
    expect(snap.batteryUnreadReason).toMatch(/power section/);
  });

  it('marks an unreadable tank unread and never sums it as 0 L', () => {
    const snap = parseProfileResult(GRID, profile({
      fuel: {
        h2FillPct: -1,
        h2TankCount: 1,
        tanks: [{
          name: 'H2 Tank', subtype: 'LargeHydrogenTank',
          filledRatio: null, filledL: null, capacity: 15_000,
          readState: 'unread', unreadReason: 'engine threw',
        }],
      },
    }), NOW);
    expect(snap.h2Pct).toBeNull();
    expect(snap.h2State).toBe('unread');
    expect(snap.h2UnreadReason).toBe('engine threw');
    expect(snap.h2Litres).toBeNull();
    expect(snap.missing).toContain('H2');
  });

  it('does not treat an oxygen tank as hydrogen fuel', () => {
    const snap = parseProfileResult(GRID, profile({
      fuel: {
        h2FillPct: -1,
        tanks: [{ name: 'O2 Tank', subtype: 'LargeOxygenTank', filledRatio: 0, filledL: 0, capacity: 15_000 }],
      },
    }), NOW);
    expect(snap.h2Pct).toBeNull();
    expect(snap.h2State).toBe('absent');
  });

  it('never raises a fuel alert for an unread tank', () => {
    const snap = parseProfileResult(GRID, profile({
      fuel: { h2FillPct: -1, h2TankCount: 1, readState: 'unread', tanks: [] },
    }), NOW);
    const alerts = evaluatePowerAlerts({
      snap,
      runway: computeRunway(snap, estimateRates([]), { zeroG: false }),
      rates: estimateRates([]),
      daylight: true,
      zeroG: false,
      now: NOW,
    });
    expect(alerts.map((a) => a.kind)).not.toContain('needs-fuel');
  });

  it('exposes the read state in the telemetry block', () => {
    const snap = parseProfileResult(GRID, profile(), NOW);
    const block = powerTelemetry(snap, {
      rates: estimateRates([]),
      runway: computeRunway(snap, estimateRates([]), { zeroG: false }),
      daylight: true,
      zeroG: false,
      alerts: [],
    }) as { h2State?: unknown; batteryState?: unknown; power: { h2: { state?: unknown } } };
    expect(block.h2State).toBe('read');
    expect(block.batteryState).toBe('read');
    expect(block.power.h2.state).toBe('read');
  });
});

describe('T20 rates and runways', () => {
  const series: PowerSample[] = [
    { at: NOW, batteryPct: 80, h2Pct: 60, h2Litres: 9_000_000, uraniumKg: 20, solarPct: 40, netMw: -0.4 },
    { at: NOW + 10 * 60_000, batteryPct: 70, h2Pct: 59.5, h2Litres: 8_925_000, uraniumKg: 19.9, solarPct: 41, netMw: -0.4 },
    { at: NOW + 20 * 60_000, batteryPct: 60, h2Pct: 59, h2Litres: 8_850_000, uraniumKg: 19.8, solarPct: 42, netMw: -0.4 },
  ];

  it('computes per-hour rates from samples, not from one reading', () => {
    const rates = estimateRates(series);
    expect(rates.source).toBe('sampled');
    expect(rates.batteryPctPerHour).toBeCloseTo(-60, 0);
    expect(rates.h2PctPerHour).toBeCloseTo(-3, 0);
    expect(rates.uraniumKgPerHour).toBeCloseTo(-0.6, 1);
  });

  it('refuses a rate from a single sample or a too-short window', () => {
    expect(estimateRates([series[0]!]).batteryPctPerHour).toBeNull();
    expect(estimateRates([series[0]!, { ...series[1]!, at: NOW + 10_000 }]).batteryPctPerHour).toBeNull();
  });

  it('derives battery and fuel runways and takes the smallest', () => {
    const snap = parseProfileResult(GRID, profile(), NOW);
    const rates = estimateRates(series);
    const runway = computeRunway(snap, rates, { zeroG: false });
    // 1.8 MWh at 0.28 MW = 385.7 min; H2 55% at 3 %/h = 1100 min.
    expect(runway.powerRunwayMin).toBeCloseTo(385.7, 0);
    expect(runway.fuelRunwayMin).toBeCloseTo(1100, 0);
    expect(runway.runwayMin).toBeCloseTo(385.7, 0);
    expect(runway.expectedLife.kind).toBe('minutes');
  });

  it('reports no limit for a station, zero-g and net-positive idle grids', () => {
    const station = { ...parseProfileResult(GRID, profile({ isStatic: true }), NOW) };
    const rates = estimateRates(series);
    expect(computeRunway(station, rates, { zeroG: false }).expectedLife.kind).toBe('no-limit');
    const zeroG = parseProfileResult(GRID, profile(), NOW);
    expect(computeRunway(zeroG, rates, { zeroG: true }).expectedLife.kind).toBe('no-limit');
    const idle = parseProfileResult(GRID, profile({ power: { ...(profile().power as object), netMw: 0.2 } }), NOW);
    expect(computeRunway(idle, { ...rates, h2PctPerHour: 0, uraniumKgPerHour: 0 }, { zeroG: false }).expectedLife.kind).toBe('no-limit');
  });
});

describe('T20 alerts and daylight', () => {
  const snap = parseProfileResult(GRID, profile(), NOW);
  const rates = estimateRates([
    { at: NOW, batteryPct: 30, h2Pct: 25, h2Litres: 3_750_000, uraniumKg: 5, solarPct: 20, netMw: -0.4 },
    { at: NOW + 20 * 60_000, batteryPct: 20, h2Pct: 20, h2Litres: 3_000_000, uraniumKg: 4, solarPct: 20, netMw: -0.4 },
  ]);
  const low = parseProfileResult(GRID, profile({
    power: {
      ...(profile().power as object),
      batteryPct: 20, batteryStoredMWh: 0.6, netMw: -0.5,
      uraniumKg: 4, uraniumCapacityKg: 100, uraniumPct: 4,
      solarEfficiency: 0.12, solarActualMw: 0.08, solarMaxMw: 0.64,
    },
    fuel: { h2FillPct: 22, tanks: [] },
  }), NOW);

  it('fires low battery, draining, fuel, uranium and solar-pointing alerts', () => {
    const runway = computeRunway(low, rates, { zeroG: false });
    const alerts = evaluatePowerAlerts({ snap: low, runway, rates, daylight: true, zeroG: false, now: NOW });
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('low-battery');
    expect(kinds).toContain('draining');
    expect(kinds).toContain('needs-fuel');
    expect(kinds).toContain('uranium-low');
    expect(kinds).toContain('solar-pointing');
    expect(alerts.find((a) => a.kind === 'solar-pointing')?.why).toContain('12%');
  });

  it('does not blame solar pointing at night', () => {
    const runway = computeRunway(low, rates, { zeroG: false });
    const alerts = evaluatePowerAlerts({ snap: low, runway, rates, daylight: false, zeroG: false, now: NOW });
    expect(alerts.map((a) => a.kind)).not.toContain('solar-pointing');
  });

  it('adds a manual-control alert when a player pilots the grid', () => {
    const manual = parseProfileResult(GRID, profile({ control: { underControl: true, by: 'owner' } }), NOW);
    const alerts = evaluatePowerAlerts({
      snap: manual,
      runway: computeRunway(manual, rates, { zeroG: false }),
      rates,
      daylight: true,
      zeroG: false,
      now: NOW,
    });
    expect(alerts.find((a) => a.kind === 'manual-control')?.why).toContain('owner');
  });

  it('computes sun elevation from the published sun vector and the local radial', () => {
    const pos = { x: EARTH.center.x, y: EARTH.center.y, z: EARTH.center.z + EARTH.surfaceRadiusM + 1000 };
    const up = { x: 0, y: 0, z: 1 };
    expect(sunElevationDeg(pos, up, EARTH)).toBeCloseTo(90, 1);
    expect(isDaylight(pos, up, EARTH)).toBe(true);
    expect(isDaylight(pos, { x: 0, y: 0, z: -1 }, EARTH)).toBe(false);
    expect(isDaylight(pos, null, EARTH)).toBeNull();
  });

  it('emits the flat field names the Fleet page feature-detects', () => {
    const block = powerTelemetry(snap, {
      rates: estimateRates([]),
      runway: computeRunway(snap, estimateRates([]), { zeroG: false }),
      daylight: true,
      zeroG: false,
      alerts: [],
    });
    for (const key of ['batteryPct', 'chargeState', 'netMw', 'solarActualMw', 'solarMaxMw', 'h2Pct', 'h2Litres', 'uraniumPct', 'runwayMin', 'isStatic']) {
      expect(block).toHaveProperty(key);
    }
    expect(block.power).toBeTruthy();
  });
});

describe('T20 poller scheduling', () => {
  function makeStore() {
    const store = new Store(openDb(':memory:', { memory: true }));
    store.setKv(PROVISION_CAPABILITIES_KV, JSON.stringify({
      at: NOW,
      grids: [
        { gridId: 'grid:a', name: 'A', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 1, isStatic: false },
        { gridId: 'grid:b', name: 'B', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 1, isStatic: false },
        { gridId: 'grid:c', name: 'C', profile: 'DRONE', broadcasting: true, radioRadiusM: 50_000, laserCount: 0, massKg: 1, isStatic: false },
      ],
    }));
    return store;
  }

  it('staggers first polls and respects the per-grid interval', async () => {
    const clock = makeClock(NOW);
    const sent: { id: string; at: number }[] = [];
    const poller = new PowerPoller({
      store: makeStore(),
      hub: { isConnected: () => true, send: () => true },
      clock: clock.now,
      sendProfile: async (id) => {
        sent.push({ id, at: clock.now() });
        return profile({ gridId: id, name: id });
      },
    });
    await poller.tick(NOW);
    expect(sent).toHaveLength(1);
    clock.advance(10_000);
    await poller.tick(clock.now());
    expect(sent).toHaveLength(2);
    clock.advance(20_000);
    await poller.tick(clock.now());
    // All three were polled once; none twice yet (interval is 30 s from its own start).
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.id)).size).toBe(3);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(333);
  });

  it('skips a grid that a player is piloting', async () => {
    const clock = makeClock(NOW);
    const polled: string[] = [];
    const poller = new PowerPoller({
      store: makeStore(),
      hub: { isConnected: () => true, send: () => true },
      clock: clock.now,
      sendProfile: async (id) => {
        polled.push(id);
        return profile({ gridId: id, name: id, control: { underControl: id === 'grid:a', by: 'owner' } });
      },
    });
    await poller.tick(NOW);
    clock.advance(31_000);
    await poller.tick(clock.now());
    clock.advance(1_000);
    await poller.tick(clock.now());
    expect(poller.summary().manualControl).toContain('grid:a');
    expect(poller.summary().manualSkipped).toBeGreaterThan(0);
    expect(polled.filter((id) => id === 'grid:a').length).toBe(1);
  });

  it('keeps the latest snapshot and a 1-minute history bucket', async () => {
    const clock = makeClock(NOW);
    const poller = new PowerPoller({
      store: makeStore(),
      hub: { isConnected: () => true, send: () => true },
      clock: clock.now,
      sendProfile: async (id) => profile({ gridId: id }),
    });
    poller.ingest('grid:a', profile(), NOW);
    poller.ingest('grid:a', profile({ power: { ...(profile().power as object), batteryPct: 58 } }), NOW + 60_000);
    expect(poller.snapshot('grid:a')?.batteryPct).toBe(58);
    const buckets = poller.buckets('grid:a');
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.minute % 60_000).toBe(0);
  });
});

describe('T30 power budget', () => {
  it('passes a station with 4 large panels and one battery at the equator', () => {
    const b = powerBudget({
      slotAltM: 45_000, lat: 0, planet: EARTH, flightMode: 'station',
      design: { radioRangeM: 50_000, radioAntennas: 1, solarLarge: 4, batteryLarge: 1 },
    });
    expect(b.verdict).toBe('ok-24-7');
    expect(b.need.avgMw).toBeCloseTo(0.21, 2);
    expect(b.summary).toContain('OK 24/7');
  });

  it('reports the night shortfall in MWh when the battery is too small', () => {
    const b = powerBudget({
      slotAltM: 10_000, lat: 65, region: 'polar', flightMode: 'atmo-hover',
      design: { radioRangeM: 50_000, radioAntennas: 1, lasers: 2, hoverDrawMw: 0.9, solarLarge: 2, batterySmall: 1 },
    });
    expect(b.verdict).toBe('short-at-night');
    expect(b.shortfallMWh).toBeGreaterThan(0);
    expect(b.summary).toContain('short at night');
    expect(b.suggestion.blocks.solarLarge).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The measured defect (data/survival-loop-verify-20261111.md): the plugin added
 * a DISCHARGING battery's own CurrentOutput to production, so SAT-R-0001 read
 * `discharging` with netMw +1.5042 MW and every grid's power runway was null.
 * The plugin now publishes net = generation - non-battery consumption; these
 * tests pin the backend half on exactly those numbers.
 */
describe('T77 power accounting: batteries are storage, not production', () => {
  function measuredProfile(power: Record<string, unknown>): Record<string, unknown> {
    return profile({
      name: 'SAT-R-0001',
      isStatic: false,
      power: {
        batteryStoredMWh: 3,
        batteryCapacityMWh: 3,
        batteryPct: 100,
        batteryInputMw: 0,
        batteryOutputMw: 1.7043,
        chargeState: 'discharging',
        // production 0 (no solar, no reactor, no H2 engine), draw 0.2001 MW
        netMw: -0.2001,
        generationMw: 0,
        consumerDrawMw: 0.2001,
        batteryChargeMw: 0,
        solarActualMw: 0,
        solarMaxMw: 0,
        solarEfficiency: -1,
        reactorOutputMw: 0,
        reactorMaxMw: 0,
        antennaDrawMw: 0.2,
        laserDrawMw: 0,
        deviceDrawMw: 0.2001,
        uraniumKg: 0,
        uraniumCapacityKg: 0,
        uraniumPct: -1,
        reactors: [],
        solar: [],
        batteries: [{ name: 'Battery 4', storedMWh: 3, capacityMWh: 3, inputMw: 0, outputMw: 1.7043, charging: false }],
        batteryCount: 1,
        readState: 'read',
        unread: [],
        ...power,
      },
    });
  }

  it('gives the measured battery-only grid a finite runway', () => {
    const snap = parseProfileResult(GRID, measuredProfile({}), NOW);
    expect(snap.charge).toBe('discharging');
    expect(snap.netMw).toBeCloseTo(-0.2001, 4);
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    // 3 MWh / 0.2001 MW = 899.5 min - finite, which is the whole point.
    expect(runway.powerRunwayMin).not.toBeNull();
    expect(runway.powerRunwayMin!).toBeCloseTo(899.6, 0);
    expect(runway.powerRunwayReason).toBe('draining');
    expect(runway.runwayMin).toBeCloseTo(899.6, 0);
  });

  it('the old positive net was why the runway was null - keep the sign honest', () => {
    // If a stale/older plugin build still sends the defect's +1.5042 MW, the
    // backend must not invent a runway from it; it must say the grid is charging.
    const snap = parseProfileResult(GRID, measuredProfile({ netMw: 1.5042, chargeState: 'discharging' }), NOW);
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    expect(runway.powerRunwayMin).toBeNull();
    expect(runway.expectedLife.kind).toBe('no-limit');
  });

  it('charging is null WITH a reason, never 0 minutes', () => {
    const snap = parseProfileResult(
      GRID,
      measuredProfile({ netMw: 0.8, batteryInputMw: 0.8, batteryOutputMw: 0, chargeState: 'charging' }),
      NOW,
    );
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    expect(runway.powerRunwayMin).toBeNull();
    expect(runway.powerRunwayReason).toBe('charging');
    const telemetry = powerTelemetry(snap, {
      rates: estimateRates([]), runway, daylight: true, zeroG: false, alerts: [],
    });
    expect(telemetry.powerRunwayReason).toBe('charging');
    expect((telemetry.power as { runways: { powerReason: string } }).runways.powerReason).toBe('charging');
  });

  it('no battery on the grid reads absent, not 0', () => {
    const snap = parseProfileResult(
      GRID,
      measuredProfile({ batteryStoredMWh: 0, batteryCapacityMWh: 0, batteryPct: -1, batteries: [], batteryCount: 0, readState: 'no-batteries' }),
      NOW,
    );
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    expect(runway.powerRunwayMin).toBeNull();
    expect(runway.powerRunwayReason).toBe('absent');
  });

  it('a deficit with an unread stored charge is unread, not a 0-minute runway', () => {
    const snap = parseProfileResult(GRID, measuredProfile({ batteryStoredMWh: null, batteryPct: null }), NOW);
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    expect(runway.powerRunwayMin).toBeNull();
    expect(runway.powerRunwayReason).toBe('unread');
  });

  it('forwards generationMw / consumerDrawMw / batteryChargeMw into the telemetry block', () => {
    // The plugin publishes the breakdown next to netMw; before this the backend
    // dropped it, so the site could not explain a negative net.
    const snap = parseProfileResult(GRID, measuredProfile({}), NOW);
    expect(snap.generationMw).toBe(0);
    expect(snap.consumerDrawMw).toBeCloseTo(0.2001, 4);
    expect(snap.batteryChargeMw).toBe(0);
    const runway = computeRunway(snap, estimateRates([]), { zeroG: false });
    const telemetry = powerTelemetry(snap, { rates: estimateRates([]), runway, daylight: true, zeroG: false, alerts: [] });
    expect(telemetry.generationMw).toBe(0);
    expect(telemetry.consumerDrawMw).toBeCloseTo(0.2001, 4);
    expect(telemetry.batteryChargeMw).toBe(0);
    const power = telemetry.power as {
      breakdown: { generationMw: number | null; consumerDrawMw: number | null; batteryChargeMw: number | null; netMw: number | null };
      runways: { powerMin: number | null };
    };
    expect(power.breakdown.generationMw).toBe(0);
    expect(power.breakdown.consumerDrawMw).toBeCloseTo(0.2001, 4);
    expect(power.breakdown.batteryChargeMw).toBe(0);
    expect(power.breakdown.netMw).toBeCloseTo(-0.2001, 4);
    // A profile that does not report the breakdown stays null, never 0.
    const noBreakdown = parseProfileResult(
      GRID,
      measuredProfile({ generationMw: undefined, consumerDrawMw: undefined, batteryChargeMw: undefined }),
      NOW,
    );
    expect(noBreakdown.generationMw).toBeNull();
    expect(noBreakdown.consumerDrawMw).toBeNull();
  });
});
