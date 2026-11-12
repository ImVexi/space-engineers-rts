/**
 * Designer hull catalog: prefab hulls come from measured capability profiles
 * (`demo/hulls.ts`, `demo/standins.ts`) plus the block counts in the prefab
 * survey (which are resolved against the CubeBlocks definitions); owner-tagged
 * grids are profiled live by the plugin (`list_tagged`). The endpoint never
 * invents a radio range: a hull with no antenna reports `radioRangeM: null` and
 * plans are infeasible.
 *
 * `power` / `tanks` feed the endurance model. They are definitions-derived for
 * prefabs; `list_tagged` does not return battery or tank state, so an
 * owner-tagged hull reports `enduranceSource: 'unavailable'` rather than a
 * guessed tank size.
 */
import { HULLS } from '../hulls.js';
import { STANDINS } from '../standins.js';
import { PREFAB_HARDWARE, bankFromCounts, bankMWh, solarPeakMW, tankLitres } from '../endurance/definitions.js';

export interface DesignerHull {
  id: string;
  source: 'prefab' | 'owner-tagged';
  name: string;
  radioRangeM: number | null;
  laserCount: number;
  thrust: { atmo: number; ion: number; h2: number };
  canGroundLaunch: boolean | 'unknown';
  twrAtSurface: number | null;
  notes: string;
  gridSize: 'large' | 'small' | null;
  massKg: number | null;
  /** Naming-service name (T9) when one exists; the grid name is the fallback. */
  displayName?: string | null;
  /** Live telemetry sampled for an owner-tagged grid (fuel/electric/mass). */
  live?: { h2Pct: number | null; batteryPct: number | null; massKg: number | null } | null;
  /** Definitions-derived electric plant; null when block counts are unknown. */
  power: { reactorMW: number; batteryMWh: number; solarPeakMW: number } | null;
  /** Definitions-derived fuel/charge state; null when unknown. */
  tanks: { h2Litres: number; h2FillPct: number; batteryFillPct: number } | null;
  enduranceSource: 'measured' | 'definitions' | 'unavailable';
  /** Demo laser model cap (100 km); null when the hull has no laser antenna. */
  laserRangeM?: number | null;
  /** Thrust per grid-local direction (T25), null when the profile has no envelope. */
  thrustPerDirection?: ThrustPerDirection | null;
  /** Measured/recommended flight mode; null when it was not sampled. */
  flightMode?: 'autopilot' | 'level' | null;
  isStatic?: boolean;
  /** Live position from the plugin profile (owner-tagged grids only). */
  position?: { x: number; y: number; z: number } | null;
}

/** T25 thrust envelope, newtons in the grid frame. */
export interface ThrustPerDirection {
  upN: number;
  downN: number;
  fwdN: number;
  backN: number;
  leftN: number;
  rightN: number;
}


/** Prefab entries used by the designer. Values are the measured profiles. */
export function prefabHulls(): DesignerHull[] {
  const out: DesignerHull[] = [];
  for (const hull of Object.values(HULLS)) {
    const stand = STANDINS[hull.prefab];
    const hardware = PREFAB_HARDWARE[hull.prefab];
    // Prefer the definition-resolved block bank: it gives the real atmo/ion/H2
    // split (a mixed hull's measured total alone cannot be split).
    const banks = hardware
      ? {
          atmo: bankFromCounts(hardware.thrustCounts.atmo).forceN,
          ion: bankFromCounts(hardware.thrustCounts.ion).forceN,
          h2: bankFromCounts(hardware.thrustCounts.h2).forceN,
        }
      : {
          atmo: hull.hullClass === 'gravity' || hull.hullClass === 'mixed' ? hull.thrustN : 0,
          ion: hull.hullClass === 'ion' ? hull.thrustN : 0,
          h2: 0,
        };
    const batteryMWh = hardware ? bankMWh(hardware.batteryCounts) : 0;
    const solarMW = hardware ? solarPeakMW(hardware.solarCounts) : 0;
    const h2Litres = hardware ? tankLitres(hardware.h2TankCounts) : 0;
    out.push({
      id: `prefab:${hull.prefab}`,
      source: 'prefab',
      name: hull.prefab,
      radioRangeM: hull.radioRadiusM > 0 ? hull.radioRadiusM : null,
      laserCount: stand?.laserPorts ?? 0,
      thrust: {
        atmo: Math.round(banks.atmo),
        ion: Math.round(banks.ion),
        h2: Math.round(banks.h2),
      },
      canGroundLaunch: hull.hullClass !== 'ion',
      twrAtSurface: hull.twrMeasured,
      notes:
        hull.sourceNote +
        (hull.hullClass === 'mixed' && !hardware
          ? ' Thrust split by type is not measured; the total is reported under atmo.'
          : '') +
        (hull.radioRadiusM === 0 ? ' NO radio antenna: plans with this hull are infeasible.' : '') +
        (hardware ? ' Endurance hardware is resolved from the prefab block survey and CubeBlocks definitions.' : ''),
      gridSize: hardware?.gridSize ?? null,
      massKg: hull.massKg,
      power: hardware ? { reactorMW: hardware.reactorMW, batteryMWh: round3(batteryMWh), solarPeakMW: round3(solarMW) } : null,
      tanks: hardware
        ? {
            h2Litres,
            h2FillPct: Math.round((hardware.h2Fill ?? 1) * 1000) / 10,
            batteryFillPct: Math.round((hardware.batteryFill ?? 1) * 1000) / 10,
          }
        : null,
      enduranceSource: hardware ? 'definitions' : 'unavailable',
      laserRangeM: stand?.laserRangeM ?? null,
      thrustPerDirection: null,
      flightMode: null,
      isStatic: stand?.isStatic ?? false,
    });
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface TaggedGridProfile {
  gridId: string;
  name: string;
  position?: { x: number; y: number; z: number };
  /** Owner identity reported by `list_tagged` (and its co-owners). */
  owner?: string | null;
  owners?: string[];
  radioRangeM?: number | null;
  laserCount?: number;
  /**
   * Profile-derived scalars. `null` since sim-speed audit #1: the cheap scan
   * does not classify thrusters, so only a `withProfile:true` caller sees
   * numbers here. Consumers must treat null as "unknown", never as zero.
   */
  thrust?: { atmo?: number; ion?: number; h2?: number } | null;
  massKg?: number;
  twr?: number | null;
  canGroundLaunch?: boolean | 'unknown' | null;
  notes?: string;
  /** Optional if the plugin later reports the electric plant. */
  power?: { reactorMW?: number; batteryMWh?: number; solarPeakMW?: number };
  /** Optional if the plugin later reports tank/power fill. */
  fuel?: { h2Litres?: number; h2FillPct?: number; batteryFillPct?: number };
  gridSize?: 'large' | 'small';
  /** T25 thrust envelope (N, grid-local) when the plugin reports it. */
  thrustPerDirection?: Partial<ThrustPerDirection> | null;
  /** `profile.flightMode` when the plugin reports it. */
  flightMode?: { recommended?: string; liftDominant?: boolean } | null;
  isStatic?: boolean;
}

/** Map one plugin `list_tagged` grid into the /hulls entry shape. */
export function taggedHull(
  grid: TaggedGridProfile,
  extra?: { displayName?: string | null; live?: { h2Pct?: number | null; batteryPct?: number | null; massKg?: number | null } | null },
): DesignerHull {
  const thrust = {
    atmo: Math.round(grid.thrust?.atmo ?? 0),
    ion: Math.round(grid.thrust?.ion ?? 0),
    h2: Math.round(grid.thrust?.h2 ?? 0),
  };
  const liveMass = extra?.live?.massKg ?? null;
  // The plugin sometimes reports 0 kg for a grid it cannot fully profile; the
  // telemetry mass is the measured fallback and wins only when > 0.
  const massKg = grid.massKg && grid.massKg > 0 ? grid.massKg : liveMass && liveMass > 0 ? liveMass : (grid.massKg ?? null);
  const known = grid.canGroundLaunch;
  const power =
    grid.power && (grid.power.reactorMW !== undefined || grid.power.batteryMWh !== undefined)
      ? {
          reactorMW: grid.power.reactorMW ?? 0,
          batteryMWh: grid.power.batteryMWh ?? 0,
          solarPeakMW: grid.power.solarPeakMW ?? 0,
        }
      : null;
  const tanks =
    grid.fuel && (grid.fuel.h2Litres !== undefined || grid.fuel.batteryFillPct !== undefined)
      ? {
          h2Litres: grid.fuel.h2Litres ?? 0,
          h2FillPct: grid.fuel.h2FillPct ?? 100,
          batteryFillPct: grid.fuel.batteryFillPct ?? 100,
        }
      : null;
  return {
    id: `tagged:${grid.gridId}`,
    source: 'owner-tagged',
    name: grid.name || grid.gridId,
    radioRangeM: grid.radioRangeM ?? null,
    laserCount: grid.laserCount ?? 0,
    thrust,
    canGroundLaunch: typeof known === 'boolean' ? known : 'unknown',
    twrAtSurface: grid.twr ?? null,
    notes:
      grid.notes ??
      `owner-tagged grid ${grid.gridId} profiled live via the plugin; thrust ${thrust.atmo + thrust.ion + thrust.h2} N, mass ${Math.round(massKg ?? 0)} kg`,
    gridSize: grid.gridSize ?? null,
    massKg,
    displayName: extra?.displayName ?? null,
    live: extra?.live
      ? {
          h2Pct: extra.live.h2Pct === undefined || extra.live.h2Pct === null ? null : extra.live.h2Pct,
          batteryPct:
            extra.live.batteryPct === undefined || extra.live.batteryPct === null ? null : extra.live.batteryPct,
          massKg: liveMass,
        }
      : null,
    power,
    tanks,
    enduranceSource: power && tanks ? 'measured' : 'unavailable',
    laserRangeM: null,
    thrustPerDirection: grid.thrustPerDirection
      ? {
          upN: Math.round(grid.thrustPerDirection.upN ?? 0),
          downN: Math.round(grid.thrustPerDirection.downN ?? 0),
          fwdN: Math.round(grid.thrustPerDirection.fwdN ?? 0),
          backN: Math.round(grid.thrustPerDirection.backN ?? 0),
          leftN: Math.round(grid.thrustPerDirection.leftN ?? 0),
          rightN: Math.round(grid.thrustPerDirection.rightN ?? 0),
        }
      : null,
    flightMode:
      grid.flightMode?.recommended === 'level'
        ? 'level'
        : grid.flightMode?.recommended === 'autopilot'
          ? 'autopilot'
          : grid.flightMode?.liftDominant
            ? 'level'
            : null,
    isStatic: grid.isStatic ?? false,
    position: grid.position ?? null,
  };
}

/** Look up a hull by id in a merged list. */
export function findHull(hulls: DesignerHull[], id: string): DesignerHull | null {
  return hulls.find((h) => h.id === id) ?? null;
}
