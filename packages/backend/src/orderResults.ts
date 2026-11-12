/**
 * Order-result delivery (sim-speed audit #7).
 *
 * Every poller used to find its own answer by re-reading the audit table:
 * `listOrderResults(500)` in a 100 ms loop, up to ten 500-row reads per second
 * against a multi-GB SQLite, on the same event loop the demo flight tick runs
 * on. That is the documented flight-tick starvation path.
 *
 * The answer already arrives on the WebSocket (`order_result` event). This
 * module keeps it in memory:
 *
 *   - `record()` is called from the plugin event handler, synchronously, so a
 *     waiting poller wakes on the same tick the frame arrived (no polling).
 *   - `waitForOrderResult()` awaits that in-memory delivery and falls back to a
 *     *cursor* read (`rowid > lastSeen`) at most once per second, only while an
 *     order is outstanding. A result that arrives before anyone waits is kept
 *     (bounded, 2 min TTL) and consumed by the waiter.
 *
 * Nothing here touches order acks: `ack` frames still go straight to the
 * dispatcher. This only replaces how a *result body* is looked up.
 */
import type { Store } from './store.js';

export interface OrderResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** How many delivered-but-unconsumed results are kept (bounded memory). */
const MAX_ENTRIES = 256;
/** A kept result is useless to a waiter after its order's timeout. */
const TTL_MS = 120_000;
/** Cursor fallback cadence, ms. Only runs while an order is outstanding. */
export const FALLBACK_POLL_MS = 1_000;

interface StoredResult {
  at: number;
  value: OrderResult;
}

export class OrderResultBus {
  private readonly stored = new Map<string, StoredResult>();
  private readonly waiters = new Map<string, (value: OrderResult) => void>();

  /** Deliver a result. Wakes a waiter on this tick, else keeps it. */
  record(orderId: string, value: OrderResult, at = Date.now()): void {
    if (!orderId) return;
    const waiter = this.waiters.get(orderId);
    if (waiter) {
      this.waiters.delete(orderId);
      waiter(value);
      return;
    }
    this.stored.set(orderId, { at, value });
    this.prune(at);
  }

  /** Take a result that arrived before the waiter started waiting. */
  take(orderId: string): OrderResult | null {
    const hit = this.stored.get(orderId);
    if (!hit) return null;
    this.stored.delete(orderId);
    return hit.value;
  }

  /**
   * Read a result WITHOUT consuming it. For the lookups that are not waiters —
   * staging reads a whole batch at once, the executor reads a probe or a
   * landing's report after the fact — a `take` would eat the result another
   * caller still needs.
   */
  peek(orderId: string): OrderResult | null {
    return this.stored.get(orderId)?.value ?? null;
  }

  /**
   * Await delivery for `timeoutMs`. Resolves null on timeout. Consumes the
   * value, so a single result is never handled twice.
   */
  wait(orderId: string, timeoutMs: number): Promise<OrderResult | null> {
    const early = this.take(orderId);
    if (early) return Promise.resolve(early);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: OrderResult | null) => {
        if (done) return;
        done = true;
        this.waiters.delete(orderId);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.set(orderId, (value) => {
        clearTimeout(timer);
        finish(value);
      });
    });
  }

  size(): number {
    return this.stored.size;
  }

  reset(): void {
    this.stored.clear();
    for (const [, resolve] of this.waiters) resolve({ ok: false, error: 'bus reset' });
    this.waiters.clear();
  }

  private prune(at: number): void {
    for (const [id, entry] of this.stored) {
      if (at - entry.at <= TTL_MS) continue;
      this.stored.delete(id);
    }
    // Insertion order is delivery order: drop the oldest beyond the cap.
    while (this.stored.size > MAX_ENTRIES) {
      const oldest = this.stored.keys().next().value;
      if (oldest === undefined) break;
      this.stored.delete(oldest);
    }
  }
}

/** Process-wide bus: the plugin event handler and every poller share it. */
export const orderResults = new OrderResultBus();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the result of `orderId`, event-first:
 *
 *   1. a result already delivered to the bus is taken immediately;
 *   2. otherwise the cursor is primed ONCE with the current max audit rowid, so
 *      the fallback reads only rows that arrived after the order was sent — and
 *      it re-reads at most once per second, not every 100 ms;
 *   3. the bus resolves the wait the moment the frame arrives.
 *
 * The fallback exists because a result can be recorded only in the audit table
 * (a process that restarted, a test hub writing rows directly). It is a cursor
 * read of new rows, never a 500-row rescan.
 */
export async function waitForOrderResult(
  store: Store,
  orderId: string,
  timeoutMs: number,
  opts: { sinceRowid?: number; bus?: OrderResultBus } = {},
): Promise<OrderResult | null> {
  const bus = opts.bus ?? orderResults;
  const early = bus.take(orderId);
  if (early) return early;

  const deadline = Date.now() + Math.max(0, timeoutMs);
  // The cursor must be taken BEFORE the order is sent (or before the result can
  // be written), otherwise a synchronous answer lands below it and is invisible.
  // Callers that send first pass their own `sinceRowid`.
  const cursor = { rowid: opts.sinceRowid ?? store.maxAuditRowid() };
  for (;;) {
    const fromDb = findInStore(store, orderId, cursor);
    if (fromDb) return fromDb;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    // Event-driven: resolves the moment the frame arrives. The timeout only
    // bounds how often the cursor fallback looks at the table (1 /s).
    const hit = await bus.wait(orderId, Math.min(FALLBACK_POLL_MS, left));
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
  }
}

function findInStore(store: Store, orderId: string, cursor: { rowid: number }): OrderResult | null {
  for (const row of store.listOrderResultsAfter(cursor.rowid, 100)) {
    if (row.rowid > cursor.rowid) cursor.rowid = row.rowid;
    const detail = row.entry.detail as {
      eventType?: string;
      data?: { orderId?: string; ok?: boolean; error?: string; result?: Record<string, unknown> };
    };
    if (detail?.eventType !== 'order_result') continue;
    if (detail.data?.orderId !== orderId) continue;
    const data = detail.data;
    return { ok: data.ok !== false, result: data.result, error: data.error };
  }
  return null;
}

/** Test helper: forget every kept result. */
export function resetOrderResultsForTests(): void {
  orderResults.reset();
}

/**
 * One order's result for a caller that is NOT waiting: memory first (the tick
 * the frame arrived), then the audit table (control-channel rows only).
 *
 * This is the replacement for `for (row of store.listOrderResults(400)) if
 * (row.orderId === id)`. That scan read the audit window, so it silently broke
 * when routine rows stopped being stored — and it cost a 400-row LIKE scan per
 * call. `maxAgeMs` keeps the durable half honest: a result older than the
 * order's timeout is not this order's answer.
 */
export function lookupOrderResult(
  store: Store,
  orderId: string,
  opts: { bus?: OrderResultBus; maxAgeMs?: number; now?: number } = {},
): OrderResult | null {
  const bus = opts.bus ?? orderResults;
  const peeked = bus.peek(orderId);
  if (peeked) return peeked;
  // The store's clock wrote every `at`; Date.now() would be wrong in a test
  // runtime and would hide a result that is actually five seconds old.
  const now = opts.now ?? store.now();
  const entry = store.findOrderResult(orderId, now - (opts.maxAgeMs ?? 5 * 60_000));
  if (!entry) return null;
  const detail = entry.detail as {
    eventType?: string;
    data?: { orderId?: string; ok?: boolean; error?: string; result?: Record<string, unknown> };
  };
  if (detail?.eventType !== 'order_result') return null;
  const data = detail.data;
  if (data?.orderId !== orderId) return null;
  return { ok: data.ok !== false, result: data.result, error: data.error };
}
