/**
 * T51/T60 operator screens: pure presentation helpers for the optimiser,
 * fleet operations, "send to" and the alert feed.
 *
 * Rules encoded here (owner preferences):
 * - one goal, one button per screen;
 * - unknown numbers are `null` and render as '—' with a reason, never as 0;
 * - coverage always carries its source (GAME when measured, SIMULATED when
 *   planner math) and terrain 'unavailable' is stated, never hidden;
 * - every refusal is a sentence about the failing invariant, not an error code.
 */
import type { DemoNode, DemoState, Planet, Vec3 } from '../types';
import type { OptimisePlan } from './optimise';

export function fmtMeters(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export function fmtMinutes(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function fmtLitres(l: number | null | undefined): string {
  if (l === null || l === undefined || !Number.isFinite(l)) return '—';
  return `${Math.round(l)} L`;
}

export function fmtPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

/** GAME when the backend measured it, SIMULATED when it is planner math. */
export function coverageSource(labels: string[] | null | undefined): 'GAME' | 'SIMULATED' | 'UNKNOWN' {
  const set = new Set((labels ?? []).map((l) => l.toUpperCase()));
  if (set.has('GAME')) return 'GAME';
  if (set.has('SIMULATED')) return 'SIMULATED';
  return 'UNKNOWN';
}

/** Visible terrain warning next to any coverage figure (T51.3). */
export function terrainNotice(coverage: { terrain: string; terrainReason?: string | null } | null | undefined): string | null {
  if (!coverage) return null;
  if (coverage.terrain === 'unavailable') {
    return `terrain unavailable — coverage is approximate (${coverage.terrainReason ?? 'no terrain tiles for this planet'})`;
  }
  if (coverage.terrain === 'none') return 'terrain not sampled — geometric coverage only';
  return null;
}

/** One line of cost, in words, for the optimiser panel. */
export function optimiseCostLine(plan: OptimisePlan | null): string {
  if (!plan) return 'No plan yet — press “Optimise my network”.';
  const ships = plan.moves.length;
  const cover = `${fmtPct(plan.coverageNow.pct)} → ${fmtPct(plan.coverageAfter.pct)}`;
  if (ships === 0) {
    return `Nothing to move: coverage already ${cover} of ${plan.planet.name}.`;
  }
  const parts = [`Move ${ships} ship${ships === 1 ? '' : 's'}`, `cover ${cover}`];
  const eta = plan.moves.reduce((best, m) => (best === null || m.etaS > best ? m.etaS : best), null as number | null);
  if (eta !== null) parts.push(`about ${fmtMinutes(eta)}`);
  const fuels = plan.moves.map((m) => m.fuel.h2L);
  const known = fuels.filter((f): f is number => typeof f === 'number' && Number.isFinite(f));
  if (known.length === fuels.length && known.length > 0) {
    parts.push(`${fmtLitres(known.reduce((a, b) => a + b, 0))} H2`);
  } else if (known.length > 0) {
    parts.push(`${fmtLitres(known.reduce((a, b) => a + b, 0))} H2 for ${known.length} of ${fuels.length} ships (rest unread)`);
  } else {
    parts.push('fuel unread for every ship');
  }
  if (plan.staying.length > 0) parts.push(`${plan.staying.length} stay put`);
  return `${parts.join(', ')}.`;
}

/** Per-move truth: from/to, distance, ETA, fuel, hold mode, transit coverage. */
export interface MoveLine {
  title: string;
  detail: string;
  transit: string;
  warn: boolean;
}

export function moveLine(move: OptimisePlan['moves'][number]): MoveLine {
  const fuel = move.fuel.h2L === null ? 'fuel unread' : `${fmtLitres(move.fuel.h2L)} H2`;
  const detail =
    `${fmtMeters(move.from.altitudeM)} → ${fmtMeters(move.to.altitudeM)}, ` +
    `${fmtMeters(move.distanceM)}, ${fmtMinutes(move.etaS)}, ${fuel}, then ${move.holdMode}`;
  const transit =
    move.substitution.uncoveredDuringTransit && move.substitution.uncoveredCellCount > 0
      ? `${move.substitution.uncoveredCellCount} cell(s) uncovered during transit`
      : 'its cells are covered by other ships while it flies';
  return {
    title: `${move.name} (${move.reason})`,
    detail,
    transit,
    warn: move.substitution.uncoveredDuringTransit && move.substitution.uncoveredCellCount > 0,
  };
}

/** Plain words for why the Apply button is off (T51.6). */
export function optimiseApplyGate(
  plan: OptimisePlan | null,
  selectedIds: string[],
): { enabled: boolean; reason: string } {
  if (!plan) return { enabled: false, reason: 'Plan first — nothing has been proposed yet.' };
  if (plan.moves.length === 0) return { enabled: false, reason: 'The plan moves no ships, so there is nothing to apply.' };
  if (!plan.executable) return { enabled: false, reason: 'The backend marked this plan not executable (see its limitations).' };
  const moving = new Set(plan.moves.map((m) => m.gridId));
  if (!selectedIds.some((id) => moving.has(id))) {
    return { enabled: false, reason: 'Select the ships this plan moves (or their group) before applying.' };
  }
  return { enabled: true, reason: `${plan.moves.length} ship(s) will move to the proposed slots.` };
}

/* ------------------------------------------------------------------ alerts */

export interface OpsAlertAction {
  label: string;
  endpoint: string;
  method: string;
  body?: Record<string, unknown>;
}

export interface OpsAlert {
  id: string;
  kind: string;
  severity: 'info' | 'warn' | 'critical' | string;
  subjectType: string;
  subjectId: string;
  message: string;
  evidence: Record<string, unknown>;
  actions: OpsAlertAction[];
  state: 'open' | 'acked' | 'resolved' | string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  ackedBy: string | null;
}

export interface AlertsResponse {
  enabled: boolean;
  reason?: string;
  now?: number;
  alerts: OpsAlert[];
  counts: { open: number; acked: number; critical: number };
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warn: 'Warning',
  info: 'Info',
};

export function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? 'Unknown severity';
}

/** Evidence → one plain sentence. Unknown stays unknown. */
export function alertReason(alert: OpsAlert): string {
  const e = alert.evidence ?? {};
  const num = (key: string): number | null => {
    const v = e[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const pct = num('coveragePct') ?? num('pct');
  const cells = num('uncoveredCells');
  if (pct !== null) {
    return cells !== null
      ? `Coverage is ${fmtPct(pct)} with ${cells} cell(s) not heard by any relay.`
      : `Coverage is ${fmtPct(pct)} of the target.`;
  }
  const runway = num('runwayMin');
  if (runway !== null) return `About ${fmtMinutes(runway * 60)} of power or fuel left at the current draw.`;
  const fuel = num('fuelPct');
  if (fuel !== null) return `The tank reads ${fmtPct(fuel)}.`;
  const age = num('ageMs');
  if (age !== null) return `Newest telemetry is ${fmtMinutes(age / 1000)} old.`;
  return alert.message;
}

/** Concrete fix hint: the backend's own action label, else a stated fallback. */
export function alertFix(alert: OpsAlert): string {
  const action = alert.actions?.[0];
  if (action?.label) return action.label;
  if (alert.kind === 'coverage-hole' || alert.kind === 'coverage-drop') return 'Plan a coverage fix in the optimiser.';
  if (alert.kind === 'grid-lost' || alert.kind === 'telemetry-stale') return 'Check the grid in game, then acknowledge.';
  if (alert.kind === 'needs-refuel' || alert.kind === 'energy-runway') return 'Recall the ship or send it a refuel run.';
  return 'No one-click fix is known — open the ship and inspect it.';
}

/** Which tab (if any) fixes this alert from the site. */
export function alertFixTab(alert: OpsAlert): OpsTab | null {
  if (alert.kind === 'coverage-hole' || alert.kind === 'coverage-drop') return 'optimise';
  if (alert.kind === 'grid-isolated' || alert.kind === 'grid-under-control') return 'send';
  if (alert.kind === 'needs-refuel' || alert.kind === 'energy-runway') return 'send';
  return null;
}

export function alertsHeadline(response: AlertsResponse | null): string {
  if (!response) return 'Loading alerts…';
  if (!response.enabled) return 'Alerts engine is off — no alert can be shown.';
  if (response.alerts.length === 0) return 'No open alerts. Every grid is reporting.';
  const critical = response.alerts.filter((a) => a.severity === 'critical').length;
  const warn = response.alerts.filter((a) => a.severity === 'warn').length;
  const info = response.alerts.filter((a) => a.severity === 'info').length;
  const parts = [`${response.alerts.length} open alert${response.alerts.length === 1 ? '' : 's'}`];
  if (critical) parts.push(`${critical} critical`);
  if (warn) parts.push(`${warn} warning`);
  if (info) parts.push(`${info} info`);
  return `${parts.join(' · ')}.`;
}

/* --------------------------------------------------------------- send-to */

export type OpsTab = 'alerts' | 'optimise' | 'send' | 'fleet';

export interface Destination {
  id: string;
  label: string;
  kind: 'planet' | 'base' | 'ship' | 'gps';
  target: { planet: string; altitudeM: number } | { gps: Vec3 } | string;
  note: string;
}

/**
 * Named destinations, never a pixel guess (T60.1). Altitudes are the
 * documented move-to forms; surface/low/zero-g are honest about being shells.
 */
export function destinations(state: DemoState | null, bases: { name: string; position: Vec3 }[] = []): Destination[] {
  const out: Destination[] = [];
  for (const planet of state?.planets ?? []) {
    out.push({
      id: `planet:${planet.name}:surface`,
      label: `${planet.name} — surface (low hover, 2 km)`,
      kind: 'planet',
      target: { planet: planet.name, altitudeM: 2000 },
      note: 'Low hover above the ground track; the final landing spot is chosen by the ship.',
    });
    out.push({
      id: `planet:${planet.name}:maxreach`,
      label: `${planet.name} — max-reach altitude (35 km)`,
      kind: 'planet',
      target: { planet: planet.name, altitudeM: 35000 },
      note: 'Highest altitude where a 50 km radio still reaches the ground.',
    });
    out.push({
      id: `planet:${planet.name}:zerog`,
      label: `${planet.name} — zero-g above (60 km)`,
      kind: 'planet',
      target: { planet: planet.name, altitudeM: 60000 },
      note: 'Gravity-free shelf: no hover thrust needed.',
    });
  }
  for (const base of bases) {
    out.push({
      id: `base:${base.name}`,
      label: `${base.name} (base)`,
      kind: 'base',
      target: { gps: base.position },
      note: 'Exact base position from provisioning.',
    });
  }
  for (const node of state?.nodes ?? []) {
    if (node.status !== 'alive') continue;
    out.push({
      id: `ship:${node.id}`,
      label: `${node.name} (ship)`,
      kind: 'ship',
      target: { gps: node.position },
      note: 'Its live position; a moving target is not re-followed by this order.',
    });
  }
  return out;
}

/** Parse an SE GPS string: `GPS:name:x:y:z:#colour`. */
export function parseGps(text: string): Vec3 | null {
  const parts = text.trim().split(':');
  if (parts.length < 5) return null;
  if (parts[0]?.toUpperCase() !== 'GPS') return null;
  const [x, y, z] = [parts[2], parts[3], parts[4]].map((v) => Number(v));
  if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { x: x as number, y: y as number, z: z as number };
}

export interface PreflightLines {
  distance: string;
  eta: string;
  fuel: string;
  link: string;
  refusal: string | null;
  ok: boolean;
}

/** The one plain-language preflight the Approve button shows (T60.3). */
export function preflightLines(preflight: {
  ok?: boolean;
  summary?: string;
  linkText?: string;
  fuelText?: string;
  etaText?: string;
  distanceM?: number | null;
  etaS?: number | null;
  block?: { code?: string; message?: string; hint?: string } | null;
  warnings?: string[];
} | null | undefined): PreflightLines {
  if (!preflight) {
    return { distance: '—', eta: '—', fuel: '—', link: '—', refusal: 'No preflight yet.', ok: false };
  }
  const refusal = preflight.ok === false
    ? [preflight.block?.message ?? preflight.summary ?? 'The backend refused this destination.', preflight.block?.hint]
        .filter(Boolean)
        .join(' ')
    : null;
  return {
    distance: preflight.distanceM === null || preflight.distanceM === undefined ? '—' : fmtMeters(preflight.distanceM),
    eta: preflight.etaS === null || preflight.etaS === undefined ? '—' : fmtMinutes(preflight.etaS),
    fuel: preflight.fuelText ?? 'fuel unread',
    link: preflight.linkText ?? 'link path unknown',
    refusal,
    ok: preflight.ok !== false,
  };
}

/* ------------------------------------------------------------- fleet ops */

export type FleetOpKind = 'swap' | 'recall' | 'reshape' | 'relocate' | 'scuttle';

export interface FleetStep2 {
  id: string;
  wave: number;
  memberId: string;
  action: string;
  target: Vec3 | null;
  status: string;
  reason?: string;
}

export interface FleetMemberPlan2 {
  gridId: string;
  home: Vec3 | null;
  verdict: 'ok' | 'skipped';
  reason?: string;
  distanceM?: number;
  fuelFraction?: number | null;
}

export interface FleetOperation2 {
  id: string;
  kind: FleetOpKind;
  planetId: string | null;
  members: string[];
  steps: FleetStep2[];
  status: string;
  dryRun: boolean;
  coverageBefore: { coveragePct: number; terrain: string; terrainReason?: string | null; totalCells: number } | null;
  coverageAfter: { coveragePct: number; terrain: string; terrainReason?: string | null; totalCells: number } | null;
  invariants: {
    ok: boolean;
    members: FleetMemberPlan2[];
    failures: { invariant: string; memberId?: string; reason: string; severity?: string }[];
    notes: string[];
  };
  abortPolicy: string;
  lastError: string | null;
}

/** Execute is disabled with the backend's own reason while the flag is off. */
export function fleetExecuteGate(
  flags: Record<string, boolean> | null | undefined,
  operation: FleetOperation2 | null,
): { enabled: boolean; reason: string } {
  if (!operation) return { enabled: false, reason: 'Plan the operation first — nothing has been proposed.' };
  if (flags?.fleet_ops_execute !== true) {
    return {
      enabled: false,
      reason: 'Execution is switched off on the server (flag fleet_ops_execute). The plan can be reviewed but not flown.',
    };
  }
  if (operation.status !== 'awaiting_approval') {
    return { enabled: false, reason: `This operation is ${operation.status.replace(/_/g, ' ')}; nothing is awaiting approval.` };
  }
  const hard = operation.invariants.failures.filter((f) => f.severity !== 'member');
  if (hard.length > 0) return { enabled: false, reason: `It would break ${hard[0]!.invariant}: ${hard[0]!.reason}` };
  return { enabled: true, reason: 'Every member passed the invariants; approve to let the executor fly it.' };
}

export interface FleetShipLine {
  name: string;
  will: string;
  warn: boolean;
}

/** What each ship will do, one line per member (T51 "show what each ship will do"). */
export function fleetShipLines(operation: FleetOperation2 | null, names: Record<string, string>): FleetShipLine[] {
  if (!operation) return [];
  const byGrid = new Map<string, FleetStep2[]>();
  for (const step of operation.steps) {
    const list = byGrid.get(step.memberId) ?? [];
    list.push(step);
    byGrid.set(step.memberId, list);
  }
  const plans = new Map(operation.invariants.members.map((m) => [m.gridId, m]));
  return operation.members.map((gridId) => {
    const name = names[gridId] ?? gridId;
    const plan = plans.get(gridId);
    const steps = (byGrid.get(gridId) ?? []).sort((a, b) => a.wave - b.wave);
    if (plan?.verdict === 'skipped') {
      return { name, will: `stays put — ${plan.reason ?? 'skipped by the planner'}`, warn: true };
    }
    if (steps.length === 0) return { name, will: 'no step in this plan', warn: true };
    const verbs = steps.map((s) => {
      if (s.action === 'hold' || s.action === 'station') return 'hold position';
      if (s.action === 'return') return 'fly home';
      if (s.action === 'relocate' || s.action === 'swap') return 'fly to its new slot';
      if (s.action === 'scuttle') return 'be scuttled';
      return s.action;
    });
    const distance = plan?.distanceM ? ` over ${fmtMeters(plan.distanceM)}` : '';
    return { name, will: `${verbs.join(', then ')}${distance}`, warn: false };
  });
}

export function fleetCoverageLine(operation: FleetOperation2 | null): string {
  if (!operation) return 'No coverage figure — nothing planned yet.';
  const before = operation.coverageBefore;
  const after = operation.coverageAfter;
  if (!before && !after) return 'Coverage before/after was not computed for this kind of operation.';
  const fmt = (c: { coveragePct: number } | null) => (c ? fmtPct(c.coveragePct) : '—');
  const terrain = terrainNotice(after ?? before);
  return `Coverage ${fmt(before)} → ${fmt(after)}${terrain ? ` (${terrain})` : ''}.`;
}

/* --------------------------------------------------------------- survival */

/** Reads a `survivalMode` boolean from /api/health or /api/demo/state. */
export function survivalBadge(value: unknown): { text: string; survival: boolean } | null {
  if (typeof value !== 'boolean') return null;
  return value ? { text: 'SURVIVAL MODE', survival: true } : { text: 'TEST WORLD', survival: false };
}

/** Defensive read: the field is being added by another job; absent = nothing. */
export function readSurvivalMode(health: unknown, state: unknown): boolean | null {
  const fromObject = (v: unknown): boolean | null => {
    if (!v || typeof v !== 'object') return null;
    const raw = (v as { survivalMode?: unknown }).survivalMode;
    return typeof raw === 'boolean' ? raw : null;
  };
  return fromObject(health) ?? fromObject(state) ?? null;
}

export function nodeName(nodes: DemoNode[], id: string): string {
  return nodes.find((n) => n.id === id)?.name ?? id;
}
