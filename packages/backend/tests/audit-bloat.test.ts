import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { Dispatcher, type OrderSender } from '../src/dispatcher.js';
import { AlertDelivery } from '../src/demo/alerts/delivery.js';
import { ALERTS_SETTINGS_DEFAULTS } from '../src/demo/alerts/settings.js';
import { AuditRetention, retentionDaysFromEnv } from '../src/auditRetention.js';
import { lookupOrderResult, orderResults } from '../src/orderResults.js';
import type { Alert, Store } from '../src/store.js';
import { makeClock, makeConfig, memoryStore, tempDir, waitFor } from './helpers.js';
import { FakePlugin } from './fakePlugin.js';

/**
 * Audit-table bloat (2026-11-11).
 *
 * The `audit` table reached 3.3 GB in a day. Three writers dominated it:
 *
 * | action           | rows/day | why                                              |
 * |------------------|----------|--------------------------------------------------|
 * | `plugin_event`   | 35.9 k   | every action/poller `order_result`, non-routine   |
 * | `alert_delivered`| 34.6 k   | each RE-delivery of an alert already up           |
 * | `ack_unknown`    | 34.4 k   | acks for `demo:*` actions (never in `orders`)     |
 *
 * Each is fixed at its source here, and a retention job bounds the rest.
 * Nothing about flight / mission / safety / admin rows changes: those are
 * state changes and keep their rows.
 */

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

describe('B audit sources: routine traffic never reaches the business audit', () => {
  let runtime: Runtime;
  let plugin: FakePlugin;
  let port = 0;

  beforeAll(async () => {
    // The event path is env-independent; a plain runtime is the honest fixture.
    delete process.env.RTS_DEMO;
    delete process.env.RTS_ENV;
    delete process.env.RTS_TEST_SERVER_MARKER;
    const clock = makeClock();
    runtime = createRuntime({ config: makeConfig({ token: '' }), memory: true, clock: clock.now });
    port = await runtime.listen(0);
    plugin = await FakePlugin.connect(port);
    plugin.hello();
    await waitFor(() => runtime.hub.isConnected(), (connected) => connected === true);
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    plugin.close();
    await runtime.close();
  });

  const event = (orderId: string, eventType = 'order_result') => ({
    schemaVersion: 1,
    type: 'event',
    eventType,
    entityId: 'grid:1',
    at: Date.now(),
    data: { orderId, ok: true, result: {} },
  });

  it('counts a demo:* action result instead of storing a row', async () => {
    const before = runtime.store.routineStats().total;
    const orderId = 'demo:power:63591de9-322c-4675-8ae7-9b5fb42ed00e';
    plugin.send(event(orderId));
    await waitFor(() => runtime.store.routineStats().total, (n) => n >= before + 1);
    const business = runtime.store.listAudit(500).filter((a) => a.action === 'plugin_event');
    expect(business, 'a fire-and-forget action result is not business evidence').toHaveLength(0);
    const everything = runtime.store
      .listAudit(500, { includeRoutine: true })
      .filter((a) => a.action === 'plugin_event');
    expect(everything, 'routine traffic is not written at all, not even flagged').toHaveLength(0);
    // The counter and the in-memory bus are the replacement for the row.
    expect(runtime.store.routineStats().byAction.plugin_event).toBeGreaterThan(0);
    expect(orderResults.peek(orderId), 'the waiter still sees the result').not.toBeNull();
    // Still readable by the order-result lookup that used to scan the table.
    expect(lookupOrderResult(runtime.store, orderId)?.ok).toBe(true);
  });

  it('keeps a control-channel (ord:) result in the business audit', async () => {
    plugin.send(event('ord:m-1:grid:1:a1'));
    await waitFor(
      () => runtime.store.listAudit(500).filter((a) => a.action === 'plugin_event').length,
      (n) => n >= 1,
    );
    const business = runtime.store.listAudit(500).filter((a) => a.action === 'plugin_event');
    expect(business).toHaveLength(1);
    expect(business[0]!.subject).toBe('grid:1');
  });

  it('still audits an order_error - errors are never routine', async () => {
    plugin.send(event('demo:guard:stop:now', 'order_error'));
    await waitFor(
      () => runtime.store.listAudit(500).filter((a) => a.action === 'plugin_event').length,
      (n) => n >= 2,
    );
  });

  it('keeps the stored row small: a 12 KB poller body leaves no row at all', async () => {
    // Measured on `data/rts.db` 2026-11-11: `plugin_event` order_result rows
    // averaged 12,011 B (max 268,709 B) and made 90 k rows/day. The fixture
    // below sends ten of them, shaped like the live `radio_links` body.
    const big = {
      sampledAt: 1,
      grids: Array.from({ length: 40 }, (_, i) => ({ grid: `grid:${i}`, pads: 'x'.repeat(240) })),
    };
    const before = runtime.store.routineStats().total;
    for (let i = 0; i < 10; i += 1) {
      plugin.send({
        schemaVersion: 1,
        type: 'event',
        eventType: 'order_result',
        entityId: 'grid:1',
        at: Date.now(),
        data: { orderId: `demo:radio_links:${i}`, ok: true, result: big },
      });
    }
    await waitFor(() => runtime.store.routineStats().total, (n) => n >= before + 10);

    const payloadBytes = JSON.stringify({ eventType: 'order_result', data: { orderId: 'x', ok: true, result: big } }).length;
    expect(payloadBytes, 'the fixture is the size that used to be stored').toBeGreaterThan(9_000);

    const stats = runtime.store.db
      .prepare('SELECT COUNT(*) AS n, IFNULL(AVG(LENGTH(detail)), 0) AS av FROM audit')
      .get() as { n: number; av: number };
    // Only the business rows written by the earlier tests of this block.
    expect(stats.n).toBeLessThanOrEqual(3);
    expect(stats.av, 'a stored business row is well under 1 KB here').toBeLessThan(1_024);
  });
});

describe('B ack_unknown: acks for fire-and-forget ids are expected, not anomalies', () => {
  class SilentSender implements OrderSender {
    send(): boolean {
      return true;
    }
    isConnected(): boolean {
      return true;
    }
    agentId(): string | null {
      return 'fake-plugin';
    }
  }

  const dispatcherOn = (store: Store, clock = makeClock()) =>
    new Dispatcher(
      store,
      new SilentSender(),
      { maxAttempts: 3, backoffMs: 500, maxOrdersPerMinute: 60, comms: {} },
      clock.now,
    );

  it('does not audit the 41 k/day of demo:* / provision:* acks', () => {
    const store = memoryStore();
    const dispatcher = dispatcherOn(store);
    const ids = [
      'demo:power:63591de9-322c-4675-8ae7-9b5fb42ed00e',
      'demo:guard:stop:m-1:0:1794445836614',
      'provision:laser_state:98734073-204f-40c1-8891-f1be7c7ddda0',
      'provision:list_tagged:c856c544-2f88-4de7-a9ea-368bbf0cfd43',
      'designer:profile:1',
      'staging:clone:1',
      'ord-ff70c63e-6c2c-40be-8e64-164e7bdb9d6d',
    ];
    for (const id of ids) dispatcher.onAck(id, true, undefined);
    expect(store.countAudit('ack_unknown')).toBe(0);
    // Counted instead (one line per 5 min at most - the count never grows the table).
    expect(dispatcher.foreignAckStats().total).toBe(ids.length);
  });

  it('still audits a reordered ack for a control order', () => {
    const store = memoryStore();
    const dispatcher = dispatcherOn(store);
    dispatcher.onAck('ord:never-seen:a1', true, undefined);
    expect(store.countAudit('ack_unknown')).toBe(1);
  });

  it('logs the foreign-ack counter at most once per 5 minutes', () => {
    const clock = makeClock();
    const store = memoryStore(clock.now);
    const dispatcher = dispatcherOn(store, clock);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      for (let i = 0; i < 100; i++) dispatcher.onAck(`demo:power:${i}`, true, undefined);
      expect(lines).toHaveLength(1);
      clock.advance(5 * 60_000);
      dispatcher.onAck('demo:power:again', true, undefined);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/101 acks for non-control orders/);
    } finally {
      console.log = original;
    }
  });
});

describe('B alert_delivered: the first delivery is audited, a repeat is not', () => {
  const alert = (overrides: Partial<Alert> = {}): Alert => ({
    id: 'alert-1',
    kind: 'energy-runway',
    severity: 'warn',
    subjectType: 'grid',
    subjectId: 'SAT-R-0001',
    message: 'runway low',
    evidence: {},
    actions: [],
    state: 'open',
    count: 3,
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ackedBy: null,
    resolvedAt: null,
    ...overrides,
  });

  const delivery = (store: Store, clock = makeClock()) =>
    new AlertDelivery({
      store,
      clock: clock.now,
      settings: () => ({ ...ALERTS_SETTINGS_DEFAULTS, discordWebhook: '' }),
      logger: () => {},
    });

  it('writes one row for the first delivery and none for a repeat', async () => {
    const store = memoryStore();
    const clock = makeClock();
    const d = delivery(store, clock);
    await d.deliver([{ alert: alert(), variant: 'opened' }], clock.now());
    expect(store.countAudit('alert_delivered', 'alert-1')).toBe(1);

    // Three re-deliveries of the still-open alert: the operator still sees them,
    // the audit table does not gain a row.
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await d.deliver([{ alert: alert({ count: 4 + i }), variant: 'updated' }], clock.now());
    }
    expect(store.countAudit('alert_delivered', 'alert-1')).toBe(1);
  });

  it('audits an escalation (warn -> critical) even though it is an update', async () => {
    const store = memoryStore();
    const clock = makeClock();
    const d = delivery(store, clock);
    await d.deliver([{ alert: alert(), variant: 'opened' }], clock.now());
    clock.advance(60_000);
    await d.deliver(
      [{ alert: alert({ severity: 'critical' }), variant: 'updated', escalated: true }],
      clock.now(),
    );
    expect(store.countAudit('alert_delivered', 'alert-1')).toBe(2);
    const escalation = store
      .listAudit(50)
      .filter((a) => a.action === 'alert_delivered')
      .find((a) => (a.detail as { escalated?: boolean }).escalated === true);
    expect(escalation, 'the escalation row says it escalated').toBeTruthy();
  });

  it('keeps the resolved delivery row (a state change)', async () => {
    const store = memoryStore();
    const clock = makeClock();
    const d = delivery(store, clock);
    await d.deliver([{ alert: alert({ state: 'resolved' }), variant: 'resolved' }], clock.now());
    expect(store.countAudit('alert_resolved_delivered', 'alert-1')).toBe(1);
  });
});

describe('B retention: archive first, delete after, flight rows never dropped silently', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_700_000_000_000;
  const dir = tempDir();

  const rows = (store: Store) =>
    store.listAudit(1_000, { includeRoutine: true }).map((a) => `${a.action}:${a.subject}`);

  it('archives then deletes rows older than the window, and keeps the recent ones', async () => {
    const store = memoryStore(() => NOW);
    // Old: a flight row and a mission row (both business rows, 8 days old).
    store.audit({ actor: 'demo', action: 'demo_flight_started', subject: 'grid:old', at: NOW - 8 * DAY });
    store.audit({ actor: 'mission', action: 'mission_created', subject: 'm-old', at: NOW - 8 * DAY });
    // Recent: must survive.
    store.audit({ actor: 'demo', action: 'demo_flight_landed', subject: 'grid:new', at: NOW - 1 * DAY });
    store.audit({ actor: 'mission', action: 'mission_approved', subject: 'm-new', at: NOW - 2 * 60_000 });

    const retention = new AuditRetention({
      store,
      archiveDir: path.join(dir, 'archive'),
      retentionDays: 7,
      clock: () => NOW,
      log: () => {},
    });
    const result = await retention.run(NOW);

    expect(result.archived).toBe(2);
    expect(result.deleted).toBe(2);
    expect(rows(store)).toEqual(['mission_approved:m-new', 'demo_flight_landed:grid:new']);

    // The archive holds what was deleted, in the same CSV shape as the manual
    // archives (`data/archive/audit-<from>-<to>.csv.gz`).
    expect(result.file).toBeTruthy();
    expect(path.basename(result.file!)).toMatch(/^audit-\d{8}T\d{4}-\d{8}T\d{4}\.csv\.gz$/);
    const text = zlib.gunzipSync(fs.readFileSync(result.file!)).toString('utf8');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('id,at,actor,action,subject,detail,rollback_point,routine');
    expect(lines).toHaveLength(3);
    expect(text).toContain('demo_flight_started');
    expect(text).toContain('mission_created');
  });

  it('archives in batches and keeps the paging honest across a page boundary', async () => {
    const store = memoryStore(() => NOW);
    const total = AuditRetention.BATCH * 2 + 7;
    for (let i = 0; i < total; i++) {
      store.audit({ actor: 'demo', action: 'demo_flight_tick', subject: `grid:${i}`, at: NOW - 9 * DAY + i });
    }
    const retention = new AuditRetention({
      store,
      archiveDir: path.join(dir, 'archive'),
      retentionDays: 7,
      clock: () => NOW,
      log: () => {},
    });
    const result = await retention.run(NOW);
    expect(result.archived).toBe(total);
    expect(result.deleted).toBe(total);
    expect(store.countAudit('demo_flight_tick')).toBe(0);

    const text = zlib.gunzipSync(fs.readFileSync(result.file!)).toString('utf8');
    const subjects = text
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(',')[4]);
    expect(subjects).toHaveLength(total);
    expect(new Set(subjects).size, 'no row archived twice').toBe(total);
  });

  it('deletes nothing when disabled', async () => {
    const store = memoryStore(() => NOW);
    store.audit({ actor: 'demo', action: 'demo_flight_started', subject: 'grid:old', at: NOW - 30 * DAY });
    const retention = new AuditRetention({
      store,
      archiveDir: path.join(dir, 'off'),
      retentionDays: 0,
      clock: () => NOW,
      log: () => {},
    });
    expect(retention.enabled).toBe(false);
    const result = await retention.run(NOW);
    expect(result).toMatchObject({ archived: 0, deleted: 0, file: null });
    expect(store.countAudit('demo_flight_started')).toBe(1);
    expect(fs.existsSync(path.join(dir, 'off'))).toBe(false);
  });

  it('reads its window from the environment, defaulting to 7 days', () => {
    expect(retentionDaysFromEnv({} as NodeJS.ProcessEnv)).toBe(7);
    expect(retentionDaysFromEnv({ RTS_AUDIT_RETENTION_DAYS: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(retentionDaysFromEnv({ RTS_AUDIT_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(retentionDaysFromEnv({ RTS_AUDIT_RETENTION: 'off' } as NodeJS.ProcessEnv)).toBe(0);
    // A garbage value must never mean "delete everything now".
    expect(retentionDaysFromEnv({ RTS_AUDIT_RETENTION_DAYS: 'soon' } as NodeJS.ProcessEnv)).toBe(0);
  });

  it('does not re-use an archive file for the same range', async () => {
    const store = memoryStore(() => NOW);
    const retention = new AuditRetention({
      store,
      archiveDir: path.join(dir, 'archive'),
      retentionDays: 7,
      clock: () => NOW,
      log: () => {},
    });
    store.audit({ actor: 'demo', action: 'demo_flight_started', subject: 'grid:a', at: NOW - 8 * DAY });
    const first = await retention.run(NOW);
    store.audit({ actor: 'demo', action: 'demo_flight_started', subject: 'grid:a', at: NOW - 8 * DAY });
    const second = await retention.run(NOW);
    expect(first.file).not.toBe(second.file);
  });
});
