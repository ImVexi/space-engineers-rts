import WebSocket from 'ws';

export interface FakePluginOptions {
  token?: string;
  queryToken?: string;
  agentId?: string;
}

/** Options for `answerExecutorOrders`. */
export interface ExecutorAnswerOptions {
  /** Timestamp for the synthetic acks (default: Date.now()). */
  now?: number;
  /** `convert_to_station` reports a static grid afterwards (default true). */
  staticAfterConvert?: boolean;
  /**
   * The identity the ownership handshake must read back. When given, an
   * `ownership` / `ownership_check` order carrying a different `ownerId` is
   * answered `applied: false`, exactly as the real plugin would.
   */
  identityId?: string;
}

/** Every action the executor can put in `params.action`. */
const EXECUTOR_ACTIONS = new Set([
  'identity',
  'ownership',
  'ownership_check',
  'wake',
  'ai_off',
  'diag',
  'inspect',
  'probe_ground',
  'convert_to_ship',
  'convert_to_station',
  'is_under_control',
  'set_block_props',
  'spawn_prefab',
  'clone_grid',
  'list_grids',
  'move',
  'hold',
  'stop',
]);

/**
 * The executor labels most orders in `params.action`, but its `send()` writes
 * the action into the order id (`demo:<mission>:<idx>:<action>:a<n>`) as well.
 * Read either, so a hand-built order without a label is still answered by what
 * it is rather than by a guess.
 */
function executorAction(msg: Record<string, unknown>): string {
  const params = (msg.params ?? {}) as { action?: unknown };
  if (typeof params.action === 'string' && params.action) return params.action;
  const id = String(msg.orderId ?? '');
  const parts = id.split(':');
  const candidate = parts.length >= 3 ? String(parts[parts.length - 2] ?? '') : '';
  if (EXECUTOR_ACTIONS.has(candidate)) return candidate;
  return candidate || String(msg.orderType ?? '');
}

/** The result body the plugin returns for one executor action. */
function executorResult(
  action: string,
  params: Record<string, unknown>,
  opts: ExecutorAnswerOptions,
): Record<string, unknown> {
  switch (action) {
    case 'identity':
      // The executor only learns an identity it does not already have cached.
      return opts.identityId ? { identityId: opts.identityId } : {};
    case 'ownership':
    case 'ownership_check': {
      // Read-back contract: `applied` is true only when the owner the executor
      // asked for is the owner the grid now reports.
      const ownerId = typeof params.ownerId === 'string' ? params.ownerId : '';
      const expected = opts.identityId;
      const applied = ownerId.length > 0 && (expected === undefined || expected === ownerId);
      return { applied, ownerId, verifiedOwnerId: ownerId };
    }
    case 'wake':
      return { gridId: params.gridId ?? params.entityId ?? null };
    case 'ai_off':
      return { stillAutopilot: 0, stillAiEnabled: 0 };
    case 'diag':
      return {
        isStatic: false,
        massKg: 1_000,
        physics: { present: true, enabled: true, active: true, massKg: 1_000 },
      };
    case 'zero_velocity':
      return { zeroed: true, speedBeforeMs: 0, speedAfterMs: 0 };
    case 'is_under_control':
      return { underControl: false };
    case 'convert_to_station':
      return {
        isStaticAfter: opts.staticAfterConvert !== false,
        positionDriftM: 0,
        aglM: 500,
        speedBeforeMs: 0,
      };
    case 'convert_to_ship':
      return { isStatic: false };
    case 'set_block_props':
      return { count: 1, blocksWithErrors: 0 };
    case 'list_grids':
      return { grids: [] };
    case 'probe_ground':
      return { hit: false, isGrid: false };
    case 'move':
    case 'hold':
      return { x: params.x, y: params.y, z: params.z };
    default:
      return {};
  }
}

/**
 * Test double for the C# plugin: opens the outbound WebSocket, performs the
 * hello handshake and lets the test push telemetry / acks and read orders.
 */
export class FakePlugin {
  readonly received: Record<string, unknown>[] = [];
  private waiters: { predicate: (msg: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: NodeJS.Timeout }[] = [];
  closed = false;
  closeCode: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.received.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(msg)) {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(msg);
        }
      }
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
  }

  static connect(port: number, opts: FakePluginOptions = {}): Promise<FakePlugin> {
    const params = opts.queryToken ? `?token=${encodeURIComponent(opts.queryToken)}` : '';
    const url = `ws://127.0.0.1:${port}/plugin${params}`;
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [], { headers });
      const plugin = new FakePlugin(ws);
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(plugin);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`connect failed: ${err.message}`));
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`unexpected server response: ${res.statusCode}`));
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  hello(overrides: Record<string, unknown> = {}): void {
    this.send({
      schemaVersion: 1,
      type: 'hello',
      agentId: 'fake-plugin',
      serverId: 'test-server',
      version: '0.1.0',
      capabilities: ['telemetry', 'orders'],
      ...overrides,
    });
  }

  telemetry(overrides: Record<string, unknown> = {}): void {
    this.send({
      schemaVersion: 1,
      type: 'telemetry',
      tick: 1,
      at: Date.now(),
      grids: [],
      contacts: [],
      links: [],
      ledgerDelta: [],
      ...overrides,
    });
  }

  ack(orderId: string, ok = true, error?: string): void {
    this.send({
      schemaVersion: 1,
      type: 'ack',
      orderId,
      ok,
      ...(error ? { error } : {}),
      at: Date.now(),
    });
  }

  /**
   * Plays the plugin's half of an executor mission: answers every order the
   * executor has sent and not yet got an ack for, with the result shape that
   * action's contract requires (identity, ownership read-back, wake, diag,
   * release/staging blocks, station conversion, move, hold, stop).
   *
   * It never originates an order, so a test drives the executor's whole chain
   * by repeating answer -> tick -> telemetry. Returns how many were answered.
   */
  answerExecutorOrders(opts: ExecutorAnswerOptions = {}): number {
    const at = opts.now ?? Date.now();
    let answered = 0;
    for (const msg of this.received) {
      if (msg.type !== 'order' || msg.answered === true) continue;
      msg.answered = true;
      answered += 1;
      const orderId = String(msg.orderId);
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const result = executorResult(executorAction(msg), params, opts);
      const entityId = String((params.gridId as string | undefined) ?? (msg.entityId as string | undefined) ?? '');
      // The real plugin answers twice: an ack for the order slot, and an
      // `order_result` event carrying the result body. The executor reads the
      // body from the event's audit row, so an ack alone reads back as `null`
      // (`applied` false, no diag physics) even though the order succeeded.
      this.send({ schemaVersion: 1, type: 'ack', orderId, ok: true, result, at });
      this.send({
        schemaVersion: 1,
        type: 'event',
        eventType: 'order_result',
        ...(entityId ? { entityId } : {}),
        data: { orderId, ok: true, result },
        at,
      });
    }
    return answered;
  }

  /**
   * Every order received for one grid, from the envelope and from
   * `params.gridId`/`params.entityId` alike. Used to prove a grid that must not
   * be commanded never is.
   */
  ordersForGrid(gridId: string): Record<string, unknown>[] {
    return this.received.filter((msg) => {
      if (msg.type !== 'order') return false;
      const params = (msg.params ?? {}) as { gridId?: unknown; entityId?: unknown; sourceGridId?: unknown };
      return (
        String(msg.entityId ?? '') === gridId ||
        String(params.gridId ?? '') === gridId ||
        String(params.entityId ?? '') === gridId ||
        String(params.sourceGridId ?? '') === gridId
      );
    });
  }

  async nextMessage(predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = this.received.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('timed out waiting for plugin message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  waitForOrder(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return this.nextMessage((m) => m.type === 'order', timeoutMs);
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
