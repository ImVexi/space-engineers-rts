import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';

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

interface DemoNode {
  id: string;
  reachable: boolean;
  source: string;
  status: string;
  position: { x: number; y: number; z: number };
  telemetry?: {
    speedMps: number;
    ageMs: number;
    moving: boolean;
    fresh: boolean;
    ownership: string | null;
  } | null;
  ports: { used: number; capacity: number };
  gate: { allowed: boolean; source: string } | null;
}

interface DemoState {
  env: { name: string; locked: boolean; productionFallback: boolean };
  nodes: DemoNode[];
  telemetry: {
    gridCount: number;
    movingCount: number;
    freshCount: number;
    staleCount?: number;
    recentCount?: number;
    archivedCount?: number;
    pollMs: number;
  };
  planets: { name: string }[];
  spofs: string[];
  reachability: { reachable: string[]; isolated: string[] };
  graph: { edges: { from: string; to: string; kind: string }[] };
  plugin: { connected: boolean };
  killSwitch: boolean;
  flags: Record<string, boolean>;
  assumptions: { id: string; status: string }[];
  labels: string[];
}

interface Option {
  id: string;
  count: number;
  spacingM: number;
  available: boolean;
  portsOk: boolean;
  linksOk: boolean;
  assumptions: { status: string }[];
  nodes: { id: string; role: string }[];
}

interface Plan {
  options: Option[];
  preferred: string;
  labels: string[];
  hardwareSummary: { radio: string; laser: string };
}

describe('demo environment lock', () => {
  afterEach(() => restoreEnv());

  it('boots without the marker and reports survival mode (T74: the marker is not a boot lock)', async () => {
    setDemoEnv();
    delete process.env.RTS_TEST_SERVER_MARKER;
    // Before T74 this threw. A hosted operator now gets a server that starts and
    // says exactly what it will not do, instead of one that refuses to boot.
    const rt = createRuntime({ config: makeConfig({ port: 0 }), memory: true });
    const port = await rt.listen(0);
    try {
      const res = await httpRequest<{ survivalMode: boolean }>(port, 'GET', '/api/health');
      expect(res.status).toBe(200);
      expect(res.body.survivalMode).toBe(true);
    } finally {
      await rt.close();
    }
  });

  it('refuses RTS_ENV=production even with the marker', () => {
    setDemoEnv();
    process.env.RTS_ENV = 'production';
    expect(() => createRuntime({ config: makeConfig({ port: 0 }), memory: true })).toThrow(/RTS_ENV must be "test"/);
  });

  it('does not mount demo routes when RTS_DEMO is unset', async () => {
    setDemoEnv();
    delete process.env.RTS_DEMO;
    const rt = createRuntime({ config: makeConfig({ port: 0 }), memory: true });
    const port = await rt.listen(0);
    const res = await httpRequest(port, 'GET', '/api/demo/state');
    expect(res.status).toBe(404);
    await rt.close();
  });
});

describe('demo routes (test env locked)', () => {
  let runtime: Runtime;
  let port: number;
  const clock = makeClock();

  beforeAll(async () => {
    setDemoEnv();
    runtime = createRuntime({ config: makeConfig({ port: 0 }), memory: true, clock: clock.now });
    port = await runtime.listen(0);
  });

  afterAll(async () => {
    await runtime.close();
    restoreEnv();
  });

  beforeEach(() => {
    clock.advance(1_000);
  });

  it('GET /api/demo/state exposes planets, nodes, graph, SPOFs and the lock badge', async () => {
    const res = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    expect(res.status).toBe(200);
    expect(res.body.env.name).toContain('TEST SERVER');
    expect(res.body.env.locked).toBe(true);
    expect(res.body.env.productionFallback).toBe(false);
    expect(res.body.planets.map((p) => p.name)).toContain('EarthLike');
    // Built-in fixture nodes are planner stand-ins with no grid in the game:
    // they must not render as if they existed on the map.
    expect(res.body.nodes.map((n) => n.id)).not.toContain('earthlike-hq');
    expect(res.body.nodes.map((n) => n.id)).not.toContain('relay-1');
    expect(res.body.nodes.find((n) => n.id === 'relay-1')).toBeUndefined();
    expect(res.body.spofs).toContain('relay-1');
    expect(res.body.reachability.isolated).toContain('alien-outpost');
    expect(res.body.plugin.connected).toBe(false);
    expect(res.body.killSwitch).toBe(false);
    // Labels stay honest: antenna/position halves may be GAME, range maths is
    // SIMULATED, and the laser model cap is UNVERIFIED.
    expect(res.body.assumptions.every((a) => ['GAME', 'SIMULATED', 'UNVERIFIED'].includes(a.status))).toBe(true);
    expect(res.body.assumptions.some((a) => a.id === 'network' && a.status === 'GAME')).toBe(true);
    expect(res.body.labels).toContain('GAME');
    expect(res.body.graph.edges.some((e) => e.kind === 'laser')).toBe(true);
  });

  it('merges live plugin telemetry positions, speed, age and ownership into state', async () => {
    const seenAt = clock.now();
    runtime.store.upsertUnit({
      id: 'grid:telemetry-1',
      name: 'Informant mk.1',
      specId: null,
      station: null,
      linkStatus: 'up',
      lastSeen: seenAt,
      pos: { x: 1_000, y: 2_000, z: 3_000 },
      vel: { x: 3, y: 4, z: 0 },
      meta: { ownerName: 'the owner' },
    });
    clock.advance(2_500);

    const res = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    expect(res.status).toBe(200);
    const node = res.body.nodes.find((n) => n.id === 'grid:telemetry-1');
    expect(node?.source).toBe('GAME');
    expect(node?.position).toEqual({ x: 1_000, y: 2_000, z: 3_000 });
    expect(node?.telemetry?.speedMps).toBeCloseTo(5, 5);
    expect(node?.telemetry?.moving).toBe(true);
    expect(node?.telemetry?.ageMs).toBe(2_500);
    expect(node?.telemetry?.ownership).toBe('the owner');
    expect(res.body.telemetry.gridCount).toBe(1);
    expect(res.body.telemetry.movingCount).toBe(1);
    expect(res.body.telemetry.pollMs).toBe(2_000);
  });

  it('hides telemetry rows unseen for over 6 h unless ?archived=1 is asked for', async () => {
    const now = clock.now();
    const unit = (id: string, name: string, lastSeen: number) => ({
      id,
      name,
      specId: null,
      station: null,
      linkStatus: 'up' as const,
      lastSeen,
      pos: { x: 10_000, y: 20_000, z: 30_000 },
      vel: null,
      meta: {},
    });
    runtime.store.upsertUnit(unit('grid:archived-1', 'Eradicator mk.1', now - 7 * 60 * 60 * 1000));
    runtime.store.upsertUnit(unit('grid:recent-1', 'SAT-L-0001', now - 2 * 60 * 60 * 1000));
    clock.advance(1_000);

    const live = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    const ids = live.body.nodes.map((n) => n.id);
    expect(ids).not.toContain('grid:archived-1');
    expect(ids).toContain('grid:recent-1');
    expect(live.body.telemetry.archivedCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(live.body.telemetry.recentCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(live.body.telemetry.staleCount ?? 0).toBeGreaterThanOrEqual(live.body.telemetry.archivedCount ?? 0);

    const archived = await httpRequest<DemoState>(port, 'GET', '/api/demo/state?archived=1');
    const archivedIds = archived.body.nodes.map((n) => n.id);
    expect(archivedIds).toContain('grid:archived-1');
    expect(archivedIds).toContain('grid:recent-1');
  });

  it('plan/connect compares radio, laser and mixed with all assumptions labelled', async () => {
    const res = await httpRequest<Plan>(port, 'POST', '/api/demo/plan/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
    });
    expect(res.status).toBe(200);
    const ids = res.body.options.map((o) => o.id);
    expect(ids).toEqual(['radio', 'laser', 'mixed']);
    const [radio, laser, mixed] = res.body.options;
    expect(radio!.count).toBeGreaterThan(laser!.count);
    expect(mixed!.count).toBeGreaterThan(laser!.count);
    expect(mixed!.count).toBeLessThan(radio!.count);
    expect(laser!.count).toBe(Math.max(2, Math.ceil(5_729_000 / 90_000)));
    for (const option of res.body.options) {
      expect(option.linksOk).toBe(true);
      expect(option.portsOk).toBe(true);
      expect(option.assumptions.length).toBeGreaterThan(0);
      expect(option.assumptions.every((a) => a.status === 'UNVERIFIED' || a.status === 'SIMULATED')).toBe(true);
      expect(option.nodes.length).toBe(option.count);
    }
    expect(res.body.options.find((o) => o.id === 'laser')!.nodes.some((n) => n.role === 'laser-bridge')).toBe(true);
    expect(res.body.options.find((o) => o.id === 'mixed')!.nodes.some((n) => n.role === 'radio-relay')).toBe(true);
    expect(res.body.hardwareSummary.laser).toContain('EncounterCitadelStation');
    expect(res.body.labels).toEqual(['SIMULATED', 'UNVERIFIED']);
  });

  it('plan/connect rejects the same planet and unknown planets', async () => {
    const same = await httpRequest(port, 'POST', '/api/demo/plan/connect', { planetA: 'EarthLike', planetB: 'EarthLike' });
    expect(same.status).toBe(400);
    const unknown = await httpRequest(port, 'POST', '/api/demo/plan/connect', { planetA: 'Nope', planetB: 'Alien' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('unknown_planet');
  });

  it('plan/connect honours template overrides and rejects unknown ones', async () => {
    const narrow = await httpRequest<Plan>(port, 'POST', '/api/demo/plan/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
      templates: { radio: 'radio-20km' },
    });
    expect(narrow.status).toBe(200);
    const radio = narrow.body.options.find((o) => o.id === 'radio')!;
    const base = await httpRequest<Plan>(port, 'POST', '/api/demo/plan/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
    });
    expect(radio.count).toBeGreaterThan(base.body.options.find((o) => o.id === 'radio')!.count);
    expect(radio.spacingM).toBe(18_000);

    const wide = await httpRequest<Plan>(port, 'POST', '/api/demo/plan/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
      templates: { laserSpacingM: 180_000 },
    });
    expect(wide.body.options.find((o) => o.id === 'laser')!.count).toBeLessThan(
      base.body.options.find((o) => o.id === 'laser')!.count,
    );

    const unknown = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/plan/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      templates: { radio: 'nope-1km' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('unknown_template');
  });

  it('missions/connect creates one build mission in approval state and never claims execution', async () => {
    const res = await httpRequest<{
      mission: { id: string; type: string; status: string; approval: string; plan: { notes: string } };
      commsGate: { source: string; allowed: boolean };
      execution: { status: string };
      approvalState: { awaitingApproval: boolean };
    }>(port, 'POST', '/api/demo/missions/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
      optionId: 'laser',
    });
    expect(res.status).toBe(201);
    expect(res.body.mission.type).toBe('build_deploy');
    expect(res.body.mission.status).toBe('queued');
    expect(res.body.mission.approval).toBe('approve');
    expect(res.body.mission.plan.notes).toContain('[SIMULATED]');
    expect(res.body.approvalState.awaitingApproval).toBe(true);
    expect(res.body.commsGate.source).toBe('SIMULATED');
    expect(res.body.execution.status).toBe('pending: plugin not connected');

    const list = await httpRequest<{ missions: { id: string; approval: string }[] }>(port, 'GET', '/api/missions?status=queued');
    expect(list.body.missions.some((m) => m.id === res.body.mission.id)).toBe(true);

    const approved = await httpRequest<{ mission: { status: string } }>(
      port,
      'POST',
      `/api/demo/missions/${res.body.mission.id}/approve`,
    );
    expect(approved.status).toBe(200);
    expect(approved.body.mission.status).toBe('approved');
  });

  it('comms gate denies a mission targeting an isolated grid', async () => {
    const res = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/move', {
      gridId: 'alien-outpost',
      pos: { x: 1, y: 2, z: 3 },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('comms_denied');

    const connect = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/missions/connect', {
      planetA: 'Alien',
      planetB: 'EarthLike',
      hardware: 'auto',
      optionId: 'radio',
    });
    expect(connect.status).toBe(403);
  });

  it('move/spawn/expand create missions or proposals without executing', async () => {
    const move = await httpRequest<{ mission: { type: string; assignedUnits: string[] } }>(port, 'POST', '/api/demo/move', {
      gridId: 'relay-2',
      pos: { x: 1_000, y: 2_000, z: 3_000 },
    });
    expect(move.status).toBe(201);
    expect(move.body.mission.type).toBe('move');
    expect(move.body.mission.assignedUnits).toEqual(['relay-2']);

    const spawn = await httpRequest<{ mission: { type: string }; plannedNode: { status: string } }>(port, 'POST', '/api/demo/spawn', {
      prefab: 'EncounterCitadelStation',
      planet: 'EarthLike',
    });
    expect(spawn.status).toBe(201);
    expect(spawn.body.mission.type).toBe('build_deploy');
    expect(spawn.body.plannedNode.status).toBe('planned');

    const state = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    // A queued mission's ghost is not the *selected* plan preview, and old
    // failed missions must not leave planned nodes on the map.
    expect(state.body.nodes.some((n) => n.status === 'planned')).toBe(false);

    const alienSpawn = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/spawn', {
      prefab: 'Eradicator_mk.1',
      planet: 'Alien',
    });
    expect(alienSpawn.status).toBe(403);

    const expand = await httpRequest<{ proposals: unknown[]; wouldExtendReach: boolean }>(port, 'POST', '/api/demo/expand', {
      fromNodeId: 'relay-2',
    });
    expect(expand.status).toBe(200);
    expect(expand.body.proposals).toHaveLength(3);
    expect(expand.body.wouldExtendReach).toBe(true);
  });

  it('what-if on the known graph isolates only relay-2 when relay-1 dies', async () => {
    const res = await httpRequest<{ newlyIsolated: string[]; reachableAfter: string[] }>(port, 'POST', '/api/demo/what-if', {
      nodeId: 'relay-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.newlyIsolated).toEqual(['relay-2']);
    expect(res.body.reachableAfter).not.toContain('relay-1');
  });

  it('kill switch blocks new missions and approvals until turned off', async () => {
    const on = await httpRequest<{ killSwitch: boolean; previous: boolean }>(port, 'POST', '/api/demo/kill', { on: true });
    expect(on.status).toBe(200);
    expect(on.body.killSwitch).toBe(true);

    const blocked = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/missions/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
      optionId: 'radio',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('kill_switch');

    const state = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    expect(state.body.killSwitch).toBe(true);

    const resetBlocked = await httpRequest(port, 'POST', '/api/demo/reset', { snapshot: 'snap-1', confirm: 'RESET' });
    expect(resetBlocked.status).toBe(409);

    const off = await httpRequest<{ killSwitch: boolean }>(port, 'POST', '/api/demo/kill', { on: false });
    expect(off.body.killSwitch).toBe(false);

    const created = await httpRequest<{ mission: { id: string } }>(port, 'POST', '/api/demo/missions/connect', {
      planetA: 'EarthLike',
      planetB: 'Alien',
      hardware: 'auto',
      optionId: 'radio',
    });
    expect(created.status).toBe(201);

    await httpRequest(port, 'POST', '/api/demo/kill', { on: true });
    const approveBlocked = await httpRequest<{ error: { code: string } }>(
      port,
      'POST',
      `/api/demo/missions/${created.body.mission.id}/approve`,
    );
    expect(approveBlocked.status).toBe(409);
    await httpRequest(port, 'POST', '/api/demo/kill', { on: false });
  });

  it('reset requires the typed confirmation and only creates a mission', async () => {
    const bad = await httpRequest<{ error: { code: string } }>(port, 'POST', '/api/demo/reset', {
      snapshot: 'snap-2',
      confirm: 'reset',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('confirm_required');

    const before = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    const ok = await httpRequest<{ mission: { type: string; status: string }; missionOnly: boolean; labels: string[] }>(
      port,
      'POST',
      '/api/demo/reset',
      { snapshot: 'snap-2', confirm: 'RESET' },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.missionOnly).toBe(true);
    expect(ok.body.mission.type).toBe('logistics');
    expect(ok.body.mission.status).toBe('queued');
    expect(ok.body.labels).toContain('SIMULATED');

    const after = await httpRequest<DemoState>(port, 'GET', '/api/demo/state');
    // A reset mission must not mutate the stand-in world.
    expect(after.body.nodes.length).toBe(before.body.nodes.length);
  });

  it('audits every mutating demo action', async () => {
    const res = await httpRequest<{ entries: { action: string; subject: string }[] }>(port, 'GET', '/api/audit');
    const actions = res.body.entries.map((e) => e.action);
    for (const action of ['demo_missions_connect', 'demo_move', 'demo_spawn', 'demo_kill_switch', 'demo_reset_requested', 'demo_approve']) {
      expect(actions).toContain(action);
    }
  });
});
