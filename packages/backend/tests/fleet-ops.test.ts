import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest, sleep, waitFor } from './helpers.js';
import { FakePlugin } from './fakePlugin.js';
import { PROVISION_CAPABILITIES_KV } from '../src/demo/network.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';

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
    else process.env[key] = saved[key];
  }
}

const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const R = EARTH.surfaceRadiusM;
/** SE grid ids exceed 2^53: these exact strings must survive every round trip. */
const BASE = 'grid:76941937918779763';
const A = 'grid:9007199254740993';
const B = 'grid:9007199254740995';

/**
 * Slot height above the catalogue mean: 300 m was underground once the
 * executor started measuring AGL from the terrain height field (the real
 * ground at these columns is ~660 m above the mean), so a refusal would be
 * correct and this fixture would never fly. 2 500 m clears the terrain.
 */
const pos = (x: number, y = 0, z = R + 2_500) => ({ x, y, z });

interface OpStep {
  id: string;
  wave: number;
  memberId: string;
  action: string;
  target: { x: number; y: number; z: number } | null;
  status: string;
  reason?: string;
  flags?: string[];
  orderId?: string;
  execution?: {
    missionId: string | null;
    baselineOrders?: number;
    dispatchedAt?: number | null;
    aborting?: string;
    verified?: { state: string; reason: string | null; at: number };
  };
}

interface OpWire {
  id: string;
  kind: string;
  planetId: string | null;
  members: string[];
  steps: OpStep[];
  status: string;
  dryRun: boolean;
  coverageBefore: { coveragePct: number; terrain: string } | null;
  coverageAfter: { coveragePct: number; terrain: string } | null;
  invariants: {
    ok: boolean;
    members: { gridId: string; verdict: string; reason?: string; home: { x: number; y: number; z: number } | null }[];
    failures: { invariant: string; memberId?: string; reason: string; severity?: string }[];
    notes: string[];
    abort?: { gridId: string; policy: string; action: string; orderId?: string; reason: string }[];
    coverageLoss?: { count: number; accepted: boolean; cells: { latDeg: number; lonDeg: number }[] };
  };
  abortPolicy: string;
  lastError: string | null;
}

interface GridSeed {
  id: string;
  name: string;
  profile: 'BASE' | 'DRONE';
  position: { x: number; y: number; z: number };
  radio?: number;
  isStatic?: boolean;
  fuel?: number;
  power?: number;
  health?: number;
  link?: 'up' | 'down' | 'unknown';
}

const clock = makeClock();

/** Every switch on: needed only for tests that execute fleet steps. */
const ALL_FLAGS = {
  demo_execute: true,
  fleet_ops_execute: true,
  station: true,
  test_api: true,
};

async function withRuntime<T>(
  opts: { memory?: boolean; flags?: Record<string, boolean> },
  fn: (ctx: { runtime: Runtime; port: number }) => Promise<T>,
): Promise<T> {
  const runtime = createRuntime({
    config: makeConfig({ port: 0, flags: opts.flags ?? {} }),
    memory: opts.memory !== false,
    clock: clock.now,
  });
  const port = await runtime.listen(0);
  if (opts.flags) {
    for (const [name, on] of Object.entries(opts.flags)) runtime.store.setFlag(name, on);
    // The executor's ownership handshake needs the plugin identity; the fake
    // plugin is not a real client, so seed the value it would have reported.
    runtime.store.setKv('demo:identityId', '10000000000000001');
    // Flags gate what the executor dispatches: run one tick with them on.
    runtime.executor?.tick();
  }
  try {
    return await fn({ runtime, port });
  } finally {
    await runtime.close();
  }
}

/**
 * Seeds the provisioned capability snapshot the gate reads, plus live
 * telemetry for every grid. No order is sent by seeding.
 */
function seedGrids(runtime: Runtime, grids: GridSeed[], now = clock.now()): void {
  runtime.store.setKv(
    PROVISION_CAPABILITIES_KV,
    JSON.stringify({
      at: now,
      grids: grids.map((g) => ({
        gridId: g.id,
        name: g.name,
        profile: g.profile,
        broadcasting: true,
        radioRadiusM: g.radio ?? 50_000,
        laserCount: 0,
        massKg: 1_000,
        isStatic: g.isStatic ?? false,
        updatedAt: now,
      })),
    }),
  );
  for (const g of grids) {
    runtime.store.upsertUnit({
      id: g.id,
      name: g.name,
      specId: null,
      station: null,
      linkStatus: g.link ?? 'up',
      lastSeen: now,
      pos: g.position,
      vel: null,
      meta: {
        fuelFraction: g.fuel ?? 1,
        powerFraction: g.power ?? 1,
        health: g.health ?? 1,
        massKg: 1_000,
      },
    });
  }
}

function ship(id: string, name: string, position: { x: number; y: number; z: number }, extra: Partial<GridSeed> = {}): GridSeed {
  return { id, name, profile: 'DRONE', position, ...extra };
}

const BASE_GRID: GridSeed = {
  id: BASE,
  name: 'BASE-01',
  profile: 'BASE',
  position: pos(0),
};

async function connect(port: number, runtime: Runtime): Promise<FakePlugin> {
  const plugin = await FakePlugin.connect(port);
  plugin.hello();
  await waitFor(() => runtime.hub.isConnected(), (connected) => connected === true);
  return plugin;
}

/**
 * Plays the plugin's half of an executor flight: answers every order the
 * executor sends (release preflight, diag, ownership read-back, move, hold,
 * station conversions) with the contract shape that action requires. The fake
 * in `fakePlugin.ts` owns those answers, so every executor test shares them;
 * this wrapper only pins the clock and the identity the read-back must match.
 * It never originates an order.
 */
function runExecutor(plugin: FakePlugin, opts: { now: number; identityId?: string | null; staticAfterConvert?: boolean }): void {
  plugin.answerExecutorOrders({
    now: opts.now,
    staticAfterConvert: opts.staticAfterConvert,
    identityId: opts.identityId ?? undefined,
  });
}

/** Executor move orders (the guarded leg), in the order they were sent. */
function executorMoves(plugin: FakePlugin): { x: number; y: number; z: number; speed: number; collisionAvoidance: boolean; gridId: string; orderId: string }[] {
  return plugin.received
    .filter((m) => m.type === 'order' && m.orderType === 'move')
    .map((m) => {
      const params = m.params as { x: number; y: number; z: number; speed: number; collisionAvoidance?: boolean };
      return {
        x: params.x,
        y: params.y,
        z: params.z,
        speed: params.speed,
        collisionAvoidance: params.collisionAvoidance === true,
        gridId: String((m.params as { gridId?: string }).gridId ?? m.entityId),
        orderId: String(m.orderId),
      };
    });
}

/** Raw orders the old fleet path sent: `fleet:<op>:...` ids and bare stops. */
function rawFleetOrders(plugin: FakePlugin): Record<string, unknown>[] {
  return plugin.received.filter((m) => m.type === 'order' && String(m.orderId ?? '').startsWith('fleet:'));
}

/**
 * Drives a running operation to a terminal state the way the game would:
 * answers the executor's orders (runExecutor), places each member at the
 * executor's own slot (so its arrival guard sees it is there), runs the
 * executor tick, then polls. Never advances the clock, so gate freshness stays.
 */
async function drive(
  port: number,
  plugin: FakePlugin,
  id: string,
  ctx?: { runtime: Runtime; staticAfterConvert?: boolean },
  opts: { brakeDistance?: number } = {},
): Promise<OpWire> {
  let last: OpWire | null = null;
  for (let i = 0; i < 80; i += 1) {
    const res = await httpRequest<{ operation: OpWire }>(port, 'GET', `/api/demo/fleet-ops/${id}`);
    expect(res.status).toBe(200);
    last = res.body.operation;
    if (['done', 'paused', 'cancelled', 'failed'].includes(last.status)) return last;
    const flying = last.steps.filter((s) => s.status === 'dispatched');
    if (!flying.length) return last;
    runExecutor(plugin, {
      now: clock.now(),
      staticAfterConvert: ctx?.staticAfterConvert,
      identityId: ctx?.runtime.store.getKv('demo:identityId'),
    });
    const placements = new Map<string, { x: number; y: number; z: number }>();
    const summary = ctx?.runtime.executor?.summary() as
      | { executions?: { drones: { gridId: string | null; execSlot: { x: number; y: number; z: number } }[] }[] }
      | undefined;
    for (const joint of summary?.executions ?? []) {
      for (const drone of joint.drones as { gridId: string | null; execSlot: { x: number; y: number; z: number } }[]) {
        if (!drone.gridId) continue;
        // The guard needs distance > 0; a metre short of the slot is "arrived".
        const r = Math.hypot(drone.execSlot.x, drone.execSlot.y, drone.execSlot.z) || 1;
        const back = 1 / r;
        placements.set(drone.gridId, {
          x: drone.execSlot.x - drone.execSlot.x * back,
          y: drone.execSlot.y - drone.execSlot.y * back,
          z: drone.execSlot.z - drone.execSlot.z * back,
        });
      }
    }
    // Brake runs start far out so the guard enforces a braking-distance speed.
    const brakeAt = opts.brakeDistance ? flying.find((s) => !placements.has(s.memberId)) : undefined;
    if (brakeAt && opts.brakeDistance) {
      const home = brakeAt.target!;
      const r = Math.hypot(home.x, home.y, home.z) || 1;
      placements.set(brakeAt.memberId, { x: home.x, y: home.y, z: home.z + (opts.brakeDistance * home.z) / r });
    }
    plugin.telemetry({
      tick: i + 1,
      at: clock.now(),
      grids: last.members.map((gridId) => ({
        gridId,
        name: gridId,
        pos: placements.get(gridId) ?? pos(0),
        vel: { x: 0, y: 0, z: 0 },
        link: 'up' as const,
        fuelFraction: 1,
        powerFraction: 1,
        health: 1,
      })),
    });
    await sleep(5);
    if (ctx) {
      ctx.runtime.executor?.tick();
      await sleep(5);
    }
  }
  throw new Error(`operation did not reach a terminal state: ${JSON.stringify(last?.steps)} received=${JSON.stringify(plugin.received.map((m) => [m.orderId, (m.params as { action?: string } | undefined)?.action])).slice(-700)}`);
}

function moveOrders(plugin: FakePlugin): { x: number; y: number; z: number; orderId: string }[] {
  return plugin.received
    .filter((m) => m.type === 'order' && m.orderType === 'move')
    .map((m) => {
      const params = m.params as { x: number; y: number; z: number };
      return { x: params.x, y: params.y, z: params.z, orderId: String(m.orderId) };
    });
}

describe('T50 fleet operations', () => {
  beforeAll(() => setDemoEnv());
  afterAll(() => restoreEnv());
  afterEach(() => clock.advance(1_000));

  it('(a) a 2-ship swap stages through a temp point: A->temp, B->A, temp->B', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = pos(1_000);
      const bHome = pos(1_700);
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', aHome, { fuel: 1 }), ship(B, 'beta', bHome, { fuel: 1 })]);
      const plugin = await connect(port, runtime);

      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: true,
        includeTerrain: false,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      expect(op.invariants.ok).toBe(true);
      expect(op.steps.map((s) => s.memberId)).toEqual([A, B, A]);
      expect(op.steps.map((s) => s.wave)).toEqual([0, 1, 2]);
      const temp = op.steps[0]!.target!;
      expect(temp).not.toEqual(aHome);
      expect(temp).not.toEqual(bHome);
      // The last leg ends at B's slot, the middle leg at A's slot: the naive
      // A->B, B->A order (both flying at each other first) never appears.
      expect(op.steps[1]!.target).toEqual(aHome);
      expect(op.steps[2]!.target).toEqual(bHome);

      const listed = await httpRequest<{ operations: OpWire[] }>(port, 'GET', '/api/demo/fleet-ops');
      expect(listed.status).toBe(200);
      expect(listed.body.operations.map((o) => o.id)).toContain(op.id);
      expect((await httpRequest(port, 'GET', '/api/demo/fleet-ops/fleet-missing')).status).toBe(404);

      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      // Dry run: approval re-checked but dispatched nothing.
      expect(approved.body.operation.status).toBe('approved');
      expect(moveOrders(plugin)).toHaveLength(0);
      expect(runtime.store.listMissions().filter((m) => (m.assignedUnits ?? []).includes(A))).toHaveLength(0);

      // Run the same plan for real from a second operation.
      const live = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
      });
      expect(live.status).toBe(201);
      const approvedLive = await httpRequest<{ operation: OpWire }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${live.body.operation.id}/approve`,
        {},
      );
      expect(approvedLive.status).toBe(200);
      // With the flag ON, wave 0 is one executor mission - never a raw order.
      const started = approvedLive.body.operation;
      expect(started.status).toBe('running');
      expect(rawFleetOrders(plugin)).toHaveLength(0);
      const first = started.steps.find((s) => s.status === 'dispatched')!;
      expect(first.memberId).toBe(A);
      // The step's order id IS the executor mission that flies it.
      expect(first.orderId).toBeTruthy();
      expect(first.orderId).toBe(first.execution!.missionId);
      const mission = runtime.store.getMission(first.orderId!)!;
      expect(mission.type).toBe('move');
      expect(mission.assignedUnits).toEqual([first.memberId]);
      expect(['approved', 'executing']).toContain(mission.status);

      const done = await drive(port, plugin, live.body.operation.id, { runtime });
      expect(done.status).toBe('done');
      const flown = executorMoves(plugin);
      // Every move is the executor's: `demo:<mission>:<idx>:move:a<n>` ids.
      expect(flown.length).toBeGreaterThanOrEqual(3);
      expect(flown.every((m) => m.orderId.startsWith('demo:'))).toBe(true);
      // Plan order by first arrival at each waypoint, and the first waypoint is
      // neither ship's slot: never fly A through B.
      const firstAt = (waypoint: { x: number; y: number; z: number }) =>
        flown.findIndex((m) => m.x === waypoint.x && m.y === waypoint.y && m.z === waypoint.z);
      expect(firstAt(temp)).toBe(0);
      expect(firstAt(aHome)).toBeGreaterThan(firstAt(temp));
      expect(firstAt(bHome)).toBeGreaterThan(firstAt(aHome));
      await plugin.close();
    });
  });

  it('(b) refuses a swap whose step boundary puts two members within 100 m', async () => {
    await withRuntime({}, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', pos(0)), ship(B, 'beta', pos(90))]);
      const created = await httpRequest<{
        error: { code: string };
        invariant: { invariant: string; reason: string };
        operation: OpWire;
      }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: true,
        minSeparationM: 100,
        includeTerrain: false,
      });
      expect(created.status).toBe(409);
      expect(created.body.error.code).toBe('invariant_failed');
      expect(created.body.invariant.invariant).toBe('separation');
      expect(created.body.invariant.reason).toContain('100 m');
      expect(created.body.operation.invariants.ok).toBe(false);
    });
  });

  it('(c) refuses a reshape that would leave a node with no path to a base', async () => {
    await withRuntime({}, async ({ port }) => {
      // Fixture world only: relay-2 is 90 km from HQ and reaches it solely
      // through relay-1.
      const created = await httpRequest<{
        error: { code: string };
        invariant: { invariant: string; reason: string };
      }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'reshape',
        members: ['relay-1'],
        planet: 'EarthLike',
        dryRun: true,
        includeTerrain: false,
        slots: [{ gridId: 'relay-1', target: pos(5_000_000) }],
      });
      expect(created.status).toBe(409);
      expect(created.body.error.code).toBe('invariant_failed');
      expect(created.body.invariant.invariant).toBe('last_path');
      expect(created.body.invariant.reason).toContain('relay-2');
    });
  });

  it('(d) skips a member without fuel for its step, with the shortfall, and the rest proceed', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = pos(1_000);
      const bHome = pos(1_700);
      seedGrids(runtime, [
        BASE_GRID,
        ship(A, 'dry-tank', aHome, { fuel: 0.001, power: 0 }),
        ship(B, 'full-tank', bHome, { fuel: 1 }),
      ]);
      const plugin = await connect(port, runtime);
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'reshape',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
        slots: [
          { gridId: A, target: pos(1_200) },
          { gridId: B, target: pos(2_000) },
        ],
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      const skipped = op.invariants.members.find((m) => m.gridId === A)!;
      expect(skipped.verdict).toBe('skipped');
      expect(skipped.reason).toContain('insufficient fuel/charge');
      const fuelFailure = op.invariants.failures.find((f) => f.invariant === 'fuel')!;
      expect(fuelFailure.memberId).toBe(A);
      expect(fuelFailure.reason).toMatch(/%/);

      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      const done = await drive(port, plugin, op.id, { runtime });
      expect(done.status).toBe('done');
      const bStep = done.steps.find((s) => s.memberId === B)!;
      if (bStep.status !== 'done') throw new Error(`DEBUG B: ${bStep.reason} | ${JSON.stringify(done.steps)}`);
      expect(bStep.status).toBe('done');
      expect(moveOrders(plugin).some((o) => o.x === 2_000)).toBe(true);
      await plugin.close();
    });
  });

  it('(e) excludes a hand-piloted member and reports it', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = pos(1_000);
      const bHome = pos(1_700);
      seedGrids(runtime, [BASE_GRID, ship(A, 'piloted', aHome), ship(B, 'automatic', bHome)]);
      runtime.store.setKv(`demo:control:${A}`, JSON.stringify({ underControl: true, by: 'the owner', at: clock.now() }));
      const plugin = await connect(port, runtime);
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'reshape',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
        slots: [
          { gridId: A, target: pos(1_200) },
          { gridId: B, target: pos(2_000) },
        ],
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      expect(op.invariants.members.find((m) => m.gridId === A)!.verdict).toBe('skipped');
      expect(op.invariants.failures.find((f) => f.invariant === 'manual')!.memberId).toBe(A);
      await httpRequest(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      const done = await drive(port, plugin, op.id, { runtime });
      expect(done.steps.find((s) => s.memberId === A)!.status).toBe('skipped');
      expect(done.steps.find((s) => s.memberId === B)!.status).toBe('done');
      // No order ever targets the piloted grid.
      expect(moveOrders(plugin).some((o) => o.x === 1_200)).toBe(false);
      expect(runtime.store.listOrders(`fleet-op:${op.id}`).some((o) => o.unitId === A)).toBe(false);
      await plugin.close();
    });
  });

  it('(f) approve re-checks and refuses a plan whose telemetry went stale', async () => {
    await withRuntime({}, async ({ runtime, port }) => {
      const aHome = pos(1_000);
      const bHome = pos(1_700);
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', aHome), ship(B, 'beta', bHome)]);
      const plugin = await connect(port, runtime);
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      expect(op.invariants.members.every((m) => m.verdict === 'ok')).toBe(true);

      // The pilot loses the grid's antenna between plan and approve.
      plugin.telemetry({
        tick: 99,
        at: clock.now(),
        grids: [
          { gridId: A, name: 'alpha', pos: aHome, link: 'down' as const, fuelFraction: 1, powerFraction: 1 },
          { gridId: B, name: 'beta', pos: bHome, link: 'up' as const, fuelFraction: 1, powerFraction: 1 },
        ],
      });
      await waitFor(() => runtime.store.getUnit(A)?.linkStatus, (s) => s === 'down');
      const approved = await httpRequest<{
        error: { code: string };
        invariant: { invariant: string; memberId?: string };
        operation: OpWire;
      }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(409);
      expect(approved.body.error.code).toBe('invariant_failed');
      expect(approved.body.invariant.invariant).toBe('commandable');
      expect(approved.body.invariant.memberId).toBe(A);
      // The record is untouched: still planned, nothing dispatched.
      expect(approved.body.operation.status).toBe('planned');
      expect(moveOrders(plugin)).toHaveLength(0);
      await plugin.close();
    });
  });

  it('(g) cancel mid-run resolves every member through the abort policy', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = pos(1_000);
      const bHome = pos(1_700);
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', aHome), ship(B, 'beta', bHome)]);
      const plugin = await connect(port, runtime);
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        abortPolicy: 'hold',
        includeTerrain: false,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      expect(approved.body.operation.status).toBe('running');
      // Wave 0 is in flight: one member has a dispatched move.
      expect(approved.body.operation.steps.filter((s) => s.status === 'dispatched')).toHaveLength(1);

      const cancelled = await httpRequest<{
        operation: OpWire;
        abort: { gridId: string; policy: string; action: string; orderId?: string; reason: string }[];
      }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/cancel`, {
        policy: 'hold',
        policies: { [A]: 'continue', [B]: 'return' },
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.operation.status).toBe('cancelled');
      const byGrid = new Map(cancelled.body.abort.map((a) => [a.gridId, a]));
      expect(byGrid.get(A)).toMatchObject({ policy: 'continue', action: 'continue' });
      expect(byGrid.get(A)!.orderId).toBeUndefined();
      expect(byGrid.get(B)).toMatchObject({ policy: 'return', action: 'return' });
      expect(byGrid.get(B)!.orderId).toBeTruthy();
      // Per-member abort steps are addressable in the record itself.
      const abortSteps = cancelled.body.operation.steps.filter((s) => s.action === 'abort');
      expect(abortSteps.map((s) => s.memberId).sort()).toEqual([A, B].sort());
      // Pending steps were skipped so a later tick cannot dispatch them.
      expect(cancelled.body.operation.steps.filter((s) => s.status === 'pending')).toHaveLength(0);
      // Return is an executor mission to the member's home slot: fleet code
      // never writes a raw `:abort:return:` order of its own.
      expect(
        plugin.received.some((m) => m.type === 'order' && String(m.orderId).includes(':abort:')),
      ).toBe(false);
      const returnMissionId = byGrid.get(B)!.orderId!;
      const returnMission = runtime.store.getMission(returnMissionId)!;
      expect(returnMission.type).toBe('move');
      expect(returnMission.assignedUnits).toEqual([B]);
      expect((returnMission.desiredState as { position?: { x: number } }).position?.x).toBe(bHome.x);
      expect(runtime.store.countAudit('fleet_op_abort_mission', returnMissionId)).toBe(1);

      // The abort route shares the policy engine; a terminal op is refused.
      const lateAbort = await httpRequest<{ error: { code: string } }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${op.id}/abort`,
        { policy: 'hold' },
      );
      expect(lateAbort.status).toBe(409);
      expect(lateAbort.body.error.code).toBe('illegal_status');

      const third = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
      });
      expect(third.status).toBe(201);
      await httpRequest(port, 'POST', `/api/demo/fleet-ops/${third.body.operation.id}/approve`, {});
      const aborted = await httpRequest<{
        operation: OpWire;
        abort: { gridId: string; action: string; orderId?: string }[];
      }>(port, 'POST', `/api/demo/fleet-ops/${third.body.operation.id}/abort`, { policy: 'hold' });
      expect(aborted.status).toBe(200);
      expect(aborted.body.operation.status).toBe('cancelled');
      expect(aborted.body.abort.every((a) => a.action === 'hold' && a.orderId)).toBe(true);
      const stopOrders = plugin.received.filter((m) => m.type === 'order' && m.orderType === 'stop');
      expect(stopOrders.length).toBeGreaterThanOrEqual(2);
      await plugin.close();
    });
  });

  it('(h) scuttle cannot execute without confirm + flag, and refuses when nested', async () => {
    await withRuntime({}, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', pos(1_000), { fuel: 0.2, health: 0.5 })]);
      const plugin = await connect(port, runtime);

      // Coverage loss is the scuttle invariant: without acceptance it refuses.
      const unaccepted = await httpRequest<{ invariant: { invariant: string; reason: string } }>(
        port,
        'POST',
        '/api/demo/fleet-ops',
        { kind: 'scuttle', members: [A], planet: 'EarthLike', includeTerrain: false },
      );
      expect(unaccepted.status).toBe(409);
      expect(unaccepted.body.invariant.invariant).toBe('coverage_loss');
      // The refusal is audited, not a silent 409.
      expect(runtime.store.countAudit('fleet_op_create_refused')).toBeGreaterThan(0);

      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'scuttle',
        members: [A],
        planet: 'EarthLike',
        includeTerrain: false,
        acceptedCoverageLoss: true,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      expect(op.invariants.coverageLoss!.count).toBeGreaterThan(0);
      expect(op.invariants.coverageLoss!.accepted).toBe(true);
      expect(op.coverageBefore!.coveragePct).toBeGreaterThan(0);
      expect(op.coverageAfter).toBeNull();

      const noConfirm = await httpRequest<{ error: { code: string }; invariant: { invariant: string } }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${op.id}/approve`,
        {},
      );
      expect(noConfirm.status).toBe(409);
      expect(noConfirm.body.error.code).toBe('confirm_required');
      expect(noConfirm.body.invariant.invariant).toBe('confirm_required');

      // Flag defaults off: confirm alone still cannot approve.
      const flagOff = await httpRequest<{ error: { code: string }; invariant: { invariant: string } }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${op.id}/approve`,
        { confirm: true },
      );
      expect(flagOff.status).toBe(409);
      expect(flagOff.body.error.code).toBe('scuttle_flag_off');
      expect(flagOff.body.invariant.invariant).toBe('scuttle_execution');

      // Even with the flag ON this build must not execute a scuttle.
      runtime.store.setFlag('fleet_scuttle_execute', true);
      const approved = await httpRequest<{ operation: OpWire; execution: { executed: boolean; mode: string } }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${op.id}/approve`,
        { confirm: true },
      );
      expect(approved.status).toBe(200);
      expect(approved.body.execution).toMatchObject({ executed: false, mode: 'plan-only' });
      expect(approved.body.operation.status).toBe('approved');
      expect(runtime.store.countAudit('fleet_op_approve', op.id)).toBeGreaterThan(0);
      const ticked = await httpRequest<{ operation: OpWire }>(port, 'GET', `/api/demo/fleet-ops/${op.id}`);
      expect(ticked.body.operation.status).toBe('approved');
      expect(plugin.received.filter((m) => m.type === 'order')).toHaveLength(0);
      expect(runtime.store.listOrders(`fleet-op:${op.id}`)).toHaveLength(0);

      // Nested: refused when it names a parent or overlaps an active operation.
      const nestedParent = await httpRequest<{ invariant: { invariant: string; reason: string } }>(
        port,
        'POST',
        '/api/demo/fleet-ops',
        {
          kind: 'scuttle',
          members: [A],
          planet: 'EarthLike',
          includeTerrain: false,
          acceptedCoverageLoss: true,
          parentOperationId: op.id,
        },
      );
      expect(nestedParent.status).toBe(409);
      expect(nestedParent.body.invariant.invariant).toBe('nested_operation');

      const nestedOverlap = await httpRequest<{ invariant: { invariant: string; reason: string } }>(
        port,
        'POST',
        '/api/demo/fleet-ops',
        { kind: 'scuttle', members: [A], planet: 'EarthLike', includeTerrain: false, acceptedCoverageLoss: true },
      );
      expect(nestedOverlap.status).toBe(409);
      expect(nestedOverlap.body.invariant.invariant).toBe('nested_operation');
      expect(nestedOverlap.body.invariant.reason).toContain(op.id);
      await plugin.close();
    });
  });

  it('(i) recall parks, flags NEEDS_REFUEL/NEEDS_REPAIR and never auto-relaunches', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = pos(600);
      const bHome = pos(-600);
      seedGrids(runtime, [
        BASE_GRID,
        ship(A, 'damaged-static', aHome, { fuel: 0.1, health: 0.5, isStatic: true }),
        ship(B, 'healthy', bHome, { fuel: 1, health: 1 }),
      ]);
      const plugin = await connect(port, runtime);
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'recall',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        base: { position: pos(0) },
        includeTerrain: false,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      // Static member is unstationed before its transit.
      expect(op.steps.filter((s) => s.memberId === A).map((s) => s.action)).toEqual([
        'unstation',
        'move',
        'dock',
        'flag',
      ]);
      expect(op.steps.filter((s) => s.memberId === B).map((s) => s.action)).toEqual(['move', 'land', 'flag']);

      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      const done = await drive(port, plugin, op.id, { runtime });
      expect(done.status).toBe('done');

      const aSteps = done.steps.filter((s) => s.memberId === A);
      const aFlag = aSteps.find((s) => s.action === 'flag')!;
      expect(aFlag.flags).toEqual(expect.arrayContaining(['NEEDS_REFUEL', 'NEEDS_REPAIR']));
      // The flag is the last thing that happens to each member: no relaunch.
      expect(aSteps[aSteps.length - 1]!.action).toBe('flag');
      const bSteps = done.steps.filter((s) => s.memberId === B);
      expect(bSteps[bSteps.length - 1]!.action).toBe('flag');
      expect(bSteps.find((s) => s.action === 'flag')!.flags).toEqual([]);
      expect(done.steps.filter((s) => s.action === 'flag').every((s) => s.status === 'done')).toBe(true);
      // Nothing was dispatched after a flag step.
      const flagWaves = done.steps.filter((s) => s.action === 'flag').map((s) => s.wave);
      expect(done.steps.some((s) => flagWaves.some((w) => w < s.wave))).toBe(false);
      await plugin.close();
    });
  });

  it('(j) relocate sequences spine-first and pauses a wave that would strand a node', async () => {
    // The wave guard runs inside the tick, which is flag-gated: with
    // `fleet_ops_execute` OFF approve would stop at `approved` and prove
    // nothing about stranding. The flag-OFF contract has its own test.
    await withRuntime({ flags: ALL_FLAGS }, async ({ port }) => {
      const hq = seedWorld().nodes.find((n) => n.id === 'earthlike-hq')!.position;
      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'relocate',
        members: ['relay-2', 'relay-1'],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
        region: { center: hq },
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      // Spine first: relay-1 is the only path to relay-2, so it leads wave 0
      // even though it was listed second.
      expect(op.steps.map((s) => s.memberId)).toEqual(['relay-1', 'relay-2']);
      expect(op.steps.map((s) => s.wave)).toEqual([0, 1]);
      expect(op.invariants.notes.some((n) => n.includes('will pause'))).toBe(true);

      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      // The wave check refuses to strand relay-2: paused, nothing dispatched.
      expect(approved.body.operation.status).toBe('paused');
      expect(approved.body.operation.lastError).toContain('relay-2');
      expect(approved.body.operation.steps.every((s) => s.status === 'pending')).toBe(true);
    });
  });
});

/**
 * T50: fleet steps are executor missions. Every ship-touching step is one
 * `move:` mission (never a raw hub order), its completion is read from the
 * executor's verified per-drone state, and a grid the owner is flying or has
 * excluded is never commanded.
 */
describe('T50 fleet steps run through the executor', () => {
  beforeAll(() => setDemoEnv());
  afterAll(() => restoreEnv());
  afterEach(() => clock.advance(1_000));

  const home = () => pos(1_000);

  /** Create one live reshape operation for one member and approve it. */
  async function reshapeAndApprove(
    port: number,
    gridId: string,
    target: { x: number; y: number; z: number },
  ): Promise<{ operation: OpWire; execution: Record<string, unknown> }> {
    const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
      kind: 'reshape',
      members: [gridId],
      planet: 'EarthLike',
      dryRun: false,
      includeTerrain: false,
      slots: [{ gridId, target }],
    });
    expect(created.status).toBe(201);
    const approved = await httpRequest<{ operation: OpWire; execution: Record<string, unknown> }>(
      port,
      'POST',
      `/api/demo/fleet-ops/${created.body.operation.id}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    return approved.body;
  }

  it('(a) dispatches one executor mission per step; the move carries the executor speed limit', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', home(), { fuel: 1 })]);
      const plugin = await connect(port, runtime);
      const target = pos(1_300);

      const approved = await reshapeAndApprove(port, A, target);
      expect(approved.execution).toMatchObject({ mode: 'executor', executed: true });
      // Nothing but executor orders ever reaches the wire.
      expect(rawFleetOrders(plugin)).toHaveLength(0);
      expect(plugin.received.filter((m) => m.type === 'order')).toHaveLength(0);

      const step = approved.operation.steps[0]!;
      expect(step.status).toBe('dispatched');
      // The step's order id is the mission id, recorded before any flight order.
      expect(step.orderId).toBe(step.execution!.missionId);
      expect(step.execution!.baselineOrders).toBe(0);
      const mission = runtime.store.getMission(step.orderId!)!;
      expect(mission.type).toBe('move');
      expect(mission.assignedUnits).toEqual([A]);
      expect(runtime.store.countAudit('fleet_op_step_dispatched', step.orderId!)).toBe(1);

      const done = await drive(port, plugin, approved.operation.id, { runtime });
      expect(done.status).toBe('done');
      expect(done.steps[0]!.status).toBe('done');
      // Completion is the executor's verified state, not telemetry.
      expect(done.steps[0]!.execution!.verified!.state).toBe('holding');

      const moves = executorMoves(plugin);
      expect(moves.length).toBeGreaterThan(0);
      const cap = runtime.config.demo.speedLimitMps;
      for (const move of moves) {
        expect(move.gridId).toBe(A);
        expect(move.orderId.startsWith('demo:')).toBe(true);
        expect(move.speed).toBeGreaterThan(0);
        expect(move.speed).toBeLessThanOrEqual(cap);
        // Every executor move forces collision avoidance on.
        expect(move.collisionAvoidance).toBe(true);
      }
      const arrival = moves.find((m) => m.x === target.x && m.y === target.y && m.z === target.z);
      expect(arrival).toBeDefined();
      // The approach is brake-limited by the leg profile, not a flat cruise.
      expect(arrival!.speed).toBeLessThan(cap);
      const profiles = runtime.store
        .listAudit(400)
        .filter((e) => e.action === 'demo_leg_profile')
        .map((e) => e.detail as { gridId?: string; vCruiseMps?: number });
      expect(
        profiles.some((p) => p.gridId === A && Math.abs((p.vCruiseMps ?? -1) - arrival!.speed) < 0.051),
      ).toBe(true);
      await plugin.close();
    });
  });

  it('(b) a member under player control receives zero orders', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      const aHome = home();
      const bHome = pos(1_700);
      seedGrids(runtime, [BASE_GRID, ship(A, 'piloted', aHome), ship(B, 'automatic', bHome)]);
      runtime.store.setKv(`demo:control:${A}`, JSON.stringify({ underControl: true, by: 'the owner', at: clock.now() }));
      const plugin = await connect(port, runtime);

      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'reshape',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
        slots: [
          { gridId: A, target: pos(1_200) },
          { gridId: B, target: pos(2_000) },
        ],
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      expect(op.invariants.members.find((m) => m.gridId === A)!.verdict).toBe('skipped');
      await httpRequest(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});

      const done = await drive(port, plugin, op.id, { runtime });
      expect(done.status).toBe('done');
      expect(done.steps.find((s) => s.memberId === A)!.status).toBe('skipped');
      expect(done.steps.find((s) => s.memberId === B)!.status).toBe('done');
      // The piloted grid is not commanded at all - not even a probe.
      expect(plugin.ordersForGrid(A)).toHaveLength(0);
      expect(plugin.ordersForGrid(B).length).toBeGreaterThan(0);
      expect(runtime.store.listMissions().filter((m) => (m.assignedUnits ?? []).includes(A))).toHaveLength(0);
      await plugin.close();
    });
  });

  it('(c) a travel step does not complete from telemetry distance alone', async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', home(), { fuel: 1 })]);
      const plugin = await connect(port, runtime);
      const target = pos(1_400);
      const approved = await reshapeAndApprove(port, A, target);
      const opId = approved.operation.id;
      expect(approved.operation.steps[0]!.status).toBe('dispatched');

      // Telemetry claims the grid is parked exactly on its slot, stationary.
      // It is inside the arrival tolerance, but the executor holds no verified
      // state for the mission, so the step must stay dispatched.
      plugin.telemetry({
        tick: 5_000,
        at: clock.now(),
        grids: [
          {
            gridId: A,
            name: 'alpha',
            pos: target,
            vel: { x: 0, y: 0, z: 0 },
            link: 'up' as const,
            fuelFraction: 1,
            powerFraction: 1,
            health: 1,
          },
        ],
      });
      await waitFor(() => runtime.store.getUnit(A)?.pos?.x, (x) => x === target.x);
      const readBack = await httpRequest<{ operation: OpWire }>(port, 'GET', `/api/demo/fleet-ops/${opId}`);
      expect(readBack.status).toBe(200);
      const step = readBack.body.operation.steps[0]!;
      expect(step.status).toBe('dispatched');
      expect(readBack.body.operation.status).toBe('running');
      // No verified state was invented for the step.
      expect(step.execution!.verified).toBeUndefined();
      expect(runtime.store.getMission(step.orderId!)!.status).not.toBe('done');

      // The executor's own verified state is what completes it.
      const last = await drive(port, plugin, opId, { runtime });
      expect(last.status).toBe('done');
      expect(last.steps[0]!.execution!.verified!.state).toBe('holding');
      await plugin.close();
    });
  });

  it("(d) abort 'hold' cancels the member's mission through the executor", async () => {
    await withRuntime({ flags: ALL_FLAGS }, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', home()), ship(B, 'beta', pos(1_700))]);
      const plugin = await connect(port, runtime);

      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'swap',
        members: [A, B],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      const approved = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/approve`, {});
      expect(approved.status).toBe(200);
      const flying = approved.body.operation.steps.find((s) => s.status === 'dispatched')!;
      const cancelledMissionId = flying.execution!.missionId!;
      expect(runtime.store.getMission(cancelledMissionId)!.status).not.toBe('cancelled');

      const aborted = await httpRequest<{
        operation: OpWire;
        abort: { gridId: string; policy: string; action: string; orderId?: string }[];
      }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/abort`, { policy: 'hold' });
      expect(aborted.status).toBe(200);
      expect(aborted.body.operation.status).toBe('cancelled');

      // 1. The flying mission was cancelled through the mission store.
      expect(runtime.store.getMission(cancelledMissionId)!.status).toBe('cancelled');
      // 2. A parking mission replaced it, approved as the operation.
      const hold = aborted.body.abort.find((a) => a.gridId === flying.memberId)!;
      expect(hold.action).toBe('hold');
      const holdMissionId = hold.orderId!;
      const holdMission = runtime.store.getMission(holdMissionId)!;
      expect(holdMission.assignedUnits).toEqual([flying.memberId]);
      expect(['approved', 'executing']).toContain(holdMission.status);
      expect(runtime.store.countAudit('fleet_op_abort_mission', holdMissionId)).toBe(1);
      // 3. The executor now flies the hold, and released the cancelled mission.
      expect(runtime.executor!.gridStates(flying.memberId).some((s) => s.missionId === holdMissionId)).toBe(true);
      expect(
        plugin.received.some(
          (m) => m.type === 'order' && m.orderType === 'stop' && String(m.entityId ?? '') === flying.memberId,
        ),
      ).toBe(true);
      // 4. Fleet code never sent an abort order of its own.
      expect(plugin.received.some((m) => m.type === 'order' && String(m.orderId).includes(':abort:'))).toBe(false);
      expect(aborted.body.operation.steps.filter((s) => s.status === 'pending')).toHaveLength(0);
      await plugin.close();
    });
  });

  it('(e) with fleet_ops_execute OFF approve is plan-only and dispatches nothing', async () => {
    await withRuntime({}, async ({ runtime, port }) => {
      seedGrids(runtime, [BASE_GRID, ship(A, 'alpha', home(), { fuel: 1 })]);
      const plugin = await connect(port, runtime);
      const missionsBefore = runtime.store.listMissions().length;
      const target = pos(1_300);

      const created = await httpRequest<{ operation: OpWire }>(port, 'POST', '/api/demo/fleet-ops', {
        kind: 'reshape',
        members: [A],
        planet: 'EarthLike',
        dryRun: false,
        includeTerrain: false,
        slots: [{ gridId: A, target }],
      });
      expect(created.status).toBe(201);
      const op = created.body.operation;
      const approved = await httpRequest<{ operation: OpWire; execution: Record<string, unknown> }>(
        port,
        'POST',
        `/api/demo/fleet-ops/${op.id}/approve`,
        {},
      );
      expect(approved.status).toBe(200);
      expect(approved.body.execution).toMatchObject({
        mode: 'plan-only',
        executed: false,
        flag: 'fleet_ops_execute',
        dispatched: 0,
      });
      // Approved for review only: the plan is untouched and nothing ran.
      expect(approved.body.operation.status).toBe('approved');
      expect(approved.body.operation.steps.every((s) => s.status === 'pending')).toBe(true);
      expect(approved.body.operation.steps.every((s) => s.orderId === undefined)).toBe(true);
      expect(runtime.store.countAudit('fleet_op_execute_flag_off', op.id)).toBe(1);
      expect(plugin.received.filter((m) => m.type === 'order')).toHaveLength(0);
      expect(runtime.store.listMissions().length).toBe(missionsBefore);

      // A tick cannot sneak a dispatch out either.
      const ticked = await httpRequest<{ operation: OpWire }>(port, 'GET', `/api/demo/fleet-ops/${op.id}`);
      expect(ticked.body.operation.status).toBe('approved');
      expect(ticked.body.operation.steps.every((s) => s.status === 'pending')).toBe(true);
      expect(plugin.received.filter((m) => m.type === 'order')).toHaveLength(0);
      expect(runtime.store.listMissions().length).toBe(missionsBefore);

      // Abort/cancel is plan-only too: the record resolves, the wire stays quiet.
      const cancelled = await httpRequest<{ operation: OpWire }>(port, 'POST', `/api/demo/fleet-ops/${op.id}/cancel`, {
        policy: 'hold',
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.operation.status).toBe('cancelled');
      expect(plugin.received.filter((m) => m.type === 'order')).toHaveLength(0);
      expect(runtime.store.listMissions().length).toBe(missionsBefore);
      await plugin.close();
    });
  });
});
