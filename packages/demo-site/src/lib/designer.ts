/**
 * Constellation designer: form state, SE GPS parsing, approval gates and the
 * preview geometry the 3D scene draws.
 *
 * Everything here is pure (no React, no fetch) so the form, the GPS round-trip
 * and the preview can be unit-tested without a browser or a backend. The
 * shapes mirror docs/CONTRACT-T6.md exactly; the planner itself lives in the
 * backend, this file never invents positions of its own.
 */
import type { Vec3 } from '../types';

export type DesignerMode = 'constellation' | 'connect';
export type DesignerPattern = 'ring' | 'inclined-rings' | 'shell' | 'chain' | 'auto';
export type Redundancy = 1 | 2 | 'no-spof';
export type LaunchMode = 'surface' | 'orbital';
export type SizingMode = 'count' | 'spacing';

/** A connect endpoint: either a planet (surface anchor) or a raw GPS point. */
export interface DesignerPoint {
  planet?: string;
  gps?: Vec3;
}

export interface Hull {
  id: string;
  source: 'prefab' | 'owner-tagged';
  name: string;
  radioRangeM: number | null;
  laserCount: number;
  thrust: { atmo: number | null; ion: number | null; h2: number | null };
  canGroundLaunch: boolean | 'unknown';
  twrAtSurface: number | null;
  notes: string | null;
  gridSize?: 'large' | 'small' | null;
  massKg?: number | null;
  displayName?: string | null;
  /** Live telemetry sampled for an owner-tagged grid. */
  live?: { h2Pct: number | null; batteryPct: number | null; massKg: number | null } | null;
  power?: { reactorMW: number; batteryMWh: number; solarPeakMW: number } | null;
  tanks?: { h2Litres: number; h2FillPct: number; batteryFillPct: number } | null;
  enduranceSource?: 'measured' | 'definitions' | 'unavailable';
}

export interface OptionEndurance {
  available: boolean;
  enforced?: boolean;
  modelReason: string | null;
  canReachSlot: boolean | null;
  launch: 'surface' | 'orbital' | null;
  ascentTimeS: number | null;
  transitTimeS: number | null;
  etaS: number | null;
  fuelUsedPct: number | null;
  batteryUsedPct: number | null;
  reservePct: number | null;
  holdEnduranceS: number | 'indefinite' | null;
  holdEnduranceText: string;
  holdLimiting: string | null;
  holdPowerMW: number | null;
  holdH2BurnLps: number | null;
  twrAtSlot: number | null;
  failureReason: string | null;
  recommendation: string;
}

export interface DesignerSlot {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface DesignerLink {
  a: string;
  b: string;
  kind: 'radio' | 'laser';
  lengthM: number;
}

export interface DesignerSlotAltitude {
  id: string;
  altitudeM: number;
  groundRadiusM: number;
  radioRadiusM: number;
  role: string;
}

export interface DesignerAlternative {
  id: 'all-low' | 'all-max-reach' | 'best-mixed' | string;
  label: string;
  ships: number;
  h2L: number;
  batteryMWh: number;
  antennaMW: number;
  coveragePct: number;
  terrain: 'corrected' | 'unavailable' | 'none';
  altitudeRangeM: [number, number];
  cost: number;
  note: string;
}

/** T53: the coverage-first solve the cover-planet option was built from. */
export interface CoverGoalSummary {
  target: 'whole' | 'hemisphere' | 'radius';
  altitudeMode: 'manual' | 'max-reach' | 'cheapest';
  countNeeded: number;
  countUsed: number;
  requestedCount: number | null;
  coveredCells: number;
  totalCells: number;
  coveragePct: number;
  uncoveredPct: number;
  counts: { coveredK1: number; coveredK2: number };
  achievedK: 1 | 2;
  relaysWithoutSecondPath: string[];
  alternatives: DesignerAlternative[];
  totals: { h2L: number; batteryMWh: number; antennaMW: number; cost: number };
  terrain: 'corrected' | 'unavailable' | 'none';
  terrainReason: string | null;
  labels: string[];
  cells: { latDeg: number; lonDeg: number; coveredBy: number }[];
  slots: {
    id: string;
    latDeg: number;
    lonDeg: number;
    altitudeM: number;
    altitudeReason: string;
    radioRadiusM: number;
    radioSavedMW: number;
    footprintRadiusM: number;
    role: string;
  }[];
}

export interface DesignerOption {
  id: string;
  pattern: DesignerPattern | string;
  mode?: string;
  hullId: string;
  count: number;
  altitudeM: number;
  positions: DesignerSlot[];
  links: DesignerLink[];
  spofs: string[];
  redundancyAchieved: Redundancy;
  coveragePct: number | null;
  maxGapM: number;
  gravityAtSlotMps2: number | null;
  feasible: boolean;
  reasons: string[];
  summary: string;
  labels: string[];
  endurance?: OptionEndurance;
  /** T52/T53 additive fields the panel must read rather than assume. */
  altitudeMode?: 'manual' | 'max-reach' | 'cheapest';
  countNeeded?: number;
  countUsed?: number;
  uncoveredPct?: number;
  goal?: CoverGoalSummary;
  alternatives?: DesignerAlternative[];
  terrain?: 'corrected' | 'unavailable' | 'none';
  blockedCells?: number;
  slotAltitudes?: DesignerSlotAltitude[];
}

export interface DesignerPlanResponse {
  options: DesignerOption[];
  labels?: string[];
}

export interface DesignerSettings {
  simSpeedMin: number;
  maxActive: number;
  /** Minimum fuel/charge reserve for the launch preflight, percent. */
  launchReservePct?: number;
}

export interface DesignerSettingsResponse extends DesignerSettings {
  liveSimSpeed: number | null;
  threshold: number | null;
}

export interface DesignerExecuteResponse {
  missionId?: string;
  mission?: { id: string; status?: string; type?: string } & Record<string, unknown>;
  planId?: string;
  optionId?: string;
  option?: { id: string; pattern?: string; count?: number; summary?: string };
  launch?: LaunchMode;
  activeCap?: number;
  scaled?: boolean;
  label?: string | null;
  execution?: { status?: string; scaled?: boolean; note?: string | null; detail?: string } | null;
  labels?: string[];
  gps?: { added?: number; removed?: number } | null;
  note?: string;
}

export interface DesignerPreview {
  slots: { id: string; pos: Vec3 }[];
  links: { from: string; to: string; kind: 'radio' | 'laser' }[];
}

/** Sea level on the test worlds is ~0 m; 60 km is the gravity-free shelf. */
export const GRAVITY_FREE_ALTITUDE_M = 60_000;
export const MIN_ALTITUDE_M = 500;
export const MAX_ALTITUDE_M = 500_000;
export const MIN_COUNT = 3;
export const MAX_COUNT = 400;
export const MIN_SPACING_M = 1_000;
export const MAX_SPACING_M = 500_000;
export const MIN_MARGIN = 0.5;
export const MAX_MARGIN = 1;
export const MIN_SIMSPEED = 0.5;
export const MAX_SIMSPEED = 1;
export const MIN_ACTIVE = 1;
export const MAX_ACTIVE = 10;
export const MIN_RESERVE_PCT = 0;
export const MAX_RESERVE_PCT = 50;

export interface DesignerForm {
  mode: DesignerMode;
  planet: string;
  a: DesignerPoint | null;
  b: DesignerPoint | null;
  pattern: DesignerPattern;
  altitudeM: number;
  sizing: SizingMode;
  count: number;
  spacingM: number;
  hullId: string;
  rangeMargin: number;
  redundancy: Redundancy;
}

export const initialDesignerForm: DesignerForm = {
  mode: 'constellation',
  planet: '',
  a: null,
  b: null,
  pattern: 'auto',
  altitudeM: GRAVITY_FREE_ALTITUDE_M,
  sizing: 'count',
  count: 8,
  spacingM: 45_000,
  hullId: '',
  rangeMargin: 0.9,
  redundancy: 1,
};

export type DesignerAction =
  | { type: 'mode'; mode: DesignerMode }
  | { type: 'planet'; planet: string }
  | { type: 'point'; which: 'a' | 'b'; point: DesignerPoint | null }
  | { type: 'pattern'; pattern: DesignerPattern }
  | { type: 'altitude'; altitudeM: number }
  | { type: 'gravity-free' }
  | { type: 'sizing'; sizing: SizingMode }
  | { type: 'count'; count: number }
  | { type: 'spacing'; spacingM: number }
  | { type: 'hull'; hullId: string }
  | { type: 'margin'; rangeMargin: number }
  | { type: 'redundancy'; redundancy: Redundancy }
  | { type: 'reset'; form?: Partial<DesignerForm> };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Keeps the form inside the contract's accepted ranges. */
export function designerReducer(state: DesignerForm, action: DesignerAction): DesignerForm {
  switch (action.type) {
    case 'mode':
      return { ...state, mode: action.mode };
    case 'planet':
      return { ...state, planet: action.planet };
    case 'point':
      return action.which === 'a' ? { ...state, a: action.point } : { ...state, b: action.point };
    case 'pattern':
      return { ...state, pattern: action.pattern };
    case 'altitude':
      return { ...state, altitudeM: Math.round(clamp(action.altitudeM, MIN_ALTITUDE_M, MAX_ALTITUDE_M)) };
    case 'gravity-free':
      return { ...state, altitudeM: Math.max(GRAVITY_FREE_ALTITUDE_M, state.altitudeM) };
    case 'sizing':
      return { ...state, sizing: action.sizing };
    case 'count':
      return { ...state, count: Math.round(clamp(action.count, MIN_COUNT, MAX_COUNT)) };
    case 'spacing':
      return { ...state, spacingM: Math.round(clamp(action.spacingM, MIN_SPACING_M, MAX_SPACING_M)) };
    case 'hull':
      return { ...state, hullId: action.hullId };
    case 'margin':
      return { ...state, rangeMargin: clamp(action.rangeMargin, MIN_MARGIN, MAX_MARGIN) };
    case 'redundancy':
      return { ...state, redundancy: action.redundancy };
    case 'reset':
      return { ...initialDesignerForm, ...action.form };
    default:
      return state;
  }
}

export function parseGpsString(input: string): { name: string; pos: Vec3 } | null {
  const raw = input.trim();
  if (!raw) return null;
  const parts = raw.includes(':')
    ? raw.split(':').map((s) => s.trim())
    : raw.split(/[\s,]+/).filter(Boolean);

  let name = '';
  let nums: string[];
  if (/^gps$/i.test(parts[0] ?? '')) {
    name = parts[1] ?? '';
    nums = parts.slice(2, 5);
  } else {
    nums = parts.slice(0, 3);
  }
  if (nums.length < 3) return null;
  const vals = nums.map((n) => Number(n));
  if (vals.some((v) => !Number.isFinite(v))) return null;
  return { name: name.replace(/[:\n\r]/g, ' ').trim(), pos: { x: vals[0]!, y: vals[1]!, z: vals[2]! } };
}

export function formatGpsString(name: string, pos: Vec3, color = '#7CE7FF'): string {
  const safe = (name || 'point').replace(/[:\n\r]/g, '-').slice(0, 64);
  return `GPS:${safe}:${Math.round(pos.x)}:${Math.round(pos.y)}:${Math.round(pos.z)}:${color}:`;
}

export function pointLabel(point: DesignerPoint | null): string {
  if (!point) return '—';
  if (point.planet) return point.planet;
  if (point.gps) return `GPS ${Math.round(point.gps.x)}, ${Math.round(point.gps.y)}, ${Math.round(point.gps.z)}`;
  return '—';
}

export interface PlanRequestBody {
  mode: DesignerMode | 'cover-planet';
  planet?: string;
  a?: DesignerPoint;
  b?: DesignerPoint;
  pattern?: DesignerPattern;
  altitudeM?: number;
  count?: number;
  spacingM?: number;
  hullId: string;
  rangeMargin: number;
  redundancy: Redundancy;
  /** T52/T53 cover-goal fields (mode 'cover-planet'). */
  altitudeMode?: 'manual' | 'max-reach' | 'cheapest';
  target?: 'whole' | 'hemisphere' | 'radius';
  targetRadiusM?: number;
  facing?: string;
  cellDeg?: number;
}

export interface PlanRequestBuild {
  body: PlanRequestBody | null;
  error: string | null;
}

/** Turns the form into the exact POST body; refuses incomplete connect pairs. */
export function buildPlanRequest(form: DesignerForm): PlanRequestBuild {
  if (!form.hullId) return { body: null, error: 'Pick a hull first' };
  if (form.mode === 'constellation' && !form.planet) return { body: null, error: 'Pick a planet first' };
  if (form.mode === 'connect') {
    if (!form.a || !form.b) return { body: null, error: 'Pick point A and point B first' };
    if (form.a.planet && form.a.planet === form.b.planet && !form.a.gps && !form.b.gps) {
      return { body: null, error: 'A and B are the same planet — pick two different points' };
    }
  }

  const body: PlanRequestBody = {
    mode: form.mode,
    pattern: form.pattern,
    hullId: form.hullId,
    rangeMargin: Number(form.rangeMargin.toFixed(2)),
    redundancy: form.redundancy,
  };
  if (form.mode === 'constellation') {
    body.planet = form.planet;
    body.altitudeM = form.altitudeM;
  } else {
    body.a = form.a!;
    body.b = form.b!;
  }
  if (form.sizing === 'count') body.count = form.count;
  else body.spacingM = form.spacingM;
  return { body, error: null };
}

export function redundancyLabel(value: Redundancy): string {
  if (value === 2) return 'Two node-disjoint paths';
  if (value === 'no-spof') return 'No single point of failure';
  return 'Single path';
}

export function shortRedundancyLabel(value: Redundancy): string {
  if (value === 2) return 'k=2';
  if (value === 'no-spof') return 'no-SPOF';
  return 'k=1';
}

export function groundLaunchState(hull: Hull | null): 'yes' | 'no' | 'unknown' {
  if (!hull) return 'unknown';
  if (hull.canGroundLaunch === true) return 'yes';
  if (hull.canGroundLaunch === false) return 'no';
  return 'unknown';
}

/** Why an approval is blocked (null when it may fly). */
export function approvalBlock(
  option: DesignerOption | null,
  hull: Hull | null,
  launch: LaunchMode,
): string | null {
  if (!option) return 'Plan an option first';
  if (!option.feasible) return option.reasons[0] ?? 'Planner marked this option infeasible';
  if (option.count < 1) return 'Option has no slots';
  if (launch === 'surface') {
    const state = groundLaunchState(hull);
    if (state === 'no') return `${hull?.name ?? 'This hull'} cannot ground-launch — use an orbital launch`;
    if (state === 'unknown') return 'Ground launch UNVERIFIED for this hull — use an orbital launch';
  }
  return null;
}

/** Formatting shared by the panel and the option cards. */
export function formatKm(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return '—';
  if (Math.abs(meters) >= 1000) return `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 1)} km`;
  return `${Math.round(meters)} m`;
}

/** Seconds -> '45 s', '18 min', '2 h 05 min', 'indefinite'. */
export function formatDurationS(value: number | 'indefinite' | null | undefined): string {
  if (value === 'indefinite') return 'indefinite';
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export function formatGravity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(value < 0.1 ? 3 : 2)} m/s²`;
}

export function coverageLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a (point-to-point)';
  return `${Math.round(value)}%`;
}

/**
 * Slot/link geometry for the 3D preview, in metres (Scene converts to km).
 * The preview is planner output, never live telemetry, so it is drawn in a
 * deliberately different colour/style from GAME drones.
 */
export function optionPreview(option: DesignerOption | null): DesignerPreview | null {
  if (!option) return null;
  const ids = new Set(option.positions.map((s) => s.id));
  const slots = option.positions.map((s) => ({ id: s.id, pos: { x: s.x, y: s.y, z: s.z } }));
  const links = option.links
    .filter((l) => ids.has(l.a) && ids.has(l.b))
    .map((l) => ({ from: l.a, to: l.b, kind: l.kind }));
  return { slots, links };
}

/** Hull ordering: owner-tagged stand-ins first, then local prefabs. */
export function sortHulls(hulls: Hull[]): Hull[] {
  return [...hulls].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'owner-tagged' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function hullOptionLabel(hull: Hull): string {
  const tag = hull.source === 'owner-tagged' ? '[HERMES-TEST] ' : '';
  const radio = hull.radioRangeM === null ? 'no radio range' : `radio ${formatKm(hull.radioRangeM)}`;
  const launch = groundLaunchState(hull);
  const launchText = launch === 'yes' ? 'ground launch yes' : launch === 'no' ? 'no ground launch' : 'ground launch UNVERIFIED';
  return `${tag}${hull.name} · ${radio} · ${launchText}`;
}

export function hullSummary(hull: Hull | null): string {
  if (!hull) return 'No hull selected';
  const radio = hull.radioRangeM === null ? 'no radio' : `radio ${formatKm(hull.radioRangeM)}`;
  return `${hull.name} · ${hull.source === 'owner-tagged' ? 'owner [HERMES-TEST]' : 'local prefab'} · ${radio} · ${hull.laserCount} laser port(s) · ground launch ${groundLaunchState(hull).toUpperCase()}`;
}

/** Long text for the GPS toggle hint. */
export const TELEPORT_HINT = 'Alt+F10 > Entity List > Teleport to';
