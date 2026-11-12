/**
 * Order-id namespaces (2026-11-11).
 *
 * There are two kinds of order id on the wire, and they matter differently:
 *
 * - **control channel** — `ord:<missionId>:<unitId>:a<attempt>`, built by the
 *   dispatcher, persisted in the `orders` table, driven by mission state. Its
 *   acks and results are business state changes.
 * - **fire-and-forget commands** — everything else: the demo executor's
 *   `demo:*` actions (`demo:power:*`, `demo:guard:*`, `demo:probe:*`, …), the
 *   provisioner's `provision:*` pollers, `designer:*` / `staging:*` actions and
 *   the manual `ord-<uuid>` test orders from `/api/test/order`. None of them is
 *   ever inserted into `orders`, so their acks are EXPECTED to be "unknown".
 *
 * Verify #4 measured 34 k `ack_unknown` rows/day, 41 910 of them `demo:*`: the
 * ack handler was auditing an expected condition as an anomaly. The rule is
 * namespace-based, not "was the order found", so a genuine reordered ack for a
 * control order is still audited.
 */
export function isControlOrderId(orderId: unknown): boolean {
  return typeof orderId === 'string' && orderId.startsWith('ord:');
}
