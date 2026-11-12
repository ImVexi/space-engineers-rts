/**
 * T74 survival mode: admin-only actions never leave a non-test backend.
 *
 * The plugin's live build has no cheat code compiled in, but the backend is the
 * other half of the rule: a route or an executor code path that still calls
 * `spawn_prefab`, `clone_grid`, `delete_grid`, `refill_grid`, `teleport`,
 * `zero_velocity`, `set_orientation` (a world-matrix write), an ownership
 * takeover, `delete_planets` or `snap_dock` would fail at the plugin and look
 * like a bug instead of a policy.
 *
 * `survivalMode` is ON unless the process is the marked test environment:
 *
 *   RTS_ENV=test AND RTS_TEST_SERVER_MARKER=se-rts-test
 *
 * which is exactly the lock the demo routes already require (`demo/env.ts`).
 * Nothing else turns it off - an unset marker is a hosted server, so the default
 * is the safe one.
 *
 * Everything here is pure so the refusals can be tested without a server.
 */

export const SURVIVAL_REASON = 'survival_mode';
export const SURVIVAL_MESSAGE = 'not available in survival build';

/** Actions that move a grid by teleport, spawn it, delete it, or steal it. */
export const ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  'spawn_prefab',
  'clone_grid',
  'delete_grid',
  'refill_grid',
  'teleport',
  'teleport_player',
  'zero_velocity',
  'set_orientation',
  'ownership',
  'delete_planets',
  'snap_dock',
]);

/** Backend features that only exist because the test world can spawn grids. */
export const ADMIN_FEATURES = ['fillWithClones', 'harness_spawn', 'delete_cleanup'] as const;
export type AdminFeature = (typeof ADMIN_FEATURES)[number];

export interface SurvivalEnv {
  RTS_ENV?: string | undefined;
  RTS_TEST_SERVER_MARKER?: string | undefined;
}

/**
 * True on the marked test world only. Any other combination (missing marker,
 * different env, a production copy of the service) is survival.
 */
export function isTestEnvironment(env: SurvivalEnv = process.env): boolean {
  const marker = (env.RTS_TEST_SERVER_MARKER ?? '').trim();
  const name = (env.RTS_ENV ?? '').trim().toLowerCase();
  return marker === 'se-rts-test' && name === 'test';
}

/** T74: the one flag every route and code path reads. */
export function resolveSurvivalMode(env: SurvivalEnv = process.env): boolean {
  return !isTestEnvironment(env);
}

export interface SurvivalRefusal {
  status: 409;
  code: typeof SURVIVAL_REASON;
  reason: typeof SURVIVAL_REASON;
  message: string;
  action: string;
  note: string;
}

/** The body a refused route sends: a plain reason, never a generic error. */
export function survivalRefusal(what: string): SurvivalRefusal {
  return {
    status: 409,
    code: SURVIVAL_REASON,
    reason: SURVIVAL_REASON,
    message: `${SURVIVAL_MESSAGE}: ${what}`,
    action: what,
    note:
      'admin/server actions are test-server only; in survival a lost node is recovered by ' +
      're-shaping neighbours, assigning an owned spare that can reach the slot, or a build request',
  };
}

/** True when `pluginAction` is an admin cheat (used by the designer proxy). */
export function isAdminAction(pluginAction: string | null | undefined): boolean {
  return !!pluginAction && ADMIN_ACTIONS.has(pluginAction.trim().toLowerCase());
}

export interface SurvivalGate {
  survivalMode: boolean;
  /** Throws-then-returns-refusal helper for routes. */
  refuse(what: string): SurvivalRefusal | null;
  allowsAction(pluginAction: string): boolean;
  allowsFeature(feature: AdminFeature): boolean;
}

export function survivalGate(survivalMode: boolean): SurvivalGate {
  return {
    survivalMode,
    refuse(what: string): SurvivalRefusal | null {
      return survivalMode ? survivalRefusal(what) : null;
    },
    allowsAction(pluginAction: string): boolean {
      return !survivalMode || !isAdminAction(pluginAction);
    },
    allowsFeature(feature: AdminFeature): boolean {
      // Every listed feature is an admin capability by definition.
      return !survivalMode || !(ADMIN_FEATURES as readonly string[]).includes(feature);
    },
  };
}

/**
 * T77: may a route accept the survival loop's `testIgnoreReach` setting?
 *
 * The override exists only to exercise the loop on the test world, where
 * BASE-01 has no antenna block and the comms gate can never pass. Policy:
 *
 *   not requested                -> allow (nothing changes)
 *   requested in survival mode   -> 409 survival_mode (and an audit row)
 *   requested outside the demo   -> 409 admin_override_not_allowed
 *
 * Pure, so the refusal table is testable without an HTTP server.
 */
export interface TestOverrideVerdict {
  allow: boolean;
  status: 409 | null;
  code: typeof SURVIVAL_REASON | 'admin_override_not_allowed' | null;
  message: string | null;
  /** Audit subject detail for the refusal row. */
  detail: Record<string, unknown> | null;
}

export function decideTestIgnoreReach(args: {
  requested: boolean;
  survivalMode: boolean;
  demoEnv: boolean;
  route?: string;
}): TestOverrideVerdict {
  if (!args.requested) return { allow: true, status: null, code: null, message: null, detail: null };
  if (args.survivalMode) {
    return {
      allow: false,
      status: 409,
      code: SURVIVAL_REASON,
      message: `${SURVIVAL_MESSAGE}: testIgnoreReach loop override`,
      detail: { route: args.route ?? null, flag: 'testIgnoreReach', reason: SURVIVAL_REASON },
    };
  }
  if (!args.demoEnv) {
    return {
      allow: false,
      status: 409,
      code: 'admin_override_not_allowed',
      message: 'testIgnoreReach is only available on the test server',
      detail: { route: args.route ?? null, flag: 'testIgnoreReach', reason: 'admin_override_not_allowed' },
    };
  }
  return { allow: true, status: null, code: null, message: null, detail: null };
}

/** How a survival-mode self-heal recovers a lost node, in order. */
export const SURVIVAL_RECOVERY_PLAN = ['reshape_neighbours', 'assign_spare', 'build_request'] as const;
export type SurvivalRecovery = (typeof SURVIVAL_RECOVERY_PLAN)[number];
