/**
 * Safety-order exemption from the comms gate.
 *
 * Measured in game 2026-11-10: during a free fall at 142 m doing -47 m/s a
 * brake order was REFUSED by the comms gate (HTTP 409 `comms_rejected`) and the
 * hull hit the ground and was destroyed. The gate exists to stop us commanding
 * a ship we may not be able to reach — but a command that can only REMOVE
 * energy cannot make a bad situation worse: if it arrives, the ship is safer;
 * if it does not, nothing was lost. Refusing it is strictly harmful.
 *
 * The test is deliberately narrow and mechanical — "can this order only reduce
 * the ship's energy?" — so movement stays gated:
 *
 *   * `stop` (order type or action): the plugin disables the autopilot and
 *     clears its waypoints. It cannot accelerate anything.
 *   * `set_dampeners { on: true }`: dampeners only ever remove relative
 *     velocity. `on: false` is NOT in this list: releasing the brake lets
 *     gravity take over, which adds energy.
 *   * `zero_velocity`: zeroes the physics body's velocity.
 *   * `hold` at the ship's CURRENT position (no target, or a target within
 *     SAFETY_HOLD_RADIUS_M): commands zero velocity where the ship already is.
 *     A hold somewhere else is a movement order and stays gated.
 *   * `brake` / `kill`: the names the operator pages and the test harness use
 *     for the same two things.
 *
 * Everything else — `move`, `waypoint`, `drive`, `level_hold`/`level_move`
 * (which drive thrusters and can climb), a hold on a distant slot — is gated
 * exactly as before.
 */

/** A hold this close to the ship's own position can only remove velocity, m. */
export const SAFETY_HOLD_RADIUS_M = 50;

export interface SafetyOrderInput {
  orderType: string;
  params?: Record<string, unknown> | null;
  /**
   * The grid's current position when the caller has fresh telemetry. Without
   * it a hold that carries coordinates cannot be proven local, so it is not
   * exempt.
   */
  position?: { x: number; y: number; z: number } | null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function targetOf(params: Record<string, unknown>): { x: number; y: number; z: number } | null {
  const nested = params.target as Record<string, unknown> | undefined;
  const source = nested && typeof nested === 'object' ? nested : params;
  const x = num(source.x);
  const y = num(source.y);
  const z = num(source.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/**
 * Why this order can only reduce the ship's energy, or null when it cannot be
 * proven to (then the comms gate decides, as for any movement order).
 */
export function safetyOrderReason(input: SafetyOrderInput): string | null {
  const orderType = String(input.orderType ?? '').toLowerCase();
  const params = input.params ?? {};
  const action = String((params.action as unknown) ?? '').toLowerCase();
  const dampenersOn = params.on === undefined ? true : params.on === true;

  if (orderType === 'stop' || action === 'stop') {
    return 'stop disables the autopilot and clears its waypoints: it can only remove commanded motion';
  }
  if (action === 'zero_velocity') {
    return 'zero_velocity zeroes the physics body velocity: it can only remove energy';
  }
  if (action === 'set_dampeners' && dampenersOn) {
    return 'dampeners on can only remove velocity (dampeners off would release the brake and is gated)';
  }
  if (action === 'brake' || action === 'kill') {
    return `${action} only slows or stops the ship`;
  }
  if (orderType === 'hold' || action === 'hold') {
    const target = targetOf(params);
    if (!target) return 'hold at the ship’s current position commands zero velocity where it already is';
    const position = input.position;
    if (!position) return null;
    const distance = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
    if (distance <= SAFETY_HOLD_RADIUS_M) {
      return `hold ${Math.round(distance)} m from the ship (inside the ${SAFETY_HOLD_RADIUS_M} m safety radius): commands zero velocity where it already is`;
    }
    return null;
  }
  return null;
}

/** Convenience: the boolean half, for callers that only need the decision. */
export function isSafetyOrder(input: SafetyOrderInput): boolean {
  return safetyOrderReason(input) !== null;
}
