/**
 * T61 passenger rule (backend half).
 *
 * THE BUG: the plugin reported `underControl` for ANY occupied ship controller,
 * so a player sitting in a PASSENGER SEAT made the executor send that ship ZERO
 * orders. The owner wants to ride along.
 *
 * THE RULE THESE TESTS PIN:
 *   - manual silence ONLY for a real pilot (`underControl` from a cockpit that
 *     can control the ship / a Remote Control being driven);
 *   - a passenger-only ship keeps receiving orders, capped at 60 m/s, with the
 *     dampeners never released and no ballistic free-fall descent;
 *   - the compatibility boolean is true only for a pilot;
 *   - a landing/descent with a passenger uses the dampened descent;
 *   - /api/demo/state exposes the crew per node.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { DemoExecutor } from '../src/demo/executor.js';
import { ControlWatch } from '../src/demo/control.js';
import { seedWorld, planetByName } from '../src/demo/world.js';
import { createMission } from '../src/missions.js';
import { createRuntime } from '../src/runtime.js';
import type { TerrainField } from '../src/planner/terrainField.js';
import {
  PASSENGER_SPEED_CAP_MPS,
  capPassengerAccel,
  capPassengerSpeed,
  crewFromControl,
  crewFromMeta,
  describePassengers,
  passengerLimits,
} from '../src/demo/passengers.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';

const NOW = 1_800_000_000_000;
const PLANET = planetByName('EarthLike')!;
const SURFACE = Number(PLANET.surfaceRadiusM);

function makeStore() {
  const config = makeConfig();
  // The operator's cap is 100 m/s; the passenger cap (60) must be the binding one.
  config.demo.speedLimitMps = 100;
  const store = new Store(openDb(':memory:', { memory: true }));
  store.ensureFlags(['demo_execute'] as never, { demo_execute: true } as never);
  return { store, config };
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

function mission(store: Store, slot: { x: number; y: number; z: number }) {
  const result = createMission(
    store,
    {
      type: 'build_deploy',
      priority: 60,
      desiredState: { shipSpec: 'relay-chain-radio', station: 'chain:EarthLike:Moon:radio', formation: 'line', qty: 1 },
      budget: { resources: {}, timeMin: 60, lossLimit: 0 },
      approval: 'approve',
      idempotencyKey: `pax-${Math.random().toString(36).slice(2)}`,
      assignedUnits: [],
      plan: {
        steps: [
          { id: 'validate', kind: 'validate_spec', params: {}, done: false },
          {
            id: 'deploy-0',
            kind: 'print',
            params: { prefab: 'Eradicator_mk.1', role: 'radio-relay', position: slot },
            done: false,
          },
          { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq' }, done: false },
        ],
        notes: '[SIMULATED] passenger-rule test',
      },
    },
    { now: NOW, actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
  );
  if (!result.ok) throw new Error(result.message);
  store.updateMission(result.mission.id, { status: 'approved' }, NOW);
  return result.mission;
}

/** A crew block in the shape the plugin sends. */
function controlBlock(opts: {
  pilot?: { name: string; seat?: string } | null;
  passengers?: { name: string; seat?: string }[];
  aboard?: { name: string }[];
} = {}) {
  const pax = (opts.passengers ?? []).map((p) => ({
    identityId: '144115188075855926',
    name: p.name,
    seat: p.seat ?? 'Passenger Seat 2',
    controllerType: 'MyCockpit',
    subtype: 'PassengerSeatLarge',
    remoteControl: false,
    main: false,
  }));
  const crew = (opts.aboard ?? []).map((p) => ({
    identityId: '144115188075855926',
    name: p.name,
    seat: 'standing',
    controllerType: 'character',
    subtype: '',
    remoteControl: false,
    main: false,
  }));
  return {
    underControl: Boolean(opts.pilot),
    by: opts.pilot?.name ?? null,
    pilot: opts.pilot
      ? {
          identityId: '144115188075855926',
          name: opts.pilot.name,
          seat: opts.pilot.seat ?? 'Cockpit',
          controllerType: 'MyCockpit',
          subtype: 'Cockpit',
          remoteControl: false,
          main: true,
        }
      : null,
    passengers: pax,
    aboard: crew,
    carryingPassengers: pax.length > 0,
    standingAboard: crew.length > 0,
    controllers: [],
  };
}

function placeGrid(store: Store, gridId: string, meta: Record<string, unknown>, now = NOW) {
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  store.upsertUnit({
    id: gridId,
    name: gridId,
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: now,
    pos: { x: hq.position.x + 10_000, y: hq.position.y, z: hq.position.z },
    vel: { x: 0, y: 0, z: 0 },
    meta: { prefab: 'Eradicator_mk.1', massKg: 20_000, fuelFraction: 0.9, powerFraction: 0.9, ...meta },
  });
}

function readyToMove(store: Store, missionId: string, gridId: string, planet = 'EarthLike') {
  store.setKv('demo:identityId', '10000000000000001');
  store.db
    .prepare(
      `UPDATE demo_drones SET state = 'securing', step = 'move', grid_id = ?, planet = ?,
         pending_order = NULL, pending_action = NULL, pending_at = NULL WHERE mission_id = ?`,
    )
    .run(gridId, planet, missionId);
}

function orders(sent: Record<string, unknown>[]) {
  return sent.filter((m) => m.type === 'order');
}
function moves(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => m.orderType === 'move');
}
function actionOf(m: Record<string, unknown>): string | null {
  const params = m.params as Record<string, unknown> | undefined;
  return typeof params?.action === 'string' ? params.action : null;
}
function dampenerOrders(sent: Record<string, unknown>[]) {
  return orders(sent).filter((m) => actionOf(m) === 'set_dampeners');
}
function audits(store: Store, action: string) {
  return store.listAudit(500).filter((row) => row.action === action);
}

/** A long horizontal leg: the ship cruises at the cap, so the cap is visible. */
function horizontalSetup(opts: { meta: Record<string, unknown> }) {
  const { store, config } = makeStore();
  const sent: Record<string, unknown>[] = [];
  const clock = { now: NOW };
  const executor = new DemoExecutor({
    store,
    hub: fakeHub(sent),
    config,
    clock: () => clock.now,
    fixturePath: null,
  });
  const hq = seedWorld(NOW).nodes.find((n) => n.controlSource)!;
  const slot = { x: hq.position.x + 70_000, y: hq.position.y, z: hq.position.z };
  const m = mission(store, slot);
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:r2': 50_000 }));
  executor.sync(NOW);
  executor.tick(); // queued pass caches the test identity; spawn traffic discarded
  sent.length = 0;
  placeGrid(store, 'grid:r2', opts.meta);
  readyToMove(store, m.id, 'grid:r2');
  return { store, config, sent, executor, mission: m, clock };
}

// ---------------------------------------------------------------- pure module

describe('T61 passenger rule: crew parsing and limits', () => {
  it('a seated passenger is not a pilot; a cockpit is', () => {
    const passengerOnly = crewFromControl(controlBlock({ passengers: [{ name: 'owner' }] }))!;
    expect(passengerOnly.underControl).toBe(false);
    expect(passengerOnly.pilot).toBeNull();
    expect(passengerOnly.passengers).toHaveLength(1);
    expect(passengerOnly.carried).toBe(true);

    const piloted = crewFromControl(controlBlock({ pilot: { name: 'owner' } }))!;
    expect(piloted.underControl).toBe(true);
    expect(piloted.pilot?.name).toBe('owner');
  });

  it('the compatibility boolean cannot be true without a pilot', () => {
    // The exact old-plugin payload: occupied seat, no classification.
    const lying = crewFromControl({
      underControl: true,
      by: 'Passenger Seat 2',
      pilot: null,
      passengers: [{ name: 'owner', seat: 'Passenger Seat 2' }],
    });
    expect(lying!.underControl).toBe(false);
  });

  it('limits: 60 m/s, 0.5 g lateral / 1 g vertical, no dampeners off, no free fall', () => {
    const crew = crewFromControl(controlBlock({ passengers: [{ name: 'owner' }] }))!;
    const limits = passengerLimits(crew, 9.81)!;
    expect(limits.speedCapMps).toBe(PASSENGER_SPEED_CAP_MPS);
    expect(limits.lateralAccelMps2).toBeCloseTo(4.905, 3);
    expect(limits.verticalAccelMps2).toBeCloseTo(9.81, 3);
    expect(limits.allowDampenersOff).toBe(false);
    expect(limits.allowFreeFall).toBe(false);
    expect(limits.names[0]).toContain('owner');
    expect(capPassengerSpeed(100, limits)).toBe(60);
    expect(capPassengerAccel(20, false, limits)).toBeCloseTo(4.905, 3);
    expect(capPassengerAccel(20, true, limits)).toBeCloseTo(9.81, 3);
  });

  it('limits: a standing player gets the hard cap', () => {
    const crew = crewFromControl(controlBlock({ aboard: [{ name: 'owner' }] }))!;
    const limits = passengerLimits(crew, 9.81)!;
    expect(limits.standing).toBe(true);
    expect(limits.lateralAccelMps2).toBeCloseTo(2.4525, 3);
    expect(limits.verticalAccelMps2).toBeCloseTo(4.905, 3);
    expect(limits.allowFreeFall).toBe(false);
  });

  it('limits: nobody aboard (or no crew block) = normal profile', () => {
    expect(passengerLimits(crewFromControl(controlBlock())!, 9.81)).toBeNull();
    expect(passengerLimits(null, 9.81)).toBeNull();
    expect(crewFromMeta({})).toBeNull();
  });

  it('reads the crew out of telemetry meta', () => {
    const crew = crewFromMeta({ control: controlBlock({ passengers: [{ name: 'owner', seat: 'Seat A' }] }) })!;
    expect(crew.passengers[0]!.seat).toBe('Seat A');
    expect(describePassengers(passengerLimits(crew, 9.81))).toContain('owner');
  });

  it('ControlWatch: a passenger sample never marks the grid manual; a pilot does', () => {
    const watch = new ControlWatch({ getKv: () => null, setKv: () => {} }, () => NOW);
    const passengerOnly = crewFromControl(controlBlock({ passengers: [{ name: 'owner' }] }))!;
    expect(
      watch.observe('grid:pax', { underControl: passengerOnly.underControl, crew: passengerOnly }, NOW),
    ).toBe(false);
    expect(watch.isManual('grid:pax')).toBe(false);
    expect(watch.crew('grid:pax')?.passengers).toHaveLength(1);

    const piloted = crewFromControl(controlBlock({ pilot: { name: 'owner' } }))!;
    expect(watch.observe('grid:pilot', { underControl: piloted.underControl, crew: piloted }, NOW)).toBe(true);
    expect(watch.isManual('grid:pilot')).toBe(true);
  });
});

// ------------------------------------------------------------------- executor

describe('T61 passenger rule: the executor keeps flying with a passenger aboard', () => {
  it('passenger-only ship receives a move, capped at 60 m/s, dampeners stay on', () => {
    const { store, sent, executor } = horizontalSetup({
      meta: { control: controlBlock({ passengers: [{ name: 'owner' }] }) },
    });

    executor.tick();

    const move = moves(sent);
    expect(move.length, 'the ship must keep receiving orders').toBeGreaterThan(0);
    const speed = Number((move[0]!.params as Record<string, unknown>).speed);
    expect(speed).toBeLessThanOrEqual(PASSENGER_SPEED_CAP_MPS);
    // The same leg without passengers cruises at 100 (asserted below), so this
    // speed is the passenger cap, not the config.
    expect(dampenerOrders(sent).filter((m) => (m.params as Record<string, unknown>).on === false)).toHaveLength(0);
    expect(audits(store, 'demo_passenger_dampeners').length).toBeGreaterThan(0);

    const carrying = audits(store, 'carrying_passengers');
    expect(carrying).toHaveLength(1);
    expect(JSON.stringify(carrying[0]!.detail)).toContain('owner');

    // Once per mission: another tick must not duplicate the audit row.
    sent.length = 0;
    executor.tick();
    expect(audits(store, 'carrying_passengers')).toHaveLength(1);
  });

  it('the same leg without passengers cruises at 100 with the dampeners released', () => {
    const { sent, executor } = horizontalSetup({ meta: { control: controlBlock() } });
    executor.tick();
    const move = moves(sent);
    expect(move.length).toBeGreaterThan(0);
    expect(Number((move[0]!.params as Record<string, unknown>).speed)).toBeGreaterThan(PASSENGER_SPEED_CAP_MPS);
    expect(dampenerOrders(sent).some((m) => (m.params as Record<string, unknown>).on === false)).toBe(true);
  });

  it('a standing player is capped harder than a seated passenger', () => {
    const { sent, executor } = horizontalSetup({
      meta: { control: controlBlock({ aboard: [{ name: 'owner' }] }) },
    });
    executor.tick();
    const move = moves(sent);
    expect(move.length).toBeGreaterThan(0);
    expect(Number((move[0]!.params as Record<string, unknown>).speed)).toBeLessThanOrEqual(PASSENGER_SPEED_CAP_MPS);
  });

  it('a piloted ship still gets zero orders (unchanged manual handoff)', () => {
    const { store, sent, executor, mission: m } = horizontalSetup({
      meta: { control: controlBlock({ pilot: { name: 'owner' } }) },
    });

    executor.tick();

    expect(moves(sent)).toHaveLength(0);
    expect(orders(sent).filter((x) => x.orderType === 'hold' || x.orderType === 'stop')).toHaveLength(0);
    expect(dampenerOrders(sent)).toHaveLength(0);
    const row = store.db.prepare(`SELECT state FROM demo_drones WHERE mission_id = ?`).get(m.id) as { state: string };
    expect(row.state).toBe('manual');
    expect(store.getMission(m.id)!.status).toBe('paused');
    // No passenger audit for a piloted ship: the pilot owns it.
    expect(audits(store, 'carrying_passengers')).toHaveLength(0);
  });
});

// ------------------------------------------------------ dampened descent test

function flatTerrain(radiusM = SURFACE): TerrainField {
  return {
    planet: PLANET.name,
    planetId: PLANET.id ?? null,
    status: 'available',
    reason: null,
    tiles: 1,
    radiusAt: () => radiusM,
  };
}

/** A gravity descent from 5 000 m to 200 m AGL with the crew block given. */
function descentSetup(control: Record<string, unknown>) {
  const { store, config } = makeStore();
  const sent: Record<string, unknown>[] = [];
  const clock = { now: NOW };
  const executor = new DemoExecutor({
    store,
    hub: fakeHub(sent),
    config,
    clock: () => clock.now,
    fixturePath: null,
    terrainField: () => flatTerrain(),
  });
  const m = mission(store, { x: 0, y: 0, z: SURFACE + 200 });
  store.setKv('demo:identityId', '10000000000000001');
  store.setKv('designer:gridRadios', JSON.stringify({ 'grid:r2': 50_000 }));
  executor.sync(NOW);
  executor.tick();
  sent.length = 0;

  store.db
    .prepare(
      `UPDATE demo_drones
         SET state = 'securing', step = 'move', grid_id = 'grid:r2', planet = 'EarthLike',
             exec_slot_json = ?, pending_order = NULL, pending_action = NULL, pending_at = NULL,
             prefab = 'existing:grid:r2'
       WHERE mission_id = ?`,
    )
    .run(JSON.stringify({ x: 0, y: 0, z: SURFACE + 200 }), m.id);

  store.upsertUnit({
    id: 'grid:r2',
    name: 'SAT-R-0002',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: NOW,
    pos: { x: 0, y: 0, z: SURFACE + 5_000 },
    vel: { x: 0, y: 0, z: 0 },
    meta: {
      massKg: 37_609,
      fuelFraction: 0.9,
      powerFraction: 0.9,
      control,
    },
  });
  return { store, config, sent, executor, mission: m, clock };
}

describe('T61 passenger rule: a descent with a passenger is dampened', () => {
  it('refuses the free-fall phase and flies the dampened descent instead', () => {
    const { store, sent, executor, mission: m } = descentSetup(controlBlock({ passengers: [{ name: 'owner' }] }));

    executor.tick();

    expect(orders(sent).filter((m) => actionOf(m) === 'inspect'), 'no lift probe: no fall is planned').toHaveLength(0);
    expect(moves(sent).length, 'the dampened descent is a normal move').toBeGreaterThan(0);
    expect(audits(store, 'demo_descent_passengers')).toHaveLength(1);
    expect(audits(store, 'carrying_passengers')).toHaveLength(1);
    const detail = JSON.stringify(audits(store, 'demo_descent_passengers')[0]!.detail);
    expect(detail).toContain('owner');
    // The move that replaced the fall is the dampened descent: dampeners on and
    // the passenger cap applied.
    const move = moves(sent)[0]!;
    expect(Number((move.params as Record<string, unknown>).speed)).toBeLessThanOrEqual(PASSENGER_SPEED_CAP_MPS);
    const row = store.db.prepare(`SELECT state, reason FROM demo_drones WHERE mission_id = ?`).get(m.id) as {
      state: string;
      reason: string;
    };
    expect(row.state).toBe('en_route');
    expect(row.reason).toContain('dampeners on');
  });

  it('control: an empty hull still starts the measured controlled fall', () => {
    const { sent, executor } = descentSetup(controlBlock());
    executor.tick();
    expect(orders(sent).filter((m) => actionOf(m) === 'inspect').length).toBe(1);
  });
});

// ----------------------------------------------------------------- state route

describe('T61 passenger rule: /api/demo/state per node', () => {
  const saved: Record<string, string | undefined> = {};
  function setDemoEnv() {
    for (const key of ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER']) {
      saved[key] = process.env[key];
    }
    process.env.RTS_DEMO = '1';
    process.env.RTS_ENV = 'test';
    process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
  }
  function restoreEnv() {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  afterEach(() => restoreEnv());

  it('exposes the pilot / passengers / standing players and the limits', async () => {
    setDemoEnv();
    const clock = makeClock();
    const runtime = createRuntime({ config: makeConfig({ port: 0 }), memory: true, clock: clock.now });
    const port = await runtime.listen(0);
    try {
      runtime.store.upsertUnit({
        id: 'grid:pax',
        name: 'PAX-01',
        specId: null,
        station: null,
        linkStatus: 'up',
        lastSeen: clock.now(),
        pos: { x: 10_000, y: 20_000, z: 30_000 },
        vel: null,
        meta: {
          control: controlBlock({ passengers: [{ name: 'owner', seat: 'Passenger Seat 2' }] }),
        },
      });
      clock.advance(2_000);
      const res = await httpRequest<{
        nodes: {
          id: string;
          crew: {
            carrying: boolean;
            standing: boolean;
            underControl: boolean;
            pilot: unknown;
            passengers: { name: string; seat: string }[];
            limits: { speedCapMps: number; allowFreeFall: boolean } | null;
          } | null;
        }[];
      }>(port, 'GET', '/api/demo/state');
      expect(res.status).toBe(200);
      const node = res.body.nodes.find((n) => n.id === 'grid:pax');
      expect(node, 'the grid must appear as a node').toBeTruthy();
      expect(node!.crew!.carrying).toBe(true);
      expect(node!.crew!.standing).toBe(false);
      expect(node!.crew!.underControl).toBe(false);
      expect(node!.crew!.pilot).toBeNull();
      expect(node!.crew!.passengers[0]!.name).toBe('owner');
      expect(node!.crew!.passengers[0]!.seat).toBe('Passenger Seat 2');
      expect(node!.crew!.limits!.speedCapMps).toBe(60);
      expect(node!.crew!.limits!.allowFreeFall).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
