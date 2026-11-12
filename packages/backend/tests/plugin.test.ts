import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { createMission, approveMission } from '../src/missions.js';
import { FakePlugin } from './fakePlugin.js';
import { makeClock, makeConfig, missionInput, waitFor } from './helpers.js';

const PORT = 8768;
const TOKEN = 'test-token-please-change';

describe('plugin WebSocket protocol (server side)', () => {
  let runtime: Runtime;
  let clock: ReturnType<typeof makeClock>;
  let plugin: FakePlugin;

  beforeAll(async () => {
    clock = makeClock();
    runtime = createRuntime({
      config: makeConfig({ port: PORT, token: TOKEN, flags: { dispatch: true, reconciler: true } }),
      clock: clock.now,
    });
    await runtime.listen(PORT);
  });

  afterAll(async () => {
    await runtime.close();
  });

  const connect = async (opts: { token?: string; queryToken?: string } = { token: TOKEN }) => {
    const p = await FakePlugin.connect(PORT, opts);
    p.hello();
    await p.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
    return p;
  };

  it('rejects a wrong token at the upgrade', async () => {
    await expect(FakePlugin.connect(PORT, { queryToken: 'wrong-token' })).rejects.toThrow(/401/);
    expect(runtime.hub.isConnected()).toBe(false);
  });

  it('closes a plugin that never authenticates in hello', async () => {
    const p = await FakePlugin.connect(PORT);
    p.hello(); // no token field
    await waitFor(() => p.closed, (closed) => closed === true, 3000);
    expect(p.closeCode).toBe(4001);
    expect(runtime.hub.isConnected()).toBe(false);
  });

  it('accepts a token in the query string and completes the handshake', async () => {
    plugin = await connect({ queryToken: TOKEN });
    expect(runtime.hub.agentId()).toBe('fake-plugin');
    expect(runtime.hub.isConnected()).toBe(true);
    await plugin.close();
  });

  it('accepts a token from hello when the client cannot set headers', async () => {
    const p = await FakePlugin.connect(PORT);
    p.hello({ token: TOKEN });
    await p.nextMessage((m) => m.type === 'status' && m.hubState === 'ready');
    expect(runtime.hub.agentId()).toBe('fake-plugin');
    await p.close();
  });

  it('closes a socket that sends telemetry before hello', async () => {
    const p = await FakePlugin.connect(PORT);
    p.telemetry();
    await waitFor(() => p.closed, (closed) => closed === true, 3000);
    expect(p.closeCode).toBe(4001);
  });

  it('ingests telemetry into the unit store', async () => {
    plugin = await connect();
    plugin.telemetry({
      grids: [
        {
          gridId: 'grid:1001',
          name: 'Relay One',
          pos: { x: 1, y: 2, z: 3 },
          link: 'up',
          specId: 'sat-relay-mk1',
          onStation: 'orbit-A',
        },
      ],
      links: [{ a: 'grid:1001', b: 'station:home', status: 'up' }],
    });

    const unitRecord = await waitFor(
      () => runtime.store.getUnit('grid:1001'),
      (u) => u !== null && u.linkStatus === 'up',
    );
    expect(unitRecord?.specId).toBe('sat-relay-mk1');
    expect(runtime.store.listLinks()).toHaveLength(1);
    await plugin.close();
  });

  it('delivers an order to a reachable unit and records its ack once', async () => {
    plugin = await connect();
    plugin.telemetry({
      grids: [{ gridId: 'grid:2002', name: 'Relay Two', link: 'up', specId: 'sat-relay-mk1' }],
    });
    await waitFor(() => runtime.store.getUnit('grid:2002'), (u) => u !== null);

    const created = createMission(
      runtime.store,
      missionInput({ assignedUnits: ['grid:2002'], idempotencyKey: 'plugin-flow' }),
      { now: clock.now(), actor: 'test', autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) throw new Error(created.message);
    approveMission(runtime.store, created.mission.id, 'test', clock.now());

    const dispatched = runtime.dispatcher.cycle(clock.now());
    expect(dispatched.sent).toHaveLength(1);

    const order = await plugin.waitForOrder();
    expect(order.entityId).toBe('grid:2002');
    expect(order.orderId).toBe(dispatched.sent[0]);

    plugin.ack(order.orderId as string);
    await waitFor(
      () => runtime.store.getOrder(order.orderId as string)?.status,
      (status) => status === 'acked',
    );
    // Duplicate ack must be a no-op, not a second state transition.
    plugin.ack(order.orderId as string);
    await waitFor(
      () => runtime.store.countAudit('ack_duplicate'),
      (count) => count >= 1,
    );
    expect(runtime.store.getMission(created.mission.id)!.status).toBe('executing');
    await plugin.close();
  });

  it('rejects test messages when the test API flag is off', async () => {
    plugin = await connect();
    plugin.send({ schemaVersion: 1, type: 'test', action: 'teleport', params: { entityId: 'grid:1' } });
    const rejection = await plugin.nextMessage((m) => m.type === 'event' && m.eventType === 'test_rejected');
    expect((rejection.data as Record<string, unknown>).reason).toBe('test_api_disabled');
    await plugin.close();
  });

  it('reports protocol errors for malformed frames without dropping the link', async () => {
    plugin = await connect();
    plugin.ws.send('{not json');
    const error = await plugin.nextMessage((m) => m.type === 'event' && m.eventType === 'protocol_error');
    expect((error.data as Record<string, unknown>).reason).toBe('invalid_json');
    expect(runtime.hub.isConnected()).toBe(true);
    await plugin.close();
  });
});
