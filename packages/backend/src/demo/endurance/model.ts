/**
 * Propulsion / energy endurance model (T6).
 *
 * Answers, for one hull and one slot:
 *   - can it get there (ascent + transit), with how much fuel/charge left?
 *   - how long can it hold station there (gravity, thrust type, power)?
 *
 * Everything that comes from a CubeBlocks definition is sourced in
 * `definitions.ts`. Items that are game-tuning choices, not definition values,
 * are marked ASSUMPTION and repeated in `ENDURANCE_ASSUMPTIONS`.
 *
 * Formulas
 * --------
 * air density (MyPlanet.GetAirDensity):
 *   rate = clamp(1 - (r - AverageRadius) / AtmosphereAltitude, 0, 1)
 *   AtmosphereAltitude = MaxHillHeight * LimitAltitude
 *   MaxHillHeight      = AverageRadius * HillParams.Max
 * EarthLike: AverageRadius 60,000 m, HillParams.Max 0.12, LimitAltitude 2.0
 *         -> atmosphere top 14,400 m above the average radius.
 *
 * planetary influence = air density (0..1, scaled by the generator Density).
 * thruster effectiveness (MyThrusterBlockThrustComponent.CalculateForceMultiplier):
 *   eff = lerp(effMin, effMax, clamp((influence - min)/(max - min), 0, 1))
 *   ion  1.0 -> 0.2   (weak in air)
 *   atmo 0.0 -> 1.0   (dead below 0.3 influence = above the atmosphere)
 *   h2   constant 1.0
 *
 * hydrogen burn at throttle t (MyEntityThrustComponent.PowerAmountToFuel):
 *   L/s = t * MaxPowerConsumptionMW / (Efficiency * EnergyDensity)
 *   EnergyDensity 0.001556 MWh/L, Efficiency 1 (LargeBlock*HydrogenThrust).
 *
 * electric draw at throttle t: t * MaxPowerConsumptionMW (ion/atmo).
 *
 * solar input = peakMW * insolation; insolation is an ASSUMPTION (0.5) because
 * planet shadow and panel orientation are not known from definitions.
 */
import type { Planet } from '@se-rts/schemas';
import { gravityAtAltitude, planetGravity, gravityFreeAltitudeM } from '../designer/gravity.js';
import {
  HYDROGEN_ENERGY_DENSITY_MWH_PER_L,
  INFLUENCE,
  bankFromCounts,
  bankMWh,
  solarPeakMW,
  tankLitres,
  type GridSize,
  type HullHardwareSpec,
  type ThrusterBank,
  type ThrusterKind,
} from './definitions.js';

/** Grid speed cap in the demo (space engineers default for large/small grids). */
export const CRUISE_SPEED_MPS = 100;
/** Average solar insolation over an orbit, including planet shadow. ASSUMPTION. */
export const SOLAR_INSOLATION = 0.5;
/** Ascent integration step, seconds. */
export const ASCENT_STEP_S = 1;
/** Hard bound so a pathological TWR cannot loop forever. */
const MAX_ASCENT_S = 4 * 3600;
/** Prefix for outputs where a value is not a definition value. */
export const ASSUMPTION = 'ASSUMPTION';

export const ENDURANCE_ASSUMPTIONS = [
  {
    id: 'insolation',
    text: 'solar input is 50 % of panel peak (planet shadow and panel orientation are unknown)',
    status: ASSUMPTION,
  },
  {
    id: 'speed_cap',
    text: 'ascent and transit are capped at the stock 100 m/s grid speed; drag is not modelled',
    status: ASSUMPTION,
  },
  {
    id: 'mass_constant',
    text: 'grid mass is constant during flight (burned hydrogen mass is small compared with the grid)',
    status: ASSUMPTION,
  },
  {
    id: 'atmosphere_shape',
    text: 'atmosphere height uses HillParams.Max 0.12 and LimitAltitude 2.0 from the planet generator; all atmosphere bodies in this world share them',
    status: 'DEFINITION-DERIVED',
  },
  {
    id: 'orbital_spawn',
    text: 'a hull that cannot lift from the surface is spawned at 40 km AGL, or at the slot altitude when that is lower',
    status: ASSUMPTION,
  },
] as const;

export interface EnduranceHull {
  id: string;
  name: string;
  gridSize: GridSize;
  massKg: number;
  massSource: 'measured' | 'assumption';
  thrust: Record<ThrusterKind, ThrusterBank>;
  reactorMW: number;
  batteryMWh: number;
  batteryOutputMW: number;
  solarPeakMW: number;
  h2CapacityL: number;
  h2Fill: number;
  batteryFill: number;
}

export function hullFromSpec(spec: HullHardwareSpec): EnduranceHull {
  const batteryCounts = spec.batteryCounts ?? {};
  let batteryOutputMW = 0;
  for (const [subtype, n] of Object.entries(batteryCounts)) {
    // Output is definition data; kept local to avoid importing another table.
    const perBlock: Record<string, number> = {
      LargeBlockBatteryBlock: 12,
      SmallBlockBatteryBlock: 4,
      SmallBlockSmallBatteryBlock: 0.2,
    };
    batteryOutputMW += (perBlock[subtype] ?? 0) * n;
  }
  return {
    id: spec.id,
    name: spec.name,
    gridSize: spec.gridSize,
    massKg: spec.massKg,
    massSource: spec.massSource,
    thrust: {
      atmo: bankFromCounts(spec.thrustCounts.atmo),
      ion: bankFromCounts(spec.thrustCounts.ion),
      h2: bankFromCounts(spec.thrustCounts.h2),
    },
    reactorMW: spec.reactorMW,
    batteryMWh: bankMWh(batteryCounts),
    batteryOutputMW,
    solarPeakMW: solarPeakMW(spec.solarCounts),
    h2CapacityL: tankLitres(spec.h2TankCounts),
    h2Fill: spec.h2Fill ?? 1,
    batteryFill: spec.batteryFill ?? 1,
  };
}

/** Density multiplier from the planet generator (`Atmosphere.Density`). */
const ATMOSPHERE_DENSITY: Record<string, number> = {
  EarthLike: 1.0,
  Alien: 1.2,
  Mars: 1.0,
};

/** HillParams.Max and Atmosphere.LimitAltitude (planet generator). */
const HILL_MAX = 0.12;
const LIMIT_ALTITUDE = 2.0;

export function hasAtmosphere(planet: Planet): boolean {
  return planet.hasAtmosphere && (ATMOSPHERE_DENSITY[planet.name] ?? 0) > 0;
}

/**
 * Average radius the game uses for the air-density ramp. MaximumHillRadius is
 * AverageRadius * (1 + HillParams.Max); with Max 0.12 this recovers 60,000 m
 * for EarthLike.
 */
export function averageRadiusM(planet: Planet): number {
  return planet.maxHillRadiusM / (1 + HILL_MAX);
}

/** Top of the usable atmosphere, metres AGL above MinimumSurfaceRadius. */
export function atmosphereTopAltitudeM(planet: Planet): number {
  if (!hasAtmosphere(planet)) return 0;
  const average = averageRadiusM(planet);
  const height = average * HILL_MAX;
  return Math.max(0, average + height * LIMIT_ALTITUDE - planet.surfaceRadiusM);
}

/** Air density 0..Density at an altitude above MinimumSurfaceRadius. */
export function airDensity(planet: Planet, altitudeM: number): number {
  if (!hasAtmosphere(planet)) return 0;
  const density = ATMOSPHERE_DENSITY[planet.name] ?? 1.0;
  const average = averageRadiusM(planet);
  const top = average * HILL_MAX * LIMIT_ALTITUDE;
  const relative = planet.surfaceRadiusM + altitudeM - average;
  const rate = Math.min(1, Math.max(0, 1 - relative / top));
  return rate * density;
}

export function effectiveness(kind: ThrusterKind, density: number): number {
  const curve = INFLUENCE[kind];
  const influence = Math.min(1, Math.max(0, density));
  if (curve.max === curve.min) return curve.effMax;
  const t = Math.min(1, Math.max(0, (influence - curve.min) / (curve.max - curve.min)));
  return curve.effMin + (curve.effMax - curve.effMin) * t;
}

export interface ThrustAtAltitude {
  density: number;
  effectiveness: Record<ThrusterKind, number>;
  forceN: Record<ThrusterKind, number>;
  totalN: number;
}

export function thrustAtAltitude(hull: EnduranceHull, planet: Planet, altitudeM: number): ThrustAtAltitude {
  const density = airDensity(planet, altitudeM);
  const eff: Record<ThrusterKind, number> = {
    atmo: effectiveness('atmo', density),
    ion: effectiveness('ion', density),
    h2: effectiveness('h2', density),
  };
  const forceN: Record<ThrusterKind, number> = {
    atmo: hull.thrust.atmo.forceN * eff.atmo,
    ion: hull.thrust.ion.forceN * eff.ion,
    h2: hull.thrust.h2.forceN * eff.h2,
  };
  return {
    density,
    effectiveness: eff,
    forceN,
    totalN: forceN.atmo + forceN.ion + forceN.h2,
  };
}

export interface Allocation {
  /** Commanded force per bank, N. */
  forceN: Record<ThrusterKind, number>;
  powerMW: number;
  h2BurnLps: number;
  /** True when the request exceeded what the banks can deliver. */
  saturated: boolean;
}

/**
 * Split a commanded force across thrust types. Atmosphere first (no fuel),
 * then ion (electric), hydrogen last (consumes the finite tank).
 */
export function allocateThrust(hull: EnduranceHull, available: ThrustAtAltitude, requiredN: number): Allocation {
  let remaining = Math.max(0, requiredN);
  const out: Record<ThrusterKind, number> = { atmo: 0, ion: 0, h2: 0 };
  for (const kind of ['atmo', 'ion', 'h2'] as ThrusterKind[]) {
    const take = Math.min(remaining, available.forceN[kind]);
    out[kind] = take;
    remaining -= take;
  }
  const throttle = (kind: ThrusterKind): number => {
    const nominal = hull.thrust[kind].forceN;
    return nominal > 0 ? out[kind] / nominal : 0;
  };
  const powerMW =
    throttle('atmo') * hull.thrust.atmo.powerMW + throttle('ion') * hull.thrust.ion.powerMW;
  const h2BurnLps =
    hull.thrust.h2.forceN > 0
      ? (throttle('h2') * hull.thrust.h2.powerMW) / HYDROGEN_ENERGY_DENSITY_MWH_PER_L
      : 0;
  return { forceN: out, powerMW, h2BurnLps, saturated: remaining > 0.5 };
}

export interface PowerBudget {
  generationMW: number;
  drawMW: number;
  /** Positive = battery charges, negative = battery discharges. */
  netMW: number;
  batteryDischargeMW: number;
  solarMW: number;
}

export function powerBudget(hull: EnduranceHull, drawMW: number): PowerBudget {
  const solarMW = hull.solarPeakMW * SOLAR_INSOLATION;
  const generationMW = hull.reactorMW + solarMW;
  const netMW = generationMW - drawMW;
  const batteryDischargeMW = Math.max(0, Math.min(-netMW, hull.batteryOutputMW));
  return { generationMW, drawMW, netMW, batteryDischargeMW, solarMW };
}

export interface SlotPhysics {
  altitudeM: number;
  gravityMps2: number;
  density: number;
  available: ThrustAtAltitude;
  requiredThrustN: number;
  twr: number | null;
  canHover: boolean;
  hover: Allocation | null;
  power: PowerBudget | null;
  /** Seconds the current charge/fuel can sustain the hover, or 'indefinite'. */
  holdEnduranceS: number | 'indefinite';
  limiting: 'gravity-free' | 'solar+reactor' | 'reactor' | 'battery' | 'h2' | 'none';
}

export function slotPhysics(
  hull: EnduranceHull,
  planet: Planet,
  altitudeM: number,
  state: { batteryMWh: number; h2L: number } = {
    batteryMWh: hull.batteryMWh * hull.batteryFill,
    h2L: hull.h2CapacityL * hull.h2Fill,
  },
): SlotPhysics {
  const gravityMps2 = gravityAtAltitude(planetGravity(planet), altitudeM);
  const available = thrustAtAltitude(hull, planet, altitudeM);
  const requiredThrustN = hull.massKg * gravityMps2;
  const twr = requiredThrustN > 0 ? available.totalN / requiredThrustN : null;
  if (requiredThrustN <= 0.001) {
    return {
      altitudeM,
      gravityMps2,
      density: available.density,
      available,
      requiredThrustN: 0,
      twr,
      canHover: true,
      hover: { forceN: { atmo: 0, ion: 0, h2: 0 }, powerMW: 0, h2BurnLps: 0, saturated: false },
      power: powerBudget(hull, 0),
      holdEnduranceS: 'indefinite',
      limiting: 'gravity-free',
    };
  }
  if (available.totalN < requiredThrustN) {
    return {
      altitudeM,
      gravityMps2,
      density: available.density,
      available,
      requiredThrustN,
      twr,
      canHover: false,
      hover: null,
      power: null,
      holdEnduranceS: 0,
      limiting: 'none',
    };
  }
  const hover = allocateThrust(hull, available, requiredThrustN);
  const power = powerBudget(hull, hover.powerMW);
  let batteryEnduranceS = Number.POSITIVE_INFINITY;
  if (power.netMW < 0) {
    if (power.batteryDischargeMW + 1e-9 < -power.netMW) batteryEnduranceS = 0;
    else batteryEnduranceS = (state.batteryMWh / -power.netMW) * 3600;
  }
  let fuelEnduranceS = Number.POSITIVE_INFINITY;
  if (hover.h2BurnLps > 0) fuelEnduranceS = state.h2L / hover.h2BurnLps;
  const batteryCanRecharge = power.netMW >= 0;
  let holdEnduranceS: number | 'indefinite' = Math.min(batteryEnduranceS, fuelEnduranceS);
  let limiting: SlotPhysics['limiting'] = fuelEnduranceS <= batteryEnduranceS ? 'h2' : 'battery';
  if (batteryCanRecharge && fuelEnduranceS === Number.POSITIVE_INFINITY) {
    holdEnduranceS = 'indefinite';
    limiting = power.solarMW > 0 ? 'solar+reactor' : 'reactor';
  }
  return {
    altitudeM,
    gravityMps2,
    density: available.density,
    available,
    requiredThrustN,
    twr,
    canHover: true,
    hover,
    power,
    holdEnduranceS,
    limiting,
  };
}

export interface AscentResult {
  ok: boolean;
  startAltitudeM: number;
  targetAltitudeM: number;
  timeS: number;
  speedMps: number;
  h2UsedL: number;
  batteryUsedMWh: number;
  batteryRemainingMWh: number;
  h2RemainingL: number;
  failureReason: string | null;
  /** Peak thrust-to-weight seen during the climb (informative). */
  minTwr: number;
}

export function simulateAscent(args: {
  hull: EnduranceHull;
  planet: Planet;
  targetAltitudeM: number;
  startAltitudeM?: number;
  batteryMWh?: number;
  h2L?: number;
  dt?: number;
  speedCap?: number;
}): AscentResult {
  const { hull, planet, targetAltitudeM } = args;
  const dt = args.dt ?? ASCENT_STEP_S;
  const speedCap = args.speedCap ?? CRUISE_SPEED_MPS;
  const startAltitudeM = Math.max(0, Math.min(args.startAltitudeM ?? 0, targetAltitudeM));
  let batteryMWh = args.batteryMWh ?? hull.batteryMWh * hull.batteryFill;
  let h2L = args.h2L ?? hull.h2CapacityL * hull.h2Fill;
  const batteryStart = batteryMWh;

  let altitude = startAltitudeM;
  let speed = 0;
  let timeS = 0;
  let minTwr = Number.POSITIVE_INFINITY;

  if (targetAltitudeM <= startAltitudeM + 0.5) {
    return {
      ok: true,
      startAltitudeM,
      targetAltitudeM,
      timeS: 0,
      speedMps: 0,
      h2UsedL: 0,
      batteryUsedMWh: 0,
      batteryRemainingMWh: batteryMWh,
      h2RemainingL: h2L,
      failureReason: null,
      minTwr: hull.massKg > 0 ? thrustAtAltitude(hull, planet, startAltitudeM).totalN / (hull.massKg * Math.max(gravityAtAltitude(planetGravity(planet), startAltitudeM), 1e-9)) : 0,
    };
  }

  while (timeS < MAX_ASCENT_S) {
    const gravity = gravityAtAltitude(planetGravity(planet), altitude);
    const available = thrustAtAltitude(hull, planet, altitude);
    const weightN = hull.massKg * gravity;
    const twr = weightN > 0 ? available.totalN / weightN : Number.POSITIVE_INFINITY;
    if (Number.isFinite(twr)) minTwr = Math.min(minTwr, twr);
    if (weightN > 0 && available.totalN <= weightN) {
      const kinds = (['atmo', 'ion', 'h2'] as ThrusterKind[])
        .filter((k) => hull.thrust[k].forceN > 0)
        .map((k) => `${k} TWR ${(available.forceN[k] / weightN).toFixed(2)}`);
      return {
        ok: false,
        startAltitudeM,
        targetAltitudeM,
        timeS,
        speedMps: speed,
        h2UsedL: hull.h2CapacityL * hull.h2Fill - h2L,
        batteryUsedMWh: batteryStart - batteryMWh,
        batteryRemainingMWh: batteryMWh,
        h2RemainingL: h2L,
        failureReason:
          `${kinds.join(', ') || 'no thrust'} at ${(altitude / 1000).toFixed(1)} km: ` +
          `available ${(available.totalN / 1e6).toFixed(2)} MN < weight ${(weightN / 1e6).toFixed(2)} MN`,
        minTwr: Number.isFinite(minTwr) ? minTwr : 0,
      };
    }
    const maxAccel = available.totalN / hull.massKg - gravity;
    const accel = Math.max(0, Math.min(maxAccel, (speedCap - speed) / dt));
    const commandedN = Math.min(available.totalN, hull.massKg * (gravity + accel));
    const allocation = allocateThrust(hull, available, commandedN);
    const power = powerBudget(hull, allocation.powerMW);

    // Energy and fuel for this step.
    let stepBattery = 0;
    if (power.netMW < 0) {
      stepBattery = (-power.netMW * dt) / 3600;
      if (power.batteryDischargeMW + 1e-9 < -power.netMW) {
        return {
          ok: false,
          startAltitudeM,
          targetAltitudeM,
          timeS,
          speedMps: speed,
          h2UsedL: hull.h2CapacityL * hull.h2Fill - h2L,
          batteryUsedMWh: batteryStart - batteryMWh,
          batteryRemainingMWh: batteryMWh,
          h2RemainingL: h2L,
          failureReason: `battery output ${hull.batteryOutputMW} MW cannot cover ${(-power.netMW).toFixed(1)} MW at ${(altitude / 1000).toFixed(1)} km`,
          minTwr: Number.isFinite(minTwr) ? minTwr : 0,
        };
      }
      if (stepBattery > batteryMWh + 1e-9) {
        return {
          ok: false,
          startAltitudeM,
          targetAltitudeM,
          timeS,
          speedMps: speed,
          h2UsedL: hull.h2CapacityL * hull.h2Fill - h2L,
          batteryUsedMWh: batteryStart - batteryMWh,
          batteryRemainingMWh: 0,
          h2RemainingL: h2L,
          failureReason: `battery exhausted at ${(altitude / 1000).toFixed(1)} km`,
          minTwr: Number.isFinite(minTwr) ? minTwr : 0,
        };
      }
      batteryMWh -= stepBattery;
    } else if (hull.batteryMWh > 0) {
      batteryMWh = Math.min(hull.batteryMWh, batteryMWh + (power.netMW * dt) / 3600);
    }

    const stepH2 = allocation.h2BurnLps * dt;
    if (stepH2 > h2L + 1e-9) {
      return {
        ok: false,
        startAltitudeM,
        targetAltitudeM,
        timeS,
        speedMps: speed,
        h2UsedL: hull.h2CapacityL * hull.h2Fill,
        batteryUsedMWh: batteryStart - batteryMWh,
        batteryRemainingMWh: batteryMWh,
        h2RemainingL: 0,
        failureReason: `H2 exhausted at ${(altitude / 1000).toFixed(1)} km`,
        minTwr: Number.isFinite(minTwr) ? minTwr : 0,
      };
    }
    h2L -= stepH2;

    speed = Math.min(speedCap, speed + (commandedN / hull.massKg - gravity) * dt);
    altitude += speed * dt;
    timeS += dt;
    if (altitude >= targetAltitudeM) {
      return {
        ok: true,
        startAltitudeM,
        targetAltitudeM,
        timeS,
        speedMps: speed,
        h2UsedL: hull.h2CapacityL * hull.h2Fill - h2L,
        batteryUsedMWh: batteryStart - batteryMWh,
        batteryRemainingMWh: batteryMWh,
        h2RemainingL: h2L,
        failureReason: null,
        minTwr: Number.isFinite(minTwr) ? minTwr : 0,
      };
    }
  }
  return {
    ok: false,
    startAltitudeM,
    targetAltitudeM,
    timeS,
    speedMps: speed,
    h2UsedL: hull.h2CapacityL * hull.h2Fill - h2L,
    batteryUsedMWh: batteryStart - batteryMWh,
    batteryRemainingMWh: batteryMWh,
    h2RemainingL: h2L,
    failureReason: `ascent did not reach ${(targetAltitudeM / 1000).toFixed(0)} km within ${MAX_ASCENT_S / 3600} h`,
    minTwr: Number.isFinite(minTwr) ? minTwr : 0,
  };
}

/**
 * Level-flight leg. In vacuum (no gravity) the leg is coasting and costs no
 * fuel; inside a gravity well it costs the same thrust as a hold.
 */
export function simulateTransit(args: {
  hull: EnduranceHull;
  planet: Planet;
  altitudeM: number;
  distanceM: number;
  batteryMWh: number;
  h2L: number;
  cruiseSpeedMps?: number;
}): { timeS: number; h2UsedL: number; batteryUsedMWh: number; batteryRemainingMWh: number; h2RemainingL: number; failureReason: string | null } {
  const speed = args.cruiseSpeedMps ?? CRUISE_SPEED_MPS;
  const timeS = speed > 0 ? args.distanceM / speed : 0;
  const gravity = gravityAtAltitude(planetGravity(args.planet), args.altitudeM);
  if (gravity <= 0.001 || timeS === 0) {
    return { timeS, h2UsedL: 0, batteryUsedMWh: 0, batteryRemainingMWh: args.batteryMWh, h2RemainingL: args.h2L, failureReason: null };
  }
  const available = thrustAtAltitude(args.hull, args.planet, args.altitudeM);
  const requiredN = args.hull.massKg * gravity;
  if (available.totalN < requiredN) {
    return {
      timeS,
      h2UsedL: 0,
      batteryUsedMWh: 0,
      batteryRemainingMWh: args.batteryMWh,
      h2RemainingL: args.h2L,
      failureReason: `cannot hold altitude for transit at ${(args.altitudeM / 1000).toFixed(1)} km (thrust below weight)`,
    };
  }
  const allocation = allocateThrust(args.hull, available, requiredN);
  const power = powerBudget(args.hull, allocation.powerMW);
  const h2UsedL = allocation.h2BurnLps * timeS;
  const deficitMW = Math.max(0, -power.netMW);
  const batteryUsedMWh = (deficitMW * timeS) / 3600;
  if (h2UsedL > args.h2L + 1e-9) {
    return { timeS, h2UsedL: args.h2L, batteryUsedMWh: 0, batteryRemainingMWh: args.batteryMWh, h2RemainingL: 0, failureReason: `H2 exhausted during transit at ${(args.altitudeM / 1000).toFixed(1)} km` };
  }
  if (batteryUsedMWh > args.batteryMWh + 1e-9) {
    return { timeS, h2UsedL, batteryUsedMWh: args.batteryMWh, batteryRemainingMWh: 0, h2RemainingL: args.h2L - h2UsedL, failureReason: `battery exhausted during transit at ${(args.altitudeM / 1000).toFixed(1)} km` };
  }
  return {
    timeS,
    h2UsedL,
    batteryUsedMWh,
    batteryRemainingMWh: args.batteryMWh - batteryUsedMWh,
    h2RemainingL: args.h2L - h2UsedL,
    failureReason: null,
  };
}

export type HoldEndurance = number | 'indefinite';

export interface EnduranceReport {
  hullId: string;
  hullName: string;
  gridSize: GridSize;
  massKg: number;
  massSource: 'measured' | 'assumption';
  planet: string;
  altitudeM: number;
  gravityMps2: number;
  airDensity: number;
  launch: 'surface' | 'orbital';
  launchAltitudeM: number;
  canReachSlot: boolean;
  ascentTimeS: number | null;
  transitTimeS: number | null;
  etaS: number | null;
  fuelUsedPct: number;
  batteryUsedPct: number;
  reservePct: number;
  holdEnduranceS: HoldEndurance;
  holdEnduranceText: string;
  holdLimiting: SlotPhysics['limiting'] | 'ascent';
  holdPowerMW: number | null;
  holdH2BurnLps: number | null;
  twrAtSlot: number | null;
  thrustAtSlotN: number;
  requiredThrustN: number;
  failureReason: string | null;
  recommendation: string;
  assumptions: string[];
  labels: string[];
}

/** Human duration: 2 h 05 m, 36 s, 'indefinite'. */
export function formatDuration(value: HoldEndurance): string {
  if (value === 'indefinite') return 'indefinite';
  if (!Number.isFinite(value)) return 'indefinite';
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Surface launch is only possible when the hull beats gravity at 0 m. */
export function canSurfaceLaunch(hull: EnduranceHull, planet: Planet): boolean {
  const g = gravityAtAltitude(planetGravity(planet), 0);
  const available = thrustAtAltitude(hull, planet, 0).totalN;
  return available > hull.massKg * g * 1.05;
}

/**
 * Evaluate one hull at one slot.
 *
 * `transitDistanceM` is the ground/arc distance from the launch point to the
 * slot; the planner passes the farthest slot so every satellite in the option
 * is covered by the same ETA/reserve.
 */
export function evaluateHullAtSlot(args: {
  hull: EnduranceHull;
  planet: Planet;
  altitudeM: number;
  transitDistanceM?: number;
  launch?: 'surface' | 'orbital';
  reservePct?: number;
  speedCap?: number;
}): EnduranceReport {
  const { hull, planet } = args;
  const altitudeM = Math.max(0, Math.round(args.altitudeM));
  const launch = args.launch ?? (canSurfaceLaunch(hull, planet) ? 'surface' : 'orbital');
  const launchAltitudeM =
    launch === 'surface' ? 0 : Math.max(0, Math.min(40_000, altitudeM));
  const transitDistanceM = Math.max(0, args.transitDistanceM ?? 0);

  const ascent = simulateAscent({
    hull,
    planet,
    targetAltitudeM: altitudeM,
    startAltitudeM: launchAltitudeM,
    speedCap: args.speedCap,
  });
  if (!ascent.ok) {
    const slot = slotPhysics(hull, planet, altitudeM, {
      batteryMWh: ascent.batteryRemainingMWh,
      h2L: ascent.h2RemainingL,
    });
    return {
      hullId: hull.id,
      hullName: hull.name,
      gridSize: hull.gridSize,
      massKg: hull.massKg,
      massSource: hull.massSource,
      planet: planet.name,
      altitudeM,
      gravityMps2: round(slot.gravityMps2, 3),
      airDensity: round(slot.density, 4),
      launch,
      launchAltitudeM,
      canReachSlot: false,
      ascentTimeS: null,
      transitTimeS: null,
      etaS: null,
      fuelUsedPct: pct(hull.h2CapacityL * hull.h2Fill - ascent.h2RemainingL, hull.h2CapacityL * hull.h2Fill),
      batteryUsedPct: pct(hull.batteryMWh * hull.batteryFill - ascent.batteryRemainingMWh, hull.batteryMWh * hull.batteryFill),
      reservePct: 0,
      holdEnduranceS: slot.holdEnduranceS,
      holdEnduranceText: formatDuration(slot.holdEnduranceS),
      holdLimiting: 'ascent',
      holdPowerMW: slot.hover ? round(slot.hover.powerMW, 2) : null,
      holdH2BurnLps: slot.hover ? round(slot.hover.h2BurnLps, 1) : null,
      twrAtSlot: slot.twr === null ? null : round(slot.twr, 2),
      thrustAtSlotN: Math.round(slot.available.totalN),
      requiredThrustN: Math.round(slot.requiredThrustN),
      failureReason: ascent.failureReason,
      recommendation: recommendationFor({ hull, planet, altitudeM, launch, launchAltitudeM, canReach: false, ascent }),
      assumptions: assumptionIds(),
      labels: ['SIMULATED', 'ENDURANCE-MODEL'],
    };
  }

  const transit = simulateTransit({
    hull,
    planet,
    altitudeM,
    distanceM: transitDistanceM,
    batteryMWh: ascent.batteryRemainingMWh,
    h2L: ascent.h2RemainingL,
    cruiseSpeedMps: args.speedCap,
  });
  const batteryAfter = transit.batteryRemainingMWh;
  const h2After = transit.h2RemainingL;
  const slot = slotPhysics(hull, planet, altitudeM, { batteryMWh: batteryAfter, h2L: h2After });
  const canReachSlot = transit.failureReason === null;
  const fuelUsedPct = pct(hull.h2CapacityL * hull.h2Fill - h2After, hull.h2CapacityL * hull.h2Fill);
  const batteryUsedPct = pct(hull.batteryMWh * hull.batteryFill - batteryAfter, hull.batteryMWh * hull.batteryFill);
  const reservePct = Math.round(Math.min(100 - fuelUsedPct, 100 - batteryUsedPct) * 10) / 10;
  const etaS = ascent.timeS + transit.timeS;

  return {
    hullId: hull.id,
    hullName: hull.name,
    gridSize: hull.gridSize,
    massKg: hull.massKg,
    massSource: hull.massSource,
    planet: planet.name,
    altitudeM,
    gravityMps2: round(slot.gravityMps2, 3),
    airDensity: round(slot.density, 4),
    launch,
    launchAltitudeM,
    canReachSlot,
    ascentTimeS: Math.round(ascent.timeS),
    transitTimeS: Math.round(transit.timeS),
    etaS: Math.round(etaS),
    fuelUsedPct,
    batteryUsedPct,
    reservePct,
    holdEnduranceS: slot.holdEnduranceS,
    holdEnduranceText: formatDuration(slot.holdEnduranceS),
    holdLimiting: slot.limiting,
    holdPowerMW: slot.hover ? round(slot.hover.powerMW, 2) : null,
    holdH2BurnLps: slot.hover ? round(slot.hover.h2BurnLps, 1) : null,
    twrAtSlot: slot.twr === null ? null : round(slot.twr, 2),
    thrustAtSlotN: Math.round(slot.available.totalN),
    requiredThrustN: Math.round(slot.requiredThrustN),
    failureReason: transit.failureReason ?? (slot.canHover ? null : 'thrust below weight at the slot'),
    recommendation: recommendationFor({ hull, planet, altitudeM, launch, launchAltitudeM, canReach: true, ascent, slot }),
    assumptions: assumptionIds(),
    labels: ['SIMULATED', 'ENDURANCE-MODEL'],
  };
}

function assumptionIds(): string[] {
  return ENDURANCE_ASSUMPTIONS.map((a) => `${a.id} (${a.status})`);
}

function recommendationFor(args: {
  hull: EnduranceHull;
  planet: Planet;
  altitudeM: number;
  launch: 'surface' | 'orbital';
  launchAltitudeM?: number;
  canReach: boolean;
  ascent: AscentResult;
  slot?: SlotPhysics;
}): string {
  const freeAlt = gravityFreeAltitudeM(planetGravity(args.planet));
  if (!args.canReach) {
    const reason = args.ascent.failureReason ?? 'the ascent failed';
    if (args.launch === 'surface') {
      return `cannot launch from the surface (${reason}); use an orbital spawn at 40 km or fit hydrogen/atmospheric thrust`;
    }
    return `cannot reach ${(args.altitudeM / 1000).toFixed(0)} km from the ${((args.launchAltitudeM ?? 0) / 1000).toFixed(0)} km spawn: ${reason}`;
  }
  const slot = args.slot;
  if (slot && slot.gravityMps2 <= 0) {
    return `park above ${(freeAlt / 1000).toFixed(0)} km: zero gravity, no fuel needed to hold`;
  }
  if (slot && slot.holdEnduranceS === 'indefinite') {
    const source = slot.power && slot.power.solarMW <= 0 ? 'the reactor covers' : 'solar + reactor cover';
    return `hold is indefinite: ${source} the ${slot.hover?.powerMW.toFixed(1) ?? '0'} MW draw at ${(args.altitudeM / 1000).toFixed(0)} km`;
  }
  if (slot && typeof slot.holdEnduranceS === 'number') {
    const limit = slot.limiting === 'h2' ? 'hydrogen' : 'battery';
    return `hold is limited to ${formatDuration(slot.holdEnduranceS)} by ${limit}; park above ${(freeAlt / 1000).toFixed(0)} km for a zero-g hold, or add tanks/panels`;
  }
  return 'reachable; hold is limited by the remaining fuel and charge';
}

function pct(used: number, capacity: number): number {
  if (!(capacity > 0)) return 0;
  return Math.round(Math.min(100, Math.max(0, (used / capacity) * 100)) * 10) / 10;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export interface LaunchGate {
  ok: boolean;
  reservePct: number;
  requiredReservePct: number;
  reason: string | null;
  report: EnduranceReport;
}

/**
 * Executor preflight: refuse a launch that cannot reach the slot with the
 * configured reserve. The default reserve is 15 % (designer setting).
 */
export function preflightLaunch(args: {
  hull: EnduranceHull;
  planet: Planet;
  altitudeM: number;
  transitDistanceM?: number;
  launch?: 'surface' | 'orbital';
  requiredReservePct?: number;
}): LaunchGate {
  const requiredReservePct = args.requiredReservePct ?? 15;
  const report = evaluateHullAtSlot(args);
  if (!report.canReachSlot) {
    return {
      ok: false,
      reservePct: report.reservePct,
      requiredReservePct,
      reason: `${report.hullName} cannot reach ${(args.altitudeM / 1000).toFixed(0)} km: ${report.failureReason ?? 'unknown'}`,
      report,
    };
  }
  if (report.reservePct + 1e-9 < requiredReservePct) {
    return {
      ok: false,
      reservePct: report.reservePct,
      requiredReservePct,
      reason:
        `${report.hullName} would arrive at ${(args.altitudeM / 1000).toFixed(0)} km with ` +
        `${report.reservePct.toFixed(1)} % reserve (minimum ${requiredReservePct} %): ` +
        `${report.fuelUsedPct.toFixed(1)} % H2, ${report.batteryUsedPct.toFixed(1)} % battery used`,
      report,
    };
  }
  return { ok: true, reservePct: report.reservePct, requiredReservePct, reason: null, report };
}
