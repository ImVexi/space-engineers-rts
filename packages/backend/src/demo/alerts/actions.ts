/**
 * Every action an alert can recommend is an endpoint that already exists in
 * this backend. The engine never executes an action itself: the site renders
 * these buttons, the owner presses one, and the existing route does the work
 * with its own gate, kill-switch and audit checks.
 *
 * `tests/alerts.test.ts` asserts each entry against the real route table
 * (`demoRoutesFor` / `designerRoutesFor`), so a renamed route fails a test
 * instead of leaving a dead button in the UI.
 */
import type { AlertAction } from '../../store.js';

export interface AlertActionRoute {
  label: string;
  method: AlertAction['method'];
  endpoint: string;
}

/** Route constants, mirrored from the routers; the test proves they match. */
export const ALERT_ACTION_ROUTES = {
  autotuneApply: { method: 'POST', endpoint: '/api/demo/autotune/apply' },
  fleetOps: { method: 'POST', endpoint: '/api/demo/fleet-ops' },
  optimise: { method: 'POST', endpoint: '/api/demo/designer/optimise' },
  killSwitch: { method: 'POST', endpoint: '/api/demo/kill' },
  state: { method: 'GET', endpoint: '/api/demo/state' },
} as const;

export type AlertActionKey = keyof typeof ALERT_ACTION_ROUTES;

export function action(
  key: AlertActionKey,
  label: string,
  body?: Record<string, unknown>,
): AlertAction {
  const route = ALERT_ACTION_ROUTES[key];
  return {
    label,
    method: route.method,
    endpoint: route.endpoint,
    ...(body ? { body } : {}),
  };
}

/** Trim antenna range / turn lasers off: the T29 autotune path. */
export function powerSaveAction(gridId: string): AlertAction {
  return action('autotuneApply', 'Trim antenna draw', { gridIds: [gridId], dryRun: false });
}

/** Fleet operation recall: fly home, land and flag NEEDS_UPGRADE. */
export function recallAction(gridId: string): AlertAction {
  return action('fleetOps', 'Come home', { kind: 'recall', members: [gridId], dryRun: false });
}

/** T43 optimiser plan for a planet (read-only: it never moves anything). */
export function planFixAction(planet: string): AlertAction {
  return action('optimise', 'Plan a coverage fix', { planet });
}

/** Fleet view for manual inspection. */
export function fleetViewAction(): AlertAction {
  return action('state', 'Open fleet view');
}

/** Kill switch: the only existing endpoint that stops every moving grid. */
export function stopAllAction(): AlertAction {
  return action('killSwitch', 'Stop all movement', { on: true });
}
