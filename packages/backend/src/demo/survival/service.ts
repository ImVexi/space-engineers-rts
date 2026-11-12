/**
 * T66 survival loop — the live half.
 *
 * Runs on its own 30 s pass, reading the power poller's cached snapshots (it
 * never polls the game itself) and the executor's view of its own missions.
 * Every decision is audited with the numbers that produced it, in plain words.
 *
 * What it may do:
 *   * start a return for a MANAGED grid: unstation (the normal launch preflight
 *     sends `convert_to_ship`), fly home on the guarded mission path, land at a
 *     free spot beside the home base (lateral leg -> settle -> land_at), gear
 *     lock (touchdown housekeeping), flag NEEDS_REFUEL;
 *   * mark a refuelled grid READY_TO_RELAUNCH and, only on owner approval, fly
 *     it back to its remembered slot (the station pass re-stations it).
 *
 * What it never does: send a plugin order directly, spawn, teleport, delete or
 * write a physics body. It has no channel of its own.
 */
import type { Planet } from '@se-rts/schemas';
import type { Store, UnitRecord } from '../../store.js';
import { approveMission, createMission, supersedeGridMissions } from '../../missions.js';
import { loadPlanetCatalog } from '../../planner/index.js';
import { nearestPlanetTo } from '../moveTo.js';
import { evaluateGate, prefabForGrid, type CommsGate } from '../gate.js';
import { loadWorld, type DemoWorld } from '../world.js';
import { resolveSurvivalMode } from '../survival.js';
import { resolveDemoEnv } from '../env.js';
import { shipRoles } from '../roles.js';
import { computeRunway, estimateRates, type PowerPoller, type PowerSnapshot } from '../power/index.js';
import { PREFAB_HARDWARE } from '../endurance/index.js';
import {
  LANDED_GRID_CLEARANCE_M,
  SURVIVAL_RETRY_MS,
  SURVIVAL_SNAPSHOT_MAX_AGE_MS,
  SURVIVAL_SETTINGS_DEFAULTS,
  SURVIVAL_TEST_RUNWAY_MAX_TTL_MS,
  SURVIVAL_TEST_RUNWAY_TTL_MS,
  bankTotals,
  blankRecord,
  chooseLandingSpot,
  distanceM,
  evaluateReturnNeed,
  formatHomePointKey,
  normaliseSettings,
  parseHomePointKey,
  readiness,
  resolveHome,
  resourceLabel,
  runwayOverrideActive,
  survivalView,
  testIgnoreReachActive,
  tripResources,
  validateHomePoint,
  retryReason,
  type HomeCandidate,
  type HomePointValidation,
  type LandingObstacle,
  type LandingSpot,
  type ReturnNeed,
  type SurvivalRecord,
  type SurvivalSettings,
  type SurvivalState,
  type TestRunwayOverride,
  type TripResources,
  type Vec3,
} from './loop.js';
import { loadColumnGround } from '../ground.js';

const ZERO_G_ALT_M = 43_700;
const STATE_KEY = 'survival:loop';
const SETTINGS_KEY = 'survival:settings';
const HOME_KEY = 'survival:home';
const TEST_RUNWAY_KEY = 'survival:test-runway';
/** Base hull radius when the profile has no size: BASE-01 is ~40 m across. */
const BASE_HULL_RADIUS_M = 40;
/** A landed grid's own keep-out, beyond the landed-grid clearance. */
const LANDED_HULL_RADIUS_M = 30;
/** How often the loop retries a postponed return (pilot aboard, gate down). */
const POSTPONE_AUDIT_MS = 60_000;

export interface SurvivalDeps {
  store: Store;
  power?: PowerPoller | null;
  executor?: { summary(): Record<string, unknown> } | null;
  clock?: () => number;
  fixturePath?: string | null;
  /** Gate verdict seam (tests); the default is the live comms gate. */
  gateFor?: (gridId: string, world: DemoWorld, now: number) => Pick<CommsGate, 'allowed' | 'nodeId' | 'reason'>;
  /** Survival-mode seam (tests); the default reads the live environment. */
  survivalMode?: () => boolean;
  /** Demo/test-env seam (tests); the default requires RTS_DEMO=1 + RTS_ENV=test. */
  demoEnv?: () => boolean;
  /**
   * Ground-sample seam for a home POINT (tests): returns the terrain sample for
   * a planet column, or null. The default is `ground.ts`'s shared sampler (the
   * same cache the executor uses), which reads the local height field.
   */
  homePointGround?: (
    planet: Planet,
    dir: Vec3,
  ) => Promise<{ radiusM: number; level: number | null; source: string } | null> | { radiusM: number; level: number | null; source: string } | null;
  logger?: (message: string) => void;
}

export interface SurvivalSettingsState {
  settings: SurvivalSettings;
  defaults: SurvivalSettings;
  /** Whether `testIgnoreReach` is actually in force right now (test env only). */
  testIgnoreReachActive: boolean;
  defaultHomeId: string | null;
  overrides: Record<string, string>;
  /** TEST-ENV-ONLY runway overrides in force (never populated in survival). */
  testRunway: Record<string, TestRunwayOverride>;
}

export interface SurvivalTickResult {
  evaluatedAt: number;
  grids: number;
  started: string[];
  pending: string[];
  landed: string[];
  ready: string[];
  /** Triggered but cannot reach home: no orders, stated plainly. */
  stranded: string[];
  skipped: { gridId: string; reason: string }[];
}

interface HomeFlags {
  defaultHomeId: string | null;
  overrides: Record<string, string>;
}

/** What one grid's telemetry says: a need, or why there is none to act on. */
interface Evaluation {
  need: ReturnNeed | null;
  reason: string | null;
  postponed: boolean;
}

export class SurvivalService {
  private readonly clock: () => number;
  private readonly records = new Map<string, SurvivalRecord>();
  private loadedFrom: Store | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly lastAudit = new Map<string, number>();
  /** gridId:kind -> signature of the last audited loop state. */
  private readonly auditSignatures = new Map<string, string>();

  constructor(private readonly deps: SurvivalDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- settings

  settings(): SurvivalSettings {
    const raw = this.deps.store.getKv(SETTINGS_KEY);
    if (!raw) return { ...SURVIVAL_SETTINGS_DEFAULTS };
    try {
      return normaliseSettings(JSON.parse(raw) as Partial<SurvivalSettings>);
    } catch {
      return { ...SURVIVAL_SETTINGS_DEFAULTS };
    }
  }

  writeSettings(patch: Partial<SurvivalSettings>, actor: string): SurvivalSettings {
    const next = normaliseSettings({ ...this.settings(), ...patch });
    this.deps.store.setKv(SETTINGS_KEY, JSON.stringify(next));
    this.audit('demo_survival_settings', 'survival', {
      settings: next,
      note:
        next.approvalMode === 'auto'
          ? 'a MANAGED grid starts its own return; relaunch still waits for the owner'
          : 'a return is recommended and waits for owner approval',
    }, actor);
    return next;
  }

  homeFlags(): HomeFlags {
    const raw = this.deps.store.getKv(HOME_KEY);
    if (!raw) return { defaultHomeId: null, overrides: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<HomeFlags>;
      const overrides: Record<string, string> = {};
      for (const [gridId, homeId] of Object.entries(parsed.overrides ?? {})) {
        if (typeof homeId === 'string' && homeId) overrides[gridId] = homeId;
      }
      return { defaultHomeId: typeof parsed.defaultHomeId === 'string' ? parsed.defaultHomeId : null, overrides };
    } catch {
      return { defaultHomeId: null, overrides: {} };
    }
  }

  /**
   * `POST /api/demo/survival/home`: one home BASE grid, a per-ship grid
   * override, or an explicit POINT (map click / GPS). A point is validated
   * before it is stored; a grid must exist and be a BASE. Nothing is stored
   * that cannot be resolved — that is how the 2026-11-11 test stored an
   * unparseable key that the loop then ignored while it kept using BASE-01.
   */
  async setHome(
    input: { gridId?: string | null; homeGridId?: string | null; homePoint?: Vec3 | null },
    actor: string,
  ): Promise<{ ok: true; flags: HomeFlags } | { ok: false; code: string; reason: string }> {
    const flags = this.homeFlags();
    let key: string | null = input.homeGridId ?? null;

    if (input.homePoint) key = formatHomePointKey(input.homePoint);
    const point = parseHomePointKey(key);
    if (point) {
      const check = await this.validateHomeTarget(point);
      if (!check.ok) return { ok: false, code: check.code ?? 'invalid_home', reason: check.reason };
      key = formatHomePointKey(point);
    } else if (key) {
      const found = this.findGrid(key);
      if (!found) {
        return {
          ok: false,
          code: 'unknown_home',
          reason: `no grid "${key}" on this server: send a BASE grid id/name, or homePoint {x,y,z}`,
        };
      }
      const role = shipRoles.roleOf(found.id);
      if (role !== 'base') {
        return {
          ok: false,
          code: 'home_not_base',
          reason: `${found.name || found.id} is ${role.toUpperCase()}: a home must be a BASE grid (or send homePoint {x,y,z})`,
        };
      }
      key = found.id;
    }

    if (input.gridId) {
      if (key) flags.overrides[input.gridId] = key;
      else delete flags.overrides[input.gridId];
    } else {
      flags.defaultHomeId = key;
    }
    this.deps.store.setKv(HOME_KEY, JSON.stringify(flags));
    this.audit('demo_survival_home', input.gridId ?? 'survival', {
      defaultHomeId: flags.defaultHomeId,
      overrides: flags.overrides,
      ...(point ? { homePoint: point } : {}),
      note: input.gridId
        ? key
          ? `return home override: ${key}`
          : 'return home override cleared'
        : key
          ? `home base set to ${key}`
          : 'home base flag cleared (BASE-01 is the default)',
    }, actor);
    return { ok: true, flags };
  }

  /** A grid by id or name (case-insensitive), from the live unit table. */
  private findGrid(key: string): { id: string; name: string } | null {
    const units = this.deps.store.listUnits();
    const byId = units.find((u) => u.id === key);
    if (byId) return { id: byId.id, name: byId.name };
    const byName = units.find((u) => (u.name ?? '').toLowerCase() === key.toLowerCase());
    return byName ? { id: byName.id, name: byName.name } : null;
  }

  /**
   * Validate a home point: on a planet surface, on landing-grade (level-5)
   * ground, at least 60 m from every grid. The ground sample comes from the
   * shared `ground.ts` sampler (injectable for tests).
   */
  async validateHomeTarget(point: Vec3): Promise<HomePointValidation> {
    const planets = loadPlanetCatalog();
    let ground: { radiusM: number; level: number | null; source: string } | null = null;
    let planet: Planet | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of planets) {
      const d = Math.abs(
        Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y, point.z - candidate.center.z) -
          candidate.surfaceRadiusM,
      );
      if (d < best) {
        best = d;
        planet = candidate;
      }
    }
    if (planet) {
      const up = {
        x: point.x - planet.center.x,
        y: point.y - planet.center.y,
        z: point.z - planet.center.z,
      };
      const len = Math.hypot(up.x, up.y, up.z);
      const dir = len > 1e-6 ? { x: up.x / len, y: up.y / len, z: up.z / len } : null;
      if (dir) {
        const read = this.deps.homePointGround
          ? await this.deps.homePointGround(planet, dir)
          : await loadColumnGround(planet, dir);
        if (read) ground = { radiusM: read.radiusM, level: read.level, source: read.source };
      }
    }
    const grids = this.deps.store
      .listUnits()
      .filter((u) => u.pos)
      .map((u) => ({ gridId: u.id, name: u.name || u.id, position: u.pos! }));
    return validateHomePoint({ point, planets, ground, grids });
  }

  settingsState(): SurvivalSettingsState {
    const flags = this.homeFlags();
    return {
      settings: this.settings(),
      defaults: { ...SURVIVAL_SETTINGS_DEFAULTS },
      testIgnoreReachActive: this.testIgnoreReach(),
      defaultHomeId: flags.defaultHomeId,
      overrides: flags.overrides,
      testRunway: this.testRunwayState(),
    };
  }

  // ------------------------------------------- TEST-ENV-ONLY runway override

  /** The test gates, resolved once: demo env AND survival mode off. */
  private testEnvGate(): { survivalMode: boolean; demoEnv: boolean } {
    return {
      survivalMode: this.deps.survivalMode ? this.deps.survivalMode() : resolveSurvivalMode(),
      demoEnv: this.deps.demoEnv ? this.deps.demoEnv() : resolveDemoEnv() !== null,
    };
  }

  /** All persisted overrides (used or not); expired ones are pruned on read. */
  private testRunwayRaw(now: number): { overrides: Record<string, TestRunwayOverride>; expired: string[] } {
    const raw = this.deps.store.getKv(TEST_RUNWAY_KEY);
    const overrides: Record<string, TestRunwayOverride> = {};
    const expired: string[] = [];
    if (!raw) return { overrides, expired };
    try {
      const parsed = JSON.parse(raw) as Record<string, TestRunwayOverride>;
      for (const [gridId, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        if (!Number.isFinite(value.expiresAt) || now >= value.expiresAt) {
          expired.push(gridId);
          continue;
        }
        overrides[gridId] = { ...value, gridId };
      }
    } catch {
      // A corrupt row is dropped, never trusted.
    }
    if (expired.length > 0) {
      this.deps.store.setKv(TEST_RUNWAY_KEY, JSON.stringify(overrides));
      for (const gridId of expired) {
        this.audit('demo_survival_test_runway_expired', gridId, { note: 'expired and dropped; the loop is back on live readings' }, 'survival-loop', now);
      }
    }
    return { overrides, expired };
  }

  /** Active overrides only: gated by the demo env + survival mode on every read. */
  testRunwayState(now = this.clock()): Record<string, TestRunwayOverride> {
    const gate = this.testEnvGate();
    if (gate.survivalMode || !gate.demoEnv) return {};
    const { overrides } = this.testRunwayRaw(now);
    const active: Record<string, TestRunwayOverride> = {};
    for (const [gridId, override] of Object.entries(overrides)) {
      const hit = runwayOverrideActive({ override, now, ...gate });
      if (hit) active[gridId] = hit;
    }
    return active;
  }

  /** The override the TRIGGER uses for this grid right now, or null. */
  private testRunwayFor(gridId: string, now: number): TestRunwayOverride | null {
    const gate = this.testEnvGate();
    if (gate.survivalMode || !gate.demoEnv) return null;
    const { overrides } = this.testRunwayRaw(now);
    return runwayOverrideActive({ override: overrides[gridId], now, ...gate });
  }

  /**
   * Set (or replace) the test runway override for one grid. Refused outside
   * the test env; `survival_mode` is the code in survival, matching every
   * other admin override on this backend.
   */
  setTestRunway(
    input: { gridId: string; resource: 'power' | 'h2'; runwayMin: number; pct: number; ttlMin?: number },
    actor: string,
  ): { ok: true; override: TestRunwayOverride } | { ok: false; code: string; reason: string } {
    const gate = this.testEnvGate();
    if (gate.survivalMode) {
      return { ok: false, code: 'survival_mode', reason: 'not available in survival build: the test runway override' };
    }
    if (!gate.demoEnv) {
      return { ok: false, code: 'admin_override_not_allowed', reason: 'the test runway override is only available on the test server' };
    }
    const now = this.clock();
    const ttlMin = Number.isFinite(input.ttlMin) ? Math.min(SURVIVAL_TEST_RUNWAY_MAX_TTL_MS / 60_000, Math.max(1, input.ttlMin!)) : SURVIVAL_TEST_RUNWAY_TTL_MS / 60_000;
    const override: TestRunwayOverride = {
      gridId: input.gridId,
      resource: input.resource,
      runwayMin: input.runwayMin,
      pct: input.pct,
      setAt: now,
      expiresAt: now + ttlMin * 60_000,
      by: actor,
    };
    const { overrides } = this.testRunwayRaw(now);
    overrides[input.gridId] = override;
    this.deps.store.setKv(TEST_RUNWAY_KEY, JSON.stringify(overrides));
    this.audit('demo_survival_test_runway', input.gridId, {
      override,
      expiresInMin: ttlMin,
      note: `TEST-ENV-ONLY: the trigger reads ${input.resource} ${input.pct} % / ${input.runwayMin} min for ${input.gridId} instead of the live reading until ${new Date(override.expiresAt).toISOString()}`,
    }, actor);
    return { ok: true, override };
  }

  /** Clear one grid's override (or all when no grid is named). */
  clearTestRunway(gridId: string | null, actor: string): Record<string, TestRunwayOverride> {
    const now = this.clock();
    const { overrides } = this.testRunwayRaw(now);
    if (gridId) delete overrides[gridId];
    else for (const key of Object.keys(overrides)) delete overrides[key];
    this.deps.store.setKv(TEST_RUNWAY_KEY, JSON.stringify(overrides));
    this.audit('demo_survival_test_runway_cleared', gridId ?? 'survival', {
      gridId,
      remaining: Object.keys(overrides),
      note: gridId ? `test runway override cleared for ${gridId}: live readings decide again` : 'every test runway override cleared',
    }, actor);
    return overrides;
  }

  /**
   * The test-only `ignoreReach` override, in force only when the setting is on
   * AND the process is the demo/test world AND survival mode is off. A persisted
   * `true` in a survival deployment is ignored here, not trusted.
   */
  testIgnoreReach(): boolean {
    return testIgnoreReachActive({ settings: this.settings(), ...this.testEnvGate() });
  }

  // ------------------------------------------------------------------- state

  /** Persisted per-grid records, reloaded once per store. */
  records_(): Map<string, SurvivalRecord> {
    if (this.loadedFrom === this.deps.store) return this.records;
    this.loadedFrom = this.deps.store;
    const raw = this.deps.store.getKv(STATE_KEY);
    if (!raw) return this.records;
    try {
      const parsed = JSON.parse(raw) as Record<string, SurvivalRecord>;
      for (const [gridId, rec] of Object.entries(parsed)) {
        if (rec && typeof rec === 'object' && typeof rec.state === 'string') {
          this.records.set(gridId, { ...blankRecord(gridId, rec.name ?? null, 0), ...rec });
        }
      }
    } catch {
      // A corrupt kv row must never stop the loop; the next tick rewrites it.
    }
    return this.records;
  }

  record(gridId: string): SurvivalRecord | null {
    return this.records_().get(gridId) ?? null;
  }

  /** The site's row for one grid, or null when the loop has no opinion. */
  rowFor(gridId: string): ReturnType<typeof survivalView> | null {
    const rec = this.record(gridId);
    if (!rec) return null;
    return survivalView(rec);
  }

  view(): {
    settings: SurvivalSettings;
    defaultHomeId: string | null;
    overrides: Record<string, string>;
    grids: Array<ReturnType<typeof survivalView> & { gridId: string; name: string | null; home: string | null; landing: LandingSpot | null }>;
  } {
    const flags = this.homeFlags();
    return {
      settings: this.settings(),
      defaultHomeId: flags.defaultHomeId,
      overrides: flags.overrides,
      grids: [...this.records_().values()]
        .filter((rec) => rec.state !== 'OK' || rec.recommendation !== null)
        .map((rec) => ({
          gridId: rec.gridId,
          name: rec.name,
          home: rec.home?.name ?? null,
          landing: rec.landing,
          ...survivalView(rec),
        })),
    };
  }

  private save(): void {
    const out: Record<string, SurvivalRecord> = {};
    for (const [gridId, rec] of this.records_()) out[gridId] = rec;
    this.deps.store.setKv(STATE_KEY, JSON.stringify(out));
  }

  private put(rec: SurvivalRecord, patch: Partial<SurvivalRecord>): SurvivalRecord {
    const next = { ...rec, ...patch, updatedAt: this.clock() };
    this.records_().set(rec.gridId, next);
    return next;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick(this.clock());
      } catch (err) {
        this.deps.logger?.(`survival loop tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Test seam: forget persisted records but keep the store rows. */
  reset(): void {
    this.records.clear();
    this.loadedFrom = null;
    this.lastAudit.clear();
    this.auditSignatures.clear();
  }

  // -------------------------------------------------------------------- tick

  /**
   * One pass. Managed grids only; a PERSONAL ship gets an alert and nothing
   * else; BASE and OFF get nothing at all.
   */
  tick(now = this.clock()): SurvivalTickResult {
    const result: SurvivalTickResult = {
      evaluatedAt: now,
      grids: 0,
      started: [],
      pending: [],
      landed: [],
      ready: [],
      stranded: [],
      skipped: [],
    };
    const units = this.deps.store.listUnits().filter((u) => u.pos);
    for (const unit of units) {
      const role = shipRoles.roleOf(unit.id);
      if (role === 'base' || role === 'off') continue;
      result.grids += 1;
      try {
        this.evaluateGrid(unit, role, now, result);
      } catch (err) {
        result.skipped.push({ gridId: unit.id, reason: err instanceof Error ? err.message : String(err) });
        this.deps.logger?.(`survival loop: ${unit.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.save();
    return result;
  }

  private evaluateGrid(
    unit: UnitRecord,
    role: ReturnType<typeof shipRoles.roleOf>,
    now: number,
    result: SurvivalTickResult,
  ): void {
    const gridId = unit.id;
    const rec = this.records_().get(gridId) ?? blankRecord(gridId, unit.name, now);
    this.records_().set(gridId, rec);

    // A grid mid-return / relaunch is driven by its mission, not re-evaluated.
    if (rec.state === 'RETURNING' && rec.missionId) {
      const aboard = this.deps.power?.snapshot(gridId)?.underControl === true;
      if (aboard) {
        // Existing manual rule: a seated pilot gets no orders. The mission is
        // paused by the executor; the loop records why, once a minute.
        this.auditOnce(gridId, 'pilot', now, 'demo_survival_postponed', gridId, {
          missionId: rec.missionId,
          phase: rec.phase,
          note: 'a pilot is aboard mid-return: no orders from the survival loop; the return is postponed',
        });
        this.put(rec, { reason: 'return postponed: a pilot is aboard (resumes when they leave the seat)' });
      }
      this.advanceMission(rec, now, result);
      return;
    }
    if (rec.state === 'RETURN_PENDING') {
      result.pending.push(gridId);
      // The alert stays open with the current numbers.
      this.raiseAlert(rec, 'return-home', 'warn', rec.reason, now);
      return;
    }
    if (rec.state === 'READY_TO_RELAUNCH' || rec.needsRefuel) {
      this.advanceRefuel(rec, now, result);
      return;
    }

    if (role === 'personal') {
      // PERSONAL: alert only. The owner flies it or asks; the loop never does.
      const evaluation = this.evaluate(rec, unit, now);
      const need = evaluation.need;
      const recommendation = need?.trigger ? `personal ship: no automatic action — ${need.reason}` : null;
      this.put(rec, {
        need: need ?? rec.need,
        recommendation,
        reason: recommendation ?? evaluation.reason ?? rec.reason,
        refuelPct: null,
      });
      if (recommendation) {
        this.raiseAlert(rec, 'return-home', 'warn', recommendation, now);
        this.auditOnce(gridId, 'recommendation', now, 'demo_survival_recommendation', gridId, {
          role,
          need,
          action: 'none',
          note: recommendation,
        });
      }
      return;
    }

    if (role !== 'managed') return;

    if (rec.lastAttemptAt !== null && now - rec.lastAttemptAt < SURVIVAL_RETRY_MS) {
      const retryIn = Math.ceil((SURVIVAL_RETRY_MS - (now - rec.lastAttemptAt)) / 60_000);
      this.put(rec, { reason: retryReason(rec.reason, retryIn) });
      return;
    }

    const evaluation = this.evaluate(rec, unit, now);
    const need = evaluation.need;
    if (!need || !need.trigger) {
      const line = evaluation.reason ?? 'no fuel or power runway to judge the return on (readings unknown)';
      this.put(rec, {
        need: need ?? null,
        state: 'OK',
        phase: null,
        reason: line,
        recommendation: evaluation.postponed ? line : null,
        refuelPct: null,
      });
      if (!evaluation.postponed) {
        this.resolveAlert(gridId, now, line);
        this.resolveAlertKind(gridId, 'stranded', now, line);
      }
      return;
    }

    // STRANDED: the trigger fired, but the flight home does not fit the tank.
    // No mission, no order, and a static grid is never unstationed for it.
    if (need.launchable === false) {
      const snap = this.deps.power?.snapshot(gridId) ?? null;
      const keepsStation = snap?.isStatic === true;
      const reason = need.reason + (keepsStation ? ' — it stays a station' : '');
      const next = this.put(rec, {
        need,
        state: 'STRANDED',
        phase: null,
        recommendation: null,
        reason,
        refuelPct: null,
      });
      this.raiseAlert(next, 'stranded', 'critical', `${unit.name || gridId}: ${reason}`, now);
      this.auditOnce(gridId, 'stranded', now, 'demo_survival_stranded', gridId, {
        need,
        isStatic: snap?.isStatic ?? null,
        keptStation: keepsStation,
        note:
          'the trip home needs more than the tank holds: no return is launched and no order is sent; ' +
          'refuel it where it is or send a tanker' + (keepsStation ? '; the static grid stays a station' : ''),
      });
      result.stranded.push(gridId);
      return;
    }

    const planned = this.planReturn(rec, unit, need, now);
    if (!planned.ok) {
      this.put(rec, {
        need,
        reason: need.reason + ` — ${planned.reason}`,
        recommendation: planned.reason,
        lastAttemptAt: now,
        state: 'OK',
      });
      this.raiseAlert(rec, 'return-home', 'critical', rec.reason, now);
      this.auditOnce(gridId, 'return-refused', now, 'demo_survival_return_refused', gridId, { need, reason: planned.reason });
      return;
    }

    const settings = this.settings();
    if (settings.approvalMode === 'approve') {
      const next = this.put(rec, {
        need,
        state: 'RETURN_PENDING',
        phase: 'return',
        reason: `${need.reason} — awaiting owner approval`,
        recommendation: need.reason,
        home: planned.home,
        landing: planned.landing,
        slot: planned.slot,
        missionId: null,
      });
      this.raiseAlert(next, 'return-home', 'warn', next.reason, now);
      this.audit('demo_survival_return_pending', gridId, { need, home: planned.home, landing: planned.landing, mode: settings.approvalMode }, 'survival-loop', now);
      result.pending.push(gridId);
      return;
    }

    this.startReturn(rec, unit, need, planned, now, 'survival-loop', result);
  }

  /** Read the live numbers for one grid and evaluate the trigger. */
  private evaluate(rec: SurvivalRecord, unit: UnitRecord, now: number): Evaluation {
    const poller = this.deps.power;
    const pos = unit.pos;
    if (!poller || !pos) return { need: null, reason: null, postponed: false };
    const snap = poller.snapshot(unit.id);
    if (!snap) return { need: null, reason: null, postponed: false };
    // TEST-ENV-ONLY: an active per-grid runway override replaces the readings
    // for this grid (and only this grid) so the whole flight can be exercised.
    // It is already gated on demo env + survival off; it never changes a
    // threshold, and it is audited on every pass it is used.
    const testRunway = this.testRunwayFor(unit.id, now);
    if (testRunway) {
      this.auditOnce(unit.id, 'test-runway', now, 'demo_survival_test_runway_used', unit.id, {
        override: testRunway,
        live: { h2Pct: snap.h2Pct, batteryPct: snap.batteryPct },
        note:
          `TEST-ENV-ONLY: trigger read ${testRunway.resource} ${testRunway.pct} % / ${testRunway.runwayMin} min ` +
          'instead of the live reading for this grid',
      });
    }
    // Simspeed merge: a snapshot the idle cadence has not refreshed is unknown.
    // A 10-minute-old "40 %" must not start a return any more than a null does.
    // With an override in force the readings come from the override, so the age
    // of the live sample is not what the decision rests on.
    if (!testRunway && now - snap.at > SURVIVAL_SNAPSHOT_MAX_AGE_MS) {
      const mins = Math.max(1, Math.round((now - snap.at) / 60_000));
      const reason = `power/fuel reading is ${mins} min old (idle grids are re-read every 5 min) — treated as unknown, so no return is started on it`;
      this.put(rec, { need: null, reason, recommendation: null });
      return { need: null, reason, postponed: false };
    }

    // A seated pilot postpones the return: existing rule, audited once.
    if (snap.underControl) {
      this.auditOnce(unit.id, 'pilot', now, 'demo_survival_postponed', unit.id, {
        role: shipRoles.roleOf(unit.id),
        controlledBy: snap.controlledBy ?? null,
        note: 'a pilot is aboard: no orders from the survival loop; the return is postponed',
      });
      return {
        need: null,
        reason: 'return postponed: a pilot is aboard (the loop sends no orders while a seat is occupied)',
        postponed: true,
      };
    }

    const planets = loadPlanetCatalog();
    const planet = nearestPlanetTo(pos, planets);
    const altitudeM = planet
      ? Math.max(0, Math.round(Math.hypot(pos.x - planet.center.x, pos.y - planet.center.y, pos.z - planet.center.z) - planet.surfaceRadiusM))
      : null;
    const zeroG = Boolean(planet?.hasAtmosphere && altitudeM !== null && altitudeM >= ZERO_G_ALT_M);
    const rates = estimateRates(poller.series(unit.id, 1));
    const runway = computeRunway(snap, rates, { zeroG });
    this.put(rec, { slot: rec.slot ?? { position: pos, planet: planet?.name ?? null, altitudeM } });

    const homeBase = this.homeFor(unit, snap, planet);
    if (!homeBase.resolution.home) {
      this.put(rec, { need: null, reason: homeBase.resolution.reason, recommendation: null });
      this.raiseAlert(rec, 'return-home', 'warn', `return refused: ${homeBase.resolution.reason}`, now);
      return { need: null, reason: homeBase.resolution.reason, postponed: false };
    }
    const home = homeBase.resolution.home;

    const need = evaluateReturnNeed({
      fuel:
        testRunway?.resource === 'h2'
          ? { pct: testRunway.pct, runwayMin: testRunway.runwayMin }
          : { pct: snap.h2Pct, runwayMin: runway.fuelRunwayMin },
      power:
        testRunway?.resource === 'power'
          ? { pct: testRunway.pct, runwayMin: testRunway.runwayMin }
          : { pct: snap.batteryPct, runwayMin: runway.powerRunwayMin },
      distanceM: distanceM(pos, home.position),
      homeAltitudeM: home.altitudeM,
      altitudeM,
      marginPct: this.settings().marginPct,
      homeLabel: home.name,
      // Which resources the trip burns: an empty one the ship needs is
      // STRANDED even with no projected drain (runway null). An override
      // replaces the reading, not the hull, so the classification still holds.
      needed: this.tripResourcesFor(unit.id),
    });
    return { need: { ...need, homeDistanceM: distanceM(pos, home.position) } as ReturnNeed, reason: need.reason, postponed: false };
  }

  /**
   * The poller snapshot only if it is fresh enough to be a reading. Idle grids
   * are re-read every 5 min by the power poller, so "no refresh since the last
   * pass" is normal; older than `SURVIVAL_SNAPSHOT_MAX_AGE_MS` is not, and the
   * loop must behave as if the numbers were null.
   */
  private freshSnapshot(gridId: string, now: number): PowerSnapshot | null {
    const snap = this.deps.power?.snapshot(gridId) ?? null;
    if (!snap) return null;
    return now - snap.at > SURVIVAL_SNAPSHOT_MAX_AGE_MS ? null : snap;
  }

  /**
   * Which resources the trip burns, from the grid's prefab hardware: the same
   * `PREFAB_HARDWARE.thrustCounts` the endurance model stages by. Unknown
   * propulsion is judged conservatively (both needed) and the reason says so,
   * so a dry tank on an unmeasured hull is never promised a flight.
   */
  private tripResourcesFor(gridId: string): TripResources {
    const prefab = prefabForGrid(this.deps.store, gridId);
    const spec = prefab ? PREFAB_HARDWARE[prefab] : undefined;
    return tripResources({ counts: bankTotals(spec?.thrustCounts) });
  }

  private homeFor(
    unit: UnitRecord,
    snap: PowerSnapshot,
    planet: Planet | null,
  ): { resolution: ReturnType<typeof resolveHome>; candidates: HomeCandidate[] } {
    const flags = this.homeFlags();
    const planets = loadPlanetCatalog();
    const candidates: HomeCandidate[] = [];
    for (const other of this.deps.store.listUnits()) {
      if (!other.pos || other.id === unit.id) continue;
      if (shipRoles.roleOf(other.id) !== 'base') continue;
      const otherSnap = this.deps.power?.snapshot(other.id) ?? null;
      candidates.push({
        gridId: other.id,
        name: other.name || other.id,
        position: other.pos,
        altitudeM: altitudeAgl(other.pos, planets),
        hasCharge: Boolean((otherSnap?.batteryMaxMWh ?? 0) > 0 || (otherSnap?.h2CapacityLitres ?? 0) > 0),
      });
    }
    void snap;
    void planet;
    const resolution = resolveHome({
      gridId: unit.id,
      position: unit.pos,
      candidates,
      overrides: flags.overrides,
      defaultHomeId: flags.defaultHomeId,
    });
    // A point override has no grid profile; its altitude comes from the
    // catalogue so the climb allowance is measured, not assumed.
    if (resolution.home && resolution.home.altitudeM === null && parseHomePointKey(resolution.home.gridId)) {
      resolution.home.altitudeM = altitudeAgl(resolution.home.position, planets);
    }
    return { resolution, candidates };
  }

  /**
   * Resolve home, the landing spot and the slot before anything is created.
   * A refusal is a plain sentence, never a silent skip.
   */
  private planReturn(
    rec: SurvivalRecord,
    unit: UnitRecord,
    need: ReturnNeed,
    now: number,
  ): {
    ok: true;
    home: { gridId: string; name: string; distanceM: number };
    landing: LandingSpot;
    slot: { position: Vec3; planet: string | null; altitudeM: number | null };
    gate: { nodeId: string };
    /** TEST-ENV-ONLY audited ignoreReach; false everywhere else. */
    adminOverride: boolean;
    /** Why the gate refused, when the override carried the mission anyway. */
    gateReason: string | null;
  } | { ok: false; reason: string } {
    if (!unit.pos) return { ok: false, reason: 'the grid has no position to fly home from' };
    const poller = this.deps.power;
    const snap = poller?.snapshot(unit.id) ?? null;
    const planets = loadPlanetCatalog();
    const planet = nearestPlanetTo(unit.pos, planets);
    const altitudeM = planet
      ? Math.max(0, Math.round(Math.hypot(unit.pos.x - planet.center.x, unit.pos.y - planet.center.y, unit.pos.z - planet.center.z) - planet.surfaceRadiusM))
      : null;
    const { resolution, candidates } = this.homeFor(unit, snap as PowerSnapshot, planet);
    if (!resolution.home) return { ok: false, reason: resolution.reason };
    const home = resolution.home;

    const homeUnit = this.deps.store.getUnit(home.gridId);
    const baseHullRadiusM = BASE_HULL_RADIUS_M;
    const obstacles: LandingObstacle[] = [];
    for (const other of this.deps.store.listUnits()) {
      if (!other.pos) continue;
      if (other.id === home.gridId || other.id === unit.id) continue;
      // Only landed/near-ground grids are obstacles; a relay at 30 km is not.
      const otherAlt = altitudeAgl(other.pos, planets);
      const baseAlt = altitudeAgl(home.position, planets);
      if (otherAlt === null || baseAlt === null) continue;
      if (Math.abs(otherAlt - baseAlt) > 50) continue;
      obstacles.push({
        gridId: other.id,
        position: other.pos,
        radiusM: LANDED_HULL_RADIUS_M + LANDED_GRID_CLEARANCE_M,
      });
    }
    void homeUnit;
    void candidates;

    const spot = chooseLandingSpot({
      home: home.position,
      planetCenter: planet ? planet.center : null,
      incomingFrom: unit.pos,
      baseHullRadiusM,
      obstacles,
      // A validated point home has no hull to keep clear of: land ON it (the
      // ring search is only for a base grid, or for a point something has
      // since landed on). Offset only when blocked, and the reason says why.
      homeIsPoint: Boolean(parseHomePointKey(home.gridId)),
    });
    if (!spot.spot) {
      return { ok: false, reason: `${home.name}: ${spot.reason}` };
    }

    const world = this.world(now);
    const testOverride = this.testIgnoreReach();
    const gate = this.gateFor(unit.id, world, now);
    if (!gate.allowed && !testOverride) {
      return {
        ok: false,
        reason: `comms gate denied ${gate.nodeId}: ${gate.reason} (the move waits; stop/brake/hold are never gated)`,
      };
    }

    return {
      ok: true,
      home: { gridId: home.gridId, name: home.name, distanceM: Math.round(home.distanceM) },
      landing: spot.spot,
      slot: rec.slot ?? { position: unit.pos, planet: planet?.name ?? null, altitudeM },
      gate: { nodeId: gate.allowed ? gate.nodeId : unit.id },
      // TEST-ENV-ONLY: the return flies with the audited ignoreReach override
      // (the test world's BASE-01 has no antenna, so the gate can never pass).
      adminOverride: testOverride,
      gateReason: gate.allowed ? null : gate.reason,
    };
  }

  /**
   * Create + approve the return mission. This is the normal guarded path: the
   * executor's launch preflight unstations a static grid, the comms gate
   * applies to the move, and the landing sequence owns the last leg.
   */
  private startReturn(
    rec: SurvivalRecord,
    unit: UnitRecord,
    need: ReturnNeed,
    planned: Extract<ReturnType<SurvivalService['planReturn']>, { ok: true }>,
    now: number,
    actor: string,
    result?: SurvivalTickResult,
  ): boolean {
    const mission = this.createMission({
      gridId: unit.id,
      name: unit.name || unit.id,
      target: planned.landing.point,
      planet: rec.slot?.planet ?? planned.slot.planet,
      altitudeM: null,
      land: true,
      gateNodeId: planned.gate.nodeId,
      kind: 'return',
      note: need.reason,
      adminOverride: planned.adminOverride,
      now,
      actor,
    });
    if (!mission.ok) {
      this.put(rec, {
        need,
        reason: `${need.reason} — return mission refused: ${mission.reason}`,
        lastAttemptAt: now,
        state: 'OK',
      });
      this.audit('demo_survival_return_refused', unit.id, { need, reason: mission.reason }, actor, now);
      return false;
    }

    this.put(rec, {
      need,
      state: 'RETURNING',
      phase: 'return',
      reason: need.reason,
      recommendation: null,
      home: planned.home,
      landing: planned.landing,
      slot: planned.slot,
      missionId: mission.missionId,
      needsRefuel: false,
      flaggedAt: null,
    });
    this.raiseAlert(rec, 'return-home', 'warn', `${unit.name || unit.id}: ${need.reason}`, now);
    // It can fly again: a STRANDED alert from an earlier pass is no longer true.
    this.resolveAlertKind(unit.id, 'stranded', now, 'the tank covers the trip again; the return started');
    this.audit('demo_survival_return_started', unit.id, {
      need,
      home: planned.home,
      landing: planned.landing,
      missionId: mission.missionId,
      mode: this.settings().approvalMode,
      ...(planned.adminOverride
        ? {
            adminOverride: true,
            gateBypassed: planned.gateReason,
            overrideNote:
              'test-env loop override: ignoreReach carried on the return mission (the test world BASE-01 has no antenna)',
          }
        : {}),
      note: `${unit.name || unit.id}: ${need.reason}`,
    }, actor, now);
    result?.started.push(unit.id);
    return true;
  }

  /** Owner pressed "Approve return" (approval-first mode). */
  approveReturn(gridId: string, actor: string): { ok: boolean; reason: string } {
    const rec = this.record(gridId);
    if (!rec) return { ok: false, reason: `no survival record for ${gridId}` };
    if (rec.state !== 'RETURN_PENDING') return { ok: false, reason: `${gridId} is not awaiting a return (${rec.state})` };
    const unit = this.deps.store.getUnit(gridId);
    if (!unit?.pos) return { ok: false, reason: `${gridId} has no live position` };
    if (shipRoles.roleOf(gridId) !== 'managed') {
      return { ok: false, reason: `${gridId} is ${shipRoles.roleOf(gridId).toUpperCase()}: the loop does not fly it` };
    }
    const now = this.clock();
    const need = rec.need;
    if (!need) return { ok: false, reason: `${gridId} has no recorded fuel/power need` };
    const planned = this.planReturn(rec, unit, need, now);
    if (!planned.ok) {
      this.put(rec, { reason: `${rec.reason} — ${planned.reason}` });
      return { ok: false, reason: planned.reason };
    }
    const ok = this.startReturn(rec, unit, need, planned, now, actor);
    return { ok, reason: ok ? `return started for ${gridId}` : `return could not start for ${gridId}` };
  }

  /**
   * Owner pressed "Relaunch to slot". Requires READY_TO_RELAUNCH and the
   * confirm flag; the mission flies the normal climb path back to the slot.
   */
  relaunch(gridId: string, confirm: boolean, actor: string): { ok: boolean; reason: string; missionId?: string } {
    const rec = this.record(gridId);
    if (!rec) return { ok: false, reason: `no survival record for ${gridId}` };
    if (!confirm) return { ok: false, reason: 'relaunch needs an explicit confirmation (confirm: true)' };
    if (rec.state !== 'READY_TO_RELAUNCH') {
      return { ok: false, reason: `${gridId} is ${rec.state}, not READY_TO_RELAUNCH` };
    }
    if (shipRoles.roleOf(gridId) !== 'managed') {
      return { ok: false, reason: `${gridId} is ${shipRoles.roleOf(gridId).toUpperCase()}: the loop does not fly it` };
    }
    const unit = this.deps.store.getUnit(gridId);
    if (!unit?.pos) return { ok: false, reason: `${gridId} has no live position` };
    if (!rec.slot) return { ok: false, reason: `${gridId} has no remembered slot to relaunch to` };
    const now = this.clock();
    const world = this.world(now);
    const testOverride = this.testIgnoreReach();
    const gate = this.gateFor(gridId, world, now);
    if (!gate.allowed && !testOverride) {
      return { ok: false, reason: `comms gate denied ${gate.nodeId}: ${gate.reason} (nothing was sent)` };
    }

    const mission = this.createMission({
      gridId,
      name: unit.name || gridId,
      target: rec.slot.position,
      planet: rec.slot.planet,
      altitudeM: rec.slot.altitudeM,
      land: false,
      gateNodeId: gate.allowed ? gate.nodeId : gridId,
      kind: 'relaunch',
      note: `relaunch to the remembered slot after refuelling (${rec.refuelPct ?? '?'} %)`,
      adminOverride: testOverride,
      now,
      actor,
    });
    if (!mission.ok) {
      this.audit('demo_survival_relaunch_refused', gridId, { reason: mission.reason }, actor, now);
      return { ok: false, reason: mission.reason };
    }
    this.put(rec, {
      state: 'RETURNING',
      phase: 'relaunch',
      reason: `relaunch approved: flying back to its slot (${rec.refuelPct ?? '—'} %)`,
      missionId: mission.missionId,
      needsRefuel: false,
    });
    this.audit('demo_survival_relaunch', gridId, {
      missionId: mission.missionId,
      slot: rec.slot,
      refuelPct: rec.refuelPct,
      ...(testOverride
        ? {
            adminOverride: true,
            gateBypassed: gate.allowed ? null : gate.reason,
            overrideNote: 'test-env loop override: ignoreReach carried on the relaunch mission',
          }
        : {}),
      note: 'owner approved the relaunch; the normal climb path flies it back and the station pass re-stations it if station rules allow',
    }, actor, now);
    return { ok: true, reason: `relaunch started for ${gridId}`, missionId: mission.missionId };
  }

  /** Follow the mission a return/relaunch started. */
  private advanceMission(rec: SurvivalRecord, now: number, result: SurvivalTickResult): void {
    const mission = rec.missionId ? this.deps.store.getMission(rec.missionId) : null;
    if (!mission) {
      this.put(rec, { state: 'OK', phase: null, missionId: null, reason: 'return mission disappeared; nothing is flying', lastAttemptAt: now });
      return;
    }
    const status = mission.status;
    if (!['done', 'failed', 'cancelled'].includes(status)) {
      if (status === 'paused') {
        this.put(rec, { reason: 'return paused by the executor (manual control or a guard); resumes when it clears' });
      }
      return;
    }
    const drone = this.droneFor(rec.missionId!);
    // The executor's summary is the fast read; if the run is no longer in it,
    // the touchdown audit row is the durable evidence that it landed.
    const touchedDown =
      drone?.state === 'holding' ||
      (!drone &&
        this.deps.store
          .listAudit(200)
          .some((a) => a.action === 'demo_touchdown' && a.subject.startsWith(`${rec.missionId}:`)));
    const held = drone?.state === 'holding' || touchedDown;
    if (status === 'done' && held && rec.phase === 'return') {
      const flag = this.put(rec, {
        state: 'NEEDS_REFUEL',
        phase: null,
        needsRefuel: true,
        flaggedAt: now,
        refuelPct: null,
        reason: `landed ${rec.landing?.atHome ? 'at' : 'beside'} ${rec.home?.name ?? 'home'}: NEEDS_REFUEL (${
          rec.landing
            ? rec.landing.atHome
              ? `on the home point, ${Math.round(rec.landing.clearanceM)} m clearance`
              : `${Math.round(rec.landing.distanceM)} m from the base, ${Math.round(rec.landing.clearanceM)} m clearance`
            : 'landed'
        })`,
      });
      this.audit('demo_survival_needs_refuel', rec.gridId, {
        missionId: rec.missionId,
        home: rec.home,
        landing: rec.landing,
        note: `flagged NEEDS_REFUEL; its slot is vacant (refuelling) until the owner relaunches it`,
      }, 'survival-loop', now);
      this.raiseAlert(flag, 'needs-refuel', 'info', `${rec.name ?? rec.gridId}: ${flag.reason}`, now);
      this.resolveAlertKind(rec.gridId, 'return-home', now, 'the grid is home');
      result.landed.push(rec.gridId);
      return;
    }
    if (status === 'done' && held && rec.phase === 'relaunch') {
      // A relaunch whose slot is on the ground LANDS there (the executor turns
      // that slot into a landing). Say so: "back on station" would be false
      // for a hull resting on the terrain.
      const landedRelaunch = this.deps.store
        .listAudit(200)
        .some((a) => a.action === 'demo_touchdown' && a.subject.startsWith(`${rec.missionId}:`));
      this.put(rec, {
        state: 'OK',
        phase: null,
        missionId: null,
        needsRefuel: false,
        reason: landedRelaunch
          ? 'relaunch landed at its slot: the slot is on the ground, so the ship is back where it was parked'
          : 'back on station: the station pass re-stations it if station rules allow',
      });
      this.audit('demo_survival_relaunched', rec.gridId, { missionId: rec.missionId, slot: rec.slot, landed: landedRelaunch }, 'survival-loop', now);
      this.resolveAlertKind(rec.gridId, 'needs-refuel', now, 'relaunched to its slot');
      return;
    }
    // Failed / cancelled / landed nowhere useful: back to OK and retry later.
    const why = mission.pauseReason ?? `mission ${status} with the drone ${drone?.state ?? 'unknown'}`;
    this.put(rec, {
      state: 'OK',
      phase: null,
      missionId: null,
      needsRefuel: false,
      lastAttemptAt: now,
      reason: `return flight did not land: ${why}`,
    });
    this.audit('demo_survival_return_failed', rec.gridId, { missionId: rec.missionId, status, drone: drone ?? null, reason: why }, 'survival-loop', now);
  }

  /** NEEDS_REFUEL -> READY_TO_RELAUNCH when the tank/charge is back. */
  private advanceRefuel(rec: SurvivalRecord, now: number, result: SurvivalTickResult): void {
    // A stale snapshot is unknown here too: "90 %" from ten minutes ago is not
    // an owner-approved relaunch waiting to happen.
    const snap = this.freshSnapshot(rec.gridId, now);
    const ready = readiness({
      fuelPct: snap?.h2Pct ?? null,
      batteryPct: snap?.batteryPct ?? null,
      relaunchPct: this.settings().relaunchPct,
      // The resource that brought it home must be the one that says it is full.
      required: rec.need?.resource ? [rec.need.resource] : undefined,
    });
    if (ready.ready && rec.state !== 'READY_TO_RELAUNCH') {
      const next = this.put(rec, {
        state: 'READY_TO_RELAUNCH',
        needsRefuel: true,
        refuelPct: ready.pct,
        reason: `${ready.reason}: ready to relaunch to its slot — owner approval required`,
        recommendation: 'relaunch to slot',
      });
      this.raiseAlert(next, 'return-home', 'info', `${rec.name ?? rec.gridId}: refuelled, ready to relaunch (owner approval)`, now);
      this.audit('demo_survival_ready', rec.gridId, { refuelPct: ready.pct, threshold: this.settings().relaunchPct, note: ready.reason }, 'survival-loop', now);
      result.ready.push(rec.gridId);
      return;
    }
    if (!ready.ready && rec.state === 'READY_TO_RELAUNCH') {
      this.put(rec, { state: 'NEEDS_REFUEL', refuelPct: ready.pct, reason: `${ready.reason} — waiting` });
      return;
    }
    this.put(rec, { refuelPct: ready.pct, reason: `${ready.reason} — waiting` });
  }

  // -------------------------------------------------------------- primitives

  private world(now: number): DemoWorld {
    return loadWorld(this.deps.store, this.deps.fixturePath ?? null, now);
  }

  private gateFor(gridId: string, world: DemoWorld, now: number): Pick<CommsGate, 'allowed' | 'nodeId' | 'reason'> {
    if (this.deps.gateFor) {
      const seam = this.deps.gateFor(gridId, world, now);
      return { allowed: seam.allowed, nodeId: seam.nodeId, reason: seam.reason };
    }
    return evaluateGate({
      store: this.deps.store,
      world,
      now,
      nodeId: gridId,
      prefabFor: (id) => prefabForGrid(this.deps.store, id),
    });
  }

  private createMission(args: {
    gridId: string;
    name: string;
    target: Vec3;
    planet: string | null;
    altitudeM: number | null;
    land: boolean;
    gateNodeId: string;
    kind: 'return' | 'relaunch';
    note: string;
    /** TEST-ENV-ONLY: label the mission as an audited ignoreReach override. */
    adminOverride?: boolean;
    now: number;
    actor: string;
  }): { ok: true; missionId: string } | { ok: false; reason: string } {
    const created = createMission(
      this.deps.store,
      {
        type: 'move',
        priority: 55,
        desiredState: {
          shipSpec: 'stand-in-grid',
          station: `survival:${args.kind}:${args.gridId}`,
          formation: 'none',
          position: args.target,
          ...(args.planet ? { planet: args.planet } : {}),
          ...(args.altitudeM !== null ? { altitudeM: args.altitudeM } : {}),
          ...(args.land ? { land: true } : {}),
        },
        budget: { resources: {}, timeMin: 120, lossLimit: 0 },
        approval: 'approve',
        assignedUnits: [args.gridId],
        idempotencyKey: `survival:${args.kind}:${args.gridId}:${Math.floor(args.now / 60_000)}`,
        plan: {
          steps: [
            {
              id: 'validate',
              kind: 'validate_spec',
              // The executor reads `adminOverride` from a step param (the mission
              // schema strips unknown desiredState keys). TEST-ENV-ONLY.
              params: args.adminOverride ? { adminOverride: true } : {},
              done: false,
            },
            { id: 'move', kind: 'move', params: { gridId: args.gridId, target: args.target }, done: false },
            { id: 'gate', kind: 'custom', params: { demoGateNode: args.gateNodeId, action: 'move' }, done: false },
          ],
          notes:
            `[SIMULATED] survival ${args.kind} ${args.gridId} -> ${Math.round(args.target.x)}, ${Math.round(args.target.y)}, ${Math.round(args.target.z)}. ` +
            `${args.note}. The executor owns every flight order; nothing is spawned or teleported.` +
            (args.adminOverride ? ' [ADMIN OVERRIDE (test server): reachability check bypassed]' : ''),
        },
      },
      { now: args.now, actor: args.actor, autoMissionTypes: [], maxQueuedBuilds: 8 },
    );
    if (!created.ok) return { ok: false, reason: `${created.code}: ${created.message}` };
    if (created.created) {
      supersedeGridMissions(
        this.deps.store,
        args.gridId,
        created.mission.id,
        args.actor,
        args.now,
        `superseded by the survival ${args.kind} (${created.mission.id})`,
      );
    }
    const approved = approveMission(this.deps.store, created.mission.id, args.actor, args.now);
    if (!approved.ok) return { ok: false, reason: `approval: ${approved.message}` };
    return { ok: true, missionId: created.mission.id };
  }

  /** One drone row from the executor's summary, by mission. */
  private droneFor(missionId: string): { state: string; gridId: string | null; reason: string | null } | null {
    const summary = this.deps.executor?.summary();
    const execs = Array.isArray(summary?.executions) ? (summary.executions as Record<string, unknown>[]) : [];
    for (const exec of execs) {
      if (String(exec.missionId ?? '') !== missionId) continue;
      const drones = Array.isArray(exec.drones) ? (exec.drones as Record<string, unknown>[]) : [];
      const drone = drones[0];
      if (!drone) return null;
      return {
        state: String(drone.state ?? ''),
        gridId: typeof drone.gridId === 'string' ? drone.gridId : null,
        reason: typeof drone.reason === 'string' ? drone.reason : null,
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ audit

  private audit(action: string, subject: string, detail: Record<string, unknown>, actor: string, at = this.clock()): void {
    this.deps.store.audit({ actor, action, subject, detail, at });
  }

  private auditOnce(key: string, kind: string, now: number, action: string, subject: string, detail: Record<string, unknown>): void {
    const mapKey = `${key}:${kind}`;
    // A loop state that has not moved is not a state change: the row is written
    // when the reason's SHAPE changes (numbers collapsed, so a draining tank
    // does not look like an event), and at most once a minute per key.
    const signature = materialSignature(detail);
    const signatures = this.auditSignatures;
    if (signatures.get(mapKey) === signature) return;
    const last = this.lastAudit.get(mapKey) ?? 0;
    if (now - last < POSTPONE_AUDIT_MS) return;
    this.lastAudit.set(mapKey, now);
    signatures.set(mapKey, signature);
    this.audit(action, subject, detail, 'survival-loop', now);
  }

  /** One open alert per kind+grid that updates instead of repeating. */
  private raiseAlert(rec: SurvivalRecord, kind: string, severity: 'info' | 'warn' | 'critical', message: string, now: number): void {
    const existing = this.deps.store.findActiveAlert(kind, rec.gridId);
    if (existing) {
      this.deps.store.updateAlert(existing.id, {
        message,
        severity,
        count: existing.count + 1,
        lastSeenAt: now,
        evidence: { state: rec.state, need: rec.need, home: rec.home, landing: rec.landing },
      });
      return;
    }
    const row = this.deps.store.createAlert({
      kind,
      severity,
      subjectType: 'grid',
      subjectId: rec.gridId,
      message,
      evidence: { state: rec.state, need: rec.need, home: rec.home, landing: rec.landing },
      actions: [],
      firstSeenAt: now,
      lastSeenAt: now,
    });
    // A new alert IS the transition; the alerts engine does not own these
    // kinds (see OWNED_KINDS) so this is the only `alert_opened` they get.
    this.audit('alert_opened', row.id, { kind, severity, subjectId: rec.gridId, message, by: 'survival-loop' }, 'survival-loop', now);
  }

  private resolveAlert(gridId: string, now: number, note: string): void {
    this.resolveAlertKind(gridId, 'return-home', now, note);
  }

  private resolveAlertKind(gridId: string, kind: string, now: number, note: string): void {
    const existing = this.deps.store.findActiveAlert(kind, gridId);
    if (!existing) return;
    this.deps.store.resolveAlert(existing.id, now);
    this.audit('demo_survival_alert_resolved', gridId, { kind, note }, 'survival-loop', now);
  }
}

/**
 * What "the same state" means for a loop row: the detail with its numbers
 * collapsed, so a tank draining 1 %/min or a distance that creeps does not
 * read as an event, while `STRANDED -> RETURN_PENDING` or a different reason
 * shape does. Used only to decide whether a loop row is a state CHANGE.
 */
export function materialSignature(detail: Record<string, unknown>): string {
  return JSON.stringify(detail)
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ');
}

/** Altitude above the catalogue surface at a position, rounded; null unknown. */
export function altitudeAgl(pos: Vec3, planets: Planet[]): number | null {
  const planet = nearestPlanetTo(pos, planets);
  if (!planet) return null;
  return Math.round(
    Math.hypot(pos.x - planet.center.x, pos.y - planet.center.y, pos.z - planet.center.z) - planet.surfaceRadiusM,
  );
}
