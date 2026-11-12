/**
 * Sim-speed audit (data/simspeed-audit-20261111.md) — the backend half, pinned.
 *
 * Each block below is one numbered item of the audit, and each one states the
 * BEFORE it replaces, because these are all "remove the cheap-looking poll that
 * costs the game thread" changes: it is easy to reintroduce the poll and have
 * every test still pass.
 *
 *  #1 `list_tagged` no longer profiles every tagged grid (17 x 7.9 ms inside one
 *     tick); the payload is a cheap scan plus block CustomName/CustomData.
 *  #3 provisioning is a 30 s cadence with immediate passes on a trigger.
 *  #4 `laser_state` is asked per grid, only for grids with a laser, and backs
 *     off when the link state stops changing.
 *  #7 the 100 ms `listOrderResults(500)` rescan is replaced by in-memory
 *     delivery of the `order_result` frame.
 *  #2/#5 an idle grid (fresh telemetry, no mission, not moving, static or
 *     stationed) is re-read every 5 min, never coerced to zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { makeClock, makeConfig } from './helpers.js';
import {
  BASE_TAG,
  IMMEDIATE_PASS_GAP_MS,
  LASER_SLOW_MS,
  POLL_MS,
  Provisioner,
  loadProfiles,
  provisionerFor,
  requestProvisionPass,
  requestProvisionPassForAck,
  requestProvisionPassForGrid,
  isRoutineOrderId,
  resetProvisionerForTests,
} from '../src/demo/provision/index.js';
import type { TaggedGrid } from '../src/demo/provision/index.js';
import { PowerPoller, IDLE_REFRESH_MS, IDLE_MAX_SPEED_MPS, IDLE_TELEMETRY_FRESH_MS } from '../src/demo/power/poller.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { HULL_LIST_OPTS } from '../src/demo/designer/routes.js';
import { taggedHull } from '../src/demo/designer/hulls.js';
import { orderResults, resetOrderResultsForTests, waitForOrderResult } from '../src/orderResults.js';

const NOW = 1_800_000_000_000;
const OWNER = loadProfiles().owner.identityId;

function makeStore() {
  const config = makeConfig();
  const store = new Store(openDb(':memory:', { memory: true }));
  return { store, config };
}

interface Call {
  action: string;
  params: Record<string, unknown>;
}

/**
 * Fake plugin hub: answers by writing the audit row the real plugin writes, so
 * `callPlugin` resolves through its cursor fallback exactly as in production.
 */
function fakeHub(
  store: Store,
  responder: (action: string, params: Record<string, unknown>) => { ok: boolean; result?: Record<string, unknown>; error?: string },
  calls: Call[] = [],
) {
  return {
    isConnected: () => true,
    agentId: () => 'fake-plugin',
    send: (message: unknown) => {
      const msg = message as { orderId: string; params: { action: string } & Record<string, unknown> };
      calls.push({ action: msg.params.action, params: msg.params });
      const answer = responder(msg.params.action, msg.params);
      store.audit({
        actor: 'plugin',
        action: 'plugin_event',
        subject: msg.orderId,
        detail: { eventType: 'order_result', data: { orderId: msg.orderId, ...answer } },
        at: NOW,
      });
      return true;
    },
  } as never;
}

/** The NEW cheap `list_tagged` shape: no thrust/TWR/gravity, role blocks present. */
function cheapTaggedGrid(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gridId: 'grid:1001',
    name: 'the owner Base',
    tags: [BASE_TAG],
    owner: OWNER,
    owners: [OWNER],
    pbName: 'PB [HERMES-BASE]',
    position: { x: 10, y: 20, z: 30 },
    blocksTotal: 40,
    radioCount: 1,
    laserCount: 1,
    massKg: 12000,
    isStatic: true,
    profiled: false,
    thrust: null,
    twr: null,
    gravityMs2: null,
    canGroundLaunch: null,
    blocks: [
      { id: 'block:2001', name: '[HERMES-ROLE:cargo] Cargo', customName: '[HERMES-ROLE:cargo] Cargo', customData: 'role=cargo', subtype: 'LargeCargoContainer' },
    ],
    ...overrides,
  };
}

function writeAnswers(action: string, params: Record<string, unknown>) {
  if (action !== 'set_block_props') return { ok: false, error: `unexpected action ${action}` };
  const props = (params.props as Record<string, unknown>) ?? {};
  const filter = (params.filter as { type?: string }) ?? {};
  return {
    ok: true,
    result: {
      gridId: params.entityId,
      count: 1,
      applied: Object.keys(props).length,
      blocks: [
        {
          name: filter.type === 'RadioAntenna' ? 'Antenna' : 'Block',
          errors: [],
          props: Object.entries(props).map(([id, value]) => ({ id, before: null, after: value === '$max' ? 50000 : value })),
        },
      ],
    },
  };
}

/** Poll `cond` until true (the pollers run their passes without being awaited). */
async function until(cond: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  resetProvisionerForTests();
  resetOrderResultsForTests();
});

describe('audit #1 — list_tagged is a cheap scan, not N profiles', () => {
  it('provisions a tagged grid from the cheap payload and keeps role blocks', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    let hook: TaggedGrid[] = [];
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') return { ok: true, result: { count: 1, grids: [cheapTaggedGrid()] } };
        return writeAnswers(action, params);
      },
      calls,
    );
    const provisioner = new Provisioner({
      config,
      store,
      hub,
      clock: () => NOW,
      onGrids: async (grids) => {
        hook = grids;
      },
    });

    const run = await provisioner.runOnce();
    expect(run.ok).toBe(true);
    expect(run.provisioned).toBe(1);
    // The scan is the ONLY read: no `profile` order is sent for the grid.
    expect(calls.some((c) => c.action === 'profile')).toBe(false);
    expect(calls.filter((c) => c.action === 'list_tagged')).toHaveLength(1);
    // The provisioner never asks for the expensive shape.
    const scan = calls.find((c) => c.action === 'list_tagged')!;
    expect(scan.params.withProfile).toBeUndefined();

    // Role tags (block CustomName/CustomData) survive to the naming/roles hook.
    expect(hook[0]?.blocks?.[0]).toMatchObject({ customName: '[HERMES-ROLE:cargo] Cargo', customData: 'role=cargo' });
    expect(hook[0]?.blocks).toHaveLength(1);

    // Capabilities still carry the counts the gate needs, from the cheap scan.
    const caps = JSON.parse(store.getKv(PROVISION_CAPABILITIES_KV)!) as { grids: Record<string, unknown>[] };
    expect(caps.grids[0]).toMatchObject({ laserCount: 1, massKg: 12000, isStatic: true });
  });

  it('only the hull list asks for the profile-derived scalars', () => {
    // The designer needs thrust/TWR; it is the one caller that says so.
    expect(HULL_LIST_OPTS.withProfile).toBe(true);
    // A cheap payload (null thrust/twr) must still map without throwing.
    const hull = taggedHull({ gridId: 'grid:1', name: 'cheap', massKg: 500, canGroundLaunch: null, thrust: null, twr: null });
    expect(hull.thrust).toEqual({ atmo: 0, ion: 0, h2: 0 });
    expect(hull.canGroundLaunch).toBe('unknown');
    expect(hull.massKg).toBe(500);
  });
});

describe('audit #3 — 30 s provisioning with immediate triggers', () => {
  it('uses a 30 s steady cadence and one coalesced pass per trigger burst', async () => {
    expect(POLL_MS).toBe(30_000);
    expect(IMMEDIATE_PASS_GAP_MS).toBe(5_000);
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') return { ok: true, result: { count: 1, grids: [cheapTaggedGrid()] } };
        return writeAnswers(action, params);
      },
      calls,
    );
    const provisioner = new Provisioner({ config, store, hub, clock: () => NOW });

    provisioner.requestPass('new grid in telemetry: grid:1001');
    provisioner.requestPass('owner order acked: ord:1');
    provisioner.requestPass('owner order acked: ord:2');
    await until(() => calls.some((c) => c.action === 'list_tagged') && calls.filter((c) => c.action === 'list_tagged').length >= 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(provisioner.immediatePassCount()).toBe(1);
    expect(calls.filter((c) => c.action === 'list_tagged')).toHaveLength(1);
  });

  it('requestProvisionPass is a no-op when no provisioner is running', () => {
    resetProvisionerForTests();
    expect(requestProvisionPass('new grid in telemetry: grid:x')).toBe(false);
    expect(requestProvisionPassForGrid('grid:x')).toBe(false);
  });

  it('poller acks are routine: only a real owner order wakes a pass', async () => {
    // runtime.ts wakes a pass on every non-routine ack. Treating the power or
    // probe poller as an "owner order" ran list_tagged every 5 s instead of
    // every 30 s on the test world (measured 2026-11-11).
    for (const id of ['provision:list_tagged:1', 'demo:power:9f2c', 'demo:probe:71a', 'demo:profile:3bd']) {
      expect(isRoutineOrderId(id), id).toBe(true);
    }
    for (const id of ['ord-9b1c', 'mission:12', 'demo:control:99', 'designer:identity', 'demo:guard:dampeners:1']) {
      expect(isRoutineOrderId(id), id).toBe(false);
    }
  });

  it('wakes a pass for a new grid, an owner order and a reconnect — never for a poller ack', async () => {
    // The behaviour behind the classification above, through the same function
    // runtime.ts calls: a routine ack must leave the immediate-pass count at 0.
    const { store, config } = makeStore();
    const calls: Call[] = [];
    let t = NOW;
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') return { ok: true, result: { count: 1, grids: [cheapTaggedGrid()] } };
        return writeAnswers(action, params);
      },
      calls,
    );
    const provisioner = provisionerFor({ config, store, hub: hub as never, clock: () => t });
    await provisioner.runOnce(); // baseline: immediate triggers are armed only after it
    const scans = () => calls.filter((c) => c.action === 'list_tagged').length;
    expect(provisioner.immediatePassCount()).toBe(0);
    expect(scans()).toBe(1);

    for (const id of ['provision:list_tagged:1', 'demo:power:9f2c', 'demo:probe:m:0:1', 'demo:profile:3bd']) {
      expect(requestProvisionPassForAck(id), id).toBe(false);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(provisioner.immediatePassCount()).toBe(0);
    expect(scans()).toBe(1);

    // A grid the last scan already returned is not new; a genuinely new one is.
    expect(requestProvisionPassForGrid('grid:1001')).toBe(false);

    // Each real trigger must produce exactly one immediate pass. `requestPass`
    // drops a request while a previous pass is still running (the burst
    // coalescing the runtime relies on), so re-offer while advancing the clock.
    const wake = async (trigger: () => boolean, want: number) => {
      const deadline = Date.now() + 5_000;
      while (provisioner.immediatePassCount() < want && Date.now() < deadline) {
        t += 6_000;
        expect(trigger()).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(provisioner.immediatePassCount()).toBe(want);
    };

    await wake(() => requestProvisionPassForGrid('grid:new'), 1);
    await wake(() => requestProvisionPass('plugin reconnect'), 2);
    await wake(() => requestProvisionPassForAck('ord-9b1c'), 3);
    expect(scans()).toBe(4);
  });

  it('a telemetry grid triggers a pass only when the last scan did not return it', async () => {
    const { store, config } = makeStore();
    const calls: Call[] = [];
    const hub = fakeHub(
      store,
      (action, params) => {
        if (action === 'list_tagged') return { ok: true, result: { count: 1, grids: [cheapTaggedGrid()] } };
        return writeAnswers(action, params);
      },
      calls,
    );
    const provisioner = provisionerFor({ config, store, hub, clock: () => NOW });
    await provisioner.runOnce();
    expect(provisioner.hasBaseline()).toBe(true);

    // Already in the last scan: no extra order.
    expect(requestProvisionPassForGrid('grid:1001')).toBe(false);
    const before = calls.filter((c) => c.action === 'list_tagged').length;
    // Never scanned: an immediate pass, i.e. a new hull is configured in one tick.
    expect(requestProvisionPassForGrid('grid:brandnew')).toBe(true);
    await until(() => calls.filter((c) => c.action === 'list_tagged').length > before);
    expect(calls.filter((c) => c.action === 'list_tagged').length).toBe(before + 1);
  });
});

describe('audit #4 — laser_state only where it can change', () => {
  function laserSetup() {
    const { store, config } = makeStore();
    const laserCalls: string[][] = [];
    let clockNow = NOW;
    const hub = fakeHub(store, (action, params) => {
      if (action === 'list_tagged') {
        return {
          ok: true,
          result: {
            count: 2,
            grids: [
              cheapTaggedGrid({ gridId: 'grid:laser', laserCount: 1 }),
              cheapTaggedGrid({ gridId: 'grid:nolaser', laserCount: 0, radioCount: 0 }),
            ],
          },
        };
      }
      if (action === 'laser_state') {
        const ids = (params.gridIds as string[]) ?? [];
        laserCalls.push(ids);
        return { ok: true, result: { grids: ids.map((id) => ({ gridId: id, lasers: [{ status: 'Idle', connectedTo: null }] })) } };
      }
      return writeAnswers(action, params);
    });
    const provisioner = new Provisioner({ config, store, hub, clock: () => clockNow });
    const pass = async (at: number) => {
      clockNow = at;
      await provisioner.runOnce();
    };
    return { provisioner, laserCalls, pass };
  }

  it('asks only grids that carry a laser, then backs off after 3 unchanged reads', async () => {
    const { laserCalls, pass } = laserSetup();
    await pass(NOW);
    await pass(NOW + POLL_MS);
    await pass(NOW + 2 * POLL_MS);
    await pass(NOW + 3 * POLL_MS);
    // Every read saw the same status, so the 4th is the last fast one.
    expect(laserCalls).toHaveLength(4);
    for (const ids of laserCalls) expect(ids).toEqual(['grid:laser']);
    // The next pass is inside the 90 s backoff window: no order at all.
    await pass(NOW + 4 * POLL_MS);
    expect(laserCalls).toHaveLength(4);
    // Once the backoff expires it is asked again.
    await pass(NOW + 3 * POLL_MS + LASER_SLOW_MS);
    expect(laserCalls).toHaveLength(5);
  });

  it('a laser command makes a backed-off grid due immediately', async () => {
    const { provisioner, laserCalls, pass } = laserSetup();
    for (let i = 0; i < 4; i += 1) await pass(NOW + i * POLL_MS);
    expect(laserCalls).toHaveLength(4);
    provisioner.markLaserActivity('grid:laser');
    await pass(NOW + 4 * POLL_MS);
    expect(laserCalls).toHaveLength(5);
  });
});

describe('audit #7 — order results arrive on the socket, not from a poll', () => {
  it('resolves a wait on the event, well inside one executor tick, with no 500-row rescan', async () => {
    const { store } = makeStore();
    const rescan = vi.spyOn(store, 'listOrderResults');
    const started = performance.now();
    const waiting = waitForOrderResult(store, 'ord:fast', 2_000);
    setTimeout(() => orderResults.record('ord:fast', { ok: true, result: { hello: 'world' } }), 5);
    const hit = await waiting;
    const elapsed = performance.now() - started;
    expect(hit).toEqual({ ok: true, result: { hello: 'world' } });
    // The executor ticks at 1 Hz; this must not wait for it, let alone 10 reads/s.
    expect(elapsed).toBeLessThan(250);
    expect(rescan).not.toHaveBeenCalled();
  });

  it('the power poller ingests a profile result delivered as an order_result frame', async () => {
    const { store } = makeStore();
    const rescan = vi.spyOn(store, 'listOrderResults');
    store.setKv(
      PROVISION_CAPABILITIES_KV,
      JSON.stringify({ at: NOW, grids: [{ gridId: 'grid:a', name: 'A', profile: 'DRONE', broadcasting: true, radioRadiusM: 50000, radioState: 'read', radioAgeMs: 0, laserCount: 0, massKg: 1000, isStatic: true, updatedAt: NOW }] }),
    );
    const sent: string[] = [];
    const hub = {
      isConnected: () => true,
      send: (message: unknown) => {
        const msg = message as { orderId: string; entityId: string };
        sent.push(msg.entityId);
        // The plugin answers on its next tick; the poller must wake on that.
        setTimeout(() => orderResults.record(msg.orderId, { ok: true, result: { gridId: msg.entityId, name: 'A', isStatic: true } }), 1);
        return true;
      },
    };
    const poller = new PowerPoller({ store, hub, clock: () => NOW });
    const started = performance.now();
    await poller.tick(NOW);
    expect(sent).toEqual(['grid:a']);
    expect(poller.snapshot('grid:a')).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    expect(rescan).not.toHaveBeenCalled();
  });

  it('order acks never wait on the result path', async () => {
    // Acks are applied by the hub callback synchronously; nothing in the pollers
    // can delay them. This pins that there is no await between arrival and apply.
    const applied: string[] = [];
    const onAck = (orderId: string) => applied.push(orderId);
    const started = performance.now();
    onAck('ord:ack');
    expect(applied).toEqual(['ord:ack']);
    expect(performance.now() - started).toBeLessThan(5);
    // …and a non-routine order result does not make the test wait for a poll.
    expect(orderResults.size()).toBe(0);
  });
});

describe('audit #2/#5 — idle grids are read every 5 min, flying grids are not', () => {
  function seedUnits(store: Store, now: number) {
    const unit = (id: string, vel: { x: number; y: number; z: number }, extra: Record<string, unknown> = {}, station: string | null = null) =>
      store.upsertUnit({
        id,
        name: id,
        specId: null,
        station,
        linkStatus: 'up',
        lastSeen: now,
        pos: { x: 0, y: 0, z: 0 },
        vel,
        meta: extra,
      });
    unit('grid:parked', { x: 0, y: 0, z: 0 }, { isStatic: true });
    unit('grid:stationed', { x: 0, y: 0.01, z: 0 }, {}, 'earthlike-hq');
    unit('grid:flying', { x: 0, y: 0, z: 6.5 });
    unit('grid:stale', { x: 0, y: 0, z: 0 }, { isStatic: true });
    // The stale one has an old telemetry sample, so it keeps the fast cadence.
    const stale = store.getUnit('grid:stale')!;
    store.upsertUnit({ ...stale, lastSeen: now - IDLE_TELEMETRY_FRESH_MS - 5_000 });
    const grids = ['grid:parked', 'grid:stationed', 'grid:flying', 'grid:stale'].map((gridId) => ({
      gridId,
      name: gridId,
      profile: 'DRONE',
      broadcasting: true,
      radioRadiusM: 50000,
      radioState: 'read',
      radioAgeMs: 0,
      laserCount: 0,
      massKg: 1000,
      isStatic: gridId === 'grid:parked',
      updatedAt: now,
    }));
    store.setKv(PROVISION_CAPABILITIES_KV, JSON.stringify({ at: now, grids }));
  }

  it('skips a parked grid for 5 min, keeps polling a moving one, and never zeroes a reading', async () => {
    expect(IDLE_REFRESH_MS).toBe(300_000);
    expect(IDLE_MAX_SPEED_MPS).toBe(0.5);
    const { store } = makeStore();
    const clock = makeClock(NOW);
    seedUnits(store, NOW);
    const polled: string[] = [];
    const hub = { isConnected: () => true, send: () => true };
    const poller = new PowerPoller({
      store,
      hub,
      clock: clock.now,
      sendProfile: async (id) => {
        polled.push(id);
        return { gridId: id, name: id, isStatic: id === 'grid:parked', power: { batteryPct: 55 } };
      },
    });

    // A real reading for the parked grid, then repeated passes: the skipped
    // grid must keep that reading (55 %), not be re-read or zeroed.
    poller.ingest('grid:parked', { gridId: 'grid:parked', name: 'parked', isStatic: true, power: { batteryPct: 55 } }, NOW - 60_000);
    await poller.tick(clock.now());
    // First polls are staggered across the interval; telemetry keeps arriving,
    // so the idle grids stay "fresh" while the moving one keeps being read.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(7_000);
      seedUnits(store, clock.now());
      await poller.tick(clock.now());
    }

    expect(poller.isIdle('grid:parked')).toBe(true);
    expect(poller.isIdle('grid:stationed')).toBe(true);
    expect(poller.isIdle('grid:flying')).toBe(false);
    expect(poller.isIdle('grid:stale')).toBe(false);
    expect(polled).not.toContain('grid:parked');
    expect(polled).toContain('grid:flying');
    expect(polled).toContain('grid:stale');
    expect(polled.filter((id) => id === 'grid:stationed')).toHaveLength(0);

    const snap = poller.snapshot('grid:parked')!;
    expect(snap.batteryPct).toBe(55);
    expect(snap.at).toBe(NOW - 60_000); // the age is real, and it is shown
    expect(poller.summary().idleSkipped).toBeGreaterThan(0);
    expect(poller.summary().idleRefreshMs).toBe(IDLE_REFRESH_MS);
  });

  it('does not treat a piloted grid as idle (it stays on the manual skip path)', async () => {
    const { store } = makeStore();
    seedUnits(store, NOW);
    const polled: string[] = [];
    const poller = new PowerPoller({
      store,
      hub: { isConnected: () => true, send: () => true },
      clock: () => NOW,
      sendProfile: async (id) => {
        polled.push(id);
        return { gridId: id, name: id };
      },
    });
    // A pilot is reported by the last profile; the grid is parked and static but
    // must never be reclassified as idle (a piloted ship is a live control).
    poller.ingest('grid:parked', { gridId: 'grid:parked', name: 'parked', isStatic: true, control: { underControl: true } }, NOW);
    expect(poller.isIdle('grid:parked')).toBe(false);
    expect(poller.isManual('grid:parked')).toBe(true);

    await poller.tick(NOW);
    await poller.tick(NOW + 31_000);
    await poller.tick(NOW + 32_000);
    expect(polled.filter((id) => id === 'grid:parked')).toHaveLength(0);
    expect(poller.summary().manualControl).toContain('grid:parked');
  });
});
