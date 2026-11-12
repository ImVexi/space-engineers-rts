/**
 * FAILURE 3, gated only (overnight run 2026-11-10): `snap_dock` destroyed the
 * hull it docked.
 *
 * The plugin's connector-gap search is measured connector-to-connector and
 * ignores hull depth, so the aligner flew SAT-L-0006 into the target station
 * (61 blocks / 20 401 kg -> 10 blocks / 284 kg) while reporting a 0.2 m /
 * 0.0 degree pose, and the engine never reported `Connected`. Until that
 * geometry is fixed the backend must be unable to put a `snap_dock` order on
 * the wire: feature flag `snap_dock_execute`, OFF by default, same mechanism
 * as `fleet_ops_execute`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakePlugin } from './fakePlugin.js';
import { makeClock, makeConfig, httpRequest } from './helpers.js';

const PORT = 8913;

describe('snap_dock execution gate (FAILURE 3, 2026-11-10)', () => {
  let runtime: Runtime;
  let plugin: FakePlugin;

  beforeAll(async () => {
    const clock = makeClock();
    runtime = createRuntime({ config: makeConfig({ port: PORT }), clock: clock.now });
    await runtime.listen(PORT);
    plugin = await FakePlugin.connect(PORT);
    plugin.hello();
    await plugin.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
  });

  afterAll(async () => {
    await plugin.close();
    await runtime.close();
  });

  const snapDockOrder = {
    orderType: 'test',
    entityId: 'grid:94562719844060513',
    params: {
      action: 'snap_dock',
      gridId: 'grid:94562719844060513',
      targetGridId: 'grid:78428572013092142',
      targetConnectorBlockId: 1,
      captureRadiusM: 40,
    },
  };
  const snapDockOrders = () =>
    plugin.received.filter(
      (m) => m.type === 'order' && (m.params as { action?: string } | undefined)?.action === 'snap_dock',
    );

  it('(e) refuses the order with the flag OFF, audits it, and sends nothing', async () => {
    const res = await httpRequest<{ error: { code: string; message: string } }>(
      PORT,
      'POST',
      '/api/test/order',
      snapDockOrder,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('flag_off');
    expect(res.body.error.message).toMatch(/snap_dock is disabled/);
    expect(res.body.error.message).toMatch(/snap_dock_execute/);

    // Nothing reached the plugin.
    expect(snapDockOrders()).toHaveLength(0);
    // The refusal is in the audit, in plain language.
    const refused = runtime.store.listAudit(200).filter((row) => row.action === 'snap_dock_refused');
    expect(refused).toHaveLength(1);
    const detail = refused[0]!.detail as { flag?: string; flagOn?: boolean; reason?: string; note?: string };
    expect(detail.flag).toBe('snap_dock_execute');
    expect(detail.flagOn).toBe(false);
    expect(String(detail.reason)).toMatch(/connector gaps ignore hull depth/);
    expect(String(detail.note)).toMatch(/no order was sent/);

    // A normal test order still goes through: the gate is specific.
    const other = await httpRequest<{ sent: boolean }>(PORT, 'POST', '/api/test/order', {
      orderType: 'test',
      entityId: 'grid:94562719844060513',
      params: { action: 'diag', entityId: 'grid:94562719844060513' },
    });
    expect(other.status).toBe(200);
    expect(other.body.sent).toBe(true);
  });

  it('(e) sends the order once an operator enables snap_dock_execute', async () => {
    runtime.store.setFlag('snap_dock_execute', true, 'test');
    const res = await httpRequest<{ sent: boolean; orderId: string }>(PORT, 'POST', '/api/test/order', snapDockOrder);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    const sent = await plugin.nextMessage(
      (m) => m.type === 'order' && (m.params as { action?: string } | undefined)?.action === 'snap_dock',
    );
    expect(String(sent.orderId)).toBe(res.body.orderId);
    expect(runtime.store.listAudit(200).filter((row) => row.action === 'snap_dock_refused')).toHaveLength(1);
  });
});
