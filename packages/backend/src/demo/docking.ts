/**
 * `snap_dock` execution gate.
 *
 * `snap_dock` is NOT safe to run near another hull. The overnight run on
 * 2026-11-10 destroyed the source grid twice: its connector-gap search is
 * measured connector-to-connector and ignores hull depth, so the aligner flew
 * SAT-L-0006 into the target station (61 blocks / 20 401 kg -> 10 blocks /
 * 284 kg, plus 10 debris grids) while reporting a perfect 0.2 m / 0.0 degree
 * pose, and the engine never reported `Connected` on either end.
 *
 * Until the plugin's geometry is fixed, the backend must be unable to put a
 * `snap_dock` order on the wire. `snap_dock_execute` is a feature flag with the
 * same mechanism (and therefore the same default) as `fleet_ops_execute`: it
 * lives in the flags table, is read per call, and is OFF unless an operator
 * sets it explicitly.
 */
import type { Store } from '../store.js';

/** Feature flag gating any `snap_dock` order. OFF unless an operator sets it. */
export const SNAP_DOCK_FLAG = 'snap_dock_execute';
/** The plugin action this gate covers. */
export const SNAP_DOCK_ACTION = 'snap_dock';

export interface SnapDockDecision {
  /** True when the order is a snap_dock order. */
  applies: boolean;
  /** True when the caller must NOT send it. */
  refused: boolean;
  action: string | null;
  flag: string;
  flagOn: boolean;
  /** Plain-language reason, suitable for the audit row and the HTTP error. */
  reason: string | null;
}

/** Action name of an order body, from `params.action` (or the order id tail). */
function actionOf(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const action = (params as { action?: unknown }).action;
  return typeof action === 'string' && action ? action : null;
}

/**
 * Decide whether a `snap_dock` order may leave the backend.
 *
 * Pure apart from the flag read, so every send path (the guarded test-order
 * route and the dispatcher) applies exactly the same rule and every refusal
 * can be audited with the same words.
 */
export function snapDockDecision(
  store: Pick<Store, 'getFlags'>,
  params: unknown,
  action = actionOf(params),
): SnapDockDecision {
  const flagOn = store.getFlags()[SNAP_DOCK_FLAG] === true;
  const applies = action === SNAP_DOCK_ACTION;
  if (!applies) {
    return { applies: false, refused: false, action, flag: SNAP_DOCK_FLAG, flagOn, reason: null };
  }
  return {
    applies: true,
    refused: !flagOn,
    action,
    flag: SNAP_DOCK_FLAG,
    flagOn,
    reason: flagOn
      ? null
      : `snap_dock is disabled: feature flag ${SNAP_DOCK_FLAG} is OFF (it defaults off). ` +
        'The action drove the source hull into the target and destroyed it on 2026-11-10 ' +
        '(its connector gaps ignore hull depth), so the backend will not send it until the ' +
        `geometry is fixed and an operator enables ${SNAP_DOCK_FLAG}.`,
  };
}
