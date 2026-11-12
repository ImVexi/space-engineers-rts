import type { LinkGraph } from '@se-rts/schemas';
import { PROTOCOL_LIMITS } from '@se-rts/schemas';
import type { Store } from '../store.js';
import type { DemoWorld } from './world.js';
import { liveGraph, networkSnapshot, type GridCapability, type NetworkSnapshot } from './network.js';
import { PROVISION_RADIO_GOOD_MS } from './provision/provisioner.js';

/**
 * Command-authority gate (single policy used by the demo executor, the demo
 * routes and the direct test-order route).
 *
 * `allowed` requires BOTH:
 *   1. the grid has fresh plugin telemetry with its antenna link `up`
 *      (GAME), and
 *   2. the network model can reach it: a radio path from a control source,
 *      where control sources are the provisioned `[HERMES-BASE]` grids whose
 *      antenna was read back as broadcasting, plus any live `Connected` laser
 *      pair (GAME edge).
 *
 * The path is range math, not a measured radio link, so the decision is
 * labelled SIMULATED even when the capability and link halves are GAME.
 * Unknown hardware still gets no profile: it is never assumed reachable.
 */
export interface CommsGate {
  nodeId: string;
  gate: 'comms';
  allowed: boolean;
  /** `GAME` would need a measured link graph; the path half is SIMULATED. */
  source: 'GAME' | 'SIMULATED';
  reason: string;
  gameLink: 'up' | 'down' | 'unknown' | 'no-telemetry';
  telemetryAgeMs: number | null;
  plannerPath: boolean | null;
  /** Fixture nodes have no grid behind them; the gate says so explicitly. */
  virtual: boolean;
  labels: string[];
  /** Provisioned capability profile used for the range maths, if any. */
  capability?: {
    radioRadiusM: number | null;
    laserCount: number;
    massKg: number | null;
    profile: 'BASE' | 'DRONE' | null;
    source: string;
    /** `absent` (no antenna) vs `unread`/`last-known-good` (unknown-but-held). */
    radioState?: string | null;
    radioAgeMs?: number | null;
  } | null;
  /** Provisioned bases with no antenna block: a world fact the owner must fix. */
  basesWithoutAntenna?: { id: string; name: string }[];
  /** `GAME` when the antenna state came from a provisioning read-back. */
  antennaSource?: 'GAME' | 'SIMULATED';
}

export interface GateInput {
  store: Store;
  world: DemoWorld;
  now: number;
  nodeId: string;
  freshMs?: number;
  /** Prefab for telemetry-only grids (the executor knows what it spawned). */
  prefabFor?: (id: string) => string | null;
  /**
   * A snapshot (and its graph) the caller ALREADY built for this tick. Without
   * it every gate evaluation rebuilds the whole network model, so a page that
   * gates N nodes does N full builds: measured 200 grids -> 1.5 s of blocked
   * event loop, which is exactly what starved the flight tick on 2026-11-10.
   */
  snapshot?: NetworkSnapshot;
  graph?: LinkGraph;
}

/**
 * Capability profile for a grid that is not a prefab (T10 owner-tagged).
 * Kept for the executor's stand-in fallback; the live model prefers the
 * provisioning snapshot. Uses the largest stand-in radio radius that does not
 * exceed the range the plugin measured, so the gate may under-estimate
 * reachability, never over-estimate it. `null` means "no profile".
 */
export function capabilityPrefabFor(store: Store, gridId: string): string | null {
  const raw = store.getKv('designer:gridRadios');
  if (!raw) return null;
  let radio: unknown;
  try {
    radio = (JSON.parse(raw) as Record<string, unknown>)[gridId];
  } catch {
    return null;
  }
  if (typeof radio !== 'number' || !Number.isFinite(radio) || radio <= 0) return null;
  if (radio >= 50_000) return 'Eradicator_mk.1';
  if (radio >= 30_000) return 'Encounter Mercenary';
  if (radio >= 10_000) return 'EncounterCitadelStation';
  if (radio >= 5_000) return 'Repair_Satellite';
  if (radio >= 1_000) return 'Large Control Drone';
  return null;
}

/** Prefab the gate should use for a grid: its prefab, or a capability stand-in. */
export function prefabForGrid(store: Store, gridId: string): string | null {
  const row = store.db.prepare(`SELECT prefab FROM demo_drones WHERE grid_id = ? LIMIT 1`).get(gridId) as
    | { prefab?: string }
    | undefined;
  const prefab = row?.prefab ?? null;
  if (prefab?.startsWith('existing:')) return capabilityPrefabFor(store, gridId);
  // A never-flown owner-tagged grid has no demo_drones row; the persisted
  // measured radios are still the right capability source for the gate.
  if (!prefab) return capabilityPrefabFor(store, gridId);
  return prefab;
}

/** Snapshot used by the gate; exported so routes can share one model. */
export function authoritySnapshot(input: GateInput): NetworkSnapshot {
  return networkSnapshot({
    store: input.store,
    world: input.world,
    now: input.now,
    freshMs: input.freshMs ?? PROTOCOL_LIMITS.telemetryFreshMs,
    prefabFor: input.prefabFor,
  });
}

export function buildAuthorityGraph(input: GateInput): LinkGraph {
  return liveGraph(authoritySnapshot(input));
}

function capabilityOf(cap: GridCapability | undefined): CommsGate['capability'] {
  if (!cap) return null;
  return {
    radioRadiusM: cap.radioRadiusM,
    laserCount: cap.laserCount,
    massKg: cap.massKg,
    profile: cap.profile,
    source: cap.source,
    radioState: cap.radioState,
    radioAgeMs: cap.radioAgeMs,
  };
}

export function evaluateGate(input: GateInput): CommsGate {
  const { store, now, nodeId } = input;
  const freshMs = input.freshMs ?? PROTOCOL_LIMITS.telemetryFreshMs;
  const unit = store.getUnit(nodeId);
  const snapshot = input.snapshot ?? authoritySnapshot(input);
  const graph = input.graph ?? liveGraph(snapshot);
  const node = graph.nodes.find((n) => n.id === nodeId);
  const cap = snapshot.capability.get(nodeId);
  const plannerPath = node ? Boolean(node.reachable) : null;
  const age = unit ? Math.max(0, now - unit.lastSeen) : null;
  const gameLink: CommsGate['gameLink'] = !unit
    ? 'no-telemetry'
    : unit.linkStatus === 'up' && age !== null && age <= freshMs
      ? 'up'
      : unit.linkStatus === 'down'
        ? 'down'
        : 'unknown';
  const fresh = gameLink === 'up';
  const virtual = !unit && node !== undefined;
  const fromGameProfile = cap !== undefined && (cap.source === 'provisioned-base' || cap.source === 'provisioned-grid');
  const sources = snapshot.nodes.filter((n) => n.controlSource).map((n) => n.id);
  const noAntenna = snapshot.noAntennaBases;
  const staleSource = sources
    .map((id) => snapshot.capability.get(id))
    .find((cap) => cap?.radioState === 'last-known-good' && typeof cap.radioAgeMs === 'number');
  const controlText = sources.length
    ? sources.map((id) => input.store.getUnit(id)?.name ?? snapshot.capability.get(id)?.name ?? id).join(', ')
    : 'no control source';
  const radioText = cap?.radioRadiusM ? `${Math.round(cap.radioRadiusM / 1000)} km radio` : 'no radio radius';

  const base: CommsGate = {
    nodeId,
    gate: 'comms',
    allowed: false,
    source: 'SIMULATED',
    reason: '',
    gameLink,
    telemetryAgeMs: age,
    plannerPath,
    virtual,
    labels: fromGameProfile ? ['GAME', 'SIMULATED'] : ['SIMULATED'],
    capability: capabilityOf(cap),
    antennaSource: fromGameProfile ? 'GAME' : 'SIMULATED',
    ...(noAntenna.length ? { basesWithoutAntenna: noAntenna } : {}),
  };

  if (!unit && !node) {
    return {
      ...base,
      reason: 'grid is not in the provisioned network model and has no plugin telemetry',
    };
  }
  if (unit && !fresh) {
    return {
      ...base,
      source: 'GAME',
      reason:
        gameLink === 'down'
          ? 'plugin telemetry reports the antenna link down'
          : age !== null && age > freshMs
            ? `plugin telemetry is stale (${age} ms old, limit ${freshMs} ms)`
            : 'plugin telemetry has no link state yet (antennas not up) or it is unknown',
    };
  }
  if (unit && node === undefined) {
    return {
      ...base,
      reason:
        'grid hardware has no capability profile: it is not owner-tagged [HERMES-BASE]/[HERMES-TEST], so the provisioner has no radio radius for it and it is not assumed reachable',
    };
  }
  if (plannerPath === false) {
    return {
      ...base,
      // With a provisioned base that has no antenna, the refusal is a GAME fact
      // (the read-back saw zero antennas), not a model opinion.
      source: sources.length === 0 && noAntenna.length ? 'GAME' : base.source,
      reason:
        sources.length === 0
          ? noAntenna.length
            ? `${noAntenna.map((b) => b.name).join(', ')} is a provisioned [HERMES-BASE] but has NO antenna block ` +
              '(0 antennas read back), so no control source can reach this grid: build an antenna on the base. ' +
              'This is a fact about the world, not a telemetry problem.'
            : 'no provisioned base with a broadcasting radio is registered, so there is no control source to reach'
          : `no planner path to ${controlText} at its live range (range math, not a measured link)`,
    };
  }
  if (!unit) {
    return {
      ...base,
      allowed: true,
      reason: 'virtual fixture node: planner-reachable from a control source; no grid or telemetry behind it',
    };
  }
  return {
    ...base,
    allowed: true,
    reason:
      `antenna link up and fresh (GAME); reachable from ${controlText} over the provisioned ${radioText} ` +
      '(range math, SIMULATED)' +
      (staleSource
        ? `; the control source's own antenna state is last-known-good, ${Math.round((staleSource.radioAgeMs ?? 0) / 1000)} s old ` +
          `(the last read failed, held inside the ${Math.round(PROVISION_RADIO_GOOD_MS / 1000)} s grace)`
        : ''),
  };
}
