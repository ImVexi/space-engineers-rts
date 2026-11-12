/**
 * A come-to-me hover height may only be built on LANDING-GRADE ground, and a
 * coarse sample may only ever raise the hull (2026-11-11, run set 3).
 *
 * Measured in game: asked for 80 m of hull bottom, flew to a hold the executor
 * had recorded with `ownColumnGroundRadiusM 61160.7` (the level-0 planning
 * field) and the hull sat **56.6 m** above the level-5 ground at its column
 * (61 198.24 m). The coarse field was 37.5 m LOW on that hillside, and the
 * executor had no datum of its own to judge the hold against - the mission's
 * `comeToMe` block dropped `groundRadiusM` on the way into `desiredState`.
 *
 * The policy pinned here:
 *   * level 3+ (level 5 where the service has it) -> the hover point is
 *     `ground + keel + ask`, exactly the point the route built;
 *   * level 0 only -> `ground + keel + ask + COME_TO_ME_COARSE_DATUM_MARGIN_M`,
 *     so the error is assumed against us and the hull can only end up HIGHER
 *     than asked - never lower;
 *   * the caller waits COME_TO_ME_COARSE_DATUM_WAITS ticks for the fine read
 *     before it falls back (exercise: the executor test in
 *     `come-to-me-hold-floor.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  COME_TO_ME_COARSE_DATUM_MARGIN_M,
  hoverHoldDatum,
  levelFromGroundSource,
} from '../src/demo/comeToMe.js';

/** The hover column, level 5 (the datum the route built the point with), m. */
const HOVER_COLUMN_L5_M = 61_198.24;
/** The same column through the level-0 planning field, m. */
const HOVER_COLUMN_L0_M = 61_160.7;
/** SAT-R-0001's keel: negative = the hull bottom sits ABOVE the pivot. */
const KEEL_M = -8.74;
/** The ask: hull bottom 80 m up. */
const ASK_M = 80;
/** The pivot radius the plugin was actually ordered to hold in set 3, m. */
const FLOWN_HOLD_RADIUS_M = 61_269.506;

/** Hull bottom AGL for a pivot radius on a ground radius (flight.ts rule). */
const hullBottomAgl = (pivotRadiusM: number, groundRadiusM: number): number =>
  pivotRadiusM - KEEL_M - groundRadiusM;

describe('come-to-me hover datum (2026-11-11 set 3)', () => {
  it('rebuilds the flown hold point exactly from the level-5 ground', () => {
    const datum = hoverHoldDatum({
      sampleRadiusM: HOVER_COLUMN_L5_M,
      level: 5,
      source: 'terrain-l5',
      keelDepthM: KEEL_M,
      requestedAglM: ASK_M,
    });
    expect(datum.coarse).toBe(false);
    expect(datum.marginM).toBe(0);
    expect(datum.source).toBe('terrain-l5');
    // 61 198.24 - 8.74 + 80 = 61 269.50: the point the plugin held in set 3.
    expect(datum.hoverRadiusM).toBeCloseTo(61_269.5, 2);
    expect(datum.hoverRadiusM).toBeCloseTo(FLOWN_HOLD_RADIUS_M, 1);
    // And the hull bottom it puts there is the ask, to the centimetre.
    expect(hullBottomAgl(datum.hoverRadiusM, HOVER_COLUMN_L5_M)).toBeCloseTo(ASK_M, 2);
  });

  it('never lets the level-0 datum place the hull lower than asked', () => {
    const datum = hoverHoldDatum({
      sampleRadiusM: HOVER_COLUMN_L0_M,
      level: 0,
      source: 'terrain-l0',
      keelDepthM: KEEL_M,
      requestedAglM: ASK_M,
    });
    expect(datum.coarse).toBe(true);
    expect(datum.marginM).toBe(COME_TO_ME_COARSE_DATUM_MARGIN_M);
    expect(datum.source).toBe('terrain-l0+margin');
    // The coarse sample is 37.5 m low here; without the margin this point would
    // be 61 231.96 (42.5 m of hull bottom on level 5). With it, 61 271.96.
    expect(datum.hoverRadiusM).toBeCloseTo(HOVER_COLUMN_L0_M + COME_TO_ME_COARSE_DATUM_MARGIN_M + 80 + KEEL_M, 2);
    expect(datum.hoverRadiusM).toBeGreaterThan(FLOWN_HOLD_RADIUS_M);
    // On the TRUE ground the hull ends up at or above the ask, never below.
    expect(hullBottomAgl(datum.hoverRadiusM, HOVER_COLUMN_L5_M)).toBeGreaterThanOrEqual(ASK_M);
    // ... and the same holds for the whole measured error band (0-37.5 m).
    for (const trueGround of [HOVER_COLUMN_L0_M, HOVER_COLUMN_L0_M + 20, HOVER_COLUMN_L5_M]) {
      expect(hullBottomAgl(datum.hoverRadiusM, trueGround)).toBeGreaterThanOrEqual(ASK_M);
    }
  });

  it('scales the margin with the ask, not with the keel sign', () => {
    const positiveKeel = hoverHoldDatum({
      sampleRadiusM: HOVER_COLUMN_L0_M,
      level: 0,
      source: 'terrain-l0',
      keelDepthM: 9, // a hull whose belly reaches 9 m BELOW the pivot
      requestedAglM: ASK_M,
    });
    expect(positiveKeel.hoverRadiusM).toBeCloseTo(HOVER_COLUMN_L0_M + 40 + 9 + ASK_M, 2);
    expect(positiveKeel.coarse).toBe(true);
  });

  it('takes level 3 as landing grade and adds no margin to it', () => {
    const datum = hoverHoldDatum({
      sampleRadiusM: HOVER_COLUMN_L5_M - 2,
      level: 3,
      source: 'terrain-l3',
      keelDepthM: KEEL_M,
      requestedAglM: ASK_M,
    });
    expect(datum.coarse).toBe(false);
    expect(datum.marginM).toBe(0);
    expect(hullBottomAgl(datum.hoverRadiusM, HOVER_COLUMN_L5_M - 2)).toBeCloseTo(ASK_M, 2);
  });

  it('honours an explicit margin and a zero ask', () => {
    const datum = hoverHoldDatum({
      sampleRadiusM: HOVER_COLUMN_L0_M,
      level: null,
      source: 'mean',
      keelDepthM: KEEL_M,
      requestedAglM: 0,
      marginM: 12,
    });
    expect(datum.marginM).toBe(12);
    expect(datum.source).toBe('mean+margin');
    expect(datum.hoverRadiusM).toBeCloseTo(HOVER_COLUMN_L0_M + 12 + KEEL_M, 2);
  });

  it('reads the tile level out of a source label', () => {
    expect(levelFromGroundSource('terrain-l5')).toBe(5);
    expect(levelFromGroundSource('terrain-l0')).toBe(0);
    expect(levelFromGroundSource('terrain-l3')).toBe(3);
    expect(levelFromGroundSource('mean')).toBeNull();
    expect(levelFromGroundSource(null)).toBeNull();
    expect(levelFromGroundSource(undefined)).toBeNull();
  });
});
