/**
 * Laser connect sequence (contract §2).
 *
 * Proven bug (T42): provisioning leaves lasers `OnOff = false` ("idle until a
 * link is planned"), but the old connect path only aimed and connected. A
 * powered-off laser accepts the target and reports `RotatingToTarget` /
 * `Connecting` forever, so every planner link failed while looking busy.
 *
 * Verified order on the test server:
 *   set_block_props OnOff=true
 *   -> laser_target(coords of the PARTNER'S LASER BLOCK)
 *   -> laser_connect
 *   -> poll laser_state <= 20 s
 *   -> retry once
 *   -> report the exact status per end
 *
 * The target is the partner block's position from `laser_state`, never the
 * grid centre: the beam leaves the antenna, and a satellite's antenna can sit
 * tens of metres off its origin.
 *
 * This module is dependency-injected (`call`) so the sequence is unit-tested
 * against a fake hub without a game server.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LaserCallResult {
  ok: boolean;
  error?: string | null;
  result?: Record<string, unknown> | null;
}

export interface LaserDeps {
  /** Sends one plugin `test` order and resolves its `order_result`. */
  call: (action: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<LaserCallResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting for Connected. */
  pollMs?: number;
}

export interface LaserReadout {
  entityId: string;
  name?: string;
  position?: Vec3;
  status?: string | null;
  targetCoords?: Vec3 | null;
  enabled?: boolean | null;
  working?: boolean | null;
  rangeM?: number | null;
  maxRangeM?: number | null;
  otherGridId?: string | null;
  otherAntennaId?: string | null;
}

export interface LaserGridReadout {
  gridId: string;
  name?: string;
  position?: Vec3;
  lasers: LaserReadout[];
}

export interface LaserEndpoint {
  gridId: string;
  /** Chosen laser block; resolved from the live read when omitted. */
  laserBlockId?: string;
  /** Fallback selector: CustomName contains this. */
  name?: string;
}

export interface LaserConnectRequest {
  a: LaserEndpoint;
  b: LaserEndpoint;
  permanent?: boolean;
  /** Total wait per attempt, default 20 s (contract). */
  timeoutMs?: number;
  /**
   * Leave the beam up on success. The laser-test action disconnects after the
   * measurement; planner links keep it. Default true.
   */
  keepConnected?: boolean;
  /** Called on every poll with the live per-end status (UI sample). */
  onSample?: (sample: { a: string | null; b: string | null }) => void;
}

export interface LaserConnectAttempt {
  attempt: number;
  status: { a: string | null; b: string | null };
  connectedTo: { a: string | null; b: string | null };
  connected: boolean;
  elapsedS: number;
}

export interface LaserConnectResult {
  ok: boolean;
  attempts: number;
  status: { a: string | null; b: string | null };
  connectedTo: { a: string | null; b: string | null };
  enabled: { a: boolean | null; b: boolean | null };
  /** Coordinates the beams were aimed at (partner laser block positions). */
  target: { a: Vec3 | null; b: Vec3 | null };
  distanceM: number | null;
  /** True when a block claimed Connecting/RotatingToTarget with no target set. */
  clearedStale: { a: boolean; b: boolean };
  elapsedS: number;
  error: string | null;
  /** Ordered evidence for the audit trail. */
  steps: string[];
  attemptsDetail: LaserConnectAttempt[];
  finalStatus: { a: string | null; b: string | null };
  disconnect: { a: boolean; b: boolean } | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 1_000;
/** Aiming states that mean "trying", not "up" or "off". */
const AIMING_STATUSES = new Set(['Connecting', 'RotatingToTarget', 'Rotating', 'OutOfRange']);

const nowOf = (deps: LaserDeps): number => deps.now?.() ?? Date.now();
const sleep = (deps: LaserDeps, ms: number): Promise<void> =>
  deps.sleep ? deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function readVec(v: unknown): Vec3 | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Vec3>;
  if (typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.z !== 'number') return null;
  return { x: o.x, y: o.y, z: o.z };
}

/** A target of all zeros means "no target"; a stale status can outlive it. */
export function isZeroVec(v: Vec3 | null | undefined): boolean {
  if (!v) return true;
  return Math.abs(v.x) < 0.5 && Math.abs(v.y) < 0.5 && Math.abs(v.z) < 0.5;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function pickLaser(grid: LaserGridReadout | undefined, endpoint: LaserEndpoint): LaserReadout | null {
  if (!grid) return null;
  const lasers = grid.lasers ?? [];
  if (endpoint.laserBlockId) {
    // An explicit block id that is not on the grid is an error, not a hint to
    // pick another antenna: the caller named the beam it wants.
    return lasers.find((l) => l.entityId === endpoint.laserBlockId) ?? null;
  }
  if (endpoint.name) {
    const named = lasers.find((l) => (l.name ?? '').includes(endpoint.name!));
    if (named) return named;
  }
  // Prefer a working block with a real range when the caller did not choose.
  return lasers.find((l) => l.working !== false) ?? lasers[0] ?? null;
}

function statusOf(lasers: LaserReadout[] | undefined, entityId: string | null): LaserReadout | null {
  if (!entityId) return null;
  return (lasers ?? []).find((l) => l.entityId === entityId) ?? null;
}

export class LaserLinker {
  constructor(private readonly deps: LaserDeps) {}

  /** Read `laser_state` for the two grids (single plugin round trip). */
  private async readState(gridIds: string[]): Promise<Map<string, LaserGridReadout>> {
    const res = await this.deps.call('laser_state', { gridIds }, 20_000);
    if (!res.ok) throw new Error(`laser_state failed: ${res.error ?? 'plugin error'}`);
    const grids = (res.result?.grids as LaserGridReadout[] | undefined) ?? [];
    const map = new Map<string, LaserGridReadout>();
    for (const g of grids) if (g && typeof g.gridId === 'string') map.set(g.gridId, g);
    return map;
  }

  /**
   * Clear a block that says it is aiming at nothing. The plugin keeps the last
   * status until the block is disconnected, so a grid that was never commanded
   * can sit at `Connecting` with targetCoords 0 forever and poison every
   * preflight that reads the status.
   */
  private async clearStale(
    endpoint: LaserEndpoint,
    laser: LaserReadout,
    steps: string[],
  ): Promise<boolean> {
    if (!AIMING_STATUSES.has(String(laser.status ?? ''))) return false;
    if (!isZeroVec(readVec(laser.targetCoords))) return false;
    const res = await this.deps
      .call('laser_disconnect', { entityId: endpoint.gridId, laserBlockId: laser.entityId }, 15_000)
      .catch(() => ({ ok: false } as LaserCallResult));
    steps.push(
      `cleared stale ${laser.status} on ${endpoint.gridId}/${laser.entityId} ` +
        `(targetCoords 0, disconnect ${res.ok ? 'ok' : 'failed'})`,
    );
    laser.status = res.ok ? 'Idle' : laser.status;
    return true;
  }

  private async enable(endpoint: LaserEndpoint, laser: LaserReadout, steps: string[]): Promise<boolean> {
    const filter = laser.name
      ? { type: 'LaserAntenna', nameContains: laser.name }
      : { type: 'LaserAntenna' };
    const res = await this.deps
      .call(
        'set_block_props',
        { entityId: endpoint.gridId, filter, props: { OnOff: true } },
        15_000,
      )
      .catch(() => ({ ok: false } as LaserCallResult));
    const blocks = (res.result?.blocks as unknown[] | undefined) ?? [];
    const ok = res.ok && !res.error;
    steps.push(
      `OnOff=true ${endpoint.gridId}/${laser.entityId}: ${ok ? 'ok' : res.error ?? 'failed'}` +
        (blocks.length ? ` (${blocks.length} block(s))` : ''),
    );
    return ok;
  }

  private async aim(endpoint: LaserEndpoint, laser: LaserReadout, target: Vec3, permanent: boolean, steps: string[]): Promise<void> {
    const res = await this.deps
      .call(
        'laser_target',
        {
          entityId: endpoint.gridId,
          laserBlockId: laser.entityId,
          x: target.x,
          y: target.y,
          z: target.z,
          permanent,
        },
        15_000,
      )
      .catch(() => ({ ok: false, error: 'send failed' } as LaserCallResult));
    steps.push(
      `target ${endpoint.gridId}/${laser.entityId} -> (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}): ` +
        `${res.ok ? 'ok' : res.error ?? 'failed'}`,
    );
  }

  private async sendConnect(endpoint: LaserEndpoint, laser: LaserReadout, permanent: boolean, steps: string[]): Promise<void> {
    const res = await this.deps
      .call('laser_connect', { entityId: endpoint.gridId, laserBlockId: laser.entityId, permanent }, 15_000)
      .catch(() => ({ ok: false, error: 'send failed' } as LaserCallResult));
    steps.push(
      `connect ${endpoint.gridId}/${laser.entityId}: ${res.ok ? 'ok' : res.error ?? 'failed'}`,
    );
  }

  /**
   * Run the full sequence. Returns the exact final status even on failure; it
   * never reports `ok` for a link the game did not confirm.
   */
  async connect(request: LaserConnectRequest): Promise<LaserConnectResult> {
    const started = nowOf(this.deps);
    const timeoutMs = Math.max(2_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollMs = Math.max(100, this.deps.pollMs ?? DEFAULT_POLL_MS);
    const permanent = request.permanent === true;
    const keepConnected = request.keepConnected !== false;
    const steps: string[] = [];
    const result: LaserConnectResult = {
      ok: false,
      attempts: 0,
      status: { a: null, b: null },
      connectedTo: { a: null, b: null },
      enabled: { a: null, b: null },
      target: { a: null, b: null },
      distanceM: null,
      clearedStale: { a: false, b: false },
      elapsedS: 0,
      error: null,
      steps,
      attemptsDetail: [],
      finalStatus: { a: null, b: null },
      disconnect: null,
    };

    let gridA: LaserGridReadout | undefined;
    let gridB: LaserGridReadout | undefined;
    let la: LaserReadout | null = null;
    let lb: LaserReadout | null = null;

    // 1. Read live block positions. Aiming at the partner's GRID CENTRE is the
    //    bug this replaces; the target is the partner laser block.
    const state = await this.readState([request.a.gridId, request.b.gridId]);
    gridA = state.get(request.a.gridId);
    gridB = state.get(request.b.gridId);
    la = pickLaser(gridA, request.a);
    lb = pickLaser(gridB, request.b);
    if (!la || !lb) {
      result.error = !la ? `no laser antenna on ${request.a.gridId}` : `no laser antenna on ${request.b.gridId}`;
      steps.push(result.error);
      return result;
    }
    const pa = readVec(la.position);
    const pb = readVec(lb.position);
    if (!pa || !pb) {
      result.error = 'laser block has no live position from laser_state';
      steps.push(result.error);
      return result;
    }
    result.distanceM = Math.round(distance(pa, pb) * 10) / 10;
    // A aims at B's block, B aims at A's block.
    result.target = { a: pb, b: pa };
    steps.push(
      `resolved ${request.a.gridId}/${la.entityId}@(${pa.x.toFixed(1)},${pa.y.toFixed(1)},${pa.z.toFixed(1)}) <- ` +
        `${request.b.gridId}/${lb.entityId}@(${pb.x.toFixed(1)},${pb.y.toFixed(1)},${pb.z.toFixed(1)}); ${result.distanceM} m`,
    );

    // 2. Clear a stale "aiming" status that has no target behind it.
    result.clearedStale.a = await this.clearStale(request.a, la, steps).catch(() => false);
    result.clearedStale.b = await this.clearStale(request.b, lb, steps).catch(() => false);

    // 3. Sequence, at most twice. The retry repeats the whole sequence (enable
    //    again included): a laser can drop OnOff when the first connect fails.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      result.attempts = attempt;
      steps.push(`attempt ${attempt}: enable -> target -> connect`);
      await this.enable(request.a, la, steps);
      await this.enable(request.b, lb, steps);
      // Aim at the partner block coordinates captured above. A retry re-aims
      // with the same values; the blocks may have rotated since.
      await this.aim(request.a, la, pb, permanent, steps);
      await this.aim(request.b, lb, pa, permanent, steps);
      await this.sendConnect(request.a, la, permanent, steps);
      await this.sendConnect(request.b, lb, permanent, steps);

      const attemptStarted = nowOf(this.deps);
      const deadline = attemptStarted + timeoutMs;
      let finalA: LaserReadout | null = null;
      let finalB: LaserReadout | null = null;
      let connected = false;
      for (;;) {
        const live = await this.readState([request.a.gridId, request.b.gridId]).catch(() => null);
        finalA = statusOf(live?.get(request.a.gridId)?.lasers, la.entityId);
        finalB = statusOf(live?.get(request.b.gridId)?.lasers, lb.entityId);
        result.status = { a: finalA?.status ?? null, b: finalB?.status ?? null };
        result.connectedTo = { a: finalA?.otherGridId ?? null, b: finalB?.otherGridId ?? null };
        result.enabled = { a: finalA?.enabled ?? null, b: finalB?.enabled ?? null };
        try {
          request.onSample?.({ a: result.status.a, b: result.status.b });
        } catch {
          /* a UI sample hook must never break the sequence */
        }
        connected = finalA?.status === 'Connected' && finalB?.status === 'Connected';
        if (connected || nowOf(this.deps) >= deadline) break;
        await sleep(this.deps, pollMs);
      }
      result.finalStatus = { ...result.status };
      result.attemptsDetail.push({
        attempt,
        status: { ...result.status },
        connectedTo: { ...result.connectedTo },
        connected,
        elapsedS: Math.round((nowOf(this.deps) - attemptStarted) / 100) / 10,
      });
      steps.push(
        `attempt ${attempt} result: a=${result.status.a ?? 'missing'} b=${result.status.b ?? 'missing'} ` +
          `after ${result.attemptsDetail[result.attemptsDetail.length - 1]!.elapsedS}s`,
      );
      if (connected) {
        result.ok = true;
        result.error = null;
        break;
      }
      if (attempt === 1) steps.push('retrying once: not Connected on both ends');
    }

    result.elapsedS = Math.round((nowOf(this.deps) - started) / 100) / 10;
    if (!result.ok) {
      result.error =
        `laser link not Connected after ${result.attempts} attempt(s) in ${result.elapsedS}s: ` +
        `a=${result.status.a ?? 'missing'}, b=${result.status.b ?? 'missing'}` +
        (result.status.a === 'Connected' || result.status.b === 'Connected' ? ' (one end only)' : '');
      steps.push(result.error);
    }

    // 4. Planner links stay up; the laser-test action tears the beam down so
    //    the hardware returns to the provisioning profile (idle, OnOff=false).
    if (!keepConnected) {
      const da = await this.deps
        .call('laser_disconnect', { entityId: request.a.gridId, laserBlockId: la.entityId }, 15_000)
        .catch(() => ({ ok: false } as LaserCallResult));
      const db = await this.deps
        .call('laser_disconnect', { entityId: request.b.gridId, laserBlockId: lb.entityId }, 15_000)
        .catch(() => ({ ok: false } as LaserCallResult));
      result.disconnect = { a: Boolean(da.ok), b: Boolean(db.ok) };
      steps.push(`disconnect: a=${da.ok ? 'ok' : 'failed'} b=${db.ok ? 'ok' : 'failed'}`);
    }
    return result;
  }
}

/** Convenience wrapper for callers that only have deps once. */
export function connectLaserPair(deps: LaserDeps, request: LaserConnectRequest): Promise<LaserConnectResult> {
  return new LaserLinker(deps).connect(request);
}

/** Small helper for readouts: end range, preferring the definition ceiling. */
export function laserRangeOf(l: { maxRangeM?: number | null; rangeM?: number | null }): number {
  const max = num(l.maxRangeM) ?? 0;
  const range = num(l.rangeM) ?? 0;
  return max > 0 ? max : range > 0 ? range : Number.POSITIVE_INFINITY;
}
