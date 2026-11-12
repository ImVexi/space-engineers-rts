import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { loadPlanetCatalog } from '../src/planner/planets.js';
import {
  OWNER_SATELLITE,
  hardwareFor,
  hardwareFrom,
  hardwareFromLiveProfile,
  type StagingHardware,
} from '../src/demo/staging/hardware.js';
import {
  HOLD_MARGIN,
  decideStaging,
  actuatorKey,
  maySwitch,
  MIN_DWELL_MS,
} from '../src/demo/staging/policy.js';
import { StagingController, ordersFor } from '../src/demo/staging/controller.js';

const EARTH = loadPlanetCatalog().find((p) => p.name === 'EarthLike')!;

/** Hull mixes the policy must handle. */
const HULLS: Record<string, StagingHardware> = {
  'atmo + H2 (Escort TT-420)': hardwareFor('Escort TT-420', null, null).hardware!,
  'H2 only (small sat)': hardwareFrom({
    id: 'h2-only',
    name: 'H2 only small satellite',
    massKg: 10_000,
    thrustCounts: { h2: { SmallBlockLargeHydrogenThrust: 1 } },
    h2TankLitres: 500_000,
    batteryMWh: 0.05,
    source: 'test fixture from CubeBlocks definitions',
  }),
  'ion + H2 (4 small ion, 1 large H2)': hardwareFrom({
    id: 'ion-h2',
    name: 'ion + H2',
    massKg: 50_000,
    thrustCounts: {
      ion: { SmallBlockLargeThrust: 4 },
      h2: { LargeBlockLargeHydrogenThrust: 1 },
    },
    h2TankLitres: 500_000,
    batteryMWh: 1,
    source: 'test fixture from CubeBlocks definitions',
  }),
  "owner's satellite (12 atmo + 10 H2, 18,965 kg)": OWNER_SATELLITE,
};

function decisionAt(hull: StagingHardware, altitudeM: number, phase: 'climb' | 'hold', overrides = {}) {
  return decideStaging(hull, EARTH, {
    phase,
    altitudeM,
    verticalSpeedMps: phase === 'climb' ? 50 : 0,
    batteryPct: 80,
    massKg: null,
    ...overrides,
  });
}

describe('staging policy across altitude (EarthLike 0-60 km)', () => {
  it.each(Object.entries(HULLS))('%s: decisions are consistent over the whole climb', (_name, hull) => {
    let previous: boolean | null = null;
    for (let alt = 0; alt <= 60_000; alt += 250) {
      const d = decisionAt(hull, alt, 'climb');
      expect(Number.isFinite(d.requiredN)).toBe(true);
      expect(d.availableN.atmo).toBeGreaterThanOrEqual(0);
      // H2 is on exactly for a real gap, never for a covered requirement.
      if (d.requiredN > 0) {
        const gap = d.requiredN - d.availableN.atmo - d.availableN.ion;
        expect(d.h2Enabled).toBe(gap > 0.5 && d.availableN.h2 > 0);
      } else {
        expect(d.h2Enabled).toBe(false);
      }
      // Coverage percentages never exceed 100 and hydrogen is the remainder.
      for (const pct of Object.values(d.coverPct)) expect(pct).toBeGreaterThanOrEqual(0);
      expect(d.coverPct.atmo).toBeLessThanOrEqual(100);
      if (alt > 0 && previous !== null && d.h2Enabled !== previous) {
        // A flip is a real threshold crossing, not numeric noise.
        expect(Math.abs(d.h2GapN)).toBeLessThan(60_000);
      }
      previous = d.h2Enabled;
    }
  });

  it('owner satellite: H2 off below ~9 km, on through the gravity well, off in zero-g', () => {
    expect(decisionAt(OWNER_SATELLITE, 0, 'climb').h2Enabled).toBe(false);
    expect(decisionAt(OWNER_SATELLITE, 5_000, 'climb').h2Enabled).toBe(false);
    expect(decisionAt(OWNER_SATELLITE, 9_000, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(OWNER_SATELLITE, 20_000, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(OWNER_SATELLITE, 40_000, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(OWNER_SATELLITE, 44_000, 'climb').h2Enabled).toBe(false);
    expect(decisionAt(OWNER_SATELLITE, 60_000, 'climb').h2Enabled).toBe(false);
  });

  it('ion takes over from hydrogen in vacuum on a mixed hull', () => {
    const hull = HULLS['ion + H2 (4 small ion, 1 large H2)']!;
    expect(decisionAt(hull, 0, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(hull, 5_000, 'climb').h2Enabled).toBe(true);
    // 20 km: gravity is down to ~3 m/s2 and four small ions give 0.69 MN.
    expect(decisionAt(hull, 20_000, 'climb').h2Enabled).toBe(false);
  });

  it('H2-only hull holds hydrogen on until gravity is cut', () => {
    const hull = HULLS['H2 only (small sat)']!;
    expect(decisionAt(hull, 0, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(hull, 20_000, 'climb').h2Enabled).toBe(true);
    expect(decisionAt(hull, 44_000, 'climb').h2Enabled).toBe(false);
  });

  it('uses the documented climb/hold margins', () => {
    const climb = decisionAt(OWNER_SATELLITE, 2_000, 'climb');
    const hold = decisionAt(OWNER_SATELLITE, 2_000, 'hold');
    expect(climb.margin).toBe(1.3);
    expect(hold.margin).toBe(HOLD_MARGIN);
    expect(climb.requiredN).toBeGreaterThan(hold.requiredN);
  });
});

describe('staging hysteresis', () => {
  const key = actuatorKey({ h2Enabled: true, h2Scope: 'all', stockpile: false });
  const other = actuatorKey({ h2Enabled: false, h2Scope: 'all', stockpile: false });

  it('refuses a flap inside the 10 s dwell window', () => {
    expect(
      maySwitch({ previousKey: other, nextKey: key, lastSwitchAt: 1_000, now: 1_000 + MIN_DWELL_MS - 1, emergency: false }),
    ).toBe(false);
    expect(
      maySwitch({ previousKey: other, nextKey: key, lastSwitchAt: 1_000, now: 1_000 + MIN_DWELL_MS, emergency: false }),
    ).toBe(true);
  });

  it('does nothing when the actuator state is unchanged', () => {
    expect(maySwitch({ previousKey: key, nextKey: key, lastSwitchAt: 5, now: 99_999, emergency: false })).toBe(false);
  });

  it('emergency bypasses the dwell window', () => {
    expect(
      maySwitch({ previousKey: other, nextKey: key, lastSwitchAt: 1_000, now: 1_001, emergency: true }),
    ).toBe(true);
  });
});

describe('staging emergency override', () => {
  it('enables every bank on a fast descent while holding', () => {
    const d = decisionAt(OWNER_SATELLITE, 10_000, 'hold', { verticalSpeedMps: -6.2 });
    expect(d.emergency).toBe(true);
    expect(d.emergencyReason).toMatch(/-6\.2 m\/s/);
    expect(d.h2Enabled).toBe(true);
    expect(d.stockpile).toBe(false);
    expect(d.reason).toMatch(/EMERGENCY/);
  });

  it('enables every bank below 15 % battery', () => {
    const d = decisionAt(OWNER_SATELLITE, 0, 'hold', { batteryPct: 9 });
    expect(d.emergency).toBe(true);
    expect(d.emergencyReason).toMatch(/battery 9 %/);
    expect(d.h2Enabled).toBe(true);
  });

  it('does not trip at -4.9 m/s or 15 % battery', () => {
    expect(decisionAt(OWNER_SATELLITE, 10_000, 'hold', { verticalSpeedMps: -4.9 }).emergency).toBe(false);
    expect(decisionAt(OWNER_SATELLITE, 10_000, 'hold', { batteryPct: 15 }).emergency).toBe(false);
  });
});

describe('staging stockpile in zero-g', () => {
  it('stockpiles when parked above the gravity limit and H2 is not needed', () => {
    const d = decisionAt(OWNER_SATELLITE, 60_000, 'hold');
    expect(d.requiredN).toBe(0);
    expect(d.h2Enabled).toBe(false);
    expect(d.stockpile).toBe(true);
    expect(d.h2BurnLpsStaged).toBe(0);
  });

  it('does not stockpile while coasting through zero-g on a climb leg', () => {
    expect(decisionAt(OWNER_SATELLITE, 60_000, 'climb').stockpile).toBe(false);
  });

  it('does not stockpile inside the gravity well even with H2 off', () => {
    const d = decisionAt(OWNER_SATELLITE, 2_000, 'hold');
    expect(d.h2Enabled).toBe(false);
    expect(d.stockpile).toBe(false);
  });

  it('does not stockpile when hydrogen may be needed', () => {
    const d = decisionAt(OWNER_SATELLITE, 20_000, 'hold');
    expect(d.h2Enabled).toBe(true);
    expect(d.stockpile).toBe(false);
  });

  it('does not stockpile on a hull with no hydrogen tank', () => {
    const eradicator = hardwareFor('Eradicator_mk.1', null, null).hardware!;
    const d = decisionAt(eradicator, 60_000, 'hold');
    expect(d.stockpile).toBe(false);
    const afterOff = ordersFor(d, { key: 'x', h2Enabled: false, h2Scope: 'all', stockpile: false });
    expect(afterOff.some((o) => o.label.startsWith('HydrogenTank'))).toBe(false);
  });
});

describe('staging fuel estimate and actuator orders', () => {
  it('reports fuel saved versus all banks enabled in the lower atmosphere', () => {
    const d = decisionAt(OWNER_SATELLITE, 2_000, 'hold');
    expect(d.h2BurnLpsStaged).toBe(0);
    expect(d.h2BurnLpsAllOn).toBeGreaterThan(0);
    expect(d.fuelSavedLps).toBeGreaterThan(0);
    expect(d.h2PctPerHour).toBeNull(); // staged burn is zero
  });

  it('reports no saving once hydrogen is genuinely needed', () => {
    const d = decisionAt(OWNER_SATELLITE, 20_000, 'hold');
    expect(d.h2BurnLpsStaged).toBeGreaterThan(0);
    expect(d.fuelSavedLps).toBe(0);
    expect(d.h2PctPerHour).toBeGreaterThan(0);
  });

  it('plans H2 off + stockpile off from a cold start, then only changes', () => {
    const off = decisionAt(OWNER_SATELLITE, 2_000, 'hold');
    const cold = ordersFor(off, null);
    expect(cold.map((o) => o.label)).toEqual(['Hydrogen:OnOff=false', 'HydrogenTank:Stockpile=false']);
    expect(cold[0]!.filter).toMatchObject({ type: 'Thruster', subtype: 'Hydrogen' });
    expect(cold[0]!.props).toEqual({ OnOff: false });
    expect(cold[0]!.actions).toEqual(['OnOff_Off']);

    expect(ordersFor(off, { key: actuatorKey(off), h2Enabled: false, h2Scope: 'all', stockpile: false })).toEqual([]);

    const on = decisionAt(OWNER_SATELLITE, 20_000, 'hold');
    const delta = ordersFor(on, { key: actuatorKey(off), h2Enabled: false, h2Scope: 'all', stockpile: false });
    expect(delta).toHaveLength(1);
    expect(delta[0]!.label).toBe('Hydrogen:OnOff=true');
  });
});

describe('staging controller (executor integration)', () => {
  function makeStore(): Store {
    return new Store(openDb(':memory:', { memory: true }));
  }

  function telemetryAt(store: Store, gridId: string, altitudeM: number, now: number, meta: Record<string, unknown> = {}) {
    store.upsertUnit({
      id: gridId,
      name: 'sat',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: { x: 0, y: 59_400 + altitudeM, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg: 18_965.4, powerFraction: 1, fuelFraction: 0.5, ...meta },
    });
  }

  const GRID = 'grid:126323015058751318';
  const PREFAB = `tagged:${GRID}`;

  function tick(ctl: StagingController, store: Store, now: number, altitudeM: number) {
    telemetryAt(store, GRID, altitudeM, now);
    ctl.tick({
      missionId: 'm1',
      idx: 0,
      label: 'slot-1',
      prefab: PREFAB,
      gridId: GRID,
      state: 'holding',
      unit: store.getUnit(GRID),
      planet: EARTH,
      now,
    });
  }

  function ack(store: Store, sent: Record<string, unknown>[], now: number): void {
    for (const payload of sent) {
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: 'order_result',
        detail: { eventType: 'order_result', data: { orderId: payload.orderId, ok: true, result: { applied: 1 } } },
        at: now,
      });
    }
    sent.length = 0;
  }

  it('writes H2 off through set_block_props, audits it, and exposes the state', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;

    tick(ctl, store, now, 2_000);
    expect(sent).toHaveLength(2);
    for (const payload of sent) {
      // T75: a set_block_props write is a legitimate action, so it leaves on
      // the production channel ('action') that every plugin build compiles.
      expect(payload.orderType).toBe('action');
      expect((payload.params as Record<string, unknown>).action).toBe('set_block_props');
      expect(payload.entityId).toBe(GRID);
    }
    expect(ctl.view(GRID)?.mode).toBe('active');

    ack(store, sent, now + 500);
    tick(ctl, store, now + 3_000, 2_000);

    const view = ctl.view(GRID)!;
    expect(view.h2).toBe('off');
    expect(view.stockpile).toBe(false);
    expect(view.altitudeM).toBe(2_000);
    expect(view.fuelSavedL).toBeGreaterThan(0);
    expect(ctl.line(GRID)).toMatch(/^H2 off · atmo 100% · ion 0%$/);

    const audit = store.listAudit(200).find((e) => e.action === 'staging_switch');
    expect(audit).toBeTruthy();
    const detail = audit!.detail as Record<string, unknown>;
    expect(detail.h2).toBe('off');
    expect(detail.altitudeM).toBe(2_000);
    expect(detail.h2FillPct).toBe(50);
    expect(detail.reason).toBeTruthy();
  });

  it('turns H2 back on when the drone climbs into thin air, after the dwell', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;

    tick(ctl, store, now, 2_000);
    ack(store, sent, now + 200);
    tick(ctl, store, now + 3_000, 2_000); // applied

    tick(ctl, store, now + 5_000, 20_000); // decision flips, dwell not met
    expect(sent).toHaveLength(0);
    expect(ctl.view(GRID)?.h2).toBe('off');

    tick(ctl, store, now + 15_000, 20_000);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.params as Record<string, unknown>).props).toEqual({ OnOff: true });
    ack(store, sent, now + 15_500);
    tick(ctl, store, now + 17_000, 20_000);
    expect(ctl.view(GRID)?.h2).toBe('on');
    expect(ctl.view(GRID)?.stockpile).toBe(false);
  });

  it('records a plugin rejection instead of claiming the switch applied', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;
    tick(ctl, store, now, 2_000);
    for (const payload of sent) {
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: 'order_result',
        detail: {
          eventType: 'order_result',
          data: { orderId: payload.orderId, ok: true, result: { count: 10, blocksWithErrors: 10 } },
        },
        at: now + 500,
      });
    }
    sent.length = 0;
    tick(ctl, store, now + 3_000, 2_000);
    expect(ctl.view(GRID)?.lastError).toMatch(/10 block\(s\) rejected/);
    expect(ctl.view(GRID)?.h2).toBeNull(); // never confirmed on the game thread
  });

  it('does not write on stale telemetry', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;
    telemetryAt(store, GRID, 2_000, now - 120_000);
    ctl.tick({
      missionId: 'm1',
      idx: 0,
      label: 'slot-1',
      prefab: PREFAB,
      gridId: GRID,
      state: 'holding',
      unit: store.getUnit(GRID),
      planet: EARTH,
      now,
    });
    expect(sent).toHaveLength(0);
    expect(ctl.view(GRID)?.mode).toBe('stale-telemetry');
  });

  it('asks the live grid for a profile instead of refusing an unregistered tagged hull', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;
    telemetryAt(store, 'grid:999', 2_000, now);
    ctl.tick({
      missionId: 'm1',
      idx: 1,
      label: 'unknown',
      prefab: 'tagged:grid:999',
      gridId: 'grid:999',
      state: 'holding',
      unit: store.getUnit('grid:999'),
      planet: EARTH,
      now,
    });
    // One read-only profile order; no actuator write until the read lands.
    expect(sent).toHaveLength(1);
    expect((sent[0]!.params as Record<string, unknown>).action).toBe('profile');
    expect(ctl.view('grid:999')?.mode).toBe('profile-pending');
    expect(String(ctl.view('grid:999')?.reason)).toMatch(/live profile requested/);
  });
});

describe('staging from a live plugin profile (cloned grid, T15)', () => {
  const CLONE = 'grid:94203702558543397';
  const LIVE = {
    gridId: CLONE,
    massKg: 19_240.5,
    thrusters: { count: 22, atmoN: 1_152_000, ionN: 0, h2N: 984_000 },
    power: { batteryCapacityMWh: 3.6, batteryStoredMWh: 3.24, batteries: [] },
    fuel: { tanks: [{ capacity: 60_000, filledRatio: 0.42 }, { capacity: 15_000, filledRatio: 0.42 }] },
    integrity: { fraction: 1 },
  };

  it('builds hardware from mass, per-type thrust, tanks and batteries', () => {
    const hw = hardwareFromLiveProfile(CLONE, LIVE)!;
    expect(hw).not.toBeNull();
    expect(hw.massKg).toBe(19_240.5);
    expect(hw.thrustN).toEqual({ atmo: 1_152_000, ion: 0, h2: 984_000 });
    expect(hw.h2TankLitres).toBe(75_000);
    expect(hw.h2Fill).toBeCloseTo(0.42, 4);
    expect(hw.batteryMWh).toBe(3.6);
    expect(hw.batteryFill).toBeCloseTo(0.9, 4);
    expect(hw.source).toMatch(/live plugin profile/);
  });

  it('refuses a read that cannot support a decision', () => {
    expect(hardwareFromLiveProfile(CLONE, { massKg: 0, thrusters: { atmoN: 1_152_000 } })).toBeNull();
    expect(hardwareFromLiveProfile(CLONE, { massKg: 19_000, thrusters: {} })).toBeNull();
  });

  function makeStore(): Store {
    return new Store(openDb(':memory:', { memory: true }));
  }

  function tickAt(ctl: StagingController, store: Store, now: number, altitudeM: number, massKg = 19_240.5): void {
    store.upsertUnit({
      id: CLONE,
      name: 'SAT-L-0016',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: now,
      pos: { x: 0, y: 59_400 + altitudeM, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      meta: { massKg, powerFraction: 0.9, fuelFraction: 0.42 },
    });
    ctl.tick({
      missionId: 'm-clone',
      idx: 0,
      label: 'clone',
      prefab: `tagged:${CLONE}`,
      gridId: CLONE,
      state: 'holding',
      unit: store.getUnit(CLONE),
      planet: EARTH,
      now,
    });
  }

  it('reads the profile once, caches it and stages the clone from it', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;

    tickAt(ctl, store, now, 2_000);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect((request.params as Record<string, unknown>).action).toBe('profile');
    expect(ctl.view(CLONE)?.mode).toBe('profile-pending');

    // The plugin answers the read.
    store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: { eventType: 'order_result', data: { orderId: request.orderId, ok: true, result: LIVE } },
      at: now + 500,
    });
    sent.length = 0;
    tickAt(ctl, store, now + 3_000, 2_000);

    // 2 km: atmosphere covers the climb, so H2 goes off through the same
    // set_block_props path the registry-backed hulls use.
    const writes = sent.filter((p) => (p.params as Record<string, unknown>).action === 'set_block_props');
    expect(writes.length).toBeGreaterThan(0);
    expect((writes[0]!.params as Record<string, unknown>).props).toEqual({ OnOff: false });
    expect(ctl.view(CLONE)?.mode).toBe('active');
    expect(String(ctl.view(CLONE)?.hardwareSource)).toMatch(/live plugin profile/);
    expect(store.listAudit(200).some((e) => e.action === 'staging_profile_live')).toBe(true);

    // Second tick inside the refresh window: no second profile read.
    sent.length = 0;
    tickAt(ctl, store, now + 6_000, 2_000);
    expect(sent.some((p) => (p.params as Record<string, unknown>).action === 'profile')).toBe(false);
  });

  it('re-reads the profile when the measured mass drifts (cargo changed)', () => {
    const store = makeStore();
    const sent: Record<string, unknown>[] = [];
    const ctl = new StagingController({ store, send: (p) => (sent.push(p), true) });
    const now = 1_800_000_000_000;

    tickAt(ctl, store, now, 2_000);
    const request = sent[0]!;
    store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: { eventType: 'order_result', data: { orderId: request.orderId, ok: true, result: LIVE } },
      at: now + 400,
    });
    sent.length = 0;
    tickAt(ctl, store, now + 3_000, 2_000);
    expect(ctl.view(CLONE)?.mode).toBe('active');
    // Acknowledge the staging batch so the next tick is free to resolve hardware.
    for (const payload of sent) {
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: 'order_result',
        detail: { eventType: 'order_result', data: { orderId: payload.orderId, ok: true, result: { applied: 1 } } },
        at: now + 3_500,
      });
    }

    // +8 % mass: the cached profile no longer describes the grid.
    sent.length = 0;
    tickAt(ctl, store, now + 6_000, 2_000, 20_800);
    const reread = sent.find((p) => (p.params as Record<string, unknown>).action === 'profile');
    expect(reread).toBeTruthy();
  });
});

describe('owner satellite staging registry (T13)', () => {
  it('resolves hardware for all four owner satellites, and refuses an unknown tagged grid', () => {
    const ids = [
      'grid:107519913664561774',
      'grid:126323015058751318',
      'grid:113586721763627228',
      'grid:115081011520040319',
    ];
    for (const id of ids) {
      const lookup = hardwareFor('existing', id, 18_000);
      expect(lookup.hardware, id).not.toBeNull();
      expect(lookup.hardware!.thrustN.atmo).toBeGreaterThan(0);
      expect(lookup.hardware!.massKg).toBe(18_000);
    }
    expect(hardwareFor('existing', 'grid:999', 18_000).hardware).toBeNull();
  });
});
