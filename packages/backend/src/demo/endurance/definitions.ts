/**
 * Block data used by the endurance model.
 *
 * Every number below is copied from the game's own CubeBlocks definitions in
 * `<your SE install>/Content/Data/CubeBlocks/`; the subtype is the
 * source for each row, so the model can be re-checked without guessing.
 *
 *  - thrusters: CubeBlocks_Thrusters.sbc (`ForceMagnitude` N,
 *    `MaxPowerConsumption` MW, `Min/MaxPlanetaryInfluence`,
 *    `EffectivenessAtMin/MaxInfluence`, `FuelConverter` Hydrogen efficiency 1)
 *  - batteries: CubeBlocks_Energy.sbc (`MaxStoredPower` MWh, `MaxPowerOutput` MW)
 *  - solar: CubeBlocks_Energy.sbc (`MaxPowerOutput` MW at full incidence)
 *  - hydrogen tanks: CubeBlocks_Logistics.sbc (`Capacity` litres)
 *  - hydrogen energy density: Sources/SpaceEngineers/Content/Data/GasProperties.sbc
 *    (`EnergyDensity` 0.001556 MWh/litre). A thruster's fuel input is
 *    `MaxPowerConsumption / (Efficiency * EnergyDensity)` at full throttle
 *    (MyEntityThrustComponent.PowerAmountToFuel), so the burn rate is derived,
 *    not guessed.
 */

export type ThrusterKind = 'atmo' | 'ion' | 'h2';
export type GridSize = 'large' | 'small';

export interface ThrusterDefinition {
  subtype: string;
  size: GridSize;
  kind: ThrusterKind;
  forceN: number;
  /** MaxPowerConsumption, MW (electric for ion/atmo, fuel-converter power for H2). */
  powerMW: number;
}

export const HYDROGEN_ENERGY_DENSITY_MWH_PER_L = 0.001556;

/** Stock thrusters. All values exact from the definitions. */
export const THRUSTER_DEFINITIONS: Record<string, ThrusterDefinition> = {
  LargeBlockLargeThrust: { subtype: 'LargeBlockLargeThrust', size: 'large', kind: 'ion', forceN: 4_320_000, powerMW: 33.6 },
  LargeBlockSmallThrust: { subtype: 'LargeBlockSmallThrust', size: 'large', kind: 'ion', forceN: 345_600, powerMW: 3.36 },
  LargeBlockLargeHydrogenThrust: { subtype: 'LargeBlockLargeHydrogenThrust', size: 'large', kind: 'h2', forceN: 7_200_000, powerMW: 7.5 },
  LargeBlockSmallHydrogenThrust: { subtype: 'LargeBlockSmallHydrogenThrust', size: 'large', kind: 'h2', forceN: 1_080_000, powerMW: 1.25 },
  LargeBlockLargeAtmosphericThrust: { subtype: 'LargeBlockLargeAtmosphericThrust', size: 'large', kind: 'atmo', forceN: 6_480_000, powerMW: 16.8 },
  LargeBlockSmallAtmosphericThrust: { subtype: 'LargeBlockSmallAtmosphericThrust', size: 'large', kind: 'atmo', forceN: 648_000, powerMW: 2.4 },
  LargeBlockLargeFlatAtmosphericThrust: { subtype: 'LargeBlockLargeFlatAtmosphericThrust', size: 'large', kind: 'atmo', forceN: 2_600_000, powerMW: 6.7 },
  SmallBlockSmallThrust: { subtype: 'SmallBlockSmallThrust', size: 'small', kind: 'ion', forceN: 14_400, powerMW: 0.2 },
  SmallBlockLargeThrust: { subtype: 'SmallBlockLargeThrust', size: 'small', kind: 'ion', forceN: 172_800, powerMW: 2.4 },
  SmallBlockLargeHydrogenThrust: { subtype: 'SmallBlockLargeHydrogenThrust', size: 'small', kind: 'h2', forceN: 480_000, powerMW: 0.6 },
  SmallBlockSmallHydrogenThrust: { subtype: 'SmallBlockSmallHydrogenThrust', size: 'small', kind: 'h2', forceN: 98_400, powerMW: 0.125 },
  SmallBlockLargeAtmosphericThrust: { subtype: 'SmallBlockLargeAtmosphericThrust', size: 'small', kind: 'atmo', forceN: 576_000, powerMW: 2.4 },
  SmallBlockSmallAtmosphericThrust: { subtype: 'SmallBlockSmallAtmosphericThrust', size: 'small', kind: 'atmo', forceN: 96_000, powerMW: 0.6 },
};

export interface BatteryDefinition {
  subtype: string;
  capacityMWh: number;
  outputMW: number;
}

export const BATTERY_DEFINITIONS: Record<string, BatteryDefinition> = {
  LargeBlockBatteryBlock: { subtype: 'LargeBlockBatteryBlock', capacityMWh: 3, outputMW: 12 },
  SmallBlockBatteryBlock: { subtype: 'SmallBlockBatteryBlock', capacityMWh: 1, outputMW: 4 },
  SmallBlockSmallBatteryBlock: { subtype: 'SmallBlockSmallBatteryBlock', capacityMWh: 0.05, outputMW: 0.2 },
};

export const SOLAR_PANEL_DEFINITIONS: Record<string, { subtype: string; peakMW: number }> = {
  LargeBlockSolarPanel: { subtype: 'LargeBlockSolarPanel', peakMW: 0.16 },
  SmallBlockSolarPanel: { subtype: 'SmallBlockSolarPanel', peakMW: 0.04 },
};

export const HYDROGEN_TANK_DEFINITIONS: Record<string, { subtype: string; capacityL: number }> = {
  LargeHydrogenTank: { subtype: 'LargeHydrogenTank', capacityL: 15_000_000 },
  LargeHydrogenTankSmall: { subtype: 'LargeHydrogenTankSmall', capacityL: 1_000_000 },
  SmallHydrogenTank: { subtype: 'SmallHydrogenTank', capacityL: 500_000 },
  SmallHydrogenTankSmall: { subtype: 'SmallHydrogenTankSmall', capacityL: 15_000 },
};

/**
 * Influence curve shared by every stock thruster of a type. The definitions
 * carry these values on each block; no stock block deviates.
 */
export const INFLUENCE: Record<ThrusterKind, { min: number; max: number; effMin: number; effMax: number }> = {
  ion: { min: 0, max: 1, effMin: 1, effMax: 0.2 },
  atmo: { min: 0.3, max: 1, effMin: 0, effMax: 1 },
  h2: { min: 0, max: 1, effMin: 1, effMax: 1 },
};

/** A bank of identical thrusters: nominal force and electric draw at 100 %. */
export interface ThrusterBank {
  forceN: number;
  powerMW: number;
  count: number;
}

export interface BankCounts {
  atmo?: Record<string, number>;
  ion?: Record<string, number>;
  h2?: Record<string, number>;
}

export function bankFromCounts(counts: Record<string, number> | undefined): ThrusterBank {
  if (!counts) return { forceN: 0, powerMW: 0, count: 0 };
  let forceN = 0;
  let powerMW = 0;
  let count = 0;
  for (const [subtype, n] of Object.entries(counts)) {
    const def = THRUSTER_DEFINITIONS[subtype];
    if (!def) throw new Error(`unknown thruster subtype ${subtype}`);
    forceN += def.forceN * n;
    powerMW += def.powerMW * n;
    count += n;
  }
  return { forceN, powerMW, count };
}

/** Hardware authored from the definitions, used by tests/docs examples. */
export interface HullHardwareSpec {
  id: string;
  name: string;
  gridSize: GridSize;
  /** Measured grid mass where available; otherwise an ASSUMPTION. */
  massKg: number;
  massSource: 'measured' | 'assumption';
  thrustCounts: BankCounts;
  reactorMW: number;
  batteryCounts?: Record<string, number>;
  solarCounts?: Record<string, number>;
  h2TankCounts?: Record<string, number>;
  /** Fill ratios 0..1; 1 = full. */
  h2Fill?: number;
  batteryFill?: number;
}

/**
 * Measured prefab hardware. Mass comes from the measured capability profiles in
 * `demo/hulls.ts`; block counts come from the prefab survey
 * (`data/prefab-candidates.json`, produced from the CubeBlocks definitions).
 */
export const PREFAB_HARDWARE: Record<string, HullHardwareSpec> = {
  'Eradicator_mk.1': {
    id: 'Eradicator_mk.1',
    name: 'Eradicator mk.1',
    gridSize: 'large',
    massKg: 2_071_825,
    massSource: 'measured',
    thrustCounts: { ion: { LargeBlockLargeThrust: 1, LargeBlockSmallThrust: 48 } },
    reactorMW: 300,
  },
  'Large Control Drone': {
    id: 'Large Control Drone',
    name: 'Large Control Drone',
    gridSize: 'large',
    massKg: 222_711,
    massSource: 'measured',
    thrustCounts: { atmo: { LargeBlockSmallAtmosphericThrust: 19 } },
    reactorMW: 0,
    batteryCounts: { LargeBlockBatteryBlock: 6 },
    batteryFill: 1,
  },
  'Escort TT-420': {
    id: 'Escort TT-420',
    name: 'Escort TT-420',
    gridSize: 'large',
    massKg: 305_085,
    massSource: 'measured',
    thrustCounts: {
      atmo: { LargeBlockLargeAtmosphericThrust: 2, LargeBlockSmallAtmosphericThrust: 8 },
      h2: { LargeBlockLargeHydrogenThrust: 1, LargeBlockSmallHydrogenThrust: 6 },
    },
    reactorMW: 15,
    batteryCounts: { LargeBlockBatteryBlock: 6 },
    h2TankCounts: { LargeHydrogenTank: 1 },
    h2Fill: 0.9996,
    batteryFill: 1,
  },
};

export function bankMWh(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const [subtype, n] of Object.entries(counts)) {
    const def = BATTERY_DEFINITIONS[subtype];
    if (!def) throw new Error(`unknown battery subtype ${subtype}`);
    total += def.capacityMWh * n;
  }
  return total;
}

export function solarPeakMW(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const [subtype, n] of Object.entries(counts)) {
    const def = SOLAR_PANEL_DEFINITIONS[subtype];
    if (!def) throw new Error(`unknown solar subtype ${subtype}`);
    total += def.peakMW * n;
  }
  return total;
}

export function tankLitres(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const [subtype, n] of Object.entries(counts)) {
    const def = HYDROGEN_TANK_DEFINITIONS[subtype];
    if (!def) throw new Error(`unknown tank subtype ${subtype}`);
    total += def.capacityL * n;
  }
  return total;
}

/**
 * Small-grid examples built strictly from definition data (mass is an
 * ASSUMPTION: a 1,000 kg bus plus thrusters/tank/battery mass). Used in
 * the endurance model and the tests, not by the live prefab catalog.
 */
export const SMALL_GRID_EXAMPLES: Record<string, HullHardwareSpec> = {
  'example:ion-solar-sat': {
    id: 'example:ion-solar-sat',
    name: 'Small-grid ion + solar satellite',
    gridSize: 'small',
    massKg: 10_000,
    massSource: 'assumption',
    thrustCounts: { ion: { SmallBlockLargeThrust: 2 } },
    reactorMW: 0,
    batteryCounts: { SmallBlockBatteryBlock: 2 },
    solarCounts: { SmallBlockSolarPanel: 4 },
    batteryFill: 1,
  },
  'example:h2-sat': {
    id: 'example:h2-sat',
    name: 'Small-grid hydrogen satellite',
    gridSize: 'small',
    massKg: 10_000,
    massSource: 'assumption',
    thrustCounts: { h2: { SmallBlockLargeHydrogenThrust: 1 } },
    reactorMW: 0,
    batteryCounts: { SmallBlockSmallBatteryBlock: 1 },
    h2TankCounts: { SmallHydrogenTank: 1 },
    h2Fill: 1,
    batteryFill: 1,
  },
};
