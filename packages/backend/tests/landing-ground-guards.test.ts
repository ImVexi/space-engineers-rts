/**
 * Move-to / landing ground-datum guards (2026-11-10).
 *
 * Two bugs, both of which only bit a mission that was NOT a designer mission:
 *
 *   1. `seedsFor()` hard-coded `planet: null` for the `move:` seed, so a
 *      move-to drone (including `land: true`) never knew its planet. Every
 *      ground read then fell back to a catalogue mean of 0 m and the AGL was
 *      measured from the origin, tens of kilometres wrong. The routes did not
 *      carry the planet either.
 *
 *   2. A LANDING flies to the GROUND POINT (`landingSlotFor`), so its slot is
 *      at — or a few metres below, from the terrain height field's column
 *      misfit between the ship and the target — the ground datum at the ship's
 *      own column. The hold-slot guard read that as "waypoint inside terrain"
 *      and held the ship in the air forever instead of landing it.
 *
 * These tests pin: the planet resolves for a move-to mission, the ground frame
 * is the SHIP's column (a real terrain radius, not 0), a refusal sentence never
 * invents a "0 m mean radius" delta, a landing slot at its own ground point is
 * flown without any exemption, and an identical non-landing hold that is
 * genuinely inside its own column's ground is refused with THAT column's
 * numbers.
 *
 * 2026-11-11: the slot's AGL now uses the ground under the SLOT's own column
 * (the come-to-me datum bug: 144 m of column height turned an 88 m clearance
 * into -63 m). The landing's -7 m slot in these fixtures was an artefact of the
 * ship-column datum, so it reads ~0 m now; the underground case is a slot
 * pushed 7 m below the target column instead.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor, gridMoveMission } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { GROUND_CLEARANCE_M, groundSafetyVerdict } from '../src/demo/flight.js';
import { type TerrainField } from '../src/planner/terrainField.js';
import { makeConfig } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('EarthLike')!;
const SURFACE = Number(PLANET.surfaceRadiusM); // 59 400 m, the catalogue mean
/** Measured in game at the SAT-R-0002 column. */
const TRUE_GROUND_M = 61_016.7;
/** The target column reads 7 m LOWER than the ship's; measured in game. */
const TARGET_GROUND_M = TRUE_GROUND_M - 7;
const GRID = 'grid:r2';
const GATE = 'earthlike-hq';

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

/**
 * A terrain field that is 7 m lower on the target column (x = 0) than on the
 * ship's column (+x): the column misfit that made the landing slot look
 * underground.
 */
function columnTerrain(): TerrainField {
  return {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    status: 'available',
    reason: null,
    tiles: 1,
    radiusAt: (dir) => (dir.x > 1e-6 ? TRUE_GROUND_M : TARGET_GROUND_M),
  };
}

/** The ship a few metres to the side of the target column, at this AGL. */
function shipPos(altitudeAglM: number): { x: number; y: number; z: number } {
  const radius = TRUE_GROUND_M + altitudeAglM;
  const x = 7;
  return { x, y: 0, z: Math.sqrt(radius * radius - x * x) };
}

function mission(store: Store, opts: { land: boolean; target: { x: number; y: number; z: number } }) {
  const input = gridMoveMission({ gridId: GRID, target: opts.target, gateNodeId: GATE });
  const desired = input.desiredState as Record<string, unknown>;
  // The route now carries the planet; this mission deliberately does not, so
  // the executor's own fallback (the planet under the target) is what resolves.
  delete desired.planet;
  if (opts.land) desired.land = true;
  const result = createMission(store, input, { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 });
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/**
 * One move-to mission on a fake hub. `slot` overrides the execution slot (the
 * non-landing hold case, which has no `landingSlotFor`), `planet` overrides the
 * drone row's planet column (the bug's `null`).
 */
function setup(opts: { land: boolean; shipAglM: number; slot?: { x: number; y: number; z: number }; planet?: string | null }) {
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
    terrainField: () => columnTerrain(),
  });
  const m = mission(store, { land: opts.land, target: { x: 0, y: 0, z: TARGET_GROUND_M } });
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ [GRID]: 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity, everything it sends is discarded
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = ?,
             pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = ?
       WHERE mission_id = ?`,
    )
    .run(GRID, `existing:${GRID}`, m.id);
  // Only override when the test asks: test 1 reads the planet the EXECUTOR
  // resolved while seeding, so forcing the column would erase the evidence.
  if (opts.planet !== undefined) {
    store.db.prepare(`UPDATE demo_drones SET planet = ? WHERE mission_id = ?`).run(opts.planet, m.id);
  }
  if (opts.slot) {
    store.db.prepare(`UPDATE demo_drones SET exec_slot_json = ? WHERE mission_id = ?`).run(JSON.stringify(opts.slot), m.id);
  }

  store.upsertUnit({
    id: GRID,
    name: 'SAT-R-0002',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: clock.now,
    pos: shipPos(opts.shipAglM),
    vel: { x: 0, y: 0, z: 0 },
    meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
  });
  return { store, config, sent, executor, mission: m, clock };
}

function orders(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order');
}
function moves(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'move');
}
function holds(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'hold');
}
function audit(store: Store, action: string) {
  return store.listAudit(600).filter((row) => row.action === action);
}
function droneRow(store: Store, missionId: string) {
  return store.db.prepare(`SELECT planet, state FROM demo_drones WHERE mission_id = ?`).get(missionId) as {
    planet: string | null;
    state: string;
  };
}

describe('move-to ground datum: the planet and the ship column', () => {
  it('a move-to landing without a planet in desiredState resolves the drone planet and measures the ship column', () => {
    // Deliberately no `desiredState.planet`: exactly what the route used to
    // create, and what the executor has to resolve for itself.
    const ctx = setup({ land: true, shipAglM: 3_000 });

    ctx.executor.tick();

    // 1. The drone row knows its planet instead of `null` forever.
    const row = droneRow(ctx.store, ctx.mission.id);
    expect(row.planet).toBe(PLANET.name);

    // 2. The ground frame is the SHIP's column (61 017 m, not the 0 m mean a
    //    null planet produced) and the AGL is the real 3 000 m.
    const measured = audit(ctx.store, 'demo_descent_measure');
    expect(measured, 'the descent must be measured from a resolved planet').toHaveLength(1);
    const detail = measured[0]!.detail as {
      groundSource?: string;
      groundRadiusM?: number;
      altitudeAglM?: number;
      note?: string;
    };
    expect(detail.groundSource).toBe('terrain');
    expect(detail.groundRadiusM).toBe(Math.round(TRUE_GROUND_M));
    expect(detail.groundRadiusM).not.toBe(0);
    expect(detail.altitudeAglM).toBe(3_000);
    expect(String(detail.note)).toMatch(/terrain height field/);
    // No "descent could not be measured" rejection: that is the old bug's shape.
    expect(audit(ctx.store, 'demo_descent_rejected')).toHaveLength(0);
    expect(row.state).toBe('en_route');
  });
});

describe('groundSafetyVerdict: no invented mean-radius delta', () => {
  it('an unknown (0 m) mean radius gets the plain clearance sentence, never "vs 0 m" or NaN', () => {
    const base = {
      source: 'terrain' as const,
      groundUncertaintyM: 0,
      groundRadiusM: TRUE_GROUND_M,
    };
    for (const surfaceRadiusM of [0, undefined]) {
      const hold = groundSafetyVerdict({ ...base, targetAglM: -20, intent: 'hold', surfaceRadiusM });
      expect(hold.ok).toBe(false);
      expect(hold.requiredAglM).toBe(GROUND_CLEARANCE_M);
      expect(hold.reason).toBe(
        'hold at -20 m AGL is unsafe: only -20 m of clearance above the measured ground (100 m required)',
      );
      expect(String(hold.reason)).not.toMatch(/NaN/);
      expect(String(hold.reason)).not.toMatch(/vs 0 m/);
      expect(String(hold.reason)).not.toMatch(/catalogue mean/);

      const descent = groundSafetyVerdict({ ...base, targetAglM: -20, intent: 'descent', surfaceRadiusM });
      expect(descent.reason).toBe(
        'descent to -20 m AGL is unsafe: only -20 m of clearance above the measured ground (100 m required)',
      );
      expect(String(descent.reason)).not.toMatch(/NaN/);
      expect(String(descent.reason)).not.toMatch(/vs 0 m/);
    }
  });

  it('a real mean radius still says how far the ground is above it', () => {
    const verdict = groundSafetyVerdict({
      targetAglM: -100,
      source: 'terrain',
      groundUncertaintyM: 0,
      intent: 'hold',
      groundRadiusM: TRUE_GROUND_M,
      surfaceRadiusM: SURFACE,
    });
    expect(verdict.reason).toMatch(/the ground at this column is 1617 m above that mean/);
    expect(verdict.reason).toMatch(/61017 m vs 59400 m/);
    expect(verdict.reason).toMatch(/the clearance above the measured ground is -100 m \(100 m required\)/);
  });
});

describe('landing slot at the ground point is not "inside terrain"', () => {
  it('a LANDING whose slot is the ground point is accepted — and LANDS, not a move+hold', () => {
    // 40 m above its own column: below the landing brake drop, so the leg (not
    // a controlled fall) is what is being planned — the in-game case where the
    // ship was held in the air forever.
    //
    // 2026-11-11 flight set 6 (defect c): this used to be "one move + one
    // hold, mission done" — a `land:true` mission that started at/near its slot
    // never landed at all (measured 2f: move + hold in 1.3 s at 9 m AGL). A low
    // landing now enters the landing sequence where it is, so the criterion is
    // that the LANDING started (and nothing was refused), not that a leg flew.
    const ctx = setup({ land: true, shipAglM: 40 });

    ctx.executor.tick();

    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(0);
    expect(droneRow(ctx.store, ctx.mission.id).state).not.toBe('aborted');
    const low = audit(ctx.store, 'demo_landing_low');
    expect(low, 'a land:true mission already below the brake drop still lands').toHaveLength(1);
    const detail = low[0]!.detail as { mechanism: string; altitudeAglM: number };
    expect(detail.altitudeAglM).toBe(40);
    expect(detail.mechanism).toBe('dampener-pulse');

    // The slot is the ground point ON ITS OWN COLUMN (2026-11-11 datum fix):
    // the terrain is 7 m lower at the target than at the ship, and the slot's
    // AGL is now measured with the target column's ground, so it reads ~0 m —
    // not the old -7 m that came from subtracting the SHIP's column. A landing
    // at its own ground point therefore needs no exemption any more, and the
    // acceptance audit (the old workaround) must not fire.
    expect(audit(ctx.store, 'demo_landing_slot_ground')).toHaveLength(0);

    // Not per tick: three more ticks keep the run clean.
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.now += 1_000;
      ctx.executor.tick();
    }
    expect(audit(ctx.store, 'demo_landing_slot_ground')).toHaveLength(0);
    expect(audit(ctx.store, 'demo_hold_refused')).toHaveLength(0);
  });

  it('an identical NON-landing hold 7 m inside the ground at its own column is still refused', () => {
    // Same ship, same columns — but no landing intent and a slot pushed 7 m
    // BELOW the target column's own ground, which is the real "waypoint inside
    // terrain" case. It must be refused with the SLOT column's numbers (61 010
    // m, not the ship's 61 017 m): the refusal sentence has to describe the
    // ground the ship would hit, not the one under the ship. The drone row
    // carries no planet (the pre-fix shape), so the refusal also has to resolve
    // the mean radius itself.
    const ctx = setup({
      land: false,
      shipAglM: 40,
      planet: null,
      slot: { x: 0, y: 0, z: TARGET_GROUND_M - 7 },
    });

    ctx.executor.tick();

    const refused = audit(ctx.store, 'demo_hold_refused');
    expect(refused).toHaveLength(1);
    const reason = String((refused[0]!.detail as { reason?: string }).reason);
    expect(reason).toMatch(/^hold at .* m above the catalogue mean is unsafe/);
    expect(reason).toMatch(/the ground at this column is 1610 m above that mean/);
    expect(reason).toMatch(/61010 m vs 59400 m/);
    expect(reason).not.toMatch(/vs 0 m/);
    expect(reason).not.toMatch(/NaN/);
    expect(moves(ctx.sent)).toHaveLength(0);
    expect(holds(ctx.sent)).toHaveLength(1);
    expect(droneRow(ctx.store, ctx.mission.id).state).toBe('aborted');
    // No landing acceptance on a mission that is not landing.
    expect(audit(ctx.store, 'demo_landing_slot_ground')).toHaveLength(0);
  });
});
