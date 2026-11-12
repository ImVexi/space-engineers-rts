/**
 * Fake-hub driver for one demo mission whose drone lands (owner request,
 * 2026-11-10: "go to XYZ and park", landing on the true ground).
 *
 * The terrain height field is injected through the executor's `terrainField`
 * seam, so "the ground" is a number the test owns (the measured test column is
 * 61 016.7 m above the planet centre, 1 616.7 m above the catalogue mean).
 * Every order the executor sends is recorded; the test acknowledges them the
 * way the fake plugin hub does, and moves the ship with a tiny point-mass
 * model so the executor's own phases (not the test) decide what happens when.
 */
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { unavailableTerrainField, type TerrainField } from '../src/planner/terrainField.js';
import { makeConfig } from './helpers.js';

export const NOW = 1_800_000_000_000;
export const PLANET = planetByName('EarthLike')!;
export const SURFACE = Number(PLANET.surfaceRadiusM); // 59 400 m, the catalogue mean
/** Measured in game at the failing column (SAT-R-0002). */
export const TRUE_GROUND_M = 61_016.7;
export const G = 9.81;

export function terrainAt(radiusM: number | null): TerrainField {
  return terrainProvider(() => radiusM);
}

/**
 * A height field the TEST owns and can change between ticks: the live datum bug
 * (2026-11-11) is about a finer sample arriving mid-descent, which a fixed
 * field can never reproduce.
 */
export function terrainProvider(radiusM: () => number | null, level = 5): TerrainField {
  return {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    get status(): 'available' | 'unavailable' {
      return radiusM() === null ? 'unavailable' : 'available';
    },
    reason: null,
    tiles: 1,
    // The fixture field models a LANDING-GRADE sample (the live bug is about a
    // fine sample arriving mid-descent). A test that wants to model the coarse
    // planning field passes `level: 0`.
    level,
    radiusAt: () => radiusM(),
  };
}

export function fakeHub(sent: Record<string, unknown>[], capabilities: string[] | null = null) {
  return {
    send: (message: unknown) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    isConnected: () => true,
    agentId: () => 'fake-plugin',
    // The hello the deployed plugin sends. `capabilities` decides the
    // final-descent mechanism (`land_controller` -> plugin-land).
    agentInfo: () => ({
      agentId: 'fake-plugin',
      serverId: 'test-server',
      version: '0.1.0',
      capabilities: capabilities ?? ['telemetry', 'orders'],
    }),
  } as never;
}

export interface ShipSpec {
  massKg: number;
  /** Gravity one local `g` above the test column. */
  upThrustN: number;
  label?: string;
}

export interface SetupOptions {
  /** Far above the ground: the far-away slot the ship must reach first. */
  slotRadiusM?: number;
  startRadiusM: number;
  terrainRadiusM: number | null;
  desired: Record<string, unknown>;
  /** Extra plan steps between spawn and `move` (e.g. a land step). */
  steps?: { id: string; kind: string; params: Record<string, unknown> }[];
  ship?: ShipSpec;
  speedLimitMps?: number;
  gridName?: string;
  /**
   * Signed pivot -> lowest hull point along local down, m, as the plugin's
   * telemetry reports it (SAT-R-0001 measured -10: the hull ends 10 m ABOVE the
   * pivot). Omitted = the field the plugin did not have before, i.e. 0.
   */
  keelDepthM?: number;
  /**
   * Capabilities the fake plugin advertises in its hello. `land_controller`
   * switches the final descent to the plugin (`land_at`).
   */
  capabilities?: string[];
  /** Extra unit meta, e.g. the `keelSource` a telemetry message carries. */
  metaExtra?: Record<string, unknown>;
  /**
   * A ground radius the test can CHANGE between ticks (a finer terrain sample
   * arriving mid-descent). Takes precedence over `terrainRadiusM`.
   */
  terrainRadius?: () => number | null;
  /** Tile level the fixture terrain field reports (5 = landing grade, 0 = coarse). */
  terrainLevel?: number;
  /** Mission station; `survival:relaunch:<grid>` exercises the ground-origin rule. */
  station?: string;
  /** Units the mission is assigned (the survival builder reads `assignedUnits[0]`). */
  assignedUnits?: string[];
}

/** One `move` step, ship and slot on the +Z axis from the planet centre. */
export function setup(opts: SetupOptions) {
  const config = makeConfig();
  config.demo.speedLimitMps = opts.speedLimitMps ?? 100;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  const sent: Record<string, unknown>[] = [];
  const clock = { now: NOW };
  const terrain =
    opts.terrainRadius
      ? terrainProvider(opts.terrainRadius, opts.terrainLevel ?? 5)
      : opts.terrainRadiusM === null
        ? unavailableTerrainField(PLANET, 'test: no tiles for this column')
        : terrainAt(opts.terrainRadiusM);
  const executor = new DemoExecutor({
    store,
    hub: fakeHub(sent, opts.capabilities ?? null),
    config,
    clock: () => clock.now,
    fixturePath: null,
    terrainField: () => terrain,
  });
  const station = opts.station ?? 'designer:test';
  const result = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: { shipSpec: 'stand-in-grid', planet: PLANET.name, station, launch: 'orbital', ...opts.desired },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      assignedUnits: opts.assignedUnits ?? [],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: {}, done: false },
          {
            id: 'slot-0',
            kind: 'print',
            params: { prefab: 'existing:grid:land', role: 'relay', position: { x: 0, y: 0, z: opts.slotRadiusM ?? opts.startRadiusM } },
            done: false,
          },
          ...(opts.steps ?? []),
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' } },
        ],
        notes: '[SIMULATED] landing-mode test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(`${result.message}: ${JSON.stringify((result as { issues?: unknown }).issues ?? result)}`);
  const mission = result.mission;
  store.updateMission(mission.id, { status: 'approved' }, NOW);
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:land': 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued tick: caches the identity, everything it sends is discarded
  sent.length = 0;
  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:land', planet = ?, 
             pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:land'
       WHERE mission_id = ?`,
    )
    .run(PLANET.name, mission.id);

  const ship = opts.ship ?? { massKg: 37_609, upThrustN: 982_956 };
  const place = (radius: number, vertical = 0, now = clock.now, lateralM = 0, linkStatus: 'up' | 'down' = 'up', meta: Record<string, unknown> = {}) => {
    store.upsertUnit({
      id: 'grid:land',
      name: opts.gridName ?? 'LAND-01',
      specId: null,
      station: null,
      linkStatus,
      lastSeen: now,
      pos: { x: lateralM, y: 0, z: radius },
      vel: { x: 0, y: 0, z: vertical },
      meta: {
        massKg: ship.massKg,
        fuelFraction: 0.9,
        powerFraction: 0.9,
        underControl: false,
        ...(opts.keelDepthM !== undefined ? { keelDepthM: opts.keelDepthM } : {}),
        ...(opts.metaExtra ?? {}),
        // Per-call telemetry, e.g. the measured attitude rate the set-6 settle
        // waits on (`spinDegS`), which changes between ticks as the gyro damps.
        ...meta,
      },
    });
  };
  place(opts.startRadiusM, 0);
  const droneRow = () =>
    store.db
      .prepare(`SELECT state, reason, step, exec_slot_json, landing_json FROM demo_drones WHERE mission_id = ?`)
      .get(mission.id) as {
      state: string;
      reason: string | null;
      step: string | null;
      exec_slot_json: string;
      landing_json: string | null;
    };
  return { store, config, sent, clock, executor, mission, place, droneRow, terrain };
}

export function orders(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order');
}
export function actionOf(m: Record<string, unknown>): string | null {
  const params = m.params as Record<string, unknown> | undefined;
  return typeof params?.action === 'string' ? params.action : null;
}
export function moves(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'move');
}
/** Every dampener write, as `on`. */
export function dampenerWrites(sent: Record<string, unknown>[]): boolean[] {
  return orders(sent)
    .filter((m) => actionOf(m) === 'set_dampeners')
    .map((m) => (m.params as { on?: boolean }).on === true);
}
/** Every Remote-Control property write. */
export function propWrites(sent: Record<string, unknown>[]): { props?: Record<string, unknown>; filter?: unknown }[] {
  return orders(sent)
    .filter((m) => actionOf(m) === 'set_block_props' && (m.params as { filter?: { type?: unknown } }).filter?.type === 'RemoteControl')
    .map((m) => m.params as { props?: Record<string, unknown>; filter?: unknown });
}
/** Every landing-gear / magnetic-plate property write (the touchdown lock). */
export function gearWrites(sent: Record<string, unknown>[]): { props?: Record<string, unknown>; filter?: unknown }[] {
  return orders(sent)
    .filter((m) => actionOf(m) === 'set_block_props' && Array.isArray((m.params as { filter?: { type?: unknown } }).filter?.type))
    .map((m) => m.params as { props?: Record<string, unknown>; filter?: unknown });
}
export function audit(store: Store, action: string) {
  return store.listAudit(2000).filter((row) => row.action === action);
}

/** Every order's action label. */
export function actionsSent(sent: Record<string, unknown>[]): (string | null)[] {
  return orders(sent).map((m) => actionOf(m));
}

/** Answer the measured-lift inspect the way the fake plugin hub does. */
export function answerInspect(ctx: ReturnType<typeof setup>, upN: number, extra: Record<string, unknown> = {}) {
  const inspect = orders(ctx.sent).find((m) => actionOf(m) === 'inspect' && !(m as { __answered?: boolean }).__answered);
  if (!inspect) return null;
  (inspect as { __answered?: boolean }).__answered = true;
  const result = {
    // The shape the live plugin reports (SAT-R-0002 profile): per-thruster
    // axes are unreliable, `thrustPerDirection.upN` is the measured lift.
    thrusters: Array.from({ length: 8 }, (_, i) => ({
      name: `Thruster ${i}`,
      enabled: true,
      working: true,
      axisWorld: { x: 0, y: 0, z: 0 },
      maxEffectiveThrustN: upN / 8,
    })),
    thrustPerDirection: { upN, upCount: 6 },
    ...extra,
  };
  ctx.store.audit({
    actor: 'plugin',
    action: 'plugin_event',
    subject: 'order_result',
    detail: {
      eventType: 'order_result',
      data: {
        orderId: String(inspect.orderId),
        ok: true,
        result,
      },
    },
    at: ctx.clock.now,
  });
  return String(inspect.orderId);
}

/** The fake hub has no dispatcher: acknowledge every sent order. */
export function ackAll(ctx: ReturnType<typeof setup>) {
  for (const m of ctx.sent) {
    if (m.type !== 'order') continue;
    const id = String(m.orderId);
    const order = ctx.store.getOrder(id);
    if (order && order.status !== 'acked') ctx.store.updateOrder(id, { status: 'acked', ackedAt: ctx.clock.now });
  }
}
