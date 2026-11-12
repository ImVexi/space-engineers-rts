/**
 * T75 order channels: a legitimate action must leave on a channel the live
 * plugin actually compiles in.
 *
 * The plugin carries two order channels:
 *
 *   - `action` - the PRODUCTION channel. Every build (live and test) compiles
 *     it, so an inspect, a dampeners write or a landing order can be sent to a
 *     hosted server.
 *   - `test`   - the TEST channel. Only the test-world build compiles it, and
 *     it carries the admin cheats (spawn, clone, delete, teleport, ownership,
 *     ...) plus test-harness-only names (`save`, `planets`, `damage`, `gps_*`,
 *     `reset_world`, ...).
 *
 * The rule this module encodes:
 *
 *   - A legitimate action (`PRODUCTION_ACTIONS`) is sent as `orderType:
 *     'action'` in BOTH modes, test included. Sending it as `test` used to
 *     work only on the test world and died at the plugin everywhere else.
 *   - An admin or unknown action stays on `test`. In survival mode it is
 *     refused before the wire (409 `survival_mode`) and audited, because the
 *     live plugin has no such channel; in the test build it still goes out.
 *   - A native order type (move/hold/stop/waypoint/drive/dock/undock/repair/
 *     laser) is the plugin's own traffic and passes through unchanged.
 *
 * Everything here is pure (no env reads) so channel decisions can be tested
 * without a server; callers that have no executor pass `resolveSurvivalMode()`.
 */

import { SURVIVAL_REASON, survivalRefusal, type SurvivalRefusal } from './survival.js';

/** The production order channel, compiled into every plugin build. */
export const PRODUCTION_ORDER_TYPE = 'action' as const;

/** Order types the plugin understands natively (never re-channelled). */
export const NATIVE_ORDER_TYPES: ReadonlySet<string> = new Set([
  'move',
  'hold',
  'stop',
  'waypoint',
  'drive',
  'dock',
  'undock',
  'repair',
  'laser',
]);

/**
 * Legitimate plugin actions: reads, dampeners/block writes, flight handover,
 * landing, docking, laser links, naming, HUD markers, and switching a grid's own
 * autopilot off. None of them spawns, deletes, teleports, refills or steals a
 * grid, so all of them exist in the live build.
 *
 * Admin names live in `ADMIN_ACTIONS` (survival.ts); test-harness-only names
 * (`save`, `damage`, `wave`, `reset`, `reset_world`, `refill`,
 * `despawn_state`, ...) are deliberately absent: they mutate world content or
 * only exist to drive the test harness.
 *
 * `list_players`, `planets`, `suit_radio` and `dock_state` are read-only.
 * `gps_*` only touches a player's own HUD markers. `rename_grid` is a grid
 * CustomName write and the plugin restricts it to owned/unclaimed grids.
 * `ai_off` switches a grid's own autopilot off (the executor's secure sequence
 * is release -> diag -> wake -> ai_off -> move, so it must work in survival).
 */
export const PRODUCTION_ACTIONS: ReadonlySet<string> = new Set([
  'inspect',
  'profile',
  'list_tagged',
  'identity',
  'ownership_check',
  'radio_links',
  'laser_state',
  'is_under_control',
  'deadman_status',
  'set_dampeners',
  'wake',
  'move',
  'hold',
  'stop',
  'brake',
  'level_hold',
  'level_move',
  'level_stop',
  'level_status',
  'land_at',
  'land_ground',
  'land_status',
  'land_stop',
  'set_block_props',
  'get_block_props',
  'laser_target',
  'laser_connect',
  'laser_disconnect',
  'convert_to_station',
  'convert_to_ship',
  'connector_state',
  'list_grids',
  'diag',
  'sim_ratio',
  'probe_ground',
  'probe_los',
  'physics_wake',
  'gyro_fix',
  'rename_block',
  'rename_grid',
  'ai_off',
  'list_players',
  'planets',
  'suit_radio',
  'dock_state',
  'gps_add',
  'gps_remove',
  'gps_list',
]);

/** True when `action` is a legitimate action the production channel carries. */
export function isProductionAction(action: string | null | undefined): boolean {
  if (!action) return false;
  return PRODUCTION_ACTIONS.has(action.trim().toLowerCase());
}

export interface ChannelDecision {
  orderType: string;
  refused: boolean;
  reason?: 'survival_mode';
  action: string;
}

/**
 * Decide which channel an order leaves on. Never mutates its input.
 *
 * - native order types pass through unchanged;
 * - `test` + production action becomes `action`;
 * - `test` + admin/unknown action stays `test`, and is `refused` in survival
 *   mode (the live plugin has no test channel to fall back to).
 */
export function decideOrderChannel(
  orderType: string,
  action: string | null | undefined,
  survivalMode: boolean,
): ChannelDecision {
  const name = (action ?? '').trim();
  if (NATIVE_ORDER_TYPES.has(orderType)) {
    return { orderType, refused: false, action: name };
  }
  if (orderType === 'test') {
    if (isProductionAction(name)) {
      return { orderType: PRODUCTION_ORDER_TYPE, refused: false, action: name };
    }
    if (survivalMode) {
      return { orderType, refused: true, reason: SURVIVAL_REASON, action: name };
    }
  }
  return { orderType, refused: false, action: name };
}

/**
 * The 409 body a refused channel sends: same shape (and wording) as
 * `survivalRefusal()`, so a route and an executor refusal read the same.
 */
export function survivalChannelRefusal(action: string): SurvivalRefusal {
  return survivalRefusal(action);
}
