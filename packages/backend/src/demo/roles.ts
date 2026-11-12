/**
 * Ship roles ("marking"), owner decision 2026-11-11.
 *
 * A grid's role says what the control system may do with it:
 *
 *   MANAGED  - full autonomy (the only role the optimiser, provisioning,
 *              self-healing, staging, naming and fleet defaults may touch).
 *   PERSONAL - the owner's own ship. Never touched automatically. Only explicit,
 *              confirmed owner orders (come-to-me, go-to, land/park, return
 *              home) plus stop/brake/hold, and those fly the gentle profile.
 *   BASE     - a station. Never moved, never assigned a slot; counts as a
 *              control source when it has a broadcasting antenna (the existing
 *              gate logic).
 *   OFF      - the backend sends it NO orders at all, only passive reads.
 *
 * The role is set IN GAME by a tag in any block's CustomName or a CustomData
 * line (`[HERMES-PERSONAL]` / `[PERSONAL]`, `[HERMES-BASE]` / `[BASE]`,
 * `[HERMES-OFF]` / `[OFF]`, `HERMES_ROLE=personal|base|off|managed`), with the
 * legacy `[HERMES-TEST]` meaning MANAGED. The site toggle is the fallback and
 * only applies when the grid carries no in-game tag. Conflicting tags resolve
 * to the most restrictive role and raise an alert.
 *
 * This module is the single resolver. Every sender asks it, so no feature can
 * invent a role of its own.
 */

import type { Store } from '../store.js';
import { isLiveInstance, ownershipVerdict, type OwnerPolicy } from './ownership.js';

export const SHIP_ROLES = ['managed', 'personal', 'base', 'off'] as const;
export type ShipRole = (typeof SHIP_ROLES)[number];

/** OFF > PERSONAL > BASE > MANAGED: more restrictive wins a conflict. */
export const ROLE_RESTRICTIVENESS: Readonly<Record<ShipRole, number>> = {
  managed: 1,
  base: 2,
  personal: 3,
  off: 4,
};

/**
 * `default-live` - an untagged grid on the live instance (OFF, read-only);
 * `ownership`    - a non-OFF role refused because the grid is not the owner's.
 */
export type RoleSource = 'in-game-tag' | 'site-toggle' | 'default' | 'default-live' | 'ownership';
export type RoleHintSource = 'block-name' | 'custom-data';

export interface RoleHint {
  role: ShipRole;
  /** The literal token that matched, e.g. `[PERSONAL]` or `HERMES_ROLE=base`. */
  token: string;
  source: RoleHintSource;
  /** Block whose name/CustomData carried the token, for the site's explanation. */
  block?: string | null;
}

export interface RoleResolution {
  role: ShipRole;
  roleSource: RoleSource;
  /** The role the in-game tag set, or null when there is none. */
  inGameRole: ShipRole | null;
  hints: RoleHint[];
  /** More than one distinct role was tagged on the grid. */
  conflict: boolean;
  conflictRoles: ShipRole[];
  /** Plain sentence for the badge/tooltip and the audit. */
  reason: string;
  /** Live instance only: why the grid was (or was not) treated as owned. */
  ownershipDetail?: string | null;
}

interface SiteToggle {
  role: ShipRole;
  by: string;
  at: number;
}

const SITE_KEY = 'roles:site';

/**
 * Tag tokens, longest-first so `[HERMES-BASE]` is seen before its short alias.
 * Matching is case-insensitive. `[HERMES-TEST]` is the legacy managed tag; the
 * explicit `[HERMES-MANAGED]` / `[MANAGED]` spellings are what the live
 * runbook asks for (untagged grids are OFF there).
 */
const TOKENS: ReadonlyArray<{ token: string; role: ShipRole }> = [
  { token: '[HERMES-PERSONAL]', role: 'personal' },
  { token: '[HERMES-MANAGED]', role: 'managed' },
  { token: '[HERMES-BASE]', role: 'base' },
  { token: '[HERMES-OFF]', role: 'off' },
  { token: '[HERMES-TEST]', role: 'managed' },
  { token: '[PERSONAL]', role: 'personal' },
  { token: '[MANAGED]', role: 'managed' },
  { token: '[BASE]', role: 'base' },
  { token: '[OFF]', role: 'off' },
];

const CUSTOM_DATA_RE = /HERMES_ROLE\s*=\s*"?'?([a-z]+)'?"?/gi;

function roleOfName(value: string): ShipRole | null {
  const v = value.trim().toLowerCase();
  return (SHIP_ROLES as readonly string[]).includes(v) ? (v as ShipRole) : null;
}

/**
 * Every role token in one string (a block name or a CustomData body), plus the
 * `HERMES_ROLE=` form. `/characteristics/`: `[BASE]` is NOT a substring of
 * `[HERMES-BASE]` (a `-` sits before it), so aliases cannot trigger each other.
 */
export function parseRoleText(text: string | null | undefined): Array<{ role: ShipRole; token: string }> {
  if (!text) return [];
  const out: Array<{ role: ShipRole; token: string }> = [];
  const lower = text.toLowerCase();
  for (const { token, role } of TOKENS) {
    if (lower.includes(token.toLowerCase())) out.push({ role, token });
  }
  CUSTOM_DATA_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_DATA_RE.exec(text)) !== null) {
    const role = roleOfName(match[1] ?? '');
    if (role) out.push({ role, token: `HERMES_ROLE=${role}` });
  }
  return out;
}

/** The most restrictive role among the hints, or null when there are none. */
export function mostRestrictive(hints: ReadonlyArray<{ role: ShipRole }>): ShipRole | null {
  let best: ShipRole | null = null;
  for (const hint of hints) {
    if (!best || ROLE_RESTRICTIVENESS[hint.role] > ROLE_RESTRICTIVENESS[best]) best = hint.role;
  }
  return best;
}

/**
 * Hints from one block's CustomName and CustomData. The plugin already parses
 * these into `roleHints`; this is the fallback for the raw block rows it also
 * returns, so the resolver works against either shape.
 */
export function hintsFromBlockText(
  customName: string | null | undefined,
  customData: string | null | undefined,
  block?: string | null,
): RoleHint[] {
  const out: RoleHint[] = [];
  for (const h of parseRoleText(customName)) out.push({ role: h.role, token: h.token, source: 'block-name', block: block ?? null });
  for (const h of parseRoleText(customData)) out.push({ role: h.role, token: h.token, source: 'custom-data', block: block ?? null });
  return out;
}

type BlockRow = { name?: unknown; customName?: unknown; customData?: unknown; data?: unknown };

function hintsFromBlockRows(rows: unknown): RoleHint[] {
  if (!Array.isArray(rows)) return [];
  const out: RoleHint[] = [];
  for (const row of rows as BlockRow[]) {
    if (!row || typeof row !== 'object') continue;
    const name = typeof row.customName === 'string' ? row.customName : typeof row.name === 'string' ? row.name : '';
    const data = typeof row.customData === 'string' ? row.customData : typeof row.data === 'string' ? row.data : '';
    out.push(...hintsFromBlockText(name, data, name || null));
  }
  return out;
}

function validHints(value: unknown): RoleHint[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter(
    (h): h is RoleHint =>
      !!h && typeof h === 'object' && (SHIP_ROLES as readonly string[]).includes(String((h as RoleHint).role)),
  );
  return out.length > 0 ? out : null;
}

/**
 * Role hints from a `list_tagged` grid row. The merged plugin computes
 * `roleHints` during its single cheap scan; an older plugin (or a new field the
 * plugin drops) still carries the same tags in `blocks[]` rows, and both are
 * read here. Never re-walks the grid: this is pure payload parsing.
 */
export function hintsFromPluginGrid(grid: {
  roleHints?: unknown;
  blocks?: unknown;
} | null | undefined): RoleHint[] {
  if (!grid) return [];
  return validHints(grid.roleHints) ?? hintsFromBlockRows(grid.blocks);
}

/**
 * Role hints from an `inspect` result. Inspect returns `roleHints` when the
 * plugin computes them and `taggedBlocks` (CustomData / `[` names) otherwise,
 * so a per-grid read resolves the same role the poll did.
 */
export function hintsFromInspect(result: {
  roleHints?: unknown;
  taggedBlocks?: unknown;
  blocks?: unknown;
} | null | undefined): RoleHint[] {
  if (!result) return [];
  const direct = validHints(result.roleHints);
  if (direct) return direct;
  const tagged = hintsFromBlockRows(result.taggedBlocks);
  return tagged.length > 0 ? tagged : hintsFromBlockRows(result.blocks);
}


/**
 * Resolve a grid's role from its in-game hints and the stored site toggle.
 * The in-game tag always wins; the toggle only applies when there is none.
 *
 * Two live-instance rules sit on top (owner decision 2026-11-11, T79):
 *
 *   - an UNTAGGED grid on `RTS_ENV=live` defaults to OFF (`default-live`), not
 *     MANAGED: on a shared world "nobody marked it" must not mean "automate it";
 *   - a non-OFF role additionally requires the grid to be owned by the
 *     configured owner (or his faction). A foreign/NPC grid is OFF with the
 *     reason `not owned by you`, whatever tag it carries.
 *
 * The test instance keeps today's default (MANAGED) so existing test flows do
 * not change.
 */
export function resolveRole(input: {
  hints?: ReadonlyArray<RoleHint> | null;
  site?: ShipRole | null;
  siteBy?: string | null;
  /** Default: `RTS_ENV=live`. Explicit so tests never depend on the shell. */
  live?: boolean;
  /** Big-owner identity ids from the plugin grid row. */
  owners?: ReadonlyArray<string | null | undefined> | null;
  /** Faction tag of each big owner, when the plugin could read factions. */
  ownerFactions?: ReadonlyArray<string | null | undefined> | null;
  /** Live ownership policy; null/absent fails closed on the live instance. */
  policy?: OwnerPolicy | null;
}): RoleResolution {
  const hints = (input.hints ?? []).filter((h) => SHIP_ROLES.includes(h.role));
  const inGameRole = mostRestrictive(hints);
  const live = input.live ?? (input.policy ? input.policy.live : isLiveInstance());
  const res = resolveBaseRole(input, hints, inGameRole, live);
  return applyOwnership(res, input, live);
}

function resolveBaseRole(
  input: {
    site?: ShipRole | null;
    siteBy?: string | null;
  },
  hints: RoleHint[],
  inGameRole: ShipRole | null,
  live: boolean,
): RoleResolution {
  if (inGameRole) {
    // MANAGED is the default role: `[HERMES-TEST]` (legacy managed) or an
    // untagged-managed expectation never conflicts with an explicit PERSONAL /
    // BASE / OFF tag on another block. A conflict is two NON-default tags
    // fighting (`[PERSONAL]` + `[BASE]`), which is a real ambiguity.
    const roles = [...new Set(hints.map((h) => h.role))].filter((role) => role !== 'managed');
    const conflict = roles.length > 1;
    const conflictRoles = conflict
      ? [...roles].sort((a, b) => ROLE_RESTRICTIVENESS[b] - ROLE_RESTRICTIVENESS[a])
      : [];
    const where = hints
      .map((h) => `${h.source === 'custom-data' ? 'CustomData' : 'block name'}${h.block ? ` of ${h.block}` : ''}: ${h.token}`)
      .join('; ');
    return {
      role: inGameRole,
      roleSource: 'in-game-tag',
      inGameRole,
      hints,
      conflict,
      conflictRoles,
      reason: conflict
        ? `conflicting role tags (${conflictRoles.map((r) => r.toUpperCase()).join(' vs ')}): the most restrictive, ${inGameRole.toUpperCase()}, wins — ${where}`
        : `set in game — ${where}`,
    };
  }
  if (input.site) {
    return {
      role: input.site,
      roleSource: 'site-toggle',
      inGameRole: null,
      hints,
      conflict: false,
      conflictRoles: [],
      reason: `set on the site${input.siteBy ? ` by ${input.siteBy}` : ''} (no in-game tag)`,
    };
  }
  if (live) {
    // Live instance: an untagged grid is read-only. This is the whole safety
    // property on a shared world - MES/NPC grids, wrecks and someone else's
    // ship must not become automatable because nobody marked them.
    return {
      role: 'off',
      roleSource: 'default-live',
      inGameRole: null,
      hints,
      conflict: false,
      conflictRoles: [],
      reason: 'untagged on the live server: add [HERMES-MANAGED] or [HERMES-TEST] to automate it',
    };
  }
  return {
    role: 'managed',
    roleSource: 'default',
    inGameRole: null,
    hints,
    conflict: false,
    conflictRoles: [],
    reason: 'untagged: the system keeps its existing behaviour for this grid',
  };
}

/**
 * The live ownership gate. A non-OFF role needs the grid's big owner to be the
 * configured owner (or a member of his faction); otherwise the grid is OFF with
 * `not owned by you`. ON THE TEST INSTANCE THIS IS A NO-OP (policy.live false),
 * so existing flows are untouched.
 */
function applyOwnership(
  res: RoleResolution,
  input: { owners?: ReadonlyArray<string | null | undefined> | null; ownerFactions?: ReadonlyArray<string | null | undefined> | null; policy?: OwnerPolicy | null },
  live: boolean,
): RoleResolution {
  if (res.role === 'off') return res;
  if (!live) return res;
  const verdict = ownershipVerdict(input.owners, input.ownerFactions, input.policy ?? null, live);
  if (verdict.owned) return { ...res, ownershipDetail: verdict.detail };
  return {
    ...res,
    role: 'off',
    roleSource: 'ownership',
    conflict: false,
    conflictRoles: [],
    reason: 'not owned by you',
    ownershipDetail: verdict.detail,
  };
}

// ------------------------------------------------------------------ gate

export type OrderIntent = 'automatic' | 'owner-order' | 'safety';

export interface RoleDecision {
  allowed: boolean;
  role: ShipRole;
  roleSource: RoleSource;
  code?: 'role_off' | 'role_personal' | 'role_base' | 'personal_confirmation_required';
  /** Plain-language reason (409 body / audit text). */
  reason: string;
}

/** Orders that only shed energy are always allowed (except on an OFF grid). */
const SAFETY_ACTIONS = new Set(['stop', 'brake', 'land_stop', 'level_stop']);

/** Order actions that are explicit owner flight orders for a PERSONAL ship. */
const PERSONAL_FLIGHT_ACTIONS = new Set([
  'move',
  'hold',
  'stop',
  'brake',
  'land_at',
  'land_ground',
  'land_stop',
  'land_status',
  'level_move',
  'level_hold',
  'level_stop',
  'level_status',
  'set_dampeners',
  'is_under_control',
  'inspect',
  'profile',
  'get_block_props',
  'probe_ground',
  'probe_los',
  'deadman_status',
]);

/** True for the collision-avoidance/dampener guard, a flight-safety write. */
export function isFlightSafetyWrite(action: string | null | undefined, params?: Record<string, unknown>): boolean {
  if (action !== 'set_block_props' && action !== 'set_dampeners') return false;
  if (action === 'set_dampeners') return true;
  const props = (params?.props ?? {}) as Record<string, unknown>;
  const keys = Object.keys(props);
  const guardProps = keys.length > 0 && keys.every((k) => k === 'CollisionAvoidance' || k === 'DampenersOverride');
  if (guardProps) return true;
  // Release preflight (gear/connector unlock) is what lets an authorised owner
  // flight leave a dock or a landing pad; it is not a configuration change.
  const releaseProps = keys.length > 0 && keys.every((k) => k === 'Autolock' || k === 'Lock');
  const actions = Array.isArray(params?.actions) ? (params.actions as unknown[]).map((a) => String(a).toLowerCase()) : [];
  const releaseActions = actions.length > 0 && actions.every((a) => ['unlock', 'lock', 'disconnect', 'connect'].includes(a));
  return releaseProps || releaseActions;
}

/** Classify a plugin action at the send boundary. */
export function actionIntent(action: string | null | undefined, params?: Record<string, unknown>): OrderIntent {
  const a = (action ?? '').trim().toLowerCase();
  if (SAFETY_ACTIONS.has(a)) return 'safety';
  if (isFlightSafetyWrite(a, params)) return 'safety';
  return 'automatic';
}

/**
 * May this role receive this order? `confirmPersonal` is the owner's explicit
 * confirmation from the site; without it a PERSONAL ship refuses (409) with the
 * reason `personal_confirmation_required`.
 */
export function orderDecision(
  res: RoleResolution,
  intent: OrderIntent,
  opts: { action?: string | null; confirmPersonal?: boolean } = {},
): RoleDecision {
  const action = (opts.action ?? '').trim().toLowerCase();
  const base = { role: res.role, roleSource: res.roleSource };
  if (res.role === 'off') {
    // The refusal names the actual reason: a tag, the live default, or a grid
    // that is not ours. A foreign grid must never read as "marked OFF".
    const reason =
      res.roleSource === 'ownership'
        ? 'not owned by you: this grid receives no orders'
        : res.roleSource === 'default-live'
          ? 'untagged on the live server: this grid receives no orders (add [HERMES-MANAGED] to automate it)'
          : 'marked OFF in game: this grid receives no orders';
    return { ...base, allowed: false, code: 'role_off', reason };
  }
  if (res.role === 'base') {
    if (intent === 'safety' || intent === 'automatic') {
      // Reads are part of telemetry and never reach this gate; the automatic
      // paths that could move a base are refused here.
      if (intent === 'automatic' && action && !SAFETY_ACTIONS.has(action) && !READ_ONLY_ACTIONS.has(action)) {
        return { ...base, allowed: false, code: 'role_base', reason: 'a base is never moved or reconfigured by an automatic feature' };
      }
      return { ...base, allowed: true, reason: 'base: read/safety action allowed' };
    }
    return { ...base, allowed: false, code: 'role_base', reason: 'a base is never moved: every movement order is refused' };
  }
  if (res.role === 'personal') {
    if (intent === 'safety') return { ...base, allowed: true, reason: 'personal ship: stop/brake/hold is always allowed' };
    if (intent === 'automatic') {
      return {
        ...base,
        allowed: false,
        code: 'role_personal',
        reason: 'personal ship: no automatic action (owner ships are never provisioned, tuned, staged or flown by the system)',
      };
    }
    if (!PERSONAL_FLIGHT_ACTIONS.has(action)) {
      return {
        ...base,
        allowed: false,
        code: 'role_personal',
        reason: `personal ship: ${action || 'that action'} is not one of the allowed owner orders`,
      };
    }
    if (opts.confirmPersonal !== true) {
      return {
        ...base,
        allowed: false,
        code: 'personal_confirmation_required',
        reason: 'this is a personal ship: confirm the order (confirmPersonal) before it is sent',
      };
    }
    return { ...base, allowed: true, reason: 'personal ship: explicit owner order' };
  }
  return { ...base, allowed: true, reason: 'managed grid' };
}

const READ_ONLY_ACTIONS = new Set([
  'inspect',
  'profile',
  'is_under_control',
  'get_block_props',
  'radio_links',
  'laser_state',
  'deadman_status',
  'diag',
  'connector_state',
  'list_grids',
  'list_tagged',
  'list_players',
  'planets',
  'suit_radio',
  'dock_state',
  'probe_ground',
  'probe_los',
  'gps_list',
]);

// -------------------------------------------------------------- registry

export interface InGameRoleRow {
  gridId: string;
  name?: string | null;
  hints?: RoleHint[] | null;
  /** Big-owner identity ids (plugin `list_tagged.owners`), live rule input. */
  owners?: ReadonlyArray<string | null | undefined> | null;
  /** Faction tag per big owner (plugin `ownerFactions`), live rule input. */
  ownerFactions?: ReadonlyArray<string | null | undefined> | null;
}

interface GridMark {
  hints: RoleHint[];
  name: string | null;
  at: number;
  owners: string[];
  ownerFactions: string[];
}

/**
 * Process-wide role registry. The provisioner's `list_tagged` poll is the only
 * writer of in-game roles; the site toggle is persisted in the store's kv row
 * `roles:site`. Both are read synchronously by every sender.
 *
 * T79: each poll row also carries the grid's big owners, and the registry holds
 * the live ownership policy (`configureOwnerPolicy`). `resolution()` applies
 * both, so the executor's role gate, the provisioner, the survival loop and
 * every route see the same OFF verdict for an untagged or foreign grid.
 */
export class ShipRoleRegistry {
  private readonly inGame = new Map<string, GridMark>();
  private readonly site = new Map<string, SiteToggle>();
  private loadedFrom: Store | null = null;
  private readonly alerted = new Set<string>();
  private ownerPolicy: OwnerPolicy | null | (() => OwnerPolicy | null) = null;

  /**
   * Install the live ownership policy (a value, or a cheap provider refreshed
   * as identities are observed). Null keeps the safe fail-closed default on
   * `RTS_ENV=live`.
   */
  configureOwnerPolicy(policy: OwnerPolicy | null | (() => OwnerPolicy | null)): void {
    this.ownerPolicy = policy;
  }

  private policy(): OwnerPolicy | null {
    if (typeof this.ownerPolicy === 'function') {
      try {
        return this.ownerPolicy();
      } catch {
        return null;
      }
    }
    return this.ownerPolicy ?? null;
  }

  /** Load persisted site toggles once per store. */
  load(store: Store): void {
    if (this.loadedFrom === store) return;
    this.loadedFrom = store;
    try {
      const raw = store.getKv(SITE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, SiteToggle>;
      for (const [gridId, toggle] of Object.entries(parsed)) {
        const role = roleOfName(String(toggle?.role ?? ''));
        if (role) this.site.set(gridId, { role, by: String(toggle.by ?? 'site'), at: Number(toggle.at ?? 0) });
      }
    } catch {
      // A corrupt kv row must never stop the backend; the in-game tags still win.
    }
  }

  /** The site toggle for a grid, if any (null means "no toggle"). */
  siteRole(gridId: string): ShipRole | null {
    return this.site.get(gridId)?.role ?? null;
  }

  siteToggle(gridId: string): SiteToggle | null {
    return this.site.get(gridId) ?? null;
  }

  /** Feed one poll of `list_tagged` (any grid with role hints). */
  noteInGame(store: Store, rows: ReadonlyArray<InGameRoleRow>, now: number): void {
    this.load(store);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row?.gridId) continue;
      const hints = (row.hints ?? []).filter((h) => h && SHIP_ROLES.includes(h.role));
      seen.add(row.gridId);
      const owners = (row.owners ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0);
      const ownerFactions = (row.ownerFactions ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (hints.length === 0 && owners.length === 0) {
        this.inGame.delete(row.gridId);
        continue;
      }
      // A grid with owners but no role hints is still tracked: on the live
      // instance it resolves to OFF either way, and the site can explain the
      // tag it is missing from the owners it read.
      this.inGame.set(row.gridId, { hints, name: row.name ?? null, at: now, owners, ownerFactions });
      if (hints.length > 0) this.maybeAlert(store, row.gridId, row.name ?? null, now);
    }
    // A grid that stopped reporting role hints has lost its tag: forget it.
    for (const gridId of [...this.inGame.keys()]) {
      if (!seen.has(gridId)) this.inGame.delete(gridId);
    }
  }

  resolution(gridId: string): RoleResolution {
    const inGame = this.inGame.get(gridId);
    const site = this.site.get(gridId) ?? null;
    return resolveRole({
      hints: inGame?.hints ?? null,
      site: site?.role ?? null,
      siteBy: site?.by ?? null,
      owners: inGame?.owners ?? null,
      ownerFactions: inGame?.ownerFactions ?? null,
      policy: this.policy(),
    });
  }

  roleOf(gridId: string): ShipRole {
    return this.resolution(gridId).role;
  }

  /** Set/clear the site fallback. Refused when an in-game tag sets the role. */
  setSiteRole(
    store: Store,
    gridId: string,
    role: ShipRole | null,
    by: string,
    now: number,
  ): { ok: boolean; code?: string; reason: string; resolution: RoleResolution } {
    this.load(store);
    const current = this.resolution(gridId);
    if (current.roleSource === 'in-game-tag') {
      return {
        ok: false,
        code: 'role_set_in_game',
        reason: `the role is set in game (${current.reason}); clear the tag on the grid to use the site toggle`,
        resolution: current,
      };
    }
    if (role === null) this.site.delete(gridId);
    else this.site.set(gridId, { role, by, at: now });
    this.persist(store);
    const resolution = this.resolution(gridId);
    store.audit({
      actor: by,
      action: 'role_set',
      subject: gridId,
      detail: {
        requested: role,
        applied: resolution.role,
        roleSource: resolution.roleSource,
        note: 'site toggle; in-game tags take precedence',
      },
      at: now,
    });
    return { ok: true, reason: `role set to ${resolution.role} (${resolution.roleSource})`, resolution };
  }

  /** Every grid the registry knows, for the site's list. */
  known(): Array<{ gridId: string; resolution: RoleResolution; name: string | null }> {
    const ids = new Set<string>([...this.inGame.keys(), ...this.site.keys()]);
    return [...ids].map((gridId) => ({
      gridId,
      resolution: this.resolution(gridId),
      name: this.inGame.get(gridId)?.name ?? null,
    }));
  }

  /** Test seam. */
  reset(): void {
    this.inGame.clear();
    this.site.clear();
    this.loadedFrom = null;
    this.alerted.clear();
    this.ownerPolicy = null;
  }

  private persist(store: Store): void {
    const out: Record<string, SiteToggle> = {};
    for (const [gridId, toggle] of this.site) out[gridId] = toggle;
    store.setKv(SITE_KEY, JSON.stringify(out));
  }

  /** One alert per (grid, conflicting tag set), never per poll. */
  private maybeAlert(store: Store, gridId: string, name: string | null, now: number): void {
    const res = this.resolution(gridId);
    if (!res.conflict) return;
    const key = `${gridId}:${res.conflictRoles.join(',')}`;
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    store.addAlert({
      kind: 'role_conflict',
      message: `${name || gridId} carries conflicting role tags (${res.conflictRoles.map((r) => r.toUpperCase()).join(' vs ')}); using the most restrictive, ${res.role.toUpperCase()}`,
      at: now,
    });
    store.audit({
      actor: 'ship-roles',
      action: 'role_conflict',
      subject: gridId,
      detail: { roles: res.conflictRoles, applied: res.role, hints: res.hints },
      at: now,
    });
  }
}

/** The process-wide registry. Tests call `reset()`; production never does. */
export const shipRoles = new ShipRoleRegistry();

/**
 * `state.nodes[].role` / `roleSource` / `roleReason` for the demo site.
 */
export function roleFieldsFor(gridId: string | null | undefined): {
  role: ShipRole;
  roleSource: RoleSource;
  roleReason: string;
  roleConflict: boolean;
} {
  if (!gridId) {
    return { role: 'managed', roleSource: 'default', roleReason: 'no grid id', roleConflict: false };
  }
  const res = shipRoles.resolution(gridId);
  return {
    role: res.role,
    roleSource: res.roleSource,
    roleReason: res.reason,
    roleConflict: res.conflict,
  };
}
