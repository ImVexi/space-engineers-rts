import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';

/**
 * SimSpeed monitor (TEST server only).
 *
 * SE 01_210_014 exposes SimSpeed only through the Remote API, not to plugins.
 * The owner's rule is: stop flying if SimSpeed stays below a threshold for
 * 30 s. The threshold is config (`RTS_SIMSPEED_MIN`, default 0.95) so it can
 * be lowered for the test server without a code change.
 *
 * `flightsAllowed()` is deliberately conservative: any single fresh sample
 * below the threshold pauses NEW flight orders. The sustained-window flag
 * (`blocked`) is what the UI and the E2E runner use to stop a run.
 */
/**
 * Where the current sample came from. Exactly one of these three, so a flight
 * record can say which read the flight gate actually used.
 */
export type SimSpeedSource = 'remote-api' | 'plugin-telemetry' | 'plugin-action';

export interface SimSpeedStatus {
  /** Last successfully sampled SimSpeed, null when unknown. */
  value: number | null;
  cpuLoad: number | null;
  /** Wall clock of the last successful sample. */
  at: number | null;
  threshold: number;
  /** Below threshold for at least `holdMs`, i.e. the owner's stop rule fired. */
  blocked: boolean;
  /** How long the current below-threshold streak has lasted. */
  belowForMs: number;
  holdMs: number;
  /** Which of the three reads produced the value in force. */
  source: SimSpeedSource;
  /** The human sentence for the same thing (endpoint, action, frame field). */
  sourceDetail: string;
  error: string | null;
}

export interface FlightGate {
  flightsAllowed(): boolean;
  status(): SimSpeedStatus;
}

export interface SimSpeedOptions {
  envPath: string;
  min: number;
  sampleMs: number;
  holdMs: number;
  clock?: () => number;
  fetchImpl?: typeof fetch;
  /** Live threshold override (designer settings); defaults to `min`. */
  threshold?: () => number;
  /**
   * T79 plugin fallback: the game's own simulation ratio, read by the plugin
   * (`sim_ratio` action -> `MyAPIGateway.Physics.SimulationRatio`). The LIVE
   * server has `RemoteApiEnabled=false`, so the Remote API sampler has no
   * source there; this is the legitimate in-process read that keeps the flight
   * gate working. Test env still asks the Remote API first.
   */
  pluginSample?: () => Promise<number | null>;
  /**
   * How long a pushed telemetry `simRatio` sample is usable, ms. Default
   * `max(3 x sampleMs, 15 s)`: a frame older than that is not "the sim now".
   */
  telemetryMaxAgeMs?: number;
  /** Age at which a sample is too old to skip the `sim_ratio` action, ms. Default `sampleMs`. */
  freshMs?: number;
}

interface RemoteCreds {
  host: string;
  port: string;
  key: Buffer;
}

function readRemoteEnv(file: string): RemoteCreds | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  if (!env.SE_TEST_REMOTE_KEY) return null;
  return {
    host: env.SE_TEST_REMOTE_HOST ?? '127.0.0.1',
    port: env.SE_TEST_REMOTE_PORT ?? '8082',
    key: Buffer.from(env.SE_TEST_REMOTE_KEY, 'base64'),
  };
}

/** Remote API request auth: base64(HMAC-SHA1(key, path\r\nnonce\r\ndate\r\n)). */
function signedHeaders(creds: RemoteCreds, path: string): Record<string, string> {
  const nonce = randomBytes(16).toString('hex');
  const date = new Date().toUTCString();
  const msg = `${path}\r\n${nonce}\r\n${date}\r\n`;
  const sig = createHmac('sha1', creds.key).update(msg).digest('base64');
  return { Authorization: `${nonce}:${sig}`, Date: date, 'Content-Type': 'application/json' };
}

export class SimSpeedMonitor implements FlightGate {
  private value: number | null = null;
  private cpuLoad: number | null = null;
  private at: number | null = null;
  private belowSince: number | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private creds: RemoteCreds | null | undefined;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;
  /** Which read produced the sample in force. */
  private source: SimSpeedSource = 'remote-api';
  private sourceDetail = 'SE Remote API /vrageremote/v1/server';
  /** The freshest telemetry `simRatio` the plugin has pushed (7 000 ms cadence in game). */
  private telemetry: { value: number; at: number } | null = null;

  constructor(private readonly opts: SimSpeedOptions) {
    this.clock = opts.clock ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), Math.max(1_000, this.opts.sampleMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.clock();
  }

  /** Current threshold: the live designer setting when wired, else config. */
  private currentMin(): number {
    if (this.opts.threshold) {
      const value = this.opts.threshold();
      if (Number.isFinite(value)) return Math.min(1, Math.max(0.5, value));
    }
    return this.opts.min;
  }

  /**
   * A telemetry frame's `simRatio`, pushed by the plugin on every frame.
   *
   * This is the live server's source: `RemoteApiEnabled=false` there, so no
   * poll can reach the game. A frame is ingested the moment it arrives rather
   * than waiting for the next `sampleMs` pass, and only when it is at least as
   * fresh as the sample in force (a late frame never overwrites a newer read).
   * Returns true when the value in force changed.
   */
  observeTelemetry(value: number, at: number): boolean {
    if (!Number.isFinite(value) || value < 0 || value > 100) return false;
    const when = Number.isFinite(at) ? at : this.now();
    if (!this.telemetry || when >= this.telemetry.at) this.telemetry = { value, at: when };
    if (this.at !== null && when < this.at) return false;
    this.ingest(value, null, 'plugin-telemetry', 'plugin telemetry simRatio (MyAPIGateway.Physics.SimulationRatio)', when);
    return true;
  }

  private telemetryMaxAgeMs(): number {
    return this.opts.telemetryMaxAgeMs ?? Math.max(3 * this.opts.sampleMs, 15_000);
  }

  private freshMs(): number {
    return this.opts.freshMs ?? this.opts.sampleMs;
  }

  /**
   * Take one sample, preferring the FRESHEST of the three reads:
   *
   *  1. `remote-api`      - the test server's Remote API (has credentials there);
   *  2. `plugin-telemetry` - the `simRatio` field the plugin pushes every frame;
   *  3. `plugin-action`   - the `sim_ratio` `action` channel read, asked only
   *                         when neither of the other two has a fresh sample
   *                         (so a live server with telemetry flowing does not
   *                         spend an order on every pass).
   *
   * All three feed the same threshold: 0.95 unless the designer setting says
   * otherwise.
   */
  async refresh(): Promise<void> {
    this.creds ??= readRemoteEnv(this.opts.envPath);
    const creds = this.creds;
    const now = this.now();
    const candidates: { value: number; cpuLoad: number | null; at: number; source: SimSpeedSource; detail: string }[] = [];

    if (creds) {
      const remote = await this.sampleRemote(creds);
      if (remote) {
        candidates.push({
          value: remote.value,
          cpuLoad: remote.cpuLoad,
          at: this.now(),
          source: 'remote-api',
          detail: 'SE Remote API /vrageremote/v1/server',
        });
      }
    }
    if (this.telemetry && now - this.telemetry.at <= this.telemetryMaxAgeMs()) {
      candidates.push({
        value: this.telemetry.value,
        cpuLoad: null,
        at: this.telemetry.at,
        source: 'plugin-telemetry',
        detail: 'plugin telemetry simRatio (MyAPIGateway.Physics.SimulationRatio)',
      });
    }

    // The action read is only worth an order when nothing else is fresh.
    const freshestSoFar = candidates.reduce<(typeof candidates)[number] | null>(
      (best, c) => (!best || c.at > best.at ? c : best),
      null,
    );
    if (this.opts.pluginSample && !(freshestSoFar && now - freshestSoFar.at <= this.freshMs())) {
      const pluginError = creds ? this.error : null;
      try {
        const value = await this.opts.pluginSample();
        if (value !== null && Number.isFinite(value)) {
          candidates.push({
            value,
            cpuLoad: null,
            at: this.now(),
            source: 'plugin-action',
            detail: 'plugin sim_ratio action (MyAPIGateway.Physics.SimulationRatio)',
          });
        } else {
          this.error = 'plugin returned no simulation ratio';
        }
      } catch (err) {
        this.error = `plugin simulation ratio unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (pluginError) this.error = `${pluginError}; ${this.error}`;
    }

    // Freshest wins; on a tie the candidate list order is the priority
    // (remote-api, then plugin-telemetry, then plugin-action).
    const best = candidates.reduce<(typeof candidates)[number] | null>(
      (win, c) => (!win || c.at > win.at ? c : win),
      null,
    );
    if (best) {
      this.ingest(best.value, best.cpuLoad, best.source, best.detail);
      return;
    }
    if (!this.opts.pluginSample) {
      this.error ??= `remote API credentials not found at ${this.opts.envPath}`;
    }
  }


  /** One Remote API sample; null means "this source has nothing". */
  private async sampleRemote(creds: RemoteCreds): Promise<{ value: number; cpuLoad: number | null } | null> {
    const path = '/vrageremote/v1/server';
    try {
      const res = await this.fetchImpl(`http://${creds.host}:${creds.port}${path}`, {
        method: 'GET',
        headers: signedHeaders(creds, path),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.error = `remote API HTTP ${res.status}`;
        return null;
      }
      const body = (await res.json()) as { data?: { SimSpeed?: number; SimulationCpuLoad?: number } };
      const speed = Number(body?.data?.SimSpeed);
      if (!Number.isFinite(speed)) {
        this.error = 'remote API returned no SimSpeed';
        return null;
      }
      return {
        value: speed,
        cpuLoad: Number.isFinite(Number(body?.data?.SimulationCpuLoad))
          ? Number(body?.data?.SimulationCpuLoad)
          : null,
      };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** Record one good sample and update the below-threshold streak. */
  private ingest(
    value: number,
    cpuLoad: number | null,
    source: SimSpeedSource,
    detail: string,
    at: number = this.now(),
  ): void {
    this.value = value;
    this.cpuLoad = cpuLoad;
    this.at = at;
    this.source = source;
    this.sourceDetail = detail;
    this.error = null;
    if (value < this.currentMin()) {
      this.belowSince ??= this.now();
    } else {
      this.belowSince = null;
    }
  }

  /** Unknown SimSpeed never blocks; a fresh low sample always does. */
  flightsAllowed(): boolean {
    return this.value === null || this.value >= this.currentMin();
  }

  status(): SimSpeedStatus {
    const now = this.now();
    const belowForMs = this.belowSince === null ? 0 : now - this.belowSince;
    return {
      value: this.value,
      cpuLoad: this.cpuLoad,
      at: this.at,
      threshold: this.currentMin(),
      blocked: this.belowSince !== null && belowForMs >= this.opts.holdMs,
      belowForMs,
      holdMs: this.opts.holdMs,
      source: this.source,
      sourceDetail: this.sourceDetail,
      error: this.error,
    };
  }
}

/** Test double: a gate with a fixed verdict. */
export class FixedFlightGate implements FlightGate {
  constructor(
    private readonly allowed: boolean,
    private readonly value: number | null = allowed ? 1 : 0.4,
    private readonly threshold = 0.95,
  ) {}

  flightsAllowed(): boolean {
    return this.allowed;
  }

  status(): SimSpeedStatus {
    return {
      value: this.value,
      cpuLoad: null,
      at: null,
      threshold: this.threshold,
      blocked: !this.allowed,
      belowForMs: this.allowed ? 0 : 30_000,
      holdMs: 30_000,
      source: 'remote-api',
      sourceDetail: 'fixed test double',
      error: null,
    };
  }
}
