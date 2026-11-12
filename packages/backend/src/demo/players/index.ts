import type { Store } from '../../store.js';
import type { PluginPlayer, Vec3 } from '@se-rts/schemas';

/**
 * T61 player positions.
 *
 * The plugin reports every online character in the telemetry frame
 * (`players[]`, ids as strings). This module keeps two things:
 *
 *   * an in-memory map of who is online right now, replaced on every frame, so
 *     a player who is kicked/logged out disappears on the next sample without
 *     a second message;
 *   * a `players` row per identity with the LAST KNOWN position and the time of
 *     that sample, so "where was the owner when he fell off" survives a disconnect
 *     and a backend restart. `ageMs` on the API is `now - lastSeenAt`.
 *
 * Privacy (T61): the plugin only ever sends identities the server knows about;
 * the API additionally marks each player with their faction and filters to the
 * owner's faction by default (settings `players.filterToOwnerFaction`). Other
 * factions are never published on the world-geometry service - this module is only read
 * by the demo routes behind the bearer token.
 */

export interface PlayerSample {
  identityId: string;
  steamId: string;
  displayName: string;
  characterEntityId: string | null;
  pos: Vec3 | null;
  vel: Vec3 | null;
  gridId: string | null;
  seatName: string | null;
  piloting: boolean;
  planet: string | null;
  aglM: number | null;
  altitudeM: number | null;
  gravityMps2: number | null;
  onFoot: boolean;
  isDead: boolean;
  factionTag: string | null;
  factionId: string | null;
}

export interface PlayerSnapshot extends PlayerSample {
  online: boolean;
  /** When this sample was taken (epoch ms). */
  lastSeenAt: number;
  /** How old the position is; the AGE the UI shows. */
  ageMs: number;
  /** True while the position is from the live sample, false once it is stale. */
  fresh: boolean;
  firstSeenAt: number;
  /** last time the character was actually reported, even if the sample aged. */
  lastOnlineAt: number | null;
  optOut: boolean;
  isOwner: boolean;
  source: 'GAME' | 'LAST_KNOWN';
}

export interface PlayerView {
  online: PlayerSnapshot[];
  lastKnown: PlayerSnapshot[];
  /** Players hidden by the faction filter (count only; never their data). */
  hiddenByFactionFilter: number;
  filter: { ownerFactionOnly: boolean; ownerFactionTag: string | null };
  onlineCount: number;
  sampledAt: number;
}

export interface PlayerFilterOptions {
  /** Only these faction tags are allowed through; null/empty = no filter. */
  factions?: (string | null)[] | null;
  /** Include players with no faction at all (the single-player case). */
  includeNoFaction?: boolean;
  /** Include players who opted out (owner's own account). */
  includeOptOut?: boolean;
  /** A position older than this is no longer "fed" to the map. */
  staleAfterMs?: number;
}

interface Row {
  identity_id: string;
  steam_id: string;
  display_name: string;
  character_entity_id: string | null;
  pos_json: string | null;
  vel_json: string | null;
  grid_id: string | null;
  seat_name: string | null;
  piloting: number;
  planet: string | null;
  agl_m: number | null;
  altitude_m: number | null;
  gravity_mps2: number | null;
  on_foot: number;
  is_dead: number;
  faction_tag: string | null;
  faction_id: string | null;
  online: number;
  first_seen_at: number;
  last_seen_at: number;
  last_online_at: number | null;
}

const DEFAULT_STALE_AFTER_MS = 30_000;

export class PlayerTracker {
  /** identityId -> the sample from the most recent telemetry frame. */
  private live = new Map<string, PlayerSample>();
  private liveAt = 0;
  /** T61 per-player opt-out reported by the plugin (sticky for this process). */
  private optOut = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Record one telemetry frame's `players[]`. */
  ingest(players: PluginPlayer[], at: number): void {
    const next = new Map<string, PlayerSample>();
    for (const raw of players) {
      // Defensive: the schema already says string, but a plugin built before
      // T61 could send a number and JSON.parse would have rounded it. Refuse
      // rather than store a wrong id.
      const identityId = typeof raw.identityId === 'string' ? raw.identityId : String(raw.identityId);
      if (!/^[0-9]+$/.test(identityId)) continue;
      const steamId = typeof raw.steamId === 'string' ? raw.steamId : String(raw.steamId);
      const sample: PlayerSample = {
        identityId,
        steamId,
        displayName: raw.displayName ?? '',
        characterEntityId: raw.characterEntityId ?? null,
        pos: raw.pos ?? null,
        vel: raw.vel ?? null,
        gridId: raw.gridId ?? null,
        seatName: raw.seatName ?? null,
        piloting: raw.piloting ?? false,
        planet: raw.planet ?? null,
        aglM: raw.aglM ?? null,
        altitudeM: raw.altitudeM ?? null,
        gravityMps2: raw.gravityMps2 ?? null,
        onFoot: raw.onFoot ?? true,
        isDead: raw.isDead ?? false,
        factionTag: raw.factionTag ?? null,
        factionId: raw.factionId ?? null,
      };
      if (raw.optOut) this.optOut.add(identityId);
      next.set(identityId, sample);
      this.persist(sample, at);
    }
    // Anyone no longer in the frame is offline: keep their last-known row.
    for (const id of this.live.keys()) if (!next.has(id)) this.markOffline(id);
    this.live = next;
    this.liveAt = at;
  }

  private persist(sample: PlayerSample, at: number): void {
    const existing = this.store.db
      .prepare('SELECT first_seen_at FROM players WHERE identity_id = ?')
      .get(sample.identityId) as { first_seen_at: number } | undefined;
    const firstSeen = existing?.first_seen_at ?? at;
    this.store.db
      .prepare(
        `INSERT INTO players (
           identity_id, steam_id, display_name, character_entity_id, pos_json, vel_json,
           grid_id, seat_name, piloting, planet, agl_m, altitude_m, gravity_mps2,
           on_foot, is_dead, faction_tag, faction_id, online, first_seen_at,
           last_seen_at, last_online_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(identity_id) DO UPDATE SET
           steam_id = excluded.steam_id,
           display_name = excluded.display_name,
           character_entity_id = excluded.character_entity_id,
           pos_json = excluded.pos_json,
           vel_json = excluded.vel_json,
           grid_id = excluded.grid_id,
           seat_name = excluded.seat_name,
           piloting = excluded.piloting,
           planet = excluded.planet,
           agl_m = excluded.agl_m,
           altitude_m = excluded.altitude_m,
           gravity_mps2 = excluded.gravity_mps2,
           on_foot = excluded.on_foot,
           is_dead = excluded.is_dead,
           faction_tag = excluded.faction_tag,
           faction_id = excluded.faction_id,
           online = 1,
           last_seen_at = excluded.last_seen_at,
           last_online_at = excluded.last_online_at`,
      )
      .run(
        sample.identityId,
        sample.steamId,
        sample.displayName,
        sample.characterEntityId,
        sample.pos ? JSON.stringify(sample.pos) : null,
        sample.vel ? JSON.stringify(sample.vel) : null,
        sample.gridId,
        sample.seatName,
        sample.piloting ? 1 : 0,
        sample.planet,
        sample.aglM,
        sample.altitudeM,
        sample.gravityMps2,
        sample.onFoot ? 1 : 0,
        sample.isDead ? 1 : 0,
        sample.factionTag,
        sample.factionId,
        firstSeen,
        at,
        at,
      );
  }

  /** Flip a known identity offline, keeping its last-known position. */
  markOffline(identityId: string): void {
    this.store.db.prepare('UPDATE players SET online = 0 WHERE identity_id = ?').run(identityId);
  }

  /** Everything the tracker knows, filtered for the map. */
  view(options: PlayerFilterOptions = {}, now = this.clock()): PlayerView {
    const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const allow = options.factions?.length ? new Set(options.factions.map((f) => (f ?? '').toUpperCase())) : null;
    const includeNoFaction = options.includeNoFaction ?? false;
    const includeOptOut = options.includeOptOut ?? false;

    const online: PlayerSnapshot[] = [];
    for (const sample of this.live.values()) {
      const row = this.row(sample.identityId);
      if (!row) continue;
      online.push(this.toSnapshot(row, this.liveAt, now, true));
    }

    // Rows with no live sample: last-known positions (age included).
    const liveIds = new Set(this.live.keys());
    const lastKnown: PlayerSnapshot[] = [];
    for (const row of this.rows()) {
      if (liveIds.has(row.identity_id)) continue;
      lastKnown.push(this.toSnapshot(row, row.last_seen_at, now, false));
    }

    const passes = (p: PlayerSnapshot): boolean => {
      if (!includeOptOut && this.optOut.has(p.identityId)) return false;
      if (!allow) return true;
      if (!p.factionTag) return includeNoFaction;
      return allow.has(p.factionTag.toUpperCase());
    };

    const visibleOnline = online.filter(passes).sort(byName);
    const visibleLast = lastKnown.filter(passes).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const p of [...visibleOnline, ...visibleLast]) {
      p.fresh = p.online && now - p.lastSeenAt <= staleAfter;
      p.source = p.fresh ? 'GAME' : 'LAST_KNOWN';
    }
    return {
      online: visibleOnline,
      lastKnown: visibleLast,
      hiddenByFactionFilter: online.length + lastKnown.length - visibleOnline.length - visibleLast.length,
      filter: {
        ownerFactionOnly: Boolean(allow),
        ownerFactionTag: allow ? [...allow][0] ?? null : null,
      },
      onlineCount: visibleOnline.length,
      sampledAt: this.liveAt,
    };
  }

  /**
   * The owner's faction tag as observed from the owner's own live sample. Used
   * as the default filter when settings have no explicit tag; a backend that
   * has never seen the owner cannot guess it and reports null (no filter
   * beyond opt-out).
   */
  ownerFactionTag(ownerSteamId: string): string | null {
    for (const sample of this.live.values()) {
      if (sample.steamId === ownerSteamId && sample.factionTag) return sample.factionTag;
    }
    const row = this.store.db
      .prepare('SELECT faction_tag FROM players WHERE steam_id = ? AND faction_tag IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1')
      .get(ownerSteamId) as { faction_tag: string | null } | undefined;
    return row?.faction_tag ?? null;
  }

  /**
   * Compact block for /api/demo/state: who is online this instant with the
   * age of the sample, plus a count of remembered last-known rows. Full
   * history and ages live on GET /api/demo/players.
   */
  summary(now: number = this.clock()): {
    online: { identityId: string; steamId: string; displayName: string; pos: Vec3 | null; planet: string | null; aglM: number | null; gridId: string | null; piloting: boolean; onFoot: boolean; isDead: boolean; ageMs: number; factionTag: string | null }[];
    onlineCount: number;
    lastKnownCount: number;
    sampledAt: number;
  } {
    const rows = [...this.live.values()].map((sample) => ({
      identityId: sample.identityId,
      steamId: sample.steamId,
      displayName: sample.displayName,
      pos: sample.pos,
      planet: sample.planet,
      aglM: sample.aglM,
      gridId: sample.gridId,
      piloting: sample.piloting,
      onFoot: sample.onFoot,
      isDead: sample.isDead,
      ageMs: Math.max(0, now - this.liveAt),
      factionTag: sample.factionTag,
    }));
    const lastKnownCount =
      (this.store.db.prepare('SELECT COUNT(*) AS n FROM players WHERE online = 0').get() as { n: number }).n;
    return { online: rows, onlineCount: rows.length, lastKnownCount, sampledAt: this.liveAt };
  }

  /**
   * One player by identityId OR steamId, live frame first, then the last-known
   * row. Used by come-to-me, which needs the position AND how old it is (a
   * 5-minute-old position is not where the player is standing now).
   */
  snapshot(idOrSteam: string, now = this.clock()): PlayerSnapshot | null {
    const key = idOrSteam.trim();
    if (!key) return null;
    for (const sample of this.live.values()) {
      if (sample.identityId === key || sample.steamId === key) {
        const row = this.row(sample.identityId);
        if (row) return this.toSnapshot(row, this.liveAt, now, true);
      }
    }
    const row =
      (this.store.db.prepare('SELECT * FROM players WHERE identity_id = ?').get(key) as Row | undefined) ??
      (this.store.db
        .prepare('SELECT * FROM players WHERE steam_id = ? ORDER BY last_seen_at DESC LIMIT 1')
        .get(key) as Row | undefined) ??
      null;
    if (!row) return null;
    const online = this.live.has(row.identity_id);
    return this.toSnapshot(row, online ? this.liveAt : row.last_seen_at, now, online);
  }

  private rows(): Row[] {
    return this.store.db
      .prepare('SELECT * FROM players ORDER BY last_seen_at DESC')
      .all() as Row[];
  }

  private row(identityId: string): Row | null {
    return (this.store.db.prepare('SELECT * FROM players WHERE identity_id = ?').get(identityId) as Row | undefined) ?? null;
  }

  private toSnapshot(row: Row, seenAt: number, now: number, online: boolean): PlayerSnapshot {
    return {
      identityId: row.identity_id,
      steamId: row.steam_id,
      displayName: row.display_name,
      characterEntityId: row.character_entity_id,
      pos: row.pos_json ? (JSON.parse(row.pos_json) as Vec3) : null,
      vel: row.vel_json ? (JSON.parse(row.vel_json) as Vec3) : null,
      gridId: row.grid_id,
      seatName: row.seat_name,
      piloting: row.piloting === 1,
      planet: row.planet,
      aglM: row.agl_m,
      altitudeM: row.altitude_m,
      gravityMps2: row.gravity_mps2,
      onFoot: row.on_foot === 1,
      isDead: row.is_dead === 1,
      factionTag: row.faction_tag,
      factionId: row.faction_id,
      online,
      lastSeenAt: seenAt,
      ageMs: Math.max(0, now - seenAt),
      fresh: online,
      firstSeenAt: row.first_seen_at,
      lastOnlineAt: row.last_online_at,
      optOut: this.optOut.has(row.identity_id),
      isOwner: false,
      source: online ? 'GAME' : 'LAST_KNOWN',
    };
  }
}

function byName(a: PlayerSnapshot, b: PlayerSnapshot): number {
  return a.displayName.localeCompare(b.displayName) || a.identityId.localeCompare(b.identityId);
}
