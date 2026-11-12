/**
 * Hardware view used by thrust staging (T8).
 *
 * Nominal thrust per type comes from the same CubeBlocks definitions as the
 * endurance model (`endurance/definitions.ts`); no force is typed in from
 * memory. Mass is the measured value from the capability profile / plugin
 * telemetry, never a prefab guess.
 *
 * A hull whose per-type split is unknown (an owner-tagged grid that reports
 * mass only) gets no staging model: switching hydrogen off on a guess could
 * drop a drone. The measured owner satellite is registered explicitly because
 * its force split was read from the live grid (endurance calibration).
 */
import {
  THRUSTER_DEFINITIONS,
  bankFromCounts,
  type ThrusterKind,
} from '../endurance/definitions.js';
import { HULLS } from '../hulls.js';

export interface StagingHardware {
  id: string;
  name: string;
  massKg: number;
  /** Nominal force per type at 100 % effectiveness, N. */
  thrustN: Record<ThrusterKind, number>;
  /** Electric/fuel draw of the bank at 100 %, MW (endurance model units). */
  powerMW: Record<ThrusterKind, number>;
  /** Block counts per type, when known (used for the per-direction subset). */
  count: Record<ThrusterKind, number>;
  batteryMWh: number;
  batteryOutputMW: number;
  h2TankLitres: number;
  h2Fill: number;
  batteryFill: number;
  /**
   * Names of hydrogen thrusters known to point "up". The plugin does not
   * report block orientation yet, so this is null for every stock hull and the
   * policy falls back to "all H2".
   */
  h2UpFacingNames: string[] | null;
  source: string;
}

/** Bank ratios from the large-block definitions (power MW per MN of force). */
const POWER_PER_MN: Record<ThrusterKind, number> = {
  ion: 33.6 / 4.32,
  atmo: 16.8 / 6.48,
  h2: 7.5 / 7.2,
};

export interface StagingHardwareInput {
  id: string;
  name: string;
  massKg: number;
  massSource?: 'measured' | 'assumption';
  thrustCounts?: Partial<Record<ThrusterKind, Record<string, number>>>;
  /** Direct force split for a profile that reports N rather than block counts. */
  thrustN?: Partial<Record<ThrusterKind, number>>;
  batteryMWh?: number;
  batteryOutputMW?: number;
  h2TankLitres?: number;
  h2Fill?: number;
  batteryFill?: number;
  h2UpFacingNames?: string[] | null;
  source: string;
}

/** Build the staging view from block counts or a measured force split. */
export function hardwareFrom(input: StagingHardwareInput): StagingHardware {
  const force: Record<ThrusterKind, number> = { atmo: 0, ion: 0, h2: 0 };
  const power: Record<ThrusterKind, number> = { atmo: 0, ion: 0, h2: 0 };
  const count: Record<ThrusterKind, number> = { atmo: 0, ion: 0, h2: 0 };
  for (const kind of ['atmo', 'ion', 'h2'] as ThrusterKind[]) {
    const counts = input.thrustCounts?.[kind];
    if (counts && Object.keys(counts).length > 0) {
      const bank = bankFromCounts(counts);
      force[kind] = bank.forceN;
      power[kind] = bank.powerMW;
      count[kind] = bank.count;
      continue;
    }
    const measured = input.thrustN?.[kind] ?? 0;
    force[kind] = measured;
    power[kind] = (measured / 1e6) * POWER_PER_MN[kind];
    count[kind] = measured > 0 ? 1 : 0;
  }
  return {
    id: input.id,
    name: input.name,
    massKg: Math.max(1, input.massKg),
    thrustN: force,
    powerMW: power,
    count,
    batteryMWh: input.batteryMWh ?? 0,
    batteryOutputMW: input.batteryOutputMW ?? 0,
    h2TankLitres: input.h2TankLitres ?? 0,
    h2Fill: input.h2Fill ?? 1,
    batteryFill: input.batteryFill ?? 1,
    h2UpFacingNames: input.h2UpFacingNames ?? null,
    source: input.source,
  };
}

/**
 * Owner satellite measured on the test server (endurance calibration):
 * 12 small atmospheric + 10 small hydrogen thrusters, 18,965.4 kg, 2 MWh of
 * battery, tank fill 39.96 %. Tank volume is the stock small tank (500,000 L)
 * and is marked ASSUMPTION in the staging model; it only scales the fuel-saved
 * percentage, not the burn rate.
 */
export const OWNER_SATELLITE_GRID_ID = 'grid:126323015058751318';

/**
 * Measured profiles of the owner's four satellites. They are the same hull
 * family but not identical (8–14 atmospheric thrusters), so each grid gets its
 * own measured force split. Without this table only SAT-L-0002 had staging and
 * the others burned hydrogen at 2 km (T13 case 1 finding, 2026-11-09).
 */
const OWNER_SAT_PROFILES: Record<string, { massKg: number; atmoN: number; h2N: number }> = {
  'grid:107519913664561774': { massKg: 19_003.6, atmoN: 1_152_000, h2N: 984_000 }, // SAT-L-0001, 12 atmo
  'grid:126323015058751318': { massKg: 18_965.4, atmoN: 1_152_000, h2N: 984_000 }, // SAT-L-0002, 12 atmo
  'grid:113586721763627228': { massKg: 18_337.6, atmoN: 1_152_000, h2N: 984_000 }, // SAT-L-0003, 12 atmo
  'grid:115081011520040319': { massKg: 20_401.6, atmoN: 1_344_000, h2N: 984_000 }, // SAT-L-0004, 14 atmo
};

const OWNER_SAT_HARDWARE: Record<string, StagingHardware> = {};
for (const [gridId, p] of Object.entries(OWNER_SAT_PROFILES)) {
  OWNER_SAT_HARDWARE[gridId] = hardwareFrom({
    id: gridId,
    name: gridId,
    massKg: p.massKg,
    massSource: 'measured',
    thrustN: { atmo: p.atmoN, h2: p.h2N, ion: 0 },
    batteryMWh: 2,
    batteryOutputMW: 8,
    h2TankLitres: 60_000, // 4 x 15,000 L small tanks
    h2Fill: 0.5,
    batteryFill: 1,
    source: 'measured live profile (staging model, owner satellite family)',
  });
}

export const OWNER_SATELLITE: StagingHardware = hardwareFrom({
  id: 'tagged:owner-satellite',
  name: 'owner satellite (12 atmo + 10 H2)',
  massKg: 18_965.4,
  massSource: 'measured',
  thrustCounts: {
    atmo: { SmallBlockSmallAtmosphericThrust: 12 },
    h2: { SmallBlockSmallHydrogenThrust: 10 },
  },
  batteryMWh: 2,
  batteryOutputMW: 4,
  h2TankLitres: 500_000,
  h2Fill: 0.3996,
  batteryFill: 1,
  source: 'measured live profile 2026-11-09 (mass 18,965.4 kg, atmo 1.152 MN + H2 0.984 MN)',
});

/** Prefab -> staging hardware, from the definitions-derived prefab table. */
const PREFAB_HARDWARE: Record<string, StagingHardware> = {};
for (const [prefab, spec] of Object.entries(HULLS)) {
  const counts = prefabCounts(prefab);
  if (!counts) continue;
  PREFAB_HARDWARE[prefab] = hardwareFrom({
    id: prefab,
    name: prefab,
    massKg: spec.massKg,
    massSource: 'measured',
    thrustCounts: counts,
    ...batteryFor(prefab),
    source: `measured capability profile (hulls.ts) + CubeBlocks counts for ${prefab}`,
  });
}

/** Block counts for the three measured prefabs, from endurance/model data. */
function prefabCounts(prefab: string): Partial<Record<ThrusterKind, Record<string, number>>> | null {
  switch (prefab) {
    case 'Eradicator_mk.1':
      return { ion: { LargeBlockLargeThrust: 1, LargeBlockSmallThrust: 48 } };
    case 'Large Control Drone':
      return { atmo: { LargeBlockSmallAtmosphericThrust: 19 } };
    case 'Escort TT-420':
      return {
        atmo: { LargeBlockLargeAtmosphericThrust: 2, LargeBlockSmallAtmosphericThrust: 8 },
        h2: { LargeBlockLargeHydrogenThrust: 1, LargeBlockSmallHydrogenThrust: 6 },
      };
    default:
      return null;
  }
}

function batteryFor(prefab: string): Pick<StagingHardwareInput, 'batteryMWh' | 'batteryOutputMW' | 'h2TankLitres'> {
  switch (prefab) {
    case 'Large Control Drone':
      return { batteryMWh: 18, batteryOutputMW: 72 };
    case 'Escort TT-420':
      return { batteryMWh: 18, batteryOutputMW: 72, h2TankLitres: 15_000_000 };
    default:
      return {};
  }
}

export interface HardwareLookup {
  hardware: StagingHardware | null;
  reason: string | null;
}

/**
 * Live plugin `profile` read (`action: 'profile'`). The plugin reports the
 * measured mass, the per-type MaxThrust totals, the battery capacity/stored
 * energy and every gas tank. This is the only trustworthy source for a cloned
 * grid: a clone keeps the hull but gets a new grid id, so no registry entry and
 * no prefab name exists for it.
 */
export interface LiveProfileResult {
  massKg?: unknown;
  thrusters?: { atmoN?: unknown; ionN?: unknown; h2N?: unknown };
  power?: { batteryCapacityMWh?: unknown; batteryStoredMWh?: unknown };
  fuel?: { tanks?: Array<{ capacity?: unknown; filledRatio?: unknown }> };
}

/**
 * Build staging hardware from a live `profile` read. Returns null when the read
 * cannot support a decision (no mass, no thrust): the controller then keeps H2
 * untouched instead of switching a bank on a guess.
 *
 * The plugin does not split tank volume by gas, so the H2 fill is the
 * capacity-weighted mean of every gas tank on the grid. That only scales the
 * fuel-saved estimate, never the burn model.
 */
export function hardwareFromLiveProfile(gridId: string, result: LiveProfileResult): StagingHardware | null {
  const massKg = finite(result.massKg);
  const t = result.thrusters ?? {};
  const atmo = finite(t.atmoN) ?? 0;
  const ion = finite(t.ionN) ?? 0;
  const h2 = finite(t.h2N) ?? 0;
  if (!massKg || massKg <= 0) return null;
  if (atmo + ion + h2 <= 0) return null;

  let litres = 0;
  let filled = 0;
  for (const tank of result.fuel?.tanks ?? []) {
    const capacity = finite(tank.capacity) ?? 0;
    if (capacity <= 0) continue;
    litres += capacity;
    filled += capacity * Math.min(1, Math.max(0, finite(tank.filledRatio) ?? 0));
  }
  const capacityMWh = finite(result.power?.batteryCapacityMWh) ?? 0;
  const storedMWh = finite(result.power?.batteryStoredMWh) ?? 0;

  return hardwareFrom({
    id: gridId,
    name: gridId,
    massKg,
    massSource: 'measured',
    thrustN: { atmo, ion, h2 },
    batteryMWh: capacityMWh,
    // The plugin does not report the battery output ceiling; staging never uses
    // it (thrustAtAltitude depends on force and air density only).
    batteryOutputMW: 0,
    h2TankLitres: litres,
    h2Fill: litres > 0 ? filled / litres : 1,
    batteryFill: capacityMWh > 0 ? Math.min(1, Math.max(0, storedMWh / capacityMWh)) : 1,
    source: 'live plugin profile (mass, per-type MaxThrust, tanks, batteries)',
  });
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Resolve hardware for an executor drone. `prefab` is the executor's value
 * (`tagged:<gridId>` for owner-tagged hulls), `gridId` the live grid, and
 * `measuredMassKg` the plugin telemetry mass when present (it wins over the
 * catalog value: mass changes when cargo changes).
 */
export function hardwareFor(prefab: string, gridId: string | null, measuredMassKg: number | null): HardwareLookup {
  const ownerHull = gridId ? OWNER_SAT_HARDWARE[gridId] : undefined;
  if (ownerHull) {
    return {
      hardware: measuredMassKg ? { ...ownerHull, massKg: measuredMassKg } : ownerHull,
      reason: null,
    };
  }
  const key = prefab.startsWith('tagged:') ? prefab : prefab;
  const known = PREFAB_HARDWARE[key];
  if (known) {
    return {
      hardware: measuredMassKg ? { ...known, massKg: measuredMassKg } : known,
      reason: null,
    };
  }
  return {
    hardware: null,
    reason: prefab.startsWith('tagged:')
      ? `no measured per-type thrust split for ${prefab}; staging refused (mass-only profiles cannot prove which bank is redundant)`
      : `no staging hardware for prefab ${prefab}`,
  };
}

/** Nominal force of one subtype, used by tests and docs tables. */
export function subtypeForceN(subtype: string): number {
  return THRUSTER_DEFINITIONS[subtype]?.forceN ?? 0;
}
