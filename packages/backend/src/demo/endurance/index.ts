/**
 * Endurance model entry point.
 *
 * `hullForDesigner` adapts a `/designer/hulls` entry into the physics model.
 * Prefab hulls use the exact definition-resolved block banks; an owner-tagged
 * hull only gets a model when the plugin supplied mass, plant and tank state.
 */
import type { DesignerHull } from '../designer/hulls.js';
import { PREFAB_HARDWARE, type ThrusterKind } from './definitions.js';
import { hullFromSpec, type EnduranceHull } from './model.js';

export * from './definitions.js';
export * from './model.js';

/**
 * Representative electric/fuel power per meganewton for a hull whose thruster
 * *counts* are unknown but whose force split is measured. Ion and atmo numbers
 * are the large-block ratios; hydrogen is its large-block ratio. Only used for
 * owner-tagged grids that report power and tanks; prefabs never take this path.
 */
const POWER_PER_MN: Record<ThrusterKind, number> = {
  ion: 33.6 / 4.32,
  atmo: 16.8 / 6.48,
  h2: 7.5 / 7.2,
};

export interface DesignerEndurance {
  hull: EnduranceHull | null;
  reason: string | null;
}

export function hullForDesigner(hull: DesignerHull): DesignerEndurance {
  if (hull.source === 'prefab') {
    const hardware = PREFAB_HARDWARE[hull.name];
    if (!hardware || hull.massKg === null) {
      return { hull: null, reason: `no definitions-derived hardware for prefab ${hull.name}` };
    }
    return { hull: hullFromSpec({ ...hardware, massKg: hull.massKg }), reason: null };
  }
  if (hull.massKg === null || !hull.power || !hull.tanks) {
    return {
      hull: null,
      reason:
        'owner-tagged hull has no mass/power/tank state from list_tagged; the endurance model needs a profile action, so the launch gate is unavailable for it',
    };
  }
  const bank = (kind: ThrusterKind, forceN: number) => ({
    forceN,
    powerMW: (forceN / 1e6) * POWER_PER_MN[kind],
    count: 0,
  });
  return {
    hull: {
      id: hull.id,
      name: hull.name,
      gridSize: hull.gridSize ?? 'large',
      massKg: hull.massKg,
      massSource: 'measured',
      thrust: {
        atmo: bank('atmo', hull.thrust.atmo),
        ion: bank('ion', hull.thrust.ion),
        h2: bank('h2', hull.thrust.h2),
      },
      reactorMW: hull.power.reactorMW,
      batteryMWh: hull.power.batteryMWh,
      // Stock batteries discharge at 4C (12 MW / 3 MWh large, 0.2 / 0.05 small).
      batteryOutputMW: hull.power.batteryMWh * 4,
      solarPeakMW: hull.power.solarPeakMW,
      h2CapacityL: hull.tanks.h2Litres,
      h2Fill: hull.tanks.h2FillPct / 100,
      batteryFill: hull.tanks.batteryFillPct / 100,
    },
    reason: 'power per thruster type is a representative large-block ratio (ASSUMPTION: the profile reports force, not per-block subtype counts)',
  };
}
