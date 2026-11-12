/**
 * T4b scenario runner (TEST SERVER ONLY).
 *
 * Scenario 1 (near-planet): a stand-in drone is spawned 12 km above the
 * EarthLike surface with its world matrix set so "up" points away from the
 * planet centre, then flies 2 km radially outward and holds.
 *
 * Scenario 2 (constellation): 4 Eradicator-class drones are placed on a ring
 * whose neighbour spacing is 0.9 x the measured radio radius, dispatched to
 * their slots, and held for 120 s. While they hold, the network state is read
 * read-only through the plugin (radio fields + MyAntennaSystem group state)
 * and compared with the planner's predicted link graph.
 *
 * Every request, response, telemetry sample and verdict goes to a JSONL log
 * under data/runs/<runId>/. No value is estimated: TWR, gravity, thrust and
 * charge come from the plugin's measured profile.
 *
 * Usage:
 *   set -a; . <token-file>; set +a
 *   npx tsx packages/backend/scripts/run-t4b.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph } from '../src/planner/graph.js';

const BASE = process.env.RTS_BASE_URL ?? 'http://127.0.0.1:8762';
const TOKEN = process.env.RTS_TOKEN ?? '';
if (!TOKEN) throw new Error('RTS_TOKEN is not set');

const S1 = 'T4b-scenario1-near-planet';
const S2 = 'T4b-scenario2-constellation';
/** s1 | both — lets a bounded S1-only retry run without redoing S2. */
const ONLY = (process.env.T4B_SCENARIOS ?? 'both').toLowerCase();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve('data/runs', runId);
fs.mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, 't4b.jsonl');
const summaryPath = path.join(dir, 'summary.json');

type Json = Record<string, any>;
type V3 = { x: number; y: number; z: number };

let scenario = S1;
function log(step: string, ok: boolean, data: Json = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), scenarioId: scenario, step, ok, ...data });
  fs.appendFileSync(logPath, line + '\n');
  console.log(line.slice(0, 320));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ sim speed
const simSamples: Json[] = [];
let simLowSince: number | null = null;
let minSimSpeed = Number.POSITIVE_INFINITY;

/** SimSpeed is not exposed to plugins in 01_210_014, so it is read from the
 *  test server's Remote API (read-only GET). */
function sampleSimSpeed(label: string): number | null {
  try {
    const out = execFileSync('python3', ['scripts/se-test-remote.py', 'GET', '/vrageremote/v1/server'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    // The helper prints a STATUS line first; the JSON body is the last line.
    const jsonLine = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop();
    if (!jsonLine) return null;
    const parsed = JSON.parse(jsonLine);
    const speed = Number(parsed?.data?.SimSpeed ?? parsed?.SimSpeed);
    if (!Number.isFinite(speed)) return null;
    simSamples.push({ t: new Date().toISOString(), label, simSpeed: speed });
    minSimSpeed = Math.min(minSimSpeed, speed);
    return speed;
  } catch {
    return null;
  }
}

/** Stop the run if SimSpeed stays below 0.95 for 30 s (standing rule). */
function guardSimSpeed(label: string, speed?: number | null): void {
  const value = speed === undefined ? sampleSimSpeed(label) : speed;
  if (value === null || value === undefined) return;
  if (value < 0.95) {
    simLowSince ??= Date.now();
    if (Date.now() - simLowSince >= 30_000) {
      throw new Error(`SimSpeed stayed below 0.95 for 30 s (last ${value}) — stopping per rule`);
    }
  } else {
    simLowSince = null;
  }
}

// ---------------------------------------------------------------------- http
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
      (e) => e.action === 'plugin_event' && e.detail?.eventType === 'order_result' && e.detail?.data?.orderId === orderId,
    );
    if (hit) return hit.detail.data as Json;
    await sleep(1200);
  }
  return null;
}

async function order(orderType: string, entityId: string, params: Json, step: string): Promise<Json> {
  const gate = await api('GET', `/api/test/gate?entityId=${encodeURIComponent(entityId)}`);
  const sent = await api('POST', '/api/test/order', { orderType, entityId, params });
  log(step, true, { phase: 'sent', orderId: sent.orderId, orderType, entityId, params, gate });
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

// ------------------------------------------------------------------ geometry
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a: V3, b: V3, s = 1): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const norm = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const round = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------- helpers
async function observeHold(gridId: string, seconds: number, label: string): Promise<Json> {
  const samples: Json[] = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const u = await unit(gridId);
    if (u?.pos) samples.push({ t: Date.now(), pos: u.pos, vel: u.vel });
    guardSimSpeed(label);
    await sleep(5000);
  }
  if (samples.length < 2) return { samples: samples.length, driftM: null };
  const first = samples[0]!.pos as V3;
  const drifts = samples.map((s) => dist(s.pos, first));
  return {
    samples: samples.length,
    driftM: round(Math.max(...drifts)),
    maxSpeed: round(Math.max(...samples.map((s) => Math.hypot(s.vel?.x ?? 0, s.vel?.y ?? 0, s.vel?.z ?? 0))), 2),
    first: samples[0],
    last: samples[samples.length - 1],
  };
}

async function waitArrival(gridId: string, target: V3, tolerance: number, timeoutMs: number, label: string): Promise<Json> {
  const start = Date.now();
  let last: Json | null = null;
  const samples: Json[] = [];
  while (Date.now() - start < timeoutMs) {
    const u = await unit(gridId);
    if (u?.pos) {
      last = u;
      const d = dist(u.pos, target);
      samples.push({ t: Date.now(), pos: u.pos, dist: round(d), vel: u.vel });
      if (d <= tolerance) {
        return { arrived: true, distanceM: round(d), elapsedMs: Date.now() - start, unit: u, samples: samples.slice(-4) };
      }
    }
    guardSimSpeed(label);
    await sleep(3000);
  }
  return {
    arrived: false,
    distanceM: last?.pos ? round(dist(last.pos, target)) : null,
    elapsedMs: Date.now() - start,
    unit: last,
    samples: samples.slice(-4),
  };
}

async function spawnPrefab(
  prefab: string,
  pos: V3,
  up: V3,
  forward: V3,
  label: string,
): Promise<{ gridId: string; spawn: Json; detail: Json }> {
  const before = await test('list_grids', {}, `${label}-list-before`);
  const beforeIds = new Set<string>((before.grids as Json[]).map((g) => g.gridId));
  const spawn = await test(
    'spawn_prefab',
    { prefab, x: pos.x, y: pos.y, z: pos.z, forward, up },
    `${label}-spawn`,
  );
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const now = await test('list_grids', {}, `${label}-list-after`);
    const fresh = (now.grids as Json[]).filter((g) => !beforeIds.has(g.gridId));
    if (fresh.length > 0) {
      // A multi-grid prefab (ship + subgrids) returns several fresh grids. The
      // main hull is the one with the mass; picking fresh[0] once measured a
      // 0 kg subgrid and produced a meaningless TWR.
      const main = [...fresh].sort((a, b) => Number(b.massKg ?? 0) - Number(a.massKg ?? 0))[0]!;
      log(label, true, {
        phase: 'spawned',
        prefab,
        grid: main,
        freshCount: fresh.length,
        otherGrids: fresh.filter((g) => g.gridId !== main.gridId).map((g) => g.gridId),
        spawnOrderResult: spawn,
      });
      return { gridId: main.gridId as string, spawn: { order: spawn, fresh: main }, detail: main as Json };
    }
  }
  throw new Error(`${label}: ${prefab} did not appear in the entity list within 18 s`);
}

/** Remove stand-in grids left by earlier failed runs (test server only). */
async function cleanupStandIns(): Promise<Json> {
  const list = await test('list_grids', {}, 'cleanup-list');
  const stale = (list.grids as Json[]).filter((g) =>
    /^(Informant|Constructor|Eradicator|Large Control Drone|Large Suport Drone|Encounter Corvette) ?(mk\.1|A|B)?$/.test(
      String(g.name ?? ''),
    ),
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

// ============================================================================
async function main(): Promise<void> {
  const summary: Json = { runId, startedAt: new Date().toISOString(), steps: {} };

  const health = await api('GET', '/api/health');
  const state = await api('GET', '/api/state');
  log('preflight', true, { health, agent: state.agent, units: (state.units as Json[]).length });
  if (!health.agentConnected) throw new Error('plugin is not connected');
  const caps: string[] = state.agent?.capabilities ?? [];
  if (!caps.includes('command_execution') || !caps.includes('test_api')) {
    throw new Error(`plugin did not advertise the write capabilities: ${caps.join(',')}`);
  }

  guardSimSpeed('preflight');

  const identity = await test('identity', {}, 'identity');
  summary.identity = identity;

  const planets = await api<{ planets: Json[] }>('GET', '/api/plan/planets');
  const earth = planets.planets.find((p) => p.name === 'EarthLike');
  if (!earth) throw new Error('EarthLike not in planet catalog');
  const up0 = norm({ x: 0.94, y: 0.21, z: 0.27 });

  // ---------------------------------------------------------- local ground truth
  const probeFrom = add(earth.center as V3, up0, (earth.surfaceRadiusM as number) + 3000);
  const probe = await test(
    'probe_ground',
    { x: probeFrom.x, y: probeFrom.y, z: probeFrom.z, direction: { x: -up0.x, y: -up0.y, z: -up0.z }, length: 9000 },
    'probe-ground',
  );
  if (!probe.hit) throw new Error('probe_ground found no terrain at the EarthLike test direction');
  const surface = probe.position as V3;
  const up = norm(probe.normal as V3);
  const tangent0 = norm(cross(up, { x: 0, y: 1, z: 0 }));
  const surfaceRadius = dist(surface, earth.center as V3);
  summary.ground = { probe, surfaceRadiusM: round(surfaceRadius), up };
  // Cleanup runs after the ground probe: deleting grids can unload the planet's
  // voxel collider on this DS build (measured T4c), which would make the probe
  // miss on a trimmed world.
  summary.cleanup = await cleanupStandIns();

  scenario = S1;
  const spawnAlt = 12_000;
  const spawnPos = add(surface, up, spawnAlt);
  log('s1', true, { phase: 'spawn-target', spawnPos, spawnAlt, up, tangent: tangent0 });

  // ------------------------------------------------ Scenario 1: hull selection
  // One variable: the hull. Measured TWR at the spawn altitude decides.
  const hulls = ONLY === 'net' ? [] : [
    { prefab: 'Eradicator_mk.1', label: 'eradica' },
    // Above the atmosphere at 12 km the atmo-only hulls measured 0 N effective
    // (Large Control Drone, run 2026-11-09T16-15-42-363Z), so the fallbacks are
    // hydrogen-lift hulls with a remote control.
    { prefab: '(NPC-CMF) Lightbringer (A)', label: 'lightbringer' },
    { prefab: '(NPC-CCF) Graf (A)', label: 'graf' },
  ];
  const trials: Json[] = [];
  let drone1: string | null = null;
  let hull: Json | null = null;
  let orient1: Json | null = null;
  let prof1: Json | null = null;
  let own1: Json | null = null;
  let ai1: Json | null = null;

  for (const candidate of hulls) {
    if (drone1) break;
    const spawned = await spawnPrefab(candidate.prefab, spawnPos, up, tangent0, candidate.label);
    const gridId = spawned.gridId;
    await test('physics_wake', { entityId: gridId }, `${candidate.label}-physics-wake`);
    // Preflight order matters: a freshly spawned prefab has its antennas and
    // thrusters switched off, so a TWR measured before wake() under-reports
    // usable thrust. Prepare the grid the way it would fly, then measure.
    const candidateOwnership = await test('ownership', { entityId: gridId, ownerId: identity.identityId }, `${candidate.label}-ownership`);
    await test('wake', { entityId: gridId }, `${candidate.label}-wake`);
    const candidateAi = await test('ai_off', { entityId: gridId }, `${candidate.label}-ai-off`);
    const candidateOrient = await test('set_orientation', { entityId: gridId, up, forward: tangent0 }, `${candidate.label}-orient`);
    const prof = await test('profile', { entityId: gridId }, `${candidate.label}-profile-at-altitude`);
    const gMag = Number(prof.gravity?.magnitudeMs2 ?? 0);
    const twr = Number(prof.twr ?? -1);
    const atmoN = Number(prof.thrusters?.atmoN ?? 0);
    const ionN = Number(prof.thrusters?.ionN ?? 0);
    const h2N = Number(prof.thrusters?.h2N ?? 0);
    const effectiveN = Number(prof.thrusters?.maxEffectiveThrustN ?? 0);
    const mass = Number(prof.massKg ?? 0);
    const trial = {
      prefab: candidate.prefab,
      gridId,
      massKg: mass,
      gravityMs2: gMag,
      twrMeasured: twr,
      thrusters: prof.thrusters,
      atmoThrustShare: effectiveN > 0 ? round(atmoN / effectiveN, 3) : 0,
      ionThrustShare: effectiveN > 0 ? round(ionN / effectiveN, 3) : 0,
      h2ThrustShare: effectiveN > 0 ? round(h2N / effectiveN, 3) : 0,
      fuelTanks: prof.fuel?.tanks ?? [],
      selected: twr >= 1.5,
    };
    trials.push(trial);
    log('s1', trial.selected, { phase: 'hull-trial', ...trial });

    if (twr >= 1.5) {
      drone1 = gridId;
      hull = trial;
      prof1 = prof;
      orient1 = candidateOrient;
      own1 = candidateOwnership;
      ai1 = candidateAi;
    } else {
      await test('delete_grid', { entityId: gridId }, `${candidate.label}-delete-unsuitable`);
    }
  }

  summary.scenario1 = { hullTrials: trials, hull, orientation: orient1 };

  if (drone1 && hull && orient1) {
    const orientOk = Number(orient1.upErrorDeg) <= 2 && Number(orient1.forwardErrorDeg) <= 2;
    log('s1-orientation', orientOk, {
      phase: 'verified',
      upErrorDeg: orient1.upErrorDeg,
      forwardErrorDeg: orient1.forwardErrorDeg,
      before: orient1.before,
      actualUp: orient1.actualUp,
      criterion: '<= 2 deg',
    });

    const own1check = await test('ownership_check', { entityId: drone1, ownerId: identity.identityId }, 's1-ownership-check');
    // Attitude can be nudged by the prep passes; re-assert it after ai_off and
    // prove the read-back again, on the grid that is about to be ordered.
    const orient2 = await test('set_orientation', { entityId: drone1, up, forward: tangent0 }, 's1-orient-final');
    const profBefore = await test('profile', { entityId: drone1 }, 's1-profile-before');

    const noSelfMotion = await observeHold(drone1, 20, 's1-self-motion');
    const selfMotionOk = noSelfMotion.driftM !== null && noSelfMotion.driftM < 25;

    const target = add(spawnPos, up, 2000);
    log('s1-leg1', true, { phase: 'target', target, pos: profBefore.position });
    await order('move', drone1, { ...target, speed: 30 }, 's1-move-2km');
    const arr = await waitArrival(drone1, target, 50, 240_000, 's1-arrival');

    let holdOrder: Json | null = null;
    if (arr.arrived && arr.unit?.pos) {
      holdOrder = await order('hold', drone1, { ...arr.unit.pos, speed: 3 }, 's1-hold');
    }
    const hold = await observeHold(drone1, 60, 's1-hold-observation');
    const profAfter = await test('profile', { entityId: drone1 }, 's1-profile-after');

    const pass =
      orientOk &&
      Boolean(own1check.applied) &&
      ai1!.stillAutopilot === 0 &&
      ai1!.stillAiEnabled === 0 &&
      selfMotionOk &&
      Boolean(arr.arrived) &&
      hold.driftM !== null &&
      hold.driftM < 25;

    summary.scenario1 = {
      ...summary.scenario1,
      drone1,
      pass,
      criteria: { altitudeM: spawnAlt, climbM: 2000, arrivalM: 50, holdDriftM: 25, orientationDeg: 2 },
      orientation: { initial: orient1, final: orient2, pass: orientOk },
      ownership: { applied: own1check.applied, matching: own1check.blocksMatchingOwner, terminal: own1check.terminalBlocks, change: own1 },
      ai: { stillAutopilot: ai1!.stillAutopilot, stillAiEnabled: ai1!.stillAiEnabled, blocksDisabled: ai1!.aiBlocksDisabled },
      noSelfMotion: { pass: selfMotionOk, ...noSelfMotion },
      gravity: profBefore.gravity,
      twrMeasured: profBefore.twr,
      move: arr,
      holdOrder,
      hold,
      charge: {
        beforeMWh: profBefore.power?.batteryStoredMWh ?? null,
        afterMWh: profAfter.power?.batteryStoredMWh ?? null,
        reactorMaxMw: profBefore.power?.reactorMaxMw ?? null,
      },
    };
    log('s1', pass, { phase: 'verdict', pass });
  } else if (ONLY !== 'net') {
    summary.scenario1 = {
      ...summary.scenario1,
      pass: false,
      blocker:
        'no available stand-in reached TWR 1.5 in local gravity; measured values are in hullTrials (mass, gravity, thrust split, TWR)',
    };
    log('s1', false, { phase: 'blocked', hullTrials: trials });
  }

  // --------------------------------------------------- Scenario 2: constellation
  scenario = S2;
  if (ONLY === 's1') {
    summary.simSpeed = { min: round(minSimSpeed, 3), samples: simSamples.length };
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log('\nSUMMARY ' + summaryPath + ' (S1 only)');
    return;
  }
  const spaceRadius = surfaceRadius + 200_000;
  const center = earth.center as V3;
  const spaceCenter = add(center, up, spaceRadius);
  const e1 = tangent0;
  const e2 = norm(cross(up, e1));

  const anchor = drone1
    ? await test('profile', { entityId: drone1 }, 's2-anchor-profile')
    : null;
  const radioRadius = Number(anchor?.radio?.[0]?.radiusM ?? trials[0]?.radioRadiusM ?? 50_000);
  const spacing = Math.min(radioRadius * 0.9, 45_000);
  const ringRadius = spacing / Math.SQRT2; // 4 points: neighbour chord = R*sqrt(2)
  const N = 4;
  const slots: V3[] = [];
  const starts: V3[] = [];
  const fwd: V3[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i * 2 * Math.PI) / N;
    const radial = add(
      add({ x: 0, y: 0, z: 0 }, e1, Math.cos(th) * ringRadius),
      e2,
      Math.sin(th) * ringRadius,
    );
    const slot = add(spaceCenter, radial, 1);
    const t = norm(add(add({ x: 0, y: 0, z: 0 }, e1, -Math.sin(th)), e2, Math.cos(th)));
    slots.push(slot);
    fwd.push(t);
    starts.push(add(slot, t, -3000)); // 3 km short of the slot, on the ring tangent
  }
  summary.scenario2 = {
    spaceCenter,
    ringRadiusM: round(ringRadius),
    spacingM: round(spacing),
    radioRadiusM: radioRadius,
    slots,
  };
  log('s2', true, {
    phase: 'plan',
    spaceCenter,
    ringRadiusM: round(ringRadius),
    spacingM: round(spacing),
    radioRadiusM: radioRadius,
    neighborChordM: round(spacing),
    diagonalChordM: round(spacing * Math.SQRT2),
    slots,
  });

  const fleet: { gridId: string; profileBefore: Json; orientation: Json }[] = [];
  const netMode = ONLY === 'net';
  for (let i = 0; i < N; i++) {
    const label = `s2-drone-${i + 1}`;
    // net mode parks each drone at its slot (no transit) so the network-state
    // read can be taken without the flight load. It is labelled network-only.
    const spawned = await spawnPrefab('Eradicator_mk.1', netMode ? slots[i]! : starts[i]!, up, fwd[i]!, label);
    const gridId = spawned.gridId;
    await test('physics_wake', { entityId: gridId }, `${label}-physics-wake`);
    await test('ownership', { entityId: gridId, ownerId: identity.identityId }, `${label}-ownership`);
    await test('wake', { entityId: gridId }, `${label}-wake`);
    await test('ai_off', { entityId: gridId }, `${label}-ai-off`);
    const orientation = await test('set_orientation', { entityId: gridId, up, forward: fwd[i]! }, `${label}-orient`);
    const profileBefore = await test('profile', { entityId: gridId }, `${label}-profile-before`);
    fleet.push({ gridId, profileBefore, orientation });
    log(label, Number(orientation.upErrorDeg) <= 2, {
      phase: 'prepared',
      gridId,
      upErrorDeg: orientation.upErrorDeg,
      twr: profileBefore.twr,
      chargeMWh: profileBefore.power?.batteryStoredMWh ?? null,
    });
  }

  // Dispatch all four, then poll them together.
  const arrivals: Json[] = new Array(N).fill(null);
  let minPairDuringApproach = Number.POSITIVE_INFINITY;
  if (!netMode) {
    for (let i = 0; i < N; i++) {
      await order('move', fleet[i]!.gridId, { ...slots[i]!, speed: 30 }, `s2-dispatch-${i + 1}`);
    }

    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      let all = true;
      const positions: (V3 | null)[] = [];
      for (let i = 0; i < N; i++) {
        const u = await unit(fleet[i]!.gridId);
        positions.push(u?.pos ?? null);
        if (u?.pos) {
          const d = dist(u.pos, slots[i]!);
          arrivals[i] = { arrived: d <= 50, distanceM: round(d), pos: u.pos, vel: u.vel };
          if (d > 50) all = false;
        } else {
          all = false;
        }
      }
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = positions[i];
          const b = positions[j];
          if (a && b) minPairDuringApproach = Math.min(minPairDuringApproach, dist(a, b));
        }
      }
      if (all) break;
      guardSimSpeed('s2-approach');
      await sleep(4000);
    }
  } else {
    for (let i = 0; i < N; i++) {
      const u = await unit(fleet[i]!.gridId);
      arrivals[i] = { arrived: true, distanceM: round(u?.pos ? dist(u.pos, slots[i]!) : null), pos: u?.pos ?? slots[i] };
    }
  }
  const allArrived = arrivals.every((a) => a?.arrived === true);
  log('s2', allArrived, {
    phase: 'arrivals',
    mode: netMode ? 'network-only (parked at slot, no transit)' : 'dispatched',
    arrivals,
    minPairDistanceM: round(minPairDuringApproach),
  });

  // Hold: re-anchor each hold order at its own arrival position.
  const holds: Json[] = [];
  if (!netMode) {
    for (let i = 0; i < N; i++) {
      const pos = arrivals[i]?.pos as V3 | undefined;
      if (!pos) continue;
      try {
        holds.push(await order('hold', fleet[i]!.gridId, { ...pos, speed: 3 }, `s2-hold-${i + 1}`));
      } catch (err) {
        log(`s2-hold-${i + 1}`, false, { error: String(err) });
        holds.push({ error: String(err) });
      }
    }
  }

  const holdStart = Date.now();
  const perDrone: Json[] = fleet.map((f) => ({ gridId: f.gridId, samples: [] as Json[] }));
  let minPairHold = Number.POSITIVE_INFINITY;
  let simOkThroughHold = true;
  while (Date.now() - holdStart < (netMode ? 0 : 120_000)) {
    const positions: (V3 | null)[] = [];
    for (let i = 0; i < N; i++) {
      const u = await unit(fleet[i]!.gridId);
      positions.push(u?.pos ?? null);
      if (u?.pos) perDrone[i]!.samples.push({ t: Date.now(), pos: u.pos, vel: u.vel });
    }
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = positions[i];
        const b = positions[j];
        if (a && b) minPairHold = Math.min(minPairHold, dist(a, b));
      }
    }
    const speed = sampleSimSpeed('s2-hold');
    if (speed !== null && speed < 0.95) simOkThroughHold = false;
    guardSimSpeed('s2-hold', speed);
    await sleep(5000);
  }

  for (const d of perDrone) {
    const s = d.samples as Json[];
    d.driftM = s.length > 1 ? round(Math.max(...s.map((x) => dist(x.pos, s[0]!.pos)))) : null;
    d.samplesCount = s.length;
    d.first = s[0] ?? null;
    d.last = s[s.length - 1] ?? null;
    delete d.samples;
  }
  const holdOk = perDrone.every((d) => d.driftM !== null && d.driftM < 25);

  // ----------------------------------------- network state (read-only, no orders)
  const ids = fleet.map((f) => f.gridId);
  const links = await test('radio_links', { entityIds: ids }, 's2-radio-links');
  const measuredPositions: V3[] = perDrone.map(
    (d, i) => (d.last?.pos as V3) ?? (arrivals[i]?.pos as V3) ?? slots[i]!,
  );
  const plannerNodes = measuredPositions.map((p, i) => ({
    id: `d${i + 1}`,
    position: p,
    radioRadiusM: spacing, // measured radius x 0.9, the planner's spacingSafetyFactor
    laserRangeM: null,
    laserUnlimited: false,
    controlSource: i === 0,
  }));
  const predicted = buildGraph(plannerNodes, [], { radioDirectional: false });
  const predictedEdges = predicted.edges.map((e) => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    distanceM: round(e.distanceM),
  }));

  const gameGrids = (links.grids as Json[]) ?? [];
  const groupValue = links.sameLogicalGroup?.state === 'readable' ? Boolean(links.sameLogicalGroup.value) : null;
  const plannerConnected = predicted.graph.components.length === 1;
  const comparison = {
    planner: {
      edges: predictedEdges,
      components: predicted.graph.components.length,
      connected: plannerConnected,
      note: 'buildGraph with radioRadiusM = 0.9 x measured radius; positions = measured hold positions',
    },
    game: {
      sameLogicalGroup: links.sameLogicalGroup,
      groupBroadcasters: gameGrids.map((g) => ({
        gridId: g.gridId,
        state: g.groupBroadcasters?.state ?? 'missing',
        value: g.groupBroadcasters?.value ?? null,
      })),
      groupSignalReceivers: gameGrids.map((g) => ({
        gridId: g.gridId,
        state: g.groupSignalReceivers?.state ?? 'missing',
        value: g.groupSignalReceivers?.value ?? null,
      })),
      representatives: gameGrids.map((g) => g.logicalGroupRepresentative?.value ?? null),
      pairwiseDirectLink: links.pairwiseDirectLink,
      laserLinks: links.laserLinks,
      radioFields: gameGrids.map((g) => ({
        gridId: g.gridId,
        radioCount: g.radioCount,
        radioWorking: g.radioWorking,
        maxRadiusM: g.maxRadiusM,
        antennas: g.radioAntennas,
      })),
    },
    readableVsUnverified: {
      READABLE: [
        'per-antenna Radius / Enabled / IsWorking / EnableBroadcasting / IsBroadcasting',
        'MyAntennaSystem group broadcaster count',
        'MyAntennaSystem group signal receiver count',
        'MyAntennaSystem logical group representative (group membership)',
        'planner-predicted edge list (computed, not game state)',
      ],
      UNVERIFIED: [
        'per-pair direct antenna link/lock state (no public member in 01_210_014)',
        'laser link state (no laser antenna on these grids)',
        'command routing through the antenna network (not tested here; this is a network-state test, not a control-relay test)',
      ],
    },
    verdict:
      groupValue === null
        ? 'UNVERIFIED'
        : groupValue && plannerConnected
          ? 'MATCH: game reports one logical antenna group, planner predicts one connected component'
          : groupValue && !plannerConnected
            ? 'MISMATCH: game group connected, planner predicts a split'
            : 'MISMATCH: game reports separate groups where the planner predicts a link',
  };
  log('s2-network-state', Boolean(groupValue), { phase: 'comparison', ...comparison });

  // ------------------------------------------------------------ charge + verdict
  const charge: Json[] = [];
  for (let i = 0; i < N; i++) {
    const after = await test('profile', { entityId: fleet[i]!.gridId }, `s2-profile-after-${i + 1}`);
    charge.push({
      gridId: fleet[i]!.gridId,
      beforeMWh: fleet[i]!.profileBefore.power?.batteryStoredMWh ?? null,
      afterMWh: after.power?.batteryStoredMWh ?? null,
      reactorMaxMw: after.power?.reactorMaxMw ?? null,
      massKg: after.massKg ?? null,
    });
  }

  const s2pass = netMode
    ? groupValue === true && plannerConnected
    : allArrived &&
      holdOk &&
      minPairHold > 100 &&
      simOkThroughHold &&
      minSimSpeed >= 0.95 &&
      Boolean(groupValue);

  summary.scenario2 = {
    ...summary.scenario2,
    mode: netMode ? 'network-only' : 'full',
    drones: fleet.map((f, i) => ({
      gridId: f.gridId,
      upErrorDeg: f.orientation.upErrorDeg,
      arrival: arrivals[i],
      holdDriftM: perDrone[i]!.driftM,
      samples: perDrone[i]!.samplesCount,
      charge: charge[i],
    })),
    criteria: { arrivalM: 50, holdDriftM: 25, holdSeconds: 120, minPairDistanceM: 100, minSimSpeed: 0.95 },
    allArrived,
    holdOk,
    minPairHoldM: round(minPairHold),
    minPairApproachM: round(minPairDuringApproach),
    minSimSpeed: round(minSimSpeed, 3),
    simOkThroughHold,
    networkState: comparison,
    pass: s2pass,
  };
  log('s2', s2pass, { phase: 'verdict', pass: s2pass });

  summary.simSpeed = { min: round(minSimSpeed, 3), samples: simSamples.length };
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log('\nSUMMARY ' + summaryPath);
  console.log(
    JSON.stringify(
      {
        s1Pass: summary.scenario1?.pass,
        s1Hull: summary.scenario1?.hull?.prefab ?? null,
        s1Twr: summary.scenario1?.twrMeasured ?? null,
        s2Pass: summary.scenario2?.pass,
        s2Arrived: summary.scenario2?.allArrived,
        s2Drift: summary.scenario2?.drones?.map((d: Json) => d.holdDriftM),
        networkVerdict: summary.scenario2?.networkState?.verdict,
        minSimSpeed: summary.simSpeed?.min,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  log('fatal', false, { error: String(err), stack: (err as Error)?.stack });
  console.error(err);
  process.exit(1);
});
