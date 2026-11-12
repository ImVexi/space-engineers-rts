/**
 * Network optimiser (T43): "optimise my network".
 *
 * One read-only endpoint that takes the ships the owner actually has (live
 * telemetry, no assumptions about grids that are not there) and answers: what
 * is the best planetary coverage these ships can give with the least movement,
 * what does each move cost, what is left uncovered after the move, and what
 * would have to be built to close the rest.
 *
 * Reuse, not a second planner:
 *   * coverage numbers come from `coverageCellsForNodes` (T49 terrain-corrected
 *     slant paths), summed per distinct radio range so a heterogeneous fleet is
 *     counted honestly instead of being flattened to one range;
 *   * fuel, ETA and hold come from `evaluateHullAtSlot` (the ONE endurance
 *     model), with the live fuel/charge fractions passed as the tank state;
 *   * slot cost/hold/build text comes from `buildSlotSpec` (T49), so a build
 *     request here is the same block-level spec the designer emits;
 *   * hop connectivity and articulation points come from `planner/graph`;
 *   * commandability is supplied by the caller (`gate.ts` `evaluateGate`), so a
 *     grid the comms gate refuses is never moved.
 *
 * Search: cell-driven greedy set cover over candidate slots at each ship's
 * current altitude, then a prune pass (a move is dropped when coverage is
 * unchanged) and a swap pass. Acceptance requires a strictly positive coverage
 * gain, so "stay put" wins whenever movement buys nothing. Every loop is
 * bounded; the same input returns the same plan.
 *
 * Known limits, reported in the response rather than hidden:
 *   * moves are lateral at the ship's current altitude (an altitude change is a
 *     different vehicle profile and is left to build requests);
 *   * the coverage search uses the smooth footprint (fast); the reported
 *     coverageNow/coverageAfter numbers are terrain-corrected, and both are
 *     included so any drift is visible;
 *   * a grid whose hull cannot be modelled (no prefab match, no measured radio
 *     for a stand-in) is never asked to fly.
 */
import { createHash } from 'node:crypto';
import type { Planet } from '@se-rts/schemas';
import { PROTOCOL_LIMITS } from '@se-rts/schemas';
import { add, dist, dot, normalize, scale, sub, v3, type V3 } from '../../planner/geometry.js';
import {
  coverageCellsFor,
  coverageCellsForNodes,
  footprintAngle,
  type CoverageCellPoint,
  type TerrainStatus,
} from '../../planner/planetCoverage.js';
import type { TerrainField } from '../../planner/terrainField.js';
import { connectedComponents, findArticulationPoints } from '../../planner/graph.js';
import { capabilitiesFromStore, LASER_MODEL_CAP_M } from '../network.js';
import { evaluateHullAtSlot, hullForDesigner, slotPhysics, type EnduranceHull } from '../endurance/index.js';
import type { Store } from '../../store.js';
import { resolveSurvivalMode } from '../survival.js';
import { prefabHulls, type DesignerHull } from './hulls.js';
import { buildSlotSpec, type SlotHoldMode, type SlotSpec, type SlotThrustClass } from './slotSpec.js';
import {
  altitudeLadderM,
  bestFlatAltitudeM,
  cheapestAltitudeM,
  normaliseCostWeights,
  type AltitudeMode,
  type CostWeights,
} from './altitude.js';

// ---------------------------------------------------------------- constants

/** Hard cap on candidate slot directions; keeps the greedy search bounded. */
const MAX_CANDIDATE_DIRS = 600;
const MIN_CANDIDATE_DIRS = 96;
/** Greedy passes over the fleet. Each pass may move every movable ship once. */
const MAX_GREEDY_PASSES = 6;
/** Endurance checks per ship per pass (the model is the expensive part). */
const MAX_ENDURANCE_CHECKS = 4;
/** Swap pass bounds. */
const MAX_SWAP_PAIRS = 400;
const MAX_SWAP_ROUNDS = 4;
/** Hop edge factor on top of the effective (margin-applied) radio range. */
const HOP_FACTOR = 0.9;
/** Cells listed per move substitution sample. */
const SUBSTITUTION_SAMPLE = 24;
/** Uncovered cell detail listed per move. */
const UNCOVERED_SAMPLE = 60;
/** Laser suggestions cap. */
const MAX_LASER_SUGGESTIONS = 12;

// ------------------------------------------------------------------- types

export type OptimiseTargetInput =
  | { kind: 'whole' }
  | { kind: 'hemisphere'; facingDir: V3; facingLabel: string }
  | { kind: 'radius'; radiusM: number; centerDir: V3; centerLabel: string };

export interface OptimiseBase {
  gridId: string | null;
  name: string;
  position: V3;
  altitudeM: number;
  radioRangeM: number | null;
  latDeg: number;
  lonDeg: number;
  source: 'control-source' | 'request' | 'default';
}

export interface ExcludedGrid {
  gridId: string;
  name: string;
  reason: string;
}

export interface FleetShip {
  gridId: string;
  name: string;
  position: V3;
  altitudeM: number;
  latDeg: number;
  lonDeg: number;
  /** Measured radio radius, metres; null when the grid has no antenna. */
  radioRangeM: number | null;
  laserCount: number;
  fuelPct: number | null;
  batteryPct: number | null;
  massKg: number | null;
  isStatic: boolean;
  underControl: boolean;
  commandable: { allowed: boolean; reason: string };
  /** Endurance model for this grid; null when no hull could be matched. */
  hull: EnduranceHull | null;
  hullId: string | null;
  hullSource: 'prefab' | 'standin' | null;
  hullReason: string | null;
}

export interface FleetRead {
  ships: FleetShip[];
  excluded: ExcludedGrid[];
}

export interface LoadFleetOptions {
  store: Store;
  planet: Planet;
  now: number;
  freshMs?: number;
  includeGridIds?: string[];
  /** Comms gate from the caller (evaluateGate); never assumed open. */
  gateFor: (gridId: string) => { allowed: boolean; reason: string };
  /** Prefab the executor knows for a grid (`prefabForGrid`). */
  prefabFor: (gridId: string) => string | null;
}

// ------------------------------------------------------------- small utils

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function byId<T extends { gridId: string }>(a: T, b: T): number {
  return a.gridId < b.gridId ? -1 : a.gridId > b.gridId ? 1 : 0;
}

function dirOf(latDeg: number, lonDeg: number): V3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
}

function latLonOf(dir: V3): { latDeg: number; lonDeg: number } {
  return {
    latDeg: round((Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI, 1),
    lonDeg: round(((Math.atan2(dir.z, dir.x) * 180) / Math.PI), 1),
  };
}

function groundDistanceM(a: V3, b: V3, surfaceRadiusM: number): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * surfaceRadiusM;
}

function fibonacci(count: number): V3[] {
  const n = Math.max(1, Math.floor(count));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: V3[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push(v3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return out;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ------------------------------------------------------------------- fleet

/** Grids currently held by a player are never moved (T27 handoff rule). */
function controlMark(store: Store, gridId: string): { underControl: boolean; by: string | null } {
  const raw = store.getKv(`demo:control:${gridId}`);
  if (!raw) return { underControl: false, by: null };
  try {
    const parsed = JSON.parse(raw) as { underControl?: unknown; by?: unknown };
    return { underControl: parsed.underControl === true, by: typeof parsed.by === 'string' ? parsed.by : null };
  } catch {
    return { underControl: false, by: null };
  }
}

/**
 * Largest catalog hull whose measured radio does not exceed the grid's
 * measured radio. A stand-in may under-estimate reachability, never over-
 * estimate it (same principle as `capabilityPrefabFor` in the gate).
 *
 * When the grid's current altitude and mass are known, a hull that could not
 * even hold there is not a credible model of a grid that is visibly there, so
 * such hulls are dropped first; if none survives, the radio match stands and
 * the endurance refusal is reported (never silently overridden).
 */
function standInHull(
  ship: { radioRangeM: number | null; massKg: number | null },
  planet: Planet,
  altitudeM: number,
  catalog: DesignerHull[],
): DesignerHull | null {
  const radioRangeM = ship.radioRangeM;
  if (radioRangeM === null || radioRangeM <= 0) return null;
  const matches = catalog.filter((hull) => {
    const radio = hull.radioRangeM ?? 0;
    return radio > 0 && radio <= radioRangeM;
  });
  const plausible = matches.filter((hull) => {
    if (!ship.massKg || ship.massKg <= 0 || hull.massKg === null) return true;
    const adapted = hullForDesigner({ ...hull, massKg: ship.massKg });
    if (!adapted.hull) return true;
    return slotPhysics(adapted.hull, planet, Math.max(0, Math.round(altitudeM))).canHover;
  });
  const pool = plausible.length ? plausible : matches;
  let best: DesignerHull | null = null;
  for (const hull of pool) {
    if (!best || (hull.radioRangeM ?? 0) > (best.radioRangeM ?? 0)) best = hull;
  }
  return best;
}

/**
 * Model one grid's hull: the executor-known prefab when it maps to a catalog
 * hull, otherwise the radio stand-in. Live mass and fuel/charge fractions from
 * telemetry replace the definitions values, so the endurance verdict is about
 * this grid's actual state, not a full-tank prefab.
 */
function modelHull(
  ship: { massKg: number | null; fuelPct: number | null; batteryPct: number | null; radioRangeM: number | null },
  prefabName: string | null,
  catalog: DesignerHull[],
  planet: Planet,
  altitudeM: number,
): { hull: EnduranceHull | null; hullId: string | null; source: 'prefab' | 'standin' | null; reason: string | null } {
  const exact = prefabName ? catalog.find((hull) => hull.name === prefabName) ?? null : null;
  const source: 'prefab' | 'standin' | null = exact ? 'prefab' : null;
  const chosen = exact ?? standInHull(ship, planet, altitudeM, catalog);
  if (!chosen) {
    return {
      hull: null,
      hullId: null,
      source: null,
      reason: 'no catalog hull matches this grid and its measured radio has no stand-in; endurance cannot be modelled',
    };
  }
  const adapted: DesignerHull = {
    ...chosen,
    radioRangeM: ship.radioRangeM ?? chosen.radioRangeM,
    massKg: ship.massKg && ship.massKg > 0 ? ship.massKg : chosen.massKg,
    tanks: chosen.tanks
      ? {
          ...chosen.tanks,
          h2FillPct: ship.fuelPct ?? chosen.tanks.h2FillPct,
          batteryFillPct: ship.batteryPct ?? chosen.tanks.batteryFillPct,
        }
      : null,
    live:
      ship.fuelPct === null && ship.batteryPct === null && ship.massKg === null
        ? chosen.live ?? null
        : { h2Pct: ship.fuelPct, batteryPct: ship.batteryPct, massKg: ship.massKg },
  };
  const resolved = hullForDesigner(adapted);
  // Prefab hulls take plant/tank sizes from the definitions; the live fill
  // fractions are this grid's actual state and must win for the endurance
  // verdict (the model is unchanged, only its starting fuel/charge).
  const hull = resolved.hull
    ? {
        ...resolved.hull,
        ...(ship.fuelPct !== null ? { h2Fill: ship.fuelPct / 100 } : {}),
        ...(ship.batteryPct !== null ? { batteryFill: ship.batteryPct / 100 } : {}),
      }
    : null;
  return {
    hull,
    hullId: adapted.id,
    source: exact ? 'prefab' : 'standin',
    reason: resolved.hull ? resolved.reason : resolved.reason ?? 'the endurance model cannot build this hull',
  };
}

/**
 * Read the real fleet from the store. Only fresh telemetry counts; stale grids,
 * grids without a position, grids on another planet, grids the owner is flying
 * by hand and ids the caller asked for that are not there are listed in
 * `excluded[]` with a plain reason and never moved.
 */
export function loadOptimiseFleet(options: LoadFleetOptions): FleetRead {
  const { store, planet, now } = options;
  const freshMs = options.freshMs ?? PROTOCOL_LIMITS.telemetryFreshMs;
  const catalog = prefabHulls();
  const caps = capabilitiesFromStore(store);
  let persistedRadios: Record<string, unknown> = {};
  try {
    persistedRadios = JSON.parse(store.getKv('designer:gridRadios') ?? '{}') as Record<string, unknown>;
  } catch {
    persistedRadios = {};
  }

  const units = store.listUnits().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const wanted = options.includeGridIds ? new Set(options.includeGridIds) : null;
  const excluded: ExcludedGrid[] = [];
  const ships: FleetShip[] = [];

  for (const unit of units) {
    if (wanted && !wanted.has(unit.id)) continue;
    const name = unit.name || unit.id;
    const exclude = (reason: string): void => {
      excluded.push({ gridId: unit.id, name, reason });
    };
    if (!unit.pos) {
      exclude('no position in telemetry');
      continue;
    }
    const radius = dist(planet.center, unit.pos);
    const altitudeM = Math.round(radius - planet.surfaceRadiusM);
    if (altitudeM < -500 || altitudeM > 500_000) {
      exclude(`position is not at ${planet.name} (radial altitude ${(altitudeM / 1000).toFixed(1)} km)`);
      continue;
    }
    const meta = unit.meta as Record<string, unknown>;
    // A piloted grid's telemetry goes stale on purpose (the poller stops), so
    // the control check comes first: the owner needs the actionable reason.
    const underControl =
      controlMark(store, unit.id).underControl || meta.underControl === true || meta.manualControl === true;
    if (underControl) {
      exclude('under player control: the pilot owns this grid, it is never moved');
      continue;
    }
    const age = Math.max(0, now - unit.lastSeen);
    if (age > freshMs) {
      exclude(`stale telemetry (${Math.round(age / 1000)} s old, limit ${Math.round(freshMs / 1000)} s)`);
      continue;
    }
    if (unit.linkStatus !== 'up') {
      exclude(`antenna link ${unit.linkStatus}: no command path`);
      continue;
    }
    const capability = caps.get(unit.id);
    const radio =
      capability?.radioRadiusM ??
      num(persistedRadios[unit.id]) ??
      num(meta.radioRadiusM) ??
      num(meta.radio);
    const radioRangeM = radio !== null && radio > 0 ? radio : null;
    const laserCount =
      capability?.laserCount ?? (typeof meta.laserCount === 'number' ? meta.laserCount : 0);
    const massKg = num(meta.massKg) ?? capability?.massKg ?? null;
    const fuelFraction = num(meta.fuelFraction);
    const powerFraction = num(meta.powerFraction);
    const fuelPct = fuelFraction === null ? null : round(fuelFraction * 100, 1);
    const batteryPct = powerFraction === null ? null : round(powerFraction * 100, 1);
    const isStatic =
      capability?.isStatic === true || meta.isStatic === true || meta.station === true;
    const gate = options.gateFor(unit.id);
    const modelled = modelHull(
      { massKg, fuelPct, batteryPct, radioRangeM },
      options.prefabFor(unit.id),
      catalog,
      planet,
      altitudeM,
    );
    const ll = latLonOf(normalize(sub(unit.pos, planet.center)));
    ships.push({
      gridId: unit.id,
      name,
      position: unit.pos,
      altitudeM,
      latDeg: ll.latDeg,
      lonDeg: ll.lonDeg,
      radioRangeM,
      laserCount,
      fuelPct,
      batteryPct,
      massKg,
      isStatic,
      underControl,
      commandable: gate,
      hull: modelled.hull,
      hullId: modelled.hullId,
      hullSource: modelled.source,
      hullReason: modelled.hull ? null : modelled.reason,
    });
  }

  if (wanted) {
    for (const id of [...wanted].sort()) {
      if (units.some((unit) => unit.id === id)) continue;
      excluded.push({ gridId: id, name: id, reason: 'grid is not in telemetry: nothing is known about it' });
    }
  }
  return { ships: ships.sort(byId), excluded: excluded.sort(byId) };
}

// ------------------------------------------------------------- target cells

export interface TargetCells {
  cells: CoverageCellPoint[];
  description: string;
  /** Cells in the planet grid at this cell size (the whole reference). */
  planetCells: number;
}

export function targetCellsFor(
  planet: Planet,
  cellDeg: number,
  target: OptimiseTargetInput,
): TargetCells {
  const all = coverageCellsFor(planet, cellDeg);
  if (target.kind === 'whole') {
    return { cells: all, description: 'whole planet', planetCells: all.length };
  }
  if (target.kind === 'hemisphere') {
    const cells = all.filter((cell) => dot(cell.dir, target.facingDir) >= 0);
    return {
      cells,
      description: `hemisphere facing ${target.facingLabel} (every cell within 90 deg)`,
      planetCells: all.length,
    };
  }
  const cells = all.filter((cell) => groundDistanceM(cell.dir, target.centerDir, planet.surfaceRadiusM) <= target.radiusM);
  return {
    cells,
    description: `${round(target.radiusM / 1000, 1)} km radius around ${target.centerLabel}`,
    planetCells: all.length,
  };
}

// ------------------------------------------------------------------ coverage

interface FleetCount {
  counts: number[];
  geometricCounts: number[];
  blocked: boolean[];
  coveredCells: number;
  coveredK1: number;
  coveredK2: number;
  totalCells: number;
  pct: number;
  geometricPct: number;
  blockedCells: number;
  terrain: TerrainStatus;
  terrainReason: string | null;
  sampling: { samplesPerPath: number; tiles: number } | null;
}

/**
 * Coverage counts for a heterogeneous fleet. `coverageCellsForNodes` takes one
 * range, so the fleet is grouped by effective range and the per-cell counts are
 * summed: each node is still tested against its own range and the same terrain
 * slant-path test, never against a flattening average.
 */
function countFleet(
  planet: Planet,
  cells: CoverageCellPoint[],
  nodes: { id: string; position: V3; rangeM: number }[],
  k: 1 | 2,
  terrain: TerrainField | null,
): FleetCount {
  const counts = new Array<number>(cells.length).fill(0);
  const geometric = new Array<number>(cells.length).fill(0);
  const blocked = new Array<boolean>(cells.length).fill(false);
  if (cells.length === 0) {
    return {
      counts,
      geometricCounts: geometric,
      blocked,
      coveredCells: 0,
      coveredK1: 0,
      coveredK2: 0,
      totalCells: 0,
      pct: 0,
      geometricPct: 0,
      blockedCells: 0,
      terrain: terrain ? (terrain.status === 'available' ? 'corrected' : 'unavailable') : 'none',
      terrainReason: terrain && terrain.status !== 'available' ? terrain.reason ?? null : null,
      sampling: null,
    };
  }
  const groups = new Map<number, { id: string; position: V3 }[]>();
  for (const node of nodes) {
    const key = Math.round(node.rangeM);
    const list = groups.get(key) ?? [];
    list.push({ id: node.id, position: node.position });
    groups.set(key, list);
  }
  let terrainStatus: TerrainStatus = terrain ? 'unavailable' : 'none';
  let terrainReason: string | null = terrain ? terrain.reason ?? null : null;
  let sampling: FleetCount['sampling'] = null;
  for (const [rangeKey, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    // Horizon-limited: a cell below the relay's horizon is never heard, so an
    // altitude change is judged against the same footprint T52 reports.
    const result = coverageCellsForNodes(planet, cells, group, rangeKey, k, terrain, true);
    terrainStatus = result.terrain;
    terrainReason = result.terrainReason;
    sampling = result.sampling ?? sampling;
    for (let i = 0; i < cells.length; i += 1) {
      counts[i] = counts[i]! + (result.cells[i]?.coveredBy ?? 0);
      geometric[i] = geometric[i]! + (result.cells[i]?.geometricCoveredBy ?? 0);
      if (result.cells[i]?.blockedByTerrain) blocked[i] = true;
    }
  }
  let coveredCells = 0;
  let coveredK1 = 0;
  let coveredK2 = 0;
  let geometricCovered = 0;
  let blockedCells = 0;
  for (let i = 0; i < cells.length; i += 1) {
    if (counts[i]! >= k) coveredCells += 1;
    if (counts[i]! >= 1) coveredK1 += 1;
    if (counts[i]! >= 2) coveredK2 += 1;
    if (geometric[i]! >= k) geometricCovered += 1;
    if (blocked[i] && counts[i]! < k) blockedCells += 1;
  }
  return {
    counts,
    geometricCounts: geometric,
    blocked,
    coveredCells,
    coveredK1,
    coveredK2,
    totalCells: cells.length,
    pct: round((coveredCells / cells.length) * 100, 1),
    geometricPct: round((geometricCovered / cells.length) * 100, 1),
    blockedCells,
    terrain: terrainStatus,
    terrainReason,
    sampling,
  };
}

// ------------------------------------------------------------------- solver

interface Slot {
  dir: V3;
  position: V3;
  altitudeM: number;
  latDeg: number;
  lonDeg: number;
}

interface ShipState {
  ship: FleetShip;
  /** T52: altitude this ship would take under the chosen mode. */
  targetAltitudeM: number;
  /** Coverage range (margin applied): the footprint this ship provides. */
  rangeM: number;
  /** Hop range (measured radio): the connectivity the radio actually gives. */
  hopM: number;
  original: Slot;
  originalList: number[];
  slot: Slot;
  list: number[];
  moved: boolean;
  moveIndex: number;
  /** Endurance verdict for the accepted move (null when it never moved). */
  verdict: EnduranceVerdict | null;
}

interface EnduranceVerdict {
  distanceM: number;
  etaS: number;
  h2L: number | null;
  batteryMWh: number | null;
  reservePct: number;
  holdMode: SlotHoldMode;
  thrustClassNeeded: SlotThrustClass;
  holdEnduranceText: string;
}

export interface OptimiseMove {
  gridId: string;
  name: string;
  from: { pos: { x: number; y: number; z: number }; altitudeM: number; latDeg: number; lonDeg: number };
  to: { pos: { x: number; y: number; z: number }; altitudeM: number; latDeg: number; lonDeg: number };
  distanceM: number;
  etaS: number;
  fuel: { h2L: number | null; batteryMWh: number | null; reservePct: number };
  thrustClassNeeded: SlotThrustClass;
  holdMode: SlotHoldMode;
  /** T52: how far the move changes altitude (metres, signed). */
  altitudeChangeM?: number;
  altitudeReason?: string;
  reason: string;
  substitution: {
    basis: string;
    cellsCovered: number;
    coversTotal: number;
    covers: { latDeg: number; lonDeg: number; stillCoveredBy: string[]; coveredByOthers: number }[];
    uncoveredDuringTransit: boolean;
    uncoveredCellCount: number;
    uncoveredCells: { latDeg: number; lonDeg: number }[];
    uncoveredTruncated: boolean;
    transitEtaS: number;
  };
}

export type HoleReason = 'no relay in range' | 'terrain shadow' | 'no LOS to any base' | 'no hull available';

export interface HoleFix {
  kind: 'reposition' | 'build' | 'bridge' | 'raise-max-moves';
  text: string;
  gridId?: string;
  distanceM?: number;
  etaS?: number;
  buildRequest?: string;
}

export interface OptimiseHole {
  latDeg: number;
  lonDeg: number;
  reason: HoleReason;
  fix: HoleFix;
}

export interface BuildRequest {
  slotId: string;
  /** The uncovered cell this request serves, for traceability. */
  servesHole: { latDeg: number; lonDeg: number };
  latDeg: number;
  lonDeg: number;
  altitudeM: number;
  tier: SlotSpec['tier'];
  holdMode: SlotHoldMode;
  thrustClassNeeded: SlotThrustClass;
  fuelEstimate: SlotSpec['fuelEstimate'];
  antennaDrawMW: number;
  hoverDrawMW: number | null;
  modelHullId: string;
  ownedFits: SlotSpec['ownedFits'];
  buildRequest: string;
  reason: string;
}

export interface LaserSuggestion {
  kind: 'component-link' | 'cut-ship' | 'spof-bypass';
  a: { gridId: string; name: string; latDeg: number; lonDeg: number };
  b: { gridId: string; name: string; latDeg: number; lonDeg: number };
  distanceM: number;
  shipsFreed: number;
  text: string;
}

export interface FleetOperationPayload {
  schemaVersion: 1;
  kind: 'reshape';
  createdAt: number;
  planet: string;
  dryRun: false;
  members: { gridId: string; name: string; from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }[];
  steps: { seq: number; kind: string; gridId: string; params: Record<string, unknown> }[];
  note: string;
}

export interface OptimisePlan {
  schemaVersion: 1;
  planId: string;
  planet: { id: string; name: string; surfaceRadiusM: number };
  asOf: number;
  request: {
    target: string;
    k: 1 | 2;
    cellDeg: number;
    cellDegUsed: number;
    rangeMarginPct: number;
    maxMoves: number | null;
    maxSimSpeedBudget: number | null;
    includeGridIds: string[] | null;
    dryRun: boolean;
    /** T52: which altitude policy the solver used. */
    altitudeMode: AltitudeMode;
  };
  base: OptimiseBase;
  fleet: {
    total: number;
    withRadio: number;
    commandable: number;
    movable: number;
    /** What was read for every owned grid that has fresh telemetry. */
    entries: {
      gridId: string;
      name: string;
      radioRangeM: number | null;
      laserCount: number;
      altitudeM: number;
      latDeg: number;
      lonDeg: number;
      fuelPct: number | null;
      batteryPct: number | null;
      isStatic: boolean;
      commandable: boolean;
      hullId: string | null;
      hullSource: 'prefab' | 'standin' | null;
    }[];
  };
  excluded: ExcludedGrid[];
  coverageNow: {
    pct: number;
    coveredCells: number;
    totalCells: number;
    cellsByK: { k1: number; k2: number };
    blockedCells: number;
    geometricPct: number;
    terrain: TerrainStatus;
    terrainReason: string | null;
    sampling: { samplesPerPath: number; tiles: number } | null;
  };
  moves: OptimiseMove[];
  staying: { gridId: string; name: string; reason: string }[];
  surplus: { gridId: string; name: string; reason: string }[];
  coverageAfter: OptimisePlan['coverageNow'];
  gainPct: number;
  gainCells: number;
  holes: OptimiseHole[];
  holesTotal: number;
  holesTruncated: boolean;
  buildRequests: BuildRequest[];
  /**
   * T74: how a lost node is recovered in survival mode, in order. Reshaping
   * neighbours is the cheapest; handing an owned spare the slot comes next; only
   * then is a hull built. Spawning is never an option there.
   */
  recovery: {
    survivalMode: boolean;
    order: ('reshape_neighbours' | 'assign_spare' | 'build_request')[];
    reshapes: { gridId: string; name: string; reason: string }[];
    spares: { gridId: string; name: string; reason: string }[];
    buildRequests: number;
    note: string;
  };
  laserPass: LaserSuggestion[];
  solver: {
    candidateSlots: number;
    greedyPasses: number;
    movesEvaluated: number;
    enduranceChecks: number;
    swapsTried: number;
    /** T52: (direction x altitude) candidates scored. */
    altitudesEvaluated: number;
    basis: string;
    bounded: string;
  };
  assumptions: string[];
  labels: string[];
  limitations: string[];
  executable: boolean;
  operation: FleetOperationPayload | null;
}

export interface SolveInput {
  planet: Planet;
  ships: FleetShip[];
  excluded: ExcludedGrid[];
  base: OptimiseBase;
  target: OptimiseTargetInput;
  targetDescription: string;
  k: 1 | 2;
  cellDeg: number;
  cellDegUsed: number;
  rangeMarginPct: number;
  maxMoves: number | null;
  maxSimSpeedBudget?: number;
  minReservePct: number;
  maxHoles: number;
  terrain: TerrainField | null;
  now: number;
  dryRun: boolean;
  includeGridIds?: string[] | null;
  /** T52: 'manual' keeps every ship's altitude (default), the other modes may change it. */
  altitudeMode?: AltitudeMode;
  /** T52: CHEAPEST cost weights. */
  costWeights?: Partial<CostWeights> | null;
  timing?: boolean;
}

function slotOf(ship: FleetShip, planet: Planet): Slot {
  const dir = normalize(sub(ship.position, planet.center));
  return {
    dir,
    position: ship.position,
    altitudeM: ship.altitudeM,
    latDeg: ship.latDeg,
    lonDeg: ship.lonDeg,
  };
}

function slotAt(planet: Planet, dir: V3, altitudeM: number): Slot {
  const ll = latLonOf(dir);
  return {
    dir,
    position: add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM)),
    altitudeM,
    latDeg: ll.latDeg,
    lonDeg: ll.lonDeg,
  };
}

/** Bounded deterministic optimiser over the fleet's own ships. */
export function solveOptimise(input: SolveInput): OptimisePlan {
  const startedAt = Date.now();
  // T74: read once per plan; a non-test backend never offers a spawn as a fix.
  const survivalMode = resolveSurvivalMode();
  const { planet, k } = input;
  const altitudeMode: AltitudeMode = input.altitudeMode ?? 'manual';
  const costWeights = normaliseCostWeights(input.costWeights);
  const cellDegUsed = input.cellDegUsed;
  const margin = 1 - input.rangeMarginPct / 100;
  const maxMoves = input.maxMoves ?? input.ships.length;
  const target = targetCellsFor(planet, cellDegUsed, input.target);
  const cells = target.cells;
  const totalCells = cells.length;
  const candidateDirs = fibonacci(
    Math.max(MIN_CANDIDATE_DIRS, Math.min(MAX_CANDIDATE_DIRS, Math.round(totalCells / 3))),
  );

  // Visibility cache: candidate footprints depend on (dir, altitude, range).
  const visibilityCache = new Map<string, number[]>();
  const visibilityFor = (key: string, dir: V3, altitudeM: number, rangeM: number): number[] => {
    const cached = visibilityCache.get(key);
    if (cached) return cached;
    const nodeRadius = planet.surfaceRadiusM + altitudeM;
    const radio = footprintAngle(planet.surfaceRadiusM, nodeRadius, rangeM);
    const horizon = Math.acos(Math.max(-1, Math.min(1, planet.surfaceRadiusM / nodeRadius)));
    const phi = Math.min(radio, horizon);
    const list: number[] = [];
    if (phi > 0) {
      const cosPhi = Math.cos(phi);
      for (let i = 0; i < totalCells; i += 1) {
        if (dot(dir, cells[i]!.dir) >= cosPhi) list.push(i);
      }
    }
    visibilityCache.set(key, list);
    return list;
  };

  const states: ShipState[] = input.ships.map((ship) => {
    const original = slotOf(ship, planet);
    const rangeM = (ship.radioRangeM ?? 0) * margin;
    const hopM = (ship.radioRangeM ?? 0) * HOP_FACTOR;
    const list =
      rangeM > 0
        ? visibilityFor(`cur:${ship.gridId}`, original.dir, original.altitudeM, rangeM)
        : [];
    return {
      ship,
      targetAltitudeM: altitudeTargetFor({
        ship,
        planet,
        mode: altitudeMode,
        currentAltitudeM: original.altitudeM,
        // The solver measures footprints with the margin applied, so the
        // altitude target must use the same effective range.
        effectiveRangeM: rangeM,
        weights: costWeights,
      }),
      rangeM,
      hopM,
      original,
      originalList: list,
      slot: original,
      list,
      moved: false,
      moveIndex: -1,
      verdict: null,
    };
  });
  if (process.env.RTS_OPTIMISE_DEBUG === '1') {
    console.info(`[optimise:debug] mode=${altitudeMode} targets=${states.map((state) => `${state.ship.gridId}:${state.targetAltitudeM}`).join(',')} flat=${bestFlatAltitudeM(planet, 50_000)}`);
  }
  const active = states.filter((state) => state.rangeM > 0);

  const counts = new Array<number>(totalCells).fill(0);
  for (const state of active) for (const index of state.list) counts[index] = counts[index]! + 1;

  let covered = counts.reduce((sum, value) => sum + (value >= k ? 1 : 0), 0);
  const oldMark = new Uint32Array(totalCells);
  const newMark = new Uint32Array(totalCells);
  let stamp = 0;

  const movable = (state: ShipState): boolean =>
    state.rangeM > 0 &&
    !state.ship.isStatic &&
    state.ship.commandable.allowed &&
    state.ship.hull !== null;

  /** Cells this ship uniquely makes covered (its removal drops them below k). */
  const uniqueCells = (state: ShipState): number => {
    let count = 0;
    for (const index of state.list) {
      if (counts[index] === k) count += 1;
    }
    return count;
  };

  /**
   * Net covered-cell change if `state` moved to `newList`. Cells in both the
   * old and the new footprint cannot change state, so they are excluded from
   * both sides; gain is a cell the ship does not cover today and that is below
   * k, loss is a cell it was the k-th coverer of.
   */
  const netGain = (state: ShipState, newList: number[]): number => {
    stamp += 1;
    for (const index of state.list) oldMark[index] = stamp;
    for (const index of newList) newMark[index] = stamp;
    let gain = 0;
    let loss = 0;
    for (const index of newList) {
      if (oldMark[index] === stamp) continue;
      if (counts[index]! < k) gain += 1;
    }
    for (const index of state.list) {
      if (newMark[index] === stamp) continue;
      if (counts[index]! === k) loss += 1;
    }
    return gain - loss;
  };

  const applyMove = (state: ShipState, dir: V3, slot: Slot, list: number[]): void => {
    for (const index of state.list) counts[index] = counts[index]! - 1;
    for (const index of list) counts[index] = counts[index]! + 1;
    state.slot = slot;
    state.list = list;
    state.moved = true;
  };

  const revert = (state: ShipState): void => {
    for (const index of state.list) counts[index] = counts[index]! - 1;
    for (const index of state.originalList) counts[index] = counts[index]! + 1;
    state.slot = state.original;
    state.list = state.originalList;
    state.moved = false;
    state.moveIndex = -1;
    state.verdict = null;
  };

  /**
   * Hop graph over the base plus every ship slot. Edges are directional, like
   * `liveGraph`: a node can be commanded when the *sender* reaches it, so a
   * hop exists when `dist <= sender range`. `rangeM` here is already the 0.9 x
   * measured-radio hop limit.
   */
  const hopEdges = (
    positions: { id: string; position: V3; rangeM: number }[],
  ): Map<string, Set<string>> => {
    const adjacency = new Map<string, Set<string>>(positions.map((node) => [node.id, new Set<string>()]));
    for (const a of positions) {
      if (a.rangeM <= 0) continue;
      for (const b of positions) {
        if (a === b) continue;
        if (dist(a.position, b.position) <= a.rangeM + 0.5) adjacency.get(a.id)!.add(b.id);
      }
    }
    return adjacency;
  };

  const reachableFromBase = (adjacency: Map<string, Set<string>>): Set<string> => {
    const seen = new Set<string>();
    if (!adjacency.has(input.base.gridId ?? 'base')) return seen;
    const queue = [input.base.gridId ?? 'base'];
    seen.add(queue[0]!);
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const baseId = input.base.gridId ?? 'base';
  const baseRange = (input.base.radioRangeM ?? 0) * HOP_FACTOR;
  const fleetNodes = (): { id: string; position: V3; rangeM: number }[] => [
    { id: baseId, position: input.base.position, rangeM: baseRange },
    ...active.map((state) => ({ id: state.ship.gridId, position: state.slot.position, rangeM: state.hopM })),
  ];

  /**
   * A destination must join the base through hops of <= 0.9 x both radios, and
   * must not strand any ship that is reachable today ('no connection, no
   * control'). `before` is the current reachable set, computed once per ship.
   */
  const connectivityOk = (state: ShipState, slot: Slot, before: Set<string>): boolean => {
    if (baseRange <= 0) return false;
    const others = active
      .filter((other) => other !== state)
      .map((other) => ({ id: other.ship.gridId, position: other.slot.position, rangeM: other.hopM }));
    const probe = [
      { id: baseId, position: input.base.position, rangeM: baseRange },
      ...others,
      { id: state.ship.gridId, position: slot.position, rangeM: state.hopM },
    ];
    const after = reachableFromBase(hopEdges(probe));
    if (!after.has(state.ship.gridId)) return false;
    for (const other of active) {
      if (other === state) continue;
      if (before.has(other.ship.gridId) && !after.has(other.ship.gridId)) return false;
    }
    return true;
  };

  // Endurance + hold verdict for a move, from the ONE model. The reason is
  // carried out so a refused grid can say why in `staying[]`.
  const verdictFor = (
    state: ShipState,
    slot: Slot,
    distanceM: number,
  ): { verdict: EnduranceVerdict | null; reason: string | null } => {
    if (!state.ship.hull) {
      return { verdict: null, reason: state.ship.hullReason ?? 'no endurance model for this hull' };
    }
    const hull = state.ship.hull;
    const report = evaluateHullAtSlot({
      hull,
      planet,
      altitudeM: slot.altitudeM,
      transitDistanceM: distanceM,
    });
    const prefix =
      state.ship.hullSource === 'standin'
        ? `radio stand-in model (${state.ship.hullId}) says: `
        : '';
    if (!report.canReachSlot || report.failureReason !== null) {
      return {
        verdict: null,
        reason: `${prefix}${report.failureReason ?? 'the endurance model cannot reach this slot'}`,
      };
    }
    if (report.reservePct + 1e-9 < input.minReservePct) {
      return {
        verdict: null,
        reason: `${prefix}arrives with ${report.reservePct.toFixed(1)} % fuel/charge reserve (minimum ${input.minReservePct} %)`,
      };
    }
    const holdMode: SlotHoldMode =
      slot.altitudeM >= 100 && report.canReachSlot ? 'station' : 'ship';
    // A ship that cannot station must at least be able to hover, and hold for
    // more than an instant; a station holds for free.
    if (holdMode === 'ship') {
      if (report.holdPowerMW === null || report.holdEnduranceS === 0) {
        return { verdict: null, reason: 'cannot hover or hold at the destination altitude' };
      }
    } else if (report.holdEnduranceS === 0) {
      return { verdict: null, reason: 'no fuel/charge to hold the destination' };
    }
    return { verdict: {
      distanceM,
      etaS: report.etaS ?? report.transitTimeS ?? 0,
      h2L:
        hull.h2CapacityL > 0
          ? round((hull.h2CapacityL * hull.h2Fill * report.fuelUsedPct) / 100, 1)
          : 0,
      batteryMWh:
        hull.batteryMWh > 0
          ? round((hull.batteryMWh * hull.batteryFill * report.batteryUsedPct) / 100, 3)
          : 0,
      reservePct: report.reservePct,
      holdMode,
      thrustClassNeeded: thrustClassOf(state.ship, slot.altitudeM),
      holdEnduranceText: report.holdEnduranceText,
    }, reason: null };
  };

  const enduranceCache = new Map<string, { verdict: EnduranceVerdict | null; reason: string | null }>();
  const blockedReasons = new Map<string, string>();
  const enduranceChecksRef = { value: 0 };
  let movesEvaluated = 0;

  // Distances are arc lengths at the ship's altitude: the endurance model's
  // transit leg is a cruise at that altitude.
  const moveDistanceM = (a: Slot, b: Slot): number => {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(a.dir, b.dir))));
    return angle * (planet.surfaceRadiusM + a.altitudeM);
  };

  let greedyPasses = 0;
  let altitudesEvaluated = 0;
  const moveQueue: ShipState[] = [];
  for (let pass = 0; pass < MAX_GREEDY_PASSES; pass += 1) {
    greedyPasses += 1;
    let changed = false;
    for (const state of [...active].sort((a, b) => byId(a.ship, b.ship))) {
      if (!movable(state)) continue;
      if (moveQueue.length >= maxMoves && !state.moved) continue;
      // Keep the best few options: ranking is by coverage gain, then by the
      // shortest movement. Only the ranked few get an endurance check.
      const ranked: { dir: V3; slot: Slot; list: number[]; net: number; distanceM: number }[] = [];
      const reachableBefore = reachableFromBase(hopEdges(fleetNodes()));
      let connectedCandidates = 0;
      let positiveCandidates = 0;
      // T52: with an altitude mode the same direction is tried at the mode's
      // target height as well, so a move may climb or descend.
      const altitudeOptions = [state.slot.altitudeM];
      if (altitudeMode !== 'manual' && state.targetAltitudeM !== state.slot.altitudeM) {
        altitudeOptions.push(state.targetAltitudeM);
      }
      for (let index = 0; index < candidateDirs.length; index += 1) {
        const dir = candidateDirs[index]!;
        for (const altitudeM of altitudeOptions) {
          const key = `c:${index}:${Math.round(altitudeM / 100)}:${Math.round(state.rangeM)}`;
          const list = visibilityFor(key, dir, altitudeM, state.rangeM);
          if (list.length === 0) continue;
          const net = netGain(state, list);
          if (net <= 0) continue;
          positiveCandidates += 1;
          altitudesEvaluated += 1;
          const slot = slotAt(planet, dir, altitudeM);
          // Reachability is a hard constraint, so it filters before the cost
          // ranking: the expensive endurance model then sees only options that
          // could actually be ordered.
          if (!connectivityOk(state, slot, reachableBefore)) continue;
          connectedCandidates += 1;
          const distanceM =
            moveDistanceM(state.slot, slot) + Math.abs(slot.altitudeM - state.slot.altitudeM);
          movesEvaluated += 1;
          ranked.push({ dir, slot, list, net, distanceM });
          ranked.sort((a, b) => b.net - a.net || a.distanceM - b.distanceM || a.slot.latDeg - b.slot.latDeg);
          if (ranked.length > MAX_ENDURANCE_CHECKS) ranked.length = MAX_ENDURANCE_CHECKS;
        }
      }
      if (process.env.RTS_OPTIMISE_DEBUG === '1') {
        console.info(
          `[optimise:debug] pass=${pass} ship=${state.ship.gridId} target=${state.targetAltitudeM} positive=${positiveCandidates} connected=${connectedCandidates} ranked=${ranked.length} top=${ranked.slice(0, 2).map((r) => `${r.slot.altitudeM}:${r.net}:${Math.round(r.distanceM)}`).join(',')}`,
        );
      }
      if (ranked.length === 0) {
        if (connectedCandidates > 0) {
          blockedReasons.set(
            state.ship.gridId,
            'no useful slot is reachable from the base within 0.9 x radio hops',
          );
        }
        continue;
      }
      let accepted = false;
      for (const option of ranked) {
        if (moveQueue.length >= maxMoves && !state.moved) break;
        const cacheKey = `${state.ship.gridId}:${option.slot.latDeg}:${option.slot.lonDeg}:${option.slot.altitudeM}`;
        let evaluated: { verdict: EnduranceVerdict | null; reason: string | null };
        if (enduranceCache.has(cacheKey)) {
          evaluated = enduranceCache.get(cacheKey)!;
        } else {
          enduranceChecksRef.value += 1;
          evaluated = verdictFor(state, option.slot, option.distanceM);
          enduranceCache.set(cacheKey, evaluated);
        }
        const verdict = evaluated.verdict;
        if (!verdict) {
          if (evaluated.reason) {
            blockedReasons.set(state.ship.gridId, `endurance refused the useful slots: ${evaluated.reason}`);
          }
          continue;
        }
        applyMove(state, option.dir, option.slot, option.list);
        state.verdict = verdict;
        state.moveIndex = moveQueue.includes(state) ? state.moveIndex : moveQueue.length;
        if (!moveQueue.includes(state)) moveQueue.push(state);
        changed = true;
        accepted = true;
        break;
      }
      if (accepted) {
        covered = counts.reduce((sum, value) => sum + (value >= k ? 1 : 0), 0);
      }
    }
    if (!changed) break;
  }

  // Prune: a move whose reversal costs nothing is movement for movement's sake.
  // It is only dropped when doing so keeps every other mover linked to the
  // base; a coverage-neutral move that bridges a chain is kept and labelled.
  for (const state of [...moveQueue].reverse()) {
    if (!state.moved) continue;
    const net = netGain(state, state.originalList);
    if (net < 0) continue;
    const probe = [
      { id: baseId, position: input.base.position, rangeM: baseRange },
      ...active
        .filter((other) => other !== state)
        .map((other) => ({ id: other.ship.gridId, position: other.slot.position, rangeM: other.rangeM })),
      { id: state.ship.gridId, position: state.original.position, rangeM: state.hopM },
    ];
    const reachesWithout = reachableFromBase(hopEdges(probe));
    const strandsOther = moveQueue.some(
      (other) => other !== state && other.moved && !reachesWithout.has(other.ship.gridId),
    );
    if (strandsOther) continue;
    revert(state);
    const at = moveQueue.indexOf(state);
    if (at >= 0) moveQueue.splice(at, 1);
  }
  for (let i = 0; i < moveQueue.length; i += 1) moveQueue[i]!.moveIndex = i;
  covered = counts.reduce((sum, value) => sum + (value >= k ? 1 : 0), 0);

  // Swap pass: exchange two ships' assigned slots when it strictly helps.
  let swapsTried = 0;
  const swapMembers = active.filter((state) => state.moved);
  for (let round = 0; round < MAX_SWAP_ROUNDS && swapMembers.length > 1; round += 1) {
    let best: { a: ShipState; b: ShipState; net: number } | null = null;
    let pairs = 0;
    outer: for (let i = 0; i < swapMembers.length; i += 1) {
      for (let j = i + 1; j < swapMembers.length; j += 1) {
        pairs += 1;
        if (pairs > MAX_SWAP_PAIRS) break outer;
        const a = swapMembers[i]!;
        const b = swapMembers[j]!;
        if (a === b) continue;
        const listA = visibilityFor(
          `swap:${a.ship.gridId}:${b.slot.latDeg}:${b.slot.lonDeg}:${a.rangeM}`,
          b.slot.dir,
          a.slot.altitudeM,
          a.rangeM,
        );
        const listB = visibilityFor(
          `swap:${b.ship.gridId}:${a.slot.latDeg}:${a.slot.lonDeg}:${b.rangeM}`,
          a.slot.dir,
          b.slot.altitudeM,
          b.rangeM,
        );
        // Exact recount over the affected cells only.
        const affected = new Set<number>([...a.list, ...b.list, ...listA, ...listB]);
        const inA = new Set(a.list);
        const inB = new Set(b.list);
        const inANew = new Set(listA);
        const inBNew = new Set(listB);
        let before = 0;
        let after = 0;
        for (const index of affected) {
          if (counts[index]! >= k) before += 1;
          const value =
            counts[index]! -
            (inA.has(index) ? 1 : 0) -
            (inB.has(index) ? 1 : 0) +
            (inANew.has(index) ? 1 : 0) +
            (inBNew.has(index) ? 1 : 0);
          if (value >= k) after += 1;
        }
        const net = after - before;
        swapsTried += 1;
        if (net > 0 && (!best || net > best.net)) best = { a, b, net };
      }
    }
    if (!best) break;
    const { a, b } = best;
    const listA = visibilityFor(`swap2:${a.ship.gridId}:${b.slot.latDeg}`, b.slot.dir, a.slot.altitudeM, a.rangeM);
    const listB = visibilityFor(`swap2:${b.ship.gridId}:${a.slot.latDeg}`, a.slot.dir, b.slot.altitudeM, b.rangeM);
    const slotA = b.slot;
    const slotB = a.slot;
    const distanceA = moveDistanceM(a.original, slotA);
    const distanceB = moveDistanceM(b.original, slotB);
    const verdictA = verdictFor(a, slotA, distanceA).verdict;
    const verdictB = verdictFor(b, slotB, distanceB).verdict;
    if (!verdictA || !verdictB) break;
    const swapProbe = [
      { id: baseId, position: input.base.position, rangeM: baseRange },
      ...active
        .filter((state) => state !== a && state !== b)
        .map((state) => ({ id: state.ship.gridId, position: state.slot.position, rangeM: state.hopM })),
      { id: a.ship.gridId, position: slotA.position, rangeM: a.hopM },
      { id: b.ship.gridId, position: slotB.position, rangeM: b.hopM },
    ];
    const swapReach = reachableFromBase(hopEdges(swapProbe));
    const reachableBeforeSwap = reachableFromBase(hopEdges(fleetNodes()));
    if (!swapReach.has(a.ship.gridId) || !swapReach.has(b.ship.gridId)) break;
    if (
      active.some(
        (state) =>
          reachableBeforeSwap.has(state.ship.gridId) && !swapReach.has(state.ship.gridId),
      )
    ) {
      break;
    }
    for (const index of a.list) counts[index] = counts[index]! - 1;
    for (const index of b.list) counts[index] = counts[index]! - 1;
    for (const index of listB) counts[index] = counts[index]! + 1;
    for (const index of listA) counts[index] = counts[index]! + 1;
    a.slot = slotA;
    a.list = listA;
    a.verdict = verdictA;
    b.slot = slotB;
    b.list = listB;
    b.verdict = verdictB;
    // A swap is two moves; report both in a stable order by grid id.
    swapMembers.sort((x, y) => byId(x.ship, y.ship));
  }
  for (const state of active) if (state.moved && !moveQueue.includes(state)) moveQueue.push(state);
  moveQueue.sort((a, b) => byId(a.ship, b.ship));
  for (let i = 0; i < moveQueue.length; i += 1) moveQueue[i]!.moveIndex = i;

  // Final connectivity repair: prune/swap can leave a mover linked only through
  // a ship that was reverted. A plan that strands a ship is not executable
  // ('no connection, no control'), so the last such mover goes back instead.
  for (let guard = 0; guard <= moveQueue.length; guard += 1) {
    const reachable = reachableFromBase(hopEdges(fleetNodes()));
    const stranded = moveQueue
      .filter((state) => !reachable.has(state.ship.gridId))
      .sort((a, b) => b.moveIndex - a.moveIndex || byId(a.ship, b.ship));
    if (stranded.length === 0) break;
    const victim = stranded[0]!;
    revert(victim);
    const at = moveQueue.indexOf(victim);
    if (at >= 0) moveQueue.splice(at, 1);
    for (let i = 0; i < moveQueue.length; i += 1) moveQueue[i]!.moveIndex = i;
  }
  covered = counts.reduce((sum, value) => sum + (value >= k ? 1 : 0), 0);

  // ---------------------------------------------------------- final numbers
  const finalNodes = active.map((state) => ({
    id: state.ship.gridId,
    position: state.slot.position,
    rangeM: state.rangeM,
  }));
  const nowNodes = active.map((state) => ({
    id: state.ship.gridId,
    position: state.original.position,
    rangeM: state.rangeM,
  }));
  const coverageNow = countFleet(planet, cells, nowNodes, k, input.terrain);
  const coverageAfter = countFleet(planet, cells, finalNodes, k, input.terrain);

  // ------------------------------------------------------------ substitution
  // Analysed in execution order, so "who still covers it" is the true state of
  // the fleet when this ship departs: ships already moved are at their new
  // slot, ships not yet moved are still at their old one.
  const contributorSets = new Map<string, Set<number>>(
    active.map((state) => [state.ship.gridId, new Set(state.originalList)]),
  );
  const moves: OptimiseMove[] = moveQueue.map((state) => {
    const verdict = state.verdict!;
    const own = state.originalList;
    const others = active.filter((other) => other !== state);
    const uncovered: number[] = [];
    const covers: OptimiseMove['substitution']['covers'] = [];
    const sampleStride = Math.max(1, Math.ceil(own.length / SUBSTITUTION_SAMPLE));
    own.forEach((index, position) => {
      const coverers = others
        .filter((other) => (contributorSets.get(other.ship.gridId) ?? new Set<number>()).has(index))
        .map((other) => other.ship.gridId)
        .sort();
      if (coverers.length === 0) uncovered.push(index);
      if (position % sampleStride === 0 && covers.length < SUBSTITUTION_SAMPLE) {
        covers.push({
          latDeg: cells[index]!.latDeg,
          lonDeg: cells[index]!.lonDeg,
          stillCoveredBy: coverers.slice(0, 4),
          coveredByOthers: coverers.length,
        });
      }
    });
    return {
      gridId: state.ship.gridId,
      name: state.ship.name,
      from: {
        pos: { x: round(state.original.position.x, 1), y: round(state.original.position.y, 1), z: round(state.original.position.z, 1) },
        altitudeM: state.original.altitudeM,
        latDeg: state.original.latDeg,
        lonDeg: state.original.lonDeg,
      },
      to: {
        pos: { x: round(state.slot.position.x, 1), y: round(state.slot.position.y, 1), z: round(state.slot.position.z, 1) },
        altitudeM: state.slot.altitudeM,
        latDeg: state.slot.latDeg,
        lonDeg: state.slot.lonDeg,
      },
      distanceM: Math.round(verdict.distanceM),
      etaS: verdict.etaS,
      fuel: { h2L: verdict.h2L, batteryMWh: verdict.batteryMWh, reservePct: verdict.reservePct },
      thrustClassNeeded: verdict.thrustClassNeeded,
      holdMode: verdict.holdMode,
      altitudeChangeM: Math.round(state.slot.altitudeM - state.original.altitudeM),
      altitudeReason: altitudeReasonForMove(altitudeMode, state.original.altitudeM, state.slot.altitudeM),
      reason:
        (netGain(state, state.originalList) >= 0 && uniqueCells(state) === 0
          ? 'bridge move: keeps another relay linked to the base; its own cells stay covered by others'
          : `covers ${state.list.length} target cell(s) at its new slot; ` +
            `net +${coverageAfter.coveredCells - coverageNow.coveredCells} cell(s) for the whole plan; ` +
            `${uncovered.length} of those cell(s) would be uncovered while it flies`),
      substitution: {
        basis: 'geometric footprint at the ship range; final totals are terrain-corrected',
        cellsCovered: own.length,
        coversTotal: own.length,
        covers,
        uncoveredDuringTransit: uncovered.length > 0,
        uncoveredCellCount: uncovered.length,
        uncoveredCells: uncovered
          .slice(0, UNCOVERED_SAMPLE)
          .map((index) => ({ latDeg: cells[index]!.latDeg, lonDeg: cells[index]!.lonDeg })),
        uncoveredTruncated: uncovered.length > UNCOVERED_SAMPLE,
        transitEtaS: verdict.etaS,
      },
    };
  });
  // The move is done before the next one starts: fold its new footprint in.
  for (const state of moveQueue) contributorSets.set(state.ship.gridId, new Set(state.list));

  // ---------------------------------------------------------- holes + fixes
  const finalContributors = new Map<string, Set<number>>(active.map((state) => [state.ship.gridId, new Set(state.list)]));
  const hopAdjacency = hopEdges(fleetNodes());
  const connectedIds = reachableFromBase(hopAdjacency);
  const uncoveredIndices: number[] = [];
  for (let i = 0; i < totalCells; i += 1) {
    if (coverageAfter.counts[i]! < k) uncoveredIndices.push(i);
  }

  // Cheapest covering candidate slot per uncovered cell, at each fleet altitude.
  const altitudes = [
    ...new Set(
      active
        .filter((state) => !state.ship.isStatic)
        .map((state) => Math.max(500, state.slot.altitudeM)),
    ),
  ].sort((a, b) => a - b);
  const candidateCovers = (index: number): { dirIndex: number; altitudeM: number; rangeM: number } | null => {
    const cell = cells[index]!;
    let best: { dirIndex: number; altitudeM: number; rangeM: number; penalty: number } | null = null;
    for (const altitudeM of altitudes.length ? altitudes : [15_000]) {
      const rangeM =
        (active.length
          ? active.reduce((max, state) => Math.max(max, state.rangeM), 0)
          : 50_000) || 50_000;
      const nodeRadius = planet.surfaceRadiusM + altitudeM;
      const radio = footprintAngle(planet.surfaceRadiusM, nodeRadius, rangeM);
      const horizon = Math.acos(Math.max(-1, Math.min(1, planet.surfaceRadiusM / nodeRadius)));
      const phi = Math.min(radio, horizon);
      if (phi <= 0) continue;
      const cosPhi = Math.cos(phi);
      for (let index2 = 0; index2 < candidateDirs.length; index2 += 1) {
        if (dot(candidateDirs[index2]!, cell.dir) < cosPhi) continue;
        const slot = slotAt(planet, candidateDirs[index2]!, altitudeM);
        const penalty = dist(slot.position, input.base.position);
        if (!best || penalty < best.penalty) best = { dirIndex: index2, altitudeM, rangeM, penalty };
      }
    }
    return best ? { dirIndex: best.dirIndex, altitudeM: best.altitudeM, rangeM: best.rangeM } : null;
  };

  // One catalog for the hole fixes: the hull a build request is modelled on is
  // the strongest owned hull, never an invented one.
  const catalogHulls = prefabHulls();
  const hullById = (id: string | null): DesignerHull | null =>
    id ? catalogHulls.find((hull) => hull.id === id) ?? null : null;
  const modelHullForBuild = (() => {
    const candidates = input.ships
      .map((ship) => ({ ship, hull: hullById(ship.hullId) }))
      .filter((entry): entry is { ship: FleetShip; hull: DesignerHull } => Boolean(entry.hull));
    const withRadio = candidates.filter((entry) => (entry.hull.radioRangeM ?? 0) > 0);
    const pool = withRadio.length ? withRadio : candidates;
    pool.sort((a, b) => (b.hull.radioRangeM ?? 0) - (a.hull.radioRangeM ?? 0) || byId(a.ship, b.ship));
    return pool[0]?.hull ?? catalogHulls.find((hull) => (hull.radioRangeM ?? 0) > 0) ?? null;
  })();
  // A hull already flying this plan is not a free hull for a new hole: only
  // mobile grids that cannot act as relays at all are offered to the slot spec.
  // A static station's hull cannot fly to the hole, so it is not "owned" here.
  const idleHullModels = input.ships
    .filter((ship) => !ship.isStatic && ((ship.radioRangeM ?? 0) <= 0 || ship.hull === null))
    .map((ship) => hullById(ship.hullId))
    .filter((hull): hull is DesignerHull => Boolean(hull));
  const requiredRadioM = active.length
    ? Math.round(active.reduce((sum, state) => sum + (state.ship.radioRangeM ?? 0), 0) / active.length)
    : 50_000;

  // Hole reasons and clustered reporting. Emit at most `maxHoles`, one per
  // 15-degree bucket, deterministic order (lat asc, lon asc).
  const bucketOf = (cell: CoverageCellPoint): string => {
    return `${Math.floor((cell.latDeg + 90) / 15)}:${Math.floor((cell.lonDeg + 180) / 15)}`;
  };
  const holes: OptimiseHole[] = [];
  const buildRequests: BuildRequest[] = [];
  const seenBuckets = new Set<string>();
  const coveredIds = active.map((state) => state.ship.gridId);
  for (const index of uncoveredIndices) {
    const cell = cells[index]!;
    const bucket = bucketOf(cell);
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    const blocked = coverageAfter.blocked[index] === true;
    const coveringIds = coveredIds.filter((id) => finalContributors.get(id)!.has(index));
    let reason: HoleReason;
    if (blocked) reason = 'terrain shadow';
    else if (coveringIds.length > 0 && coveringIds.every((id) => !connectedIds.has(id))) reason = 'no LOS to any base';
    else if (k === 2 && coverageAfter.counts[index]! === 1) reason = 'no hull available';
    else if (coveringIds.length > 0) reason = 'no hull available';
    else if (moveQueue.length >= maxMoves && maxMoves > 0) reason = 'no hull available';
    else reason = 'no relay in range';

    let fix: HoleFix;
    const slotChoice = candidateCovers(index);
    const slot = slotChoice ? slotAt(planet, candidateDirs[slotChoice.dirIndex]!, slotChoice.altitudeM) : null;
    const hullForSpec = modelHullForBuild;
    const buildSpec =
      slot && hullForSpec
        ? buildSlotSpec({
            planet,
            slotId: `hole-${holes.length + 1}`,
            position: slot.position,
            altitudeM: slot.altitudeM,
            hull: hullForSpec,
            requiredRadioM,
            ownedHulls: idleHullModels,
            transitDistanceM: 0,
          })
        : null;

    if (reason === 'no hull available' && moveQueue.length >= maxMoves && maxMoves > 0) {
      fix = {
        kind: 'raise-max-moves',
        text: `the plan already moves ${moveQueue.length} ship(s), the requested maxMoves; raise maxMoves to cover this cell`,
      };
    } else if (reason === 'no LOS to any base' && slot) {
      fix = {
        kind: 'bridge',
        text:
          `the relay(s) over this cell cannot reach a base within 0.9 x radio; add a bridge relay at ` +
          `${slot.latDeg}, ${slot.lonDeg} (${(slot.altitudeM / 1000).toFixed(1)} km) to chain it home`,
        ...(buildSpec ? { buildRequest: buildSpec.buildRequest ?? undefined } : {}),
      };
    } else if (reason === 'terrain shadow') {
      // A higher relay at the hole's own direction clears more of the ridge than
      // a lateral move; if that still does not fit, the fallback is a ground laser.
      const shadowAltitudeM = Math.min(30_000, (slot?.altitudeM ?? 15_000) + 5_000);
      const shadowSlot = slotAt(planet, cell.dir, shadowAltitudeM);
      const shadowSpec = hullForSpec
        ? buildSlotSpec({
            planet,
            slotId: `hole-${holes.length + 1}`,
            position: shadowSlot.position,
            altitudeM: shadowSlot.altitudeM,
            hull: hullForSpec,
            requiredRadioM,
            ownedHulls: idleHullModels,
          })
        : null;
      fix = {
        kind: 'build',
        text:
          `terrain blocks every sky path to this cell; raise a relay above the ridge at ` +
          `${shadowSlot.latDeg}, ${shadowSlot.lonDeg} (${(shadowSlot.altitudeM / 1000).toFixed(1)} km) ` +
          'or place a ground laser rover there',
        ...(shadowSpec?.buildRequest ? { buildRequest: shadowSpec.buildRequest } : {}),
      };
      if (shadowSpec?.buildRequest && buildRequests.length < 12) {
        buildRequests.push({
          slotId: shadowSpec.slotId,
          servesHole: { latDeg: cell.latDeg, lonDeg: cell.lonDeg },
          latDeg: shadowSlot.latDeg,
          lonDeg: shadowSlot.lonDeg,
          altitudeM: shadowSlot.altitudeM,
          tier: shadowSpec.tier,
          holdMode: shadowSpec.holdMode,
          thrustClassNeeded: shadowSpec.thrustClassNeeded,
          fuelEstimate: shadowSpec.fuelEstimate,
          antennaDrawMW: shadowSpec.antennaDrawMW,
          hoverDrawMW: shadowSpec.hoverDrawMW,
          modelHullId: hullForSpec?.id ?? 'unknown',
          ownedFits: shadowSpec.ownedFits,
          buildRequest: shadowSpec.buildRequest,
          reason: 'terrain shadow: no owned hull has line of sight over the ridge from the fleet altitude',
        });
      }
    } else if (slot && buildSpec) {
      if (buildSpec.ownedFits.some((fit) => fit.fits === true) && moveQueue.length < maxMoves) {
        const idle = input.ships.find(
          (ship) =>
            ship.hullId === buildSpec.ownedFits.find((fit) => fit.fits === true)?.hullId &&
            !moveQueue.some((state) => state.ship.gridId === ship.gridId),
        );
        fix = {
          kind: 'reposition',
          ...(idle ? { gridId: idle.gridId } : {}),
          text:
            `move ${idle ? idle.name : 'a spare hull'} to ${slot.latDeg}, ${slot.lonDeg} (${(slot.altitudeM / 1000).toFixed(1)} km): ` +
            `it fits this slot per the endurance model`,
        };
      } else {
        fix = {
          kind: 'build',
          text:
            buildSpec.buildRequest ??
            `the cheapest option is a relay at ${slot.latDeg}, ${slot.lonDeg} (${(slot.altitudeM / 1000).toFixed(1)} km)`,
          ...(buildSpec.buildRequest ? { buildRequest: buildSpec.buildRequest } : {}),
        };
        const slotKey = `${slot.latDeg}:${slot.lonDeg}`;
        if (
          buildSpec.buildRequest &&
          buildRequests.length < 12 &&
          !buildRequests.some((request) => `${request.latDeg}:${request.lonDeg}` === slotKey)
        ) {
          buildRequests.push({
            slotId: buildSpec.slotId,
            servesHole: { latDeg: cell.latDeg, lonDeg: cell.lonDeg },
            latDeg: slot.latDeg,
            lonDeg: slot.lonDeg,
            altitudeM: slot.altitudeM,
            tier: buildSpec.tier,
            holdMode: buildSpec.holdMode,
            thrustClassNeeded: buildSpec.thrustClassNeeded,
            fuelEstimate: buildSpec.fuelEstimate,
            antennaDrawMW: buildSpec.antennaDrawMW,
            hoverDrawMW: buildSpec.hoverDrawMW,
            modelHullId: hullForSpec?.id ?? 'unknown',
            ownedFits: buildSpec.ownedFits,
            buildRequest: buildSpec.buildRequest,
            reason: `no owned hull can serve this hole (${active.filter((state) => !state.ship.isStatic).length} mobile relay(s) already assigned)`,
          });
        }
      }
    } else {
      fix = {
        kind: 'build',
        text: `no owned hull and no candidate slot covers this cell at the fleet radio; a ground relay there is the only fix`,
      };
    }
    holes.push({ latDeg: cell.latDeg, lonDeg: cell.lonDeg, reason, fix });
    if (holes.length >= input.maxHoles) break;
  }

  // ------------------------------------------------------------- laser pass
  const laserPass = suggestLaserEdges(active, input.base, connectedIds, planet);

  // ---------------------------------------------------------------- staying
  const staying: { gridId: string; name: string; reason: string }[] = [];
  const surplus: { gridId: string; name: string; reason: string }[] = [];
  for (const state of states) {
    if (state.moved) continue;
    const ship = state.ship;
    let reason: string;
    if (state.rangeM <= 0) {
      reason = 'no radio antenna: it cannot act as a relay';
    } else if (ship.isStatic) {
      reason = 'static grid/station: it cannot be repositioned';
    } else if (!ship.commandable.allowed) {
      reason = `not commandable: ${ship.commandable.reason}`;
    } else if (!ship.hull) {
      reason = `no endurance model for this hull: ${ship.hullReason ?? 'unknown'}`;
    } else if (blockedReasons.has(ship.gridId)) {
      reason = blockedReasons.get(ship.gridId)!;
    } else if (uniqueCells(state) === 0) {
      reason = `its ${state.list.length} cell(s) are already covered by other relays; no movement buys coverage`;
    } else {
      reason = 'staying put: no relocation of this ship increases coverage';
    }
    staying.push({ gridId: ship.gridId, name: ship.name, reason });
    if (uniqueCells(state) === 0 || state.rangeM <= 0) {
      surplus.push({
        gridId: ship.gridId,
        name: ship.name,
        reason:
          state.rangeM <= 0
            ? 'no radio antenna: cannot act as a relay'
            : `redundant for this target: its ${state.list.length} cell(s) stay covered without it; release it or hold it in reserve`,
      });
    }
  }

  const fleetWithRadio = active.length;
  const commandable = input.ships.filter((ship) => ship.commandable.allowed).length;
  const movableCount = input.ships.filter(
    (ship) => ship.commandable.allowed && !ship.isStatic && ship.hull !== null && (ship.radioRangeM ?? 0) > 0,
  ).length;
  const gainCells = coverageAfter.coveredCells - coverageNow.coveredCells;

  const operation: FleetOperationPayload | null = input.dryRun || moves.length === 0
    ? null
    : {
        schemaVersion: 1,
        kind: 'reshape',
        createdAt: input.now,
        planet: planet.name,
        dryRun: false,
        members: moves.map((move) => ({
          gridId: move.gridId,
          name: move.name,
          from: move.from.pos,
          to: move.to.pos,
        })),
        steps: moves.flatMap((move, index) => [
          { seq: index * 3 + 1, kind: 'validate_reshape', gridId: move.gridId, params: { planet: planet.name } },
          {
            seq: index * 3 + 2,
            kind: 'move',
            gridId: move.gridId,
            params: {
              to: move.to.pos,
              altitudeM: move.to.altitudeM,
              etaS: move.etaS,
              reservePct: move.fuel.reservePct,
              reason: 'network optimise (T43)',
            },
          },
          {
            seq: index * 3 + 3,
            kind: move.holdMode === 'station' ? 'station' : 'hold',
            gridId: move.gridId,
            params: { altitudeM: move.to.altitudeM },
          },
        ]),
        note:
          'FleetOperation-shaped payload only: dryRun=false does not execute anything in this build. ' +
          'Execution (mission + comms gate + flight orders) is a separate job.',
      };

  const plan: OptimisePlan = {
    schemaVersion: 1,
    planId: planIdFor(input, planSeed(input, coverageNow.coveredCells, coverageAfter.coveredCells, moves)),
    planet: { id: planet.id, name: planet.name, surfaceRadiusM: planet.surfaceRadiusM },
    asOf: input.now,
    request: {
      target: input.targetDescription,
      k,
      cellDeg: input.cellDeg,
      cellDegUsed,
      rangeMarginPct: input.rangeMarginPct,
      maxMoves: input.maxMoves,
      maxSimSpeedBudget: input.maxSimSpeedBudget ?? null,
      includeGridIds: input.includeGridIds ?? null,
      dryRun: input.dryRun,
      altitudeMode,
    },
    base: input.base,
    fleet: {
      total: input.ships.length,
      withRadio: fleetWithRadio,
      commandable,
      movable: movableCount,
      entries: input.ships.map((ship) => ({
        gridId: ship.gridId,
        name: ship.name,
        radioRangeM: ship.radioRangeM,
        laserCount: ship.laserCount,
        altitudeM: ship.altitudeM,
        latDeg: ship.latDeg,
        lonDeg: ship.lonDeg,
        fuelPct: ship.fuelPct,
        batteryPct: ship.batteryPct,
        isStatic: ship.isStatic,
        commandable: ship.commandable.allowed,
        hullId: ship.hullId,
        hullSource: ship.hullSource,
      })),
    },
    excluded: input.excluded,
    coverageNow: {
      pct: coverageNow.pct,
      coveredCells: coverageNow.coveredCells,
      totalCells: coverageNow.totalCells,
      cellsByK: { k1: coverageNow.coveredK1, k2: coverageNow.coveredK2 },
      blockedCells: coverageNow.blockedCells,
      geometricPct: coverageNow.geometricPct,
      terrain: coverageNow.terrain,
      terrainReason: coverageNow.terrainReason,
      sampling: coverageNow.sampling,
    },
    moves,
    staying,
    surplus,
    coverageAfter: {
      pct: coverageAfter.pct,
      coveredCells: coverageAfter.coveredCells,
      totalCells: coverageAfter.totalCells,
      cellsByK: { k1: coverageAfter.coveredK1, k2: coverageAfter.coveredK2 },
      blockedCells: coverageAfter.blockedCells,
      geometricPct: coverageAfter.geometricPct,
      terrain: coverageAfter.terrain,
      terrainReason: coverageAfter.terrainReason,
      sampling: coverageAfter.sampling,
    },
    gainPct: round(coverageAfter.pct - coverageNow.pct, 1),
    gainCells,
    holes,
    holesTotal: uncoveredIndices.length,
    holesTruncated: uncoveredIndices.length > holes.length,
    buildRequests,
    recovery: {
      survivalMode,
      order: ['reshape_neighbours', 'assign_spare', 'build_request'],
      // (a) neighbours already moved by this plan are the first-stage recovery;
      // (b) surplus owned hulls the endurance model says fit a hole are spares;
      // (c) buildRequests above is the last stage.
      reshapes: moves.map((m) => ({ gridId: m.gridId, name: m.name, reason: 'reshape: this move is part of the plan that covers the hole' })),
      spares: surplus.map((sp) => ({ gridId: sp.gridId, name: sp.name, reason: sp.reason })),
      buildRequests: buildRequests.length,
      note: survivalMode
        ? 'survival mode: a lost node is covered by re-shaping neighbours, then by an owned spare that can reach the slot, then by a build request - never by spawning'
        : 'test server: a lost node may also be replaced by a spawned/cloned hull',
    },
    laserPass,
    solver: {
      candidateSlots: candidateDirs.length,
      greedyPasses,
      movesEvaluated,
      enduranceChecks: enduranceChecksRef.value,
      swapsTried,
      altitudesEvaluated,
      basis: 'geometric footprint search over candidate slots at the ship altitude and, under an altitude mode, at its target height; reported coverage is terrain-corrected',
      bounded: `passes<=${MAX_GREEDY_PASSES}, endurance<=${MAX_ENDURANCE_CHECKS}/ship/pass, swaps<=${MAX_SWAP_PAIRS} pairs x ${MAX_SWAP_ROUNDS} rounds`,
    },
    assumptions: [
      'fuel, ETA and hold come from demo/endurance/model.ts evaluateHullAtSlot with live fuel/charge fractions as the tank state',
      altitudeMode === 'manual'
      ? 'altitudeMode manual: every move keeps the ship at its current altitude'
      : `altitudeMode ${altitudeMode}: a move may also change altitude to the mode's target height (per-slot altitude for coverage plans)`, 
      'a hull without an owner prefab is modelled from the largest catalog hull whose radio does not exceed its measured radio and that could hold at its current altitude (never over-estimates reach)',
      'hop reachability is directional range math like the gate (0.9 x the measured radio); planet occlusion is not re-tested here, so the gate remains the final authority',
      'the coverage search uses the smooth footprint; reported numbers are terrain-corrected when tiles exist',
    ],
    labels: [
      'SIMULATED',
      'COVERAGE-GEOMETRY',
      coverageAfter.terrain === 'corrected' ? 'TERRAIN-CORRECTED' : coverageAfter.terrain === 'unavailable' ? 'TERRAIN-UNAVAILABLE' : 'TERRAIN-OFF',
    ],
    limitations: [
      'laser pass is advisory only in this version: it suggests pairs, it does not create links',
      'dryRun=false returns the FleetOperation payload only; nothing is executed here',
      'maxSimSpeedBudget is echoed for information; this plan does not time-box the operation',
      'holes[] is one representative per 15-degree bucket up to maxHoles, buildRequests[] is capped at 12; holesTotal is the true uncovered cell count',
      altitudeMode === 'manual'
        ? 'moves keep the current altitude; ask for altitudeMode max-reach or cheapest to let the planner change it'
        : `moves may change altitude under altitudeMode ${altitudeMode}; the endurance model prices the climb`, 
      'maxMoves is honoured in grid-id order: the solver does not search over which subset of ships may move',
      'coverage timing scales with the number of distinct radio ranges in the fleet (one terrain pass per range)',
      'terrain correction is available for EarthLike and Moon; other planets report terrain unavailable',
    ],
    executable: !input.dryRun && moves.length > 0,
    operation,
  };

  if (input.timing !== false) {
    console.info(
      `[optimise] planet=${planet.name} cellDeg=${cellDegUsed} cells=${totalCells} ships=${input.ships.length} ` +
        `moves=${moves.length} gain=${plan.gainPct}% ms=${Date.now() - startedAt}`,
    );
  }
  return plan;
}

function thrustClassOf(ship: FleetShip, altitudeM: number): SlotThrustClass {
  if (altitudeM < 100) return 'none';
  const thrust = { atmo: 0, ion: 0, h2: 0 };
  // The catalog hull carries the thrust split; the stand-in is under-estimated.
  const catalog = prefabHulls();
  const hull = ship.hullId ? catalog.find((entry) => entry.id === ship.hullId) : undefined;
  if (hull) {
    thrust.atmo = hull.thrust.atmo;
    thrust.ion = hull.thrust.ion;
    thrust.h2 = hull.thrust.h2;
  }
  if (thrust.h2 > 0) return altitudeM <= 9_000 ? 'atmo' : 'hydrogen';
  if (thrust.ion > 0 && thrust.atmo === 0) return 'ion';
  if (thrust.atmo > 0) return 'atmo';
  return 'none';
}

/** Advisory laser pairs: connect radio components, or bypass an articulation point. */
function suggestLaserEdges(
  active: ShipState[],
  base: OptimiseBase,
  connectedIds: Set<string>,
  planet: Planet,
): LaserSuggestion[] {
  const out: LaserSuggestion[] = [];
  const nodes = active.map((state) => ({
    id: state.ship.gridId,
    name: state.ship.name,
    position: state.slot.position,
    rangeM: state.hopM,
    latDeg: state.slot.latDeg,
    lonDeg: state.slot.lonDeg,
  }));
  const all = [
    { id: base.gridId ?? 'base', name: base.name, position: base.position, rangeM: base.radioRangeM ?? 0, latDeg: base.latDeg, lonDeg: base.lonDeg },
    ...nodes,
  ];
  // Radio edges are directional (a sender reaches a receiver); components use
  // the undirected view, which is what "a stranded cluster" means.
  const adjacency = new Map<string, Set<string>>(all.map((node) => [node.id, new Set<string>()]));
  for (const a of all) {
    if (a.rangeM <= 0) continue;
    for (const b of all) {
      if (a === b) continue;
      if (dist(a.position, b.position) <= a.rangeM + 0.5) adjacency.get(a.id)!.add(b.id);
    }
  }
  const undirected = new Map<string, Set<string>>(all.map((node) => [node.id, new Set<string>()]));
  for (const [from, tos] of adjacency) {
    for (const to of tos) {
      undirected.get(from)!.add(to);
      undirected.get(to)!.add(from);
    }
  }
  const ids = all.map((node) => node.id);
  const components = connectedComponents(ids, undirected).sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
  const byIdMap = new Map(all.map((node) => [node.id, node]));
  // The demo laser model caps every beam at 100 km; a pair is only suggested
  // inside that cap, so the suggestion is physically reachable in this model.
  const laserRange = (): number => LASER_MODEL_CAP_M;
  // Component to component: the closest pair two lasers could join.
  for (let i = 0; i < components.length; i += 1) {
    for (let j = i + 1; j < components.length; j += 1) {
      let best: { a: string; b: string; distanceM: number } | null = null;
      for (const idA of components[i]!) {
        for (const idB of components[j]!) {
          const a = byIdMap.get(idA)!;
          const b = byIdMap.get(idB)!;
          const distanceM = dist(a.position, b.position);
          if (distanceM > laserRange()) continue;
          if (!best || distanceM < best.distanceM || (distanceM === best.distanceM && idA + idB < best.a + best.b)) {
            best = { a: idA, b: idB, distanceM };
          }
        }
      }
      if (!best) continue;
      const a = byIdMap.get(best.a)!;
      const b = byIdMap.get(best.b)!;
      out.push({
        kind: 'component-link',
        a: { gridId: a.id, name: a.name, latDeg: a.latDeg, lonDeg: a.lonDeg },
        b: { gridId: b.id, name: b.name, latDeg: b.latDeg, lonDeg: b.lonDeg },
        distanceM: Math.round(best.distanceM),
        shipsFreed: 0,
        text: `a laser edge between ${a.name} and ${b.name} (${(best.distanceM / 1000).toFixed(1)} km) would join a stranded cluster to the base side of the network`,
      });
      if (out.length >= MAX_LASER_SUGGESTIONS) return out;
    }
  }
  // Articulation points: two neighbours that could be laser-bridged so the
  // articulation relay is no longer a single point of failure.
  const spofs = findArticulationPoints(ids, undirected).filter((id) => id !== (base.gridId ?? 'base'));
  for (const spofId of spofs.sort()) {
    const spof = byIdMap.get(spofId);
    if (!spof) continue;
    const neighbours = [...(adjacency.get(spofId) ?? [])]
      .map((id) => byIdMap.get(id)!)
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = 0; i < neighbours.length; i += 1) {
      for (let j = i + 1; j < neighbours.length; j += 1) {
        const a = neighbours[i]!;
        const b = neighbours[j]!;
        if (undirected.get(a.id)?.has(b.id)) continue;
        const distanceM = dist(a.position, b.position);
        if (distanceM > laserRange()) continue;
        out.push({
          kind: 'spof-bypass',
          a: { gridId: a.id, name: a.name, latDeg: a.latDeg, lonDeg: a.lonDeg },
          b: { gridId: b.id, name: b.name, latDeg: b.latDeg, lonDeg: b.lonDeg },
          distanceM: Math.round(distanceM),
          shipsFreed: 1,
          text:
            `a laser edge between ${a.name} and ${b.name} (${(distanceM / 1000).toFixed(1)} km) bypasses ${spof.name}, ` +
            'the single point of failure; that relay becomes optional',
        });
        if (out.length >= MAX_LASER_SUGGESTIONS) return out;
      }
    }
  }
  return out;
}

function planSeed(
  input: SolveInput,
  nowCovered: number,
  afterCovered: number,
  moves: OptimiseMove[],
): string {
  return JSON.stringify({
    planet: input.planet.name,
    target: input.targetDescription,
    k: input.k,
    cellDeg: input.cellDegUsed,
    margin: input.rangeMarginPct,
    base: input.base.gridId,
    ships: input.ships.map((ship) => ({
      id: ship.gridId,
      alt: ship.altitudeM,
      radio: ship.radioRangeM,
      fuel: ship.fuelPct,
      battery: ship.batteryPct,
    })),
    nowCovered,
    afterCovered,
    moves: moves.map((move) => ({ id: move.gridId, to: move.to.pos })),
  });
}

function planIdFor(_input: SolveInput, seed: string): string {
  return `opt-${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
}

// Re-exported so the route and tests do not reach into internals.
export type { CoverageCellPoint, SlotSpec };

/**
 * T52: the altitude a ship would take under the chosen mode. MANUAL keeps the
 * current height; MAX REACH uses the flat footprint peak; CHEAPEST uses the
 * ladder height with the lowest total cost per km of ground reach.
 */
export function altitudeTargetFor(args: {
  ship: FleetShip;
  planet: Planet;
  mode: AltitudeMode;
  currentAltitudeM: number;
  /** Margin-applied radio range the solver measures footprints with. */
  effectiveRangeM: number;
  weights: Required<CostWeights>;
}): number {
  if (args.mode === 'manual' || !(args.effectiveRangeM > 0)) return args.currentAltitudeM;
  if (args.mode === 'max-reach') return bestFlatAltitudeM(args.planet, args.effectiveRangeM);
  const hull = args.ship.hullId ? prefabHulls().find((entry) => entry.id === args.ship.hullId) : undefined;
  if (!hull) return args.currentAltitudeM;
  return cheapestAltitudeM({ planet: args.planet, hull, rangeM: args.effectiveRangeM, weights: args.weights });
}

function altitudeReasonForMove(mode: AltitudeMode, fromM: number, toM: number): string {
  const delta = toM - fromM;
  if (Math.abs(delta) < 1) {
    return mode === 'manual'
      ? 'keeps its current altitude (altitudeMode manual)'
      : 'no altitude change improved coverage enough to pay for the climb';
  }
  const from = (fromM / 1000).toFixed(1);
  const to = (toM / 1000).toFixed(1);
  if (delta > 0) {
    return `climbs ${from} km -> ${to} km: a higher relay covers a larger terrain-cleared footprint (${mode})`;
  }
  return `descends ${from} km -> ${to} km: cheaper climb and hold for the same cells (${mode})`;
}
