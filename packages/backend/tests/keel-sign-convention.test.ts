/**
 * THE KEEL SIGN CONVENTION, pinned with the in-game numbers from flight set 4
 * (2026-11-11). One helper each way, and they must stay exact inverses:
 *
 *   hullBottomAglM(pivotAglM, keelDepthM)                = pivotAglM - keelDepthM
 *   pivotRadiusForHullBottomAgl(ground, keelDepthM, agl) = ground + keelDepthM + agl
 *
 * `keelDepthM` is the signed pivot -> lowest-AABB-point distance along local
 * down: POSITIVE when the hull extends below the pivot, NEGATIVE when the hull
 * bottom sits ABOVE the pivot. SAT-R-0001 is the negative case:
 *
 *   inspect: localAABB y 8.75..18.75, keelDepthM -8.75, pivot radius 61 264.18
 *   -> the hull bottom is at 61 272.93, i.e. 8.75 m ABOVE the pivot and 75.07 m
 *      above the 61 197.86 m ground datum.
 *
 * The "57.6 m hover" in data/flight-proof-20261111.md is `pivotAgl + keel`, the
 * inverted reading; it is pinned here as WRONG so it cannot come back.
 */
import { describe, expect, it } from 'vitest';
import {
  LANDING_APPROACH_TARGET_AGL_M,
  hullBottomAglM,
  pivotRadiusForHullBottomAgl,
} from '../src/demo/flight.js';

/** Ground radius at the set-4 hover column (plan datum, level 5), m. */
const GROUND_M = 61_197.86;
/** SAT-R-0001's keel from telemetry (`keelSource: local-aabb`), m. */
const KEEL_M = -8.74;
/** The come-to-me ask: hull bottom 80 m up. */
const ASK_M = 80;

describe('keel sign convention (flight set 4 numbers)', () => {
  it('builds the pivot radius for a NEGATIVE keel by ADDING the keel', () => {
    const pivot = pivotRadiusForHullBottomAgl(GROUND_M, KEEL_M, ASK_M);
    // 61 197.86 - 8.74 + 80: the hull bottom sits 80 m up, not 97.5 m and not
    // 62.5 m. (61 286.60 would be the inverted convention: belly at 97.5 m.)
    expect(pivot).toBeCloseTo(61_269.12, 2);
    expect(pivot).not.toBeCloseTo(61_286.6, 2);
    // And the same point read back is the ask, to the centimetre.
    expect(hullBottomAglM(pivot - GROUND_M, KEEL_M)).toBeCloseTo(ASK_M, 6);
  });

  it('is an exact inverse for both keel signs and for a zero keel', () => {
    for (const keel of [KEEL_M, -10, -0.5, 0, 0.5, 10, 18.75]) {
      for (const agl of [0, 1, 15, 80, 100]) {
        const pivot = pivotRadiusForHullBottomAgl(GROUND_M, keel, agl);
        expect(hullBottomAglM(pivot - GROUND_M, keel)).toBeCloseTo(agl, 9);
      }
    }
  });

  it('reads the settled set-4 hover as 75.07 m of hull bottom, not 57.6 m', () => {
    // The in-game inspect: pivot radius 61 264.18 with keel -8.75.
    const pivotAgl = 61_264.18 - GROUND_M;
    expect(hullBottomAglM(pivotAgl, -8.75)).toBeCloseTo(75.07, 2);
    // The proof's 57.6 came from `pivotAgl + keel`, which is the sign error.
    expect(hullBottomAglM(pivotAgl, -8.75)).not.toBeCloseTo(57.58, 1);
  });

  it('keeps every landing figure on the hull bottom for a negative keel', () => {
    // Negative keel: the pivot target sits BELOW the terrain by |keel| and the
    // hull bottom is where the target says it is.
    const approach = pivotRadiusForHullBottomAgl(
      GROUND_M,
      KEEL_M,
      LANDING_APPROACH_TARGET_AGL_M,
    );
    expect(approach - GROUND_M).toBeCloseTo(KEEL_M + LANDING_APPROACH_TARGET_AGL_M, 9);
    expect(hullBottomAglM(approach - GROUND_M, KEEL_M)).toBeCloseTo(
      LANDING_APPROACH_TARGET_AGL_M,
      9,
    );
    // Touchdown: pivot |keel| under the terrain, belly on it.
    const touchdown = pivotRadiusForHullBottomAgl(GROUND_M, KEEL_M, 0);
    expect(touchdown - GROUND_M).toBeCloseTo(KEEL_M, 9);
    expect(hullBottomAglM(touchdown - GROUND_M, KEEL_M)).toBeCloseTo(0, 9);
  });

  it('measures the readiness audit row with the same helper', () => {
    // `come_to_me_ready.planDatumAgl` = hull-bottom AGL of the pivot on the plan
    // datum. At 7.5 m from an 80 m point the row read 72.1: consistent only
    // with this sign (an inverted read would have said 63.4).
    const pivotAgl = 72.1 + KEEL_M; // the pivot altitude that produced 72.1
    expect(hullBottomAglM(pivotAgl, KEEL_M)).toBeCloseTo(72.1, 6);
    expect(hullBottomAglM(pivotAgl, KEEL_M)).not.toBeCloseTo(72.1 - 2 * KEEL_M, 1);
  });
});
