/**
 * Auto-provisioning for owner-tagged grids (test server only).
 *
 * The plugin exposes two generic, data-driven actions:
 *   - `get_block_props`  — every terminal property of a block, with its range
 *   - `set_block_props`  — write properties / run actions, with read-back
 *
 * Nothing here hard-codes a block setting: profiles live in `profiles.json` and
 * are sent to the plugin as data, so a new setting is a JSON edit plus a backend
 * restart — never a plugin rebuild or a game-server restart.
 *
 * Rule of the road: a tagged grid is only touched when its BigOwner is the
 * owner identity. Anything else is skipped with a reason and audited.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { PluginHub } from '../../pluginHub.js';
import { decideOrderChannel } from '../channel.js';
import { resolveSurvivalMode, SURVIVAL_REASON } from '../survival.js';
import {
  resolveGridRole,
  isAutomatableRole,
  isBaseRole,
  shipRoles,
  hintsFromPluginGrid,
  type RoleHint,
  type RoleResolution,
  type ShipRole,
} from '../roles.js';
import { isLiveInstance } from '../ownership.js';
import { waitForOrderResult } from '../../orderResults.js';

export const BASE_TAG = '[HERMES-BASE]';
export const TEST_TAG = '[HERMES-TEST]';
/**
 * Steady-state pass interval, ms (sim-speed audit #3). 10 s was provisioning's
 * default and it re-read the whole tagged set six times a minute forever. 30 s
 * is enough for config/roles drift; anything that needs to be immediate asks
 * for a pass (`requestPass`: new grid in telemetry, an owner order, a plugin
 * reconnect) instead of shortening this.
 */
export const POLL_MS = 30_000;
/** Two immediate triggers inside this window collapse into one pass. */
export const IMMEDIATE_PASS_GAP_MS = 5_000;
/**
 * `laser_state` backoff (sim-speed audit #4). The audit's shape is "2 s -> 30 s
 * after 3 unchanged reads"; the base cadence here is the 30 s pass, so the
 * backed-off cadence is every third pass (90 s). A connected/disconnected link
 * cannot change without a command, and a command (or an open mission) forces
 * the grid due again immediately.
 */
export const LASER_UNCHANGED_READS = 3;
export const LASER_SLOW_MS = 90_000;
const KV_GRIDS = 'provision:grids';
/**
 * How long an UNREAD antenna state may hold command authority on its last good
 * reading, ms (2026-11-11). A read flap must not revoke a live mission; a real
 * outage must not keep a dead control source alive either.
 */
export const PROVISION_RADIO_GOOD_MS = 60_000;

/** Live capability snapshot (radio radius, laser count, mass) for the gate. */
const KV_CAPABILITIES = 'provision:capabilities';
/** Live `laser_state` sample; Connected pairs become GAME edges in the graph. */
const KV_LASERS = 'provision:lasers';
const FAILURE_RETRY_MS = 5 * 60_000;

export class ProvisionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: string[],
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

export interface ProvisionDeps {
  config: Config;
  store: Store;
  hub: PluginHub;
  clock?: () => number;
  /**
   * Optional post-pass hook (T9 naming). Receives the same tagged-grid list the
   * pass just scanned, so the naming service sees live block counts without a
   * second `list_tagged` call. Must not throw: provisioning owns its own result.
   */
  onGrids?: (grids: TaggedGrid[]) => Promise<void>;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TaggedGrid {
  gridId: string;
  name: string;
  tags: string[];
  /** Ship-role hints scanned from ANY block name / CustomData (plugin >= roles). */
  roleHints?: RoleHint[];
  roleTags?: string[];
  role?: ShipRole | null;
  owner: string | null;
  owners: string[];
  /**
   * Faction tag of each big owner, read by the plugin
   * (`MyAPIGateway.Session.Factions.TryGetPlayerFaction`). Null entries mean the
   * owner has no faction or the plugin could not read it.
   */
  ownerFactions?: (string | null)[] | null;
  pbName: string | null;
  position: Vec3 | null;
  blocksTotal?: number;
  radioCount?: number;
  laserCount?: number;
  laserRangeM?: number | null;
  massKg?: number;
  isStatic?: boolean;
  /** True when the payload carried profile-derived scalars (thrust/TWR). */
  profiled?: boolean;
  /**
   * Blocks carrying a CustomName/CustomData line, from the same scan. This is
   * where role tags live (`[HERMES-ROLE:...]`), so the roles backend reads
   * them here instead of asking for a per-grid profile.
   */
  blocks?: {
    id?: string;
    name?: string;
    customName?: string;
    customData?: string;
    subtype?: string;
  }[];
  lockedBy?: {
    landingGears?: number;
    landingGearsLocked?: number;
    connectors?: number;
    connectorsConnected?: number;
    totalLocked?: number;
  };
}

export type ProfileKey = 'BASE' | 'DRONE';

interface Step {
  name: string;
  filter: Record<string, unknown>;
  props: Record<string, unknown>;
  actions?: string[];
}

interface ProfilesFile {
  version: number;
  owner: { steamId: string; identityId: string };
  tags: Record<string, string>;
  enums: Record<string, Record<string, number>>;
  profiles: Record<ProfileKey, { description: string; steps: Step[] }>;
}

export interface ProvisionStepResult {
  name: string;
  blocks: number;
  applied: number;
  errors: string[];
}

export interface GridRecord {
  gridId: string;
  name: string;
  profile: ProfileKey;
  tag: string;
  owner: string | null;
  signature: string;
  appliedAt: number;
  changed: boolean;
  ok: boolean;
  steps: ProvisionStepResult[];
  props: { step: string; block: string; id: string; before: unknown; after: unknown }[];
  /**
   * Radio read-back. `read` says WHICH fact this is, and that distinction is
   * the 2026-11-11 comms-gate bug:
   *   * `read`   - the profile's radio step answered and at least one antenna
   *                block was written/read back,
   *   * `absent` - the scan and the step agree the grid has ZERO antennas
   *                (a world fact: build one),
   *   * `unread` - the step failed or the plugin did not answer. The radio
   *                state is UNKNOWN, which is not the same as absent, and must
   *                never revoke an established authorisation on the spot.
   */
  radio: {
    count: number;
    broadcasting: boolean | null;
    radiusM: number | null;
    state?: 'read' | 'absent' | 'unread';
    /** When this reading was taken, ms. */
    readAt?: number;
    /** Resolved state after the last-known-good grace, for the gate. */
    publishedState?: 'read' | 'absent' | 'unread' | 'last-known-good';
  };
  /** Last reading that actually saw an antenna (survives an unread poll). */
  lastGoodRadio?: { broadcasting: boolean; radiusM: number; at: number } | null;
  /** Live hardware counts from the same `list_tagged` scan. */
  hardware?: {
    blocksTotal: number | null;
    radioCount: number | null;
    laserCount: number | null;
    massKg: number | null;
    isStatic: boolean | null;
  };
}

export interface ProvisionIssue {
  at: number;
  gridId: string | null;
  reason: string;
}

export interface ProvisionLastRun {
  at: number;
  ok: boolean;
  scanned: number;
  provisioned: number;
  skipped: number;
  errors: string[];
}

export interface ProvisionState {
  bases: GridRecord[];
  drones: GridRecord[];
  lastRun: ProvisionLastRun | null;
  issues: ProvisionIssue[];
  owner: { identityId: string; steamId: string };
  pollMs: number;
  labels: string[];
  profiles: Record<ProfileKey, { description: string; steps: string[] }>;
}

interface PluginTestResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

let cachedProfiles: ProfilesFile | null = null;

/**
 * Plugin actions that are ROUTINE POLLER reads: the provisioner pass and the
 * power/naming pollers call them on a few-second cadence, per grid, forever.
 * Their order/result/ack rows go to the routine audit channel (hidden from
 * `/api/audit`, pruned after an hour) instead of drowning the flight evidence:
 * measured 2026-11-10, poller traffic was ~90 % of the audit table and 2 000
 * rows covered four minutes, so a landing's audit trail was gone before the
 * run ended. Failures are always audited, on the business channel.
 */
export const ROUTINE_PLUGIN_ACTIONS: ReadonlySet<string> = new Set([
  'radio_links',
  'laser_state',
  'list_tagged',
  'list_players',
  'planets',
  'identity',
  'gps_list',
  'profile',
  // T79: the live sim-speed sampler reads this every few seconds.
  'sim_ratio',
]);

/**
 * Prefixes of orders the control stack issues on a timer rather than on a
 * player's behalf. Their acks must not count as "an owner order went out":
 * runtime.ts wakes a provisioning pass on every non-routine ack, so a 1 Hz
 * poller ack would otherwise re-trigger `list_tagged` every coalescing window
 * (measured 2026-11-11 on the test world: one pass every 5 s instead of 30 s,
 * and 12 list_tagged/min against a planned 2).
 */
export const ROUTINE_ORDER_PREFIXES: readonly string[] = [
  'provision:',
  'demo:power:',
  'demo:probe:',
  'demo:profile:',
];

/** True for a poller/provisioner order (never in the `orders` table). */
export function isRoutineOrderId(orderId: unknown): boolean {
  return (
    typeof orderId === 'string' && ROUTINE_ORDER_PREFIXES.some((p) => orderId.startsWith(p))
  );
}

export function loadProfiles(): ProfilesFile {
  if (cachedProfiles) return cachedProfiles;
  const raw = readFileSync(new URL('./profiles.json', import.meta.url), 'utf8');
  cachedProfiles = JSON.parse(raw) as ProfilesFile;
  return cachedProfiles;
}

function nowOf(deps: ProvisionDeps): number {
  return deps.clock?.() ?? Date.now();
}

/**
 * Send one plugin action order and wait for its `order_result` audit row.
 * Legitimate actions ride the production channel (`action`); admin/test-only
 * names keep `test` and are refused in survival mode (T75). Same shape as the
 * designer proxy: the plugin executes on the game thread.
 */
export async function callPlugin(
  deps: ProvisionDeps,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<PluginTestResult> {
  if (!deps.hub.isConnected()) {
    throw new ProvisionError(503, 'plugin_offline', 'the test-server plugin is not connected');
  }
  const now = nowOf(deps);
  const orderId = `provision:${action}:${randomUUID()}`;
  // T75: legitimate actions use the production channel in both modes; an
  // admin/test-only action in survival mode is refused before the wire.
  const decision = decideOrderChannel('test', action, resolveSurvivalMode());
  if (decision.refused) {
    deps.store.audit({
      actor: 'provisioner',
      action: 'survival_refused',
      subject: orderId,
      detail: { action, orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at: now,
    });
    throw new ProvisionError(409, SURVIVAL_REASON, `not available in survival build: ${action}`);
  }
  const payload = {
    schemaVersion: 1 as const,
    type: 'order' as const,
    orderId,
    orderType: decision.orderType,
    entityId: 'grid:0',
    params: { action, entityId: 'grid:0', ...params },
    tick: 0,
    issuedAt: now,
    expiresAt: now + timeoutMs,
  };
  const routine = ROUTINE_PLUGIN_ACTIONS.has(action);
  deps.store.audit({
    actor: 'provisioner',
    action: 'provision_plugin_order',
    subject: orderId,
    detail: { action, params },
    at: now,
    routine,
  });
  // Cursor before the order leaves: a result written during `send` (tests, a
  // synchronous hub) still lands above it.
  const sinceRowid = deps.store.maxAuditRowid();
  if (!deps.hub.send(payload)) {
    deps.store.audit({
      actor: 'provisioner',
      action: 'provision_plugin_order_failed',
      subject: orderId,
      detail: { action, reason: 'the plugin socket refused the order' },
      at: now,
    });
    throw new ProvisionError(503, 'plugin_send_failed', 'the plugin socket refused the order');
  }
  // Event-first (sim-speed audit #7): the order_result frame wakes this wait
  // synchronously; the store is only read for rows newer than the cursor, at
  // most once a second, and only while this order is outstanding.
  const hit = await waitForOrderResult(deps.store, orderId, timeoutMs, { sinceRowid });
  if (hit) return hit;
  deps.store.audit({
    actor: 'provisioner',
    action: 'provision_plugin_order_failed',
    subject: orderId,
    detail: { action, reason: `no order_result within ${timeoutMs} ms` },
    at: nowOf(deps),
  });
  throw new ProvisionError(504, 'plugin_timeout', `plugin did not return a result for ${action} within ${timeoutMs} ms`);
}

/** Resolve profile values that are enum names (e.g. battery ChargeMode). */
function resolveProps(profiles: ProfilesFile, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string') {
      const table = profiles.enums[key];
      const mapped = table?.[value.toLowerCase()];
      if (mapped !== undefined) {
        out[key] = mapped;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function sameTag(tags: string[], tag: string): boolean {
  return tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

function tagOf(profiles: ProfilesFile, tags: string[]): ProfileKey | null {
  if (sameTag(tags, profiles.tags.BASE ?? BASE_TAG)) return 'BASE';
  if (sameTag(tags, profiles.tags.DRONE ?? TEST_TAG)) return 'DRONE';
  return null;
}

/**
 * Which profile (if any) a grid may receive. The SHARED role resolution decides
 * it (see `roles.ts`): a PERSONAL grid is never provisioned, an OFF grid is
 * never touched, a BASE grid (any alias, on any block or `HERMES_ROLE=base`)
 * gets the station profile, and a MANAGED grid gets the drone profile whatever
 * spelling set it (`[HERMES-MANAGED]`, `[MANAGED]`, the legacy `[HERMES-TEST]`,
 * `HERMES_ROLE=managed`).
 *
 * `resolution` is the registry's resolution (with the live ownership policy
 * applied) and should be passed whenever one exists. Without it the role is
 * resolved from the grid row alone, test-default so a pure call can never
 * mistake "no policy" for "live and foreign" - the untagged default still never
 * provisions anything.
 */
export function profileForGrid(
  profiles: ProfilesFile,
  grid: TaggedGrid,
  resolution?: RoleResolution,
): ProfileKey | null {
  const res = resolution ?? resolveGridRole(grid, { live: false });
  if (res.role === 'personal' || res.role === 'off') return null;
  if (isBaseRole(res)) return 'BASE';
  if (isAutomatableRole(res)) return 'DRONE';
  // Legacy shape: no role hints in the payload at all (old plugin, or a grid
  // whose mark was only the PB name the plugin reported as a tag).
  return tagOf(profiles, grid.tags ?? []);
}

export class Provisioner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private inFlight: Promise<ProvisionLastRun> | null = null;
  private records = new Map<string, GridRecord>();
  private issues: ProvisionIssue[] = [];
  private lastRun: ProvisionLastRun | null = null;
  private readonly issueKeys = new Set<string>();
  /** Per-grid `laser_state` cadence (sim-speed audit #4). */
  private readonly laserCadence = new Map<string, { sig: string; unchanged: number; nextDueAt: number }>();
  /** Grids a laser/link command touched: their next sample is due now. */
  private readonly laserImmediate = new Set<string>();
  private lastImmediateAt = 0;
  private immediatePasses = 0;
  /** Grid ids from the most recent `list_tagged` scan. */
  private scannedGridIds = new Set<string>();

  constructor(private readonly deps: ProvisionDeps) {
    this.load();
  }

  private load(): void {
    const raw = this.deps.store.getKv(KV_GRIDS);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as GridRecord[];
      for (const rec of parsed) this.records.set(rec.gridId, rec);
    } catch {
      /* corrupt cache: start clean, the next poll re-applies */
    }
  }

  private save(): void {
    this.deps.store.setKv(KV_GRIDS, JSON.stringify([...this.records.values()]));
  }

  private issue(gridId: string | null, reason: string): void {
    const key = `${gridId ?? '-'}::${reason}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.issues.unshift({ at: nowOf(this.deps), gridId, reason });
    if (this.issues.length > 50) this.issues.length = 50;
  }

  /**
   * Grids the automatic features own, with the profile they get. The shared
   * role resolution decides (any BASE/MANAGED spelling), and on the live
   * instance the registry already turned a foreign grid OFF, so a copied tag on
   * somebody else's hull never becomes a capability row.
   */
  private ownedGrids(grids: TaggedGrid[], profiles: ProfilesFile): { grid: TaggedGrid; profile: ProfileKey }[] {
    const out: { grid: TaggedGrid; profile: ProfileKey }[] = [];
    for (const grid of grids) {
      const profile = profileForGrid(profiles, grid, shipRoles.resolution(grid.gridId));
      if (!profile) continue;
      const ownerIds = [grid.owner, ...(grid.owners ?? [])].filter((v): v is string => typeof v === 'string');
      // Test instance keeps the legacy owner-identity rule; live relies on the
      // registry's policy (identity OR faction).
      if (!isLiveInstance() && !ownerIds.includes(profiles.owner.identityId)) continue;
      out.push({ grid, profile });
    }
    return out;
  }

  /**
   * Publish the capability snapshot the gate reads. Radio radius/state are the
   * values the profile wrote and read back (GAME); laser count and mass come
   * from the same live `list_tagged` scan. Written even when a grid is skipped
   * as unchanged, so the snapshot is refreshed every poll.
   */
  private writeCapabilities(grids: TaggedGrid[], profiles: ProfilesFile, at: number): void {
    let changed = false;
    const rows = this.ownedGrids(grids, profiles).map(({ grid, profile }) => {
      const record = this.records.get(grid.gridId);
      const radio = this.publishRadio(grid, profile, record, at);
      if (record && record.radio.publishedState !== radio.radioState) {
        record.radio.publishedState = radio.radioState;
        changed = true;
      }
      // The role travels with the capability row so the gate/network explain
      // "base" vs "managed" from the same decision that chose the profile
      // (a legacy long tag in `tags` is still a BASE decision).
      const role: ShipRole = profile === 'BASE' ? 'base' : 'managed';
      return {
        gridId: grid.gridId,
        name: record?.name ?? grid.name ?? grid.pbName ?? grid.gridId,
        profile,
        role,
        broadcasting: radio.broadcasting,
        radioRadiusM: radio.radioRadiusM,
        // WHICH fact this is + how old, so the gate and the audit can tell
        // "no antenna" from "could not read" (2026-11-11).
        radioState: radio.radioState,
        radioAgeMs: radio.radioAgeMs,
        laserCount: grid.laserCount ?? record?.hardware?.laserCount ?? 0,
        massKg: grid.massKg ?? record?.hardware?.massKg ?? null,
        isStatic: grid.isStatic ?? record?.hardware?.isStatic ?? null,
        updatedAt: at,
      };
    });
    this.deps.store.setKv(KV_CAPABILITIES, JSON.stringify({ at, grids: rows }));
    if (changed) this.save();
  }

  /**
   * What the gate may be told about this grid's antenna, and why.
   *
   * `absent` is a world fact and revokes on the spot (with an audit row naming
   * the base, because the owner has to build an antenna). `unread` is NOT a
   * fact: the last-known-good reading is kept for
   * `PROVISION_RADIO_GOOD_MS` so a plugin hiccup cannot drop command authority
   * mid-mission, and after that it is revoked with an explicit audit row.
   */
  private publishRadio(
    grid: TaggedGrid,
    profile: ProfileKey,
    record: GridRecord | undefined,
    at: number,
  ): { broadcasting: boolean | null; radioRadiusM: number | null; radioState: GridRecord['radio']['state'] | 'last-known-good'; radioAgeMs: number | null } {
    const state = record?.radio.state ?? 'unread';
    const readAt = record?.radio.readAt ?? record?.appliedAt ?? null;
    const ageMs = readAt === null ? null : Math.max(0, at - readAt);
    if (state === 'read') {
      return {
        broadcasting: record?.radio.broadcasting ?? null,
        radioRadiusM: record?.radio.radiusM ?? null,
        radioState: 'read',
        radioAgeMs: ageMs,
      };
    }
    if (state === 'absent') {
      this.noteNoAntenna(grid, profile);
      return { broadcasting: false, radioRadiusM: null, radioState: 'absent', radioAgeMs: ageMs };
    }
    const good = record?.lastGoodRadio ?? null;
    if (good && at - good.at <= PROVISION_RADIO_GOOD_MS) {
      this.noteRadioUnread(grid, profile, at - good.at);
      return {
        broadcasting: good.broadcasting,
        radioRadiusM: good.radiusM,
        radioState: 'last-known-good',
        radioAgeMs: Math.max(0, at - good.at),
      };
    }
    this.noteRadioRevoked(grid, profile, good ? at - good.at : null);
    return { broadcasting: null, radioRadiusM: null, radioState: 'unread', radioAgeMs: ageMs };
  }

  /** Once per grid: the base has no antenna. That is the owner's to fix. */
  private noteNoAntenna(grid: TaggedGrid, profile: ProfileKey): void {
    if (profile !== 'BASE') return;
    const key = `no-antenna:${grid.gridId}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.issue(
      grid.gridId,
      `${grid.name || grid.gridId} is tagged [HERMES-BASE] but has NO antenna block, so it cannot be a control ` +
        'source: no ship can be reached through it. Build a radio antenna (or laser antenna) on the base.',
    );
    this.deps.store.audit({
      actor: 'provisioner',
      action: 'provision_base_no_antenna',
      subject: grid.gridId,
      detail: {
        gridName: grid.name || grid.gridId,
        profile,
        radioCount: grid.radioCount ?? null,
        antennaBlocks: 0,
        controlSource: false,
        worldFact: true,
        note:
          'the base has no antenna block (the scan and the radio read-back agree): it is not a control source and ' +
          'no order can be routed through it until one is built. Nothing is faked.',
      },
      at: nowOf(this.deps),
    });
  }

  /** Once per grid per unread episode: authority is held on the last good read. */
  private noteRadioUnread(grid: TaggedGrid, profile: ProfileKey, ageMs: number): void {
    const key = `radio-unread:${grid.gridId}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.deps.store.audit({
      actor: 'provisioner',
      action: 'provision_radio_unread',
      subject: grid.gridId,
      detail: {
        gridName: grid.name || grid.gridId,
        profile,
        reason: 'the antenna read-back did not answer',
        lastGoodAgeMs: Math.round(ageMs),
        graceMs: PROVISION_RADIO_GOOD_MS,
        note:
          `antenna state is UNKNOWN, not absent: keeping the last reading for up to ` +
          `${Math.round(PROVISION_RADIO_GOOD_MS / 1000)} s so a read flap cannot revoke an established authorisation`,
      },
      at: nowOf(this.deps),
    });
  }

  /** Once per grid: the unknown state outlived the grace, so authority is gone. */
  private noteRadioRevoked(grid: TaggedGrid, profile: ProfileKey, lastGoodAgeMs: number | null): void {
    if (profile !== 'BASE') return;
    const key = `radio-revoked:${grid.gridId}`;
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.deps.store.audit({
      actor: 'provisioner',
      action: 'provision_capability_revoked',
      subject: grid.gridId,
      detail: {
        gridName: grid.name || grid.gridId,
        profile,
        lastGoodAgeMs: lastGoodAgeMs === null ? null : Math.round(lastGoodAgeMs),
        graceMs: PROVISION_RADIO_GOOD_MS,
        reason:
          'the antenna state has been unreadable for longer than the last-known-good grace, so this base is no ' +
          'longer counted as a control source',
      },
      at: nowOf(this.deps),
    });
  }

  /**
   * Read `laser_state` for every owner grid that carries a laser antenna, so
   * the demo graph can draw a GAME edge for a pair the plugin reports
   * `Connected`. A read failure is advisory only: provisioning still succeeds.
   *
   * Cadence (sim-speed audit #4): only grids that actually have a laser are
   * asked, a grid whose link state stopped changing backs off to 30 s, and a
   * grid with an open mission or a fresh laser command is due immediately.
   * Previous samples are kept and merged, so backing a grid off never blanks
   * its edge in the graph.
   */
  private async sampleLasers(grids: TaggedGrid[], profiles: ProfilesFile, at: number): Promise<void> {
    const withLasers = this.ownedGrids(grids, profiles).filter(({ grid }) => (grid.laserCount ?? 0) > 0);
    const ids = withLasers.map(({ grid }) => grid.gridId).filter((id) => this.laserDue(id, at));
    if (!ids.length) {
      // Nothing due: keep the last sample exactly as it is.
      return;
    }
    try {
      const res = await callPlugin(this.deps, 'laser_state', { gridIds: ids }, 20_000);
      if (res.ok && Array.isArray(res.result?.grids)) {
        const read = res.result.grids as { gridId?: string }[];
        for (const row of read) {
          if (!row || typeof row.gridId !== 'string') continue;
          this.noteLaserReading(row.gridId, row, at);
          this.laserImmediate.delete(row.gridId);
        }
        const merged = this.mergeLaserSamples(read);
        this.deps.store.setKv(KV_LASERS, JSON.stringify({ at, grids: merged }));
      }
    } catch {
      /* keep the previous sample; the link graph simply stays as it was */
    }
  }

  /**
   * Is this grid's `laser_state` due? A grid backs off after three identical
   * reads (the link cannot change on its own), and is forced due by an open
   * mission or a laser/link command aimed at it.
   */
  private laserDue(gridId: string, at: number): boolean {
    if (this.laserImmediate.has(gridId)) return true;
    const state = this.laserCadence.get(gridId);
    if (!state) return true;
    if (this.gridHasOpenMission(gridId)) return true;
    return at >= state.nextDueAt;
  }

  /** Remember one reading and set the next due time from how it changed. */
  private noteLaserReading(gridId: string, row: unknown, at: number): void {
    const sig = JSON.stringify(row);
    const previous = this.laserCadence.get(gridId);
    const unchanged = previous && previous.sig === sig ? previous.unchanged + 1 : 0;
    const changed = !previous || previous.sig !== sig;
    const nextDueAt = changed
      ? at + POLL_MS
      : unchanged >= LASER_UNCHANGED_READS
        ? at + LASER_SLOW_MS
        : at + POLL_MS;
    this.laserCadence.set(gridId, { sig, unchanged, nextDueAt });
  }

  /** Merge fresh readings into the stored sample so no grid loses its edge. */
  private mergeLaserSamples(read: { gridId?: string }[]): unknown[] {
    const byGrid = new Map<string, unknown>();
    const raw = this.deps.store.getKv(KV_LASERS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { grids?: { gridId?: string }[] };
        for (const row of parsed.grids ?? []) {
          if (row && typeof row.gridId === 'string') byGrid.set(row.gridId, row);
        }
      } catch {
        /* corrupt cache: start from the fresh readings */
      }
    }
    for (const row of read) {
      if (row && typeof row.gridId === 'string') byGrid.set(row.gridId, row);
    }
    return [...byGrid.values()];
  }

  /**
   * A laser/link command touched this grid (the connect route, the map's link
   * button): its link state is about to change, so the next pass must sample it
   * even if it was backed off.
   */
  markLaserActivity(gridId: string): void {
    if (!gridId) return;
    this.laserImmediate.add(gridId);
  }

  private gridHasOpenMission(gridId: string): boolean {
    try {
      const open = this.deps.store.listMissions({ status: ['queued', 'planned', 'approved', 'executing', 'paused'] });
      return open.some((m) => (m.assignedUnits ?? []).includes(gridId));
    } catch {
      return true;
    }
  }

  state(): ProvisionState {
    const profiles = loadProfiles();
    const all = [...this.records.values()].sort((a, b) => b.appliedAt - a.appliedAt);
    return {
      bases: all.filter((r) => r.profile === 'BASE'),
      drones: all.filter((r) => r.profile === 'DRONE'),
      lastRun: this.lastRun,
      issues: this.issues,
      owner: { identityId: profiles.owner.identityId, steamId: profiles.owner.steamId },
      pollMs: POLL_MS,
      labels: [
        'GAME: terminal property values read back from the running block',
        'SIMULATED: radio range math between grids',
      ],
      profiles: {
        BASE: { description: profiles.profiles.BASE.description, steps: profiles.profiles.BASE.steps.map((s) => s.name) },
        DRONE: { description: profiles.profiles.DRONE.description, steps: profiles.profiles.DRONE.steps.map((s) => s.name) },
      },
    };
  }

  record(gridId: string): GridRecord | null {
    return this.records.get(gridId) ?? null;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, POLL_MS);
    // Never keep the process alive just for the poller.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Ask for an immediate pass (sim-speed audit #3). The 30 s steady cadence
   * would otherwise delay: a grid that just appeared in telemetry, a config
   * change an owner ordered, or a plugin reconnect (everything is unknown until
   * the first pass after it). Bursts collapse into one pass.
   */
  requestPass(reason: string): void {
    const at = nowOf(this.deps);
    if (this.busy) return;
    if (at - this.lastImmediateAt < IMMEDIATE_PASS_GAP_MS) return;
    this.lastImmediateAt = at;
    this.immediatePasses += 1;
    this.deps.store.audit({
      actor: 'provisioner',
      action: 'provision_pass_requested',
      subject: 'provisioner',
      detail: { reason, pollMs: POLL_MS },
      at,
      routine: true,
    });
    void this.runOnce().catch(() => undefined);
  }

  /** Immediate-pass count (diagnostics; the steady cadence does not count). */
  immediatePassCount(): number {
    return this.immediatePasses;
  }

  /**
   * True once a pass has completed cleanly. Immediate triggers are off before
   * this: there is no stale state to refresh yet, and the startup pass covers
   * the frames that arrive while it is running.
   */
  hasBaseline(): boolean {
    return this.lastRun !== null && this.lastRun.ok;
  }

  /** Was this grid part of the most recent scan? */
  sawInLastScan(gridId: string): boolean {
    return this.scannedGridIds.has(gridId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every tagged grid. `onlyGridId` forces a single re-apply.
   * A second caller waits for the pass already running instead of reading a
   * stale state — an explicit `apply` must never return another pass's record.
   */
  async runOnce(onlyGridId?: string): Promise<ProvisionLastRun> {
    while (this.busy) {
      const inflight = this.inFlight;
      if (!inflight) break;
      await inflight.catch(() => undefined);
    }
    const at = nowOf(this.deps);
    this.busy = true;
    const pass = this.pass(onlyGridId, at);
    this.inFlight = pass;
    try {
      return await pass;
    } finally {
      this.busy = false;
      if (this.inFlight === pass) this.inFlight = null;
    }
  }

  private async pass(onlyGridId: string | undefined, at: number): Promise<ProvisionLastRun> {
    {
      const profiles = loadProfiles();
      const errors: string[] = [];
      let scanned = 0;
      let provisioned = 0;
      let skipped = 0;

      // No explicit tag filter: the plugin also returns grids whose only mark
      // is a role tag on a non-PB block (or CustomData), so the role registry
      // sees PERSONAL/OFF grids it must leave alone.
      const listed = await callPlugin(this.deps, 'list_tagged', {});
      const grids = ((listed.result?.grids as TaggedGrid[] | undefined) ?? []).filter(Boolean);
      scanned = grids.length;
      shipRoles.noteInGame(
        this.deps.store,
        grids.map((g) => ({
          gridId: g.gridId,
          name: g.name ?? null,
          hints: hintsFromPluginGrid(g),
          // T79: the live ownership rule needs the big owners and their faction
          // tags; both come from the same list_tagged row (no extra order).
          owners: [g.owner, ...(g.owners ?? [])].filter((v): v is string => typeof v === 'string'),
          ownerFactions: g.ownerFactions ?? null,
        })),
        at,
      );
      this.scannedGridIds = new Set(grids.map((g) => g.gridId).filter((id): id is string => typeof id === 'string'));

      for (const grid of grids) {
        if (onlyGridId && grid.gridId !== onlyGridId) {
          skipped++;
          continue;
        }
        const resolution = shipRoles.resolution(grid.gridId);
        const profile = profileForGrid(profiles, grid, resolution);
        if (!profile) {
          skipped++;
          continue;
        }
        // T79: the registry's role gate is the send-boundary rule on the live
        // instance (untagged -> OFF, foreign/NPC owner -> OFF). Asking it here
        // means provisioning cannot act on a grid the executor would refuse.
        if (resolution.role === 'off' || resolution.role === 'personal') {
          skipped++;
          continue;
        }
        const ownerIds = [grid.owner, ...(grid.owners ?? [])].filter((v): v is string => typeof v === 'string');
        // Test instance: the legacy owner-identity rule stays exactly as it was.
        // Live: the registry already applied the configurable owner/faction
        // policy, so a faction-mate's tagged grid is legitimately in scope.
        if (!isLiveInstance() && !ownerIds.includes(profiles.owner.identityId)) {
          this.issue(grid.gridId, `owner ${ownerIds[0] ?? 'unknown'} is not the owner identity ${profiles.owner.identityId}; grid skipped`);
          skipped++;
          continue;
        }
        const signature = [grid.blocksTotal ?? 0, grid.radioCount ?? 0, grid.laserCount ?? 0, Math.round(grid.massKg ?? 0)].join('|');
        const previous = this.records.get(grid.gridId);
        if (!onlyGridId && previous && previous.signature === signature && previous.ok) {
          skipped++;
          continue;
        }
        // A grid that failed keeps its errors on the record; do not hammer a
        // broken block every 10 s. Retry at most once per FAILURE_RETRY_MS.
        if (!onlyGridId && previous && !previous.ok && at - previous.appliedAt < FAILURE_RETRY_MS) {
          skipped++;
          continue;
        }

        try {
          const record = await this.applyGrid(grid, profile, signature, profiles);
          this.records.set(grid.gridId, record);
          provisioned++;
          if (!record.ok) errors.push(`${grid.gridId}: ${record.steps.flatMap((s) => s.errors).slice(0, 3).join('; ') || 'incomplete'}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${grid.gridId}: ${message}`);
          this.issue(grid.gridId, `provisioning failed: ${message}`);
        }
      }

      // Publish what the gate may assume about the owner's grids, then sample
      // the laser hardware. Both reads happen even when nothing was written.
      this.writeCapabilities(grids, profiles, at);
      await this.sampleLasers(grids, profiles, at);

      // Naming is a separate service but runs on the same scan (T9). Its own
      // errors are logged by the hook and must never fail provisioning.
      if (this.deps.onGrids) {
        try {
          await this.deps.onGrids(grids);
        } catch (err) {
          errors.push(`naming hook: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const run: ProvisionLastRun = { at, ok: errors.length === 0, scanned, provisioned, skipped, errors };
      this.lastRun = run;
      this.save();
      return run;
    }
  }

  private async applyGrid(
    grid: TaggedGrid,
    profile: ProfileKey,
    signature: string,
    profiles: ProfilesFile,
  ): Promise<GridRecord> {
    const steps: ProvisionStepResult[] = [];
    const props: GridRecord['props'] = [];
    const radio: GridRecord['radio'] = {
      count: 0,
      broadcasting: null,
      radiusM: null,
      state: 'read',
      readAt: nowOf(this.deps),
    };
    let radioStepAnswered = false;
    let radioStepFailed = false;
    let changed = false;
    let ok = true;

    for (const step of profiles.profiles[profile].steps) {
      const params: Record<string, unknown> = {
        entityId: grid.gridId,
        filter: step.filter,
        props: resolveProps(profiles, step.props),
      };
      if (step.actions && step.actions.length) params.actions = step.actions;

      let res: PluginTestResult;
      try {
        res = await callPlugin(this.deps, 'set_block_props', params, 20_000);
      } catch (err) {
        ok = false;
        const isRadioStep = (step.filter as { type?: string } | undefined)?.type === 'RadioAntenna';
        if (isRadioStep) radioStepFailed = true;
        steps.push({ name: step.name, blocks: 0, applied: 0, errors: [err instanceof Error ? err.message : String(err)] });
        continue;
      }
      if (!res.ok) {
        ok = false;
        const isRadioStep = (step.filter as { type?: string } | undefined)?.type === 'RadioAntenna';
        if (isRadioStep) radioStepFailed = true;
        steps.push({ name: step.name, blocks: 0, applied: 0, errors: [res.error ?? 'plugin reported failure'] });
        continue;
      }
      if ((step.filter as { type?: string } | undefined)?.type === 'RadioAntenna') radioStepAnswered = true;

      const blocks = (res.result?.blocks as {
        name?: string;
        props?: { id: string; before: unknown; after: unknown }[];
        errors?: string[];
      }[]) ?? [];
      const stepErrors: string[] = [];
      const isRadioStep = (step.filter as { type?: string } | undefined)?.type === 'RadioAntenna';
      for (const block of blocks) {
        // Count blocks, not property rows: one antenna contributes several props.
        if (isRadioStep) radio.count++;
        for (const row of block.props ?? []) {
          props.push({ step: step.name, block: block.name ?? '', id: row.id, before: row.before, after: row.after });
          if (row.before !== row.after) changed = true;
          if (isRadioStep) {
            // The terminal id is `EnableBroadCast` (capital C) on the radio antenna.
            if (row.id.toLowerCase() === 'enablebroadcast') radio.broadcasting = row.after === true;
            // The plugin resolves `$max` against the block and reads the number back.
            if (row.id === 'Radius' && typeof row.after === 'number') radio.radiusM = Math.max(radio.radiusM ?? 0, row.after);
          }
        }
        for (const e of block.errors ?? []) stepErrors.push(`${block.name ?? 'block'}: ${e}`);
      }
      if (stepErrors.length) ok = false;
      steps.push({
        name: step.name,
        blocks: blocks.length,
        applied: Number(res.result?.applied ?? 0),
        errors: stepErrors,
      });
    }

    // Classify the radio reading (2026-11-11): an answered step with no block is
    // ABSENT only when the scan also sees no antenna; otherwise the state is
    // UNREAD and the last-known-good value keeps the gate honest for a while.
    const scannedRadio = grid.radioCount;
    if (radio.count > 0) radio.state = 'read';
    else if (radioStepFailed || !radioStepAnswered) radio.state = 'unread';
    else if (typeof scannedRadio === 'number') radio.state = scannedRadio > 0 ? 'unread' : 'absent';
    else radio.state = 'unread';
    const previous = this.records.get(grid.gridId);
    const lastGoodRadio =
      radio.state === 'read' && radio.broadcasting === true && (radio.radiusM ?? 0) > 0
        ? { broadcasting: true, radiusM: radio.radiusM as number, at: radio.readAt ?? nowOf(this.deps) }
        : previous?.lastGoodRadio ?? null;

    const record: GridRecord = {
      gridId: grid.gridId,
      name: grid.name || grid.pbName || grid.gridId,
      profile,
      tag: profile === 'BASE' ? profiles.tags.BASE ?? BASE_TAG : profiles.tags.DRONE ?? TEST_TAG,
      owner: grid.owner ?? null,
      signature,
      appliedAt: nowOf(this.deps),
      changed,
      ok,
      steps,
      props,
      radio,
      lastGoodRadio,
      hardware: {
        blocksTotal: grid.blocksTotal ?? null,
        radioCount: grid.radioCount ?? null,
        laserCount: grid.laserCount ?? null,
        massKg: grid.massKg ?? null,
        isStatic: grid.isStatic ?? null,
      },
    };

    this.deps.store.audit({
      actor: 'provisioner',
      action: 'provision_apply',
      subject: grid.gridId,
      detail: {
        profile,
        gridName: record.name,
        changed,
        ok,
        // Before/after for every property actually written.
        props: props.slice(0, 40),
        steps: steps.map((s) => ({ name: s.name, blocks: s.blocks, applied: s.applied, errors: s.errors })),
        radio,
        trigger: 'tagged-grid poll',
      },
      rollbackPoint: `provision:${grid.gridId}@${record.appliedAt}`,
      at: record.appliedAt,
    });
    return record;
  }
}

// ------------------------------------------------------------- process wiring

let singleton: Provisioner | null = null;
let singletonStore: Store | null = null;

/**
 * One provisioner per store. Routes and the poller must share it, otherwise the
 * poller would re-apply grids the state endpoint has never seen.
 */
export function provisionerFor(deps: ProvisionDeps): Provisioner {
  if (!singleton || singletonStore !== deps.store) {
    singleton = new Provisioner(deps);
    singletonStore = deps.store;
  }
  return singleton;
}

/** Start the ~10 s poll. Safe to call twice. */
export function startProvisioner(deps: ProvisionDeps): Provisioner {
  const provisioner = provisionerFor(deps);
  provisioner.start();
  return provisioner;
}

/**
 * Ask the running provisioner for a pass; no-op when it is not running.
 *
 * Guarded by a successful baseline pass: before the first good scan there is
 * nothing to be stale, and the startup pass is already on its way — firing here
 * would just add poller orders to a server whose plugin has not answered yet.
 */
export function requestProvisionPass(reason: string): boolean {
  if (!singleton || !singleton.hasBaseline()) return false;
  singleton.requestPass(reason);
  return true;
}

/**
 * An order was acked. Only an owner/executor order means the grid's config and
 * roles were just exercised and must be re-read; a routine poller order
 * (`provision:*`, `demo:power:*`, `demo:probe:*`, `demo:profile:*`) is the
 * control stack talking to itself and must not wake a pass.
 *
 * Measured before this guard (2026-11-11, test world): the 1 Hz power poller
 * ack fired a pass every coalescing window — one `list_tagged` every 5 s
 * instead of the intended 30 s. This is the single place runtime.ts asks, so
 * the rule is directly testable rather than living in an inline condition.
 */
export function requestProvisionPassForAck(orderId: unknown): boolean {
  if (isRoutineOrderId(orderId)) return false;
  return requestProvisionPass(`owner order acked: ${String(orderId)}`);
}

/**
 * A grid appeared in telemetry. Only an immediate pass when it is genuinely new:
 * a grid the last scan already returned needs no re-read.
 */
export function requestProvisionPassForGrid(gridId: string): boolean {
  if (!singleton || !singleton.hasBaseline()) return false;
  if (singleton.sawInLastScan(gridId)) return false;
  singleton.requestPass(`new grid in telemetry: ${gridId}`);
  return true;
}

/** Test helper: drop the singleton and stop its timer. */
export function resetProvisionerForTests(): void {
  singleton?.stop();
  singleton = null;
  singletonStore = null;
}

// ------------------------------------------------------------------ gate hook

export interface ProvisionControlSource {
  gridId: string;
  name: string;
  radioRangeM: number;
  antennaBroadcasting: true;
  labels: { antenna: 'GAME'; range: 'SIMULATED' };
  note: string;
}

/**
 * Control sources for the comms gate: provisioned BASE-role grids (any tag
 * spelling: `[HERMES-BASE]` or `[BASE]`, on any block or `HERMES_ROLE=base`)
 * whose radio antenna was read back as broadcasting, with a positive radius.
 *
 * Wiring note for the gate owner: call this with `provisioner.state()` and use
 * the returned ids as the set of control sources. The antenna state is GAME
 * (read back from the block on the game thread); any range/distance maths on top
 * of it stays SIMULATED, exactly like the rest of the planner half.
 */
export function controlSourcesFromState(state: ProvisionState): ProvisionControlSource[] {
  return state.bases
    .filter((b) => b.radio.broadcasting === true && (b.radio.radiusM ?? 0) > 0)
    .map((b) => ({
      gridId: b.gridId,
      name: b.name,
      radioRangeM: b.radio.radiusM as number,
      antennaBroadcasting: true as const,
      labels: { antenna: 'GAME' as const, range: 'SIMULATED' as const },
      note: 'provisioned base: antenna state read from the block, range maths simulated',
    }));
}

// -------------------------------------------------------------------- teleport

export type TeleportTarget = string | { x: number; y: number; z: number };

export interface TeleportResult {
  target: TeleportTarget;
  position: Vec3;
  plugin: Record<string, unknown>;
  labels: string[];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Move the owner's character above a planet, next to a grid, or to explicit
 * coordinates. The plugin re-checks the target against every planet surface and
 * reports any adjustment, so the coordinate is never trusted blindly.
 */
export async function teleportOwner(deps: ProvisionDeps, target: TeleportTarget): Promise<TeleportResult> {
  const profiles = loadProfiles();
  let position: Vec3;
  let description: string;

  if (typeof target === 'object') {
    position = { x: target.x, y: target.y, z: target.z };
    description = 'explicit coordinates';
  } else if (target.startsWith('planet:')) {
    const wanted = target.slice('planet:'.length).trim();
    const res = await callPlugin(deps, 'planets', {});
    const planets = (res.result?.planets as { name: string; position: Vec3; radiusM: number }[] | undefined) ?? [];
    const hit = planets.find((p) => p.name?.toLowerCase() === wanted.toLowerCase()) ??
      planets.find((p) => p.name?.toLowerCase().includes(wanted.toLowerCase()));
    if (!hit) {
      throw new ProvisionError(
        404,
        'planet_not_found',
        `no planet matching "${wanted}"`,
        planets.map((p) => p.name),
      );
    }
    const dir = normalize(hit.position);
    const r = hit.radiusM + 300;
    position = { x: hit.position.x + dir.x * r, y: hit.position.y + dir.y * r, z: hit.position.z + dir.z * r };
    description = `${hit.name} +300 m above the average surface radius`;
  } else if (target.startsWith('grid:')) {
    const res = await callPlugin(deps, 'list_tagged', { tags: [profiles.tags.BASE ?? BASE_TAG, profiles.tags.DRONE ?? TEST_TAG] });
    const grids = (res.result?.grids as TaggedGrid[] | undefined) ?? [];
    const hit = grids.find((g) => g.gridId === target);
    if (!hit || !hit.position) {
      throw new ProvisionError(404, 'grid_not_found', `no tagged grid ${target} with a live position`);
    }
    position = { x: hit.position.x, y: hit.position.y + 25, z: hit.position.z + 25 };
    description = `next to ${hit.name || target} (25 m up, 25 m back)`;
  } else {
    throw new ProvisionError(400, 'invalid_target', 'target must be "planet:<name>", "grid:<id>" or {x,y,z}');
  }

  const res = await callPlugin(deps, 'teleport_player', {
    identityId: profiles.owner.identityId,
    steamId: profiles.owner.steamId,
    x: position.x,
    y: position.y,
    z: position.z,
  }, 10_000);

  if (res.result?.teleported !== true) {
    throw new ProvisionError(
      409,
      'not_teleported',
      String(res.result?.reason ?? res.error ?? 'the plugin did not move the player'),
      ((res.result?.online as { displayName?: string }[] | undefined) ?? []).map((p) => `online: ${p.displayName ?? 'unknown'}`),
    );
  }

  const landed = (res.result.position as Vec3 | undefined) ?? position;
  deps.store.audit({
    actor: 'owner-request',
    action: 'provision_teleport',
    subject: profiles.owner.identityId,
    detail: { requested: position, landed, target, description, adjustedForSurface: res.result.adjustedForSurface === true },
    at: Date.now(),
  });

  return {
    target,
    position: landed,
    plugin: res.result,
    labels: ['GAME: the plugin moved the character and zeroed its velocity', `SIMULATED: ${description}`],
  };
}
