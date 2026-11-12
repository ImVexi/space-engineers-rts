/**
 * T10b: single-ship move-to.
 *
 * Resolves a human destination (a GPS point, "above planet X at altitude Y",
 * or a preset orbit) into coordinates, then answers the two questions the
 * owner actually asks before pressing the button:
 *
 *   - can the backend still reach the ship there (radio chain to a base)?
 *   - has it got fuel for the trip, and how long will it take?
 *
 * Reachability is planner range math (SIMULATED), exactly like the comms
 * gate. Nothing here sends an order; the route refuses or creates the mission.
 */
import type { Planet } from '@se-rts/schemas';
import { gravityAtAltitude, gravityFreeAltitudeM, planetGravity } from './designer/gravity.js';
import { atmosphereTopAltitudeM, thrustAtAltitude } from './endurance/model.js';
import { hardwareFrom } from './staging/hardware.js';
import { enduranceHullFor } from './staging/policy.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** `orbit-zero-g` parks above the gravity cutoff; `orbit-low` is a low pass. */
export const ORBIT_LOW_ALTITUDE_M = 20_000;
export const ORBIT_ZERO_G_MIN_ALTITUDE_M = 60_000;

export type MoveTargetPreset = 'orbit-zero-g' | 'orbit-low';
export type MoveTargetSpec =
  | { gps: Vec3 }
  | { planet: string; altitudeM: number }
  | MoveTargetPreset;

export interface ResolvedTarget {
  position: Vec3;
  planet: string | null;
  altitudeM: number | null;
  label: string;
  preset: MoveTargetPreset | null;
}

export interface MoveTargetError {
  code: string;
  message: string;
  hint: string;
}

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function norm(v: Vec3): Vec3 {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Planet whose surface is closest to the point (|r - surface|). */
export function nearestPlanetTo(pos: Vec3, planets: Planet[]): Planet | null {
  let best: Planet | null = null;
  let delta = Infinity;
  for (const p of planets) {
    const d = Math.abs(Math.hypot(pos.x - p.center.x, pos.y - p.center.y, pos.z - p.center.z) - p.surfaceRadiusM);
    if (d < delta) {
      delta = d;
      best = p;
    }
  }
  return best;
}

/** Gravity-free altitude for a planet, plus 5 km margin, never below 60 km. */
export function zeroGAltitudeM(planet: Planet): number {
  const free = gravityFreeAltitudeM(planetGravity(planet));
  return Math.round(Math.max(ORBIT_ZERO_G_MIN_ALTITUDE_M, free + 5_000));
}

/**
 * Direction from the planet centre to the ship, so "move above the planet"
 * keeps the current ground track. Falls back to +X when the ship is nowhere
 * near the planet (a click from deep space still has to resolve somewhere).
 */
function radialDirection(ship: Vec3 | null, planet: Planet): Vec3 {
  if (ship) {
    const d = { x: ship.x - planet.center.x, y: ship.y - planet.center.y, z: ship.z - planet.center.z };
    const r = len(d);
    if (r > planet.surfaceRadiusM * 0.5 && r < planet.maxHillRadiusM * 20) return norm(d);
  }
  return { x: 1, y: 0, z: 0 };
}

export function resolveMoveTarget(args: {
  target: MoveTargetSpec;
  ship: Vec3 | null;
  planets: Planet[];
}): { target: ResolvedTarget } | { error: MoveTargetError } {
  const { target, ship, planets } = args;
  if (typeof target === 'string') {
    const planet = ship ? nearestPlanetTo(ship, planets) : planets.find((p) => p.name === 'EarthLike') ?? planets[0] ?? null;
    if (!planet) {
      return {
        error: { code: 'unknown_planet', message: 'no planet catalog is available', hint: 'Reload the test world and retry.' },
      };
    }
    const altitudeM = target === 'orbit-zero-g' ? zeroGAltitudeM(planet) : ORBIT_LOW_ALTITUDE_M;
    const dir = radialDirection(ship, planet);
    return {
      target: {
        position: {
          x: planet.center.x + dir.x * (planet.surfaceRadiusM + altitudeM),
          y: planet.center.y + dir.y * (planet.surfaceRadiusM + altitudeM),
          z: planet.center.z + dir.z * (planet.surfaceRadiusM + altitudeM),
        },
        planet: planet.name,
        altitudeM,
        label: `${target === 'orbit-zero-g' ? 'gravity-free orbit' : 'low orbit'} above ${planet.name} at ${(altitudeM / 1000).toFixed(0)} km`,
        preset: target,
      },
    };
  }
  if ('gps' in target) {
    const planet = nearestPlanetTo(target.gps, planets);
    const altitudeM = planet
      ? Math.max(0, Math.round(Math.hypot(target.gps.x - planet.center.x, target.gps.y - planet.center.y, target.gps.z - planet.center.z) - planet.surfaceRadiusM))
      : null;
    return {
      target: {
        position: target.gps,
        planet: planet?.name ?? null,
        altitudeM,
        label: `GPS ${Math.round(target.gps.x)}, ${Math.round(target.gps.y)}, ${Math.round(target.gps.z)}`,
        preset: null,
      },
    };
  }
  const planet = planets.find((p) => p.name === target.planet || p.id === target.planet) ?? null;
  if (!planet) {
    return {
      error: {
        code: 'unknown_planet',
        message: `unknown planet ${target.planet}`,
        hint: 'Pick a planet from the list (EarthLike, Moon, …).',
      },
    };
  }
  if (!(target.altitudeM > 0)) {
    return {
      error: { code: 'invalid_target', message: 'altitudeM must be greater than 0', hint: 'Enter an altitude in metres, e.g. 60000.' },
    };
  }
  const dir = radialDirection(ship, planet);
  return {
    target: {
      position: {
        x: planet.center.x + dir.x * (planet.surfaceRadiusM + target.altitudeM),
        y: planet.center.y + dir.y * (planet.surfaceRadiusM + target.altitudeM),
        z: planet.center.z + dir.z * (planet.surfaceRadiusM + target.altitudeM),
      },
      planet: planet.name,
      altitudeM: target.altitudeM,
      label: `${target.altitudeM / 1000} km above ${planet.name}`,
      preset: null,
    },
  };
}

export interface ReachNode {
  id: string;
  /** Display name for the human message; falls back to the id. */
  name?: string | null;
  position: Vec3;
  radioRangeM: number | null;
  controlSource: boolean;
}

export interface ReachResult {
  reachable: boolean;
  /** Closest reachable node whose antenna can reach the point. */
  via: string | null;
  /** Display name of `via`, for the human message. */
  viaName?: string | null;
  distanceM: number | null;
  requiredRangeM: number | null;
  /** Radio radius of the closest node, for the plain-language message. */
  nodeRangeM: number | null;
  reason: string;
}

/**
 * Can a control source reach `point` over a radio chain? Edges use
 * min(rangeA, rangeB) because a link needs both antennas. This is the same
 * range-math model as the comms gate (SIMULATED), not measured game state.
 */
export function reachAtPoint(point: Vec3, nodes: ReachNode[]): ReachResult {
  if (nodes.length === 0) {
    return { reachable: false, via: null, distanceM: null, requiredRangeM: null, nodeRangeM: null, reason: 'no relay or base is registered' };
  }
  const withRadio = nodes.filter((n) => typeof n.radioRangeM === 'number' && n.radioRangeM > 0);
  const adjacency = new Map<string, string[]>(withRadio.map((n) => [n.id, []]));
  for (let i = 0; i < withRadio.length; i += 1) {
    for (let j = i + 1; j < withRadio.length; j += 1) {
      const a = withRadio[i]!;
      const b = withRadio[j]!;
      const reach = Math.min(a.radioRangeM!, b.radioRangeM!);
      if (Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) <= reach) {
        adjacency.get(a.id)!.push(b.id);
        adjacency.get(b.id)!.push(a.id);
      }
    }
  }
  const seen = new Set<string>();
  const queue = withRadio.filter((n) => n.controlSource).map((n) => n.id);
  queue.forEach((id) => seen.add(id));
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  if (seen.size === 0) {
    return { reachable: false, via: null, distanceM: null, requiredRangeM: null, nodeRangeM: null, reason: 'no control source (base) is registered' };
  }
  const seenNodes = withRadio.filter((n) => seen.has(n.id));
  const directSources = seenNodes
    .filter((n) => n.controlSource && Math.hypot(n.position.x - point.x, n.position.y - point.y, n.position.z - point.z) <= n.radioRangeM!)
    .sort(
      (a, b) =>
        Math.hypot(a.position.x - point.x, a.position.y - point.y, a.position.z - point.z) -
        Math.hypot(b.position.x - point.x, b.position.y - point.y, b.position.z - point.z),
    );
  if (directSources.length > 0) {
    // A direct base link is the honest answer; do not report a nearer relay
    // whose own antenna cannot carry the point.
    const best = directSources[0]!;
    const distance = Math.hypot(best.position.x - point.x, best.position.y - point.y, best.position.z - point.z);
    return {
      reachable: true,
      via: best.id,
      viaName: best.name ?? best.id,
      distanceM: Math.round(distance),
      requiredRangeM: Math.round(distance),
      nodeRangeM: best.radioRangeM,
      reason: `inside ${best.name ?? best.id}'s ${(best.radioRangeM! / 1000).toFixed(0)} km radio (${(distance / 1000).toFixed(1)} km)`,
    };
  }
  const nearestOf = (nodes: ReachNode[]) => {
    let pick: ReachNode | null = null;
    let pickDistance = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(node.position.x - point.x, node.position.y - point.y, node.position.z - point.z);
      if (d < pickDistance) {
        pickDistance = d;
        pick = node;
      }
    }
    return { pick, pickDistance };
  };
  // No direct base link: a relay whose own antenna carries the point is the
  // next honest answer (the chain is already known to reach that relay).
  const fromRelay = nearestOf(
    seenNodes.filter(
      (n) => !n.controlSource && Math.hypot(n.position.x - point.x, n.position.y - point.y, n.position.z - point.z) <= n.radioRangeM!,
    ),
  );
  if (fromRelay.pick) {
    const best = fromRelay.pick;
    const distance = fromRelay.pickDistance;
    return {
      reachable: true,
      via: best.id,
      viaName: best.name ?? best.id,
      distanceM: Math.round(distance),
      requiredRangeM: Math.round(distance),
      nodeRangeM: best.radioRangeM,
      reason: `inside ${best.name ?? best.id}'s ${(best.radioRangeM! / 1000).toFixed(0)} km radio (${(distance / 1000).toFixed(1)} km)`,
    };
  }
  // Refusal: the owner needs the network's reach, not the nearest satellite,
  // so name the closest control source when there is one.
  const fromBase = nearestOf(seenNodes.filter((n) => n.controlSource));
  const fallback = fromBase.pick ? fromBase : nearestOf(seenNodes);
  const best = fallback.pick;
  const bestDistance = fallback.pickDistance;
  if (!best) {
    return { reachable: false, via: null, distanceM: null, requiredRangeM: null, nodeRangeM: null, reason: 'no reachable node has a radio antenna' };
  }
  return {
    reachable: false,
    via: best.id,
    viaName: best.name ?? best.id,
    distanceM: Math.round(bestDistance),
    requiredRangeM: Math.round(bestDistance),
    nodeRangeM: best.radioRangeM,
    reason: `${(bestDistance / 1000).toFixed(1)} km from ${best.name ?? best.id}, whose radio reaches ${(best.radioRangeM! / 1000).toFixed(0)} km`,
  };
}

/**
 * Plain-language preflight for one ship to one destination.
 * Fuel is the live telemetry fraction; the model never invents a tank size.
 */
export interface ShipState {
  gridId: string;
  name: string;
  position: Vec3;
  /** Altitude above the nearest planet surface, when known. */
  altitudeM: number | null;
  massKg: number | null;
  fuelPct: number | null;
  batteryPct: number | null;
  thrust: { atmo: number; ion: number; h2: number } | null;
  /** Body the ship is orbiting; used for the atmosphere/thrust curve. */
  planet?: Planet | null;
}

export interface MovePreflight {
  ok: boolean;
  canReach: boolean;
  linkText: string;
  fuelText: string;
  etaText: string;
  distanceM: number;
  etaS: number;
  altitudeM: number | null;
  fuelPct: number | null;
  batteryPct: number | null;
  /** Codes/hints for the first blocking problem, if any. */
  block: MoveTargetError | null;
  warnings: string[];
}

export function moveEtaS(distanceM: number, speedMps: number): number {
  return Math.round(distanceM / Math.max(1, speedMps));
}

export function formatDurationShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export function preflightMove(args: {
  ship: ShipState;
  target: ResolvedTarget;
  reach: ReachResult;
  speedMps: number;
  ignoreReach: boolean;
  /**
   * T75: survival builds have no admin override, so the preflight text must not
   * offer one. Defaults to false (the test world's wording).
   */
  survivalMode?: boolean;
}): MovePreflight {
  const { ship, target, reach, speedMps, ignoreReach, survivalMode = false } = args;
  const distanceM = Math.round(
    Math.hypot(target.position.x - ship.position.x, target.position.y - ship.position.y, target.position.z - ship.position.z),
  );
  const etaS = moveEtaS(distanceM, speedMps);
  const warnings: string[] = [];
  let block: MoveTargetError | null = null;

  if (!reach.reachable && !ignoreReach) {
    const radioText = reach.nodeRangeM ? `${Math.round(reach.nodeRangeM / 1000)} km` : 'base';
    const distanceText = reach.distanceM !== null ? ` (${(reach.distanceM / 1000).toFixed(1)} km away)` : '';
    block = {
      code: 'not_reachable',
      message: `The destination is not reachable from your network: ${reach.reason}.`,
      hint:
        `The point is outside ${reach.viaName ?? 'your base'}'s ${radioText} radio${distanceText}. ` +
        (survivalMode
          ? 'Lower the destination or add a relay within radio range.'
          : 'Lower the destination, add a relay within radio range, or use Admin override (test server).'),
    };
  }
  const thrust = ship.thrust;
  const noIon = !thrust || thrust.ion <= 0;
  const climbing = target.altitudeM !== null && target.altitudeM > (ship.altitudeM ?? 0);
  const targetAltitude = target.altitudeM ?? ship.altitudeM ?? 0;
  // A 0 % tank is only a blocker when the climb actually needs hydrogen.
  // Atmosphere (and ion, when fitted) carry the low part of a climb; refusing
  // an atmo-only ship a 300 m hop at 2 km was wrong (T13 case 1).
  if (!block && ship.fuelPct !== null && ship.fuelPct <= 0.001 && noIon && climbing) {
    const planet = ship.planet ?? null;
    const mass = ship.massKg;
    const measuredThrust = thrust !== null && (thrust.atmo > 0 || thrust.h2 > 0);
    if (planet && mass !== null && mass > 0 && measuredThrust) {
      const hull = enduranceHullFor(
        hardwareFrom({
          id: ship.gridId,
          name: ship.name,
          massKg: mass,
          thrustN: { atmo: thrust!.atmo, ion: thrust!.ion, h2: thrust!.h2 },
          source: 'live-profile',
        }),
        mass,
      );
      const available = thrustAtAltitude(hull, planet, targetAltitude);
      const gravity = gravityAtAltitude(planetGravity(planet), targetAltitude);
      const requiredN = mass * Math.max(gravity, 0) * 1.3; // climb margin (docs/staging.md)
      const noFuelForceN = available.forceN.atmo + available.forceN.ion;
      const coverPct = requiredN <= 0 ? 100 : Math.round((noFuelForceN / requiredN) * 100);
      if (noFuelForceN >= requiredN) {
        warnings.push(
          `Hydrogen is empty; atmosphere covers ${coverPct} % of the ${Math.round(requiredN / 1000)} kN climb at ${Math.round(targetAltitude)} m (staging keeps H2 off anyway).`,
        );
      } else {
        block = {
          code: 'no_fuel',
          message: `The ship has 0 % hydrogen and atmosphere/ion cover only ${coverPct} % of the ${Math.round(requiredN / 1000)} kN climb at ${Math.round(targetAltitude)} m.`,
          hint: 'Refuel the ship, lower the destination into thicker air, or add ion thrusters.',
        };
      }
    } else {
      // No measured thrust split: only refuse where atmosphere cannot help.
      const atmoTop = planet ? atmosphereTopAltitudeM(planet) : 15_000;
      if (targetAltitude > atmoTop) {
        block = {
          code: 'no_fuel',
          message: `The ship has 0 % hydrogen and the destination (${Math.round(targetAltitude)} m) is above the ${Math.round(atmoTop)} m atmosphere.`,
          hint: 'Refuel the ship, pick a lower destination, or add ion thrusters.',
        };
      } else {
        warnings.push('Hydrogen is empty; this climb relies on atmospheric thrusters (no live thrust split to verify the margin).');
      }
    }
  }
  if (ship.fuelPct !== null && ship.fuelPct > 0.001 && ship.fuelPct < 0.2) {
    warnings.push(`Only ${ship.fuelPct.toFixed(1)} % hydrogen left: top up before a long climb.`);
  }
  if (ship.position && target.altitudeM !== null && ship.altitudeM !== null && target.altitudeM < 1_000) {
    warnings.push('The destination is at ground level: the ship may need to land, not just hold.');
  }

  const linkText = reach.reachable
    ? `linked via ${reach.viaName ?? reach.via}: ${reach.reason}`
    : ignoreReach && !survivalMode
      ? `not linked (${reach.reason}) — ADMIN OVERRIDE will fly it outside the network`
      : `not linked: ${reach.reason}`;
  const fuelText =
    ship.fuelPct === null
      ? 'fuel: no telemetry (unknown)'
      : `fuel: hydrogen ${ship.fuelPct.toFixed(0)} %, battery ${ship.batteryPct === null ? 'unknown' : `${ship.batteryPct.toFixed(0)} %`}`;
  const etaText = `ETA ~${formatDurationShort(etaS)} at ${speedMps} m/s over ${(distanceM / 1000).toFixed(1)} km`;

  return {
    ok: block === null,
    canReach: reach.reachable,
    linkText,
    fuelText,
    etaText,
    distanceM,
    etaS,
    altitudeM: target.altitudeM,
    fuelPct: ship.fuelPct,
    batteryPct: ship.batteryPct,
    block,
    warnings,
  };
}
