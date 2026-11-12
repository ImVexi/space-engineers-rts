/**
 * T4a physics/ownership probe (TEST SERVER ONLY).
 *
 * Short, bounded experiment used to find out why a spawned stand-in never moves:
 * spawn -> read physics + autopilot state -> order a short move -> sample.
 * Writes data/runs/probe-<ts>/probe.jsonl. Does not loop.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.RTS_BASE_URL ?? 'http://127.0.0.1:8762';
const TOKEN = process.env.RTS_TOKEN ?? '';
if (!TOKEN) throw new Error('RTS_TOKEN is not set');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve('data/runs', `probe-${runId}`);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, 'probe.jsonl');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Json = Record<string, any>;

function log(step: string, ok: boolean, data: Json = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), step, ok, ...data });
  fs.appendFileSync(logPath, line + '\n');
  console.log(line.slice(0, 500));
}

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.message ?? text}`);
  return json as T;
}

async function result(orderId: string, timeoutMs = 20_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const audit = await api<{ entries: Json[] }>('GET', '/api/audit?limit=200');
    const hit = audit.entries.find(
      (e) => e.action === 'plugin_event' && e.detail?.data?.orderId === orderId,
    );
    if (hit) return hit.detail.data as Json;
    await sleep(800);
  }
  return { ok: false, error: 'no result' };
}

async function order(orderType: string, entityId: string, params: Json, step: string): Promise<Json> {
  const sent = await api('POST', '/api/test/order', { orderType, entityId, params });
  const r = await result(sent.orderId);
  log(step, Boolean(r.ok), { orderId: sent.orderId, params, ok: r.ok, error: r.error ?? null, result: r.result });
  return r.result as Json;
}
const test = (action: string, params: Json, step: string) =>
  order('test', 'grid:0', { action, ...params }, step);

const norm = (v: Json) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

async function main(): Promise<void> {
  const health = await api('GET', '/api/health');
  log('health', true, { health });
  const state = await api<{ units: Json[]; agent: Json }>('GET', '/api/state');
  log('agent', true, { agent: state.agent, units: state.units.length });

  const planets = await api<{ planets: Json[] }>('GET', '/api/planets').catch(() => api<{ planets: Json[] }>('GET', '/api/plan/planets'));
  const earth = planets.planets.find((p) => p.name === 'EarthLike')!;
  const identity = await test('identity', {}, 'identity');
  const up = norm({ x: 0.94, y: 0.21, z: 0.27 });
  const pos = {
    x: earth.center.x + up.x * (earth.surfaceRadiusM + 12_000),
    y: earth.center.y + up.y * (earth.surfaceRadiusM + 12_000),
    z: earth.center.z + up.z * (earth.surfaceRadiusM + 12_000),
  };

  const existing = await test('list_grids', {}, 'list-before');
  for (const g of (existing.grids as Json[]).filter((x) => /^Informant mk\.1$/.test(String(x.name ?? '')))) {
    await test('delete_grid', { entityId: g.gridId }, 'cleanup-old');
  }

  const before = await test('list_grids', {}, 'list-before');
  const beforeIds = new Set<string>((before.grids as Json[]).map((g) => g.gridId));
  await test('spawn_prefab', { prefab: 'Informant_mk.1', x: pos.x, y: pos.y, z: pos.z, forward: { x: -0.276, y: 0, z: 0.961 }, up }, 'spawn');
  let gridId = '';
  for (let i = 0; i < 8 && !gridId; i++) {
    await sleep(1500);
    const now = await test('list_grids', {}, 'list-after');
    const fresh = (now.grids as Json[]).filter((g) => !beforeIds.has(g.gridId));
    if (fresh.length) gridId = fresh[0]!.gridId;
  }
  if (!gridId) throw new Error('spawn did not produce a grid');
  log('spawn', true, { gridId });

  const d0 = await test('diag', { entityId: gridId }, 'diag-t0');
  await sleep(5000);
  const d1 = await test('diag', { entityId: gridId }, 'diag-t5');

  const prof0 = await test('profile', { entityId: gridId }, 'profile');
  const own = await test('ownership', { entityId: gridId, ownerId: identity.identityId }, 'ownership');
  await sleep(3000);
  const ownCheck = await test('ownership_check', { entityId: gridId, ownerId: identity.identityId }, 'ownership-check');
  const ai = await test('ai_off', { entityId: gridId }, 'ai_off');

  const a0 = await test('diag', { entityId: gridId }, 'diag-pre-aiobserve');
  await sleep(20_000);
  const a1 = await test('diag', { entityId: gridId }, 'diag-post-aiobserve');
  const g = prof0.gravity;
  const dv = {
    x: (a1.physics.velocity.x - a0.physics.velocity.x) / 20,
    y: (a1.physics.velocity.y - a0.physics.velocity.y) / 20,
    z: (a1.physics.velocity.z - a0.physics.velocity.z) / 20,
  };
  log('accel', true, {
    measuredAccel: dv,
    gravity: g,
    residual: Math.hypot(dv.x - g.x, dv.y - g.y, dv.z - g.z),
    drift: Math.hypot(a1.position.x - a0.position.x, a1.position.y - a0.position.y, a1.position.z - a0.position.z),
  });
  await test('wake', { entityId: gridId }, 'wake');
  await sleep(8000); // let telemetry refresh so the comms gate sees the antenna
  const dW = await test('diag', { entityId: gridId }, 'diag-after-wake');
  log('rc-state', true, { rc: dW.remoteControls, thrust: dW.thrust });

  const target = { x: pos.x + up.x * 400, y: pos.y + up.y * 400, z: pos.z + up.z * 400 };
  const mv = await order('move', gridId, target, 'move-400m');
  const samples: Json[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const d = await test('diag', { entityId: gridId }, 'diag-move');
    samples.push({ t: Date.now(), pos: d.position, vel: d.physics?.velocity, active: d.physics?.active, autopilot: d.remoteControls?.[0]?.autopilot });
  }
  log('move-samples', true, { samples, target });

  await order('stop', gridId, {}, 'stop');
  const del = await test('delete_grid', { entityId: gridId }, 'delete');
  const last = samples[samples.length - 1];
  log('done', true, { own, ownCheck, ai, move: mv, del, moved: last ? Math.hypot(last.pos.x - pos.x, last.pos.y - pos.y, last.pos.z - pos.z) : null });
}

main().catch((e) => { log('fatal', false, { error: String(e) }); process.exit(1); });
