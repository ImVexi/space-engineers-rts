/**
 * Player-control watch (T27 manual handoff, T61 passenger rule).
 *
 * The owner pilots ships by hand. While a real PILOT flies a grid - an occupied
 * controller whose CanControlShip is true (cockpit/flight/control seat) or a
 * Remote Control being driven - the executor must send that grid NO orders at
 * all: no move,
 * hold, stop, dampener flip, staging write, set_block_props or station
 * conversion. This class is the single source of truth for that decision.
 *
 * Detection:
 *   1. telemetry, when it already carries it (`underControl`/`manualControl` in
 *      the unit meta, or the read-only `profile` power snapshot). It is trusted
 *      for `TELEMETRY_TRUST_MS`, because the power poller deliberately stops
 *      polling a grid while it is piloted, so its last sample goes stale.
 *   2. otherwise the read-only plugin action `is_under_control`, asked at most
 *      once per `PROBE_INTERVAL_MS` per grid with an active mission.
 *
 * A manual mark is persisted in kv so a backend restart does not resume
 * flying an owner's ship. Releasing control clears the mark but never resumes
 * the paused mission: only a new owner order may do that.
 *
 * T61: a seated PASSENGER is not a pilot and must not silence the executor. The
 * plugin classifies each grid (`control.pilot` / `control.passengers` /
 * `control.aboard`) and reports `underControl` true only for a real pilot. The
 * crew sample is kept here whether or not a pilot is present, so the executor
 * can fly a passenger-carrying ship under passenger limits
 * (see `passengers.ts`).
 */
import type { GridCrew } from './passengers.js';

export interface ControlTelemetry {
  /** TRUE only for a real pilot (T61: a passenger seat does not count). */
  underControl: boolean;
  by?: string | null;
  /** Backend clock when the sample was taken; 0/absent means "now". */
  at?: number;
  /**
   * T61: the plugin's classified crew (pilot/passengers/standing). Stored even
   * when `underControl` is false, because that is exactly the case the executor
   * must keep flying under passenger limits.
   */
  crew?: GridCrew | null;
}

export interface ControlView {
  underControl: boolean;
  by: string | null;
  source: 'telemetry' | 'probe' | null;
  checkedAt: number | null;
  probeAt: number | null;
  probeInFlight: boolean;
}

interface Entry {
  underControl: boolean;
  by: string | null;
  source: 'telemetry' | 'probe' | null;
  observedAt: number;
  probeSentAt: number;
  probeOrderId: string | null;
  /** A manual mark exists until the plugin answers `underControl=false`. */
  mark: boolean;
  /** T61: last classified crew sample (pilot / passengers / standing players). */
  crew: GridCrew | null;
  crewAt: number;
}

const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const TELEMETRY_TRUST_MS = 120_000;

interface Kv {
  getKv: (key: string) => string | null;
  setKv: (key: string, value: string) => void;
}

export class ControlWatch {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly kv: Kv,
    private readonly clock: () => number,
  ) {}

  private key(gridId: string): string {
    return `demo:control:${gridId}`;
  }

  private entry(gridId: string): Entry {
    const found = this.entries.get(gridId);
    if (found) return found;
    const entry: Entry = {
      underControl: false,
      by: null,
      source: null,
      observedAt: 0,
      probeSentAt: 0,
      probeOrderId: null,
      mark: false,
      crew: null,
      crewAt: 0,
    };
    const raw = this.kv.getKv(this.key(gridId));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { underControl?: unknown; by?: unknown; at?: unknown };
        if (parsed.underControl === true) {
          entry.underControl = true;
          entry.mark = true;
          entry.by = typeof parsed.by === 'string' ? parsed.by : null;
          entry.source = 'probe';
          entry.observedAt = typeof parsed.at === 'number' ? parsed.at : 0;
        }
      } catch {
        // A corrupt mark is not a reason to fly a ship: ignore it, re-probe.
      }
    }
    this.entries.set(gridId, entry);
    return entry;
  }

  private persist(gridId: string, entry: Entry): void {
    this.kv.setKv(
      this.key(gridId),
      JSON.stringify({ underControl: entry.underControl, by: entry.by, at: entry.observedAt }),
    );
  }

  /** Apply a telemetry sample. Returns true when it is the manual transition. */
  observe(gridId: string, telemetry: ControlTelemetry | null, now: number): boolean {
    if (!telemetry) return false;
    // The crew classification is recorded whether or not a pilot is present:
    // "passengers aboard, no pilot" is the case that must keep flying.
    if (telemetry.crew !== undefined && telemetry.crew !== null) {
      const entry = this.entry(gridId);
      entry.crew = telemetry.crew;
      entry.crewAt = now;
    }
    if (telemetry.underControl !== true) return false;
    const at = telemetry.at && telemetry.at > 0 ? telemetry.at : now;
    if (now - at > TELEMETRY_TRUST_MS) return false;
    const entry = this.entry(gridId);
    entry.by = telemetry.by ?? entry.by;
    entry.source = 'telemetry';
    entry.observedAt = now;
    if (entry.underControl) {
      this.persist(gridId, entry);
      return false;
    }
    entry.underControl = true;
    entry.mark = true;
    this.persist(gridId, entry);
    return true;
  }

  /** Record the manual transition learned from a probe. */
  markManual(gridId: string, by: string | null, now: number): boolean {
    const entry = this.entry(gridId);
    const entered = !entry.underControl;
    entry.underControl = true;
    entry.mark = true;
    entry.by = by ?? entry.by;
    entry.source = 'probe';
    entry.observedAt = now;
    this.persist(gridId, entry);
    return entered;
  }

  isManual(gridId: string): boolean {
    return this.entry(gridId).underControl;
  }

  /**
   * T61: the last classified crew. `null` means the plugin has not reported one
   * (older plugin), in which case the executor keeps its pre-T61 behaviour.
   */
  crew(gridId: string): GridCrew | null {
    return this.entry(gridId).crew;
  }

  /** When the crew sample was taken, ms (0 = never). */
  crewAt(gridId: string): number {
    return this.entry(gridId).crewAt;
  }

  /** A persisted/learned manual mark exists (used to fail closed on a probe). */
  hasMark(gridId: string): boolean {
    return this.entry(gridId).mark;
  }

  probeInFlight(gridId: string): boolean {
    return this.entry(gridId).probeOrderId !== null;
  }

  probeDue(gridId: string, now: number): boolean {
    const entry = this.entry(gridId);
    if (entry.probeOrderId !== null) return false;
    return now - entry.probeSentAt >= PROBE_INTERVAL_MS;
  }

  beginProbe(gridId: string, orderId: string, now: number): void {
    const entry = this.entry(gridId);
    entry.probeOrderId = orderId;
    entry.probeSentAt = now;
  }

  /** A probe was lost: allow the next one after the normal interval. */
  expireProbe(gridId: string, now: number): void {
    const entry = this.entry(gridId);
    if (entry.probeOrderId === null) return;
    if (now - entry.probeSentAt < PROBE_TIMEOUT_MS) return;
    entry.probeOrderId = null;
    entry.probeSentAt = now;
  }

  probeOrder(gridId: string): string | null {
    return this.entry(gridId).probeOrderId;
  }

  /**
   * Apply the plugin's answer. Only `underControl=false` releases a mark; a
   * release never resumes anything by itself, the caller keeps the paused
   * mission paused and waits for a new owner order.
   */
  settle(
    gridId: string,
    underControl: boolean,
    by: string | null,
    now: number,
    crew?: GridCrew | null,
  ): { released: boolean } {
    const entry = this.entry(gridId);
    if (crew) {
      entry.crew = crew;
      entry.crewAt = now;
    }
    entry.probeOrderId = null;
    entry.probeSentAt = now;
    if (underControl) {
      entry.underControl = true;
      entry.mark = true;
      entry.by = by ?? entry.by;
      entry.source = 'probe';
      entry.observedAt = now;
      this.persist(gridId, entry);
      return { released: false };
    }
    const released = entry.underControl || entry.mark;
    entry.underControl = false;
    entry.mark = false;
    entry.by = null;
    entry.source = 'probe';
    entry.observedAt = now;
    this.persist(gridId, entry);
    return { released };
  }

  view(gridId: string | null): ControlView | null {
    if (!gridId) return null;
    const entry = this.entry(gridId);
    return {
      underControl: entry.underControl,
      by: entry.by,
      source: entry.source,
      checkedAt: entry.observedAt || null,
      probeAt: entry.probeSentAt || null,
      probeInFlight: entry.probeOrderId !== null,
    };
  }

  /** Grids currently held for manual control (for /api/demo/state). */
  list(): { gridId: string; by: string | null; source: 'telemetry' | 'probe' | null }[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.underControl)
      .map(([gridId, entry]) => ({ gridId, by: entry.by, source: entry.source }));
  }
}
