import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { httpRequest, makeClock, makeConfig } from './helpers.js';
import { FakePlugin } from './fakePlugin.js';

/**
 * Designer plugin proxy (2026-11-11 regression).
 *
 * `callPlugin()` used to find its answer by scanning `store.listAudit(400)`.
 * When routine audit rows stopped appearing in that window (the audit-bloat
 * fix re-flags poller traffic as `routine = 1`, and 2026-11-11 stopped writing
 * those rows at all) the scan found nothing, so every designer action —
 * `identity` included — waited the full timeout and returned 504 while the
 * plugin had logged `ok=True`. The result now comes from the order-result bus,
 * which is populated on the tick the `order_result` frame arrives.
 */

const TOKEN = 'designer-result-token';
const PORT = 8874;

const ENV_KEYS = ['RTS_DEMO', 'RTS_ENV', 'RTS_TEST_SERVER_MARKER', 'RTS_TOKEN'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function testEnv(): void {
  process.env.RTS_DEMO = '1';
  process.env.RTS_ENV = 'test';
  process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
  process.env.RTS_TOKEN = TOKEN;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('designer plugin proxy: the answer comes from the order-result bus', () => {
  let runtime: Runtime | null = null;
  let plugin: FakePlugin | null = null;

  async function boot(): Promise<void> {
    restoreEnv();
    testEnv();
    const clock = makeClock();
    runtime = createRuntime({ config: makeConfig({ port: PORT, token: TOKEN }), clock: clock.now, memory: true });
    await runtime.listen(PORT);
    plugin = await FakePlugin.connect(PORT, { token: TOKEN });
    plugin.hello();
    for (let i = 0; i < 100 && !runtime.hub.isConnected(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runtime.hub.isConnected()).toBe(true);
  }

  afterEach(async () => {
    plugin?.close();
    plugin = null;
    if (runtime) await runtime.close();
    runtime = null;
    restoreEnv();
  });

  afterAll(() => restoreEnv());

  it('identity returns 200 when the plugin acks ok (was a 504 timeout)', async () => {
    await boot();
    const fake = plugin!;
    const post = httpRequest<{ action: string; ok: boolean; result?: { steamId?: string } }>(
      PORT,
      'POST',
      '/api/demo/designer/plugin',
      { action: 'identity', params: {} },
      TOKEN,
    );

    const order = (await fake.waitForOrder()) as { orderId?: string };
    const orderId = String(order.orderId);
    expect(orderId).toMatch(/^designer:identity:/);
    // The plugin answers the way the real one does: an ack and an
    // `order_result` event. Only the event carries the body.
    fake.ack(orderId, true);
    fake.send({
      schemaVersion: 1,
      type: 'event',
      eventType: 'order_result',
      entityId: 'grid:0',
      data: { orderId, ok: true, result: { steamId: '10000000000000001' } },
      at: Date.now(),
    });

    const res = await post;
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result?.steamId).toBe('10000000000000001');
  });

  it('answers from the bus, not from a scan of the audit window', async () => {
    await boot();
    const fake = plugin!;
    const post = httpRequest<{ ok: boolean; result?: { steamId?: string } }>(
      PORT,
      'POST',
      '/api/demo/designer/plugin',
      { action: 'identity', params: {} },
      TOKEN,
    );
    const order = (await fake.waitForOrder()) as { orderId?: string };
    const orderId = String(order.orderId);
    fake.send({
      schemaVersion: 1,
      type: 'event',
      eventType: 'order_result',
      entityId: 'grid:0',
      data: { orderId, ok: true, result: { steamId: '1' } },
      at: Date.now(),
    });
    const res = await post;
    expect(res.status).toBe(200);
    expect(res.body.result?.steamId).toBe('1');
    // The order itself is still audited (it is a state change: an order was
    // sent), and the answer is on the bus rather than in a row to be scanned.
    const orders = runtime!.store.listAudit(200).filter((a) => a.action === 'designer_plugin_order');
    expect(orders.map((a) => a.subject)).toContain(orderId);
  });
});
