import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, FeatureFlag } from '../src/config.js';
import { FEATURE_FLAGS } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

export function tempDir(prefix = 'se-rts-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeConfig(
  overrides: Partial<Omit<Config, 'flags' | 'caps'>> & {
    flags?: Partial<Record<FeatureFlag, boolean>>;
    caps?: Partial<Config['caps']>;
  } = {},
): Config {
  const dir = overrides.dataDir ?? tempDir();
  const flags = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<FeatureFlag, boolean>;
  return {
    bind: overrides.bind ?? '127.0.0.1',
    port: overrides.port ?? 0,
    token: overrides.token ?? '',
    dataDir: dir,
    dbPath: path.join(dir, 'rts.db'),
    flags: { ...flags, ...(overrides.flags ?? {}) },
    caps: {
      maxQueuedBuilds: 8,
      maxOrdersPerMinute: 60,
      minReconcileIntervalMs: 5000,
      maxOrderAttempts: 3,
      orderBackoffMs: 500,
      ...(overrides.caps ?? {}),
    },
    autoMissionTypes: overrides.autoMissionTypes ?? [],
    owner: overrides.owner ?? { steamId: '10000000000000001', identityNames: ['owner'] },
    detector: overrides.detector ?? {
      sbsPath: path.join(dir, 'missing.sbs'),
      sbcPath: path.join(dir, 'missing.sbc'),
      refreshMs: 60000,
    },
    controlSources: overrides.controlSources ?? [],
    demo:
      overrides.demo ??
      {
        speedLimitMps: 60,
        maxDronesPerMission: 6,
        maxActiveStandIns: 10,
        maxClimbConcurrent: 3,
        legM: 2500,
        tickMs: 1000,
        gateFreshMs: 30_000,
        simSpeedMin: 0.95,
        simSpeedSampleMs: 5_000,
        simSpeedHoldMs: 30_000,
        spawnAglM: 8_000,
        gravitySpawnAglM: 2_500,
        orbitAglM: 40_000,
        gravityHull: null,
        leaveHolding: false,
        maxGridsBeforeRun: 20,
        simSpeedEnvPath: '/nonexistent/remote.env',
        archivedAfterMs: 6 * 60 * 60 * 1000,
        landingHandoverAglM: 150,
        station: { enabled: true, afterMs: 30_000, maxSpeedMps: 0.5, zeroSpeedMps: 5, minAglM: 100 },
        comeToMe: { lateralM: 40, aboveGroundM: 80, timeoutMs: 600_000 },
      },
    tickMs: overrides.tickMs ?? { reconcile: 50, dispatch: 50 },
  };
}

export function memoryStore(clock: () => number = Date.now): Store {
  const db = openDb(':memory:', { memory: true });
  return new Store(db, clock);
}

export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
  set: (value: number) => void;
}

export function makeClock(start = 1_700_000_000_000): Clock {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
    set: (v: number) => {
      value = v;
    },
  };
}

/** Minimal valid mission create payload. */
export function missionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'build_deploy',
    priority: 50,
    desiredState: { shipSpec: 'sat-relay-mk1', station: 'orbit-A' },
    budget: { resources: { iron: 12000 }, timeMin: 90, lossLimit: 1 },
    ...overrides,
  };
}

export function unit(overrides: Partial<{
  id: string;
  name: string;
  specId: string | null;
  station: string | null;
  linkStatus: 'up' | 'down' | 'unknown';
  lastSeen: number;
  pos: { x: number; y: number; z: number } | null;
  vel: null;
  meta: Record<string, unknown>;
}> = {}) {
  return {
    id: 'grid:1',
    name: 'test',
    specId: 'sat-relay-mk1',
    station: 'orbit-A',
    linkStatus: 'up' as const,
    lastSeen: 1_700_000_000_000,
    pos: { x: 0, y: 0, z: 0 },
    vel: null,
    meta: {},
    ...overrides,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

export async function httpRequest<T = unknown>(
  port: number,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}
