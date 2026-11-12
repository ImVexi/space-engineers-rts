/**
 * Per-slot specifications (T49).
 *
 * Every slot a plan produces gets one spec that answers the owner's questions
 * in plain language:
 *
 *   * altitude and tier (ground / atmo / space) from the planet's air and the
 *     verified zero-g edge (`designer/gravity.ts`);
 *   * `holdMode`: a station by default (a station holds for free, T18) and
 *     only a flying/hovering ship when the slot is below 100 m or unreachable;
 *   * which thrust class the climb needs: atmospheric while the local TWR stays
 *     >= 1.5, hydrogen or ion above the density ceiling;
 *   * climb time, fuel and charge from the EXISTING endurance model
 *     (`demo/endurance/model.ts`, `evaluateHullAtSlot`) — no second physics;
 *   * hover draw when it cannot station, and antenna draw at the tuned range
 *     from the T30 power budget (`demo/power/budget.ts`, `radioDrawMw`);
 *   * whether an owner-tagged hull (real grid, from telemetry) fits, and a
 *     build-request line when none does.
 */
import type { Planet } from '@se-rts/schemas';
import type { V3 } from '../../planner/geometry.js';
import { hullForDesigner } from '../endurance/index.js';
import {
  airDensity,
  evaluateHullAtSlot,
  thrustAtAltitude,
  type EnduranceHull,
} from '../endurance/model.js';
import { radioDrawMw } from '../power/budget.js';
import { ATMO_CEILING_M, classifyHull } from './classification.js';
import { gravityAtAltitude, gravityFreeAltitudeM, planetGravity } from './gravity.js';
import type { DesignerHull } from './hulls.js';

export type SlotTier = 'ground' | 'atmo' | 'space';
export type SlotHoldMode = 'station' | 'ship';
export type SlotThrustClass = 'atmo' | 'hydrogen' | 'ion' | 'none';

/** Minimum local TWR the chosen thrust class must still achieve. */
export const SLOT_MIN_TWR = 1.5;
/** Station mode is only meaningful above ground clutter. */
export const SLOT_MIN_STATION_ALTITUDE_M = 100;
/** Air density below this is vacuum for thruster purposes (definitions table). */
const VACUUM_DENSITY = 0.05;

export interface SlotSpecInput {
  planet: Planet;
  slotId: string;
  position: V3;
  altitudeM: number;
  /** Hull the plan was built for (drives climb/fuel/thrust-class math). */
  hull: DesignerHull;
  /** Radio range the slot has to provide (metres); null when the hull has none. */
  requiredRadioM: number | null;
  /** Owner-tagged hulls from telemetry, for the fit check. */
  ownedHulls?: DesignerHull[];
  /** Ground distance to the slot for the endurance transit leg (default 0). */
  transitDistanceM?: number;
}

export interface OwnedHullFit {
  hullId: string;
  name: string;
  /**
   * true = fits, false = does not, null = cannot be confirmed (an owner-tagged
   * grid without endurance state from `list_tagged`).
   */
  fits: boolean | null;
  why: string;
}

export interface SlotSpec {
  slotId: string;
  altitudeM: number;
  tier: SlotTier;
  holdMode: SlotHoldMode;
  thrustClassNeeded: SlotThrustClass;
  /** T52: plain words for why this height was chosen. */
  altitudeReason?: string;
  /** T52: radio radius the slot needs, metres (T29 auto-tune). */
  radioRadiusM?: number | null;
  /** T52: MW saved by tuning the antenna down to that radius. */
  radioSavedMW?: number;
  /** Seconds from launch to the slot; null when the hull cannot reach it. */
  climbTimeS: number | null;
  fuelEstimate: {
    h2L: number | null;
    batteryMWh: number | null;
    reservePct: number | null;
    launch: 'surface' | 'orbital' | null;
    source: string;
  };
  /** Hover draw when the slot cannot be a station; null when it can. */
  hoverDrawMW: number | null;
  /** Antenna draw at the tuned range, MW (T30 linear model). */
  antennaDrawMW: number;
  /** Altitude up to which this hull keeps TWR >= 1.5 on atmospheric thrust. */
  atmoThrustCeilingM: number | null;
  rationale: string;
  /** Owner-tagged hulls known from telemetry and whether they fit. */
  ownedFits: OwnedHullFit[];
  /** One-line build request when no owned hull fits (null when one does). */
  buildRequest: string | null;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function tierOf(planet: Planet, altitudeM: number, zeroGAltitudeM: number): SlotTier {
  if (altitudeM < SLOT_MIN_STATION_ALTITUDE_M) return 'ground';
  if (zeroGAltitudeM > 0 && altitudeM >= zeroGAltitudeM) return 'space';
  return planet.hasAtmosphere ? 'atmo' : 'space';
}

/**
 * Highest altitude where this hull's atmospheric bank still gives TWR >= 1.5.
 * Scans in 250 m steps over the climb; in zero gravity there is no ceiling to
 * beat, so the target altitude is returned.
 */
function atmoThrustCeiling(hull: EnduranceHull | null, planet: Planet, targetAltitudeM: number): number {
  if (!hull || !(hull.massKg > 0)) return Math.min(ATMO_CEILING_M, targetAltitudeM);
  const gravity = planetGravity(planet);
  let ceiling = 0;
  for (let altitude = 0; altitude <= targetAltitudeM; altitude += 250) {
    const g = gravityAtAltitude(gravity, altitude);
    if (!(g > 0.001)) return altitude;
    const available = thrustAtAltitude(hull, planet, altitude);
    const twr = available.forceN.atmo / (hull.massKg * g);
    if (!(twr >= SLOT_MIN_TWR)) return ceiling;
    ceiling = altitude;
  }
  return ceiling;
}

function thrustClassFor(args: {
  hull: EnduranceHull | null;
  designerHull: DesignerHull;
  planet: Planet;
  altitudeM: number;
  atmoCeilingM: number;
}): SlotThrustClass {
  if (args.altitudeM < SLOT_MIN_STATION_ALTITUDE_M) return 'none';
  if (args.altitudeM <= args.atmoCeilingM) return 'atmo';
  const density = airDensity(args.planet, args.altitudeM);
  const hasIon = (args.designerHull.thrust.ion ?? 0) > 0;
  // Above the atmosphere ion works at full thrust; inside it, hydrogen is the
  // only class that is not degraded.
  if (density <= VACUUM_DENSITY && hasIon) return 'ion';
  return 'hydrogen';
}

interface FitVerdict {
  fits: boolean | null;
  why: string;
}

function fits(owned: DesignerHull, planet: Planet, slot: SlotSpecInput, thrustClass: SlotThrustClass): FitVerdict {
  const required = slot.requiredRadioM ?? 0;
  if (required > 0 && (owned.radioRangeM ?? 0) < required) {
    return {
      fits: false,
      why: `radio ${((owned.radioRangeM ?? 0) / 1000).toFixed(0)} km is short of the ${(required / 1000).toFixed(0)} km this slot must provide`,
    };
  }
  const cap = classifyHull(owned);
  if (thrustClass === 'atmo' && !cap.tierEligibility.atmo) return { fits: false, why: 'no atmospheric thrust for the climb' };
  if (thrustClass === 'hydrogen' && !cap.tierEligibility.h2) return { fits: false, why: 'no hydrogen thrust for the climb' };
  if (thrustClass === 'ion' && !cap.tierEligibility.ion && !cap.tierEligibility.h2) {
    return { fits: false, why: 'no ion or hydrogen thrust for the climb' };
  }
  const adapted = hullForDesigner(owned);
  if (!adapted.hull) {
    return { fits: null, why: adapted.reason ?? 'no endurance state from telemetry' };
  }
  const report = evaluateHullAtSlot({
    hull: adapted.hull,
    planet,
    altitudeM: slot.altitudeM,
    transitDistanceM: slot.transitDistanceM ?? 0,
  });
  if (!report.canReachSlot) {
    return { fits: false, why: report.failureReason ?? 'endurance preflight cannot reach this slot' };
  }
  if (report.reservePct + 1e-9 < 15) {
    return { fits: false, why: `arrives with ${report.reservePct.toFixed(0)} % reserve (minimum 15 %)` };
  }
  return { fits: true, why: `reaches the slot with ${report.reservePct.toFixed(0)} % reserve` };
}

/**
 * One spec for one slot. Pure and deterministic: same inputs, same spec.
 */
export function buildSlotSpec(input: SlotSpecInput): SlotSpec {
  const { planet, altitudeM } = input;
  const zeroG = gravityFreeAltitudeM(planetGravity(planet));
  const adapted = hullForDesigner(input.hull);
  const hull = adapted.hull;
  const report = hull
    ? evaluateHullAtSlot({
        hull,
        planet,
        altitudeM,
        transitDistanceM: input.transitDistanceM ?? 0,
      })
    : null;

  const reachable = report ? report.canReachSlot : false;
  const holdMode: SlotHoldMode =
    altitudeM >= SLOT_MIN_STATION_ALTITUDE_M && reachable ? 'station' : 'ship';
  const tier = tierOf(planet, altitudeM, zeroG);
  const atmoCeilingM = atmoThrustCeiling(hull, planet, altitudeM);
  const thrustClassNeeded = thrustClassFor({
    hull,
    designerHull: input.hull,
    planet,
    altitudeM,
    atmoCeilingM,
  });
  const antennaDrawMW = round(radioDrawMw(input.requiredRadioM ?? 0, 1), 4);
  const hoverDrawMW = holdMode === 'ship' ? (report?.holdPowerMW ?? null) : null;

  const h2L =
    hull && report ? round((hull.h2CapacityL * hull.h2Fill * report.fuelUsedPct) / 100, 1) : null;
  const batteryMWh =
    hull && report ? round((hull.batteryMWh * hull.batteryFill * report.batteryUsedPct) / 100, 3) : null;

  const ownedFits: OwnedHullFit[] = (input.ownedHulls ?? []).map((owned) => {
    const verdict = fits(owned, planet, input, thrustClassNeeded);
    return { hullId: owned.id, name: owned.displayName ?? owned.name, fits: verdict.fits, why: verdict.why };
  });
  const anyOwnedFits = ownedFits.some((fit) => fit.fits === true);
  const unknownOnly = !anyOwnedFits && ownedFits.some((fit) => fit.fits === null);

  const scope = input.requiredRadioM ? ` and a ${(input.requiredRadioM / 1000).toFixed(0)} km radio` : '';
  const buildRequest = anyOwnedFits
    ? null
    : `BUILD: 1x ${tier === 'space' ? 'orbital' : tier} relay with ${thrustClassNeeded} thrust${scope}, ` +
      `station-capable, for ${input.slotId} at ${(altitudeM / 1000).toFixed(1)} km on ${planet.name}` +
      (unknownOnly ? ' (no owned hull can be confirmed: telemetry has no endurance state)' : ' (no owned hull in telemetry fits)');

  const rationaleParts: string[] = [];
  if (tier === 'ground') rationaleParts.push('Ground slot: no climb or hold thrust is needed.');
  else if (holdMode === 'station') {
    rationaleParts.push(
      `Station at ${(altitudeM / 1000).toFixed(1)} km (${tier}): a station holds for free, so the only power cost is the antenna`,
    );
  } else {
    rationaleParts.push(
      `Flying ship at ${(altitudeM / 1000).toFixed(1)} km: it cannot station there` +
        (reachable ? '' : ' because the climb does not reach it') +
        (hoverDrawMW !== null ? `, so it burns ${hoverDrawMW.toFixed(2)} MW to hover` : ''),
    );
  }
  if (thrustClassNeeded === 'atmo') {
    rationaleParts.push(`atmospheric thrust keeps TWR >= ${SLOT_MIN_TWR} up to ${(atmoCeilingM / 1000).toFixed(1)} km`);
  } else if (thrustClassNeeded !== 'none') {
    rationaleParts.push(`${thrustClassNeeded} thrust is needed above the ${(atmoCeilingM / 1000).toFixed(1)} km atmospheric ceiling`);
  }
  rationaleParts.push(`${antennaDrawMW.toFixed(3)} MW goes to the antenna at its tuned range`);
  if (report && report.canReachSlot) {
    rationaleParts.push(
      `the climb takes ${report.ascentTimeS ?? 0} s and leaves ${report.reservePct.toFixed(0)} % reserve`,
    );
  } else if (report) {
    rationaleParts.push('the endurance preflight cannot reach this slot with the modelled plant and tanks');
  } else {
    rationaleParts.push('the endurance model has no definitions-derived plant/tank data for this hull');
  }

  return {
    slotId: input.slotId,
    altitudeM: Math.round(altitudeM),
    tier,
    holdMode,
    thrustClassNeeded,
    climbTimeS: report?.ascentTimeS ?? null,
    fuelEstimate: {
      h2L,
      batteryMWh,
      reservePct: report?.reservePct ?? null,
      launch: report?.launch ?? null,
      source: 'demo/endurance/model.ts evaluateHullAtSlot',
    },
    hoverDrawMW,
    antennaDrawMW,
    atmoThrustCeilingM: hull ? Math.round(atmoCeilingM) : null,
    rationale: `${rationaleParts.join('; ')}.`,
    ownedFits,
    buildRequest,
  };
}

/** Build specs for every slot a plan produced, in plan order. */
export function buildSlotSpecs(
  planet: Planet,
  slots: {
    slotId: string;
    position: V3;
    altitudeM: number;
    /** T52: per-slot radio requirement (defaults to the shared one). */
    requiredRadioM?: number | null;
    altitudeReason?: string;
    radioRadiusM?: number | null;
    radioSavedMW?: number;
  }[],
  hull: DesignerHull,
  requiredRadioM: number | null,
  ownedHulls: DesignerHull[] = [],
  transitDistanceM = 0,
): SlotSpec[] {
  return slots.map((slot) => {
    const spec = buildSlotSpec({
      planet,
      slotId: slot.slotId,
      position: slot.position,
      altitudeM: slot.altitudeM,
      hull,
      requiredRadioM: slot.requiredRadioM ?? requiredRadioM,
      ownedHulls,
      transitDistanceM,
    });
    if (slot.altitudeReason !== undefined) spec.altitudeReason = slot.altitudeReason;
    if (slot.radioRadiusM !== undefined) spec.radioRadiusM = slot.radioRadiusM;
    if (slot.radioSavedMW !== undefined) spec.radioSavedMW = slot.radioSavedMW;
    return spec;
  });
}
