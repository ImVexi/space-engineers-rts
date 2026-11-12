/**
 * T68 alerts engine: shared types.
 *
 * Conditions are evaluated from ONE snapshot of the world built by
 * `context.ts` (the 30 s power poll tick plus the on-demand route). Nothing
 * here polls the game per alert. A missing reading is `null` and never a zero
 * (an unread tank is not an empty tank).
 */
import type { PowerSnapshot } from '../power/index.js';
import type { RateEstimate } from '../power/index.js';
import type { AlertAction, AlertSeverity, AlertSubjectType } from '../../store.js';

export type AlertKind =
  | 'energy-runway'
  | 'grid-isolated'
  | 'grid-lost'
  | 'coverage-hole'
  | 'coverage-drop'
  | 'grid-under-control'
  | 'mission-failed'
  | 'mission-aborted'
  | 'telemetry-stale'
  | 'plugin-link-down'
  | 'sim-speed'
  | 'needs-refuel'
  | 'come-to-me-timeout';

export const ALERT_KINDS: AlertKind[] = [
  'energy-runway',
  'grid-isolated',
  'grid-lost',
  'coverage-hole',
  'coverage-drop',
  'grid-under-control',
  'mission-failed',
  'mission-aborted',
  'telemetry-stale',
  'plugin-link-down',
  'sim-speed',
  'needs-refuel',
  'come-to-me-timeout',
];

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };

/** One grid as the evaluator sees it; built from store + power + graph. */
export interface AlertGrid {
  id: string;
  name: string;
  /** Planet name when the position resolves to one, else null. */
  planet: string | null;
  altitudeM: number | null;
  zeroG: boolean;
  isStatic: boolean | null;
  /** Reaches a base through the live gate/link graph. */
  reachable: boolean;
  /** True for a provisioned base / control source. */
  isBase: boolean;
  /** Owner-tagged grid: one that should report telemetry. */
  shouldReport: boolean;
  underControl: boolean;
  controlledBy: string | null;
  /** Gate verdict text for an isolated grid, when the graph supplies one. */
  gate: string | null;
  lastSeenAt: number | null;
  power: PowerSnapshot | null;
  rates: RateEstimate | null;
  runwayMin: number | null;
  powerRunwayMin: number | null;
  fuelRunwayMin: number | null;
  uraniumRunwayMin: number | null;
  /** Nearest radio range from the capability profile, metres. */
  radioRangeM: number | null;
  position: { x: number; y: number; z: number } | null;
}

/** One edge of the live link graph, as recorded for a lost grid. */
export interface AlertLinkedGrid {
  id: string;
  name: string | null;
  /** 'radio' | 'laser' | whatever the graph calls the medium. */
  kind: string;
  distanceM: number | null;
}

/** Last known state of a grid that reported telemetry in an earlier pass. */
export interface AlertKnownGrid {
  id: string;
  name: string;
  planet: string | null;
  /** Height above the planet surface, metres (AGL), null off-planet. */
  altitudeM: number | null;
  position: { x: number; y: number; z: number } | null;
  /** Newest telemetry sample while it was alive. */
  lastSeenAt: number;
  /** What the link graph said it was connected to at that sample. */
  linkedTo: AlertLinkedGrid[];
}

/** Coverage as of the previous evaluation, per planet. */
export interface AlertCoverageBaseline {
  planet: string;
  coveragePct: number;
  at: number;
}

/** One executor drone that ended in a terminal failure state. */
export interface AlertExecutionFailure {
  missionId: string;
  gridId: string | null;
  name: string | null;
  state: 'failed' | 'aborted';
  reason: string | null;
  at: number;
}

/** One come-to-me hover that has waited past its timeout for a pilot. */
export interface AlertComeToMeWait {
  missionId: string;
  gridId: string;
  name: string | null;
  player: string | null;
  playerName: string | null;
  /** Backend clock when the hover began. */
  readyAt: number;
  timeoutMs: number;
  hoverAglM: number | null;
  position: { x: number; y: number; z: number } | null;
}

export interface AlertCoverageView {
  planet: string;
  planId: string | null;
  /** Live, terrain-uncorrected coverage over the plan's own cell grid. */
  uncoveredCells: number;
  totalCells: number;
  coveragePct: number;
  cellDeg: number;
  k: 1 | 2;
  /** Nodes on the planet that took part in the calculation. */
  nodeIds: string[];
  terrain: string;
}

export interface AlertSimSpeedView {
  value: number | null;
  threshold: number;
  belowForMs: number;
  sampleAt: number | null;
}

/** One evaluation input. Tests build this directly; runtime builds it live. */
export interface AlertContext {
  now: number;
  grids: AlertGrid[];
  executions: AlertExecutionFailure[];
  coverage: AlertCoverageView[];
  simSpeed: AlertSimSpeedView | null;
  /** False when the plugin link is down: stale telemetry cannot be judged. */
  pluginConnected: boolean;
  /** Number of control sources the graph currently knows. */
  baseCount: number;
  /**
   * Grids that reported telemetry on an earlier evaluation, with their last
   * known position and links. Absence from `grids` is invisible without this.
   */
  knownGrids?: AlertKnownGrid[];
  /** Coverage percentage stored by the previous evaluation, per planet. */
  coverageBaseline?: AlertCoverageBaseline[];
  /** Grid ids deleted deliberately through our own API: never alert as lost. */
  deletedGridIds?: string[];
  /** Come-to-me hovers currently waiting (and past their timeout). */
  comeToMeWaits?: AlertComeToMeWait[];
}

/** A condition that holds right now, before dedupe. */
export interface AlertCandidate {
  kind: AlertKind;
  severity: AlertSeverity;
  subjectType: AlertSubjectType;
  subjectId: string;
  message: string;
  evidence: Record<string, unknown>;
  actions: AlertAction[];
}
