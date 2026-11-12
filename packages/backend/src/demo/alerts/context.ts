/**
 * Builds the one AlertContext an evaluation runs on.
 *
 * Sources, all existing ones:
 *   * `store`               - owner-tagged capability profiles and telemetry rows
 *   * `networkSnapshot` / `liveGraph` (demo/network.ts) - the same gate/link
 *     graph the control gate uses, so "isolated" means the same thing here
 *   * `PowerPoller`         - the 30 s read-only profile snapshots
 *   * `DemoExecutor.summary()` - mission/drone terminal states
 *   * `SimSpeedMonitor`     - value, threshold and measured below-window
 *   * `designer:lastPlan`   - which planet has a plan, its cell size/range
 *
 * Coverage is computed from live positions over the plan's own cell grid. It
 * is terrain-uncorrected here (labelled `unavailable` in the evidence) because
 * the terrain field needs the :8786 proxy; the alert is about holes over time,
 * not about claiming a corrected percentage.
 */
import type { Store } from '../../store.js';
import { capabilitiesFromStore, liveGraph, networkSnapshot } from '../network.js';
import { loadWorld } from '../world.js';
import { nearestPlanetTo } from '../moveTo.js';
import { loadPlanetCatalog } from '../../planner/index.js';
import { coverageCellsFor, coverageCellsForNodes } from '../../planner/planetCoverage.js';
import { computeRunway, estimateRates, type PowerPoller, type PowerSnapshot } from '../power/index.js';
import type {
  AlertContext,
  AlertComeToMeWait,
  AlertCoverageView,
  AlertExecutionFailure,
  AlertGrid,
  AlertKnownGrid,
  AlertLinkedGrid,
} from './types.js';
import type { AlertsSettings } from './settings.js';
import {
  readCoverageBaseline,
  readDeletedGridIds,
  readKnownGrids,
  writeCoverageBaseline,
  writeKnownGrids,
} from './tracking.js';

const ZERO_G_ALT_M = 43_700;

export interface AlertsContextDeps {
  store: Store;
  clock: () => number;
  fixturePath: string | null;
  settings: () => AlertsSettings;
  power?: PowerPoller | null;
  /** Structural typing keeps this module free of the executor implementation. */
  executor?: { summary(): Record<string, unknown> } | null;
  simSpeed?: { status(): { value: number | null; threshold: number; belowForMs: number; at: number | null } } | null;
  pluginConnected?: () => boolean;
}

interface StoredPlan {
  id?: unknown;
  mode?: unknown;
  input?: { planet?: unknown; cellDeg?: unknown; k?: unknown; rangeMargin?: unknown };
  planets?: { a?: unknown; b?: unknown };
  hull?: { radioRangeM?: unknown };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildAlertContext(deps: AlertsContextDeps): AlertContext {
  const now = deps.clock();
  const settings = deps.settings();
  const store = deps.store;
  const planets = loadPlanetCatalog();
  const world = loadWorld(store, deps.fixturePath, now);
  const pluginConnected = deps.pluginConnected ? deps.pluginConnected() : false;
  const snapshot = networkSnapshot({
    store,
    world,
    now,
    freshMs: Math.max(settings.telemetryStaleMs, 60_000),
    prefabFor: () => null,
  });
  const graph = liveGraph(snapshot, planets);
  const caps = snapshot.capability;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const baseCount = graph.nodes.filter((n) => n.controlSource).length;
  const linkedById = new Map<string, AlertLinkedGrid[]>();
  for (const edge of graph.edges) {
    const add = (owner: string, otherId: string): void => {
      const list = linkedById.get(owner) ?? [];
      list.push({
        id: otherId,
        name: caps.get(otherId)?.name ?? null,
        kind: edge.kind,
        distanceM: Number.isFinite(edge.distanceM) ? Math.round(edge.distanceM) : null,
      });
      linkedById.set(owner, list);
    };
    add(edge.from, edge.to);
    add(edge.to, edge.from);
  }

  const grids: AlertGrid[] = [];
  for (const cap of caps.values()) {
    const unit = store.getUnit(cap.gridId);
    const position = unit?.pos ?? null;
    const planet = position ? nearestPlanetTo(position, planets) : null;
    const altitudeM =
      position && planet
        ? Math.max(
            0,
            Math.hypot(
              position.x - planet.center.x,
              position.y - planet.center.y,
              position.z - planet.center.z,
            ) - planet.surfaceRadiusM,
          )
        : null;
    const zeroG = Boolean(planet?.hasAtmosphere && altitudeM !== null && altitudeM >= ZERO_G_ALT_M);

    const power = deps.power?.snapshot(cap.gridId) ?? null;
    const rates = deps.power ? estimateRates(deps.power.series(cap.gridId, 1)) : null;
    const runway = power && rates ? computeRunway(power, rates, { zeroG }) : null;
    const meta = (unit?.meta ?? {}) as Record<string, unknown>;

    grids.push({
      id: cap.gridId,
      name: unit?.name || cap.name || power?.name || cap.gridId,
      planet: planet?.name ?? null,
      altitudeM,
      zeroG,
      isStatic: cap.isStatic ?? power?.isStatic ?? null,
      reachable: nodeById.get(cap.gridId)?.reachable === true,
      isBase: cap.controlSource || cap.profile === 'BASE',
      shouldReport: true,
      underControl:
        power?.underControl === true ||
        meta.underControl === true ||
        meta.manualControl === true ||
        meta.piloted === true,
      controlledBy: power?.controlledBy ?? null,
      gate: null,
      lastSeenAt: unit?.lastSeen ?? null,
      power,
      rates,
      runwayMin: runway?.runwayMin ?? null,
      powerRunwayMin: runway?.powerRunwayMin ?? null,
      fuelRunwayMin: runway?.fuelRunwayMin ?? null,
      uraniumRunwayMin: runway?.uraniumRunwayMin ?? null,
      radioRangeM: cap.radioRadiusM,
      position,
    });
  }

  // The grid list only ever contains grids that are still here, so a deleted
  // grid is invisible to a pure pass. Remember every live grid (position, AGL,
  // and the edges the link graph gave it) so the next pass can see it vanish.
  const deletedGridIds = readDeletedGridIds(store);
  const registry = new Map(readKnownGrids(store).map((entry) => [entry.id, entry]));
  for (const grid of grids) {
    if (grid.lastSeenAt === null) continue;
    if (!nodeById.has(grid.id)) continue; // never part of the link graph
    if (now - grid.lastSeenAt > settings.gridLostAfterMs) continue; // do not refresh a dead entry
    const entry: AlertKnownGrid = {
      id: grid.id,
      name: grid.name,
      planet: grid.planet,
      altitudeM: grid.altitudeM,
      position: grid.position,
      lastSeenAt: grid.lastSeenAt,
      linkedTo: linkedById.get(grid.id) ?? [],
    };
    registry.set(grid.id, entry);
  }
  for (const id of deletedGridIds) registry.delete(id);
  const knownGrids = [...registry.values()];
  writeKnownGrids(store, knownGrids);

  const executions = executorFailures(deps.executor, now);
  const coverage = planCoverage(store, grids, planets, now, settings, pluginConnected);

  // Keep the previous sample for the delta, then store this one. A planet that
  // drops out of the coverage list keeps its old sample until it ages out, so a
  // later return can still be compared inside the window.
  const coverageBaseline = readCoverageBaseline(store);
  if (pluginConnected) {
    const next = new Map(coverageBaseline.map((sample) => [sample.planet, sample]));
    for (const cov of coverage) {
      next.set(cov.planet, { planet: cov.planet, coveragePct: cov.coveragePct, at: now });
    }
    writeCoverageBaseline(
      store,
      [...next.values()].filter((sample) => now - sample.at <= 24 * 3_600_000),
    );
  }

  const sim = deps.simSpeed?.status() ?? null;
  return {
    now,
    grids,
    executions,
    coverage,
    simSpeed: sim
      ? {
          value: sim.value,
          threshold: sim.threshold,
          belowForMs: sim.belowForMs,
          sampleAt: sim.at,
        }
      : null,
    pluginConnected,
    baseCount,
    knownGrids,
    coverageBaseline,
    deletedGridIds: [...deletedGridIds],
    comeToMeWaits: comeToMeWaits(store),
  };
}

/**
 * Open come-to-me missions whose hover is waiting for a pilot. Read from the
 * missions themselves ({@link desiredState.comeToMe.phase}), so the alert
 * needs no executor state and survives a backend restart.
 */
export function comeToMeWaits(store: Store, limit = 50): AlertComeToMeWait[] {
  const out: AlertComeToMeWait[] = [];
  const missions = store.listMissions({ status: ['executing', 'paused', 'approved'], limit });
  for (const mission of missions) {
    const comeToMe = (mission.desiredState as { comeToMe?: Record<string, unknown> }).comeToMe;
    if (!comeToMe || comeToMe.phase !== 'waiting_for_pilot') continue;
    const readyAt = asNumber(comeToMe.readyAt);
    if (readyAt === null) continue;
    const gridId = mission.assignedUnits[0] ?? '';
    if (!gridId) continue;
    const unit = store.getUnit(gridId);
    const hover = comeToMe.hover as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    out.push({
      missionId: mission.id,
      gridId,
      name: unit?.name ?? null,
      player: asString(comeToMe.player),
      playerName: asString(comeToMe.playerName),
      readyAt,
      timeoutMs: asNumber(comeToMe.timeoutMs) ?? 600_000,
      hoverAglM: asNumber(comeToMe.hoverAglM),
      position:
        hover && typeof hover.x === 'number' && typeof hover.y === 'number' && typeof hover.z === 'number'
          ? { x: hover.x, y: hover.y, z: hover.z }
          : null,
    });
  }
  return out;
}

/** Terminal drone failures from the executor summary; defensive parsing. */
export function executorFailures(
  executor: { summary(): Record<string, unknown> } | null | undefined,
  now: number,
): AlertExecutionFailure[] {
  if (!executor) return [];
  let summary: Record<string, unknown>;
  try {
    summary = executor.summary();
  } catch {
    return [];
  }
  const executions = Array.isArray(summary.executions) ? summary.executions : [];
  const out: AlertExecutionFailure[] = [];
  for (const raw of executions) {
    if (!raw || typeof raw !== 'object') continue;
    const exec = raw as { missionId?: unknown; drones?: unknown };
    const missionId = asString(exec.missionId);
    if (!missionId || !Array.isArray(exec.drones)) continue;
    for (const item of exec.drones) {
      if (!item || typeof item !== 'object') continue;
      const drone = item as Record<string, unknown>;
      const state = drone.state;
      if (state !== 'failed' && state !== 'aborted') continue;
      const at = asNumber(drone.updatedAt) ?? now;
      out.push({
        missionId,
        gridId: asString(drone.gridId),
        name: asString(drone.label),
        state,
        reason: asString(drone.reason),
        at,
      });
    }
  }
  return out;
}

/**
 * One coverage view per planet that has a stored designer plan. The cell grid
 * and k come from the plan; the NODES AND POSITIONS ALWAYS COME FROM LIVE
 * TELEMETRY, never from the plan's stored slots. The count is any-node union
 * coverage (`coverageCellsForNodes`, the same function the optimiser uses), so
 * removing a relay only changes the number when that relay covered cells no
 * other live node reaches.
 *
 * With no live node the view is 0 % over the plan's cells: that is what lets a
 * total loss of the constellation register as a drop rather than disappear.
 */
function planCoverage(
  store: Store,
  grids: AlertGrid[],
  planets: ReturnType<typeof loadPlanetCatalog>,
  now: number,
  settings: AlertsSettings,
  pluginConnected: boolean,
): AlertCoverageView[] {
  // A frozen telemetry stream cannot prove a coverage change: the entire
  // planet would read as 0 % while the link is down.
  if (!pluginConnected) return [];
  const raw = store.getKv('designer:lastPlan');
  if (!raw) return [];
  let plan: StoredPlan;
  try {
    plan = JSON.parse(raw) as StoredPlan;
  } catch {
    return [];
  }
  const planetName = asString(plan.input?.planet) ?? asString(plan.planets?.a) ?? asString(plan.planets?.b);
  if (!planetName) return [];
  const planet = planets.find((p) => p.name === planetName || p.id === planetName);
  if (!planet) return [];

  const live = grids.filter(
    (g) =>
      g.planet === planet.name &&
      g.position !== null &&
      typeof g.radioRangeM === 'number' &&
      g.radioRangeM > 0 &&
      g.lastSeenAt !== null &&
      // Same liveness limit as grid-lost: a sample older than 2 polls is not a
      // live position, so the node stops counting toward coverage when it is
      // declared lost rather than two minutes later.
      now - g.lastSeenAt <= settings.gridLostAfterMs,
  );

  const radioRangeM = live.length ? Math.min(...live.map((g) => g.radioRangeM!)) : 0;
  const cellDeg = Math.max(2, Math.min(30, asNumber(plan.input?.cellDeg) ?? 10));
  const k = asNumber(plan.input?.k) === 2 ? 2 : 1;
  const margin = Math.max(0.5, Math.min(1, asNumber(plan.input?.rangeMargin) ?? 0.9));
  const result = coverageCellsForNodes(
    planet,
    coverageCellsFor(planet, cellDeg),
    live.map((g) => ({ id: g.id, position: g.position! })),
    radioRangeM * margin,
    k,
    null,
  );
  return [
    {
      planet: planet.name,
      planId: asString(plan.id),
      uncoveredCells: result.totalCells - result.coveredCells,
      totalCells: result.totalCells,
      coveragePct: result.coveragePct,
      cellDeg,
      k: k as 1 | 2,
      nodeIds: live.map((g) => g.id).sort(),
      terrain: result.terrain,
    },
  ];
}
