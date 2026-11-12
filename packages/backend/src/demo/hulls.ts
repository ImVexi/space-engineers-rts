/**
 * Hull selection for demo drones.
 *
 * Every number here was measured on the TEST server (`SE-RTS Test Lab`,
 * MiniLab5, 2026-11-09) with the capability profile action - see
 * `docs/scenario-results.md` (T5, hull trials). Nothing is copied from the
 * prefab survey: mass and TWR cannot be read from XML.
 *
 * Two spawn modes exist because thrust type decides where a hull can hover:
 *
 *  - `surface`: a hull with atmospheric or hydrogen thrust can hold against
 *    gravity inside an atmosphere.
 *  - `orbital`: an ion-only hull cannot hold inside an atmosphere (ion thrust
 *    decays with air density), so the executor spawns it above the atmosphere
 *    (`surface * AtmosphereTopModifier + margin`) where gravity is zero and
 *    full ion thrust is available. This is labelled "orbital spawn".
 *
 * A gravity hull is only usable if it also carries a radio antenna: the
 * command gate needs a planner path over radio/laser range. There is no
 * vanilla gravity hull with both a long-range antenna and an RC in this DS
 * content, so `gravityHull` stays opt-in (RTS_DEMO_HULL_GRAVITY) and the
 * default demo keeps the ion relay with an orbital spawn.
 */
export type HullClass = 'ion' | 'gravity' | 'mixed';
export type SpawnMode = 'surface' | 'orbital';

export interface HullSpec {
  prefab: string;
  hullClass: HullClass;
  /** Largest radio antenna radius on the grid, metres. 0 = no antenna. */
  radioRadiusM: number;
  /** Measured grid mass in kg. */
  massKg: number;
  /** Sum of nominal thruster force, newtons. */
  thrustN: number;
  /** Measured TWR at the sampled altitude (gravity hulls) or in vacuum. */
  twrMeasured: number;
  /** Altitude of the TWR sample above the surface, metres. */
  measuredAtAglM: number;
  fuel: string;
  sourceNote: string;
}

export const HULLS: Record<string, HullSpec> = {
  'Eradicator_mk.1': {
    prefab: 'Eradicator_mk.1',
    hullClass: 'ion',
    radioRadiusM: 50_000,
    massKg: 2_071_825,
    thrustN: 20_908_800,
    twrMeasured: 1.03,
    measuredAtAglM: 68_000,
    fuel: 'reactor 300 MW + batteries',
    sourceNote:
      'measured 2026-11-09: 49 ion thrusters 20.9 MN, mass 2,071,825 kg, vacuum accel 10.09 m/s2 (> 9.81 g at surface, but effective ion thrust decays in air, so it falls in the atmosphere)',
  },
  'Large Control Drone': {
    prefab: 'Large Control Drone',
    hullClass: 'gravity',
    radioRadiusM: 1_000,
    massKg: 222_711,
    thrustN: 12_312_000,
    twrMeasured: 2.45,
    measuredAtAglM: 5_700,
    fuel: 'batteries 18 MWh',
    sourceNote:
      'measured 2026-11-09: 19 atmospheric thrusters 12.3 MN nominal / 5.35 MN effective at 5.7 km, TWR 2.45, radio 1 km; the 1 km antenna needs a leg under ~900 m to stay gate-reachable',
  },
  'Escort TT-420': {
    prefab: 'Escort TT-420',
    hullClass: 'mixed',
    radioRadiusM: 0,
    massKg: 305_085,
    thrustN: 31_824_000,
    twrMeasured: 9.0,
    measuredAtAglM: 2_950,
    fuel: 'H2 15 M litres at 99.96 %, 18 MWh batteries, 15 MW reactor',
    sourceNote:
      'measured 2026-11-09: 10 atmo + 7 H2 thrusters, 26.9 MN effective at 2.9 km, TWR 9.0; NO radio antenna, so the comms gate refuses it unless an antenna is fitted',
  },
};

export function getHull(prefab: string): HullSpec | null {
  return HULLS[prefab] ?? null;
}

export interface HullChoice {
  prefab: string;
  hullClass: HullClass;
  spawnMode: SpawnMode;
  reason: string;
}

export interface SelectHullOptions {
  /** Opt-in gravity hull for atmospheric slots (config RTS_DEMO_HULL_GRAVITY). */
  gravityHull?: string | null;
  /** Orbital spawn altitude above the surface, metres (default 40 km: measured
   * gravity is 0.67 m/s2 there vs 9.8 at 20 km, where the ion hull still falls). */
  orbitAglM?: number;
}

/**
 * Pick the spawn mode for a planned prefab on a given planet.
 *
 * Order of precedence:
 *  1. no capability profile -> planned prefab, surface spawn, labelled UNKNOWN
 *  2. gravity/mixed hull -> surface spawn
 *  3. ion hull + atmosphere -> orbital spawn (the point of this module)
 *  4. ion hull + airless body -> surface spawn (no atmosphere to decay thrust)
 *  5. atmospheric slot with a configured gravity hull -> that hull, surface
 */
export function selectHull(
  planned: string,
  planet: { name?: string; hasAtmosphere?: boolean } | null,
  opts: SelectHullOptions = {},
): HullChoice {
  const atmo = planet?.hasAtmosphere === true;
  const where = planet?.name ? ` on ${planet.name}` : '';
  const hull = getHull(planned);

  if (!hull) {
    return {
      prefab: planned,
      hullClass: 'ion',
      spawnMode: 'surface',
      reason: `UNKNOWN hull ${planned}: no measured capability profile, surface spawn (TWR unverified)`,
    };
  }

  if (opts.gravityHull && atmo) {
    const g = getHull(opts.gravityHull);
    if (g && g.hullClass !== 'ion') {
      return {
        prefab: g.prefab,
        hullClass: g.hullClass,
        spawnMode: 'surface',
        reason: `GRAVITY HULL: ${g.prefab} substituted${where}; measured TWR ${g.twrMeasured.toFixed(2)} at ${g.measuredAtAglM} m AGL, ${g.radioRadiusM > 0 ? `radio ${g.radioRadiusM} m` : 'NO antenna (gate will refuse)'}`,
      };
    }
  }

  if (hull.hullClass !== 'ion') {
    return {
      prefab: planned,
      hullClass: hull.hullClass,
      spawnMode: 'surface',
      reason: `GRAVITY HULL: ${planned}${where}; measured TWR ${hull.twrMeasured.toFixed(2)} at ${hull.measuredAtAglM} m AGL`,
    };
  }

  if (atmo) {
    const agl = opts.orbitAglM ?? 40_000;
    return {
      prefab: planned,
      hullClass: 'ion',
      spawnMode: 'orbital',
      reason: `ORBITAL SPAWN: ${planned} is ion-only and ${planet?.name ?? 'the planet'} has an atmosphere; spawn ${Math.round(agl / 1000)} km above the surface where gravity has fallen to ~0.7 m/s2 (it is still 9.8 at 20 km)`,
    };
  }

  return {
    prefab: planned,
    hullClass: 'ion',
    spawnMode: 'surface',
    reason: `ION HULL: ${planned}${where} has no atmosphere above the surface, so full ion thrust is available at the normal spawn altitude`,
  };
}

/** One-line hardware summary for the demo UI / docs. */
export function hullTable(): string[] {
  return Object.values(HULLS).map(
    (h) =>
      `${h.prefab}: ${h.hullClass}, radio ${h.radioRadiusM ? `${h.radioRadiusM} m` : 'none'}, ` +
      `mass ${Math.round(h.massKg / 1000)} t, ${(h.thrustN / 1e6).toFixed(1)} MN, TWR ${h.twrMeasured.toFixed(2)} at ${h.measuredAtAglM} m`,
  );
}
