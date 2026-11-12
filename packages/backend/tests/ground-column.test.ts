/**
 * 2026-11-11 ground disagreement (data/flight-proof-20261111.md, defect 2).
 *
 * `comeToMe` placed its hover with an awaited level-5 sample (ground 61 162.9 m
 * at the hover column, `terrain-l5`), then the executor's hold guard re-sampled
 * the SAME column through its own cold cache, got 61 190 m from the level-0
 * planning field, and refused the leg:
 *
 *   "hold at 1849 m AGL is unsafe: the ground at this column is 1790 m above the
 *    catalogue mean radius (61190 m vs 59400 m), leaving 59 m of clearance
 *    (80 m required)"
 *
 * `land_at` was handed 61 156.4 where level-5 reads 61 177.9. On that hillside
 * level-3/4/5 differ by 30-90 m, so two samplers can never agree - the fix is
 * ONE shared column sampler (`ground.ts`) at the finest available level, with
 * the source named in the audit, and the mission's own recorded datum used by
 * the hold guard whenever this tick's sample is coarser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { createMission } from '../src/missions.js';
import { seedWorld } from '../src/demo/world.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import { COME_TO_ME_HOLD_FLOOR_M } from '../src/demo/flight.js';
import { FINE_TERRAIN_LEVEL, FINE_TERRAIN_MIN_LEVEL } from '../src/demo/terrain.js';
import {
  clearGroundCache,
  columnGround,
  groundColumnKey,
  loadColumnGround,
  rememberColumnGround,
} from '../src/demo/ground.js';
import { makeConfig } from './helpers.js';

type Vec3 = { x: number; y: number; z: number };

const NOW = 1_800_000_000_000;
const EARTH = PLANET_CATALOG.find((p) => p.name === 'EarthLike')!;
const CENTRE = EARTH.center;
/** The measured column: level-5 (what the hover was built on) vs level-0. */
const FINE_GROUND_M = 61_162.9;
const COARSE_GROUND_M = 61_190;
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
const fromCentre = (dir: Vec3, radiusM: number): Vec3 => ({
  x: CENTRE.x + dir.x * radiusM,
  y: CENTRE.y + dir.y * radiusM,
  z: CENTRE.z + dir.z * radiusM,
});

function hoverDirection(): Vec3 {
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  return norm(sub({ x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z }, CENTRE));
}

function columnTerrain(radiusAt: (dir: Vec3) => number): TerrainField {
  return {
    planet: EARTH.name,
    planetId: EARTH.id ?? null,
    get status(): 'available' | 'unavailable' {
      return 'available';
    },
    reason: null,
    tiles: 2,
    radiusAt: (dir) => radiusAt(dir),
  };
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

/** A come-to-me mission whose hover block records the datum it was built with. */
function setupComeToMe(opts: { terrain: () => TerrainField; recordedGroundM: number; recordedSource: string }) {
  // Every case starts with a COLD shared cache: that is the state the in-game
  // run was in when the two samplers disagreed.
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
  const hover = fromCentre(dir, opts.recordedGroundM + KEEL + HOVER_AGL);
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
          groundRadiusM: opts.recordedGroundM,
          groundSource: opts.recordedSource,
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
        notes: '[SIMULATED] shared ground-datum test',
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
  // The ship sits over a DIFFERENT column 2 km away, so the slot's own ground
  // is the one under test (the same geometry as the in-game run).
  store.upsertUnit({
    id: GRID,
    name: 'SAT-R-0001',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: clock.now,
    pos: fromCentre(norm({ x: dir.x + 0.03, y: dir.y, z: dir.z }), opts.recordedGroundM + KEEL + HOVER_AGL + 2),
    vel: { x: 0, y: 0, z: 0 },
    meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false, keelDepthM: KEEL },
  });
  return { store, sent, clock, executor, mission, dir };
}

function audit(store: Store, action: string) {
  return store.listAudit(500).filter((row) => row.action === action);
}

const savedTerrain = process.env.RTS_TERRAIN;

beforeAll(() => {
  // The fixture terrain field is the ground truth here; the real :8786 field
  // must never decide a pass or a fail.
  process.env.RTS_TERRAIN = 'off';
});

afterAll(() => {
  if (savedTerrain === undefined) delete process.env.RTS_TERRAIN;
  else process.env.RTS_TERRAIN = savedTerrain;
  clearGroundCache();
});

describe('one shared column sample (2026-11-11)', () => {
  it('gives two readers the same radius for a column, and never lets a coarse read replace a fine one', () => {
    clearGroundCache();
    const dir = hoverDirection();
    const key = groundColumnKey(EARTH, dir);
    expect(columnGround(EARTH, dir), 'a cold column is unknown, not invented').toBeNull();

    // The come-to-me path files its awaited level-5 reading.
    const fine = rememberColumnGround(EARTH, dir, {
      radiusM: FINE_GROUND_M,
      source: `terrain-l${FINE_TERRAIN_LEVEL}`,
      level: FINE_TERRAIN_LEVEL,
    })!;
    // The executor's tick-time reader gets exactly that number, not a second
    // datum from its own cache.
    const readBack = columnGround(EARTH, dir)!;
    expect(readBack.radiusM).toBe(FINE_GROUND_M);
    expect(readBack.source).toBe(`terrain-l${FINE_TERRAIN_LEVEL}`);
    expect(readBack.key).toBe(key);

    // A level-0 fallback for the same column must NOT overwrite it (that is how
    // the 27 m disagreement happened).
    rememberColumnGround(EARTH, dir, { radiusM: COARSE_GROUND_M, source: 'terrain-l0', level: 0 });
    expect(columnGround(EARTH, dir)!.radiusM).toBe(FINE_GROUND_M);

    // A coarser planet/column is a different key.
    const other = norm({ x: dir.x, y: dir.y + 0.01, z: dir.z });
    expect(groundColumnKey(EARTH, other)).not.toBe(key);
    expect(columnGround(EARTH, other)).toBeNull();
  });

  it('never invents a ground radius when no terrain service is available', async () => {
    clearGroundCache();
    const dir = hoverDirection();
    // RTS_TERRAIN=off: fine and planning fields are both unavailable.
    expect(await loadColumnGround(EARTH, dir)).toBeNull();
    expect(columnGround(EARTH, dir)).toBeNull();
    // Once a sample is filed by any reader, both readers agree on it.
    rememberColumnGround(EARTH, dir, { radiusM: FINE_GROUND_M, source: 'terrain-l5', level: 5 });
    expect((await loadColumnGround(EARTH, dir))!.radiusM).toBe(FINE_GROUND_M);
    expect(columnGround(EARTH, dir)!.radiusM).toBe(FINE_GROUND_M);
    expect(FINE_TERRAIN_LEVEL).toBeGreaterThanOrEqual(FINE_TERRAIN_MIN_LEVEL);
  });
});

describe('the hold guard uses the datum the point was built with (2026-11-11)', () => {
  it('does not refuse an 80 m hover because a COARSE sample of the same column reads 27 m higher', () => {
    // The exact measured pair: hover built on 61 162.9 (level-5), the level-0
    // field says 61 190 - which used to leave 59 m and refuse the leg.
    const ctx = setupComeToMe({
      recordedGroundM: FINE_GROUND_M,
      recordedSource: 'terrain-l5',
      terrain: () => columnTerrain(() => COARSE_GROUND_M),
    });
    ctx.executor.tick();
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
    const moves = ctx.sent.filter((m) => m.type === 'order' && m.orderType === 'move');
    expect(moves.length).toBeGreaterThan(0);
  });

  it('still refuses when a FINER, fresher sample finds the ground rose under the hover', () => {
    // A level-5 read for the slot column filed in the shared cache after the
    // point was planned: the terrain really is 47 m higher, so 80 m became 33 m
    // and the leg must be refused with the 80 m come-to-me floor.
    clearGroundCache();
    const ctx = setupComeToMe({
      recordedGroundM: FINE_GROUND_M,
      recordedSource: 'terrain-l5',
      terrain: () => columnTerrain(() => FINE_GROUND_M + 47),
    });
    const slotDir = norm(sub(
      { x: ctx.dir.x * 40, y: ctx.dir.y * 40, z: ctx.dir.z * 40 },
      { x: 0, y: 0, z: 0 },
    ));
    // File the fine sample the executor will read for the slot's own column.
    rememberColumnGround(EARTH, slotDir, {
      radiusM: FINE_GROUND_M + 47,
      source: 'terrain-l5',
      level: 5,
    });
    ctx.executor.tick();
    const refused = audit(ctx.store, 'demo_hold_refused');
    expect(refused).toHaveLength(1);
    const detail = refused[0]!.detail as { reason: string; targetAglM: number; datumSource: string };
    expect(detail.reason).toMatch(new RegExp(`${COME_TO_ME_HOLD_FLOOR_M} m required`));
    expect(detail.targetAglM).toBeLessThan(COME_TO_ME_HOLD_FLOOR_M);
    expect(String(detail.datumSource)).toContain('frame');
  });
});
