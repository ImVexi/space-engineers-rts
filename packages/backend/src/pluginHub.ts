import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PROTOCOL_LIMITS,
  PluginMessageSchema,
  type AckMessage,
  type EventMessage,
  type HelloMessage,
  type PluginMessage,
  type StatusMessage,
  type TelemetryMessage,
  type TestMessage,
} from '@se-rts/schemas';

export interface PluginCallbacks {
  onHello: (hello: HelloMessage) => void;
  onTelemetry: (msg: TelemetryMessage) => void;
  onEvent: (msg: EventMessage) => void;
  onAck: (msg: AckMessage) => void;
  onStatus: (msg: StatusMessage) => void;
  onTest?: (msg: TestMessage) => void;
  onProtocolError?: (detail: { reason: string; raw?: string }) => void;
}

export interface PluginHubOptions {
  token: string;
  testApiEnabled: () => boolean;
  callbacks: PluginCallbacks;
}

function tokenFromRequest(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Plugin-initiated WebSocket endpoint. The game server opens the connection
 * outbound; the backend never dials the game server. Bearer auth is required
 * whenever a token is configured (or whenever the bind is non-loopback, which
 * config.ts enforces).
 */
export class PluginHub {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: PROTOCOL_LIMITS.maxPayloadBytes,
  });
  private socket: WebSocket | null = null;
  private hello: HelloMessage | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private status: StatusMessage | null = null;

  constructor(private readonly opts: PluginHubOptions) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const supplied = tokenFromRequest(req);
    // Header/query token can authenticate the socket up front. A plugin that
    // cannot set headers may still authenticate inside `hello` (within 5 s).
    if (this.opts.token && supplied && !safeEqual(supplied, this.opts.token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const needsHelloToken = Boolean(this.opts.token && !supplied);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, needsHelloToken));
  }

  private connection(ws: WebSocket, needsHelloToken: boolean): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // One plugin agent per backend in this scaffold; replace and tell the old
      // socket why instead of silently issuing orders to a dead link.
      this.socket.close(4002, 'replaced by newer plugin connection');
    }
    this.socket = ws;
    this.hello = null;
    this.status = null;

    this.helloTimer = setTimeout(() => {
      this.opts.callbacks.onProtocolError?.({ reason: 'hello_timeout' });
      ws.close(4001, 'hello required');
    }, PROTOCOL_LIMITS.helloTimeoutMs);

    ws.on('message', (data) => this.onMessage(ws, data.toString(), needsHelloToken));
    ws.on('close', () => {
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      if (this.socket === ws) {
        this.socket = null;
        this.hello = null;
      }
    });
    ws.on('error', () => {
      /* close handler cleans up */
    });
  }

  private onMessage(ws: WebSocket, raw: string, needsHelloToken: boolean): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.callbacks.onProtocolError?.({ reason: 'invalid_json', raw: raw.slice(0, 200) });
      this.sendEvent('protocol_error', { reason: 'invalid_json' });
      return;
    }

    const parsed = PluginMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.opts.callbacks.onProtocolError?.({
        reason: 'invalid_message',
        raw: raw.slice(0, 200),
      });
      this.sendEvent('protocol_error', {
        reason: 'invalid_message',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    const msg = parsed.data;

    if (!this.hello) {
      if (msg.type !== 'hello') {
        ws.close(4001, 'hello required first');
        return;
      }
      if (needsHelloToken && (!msg.token || !safeEqual(msg.token, this.opts.token))) {
        ws.close(4001, 'invalid token');
        return;
      }
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.hello = msg;
      this.opts.callbacks.onHello(msg);
      this.send({
        schemaVersion: 1,
        type: 'status',
        hubState: 'ready',
        queueDepth: 0,
        note: 'hello accepted',
      });
      return;
    }

    switch (msg.type) {
      case 'telemetry':
        this.opts.callbacks.onTelemetry(msg);
        break;
      case 'event':
        this.opts.callbacks.onEvent(msg);
        break;
      case 'ack':
        this.opts.callbacks.onAck(msg);
        break;
      case 'status':
        this.status = msg;
        this.opts.callbacks.onStatus(msg);
        break;
      case 'test':
        if (!this.opts.testApiEnabled()) {
          this.sendEvent('test_rejected', { reason: 'test_api_disabled' });
          break;
        }
        this.opts.callbacks.onTest?.(msg);
        break;
      case 'hello':
        // A second hello is a protocol error, not a re-auth.
        this.sendEvent('protocol_error', { reason: 'duplicate_hello' });
        break;
      case 'order':
        this.sendEvent('protocol_error', { reason: 'order_from_plugin' });
        break;
      default:
        break;
    }
  }

  /** Send a message to the connected plugin. Returns false when offline. */
  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.hello) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  sendEvent(eventType: string, data: Record<string, unknown>): void {
    this.send({ schemaVersion: 1, type: 'event', eventType, data, at: Date.now() });
  }

  isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.hello);
  }

  agentId(): string | null {
    return this.hello?.agentId ?? null;
  }

  agentInfo(): Omit<HelloMessage, 'schemaVersion' | 'type' | 'token'> | null {
    if (!this.hello) return null;
    const { schemaVersion: _v, type: _t, token: _tok, ...rest } = this.hello;
    return rest;
  }

  lastStatus(): StatusMessage | null {
    return this.status;
  }

  async close(): Promise<void> {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** Website-facing state delta socket (GET /ws). */
export class StateHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly opts: { token: string; snapshot: () => unknown }) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.opts.token) {
      const supplied = tokenFromRequest(req);
      if (!supplied || !safeEqual(supplied, this.opts.token)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: 'snapshot', at: Date.now(), state: this.opts.snapshot() }));
    });
  }

  broadcast(delta: unknown): void {
    const payload = JSON.stringify(delta);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
