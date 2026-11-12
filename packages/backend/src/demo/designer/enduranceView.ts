/**
 * Shared endurance view for designer plans: one hull at one slot, rendered in
 * the shape the API exposes (`OptionEndurance`). Extracted so the new planner
 * modes and the existing constellation/connect modes cannot drift apart.
 */
import type { Planet } from '@se-rts/schemas';
import {
  evaluateHullAtSlot,
  hullForDesigner,
  type EnduranceReport,
} from '../endurance/index.js';
import type { DesignerHull } from './hulls.js';

export interface OptionEndurance {
  available: boolean;
  /** False for connect anchors: the endpoint is a geometric waypoint, not a station-keeping slot. */
  enforced: boolean;
  modelReason: string | null;
  canReachSlot: boolean | null;
  launch: 'surface' | 'orbital' | null;
  ascentTimeS: number | null;
  transitTimeS: number | null;
  etaS: number | null;
  fuelUsedPct: number | null;
  batteryUsedPct: number | null;
  reservePct: number | null;
  holdEnduranceS: number | 'indefinite' | null;
  holdEnduranceText: string;
  holdLimiting: string | null;
  holdPowerMW: number | null;
  holdH2BurnLps: number | null;
  twrAtSlot: number | null;
  failureReason: string | null;
  recommendation: string;
}

export function enduranceView(
  hull: DesignerHull,
  planet: Planet,
  altitudeM: number,
  transitDistanceM: number,
): OptionEndurance {
  const adapted = hullForDesigner(hull);
  if (!adapted.hull) {
    return {
      available: false,
      enforced: true,
      modelReason: adapted.reason,
      canReachSlot: null,
      launch: null,
      ascentTimeS: null,
      transitTimeS: null,
      etaS: null,
      fuelUsedPct: null,
      batteryUsedPct: null,
      reservePct: null,
      holdEnduranceS: null,
      holdEnduranceText: 'not modelled',
      holdLimiting: null,
      holdPowerMW: null,
      holdH2BurnLps: null,
      twrAtSlot: null,
      failureReason: null,
      recommendation: 'no endurance estimate: the hull has no definitions-derived power/tank data',
    };
  }
  const report: EnduranceReport = evaluateHullAtSlot({
    hull: adapted.hull,
    planet,
    altitudeM,
    transitDistanceM,
  });
  return {
    available: true,
    enforced: true,
    modelReason: adapted.reason,
    canReachSlot: report.canReachSlot,
    launch: report.launch,
    ascentTimeS: report.ascentTimeS,
    transitTimeS: report.transitTimeS,
    etaS: report.etaS,
    fuelUsedPct: report.fuelUsedPct,
    batteryUsedPct: report.batteryUsedPct,
    reservePct: report.reservePct,
    holdEnduranceS: report.holdEnduranceS,
    holdEnduranceText: report.holdEnduranceText,
    holdLimiting: report.holdLimiting,
    holdPowerMW: report.holdPowerMW,
    holdH2BurnLps: report.holdH2BurnLps,
    twrAtSlot: report.twrAtSlot,
    failureReason: report.failureReason,
    recommendation: report.recommendation,
  };
}
