/**
 * Constellation control panel math (CONTRACT-FEATURES §5, T52, T53).
 *
 * This file is pure: it turns panel values into the plan request, ghost slot
 * positions, ship-to-slot assignment and the one-line cost. Three things it
 * must never get wrong:
 *
 *  - the DEFAULT goal is coverage ('cover the planet'), solved cell-first by
 *    the backend, not a geometric ring of a fixed count (T53);
 *  - count is AUTO by default: the request omits `count` and the panel shows
 *    what the solver says the goal needs; a fixed count is the operator
 *    overriding it (T53);
 *  - altitude follows T52 ('manual' | 'max-reach' | 'cheapest'), with the
 *    ground-reach readout from the same horizon-limited footprint the
 *    backend uses, so a manual height above the radio's reach is visible
 *    before Apply (T51.9b).
 */
import type { Vec3 } from '../types';
import type { DesignerPattern, Redundancy } from './designer';

export type ConstellationPattern = 'ring' | 'inclined' | 'arc' | 'shell';

/** T53 root goal. `pattern` is the manual-shape fallback under Advanced. */
export type ConstellationGoal = 'cover' | 'pattern';
export type CoverTargetKind = 'whole' | 'hemisphere' | 'radius';
export type AltitudeMode = 'manual' | 'max-reach' | 'cheapest';

export interface ConstellationForm {
  planet: string;
  goal: ConstellationGoal;
  target: CoverTargetKind;
  targetRadiusM: number;
  /** null = AUTO count (the solver's number); a number is the override. */
  count: number | null;
  altitudeMode: AltitudeMode;
  altitudeM: number;
  redundancy: Redundancy;
  /** advanced */
  pattern: ConstellationPattern;
  spacingM: number;
  inclinationDeg: number;
  hullId: string;
}

export const CONSTELLATION_PATTERNS: { value: ConstellationPattern; label: string; hint: string }[] = [
  { value: 'ring', label: 'Equatorial ring', hint: 'One ring around the equator — cheapest, covers the belt.' },
  { value: 'inclined', label: 'Two inclined rings', hint: 'Two rings tilted either side of the equator.' },
  { value: 'arc', label: 'Arc', hint: 'A short arc facing one region — planned as a chain.' },
  { value: 'shell', label: 'Shell', hint: 'Even coverage over the whole planet.' },
];

export const COVER_TARGETS: { value: CoverTargetKind; label: string; hint: string }[] = [
  { value: 'whole', label: 'Whole planet', hint: 'Every cell on the planet needs a relay.' },
  { value: 'hemisphere', label: 'Hemisphere facing base', hint: 'The half of the planet the base looks at.' },
  { value: 'radius', label: 'Radius around base', hint: 'A circle of ground centred on the base.' },
];

export const ALTITUDE_MODES: { value: AltitudeMode; label: string; hint: string }[] = [
  { value: 'cheapest', label: 'CHEAPEST', hint: 'Lowest total cost for full coverage; mixed heights allowed (T52).' },
  { value: 'max-reach', label: 'MAX REACH', hint: 'Every relay at the altitude with the largest ground footprint (T52).' },
  { value: 'manual', label: 'MANUAL', hint: 'Your altitude, with the live ground reach shown next to it (T52).' },
];

export const DEFAULT_CONSTELLATION: Omit<ConstellationForm, 'planet' | 'hullId'> = {
  goal: 'cover',
  target: 'whole',
  targetRadiusM: 50_000,
  count: null,
  altitudeMode: 'cheapest',
  altitudeM: 18_500,
  redundancy: 1,
  pattern: 'ring',
  spacingM: 45_000,
  inclinationDeg: 30,
};

/**
 * CONTRACT §4 / designer schema: `count` is min(2) on the backend, so the UI
 * must never offer 1 as a valid constellation. One ship cannot form a link.
 */
export const MIN_CONSTELLATION_COUNT = 2;
export const MAX_CONSTELLATION_COUNT = 20;
export const MIN_CONSTELLATION_ALT = 100;
export const MAX_CONSTELLATION_ALT = 500_000;
export const MAX_MEMBERS_PER_EXECUTE = 20;
/** T51.9b: below this simulated coverage Apply stays disabled (without relay-only). */
export const MIN_APPLY_COVERAGE_PCT = 1;

export type ConstellationEvent =
  | { type: 'patch'; patch: Partial<ConstellationForm> }
  | { type: 'reset'; planet: string; hullId: string };

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

export function constellationReducer(state: ConstellationForm, event: ConstellationEvent): ConstellationForm {
  if (event.type === 'reset') {
    return { ...state, ...DEFAULT_CONSTELLATION, planet: event.planet, hullId: event.hullId };
  }
  const p = event.patch;
  const next = { ...state, ...p };
  // null is the AUTO count and must survive the clamp untouched.
  next.count =
    next.count === null || next.count === undefined
      ? null
      : Math.round(clamp(Number(next.count), MIN_CONSTELLATION_COUNT, MAX_CONSTELLATION_COUNT));
  next.altitudeM = Math.round(clamp(next.altitudeM, MIN_CONSTELLATION_ALT, MAX_CONSTELLATION_ALT));
  next.targetRadiusM = Math.round(clamp(next.targetRadiusM, 1_000, 2_000_000));
  next.spacingM = Math.round(clamp(next.spacingM, 1_000, 500_000));
  next.inclinationDeg = Math.round(clamp(next.inclinationDeg, 0, 89));
  return next;
}

/** Panel label -> backend constellation pattern. Arc is the planner's chain. */
export function backendPattern(pattern: ConstellationPattern): DesignerPattern {
  if (pattern === 'inclined') return 'inclined-rings';
  if (pattern === 'arc') return 'chain';
  return pattern;
}

export function patternLabel(pattern: ConstellationPattern): string {
  return CONSTELLATION_PATTERNS.find((p) => p.value === pattern)?.label ?? pattern;
}

export interface PlanetGeom {
  center: Vec3;
  surfaceRadiusM: number;
}

function fibonacciSphere(count: number): Vec3[] {
  const n = Math.max(1, count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return out;
}

/**
 * Ghost slot positions in metres, ordered deterministically. All slots sit at
 * the same altitude above the surface so the pattern stays readable.
 */
export function ghostSlots(
  planet: PlanetGeom,
  form: { count: number | null; altitudeM: number; pattern: ConstellationPattern; inclinationDeg: number },
): Vec3[] {
  const radius = planet.surfaceRadiusM + form.altitudeM;
  const dirs: Vec3[] = [];
  const n = Math.max(1, Math.round(form.count ?? 8));
  const at = (dir: Vec3): Vec3 => ({
    x: planet.center.x + dir.x * radius,
    y: planet.center.y + dir.y * radius,
    z: planet.center.z + dir.z * radius,
  });

  if (form.pattern === 'shell') return fibonacciSphere(n).map(at);

  if (form.pattern === 'arc') {
    // 140° arc centred on the planet's +X axis, equatorial plane.
    const span = (140 * Math.PI) / 180;
    for (let i = 0; i < n; i += 1) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = -span / 2 + span * t;
      dirs.push({ x: Math.cos(a), y: 0, z: Math.sin(a) });
    }
    return dirs.map(at);
  }

  if (form.pattern === 'inclined') {
    const inc = (form.inclinationDeg * Math.PI) / 180;
    const up = Math.ceil(n / 2);
    for (let i = 0; i < n; i += 1) {
      const tilt = i < up ? inc : -inc;
      const idx = i < up ? i : i - up;
      const perRing = i < up ? up : n - up;
      const a = (idx / Math.max(1, perRing)) * Math.PI * 2;
      const x = Math.cos(a);
      const z = Math.sin(a);
      dirs.push({ x, y: z * Math.sin(tilt), z: z * Math.cos(tilt) });
    }
    return dirs.map(at);
  }

  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    dirs.push({ x: Math.cos(a), y: 0, z: Math.sin(a) });
  }
  return dirs.map(at);
}

export interface Assignment {
  gridId: string;
  slotIndex: number;
  distanceM: number;
}

/**
 * Nearest-pair assignment, greedily from the shortest pair. Deterministic and
 * small (max 20 ships), so it settles the ghost preview immediately.
 */
export function assignToSlots(members: { id: string; position: Vec3 }[], slots: Vec3[]): Assignment[] {
  if (members.length === 0 || slots.length === 0) return [];
  const pairs: { mi: number; si: number; d: number }[] = [];
  for (let mi = 0; mi < members.length; mi += 1) {
    const p = members[mi]!.position;
    for (let si = 0; si < slots.length; si += 1) {
      const s = slots[si]!;
      pairs.push({ mi, si, d: Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) });
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.mi - b.mi || a.si - b.si);
  const usedM = new Set<number>();
  const usedS = new Set<number>();
  const out: Assignment[] = [];
  for (const pair of pairs) {
    if (usedM.has(pair.mi) || usedS.has(pair.si)) continue;
    usedM.add(pair.mi);
    usedS.add(pair.si);
    out.push({ gridId: members[pair.mi]!.id, slotIndex: pair.si, distanceM: pair.d });
  }
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

export interface FuelModel {
  /** planner-reported fuel for one transit of `pathM` */
  fuelPct: number;
  pathM: number;
}

export interface ConstellationCost {
  ships: number;
  moves: number;
  totalM: number;
  etaS: number | null;
  fuelPct: number | null;
  text: string;
}

export const COST_CRUISE_MPS = 100;
/** A ship already this close to its slot is counted as holding, not moving. */
export const COST_MOVE_THRESHOLD_M = 250;

function fmtKm(m: number): string {
  if (m >= 100_000) return `${Math.round(m / 1000)} km`;
  if (m >= 10_000) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** T51.9c: one member's planner estimate, or why it has none. */
export interface MemberEstimate {
  id: string;
  name: string;
  distanceM: number;
  etaS: number;
  h2L: number | null;
  batteryMWh: number | null;
  altitudeChangeM: number;
  reason: string;
}

export interface ConstellationEstimate {
  ships: number;
  moves: number;
  totalM: number;
  etaS: number;
  h2L: number;
  batteryMWh: number;
  /** Member names the planner could not price (never a blanket refusal). */
  unestimated: string[];
  text: string;
}

/**
 * T51.9c/d: the cost line is built from the PER-MEMBER planner estimates
 * (optimise moves carry fuel + altitude change), so one unpriced ship names
 * itself instead of blanking the whole line, and total movement is always
 * shown next to the coverage gain.
 */
export function estimateCost(
  estimates: MemberEstimate[],
  opts: { gainPct?: number | null; fromPct?: number | null; toPct?: number | null; speedMps?: number } = {},
): ConstellationEstimate {
  const speed = opts.speedMps ?? COST_CRUISE_MPS;
  const moves = estimates.filter((e) => e.distanceM > COST_MOVE_THRESHOLD_M);
  const totalM = moves.reduce((sum, e) => sum + e.distanceM, 0);
  const etaS = moves.reduce((max, e) => Math.max(max, Number.isFinite(e.etaS) && e.etaS > 0 ? e.etaS : e.distanceM / speed), 0);
  const priced = moves.filter((e) => e.h2L !== null || e.batteryMWh !== null);
  const unestimated = moves.filter((e) => e.h2L === null && e.batteryMWh === null).map((e) => e.name);
  const h2L = priced.reduce((sum, e) => sum + (e.h2L ?? 0), 0);
  const batteryMWh = priced.reduce((sum, e) => sum + (e.batteryMWh ?? 0), 0);
  const fuel =
    moves.length === 0
      ? null
      : priced.length === 0
        ? `fuel not modelled for ${unestimated.join(', ')}`
        : `${h2L > 0 ? `${h2L.toFixed(1)} L H2` : ''}${h2L > 0 && batteryMWh > 0 ? ' + ' : ''}` +
          `${batteryMWh > 0 ? `${batteryMWh.toFixed(2)} MWh` : ''}` +
          (h2L <= 0 && batteryMWh <= 0 ? 'no fuel (already at altitude)' : '') +
          (unestimated.length ? `; no estimate for ${unestimated.join(', ')}` : '');
  const gain =
    typeof opts.gainPct === 'number'
      ? `coverage ${fmtPct(opts.fromPct ?? null)} → ${fmtPct(opts.toPct ?? null)} (${opts.gainPct >= 0 ? '+' : ''}${opts.gainPct.toFixed(1)} pts)`
      : null;
  const parts = [
    `${moves.length} ${moves.length === 1 ? 'move' : 'moves'} · ${fmtKm(totalM)} total`,
    moves.length === 0 ? 'already in place' : `~${formatDuration(etaS)}`,
    fuel ?? 'no fuel needed',
    gain,
  ].filter((part): part is string => Boolean(part));
  return {
    ships: estimates.length,
    moves: moves.length,
    totalM,
    etaS,
    h2L: Math.round(h2L * 10) / 10,
    batteryMWh: Math.round(batteryMWh * 1000) / 1000,
    unestimated,
    text: parts.join(' · '),
  };
}

function fmtPct(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

/** T53: the request the cover-first solver understands, never a fixed ring. */
export interface CoverGoalPlanBody {
  mode: 'cover-planet';
  planet: string;
  hullId: string;
  rangeMargin: number;
  redundancy: Redundancy;
  altitudeMode: AltitudeMode;
  target: CoverTargetKind;
  targetRadiusM?: number;
  count?: number;
  altitudeM?: number;
  cellDeg?: number;
}

export interface PatternPlanBody {
  mode: 'constellation';
  planet: string;
  pattern: DesignerPattern;
  altitudeM: number;
  count: number;
  hullId: string;
  rangeMargin: number;
  redundancy: Redundancy;
}

export type ConstellationPlanBody = CoverGoalPlanBody | PatternPlanBody;

export function buildConstellationPlan(form: ConstellationForm): { body: ConstellationPlanBody | null; error: string | null } {
  if (!form.planet) return { body: null, error: 'Pick a planet first.' };
  if (!form.hullId) return { body: null, error: 'No hull matched this group yet.' };
  if (form.goal === 'pattern') {
    // Manual shape under Advanced: it still needs a number to ring.
    if (form.count === null || form.count < MIN_CONSTELLATION_COUNT) {
      return { body: null, error: `A manual ${patternLabel(form.pattern).toLowerCase()} needs at least ${MIN_CONSTELLATION_COUNT} ships.` };
    }
    return {
      body: {
        mode: 'constellation',
        planet: form.planet,
        pattern: backendPattern(form.pattern),
        altitudeM: form.altitudeM,
        count: form.count,
        hullId: form.hullId,
        rangeMargin: 0.9,
        redundancy: form.redundancy,
      },
      error: null,
    };
  }
  const body: CoverGoalPlanBody = {
    mode: 'cover-planet',
    planet: form.planet,
    hullId: form.hullId,
    rangeMargin: 0.9,
    redundancy: form.redundancy,
    altitudeMode: form.altitudeMode,
    target: form.target,
    cellDeg: 5,
  };
  if (form.target === 'radius') body.targetRadiusM = form.targetRadiusM;
  if (form.count !== null) body.count = form.count;
  if (form.altitudeMode === 'manual') body.altitudeM = form.altitudeM;
  return { body, error: null };
}

/**
 * T52 ground reach, identical to the backend's `groundFootprintRadiusM`:
 * the smaller of the radio limit (law of cosines) and the horizon. Pure so the
 * MANUAL readout and the Apply guard agree with the solver.
 */
export function groundReachM(surfaceRadiusM: number, altitudeM: number, rangeM: number): number {
  if (!(rangeM > 0) || !(surfaceRadiusM > 0)) return 0;
  const nodeRadius = surfaceRadiusM + Math.max(0, altitudeM);
  const cosRadio = (nodeRadius * nodeRadius + surfaceRadiusM * surfaceRadiusM - rangeM * rangeM) / (2 * nodeRadius * surfaceRadiusM);
  const radio = cosRadio >= 1 ? 0 : cosRadio <= -1 ? Math.PI : Math.acos(cosRadio);
  const horizon = Math.acos(Math.max(-1, Math.min(1, surfaceRadiusM / nodeRadius)));
  const phi = Math.min(radio, horizon);
  return phi > 0 ? surfaceRadiusM * phi : 0;
}

/** The one-sentence automatic decision, shown above the Apply button. */
export function constellationSentence(form: ConstellationForm, planetLabel: string, countNeeded?: number | null): string {
  if (form.goal === 'pattern') {
    const alt = form.altitudeM >= 10_000 ? `${Math.round(form.altitudeM / 1000)} km` : `${form.altitudeM} m`;
    const pattern = patternLabel(form.pattern).toLowerCase();
    return `Places ${form.count ?? 0} ${form.count === 1 ? 'ship' : 'ships'} in ${pattern} at ${alt} around ${planetLabel}, keeping the base link up.`;
  }
  const target = COVER_TARGETS.find((t) => t.value === form.target)?.label.toLowerCase() ?? 'the planet';
  const count = form.count === null ? 'as many relays as it needs' : `${form.count} relays`;
  const alt =
    form.altitudeMode === 'manual'
      ? `at ${form.altitudeM >= 10_000 ? `${(form.altitudeM / 1000).toFixed(1)} km` : `${form.altitudeM} m`} (manual)`
      : form.altitudeMode === 'max-reach'
        ? 'at the tallest-reach altitude'
        : 'at the cheapest altitudes that still cover';
  const needs = form.count === null && typeof countNeeded === 'number' ? `${countNeeded} relays needed` : count;
  return `Covers ${target} on ${planetLabel} with ${needs} ${alt}, ${form.redundancy === 2 ? 'two relays over every cell' : 'one relay over every cell'}.`;
}

export const CONSTELLATION_WHY =
  'The solver starts from the coverage grid, not a shape: it picks cells first, gives each slot its own altitude, and only adds a ship when it buys uncovered ground.';

/** Matches a member grid to an owner-tagged hull id (`tagged:grid:<id>`). */
export function matchHullId(memberIds: string[], hullIds: string[]): string | null {
  for (const id of memberIds) {
    const wanted = `tagged:grid:${id.replace(/^grid:/, '')}`;
    if (hullIds.includes(wanted)) return wanted;
  }
  return null;
}
