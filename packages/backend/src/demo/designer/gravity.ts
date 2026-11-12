/**
 * SE planet gravity model (T6).
 *
 * Source of truth: `MySphericalNaturalGravityComponent` (Space Engineers
 * open-source tree, `Sources/Sandbox.Game/Game/Entities/Planet/`):
 *
 *   attenuation = (r / maxRadius) ^ -falloff          when r > maxRadius
 *   g           = 9.81 * surfaceGravityMultiplier * attenuation
 *   gravity is exactly 0 when r > gravityLimit,
 *   gravityLimit = maxRadius * (intensity / 0.05) ^ (1 / falloff)
 *
 * Planet values are read from the test world (`Saves/MiniLab5/SANDBOX_0_0_0_.sbs`):
 * EarthLike `Radius 60000`, `MinimumSurfaceRadius 59400`,
 * `MaximumHillRadius 67200`, `SurfaceGravity 1`, `GravityFalloff 7`.
 *
 * Check against the measured probe (docs/scenario-results.md, 2026-11-09):
 * 40 km AGL -> 0.665 m/s2 measured, this model gives 0.63 (the probe read one
 * vector axis, so 6 % is inside the sampling noise); gravity is cut off above
 * 43.7 km AGL, so the "0 g at ~60 km" probe is consistent.
 */
import type { Planet } from '@se-rts/schemas';

/** Standard gravity constant used by MyGravityProviderSystem.G. */
export const SE_G = 9.81;
const GRAVITY_LIMIT_STRENGTH = 0.05;

export interface PlanetGravity {
  /** SurfaceGravity multiplier from the planet generator (1 = EarthLike). */
  intensity: number;
  /** MinimumSurfaceRadius, metres. */
  minRadiusM: number;
  /** MaximumHillRadius, metres (the falloff reference radius). */
  maxRadiusM: number;
  /** GravityFalloff from the planet generator (7 on every stock planet). */
  falloff: number;
}

/**
 * Surface gravity multipliers. EarthLike and Moon are the two bodies used by
 * the test world and both were confirmed from the planet generator data; the
 * other entries are the generator's SurfaceGravity values and are labelled in
 * the plan as not re-verified.
 */
const SURFACE_G: Record<string, number> = {
  EarthLike: 1.0,
  Moon: 0.25,
  Alien: 1.1,
  Mars: 0.9,
  Titan: 0.25,
  Europa: 0.25,
};

export function planetGravity(planet: Pick<Planet, 'name' | 'surfaceRadiusM' | 'maxHillRadiusM'>): PlanetGravity {
  return {
    intensity: SURFACE_G[planet.name] ?? 1.0,
    minRadiusM: planet.surfaceRadiusM,
    maxRadiusM: planet.maxHillRadiusM,
    falloff: 7,
  };
}

/** Radius (from the planet centre) where SE cuts gravity to exactly zero. */
export function gravityLimitRadiusM(gravity: PlanetGravity): number {
  return gravity.maxRadiusM * Math.pow(gravity.intensity / GRAVITY_LIMIT_STRENGTH, 1 / gravity.falloff);
}

/** Gravity magnitude at a distance from the planet centre, m/s2. */
export function gravityAtRadius(gravity: PlanetGravity, radiusM: number): number {
  if (!(radiusM > 0)) return 0;
  if (radiusM > gravityLimitRadiusM(gravity)) return 0;
  if (radiusM <= gravity.minRadiusM) {
    // Inside the minimum surface radius the game scales down linearly; the
    // planner never places slots there, but the function stays total.
    return SE_G * gravity.intensity * Math.max(0.01, radiusM / gravity.minRadiusM);
  }
  if (radiusM <= gravity.maxRadiusM) return SE_G * gravity.intensity;
  return SE_G * gravity.intensity * Math.pow(radiusM / gravity.maxRadiusM, -gravity.falloff);
}

/** Gravity at `altitudeM` above MinimumSurfaceRadius, m/s2. */
export function gravityAtAltitude(gravity: PlanetGravity, altitudeM: number): number {
  return gravityAtRadius(gravity, gravity.minRadiusM + altitudeM);
}

/** Lowest altitude (m AGL) where gravity is exactly zero on this planet. */
export function gravityFreeAltitudeM(gravity: PlanetGravity): number {
  return Math.max(0, gravityLimitRadiusM(gravity) - gravity.minRadiusM);
}

/** EarthLike: ~43.7 km. Used for docs/tests and the designer's hint. */
export const EARTHLIKE_GRAVITY_FREE_ALTITUDE_M = 43_692;
