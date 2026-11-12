/**
 * ONE ground function for every caller that needs "the ground radius at this
 * column".
 *
 * Why this module exists (measured 2026-11-11, both in game): `comeToMe` built
 * its hover point with an awaited level-5 terrain sample (ground 61 162.9 m at
 * the hover column) and the executor's hold guard re-sampled the SAME column
 * through its own cache and got 61 190 m from the level-0 planning field - a
 * 27 m disagreement that turned an 80 m clearance into 59 m and refused a legal
 * hover. `land_at` was handed 61 156.4 where level-5 reads 61 177.9. Two
 * samplers with two caches and two fallback orders cannot agree, and the one
 * that vetoes is whichever ran last.
 *
 * The rules here, once:
 *   * finest first: the finest terrain tile the service serves (level 5 ~30 m
 *     samples, matching hull contact within ~1 m; level 0 is ~1.5 km per sample
 *     and measured 31 m low on a landing column),
 *   * then the level-0 planning field, then the catalogue mean - and the
 *     source is named (`terrain-l5`, `terrain-l0`, `probe`, `mean`) so the
 *     audit can say which datum a decision used,
 *   * ONE cache, keyed by planet + column bucket, shared by the awaited
 *     (`loadColumnGround`) and the tick-time (`columnGround`) readers, and
 *     monotone: a coarse sample never replaces a fine one for the same column.
 *
 * A probe hit (`probe_ground`) is layered on top by the caller that has one:
 * `probe_ground` cannot see procedural planet terrain on this build, so it
 * refines a column, it never replaces the height field.
 */
import type { Planet } from '@se-rts/schemas';
import { FINE_TERRAIN_MIN_LEVEL, loadFineTerrainRadiusAt, loadTerrainField } from './terrain.js';

export type Vec3 = { x: number; y: number; z: number };

/** A ground sample for one column. */
export interface ColumnGround {
  /** Terrain radius along the column, m. */
  radiusM: number;
  /** `terrain-l5` ... `terrain-l3` | `terrain-l0` | `probe` | `mean`. */
  source: string;
  /** Tile level behind `radiusM` (0 = planning field), null for probe/mean. */
  level: number | null;
  /** The cache key this sample is filed under. */
  key: string;
  /** When it was read, ms. */
  at: number;
}

/** Column bucket size, m (~6 m at a 59 km radius: a few fetches per descent). */
export const GROUND_COLUMN_BUCKET_M = 6;

/**
 * A sample is LANDING GRADE when it came from a tile at or above
 * `FINE_TERRAIN_MIN_LEVEL` (level 3+; level 5 is the finest served). Only these
 * may be used to decide a brake, a flare, a hover height or a vertical datum
 * update: the level-0 planning field is ~1.5 km per sample and measured 37.1 m
 * low on this hillside (61 160.7 m vs 61 197.8 m at the same column).
 */
export function isLandingGrade(level: number | null | undefined): boolean {
  return typeof level === 'number' && level >= FINE_TERRAIN_MIN_LEVEL;
}
/**
 * How long a column sample stays valid. Long enough that a hover planned and
 * then flown arrives on the datum it was built with, short enough that a
 * re-shaped hillside is re-read.
 */
export const GROUND_SAMPLE_TTL_MS = 10 * 60_000;

const samples = new Map<string, ColumnGround>();
const inFlight = new Map<string, Promise<ColumnGround | null>>();

/**
 * Planet-qualified column key at GROUND_COLUMN_BUCKET_M resolution.
 *
 * The key must be a grid of METRES on the surface sphere. It was a grid of
 * `round(u*1e6)/6`, i.e. ~0.4 mm per bucket instead of 6 m (the division was by
 * the bucket size in a space where one bucket unit is 6e-9 of the unit
 * direction), so two reads of the SAME hilltop never shared a cache entry
 * unless the ship had not moved a millimetre. Every tick of a descent was
 * therefore a cold column: the awaited plan read filed level 5 at the plan's
 * column while the executor's readback fell back to the level-0 field and
 * reported 110.9 m AGL where the plan's own datum said 74.3 m (2026-11-11).
 *
 * Project the unit direction onto the surface sphere and bucket in metres.
 */
export function groundColumnKey(planet: Planet, dir: Vec3): string {
  const planetId = planet.id ?? planet.name;
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const radiusM = Number(planet.surfaceRadiusM ?? 0) || 60_000;
  const bucket = (v: number): string => Math.round(((v / len) * radiusM) / GROUND_COLUMN_BUCKET_M).toString();
  return `${planetId}:${bucket(dir.x)}:${bucket(dir.y)}:${bucket(dir.z)}`;
}

function withinPlanet(planet: Planet, radiusM: number): boolean {
  const surface = Number(planet.surfaceRadiusM ?? 0) || 0;
  const hill = Math.max(Number(planet.maxHillRadiusM ?? 0) || 0, surface);
  return radiusM > 1 && radiusM >= surface - 1 && radiusM <= hill * 2;
}

/**
 * File a sample for a column. Finest wins: a level-0 value never overwrites a
 * level-3+ one, so the number a decision used cannot get coarser behind it.
 */
export function rememberColumnGround(planet: Planet, dir: Vec3, sample: Omit<ColumnGround, 'key' | 'at'> & { at?: number }): ColumnGround | null {
  if (!Number.isFinite(sample.radiusM) || !withinPlanet(planet, sample.radiusM)) return null;
  const key = groundColumnKey(planet, dir);
  const existing = samples.get(key);
  const level = sample.level;
  if (existing) {
    // Higher tile level = FINER (5 is landing grade, 0 is the planning field).
    // A coarser or unlevelled (probe/mean) value never replaces a finer one.
    if (level === null) return existing;
    if (existing.level !== null && level < existing.level) return existing;
  }
  const entry: ColumnGround = {
    radiusM: sample.radiusM,
    source: sample.source,
    level: level ?? null,
    key,
    at: sample.at ?? Date.now(),
  };
  samples.set(key, entry);
  while (samples.size > 2_000) {
    const oldest = samples.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    samples.delete(oldest);
  }
  return entry;
}

/**
 * Best cached sample for this column, or null when nothing has been read here
 * yet (or the sample is older than GROUND_SAMPLE_TTL_MS). Never invents a
 * number: a cold column is null, and the caller says which datum it used.
 */
export function columnGround(planet: Planet, dir: Vec3, now = Date.now()): ColumnGround | null {
  const key = groundColumnKey(planet, dir);
  const hit = samples.get(key);
  if (!hit) return null;
  if (now - hit.at > GROUND_SAMPLE_TTL_MS) {
    samples.delete(key);
    return null;
  }
  return hit;
}

/**
 * Read the finest ground the terrain service can give for this column, and
 * file it. Falls back to the level-0 planning field, then null (= the caller
 * uses the catalogue mean and says so). Never throws: terrain is optional and
 * a failure must not block a flight tick.
 */
export async function loadColumnGround(planet: Planet, dir: Vec3): Promise<ColumnGround | null> {
  const key = groundColumnKey(planet, dir);
  const cached = columnGround(planet, dir);
  // A landing-grade sample is as good as it gets: reuse it.
  if (cached && (cached.level !== null && cached.level >= FINE_TERRAIN_MIN_LEVEL)) return cached;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = (async (): Promise<ColumnGround | null> => {
    try {
      const fine = await loadFineTerrainRadiusAt(planet, dir);
      if (fine && fine.level >= FINE_TERRAIN_MIN_LEVEL && withinPlanet(planet, fine.radiusM)) {
        return rememberColumnGround(planet, dir, {
          radiusM: fine.radiusM,
          source: `terrain-l${fine.level}`,
          level: fine.level,
        });
      }
    } catch {
      /* fall through to the planning field */
    }
    const again = columnGround(planet, dir);
    if (again) return again;
    try {
      const field = await loadTerrainField(planet);
      if (field.status === 'available') {
        const hit = field.radiusAt(dir);
        if (typeof hit === 'number' && Number.isFinite(hit) && withinPlanet(planet, hit)) {
          const level = typeof field.level === 'number' ? field.level : 0;
          return rememberColumnGround(planet, dir, { radiusM: hit, source: `terrain-l${level}`, level });
        }
      }
    } catch {
      /* no tiles at all: the caller falls back to the mean and says so */
    }
    return null;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * Kick the shared read for a column without waiting (the executor's tick is
 * synchronous). The result is filed in the same cache `loadColumnGround` reads,
 * so whoever asks next - a later tick, `comeToMe`, a guard - gets the fine
 * number instead of a second, coarser datum.
 */
export function requestColumnGround(planet: Planet, dir: Vec3): void {
  const cached = columnGround(planet, dir);
  if (cached && cached.level !== null && cached.level >= FINE_TERRAIN_MIN_LEVEL) return;
  void loadColumnGround(planet, dir).catch(() => null);
}

/**
 * ONE resolution policy for every consumer that needs "the ground radius at
 * this column" and cannot wait (the executor tick is synchronous).
 *
 * Order: the shared cache (finest sample wins, so once a landing-grade read has
 * landed every later reader gets THAT number) -> the level-0 planning field,
 * LABELLED `terrain-l0` -> null (the caller uses the catalogue mean and says
 * so). The label is the point: before this, the coarse fallback came back as
 * `source: 'terrain'`, indistinguishable from a level-5 sample, which is how a
 * 61 160.7 m planning value was pushed to the plugin as the descent's datum at
 * 18 m AGL (a -37.1 m jump) and how a hover was reported 36 m high.
 *
 * A cold column also kicks the shared fine read, so the next tick is fine.
 */
export function bestColumnGround(
  planet: Planet,
  dir: Vec3,
  planningField?: { status: string; radiusAt: (d: Vec3) => number | null; level?: number } | null,
): ColumnGround | null {
  const cached = columnGround(planet, dir);
  if (cached) return cached;
  requestColumnGround(planet, dir);
  const field = planningField ?? null;
  if (!field || field.status !== 'available') return null;
  const hit = field.radiusAt(dir);
  if (typeof hit !== 'number' || !Number.isFinite(hit) || !withinPlanet(planet, hit)) return null;
  const level = typeof field.level === 'number' ? field.level : 0;
  // The coarse fallback is returned but NEVER filed: one mission's planning
  // field must not become another's "measured" ground.
  return { radiusM: hit, source: `terrain-l${level}`, level, key: groundColumnKey(planet, dir), at: Date.now() };
}

/** Drop every cached column (tests, world restore). */
export function clearGroundCache(): void {
  samples.clear();
  inFlight.clear();
}

/** Cache size, for diagnostics. */
export function groundCacheStats(): { columns: number; loading: number } {
  return { columns: samples.size, loading: inFlight.size };
}
