/**
 * T29 apply: write the tuned radio radius with `set_block_props` and prove the
 * result from live profiles.
 *
 * `set_block_props` writes the antenna's `Radius` property, so no restart and
 * no re-provisioning is needed. Every write is measured before and after:
 * radius read back from the block plus the grid's antenna draw and net MW from
 * the same profile action the Fleet page uses.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '../../store.js';
import type { ProfileSender } from '../power/poller.js';
import { decideOrderChannel } from '../channel.js';
import { resolveSurvivalMode, SURVIVAL_REASON } from '../survival.js';
import { parseProfileResult } from '../power/parse.js';
import { shipRoles } from '../roles.js';
import type { PowerSnapshot } from '../power/types.js';
import type { TunePlan } from './range.js';
import type { PinMap } from './pins.js';

export interface ApplyDeps {
  store: Store;
  hub: ProfileSender;
  clock?: () => number;
  timeoutMs?: number;
  /** Injection point for tests: profile without a game. */
  profile?: (gridId: string) => Promise<Record<string, unknown> | null>;
  /** Injection point for tests: set_block_props without a game. */
  writeRadius?: (gridId: string, radiusM: number) => Promise<{ ok: boolean; appliedM: number | null; error: string | null }>;
}

export interface ApplyRow {
  gridId: string;
  name: string;
  fromM: number | null;
  toM: number;
  appliedM: number | null;
  ok: boolean;
  reason: string;
  before: { antennaDrawMw: number | null; netMw: number | null } | null;
  after: { antennaDrawMw: number | null; netMw: number | null } | null;
  drawDropMw: number | null;
}

export interface ApplyResult {
  applied: ApplyRow[];
  skipped: { gridId: string; name: string; reason: string }[];
  failed: { gridId: string; name: string; error: string }[];
  savedMw: number;
  labels: ['GAME', 'SIMULATED'];
  note: string;
}

export async function applyTune(
  deps: ApplyDeps,
  plan: TunePlan,
  opts: { gridIds?: string[] | null; pins?: PinMap } = {},
): Promise<ApplyResult> {
  const pins = opts.pins ?? {};
  const wanted = opts.gridIds && opts.gridIds.length > 0 ? new Set(opts.gridIds) : null;
  const result: ApplyResult = {
    applied: [],
    skipped: [],
    failed: [],
    savedMw: 0,
    labels: ['GAME', 'SIMULATED'],
    note: 'Radius written with set_block_props; before/after values read back from live profiles',
  };

  if (!deps.hub.isConnected()) {
    return { ...result, failed: plan.changes.map((c) => ({ gridId: c.gridId, name: nodeName(plan, c.gridId), error: 'plugin offline' })) };
  }

  for (const change of plan.changes) {
    if (wanted && !wanted.has(change.gridId)) continue;
    // SHIP ROLE: antenna auto-tune is an automatic feature. A personal/owner
    // grid is never re-tuned, and an OFF grid gets no orders at all.
    const shipRole = shipRoles.roleOf(change.gridId);
    if (shipRole !== 'managed') {
      result.skipped.push({
        gridId: change.gridId,
        name: nodeName(plan, change.gridId),
        reason: `role ${shipRole}: antenna auto-tune only touches managed grids`,
      });
      continue;
    }
    const node = plan.nodes.find((n) => n.gridId === change.gridId);
    const name = node?.name ?? change.gridId;
    const pin = pins[change.gridId];
    if (pin && pin.radioM !== null && pin.radioM !== undefined) {
      result.skipped.push({ gridId: change.gridId, name, reason: `owner pin: keep ${Math.round(pin.radioM / 1000)} km` });
      continue;
    }
    if (node?.role === 'base') {
      result.skipped.push({ gridId: change.gridId, name, reason: 'base: keep max range' });
      continue;
    }

    const before = await profileOf(deps, change.gridId);
    if (before && before.radioRangeM !== null && Math.abs(before.radioRangeM - change.toM) < 500) {
      result.skipped.push({ gridId: change.gridId, name, reason: `already at ${(before.radioRangeM / 1000).toFixed(1)} km` });
      continue;
    }

    let write: { ok: boolean; appliedM: number | null; error: string | null };
    try {
      write = deps.writeRadius
        ? await deps.writeRadius(change.gridId, change.toM)
        : await writeRadiusWithPlugin(deps, change.gridId, change.toM);
    } catch (err) {
      write = { ok: false, appliedM: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (!write.ok) {
      result.failed.push({ gridId: change.gridId, name, error: write.error ?? 'set_block_props refused' });
      continue;
    }

    // Read back from the grid, not from the order ack: the block is the truth.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await profileOf(deps, change.gridId);
    const readBack = write.appliedM ?? after?.radioRangeM ?? null;
    const ok = readBack !== null && Math.abs(readBack - change.toM) < 250;
    const beforeDraw = before?.antennaDrawMw ?? null;
    const afterDraw = after?.antennaDrawMw ?? null;
    const row: ApplyRow = {
      gridId: change.gridId,
      name,
      fromM: before?.radioRangeM ?? change.fromM,
      toM: change.toM,
      appliedM: readBack === null ? null : Math.round(readBack),
      ok,
      reason: ok ? 'radius changed and read back from the block' : 'radius did not read back at the target',
      before: before ? { antennaDrawMw: before.antennaDrawMw, netMw: before.netMw } : null,
      after: after ? { antennaDrawMw: after.antennaDrawMw, netMw: after.netMw } : null,
      drawDropMw: beforeDraw !== null && afterDraw !== null ? round(beforeDraw - afterDraw, 4) : null,
    };
    if (ok) {
      result.applied.push(row);
      result.savedMw = round(result.savedMw + Math.max(0, row.drawDropMw ?? 0), 4);
    } else {
      result.failed.push({ gridId: change.gridId, name, error: row.reason });
    }
  }
  return result;
}

function nodeName(plan: TunePlan, gridId: string): string {
  return plan.nodes.find((n) => n.gridId === gridId)?.name ?? gridId;
}

async function profileOf(deps: ApplyDeps, gridId: string): Promise<PowerSnapshot | null> {
  const raw = deps.profile
    ? await deps.profile(gridId)
    : await sendProfileOrder(deps, gridId);
  if (!raw) return null;
  return parseProfileResult(gridId, raw, deps.clock?.() ?? Date.now());
}

async function sendProfileOrder(deps: ApplyDeps, gridId: string): Promise<Record<string, unknown> | null> {
  const now = deps.clock?.() ?? Date.now();
  const timeoutMs = deps.timeoutMs ?? 4_000;
  const orderId = `demo:tune-profile:${randomUUID()}`;
  // T75: a profile read is a legitimate action: production channel in both builds.
  const decision = decideOrderChannel('test', 'profile', resolveSurvivalMode());
  if (decision.refused) {
    deps.store.audit({
      actor: 'autotune',
      action: 'survival_refused',
      subject: orderId,
      detail: { action: 'profile', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at: now,
    });
    return null;
  }
  const sent = deps.hub.send({
    schemaVersion: 1 as const,
    type: 'order' as const,
    orderId,
    orderType: decision.orderType,
    entityId: gridId,
    params: { action: 'profile', entityId: gridId },
    tick: 0,
    issuedAt: now,
    expiresAt: now + timeoutMs,
  });
  if (!sent) return null;
  return waitForResult(deps, orderId, timeoutMs);
}

async function writeRadiusWithPlugin(
  deps: ApplyDeps,
  gridId: string,
  radiusM: number,
): Promise<{ ok: boolean; appliedM: number | null; error: string | null }> {
  const now = deps.clock?.() ?? Date.now();
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const orderId = `demo:tune-set:${randomUUID()}`;
  // T75: an antenna-radius write is a legitimate action: production channel in both builds.
  const decision = decideOrderChannel('test', 'set_block_props', resolveSurvivalMode());
  if (decision.refused) {
    deps.store.audit({
      actor: 'autotune',
      action: 'survival_refused',
      subject: orderId,
      detail: { action: 'set_block_props', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at: now,
    });
    return { ok: false, appliedM: null, error: 'not available in survival build: set_block_props' };
  }
  const sent = deps.hub.send({
    schemaVersion: 1 as const,
    type: 'order' as const,
    orderId,
    orderType: decision.orderType,
    entityId: gridId,
    // `Radius` is the antenna's own terminal property; the filter matches every
    // radio antenna on the grid (a relay with two antennas tunes both).
    params: {
      action: 'set_block_props',
      entityId: gridId,
      filter: { type: 'RadioAntenna' },
      props: { Radius: Math.round(radiusM) },
    },
    tick: 0,
    issuedAt: now,
    expiresAt: now + timeoutMs,
  });
  if (!sent) return { ok: false, appliedM: null, error: 'plugin hub refused the order' };
  const result = await waitForResult(deps, orderId, timeoutMs);
  if (!result) return { ok: false, appliedM: null, error: 'no set_block_props result (timeout)' };
  return parseSetResult(result);
}

function parseSetResult(result: Record<string, unknown>): { ok: boolean; appliedM: number | null; error: string | null } {
  const blocks = Array.isArray(result.blocks) ? (result.blocks as Record<string, unknown>[]) : [];
  const errors: string[] = [];
  let after: number | null = null;
  for (const block of blocks) {
    const props = Array.isArray(block.props) ? (block.props as Record<string, unknown>[]) : [];
    for (const prop of props) {
      if (prop.id !== 'Radius') continue;
      const value = prop.after;
      if (typeof value === 'number' && Number.isFinite(value)) after = value;
    }
    if (Array.isArray(block.errors)) errors.push(...block.errors.map((e) => String(e)));
  }
  if (errors.length > 0 && after === null) return { ok: false, appliedM: null, error: errors.join('; ') };
  // A successful write can still report an unchanged value; read-back decides.
  if (after === null) return { ok: true, appliedM: null, error: null };
  return { ok: true, appliedM: after, error: null };
}

async function waitForResult(deps: ApplyDeps, orderId: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of deps.store.listOrderResults(500)) {
      const detail = entry.detail as { eventType?: string; data?: { orderId?: string; result?: Record<string, unknown> } };
      if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result') continue;
      if (detail.data?.orderId !== orderId) continue;
      return detail.data.result ?? {};
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
