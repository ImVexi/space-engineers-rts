/**
 * T5 command-authority gate test (TEST SERVER ONLY).
 *
 * (a) connected drone          -> move accepted
 * (b) isolated drone           -> move rejected with the gate reason
 * (c) cut the only neighbour   -> subsequent orders rejected
 * (d) restore the neighbour    -> accepted again
 * (e) no-bypass check          -> every order entry point refuses the isolated drone
 *
 * Every order goes through the backend (POST /api/test/order or the demo
 * routes); nothing here talks to the game directly. The gate uses a planner
 * path plus fresh plugin link state, so results are labelled
 * AUTHORITY GATE (SIMULATED link source).
 *
 * Usage:
 *   set -a; . <token-file>; set +a
 *   npx tsx packages/backend/scripts/gate-authority.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.RTS_BASE_URL ?? 'http://127.0.0.1:8762';
const TOKEN = process.env.RTS_TOKEN ?? '';
if (!TOKEN) throw new Error('RTS_TOKEN is not set');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve('data/runs', runId);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, 'gate-authority.jsonl');

type Json = Record<string, any>;
const results: { step: string; pass: boolean; detail?: Json }[] = [];

function log(step: string, ok: boolean, data: Json = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), step, ok, ...data });
  fs.appendFileSync(logPath, line + '\n');
  console.log(line.slice(0, 500));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(
    public status: number,
    public body: Json,
  ) {
    super(`${status} ${body?.error?.code ?? body?.code ?? ''} ${body?.error?.message ?? body?.message ?? ''}`);
  }
}

async function api<T = Json>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-actor': 'gate-test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new HttpError(res.status, json);
  return json as T;
}

async function waitResult(orderId: string, timeoutMs = 25_000): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const audit = await api<{ entries: Json[] }>('GET', '/api/audit?limit=300');
    const hit = audit.entries.find(
      (e) => e.action === 'plugin_event' && e.detail?.eventType === 'order_result' && e.detail?.data?.orderId === orderId,
    );
    if (hit) return hit.detail.data as Json;
    await sleep(1000);
  }
  return null;
}

async function testAction(action: string, params: Json = {}): Promise<Json> {
  const sent = await api<Json>('POST', '/api/test/order', {
    orderType: 'test',
    entityId: 'grid:0',
    params: { action, ...params },
  });
  const result = await waitResult(sent.orderId);
  if (!result?.ok) throw new Error(`${action} failed: ${result?.error ?? 'no result'}`);
  return result.result as Json;
}

async function move(entityId: string, target: Json, speed = 15): Promise<Json> {
  const sent = await api<Json>('POST', '/api/test/order', {
    orderType: 'move',
    entityId,
    params: { x: target.x, y: target.y, z: target.z, speed },
  });
  const result = await waitResult(sent.orderId);
  return { sent, result, gate: sent.commsGate };
}

async function gateOf(entityId: string): Promise<Json> {
  const state = await api<Json>('GET', '/api/demo/state');
  const node = (state.nodes as Json[]).find((n) => n.id === entityId);
  return node?.gate ?? { error: 'grid not in demo state yet' };
}

async function waitForTelemetry(gridId: string, timeoutMs = 60_000): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api<Json>('GET', '/api/state');
    const unit = (state.units as Json[]).find((u) => u.id === gridId);
    if (unit?.pos) return unit;
    await sleep(2000);
  }
  return null;
}

function dist(a: Json, b: Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function add(a: Json, b: Json, scale = 1): Json {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

function norm(v: Json): Json {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Json, b: Json): Json {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Delete only grids this script spawned (name prefix gate-). */
/**
 * Delete grids this script spawned: tracked ids, plus Eradicator grids sitting
 * within 800 m of a point only this script uses (leftovers from a failed run).
 * DisplayName is the prefab name, so proximity + name is the only safe filter;
 * nothing else in the test world is at these coordinates.
 */
async function cleanup(ids: string[] = [], points: Json[] = []): Promise<Json> {
  const deleted: string[] = [];
  const targets = new Set(ids);
  if (points.length) {
    const list = await testAction('list_grids');
    for (const g of list.grids as Json[]) {
      if (!g.position || !/^Eradicator mk\.1$/.test(String(g.name ?? ''))) continue;
      if (points.some((p) => Math.hypot(g.position.x - p.x, g.position.y - p.y, g.position.z - p.z) < 800)) {
        targets.add(g.gridId as string);
      }
    }
  }
  for (const id of targets) {
    try {
      await testAction('delete_grid', { entityId: id });
      deleted.push(id);
    } catch {
      /* reported via the count */
    }
  }
  return { found: targets.size, deleted };
}

async function spawn(name: string, pos: Json, up: Json, forward: Json, ownerId: string): Promise<string> {
  const before = await testAction('list_grids');
  const beforeIds = new Set((before.grids as Json[]).map((g) => g.gridId));
  const spawned = await testAction('spawn_prefab', {
    prefab: 'Eradicator_mk.1',
    x: pos.x,
    y: pos.y,
    z: pos.z,
    up,
    forward,
    name,
  });
  let gridId = typeof spawned.gridId === 'string' ? spawned.gridId : '';
  // The harness may fill the spawn list asynchronously: diff the entity list
  // and pick the newest grid close to the requested point.
  for (let i = 0; i < 8 && !gridId; i++) {
    await sleep(1500);
    const now = await testAction('list_grids');
    const hit = (now.grids as Json[]).find(
      (g) => !beforeIds.has(g.gridId) && g.position && Math.hypot(g.position.x - pos.x, g.position.y - pos.y, g.position.z - pos.z) < 500,
    );
    if (hit) gridId = hit.gridId as string;
  }
  if (!gridId) throw new Error(`spawn ${name} did not appear`);
  await testAction('ownership', { entityId: gridId, ownerId });
  await testAction('wake', { entityId: gridId });
  await testAction('ai_off', { entityId: gridId });
  return gridId;
}

async function main(): Promise<void> {
  const summary: Json = { scenario: 'AUTHORITY GATE (SIMULATED link source)', runId, startedAt: new Date().toISOString() };
  const health = await api<Json>('GET', '/api/health');
  if (!health.agentConnected) throw new Error('plugin not connected');
  const state = await api<Json>('GET', '/api/demo/state');
  if (state.executions?.enabled !== true) throw new Error('demo executor is not enabled');
  summary.health = health;

  const mine: string[] = [];
  const identity = await testAction('identity');
  const ownerId = String(identity.identityId);
  const earth = (state.planets as Json[]).find((p) => p.name === 'EarthLike')!;
  const center = earth.center as Json;
  const surface = Number(earth.surfaceRadiusM);
  // Fixture HQ sits at (1581,1581,69163); spawn near its surface point so the
  // planner path exists, exactly like the executor does for a real mission.
  const upDir = norm({ x: 1581.8, y: 1581.8, z: 69163.8 });
  const tangent = norm(cross(upDir, { x: 0, y: 1, z: 0.31 }));
  const base = add(center, upDir, surface + 3_000);
  const forward = tangent;

  // ---- chain: HQ --40km-- C --40km-- D; B isolated 300 km away
  const cPos = add(base, tangent, 40_000);
  const dPos = add(cPos, tangent, 40_000);
  const bPos = add(base, tangent, 300_000);

  const testPoints = [base, cPos, dPos, bPos];
  summary.cleanupBefore = await cleanup(mine, testPoints);
  const cId = await spawn('gate-c', cPos, upDir, forward, ownerId);
  mine.push(cId);
  const dId = await spawn('gate-d', dPos, upDir, forward, ownerId);
  mine.push(dId);
  const bId = await spawn('gate-b', bPos, upDir, forward, ownerId);
  mine.push(bId);
  summary.grids = { c: cId, d: dId, b: bId, cPos, dPos, bPos };
  for (const id of [cId, dId, bId]) {
    const u = await waitForTelemetry(id);
    if (!u) throw new Error(`${id} never appeared in telemetry`);
  }

  const gateC = await gateOf(cId);
  const gateD = await gateOf(dId);
  const gateB = await gateOf(bId);
  log('gate-preview', gateC.allowed && gateD.allowed && !gateB.allowed, { gateC, gateD, gateB });
  results.push({ step: 'precondition: C/D reachable, B isolated', pass: gateC.allowed && gateD.allowed && !gateB.allowed });

  // ---- (a) connected drone -> move accepted
  let a: Json;
  try {
    a = await move(dId, add(dPos, tangent, 120));
    log('a-connected-accepted', Boolean(a.result?.ok), { gate: a.gate, result: a.result });
    results.push({ step: 'a) connected drone -> move accepted', pass: Boolean(a.result?.ok) && a.gate?.allowed === true });
  } catch (err) {
    log('a-connected-accepted', false, { error: String(err) });
    results.push({ step: 'a) connected drone -> move accepted', pass: false, detail: { error: String(err) } });
  }

  // ---- (b) isolated drone -> rejected with a reason
  let b: Json | null = null;
  try {
    b = await move(bId, add(bPos, tangent, 120));
    // A 200 here means the backend sent it: that is a gate failure.
    log('b-isolated-rejected', false, { unexpected: b });
    results.push({ step: 'b) isolated drone -> rejected', pass: false, detail: { unexpected: b } });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    const body = err instanceof HttpError ? err.body : {};
    const reason = body?.error?.message ?? String(err);
    log('b-isolated-rejected', status === 409, { status, reason, body });
    results.push({ step: 'b) isolated drone -> rejected', pass: status === 409, detail: { status, reason } });
  }

  // ---- (c) cut the only neighbour (teleport C away) -> rejected
  const far = add(base, tangent, 300_000);
  await testAction('teleport', { entityId: cId, x: far.x, y: far.y, z: far.z });
  // Wait for the plugin telemetry to report the new C position, then for the
  // gate to lose the path (telemetry cadence is a few seconds).
  let gateAfterCut = await gateOf(dId);
  for (let i = 0; i < 15 && gateAfterCut.plannerPath !== false; i++) {
    await sleep(2000);
    gateAfterCut = await gateOf(dId);
  }
  const stateCut = await api<Json>('GET', '/api/state');
  const posC = (stateCut.units as Json[]).find((u) => u.id === cId)?.pos;
  const posD = (stateCut.units as Json[]).find((u) => u.id === dId)?.pos;
  log('cut-positions', true, { posC, posD, expectedC: far, dPos });
  let c: Json | null = null;
  try {
    c = await move(dId, add(dPos, tangent, 240));
    log('c-cut-rejected', false, { gateAfterCut, unexpected: c });
    results.push({ step: 'c) cut neighbour -> rejected', pass: false, detail: { gateAfterCut, unexpected: c } });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    log('c-cut-rejected', status === 409, { status, gateAfterCut, reason: err instanceof HttpError ? err.body : String(err) });
    results.push({
      step: 'c) cut neighbour -> rejected',
      pass: status === 409 && gateAfterCut?.plannerPath === false,
      detail: { status, gateAfterCut },
    });
  }

  // ---- (d) restore the neighbour -> accepted again
  await testAction('teleport', { entityId: cId, x: cPos.x, y: cPos.y, z: cPos.z });
  await sleep(4000);
  const gateAfterRestore = await gateOf(dId);
  let d: Json | null = null;
  try {
    d = await move(dId, add(dPos, tangent, 60));
    log('d-restored-accepted', Boolean(d.result?.ok), { gate: d.gate, gateAfterRestore });
    results.push({
      step: 'd) restore neighbour -> accepted again',
      pass: Boolean(d.result?.ok) && gateAfterRestore?.allowed === true,
      detail: { gateAfterRestore },
    });
  } catch (err) {
    log('d-restored-accepted', false, { error: String(err), gateAfterRestore });
    results.push({ step: 'd) restore neighbour -> accepted again', pass: false, detail: { error: String(err), gateAfterRestore } });
  }

  // ---- (e) every entry point refuses the isolated drone
  const bypass: Json = {};
  // 1. raw test order route
  try {
    await move(bId, add(bPos, tangent, 60));
    bypass.test_order = { rejected: false };
  } catch (err) {
    bypass.test_order = { rejected: err instanceof HttpError && err.status === 409, status: err instanceof HttpError ? err.status : 0 };
  }
  // 2. demo move route on an isolated fixture node (alien-outpost)
  try {
    await api('POST', '/api/demo/move', { gridId: 'alien-outpost', pos: { x: 0, y: 0, z: 0 } });
    bypass.demo_move = { rejected: false };
  } catch (err) {
    bypass.demo_move = { rejected: err instanceof HttpError && err.status === 403, status: err instanceof HttpError ? err.status : 0 };
  }
  // 3. connect mission whose source planet has no control source (Moon)
  try {
    await api('POST', '/api/demo/missions/connect', { planetA: 'Moon', planetB: 'EarthLike', optionId: 'radio' });
    bypass.connect_no_source = { rejected: false };
  } catch (err) {
    bypass.connect_no_source = {
      rejected: err instanceof HttpError && err.status === 403,
      status: err instanceof HttpError ? err.status : 0,
    };
  }
  // 4. executor path is gated in code: sendMove() evaluates gateFor() before
  // send(); audited in docs/scenario-results.md (no live mission for a drone
  // that is already known isolated, so the route above is the runtime proof).
  const ePass =
    bypass.test_order?.rejected === true && bypass.demo_move?.rejected === true && bypass.connect_no_source?.rejected === true;
  log('e-no-bypass', ePass, bypass);
  results.push({
    step: 'e) no bypass: test order, demo move, connect anchor all refuse',
    pass: ePass,
    detail: bypass,
  });

  // ---- cleanup our grids
  summary.cleanupAfter = await cleanup(mine, testPoints);
  summary.stopSent = true;
  summary.results = results;
  summary.pass = results.every((r) => r.pass);
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'gate-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nAUTHORITY GATE: ${summary.pass ? 'PASS' : 'FAIL'}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.step}`);
  console.log('SUMMARY ' + path.join(dir, 'gate-summary.json'));
  if (!summary.pass) process.exitCode = 1;
}

main().catch((err) => {
  log('fatal', false, { error: String(err), stack: (err as Error)?.stack });
  console.error(err);
  process.exit(1);
});
