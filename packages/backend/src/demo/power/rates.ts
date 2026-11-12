/**
 * Derived power numbers: rate of change over time, runways, expected life,
 * daylight, alerts and the telemetry block the site reads.
 *
 * Pure functions only; the poller owns the samples, this file owns the maths so
 * every rule is unit-tested without a server or a game.
 */
import type { Planet } from '@se-rts/schemas';
import type { PowerSnapshot } from './types.js';
import { POWER_DEFAULTS } from './types.js';

export interface PowerSample {
  at: number;
  batteryPct: number | null;
  h2Pct: number | null;
  h2Litres: number | null;
  uraniumKg: number | null;
  solarPct: number | null;
  netMw: number | null;
}

export function sampleOf(snap: PowerSnapshot): PowerSample {
  return {
    at: snap.at,
    batteryPct: snap.batteryPct,
    h2Pct: snap.h2Pct,
    h2Litres: snap.h2Litres,
    uraniumKg: snap.uraniumKg,
    solarPct: snap.solarMaxMw !== null && snap.solarMaxMw > 0.0001 && snap.solarActualMw !== null
      ? (snap.solarActualMw / snap.solarMaxMw) * 100
      : null,
    netMw: snap.netMw,
  };
}

export interface RateEstimate {
  windowS: number;
  samples: number;
  /** Percent per hour; negative = falling. */
  batteryPctPerHour: number | null;
  h2PctPerHour: number | null;
  h2LitresPerHour: number | null;
  uraniumKgPerHour: number | null;
  source: 'sampled' | 'insufficient';
}

/**
 * Least-squares slope of each series against time. A two-point delta is far too
 * noisy on a 0.1 %-resolution battery readout, and a single sample is not a
 * rate: both report `null` rather than a made-up number.
 */
export function estimateRates(samples: PowerSample[], opts: { minSpanMs?: number } = {}): RateEstimate {
  const minSpanMs = opts.minSpanMs ?? POWER_DEFAULTS.minRateSpanMs;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const spanMs = sorted.length > 1 ? sorted[sorted.length - 1]!.at - sorted[0]!.at : 0;
  const base: RateEstimate = {
    windowS: Math.round(spanMs / 1000),
    samples: sorted.length,
    batteryPctPerHour: null,
    h2PctPerHour: null,
    h2LitresPerHour: null,
    uraniumKgPerHour: null,
    source: 'insufficient',
  };
  if (sorted.length < 2 || spanMs < minSpanMs) return base;

  const slope = (pick: (s: PowerSample) => number | null): number | null => {
    const pts = sorted
      .map((s) => ({ t: s.at / 3_600_000, v: pick(s) }))
      .filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.v));
    if (pts.length < 2) return null;
    const n = pts.length;
    const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
    const meanV = pts.reduce((a, p) => a + p.v, 0) / n;
    let cov = 0;
    let varT = 0;
    for (const p of pts) {
      cov += (p.t - meanT) * (p.v - meanV);
      varT += (p.t - meanT) ** 2;
    }
    if (varT < 1e-9) return null;
    return cov / varT;
  };

  const battery = slope((s) => s.batteryPct);
  const h2Pct = slope((s) => s.h2Pct);
  const h2L = slope((s) => s.h2Litres);
  const uranium = slope((s) => s.uraniumKg);
  const any = battery !== null || h2Pct !== null || h2L !== null || uranium !== null;
  return {
    ...base,
    batteryPctPerHour: battery === null ? null : round(battery, 3),
    h2PctPerHour: h2Pct === null ? null : round(h2Pct, 3),
    h2LitresPerHour: h2L === null ? null : round(h2L, 1),
    uraniumKgPerHour: uranium === null ? null : round(uranium, 3),
    source: any ? 'sampled' : 'insufficient',
  };
}

export type LifeKind = 'no-limit' | 'unknown' | 'minutes';

/**
 * Why `powerRunwayMin` is null (or set). A null runway is an answer, not a
 * missing number: "the batteries are charging" and "nothing is drawing" are
 * different facts, and neither is 0 minutes.
 *
 * `draining` with a null runway means the deficit exists but the stored charge
 * is unread (0 MWh from the plugin is ambiguous: empty, or a failed read).
 */
export type PowerRunwayReason = 'draining' | 'charging' | 'idle' | 'absent' | 'unread';

export interface Runway {
  powerRunwayMin: number | null;
  /** Why the power runway is what it is: draining / charging / idle / absent / unread. */
  powerRunwayReason: PowerRunwayReason;
  fuelRunwayMin: number | null;
  uraniumRunwayMin: number | null;
  /** Smallest known runway; null when nothing is known. */
  runwayMin: number | null;
  expectedLife: { kind: LifeKind; minutes: number | null; label: string };
}

/**
 * The projected deficit is production minus consumption, where the plugin
 * publishes `netMw` with batteries as STORAGE (a discharging battery is not
 * production). Before 2026-11-11 the plugin counted the battery's own output as
 * generation, so every battery-powered grid read a positive net and no runway
 * could ever exist.
 */
function powerReason(snap: PowerSnapshot, hasRunway: boolean): PowerRunwayReason {
  if (snap.batteryState === 'absent') return 'absent';
  if (hasRunway) return 'draining';
  if (snap.charge === 'charging') return 'charging';
  if (snap.netMw !== null && snap.netMw > 0.0005) return 'charging';
  if (snap.netMw === null) return 'unread';
  // A negative net with no stored charge figure: the drained battery's charge is
  // unread, not "0 minutes left".
  if (snap.netMw < -0.001) return 'unread';
  return 'idle';
}

export function computeRunway(snap: PowerSnapshot, rates: RateEstimate, ctx: { zeroG: boolean }): Runway {
  const storedMWh = snap.batteryStoredMWh
    ?? (snap.batteryPct !== null && snap.batteryMaxMWh !== null ? (snap.batteryPct / 100) * snap.batteryMaxMWh : null);
  const powerRunwayMin = storedMWh !== null && storedMWh > 0 && snap.netMw !== null && snap.netMw < -0.001
    ? round((storedMWh / -snap.netMw) * 60, 1)
    : null;
  const powerRunwayReason = powerReason(snap, powerRunwayMin !== null);

  // Rates are negative while the stock is falling; a positive rate means the
  // tank is filling and there is no runway to compute.
  const fuelPctRate = rates.h2PctPerHour;
  const fuelLitreRate = rates.h2LitresPerHour;
  const fuelRunwayMin = fuelPctRate !== null && fuelPctRate < 0 && snap.h2Pct !== null
    ? round((snap.h2Pct / -fuelPctRate) * 60, 1)
    : fuelLitreRate !== null && fuelLitreRate < 0 && snap.h2Litres !== null
      ? round((snap.h2Litres / -fuelLitreRate) * 60, 1)
      : null;

  const uraniumRunwayMin = rates.uraniumKgPerHour !== null && rates.uraniumKgPerHour < 0 &&
    snap.uraniumKg !== null && (snap.uraniumCapacityKg ?? 0) > 0
    ? round((snap.uraniumKg / -rates.uraniumKgPerHour) * 60, 1)
    : null;

  const values = [powerRunwayMin, fuelRunwayMin, uraniumRunwayMin].filter(
    (v): v is number => v !== null && Number.isFinite(v) && v >= 0,
  );
  const runwayMin = values.length ? Math.min(...values) : null;

  const noFuelBurn = (rates.h2PctPerHour ?? 0) >= 0 && (rates.uraniumKgPerHour ?? 0) >= 0;
  const noLimit = snap.isStatic === true || ctx.zeroG || ((snap.netMw ?? 0) >= -0.001 && noFuelBurn);
  const expectedLife = noLimit
    ? { kind: 'no-limit' as const, minutes: null, label: 'no limit' }
    : runwayMin === null
      ? { kind: 'unknown' as const, minutes: null, label: '—' }
      : { kind: 'minutes' as const, minutes: runwayMin, label: formatRunway(runwayMin) };

  return { powerRunwayMin, powerRunwayReason, fuelRunwayMin, uraniumRunwayMin, runwayMin, expectedLife };
}

export function formatRunway(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 100) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export type PowerAlertKind =
  | 'low-battery'
  | 'draining'
  | 'needs-fuel'
  | 'uranium-low'
  | 'solar-pointing'
  | 'manual-control';

export interface PowerAlert {
  id: string;
  gridId: string;
  name: string;
  kind: PowerAlertKind;
  severity: 'warn' | 'bad';
  title: string;
  why: string;
  action: string;
  value: number | null;
  at: number;
}

export function evaluatePowerAlerts(args: {
  snap: PowerSnapshot;
  runway: Runway;
  rates: RateEstimate;
  daylight: boolean | null;
  zeroG: boolean;
  now: number;
}): PowerAlert[] {
  const { snap, runway, rates, daylight, zeroG, now } = args;
  const name = snap.name ?? snap.gridId;
  const out: PowerAlert[] = [];
  const push = (a: Omit<PowerAlert, 'id' | 'gridId' | 'name' | 'at'>) =>
    out.push({ ...a, id: `${snap.gridId}:${a.kind}`, gridId: snap.gridId, name, at: now });

  if (snap.underControl) {
    push({
      kind: 'manual-control',
      severity: 'warn',
      title: `${name} under manual control`,
      why: `${snap.controlledBy ? `${snap.controlledBy} is` : 'A player is'} piloting this grid; the fleet pauses its orders.`,
      action: 'Release the cockpit or remote control to let the fleet resume.',
      value: null,
    });
  }

  const draining = snap.charge === 'discharging' || (snap.netMw !== null && snap.netMw < -0.001);
  if (snap.batteryPct !== null && snap.batteryPct < 25) {
    push({
      kind: 'low-battery',
      severity: snap.batteryPct < 10 ? 'bad' : 'warn',
      title: `${name} battery low`,
      why: `Battery at ${snap.batteryPct.toFixed(1)}%${snap.netMw !== null ? ` (${snap.netMw.toFixed(2)} MW net)` : ''}.`,
      action: zeroG ? 'A zero-g hold needs no thrust: check antenna draw and solar pointing.' : 'Cut antenna range (auto-tune) or move it into daylight.',
      value: snap.batteryPct,
    });
  }
  if (draining && runway.powerRunwayMin !== null && runway.powerRunwayMin < 120) {
    push({
      kind: 'draining',
      severity: runway.powerRunwayMin < 30 ? 'bad' : 'warn',
      title: `${name} draining`,
      why: `Battery empties in ${formatRunway(runway.powerRunwayMin)} at ${snap.netMw?.toFixed(2) ?? '?'} MW net.`,
      action: 'Reduce draw (auto-tune ranges) or add generation before it browns out.',
      value: runway.powerRunwayMin,
    });
  }
  if (snap.h2Pct !== null && snap.h2Pct < 30 && snap.isStatic !== true) {
    push({
      kind: 'needs-fuel',
      severity: snap.h2Pct < 10 ? 'bad' : 'warn',
      title: `${name} hydrogen low`,
      why: `H2 at ${snap.h2Pct.toFixed(1)}%${rates.h2PctPerHour !== null ? ` (${rates.h2PctPerHour.toFixed(2)} %/h)` : ''}.`,
      action: 'Send a refuel run or station it (a station burns no hydrogen).',
      value: snap.h2Pct,
    });
  }
  if (snap.uraniumPct !== null && snap.uraniumPct < 10) {
    push({
      kind: 'uranium-low',
      severity: 'warn',
      title: `${name} reactor fuel low`,
      why: `Uranium at ${snap.uraniumKg !== null ? `${snap.uraniumKg.toFixed(0)} kg` : ''} (${snap.uraniumPct.toFixed(1)}%)` +
        `${rates.uraniumKgPerHour !== null ? `, ${rates.uraniumKgPerHour.toFixed(2)} kg/h` : ''}.`,
      action: 'Refuel the reactor; at the current draw the fuel will run out soon.',
      value: snap.uraniumPct,
    });
  }
  if (snap.solarMaxMw !== null && snap.solarMaxMw > 0.0001 && snap.solarEfficiency !== null && snap.solarEfficiency < 0.3 && daylight === true) {
    push({
      kind: 'solar-pointing',
      severity: 'warn',
      title: `${name} solar not facing sun`,
      why: `Solar makes ${(snap.solarEfficiency * 100).toFixed(0)}% of installed capacity in daylight.`,
      action: 'Rotate the solar farm towards the sun (or accept the lower input).',
      value: snap.solarEfficiency * 100,
    });
  }
  return out;
}

/**
 * Sun elevation above the local horizon, degrees. The plugin publishes a
 * world-space unit vector towards the sun; the local "up" is the radial from
 * the nearest planet, so this works on every planet without an ephemeris.
 */
export function sunElevationDeg(pos: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number } | null, planet: Planet | null): number | null {
  if (!sun || !planet) return null;
  const sunLen = Math.hypot(sun.x, sun.y, sun.z);
  const up = { x: pos.x - planet.center.x, y: pos.y - planet.center.y, z: pos.z - planet.center.z };
  const upLen = Math.hypot(up.x, up.y, up.z);
  if (sunLen < 1e-6 || upLen < 1e-6) return null;
  const dot = (sun.x * up.x + sun.y * up.y + sun.z * up.z) / (sunLen * upLen);
  return (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

export function isDaylight(pos: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number } | null, planet: Planet | null): boolean | null {
  const elevation = sunElevationDeg(pos, sun, planet);
  return elevation === null ? null : elevation > 0;
}

/**
 * The telemetry block merged into `/api/demo/state` → `nodes[].telemetry`.
 *
 * Flat aliases are the exact names `fleet.ts` feature-detects; the nested
 * `power` object is the structured view for the ship card. Missing values stay
 * `null` (and are listed in `power.missing`) so the site shows "—".
 */
export function powerTelemetry(
  snap: PowerSnapshot,
  ctx: { rates: RateEstimate; runway: Runway; daylight: boolean | null; zeroG: boolean; alerts: PowerAlert[] },
): Record<string, unknown> {
  const { rates, runway, daylight, zeroG, alerts } = ctx;
  return {
    // flat aliases read by the Fleet page
    batteryPct: snap.batteryPct,
    batteryState: snap.batteryState,
    batteryUnreadReason: snap.batteryUnreadReason,
    batteryStoredMWh: snap.batteryStoredMWh,
    batteryMaxMWh: snap.batteryMaxMWh,
    chargeState: snap.charge,
    currentInputMw: snap.batteryInputMw,
    currentOutputMw: snap.batteryOutputMw,
    netMw: snap.netMw,
    // The power breakdown beside netMw (why the net is what it is).
    generationMw: snap.generationMw,
    consumerDrawMw: snap.consumerDrawMw,
    batteryChargeMw: snap.batteryChargeMw,
    solarActualMw: snap.solarActualMw,
    solarOutputMw: snap.solarActualMw,
    solarMaxMw: snap.solarMaxMw,
    solarEfficiency: snap.solarEfficiency,
    h2Pct: snap.h2Pct,
    h2State: snap.h2State,
    h2UnreadReason: snap.h2UnreadReason,
    h2TankCount: snap.h2TankCount,
    h2Litres: snap.h2Litres,
    h2PctPerHour: rates.h2PctPerHour,
    uraniumKg: snap.uraniumKg,
    uraniumCapacityKg: snap.uraniumCapacityKg,
    uraniumPct: snap.uraniumPct,
    uraniumKgPerHour: rates.uraniumKgPerHour,
    powerRunwayMin: runway.powerRunwayMin,
    powerRunwayReason: runway.powerRunwayReason,
    fuelRunwayMin: runway.fuelRunwayMin,
    uraniumRunwayMin: runway.uraniumRunwayMin,
    runwayMin: runway.runwayMin,
    expectedLife: runway.expectedLife,
    isStatic: snap.isStatic,
    underControl: snap.underControl,
    manualControl: snap.underControl,
    daylight,
    zeroG,
    powerAgeMs: null,
    power: {
      battery: {
        state: snap.batteryState,
        unreadReason: snap.batteryUnreadReason,
        storedMWh: snap.batteryStoredMWh,
        capacityMWh: snap.batteryMaxMWh,
        pct: snap.batteryPct,
        inputMw: snap.batteryInputMw,
        outputMw: snap.batteryOutputMw,
      },
      charge: snap.charge,
      netMw: snap.netMw,
      /**
       * The measured breakdown behind netMw: production, non-battery draw and
       * battery input. The plugin publishes it in its `power` block; the site
       * renders it so a negative net is explainable instead of mysterious.
       */
      breakdown: {
        generationMw: snap.generationMw,
        consumerDrawMw: snap.consumerDrawMw,
        batteryChargeMw: snap.batteryChargeMw,
        netMw: snap.netMw,
      },
      currentInputMw: snap.batteryInputMw,
      currentOutputMw: snap.batteryOutputMw,
      solar: {
        actualMw: snap.solarActualMw,
        maxMw: snap.solarMaxMw,
        pct: snap.solarEfficiency === null ? null : snap.solarEfficiency * 100,
        efficiency: snap.solarEfficiency,
        panels: snap.solar,
      },
      reactor: {
        outputMw: snap.reactorOutputMw,
        maxMw: snap.reactorMaxMw,
        uraniumKg: snap.uraniumKg,
        capacityKg: snap.uraniumCapacityKg,
        pct: snap.uraniumPct,
        reactors: snap.reactors,
      },
      h2: {
        state: snap.h2State,
        unreadReason: snap.h2UnreadReason,
        tankCount: snap.h2TankCount,
        litres: snap.h2Litres,
        capacityLitres: snap.h2CapacityLitres,
        pct: snap.h2Pct,
        pctPerHour: rates.h2PctPerHour,
        tanks: snap.tanks,
      },
      draw: {
        antennaMw: snap.antennaDrawMw,
        laserMw: snap.laserDrawMw,
        deviceMw: snap.deviceDrawMw,
      },
      antennas: snap.radio,
      lasers: snap.lasers,
      rates,
      runways: {
        powerMin: runway.powerRunwayMin,
        powerReason: runway.powerRunwayReason,
        fuelMin: runway.fuelRunwayMin,
        uraniumMin: runway.uraniumRunwayMin,
        min: runway.runwayMin,
      },
      expectedLife: runway.expectedLife,
      alerts,
      missing: snap.missing,
      source: 'GAME',
      sampledAt: snap.at,
      gameAt: snap.gameAt,
    },
    alerts,
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
