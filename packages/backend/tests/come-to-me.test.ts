/**
 * Come to me (owner request 2026-11-11): fly a ship low and near a player,
 * hold there and wait for them to land it by hand with Remote Control.
 *
 * Two halves:
 *   * the ROUTE's standoff geometry (pure, fake terrain) - the hover is away
 *     from the player, never over them, inside the 180 m suit-radio cap and
 *     measured on the HULL BOTTOM above the TRUE ground;
 *   * the EXECUTOR's hover - arrival puts the mission in `waiting_for_pilot`,
 *     sends no flight order after the hover hold, completes as `handed to
 *     pilot` when the plugin reports control, and raises one info alert after
 *     the timeout while KEEPING the hover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { unavailableTerrainField, type TerrainField } from '../src/planner/terrainField.js';
import { AlertsService } from '../src/demo/alerts/index.js';
import { createRuntime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';
import {
  COME_TO_ME_MAX_DISTANCE_M,
  COME_TO_ME_MIN_LATERAL_M,
  computeComeToMePoint,
  offsetDirection,
  setComeToMeGroundSampler,
  type GroundSampler,
} from '../src/demo/comeToMe.js';

const NOW = 1_800_000_000_000;
const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The demo routes are hard-locked to the test server: without these the
  // request 404s before it ever reaches the handler.
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
  // The route samples the real :8786 height field, which is up on the dev
  // host; a test must not depend on that. Every column here is the measured
  // test column, 1 616.7 m above the catalogue mean.
  setComeToMeGroundSampler(() => flat(TRUE_GROUND_M));
});

afterAll(() => {
  setComeToMeGroundSampler(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const CENTRE = EARTH.center;
/** The measured test column: 1 616.7 m above the catalogue mean. */
const TRUE_GROUND_M = 61_016.7;

/** Flat ground at one radius: every column has the same true ground. */
const flat = (radiusM: number): GroundSampler => () => Promise.resolve({ radiusM, source: 'terrain-l5' });

/** Ground that steps up 400 m at the hover column (offset away from the ship). */
function stepped(baseRadiusM: number, stepAt: 'positive-x' | 'negative-x'): GroundSampler {
  return async (dir) => {
    const high = stepAt === 'positive-x' ? dir.x > 0.0001 : dir.x < -0.0001;
    return { radiusM: baseRadiusM + (high ? 20 : 0), source: high ? 'terrain-l5' : 'terrain-l0' };
  };
}

const playerAt = (radiusM = TRUE_GROUND_M, x = 0): { x: number; y: number; z: number } => ({
  x,
  y: 0,
  z: radiusM,
});

const length = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z);
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('come-to-me standoff geometry', () => {
  it('offsets AWAY from the ship, never over the player, and reads the hull bottom', async () => {
    // Ship 500 m east of the player: the hover must be east of the player too,
    // so the ship never crosses over them.
    const player = playerAt();
    const out = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: 500, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      // SAT-R-0001's keel: the hull ends 10 m ABOVE the pivot.
      keelDepthM: -10,
      lateralM: 40,
      aboveGroundM: 80,
      groundAt: flat(TRUE_GROUND_M),
    });
    if ('error' in out) throw new Error(out.error.message);
    const point = out.point;
    expect(point.directionSource).toBe('ship-approach');
    expect(point.position.x).toBeGreaterThan(player.x);
    expect(point.horizontalM).toBeCloseTo(40, 0);
    expect(point.horizontalM).toBeGreaterThanOrEqual(COME_TO_ME_MIN_LATERAL_M);
    // Hull bottom 80 m up: the POSITION is 80 + keel above the ground.
    expect(point.position.z).toBeCloseTo(TRUE_GROUND_M - 10 + 80, 0);
    expect(point.hoverAglM).toBeCloseTo(80, 1);
    expect(point.distanceToPlayerM).toBeLessThanOrEqual(COME_TO_ME_MAX_DISTANCE_M);
    expect(point.distanceToPlayerM).toBeCloseTo(Math.hypot(40, 80 - 10), 0);
    expect(point.groundSource).toBe('terrain-l5');
  });

  it('uses the terrain radius at the HOVER column, not at the player', async () => {
    const player = playerAt();
    const out = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: -800, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      keelDepthM: -10,
      lateralM: 40,
      aboveGroundM: 80,
      // The hover column (west of the player) is 20 m higher.
      groundAt: stepped(TRUE_GROUND_M, 'negative-x'),
    });
    if ('error' in out) throw new Error(out.error.message);
    expect(out.point.position.x).toBeLessThan(0);
    expect(out.point.position.z).toBeCloseTo(TRUE_GROUND_M + 20 - 10 + 80, 0);
    expect(out.point.hoverAglM).toBeCloseTo(80, 1);
    expect(out.point.groundSource).toBe('terrain-l5');
  });

  it('never sits over the player when the ship is already overhead', async () => {
    const player = playerAt();
    const dir = offsetDirection({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 500 });
    expect(dir.source).toBe('fallback-tangent');
    expect(length(dir.dir)).toBeCloseTo(1, 6);
    const out = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: 0, y: 0, z: TRUE_GROUND_M + 500 },
      planet: EARTH,
      keelDepthM: 0,
      lateralM: 40,
      aboveGroundM: 80,
      groundAt: flat(TRUE_GROUND_M),
    });
    if ('error' in out) throw new Error(out.error.message);
    expect(out.point.directionSource).toBe('fallback-tangent');
    expect(out.point.horizontalM).toBeGreaterThanOrEqual(COME_TO_ME_MIN_LATERAL_M);
    expect(dist(out.point.position, player)).toBeLessThanOrEqual(COME_TO_ME_MAX_DISTANCE_M);
  });

  it('shrinks the standoff to fit inside the 180 m suit-radio cap', async () => {
    const player = playerAt();
    const requested = 150;
    const out = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: 2_000, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      keelDepthM: 0,
      lateralM: requested,
      aboveGroundM: 170,
      groundAt: flat(TRUE_GROUND_M),
    });
    if ('error' in out) throw new Error(out.error.message);
    expect(out.point.shrunk).toBe(true);
    expect(out.point.requestedLateralM).toBe(requested);
    expect(out.point.lateralM).toBeLessThan(requested);
    expect(out.point.lateralM).toBeGreaterThanOrEqual(COME_TO_ME_MIN_LATERAL_M);
    expect(out.point.distanceToPlayerM).toBeLessThanOrEqual(COME_TO_ME_MAX_DISTANCE_M);
    // The requested clearance is kept: only the lateral room is given up.
    expect(out.point.hoverAglM).toBeCloseTo(170, 1);
  });

  it('refuses a hover that cannot fit, and any offset closer than 25 m', async () => {
    const player = playerAt();
    const tooTall = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: 2_000, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      keelDepthM: 0,
      lateralM: 40,
      aboveGroundM: 179,
      groundAt: flat(TRUE_GROUND_M),
    });
    expect('error' in tooTall && tooTall.error.code).toBe('standoff_refused');
    expect('error' in tooTall && tooTall.error.message).toContain('180');

    const tooClose = await computeComeToMePoint({
      playerPos: player,
      shipPos: { x: 200, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      keelDepthM: 0,
      lateralM: 10,
      aboveGroundM: 80,
      groundAt: flat(TRUE_GROUND_M),
    });
    expect('error' in tooClose && tooClose.error.code).toBe('standoff_too_close');
  });
});

// ------------------------------------------------------------------ the route

interface MoveToResponse {
  request?: string | null;
  comeToMe?: {
    player: string | null;
    standIn: { x: number; y: number; z: number } | null;
    hover: { x: number; y: number; z: number };
    hoverAglM: number;
    standoff: { lateralM: number; aboveGroundM: number };
    distanceToPlayerM: number;
    shrunk: boolean;
    timeoutMs: number;
    groundSource: string;
  } | null;
  mission: { id: string; desiredState: Record<string, unknown> };
  gridId: string;
}

interface ErrorBody {
  error: { code: string; message?: string; issues?: string[] };
}

const GRID = 'grid:107519913664561774';
const IDENTITY = '10000000000000001';
const STEAM = '10000000000000001';
const PLAYER_RADIUS = 61_016.7;

async function withRuntime<T>(fn: (ctx: { runtime: ReturnType<typeof createRuntime>; port: number; clock: ReturnType<typeof makeClock> }) => Promise<T>): Promise<T> {
  const clock = makeClock(NOW);
  const runtime = createRuntime({
    config: makeConfig({ port: 0, flags: { demo_execute: true } }),
    memory: true,
    clock: clock.now,
  });
  const port = await runtime.listen(0);
  // The ship sits 800 m east of the player, in the SAME column terrain.
  runtime.store.upsertUnit({
    id: GRID,
    name: 'SAT-R-0001',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: 800, y: 0, z: PLAYER_RADIUS + 20 },
    vel: null,
    meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, keelDepthM: -10 },
  });
  try {
    return await fn({ runtime, port, clock });
  } finally {
    await runtime.close();
  }
}

function ingestPlayer(runtime: ReturnType<typeof createRuntime>, at: number): void {
  runtime.players.ingest(
    [
      {
        identityId: IDENTITY,
        steamId: STEAM,
        displayName: 'the owner',
        characterEntityId: 'char:1',
        pos: { x: 0, y: 0, z: PLAYER_RADIUS },
        vel: { x: 0, y: 0, z: 0 },
        gridId: null,
        seatName: null,
        piloting: false,
        planet: EARTH.name,
        aglM: 0,
        altitudeM: 1_616.7,
        gravityMps2: 9.81,
        onFoot: true,
        isDead: false,
        factionTag: 'HERMES',
        factionId: '1',
        optOut: false,
      },
    ],
    at,
  );
}

describe('POST /api/demo/move-to with a player target', () => {
  it('resolves the hover beside the player and records the standoff on the mission', async () => {
    await withRuntime(async ({ runtime, port }) => {
      ingestPlayer(runtime, NOW);
      const res = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: IDENTITY },
        ignoreReach: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.request).toBe('come-to-me');
      const comeToMe = res.body.comeToMe!;
      expect(comeToMe.player).toBe(IDENTITY);
      expect(comeToMe.standoff.lateralM).toBe(40);
      expect(comeToMe.standoff.aboveGroundM).toBe(80);
      expect(comeToMe.hoverAglM).toBeCloseTo(80, 0);
      expect(comeToMe.distanceToPlayerM).toBeLessThanOrEqual(COME_TO_ME_MAX_DISTANCE_M);
      // East of the player (the ship is east of them): the ship never crosses.
      expect(comeToMe.hover.x).toBeGreaterThan(0);
      const desired = res.body.mission.desiredState as {
        mode?: string;
        comeToMe?: { phase?: string; timeoutMs?: number; hover?: { x: number } };
      };
      expect(desired.mode).toBe('hold');
      expect(desired.comeToMe?.phase).toBe('flying');
      expect(desired.comeToMe?.timeoutMs).toBe(600_000);
      expect(desired.comeToMe?.hover?.x).toBeCloseTo(comeToMe.hover.x, 3);
    });
  });

  it('accepts a GPS stand-in point with comeToMe: true (nobody online)', async () => {
    await withRuntime(async ({ port }) => {
      const standIn = { x: 0, y: 0, z: PLAYER_RADIUS };
      const res = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: standIn },
        comeToMe: true,
        ignoreReach: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.request).toBe('come-to-me');
      expect(res.body.comeToMe?.player).toBeNull();
      expect(res.body.comeToMe?.standIn).toEqual(standIn);
      expect(res.body.comeToMe?.hover.x).toBeGreaterThan(0);
    });
  });

  it('refuses a player position older than 5 minutes, with a plain reason', async () => {
    await withRuntime(async ({ runtime, port }) => {
      ingestPlayer(runtime, NOW - 6 * 60_000);
      const res = await httpRequest<ErrorBody>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: STEAM },
        ignoreReach: true,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('player_position_stale');
      expect(res.body.error.message).toMatch(/6 min/);
      expect(res.body.error.message).toMatch(/limit 5 min/);
    });
  });

  it('refuses an unknown player id and a standoff under 25 m', async () => {
    await withRuntime(async ({ runtime, port }) => {
      ingestPlayer(runtime, NOW);
      const unknown = await httpRequest<ErrorBody>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: '10000000000000099' },
        ignoreReach: true,
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('unknown_player');

      const close = await httpRequest<ErrorBody>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: IDENTITY, standoff: { lateralM: 10 } },
        ignoreReach: true,
      });
      expect(close.status).toBe(409);
      expect(close.body.error.code).toBe('standoff_too_close');
    });
  });

  it('shrinks a too-far standoff through the API instead of flying outside the radio', async () => {
    await withRuntime(async ({ runtime, port }) => {
      ingestPlayer(runtime, NOW);
      const res = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: IDENTITY, standoff: { lateralM: 150, aboveGroundM: 170 } },
        ignoreReach: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.comeToMe?.shrunk).toBe(true);
      expect(res.body.comeToMe?.standoff.lateralM).toBeLessThan(150);
      expect(res.body.comeToMe?.standoff.lateralM).toBeGreaterThanOrEqual(COME_TO_ME_MIN_LATERAL_M);
      expect(res.body.comeToMe!.distanceToPlayerM).toBeLessThanOrEqual(COME_TO_ME_MAX_DISTANCE_M);
      // The requested clearance is kept: only the lateral room is given up.
      expect(res.body.comeToMe?.hoverAglM).toBeCloseTo(170, 0);
    });
  });

  it('refuses to combine a come-to-me hover with a landing', async () => {
    await withRuntime(async ({ runtime, port }) => {
      ingestPlayer(runtime, NOW);
      const res = await httpRequest<ErrorBody>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { player: IDENTITY },
        ignoreReach: true,
        land: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid');
      expect((res.body.error.issues ?? []).join(' ')).toMatch(/manual landing/);
    });
  });
});

// --------------------------------------------------------------- the executor

function fakeHub(sent: Record<string, unknown>[]) {
  return {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
  } as never;
}

function flatTerrain(radiusM: number): TerrainField {
  return {
    planet: EARTH.name,
    planetId: EARTH.id ?? null,
    get status(): 'available' | 'unavailable' {
      return 'available';
    },
    reason: null,
    tiles: 1,
    radiusAt: () => radiusM,
  };
}

const KEEL = -10;
const HOVER_AGL = 80;

/** A move mission the route would create for comeToMe, plus a fake-hub executor. */
function setupComeToMe(
  timeoutMs = 600_000,
  opts: { terrain?: () => TerrainField; slotGroundM?: number } = {},
) {
  const config = makeConfig();
  config.demo.speedLimitMps = 100;
  config.demo.comeToMe.timeoutMs = timeoutMs;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  const sent: Record<string, unknown>[] = [];
  const clock = { now: NOW };
  const executor = new DemoExecutor({
    store,
    hub: fakeHub(sent),
    config,
    clock: () => clock.now,
    fixturePath: null,
    terrainField: () => opts.terrain?.() ?? flatTerrain(TRUE_GROUND_M),
  });
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  // 10 km from the base, so the comms gate is satisfied, at the hover radius.
  const raw = { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z };
  const r = Math.hypot(raw.x - CENTRE.x, raw.y - CENTRE.y, raw.z - CENTRE.z);
  const k = ((opts.slotGroundM ?? TRUE_GROUND_M) + KEEL + HOVER_AGL) / r;
  const hover = {
    x: CENTRE.x + (raw.x - CENTRE.x) * k,
    y: CENTRE.y + (raw.y - CENTRE.y) * k,
    z: CENTRE.z + (raw.z - CENTRE.z) * k,
  };
  const playerPos = { x: CENTRE.x, y: CENTRE.y, z: CENTRE.z + TRUE_GROUND_M };
  const result = createMission(
    store,
    {
      type: 'move',
      priority: 50,
      desiredState: {
        shipSpec: 'stand-in-grid',
        station: `move:${GRID.replace(/[^0-9]/g, '')}`,
        formation: 'none',
        position: hover,
        targetLabel: 'hover near the player',
        altitudeM: 1_696.7,
        planet: EARTH.name,
        mode: 'hold',
        comeToMe: {
          player: IDENTITY,
          playerName: 'the owner',
          standoff: { lateralM: 40, aboveGroundM: HOVER_AGL },
          hover,
          hoverAglM: HOVER_AGL,
          groundSource: 'terrain-l5',
          distanceToPlayerM: 89,
          phase: 'flying',
          timeoutMs,
        },
      } as never,
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: [GRID],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: { adminOverride: true }, done: false },
          { id: 'move', kind: 'move', params: { gridId: GRID, target: hover }, done: false },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq', action: 'move' }, done: false },
        ],
        notes: '[SIMULATED] come-to-me test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(`${result.message}: ${JSON.stringify((result as { issues?: unknown }).issues ?? result)}`);
  const mission = result.mission;
  store.updateMission(mission.id, { status: 'approved' }, NOW);
  store.setKv('demo:identityId', IDENTITY);
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = ?, planet = ?,
             pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:${GRID}'
       WHERE mission_id = ?`,
    )
    .run(GRID, EARTH.name, mission.id);
  const place = (
    pos: { x: number; y: number; z: number },
    vel = { x: 0, y: 0, z: 0 },
    meta: Record<string, unknown> = {},
  ) => {
    store.upsertUnit({
      id: GRID,
      name: 'SAT-R-0001',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: clock.now,
      pos,
      vel,
      meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false, keelDepthM: KEEL, ...meta },
    });
  };
  place(hover);
  const drone = () =>
    store.db
      .prepare(`SELECT state, reason, step FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string | null; step: string | null };
  return { store, config, sent, clock, executor, mission, hover, playerPos, place, drone, hq };
}

/** Ack every pending order the way the fake plugin hub does. */
function ackAll(store: Store, sent: Record<string, unknown>[]): void {
  for (const message of sent) {
    if (message.type !== 'order') continue;
    const orderId = String(message.orderId ?? '');
    const order = orderId ? store.getOrder(orderId) : null;
    if (order && order.status !== 'acked') store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
  }
}

function flightOrders(sent: Record<string, unknown>[]): Record<string, unknown>[] {
  return sent.filter((m) => m.type === 'order' && ['move', 'hold', 'stop'].includes(String(m.orderType)));
}

function audit(store: Store, action: string): { detail: Record<string, unknown> }[] {
  return (store.listAudit(500) as { action: string; detail: Record<string, unknown> }[]).filter(
    (row) => row.action === action,
  );
}

/** Fly to the hover point: one move, then arrive. */
function arrive(ctx: ReturnType<typeof setupComeToMe>) {
  for (let i = 0; i < 6; i += 1) {
    ctx.executor.tick();
    ackAll(ctx.store, ctx.sent);
    ctx.clock.now += 1_000;
  }
}

describe('come-to-me arrival and handoff', () => {
  it('parks the mission in waiting_for_pilot and sends no flight order afterwards', () => {
    const ctx = setupComeToMe();
    arrive(ctx);

    expect(ctx.drone().state).toBe('waiting_pilot');
    const ready = audit(ctx.store, 'come_to_me_ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]!.detail.player).toBe(IDENTITY);
    expect(ready[0]!.detail.distanceToPlayerM).toBe(89);
    expect(Number(ready[0]!.detail.hoverAglM)).toBeCloseTo(HOVER_AGL, 0);
    const mission = ctx.store.getMission(ctx.mission.id)!;
    // Not finished: the dispatcher may still show `approved` here, never a
    // terminal status (the hover is waiting, the ship is still in the air).
    expect(['approved', 'executing']).toContain(mission.status);
    expect((mission.desiredState as { comeToMe: { phase: string } }).comeToMe.phase).toBe('waiting_for_pilot');

    // The autopilot is cleared once so the dampeners hold the hover, then
    // NOTHING else: no re-anchored hold, no landing, no stop.
    expect(ctx.drone().step).toBe('come-to-me-waiting');
    expect(audit(ctx.store, 'come_to_me_autopilot_off')).toHaveLength(1);
    ctx.sent.length = 0;
    for (let i = 0; i < 10; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(flightOrders(ctx.sent)).toHaveLength(0);
    expect(ctx.drone().state).toBe('waiting_pilot');
    // Still not finished: nobody has landed it.
    expect(['approved', 'executing']).toContain(ctx.store.getMission(ctx.mission.id)!.status);
  });

  it('completes as handed to pilot when the plugin reports control, with zero orders', () => {
    const ctx = setupComeToMe();
    arrive(ctx);
    expect(ctx.drone().state).toBe('waiting_pilot');

    // Let the 5 s control probe go out, then answer it the way the plugin does.
    ctx.clock.now += 6_000;
    ctx.executor.tick();
    const probes = ctx.sent.filter(
      (m) => (m.params as Record<string, unknown> | undefined)?.action === 'is_under_control',
    );
    expect(probes.length).toBeGreaterThan(0);
    const probe = probes.at(-1)!;
    ctx.store.audit({
      actor: 'plugin',
      action: 'plugin_event',
      subject: 'order_result',
      detail: {
        eventType: 'order_result',
        data: { orderId: String(probe.orderId), ok: true, result: { underControl: true, control: { underControl: true, by: 'Remote control' } } },
      },
      at: ctx.clock.now,
    });
    ctx.sent.length = 0;
    ctx.clock.now += 1_000;
    ctx.executor.tick();

    const mission = ctx.store.getMission(ctx.mission.id)!;
    expect(mission.status).toBe('done');
    expect(mission.pauseReason).toBe('handed to pilot');
    expect((mission.desiredState as { comeToMe: { phase: string } }).comeToMe.phase).toBe('handed_to_pilot');
    expect(ctx.drone().state).toBe('manual');
    expect(audit(ctx.store, 'come_to_me_handed_to_pilot')).toHaveLength(1);
    expect(flightOrders(ctx.sent)).toHaveLength(0);

    // And it stays silent: a hand-flown ship gets no orders while the player
    // has it.
    for (let i = 0; i < 5; i += 1) {
      ctx.clock.now += 6_000;
      ctx.executor.tick();
    }
    expect(flightOrders(ctx.sent)).toHaveLength(0);
  });

  it('does not hand off on telemetry alone (the stale underControl bug)', () => {
    const ctx = setupComeToMe();
    arrive(ctx);
    expect(ctx.drone().state).toBe('waiting_pilot');

    // Telemetry claims a pilot; the plugin's is_under_control probe has not
    // answered. Come to me trusts only the probe, so nothing happens.
    ctx.place(ctx.hover, { x: 0, y: 0, z: 0 }, { underControl: true, controlledBy: 'the owner' });
    ctx.sent.length = 0;
    for (let i = 0; i < 5; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(ctx.drone().state).toBe('waiting_pilot');
    expect(ctx.store.getMission(ctx.mission.id)!.status).not.toBe('done');
    expect(flightOrders(ctx.sent)).toHaveLength(0);
  });

  it('raises one info alert after the timeout and KEEPS the hover', async () => {
    const ctx = setupComeToMe(60_000);
    arrive(ctx);
    expect(ctx.drone().state).toBe('waiting_pilot');

    ctx.clock.now += 61_000;
    ctx.executor.tick();
    expect(audit(ctx.store, 'come_to_me_timeout')).toHaveLength(1);

    const alerts = new AlertsService({
      store: ctx.store,
      clock: () => ctx.clock.now,
      fixturePath: null,
      pluginConnected: () => true,
    });
    const result = await alerts.evaluate(undefined, ctx.clock.now);
    const opened = result.opened.find((a) => a.kind === 'come-to-me-timeout')!;
    expect(opened).toBeTruthy();
    expect(opened.severity).toBe('info');
    expect(opened.subjectId).toBe(GRID);
    expect(opened.message).toMatch(/keeps hovering/);

    // The ship is still exactly where it was: no landing, no departure.
    ctx.sent.length = 0;
    for (let i = 0; i < 10; i += 1) {
      ctx.clock.now += 10_000;
      ctx.executor.tick();
    }
    expect(flightOrders(ctx.sent)).toHaveLength(0);
    expect(ctx.drone().state).toBe('waiting_pilot');
    expect(['approved', 'executing']).toContain(ctx.store.getMission(ctx.mission.id)!.status);
    expect(ctx.drone().step).toBe('come-to-me-timed-out');
  });
});

describe('come-to-me ground fallbacks', () => {
  it('labels a mean-ground hover instead of pretending it is terrain', async () => {
    const out = await computeComeToMePoint({
      playerPos: playerAt(),
      shipPos: { x: 500, y: 0, z: TRUE_GROUND_M },
      planet: EARTH,
      keelDepthM: 0,
      lateralM: 40,
      aboveGroundM: 80,
      groundAt: () => Promise.resolve(null),
    });
    expect('error' in out && out.error.code).toBe('ground_unknown');
  });

  it('keeps the flat terrain helper honest for the tests above', () => {
    // Guard against a typo in the fixture: an unavailable field is explicit.
    expect(unavailableTerrainField(EARTH, 'test').status).toBe('unavailable');
  });
});
