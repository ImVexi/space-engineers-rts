import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';
import { FakePlugin } from './fakePlugin.js';
import { PlayerTracker } from '../src/demo/players/index.js';
import {
  PLAYER_SETTINGS_DEFAULTS,
  readPlayerSettings,
  validatePlayerSettings,
  writePlayerSettings,
} from '../src/demo/players/settings.js';
import { memoryStore } from './helpers.js';

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const saved: Record<string, string | undefined> = {};
const TOKEN = 't61-token-please-change-1234';

const OWNER_STEAM = '10000000000000001';
const OWNER_IDENTITY = '144115188075855926';
const MATE_STEAM = '10000000000000001';
const MATE_IDENTITY = '144115188075855927';
const ENEMY_STEAM = '10000000000000001';
const ENEMY_IDENTITY = '144115188075855928';

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

/** One plugin `players[]` entry, shaped exactly like the plugin sends it. */
function player(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identityId: OWNER_IDENTITY,
    steamId: OWNER_STEAM,
    displayName: 'owner',
    characterEntityId: '9007199254740993',
    pos: { x: 1000.25, y: 2000.5, z: -3000.75 },
    vel: { x: 0.5, y: 0, z: 0 },
    gridId: null,
    seatName: null,
    piloting: false,
    planet: 'EarthLike',
    aglM: 12.5,
    altitudeM: 30.25,
    gravityMps2: 9.81,
    onFoot: true,
    isDead: false,
    factionTag: 'HMTST',
    factionId: '123456789',
    optOut: false,
    ...overrides,
  };
}

/**
 * A PlayerSample for a direct tracker test. Typed from the tracker's own
 * signature so the test cannot drift from the production shape.
 */
type IngestInput = Parameters<PlayerTracker['ingest']>[0][number];

function sample(overrides: Partial<Record<keyof IngestInput, unknown>> = {}): IngestInput {
  return {
    identityId: OWNER_IDENTITY,
    steamId: OWNER_STEAM,
    displayName: 'owner',
    characterEntityId: '9007199254740993',
    pos: { x: 1, y: 2, z: 3 },
    vel: null,
    gridId: null,
    seatName: null,
    piloting: false,
    planet: 'EarthLike',
    aglM: 5,
    altitudeM: 20,
    gravityMps2: 9.81,
    onFoot: true,
    isDead: false,
    factionTag: 'HMTST',
    factionId: '123456789',
    optOut: false,
    ...overrides,
  } as IngestInput;
}

describe('T61 player telemetry ingestion', () => {
  it('keeps every id a string, including values past 2^53', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    tracker.ingest(
      [
        {
          identityId: OWNER_IDENTITY,
          steamId: OWNER_STEAM,
          displayName: 'owner',
          characterEntityId: '9007199254740993',
          pos: { x: 1, y: 2, z: 3 },
          vel: null,
          gridId: 'grid:87929829394037977',
          seatName: 'Cockpit',
          piloting: true,
          planet: 'EarthLike',
          aglM: 3,
          altitudeM: 4,
          gravityMps2: 9.81,
          onFoot: false,
          isDead: false,
          factionTag: 'HMTST',
          factionId: '123456789',
          optOut: false,
        },
      ],
      1_000,
    );
    const row = store.db.prepare('SELECT * FROM players').get() as Record<string, unknown>;
    expect(typeof row.identity_id).toBe('string');
    expect(row.identity_id).toBe(OWNER_IDENTITY);
    expect(typeof row.steam_id).toBe('string');
    expect(row.steam_id).toBe(OWNER_STEAM);
    // 2^53 + 1: a number would have rounded to 9007199254740992.
    expect(row.character_entity_id).toBe('9007199254740993');
    expect(row.grid_id).toBe('grid:87929829394037977');
    const view = tracker.view({}, 1_000);
    expect(view.online).toHaveLength(1);
    expect(view.online[0]!.identityId).toBe(OWNER_IDENTITY);
    expect(view.online[0]!.steamId).toBe(OWNER_STEAM);
    expect(view.online[0]!.characterEntityId).toBe('9007199254740993');
    expect(view.online[0]!.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(view.online[0]!.piloting).toBe(true);
    expect(view.online[0]!.onFoot).toBe(false);
    store.close();
  });

  it('skips an identity that is not a numeric string instead of storing a rounded one', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    const bad = player({ identityId: '9007199254740993.5', steamId: OWNER_STEAM });
    tracker.ingest([bad as never, player({ identityId: MATE_IDENTITY, steamId: MATE_STEAM }) as never], 1_000);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n).toBe(1);
    expect(tracker.view({}, 1_000).online.map((p) => p.identityId)).toEqual([MATE_IDENTITY]);
    store.close();
  });

  it('keeps the last-known position and its age after a player disappears', () => {
    const store = memoryStore();
    let now = 10_000;
    const tracker = new PlayerTracker(store, () => now);
    tracker.ingest([sample()], 10_000);
    expect(tracker.view({}, 10_000).online).toHaveLength(1);

    // Next frame: the player is gone (disconnect / death). The position must
    // survive as lastKnown with the age of that sample.
    now = 40_000;
    tracker.ingest([], 40_000);
    const view = tracker.view({}, 40_000);
    expect(view.online).toHaveLength(0);
    expect(view.lastKnown).toHaveLength(1);
    expect(view.lastKnown[0]!.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(view.lastKnown[0]!.online).toBe(false);
    expect(view.lastKnown[0]!.source).toBe('LAST_KNOWN');
    expect(view.lastKnown[0]!.ageMs).toBe(30_000);
    expect(view.lastKnown[0]!.lastSeenAt).toBe(10_000);

    // Age grows while nothing changes.
    now = 130_000;
    expect(tracker.view({}, 130_000).lastKnown[0]!.ageMs).toBe(120_000);
    // And it is still there after a fresh PlayerTracker over the same DB
    // (a backend restart).
    const reopened = new PlayerTracker(store, () => 200_000);
    const after = reopened.view({}, 200_000);
    expect(after.online).toHaveLength(0);
    expect(after.lastKnown[0]!.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(after.lastKnown[0]!.ageMs).toBe(190_000);
    store.close();
  });

  it('brings a returning player back online and moves the position', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    tracker.ingest([sample()], 1_000);
    tracker.ingest([], 2_000);
    tracker.ingest([sample({ pos: { x: 9, y: 9, z: 9 } })], 3_000);
    const view = tracker.view({}, 3_000);
    expect(view.online).toHaveLength(1);
    expect(view.online[0]!.pos).toEqual({ x: 9, y: 9, z: 9 });
    expect(view.online[0]!.ageMs).toBe(0);
    expect(view.lastKnown).toHaveLength(0);
    store.close();
  });

  it('marks a position stale once the sample is older than the cutoff', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 0);
    tracker.ingest([sample()], 0);
    const fresh = tracker.view({ staleAfterMs: 30_000 }, 10_000);
    expect(fresh.online[0]!.fresh).toBe(true);
    expect(fresh.online[0]!.source).toBe('GAME');
    const stale = tracker.view({ staleAfterMs: 30_000 }, 45_000);
    expect(stale.online[0]!.fresh).toBe(false);
    expect(stale.online[0]!.source).toBe('LAST_KNOWN');
    store.close();
  });
});

describe('T61 faction filter', () => {
  it('publishes only the owner faction by default', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    tracker.ingest(
      [
        sample(),
        sample({ identityId: MATE_IDENTITY, steamId: MATE_STEAM, displayName: 'Mate', factionTag: 'HMTST' }),
        sample({ identityId: ENEMY_IDENTITY, steamId: ENEMY_STEAM, displayName: 'Enemy', factionTag: 'PIR8' }),
      ],
      1_000,
    );
    const view = tracker.view({ factions: ['HMTST'], includeNoFaction: true }, 1_000);
    expect(view.online.map((p) => p.displayName).sort()).toEqual(['Mate', 'owner']);
    expect(view.online.some((p) => p.factionTag === 'PIR8')).toBe(false);
    expect(view.hiddenByFactionFilter).toBe(1);
    expect(view.filter.ownerFactionOnly).toBe(true);

    // Turning the filter off is explicit and shows everyone.
    const all = tracker.view({ factions: null }, 1_000);
    expect(all.online).toHaveLength(3);
    expect(all.hiddenByFactionFilter).toBe(0);
    store.close();
  });

  it('does not hide a factionless owner when includeNoFaction is on (single-player case)', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    tracker.ingest([sample({ factionTag: null, factionId: null })], 1_000);
    const withNoFaction = tracker.view({ factions: [null], includeNoFaction: true }, 1_000);
    expect(withNoFaction.online).toHaveLength(1);
    const strict = tracker.view({ factions: [null], includeNoFaction: false }, 1_000);
    expect(strict.online).toHaveLength(0);
    expect(strict.hiddenByFactionFilter).toBe(1);
    store.close();
  });

  it('honours the per-player opt-out', () => {
    const store = memoryStore();
    const tracker = new PlayerTracker(store, () => 1_000);
    tracker.ingest([{ ...player({ optOut: true }) } as never], 1_000);
    expect(tracker.view({}, 1_000).online).toHaveLength(0);
    expect(tracker.view({ includeOptOut: true }, 1_000).online).toHaveLength(1);
    store.close();
  });

  it('settings default to owner-faction-only and validate input', () => {
    const store = memoryStore();
    expect(readPlayerSettings(store)).toEqual(PLAYER_SETTINGS_DEFAULTS);
    expect(PLAYER_SETTINGS_DEFAULTS.filterToOwnerFaction).toBe(true);
    const next = writePlayerSettings(store, { filterToOwnerFaction: false }, 'test', 5_000);
    expect(next.filterToOwnerFaction).toBe(false);
    expect(readPlayerSettings(store).filterToOwnerFaction).toBe(false);
    expect(validatePlayerSettings({ staleAfterMs: 1 }, PLAYER_SETTINGS_DEFAULTS).staleAfterMs).toBe(5_000);
    store.close();
  });
});

describe('T61 players over the wire', () => {
  let runtime: Runtime;
  let port: number;
  const clock = makeClock(1_700_000_000_000);

  beforeAll(async () => {
    setDemoEnv();
    runtime = createRuntime({ config: makeConfig({ port: 0, token: TOKEN }), memory: true, clock: clock.now });
    port = await runtime.listen(0);
  });

  afterAll(async () => {
    await runtime.close();
    restoreEnv();
  });

  it('GET /api/demo/players is empty (not an error) when no character was ever reported', async () => {
    const res = await httpRequest<{
      online: unknown[];
      lastKnown: unknown[];
      onlineCount: number;
      filter: { ownerFactionOnly: boolean };
      sampledAt: number;
    }>(port, 'GET', '/api/demo/players', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.online).toEqual([]);
    expect(res.body.lastKnown).toEqual([]);
    expect(res.body.onlineCount).toBe(0);
    expect(res.body.filter.ownerFactionOnly).toBe(true);
  });

  it('requires the bearer token', async () => {
    const res = await httpRequest(port, 'GET', '/api/demo/players');
    expect(res.status).toBe(401);
  });

  it('ingests a telemetry players[] frame and serves it with ids as strings', async () => {
    const plugin = await FakePlugin.connect(port, { token: TOKEN });
    plugin.hello();
    await plugin.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
    plugin.telemetry({
      at: clock.now(),
      players: [
        player(),
        player({
          identityId: MATE_IDENTITY,
          steamId: MATE_STEAM,
          displayName: 'Mate',
          characterEntityId: '144115188075855929',
        }),
        player({ identityId: ENEMY_IDENTITY, steamId: ENEMY_STEAM, displayName: 'Enemy', factionTag: 'PIR8' }),
      ],
    });
    const res = await httpRequest<{
      online: { identityId: string; steamId: string; displayName: string; pos: { x: number }; isOwner: boolean; characterEntityId: string }[];
      lastKnown: unknown[];
      hiddenByFactionFilter: number;
      filter: { ownerFactionOnly: boolean; ownerFactionTag: string | null };
    }>(port, 'GET', '/api/demo/players', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.online.map((p) => p.displayName).sort()).toEqual(['Mate', 'owner']);
    expect(res.body.hiddenByFactionFilter).toBe(1);
    const owner = res.body.online.find((p) => p.displayName === 'owner')!;
    expect(owner.identityId).toBe(OWNER_IDENTITY);
    expect(typeof owner.identityId).toBe('string');
    expect(owner.steamId).toBe(OWNER_STEAM);
    expect(owner.isOwner).toBe(true);
    expect(owner.pos.x).toBeCloseTo(1000.25, 2);

    // all=1 is the explicit override.
    const all = await httpRequest<{ online: unknown[] }>(port, 'GET', '/api/demo/players?all=1', undefined, TOKEN);
    expect(all.body.online).toHaveLength(3);

    // A second frame with the enemy gone and the owner moved.
    plugin.telemetry({
      at: clock.now(),
      players: [player({ pos: { x: 1005, y: 2000.5, z: -3000.75 } })],
    });
    const moved = await httpRequest<{
      online: { displayName: string; pos: { x: number } }[];
      lastKnown: { displayName: string; ageMs: number; source: string }[];
    }>(port, 'GET', '/api/demo/players', undefined, TOKEN);
    expect(moved.body.online).toHaveLength(1);
    expect(moved.body.online[0]!.pos.x).toBe(1005);
    const mate = moved.body.lastKnown.find((p) => p.displayName === 'Mate')!;
    expect(mate.ageMs).toBe(0);
    expect(mate.source).toBe('LAST_KNOWN');
    await plugin.close();
  });

  it('/api/demo/state carries a compact players section', async () => {
    const res = await httpRequest<{
      players: { enabled: boolean; onlineCount: number; lastKnownCount: number; online: { displayName: string }[]; filter: { ownerFactionOnly: boolean } };
    }>(port, 'GET', '/api/demo/state', undefined, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.players.enabled).toBe(true);
    expect(res.body.players.onlineCount).toBeGreaterThanOrEqual(0);
    expect(res.body.players.filter.ownerFactionOnly).toBe(true);
    expect(Array.isArray(res.body.players.online)).toBe(true);
  });

  it('PUT /api/demo/players/settings flips the faction filter and is audited', async () => {
    const put = await httpRequest<{ settings: { filterToOwnerFaction: boolean } }>(
      port,
      'PUT',
      '/api/demo/players/settings',
      { filterToOwnerFaction: false },
      TOKEN,
    );
    expect(put.status).toBe(200);
    expect(put.body.settings.filterToOwnerFaction).toBe(false);
    const audit = runtime.store.db
      .prepare(`SELECT * FROM audit WHERE action = 'player_settings' ORDER BY at DESC LIMIT 1`)
      .get() as { actor: string } | undefined;
    expect(audit).toBeDefined();
    // Put it back so the filter test above stays order-independent.
    await httpRequest(port, 'PUT', '/api/demo/players/settings', { filterToOwnerFaction: true }, TOKEN);
  });
});
