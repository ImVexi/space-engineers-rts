/**
 * T4a scenario runner (TEST SERVER ONLY).
 *
 * Everything it does goes through the backend's /api/test/order path, which
 * gates move/stop/hold orders on the comms graph. Every request, response,
 * telemetry sample and verdict is appended to a JSONL run log.
 *
 * Scenario 1: one NPC stand-in drone moves 2 km, holds, then moves 10 km and
 * holds, with built-in AI off, ownership applied and no self-motion.
 *
 * Usage:
 *   set -a; . <token-file>; set +a
 *   npx tsx packages/backend/scripts/run-t4a.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.RTS_BASE_URL ?? 'http://127.0.0.1:8762';
const TOKEN = process.env.RTS_TOKEN ?? '';
if (!TOKEN) throw new Error('RTS_TOKEN is not set');

const SCENARIO = 'T4a-scenario1';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve('data/runs', runId);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, 'scenario1.jsonl');
const summaryPath = path.join(dir, 'summary.json');

type Json = Record<string, any>;

function log(step: string, ok: boolean, data: Json = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), scenarioId: SCENARIO, step, ok, ...data });
  fs.appendFileSync(logPath, line + '\n');
  console.log(line.slice(0, 400));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(`${method} ${p} -> ${res.status} ${json.code ?? ''} ${json.message ?? ''}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

async function waitForResult(orderId: string, timeoutMs = 25_000): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const audit = await api<{ entries: Json[] }>('GET', '/api/audit?limit=400');
    const hit = audit.entries.find(
      (e) =>
        e.action === 'plugin_event' &&
        e.detail?.eventType === 'order_result' &&
        e.detail?.data?.orderId === orderId,
    );
    if (hit) return hit.detail.data as Json;
    await sleep(1200);
  }
  return null;
}

async function order(orderType: string, entityId: string, params: Json, step: string): Promise<Json> {
  const gate = await api('GET', `/api/test/gate?entityId=${encodeURIComponent(entityId)}`);
  const sent = await api('POST', '/api/test/order', { orderType, entityId, params });
  log(step, true, { phase: 'sent', orderId: sent.orderId, orderType, entityId, params, gate, labels: sent.labels });
  const result = await waitForResult(sent.orderId);
  const ok = Boolean(result?.ok);
  log(step, ok, { phase: 'result', orderId: sent.orderId, result });
  if (!ok) throw new Error(`${step} failed: ${result?.error ?? 'no ack/result received'}`);
  return result!;
}

async function test(action: string, params: Json, step: string): Promise<Json> {
  const result = await order('test', 'grid:0', { action, ...params }, step);
  return result.result as Json;
}

async function unit(gridId: string): Promise<Json | null> {
  const state = await api<{ units: Json[] }>('GET', '/api/state');
  return state.units.find((u) => u.id === gridId) ?? null;
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

async function waitArrival(gridId: string, target: Json, tolerance: number, timeoutMs: number): Promise<Json> {
  const start = Date.now();
  let last: Json | null = null;
  let samples: Json[] = [];
  while (Date.now() - start < timeoutMs) {
    const u = await unit(gridId);
    if (u?.pos) {
      last = u;
      const d = dist(u.pos, target);
      samples.push({ t: Date.now(), pos: u.pos, dist: d, vel: u.vel });
      if (d <= tolerance) return { arrived: true, distance: d, elapsedMs: Date.now() - start, unit: u, samples: samples.slice(-6) };
    }
    await sleep(3000);
  }
  return { arrived: false, distance: last?.pos ? dist(last.pos, target) : null, elapsedMs: Date.now() - start, unit: last, samples: samples.slice(-6) };
}

async function observeHold(gridId: string, seconds: number): Promise<Json> {
  const samples: Json[] = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const u = await unit(gridId);
    if (u?.pos) samples.push({ t: Date.now(), pos: u.pos, vel: u.vel });
    await sleep(5000);
  }
  if (samples.length < 2) return { samples: samples.length, driftM: null };
  const first = samples[0]!.pos;
  const drifts = samples.map((s) => dist(s.pos, first));
  return {
    samples: samples.length,
    driftM: Math.max(...drifts),
    maxSpeed: Math.max(...samples.map((s) => Math.hypot(s.vel?.x ?? 0, s.vel?.y ?? 0, s.vel?.z ?? 0))),
    first: samples[0],
    last: samples[samples.length - 1],
  };
}

async function spawnPrefab(prefab: string, pos: Json, up: Json, forward: Json, label: string): Promise<{ gridId: string; spawn: Json; detail: Json }> {
  const before = await test('list_grids', {}, `${label}-list-before`);
  const beforeIds = new Set<string>((before.grids as Json[]).map((g) => g.gridId));
  // SpawnPrefab fills its result list asynchronously, so the order result is
  // not evidence of a grid. Poll the entity list and diff instead.
  const spawn = await test('spawn_prefab', { prefab, x: pos.x, y: pos.y, z: pos.z, forward, up }, `${label}-spawn`);
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const now = await test('list_grids', {}, `${label}-list-after`);
    const fresh = (now.grids as Json[]).filter((g) => !beforeIds.has(g.gridId));
    if (fresh.length > 0) {
      log(label, true, { phase: 'spawned', prefab, grid: fresh[0], freshCount: fresh.length, spawnOrderResult: spawn });
      return { gridId: fresh[0]!.gridId as string, spawn: { order: spawn, fresh }, detail: fresh[0] as Json };
    }
  }
  throw new Error(`${label}: ${prefab} did not appear in the entity list within 18 s`);
}

/** Remove stand-in grids left behind by earlier failed runs (test server only). */
async function cleanupStandIns(): Promise<Json> {
  const list = await test('list_grids', {}, 'cleanup-list');
  const stale = (list.grids as Json[]).filter(
    (g) => /^(Informant|Constructor|Eradicator) mk\.1$/.test(String(g.name ?? '')),
  );
  const deleted: string[] = [];
  for (const g of stale) {
    try {
      await test('delete_grid', { entityId: g.gridId }, 'cleanup-delete');
      deleted.push(g.gridId as string);
    } catch (err) {
      log('cleanup-delete', false, { gridId: g.gridId, error: String(err) });
    }
  }
  log('cleanup', true, { found: stale.map((g) => g.gridId), deleted });
  return { found: stale.length, deleted };
}

async function main(): Promise<void> {
  const summary: Json = { scenarioId: SCENARIO, runId, startedAt: new Date().toISOString(), steps: {} };

  // ---------------------------------------------------------------- preflight
  const health = await api('GET', '/api/health');
  const state = await api('GET', '/api/state');
  log('preflight', true, { health, agent: state.agent, flags: health.flags });
  if (!health.agentConnected) throw new Error('plugin is not connected');
  const caps: string[] = state.agent?.capabilities ?? [];
  if (!caps.includes('command_execution') || !caps.includes('test_api')) {
    throw new Error(`plugin did not advertise the write capabilities: ${caps.join(',')}`);
  }
  summary.agent = state.agent;

  summary.cleanup = await cleanupStandIns();

  const planets = await api<{ planets: Json[] }>('GET', '/api/plan/planets');
  const earth = planets.planets.find((p) => p.name === 'EarthLike');
  if (!earth) throw new Error('EarthLike not in planet catalog');
  summary.planets = { EarthLike: earth };

  const identity = await test('identity', {}, 'identity');
  summary.identity = identity;

  const up = norm({ x: 0.94, y: 0.21, z: 0.27 });
  const tangent = norm(cross(up, { x: 0, y: 1, z: 0 }));
  const surfaceRadius = earth.surfaceRadiusM as number;

  // ------------------------------------------------- Part A, drone 1 (space)
  // Gravity-free spawn: at surfaceRadius+12 km both stand-ins fell to the
  // surface (measured 2026-11-09), which measures the hull's hover margin, not
  // the control path. Scenario 1 asserts "moves to XYZ and holds".
  const spacePos = add(earth.center, up, surfaceRadius + 200_000);
  const spawn1 = await spawnPrefab('Eradicator_mk.1', spacePos, up, tangent, 'eradica');
  const drone1 = spawn1.gridId;
  summary.drone1 = { gridId: drone1, spawn: spawn1.spawn, grid: spawn1.detail };

  // Physics state right after spawn, then an explicit wake, then the state
  // again: a frozen body is the difference between "ordered" and "flying".
  const diagSpawn = await test('diag', { entityId: drone1 }, 'diag-spawn');
  const inspectSpawn = await test('inspect', { entityId: drone1 }, 'inspect-spawn');
  const physWake = await test('physics_wake', { entityId: drone1 }, 'physics-wake');
  await sleep(2000);
  const diagAfterWake = await test('diag', { entityId: drone1 }, 'diag-after-wake');

  const own1 = await test('ownership', { entityId: drone1, ownerId: identity.identityId }, 'ownership-informant');
  await sleep(3000);
  const own1check = await test('ownership_check', { entityId: drone1, ownerId: identity.identityId }, 'ownership-check-informant');
  const owned = Boolean(own1check.applied);
  log('ownership', owned, { applied: own1check.applied, matching: own1check.blocksMatchingOwner, terminal: own1check.terminalBlocks, nonMatching: own1check.nonMatching });

  const wake1 = await test('wake', { entityId: drone1 }, 'wake-informant');
  const ai1 = await test('ai_off', { entityId: drone1 }, 'ai-off-informant');
  // Built-in AI off is only proven by observation: 60 s, no displacement.
  const selfMotion = await observeHold(drone1, 60);
  const aiOk = ai1.stillAutopilot === 0 && ai1.stillAiEnabled === 0;
  const noSelfMotion = selfMotion.driftM !== null && selfMotion.driftM < 25 && (selfMotion.maxSpeed ?? 99) < 1;
  log('ai-off', aiOk && noSelfMotion, { ai: ai1, selfMotion, criteria: { driftM: 25, maxSpeed: 1 } });

  const prof1 = await test('profile', { entityId: drone1 }, 'profile-informant');
  const despawn1 = await test('despawn_state', { entityId: drone1 }, 'despawn-state-informant');
  summary.drone1 = { ...summary.drone1, diagSpawn, inspectSpawn, physWake, diagAfterWake, ownership: own1, ownershipCheck: own1check, wake: wake1, ai: ai1, selfMotion, profile: prof1, despawn: despawn1 };

  // ------------------------------------------- Part A, drone 2 (ground launch)
  // Local terrain differs from the catalog's mean surface radius, so probe a
  // few sites and spawn 50 m above the first solid hit (no ocean/void hits).
  const probeDirs = [up, norm({ x: 0.3, y: 0.62, z: -0.72 }), norm({ x: -0.8, y: 0.38, z: 0.46 })];
  let probe: Json = { hit: false };
  for (const dir of probeDirs) {
    const from = add(earth.center, dir, surfaceRadius + 800);
    const attempt = await test(
      'probe_ground',
      { x: from.x, y: from.y, z: from.z, direction: { x: -dir.x, y: -dir.y, z: -dir.z }, length: 6000 },
      'probe-ground',
    );
    log('probe-ground', Boolean(attempt.hit), { phase: 'attempt', dir, attempt });
    if (attempt.hit) {
      probe = attempt;
      break;
    }
  }
  summary.groundProbe = probe;
  let drone2: string | null = null;
  let own2: Json | null = null;
  let ai2: Json | null = null;
  let prof2: Json | null = null;
  let wake2: Json | null = null;
  if (probe.hit) {
    const padUp = norm(probe.normal);
    const padPos = add(probe.position, padUp, 50);
    try {
      const spawn2 = await spawnPrefab('Constructor_mk.1', padPos, padUp, tangent, 'constructor');
      drone2 = spawn2.gridId;
      await test('physics_wake', { entityId: drone2 }, 'physics-wake-constructor');
      own2 = await test('ownership', { entityId: drone2, ownerId: identity.identityId }, 'ownership-constructor');
      wake2 = await test('wake', { entityId: drone2 }, 'wake-constructor');
      ai2 = await test('ai_off', { entityId: drone2 }, 'ai-off-constructor');
      prof2 = await test('profile', { entityId: drone2 }, 'profile-constructor');
    } catch (err) {
      log('spawn-constructor', false, { error: String(err) });
      drone2 = null;
    }
  }
  summary.drone2 = { gridId: drone2, ownership: own2, wake: wake2, ai: ai2, profile: prof2 };

  // ---------------------------------------------------- Scenario 1: leg 1 (2 km)
  const before1 = await unit(drone1);
  const leg1Target = add(spacePos, up, 2000);
  log('leg1', true, { phase: 'target', target: leg1Target, before: before1?.meta, pos: before1?.pos });
  await order('move', drone1, { x: leg1Target.x, y: leg1Target.y, z: leg1Target.z, speed: 40 }, 'leg1-move');
  const diagMove1 = await test('diag', { entityId: drone1 }, 'diag-after-move-leg1');
  const inspectMove1 = await test('inspect', { entityId: drone1 }, 'inspect-after-move-leg1');
  const arr1 = await waitArrival(drone1, leg1Target, 50, 240_000);
  log('leg1', Boolean(arr1.arrived), { phase: 'arrival', ...arr1, diag: diagMove1, inspect: inspectMove1 });
  // "moves to XYZ and holds" is an order, not free drift: re-anchor the
  // waypoint at the arrival position and verify the grid stays there.
  let holdOrder1: Json | null = null;
  if (arr1.arrived && arr1.unit?.pos) {
    holdOrder1 = await order('hold', drone1, { ...arr1.unit.pos, speed: 5 }, 'leg1-hold');
  }
  const hold1 = await observeHold(drone1, 60);
  const hold1Pass = arr1.arrived && hold1.driftM !== null && hold1.driftM < 25;
  log('leg1', hold1Pass, { phase: 'hold', hold: hold1, criteria: { arrivalM: 50, driftM: 25 } });

  // ------------------------------------------- Scenario 1: leg 2 (10 km tangent)
  const before2 = await unit(drone1);
  const leg2Target = add(leg1Target, tangent, 10_000);
  log('leg2', true, { phase: 'target', target: leg2Target, before: before2?.meta, pos: before2?.pos });
  let arr2: Json = { arrived: false, error: 'not attempted' };
  let diagMove2: Json | null = null;
  try {
    await order('move', drone1, { x: leg2Target.x, y: leg2Target.y, z: leg2Target.z, speed: 60 }, 'leg2-move');
    diagMove2 = await test('diag', { entityId: drone1 }, 'diag-after-move-leg2');
    arr2 = await waitArrival(drone1, leg2Target, 50, 300_000);
  } catch (err) {
    // A rejected leg-2 order must not abort the run: persistence is measured
    // after this and a missing measurement is worse than a recorded failure.
    log('leg2', false, { phase: 'order-rejected', error: String(err) });
    arr2 = { arrived: false, error: String(err) };
  }
  log('leg2', Boolean(arr2.arrived), { phase: 'arrival', ...arr2, diag: diagMove2 });
  let holdOrder2: Json | null = null;
  if (arr2.arrived && arr2.unit?.pos) {
    holdOrder2 = await order('hold', drone1, { ...arr2.unit.pos, speed: 5 }, 'leg2-hold');
  }
  const hold2 = await observeHold(drone1, 60);
  const hold2Pass = arr2.arrived && hold2.driftM !== null && hold2.driftM < 25;
  log('leg2', hold2Pass, { phase: 'hold', hold: hold2, criteria: { arrivalM: 50, driftM: 25 } });

  const after = await unit(drone1);
  const stop = await order('stop', drone1, {}, 'stop');
  const afterStop = await observeHold(drone1, 20);

  const beforeMeta = before1?.meta ?? {};
  const afterMeta = after?.meta ?? {};
  summary.scenario1 = {
    pass: Boolean(owned && aiOk && noSelfMotion && hold1Pass && hold2Pass),
    ownership: { applied: owned, matching: own1check.blocksMatchingOwner, terminal: own1check.terminalBlocks },
    ai: { stillAutopilot: ai1.stillAutopilot, stillAiEnabled: ai1.stillAiEnabled, blocksDisabled: ai1.aiBlocksDisabled },
    noSelfMotion: { pass: noSelfMotion, driftM: selfMotion.driftM, maxSpeed: selfMotion.maxSpeed },
    leg1: { arrival: arr1, holdOrder: holdOrder1, hold: hold1, pass: hold1Pass, autopilotAfterMove: diagMove1?.remoteControls?.[0]?.autopilot ?? null },
    leg2: { arrival: arr2, holdOrder: holdOrder2, hold: hold2, pass: hold2Pass, autopilotAfterMove: diagMove2?.remoteControls?.[0]?.autopilot ?? null },
    stop,
    afterStop,
    resources: {
      chargeBefore: beforeMeta.powerFraction ?? null,
      chargeAfter: afterMeta.powerFraction ?? null,
      fuelBefore: beforeMeta.fuelFraction ?? null,
      fuelAfter: afterMeta.fuelFraction ?? null,
    },
    massKg: prof1?.massKg ?? null,
    twr: prof1?.twr ?? null,
  };

  // ------------------------------------- despawn protection: wait out the window
  // NPC grids are cleaned up by MES on a timer; 12 minutes with no players is
  // the observation window for "it persisted".
  const spawnAt = Date.parse(summary.startedAt);
  const waitUntil = spawnAt + 12 * 60_000;
  const remain = waitUntil - Date.now();
  if (remain > 0) {
    log('persistence-wait', true, { phase: 'start', waitMs: remain });
    await sleep(remain);
  }
  const final1 = await test('despawn_state', { entityId: drone1 }, 'despawn-final-informant');
  const final2 = drone2 ? await test('despawn_state', { entityId: drone2 }, 'despawn-final-constructor') : null;
  const all = await test('list_grids', {}, 'list-grids');
  const standIns = (all.grids as Json[]).filter((g) => /^(Informant|Constructor|Eradicator) mk\.1$/.test(String(g.name ?? '')));
  summary.persistence = {
    drone1: final1,
    drone2: final2,
    persistedMinutes: 12,
    gridsOnServer: (all.grids as Json[]).length,
    standInGrids: standIns.map((g) => g.gridId),
    drone1Present: (all.grids as Json[]).some((g) => g.gridId === drone1),
    drone2Present: drone2 ? (all.grids as Json[]).some((g) => g.gridId === drone2) : null,
    stillOwned: Boolean(final1.ownerIsTestIdentity),
  };
  log('persistence-final', Boolean(final1.ownerIsTestIdentity), summary.persistence);

  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log('\nSUMMARY ' + summaryPath);
  console.log(JSON.stringify({
    scenario1Pass: summary.scenario1?.pass,
    ownershipApplied: summary.scenario1?.ownership?.applied,
    noSelfMotion: summary.scenario1?.noSelfMotion?.pass,
    persisted: summary.persistence?.drone1Present,
    standInsLeft: summary.persistence?.standInGrids?.length,
  }, null, 2));
}

main().catch((err) => {
  log('fatal', false, { error: String(err), stack: (err as Error)?.stack });
  console.error(err);
  process.exit(1);
});
