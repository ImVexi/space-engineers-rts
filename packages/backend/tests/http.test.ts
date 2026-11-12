import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, missionInput, httpRequest } from './helpers.js';

const PORT = 8767;
const AUTH_PORT = 8769;

describe('HTTP API', () => {
  let clock: ReturnType<typeof makeClock>;
  let runtime: Runtime;

  beforeAll(async () => {
    clock = makeClock();
    runtime = createRuntime({ config: makeConfig({ port: PORT }), clock: clock.now });
    await runtime.listen(PORT);
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('GET /api/health', async () => {
    const res = await httpRequest<{ ok: boolean; killSwitch: boolean }>(PORT, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.killSwitch).toBe(false);
  });

  it('POST /api/missions validates and defaults to approve/queued', async () => {
    const bad = await httpRequest(PORT, 'POST', '/api/missions', { type: 'nope' });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { issues: string[] } }).error.issues.length).toBeGreaterThan(0);

    const ok = await httpRequest<{ mission: { id: string; approval: string; status: string } }>(
      PORT,
      'POST',
      '/api/missions',
      missionInput({ idempotencyKey: 'api-1' }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.mission.approval).toBe('approve');
    expect(ok.body.mission.status).toBe('queued');

    const dup = await httpRequest<{ created: boolean }>(PORT, 'POST', '/api/missions', missionInput({ idempotencyKey: 'api-1' }));
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
  });

  it('GET /api/approvals lists only missions awaiting approval', async () => {
    const res = await httpRequest<{ approvals: { id: string; status: string }[] }>(PORT, 'GET', '/api/approvals');
    expect(res.status).toBe(200);
    expect(res.body.approvals.length).toBeGreaterThan(0);
    for (const mission of res.body.approvals) expect(mission.status).toBe('queued');

    const list = await httpRequest<{ missions: { id: string }[] }>(PORT, 'GET', '/api/missions?status=queued');
    expect(list.body.missions.length).toBe(res.body.approvals.length);
  });

  it('PATCH approve then reject a second approval and allow cancel', async () => {
    const created = await httpRequest<{ mission: { id: string } }>(
      PORT,
      'POST',
      '/api/missions',
      missionInput({ idempotencyKey: 'api-patch' }),
    );
    const id = created.body.mission.id;

    const approved = await httpRequest<{ mission: { status: string } }>(PORT, 'PATCH', `/api/missions/${id}`, {
      action: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.mission.status).toBe('approved');

    const again = await httpRequest(PORT, 'PATCH', `/api/missions/${id}`, { action: 'approve' });
    expect(again.status).toBe(409);

    const cancelled = await httpRequest<{ mission: { status: string } }>(PORT, 'PATCH', `/api/missions/${id}`, {
      action: 'cancel',
    });
    expect(cancelled.body.mission.status).toBe('cancelled');
  });

  it('PATCH rejects unknown missions and bad bodies', async () => {
    expect((await httpRequest(PORT, 'PATCH', '/api/missions/missing', { action: 'approve' })).status).toBe(404);
    expect((await httpRequest(PORT, 'PATCH', '/api/missions/x', { note: 'nothing' })).status).toBe(400);
  });

  it('GET /api/state, /api/ledger and /api/audit', async () => {
    const state = await httpRequest<{ flags: Record<string, boolean>; missions: { counts: Record<string, number> } }>(
      PORT,
      'GET',
      '/api/state',
    );
    expect(state.status).toBe(200);
    expect(state.body.flags.dispatch).toBe(false);
    expect(state.body.missions.counts).toBeTypeOf('object');

    const ledger = await httpRequest<{ entries: unknown[] }>(PORT, 'GET', '/api/ledger');
    expect(ledger.status).toBe(200);
    expect(Array.isArray(ledger.body.entries)).toBe(true);

    const audit = await httpRequest<{ entries: { action: string }[] }>(PORT, 'GET', '/api/audit');
    expect(audit.body.entries.some((e) => e.action === 'mission_created')).toBe(true);
  });

  it('POST /api/desired feeds the reconciler', async () => {
    const res = await httpRequest<{ desired: { id: string } }>(PORT, 'POST', '/api/desired', {
      id: 'orbit-A-sats',
      spec: 'sat-relay-mk1',
      station: 'orbit-A',
      count: 1,
      formation: 'ring',
    });
    expect(res.status).toBe(200);
    expect(runtime.store.listDesired().map((d) => d.id)).toContain('orbit-A-sats');
  });

  it('flag and kill-switch admin routes are audited', async () => {
    const flag = await httpRequest<{ flags: Record<string, boolean> }>(PORT, 'POST', '/api/admin/flags/reconciler', {
      enabled: true,
    });
    expect(flag.body.flags.reconciler).toBe(true);
    expect(runtime.store.countAudit('flag_set')).toBe(1);

    const kill = await httpRequest<{ killSwitch: boolean }>(PORT, 'POST', '/api/admin/kill-switch', { on: true });
    expect(kill.body.killSwitch).toBe(true);
    const health = await httpRequest<{ killSwitch: boolean }>(PORT, 'GET', '/api/health');
    expect(health.body.killSwitch).toBe(true);
    await httpRequest(PORT, 'POST', '/api/admin/kill-switch', { on: false });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await httpRequest<{ error: { code: string } }>(PORT, 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('GET /api/handoff/candidates returns an empty report when no save exists', async () => {
    const res = await httpRequest<{ candidates: unknown[]; error?: string }>(PORT, 'GET', '/api/handoff/candidates');
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.error).toContain('save file not found');
  });

  it('planning routes are GET-only for reads and pure POSTs for computation', async () => {
    const planets = await httpRequest<{ planets: { name: string }[] }>(PORT, 'GET', '/api/plan/planets');
    expect(planets.status).toBe(200);
    expect(planets.body.planets.length).toBe(6);

    const config = await httpRequest<{ linkModel: { spacingSafetyFactor: number } }>(PORT, 'GET', '/api/plan/config');
    expect(config.status).toBe(200);
    expect(config.body.linkModel.spacingSafetyFactor).toBe(0.9);

    const chain = await httpRequest<{ count: number; maxGapM: number; spacingM: number }>(PORT, 'POST', '/api/plan/chain', {
      from: 'EarthLike',
      to: 'Alien',
      templateId: 'radio-50km',
    });
    expect(chain.status).toBe(200);
    expect(chain.body.count).toBeGreaterThan(100);
    expect(chain.body.maxGapM).toBeLessThanOrEqual(chain.body.spacingM);

    const bad = await httpRequest(PORT, 'POST', '/api/plan/chain', { from: 'Nope', to: 'Alien' });
    expect(bad.status).toBe(400);

    const nodes = [
      { id: 'a', position: { x: 0, y: 0, z: 0 }, radioRadiusM: 60, controlSource: true },
      { id: 'b', position: { x: 50, y: 0, z: 0 }, radioRadiusM: 60 },
      { id: 'c', position: { x: 100, y: 0, z: 0 }, radioRadiusM: 60 },
    ];
    const graph = await httpRequest<{ articulationPoints: string[] }>(PORT, 'POST', '/api/plan/graph', { nodes });
    expect(graph.status).toBe(200);
    expect(graph.body.articulationPoints).toEqual(['b']);

    const whatIf = await httpRequest<{ newlyIsolated: string[] }>(PORT, 'POST', '/api/plan/what-if', { nodes, nodeId: 'b' });
    expect(whatIf.status).toBe(200);
    expect(whatIf.body.newlyIsolated).toEqual(['c']);

    const coverage = await httpRequest<{ count: number; uncoveredSamples: number }>(PORT, 'POST', '/api/plan/coverage', {
      planet: 'EarthLike',
      templateId: 'radio-50km',
      k: 1,
    });
    expect(coverage.status).toBe(200);
    expect(coverage.body.count).toBeGreaterThan(0);
    expect(coverage.body.uncoveredSamples).toBe(0);
  });
});

describe('authentication when a token is configured', () => {
  const TOKEN = 'bearer-token-1234567890';
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = createRuntime({ config: makeConfig({ port: AUTH_PORT, token: TOKEN }) });
    await runtime.listen(AUTH_PORT);
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('rejects every API route without a bearer token', async () => {
    for (const route of ['/api/health', '/api/state', '/api/missions', '/api/ledger']) {
      const res = await httpRequest(AUTH_PORT, 'GET', route);
      expect(res.status, route).toBe(401);
    }
  });

  it('accepts the bearer token', async () => {
    const res = await httpRequest<{ ok: boolean }>(AUTH_PORT, 'GET', '/api/health', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts a token query parameter for read-only GETs', async () => {
    const res = await httpRequest<{ ok: boolean }>(AUTH_PORT, 'GET', `/api/health?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });
});
