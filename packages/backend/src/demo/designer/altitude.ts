/**
 * Altitude selection for coverage slots (T52).
 *
 * A relay's ground footprint is the *smaller* of two limits:
 *   * the radio range (law of cosines, `footprintAngle`); and
 *   * the horizon — a cell below the tangent plane can never be seen.
 *
 * The existing T28 footprint only applied the first, which over-credits a low
 * relay on a smooth sphere (a radio at 0 m "covering" 50 km through the
 * planet). This module adds the horizon clamp and uses it to pick an altitude
 * per slot:
 *
 *   * `max-reach`  — the altitude that maximises the terrain-cleared ground
 *     footprint. On a flat sphere the two limits cross at
 *     `sqrt(surface^2 + range^2) - surface` (EarthLike, 50 km: 18.24 km), which
 *     is where the footprint peaks (41.6 km ground, 11.7 % of the planet);
 *   * `cheapest`   — not simply "lowest": the ladder altitude with the lowest
 *     total cost per kilometre of ground reach, where cost is ship weight +
 *     climb fuel/charge from the ONE endurance model + hold + antenna draw;
 *   * `manual`     — the operator's number, unchanged.
 *
 * Everything here is deterministic (no randomness, stable tie-breaks) and uses
 * existing physics: `evaluateHullAtSlot` for climb/hold, `radioDrawMw` for the
 * antenna.
 */
import type { Planet } from '@se-rts/schemas';
import { add, dot, normalize, scale, v3, type V3 } from '../../planner/geometry.js';
import { coverageCellsFor, coverageCellsForNodes, footprintAngle, type CoverageCellPoint } from '../../planner/planetCoverage.js';
import type { TerrainField } from '../../planner/terrainField.js';
import { hullForDesigner } from '../endurance/index.js';
import { evaluateHullAtSlot } from '../endurance/model.js';
import { radioDrawMw } from '../power/budget.js';
import type { DesignerHull } from './hulls.js';
import { RANGE_MARGIN, tuneNode } from '../autotune/range.js';

export type AltitudeMode = 'manual' | 'max-reach' | 'cheapest';

/** Candidate heights for the CHEAPEST search, metres AGL (T52 example ladder). */
export const CHEAPEST_LADDER_M = [3_000, 5_000, 8_000, 10_000, 12_000, 15_000, 18_500] as const;

/** Extra ladder rungs used when terrain pushes the best footprint higher. */
export const RIDGE_LADDER_M = [22_000, 26_000, 30_000] as const;

/** Lower bound for a station (T18/T19: never on the ground). */
export const MIN_STATION_ALTITUDE_M = 100;

export interface CostWeights {
  /** Cost of committing one ship (default 1 — "one ship dominates its climb"). */
  ship: number;
  /** Cost per litre of hydrogen burned on the climb (default 0.001). */
  h2PerL: number;
  /** Cost per MWh of battery charge burned on the climb (default 0.05). */
  batteryPerMWh: number;
  /** Cost per MW of continuous draw (antenna + hover), default 0.2. */
  mw: number;
  /** Hours of hover assumed when a slot cannot be stationed (default 24). */
  holdHours?: number;
}

export const DEFAULT_COST_WEIGHTS: Required<CostWeights> = {
  ship: 1,
  // One ship dominates a typical climb: 250,000 L of hydrogen still costs a
  // fifth of a ship at 2e-6 per litre (see the module docs).
  h2PerL: 0.000002,
  batteryPerMWh: 0.05,
  mw: 0.2,
  holdHours: 24,
};

export function normaliseCostWeights(input?: Partial<CostWeights> | null): Required<CostWeights> {
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    ship: pick(input?.ship, DEFAULT_COST_WEIGHTS.ship),
    h2PerL: pick(input?.h2PerL, DEFAULT_COST_WEIGHTS.h2PerL),
    batteryPerMWh: pick(input?.batteryPerMWh, DEFAULT_COST_WEIGHTS.batteryPerMWh),
    mw: pick(input?.mw, DEFAULT_COST_WEIGHTS.mw),
    holdHours: pick(input?.holdHours, DEFAULT_COST_WEIGHTS.holdHours ?? 24),
  };
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Ground half-angle of the *horizon* from `altitudeM` AGL, radians. */
export function horizonAngle(planet: Planet, altitudeM: number): number {
  const nodeRadius = planet.surfaceRadiusM + Math.max(0, altitudeM);
  if (!(planet.surfaceRadiusM > 0) || nodeRadius <= planet.surfaceRadiusM) return 0;
  const ratio = planet.surfaceRadiusM / nodeRadius;
  return Math.acos(Math.max(-1, Math.min(1, ratio)));
}

/**
 * Horizon- and radio-limited ground footprint radius, metres. This is the
 * number T52 quotes (EarthLike/50 km: 18.5 km -> 41.6 km, 10 km -> 32.2 km).
 */
export function groundFootprintRadiusM(planet: Planet, altitudeM: number, rangeM: number): number {
  if (!(rangeM > 0)) return 0;
  const radio = footprintAngle(planet.surfaceRadiusM, planet.surfaceRadiusM + Math.max(0, altitudeM), rangeM);
  const horizon = horizonAngle(planet, altitudeM);
  const phi = Math.min(radio, horizon);
  return phi > 0 ? planet.surfaceRadiusM * phi : 0;
}

/** Fraction of the planet's surface one relay covers. */
export function groundFootprintFraction(planet: Planet, altitudeM: number, rangeM: number): number {
  const radiusM = groundFootprintRadiusM(planet, altitudeM, rangeM);
  if (radiusM <= 0) return 0;
  const phi = radiusM / planet.surfaceRadiusM;
  return (1 - Math.cos(phi)) / 2;
}

/**
 * Analytic peak of the flat-sphere footprint: the altitude where the horizon
 * and the radio limit cross, `sqrt(surface^2 + range^2) - surface`.
 */
export function analyticPeakAltitudeM(planet: Planet, rangeM: number): number {
  const r = planet.surfaceRadiusM;
  if (!(r > 0) || !(rangeM > 0)) return 0;
  return Math.sqrt(r * r + rangeM * rangeM) - r;
}

/** Altitude ceiling the ladder may use: a relay above its radio has no footprint. */
export function altitudeCeilingM(planet: Planet, rangeM: number): number {
  if (!(rangeM > 0)) return 0;
  return Math.max(MIN_STATION_ALTITUDE_M, Math.floor(rangeM * 0.98));
}

/** Ladder clipped to [100 m, 0.98 x radio], ascending, deduplicated. */
export function altitudeLadderM(planet: Planet, rangeM: number, extra: readonly number[] = []): number[] {
  const ceiling = altitudeCeilingM(planet, rangeM);
  const all = [...CHEAPEST_LADDER_M, ...extra];
  const out = all.filter((alt) => alt > MIN_STATION_ALTITUDE_M && alt <= ceiling);
  if (out.length === 0) out.push(Math.min(ceiling, Math.max(MIN_STATION_ALTITUDE_M + 1, 1_000)));
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Best flat-sphere altitude by search (1 km coarse, then 250 m refinement), so
 * the caller never depends on the closed form being memorised. On flat terrain
 * this lands within 250 m of `analyticPeakAltitudeM`.
 */
export function bestFlatAltitudeM(planet: Planet, rangeM: number): number {
  const ceiling = Math.min(altitudeCeilingM(planet, rangeM), 60_000);
  if (!(ceiling > MIN_STATION_ALTITUDE_M)) return MIN_STATION_ALTITUDE_M;
  let bestAlt = MIN_STATION_ALTITUDE_M + 1;
  let bestRadius = -1;
  for (let alt = 1_000; alt <= ceiling; alt += 1_000) {
    const radius = groundFootprintRadiusM(planet, alt, rangeM);
    if (radius > bestRadius) {
      bestRadius = radius;
      bestAlt = alt;
    }
  }
  const lo = Math.max(MIN_STATION_ALTITUDE_M + 1, bestAlt - 1_000);
  const hi = Math.min(ceiling, bestAlt + 1_000);
  for (let alt = lo; alt <= hi; alt += 250) {
    const radius = groundFootprintRadiusM(planet, alt, rangeM);
    if (radius > bestRadius + 1e-6) {
      bestRadius = radius;
      bestAlt = alt;
    }
  }
  return Math.round(bestAlt);
}

export interface AltitudeCost {
  /** Weighted total, "ships" as the unit. */
  total: number;
  ship: number;
  h2L: number | null;
  batteryMWh: number | null;
  antennaMW: number;
  /** Hover draw x holdHours, MW (0 when the slot can be stationed). */
  holdMW: number;
  holdMode: 'station' | 'ship';
  thrustClassNeeded: 'atmo' | 'hydrogen' | 'ion' | 'none';
  /** Ground radius the same hull provides here, metres. */
  footprintRadiusM: number;
  /** Cost per kilometre of ground reach (the CHEAPEST ranking key). */
  costPerKm: number;
  basis: string;
}

/**
 * Total cost of one ship at one slot height: ship weight + climb fuel/charge
 * (endurance model) + hold + antenna draw at the tuned radius.
 */
export function slotCostAt(args: {
  planet: Planet;
  hull: DesignerHull;
  altitudeM: number;
  rangeM: number;
  weights: Required<CostWeights>;
  /** Flight distance priced into the climb (default: min(radio, 40 km)). */
  transitDistanceM?: number;
}): AltitudeCost {
  const { planet, hull, altitudeM, rangeM, weights } = args;
  const adapted = hullForDesigner(hull);
  // A slot is not free to reach: the ship flies there. Price the same transit
  // the move planner prices, at the plan's typical hop, so a slot that needs a
  // long climb or a long flight costs more than one that does not.
  const transitDistanceM = args.transitDistanceM ?? Math.round(Math.min(Math.max(rangeM, 0), 10_000));
  const report = adapted.hull
    ? evaluateHullAtSlot({ hull: adapted.hull, planet, altitudeM, transitDistanceM })
    : null;
  const station = altitudeM >= MIN_STATION_ALTITUDE_M && (report?.canReachSlot ?? false);
  // Litres on the climb AND the transit: a relay that cannot station holds
  // hover fuel, and one that must fly further carries more. Clamped to the
  // tanks, so an infeasible report never invents a 400,000 L bill.
  const h2UsedL = report && adapted.hull ? (adapted.hull.h2CapacityL * adapted.hull.h2Fill * report.fuelUsedPct) / 100 : null;
  const hoverL =
    report && !station && typeof report.holdH2BurnLps === 'number'
      ? report.holdH2BurnLps * (typeof report.holdEnduranceS === 'number' ? Math.min(report.holdEnduranceS, 3_600) : 3_600)
      : 0;
  const h2L = h2UsedL === null ? null : round(Math.min(adapted.hull!.h2CapacityL * adapted.hull!.h2Fill, h2UsedL + hoverL), 1);
  const batteryMWh = report && adapted.hull
    ? round((adapted.hull.batteryMWh * adapted.hull.batteryFill * report.batteryUsedPct) / 100, 3)
    : null;
  // Antenna at the radius the slot actually needs: the footprint's slant edge
  // is the ground radius itself (chord == range at the footprint rim).
  const footprintRadiusM = Math.round(groundFootprintRadiusM(planet, altitudeM, rangeM));
  const tuned = Math.min(hull.radioRangeM ?? rangeM, Math.max(footprintRadiusM, RANGE_MARGIN * 1_000));
  const antennaMW = radioDrawMw(tuned, 1);
  const holdMW = station ? 0 : report?.holdPowerMW ?? 0;
  const total =
    weights.ship +
    weights.h2PerL * (h2L ?? 0) +
    weights.batteryPerMWh * (batteryMWh ?? 0) +
    weights.mw * (antennaMW + holdMW * (weights.holdHours ?? 24));
  return {
    total: round(total, 4),
    ship: weights.ship,
    h2L,
    batteryMWh,
    antennaMW: round(antennaMW, 4),
    holdMW: round(holdMW, 4),
    holdMode: station ? 'station' : 'ship',
    thrustClassNeeded:
      altitudeM <= 10_000 ? 'atmo' : altitudeM >= 43_700 ? 'ion' : 'hydrogen',
    footprintRadiusM,
    costPerKm: footprintRadiusM > 0 ? round(total / (footprintRadiusM / 1000), 5) : Number.POSITIVE_INFINITY,
    basis: adapted.hull
      ? 'demo/endurance/model.ts evaluateHullAtSlot + radioDrawMw at the tuned radius'
      : `endurance model unavailable for ${hull.name}: climb fuel is not counted`,
  };
}

/** CHEAPEST: the ladder altitude with the lowest cost per km of ground reach. */
export function cheapestAltitudeM(args: {
  planet: Planet;
  hull: DesignerHull;
  rangeM: number;
  weights: Required<CostWeights>;
}): number {
  const ladder = altitudeLadderM(args.planet, args.rangeM, RIDGE_LADDER_M);
  let best = ladder[0]!;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const altitudeM of ladder) {
    const cost = slotCostAt({ ...args, altitudeM });
    // Strictly better cost-per-km wins; a later (higher) rung only wins when it
    // is measurably better, so the tie-break prefers the cheaper climb.
    if (cost.costPerKm < bestCost - 1e-9) {
      bestCost = cost.costPerKm;
      best = altitudeM;
    }
  }
  return best;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

function bearingNorthEast(dir: V3): { north: V3; east: V3 } {
  const up = v3(0, 1, 0);
  let north = { x: up.x - dir.x * dot(up, dir), y: up.y - dir.y * dot(up, dir), z: up.z - dir.z * dot(up, dir) };
  if (Math.hypot(north.x, north.y, north.z) < 1e-6) {
    const fallback = v3(1, 0, 0);
    north = {
      x: fallback.x - dir.x * dot(fallback, dir),
      y: fallback.y - dir.y * dot(fallback, dir),
      z: fallback.z - dir.z * dot(fallback, dir),
    };
  }
  north = normalize(north);
  const east = normalize(v3(dir.y * north.z - dir.z * north.y, dir.z * north.x - dir.x * north.z, dir.x * north.y - dir.y * north.x));
  return { north, east };
}

/** Relief (metres above the smooth sphere) and its compass bearing, 8 samples. */
export function reliefAround(planet: Planet, field: TerrainField | null, dir: V3, sampleM = 8_000): { reliefM: number; bearing: string } | null {
  if (!field || field.status !== 'available') return null;
  const { north, east } = bearingNorthEast(dir);
  let bestRelief = 0;
  let bestBearing = '';
  const angle = sampleM / planet.surfaceRadiusM;
  for (let i = 0; i < 8; i += 1) {
    const bearing = (i / 8) * Math.PI * 2;
    const tangent = add(scale(north, Math.cos(bearing)), scale(east, Math.sin(bearing)));
    const probe = normalize(add(scale(dir, Math.cos(angle)), scale(tangent, Math.sin(angle))));
    const radius = field.radiusAt(probe);
    const relief = radius === null ? 0 : radius - planet.surfaceRadiusM;
    if (relief > bestRelief) {
      bestRelief = relief;
      bestBearing = COMPASS[i]!;
    }
  }
  return bestRelief > 50 ? { reliefM: Math.round(bestRelief), bearing: bestBearing } : null;
}

/** Cells within the horizon/radio footprint of `dir` at `altitudeM`. */
export function cellsWithinFootprint(cells: CoverageCellPoint[], dir: V3, phi: number): CoverageCellPoint[] {
  if (!(phi > 0)) return [];
  const cosPhi = Math.cos(phi);
  return cells.filter((cell) => dot(dir, cell.dir) >= cosPhi);
}

function terrainCoveredCount(args: {
  planet: Planet;
  dir: V3;
  altitudeM: number;
  cells: CoverageCellPoint[];
  rangeM: number;
  terrain: TerrainField | null;
}): number {
  const { planet, dir, altitudeM, cells, rangeM, terrain } = args;
  const radio = footprintAngle(planet.surfaceRadiusM, planet.surfaceRadiusM + altitudeM, rangeM);
  const phi = Math.min(radio, horizonAngle(planet, altitudeM));
  if (!(phi > 0)) return 0;
  const subset = cellsWithinFootprint(cells, dir, phi);
  if (subset.length === 0) return 0;
  const position = add(planet.center, scale(dir, planet.surfaceRadiusM + altitudeM));
  const result = coverageCellsForNodes(planet, subset, [{ id: 'candidate', position }], rangeM, 1, terrain);
  return result.coveredCells;
}

export interface AltitudeChoice {
  mode: AltitudeMode;
  altitudeM: number;
  reason: string;
  footprintRadiusM: number;
  footprintPct: number;
  /** True when terrain forced this slot higher than the flat peak would be. */
  raisedByTerrain: boolean;
  candidates: { altitudeM: number; coveredCells: number; footprintRadiusM: number }[];
}

/**
 * Per-slot altitude for a coverage slot. `cells` are the cells this slot is
 * asked to cover (the target set); with terrain the search counts the cells
 * whose slant path still clears the ground, so a ridge pushes the slot up.
 */
export function chooseSlotAltitude(args: {
  planet: Planet;
  dir: V3;
  rangeM: number;
  mode: AltitudeMode;
  manualAltitudeM?: number | null;
  cells: CoverageCellPoint[];
  terrain: TerrainField | null;
  /** Required for CHEAPEST: the cost model needs the hull. */
  hull?: DesignerHull | null;
  costWeights?: Required<CostWeights>;
}): AltitudeChoice {
  const { planet, dir, rangeM, mode, terrain } = args;
  const flatPeak = bestFlatAltitudeM(planet, rangeM);
  const manual = typeof args.manualAltitudeM === 'number' && Number.isFinite(args.manualAltitudeM)
    ? Math.max(MIN_STATION_ALTITUDE_M + 1, Math.round(args.manualAltitudeM))
    : flatPeak;
  if (mode === 'manual') {
    const radiusM = groundFootprintRadiusM(planet, manual, rangeM);
    const relief = reliefAround(planet, terrain, dir);
    return {
      mode,
      altitudeM: manual,
      reason:
        radiusM > 0
          ? `MANUAL: operator set ${(manual / 1000).toFixed(1)} km; a ${(rangeM / 1000).toFixed(0)} km radio reaches ` +
            `${(radiusM / 1000).toFixed(1)} km of ground from there` +
            (relief ? `, with ${(relief.reliefM / 1000).toFixed(1)} km of relief to the ${relief.bearing}` : '')
          : `MANUAL: operator set ${(manual / 1000).toFixed(1)} km, above the ${(rangeM / 1000).toFixed(0)} km radio's ground reach (relay-only)`,
      footprintRadiusM: Math.round(radiusM),
      footprintPct: round(groundFootprintFraction(planet, manual, rangeM) * 100, 2),
      raisedByTerrain: false,
      candidates: [],
    };
  }

  const ladder = altitudeLadderM(planet, rangeM, RIDGE_LADDER_M);
  const scored = ladder.map((altitudeM) => ({
    altitudeM,
    coveredCells: terrainCoveredCount({ planet, dir, altitudeM, cells: args.cells, rangeM, terrain }),
    footprintRadiusM: Math.round(groundFootprintRadiusM(planet, altitudeM, rangeM)),
  }));
  let bestIndex = 0;
  for (let i = 1; i < scored.length; i += 1) {
    const a = scored[i]!;
    const b = scored[bestIndex]!;
    if (a.coveredCells > b.coveredCells || (a.coveredCells === b.coveredCells && a.altitudeM < b.altitudeM)) bestIndex = i;
  }
  // Refine around the best rung (250 m) so the answer is not quantised to the ladder.
  let best = scored[bestIndex]!;
  const floor = scored[Math.max(0, bestIndex - 1)]!.altitudeM;
  const roof = scored[Math.min(scored.length - 1, bestIndex + 1)]!.altitudeM;
  // A relay's own fuel budget decides whether it may sit at the best-reach
  // rung: with scarce H2 it cannot, so the reaching height has to come down.
  const reachable = (altitudeM: number): boolean => {
    if (!args.hull) return true;
    const adapted = hullForDesigner(args.hull);
    const report = adapted.hull
      ? evaluateHullAtSlot({ hull: adapted.hull, planet, altitudeM, transitDistanceM: Math.round(Math.min(rangeM, 10_000)) })
      : null;
    return report ? report.canReachSlot && report.reservePct >= 10 : true;
  };
  if (mode === 'max-reach' || best.coveredCells > 0) {
    for (let alt = floor; alt <= roof; alt += 250) {
      const covered = terrainCoveredCount({ planet, dir, altitudeM: alt, cells: args.cells, rangeM, terrain });
      if (covered > best.coveredCells || (covered === best.coveredCells && alt < best.altitudeM)) {
        best = { altitudeM: alt, coveredCells: covered, footprintRadiusM: Math.round(groundFootprintRadiusM(planet, alt, rangeM)) };
      }
    }
  }
  if (mode === 'cheapest' && args.hull) {
    // CHEAPEST picks the rung with the lowest COST PER COVERED CELL, and then
    // lets the solver buy more relays at cheap rungs to make up the coverage.
    // That is what makes a scarce H2/battery budget buy more, lower relays and
    // a scarce ship budget buy fewer, higher ones. Requiring full coverage at
    // the rung level (the earlier reachFloor rule) collapsed both weight sets
    // onto the same rung, so the weights could never diverge.
    const weights = args.costWeights ?? DEFAULT_COST_WEIGHTS;
    let cheapest: (typeof scored)[number] | null = null;
    let cheapestScore = Number.POSITIVE_INFINITY;
    for (const entry of scored) {
      if (entry.coveredCells <= 0) continue;
      if (!reachable(entry.altitudeM)) continue;
      const cost = slotCostAt({ planet, hull: args.hull, altitudeM: entry.altitudeM, rangeM, weights });
      const score = cost.total / entry.coveredCells;
      if (
        score < cheapestScore - 1e-12 ||
        (Math.abs(score - cheapestScore) <= 1e-12 && cheapest !== null && entry.altitudeM < cheapest.altitudeM)
      ) {
        cheapestScore = score;
        cheapest = entry;
      }
    }
    if (cheapest) best = cheapest;
  }

  const relief = reliefAround(planet, terrain, dir);
  const flatRadius = groundFootprintRadiusM(planet, flatPeak, rangeM);
  const lowBlocked = scored.length > 0 && scored[0]!.coveredCells === 0 && best.coveredCells > 0;
  const raisedByTerrain = Boolean(terrain && terrain.status === 'available') && lowBlocked;
  const coverageWord = best.coveredCells > 0 ? `${best.coveredCells} cell(s)` : 'no cell sees this slot';
  const reason = raisedByTerrain
    ? `${relief ? `${relief.bearing} ridge ${(relief.reliefM / 1000).toFixed(1)} km high` : 'terrain'} blocks the low path: ` +
      `raised to ${(best.altitudeM / 1000).toFixed(1)} km to clear it (${coverageWord})`
    : mode === 'max-reach'
      ? `open ground: ${(best.altitudeM / 1000).toFixed(1)} km maximises the ground footprint ` +
        `(${(best.footprintRadiusM / 1000).toFixed(1)} km, ${((best.footprintRadiusM / (planet.surfaceRadiusM * Math.PI * 2)) * 100).toFixed(1)} % of the rim; ` +
        `flat peak ${(flatPeak / 1000).toFixed(1)} km = ${(flatRadius / 1000).toFixed(1)} km)`
      : `${best.altitudeM <= 10_000 ? 'low basin' : 'station tier'}: ${(best.altitudeM / 1000).toFixed(1)} km is the cheapest ` +
        `height that still covers its ${coverageWord} (radio ${(best.footprintRadiusM / 1000).toFixed(1)} km)`;
  return {
    mode,
    altitudeM: Math.round(best.altitudeM),
    reason,
    footprintRadiusM: best.footprintRadiusM,
    footprintPct: round((best.coveredCells > 0 ? groundFootprintFraction(planet, best.altitudeM, rangeM) : 0) * 100, 2),
    raisedByTerrain,
    candidates: scored,
  };
}

/**
 * Per-slot radio radius (T29 auto-tune) from the cells the slot serves and the
 * links it carries. Never below a link in use; never above the hardware.
 */
export function tuneSlotRadio(args: {
  planet: Planet;
  hull: DesignerHull;
  slotId: string;
  position: V3;
  coveredCells: { latDeg: number; lonDeg: number }[];
  links: { to: string; distanceM: number }[];
}): {
  radioRadiusM: number;
  antennaMW: number;
  savedMW: number;
  maxSlantM: number;
  longestLinkM: number;
  reason: string;
} {
  const { planet, hull, position, coveredCells, links } = args;
  const maxSlantM = coveredCells.reduce((max, cell) => {
    const lat = (cell.latDeg * Math.PI) / 180;
    const lon = (cell.lonDeg * Math.PI) / 180;
    const dir = v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    const point = add(planet.center, scale(dir, planet.surfaceRadiusM));
    return Math.max(max, Math.hypot(point.x - position.x, point.y - position.y, point.z - position.z));
  }, 0);
  const longestLinkM = links.reduce((max, link) => Math.max(max, link.distanceM), 0);
  const hardware = hull.radioRangeM ?? 0;
  const plan = tuneNode({
    gridId: args.slotId,
    name: args.slotId,
    role: 'coverage',
    radioRadiusM: hardware,
    laserRangeM: null,
    footprintM: maxSlantM > 0 ? Math.round(maxSlantM) : null,
    radioLinks: links,
    laserLinks: [],
    maxRadioM: hardware,
    antennaDrawMw: radioDrawMw(hardware, 1),
  });
  const radioRadiusM = Math.max(hardware > 0 ? Math.min(hardware, plan.radio.neededM ?? hardware) : 0, Math.round(longestLinkM));
  return {
    radioRadiusM: Math.round(radioRadiusM),
    antennaMW: round(radioDrawMw(radioRadiusM, 1), 4),
    savedMW: round(Math.max(0, radioDrawMw(hardware, 1) - radioDrawMw(radioRadiusM, 1)), 4),
    maxSlantM: Math.round(maxSlantM),
    longestLinkM: Math.round(longestLinkM),
    reason: plan.radio.reason,
  };
}

/** The default target cell set used by the cover-goal tests and callers. */
export function cellsForPlanet(planet: Planet, cellDeg: number): CoverageCellPoint[] {
  return coverageCellsFor(planet, cellDeg);
}
