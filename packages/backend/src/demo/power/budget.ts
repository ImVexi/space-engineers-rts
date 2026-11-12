/**
 * T30: power budget per deployment slot.
 *
 * Answers one question per slot: at this altitude/latitude, with this hull and
 * these antennas, is generation + battery enough for 24/7 operation — and if
 * not, by how much? Pure function; the planner (T22) can call it as a hard
 * constraint and the site can call it through `/api/demo/power/budget`.
 *
 * Block numbers are EXACT from the game definitions used by the endurance model
 * (endurance model): large solar 0.16 MW, small solar 0.04 MW, large battery
 * 3 MWh / 12 MW, small battery 1 MWh / 4 MW, small-small 0.05 MWh / 0.2 MW,
 * laser antenna 1.0 MW while lasing (0.001 turning, 0.0001 idle).
 *
 * Insolation is an ASSUMPTION, same as the endurance model: 50 % of panel peak
 * on average at the equator, scaled by cos(latitude) and by a terrain factor.
 */
import type { Planet } from '@se-rts/schemas';

export const BLOCK_POWER = {
  solarLargeMw: 0.16,
  solarSmallMw: 0.04,
  batteryLargeMWh: 3,
  batteryLargeMaxOutputMw: 12,
  batterySmallMWh: 1,
  batterySmallMaxOutputMw: 4,
  batterySmallSmallMWh: 0.05,
  batterySmallSmallMaxOutputMw: 0.2,
  laserLasingMw: 1.0,
  laserTurningMw: 0.001,
  /** Housekeeping: gyro + RC + PB + lights, measured from live profiles. */
  housekeepingMw: 0.01,
  /**
   * Radio antenna draw model. SE has no power value in the antenna definition:
   * the game scales the sink with the configured radius, so the demo models it
   * linearly and calibrates the constant against the live profile's
   * `antennaDrawMw` at the sampled radius (power telemetry model).
   */
  radioMwPerKm: 0.004,
} as const;

export type SlotRegion = 'polar' | 'equator' | 'valley' | 'zero-g';

export interface BudgetDesign {
  radioRangeM: number | null;
  radioAntennas: number;
  lasers: number;
  solarLarge: number;
  solarSmall: number;
  batteryLarge: number;
  batterySmall: number;
  batterySmallSmall: number;
  reactorMw: number;
  /** Continuous hover/thrust draw; 0 for station and zero-g. */
  hoverDrawMw: number;
  housekeepingMw: number;
}

export interface BudgetInput {
  gridId?: string | null;
  slotAltM: number;
  /** Degrees; 0 = equator, +/-90 = poles. */
  lat: number;
  planet?: Pick<Planet, 'name' | 'hasAtmosphere' | 'surfaceRadiusM'> | null;
  region?: SlotRegion | null;
  /** 'station' and 'zero-g' have no hover cost. */
  flightMode?: 'station' | 'zero-g' | 'atmo-hover' | 'ion-hover' | null;
  design: Partial<BudgetDesign>;
}

export interface BudgetResult {
  gridId: string | null;
  slotAltM: number;
  lat: number;
  planet: string | null;
  region: SlotRegion;
  dayNight: { nightFraction: number; daylightFactor: number; note: string };
  design: BudgetDesign;
  need: { avgMw: number; peakMw: number; nightMWh: number };
  supply: { solarAvgMw: number; solarPeakMw: number; batteryMWh: number; batteryMaxOutputMw: number; reactorMw: number };
  verdict: 'ok-24-7' | 'short-at-night' | 'generation-short' | 'no-storage';
  shortfallMWh: number;
  summary: string;
  suggestion: DesignSuggestion;
  source: 'SIMULATED';
  assumptions: string[];
}

export interface DesignSuggestion {
  region: SlotRegion;
  blocks: Record<string, number>;
  massKgEstimate: number;
  pcuEstimate: number;
  rationale: string;
}

function design(input: BudgetInput): BudgetDesign {
  const d = input.design ?? {};
  return {
    radioRangeM: d.radioRangeM ?? null,
    radioAntennas: Math.max(0, Math.round(d.radioAntennas ?? (d.radioRangeM ? 1 : 0))),
    lasers: Math.max(0, Math.round(d.lasers ?? 0)),
    solarLarge: Math.max(0, Math.round(d.solarLarge ?? 0)),
    solarSmall: Math.max(0, Math.round(d.solarSmall ?? 0)),
    batteryLarge: Math.max(0, Math.round(d.batteryLarge ?? 0)),
    batterySmall: Math.max(0, Math.round(d.batterySmall ?? 0)),
    batterySmallSmall: Math.max(0, Math.round(d.batterySmallSmall ?? 0)),
    reactorMw: Math.max(0, d.reactorMw ?? 0),
    hoverDrawMw: Math.max(0, d.hoverDrawMw ?? 0),
    housekeepingMw: Math.max(0, d.housekeepingMw ?? BLOCK_POWER.housekeepingMw),
  };
}

export function radioDrawMw(rangeM: number | null, antennas = 1): number {
  if (rangeM === null || rangeM <= 0) return 0;
  return (rangeM / 1000) * BLOCK_POWER.radioMwPerKm * Math.max(1, antennas);
}

/** Daylight-average solar factor at a latitude, before terrain/region. */
export function insolationFactor(lat: number): number {
  const rad = (Math.max(-90, Math.min(90, lat)) * Math.PI) / 180;
  // 50 % average insolation at the equator is the endurance model's number.
  return Math.max(0.02, 0.5 * Math.cos(rad));
}

export function resolveRegion(input: BudgetInput): SlotRegion {
  if (input.region) return input.region;
  if (input.flightMode === 'zero-g' || input.slotAltM >= 43_700) return 'zero-g';
  if (Math.abs(input.lat) >= 60) return 'polar';
  return 'equator';
}

const TERRAIN_FACTOR: Record<SlotRegion, number> = {
  polar: 0.9,
  equator: 1,
  valley: 0.6,
  'zero-g': 0.95,
};

const NIGHT_FRACTION: Record<SlotRegion, number> = {
  polar: 0.68,
  equator: 0.5,
  valley: 0.5,
  'zero-g': 0.3,
};

export function powerBudget(input: BudgetInput): BudgetResult {
  const d = design(input);
  const region = resolveRegion(input);
  const latFactor = insolationFactor(input.lat) * TERRAIN_FACTOR[region];
  const solarPeakMw = d.solarLarge * BLOCK_POWER.solarLargeMw + d.solarSmall * BLOCK_POWER.solarSmallMw;
  const solarAvgMw = solarPeakMw * latFactor;
  const batteryMWh =
    d.batteryLarge * BLOCK_POWER.batteryLargeMWh +
    d.batterySmall * BLOCK_POWER.batterySmallMWh +
    d.batterySmallSmall * BLOCK_POWER.batterySmallSmallMWh;
  const batteryMaxOutputMw =
    d.batteryLarge * BLOCK_POWER.batteryLargeMaxOutputMw +
    d.batterySmall * BLOCK_POWER.batterySmallMaxOutputMw +
    d.batterySmallSmall * BLOCK_POWER.batterySmallSmallMaxOutputMw;

  const antennaMw = radioDrawMw(d.radioRangeM, d.radioAntennas);
  const laserMw = d.lasers * BLOCK_POWER.laserLasingMw;
  const hoverMw = input.flightMode === 'station' || input.flightMode === 'zero-g' || region === 'zero-g' ? 0 : d.hoverDrawMw;
  const avgMw = antennaMw + laserMw * 0.5 + hoverMw + d.housekeepingMw;
  const peakMw = antennaMw + laserMw + hoverMw + d.housekeepingMw;

  const nightFraction = NIGHT_FRACTION[region];
  const solarDayMw = solarPeakMw * latFactor;
  // (average need - daytime generation) MW x night hours = MWh the battery
  // must cover. 24 h * nightFraction = night hours.
  const nightHours = 24 * nightFraction;
  const deficitMw = Math.max(0, avgMw - solarDayMw);
  const shortfallMWh = round(deficitMw * nightHours, 3);

  let verdict: BudgetResult['verdict'];
  if (solarPeakMw <= 0 && d.reactorMw <= 0 && batteryMWh <= 0) verdict = 'generation-short';
  else if (deficitMw > 0 && batteryMWh < shortfallMWh) verdict = 'short-at-night';
  else if (deficitMw > 0 && batteryMaxOutputMw < avgMw) verdict = 'no-storage';
  else if (avgMw > solarAvgMw + d.reactorMw + batteryMaxOutputMw) verdict = 'generation-short';
  else verdict = 'ok-24-7';

  const supply = {
    solarAvgMw: round(solarAvgMw, 3),
    solarPeakMw: round(solarPeakMw, 3),
    batteryMWh: round(batteryMWh, 3),
    batteryMaxOutputMw: round(batteryMaxOutputMw, 3),
    reactorMw: round(d.reactorMw, 3),
  };
  const need = { avgMw: round(avgMw, 3), peakMw: round(peakMw, 3), nightMWh: round(shortfallMWh, 3) };

  return {
    gridId: input.gridId ?? null,
    slotAltM: round(input.slotAltM, 0),
    lat: round(input.lat, 1),
    planet: input.planet?.name ?? null,
    region,
    dayNight: {
      nightFraction: round(nightFraction, 2),
      daylightFactor: round(latFactor, 3),
      note: `${Math.round(nightHours)} h of night-equivalent per day at this latitude/region (assumption)`,
    },
    design: d,
    need,
    supply,
    verdict,
    shortfallMWh,
    summary: summaryOf(verdict, need, supply, shortfallMWh),
    suggestion: suggestDesign(region, input.planet ?? null),
    source: 'SIMULATED',
    assumptions: [
      `solar: ${Math.round(latFactor * 100)} % of panel peak on average (50 % at the equator x cos(latitude) x terrain)`,
      'battery is the only night buffer unless a reactor is listed',
      `radio draw ${BLOCK_POWER.radioMwPerKm} MW/km (linear model calibrated to live profile antennaDrawMw)`,
      'laser antenna 1.0 MW while lasing, 0.5 MW average duty in this budget',
    ],
  };
}

function summaryOf(
  verdict: BudgetResult['verdict'],
  need: BudgetResult['need'],
  supply: BudgetResult['supply'],
  shortfallMWh: number,
): string {
  if (verdict === 'ok-24-7') {
    return `Needs ${need.avgMw.toFixed(2)} MW average (${need.peakMw.toFixed(2)} MW peak); this hull supplies ${supply.solarAvgMw.toFixed(2)} MW solar average plus ${supply.batteryMWh.toFixed(2)} MWh of battery -> OK 24/7.`;
  }
  if (verdict === 'short-at-night') {
    return `Needs ${need.avgMw.toFixed(2)} MW average (${need.peakMw.toFixed(2)} MW peak); short at night by ${shortfallMWh.toFixed(2)} MWh (battery has ${supply.batteryMWh.toFixed(2)} MWh).`;
  }
  if (verdict === 'no-storage') {
    return `Generation covers the day, but the battery can only deliver ${supply.batteryMaxOutputMw.toFixed(2)} MW against a ${need.avgMw.toFixed(2)} MW need: add batteries or drop a laser.`;
  }
  return `Not enough generation: ${need.avgMw.toFixed(2)} MW average needed, ${supply.solarAvgMw.toFixed(2)} MW solar average + ${supply.reactorMw.toFixed(2)} MW reactor.`;
}

/**
 * Design spec for a region: the block mix that meets a relay's needs with a
 * margin, so the owner can build a specialised variant instead of flying a
 * general-purpose hull everywhere.
 */
export function suggestDesign(region: SlotRegion, planet: Pick<Planet, 'name' | 'hasAtmosphere'> | null): DesignSuggestion {
  const atmo = planet?.hasAtmosphere ?? true;
  switch (region) {
    case 'polar':
      return {
        region,
        blocks: { solarLarge: 6, batteryLarge: 2, radio: 1, laser: 0, thrusters: atmo ? 4 : 2 },
        massKgEstimate: 24_000,
        pcuEstimate: 1_900,
        rationale:
          'Polar light is weak and the night is long: more panel area and two large batteries beat a bigger array of small ones. Radio only unless the link plan needs a laser.',
      };
    case 'valley':
      return {
        region,
        blocks: { solarLarge: 2, batteryLarge: 2, radio: 1, laser: 1, thrusters: 0 },
        massKgEstimate: 18_000,
        pcuEstimate: 1_500,
        rationale:
          'Terrain shadows the valley: panels are unreliable, so keep a laser + 2 batteries and let the ground node be a station/rover with no thrust.',
      };
    case 'zero-g':
      return {
        region,
        blocks: { solarLarge: 4, batteryLarge: 1, radio: 1, laser: 2, thrusters: 2 },
        massKgEstimate: 20_500,
        pcuEstimate: 1_700,
        rationale:
          'Zero-g hold needs no thrust: 4 panels and one battery cover housekeeping plus two lasers, and lasers give the long backbone hops radio cannot.',
      };
    default:
      return {
        region: 'equator',
        blocks: { solarLarge: 4, batteryLarge: 1, radio: 1, laser: 0, thrusters: atmo ? 4 : 2 },
        massKgEstimate: 19_000,
        pcuEstimate: 1_600,
        rationale:
          'Equatorial light is the best on the planet: 4 large panels cover a 50 km radio and housekeeping with one battery for the night.',
      };
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
