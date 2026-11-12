/**
 * The 2026-11-11 come-to-me hold fixes, pinned.
 *
 *   1. DATUM: `groundFrame()` measured the SLOT's AGL with the ground sampled
 *      under the SHIP. The two columns differ by 144 m of terrain height on the
 *      BASE-01 approach (61 177.6 m vs 61 033.8 m), which read an 88 m
 *      clearance as -63 m and refused a legal hover. The slot must use its OWN
 *      column; the ship keeps its own.
 *   2. FLOOR: the come-to-me hold floor is 80 m of hull bottom (owner decision),
 *      NOT the 100 m station rule. A hover planned at 80 m is judged at 80,
 *      stations keep 100, and a come-to-me hover is never converted to a
 *      station (which would freeze it there).
 *   3. PHANTOM: a run whose drones are all terminal must be closed with a final
 *      status and a reason on the next tick - the come-to-me exemption in
 *      `finishIfDone` used to leave it `running` for ever.
 *
 * RTS_TERRAIN=off keeps the fine-terrain loader out of the test: these fixtures
 * are the whole ground truth, and the real :8786 field must never decide a
 * pass or a fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { cancelMission, createMission } from '../src/missions.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import { stationDecision } from '../src/demo/station.js';
import { COME_TO_ME_HOLD_FLOOR_M, GROUND_CLEARANCE_M } from '../src/demo/flight.js';
import { COME_TO_ME_COARSE_DATUM_MARGIN_M } from '../src/demo/comeToMe.js';
import { clearGroundCache } from '../src/demo/ground.js';
import { makeClock, makeConfig } from './helpers.js';

type Vec3 = { x: number; y: number; z: number };

const NOW = 1_800_000_000_000;
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const CENTRE = EARTH.center;
/** The two measured columns: the hover slot's ground and the ship's. */
const SLOT_GROUND_M = 61_033.8;
const SHIP_GROUND_M = 61_177.6;
const KEEL = -10;
const HOVER_AGL = 80;
const GRID = 'grid:107519913664561774';
const IDENTITY = '10000000000000001';

const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const fromCentre = (dir: Vec3, radiusM: number): Vec3 => ({
  x: CENTRE.x + dir.x * radiusM,
  y: CENTRE.y + dir.y * radiusM,
  z: CENTRE.z + dir.z * radiusM,
});

/**
 * A terrain field whose radius depends on the sampled column (by direction).
 *
 * `level` defaults to 5: these fixtures ARE the true ground, and a field that
 * claims level 5 is the honest labelling of that. A test that wants the coarse
 * planning field says so (`level: 0`) and gets the coarse-datum rules.
 */
function columnTerrain(radiusAt: (dir: Vec3) => number, level = 5): TerrainField {
  return {
    planet: EARTH.name,
    planetId: EARTH.id ?? null,
    get status(): 'available' | 'unavailable' {
      return 'available';
    },
    reason: null,
    tiles: 2,
    level,
    radiusAt: (dir) => radiusAt(dir),
  };
}

/** The hover direction the route's come-to-me would build for the seeded base. */
function hoverDirection(): Vec3 {
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  const raw = { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z };
  return norm(sub(raw, CENTRE));
}

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

/** A come-to-me move mission, the drone already released onto the grid. */
function setupComeToMe(opts: {
  terrain: () => TerrainField;
  slotGroundM: number;
  /** The datum the route RECORDED on the mission (what set 3 was missing). */
  datum?: { groundRadiusM: number; groundLevel: number; groundSource: string };
}) {
  // The shared column cache is module-level (by design: one policy, one cache),
  // so a fixture from the previous test would otherwise decide this one - a
  // level-5 sample filed for this column once made a coarse-datum test pass by
  // accident.
  clearGroundCache();
  const config = makeConfig();
  config.demo.speedLimitMps = 100;
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
    terrainField: () => opts.terrain(),
  });
  const dir = hoverDirection();
  const hover = fromCentre(dir, opts.slotGroundM + KEEL + HOVER_AGL);
  const playerPos = fromCentre(dir, opts.slotGroundM);
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
          ...(opts.datum
            ? {
                groundRadiusM: opts.datum.groundRadiusM,
                groundLevel: opts.datum.groundLevel,
                groundSource: opts.datum.groundSource,
              }
            : {}),
          groundSource: opts.datum?.groundSource ?? 'terrain-l5',
          distanceToPlayerM: 89,
          phase: 'flying',
          timeoutMs: 600_000,
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
        notes: '[SIMULATED] come-to-me hold floor test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(`${result.message}: ${JSON.stringify((result as { issues?: unknown }).issues ?? result)}`);
  const mission = result.mission;
  store.updateMission(mission.id, { status: 'approved' }, NOW);
  store.setKv('demo:identityId', IDENTITY);
  executor.sync(NOW);
  executor.tick();
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
  const place = (pos: Vec3, vel: Vec3 = { x: 0, y: 0, z: 0 }) => {
    store.upsertUnit({
      id: GRID,
      name: 'SAT-R-0001',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: clock.now,
      pos,
      vel,
      meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false, keelDepthM: KEEL },
    });
  };
  place(hover);
  const drone = () =>
    store.db
      .prepare(`SELECT state, reason, step FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as { state: string; reason: string | null; step: string | null };
  const exec = () =>
    store.db.prepare(`SELECT state, note FROM demo_exec WHERE mission_id = ?`).get(mission.id) as {
      state: string;
      note: string | null;
    };
  return { store, config, sent, clock, executor, mission, hover, playerPos, place, drone, exec, dir };
}

function ackAll(store: Store, sent: Record<string, unknown>[]): void {
  for (const message of sent) {
    if (message.type !== 'order') continue;
    const orderId = String(message.orderId ?? '');
    const order = orderId ? store.getOrder(orderId) : null;
    if (order && order.status !== 'acked') store.updateOrder(orderId, { status: 'acked', ackedAt: NOW });
  }
}

function audit(store: Store, action: string): { detail: Record<string, unknown> }[] {
  return (store.listAudit(500) as { action: string; detail: Record<string, unknown> }[]).filter(
    (row) => row.action === action,
  );
}

const savedTerrain = process.env.RTS_TERRAIN;

beforeAll(() => {
  // Never let the real :8786 height field decide these assertions.
  process.env.RTS_TERRAIN = 'off';
});

afterAll(() => {
  if (savedTerrain === undefined) delete process.env.RTS_TERRAIN;
  else process.env.RTS_TERRAIN = savedTerrain;
});

describe('come-to-me slot datum (2026-11-11)', () => {
  it('measures the SLOT at its own column, so a 144 m column offset does not refuse the hover', () => {
    const dir = hoverDirection();
    const slot = fromCentre(dir, SLOT_GROUND_M + KEEL + HOVER_AGL);
    // The ship hovers 2 km away, over ground 143.8 m HIGHER than the slot's.
    const angle = 2_000 / SLOT_GROUND_M;
    const up = dir;
    const east = norm({ x: -up.z, y: 0, z: up.x });
    const shipDir = norm({
      x: up.x * Math.cos(angle) + east.x * Math.sin(angle),
      y: up.y * Math.cos(angle) + east.y * Math.sin(angle),
      z: up.z * Math.cos(angle) + east.z * Math.sin(angle),
    });
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () =>
        columnTerrain((sample) => (dot(sample, dir) > 0.9999 ? SLOT_GROUND_M : SHIP_GROUND_M)),
    });
    // 30 m above its own (higher) column: the ship's own AGL is readable and
    // the slot's is the 80 m the mission asked for.
    ctx.place(fromCentre(shipDir, SHIP_GROUND_M + 30));
    ctx.executor.tick();
    ackAll(ctx.store, ctx.sent);

    // The old code subtracted the ship's column from the slot's radius and got
    // -63 m of hull bottom: `demo_hold_refused`, no leg. Neither may happen.
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
    const moves = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'move');
    expect(moves.length).toBeGreaterThan(0);

    // And it actually arrives: the hover is real, not a refused waypoint.
    for (let i = 0; i < 6; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    ctx.place(slot);
    for (let i = 0; i < 6; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    expect(ctx.drone().state).toBe('waiting_pilot');
    const ready = audit(ctx.store, 'come_to_me_ready');
    expect(ready).toHaveLength(1);
    // Hull bottom 80 m above the SLOT's ground (70 m of position AGL + 10 m keel).
    expect(Number(ready[0]!.detail.hoverAglM)).toBeCloseTo(HOVER_AGL, 0);
  });
});

describe('come-to-me hold floor is 80 m, not the 100 m station floor', () => {
  it('uses the 80 m come-to-me floor in the refusal, and refuses a hover the terrain rose under', () => {
    // Planned at 80 m over 61 033.8 m; the terrain at the slot is 20 m higher
    // when the leg is planned, so the hover now measures ~60 m of hull bottom.
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M + 20),
    });
    ctx.executor.tick();

    const refused = audit(ctx.store, 'demo_hold_refused');
    expect(refused).toHaveLength(1);
    const reason = String(refused[0]!.detail.reason);
    // The come-to-me floor (80), never the station rule (100).
    expect(reason).toMatch(new RegExp(`${COME_TO_ME_HOLD_FLOOR_M} m required`));
    expect(reason).not.toMatch(new RegExp(`${GROUND_CLEARANCE_M} m required`));
    expect(Number(refused[0]!.detail.targetAglM)).toBeLessThan(COME_TO_ME_HOLD_FLOOR_M);
  });

  it('lets the planned 80 m hover through when the ground matches the plan', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M),
    });
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
  });

  it('keeps the 100 m station floor for stations (an 80 m hover is never stationable)', () => {
    const decision = stationDecision({
      enabled: true,
      state: 'holding',
      holdMs: 60_000,
      speedMps: 0.2,
      aglM: COME_TO_ME_HOLD_FLOOR_M,
      hasPendingOrder: false,
      underControl: false,
      isStatic: false,
      alreadyStationed: false,
      config: { enabled: true, afterMs: 30_000, maxSpeedMps: 0.5, zeroSpeedMps: 5, minAglM: GROUND_CLEARANCE_M },
    });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain(`${GROUND_CLEARANCE_M} m`);
  });

  it('never converts a come-to-me hover to a station, even at 300 m with the holds satisfied', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M),
    });
    // A high, still, long-held drone - exactly what the station pass stations.
    ctx.place(fromCentre(ctx.dir, SLOT_GROUND_M + 300));
    ctx.store.db
      .prepare(`UPDATE demo_drones SET state = 'holding', step = NULL, hold_at = ? WHERE mission_id = ?`)
      .run(NOW - 120_000, ctx.mission.id);
    ctx.sent.length = 0;
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'convert_to_station')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_station_decision')).toHaveLength(0);
    expect(ctx.drone().state).toBe('holding');
  });
});

describe('phantom running execution (2026-11-11)', () => {
  it('closes a come-to-me run whose only drone is terminal, and keeps its history rows', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M),
    });
    ctx.store.db
      .prepare(`UPDATE demo_drones SET state = 'aborted', reason = 'test: aborted before the hover' WHERE mission_id = ?`)
      .run(ctx.mission.id);
    expect(ctx.exec().state).toBe('running');

    ctx.clock.now += 1_000;
    ctx.executor.tick();

    const exec = ctx.exec();
    expect(exec.state).toBe('failed');
    expect(String(exec.note)).toMatch(/come-to-me hover ended without a handoff/);
    expect(ctx.store.getMission(ctx.mission.id)!.status).toBe('failed');
    const finished = audit(ctx.store, 'demo_exec_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.detail.state).toBe('failed');
    expect(JSON.stringify(finished[0]!.detail.droneStates)).toContain('aborted');
    // History is NOT deleted: the rows stay for the audit trail.
    const rows = ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM demo_drones WHERE mission_id = ?`).get(ctx.mission.id) as {
      n: number;
    };
    expect(rows.n).toBe(1);
    expect(ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM demo_exec WHERE mission_id = ?`).get(ctx.mission.id)).toEqual({
      n: 1,
    });
  });

  it('does not close a run that is still hovering for a pilot', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M),
    });
    const slot = fromCentre(ctx.dir, SLOT_GROUND_M + KEEL + HOVER_AGL);
    ctx.place(slot);
    for (let i = 0; i < 8; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    expect(ctx.drone().state).toBe('waiting_pilot');
    expect(ctx.exec().state).toBe('running');
    expect(audit(ctx.store, 'demo_exec_finished')).toHaveLength(0);
  });
});

describe('a coarse datum may only raise the hover (2026-11-11 set 3)', () => {
  it('raises a hold recorded on the level-0 field by the margin, and audits the datum', () => {
    // The route planned this hover while only the level-0 planning field was up:
    // on the test world that field read 37.5 m low (61 160.7 vs 61 198.24), and
    // a hold built on it as-is is the 56.6 m hover that was flown against an
    // 80 m ask.
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M, 0),
      datum: { groundRadiusM: SLOT_GROUND_M, groundLevel: 0, groundSource: 'terrain-l0' },
    });
    const plannedRadius = len(ctx.hover);
    ctx.place(ctx.hover);
    for (let i = 0; i < 12; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    const datum = audit(ctx.store, 'come_to_me_hold_datum');
    expect(datum).toHaveLength(1);
    const detail = datum[0]!.detail;
    expect(Number(detail.sampleLevel)).toBe(0);
    expect(Number(detail.coarseMarginM)).toBe(COME_TO_ME_COARSE_DATUM_MARGIN_M);
    // The hold is the coarse sample PLUS the margin: never below the ask.
    expect(Number(detail.holdRadiusM)).toBeCloseTo(
      SLOT_GROUND_M + COME_TO_ME_COARSE_DATUM_MARGIN_M + KEEL + HOVER_AGL,
      1,
    );
    expect(Number(detail.deltaM)).toBeCloseTo(COME_TO_ME_COARSE_DATUM_MARGIN_M, 1);
    expect(Number(detail.holdRadiusM)).toBeGreaterThan(plannedRadius);
    // And the slot the executor will fly IS the raised one.
    const row = ctx.store.db
      .prepare(`SELECT exec_slot_json FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { exec_slot_json: string };
    const slot = JSON.parse(row.exec_slot_json) as Vec3;
    expect(len(slot)).toBeCloseTo(plannedRadius + COME_TO_ME_COARSE_DATUM_MARGIN_M, 1);
    expect(String(detail.note)).toMatch(/never lower it/);
  });

  it('does not move a hold recorded on landing-grade ground, and reports the plan datum', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M, 0),
      datum: { groundRadiusM: SLOT_GROUND_M, groundLevel: 5, groundSource: 'terrain-l5' },
    });
    const plannedRadius = len(ctx.hover);
    ctx.place(ctx.hover);
    for (let i = 0; i < 12; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    expect(audit(ctx.store, 'come_to_me_hold_datum')).toHaveLength(0);
    const ready = audit(ctx.store, 'come_to_me_ready');
    expect(ready).toHaveLength(1);
    // The hover is judged on the datum it was BUILT with, not on the coarse
    // sample at the ship's column.
    expect(String(ready[0]!.detail.hoverAglSource)).toBe('plan-datum');
    expect(Number(ready[0]!.detail.hoverAglM)).toBeCloseTo(HOVER_AGL, 0);
    const row = ctx.store.db
      .prepare(`SELECT exec_slot_json FROM demo_drones WHERE mission_id = ?`)
      .get(ctx.mission.id) as { exec_slot_json: string };
    expect(len(JSON.parse(row.exec_slot_json) as Vec3)).toBeCloseTo(plannedRadius, 1);
  });
});

describe('a superseded come-to-me is cancelled, not failed (2026-11-11 set 3)', () => {
  it('closes the run cancelled with the reason when a newer order cancels the mission', () => {
    const ctx = setupComeToMe({
      slotGroundM: SLOT_GROUND_M,
      terrain: () => columnTerrain(() => SLOT_GROUND_M),
    });
    ctx.place(ctx.hover);
    for (let i = 0; i < 4; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    // What `supersedeGridMissions` does when a newer order for the grid arrives.
    const cancelled = cancelMission(
      ctx.store,
      ctx.mission.id,
      'demo-site',
      ctx.clock.now,
      `superseded by a new move-to (m-newer)`,
    );
    expect(cancelled.ok).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
      ackAll(ctx.store, ctx.sent);
    }
    const exec = ctx.exec();
    expect(exec.state).toBe('cancelled');
    expect(String(exec.note)).toMatch(/cancelled by a newer order|superseded/);
    expect(String(exec.note)).not.toMatch(/without a handoff/);
    expect(ctx.store.getMission(ctx.mission.id)!.status).toBe('cancelled');
    const finished = audit(ctx.store, 'demo_exec_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.detail.state).toBe('cancelled');
    expect(ctx.drone().state).not.toBe('waiting_pilot');
  });
});
