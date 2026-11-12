/**
 * Which obstacle each link medium respects — one rule, one place.
 *
 * ## Why this is a constant and not a knob
 *
 * Decided by experiment on the test server (`hermes-se-test`, EarthLike,
 * 2026-11-10). The question was whether Space Engineers radio requires a clear
 * line of sight or only range; the coverage planner used to assume LOS for
 * everything and blocked cells behind ridges.
 *
 * 1. Geometry used: two grids 27.96 km apart on opposite sides of a ridge
 *    (the game's own 2048-res heightmap: ground radii 61.90 km and 63.64 km,
 *    crest 66.99 km). 12-sample slant path: the chord passes 480 m *inside*
 *    the rock.
 * 2. The deployed test plugin cannot read a radio pair link at all:
 *    `radio_links.sameLogicalGroup` is `MyAntennaSystem.GetLogicalGroupRepresentative`,
 *    which follows `MyCubeGridGroups.Logical` (rotor/piston/connector groups),
 *    not antennas. Measured: two grids with 50 km antennas at 500 m, and a grid
 *    200 m from BASE-01 with both antennas on, both reported "different group".
 *    So that field is not evidence either way and is no longer quoted as such.
 * 3. The shipped assembly decides it: an exhaustive IL scan of the whole radio
 *    path (`MyAntennaSystem`, `MyGridRadioSystem`, `MyDataBroadcaster`,
 *    `MyDataReceiver`, `MyRadioAntenna`, `MyBeacon`; 349 methods,
 *    `Sandbox.Game.dll` 01_210_014) finds **zero** references to
 *    `CastRay`/`Raycast`/`Voxel`/`Intersect`/`LineOfSight`. Radio relay
 *    resolution walks `MyDataReceiver.BroadcastersInRange` /
 *    `MyDataBroadcaster.ReceiversInRange`, i.e. distance only. The only LOS
 *    code in the comms area is `MyLaserAntenna.LosTest`, which intersects the
 *    voxel map (`MyPlanetStorageProvider::IntersectExact`) and calls
 *    `MyPhysics::CastRay`.
 *
 * Therefore: radio is range-limited only; lasers need line of sight. Treating
 * radio as LOS-limited over-places relays (see docs/architecture.md).
 *
 * `RTS_RADIO_LOS=1` restores the old, pessimistic rule so the two models can be
 * compared without editing code.
 */

/** Obstruction rule for the radio medium. */
export type RadioRule = 'range' | 'range+los';

/** Obstruction rule for the laser medium (always needs a clear slant path). */
export type LaserRule = 'los';

/** Obstruction rule for one link medium. */
export type MediumRule = RadioRule | LaserRule;

/** The rule discovered by the experiment. Change only with new measurements. */
export const MEDIUM_RULES = {
  radio: 'range',
  laser: 'los',
} as const satisfies Record<'radio' | 'laser', MediumRule>;

/** Per-medium rule used by the coverage planner (laser is always LOS). */
export interface MediumRules {
  radio: RadioRule;
  laser: LaserRule;
}

/** Environment override that restores the pre-experiment radio rule. */
export const RADIO_LOS_ENV = 'RTS_RADIO_LOS';

/** True when the caller asked for the legacy "radio needs LOS" model. */
export function radioNeedsLos(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[RADIO_LOS_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Radio rule for this call: env override first, measured constant second. */
export function radioRuleFromEnv(env: NodeJS.ProcessEnv = process.env): RadioRule {
  return radioNeedsLos(env) ? 'range+los' : MEDIUM_RULES.radio;
}

/** Both rules for a plan, so the result can be labelled without guessing. */
export function mediumRules(radioRule: RadioRule = radioRuleFromEnv()): MediumRules {
  return { radio: radioRule, laser: MEDIUM_RULES.laser };
}
