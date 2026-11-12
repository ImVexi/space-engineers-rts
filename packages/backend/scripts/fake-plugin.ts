import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';

/**
 * Minimal fake plugin for local demos: connects outbound, says hello, streams
 * one synthetic grid, and acks every order it receives. Test-only scaffolding.
 */
const config = loadConfig();
const url = `ws://${config.bind === '0.0.0.0' ? '127.0.0.1' : config.bind}:${config.port}/plugin${
  config.token ? `?token=${encodeURIComponent(config.token)}` : ''
}`;

const ws = new WebSocket(url);
let tick = 0;

ws.on('open', () => {
  // eslint-disable-next-line no-console
  console.log(`[fake-plugin] connected to ${url}`);
  ws.send(
    JSON.stringify({
      schemaVersion: 1,
      type: 'hello',
      agentId: 'fake-plugin',
      serverId: 'local-dev',
      version: '0.1.0',
      capabilities: ['telemetry', 'orders'],
    }),
  );
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as { type: string; orderId?: string };
  // eslint-disable-next-line no-console
  console.log('[fake-plugin] <-', JSON.stringify(msg));
  if (msg.type === 'order' && msg.orderId) {
    ws.send(
      JSON.stringify({
        schemaVersion: 1,
        type: 'ack',
        orderId: msg.orderId,
        ok: true,
        at: Date.now(),
      }),
    );
  }
});

const timer = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  tick += 1;
  ws.send(
    JSON.stringify({
      schemaVersion: 1,
      type: 'telemetry',
      tick,
      at: Date.now(),
      grids: [
        {
          gridId: 'grid:1001',
          name: 'Dev Relay',
          pos: { x: 0, y: 0, z: 0 },
          link: 'up',
          specId: 'sat-relay-mk1',
          powerFraction: 0.9,
          fuelFraction: 1,
        },
      ],
      contacts: [],
      links: [],
      ledgerDelta: [],
    }),
  );
}, 2000);
timer.unref?.();

ws.on('close', () => {
  // eslint-disable-next-line no-console
  console.log('[fake-plugin] disconnected');
  process.exit(0);
});
ws.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[fake-plugin] error', err.message);
  process.exit(1);
});
