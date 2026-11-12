/**
 * T21 fleet monitor: pure row-building, sorting, filtering, alert and CSV
 * helpers. No React, no three.js — everything here is unit tested and the
 * panel stays a thin renderer.
 *
 * Telemetry is feature-detected: the plugin power/inventory fields (T20) may
 * not exist yet, so a value that the backend does not send reads as `null`
 * and the UI shows "—" instead of inventing a number.
 */
import type { DemoNode, DemoState, NamingGrid, NodeTelemetry, Planet, Vec3 } from '../types';
import { nearestPlanet } from './sceneMath';

export type FleetState = 'station' | 'ship' | 'holding' | 'en-route' | 'needs-fuel' | 'failed' | 'manual';
export type FleetRole = 'R' | 'L' | 'M' | 'H';
export type ChargeState = 'charging' | 'draining' | 'idle' | 'unknown';

/** Altitude that counts as gravity-free on a planet with an atmosphere. */
export const ZERO_G_ALT_M = 43_700;
/** Below this H2 fill a ship is reported as needing fuel. */
export const FUEL_ALERT_PCT = 20;
/** Battery fill that raises a low-power alert while draining. */
export const LOW_POWER_PCT = 25;
/** Solar output below this share of installed capacity is a pointing hint. */
export const LOW_SOLAR_PCT = 25;

export interface PowerReading {
  batteryPct: number | null;
  batteryState: 'read' | 'unread' | 'absent' | 'unknown';
  batteryUnreadReason: string | null;
  batteryStoredMWh: number | null;
  batteryMaxMWh: number | null;
  charge: ChargeState;
  netMw: number | null;
  /** Measured breakdown behind netMw (plugin `power` block). */
  generationMw: number | null;
  consumerDrawMw: number | null;
  batteryChargeMw: number | null;
  solarActualMw: number | null;
  solarMaxMw: number | null;
  solarPct: number | null;
  h2Pct: number | null;
  /**
   * Why H2 may have no number: `unread` (plugin could not read it) or
   * `absent` (no hydrogen tank). Both render as "—" with a reason and never
   * raise a fuel alert — an unread tank is not an empty tank.
   */
  h2State: 'read' | 'unread' | 'absent' | 'unknown';
  h2UnreadReason: string | null;
  h2Litres: number | null;
  uraniumKg: number | null;
  uraniumCapacityKg: number | null;
  uraniumPct: number | null;
  /** Optional runways the backend may compute itself, minutes. */
  powerRunwayMin: number | null;
  fuelRunwayMin: number | null;
  uraniumRunwayMin: number | null;
  /** Backend-provided overall runway (wins over derived values), minutes. */
  runwayMin: number | null;
  /** Human labels for the values the backend did not send. */
  missing: string[];
}

export interface ExpectedLife {
  kind: 'no-limit' | 'unknown' | 'minutes';
  minutes: number | null;
}

export interface FleetRow {
  id: string;
  name: string;
  role: FleetRole | null;
  roleLabel: string;
  state: FleetState;
  planet: string | null;
  altitudeM: number | null;
  position: Vec3;
  speedMps: number;
  links: number;
  linkNames: string[];
  linkKinds: { radio: number; laser: number };
  radioRangeM: number | null;
  laserPortsUsed: number;
  laserPortsFree: number;
  laserPortsCapacity: number;
  power: PowerReading;
  batteryPct: number | null;
  charge: ChargeState;
  solarPct: number | null;
  h2Pct: number | null;
  uraniumPct: number | null;
  expectedLife: ExpectedLife;
  lastContactAgeMs: number | null;
  integrityPct: number | null;
  reachable: boolean;
  stale: boolean;
  isStation: boolean;
  zeroG: boolean;
  source: 'GAME' | 'SIMULATED';
}

export type AlertKind = 'needs-fuel' | 'low-power' | 'link-lost' | 'drifting' | 'stale';
export type AlertSeverity = 'bad' | 'warn';

export interface FleetAlert {
  id: string;
  nodeId: string;
  name: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  why: string;
  action: string;
}

export type SortKey =
  | 'name'
  | 'role'
  | 'state'
  | 'planet'
  | 'altitude'
  | 'links'
  | 'radio'
  | 'laser'
  | 'battery'
  | 'solar'
  | 'h2'
  | 'uranium'
  | 'life'
  | 'age'
  | 'integrity';

export interface FleetFilter {
  roles: FleetRole[];
  states: FleetState[];
  /** drop rows whose H2 fill is at or above this percentage */
  maxFuelPct: number | null;
  query: string;
}

export const EMPTY_FILTER: FleetFilter = { roles: [], states: [], maxFuelPct: null, query: '' };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read a nested field without trusting its shape. */
function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function firstNumber(obj: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const v = num(pick(obj, path));
    if (v !== null) return v;
  }
  return null;
}

function firstString(obj: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const v = pick(obj, path);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Normalise the T20 power block. Every accepted spelling is a field the
 * backend/plugin may plausibly send; absence stays `null`.
 */
export function readPower(node: DemoNode): PowerReading {
  const t: Partial<NodeTelemetry> & Record<string, unknown> = (node.telemetry ?? {}) as never;
  const missing: string[] = [];

  const batteryPct = firstNumber(t, [
    ['batteryPct'],
    ['power', 'battery', 'pct'],
    ['power', 'batteryPct'],
    ['battery', 'pct'],
  ]) ?? (firstNumber(t, [['powerFraction']]) !== null ? firstNumber(t, [['powerFraction']])! * 100 : null);

  const batteryStoredMWh = firstNumber(t, [
    ['batteryStoredMWh'],
    ['power', 'battery', 'storedMWh'],
    ['power', 'batteryStoredMWh'],
    ['battery', 'storedMWh'],
  ]);
  const batteryMaxMWh = firstNumber(t, [
    ['batteryMaxMWh'],
    ['power', 'battery', 'capacityMWh'],
    ['power', 'batteryMaxMWh'],
    ['battery', 'capacityMWh'],
  ]);

  const netMw = firstNumber(t, [['netMw'], ['power', 'netMw'], ['power', 'net']]);
  // The measured breakdown (plugin `power` block, forwarded by the backend).
  const generationMw = firstNumber(t, [['generationMw'], ['power', 'breakdown', 'generationMw'], ['power', 'generationMw']]);
  const consumerDrawMw = firstNumber(t, [['consumerDrawMw'], ['power', 'breakdown', 'consumerDrawMw'], ['power', 'consumerDrawMw']]);
  const batteryChargeMw = firstNumber(t, [['batteryChargeMw'], ['power', 'breakdown', 'batteryChargeMw'], ['power', 'batteryChargeMw']]);
  const explicitCharge = firstString(t, [['chargeState'], ['power', 'charge'], ['batteryState']]);
  let charge: ChargeState = 'unknown';
  if (explicitCharge) {
    const lower = explicitCharge.toLowerCase();
    if (lower.includes('charg') && !lower.includes('dis')) charge = 'charging';
    else if (lower.includes('discharg') || lower.includes('drain')) charge = 'draining';
    else if (lower.includes('idle') || lower.includes('stand')) charge = 'idle';
  } else {
    const inputMw = firstNumber(t, [['currentInputMw'], ['power', 'currentInputMw'], ['power', 'inputMw']]);
    const outputMw = firstNumber(t, [['currentOutputMw'], ['power', 'currentOutputMw'], ['power', 'outputMw']]);
    if (inputMw !== null && inputMw > 0.0001 && (outputMw === null || inputMw > outputMw)) charge = 'charging';
    else if (outputMw !== null && outputMw > 0.0001) charge = 'draining';
    else if (netMw !== null) charge = netMw > 0.0001 ? 'charging' : netMw < -0.0001 ? 'draining' : 'idle';
  }

  const solarActualMw = firstNumber(t, [
    ['solarOutputMw'],
    ['solarActualMw'],
    ['power', 'solar', 'actualMw'],
    ['power', 'solarOutputMw'],
  ]);
  const solarMaxMw = firstNumber(t, [
    ['solarMaxMw'],
    ['power', 'solar', 'maxMw'],
    ['power', 'solarMaxMw'],
  ]);
  const solarPct = solarActualMw !== null && solarMaxMw !== null && solarMaxMw > 0
    ? clampPct((solarActualMw / solarMaxMw) * 100)
    : null;

  const h2Pct = firstNumber(t, [
    ['h2Pct'],
    ['power', 'h2', 'pct'],
    ['h2', 'pct'],
    ['hydrogenPct'],
  ]) ?? (firstNumber(t, [['fuelFraction']]) !== null ? firstNumber(t, [['fuelFraction']])! * 100 : null);
  const h2Litres = firstNumber(t, [['h2Litres'], ['power', 'h2', 'litres'], ['h2', 'litres']]);
  const h2StateRaw = firstString(t, [['h2State'], ['power', 'h2', 'state'], ['fuel', 'readState']]);
  let h2State: PowerReading['h2State'] =
    h2StateRaw === 'read' || h2StateRaw === 'unread' || h2StateRaw === 'absent'
      ? h2StateRaw
      : h2Pct !== null
        ? 'read'
        : 'unknown';
  const h2UnreadReason = firstString(t, [['h2UnreadReason'], ['power', 'h2', 'unreadReason']])
    ?? (h2State === 'absent' ? 'no hydrogen tank on this grid' : null);
  // A numeric state with no number is a failed read, not a zero.
  if (h2State === 'read' && h2Pct === null) h2State = 'unread';

  const batteryStateRaw = firstString(t, [['batteryState'], ['power', 'battery', 'state']]);
  let batteryState: PowerReading['batteryState'] =
    batteryStateRaw === 'read' || batteryStateRaw === 'unread' || batteryStateRaw === 'absent'
      ? batteryStateRaw
      : batteryPct !== null
        ? 'read'
        : 'unknown';
  if (batteryState === 'read' && batteryPct === null) batteryState = 'unread';
  const batteryUnreadReason = firstString(t, [['batteryUnreadReason'], ['power', 'battery', 'unreadReason']])
    ?? (batteryState === 'absent' ? 'no battery on this grid' : null);

  let uraniumKg = firstNumber(t, [
    ['uraniumKg'],
    ['power', 'reactor', 'uraniumKg'],
    ['reactor', 'uraniumKg'],
  ]);
  let uraniumCapacityKg = firstNumber(t, [
    ['uraniumCapacityKg'],
    ['power', 'reactor', 'capacityKg'],
    ['reactor', 'capacityKg'],
  ]);
  // Sum per-reactor / per-tank arrays only when the backend sends them.
  const reactorList = pick(t, ['power', 'reactors']);
  if (Array.isArray(reactorList) && reactorList.length > 0) {
    let kg = 0;
    let cap = 0;
    let ok = true;
    for (const r of reactorList) {
      const rk = num(pick(r, ['uraniumKg']));
      const rc = num(pick(r, ['capacityKg']));
      if (rk === null) ok = false;
      else kg += rk;
      if (rc === null) cap = 0;
      else cap += rc;
    }
    if (ok && uraniumKg === null) uraniumKg = kg;
    if (cap > 0 && uraniumCapacityKg === null) uraniumCapacityKg = cap;
  }
  let uraniumPct = firstNumber(t, [['uraniumPct'], ['power', 'reactor', 'pct'], ['reactor', 'pct']]);
  if (uraniumPct === null && uraniumKg !== null && uraniumCapacityKg !== null && uraniumCapacityKg > 0) {
    uraniumPct = clampPct((uraniumKg / uraniumCapacityKg) * 100);
  }

  const powerRunwayMin = firstNumber(t, [['powerRunwayMin'], ['runway', 'powerMin']]);
  const fuelRunwayMin = firstNumber(t, [['fuelRunwayMin'], ['h2RunwayMin'], ['runway', 'fuelMin']]);
  const uraniumRunwayMin = firstNumber(t, [['uraniumRunwayMin'], ['runway', 'uraniumMin']]);
  const runwayMin = firstNumber(t, [['runwayMin'], ['runway', 'min']]);

  if (batteryPct === null) missing.push('battery');
  if (solarPct === null) missing.push('solar');
  if (h2Pct === null) missing.push('H2');
  if (uraniumPct === null) missing.push('uranium');
  if (charge === 'unknown') missing.push('charge state');

  return {
    batteryPct,
    batteryState,
    batteryUnreadReason,
    batteryStoredMWh,
    batteryMaxMWh,
    charge,
    netMw,
    generationMw,
    consumerDrawMw,
    batteryChargeMw,
    solarActualMw,
    solarMaxMw,
    solarPct,
    h2Pct,
    h2State,
    h2UnreadReason,
    h2Litres,
    uraniumKg,
    uraniumCapacityKg,
    uraniumPct,
    powerRunwayMin,
    fuelRunwayMin,
    uraniumRunwayMin,
    runwayMin,
    missing,
  };
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Integrity as a percentage; `health` is a 0..1 fraction, `integrityPct` already a percent. */
export function integrityPct(telemetry: unknown): number | null {
  const pct = firstNumber(telemetry, [['integrityPct'], ['integrity']]);
  if (pct !== null) return clampPct(pct);
  const health = firstNumber(telemetry, [['health']]);
  if (health === null) return null;
  return clampPct(health <= 1 ? health * 100 : health);
}

/** Minutes of battery left at a constant net draw (negative net = draining). */
export function powerRunwayMinutes(storedMWh: number | null, netMw: number | null): number | null {
  if (storedMWh === null || netMw === null) return null;
  if (storedMWh < 0 || netMw >= -1e-6) return null;
  return (storedMWh / -netMw) * 60;
}

/** Minutes of fuel left from a fill and a burn rate in %/hour. */
export function fuelRunwayMinutes(h2Pct: number | null, burnPctPerHour: number | null): number | null {
  if (h2Pct === null || burnPctPerHour === null || burnPctPerHour <= 0) return null;
  return (h2Pct / burnPctPerHour) * 60;
}

/** Minutes of reactor fuel left from kilograms and kg/hour (or MWh and MW). */
export function stockRunwayMinutes(remaining: number | null, perHour: number | null): number | null {
  if (remaining === null || perHour === null || perHour <= 0) return null;
  return (remaining / perHour) * 60;
}

/**
 * Expected life = the smallest known runway. A station or a zero-g hold needs
 * no hover thrust, so its expected life is "no limit" even when the battery is
 * slowly cycling. Without any runway data the answer is "unknown", never 0.
 */
export function expectedLife(
  args: {
    isStation: boolean;
    zeroG: boolean;
    runways: (number | null)[];
    provided: number | null;
  },
): ExpectedLife {
  if (args.isStation || args.zeroG) return { kind: 'no-limit', minutes: null };
  const values = args.runways.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  if (args.provided !== null && Number.isFinite(args.provided) && args.provided >= 0) values.push(args.provided);
  if (values.length === 0) return { kind: 'unknown', minutes: null };
  return { kind: 'minutes', minutes: Math.min(...values) };
}

export function roleFromNaming(grid: NamingGrid | undefined): FleetRole | null {
  const cls = (grid?.cls ?? '').trim().toUpperCase();
  if (cls === 'R' || cls === 'L' || cls === 'M' || cls === 'H') return cls;
  // A name is the fallback when the naming payload predates `cls`.
  const m = /^SAT-([RLMH])-/.exec(grid?.name ?? '');
  return m ? (m[1] as FleetRole) : null;
}

const ROLE_LABEL: Record<FleetRole, string> = {
  R: 'R · radio relay',
  L: 'L · laser relay',
  M: 'M · mixed (radio + 1 laser)',
  H: 'H · laser hub (3+)',
};

export function planetFor(pos: Vec3, planets: Planet[]): { planet: string; altitudeM: number } | null {
  const near = nearestPlanet(
    pos,
    planets.map((p) => ({ id: p.id, name: p.name, pos: p.center, radius: p.surfaceRadiusM })),
  );
  if (!near) return null;
  return { planet: near.planet.name, altitudeM: near.altitude };
}

interface ExecutionIndex {
  byGrid: Map<string, { state: string; missionId: string }>;
}

function indexExecutions(state: DemoState): ExecutionIndex {
  const byGrid = new Map<string, { state: string; missionId: string }>();
  for (const exec of state.executions?.executions ?? []) {
    for (const d of exec.drones) {
      if (!d.gridId) continue;
      const prev = byGrid.get(d.gridId);
      // A failed row wins over an earlier holding row from another mission.
      if (!prev || d.state === 'failed' || prev.state !== 'failed') {
        byGrid.set(d.gridId, { state: d.state, missionId: exec.missionId });
      }
    }
  }
  return { byGrid };
}

function deriveState(
  node: DemoNode,
  exec: { state: string } | undefined,
  power: PowerReading,
  isStation: boolean,
): FleetState {
  if (exec?.state === 'failed') return 'failed';
  const tele = node.telemetry as unknown as Record<string, unknown> | null;
  const manual = tele?.underControl === true || tele?.manualControl === true || tele?.piloted === true;
  if (manual) return 'manual';
  // Only a *read* value can prove low fuel. An unread tank must not become
  // "0 %" and must not raise needs-fuel.
  if (power.h2State === 'read' && power.h2Pct !== null && power.h2Pct < FUEL_ALERT_PCT && !isStation) return 'needs-fuel';
  if (isStation) return 'station';
  if (exec?.state === 'en_route' || exec?.state === 'spawning' || exec?.state === 'securing') return 'en-route';
  if (exec?.state === 'holding') return 'holding';
  if (node.telemetry?.moving && node.telemetry.speedMps > 1) return 'en-route';
  return 'ship';
}

export function buildFleetRows(
  state: DemoState,
  nodes: DemoNode[],
  naming: NamingGrid[],
): FleetRow[] {
  const namingById = new Map(naming.map((g) => [g.gridId, g]));
  const names = new Map(naming.map((g) => [g.gridId, g.name]));
  const execs = indexExecutions(state);
  const now = state.now;
  const rows: FleetRow[] = [];

  for (const node of nodes) {
    const power = readPower(node);
    const cap = node.capability;
    const telemetry = node.telemetry ?? null;
    const located = planetFor(node.position, state.planets);
    const isStation = (node.telemetry as unknown as Record<string, unknown> | null)?.isStatic === true
      || cap?.isStatic === true;
    const planet = located?.planet ?? node.planet ?? null;
    const altitudeM = located?.altitudeM ?? null;
    const planetMeta = state.planets.find((p) => p.name === planet) ?? null;
    const zeroG = Boolean(planetMeta?.hasAtmosphere) && altitudeM !== null && altitudeM >= ZERO_G_ALT_M;

    const laserLinks = node.links.filter((l) => l.kind === 'laser');
    const radioLinks = node.links.filter((l) => l.kind === 'radio');
    const capacity = cap?.laserPorts ?? node.ports?.capacity ?? 0;
    const used = Math.max(laserLinks.length, node.ports?.used ?? 0);
    const linkNames = node.links
      .map((l) => names.get(l.to) ?? state.nodes.find((n) => n.id === l.to)?.name ?? l.to)
      .sort((a, b) => a.localeCompare(b));

    const h2Burn = firstNumber(node.telemetry as never, [['h2PctPerHour'], ['power', 'h2', 'pctPerHour']]);
    const uraniumBurn = firstNumber(node.telemetry as never, [
      ['uraniumKgPerHour'],
      ['power', 'reactor', 'kgPerHour'],
    ]);
    const derivedPower = powerRunwayMinutes(
      power.batteryStoredMWh ?? (power.batteryPct !== null && power.batteryMaxMWh !== null
        ? (power.batteryPct / 100) * power.batteryMaxMWh
        : null),
      power.netMw,
    );
    const derivedFuel = fuelRunwayMinutes(power.h2Pct, h2Burn);
    const derivedUranium = stockRunwayMinutes(power.uraniumKg, uraniumBurn);
    const life = expectedLife({
      isStation,
      zeroG,
      runways: [
        power.powerRunwayMin ?? derivedPower,
        power.fuelRunwayMin ?? derivedFuel,
        power.uraniumRunwayMin ?? derivedUranium,
      ],
      provided: power.runwayMin,
    });

    const role = roleFromNaming(namingById.get(node.id));
    const stateName = deriveState(node, execs.byGrid.get(node.id), power, isStation);
    const ageMs = telemetry ? Math.max(0, now - telemetry.lastSeen) : null;

    rows.push({
      id: node.id,
      name: names.get(node.id) ?? node.name,
      role,
      roleLabel: role ? ROLE_LABEL[role] : 'no role tag',
      state: stateName,
      planet,
      altitudeM,
      position: node.position,
      speedMps: telemetry?.speedMps ?? 0,
      links: node.links.length,
      linkNames,
      linkKinds: { radio: radioLinks.length, laser: laserLinks.length },
      radioRangeM: cap?.radioRadiusM ?? null,
      laserPortsUsed: used,
      laserPortsFree: Math.max(0, capacity - used),
      laserPortsCapacity: capacity,
      power,
      batteryPct: power.batteryPct,
      charge: power.charge,
      solarPct: power.solarPct,
      h2Pct: power.h2Pct,
      uraniumPct: power.uraniumPct,
      expectedLife: life,
      lastContactAgeMs: ageMs,
      integrityPct: integrityPct(node.telemetry as never),
      reachable: node.reachable,
      stale: ageMs === null || ageMs > 60_000,
      isStation,
      zeroG,
      source: node.source,
    });
  }
  return rows;
}

export function alertsFor(rows: FleetRow[]): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  for (const row of rows) {
    if (row.state === 'failed') {
      alerts.push({
        id: `${row.id}:failed`,
        nodeId: row.id,
        name: row.name,
        kind: 'stale',
        severity: 'bad',
        title: `${row.name} mission failed`,
        why: 'The executor reported this grid as failed; it is not holding its slot.',
        action: 'Open the mission list to see the failure reason, then move or relaunch it.',
      });
    }
    if (row.power.h2State === 'read' && row.h2Pct !== null && row.h2Pct < FUEL_ALERT_PCT && !row.isStation) {
      alerts.push({
        id: `${row.id}:fuel`,
        nodeId: row.id,
        name: row.name,
        kind: 'needs-fuel',
        severity: row.h2Pct < 10 ? 'bad' : 'warn',
        title: `${row.name} needs fuel`,
        why: `Hydrogen is at ${fmtPct(row.h2Pct)}${row.state === 'needs-fuel' ? '' : ' and falling'}.`,
        action: 'Send it to a base or top up H2 before the next burn.',
      });
    }
    const draining = row.charge === 'draining' || (row.power.netMw !== null && row.power.netMw < 0);
    if (row.power.batteryState === 'read' && row.batteryPct !== null && row.batteryPct < LOW_POWER_PCT && draining && !row.isStation) {
      alerts.push({
        id: `${row.id}:power`,
        nodeId: row.id,
        name: row.name,
        kind: 'low-power',
        severity: row.batteryPct < 10 ? 'bad' : 'warn',
        title: `${row.name} low power`,
        why: `Battery at ${fmtPct(row.batteryPct)} and discharging${row.power.netMw !== null ? ` (${row.power.netMw.toFixed(2)} MW net)` : ''}.`,
        action: row.zeroG ? 'Zero-g hold needs no thrust: check antennas and solar pointing.' : 'Reduce antenna range or move it to daylight.',
      });
    }
    if (row.power.solarPct !== null && row.power.solarPct < LOW_SOLAR_PCT && row.power.batteryState === 'read' && row.batteryPct !== null && row.batteryPct < 60) {
      alerts.push({
        id: `${row.id}:solar`,
        nodeId: row.id,
        name: row.name,
        kind: 'low-power',
        severity: 'warn',
        title: `${row.name} solar weak`,
        why: `Solar is producing ${fmtPct(row.power.solarPct)} of installed capacity.`,
        action: 'Check solar panel orientation; the farm may be edge-on to the sun.',
      });
    }
    if (row.source === 'GAME' && !row.reachable && row.links === 0) {
      alerts.push({
        id: `${row.id}:link`,
        nodeId: row.id,
        name: row.name,
        kind: 'link-lost',
        severity: 'warn',
        title: `${row.name} link lost`,
        why: 'No radio or laser edge reaches this grid from the network.',
        action: 'Move it inside a relay footprint or add a relay between it and the base.',
      });
    }
    if (row.state === 'en-route' && row.speedMps > 1 && row.stale) {
      alerts.push({
        id: `${row.id}:drift`,
        nodeId: row.id,
        name: row.name,
        kind: 'drifting',
        severity: 'warn',
        title: `${row.name} drifting`,
        why: `Moving at ${Math.round(row.speedMps)} m/s with no fresh contact.`,
        action: 'Check the mission state; stop it if the order was not expected.',
      });
    }
    if (row.stale) {
      alerts.push({
        id: `${row.id}:stale`,
        nodeId: row.id,
        name: row.name,
        kind: 'stale',
        severity: 'warn',
        title: `${row.name} stale`,
        why: row.lastContactAgeMs === null ? 'No telemetry has ever arrived for this grid.' : `Last contact ${fmtAge(row.lastContactAgeMs)} ago.`,
        action: 'Check the plugin connection before trusting this row.',
      });
    }
  }
  const order: Record<AlertKind, number> = { 'needs-fuel': 0, 'low-power': 1, 'link-lost': 2, drifting: 3, stale: 4 };
  return alerts.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

export function filterFleet(rows: FleetRow[], filter: FleetFilter): FleetRow[] {
  const q = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.roles.length > 0) {
      if (row.role === null || !filter.roles.includes(row.role)) return false;
    }
    if (filter.states.length > 0 && !filter.states.includes(row.state)) return false;
    if (filter.maxFuelPct !== null) {
      // Rows with unknown fuel cannot prove they are below the threshold, but
      // hiding them would make the filter look like "no ships".
      if (row.h2Pct !== null && row.h2Pct >= filter.maxFuelPct) return false;
    }
    if (q) {
      const hay = `${row.name} ${row.planet ?? ''} ${row.state} ${row.role ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** A missing value sorts below every real value in both directions. */
export function sortFleet(rows: FleetRow[], key: SortKey, dir: 'asc' | 'desc'): FleetRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (row: FleetRow): number | string | null => {
    switch (key) {
      case 'name': return row.name.toLowerCase();
      case 'role': return row.role ?? '';
      case 'state': return row.state;
      case 'planet': return row.planet ?? '';
      case 'altitude': return row.altitudeM;
      case 'links': return row.links;
      case 'radio': return row.radioRangeM;
      case 'laser': return row.laserPortsFree;
      case 'battery': return row.batteryPct;
      case 'solar': return row.solarPct;
      case 'h2': return row.h2Pct;
      case 'uranium': return row.uraniumPct;
      case 'life': return row.expectedLife.kind === 'no-limit' ? Number.POSITIVE_INFINITY : row.expectedLife.minutes;
      case 'age': return row.lastContactAgeMs;
      case 'integrity': return row.integrityPct;
      default: return row.name.toLowerCase();
    }
  };
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av === bv) return a.name.localeCompare(b.name);
      return (av - bv) * sign;
    }
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return cmp * sign;
  });
}

/** One label the UI can render; `null` means "needs plugin update". */
export function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`;
}

export function fmtKm(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '—';
  const km = m / 1000;
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min}m`;
  return `${(min / 60).toFixed(1)}h`;
}

/** h:mm for runways; 'no limit' for stations; '—' when unknown. */
export function fmtRunway(life: ExpectedLife): string {
  if (life.kind === 'no-limit') return 'no limit';
  if (life.kind === 'unknown' || life.minutes === null) return '—';
  const total = Math.max(0, Math.round(life.minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 100) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

const CSV_COLUMNS: { key: string; header: string; get: (row: FleetRow) => string | number }[] = [
  { key: 'name', header: 'name', get: (r) => r.name },
  { key: 'role', header: 'role', get: (r) => r.role ?? '' },
  { key: 'state', header: 'state', get: (r) => r.state },
  { key: 'planet', header: 'planet', get: (r) => r.planet ?? '' },
  { key: 'altitude_km', header: 'altitude_km', get: (r) => (r.altitudeM === null ? '' : (r.altitudeM / 1000).toFixed(2)) },
  { key: 'links', header: 'links', get: (r) => r.links },
  { key: 'link_names', header: 'link_names', get: (r) => r.linkNames.join('; ') },
  { key: 'radio_km', header: 'radio_km', get: (r) => (r.radioRangeM === null ? '' : (r.radioRangeM / 1000).toFixed(1)) },
  { key: 'laser_free', header: 'laser_ports_free', get: (r) => r.laserPortsFree },
  { key: 'battery_pct', header: 'battery_pct', get: (r) => (r.batteryPct === null ? '' : r.batteryPct.toFixed(1)) },
  { key: 'charge', header: 'charge', get: (r) => r.charge },
  { key: 'solar_pct', header: 'solar_pct', get: (r) => (r.solarPct === null ? '' : r.solarPct.toFixed(1)) },
  { key: 'h2_pct', header: 'h2_pct', get: (r) => (r.h2Pct === null ? '' : r.h2Pct.toFixed(1)) },
  { key: 'uranium_pct', header: 'uranium_pct', get: (r) => (r.uraniumPct === null ? '' : r.uraniumPct.toFixed(1)) },
  { key: 'expected_life', header: 'expected_life', get: (r) => fmtRunway(r.expectedLife) },
  { key: 'last_contact_s', header: 'last_contact_s', get: (r) => (r.lastContactAgeMs === null ? '' : Math.round(r.lastContactAgeMs / 1000)) },
  { key: 'integrity_pct', header: 'integrity_pct', get: (r) => (r.integrityPct === null ? '' : r.integrityPct.toFixed(1)) },
];

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function fleetCsv(rows: FleetRow[]): string {
  const head = CSV_COLUMNS.map((c) => c.header).join(',');
  const body = rows.map((row) => CSV_COLUMNS.map((c) => csvCell(c.get(row))).join(','));
  return [head, ...body].join('\n');
}
