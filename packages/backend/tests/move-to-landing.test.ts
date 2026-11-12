/**
 * POST /api/demo/move-to with a landing or a parking request (owner request,
 * 2026-11-10: "tell it to go to XYZ and park").
 *
 * The website and the API must be able to ask for the same thing the mission
 * schema already understands:
 *
 *   { land: true }                  — land on the ground at the target
 *   { mode: 'land' }                — the same request as a word
 *   { landing: { flareAglM: 120 } } — land with an explicit flare height
 *   { park: true }                  — stop AT the target; land only if it is ground
 *
 * Everything is validated by zod like the rest of the route: unknown words,
 * out-of-range flare heights and land+park together are 400s, not missions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';
import { PLANET_CATALOG } from '../src/planner/planets.js';
import { shipRoles, type RoleHint } from '../src/demo/roles.js';

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
const SURFACE = Number(EARTH.surfaceRadiusM);
const GRID = 'grid:107519913664561774';

interface MoveToResponse {
  request?: 'land' | 'park' | null;
  mission: { id: string; desiredState: Record<string, unknown> };
  gridId: string;
}
interface ErrorResponse {
  error: { code: string; issues?: string[]; message?: string };
}

const clock = makeClock();

async function withRuntime<T>(fn: (ctx: { runtime: Runtime; port: number }) => Promise<T>): Promise<T> {
  const runtime = createRuntime({
    config: makeConfig({ port: 0, flags: { demo_execute: true } }),
    memory: true,
    clock: clock.now,
  });
  const port = await runtime.listen(0);
  runtime.store.upsertUnit({
    id: GRID,
    name: 'SAT-R-0002',
    specId: null,
    station: null,
    linkStatus: 'up',
    lastSeen: clock.now(),
    pos: { x: 0, y: 0, z: SURFACE + 3_000 },
    vel: null,
    meta: { massKg: 37_609, fuelFraction: 0.9, powerFraction: 0.9, underControl: false },
  });
  try {
    return await fn({ runtime, port });
  } finally {
    await runtime.close();
  }
}

function landingRow(runtime: Runtime) {
  return runtime.store.db
    .prepare(`SELECT state, landing_json, exec_slot_json FROM demo_drones WHERE grid_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(GRID) as { state: string; landing_json: string | null; exec_slot_json: string } | undefined;
}

describe('POST /api/demo/move-to landing and park requests', () => {
  beforeAll(() => setDemoEnv());
  afterAll(() => restoreEnv());
  afterEach(() => {
    clock.advance(1_000);
    shipRoles.reset();
  });

  it('accepts land: true and seeds the drone with a landing intent on the ground point', async () => {
    await withRuntime(async ({ runtime, port }) => {
      const res = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        land: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.request).toBe('land');
      expect(res.body.mission.desiredState.land).toBe(true);
      const row = landingRow(runtime);
      expect(row?.landing_json, 'the executor must seed the landing intent').toBeTruthy();
      expect(JSON.parse(row!.landing_json!)).toEqual({ kind: 'land', flareAglM: 40 });
      // A landing flies to the GROUND POINT, not to the point in the air.
      expect(Number(JSON.parse(row!.exec_slot_json).z)).toBeCloseTo(SURFACE, 0);
    });
  });

  it('accepts mode: land / park and an explicit flare height, and records which was asked for', async () => {
    await withRuntime(async ({ runtime, port }) => {
      const byWord = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { planet: EARTH.name, altitudeM: 3_000 },
        ignoreReach: true,
        mode: 'land',
        landing: { flareAglM: 120 },
      });
      expect(byWord.status).toBe(201);
      expect(byWord.body.request).toBe('land');
      expect(byWord.body.mission.desiredState.mode).toBe('land');
      expect(byWord.body.mission.desiredState.landing).toEqual({ flareAglM: 120 });
      expect(JSON.parse(landingRow(runtime)!.landing_json!)).toEqual({ kind: 'land', flareAglM: 120 });

      const park = await httpRequest<MoveToResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        park: true,
      });
      expect(park.status).toBe(201);
      expect(park.body.request).toBe('park');
      expect(park.body.mission.desiredState.park).toBe(true);
      // A park in the air is NOT a landing: the executor says so and seeds no
      // landing intent, so the four landing phases can never run.
      expect(landingRow(runtime)?.landing_json).toBeNull();
      const parkAudit = runtime.store
        .listAudit(500)
        .filter((row) => row.action === 'demo_park')
        .at(-1)!;
      const detail = parkAudit.detail as { decision?: string; reason?: string };
      expect(detail.decision).toBe('hold');
      expect(String(detail.reason)).toMatch(/held in the air at the point instead of landing/);
    });
  });

  it('validates the request like the rest of the route: bad words, bad flare, land+park', async () => {
    await withRuntime(async ({ port }) => {
      const badWord = await httpRequest<ErrorResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        mode: 'landish',
      });
      expect(badWord.status).toBe(400);
      expect(badWord.body.error.code).toBe('invalid');

      const badFlare = await httpRequest<ErrorResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        land: true,
        landing: { flareAglM: 5 },
      });
      expect(badFlare.status).toBe(400);
      expect(badFlare.body.error.code).toBe('invalid');
      expect((badFlare.body.error.issues ?? []).join(' ')).toMatch(/landing\.flareAglM/);

      const both = await httpRequest<ErrorResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        land: true,
        park: true,
      });
      expect(both.status).toBe(400);
      expect(both.body.error.code).toBe('invalid');
      expect((both.body.error.issues ?? []).join(' ')).toMatch(/mutually exclusive/);
    });
  });

  it('reports the request in the dry-run preflight without creating a mission', async () => {
    await withRuntime(async ({ runtime, port }) => {
      const before = runtime.store.listMissions({ status: ['queued', 'approved', 'executing'], limit: 50 }).length;
      const dry = await httpRequest<{ dryRun: boolean; request?: string }>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
        land: true,
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.request).toBe('land');
      expect(runtime.store.listMissions({ status: ['queued', 'approved', 'executing'], limit: 50 }).length).toBe(before);
    });
  });
});

describe('POST /api/demo/move-to dryRun applies the ship-role gate', () => {
  // A dry run answers "may I send this?", so it must give the SAME refusal a
  // real order gives. Before 2026-11-11 it answered 200/ok for a PERSONAL grid
  // without confirmPersonal and only the real call refused.
  beforeAll(() => setDemoEnv());
  afterAll(() => restoreEnv());

  const hint = (role: RoleHint['role']): RoleHint => ({ role, token: `[${role}]`, source: 'block-name', block: 'PB' });
  const note = (runtime: Runtime, role: RoleHint['role']) =>
    shipRoles.noteInGame(runtime.store, [{ gridId: GRID, name: 'SAT-R-0002', hints: [hint(role)] }], clock.now());
  const dryRun = (port: number, extra: Record<string, unknown> = {}) =>
    httpRequest<ErrorResponse & { dryRun?: boolean }>(port, 'POST', '/api/demo/move-to', {
      gridId: GRID,
      target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
      ignoreReach: true,
      dryRun: true,
      ...extra,
    });

  it('PERSONAL without confirmPersonal refuses the dry run like the real order', async () => {
    await withRuntime(async ({ runtime, port }) => {
      note(runtime, 'personal');
      const dry = await dryRun(port);
      expect(dry.status).toBe(409);
      expect(dry.body.error.code).toBe('personal_confirmation_required');
      const real = await httpRequest<ErrorResponse>(port, 'POST', '/api/demo/move-to', {
        gridId: GRID,
        target: { gps: { x: 0, y: 0, z: SURFACE + 3_000 } },
        ignoreReach: true,
      });
      expect(real.status).toBe(409);
      expect(real.body.error.code).toBe('personal_confirmation_required');
      // Same grid + confirmation: the dry run is allowed and says so.
      const confirmed = await dryRun(port, { confirmPersonal: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.dryRun).toBe(true);
    });
  });

  it('OFF and BASE refuse the dry run with their own codes', async () => {
    await withRuntime(async ({ runtime, port }) => {
      note(runtime, 'off');
      const off = await dryRun(port);
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('role_off');
      note(runtime, 'base');
      const base = await dryRun(port);
      expect(base.status).toBe(409);
      expect(base.body.error.code).toBe('role_base');
    });
  });
});
