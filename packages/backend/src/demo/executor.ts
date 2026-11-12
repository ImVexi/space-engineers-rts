import { randomUUID } from 'node:crypto';
import type { Mission, MissionCreate } from '@se-rts/schemas';
import type { Config } from '../config.js';
import type { PluginHub } from '../pluginHub.js';
import type { OrderRecord, Store } from '../store.js';
import { evaluateGate, prefabForGrid as sharedPrefabForGrid, type CommsGate } from './gate.js';
import { actionIntent, orderDecision, shipRoles, type RoleDecision } from './roles.js';
import { getStandIn } from './standins.js';
import { getHull, selectHull, type SpawnMode } from './hulls.js';
import type { FlightGate } from './simSpeed.js';
import { aliveNodes, loadWorld, planetByName, type DemoWorld } from './world.js';
import { loadPlanetCatalog } from '../planner/index.js';
import { readDesignerSettings } from './designer/settings.js';
import { pauseMission, supersedeGridMissions } from '../missions.js';
import { ControlWatch, type ControlTelemetry } from './control.js';
import {
  capPassengerSpeed,
  crewFromMeta,
  describePassengers,
  passengerLimits,
  personalShipLimits,
  type PassengerLimits,
} from './passengers.js';
import { StagingController } from './staging/index.js';
import {
  RELEASE_STEP_CONNECTORS,
  RELEASE_STEP_CONVERT,
  RELEASE_STEP_GEARS,
  RELEASE_STEP_PROFILE,
  RELEASE_STEP_RELOCK,
  RELEASE_STEP_VERIFY,
  STATIC_CONVERT_PENDING,
  connectorReleaseOrder,
  landingGearRelockOrder,
  landingGearReleaseOrder,
  parseReleaseReadout,
  releaseVerdict,
  isGroundTarget,
  type ReleaseBlockOrder,
} from './release.js';
import { gravityAtAltitude, planetGravity } from './designer/gravity.js';
import { atmosphereTopAltitudeM, thrustAtAltitude } from './endurance/model.js';
import { hardwareFrom, hardwareFor } from './staging/hardware.js';
import { enduranceHullFor } from './staging/policy.js';
import { STAGING_STEP_HANDOFF, hydrogenStagingHandoffOrder } from './staging/handoff.js';
import { FINE_TERRAIN_MIN_LEVEL, loadTerrainField } from './terrain.js';
import { bestColumnGround, columnGround, isLandingGrade, rememberColumnGround, requestColumnGround, type ColumnGround } from './ground.js';
import {
  COME_TO_ME_COARSE_DATUM_WAITS,
  hoverHoldDatum,
  levelFromGroundSource,
} from './comeToMe.js';
import { unavailableTerrainField, type TerrainField } from '../planner/terrainField.js';
import {
  STATION_CONVERT_MAX_SPEED_MPS,
  convertToStationOrder,
  stationDecision,
  stationLine,
  zeroVelocityOrder,
  STATION_MAX_ATTEMPTS,
  STATION_SETTLE_MS,
  STATION_SURVIVAL_STOP_TIMEOUT_MS,
  type StationConfig,
} from './station.js';
import { SURVIVAL_REASON, resolveSurvivalMode } from './survival.js';
import { decideOrderChannel } from './channel.js';
import {
  BRAKE_MARGIN,
  GROUND_FLOOR_M,
  descentStoppableSpeedMps,
  flightGuardVerdict,
  groundVerdict,
  reserveVerdict,
  safeApproachSpeedMps,
  type FlightGuardVerdict,
  type ThrustSplit,
} from './safety.js';
import { safetyOrderReason } from './safety-order.js';
import {
  DESCENT_MAX_HORIZONTAL_M,
  DESCENT_MIN_DROP_M,
  UNKNOWN_HULL_BRAKE_MPS2,
  DAMPENER_FINAL_M,
  ARRIVAL_CYCLE_AMPLITUDE_M,
  ARRIVAL_SETTLE_RANGE_M,
  ARRIVAL_SETTLE_VERTICAL_M,
  ARRIVAL_VERTICAL_RADIUS_M,
  arrivalCommandSpeedMps,
  landingContactBand,
  LANDING_CONTACT_BAND_AGL_M,
  ARRIVAL_VERTICAL_SETTLED_MPS,
  LANDING_APPROACH_DESCENT_MPS,
  LANDING_APPROACH_STALL_MIN_DROP_M,
  LANDING_APPROACH_STALL_MS,
  LANDING_APPROACH_TARGET_AGL_M,
  LANDING_HANDOVER_AGL_M,
  LANDING_FINAL_DESCENT_AGL_M,
  LANDING_FINAL_DESCENT_MPS,
  LANDING_MAX_TOUCHDOWN_AGL_M,
  LANDING_MIN_BRAKE_AGL_M,
  LANDING_MIN_BRAKE_DROP_M,
  LANDING_LIVE_BRAKE_MARGIN,
  LANDING_TOUCHDOWN_AGL_M,
  LANDING_TOUCHDOWN_MPS,
  LANDING_CONTACT_MPS,
  LANDING_LATERAL_ALIGN_M,
  LANDING_LATERAL_ARRIVE_M,
  LANDING_LATERAL_MIN_CLEARANCE_M,
  LANDING_LATERAL_RESEND_MS,
  LANDING_LATERAL_SPEED_MPS,
  LANDING_LATERAL_TIMEOUT_MS,
  LANDING_SETTLE_SPIN_MAX_DEG_S,
  LANDING_SETTLE_SPEED_MAX_MPS,
  LANDING_SETTLE_MAX_MS,
  LANDING_SETTLE_RESEND_MS,
  LANDING_SLOT_DATUM_WAITS,
  LANDING_SLOT_DATUM_MIN_FIX_M,
  CLIMB_WP_ARRIVE_M,
  CLIMB_MAX_ELEVATION_DEG,
  LANDING_DAMPENED_CONTACT_MPS,
  hullBottomAglM,
  pivotRadiusForHullBottomAgl,
  climbLadder,
  landingDescentCommand,
  waypointAngleVerdict,
  arrivalProgress,
  computeDescentProfile,
  computeLandingProfile,
  computeLegProfile,
  emptyArrivalProgress,
  groundSafetyVerdict,
  GROUND_CLEARANCE_M,
  GROUND_ORIGIN_AGL_M,
  COME_TO_ME_HOLD_FLOOR_M,
  landingApproachSpeedMps,
  landingBrakeAglM,
  landingShedRateMps2,
  buildLandAtOrder,
  chooseFinalDescentMechanism,
  PLUGIN_LAND_CAPABILITY,
  readLandingIntent,
  shouldResendMove,
  telemetryGroundFrame,
  type AltitudeSource,
  type ArrivalProgressState,
  type ClimbLadder,
  type DescentProfile,
  type FinalDescentMechanism,
  type FlightVec3,
  type GroundSafetyVerdict,
  type LandingIntent,
  type LandingProfile,
  type LegProfile,
} from './flight.js';

/**
 * Demo mission executor (T5).
 *
 * Approved demo missions are translated into an ordered plugin sequence:
 *   spawn_prefab -> ownership -> ownership_check -> wake -> ai_off -> move -> hold
 *
 * Every flight order (move/hold) passes `evaluateGate`; a denial is recorded as
 * a failed drone with the gate reason and is never sent. Stop is the only
 * un-gated action: it can only remove authority, so a kill switch always works.
 *
 * State lives in SQLite (`demo_exec`, `demo_drones`), so a backend restart
 * resumes the same step instead of re-spawning a second grid.
 */
export type DroneState =
  | 'queued'
  | 'spawning'
  | 'securing'
  | 'en_route'
  | 'holding'
  | 'stopped'
  | 'failed'
  /** A safety guard ended the flight: the ship was held/stopped, not flown on. */
  | 'aborted'
  | 'skipped'
  /** T10: launchable but held back by the active cap; labelled, never flown. */
  | 'deferred'
  /**
   * T27: a player is piloting this grid. No order of any kind is sent for it,
   * staging is suspended and its mission is paused. Terminal on purpose: the
   * executor never auto-resumes into a fight — only a new owner order flies it.
   */
  | 'manual'
  /**
   * Come to me: arrived at the hover point beside the player and waiting for
   * them to take over. NOT terminal (the mission must not finish itself) and
   * NOT `holding` (a holding drone re-anchors its waypoint every 60 s; this one
   * sends nothing at all). Only the plugin's `is_under_control` answer or a
   * newer owner order ends it.
   */
  | 'waiting_pilot';

const TERMINAL: DroneState[] = ['holding', 'stopped', 'failed', 'aborted', 'skipped', 'deferred', 'manual'];
/**
 * Mission statuses that END the run. The read-only monitors (`probe_ground`,
 * `is_under_control`) are disarmed for these: a finished mission must send no
 * order at all. `paused` is deliberately absent — it is resumable, and its
 * control probe is how a released cockpit is noticed.
 */
const TERMINAL_MISSION_STATUS: string[] = ['done', 'failed', 'cancelled'];
/** Drone step marker: the grid has been converted to a station (static). */
const STATIONED_STEP = 'stationed';
const STATIONING_STEP = 'stationing';
/** Landing mode: the gear lock was sent and the ship is down (a ship, not a station). */
const LANDING_STEP_LOCKED = 'landed';
/**
 * Come to me: the hover is handed to the dampeners, then NOTHING is sent. The
 * step doubles as the "timeout already audited" flag.
 */
const COME_TO_ME_STEP_HOLD = 'come-to-me-hold';
const COME_TO_ME_STEP_AUTOPILOT_OFF = 'come-to-me-autopilot-off';
const COME_TO_ME_STEP_WAITING = 'come-to-me-waiting';
const COME_TO_ME_STEP_TIMED_OUT = 'come-to-me-timed-out';
/** Time between the arrival hold and the autopilot-off stop, ms (settle). */
const COME_TO_ME_SETTLE_MS = 2_000;
/** Drone step marker: this come-to-me handoff was already completed. */
const COME_TO_ME_STEP_HANDED = 'come-to-me-handed';
const FLYING: DroneState[] = ['en_route', 'holding'];

/**
 * The mission's come-to-me block (desiredState.comeToMe), as the executor reads
 * it back. Everything else in the mission schema strips unknown keys, so this
 * is where progress has to live.
 */
export interface ComeToMeMissionState {
  player?: string | null;
  playerName?: string | null;
  standIn?: Vec3;
  standoff?: { lateralM: number; aboveGroundM: number };
  hover?: Vec3;
  hoverAglM?: number | null;
  /** True ground radius at the hover column when the point was built, m. */
  groundRadiusM?: number | null;
  /** Tile level behind `groundRadiusM` (0 = planning field, 5 = finest). */
  groundLevel?: number | null;
  groundSource?: string;
  /** True ground radius at the hover column when the point was built, m. */
  plannedGroundRadiusM?: number | null;
  /** Tile level behind the hover readback (0 = coarse planning field). */
  hoverAglLevel?: number | null;
  /** `measured-own-column` | `plan-datum` | `plan`: how `hoverAglM` was read. */
  hoverAglSource?: string;
  distanceToPlayerM?: number | null;
  phase?: 'flying' | 'waiting_for_pilot' | 'handed_to_pilot' | 'timed_out';
  readyAt?: number;
  timeoutMs?: number;
}

export interface DroneRow {
  missionId: string;
  idx: number;
  label: string;
  prefab: string;
  role: string | null;
  planet: string | null;
  planSlot: Vec3;
  execSlot: Vec3;
  spawn: Vec3;
  state: DroneState;
  gridId: string | null;
  attempts: number;
  reason: string | null;
  /** Securing sub-step (ownership -> ownership_check -> wake -> ai_off -> move). */
  step: string | null;
  /** T50: how many flight orders this drone has been sent (fleet step completion). */
  ordersSent?: number;
  /** Ticks spent waiting for fresh link telemetry; bounded by GATE_WAIT_TICKS. */
  gateWaits: number;
  pendingOrder: string | null;
  pendingAction: string | null;
  pendingAt: number | null;
  holdAt: number | null;
  stopSentAt: number | null;
  /** Hull selection: 'surface' (gravity thrust) or 'orbital' (ion above atmo). */
  spawnMode: SpawnMode;
  /** T10 admin override: bypass the reach half of the comms gate (test only). */
  adminOverride: boolean;
  /**
   * Landing mode (owner request, 2026-11-10): the drone lands at its slot
   * instead of holding in the air. `execSlot` is then THE GROUND POINT and the
   * AGL of that point is negative on purpose.
   */
  landing: LandingIntent | null;
  updatedAt: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Controlled-fall state for one descent leg (T52). */
interface DescentState {
  /**
   * measuring: the `inspect` probe is out; falling: dampeners off, no thrust;
   * braking: the brake move was sent, normal arrival logic owns the ship;
   * late-brake: telemetry was late, full dampener brake until it is slow.
   */
  phase: 'measuring' | 'falling' | 'braking' | 'late-brake';
  probeId: string | null;
  probeAt: number;
  plan: DescentProfile | null;
  /** Dampened profile used if the measurement rejects the fall (recorded). */
  normalProfile: LegProfile | null;
  rejected: string | null;
  startedAt: number;
  /** Where the AGL used for this descent came from (terrain / probe / mean). */
  groundSource: AltitudeSource;
  /**
   * Ground radius the fall plan was computed against, m. The brake altitude in
   * `plan` is AGL over THAT ground; if the terrain field resolves higher while
   * the fall is running, the real clearance is
   * `plan.brakeAltAglM + planGroundRadiusM - currentGroundRadiusM`.
   */
  planGroundRadiusM: number | null;
  /** AGL at the moment the fall was planned, m. */
  altitudeAglM: number;
  targetAglM: number;
  /**
   * Landing mode (owner request, 2026-11-10). `flare`: dampeners off, a fast
   * gravity fall; `flare-brake`: the dampened brake (autopilot off, dampeners
   * on) that stops the ship at `landing.flareAglM` above the true ground;
   * `approach`: the dampener-pulse final descent — the autopilot is OFF and the
   * last phase is flown by turning dampeners off/on, because the SE autopilot
   * will not fly a waypoint below the ship (measured 2026-11-10). `landing` is
   * null on an ordinary descent, which then flies exactly as before.
   */
  landing: {
    phase: 'flare' | 'flare-brake' | 'approach' | 'plugin-land' | 'lateral' | 'settle';
    plan: LandingProfile;
    brakeStartedAt?: number;
    /** Final descent: dampeners currently released for a descent pulse. */
    dampenersOff?: boolean;
    /** When the current pulse (either state) was written. */
    pulseAt?: number;
    /** Last control verdict, for the audit trail. */
    pulseReason?: string;
    /** How many times the brake stopped the hull short and the fall resumed. */
    resumes?: number;
    /** plugin-land: the single `land_at` order, and when it went out. */
    pluginOrderId?: string | null;
    pluginOrderAt?: number;
    /** plugin-land: the plugin reported the landing finished/aborted. */
    pluginAbortReason?: string | null;
    /**
     * plugin-land: the ground radius the `land_at` order carried, m (defect b,
     * 2026-11-11). The terrain field refines as the descent moves, so this is
     * what the plugin is currently braking against; `land_ground` replaces it.
     */
    pluginGroundRadiusM?: number | null;
    /** plugin-land: backend clock of the last `land_ground`, ms. */
    groundUpdateAt?: number;
    /** plugin-land: how many `land_ground` updates went out for this landing. */
    groundUpdates?: number;
    /** plugin-land: the first coarse-sample skip was audited at, ms. */
    coarseDatumAuditedAt?: number;
    /** plugin-land: a late-decent datum disagreement held the hull at, ms. */
    groundDisagreementAt?: number;
    /**
     * Approach alignment (2026-11-11 flight set 5): the lateral leg flown at
     * altitude to above the REQUESTED column before the `land_at` handover.
     * Present only while the leg is in progress or after it finished, so the
     * audit and the tests can read how far it had to fly.
     */
    lateral?: {
      /** Clock of the first leg order, ms. */
      startedAt: number;
      /** Clock of the last leg order, ms. */
      lastMoveAt: number;
      /** Horizontal offset measured when the leg was planned, m. */
      offsetAtStartM: number;
      /** Orders sent for the leg. */
      moves: number;
      /** AGL (hull bottom over the CURRENT column's ground) the leg flies at, m. */
      targetAglM: number;
      /** The point the leg flies to, world metres. */
      target: Vec3;
    };
    /**
     * SETTLE GATE before the handover (2026-11-11 flight set 6): the hull is
     * held on autopilot-off + dampeners-on until its measured angular rate and
     * speed are inside the handover envelope, bounded by
     * `LANDING_SETTLE_MAX_MS`. Present only while the settle runs.
     */
    settle?: {
      /** Clock the settle started, ms. */
      startedAt: number;
      /** Clock of the last safety order re-assert, ms. */
      lastOrderAt: number;
      /** Angular rate measured when the settle started, deg/s (null = unread). */
      spinAtStartDegS: number | null;
      /** Speed measured when the settle started, m/s (null = unread). */
      speedAtStartMps: number | null;
      /** Re-asserts sent. */
      orders: number;
    };
    /** plugin-land: spin-refusal retries already spent after a settle. */
    startRetries?: number;
    /** plugin-land: the hold-target audit row went out for this order. */
    holdTargetAudited?: boolean;
  } | null;
}

/** Per-drone safety state (in memory: a backend restart re-probes and re-issues). */
interface GuardState {
  /** SpeedLimit currently written to the autopilot. */
  speedLimit: number;
  lastResendAt: number;
  lastBrakeAt: number;
  /** plugin-land handovers deferred until the column read is landing grade. */
  coarseHandoverWaits?: number;
  /** Landing attempts waiting for a landing-grade sample at the TARGET column. */
  slotDatumWaits?: number;
  /** come-to-me: ticks spent waiting for a landing-grade read at the hover column. */
  comeToMeDatumWaits?: number;
  /** come-to-me: the hold point was rebuilt on a better datum (once per drone). */
  comeToMeDatumFixed?: boolean;
  /** A brake hold was sent; the waypoint must be re-issued. */
  needsMove: boolean;
  /**
   * Last `probe_ground` hit, world space, or null. It only REFINES the ground
   * reference: on this build the probe cannot hit procedural planet terrain
   * (Storage.GetGeometry() is null), so it is opportunistic and never awaited.
   */
  groundHit: Vec3 | null;
  probeAt: number;
  probeId: string | null;
  /** Consecutive probe misses; after two the probe backs off for two minutes. */
  probeMisses: number;
  probeMissAt: number;
  lastVerdict: FlightGuardVerdict | null;
  /** Overshoot detection: last distance and consecutive ticks moving away. */
  lastRemaining: number | null;
  awayTicks: number;
  /** Arrival loop guard: closing rate, speed shortfall and limit-cycle swings. */
  arrival: ArrivalProgressState;
  /** Terminal phase: collision avoidance is handed to the speed/ground guard. */
  terminal: boolean;
  postmortem: boolean;
  /** T19: convert attempts after zeroing velocity (max 3). */
  stationAttempts: number;
  /** T19: backend clock when zero_velocity last completed; the 2 s wait starts here. */
  stationZeroAt: number | null;
  /** T19: last speed the plugin read on the grid, m/s. */
  stationSpeedMps: number | null;
  /** T19: do not retry a refused conversion for this long. */
  stationGiveUpAt: number | null;
  /** Contract §3: one flight profile per leg, computed when the move is sent. */
  legProfile: LegProfile | null;
  legStartedAt: number | null;
  predictedEtaS: number | null;
  predictedFuelL: number | null;
  /** Hydrogen fraction sampled when the leg order went out. */
  fuelAtStart: number | null;
  /** Vacuum cruise with dampeners off; set once, cleared on arrival. */
  dampenersOff: boolean;
  /** When dampeners came back on for the final approach. */
  dampenersOnAt: number | null;
  /** T52 controlled fall for this descent leg (null on climbs/horizontal legs). */
  descent: DescentState | null;
  /**
   * Near-vertical climbs (measured 2026-11-10): the SE autopilot crawls on a
   * waypoint close to the local up vector, so the leg is flown as a ladder of
   * shallower waypoints (see `climbLadder`). `index` is the waypoint being
   * flown; the last waypoint is the leg's own slot. Null on every other leg.
   */
  climb: { ladder: ClimbLadder; index: number } | null;
  /**
   * A near-vertical leg the throttle guard re-issued (2026-11-11): `buildMove`
   * re-aimed it onto the 60 deg cone, so the waypoint it sent is a point ~553 m
   * TANGENTIALLY away at the slot's own altitude, not the slot. That point is
   * an intermediate step only — once the hull is on it, the leg to the real
   * slot (lateral, same altitude) is sent, so the ship ends up over the
   * requested column instead of descending off it. `steps` caps the chain so a
   * pathological leg cannot dogleg forever. Null on a normal leg.
   */
  coneStep: { point: Vec3; steps: number } | null;
  /**
   * Signed pivot -> lowest hull point along local down, m (plugin
   * `keelDepthM`). Every ground rule is phrased on the HULL BOTTOM, so this is
   * the correction between the grid's reported position and the part that
   * actually touches terrain. `keelSource` says where it came from.
   */
  keelM: number;
  /**
   * Where `keelM` came from: the plugin's own label when it sends one
   * ('local-aabb'), else 'telemetry', 'inspect', or 'none' (old behaviour).
   */
  keelSource: 'telemetry' | 'inspect' | 'none' | (string & {});
  /** Emission period of the telemetry feeding this drone, s (measured). */
  telemetryPeriodS: number;
  /** `unit.lastSeen` of the previous tick, for the period measurement. */
  lastTelemetryAt: number | null;
  /**
   * Landing approach progress: the last AGL that counted as downward progress
   * and when. A ship that stops descending is aborted, never left hovering.
   */
  approach: { lastAglM: number; atMs: number } | null;
  /**
   * A landing slot that sits at/below the ground datum measured at the ship's
   * own column was accepted as the GROUND POINT (audited once, not per tick).
   */
  landingSlotGround: boolean;
  /**
   * Measured dampened shed rate of this hull, m/s². Sampled from the live
   * brake (Δ|v| / Δt with the dampeners holding) so the next brake point is
   * planned from a measurement instead of a constant. Null until one is seen.
   */
  measuredShedMps2: number | null;
  /** Sample used to derive `measuredShedMps2` (prev tick's speed and time). */
  shedSample: { speedMps: number; atMs: number } | null;
  /**
   * When the landing phase last SENT an order. The idle watchdog audits
   * `demo_landing_idle` after LANDING_PHASE_IDLE_MS of silence, then resumes or
   * aborts: measured 2026-11-10 a landing phase sat 290 s with no order and no
   * audit row, and nothing noticed.
   */
  landingOrderAt: number | null;
  /** When the idle watchdog's current 20 s window started (null = restart). */
  landingIdleAt: number | null;
  /**
   * AGL at the start of that window. The watchdog keeps its OWN anchor: the
   * approach's `gs.approach` is re-armed on every metre of progress, so reading
   * it made a 0.3 m/s descent look like "no descent" and aborted a good landing.
   */
  landingIdleAglM: number | null;
  /** Resumes the idle watchdog already granted for this landing. */
  landingIdleResumes: number;
  /** The contact-band warning has been written for this landing (once). */
  landingContactWarned?: boolean;
}

/**
 * How hard dampeners shed vertical speed once the brake is engaged, when it is
 * less than the hull's full thrust authority: SE's dampeners hold a velocity
 * setpoint and kill the descent smoothly instead of slamming a full-thrust burn
 * that would throw the ship back up (the 1 km overshoot measured 2026-11-10).
 */
const LANDING_SHED_DECEL_MPS2 = 4;
/** Ticks the flare brake may take before it counts as failed to stop, s. */
const LANDING_BRAKE_TIMEOUT_S = 30;
/**
 * A landing phase that sends NO order for this long is audited as
 * `demo_landing_idle` and then either resumed or aborted with a plain reason.
 * Measured 2026-11-10: `advanceLandingFlareBrake` re-armed its timer forever and
 * the ship sat 290 s with zero orders and zero audit rows.
 */
const LANDING_PHASE_IDLE_MS = 20_000;
/** How many idle resumes the watchdog grants before it aborts, per landing. */
const LANDING_IDLE_MAX_RESUMES = 2;

function clampPct(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * Set by `buildMove` on every waypoint it produces. `send` refuses to put a
 * `move` on the wire without it, so a move built anywhere else fails loudly in
 * the tests instead of quietly asking the autopilot for a leg it cannot fly.
 * Symbol-keyed: `JSON.stringify` (and therefore the plugin payload) never sees
 * it.
 */
const WAYPOINT_GUARDED: unique symbol = Symbol('hermes.waypointGuarded');

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export interface ExecRow {
  missionId: string;
  state: string;
  scaled: boolean;
  total: number;
  cap: number;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DroneSeed {
  idx: number;
  label: string;
  prefab: string;
  role: string | null;
  planet: string | null;
  planSlot: Vec3;
  spawnMode: SpawnMode;
  hullReason: string;
  /** T10: an existing owner-tagged grid launched in place (no spawn/clone). */
  existingGridId?: string;
  /** T10 admin override, copied from the mission's desiredState. */
  adminOverride?: boolean;
}

export interface DemoExecutorDeps {
  store: Store;
  hub: PluginHub;
  config: Config;
  clock?: () => number;
  fixturePath: string | null;
  /** SimSpeed gate (owner rule). Absent in unit tests that do not fly. */
  simSpeed?: FlightGate;
  /** T20 power poller: the same read-only `profile` sample /api/demo/state
   *  exposes carries `control.underControl`, the cheapest manual-handoff check. */
  power?: { snapshot(gridId: string): { underControl: boolean; controlledBy: string | null; at: number } | null };
  /**
   * Test/ops seam for the terrain height field: return the field for a planet
   * synchronously instead of letting the executor load it. Production leaves
   * this unset and the executor loads (and caches) one field per planet.
   */
  terrainField?: (planet: NonNullable<ReturnType<typeof nearestPlanet>>) => TerrainField | null;
  /**
   * T74: explicit survivalMode for tests and embedded use. Production leaves it
   * unset and it resolves from the environment (ON unless RTS_ENV=test AND the
   * test-server marker are set).
   */
  survivalMode?: boolean;
}

/**
 * A re-sampled ground radius that differs from the one `land_at` carried by more
 * than this is pushed to the plugin mid-descent as `land_ground`, m (2026-11-11).
 * Below it the datum change cannot move a brake decision by a metre.
 */
const LAND_GROUND_MIN_DELTA_M = 2;
/** At most ONE `land_ground` per this interval, ms (order cost, not a poll). */
const LAND_GROUND_MIN_INTERVAL_MS = 5_000;
/** At most this many `land_ground` updates per landing. */
const LAND_GROUND_MAX_UPDATES = 5;
/**
 * LATE-DESCENT DATUM GUARD (2026-11-11). A `land_ground` update that moves the
 * AGL by more than max(this many metres, this fraction of the current AGL) while
 * the hull is below the AGL below is NOT sent: the backend orders a safe hover
 * and audits `ground datum disagreement` instead.
 *
 * The number this defends against is measured: at 18 m AGL the datum moved
 * 61 197.8 -> 61 160.7 m (-37.1 m, the level-5 sample replaced by the level-0
 * planning field), the indicated AGL became 52.5 m in one tick, the 21.4 m
 * brake stopped being a brake and the hull flew the last metres at ~5 m/s with
 * a spin -> safe abort at 39.6 m indicated (~18 m of real clearance). A datum
 * may be corrected late in a descent, but not by a jump that erases the
 * clearance the descent was flying to.
 */
const LAND_GROUND_JUMP_MIN_M = 5;
/** Fraction of the current AGL a late datum change may not exceed. */
const LAND_GROUND_JUMP_AGL_FRACTION = 0.25;
/** The guard only applies below this hull-bottom AGL, m. */
const LAND_GROUND_JUMP_MAX_AGL_M = 150;
/**
 * Ticks a plugin-land handover waits for a landing-grade column sample before
 * it accepts a planning-grade datum (labelled). Bounded so a descent can never
 * wait on terrain (the 2026-11-10 rule).
 */
const LANDING_HANDOVER_COARSE_WAITS = 5;

const MAX_SAVE_ATTEMPTS = 3;
/**
 * How many intermediate cone waypoints one re-aimed leg may chain (2026-11-11).
 * A near-vertical leg is clamped onto the 60 deg cone; the hull is sent to that
 * point, then to the requested column. More than a few steps means the leg is
 * fighting the ceiling, which the arrival guard should report, not paper over.
 */
const CONE_STEP_MAX = 3;
/**
 * A clamp only becomes an intermediate step when it moved the waypoint a real
 * distance, m. A 19 m settle above the slot re-aims by 11 m, which the arrival
 * logic already handles; sending a "column leg" for that would refuse a landing
 * that had in fact arrived.
 */
const CONE_STEP_MIN_HORIZONTAL_M = 50;
const ORDER_TIMEOUT_MS = 25_000;
/** PASS criterion: a drone counts as arrived only within 50 m of its slot. */
const ARRIVAL_RADIUS_M = 50;
const ARRIVAL_TIMEOUT_MS = 240_000;
/** Ticks (1 s) a drone may wait for its first usable link sample after wake. */
const GATE_WAIT_TICKS = 10;
/** A descent does not start until the measured lift probe answers (or this expires). */
const DESCENT_PROBE_TIMEOUT_MS = 6_000;
/**
 * Hard cap on the whole `measuring` phase. FAILURE 1 (2026-11-10): the descent
 * sat in `measuring` for the whole run because it waited on a ground
 * measurement that cannot arrive on procedural planet terrain. Whatever
 * happens, after this the ship flies the dampened descent and the audit says
 * why.
 */
const DESCENT_MEASURE_MAX_MS = 20_000;
/**
 * How long an unavailable terrain field is kept before the loader is asked
 * again, ms. Matches `terrain.ts`'s own unavailable TTL: a terrain service that
 * comes up after the backend does is picked up without a restart.
 */
const TERRAIN_UNAVAILABLE_RETRY_MS = 30_000;
/** How long a landing-grade (level-5) terrain sample stays valid, ms. */

function vec(v: unknown): Vec3 | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
}

function add(a: Vec3, b: Vec3, scale = 1): Vec3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function norm(v: Vec3): Vec3 {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

function json<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class DemoExecutor {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  /** Wall-clock ms of the last tick start, and the worst gap between ticks. */
  private lastTickStartMs = 0;
  private maxTickGapMs = 0;
  private lastTickGapMs = 0;
  private tickCount = 0;
  private identityId: string | null = null;
  /** T8: hydrogen/stockpile staging, driven from live telemetry. */
  private readonly staging: StagingController;
  /** Flight-safety state per drone, keyed `${missionId}:${idx}`. */
  private readonly guards = new Map<string, GuardState>();
  /** In-flight ground probe orders, keyed orderId. */
  private readonly probes = new Map<string, { key: string; gridId: string }>();
  /** T27: player-control watch, keyed by grid id. */
  private readonly controls: ControlWatch;

  /** In-flight `is_under_control` reads, keyed orderId. */
  private readonly controlProbes = new Map<string, { gridId: string; missionId: string; idx: number }>();

  /**
   * Missions whose monitors have been disarmed. One `demo_probe_disarm` audit
   * row per disarm (not per tick); the entry is dropped again on re-arm.
   */
  private readonly disarmed = new Set<string>();

  /**
   * Terrain height fields, one per planet, loaded on first need (ground-datum
   * crash, 2026-11-10). The catalogue surfaceRadiusM is a mean that sits
   * 1 616.7 m below the real ground at the test column, so AGL has to be
   * measured from the terrain, not from that number.
   */
  private readonly terrainFields = new Map<string, { field: TerrainField; at: number }>();
  private readonly terrainLoading = new Set<string>();
  /**
   * Level-5 terrain radius per column for LANDING altimetry. The level-0
   * planning field is ~1.5 km per sample and measured 17 m low at BASE-01 and
   * 31 m low at SAT-R-0001's column — a flare sized on it brakes inside the
   * hill. Keyed by the unit direction rounded to ~6 m.
   */

  /**
   * T74: on a non-test backend no admin action leaves this process. Captured at
   * construction so a test can pin it; production resolves the env once at boot.
   */
  private readonly survivalMode: boolean;

  /**
   * Missions whose PERSONAL ship the owner explicitly confirmed (site dialog,
   * `desiredState.personalConfirmed`). Only those may receive flight orders;
   * everything automatic is refused on a personal grid regardless.
   */
  private readonly personalConfirmed = new Set<string>();

  constructor(private readonly deps: DemoExecutorDeps) {
    this.survivalMode = deps.survivalMode ?? resolveSurvivalMode();
    this.controls = new ControlWatch(
      { getKv: (key) => deps.store.getKv(key), setKv: (key, value) => deps.store.setKv(key, value) },
      () => this.now(),
    );
    this.staging = new StagingController({
      store: deps.store,
      send: (payload) => this.stagingSend(payload),
      enabled: process.env.RTS_STAGING !== '0',
      dryRun: process.env.RTS_STAGING_DRY === '1',
      ...(process.env.RTS_STAGING_TICK_MS ? { tickMs: Number(process.env.RTS_STAGING_TICK_MS) } : {}),
    });
  }

  /**
   * Staging has its own sender (it is a long-lived controller), so the ship
   * role is enforced here too: PERSONAL ships are never thrust-staged, and an
   * OFF grid receives nothing.
   */
  private stagingSend(payload: unknown): boolean {
    const gridId = String((payload as { entityId?: unknown })?.entityId ?? '');
    const role = gridId ? shipRoles.roleOf(gridId) : 'managed';
    if (role !== 'managed') {
      this.store().audit({
        actor: 'demo-executor',
        action: 'role_refused',
        subject: gridId || 'staging',
        detail: { feature: 'staging', role, reason: `role ${role}: thrust staging only touches managed grids`, note: 'no order was sent to the plugin' },
        at: this.now(),
      });
      return false;
    }
    return this.deps.hub.send(payload as never);
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private store(): Store {
    return this.deps.store;
  }

  enabled(): boolean {
    return this.store().getFlags().demo_execute === true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Tick-latency telemetry: a flight tick that arrives late is a control
      // decision that arrived late. Measured here so "the event loop starved"
      // is a number, not an opinion.
      const startedAt = Date.now();
      if (this.lastTickStartMs > 0) {
        const gap = startedAt - this.lastTickStartMs;
        if (gap > this.maxTickGapMs) this.maxTickGapMs = gap;
        this.lastTickGapMs = gap;
      }
      this.lastTickStartMs = startedAt;
      this.tickCount += 1;
      try {
        this.tick();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_executor_error',
          subject: 'tick',
          detail: { error: this.lastError },
          at: this.now(),
        });
      }
    }, Math.max(250, this.deps.config.demo.tickMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Flight-tick latency: the measured interval the loop actually achieved.
   * `starved` is the state that cost SAT-R-0001: a gap over twice the target
   * interval means a control decision arrived too late.
   */
  tickStats(): {
    intervalMs: number;
    lastGapMs: number;
    maxGapMs: number;
    ticks: number;
    starved: boolean;
  } {
    const intervalMs = Math.max(250, this.deps.config.demo.tickMs);
    return {
      intervalMs,
      lastGapMs: this.lastTickGapMs,
      maxGapMs: this.maxTickGapMs,
      ticks: this.tickCount,
      starved: this.maxTickGapMs > intervalMs * 2,
    };
  }

  /** Start a fresh measurement window (tests, and an operator asking "since when"). */
  resetTickStats(): void {
    this.lastTickStartMs = 0;
    this.maxTickGapMs = 0;
    this.lastTickGapMs = 0;
    this.tickCount = 0;
  }

  // ------------------------------------------------------------------- tick

  tick(): void {
    const now = this.now();
    this.lastTickAt = now;
    if (!this.enabled()) return;
    this.sync(now);
    this.pollControlProbes(now);
    if (this.store().isKillSwitchOn()) {
      this.staging.reset('kill switch on: staging suspended');
      this.emergencyStop(now);
      return;
    }
    // One ship, one order: a cancelled/finished mission stops its drones, and
    // when two live missions command the same grid only the newest one flies.
    const createdAt = (id: string): number => this.store().getMission(id)?.createdAt ?? 0;
    const newestByGrid = new Map<string, { missionId: string; at: number }>();
    for (const exec of this.execs()) {
      const st = this.store().getMission(exec.missionId)?.status;
      if (st && !['approved', 'executing'].includes(st)) continue;
      for (const d of this.drones(exec.missionId)) {
        if (!d.gridId || TERMINAL.includes(d.state)) continue;
        const at = createdAt(exec.missionId);
        const cur = newestByGrid.get(d.gridId);
        if (!cur || at > cur.at) newestByGrid.set(d.gridId, { missionId: exec.missionId, at });
      }
    }
    for (const exec of this.execs()) {
      const status = this.store().getMission(exec.missionId)?.status;
      const missionDead = Boolean(status && !['approved', 'executing'].includes(status));
      for (const drone of this.drones(exec.missionId)) {
        // A manual row still runs the read-only probe (that is how a released
        // cockpit is noticed) but never receives another order.
        if (drone.state === 'manual') {
          if (drone.gridId) this.controlPass(exec, drone, now);
          continue;
        }
        if (TERMINAL.includes(drone.state)) continue;
        // T27 manual handoff: a piloted grid gets NO order of any kind. This
        // runs before the mission/supersede stop paths, so pausing a mission
        // for manual control can never send a stop either.
        if (drone.gridId && this.controlPass(exec, drone, now)) continue;
        const newest = drone.gridId ? newestByGrid.get(drone.gridId) : undefined;
        const superseded = Boolean(newest && newest.missionId !== exec.missionId);
        if (missionDead || superseded) {
          if (drone.gridId) this.sendRaw(exec, drone, now, 'stop', {}, missionDead ? 'mission-released' : 'superseded');
          this.setState(
            drone,
            'stopped',
            now,
            missionDead ? `mission ${status}: drone released` : `superseded by newer order ${newest?.missionId}`,
          );
          continue;
        }
        try {
          this.advance(exec, drone, now);
          this.stageDrone(exec, drone, now);
        } catch (err) {
          this.fail(drone, now, `executor error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.finishIfDone(exec, now);
      this.stationPass(exec, now);
    }
    this.cleanupTerminal(now);
  }

  /** Create execution rows for approved demo missions (idempotent). */
  sync(now: number): void {
    const missions = this.store().listMissions({ status: ['approved', 'executing'], limit: 50 });
    for (const mission of missions) {
      if (!isDemoMission(mission)) continue;
      if (this.execs().some((e) => e.missionId === mission.id)) continue;
      const plan = this.seedsFor(mission);
      if (plan.error) {
        // An approved mission whose source the executor cannot build is a
        // FAILED mission, stated once and audited: silently skipping it left
        // verify #3's approved survival return sitting at `approved` with no
        // execution row and no order for the whole run.
        this.failMissionSource(mission, plan.error, now);
        continue;
      }
      const seeds = plan.seeds;
      if (!seeds.length) continue;
      // T10 admin override travels with the mission, not the order payload:
      // every drone in it is labelled and audited accordingly. The flag lives
      // in a step param because the mission schema strips unknown desiredState
      // keys (station is the only free-form field that survives).
      const adminOverride =
        Boolean((mission.desiredState as { adminOverride?: unknown }).adminOverride) ||
        (mission.plan.steps ?? []).some((s) => s.params?.adminOverride === true);
      if (adminOverride) for (const seed of seeds) seed.adminOverride = true;
      // A PERSONAL ship only receives flight orders when the owner confirmed
      // the mission on the site; the flag travels in desiredState (declared in
      // the schema, unlike the older step-param adminOverride).
      if (Boolean((mission.desiredState as { personalConfirmed?: unknown }).personalConfirmed)) {
        this.personalConfirmed.add(mission.id);
      }
      const settings = readDesignerSettings(this.store());
      const designer = isDesignerMission(mission);
      // T6: the per-mission cap is the designer setting (validated 1..10), not
      // the legacy executor default of 1. Non-designer demo missions keep the
      // config cap so old scenarios are unchanged.
      const cap = Math.max(
        1,
        Math.min(designer ? Math.min(settings.maxActive, 10) : this.deps.config.demo.maxDronesPerMission, 10),
      );
      const chosen = seeds.slice(0, cap);
      // T10: a launch-in-place mission holds the excess drones back instead of
      // marking them skipped; they are real owner satellites and stay in the
      // world untouched, so 'deferred' is the honest state (never flown).
      const inPlaceMission = seeds.some((s) => Boolean(s.existingGridId));
      const overflowState: DroneState = inPlaceMission ? 'deferred' : 'skipped';
      const overflowReason = inPlaceMission
        ? `QUEUED: active cap ${cap}; not launched in this run`
        : `mission cap ${cap}: not executed in this demo`;
      if (seeds.length > cap) {
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_mission_cap',
          subject: mission.id,
          detail: { requested: seeds.length, cap, maxActive: settings.maxActive, designer },
          at: now,
        });
      }
      const scaled = chosen.some((s) => dist(s.planSlot, this.execSlotFor(s, seeds, mission, chosen.indexOf(s))) > 1_000);
      const note = seeds.length > cap
        ? `SCALED DEMO: executing the first ${cap} of ${seeds.length} planned nodes (per-mission cap ${cap}); the rest are marked skipped`
        : scaled
          ? 'SCALED DEMO: plan slots are compressed to a short local leg so a LAN demo finishes in minutes; planned positions are unchanged in the planner'
          : null;
      this.store().db
        .prepare(
          `INSERT OR IGNORE INTO demo_exec (mission_id, state, scaled, total, cap, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(mission.id, 'running', scaled ? 1 : 0, seeds.length, cap, note, now, now);
      chosen.forEach((seed, i) => {
        const landing = this.landingIntentFor(mission, seed, i);
        // `park` is resolved once, here, into either a landing (the point is on
        // the ground) or a plain hold at the point (it is airborne). A park that
        // resolves to a hold has NO landing phases: it flies the normal leg.
        const resolved = landing?.kind === 'park' ? this.resolvePark(mission, seed, i, landing) : landing;
        const execSlot = resolved ? this.landingSlotFor(seed, i) : this.execSlotFor(seed, seeds, mission, i);
        const spawn = this.spawnFor(mission, seed, i);
        this.store().db
          .prepare(
            `INSERT OR IGNORE INTO demo_drones
             (mission_id, idx, label, prefab, role, planet, plan_slot_json, exec_slot_json, spawn_json,
              state, attempts, reason, spawn_mode, admin_override, landing_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?, ?, ?)`,
          )
          .run(
            mission.id,
            seed.idx,
            seed.label,
            seed.prefab,
            seed.role,
            seed.planet,
            JSON.stringify(seed.planSlot),
            JSON.stringify(execSlot),
            JSON.stringify(spawn),
            seed.spawnMode,
            seed.adminOverride ? 1 : 0,
            resolved ? JSON.stringify(resolved) : null,
            now,
          );
      });
      for (const seed of seeds.slice(cap)) {
        this.store().db
          .prepare(
            `INSERT OR IGNORE INTO demo_drones
             (mission_id, idx, label, prefab, role, planet, plan_slot_json, exec_slot_json, spawn_json,
              state, attempts, reason, spawn_mode, admin_override, landing_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          )
          .run(
            mission.id,
            seed.idx,
            seed.label,
            seed.prefab,
            seed.role,
            seed.planet,
            JSON.stringify(seed.planSlot),
            JSON.stringify(this.execSlotFor(seed, seeds, mission, seed.idx)),
            JSON.stringify(this.spawnFor(mission, seed, seed.idx)),
            overflowState,
            overflowReason,
            seed.spawnMode,
            seed.adminOverride ? 1 : 0,
            null,
            now,
          );
      }
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_exec_created',
        subject: mission.id,
        detail: {
          total: seeds.length,
          executed: chosen.length,
          cap,
          scaled,
          note,
          hulls: chosen.map((s) => ({ prefab: s.prefab, spawnMode: s.spawnMode, reason: s.hullReason })),
        },
        at: now,
      });
    }
  }

  /**
   * An approved demo mission the executor has no builder for: audit it once and
   * mark it failed with the reason, so the mission list and the survival loop
   * can see why nothing flew. Never a silent skip.
   */
  private failMissionSource(mission: Mission, reason: string, now: number): void {
    const already = this.store()
      .listAudit(50)
      .some((a) => a.action === 'demo_mission_source_not_executable' && a.subject === mission.id);
    if (!already) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_mission_source_not_executable',
        subject: mission.id,
        detail: {
          reason,
          station: String((mission.desiredState as { station?: unknown }).station ?? ''),
          steps: (mission.plan.steps ?? []).map((s) => `${s.id}:${s.kind}`),
        },
        at: now,
      });
    }
    const current = this.store().getMission(mission.id);
    if (current && ['done', 'failed', 'cancelled'].includes(current.status)) return;
    this.store().updateMission(mission.id, { status: 'failed', pauseReason: reason }, now);
  }

  // -------------------------------------------------------------- planning

  /**
   * Seeds for an approved demo mission, or an explicit error when its source is
   * one the executor has no builder for.
   *
   * `survival:` is flown by the SAME builder as `move:`: a survival
   * return/relaunch mission is a `move` mission whose station is
   * `survival:return:<grid>` / `survival:relaunch:<grid>`, assigned to exactly
   * one existing grid, with the target in the `move` step. Reusing the builder
   * is the point: the guarded path (lateral leg -> settle -> land_at for a
   * return, climb to the slot / station rules for a relaunch) is the move path,
   * so a survival mission cannot drift into a parallel one.
   */
  private seedsFor(mission: Mission): { seeds: DroneSeed[]; error: string | null } {
    const desired = mission.desiredState as { station?: string; planet?: string; launch?: string };
    const station = String(desired.station ?? '');
    const steps = mission.plan.steps ?? [];

    // T6 designer missions: one drone per planned slot. `launch` decides where
    // the grid starts (surface: low spawn near the control source; orbital: at
    // the slot itself), never whether the slot is flown to.
    if (station.startsWith('designer:')) {
      const launch: SpawnMode = String(desired.launch ?? 'orbital') === 'surface' ? 'surface' : 'orbital';
      const seeds: DroneSeed[] = steps
        .filter((s) => s.id.startsWith('slot-'))
        .map((s, i): DroneSeed | null => {
          const p = s.params ?? {};
          const pos = vec(p.position);
          if (!pos) return null;
          const useGridId = typeof p.useGridId === 'string' && p.useGridId ? p.useGridId : null;
          if (useGridId) {
            return {
              idx: i,
              label: String(p.gridName ?? useGridId),
              prefab: `existing:${useGridId}`,
              role: 'existing',
              planet: desired.planet ? String(desired.planet) : null,
              planSlot: pos,
              spawnMode: 'orbital',
              hullReason: 'owner-tagged grid launches in place: no spawn, no ownership transfer',
              existingGridId: useGridId,
            };
          }
          const hullId = String(p.hullId ?? '');
          const prefab = hullId.startsWith('tagged:') ? hullId : String(p.prefab ?? hullId);
          return {
            idx: i,
            label: `slot-${i + 1}`,
            prefab,
            role: 'slot',
            planet: desired.planet ? String(desired.planet) : null,
            planSlot: pos,
            spawnMode: launch,
            hullReason:
              launch === 'orbital'
                ? 'designer orbital launch: spawn in orbit at the slot, then hold'
                : 'designer surface launch: spawn near the control source and fly to the slot',
          };
        })
        .filter((s): s is DroneSeed => Boolean(s));
      return { seeds, error: null };
    }

    if (station.startsWith('chain:')) {
      const parts = station.split(':');
      const planetName = parts[1] ?? null;
      const seeds: DroneSeed[] = steps
        .filter((s) => s.id.startsWith('deploy-'))
        .map((s, i) => {
          const p = s.params ?? {};
          const pos = vec(p.position);
          if (!pos) return null;
          // The first/last plan nodes are virtual anchor stations (they model
          // an existing control source), not drones to spawn. Only relays fly.
          if (String(p.role ?? '') === 'station') return null;
          const planned = String(p.prefab ?? 'Eradicator_mk.1');
          const choice = selectHull(planned, (planetName ? planetByName(planetName) : null) ?? null, {
            gravityHull: this.deps.config.demo.gravityHull,
            orbitAglM: this.deps.config.demo.orbitAglM,
          });
          return {
            idx: i,
            label: `relay-${i + 1}`,
            prefab: choice.prefab,
            role: p.role ? String(p.role) : null,
            planet: planetName,
            planSlot: pos,
            spawnMode: choice.spawnMode,
            hullReason: choice.reason,
          } satisfies DroneSeed;
        })
        .filter((s): s is DroneSeed => Boolean(s));
      return { seeds, error: null };
    }

    if (station.startsWith('move:') || station.startsWith('survival:')) {
      // One existing grid, one target. `survival:return:<grid>` and
      // `survival:relaunch:<grid>` are move missions in every way that matters
      // (assignedUnits[0] = the grid, the `move` step carries the target), so
      // they fly the same guarded path as move-to: `land: true` on a return
      // gives the lateral leg -> settle -> land_at sequence, and a relaunch
      // (no `land`) climbs to its slot and leaves station rules to `stationPass`.
      const gridId = mission.assignedUnits[0];
      const moveStep = steps.find((s) => s.kind === 'move' && s.params?.target);
      const target = vec(moveStep?.params?.target);
      if (!gridId || !target) {
        return {
          seeds: [],
          error: `mission source not executable: ${
            station.startsWith('survival:') ? 'survival' : 'move'
          } mission ${mission.id} has no ${gridId ? '' : 'assigned grid and no '}move step with a target`,
        };
      }
      // The route puts the planet under the target into `desiredState.planet`;
      // a mission created without it still knows the planet from the target
      // position. This used to be hard-coded `null`, so every ground read for a
      // move-to mission fell back to a 0 m catalogue mean radius and every AGL
      // was measured from the origin instead of the planet centre.
      const planetName = (desired.planet ? String(desired.planet) : null) ?? nearestPlanet(target)?.name ?? null;
      return {
        seeds: [
          {
            idx: 0,
            label: gridId,
            prefab: 'existing',
            role: 'existing',
            planet: planetName,
            planSlot: target,
            spawnMode: 'surface',
            hullReason: 'existing grid: no spawn, no hull selection',
          },
        ],
        error: null,
      };
    }

    // Spawn mission: one prefab at the print position.
    const print = steps.find((s) => s.kind === 'print');
    const pos = vec(print?.params?.position);
    const planned = String(print?.params?.prefab ?? '');
    if (!pos || !planned) {
      // No builder matched and there is no print step to fall back on. Say it
      // out loud: an approved mission the executor silently skips sits at
      // `approved` for ever and the operator sees nothing (verify #3: an
      // approved survival return with no execution row and no order for 3 min
      // 25 s).
      return {
        seeds: [],
        error: `mission source not executable: station "${station || '(none)'}" is not designer:/chain:/move:/survival: and the plan has no print step`,
      };
    }
    const planet = nearestPlanet(pos);
    const choice = selectHull(planned, planet, {
      gravityHull: this.deps.config.demo.gravityHull,
      orbitAglM: this.deps.config.demo.orbitAglM,
    });
    return {
      seeds: [
        {
          idx: 0,
          label: choice.prefab,
          prefab: choice.prefab,
          role: getStandIn(choice.prefab)?.role ?? getHull(choice.prefab)?.hullClass ?? null,
          planet: planet?.name ?? null,
          planSlot: pos,
          spawnMode: choice.spawnMode,
          hullReason: choice.reason,
        },
      ],
      error: null,
    };
  }

  /** Spawn altitude above the source planet surface (2-12 km per the spec). */
  private spawnFor(mission: Mission, seed: DroneSeed, idx: number): Vec3 {
    const station = String((mission.desiredState as { station?: string }).station ?? '');
    if (station.startsWith('designer:') && seed.spawnMode === 'orbital') {
      // Orbital launch: the grid appears in space at its slot; hold is local.
      return seed.planSlot;
    }
    const planetName = station.startsWith('chain:') ? station.split(':')[1] : seed.planet;
    const planet = (planetName ? planetByName(planetName) : null) ?? nearestPlanet(seed.planSlot);
    if (!planet) return seed.planSlot;
    const surface = Number(planet.surfaceRadiusM ?? 0) || Number(planet.maxHillRadiusM ?? 0) || 59_400;
    const center = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    // Spawn above the planet's control source when one exists: the gate needs
    // a planner path, and the source is what makes the first leg reachable.
    const sources = aliveNodes(this.world()).filter(
      (n) => n.controlSource && (!n.planet || n.planet === planet.name),
    );
    const anchor = sources.length
      ? sources.reduce((best, n) => (dist(n.position, center) < dist(best.position, center) ? n : best))
      : null;
    const dir = norm(sub(anchor ? anchor.position : seed.planSlot, center));
    const up = dir;
    const tangent = norm(cross(up, { x: 0, y: 1, z: 0.31 }));
    const hull = getHull(seed.prefab);
    const d = this.deps.config.demo;
    const altitude =
      seed.spawnMode === 'orbital'
        ? surface + d.orbitAglM
        : hull && hull.hullClass !== 'ion'
          ? d.gravitySpawnAglM
          : d.spawnAglM;
    const base = add(center, up, altitude);
    // Spread spawn points along the tangent so six grids never overlap.
    return add(base, tangent, idx * 220);
  }

  /** Compressed slot for the live demo: legM per hop, along the planned direction. */
  private execSlotFor(seed: DroneSeed, seeds: DroneSeed[], mission: Mission, idx: number): Vec3 {
    const station = String((mission.desiredState as { station?: string }).station ?? '');
    if (station.startsWith('designer:')) return seed.planSlot;
    if (!station.startsWith('chain:')) return seed.planSlot;
    const spawn = this.spawnFor(mission, seed, idx);
    const leg = this.deps.config.demo.legM;
    let d = sub(seed.planSlot, spawn);
    if (seed.spawnMode === 'orbital') {
      // An orbital spawn must not dive back into the atmosphere: keep the
      // altitude constant and fly the horizontal component of the planned leg.
      const planet = (seed.planet ? planetByName(seed.planet) : null) ?? nearestPlanet(spawn);
      const center = planet ? vec(planet.center) ?? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 };
      const up = norm(sub(spawn, center));
      const radial = d.x * up.x + d.y * up.y + d.z * up.z;
      d = sub(d, { x: up.x * radial, y: up.y * radial, z: up.z * radial });
      if (len(d) < 1) d = cross(up, { x: 0, y: 1, z: 0.31 });
    }
    const distance = len(d);
    if (distance < 1) return add(spawn, norm(sub(seeds[0]!.planSlot, spawn)), leg * (idx + 1));
    return add(spawn, norm(d), Math.min(distance, leg * (idx + 1)));
  }

  /**
   * Landing mode: does this mission ask this drone to land? A designer mission
   * says it once for the whole plan (`desiredState.land`); a move-to mission
   * says it per drone with `desiredState.landing`. Nothing else reads it, so an
   * ordinary mission can never turn into a landing by accident.
   */
  private landingIntentFor(mission: Mission, seed: DroneSeed, idx: number): LandingIntent | null {
    const desired = (mission.desiredState ?? {}) as Record<string, unknown>;
    const shared = readLandingIntent(desired);
    const perDrone = Array.isArray(desired.landingTargets) ? desired.landingTargets[idx] : null;
    if (shared) {
      if (perDrone && typeof perDrone === 'object' && (perDrone as { land?: unknown }).land === false) return null;
      return shared;
    }
    // A survival return/relaunch carries `land: true` for a return and no landing
    // intent for a relaunch. When the relaunch target is the ship's own resting
    // point (a slot recorded while it sat on the ground), a hold there is not
    // merely refused — it is the wrong mission: `land_at` is what flies a ground
    // point. Air slots keep the hold/station path untouched.
    return this.groundOriginIntent(mission, seed, idx);
  }

  /**
   * A relaunch whose remembered slot is ON THE GROUND is flown as a landing.
   *
   * Verify #4: R-0001's slot was its ground resting point. The executor planned
   * an airborne hold at it, the ground-hold guard measured 1 m of clearance and
   * aborted the flight before it lifted, so the loop never got past
   * READY_TO_RELAUNCH. The decision is only taken on a MEASURED, landing-grade
   * column (`terrain` at level >= 3): with the catalogue mean only there is no
   * ground to land on and the previous behaviour is kept.
   */
  private groundOriginIntent(mission: Mission, seed: DroneSeed, idx: number): LandingIntent | null {
    const desired = (mission.desiredState ?? {}) as Record<string, unknown>;
    const station = String(desired.station ?? '');
    if (!station.startsWith('survival:relaunch:')) return null;
    const planet = (seed.planet ? planetByName(seed.planet) : null) ?? nearestPlanet(seed.planSlot);
    const centre = planet ? vec(planet.center) : null;
    const radiusM = centre ? len(sub(seed.planSlot, centre)) : null;
    const ground = planet ? this.terrainRadiusAt(planet, seed.planSlot) : null;
    if (radiusM === null || !ground || !ground.source.startsWith('terrain')) return null;
    if (ground.level !== null && ground.level < FINE_TERRAIN_MIN_LEVEL) return null;
    const aglM = radiusM - ground.radiusM;
    if (!(aglM <= GROUND_ORIGIN_AGL_M)) return null;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_relaunch_ground',
      subject: `${mission.id}:${idx}`,
      detail: {
        gridId: seed.existingGridId ?? null,
        decision: 'land',
        targetAglM: Math.round(aglM),
        groundSource: ground.source,
        groundRadiusM: Math.round(ground.radiusM),
        note: `the relaunch slot is on the ground (${Math.round(aglM)} m above the measured terrain), so it is flown as a landing: lateral -> settle -> land_at`,
      },
      at: this.deps.clock?.() ?? Date.now(),
    });
    // Same shape a `land: true` mission gets, so the landing profile is built
    // exactly as it is for a return.
    return readLandingIntent({ land: true });
  }

  /**
   * The slot a landing flies to: the GROUND POINT under the planned slot, i.e.
   * the point pushed from the planet centre out to the terrain radius on that
   * bearing. AGL of that point is negative by construction; the landing phases
   * own the approach once the ground is known.
   */
  private landingSlotFor(seed: DroneSeed, idx: number): Vec3 {
    void idx;
    const planet = (seed.planet ? planetByName(seed.planet) : null) ?? nearestPlanet(seed.planSlot);
    if (!planet) return seed.planSlot;
    const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    const up = norm(sub(seed.planSlot, centre));
    const groundRadius =
      this.terrainRadiusAt(planet, seed.planSlot)?.radiusM ?? (Number(planet.surfaceRadiusM ?? 0) || 0);
    return add(centre, { x: up.x * groundRadius, y: up.y * groundRadius, z: up.z * groundRadius });
  }

  /**
   * `park` (owner request, 2026-11-10: "go to XYZ and park"): stop at the
   * requested point. Parking ON the ground is a landing, so this returns a
   * `land` intent and the four landing phases run. Parking in the air is not:
   * the ship holds at the point (it never dives at ground it does not have to
   * touch), and the audit says which of the two happened and why — a bare
   * parking request must never turn into a surprise landing, and an airborne
   * GPS point has nothing to land on.
   */
  private resolvePark(mission: Mission, seed: DroneSeed, idx: number, intent: LandingIntent): LandingIntent | null {
    const planet = (seed.planet ? planetByName(seed.planet) : null) ?? nearestPlanet(seed.planSlot);
    const centre = planet ? vec(planet.center) : null;
    const radiusM = centre ? len(sub(seed.planSlot, centre)) : null;
    // `null` means the ground is only the catalogue mean here (no terrain
    // field, no probe): treat that as NO measured ground below the point.
    const groundRadiusM = planet && centre ? (this.terrainRadiusAt(planet, seed.planSlot)?.radiusM ?? null) : null;
    const aglM = radiusM !== null && groundRadiusM !== null ? radiusM - groundRadiusM : null;
    const subject = `${mission.id}:${idx}`;
    if (aglM !== null && aglM <= LANDING_TOUCHDOWN_AGL_M + 1) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_park',
        subject,
        detail: {
          gridId: seed.existingGridId ?? null,
          decision: 'land',
          altitudeAglM: Math.round(aglM),
          groundSource: 'terrain',
          reason: `park: the requested point is on the ground (${Math.round(aglM)} m above it), so parking means landing`,
        },
        at: this.deps.clock?.() ?? Date.now(),
      });
      return { kind: 'land', flareAglM: intent.flareAglM };
    }
    const reason =
      aglM === null
        ? 'park: the requested point is airborne and no ground is measured below it, so there is nothing to land on — ' +
          `held in the air at the point instead of landing; it cannot be stationed either (station mode needs a readable ` +
          `altitude above ${GROUND_CLEARANCE_M} m AGL), so it holds`
        : `park: the requested point is ${Math.round(aglM)} m above the ground — held in the air at the point instead of landing` +
          (aglM >= GROUND_CLEARANCE_M
            ? '; station mode may station it once it is stable there'
            : `; too low to station (station mode never converts below ${GROUND_CLEARANCE_M} m AGL), so it holds`);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_park',
      subject,
      detail: {
        gridId: seed.existingGridId ?? null,
        decision: 'hold',
        altitudeAglM: aglM === null ? null : Math.round(aglM),
        groundSource: aglM === null ? 'mean' : 'terrain',
        reason,
      },
      at: this.deps.clock?.() ?? Date.now(),
    });
    return null;
  }

  // --------------------------------------------------------------- advance

  private advance(exec: ExecRow, drone: DroneRow, now: number): void {
    if (drone.pendingOrder) {
      this.resolvePending(exec, drone, now);
      if (drone.pendingOrder) return;
      if (TERMINAL.includes(drone.state)) return;
    }

    switch (drone.state) {
      case 'queued':
        this.ensureIdentity(now);
        if (drone.prefab.startsWith('existing:')) {
          // T10: launch an owner-tagged grid in place. No spawn, no clone, no
          // ownership transfer and no demo_spawned row (debris cleanup must
          // never delete the owner's satellite). Start at the release chain;
          // it lands on move and then hold.
          drone.gridId = drone.prefab.slice('existing:'.length);
          this.store()
            .db.prepare(`UPDATE demo_drones SET grid_id = ? WHERE mission_id = ? AND idx = ?`)
            .run(drone.gridId, exec.missionId, drone.idx);
          supersedeGridMissions(this.store(), drone.gridId, exec.missionId, 'demo-executor', now,
            `superseded by newer mission ${exec.missionId}`);
          drone.step = RELEASE_STEP_GEARS;
          this.setState(drone, 'securing', now, 'owner-tagged grid: launch in place (release -> move -> hold)');
          return;
        }
        if (drone.prefab === 'existing') {
          // `move:` missions act on a grid that already exists. Spawning a
          // new prefab here created a stray grid and left the real drone
          // untouched ("the ship is disabled").
          drone.gridId = drone.label;
          this.store()
            .db.prepare(`UPDATE demo_drones SET grid_id = ? WHERE mission_id = ? AND idx = ?`)
            .run(drone.gridId, exec.missionId, drone.idx);
          supersedeGridMissions(this.store(), drone.gridId, exec.missionId, 'demo-executor', now,
            `superseded by newer mission ${exec.missionId}`);
          this.setState(drone, 'securing', now, 'existing grid: no spawn');
          return;
        }
        if (this.survivalMode) {
          // T74: the harness spawn/clone path does not exist on a hosted server.
          // A demo mission that needs a grid must be given an existing one.
          this.fail(drone, now,
            `not available in survival build: cannot spawn ${drone.prefab} (use an existing owned grid, e.g. prefab "existing")`);
          this.store().audit({
            actor: 'demo-executor',
            action: 'survival_refused',
            subject: `${exec.missionId}:${drone.idx}`,
            detail: { reason: SURVIVAL_REASON, attempted: drone.prefab.startsWith('tagged:') ? 'clone_grid' : 'spawn_prefab' },
            at: now,
          });
          return;
        }
        if (drone.prefab.startsWith('tagged:')) {
          // Owner-tagged hull: copy the source grid instead of spawning a
          // prefab, then hand ownership to the owner identity.
          this.send(exec, drone, now, 'test', 'grid:0', 'clone_grid', {
            sourceGridId: drone.prefab.slice('tagged:'.length),
            x: drone.spawn.x,
            y: drone.spawn.y,
            z: drone.spawn.z,
            up: norm(sub(drone.spawn, this.planetCenterFor(drone, exec))),
            forward: norm(cross(norm(sub(drone.spawn, this.planetCenterFor(drone, exec))), { x: 0, y: 1, z: 0.31 })),
            name: `demo-${short(exec.missionId)}-${drone.idx + 1}`,
            ...(this.identityId ? { ownerId: this.identityId } : {}),
          });
        } else {
          this.send(exec, drone, now, 'test', 'grid:0', 'spawn_prefab', {
            prefab: drone.prefab,
            x: drone.spawn.x,
            y: drone.spawn.y,
            z: drone.spawn.z,
            up: norm(sub(drone.spawn, this.planetCenterFor(drone, exec))),
            forward: norm(cross(norm(sub(drone.spawn, this.planetCenterFor(drone, exec))), { x: 0, y: 1, z: 0.31 })),
            name: `demo-${short(exec.missionId)}-${drone.idx + 1}`,
            ...(this.identityId ? { ownerId: this.identityId } : {}),
          });
        }
        this.setState(drone, 'spawning', now, 'spawn order sent');
        return;

      case 'spawning': {
        // SpawnPrefab fills its result list asynchronously: diff list_grids.
        const name = `demo-${short(exec.missionId)}-${drone.idx + 1}`;
        this.send(exec, drone, now, 'test', 'grid:0', 'list_grids', { expectName: name });
        return;
      }

      case 'securing': {
        if (!drone.gridId) return this.fail(drone, now, 'no grid id after spawn');
        if (!this.identityId) {
          // Identity runs as an order; retry next tick once it lands.
          this.send(exec, drone, now, 'test', 'grid:0', 'identity', {});
          return;
        }
        const step = drone.step ?? 'ownership_check';
        if (step === 'ownership_check') {
          // READ-ONLY first (2026-11-11, set 3): the takeover used to be sent
          // unconditionally on every mission start, so a grid the owner already
          // held got an admin `ownership` write anyway (twice per mission, on
          // the `test` channel, 12/24 blocks). Ask who owns it; only an
          // unowned/foreign grid needs the takeover, and in survival that is
          // refused with a plain reason instead of a mystery failure.
          this.send(exec, drone, now, 'test', drone.gridId, 'ownership_check', { ownerId: this.identityId });
        } else if (step === 'ownership') {
          this.send(exec, drone, now, 'test', drone.gridId, 'ownership', { ownerId: this.identityId });
        } else if (step === 'wake') {
          this.send(exec, drone, now, 'test', drone.gridId, 'wake', {});
        } else if (step === STAGING_STEP_HANDOFF) {
          // `wake` enables every thruster; staging owns the hydrogen bank from
          // here on (it knows altitude, bank split and tank state).
          this.sendReleaseBlock(exec, drone, now, hydrogenStagingHandoffOrder());
        } else if (step === 'ai_off') {
          this.send(exec, drone, now, 'test', drone.gridId, 'ai_off', {});
        } else if (step === RELEASE_STEP_GEARS) {
          this.sendReleaseBlock(exec, drone, now, landingGearReleaseOrder());
        } else if (step === RELEASE_STEP_CONNECTORS) {
          this.sendReleaseBlock(exec, drone, now, connectorReleaseOrder());
        } else if (step === RELEASE_STEP_PROFILE || step === RELEASE_STEP_VERIFY) {
          // diag is the profile read that includes the physics body state.
          this.send(exec, drone, now, 'test', drone.gridId, 'diag', {});
        } else if (step === RELEASE_STEP_CONVERT) {
          this.send(exec, drone, now, 'test', drone.gridId, 'convert_to_ship', { gridId: drone.gridId });
        } else if (step === 'move') {
          this.sendMove(exec, drone, now);
        }
        return;
      }

      case 'en_route': {
        const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
        if (!unit?.pos) return;
        const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit.pos);
        const surface = Number(planet?.surfaceRadiusM ?? 0) || 0;
        const gs = this.guardState(drone);
        // Ground frame: AGL = |position - planetCentre| - groundRadius, where
        // groundRadius is the terrain height field at this column, else a
        // probe hit, else the catalogue mean (the mean is 1 616.7 m below the
        // real ground at the test column). `probe_ground` is opportunistic only
        // (FAILURE 1: it cannot hit procedural planet terrain on this build).
        this.refreshGround(drone, unit.pos, planet, now);
        this.pollGroundProbes(now);
        const frame = this.groundFrame(drone, unit.pos, planet);
        if (!frame) return;
        const groundRadius = frame.groundRadiusM;
        const radius = frame.radiusM;
        const up = frame.up;
        const vel = unit.vel ?? { x: 0, y: 0, z: 0 };
        const speed = len(vel);
        const verticalSpeed = dot(vel, up);
        const altitudeAgl = frame.altitudeAglM;
        const targetAgl = frame.targetAglM;
        const remaining = dist(unit.pos, drone.execSlot);
        const mass = Number((unit.meta as { massKg?: number }).massKg ?? 0) || 1;
        // Telemetry cadence, measured from the sample timestamps rather than
        // assumed: the live landing brake has to cover the fall that happens
        // before the next sample (2 s = 208 m at 104 m/s in the measured run).
        if (gs.lastTelemetryAt === null || unit.lastSeen !== gs.lastTelemetryAt) {
          if (gs.lastTelemetryAt !== null) {
            const gapS = (unit.lastSeen - gs.lastTelemetryAt) / 1000;
            if (gapS > 0.1) gs.telemetryPeriodS = Math.min(5, Math.max(0.25, gapS));
          }
          gs.lastTelemetryAt = unit.lastSeen;
        }
        // Near-vertical climb (measured 2026-11-10): the leg is flown as a
        // ladder of waypoints no steeper than 60 deg above the horizon,
        // because the SE autopilot crawls on a waypoint close to the local up
        // vector (37.6 m/s peak then decay on a 1 672 m climb, 1.2 m/s on a
        // descent order, against 99.9 m/s on a diagonal and 20 m/s on a
        // horizontal leg of the same hull). Each ladder waypoint that is
        // reached sends the next one; the last waypoint is the leg's own slot,
        // after which the normal guard owns the ship.
        if (gs.climb && !drone.landing && drone.gridId) {
          const waypoint = gs.climb.ladder.waypoints[gs.climb.index];
          const stepRemainingM = waypoint ? dist(unit.pos, waypoint) : 0;
          if (waypoint && stepRemainingM <= CLIMB_WP_ARRIVE_M) {
            const stepGate = this.gateFor(drone, now);
            if (!stepGate.allowed) return;
            const speed = Math.max(1, Math.round((gs.legProfile?.vCruiseMps ?? gs.speedLimit) * 10) / 10);
            const nextIndex = gs.climb.index + 1;
            const next = gs.climb.ladder.waypoints[nextIndex];
            const leg = gs.climb.ladder.legs[nextIndex];
            if (!next || !leg) {
              // The ladder's last waypoint IS the slot: the normal en-route
              // guard and arrival logic take over from here.
              gs.climb = null;
            } else {
              this.send(
                exec,
                drone,
                now,
                'move',
                drone.gridId,
                'move',
                this.buildMove(drone, now, unit.pos, next, up, speed, { tag: 'climb-step' }),
                stepGate,
              );
              this.enforceCollisionAvoidance(exec, drone, now, speed);
              this.store().audit({
                actor: 'demo-executor',
                action: 'demo_leg_climb_step',
                subject: `${drone.missionId}:${drone.idx}`,
                detail: {
                  gridId: drone.gridId,
                  step: nextIndex + 1,
                  of: gs.climb.ladder.waypoints.length,
                  elevationDeg: leg.elevationDeg,
                  riseM: leg.riseM,
                  lateralM: leg.lateralM,
                  maxElevationDeg: gs.climb.ladder.maxElevationDeg,
                  stepRemainingM: Math.round(stepRemainingM),
                  speedMps: speed,
                  target: next,
                  note:
                    `climb ladder step ${nextIndex + 1}/${gs.climb.ladder.waypoints.length} at ` +
                    `${leg.elevationDeg} deg above the horizon (ceiling ${gs.climb.ladder.maxElevationDeg} deg); ` +
                    'the autopilot crawls on a waypoint near the local up vector',
                },
                at: now,
              });
              gs.climb = { ladder: gs.climb.ladder, index: nextIndex };
              gs.speedLimit = speed;
              gs.lastResendAt = now;
              this.setState(
                drone,
                'en_route',
                now,
                `climb ladder ${nextIndex + 1}/${gs.climb.ladder.waypoints.length}: ` +
                  `${leg.elevationDeg} deg, ${Math.round(leg.riseM)} m up + ${Math.round(leg.lateralM)} m across at ${speed} m/s`,
              );
              return;
            }
          }
        }
        // A cone-clamped waypoint from a throttle re-issue is an INTERMEDIATE
        // step, never the destination (2026-11-11). Once the hull is on it, send
        // the leg to the requested column itself: the clamped point sits at the
        // slot's altitude, so this is a lateral leg the autopilot flies at full
        // speed, and the descent that follows is over the right column.
        if (gs.coneStep && !gs.climb && drone.gridId) {
          const stepRemainingM = dist(unit.pos, gs.coneStep.point);
          if (stepRemainingM <= CLIMB_WP_ARRIVE_M) {
            const stepGate = this.gateFor(drone, now);
            if (!stepGate.allowed) return;
            const stepSpeed = Math.max(1, Math.round((gs.legProfile?.vCruiseMps ?? gs.speedLimit) * 10) / 10);
            const previousSteps = gs.coneStep.steps;
            const stepFrom = unit.pos;
            gs.coneStep = null;
            this.send(
              exec,
              drone,
              now,
              'move',
              drone.gridId,
              'move',
              this.buildMove(drone, now, stepFrom, drone.execSlot, up, stepSpeed, {
                tag: 'cone-step-final',
                onClamp: (info) => this.noteConeClamp(drone, now, gs, previousSteps, info, 'cone-step-final'),
              }),
              stepGate,
            );
            this.enforceCollisionAvoidance(exec, drone, now, stepSpeed);
            this.store().audit({
              actor: 'demo-executor',
              action: 'demo_leg_cone_step_done',
              subject: `${drone.missionId}:${drone.idx}`,
              detail: {
                gridId: drone.gridId,
                step: previousSteps,
                coneRemainingM: Math.round(stepRemainingM),
                target: drone.execSlot,
                speedMps: stepSpeed,
                note:
                  'the intermediate cone waypoint was reached; the leg to the REQUESTED column is flying now, ' +
                  'so the ship does not descend off-column',
              },
              at: now,
            });
            gs.speedLimit = stepSpeed;
            gs.lastResendAt = now;
            gs.needsMove = false;
            this.setState(
              drone,
              'en_route',
              now,
              `cone step ${previousSteps} reached ${Math.round(stepRemainingM)} m away: flying the requested column ` +
                `(${Math.round(dist(unit.pos, drone.execSlot))} m lateral)`,
            );
            return;
          }
        }
        const hw = this.guardHardware(drone, mass);
        const modelAltitude = Math.max(0, radius - surface);
        const thrust: ThrustSplit = hw && planet
          ? thrustAtAltitude(enduranceHullFor(hw, mass), planet, modelAltitude).forceN
          : { atmo: mass * Math.max(0, this.gravityAt(planet, modelAltitude)) * 3, ion: 0, h2: 0 };
        const gravity = this.gravityAt(planet, modelAltitude);
        const fuel = Number((unit.meta as { fuelFraction?: number }).fuelFraction ?? hw?.h2Fill ?? 0);
        const power = Number((unit.meta as { powerFraction?: number }).powerFraction ?? hw?.batteryFill ?? 0);
        // T52 controlled fall: measuring, falling and the late-brake hold own
        // the tick. Once the brake move is out, the normal guard and arrival
        // logic below fly the final approach exactly as for any other leg.
        // Landing mode owns every tick until touchdown: its phases run their
        // own dampened approach (with the floor removed), so the generic guard
        // and arrival logic never get the chance to "arrive" above the ground.
        if (gs.descent && (drone.landing !== null || gs.descent.phase !== 'braking')) {
          const consumed = this.advanceDescent(exec, drone, unit, gs, {
            now,
            up,
            altitudeAgl,
            targetAgl,
            verticalSpeed,
            remaining,
            speed,
            planet,
            mass,
            fuel,
            power,
            gravity,
            surfaceOffsetM: groundRadius - surface,
            groundRadiusM: groundRadius,
            groundSource: frame.source,
            groundLevel: frame.terrainLevel,
            groundUncertaintyM: frame.groundUncertaintyM,
            telemetryPeriodS: gs.telemetryPeriodS,
            groundHit: gs.groundHit !== null,
            landed: this.landingGearLocked(drone.gridId),
          });
          if (consumed) return;
        } else if (drone.landing && drone.state === 'en_route') {
          // Landing mode owns every tick until touchdown: with no descent state
          // yet (no flare planned) or after the flare phase, the landing
          // approach still runs, so the generic arrival logic can never accept
          // the ground point as "arrived" from 10 m up.
          const consumed = this.advanceDescent(exec, drone, unit, gs, {
            now,
            up,
            altitudeAgl,
            targetAgl,
            verticalSpeed,
            remaining,
            speed,
            planet,
            mass,
            fuel,
            power,
            gravity,
            surfaceOffsetM: groundRadius - surface,
            groundRadiusM: groundRadius,
            groundSource: frame.source,
            groundLevel: frame.terrainLevel,
            groundUncertaintyM: frame.groundUncertaintyM,
            telemetryPeriodS: gs.telemetryPeriodS,
            groundHit: gs.groundHit !== null,
            landed: this.landingGearLocked(drone.gridId),
          });
          if (consumed) return;
        }
        // The validated config cap is the ceiling for every hull. An
        // unmeasured hull (no staging profile, mass outside the known family)
        // used to be pinned to 5 m/s for the WHOLE leg — that is the arrival
        // cap leaking out to multi-km legs and it made ships crawl. The leg
        // profile below already derives the speed from the braking maths with
        // the same conservative fallback thrust the guard uses, so the ceiling
        // can stay at the configured cap.
        const limit = this.deps.config.demo.speedLimitMps;
        const verdict = flightGuardVerdict({
          // 15 m of look-ahead: telemetry arrives about once a second and the ship
          // covers ~5 m between samples, so the 1 m/s cap must engage by 25 m
          // to be true when it physically crosses 10 m.
          distanceM: Math.max(0.1, remaining - 15),
          speedMps: speed,
          massKg: mass,
          thrustN: thrust,
          h2Pct: clampPct(fuel * 100),
          gravityMps2: gravity,
          hasAtmosphere: thrust.atmo > 0,
          speedLimitMps: limit,
          plannedSpeedMps: gs.legProfile?.vCruiseMps ?? 0,
          verticalSpeedMps: verticalSpeed,
          altitudeAglM: altitudeAgl,
          targetAglM: targetAgl,
          batteryPct: clampPct(power * 100),
          landing: drone.landing !== null,
        });
        gs.lastVerdict = verdict;

        // Arrival loop guard (overnight run 2026-11-10, FAILURE 2). Two plain
        // failures were measured in the game: a hull that could not reach the
        // commanded 92.5 m/s (hover ceiling) was left circling for 300 s, and
        // the range oscillated 65 -> 295 m at ~3 m/s without ever arriving.
        // Both are reported in plain language instead of cycling.
        // The number the guards compare against is the speed this leg is
        // ACTUALLY asking for at this range (2026-11-11): the order's limit
        // tapered by the braking maths and the 5/1 m/s arrival caps, never the
        // ladder step's cruise command on a ship that has arrived.
        const commanded = arrivalCommandSpeedMps({
          legLimitMps: gs.speedLimit,
          remainingM: remaining,
          decelMps2: verdict.availableDecelMps2,
          plannedCruiseMps: gs.legProfile?.vCruiseMps ?? null,
        });
        const verticalMissM = Math.abs(altitudeAgl - targetAgl);
        const progress = arrivalProgress(gs.arrival, {
          nowMs: now,
          remainingM: remaining,
          speedMps: speed,
          commandedMps: commanded,
          verticalMissM,
          legStartedAtMs: gs.legStartedAt,
          // The range only moves when a telemetry sample lands; stamping the
          // sample with its own timestamp is what makes the crawl window
          // immune to the tick cadence.
          observedAtMs: unit.lastSeen,
        });
        gs.arrival = progress.state;
        if (progress.swing) {
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_arrival_swing',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              swing: progress.swing.swings,
              amplitudeM: Math.round(progress.swing.amplitudeM),
              closestApproachM: Math.round(progress.swing.lowM),
              remainingM: Math.round(remaining),
              speedMps: Math.round(speed * 10) / 10,
              note:
                `distance grew to ${remaining.toFixed(0)} m after closing to ${progress.swing.lowM.toFixed(0)} m ` +
                `(+${progress.swing.amplitudeM.toFixed(0)} m): the ship came in and went back out`,
            },
            at: now,
          });
        }
        if (progress.limitCycle) {
          this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-limit-cycle');
          const cycleLow = Math.round(progress.state.cycleLowM ?? remaining);
          const cycleVerdict: FlightGuardVerdict = {
            ...verdict,
            action: 'abort-hold',
            code: 'limit-cycle',
            reason:
              `arrival limit cycle: the distance to the slot grew more than ${ARRIVAL_CYCLE_AMPLITUDE_M} m past ` +
              `its closest approach ${progress.state.cycleSwings} times (it came in to ${cycleLow} m and is out at ` +
              `${remaining.toFixed(0)} m again, ${speed.toFixed(1)} m/s) — the ship is orbiting the slot instead ` +
              'of arriving; held at its current position',
            commandedSpeedMps: commanded,
            achievedSpeedMps: Math.round(speed * 10) / 10,
            closingRateMps: Math.round(progress.closingMps * 10) / 10,
          };
          this.abortFlight(exec, drone, now, cycleVerdict);
          return;
        }
        if (progress.stuck) {
          this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-stuck');
          const stuckVerdict: FlightGuardVerdict = {
            ...verdict,
            action: 'abort-hold',
            code: 'hull-speed',
            reason:
              `hull cannot achieve commanded speed: commanded ${progress.stuck.commandedMps.toFixed(1)} m/s, ` +
              `achieved ${progress.stuck.achievedMps.toFixed(1)} m/s ` +
              `(${Math.round(progress.stuck.ratio * 100)} %) for ${progress.stuck.dwellS.toFixed(0)} s while the ` +
              `distance closed at ${progress.stuck.closingMps.toFixed(1)} m/s (${remaining.toFixed(0)} m to the slot); ` +
              'held at its current position',
            commandedSpeedMps: Math.round(progress.stuck.commandedMps * 10) / 10,
            achievedSpeedMps: Math.round(progress.stuck.achievedMps * 10) / 10,
            shortfallSeconds: Math.round(progress.stuck.dwellS),
            closingRateMps: Math.round(progress.closingMps * 10) / 10,
          };
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_arrival_stuck',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              commandedSpeedMps: stuckVerdict.commandedSpeedMps,
              achievedSpeedMps: stuckVerdict.achievedSpeedMps,
              ratio: Math.round(progress.stuck.ratio * 100) / 100,
              shortfallSeconds: stuckVerdict.shortfallSeconds,
              closingRateMps: stuckVerdict.closingRateMps,
              remainingM: Math.round(remaining),
              altitudeAglM: Math.round(altitudeAgl),
            },
            at: now,
          });
          this.abortFlight(exec, drone, now, stuckVerdict);
          return;
        }
        // Slow-crawl guard (measured 2026-11-10): a 2 km ascent commanded at
        // 100 m/s held 1.2-1.7 m/s for the whole leg and died on the 300 s
        // arrival timeout, because the shortfall detector above needed the
        // closing rate under 1 m/s and this hull closed at ~1.5 m/s. A leg
        // crawling at under ARRIVAL_CRAWL_CLOSING_MPS with more than
        // ARRIVAL_CRAWL_MIN_RANGE_M to go is aborted with both numbers.
        if (progress.crawl) {
          this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-crawl');
          const crawlVerdict: FlightGuardVerdict = {
            ...verdict,
            action: 'abort-hold',
            code: 'hull-crawl',
            reason:
              `hull is crawling: commanded ${progress.crawl.commandedMps.toFixed(1)} m/s, achieved ` +
              `${progress.crawl.achievedMps.toFixed(1)} m/s, closing on the slot at ` +
              `${progress.crawl.closingMps.toFixed(1)} m/s for ${progress.crawl.dwellS.toFixed(0)} s with ` +
              `${progress.crawl.remainingM.toFixed(0)} m still to go (${Math.round(altitudeAgl)} m AGL); ` +
              'held at its current position',
            commandedSpeedMps: Math.round(progress.crawl.commandedMps * 10) / 10,
            achievedSpeedMps: Math.round(progress.crawl.achievedMps * 10) / 10,
            shortfallSeconds: Math.round(progress.crawl.dwellS),
            closingRateMps: Math.round(progress.crawl.closingMps * 10) / 10,
          };
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_arrival_crawl',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              commandedSpeedMps: crawlVerdict.commandedSpeedMps,
              achievedSpeedMps: crawlVerdict.achievedSpeedMps,
              closingRateMps: crawlVerdict.closingRateMps,
              crawlSeconds: crawlVerdict.shortfallSeconds,
              remainingM: Math.round(progress.crawl.remainingM),
              altitudeAglM: Math.round(altitudeAgl),
              reason: 'the leg closed on its slot far too slowly for the speed it was commanded',
            },
            at: now,
          });
          this.abortFlight(exec, drone, now, crawlVerdict);
          return;
        }
        // Overshoot guard: if the ship is moving away from its slot for four
        // consecutive ticks it has missed the waypoint (autopilot overshoot,
        // or collision avoidance steering it around an obstacle). Stop it.
        // Once a swing has been counted the limit-cycle detector owns the leg:
        // reporting the oscillation beats reporting its first symptom.
        if (gs.lastRemaining !== null && remaining > gs.lastRemaining + 2) gs.awayTicks += 1;
        else gs.awayTicks = 0;
        gs.lastRemaining = remaining;
        if (gs.awayTicks >= 4 && remaining > 15 && gs.arrival.cycleSwings === 0) {
          this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-overshoot');
          const overshootVerdict: FlightGuardVerdict = {
            ...verdict,
            action: 'abort-hold',
            code: 'overshoot',
            reason:
              `overshoot guard: distance grew to ${remaining.toFixed(0)} m from the slot ` +
              `(was ${(gs.lastRemaining ?? remaining).toFixed(0)} m); ship held at ${speed.toFixed(1)} m/s`,
          };
          this.abortFlight(exec, drone, now, overshootVerdict);
          return;
        }

        // Terminal phase: inside 30 m collision avoidance is turned off. SE's
        // avoidance treats the base/terrain as an obstacle and climbed a
        // satellite 600 m past a 100 m waypoint (T13 hop, 2026-11-09); the
        // 1 m/s cap and the ground floor take over there.
        if (remaining <= 30 && !gs.terminal) {
          gs.terminal = true;
          this.setCollisionAvoidance(exec, drone, now, false, 'terminal approach');
        }
        // Contract §3: dampeners come back on for the final 100 m so the
        // autopilot can trim and hold instead of coasting past the slot.
        if (gs.legProfile?.dampeners === 'off' && gs.dampenersOnAt === null && remaining <= DAMPENER_FINAL_M) {
          this.setDampeners(exec, drone, now, true, 'final 100 m');
          gs.dampenersOnAt = now;
        }

        if (verdict.action === 'abort-hold' || verdict.action === 'abort-stop') {
          if (verdict.action === 'abort-hold') {
            this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-hold');
          } else {
            this.sendRaw(exec, drone, now, 'stop', {}, 'guard-stop');
          }
          this.abortFlight(exec, drone, now, verdict);
          return;
        }

        if (verdict.action === 'brake' && verdict.code === 'ground-descent') {
          // Stop descending now; resume the waypoint once the closing rate is
          // safe again (next ticks re-evaluate, needsMove re-issues the move).
          if (now - gs.lastBrakeAt > 1_500) {
            this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-brake');
            gs.lastBrakeAt = now;
            gs.needsMove = true;
            gs.speedLimit = 1;
            this.store().audit({
              actor: 'demo-executor',
              action: 'demo_guard_brake',
              subject: `${drone.missionId}:${drone.idx}`,
              detail: { gridId: drone.gridId, ...verdict },
              at: now,
            });
          }
          return;
        }

        // Final settle of a near-vertical leg (2026-11-11, the climb abort):
        // the altitude is made (|vertical miss| <= ARRIVAL_SETTLE_VERTICAL_M)
        // and only ARRIVAL_SETTLE_RANGE_M of lateral trim is left, so the
        // speed guards are silent (see arrivalProgress). The autopilot stopped
        // at the waypoint it was given - 143 m short of the column - and the
        // re-send policy below stays silent because the required speed did not
        // change. Re-issue the leg to the SLOT itself so the climb finishes.
        if (progress.settle && !drone.landing && !gs.descent) {
          if (now - gs.lastResendAt > 5_000 && !drone.pendingOrder) {
            this.sendMoveAt(exec, drone, now, Math.max(1, commanded), verdict);
            gs.lastResendAt = now;
            gs.speedLimit = Math.max(1, commanded);
            this.store().audit({
              actor: 'demo-executor',
              action: 'demo_arrival_settle_reissue',
              subject: `${drone.missionId}:${drone.idx}`,
              detail: {
                gridId: drone.gridId,
                remainingM: Math.round(remaining),
                verticalMissM: Math.round(verticalMissM * 10) / 10,
                speedMps: Math.round(speed * 10) / 10,
                commandedSpeedMps: Math.round(commanded * 10) / 10,
                altitudeAglM: Math.round(altitudeAgl * 10) / 10,
                targetAglM: Math.round(targetAgl * 10) / 10,
                note:
                  'the altitude is made and only the lateral trim is left: the leg to the slot itself was ' +
                  're-issued instead of the hull being judged on its settle speed',
              },
              at: now,
            });
          }
          return;
        }
        // Arrival: 10 m normally, 3 m for a landing waypoint inside the floor.
        // A ship that is physically on the slot is accepted even if a sample
        // still shows 2 m/s (autopilot trim), then held at 1 m/s.
        //
        // Vertical arrival (2026-11-10): a descent that settled 19 m above its
        // slot hovered forever, because the radius was 10 m and the terminal
        // hold will not fly faster than 1 m/s. A ship within
        // ARRIVAL_VERTICAL_RADIUS_M VERTICALLY of its slot and below
        // ARRIVAL_VERTICAL_SETTLED_MPS is on it, whatever the horizontal offset
        // (a descent slot is the ground point, so `remaining` is its altitude).
        const arrivalRadius = targetAgl <= 25 ? 3 : 10;
        const onSlot = remaining <= 3 && speed <= 2.5;
        const settled = remaining <= arrivalRadius && speed <= Math.max(1.5, verdict.targetSpeedMps * 1.1);
        const verticalArrival =
          Math.abs(verticalSpeed) < ARRIVAL_VERTICAL_SETTLED_MPS &&
          Math.abs(remaining) <= ARRIVAL_VERTICAL_RADIUS_M;
        if (onSlot || settled || verticalArrival) {
          const gate = this.gateFor(drone, now);
          if (!gate.allowed) {
            if (this.waitForLink(drone, now, gate)) return;
            this.fail(drone, now, `hold denied by comms gate: ${gate.reason}`);
            return;
          }
          drone.gateWaits = 0;
          if (this.flightPaused(drone, now)) return;
          const holdSpeed = targetAgl <= 25 ? 1 : Math.min(5, verdict.targetSpeedMps);
          const comeToMe = this.comeToMeOf(exec.missionId);
          if (comeToMe) {
            this.comeToMeArrival(exec, drone, now, { remaining, speed, holdSpeed, gate });
            return;
          }
          this.recordLegResult(drone, now, remaining, speed, 'arrived');
          this.send(exec, drone, now, 'hold', drone.gridId!, 'hold', { ...drone.execSlot, speed: holdSpeed }, gate);
          // Hold turns collision avoidance back on; at the slot the precision
          // guard owns the ship, so turn it off again once inside 30 m.
          if (remaining <= 30) this.setCollisionAvoidance(exec, drone, now, false, 'holding at slot');
          this.setState(
            drone,
            'holding',
            now,
            `arrived ${remaining.toFixed(1)} m from slot at ${speed.toFixed(1)} m/s; hold sent`,
          );
          drone.holdAt = now;
          return;
        }

        // Contract §3: ONE move per leg. A new order is only sent when the
        // required speed moved more than 20 % (the guard is throttling the
        // approach down) or a guard event asked for it (brake / stall).
        const required = capPassengerSpeed(
          Math.min(verdict.targetSpeedMps, gs.legProfile?.vCruiseMps ?? limit),
          this.passengerLimitsFor(drone, drone.gridId ? this.store().getUnit(drone.gridId) : null),
        );
        const stalled = speed < 0.3 && remaining > 5;
        const guardTripped = gs.needsMove || stalled;
        const want = gs.needsMove ? verdict.targetSpeedMps : required;
        if (shouldResendMove(gs.speedLimit, want, guardTripped) && now - gs.lastResendAt > (stalled ? 4_000 : 1_000)) {
          this.sendMoveAt(exec, drone, now, Math.max(1, Math.round(want * 10) / 10), verdict);
          gs.lastResendAt = now;
          gs.speedLimit = Math.max(1, Math.round(want * 10) / 10);
          gs.needsMove = false;
        }
        // The arrival watchdog is scaled by the profile ETA: a 500 km coast
        // leg is not a stalled approach, and the old flat 240 s failed it.
        const arrivalBudget = Math.max(
          ARRIVAL_TIMEOUT_MS,
          (gs.predictedEtaS ?? 0) * 2_000 + 60_000,
        );
        if (now - (drone.pendingAt ?? now) > arrivalBudget) {
          this.fail(
            drone,
            now,
            `arrival timeout: ${remaining.toFixed(0)} m from slot; last guard ${verdict.code} ` +
              `(${speed.toFixed(1)} m/s, ${altitudeAgl.toFixed(0)} m AGL)`,
          );
        }
        return;
      }

      case 'holding': {
        // Optional: re-arm the landing gear once the drone is parked on the
        // ground (owner opt-in RTS_RELEASE_RELOCK_GEAR=1; release preflight is
        // always automatic, this is not).
        if (
          process.env.RTS_RELEASE_RELOCK_GEAR === '1' &&
          drone.gridId &&
          !drone.pendingOrder &&
          drone.step !== 'relock_done' &&
          drone.step !== RELEASE_STEP_RELOCK
        ) {
          const unit = this.store().getUnit(drone.gridId);
          const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
          const alt = unit?.pos && planet ? dist(unit.pos, vec(planet.center) ?? { x: 0, y: 0, z: 0 }) - Number(planet.surfaceRadiusM ?? 0) : null;
          const g = alt === null || !planet ? null : gravityAtAltitude(planetGravity(planet), Math.max(0, alt));
          if (isGroundTarget(alt, g)) {
            this.send(exec, drone, now, 'test', drone.gridId, 'set_block_props', {
              filter: landingGearRelockOrder().filter,
              props: landingGearRelockOrder().props,
              actions: landingGearRelockOrder().actions,
            });
            drone.step = RELEASE_STEP_RELOCK;
            this.saveDrone(drone);
            return;
          }
          drone.step = 'relock_done';
          this.saveDrone(drone);
        }
        // Re-anchor the hold waypoint occasionally; drift is measured by the run.
        // A LANDED grid is never re-anchored: its slot is the ground point under
        // the hull, so a hold there would re-arm the autopilot with exactly the
        // waypoint it cannot fly (measured 2026-11-10) and push the hull into the
        // terrain. Dampeners stay on and the gear stays locked instead.
        if (drone.step !== LANDING_STEP_LOCKED && drone.holdAt && now - drone.holdAt > 60_000) {
          const gate = this.gateFor(drone, now);
          if (gate.allowed) this.send(exec, drone, now, 'hold', drone.gridId!, 'hold', { ...drone.execSlot, speed: 5 }, gate);
          drone.holdAt = now;
          this.saveDrone(drone);
        }
        return;
      }

      case 'waiting_pilot': {
        // Come to me: the ship is at the hover point beside the player. The
        // arrival hold settled the last few metres; one stop a moment later
        // clears the autopilot so it hovers on DAMPENERS ALONE (never a
        // landing, never a re-anchored waypoint). After that this state sends
        // nothing at all — the only way out is the plugin's is_under_control
        // answer (handoff) or a newer owner mission (supersede).
        const step = drone.step ?? COME_TO_ME_STEP_HOLD;
        if (step === COME_TO_ME_STEP_HOLD) {
          if (now - (drone.pendingAt ?? now) < COME_TO_ME_SETTLE_MS) return;
          const sent = this.sendRaw(exec, drone, now, 'stop', {}, 'come-to-me-autopilot-off');
          drone.step = COME_TO_ME_STEP_AUTOPILOT_OFF;
          this.saveDrone(drone);
          this.store().audit({
            actor: 'demo-executor',
            action: 'come_to_me_autopilot_off',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              sent,
              autopilot: 'off',
              dampeners: 'on',
              note: 'the hover is held by the dampeners; no waypoint is re-armed',
            },
            at: now,
          });
          return;
        }
        if (step === COME_TO_ME_STEP_AUTOPILOT_OFF) {
          drone.step = COME_TO_ME_STEP_WAITING;
          this.saveDrone(drone);
          return;
        }
        if (step === COME_TO_ME_STEP_WAITING) {
          const comeToMe = this.comeToMeOf(exec.missionId);
          const timeoutMs = comeToMe?.timeoutMs ?? this.deps.config.demo.comeToMe.timeoutMs;
          const readyAt = comeToMe?.readyAt ?? drone.holdAt ?? now;
          if (now - readyAt >= timeoutMs) {
            drone.step = COME_TO_ME_STEP_TIMED_OUT;
            this.saveDrone(drone);
            const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
            this.store().audit({
              actor: 'demo-executor',
              action: 'come_to_me_timeout',
              subject: `${drone.missionId}:${drone.idx}`,
              detail: {
                gridId: drone.gridId,
                player: comeToMe?.player ?? null,
                playerName: comeToMe?.playerName ?? null,
                waitedMs: now - readyAt,
                timeoutMs,
                position: unit?.pos ?? null,
                hoverAglM: comeToMe?.hoverAglM ?? null,
                note:
                  'nobody took control: the ship keeps hovering (it never lands or leaves on its own); an info alert was raised',
              },
              at: now,
            });
          }
          return;
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * T19: station pass. `holding` is a TERMINAL drone state for the flight loop
   * (the case below it is only reachable through the state transition), so the
   * station decision runs from its own pass rather than inside advance().
   *
   * Public so a test can drive one station pass without a flying mission; the
   * tick loop is its only production caller.
   */
  stationPass(exec: ExecRow, now: number): void {
    // A come-to-me hover is never a station: the ship waits at 80 m of hull
    // bottom for the OWNER to land it by hand, and a conversion would freeze it
    // there (and judge the hover against the 100 m station floor).
    if (this.comeToMeOf(exec.missionId)) return;
    for (const drone of this.drones(exec.missionId)) {
      if (drone.state !== 'holding' || !drone.gridId) continue;
      if (drone.step === STATIONED_STEP) continue;
      try {
        // `holding` never reaches advance(), so its pending station order has
        // to be resolved here before the next decision is made.
        if (drone.pendingOrder) {
          this.resolvePending(exec, drone, now);
          continue;
        }
        // Velocity has been zeroed; give the physics body 2 s to settle, then
        // convert. A conversion issued in the same tick as the zeroing was the
        // old race that left satellites drifting at ~1 m/s.
        if (drone.step === 'station_wait') {
          const gs = this.guardState(drone);
          if (this.survivalMode) {
            // Poll the live speed: convert only under the limit SE will freeze,
            // and give up honestly after the timeout rather than forcing it.
            const speed = this.liveSpeedFor(drone);
            if (speed !== null) gs.stationSpeedMps = speed;
            const waitedMs = gs.stationZeroAt === null ? 0 : now - gs.stationZeroAt;
            if (speed !== null && speed < STATION_CONVERT_MAX_SPEED_MPS) {
              this.send(exec, drone, now, 'test', drone.gridId!, 'convert_to_station',
                { ...convertToStationOrder(drone.gridId!), zone: 'survival' });
              drone.step = STATIONING_STEP;
              this.saveDrone(drone);
              continue;
            }
            if (waitedMs >= STATION_SURVIVAL_STOP_TIMEOUT_MS) {
              drone.step = null;
              drone.reason = `station refused: dampeners did not bring it under ` +
                `${STATION_CONVERT_MAX_SPEED_MPS} m/s in ${Math.round(waitedMs / 1000)} s` +
                (speed !== null ? ` (still ${speed.toFixed(2)} m/s)` : '') +
                ' - not zeroing the velocity in survival';
              this.saveDrone(drone);
              this.store().audit({
                actor: 'demo-executor',
                action: 'demo_station_stop_timeout',
                subject: `${drone.missionId}:${drone.idx}`,
                detail: { gridId: drone.gridId, speedMs: speed, waitedMs, reason: SURVIVAL_REASON },
                at: now,
              });
              continue;
            }
            // Keep the brakes on; a missed set_dampeners is not fatal (the plugin
            // dead-man restores them too), but the speed poll is the truth.
            continue;
          }
          if (gs.stationZeroAt !== null && now - gs.stationZeroAt >= STATION_SETTLE_MS) {
            this.send(exec, drone, now, 'test', drone.gridId!, 'convert_to_station', convertToStationOrder(drone.gridId!));
            drone.step = STATIONING_STEP;
            this.saveDrone(drone);
          }
          continue;
        }
        this.maybeStation(exec, drone, now);
      } catch (err) {
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_station_error',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: { gridId: drone.gridId, error: err instanceof Error ? err.message : String(err) },
          at: now,
        });
      }
    }
  }

  /**
   * T19: station a relay that is genuinely parked.
   *
   * Called from the `holding` state only, so the drone is at its slot with no
   * order in flight. The decision is a pure function (demo/station.ts); this
   * method only supplies the measurements and the order plumbing.
   *
   * A player piloting the grid wins: before converting, the executor asks the
   * plugin (`is_under_control`) and abandons the conversion when a cockpit or
   * remote control is occupied. Returns true when it consumed the tick.
   */
  /**
   * T74: the speed the survival station loop waits on, from the last telemetry
   * sample (never from a plugin write). null when the unit has not reported.
   */
  private liveSpeedFor(drone: DroneRow): number | null {
    if (!drone.gridId) return null;
    const unit = this.store().getUnit(drone.gridId);
    if (!unit?.vel) return null;
    return Math.hypot(unit.vel.x, unit.vel.y, unit.vel.z);
  }

  private maybeStation(exec: ExecRow, drone: DroneRow, now: number): boolean {
    if (!drone.gridId) return false;
    if (drone.step === STATIONED_STEP) return true;
    if (drone.step === STATIONING_STEP || drone.step === 'station_check') return true;
    if (drone.step === 'station_zeroing' || drone.step === 'station_wait') return true;
    const guard = this.guardState(drone);
    // A refused conversion is retried on the next pass only after a cooldown,
    // otherwise a grid that cannot be frozen is re-zeroed every 2 s forever.
    if (guard.stationGiveUpAt !== null && now - guard.stationGiveUpAt < 600_000) return true;
    const unit = this.store().getUnit(drone.gridId);
    if (!unit?.pos) return false;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit.pos);
    this.refreshGround(drone, unit.pos, planet, now);
    this.pollGroundProbes(now);
    const frame = this.groundFrame(drone, unit.pos, planet);
    const groundRadius = frame?.groundRadiusM ?? 0;
    const speed = unit.vel ? Math.hypot(unit.vel.x, unit.vel.y, unit.vel.z) : null;
    const agl = frame && groundRadius > 0 ? frame.altitudeAglM : null;

    const decision = stationDecision({
      enabled: this.stationConfig().enabled,
      state: drone.state,
      holdMs: drone.holdAt !== null ? now - drone.holdAt : null,
      speedMps: speed,
      aglM: agl,
      hasPendingOrder: !!drone.pendingOrder,
      underControl: false, // verified with the plugin before converting
      isStatic: false,
      alreadyStationed: false,
      config: this.stationConfig(),
    });
    if (decision.action !== 'station') return false;

    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_station_decision',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, decision, speedMps: speed, aglM: agl, line: stationLine(decision) },
      at: now,
    });
    this.send(exec, drone, now, 'test', drone.gridId, 'is_under_control', { gridId: drone.gridId });
    drone.step = 'station_check';
    this.saveDrone(drone);
    return true;
  }

  private stationConfig(): StationConfig {
    const s = this.deps.config.demo.station;
    return {
      enabled: s.enabled,
      afterMs: s.afterMs,
      maxSpeedMps: s.maxSpeedMps,
      zeroSpeedMps: s.zeroSpeedMps ?? 5,
      minAglM: s.minAglM,
    };
  }

  /**
   * T8: hand one flying/holding drone to the staging controller. Staging never
   * throws into the flight state machine: a staging fault is audited and the
   * mission continues.
   */
  private stageDrone(exec: ExecRow, drone: DroneRow, now: number): void {
    if (!drone.gridId) return;
    if (this.controls.isManual(drone.gridId)) return;
    if (drone.state !== 'en_route' && drone.state !== 'holding') return;
    // A station is static: no thrusters to stage and nothing to burn.
    if (drone.step === STATIONED_STEP) return;
    try {
      const unit = this.store().getUnit(drone.gridId);
      const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
      this.staging.tick({
        missionId: exec.missionId,
        idx: drone.idx,
        label: drone.label,
        prefab: drone.prefab,
        gridId: drone.gridId,
        state: drone.state,
        unit,
        planet,
        now,
        plannedDescent: this.descentPlanned(drone),
      });
    } catch (err) {
      this.store().audit({
        actor: 'thrust-staging',
        action: 'staging_error',
        subject: `${exec.missionId}:${drone.idx}`,
        detail: { error: err instanceof Error ? err.message : String(err), gridId: drone.gridId },
        at: now,
      });
    }
  }

  private guardKey(drone: DroneRow): string {
    return `${drone.missionId}:${drone.idx}`;
  }

  // ------------------------------------------------ T27 manual handoff

  // ------------------------------------------------ come to me (T: hover for a manual landing)

  /**
   * The come-to-me block of the mission's desired state, or null. Reading the
   * MISSION (not an in-memory flag) means the phase survives a restart.
   */
  private comeToMeOf(missionId: string): ComeToMeMissionState | null {
    const mission = this.store().getMission(missionId);
    const raw = (mission?.desiredState as { comeToMe?: ComeToMeMissionState } | undefined)?.comeToMe;
    return raw ?? null;
  }

  /** Write progress back into the mission's come-to-me block (phase/readyAt). */
  private setComeToMePhase(missionId: string, patch: Partial<ComeToMeMissionState>, now: number): void {
    const mission = this.store().getMission(missionId);
    if (!mission) return;
    const current = (mission.desiredState as { comeToMe?: ComeToMeMissionState }).comeToMe ?? {};
    this.store().updateMission(
      missionId,
      { desiredState: { ...mission.desiredState, comeToMe: { ...current, ...patch } } },
      now,
    );
  }

  /**
   * Arrival at the hover point. This is NOT a landing and not a normal hold:
   * one hold order settles the last few metres, then the waiting_pilot state
   * clears the autopilot and sends nothing ever again. The mission stays
   * `executing` with phase `waiting_for_pilot` - visible in
   * desiredState.comeToMe.phase and audited as `come_to_me_ready`.
   */
  private comeToMeArrival(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    info: { remaining: number; speed: number; holdSpeed: number; gate: CommsGate },
  ): void {
    if (!drone.gridId) return;
    const comeToMe = this.comeToMeOf(exec.missionId) ?? {};
    const gs = this.guardState(drone);
    // The hold point must sit on LANDING-GRADE ground at the HOVER column: a
    // coarse datum 37.5 m low is what turned an 80 m ask into 56.6 m flown
    // (2026-11-11). Moves the slot and returns true when it did.
    if (this.relocateComeToMeHold(exec, drone, now, comeToMe, gs)) return;
    this.recordLegResult(drone, now, info.remaining, info.speed, 'arrived');
    this.send(exec, drone, now, 'hold', drone.gridId, 'hold', { ...drone.execSlot, speed: info.holdSpeed }, info.gate);
    this.setCollisionAvoidance(exec, drone, now, false, 'hovering for the pilot');
    const unit = this.store().getUnit(drone.gridId);
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    const frame = unit?.pos && planet ? this.groundFrame(drone, unit.pos, planet) : null;
    // A hover height is only MEASURED on a landing-grade sample. The level-0
    // planning field at this cold column reported 110.9 m AGL where the plan's
    // level-5 datum said 74.3 m for the same hover (2026-11-11): reporting that
    // coarse number as the hover's AGL is how a ~36 m LOD error became "the
    // ship is 110 m up". A coarse read is reported against the datum the hover
    // was BUILT with, and labelled.
    const ownColumnMeasured = frame !== null && isLandingGrade(frame.terrainLevel);
    const measuredAgl = ownColumnMeasured && frame ? Math.round(frame.altitudeAglM * 10) / 10 : null;
    const planDatumAgl =
      frame && typeof comeToMe.groundRadiusM === 'number' && Number.isFinite(comeToMe.groundRadiusM)
        ? Math.round(hullBottomAglM(frame.radiusM - comeToMe.groundRadiusM, frame.keelM) * 10) / 10
        : null;
    const hoverAglSource =
      measuredAgl !== null ? 'measured-own-column' : planDatumAgl !== null ? 'plan-datum' : 'plan';
    this.setState(
      drone,
      'waiting_pilot',
      now,
      `arrived ${info.remaining.toFixed(1)} m from the hover point at ${info.speed.toFixed(1)} m/s; hovering for the pilot`,
    );
    drone.step = COME_TO_ME_STEP_HOLD;
    drone.holdAt = now;
    this.saveDrone(drone);
    this.setComeToMePhase(
      exec.missionId,
      {
        phase: 'waiting_for_pilot',
        readyAt: now,
        ...(measuredAgl !== null
          ? { hoverAglM: measuredAgl }
          : planDatumAgl !== null
            ? { hoverAglM: planDatumAgl }
            : {}),
        ...(frame ? { groundSource: frame.source, hoverAglLevel: frame.terrainLevel, hoverAglSource } : {}),
      },
      now,
    );
    this.store().audit({
      actor: 'demo-executor',
      action: 'come_to_me_ready',
      subject: `${exec.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        player: comeToMe.player ?? null,
        playerName: comeToMe.playerName ?? null,
        standIn: comeToMe.standIn ?? null,
        distanceToPlayerM: comeToMe.distanceToPlayerM ?? null,
        hoverAglM: measuredAgl ?? planDatumAgl ?? comeToMe.hoverAglM ?? null,
        plannedHoverAglM: comeToMe.hoverAglM ?? null,
        hoverAglSource,
        hoverAglLevel: frame?.terrainLevel ?? null,
        plannedGroundRadiusM:
          typeof comeToMe.groundRadiusM === 'number' ? Math.round(comeToMe.groundRadiusM * 10) / 10 : null,
        ownColumnGroundRadiusM: frame ? Math.round(frame.groundRadiusM * 10) / 10 : null,
        groundSource: frame?.source ?? comeToMe.groundSource ?? null,
        fromHoverPointM: Math.round(info.remaining * 10) / 10,
        speedMps: Math.round(info.speed * 10) / 10,
        phase: 'waiting_for_pilot',
        note: 'hovering (dampeners on, autopilot off); the pilot lands it by hand, no order is sent',
      },
      at: now,
    });
  }

  /**
   * The come-to-me hold point must sit on LANDING-GRADE ground at the HOVER
   * column (2026-11-11, run set 3).
   *
   * Measured: an 80 m hull-bottom hover was flown **56.6 m** above the level-5
   * ground (61 198.24 m) because the executor judged the hold on its own column
   * read, which was the level-0 planning field (61 160.7 m) - 37.5 m LOW, i.e.
   * 23 m of the 24 m miss. The route now records the datum the point was built
   * with (`comeToMe.groundRadiusM` / `groundLevel`), and this method is the one
   * place that turns a datum into a hold radius:
   *
   *   * a landing-grade sample at the hover column (fresh read first, else the
   *     recorded one) -> that radius, no margin;
   *   * a COARSE sample only -> wait up to `COME_TO_ME_COARSE_DATUM_WAITS`
   *     ticks for the level-5 read (the same bounded wait the `land_at`
   *     handover uses), then use the coarse sample PLUS
   *     `COME_TO_ME_COARSE_DATUM_MARGIN_M`: a coarse datum may only ever place
   *     the hull HIGHER than asked, never lower.
   *
   * Returns true when the slot moved, or while the fine read is still being
   * waited for: the caller must NOT declare the hover ready this tick. The leg
   * loop flies the corrected point and calls back into the arrival.
   */
  private relocateComeToMeHold(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    comeToMe: ComeToMeMissionState,
    gs: GuardState,
  ): boolean {
    if (!comeToMe.hover) return false;
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const planet =
      (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? comeToMe.hover);
    if (!planet) return false;
    const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    const dir = this.upAt(planet, comeToMe.hover);
    if (!dir) return false;

    // 1. The finest sample of the HOVER column available this tick.
    const recordedM = Number(comeToMe.groundRadiusM ?? NaN);
    const recordedLevel =
      typeof comeToMe.groundLevel === 'number' && Number.isFinite(comeToMe.groundLevel)
        ? comeToMe.groundLevel
        : levelFromGroundSource(comeToMe.groundSource);
    const fresh = this.terrainRadiusAt(planet, dir);
    const sample = isLandingGrade(fresh?.level)
      ? { radiusM: fresh!.radiusM, level: fresh!.level, source: fresh!.source }
      : Number.isFinite(recordedM) && recordedM > 1
        ? { radiusM: recordedM, level: recordedLevel, source: comeToMe.groundSource ?? 'recorded' }
        : fresh
          ? { radiusM: fresh.radiusM, level: fresh.level, source: fresh.source }
          : null;
    if (!sample) return false;

    const requestedAglM = Number(
      comeToMe.standoff?.aboveGroundM ??
        (Number.isFinite(Number(comeToMe.hoverAglM)) ? Number(comeToMe.hoverAglM) : COME_TO_ME_HOLD_FLOOR_M),
    );
    const keelM = this.keelFor(drone).keelM;
    const datum = hoverHoldDatum({
      sampleRadiusM: sample.radiusM,
      level: sample.level,
      source: sample.source,
      keelDepthM: keelM,
      requestedAglM,
    });

    // 2. Wait for the fine read before falling back to a margin.
    if (datum.coarse) {
      gs.comeToMeDatumWaits = (gs.comeToMeDatumWaits ?? 0) + 1;
      if (gs.comeToMeDatumWaits <= COME_TO_ME_COARSE_DATUM_WAITS) {
        requestColumnGround(planet, dir);
        return true;
      }
    }

    // 3. Move the slot only when the datum moves it. One correction per drone:
    //    a hover never ping-pongs between two samples.
    const previousRadiusM = len(sub(drone.execSlot, centre));
    const deltaM = Math.round((datum.hoverRadiusM - previousRadiusM) * 10) / 10;
    if (Math.abs(deltaM) <= 1 || gs.comeToMeDatumFixed) return false;
    gs.comeToMeDatumFixed = true;
    drone.execSlot = {
      x: centre.x + dir.x * datum.hoverRadiusM,
      y: centre.y + dir.y * datum.hoverRadiusM,
      z: centre.z + dir.z * datum.hoverRadiusM,
    };
    this.saveDrone(drone);
    this.store().audit({
      actor: 'demo-executor',
      action: 'come_to_me_hold_datum',
      subject: `${exec.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        requestedAglM: Math.round(requestedAglM * 10) / 10,
        sampleGroundRadiusM: Math.round(sample.radiusM * 10) / 10,
        sampleLevel: sample.level,
        sampleSource: sample.source,
        coarseMarginM: datum.marginM,
        datumGroundRadiusM: Math.round(datum.datumRadiusM * 10) / 10,
        holdRadiusM: Math.round(datum.hoverRadiusM * 10) / 10,
        previousRadiusM: Math.round(previousRadiusM * 10) / 10,
        deltaM,
        keelM,
        note: datum.coarse
          ? 'the hover column has no landing-grade ground sample after the wait, so the hold is built on the planning field plus a ' +
            `${datum.marginM} m margin: a coarse datum may only raise the hull, never lower it`
          : 'the hold is built on the landing-grade ground at the hover column, not on a coarse sample under the ship',
      },
      at: now,
    });
    return true;
  }

  /**
   * The plugin says a player has the grid. Nothing is sent from here on; the
   * mission completes as `handed to pilot` instead of pausing, because the
   * ship did exactly what it was asked to do (arrive) and the rest is manual.
   */
  private handToPilot(drone: DroneRow, now: number, by: string | null, source: string | null): void {
    if (drone.step === COME_TO_ME_STEP_HANDED) return;
    const mission = this.store().getMission(drone.missionId);
    if (!mission) return;
    const comeToMe = this.comeToMeOf(drone.missionId) ?? {};
    this.store().updateMission(
      drone.missionId,
      {
        status: 'done',
        pauseReason: 'handed to pilot',
        desiredState: { ...mission.desiredState, comeToMe: { ...comeToMe, phase: 'handed_to_pilot' } },
      },
      now,
    );
    this.store().db
      .prepare(`UPDATE demo_exec SET state = 'done', updated_at = ? WHERE mission_id = ?`)
      .run(now, drone.missionId);
    drone.step = COME_TO_ME_STEP_HANDED;
    this.saveDrone(drone);
    this.store().audit({
      actor: 'demo-executor',
      action: 'come_to_me_handed_to_pilot',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        by,
        source,
        phase: 'handed_to_pilot',
        missionStatus: 'done',
        ordersSent: 'zero',
        note: 'the player has control (plugin is_under_control); the autopilot sends nothing more',
      },
      at: now,
    });
  }

  /** Telemetry the state route already exposes: unit meta, or the power poll. */
  private controlTelemetry(gridId: string, now: number): ControlTelemetry | null {
    const unit = this.store().getUnit(gridId);
    const meta = (unit?.meta ?? {}) as Record<string, unknown>;
    // T61: the plugin's classified crew travels with telemetry `control`. Its
    // `underControl` is PILOT ONLY, and `passengers`/`aboard` are kept so a
    // passenger-carrying ship keeps flying under the passenger limits.
    const crew = crewFromMeta(meta);
    if (crew) {
      return {
        underControl: crew.underControl,
        by: crew.pilot?.name ?? null,
        at: now,
        crew,
      };
    }
    if (meta.underControl === true || meta.manualControl === true || meta.piloted === true) {
      return {
        underControl: true,
        by: typeof meta.controlledBy === 'string' ? meta.controlledBy : null,
        at: now,
      };
    }
    const snap = this.deps.power?.snapshot(gridId);
    if (snap) return { underControl: snap.underControl, by: snap.controlledBy, at: snap.at };
    return null;
  }

  /**
   * True when this tick must be withheld. A piloted grid gets NO order at all:
   * not move/hold/stop, not staging, not a station conversion, not a
   * set_block_props write. The read-only probe runs at most once per 5 s so a
   * released cockpit is noticed without ever auto-resuming the paused mission.
   */
  private controlPass(exec: ExecRow, drone: DroneRow, now: number): boolean {
    if (!drone.gridId) return false;
    const gridId = drone.gridId;
    // Come to me trusts ONLY the plugin's read-only `is_under_control` answer:
    // telemetry once reported `underControl: true` for an empty ship (a stale
    // power sample), and handing off a hover to a pilot who is not there would
    // be exactly the bug this feature cannot afford.
    const probeOnly = this.comeToMeOf(exec.missionId) !== null;
    if (!probeOnly && this.controls.observe(gridId, this.controlTelemetry(gridId, now), now)) {
      this.enterManual(drone, now);
    }
    // The probe runs while manual too: it is how a released cockpit is noticed.
    // A terminal mission is disarmed, but a `paused` one is NOT: that probe is
    // exactly how a released cockpit gets the mission resumed.
    if (this.controls.probeDue(gridId, now) && this.probeArmed(exec.missionId)) this.sendControlProbe(exec, drone, now);
    if (this.controls.isManual(gridId)) {
      if (drone.state !== 'manual') this.enterManual(drone, now);
      return true;
    }
    // Fail closed while a probe is in flight for a grid that carries a manual
    // mark (a restart, or a previous handoff): nothing may leave before the
    // plugin has answered.
    if (this.controls.probeInFlight(gridId) && this.controls.hasMark(gridId)) return true;
    // T61: no pilot, so the ship keeps flying - but passengers aboard change
    // how. Record that once per mission (with names), and let the flight paths
    // read the limits from `controls.crew()`.
    this.notePassengers(exec, drone, now);
    return false;
  }

  /** Missions whose `carrying_passengers` audit has already been written. */
  private readonly passengerAudited = new Set<string>();
  /** mission:idx descent refusals already audited (one per leg, not per tick). */
  private readonly passengerDescentAudited = new Set<string>();

  /**
   * T61: one audit row per mission the first time a non-pilot is found aboard,
   * naming who it is and what the caps are. The executor is NOT silenced: the
   * ship keeps flying under `passengers.ts` limits.
   */
  private notePassengers(exec: ExecRow, drone: DroneRow, now: number): void {
    if (!drone.gridId) return;
    if (this.passengerAudited.has(exec.missionId)) return;
    const limits = this.passengerLimitsFor(drone, this.store().getUnit(drone.gridId));
    if (!limits) return;
    this.passengerAudited.add(exec.missionId);
    this.store().audit({
      actor: 'demo-executor',
      action: 'carrying_passengers',
      subject: exec.missionId,
      detail: {
        missionId: exec.missionId,
        idx: drone.idx,
        label: drone.label,
        gridId: drone.gridId,
        names: limits.names,
        standing: limits.standing,
        carrying: limits.carrying,
        speedCapMps: limits.speedCapMps,
        lateralAccelMps2: Math.round(limits.lateralAccelMps2 * 100) / 100,
        verticalAccelMps2: Math.round(limits.verticalAccelMps2 * 100) / 100,
        dampenersOff: limits.allowDampenersOff,
        freeFall: limits.allowFreeFall,
        line: describePassengers(limits),
        note: 'no pilot aboard: the ship keeps flying under passenger limits',
      },
      at: now,
    });
  }

  /**
   * T61: the limits this grid is flown under, from the plugin's classified crew
   * and the local gravity. Null = the normal profile (nobody aboard, or the
   * plugin reported no crew).
   */
  private passengerLimitsFor(
    drone: DroneRow,
    unit: { pos?: { x: number; y: number; z: number } | null } | null | undefined,
  ): PassengerLimits | null {
    if (!drone.gridId) return null;
    const pos = unit?.pos ?? null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? (pos ? nearestPlanet(pos) : null);
    let gravity = 9.81;
    if (planet && pos) {
      const surface = Number(planet.surfaceRadiusM ?? 0) || 0;
      const altitude = Math.max(0, len(pos) - surface);
      const g = this.gravityAt(planet, altitude);
      if (Number.isFinite(g) && g > 0.1) gravity = g;
    }
    // A PERSONAL ship flies the same gentle envelope as a passenger ride-along
    // (60 m/s, dampened, no free fall) even with nobody aboard: an owner ship is
    // never thrown around by the autopilot.
    if (shipRoles.roleOf(drone.gridId) === 'personal') return personalShipLimits(gravity);
    const crew = this.controls.crew(drone.gridId);
    if (!crew) return null;
    return passengerLimits(crew, gravity);
  }

  /**
   * The single transition: mark the drone row manual, pause (free) its mission
   * with reason `manual control by player`, and suspend staging. `setState`
   * only audits when the state changes, so this is one audit row per handoff.
   */
  private enterManual(drone: DroneRow, now: number): void {
    if (!drone.gridId) return;
    const view = this.controls.view(drone.gridId);
    const first = drone.state !== 'manual';
    const comeToMe = this.comeToMeOf(drone.missionId);
    drone.pendingOrder = null;
    drone.pendingAction = null;
    this.setState(drone, 'manual', now, comeToMe ? 'handed to pilot' : 'manual control by player');
    this.staging.suspend(drone.gridId, 'manual control by player');
    // Come to me is FINISHED by the handoff, not paused: the ship arrived and
    // did what it was asked to; the landing is the player's. `handToPilot`
    // marks the mission done and sends nothing.
    if (comeToMe) {
      this.handToPilot(drone, now, view?.by ?? null, view?.source ?? null);
      return;
    }
    const mission = this.store().getMission(drone.missionId);
    if (mission && ['approved', 'executing'].includes(mission.status)) {
      pauseMission(
        this.store(),
        drone.missionId,
        'manual control by player',
        {
          kind: 'manual_control',
          message: `${drone.label}: a player is piloting ${drone.gridId}; mission paused, no orders are sent`,
        },
        'demo-executor',
        now,
      );
    }
    if (!first) return;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_manual_handoff',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        by: view?.by ?? null,
        source: view?.source ?? null,
        suppressed: ['move', 'hold', 'stop', 'staging', 'station', 'set_block_props'],
        missionStatus: 'paused',
        reason: 'manual control by player',
      },
      at: now,
    });
  }

  /** One read-only `is_under_control` per grid per 5 s (never a flight order). */
  private sendControlProbe(exec: ExecRow, drone: DroneRow, now: number): void {
    if (!drone.gridId || !this.deps.hub.isConnected()) return;
    const gridId = drone.gridId;
    // OFF means NO orders at all, and this probe is an order even though it
    // only reads. PERSONAL keeps it: the manual-handoff rule needs to notice
    // the owner boarding.
    if (shipRoles.roleOf(gridId) === 'off') return;
    const orderId = `demo:control:${gridId}:${now}`;
    const wireType = this.orderChannel('is_under_control', now, gridId);
    if (!wireType) return;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: gridId,
      params: { action: 'is_under_control', entityId: gridId },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 20_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: gridId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    if (!this.deps.hub.send(payload)) return;
    this.controls.beginProbe(gridId, orderId, now);
    this.controlProbes.set(orderId, { gridId, missionId: exec.missionId, idx: drone.idx });
  }

  /** Apply probe answers from the audit trail (same path as ground probes). */
  private pollControlProbes(now: number): void {
    if (this.controlProbes.size === 0) return;
    for (const [orderId, record] of this.controlProbes) {
      if (this.controls.probeOrder(record.gridId) !== orderId) {
        this.controlProbes.delete(orderId);
        continue;
      }
      const result = this.resultFor(orderId);
      if (!result) {
        this.controls.expireProbe(record.gridId, now);
        continue;
      }
      this.controls.expireProbe(record.gridId, now);
      if (result.ok === false) continue; // retry next interval, keep the mark
      this.controlProbes.delete(orderId);
      const r = (result.result ?? {}) as {
        underControl?: unknown;
        by?: unknown;
        control?: { underControl?: unknown; by?: unknown };
      };
      const under = r.underControl === true || r.control?.underControl === true;
      const by =
        typeof r.control?.by === 'string' ? r.control.by : typeof r.by === 'string' ? r.by : null;
      // T61: the probe carries the same classification as telemetry; keep it so
      // a passenger-carrying grid still gets its limits after a probe settles.
      const crew = crewFromMeta({ control: r.control ?? r });
      const settled = this.controls.settle(record.gridId, under, by, now, crew);
      if (under) {
        const drone = this.drones(record.missionId).find((d) => d.idx === record.idx);
        if (drone) this.enterManual(drone, now);
      } else if (settled.released) {
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_manual_released',
          subject: record.gridId,
          detail: {
            note: 'player control released; the paused mission stays paused until a new owner order',
          },
          at: now,
        });
      }
    }
  }

  /**
   * True while a controlled fall is planned/in progress. Staging uses this so a
   * deliberate fast descent is not treated as an emergency; a holding ship
   * falling is still an emergency.
   */
  private descentPlanned(drone: DroneRow): boolean {
    const phase = this.guards.get(this.guardKey(drone))?.descent?.phase;
    return phase === 'falling' || phase === 'braking' || phase === 'late-brake';
  }

  private guardState(drone: DroneRow): GuardState {
    const key = this.guardKey(drone);
    let gs = this.guards.get(key);
    if (!gs) {
      gs = {
        speedLimit: this.deps.config.demo.speedLimitMps,
        lastResendAt: 0,
        lastBrakeAt: 0,
        needsMove: false,
        coneStep: null,
        groundHit: null,
        probeAt: 0,
        probeId: null,
        probeMisses: 0,
        probeMissAt: 0,
        lastVerdict: null,
        lastRemaining: null,
        awayTicks: 0,
        arrival: emptyArrivalProgress(),
        terminal: false,
        postmortem: false,
        stationAttempts: 0,
        stationZeroAt: null,
        stationSpeedMps: null,
        stationGiveUpAt: null,
        legProfile: null,
        legStartedAt: null,
        predictedEtaS: null,
        predictedFuelL: null,
        fuelAtStart: null,
        dampenersOff: false,
        dampenersOnAt: null,
        descent: null,
        climb: null,
        keelM: 0,
        keelSource: 'none',
        telemetryPeriodS: 1,
        lastTelemetryAt: null,
        approach: null,
        landingSlotGround: false,
        measuredShedMps2: null,
        shedSample: null,
        landingOrderAt: null,
        landingIdleAt: null,
        landingIdleAglM: null,
        landingIdleResumes: 0,
        landingContactWarned: false,
      };
      this.guards.set(key, gs);
    }
    return gs;
  }

  private gravityAt(planet: ReturnType<typeof nearestPlanet>, altitudeM: number): number {
    return planet ? gravityAtAltitude(planetGravity(planet), Math.max(0, altitudeM)) : 9.81;
  }

  /**
   * Terrain height field for one planet, loaded on first need (ground-datum
   * crash, 2026-11-10).
   *
   * `loadTerrainField` never throws and caches its own copies; this map only
   * holds the one field per planet the flight maths reads synchronously. Until
   * the first load lands the caller gets null and falls back to the catalogue
   * mean, flagged `mean` with its uncertainty. An unavailable field is retried
   * after `TERRAIN_UNAVAILABLE_RETRY_MS` so a terrain service that came up late
   * is picked up without a restart.
   */
  private terrainFieldFor(planet: NonNullable<ReturnType<typeof nearestPlanet>>): TerrainField | null {
    const key = planet.id ?? planet.name;
    const now = this.now();
    const cached = this.terrainFields.get(key);
    if (cached && (cached.field.status === 'available' || now - cached.at < TERRAIN_UNAVAILABLE_RETRY_MS)) {
      return cached.field;
    }
    // Test/ops seam: a field handed in directly (the fake-hub tests use this).
    const injected = this.deps.terrainField?.(planet) ?? null;
    if (injected) {
      this.terrainFields.set(key, { field: injected, at: now });
      return injected;
    }
    if (!this.terrainLoading.has(key)) {
      this.terrainLoading.add(key);
      void loadTerrainField(planet)
        .then((field) => {
          this.terrainFields.set(key, { field, at: this.now() });
        })
        .catch((err: unknown) => {
          this.terrainFields.set(key, {
            field: unavailableTerrainField(
              planet,
              `terrain field for ${planet.name} could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
            ),
            at: this.now(),
          });
        })
        .finally(() => {
          this.terrainLoading.delete(key);
        });
    }
    return cached?.field ?? null;
  }

  /**
   * Signed pivot -> lowest hull point along local down, m, and where it came
   * from.
   *
   * Telemetry first (the plugin reports `keelDepthM` every frame from the
   * grid's block AABB, so it follows the hull's attitude), then the last
   * `inspect` reply, then 0 with source `none` — which is the old behaviour and
   * is labelled as such in every audit that uses it.
   */
  private keelFor(drone: DroneRow): { keelM: number; source: GuardState['keelSource'] } {
    const gs = this.guardState(drone);
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const meta = (unit?.meta ?? {}) as { keelDepthM?: unknown; keelSource?: unknown };
    const rawTelemetry = meta.keelDepthM;
    // `Number(null)`, `Number(undefined)` and `Number('')` are finite (0), so a
    // missing sample must be rejected BEFORE the numeric coercion: otherwise
    // "not reported" reads as a perfect 0 m keel and the source says
    // 'telemetry', which is the silent-zero the game run showed.
    const fromTelemetry =
      rawTelemetry === null || rawTelemetry === undefined || rawTelemetry === '' ? NaN : Number(rawTelemetry);
    if (Number.isFinite(fromTelemetry)) {
      // The plugin labels its own sample ('local-aabb'). Keep that label: it is
      // what the landing audits report, so a reader can tell a live AABB read
      // from an inspect fallback.
      const label = typeof meta.keelSource === 'string' && meta.keelSource.length > 0 ? meta.keelSource : 'telemetry';
      if (gs.keelM !== fromTelemetry || gs.keelSource !== label) {
        gs.keelM = fromTelemetry;
        gs.keelSource = label;
      }
      return { keelM: fromTelemetry, source: label };
    }
    const inspected = this.inspectKeelM(drone.gridId);
    if (inspected !== null) {
      if (gs.keelM !== inspected || gs.keelSource !== 'inspect') {
        gs.keelM = inspected;
        gs.keelSource = 'inspect';
      }
      return { keelM: inspected, source: 'inspect' };
    }
    return { keelM: gs.keelSource === 'none' ? 0 : gs.keelM, source: gs.keelSource === 'none' ? 'none' : gs.keelSource };
  }

  /** `keelDepthM` from the last `inspect` reply for this grid, or null. */
  private inspectKeelM(gridId: string | null): number | null {
    if (!gridId) return null;
    const result = this.inspectResultFor(gridId);
    const payload = result as { geometry?: { keelDepthM?: unknown } } | null;
    const value = Number(payload?.geometry?.keelDepthM);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * The shared column ground for this position: ONE policy, in `ground.ts`
   * (`bestColumnGround`) - finest cached sample, else the level-0 planning
   * field LABELLED `terrain-l0`, else null (the caller uses the catalogue mean
   * and says so). The sample carries `level`, so no consumer can mistake a
   * coarse value for a landing-grade one.
   *
   * Sync by design (the executor tick is sync): a cold column kicks the shared
   * read and returns the coarse value NOW, and the next tick - and `comeToMe`,
   * and every guard - sees the fine number.
   */
  private terrainRadiusAt(
    planet: NonNullable<ReturnType<typeof nearestPlanet>>,
    pos: Vec3,
  ): ColumnGround | null {
    const dir = this.upAt(planet, pos);
    if (!dir) return null;
    return bestColumnGround(planet, dir, this.terrainFieldFor(planet));
  }

  /** Unit direction from the planet centre through `pos`, or null. */
  private upAt(planet: NonNullable<ReturnType<typeof nearestPlanet>>, pos: Vec3): Vec3 | null {
    const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    const dx = pos.x - centre.x;
    const dy = pos.y - centre.y;
    const dz = pos.z - centre.z;
    const radiusM = Math.hypot(dx, dy, dz);
    if (!(radiusM > 1)) return null;
    return { x: dx / radiusM, y: dy / radiusM, z: dz / radiusM };
  }

  /**
   * Local ground frame for one grid: terrain height field first, then a
   * `probe_ground` hit, then the catalogue mean (overnight run 2026-11-10,
   * FAILURE 1 and the ground-datum crash).
   *
   * `probe_ground` cannot hit procedural planet terrain on this build
   * (MyVoxelBase.GetIntersectionWithLine -> Storage.GetGeometry() is null for
   * planets), so nothing may wait on it. Everything a descent needs is already
   * in telemetry: the grid's position, the planet centre (save position +
   * 131072 m per axis, from the catalog the planner and gravity code use) and
   * surfaceRadiusM:
   *
   *   AGL = |position - planetCentre| - groundRadius
   *
   * `groundRadius` is the terrain radius at this column when the height field
   * has it (`source: 'terrain'`), else a `probe_ground` hit (`'probe'`), else
   * the catalogue mean (`'mean'`) with `groundUncertaintyM` = the planet's hill
   * range, because the real ground can be that much higher. `reason` is null
   * when the frame is usable, else a plain sentence saying why the descent
   * cannot be measured from telemetry — the caller records it and flies the
   * dampened leg.
   */
  private groundFrame(
    drone: DroneRow,
    pos: Vec3 | null | undefined,
    planetHint: ReturnType<typeof nearestPlanet>,
  ): {
    radiusM: number;
    groundRadiusM: number;
    /**
     * Ground radius under the SLOT's own column, m (2026-11-11): the ship's
     * column and the slot's can differ by >100 m of terrain height, so the
     * slot's AGL may never be measured with the ship's ground.
     */
    targetGroundRadiusM: number;
    /** Where `targetGroundRadiusM` came from ('terrain', else the ship's frame). */
    targetGroundSource: AltitudeSource;
    /** Terrain tile level behind `targetGroundRadiusM` (0 = planning field). */
    targetGroundLevel: number | null;
    /** HULL-BOTTOM altitude above the ground, m (the figure every ground rule uses). */
    altitudeAglM: number;
    /** The grid position's altitude above the ground, m (diagnostics only). */
    positionAglM: number;
    /** HULL-BOTTOM altitude of the leg's slot, m. */
    targetAglM: number;
    /** The leg slot's own altitude above the ground, m (inside-hill test). */
    targetPositionAglM: number;
    up: Vec3;
    source: AltitudeSource;
    groundUncertaintyM: number;
    /** Signed pivot -> lowest hull point along local down, m. */
    keelM: number;
    keelSource: GuardState['keelSource'];
    /** Tile level behind `groundRadiusM` when it came from the height field. */
    terrainLevel: number | null;
    reason: string | null;
  } | null {
    if (!pos) return null;
    // Resolve the planet from the position when the caller has none: a
    // move-to drone used to carry `planet: null`, and without a centre the
    // catalogue mean is read as 0 m, so the AGL came out tens of km wrong.
    const planet = planetHint ?? nearestPlanet(pos);
    const gs = this.guardState(drone);
    const keel = this.keelFor(drone);
    const surface = Number(planet?.surfaceRadiusM ?? 0) || 0;
    const probedRadius =
      planet && gs.groundHit
        ? len(sub(gs.groundHit, vec(planet.center) ?? { x: 0, y: 0, z: 0 }))
        : null;
    const terrainSample = planet ? this.terrainRadiusAt(planet, pos) : null;
    const terrainRadius = terrainSample ? terrainSample.radiusM : null;
    const frame = telemetryGroundFrame(pos, planet, probedRadius, terrainRadius);
    if (frame) {
      const centre = vec(planet!.center) ?? { x: 0, y: 0, z: 0 };
      const targetRadius = len(sub(drone.execSlot, centre));
      // The SAME shared sample the hold guard and come-to-me read (one cache).
      const sharedGround = planet ? columnGround(planet, this.upAt(planet, pos) ?? pos) : null;
      // THE SLOT'S OWN COLUMN (2026-11-11, come-to-me datum bug): the slot's
      // AGL used to subtract the ground radius sampled under the SHIP. On the
      // BASE-01 approach the ship's column reads 61 177.6 m while the hover
      // slot's reads 61 033.8 m — a 144 m error that turned an 88 m clearance
      // into -63 m and refused a legal come-to-me hold. Sample the ground under
      // the slot for the slot, and keep the ship column for the ship. The
      // probe hit is a ray under the SHIP, so it is never used for the slot;
      // with no slot sample the ship-column value is the only thing left, and
      // `targetGroundSource` says so.
      const slotTerrainSample = planet ? this.terrainRadiusAt(planet, drone.execSlot) : null;
      const slotGroundRadius = slotTerrainSample ? slotTerrainSample.radiusM : frame.groundRadiusM;
      const targetGroundSource: AltitudeSource = slotTerrainSample ? 'terrain' : frame.source;
      const targetGroundLevel = slotTerrainSample ? slotTerrainSample.level : null;
      return {
        radiusM: frame.radiusM,
        groundRadiusM: frame.groundRadiusM,
        targetGroundRadiusM: slotGroundRadius,
        targetGroundSource: targetGroundSource,
        targetGroundLevel,
        // Every ground rule below is phrased on the HULL BOTTOM: the grid's
        // reported position is its pivot, and on SAT-R-0001 the hull ends ~10 m
        // above it, so a position-based AGL mis-states the clearance by that
        // much and a touchdown rule on it can never fire.
        altitudeAglM: hullBottomAglM(frame.altitudeAglM, keel.keelM),
        positionAglM: frame.altitudeAglM,
        targetAglM: hullBottomAglM(targetRadius - slotGroundRadius, keel.keelM),
        targetPositionAglM: targetRadius - slotGroundRadius,
        up: frame.up,
        source: frame.source,
        groundUncertaintyM: frame.groundUncertaintyM,
        keelM: keel.keelM,
        keelSource: keel.source,
        // The LOD must come from the SAME sample the radius did: reporting
        // level 0 for a level-5 radius (or the reverse) is how a coarse datum
        // passed for a measured one.
        terrainLevel: frame.source === 'terrain' ? (terrainSample?.level ?? null) : null,
        reason: null,
      };
    }
    // Documented fallback: no planet (or one the grid is nowhere near) and no
    // probe hit. Keep the legacy origin-referenced numbers so the rest of the
    // leg still flies, and say plainly why a fall cannot be planned from them.
    const radiusM = Math.max(1, len(pos));
    const centre = planet ? vec(planet.center) ?? { x: 0, y: 0, z: 0 } : null;
    const groundRadiusM = gs.groundHit
      ? len(centre ? sub(gs.groundHit, centre) : gs.groundHit)
      : surface;
    // Same rule as the measured branch: the slot's ground, not the ship's.
    const slotFallbackTerrain = planet ? this.terrainRadiusAt(planet, drone.execSlot) : null;
    const slotFallbackGroundRadius = slotFallbackTerrain ? slotFallbackTerrain.radiusM : groundRadiusM;
    return {
      radiusM,
      groundRadiusM,
      targetGroundRadiusM: slotFallbackGroundRadius,
      targetGroundSource: slotFallbackTerrain !== null ? 'terrain' : 'mean',
      targetGroundLevel: slotFallbackTerrain ? slotFallbackTerrain.level : null,
      altitudeAglM: hullBottomAglM(radiusM - groundRadiusM, keel.keelM),
      positionAglM: radiusM - groundRadiusM,
      targetAglM: hullBottomAglM(len(drone.execSlot) - slotFallbackGroundRadius, keel.keelM),
      targetPositionAglM: len(drone.execSlot) - slotFallbackGroundRadius,
      up: norm(pos),
      source: 'mean',
      groundUncertaintyM: 0,
      keelM: keel.keelM,
      keelSource: keel.source,
      terrainLevel: null,
      reason: planet
        ? `planet ${planet.name} is not near this grid: ${Math.round(
            centre ? len(sub(pos, centre)) : radiusM,
          )} m from its centre is far outside its ${Math.round(
            Number(planet.maxHillRadiusM ?? 0) || surface,
          )} m hill radius`
        : 'no planet known for this grid (no catalog entry and none near its position)',
    };
  }

  /**
   * Measured thrust split for a drone. Owner-tagged grids are registered in the
   * staging hardware table; a clone of that family keeps its measured mass but
   * a new grid id, so the same 18-21 t family profile is used as a fallback.
   * Without any profile the caller caps at 5 m/s instead of trusting a guess.
   */
  private guardHardware(drone: DroneRow, massKg: number): ReturnType<typeof hardwareFrom> | null {
    const direct = hardwareFor(drone.prefab, drone.gridId, massKg).hardware;
    if (direct) return direct;
    if (massKg >= 15_000 && massKg <= 26_000) {
      return hardwareFrom({
        id: drone.gridId ?? drone.label,
        name: drone.label,
        massKg,
        massSource: 'measured',
        thrustN: { atmo: massKg > 19_500 ? 1_344_000 : 1_152_000, h2: 984_000, ion: 0 },
        batteryMWh: 2,
        batteryOutputMW: 8,
        h2TankLitres: 60_000,
        source: 'measured owner-satellite family profile (mass fallback for a cloned grid)',
      });
    }
    return null;
  }

  /**
   * Arming gate for the read-only monitors (`probe_ground`, `is_under_control`).
   *
   * A terminal mission keeps its `demo_exec`/`demo_drones` rows, and `tick()`
   * calls `stationPass()` for every exec row, so without this gate a mission
   * that is `done` re-armed the ground probe from its `holding` drone every
   * 10 s forever (measured in game: `demo:probe:<missionId>:<idx>:<epochMs>`).
   * Nothing is sent for a mission that is over: no mission row, a terminal
   * status, or an exec row that is no longer `running` disarms both probes.
   *
   * The first disarm is audited once (`demo_probe_disarm`) so the behaviour is
   * visible in the trail rather than a silent stop; the mission is forgotten on
   * re-arm so a later disarm is audited again.
   */
  private probeArmed(missionId: string): boolean {
    const mission = this.store().getMission(missionId);
    const exec = this.execs().find((e) => e.missionId === missionId);
    const missionStatus = mission?.status ?? 'missing';
    const execState = exec?.state ?? 'missing';
    const armed = Boolean(mission) && !TERMINAL_MISSION_STATUS.includes(missionStatus) && execState === 'running';
    if (armed) {
      this.disarmed.delete(missionId);
      return true;
    }
    if (!this.disarmed.has(missionId)) {
      this.disarmed.add(missionId);
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_probe_disarm',
        subject: missionId,
        detail: {
          missionStatus,
          execState,
          probes: ['ground', 'control'],
          note: 'mission is over: probe_ground and is_under_control are no longer sent',
        },
        at: this.now(),
      });
    }
    return false;
  }

  /**
   * Opportunistic terrain probe (never a descent dependency).
   *
   * The planet's surfaceRadius is not the voxel surface at BASE-01 (terrain is
   * ~1.8 km higher), so a `probe_ground` hit would refine the ground reference
   * — but on this build the probe cannot hit procedural planet terrain at all,
   * so it is fired from 120 m to the side of the ship (avoids the hull) and
   * only its HIT is used. Two consecutive misses back it off for two minutes
   * and are audited once, so a miss can neither block a descent nor fill the
   * audit trail. Results are matched from order_result audits, never the
   * pending order slot.
   */
  private refreshGround(drone: DroneRow, pos: Vec3, planet: ReturnType<typeof nearestPlanet>, now: number): void {
    const gs = this.guardState(drone);
    if (!this.probeArmed(drone.missionId)) {
      // A disarmed mission keeps no probe armed: drop the in-flight slot and the
      // 10 s window so a mission that is re-armed later is clean, not blocked.
      if (gs.probeId) this.probes.delete(gs.probeId);
      gs.probeId = null;
      gs.probeAt = 0;
      return;
    }
    if (gs.probeId) return;
    if (gs.probeMisses >= 2 && now - gs.probeMissAt < 120_000) return;
    if (now - gs.probeAt < 10_000 || !this.deps.hub.isConnected()) return;
    const frame = this.groundFrame(drone, pos, planet);
    if (!frame) return;
    // Below 60 m above the GROUND a sideways ray start may be inside terrain;
    // keep the last known ground instead. (True AGL: the terrain datum, not the
    // catalogue mean.)
    if (frame.altitudeAglM < 60) return;
    const up = frame.up;
    const tangent = norm(cross(up, { x: 0, y: 1, z: 0.31 }));
    const from = add(pos, tangent, 120);
    const orderId = `demo:probe:${drone.missionId}:${drone.idx}:${now}`;
    const wireType = this.orderChannel('probe_ground', now, drone.gridId ?? '');
    if (!wireType) return;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: drone.gridId,
      params: {
        action: 'probe_ground',
        entityId: drone.gridId,
        x: from.x,
        y: from.y,
        z: from.z,
        direction: { x: -up.x, y: -up.y, z: -up.z },
        length: 20_000,
      },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 20_000,
    };
    this.store().createOrder({
      orderId,
      missionId: drone.missionId,
      unitId: drone.gridId ?? 'grid:0',
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    gs.probeAt = now;
    if (this.deps.hub.send(payload)) {
      gs.probeId = orderId;
      this.probes.set(orderId, { key: this.guardKey(drone), gridId: drone.gridId ?? '' });
    }
  }

  private pollGroundProbes(now: number): void {
    if (this.probes.size === 0) return;
    for (const entry of this.store().listOrderResults(120)) {
      const detail = entry.detail as { eventType?: string; data?: { orderId?: string; result?: unknown } };
      if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result') continue;
      const orderId = detail.data?.orderId;
      if (!orderId) continue;
      const record = this.probes.get(orderId);
      if (!record) continue;
      const result = (detail.data?.result ?? {}) as {
        hit?: boolean;
        isGrid?: boolean;
        position?: Vec3;
      };
      const gs = this.guards.get(record.key);
      if (gs) {
        gs.probeId = null;
        if (result.hit && result.isGrid === false && result.position) {
          // A hit only refines the ground radius; a miss leaves the catalog
          // surface radius in place and is counted so the probe backs off.
          gs.groundHit = result.position;
          gs.probeMisses = 0;
        } else {
          gs.probeMisses += 1;
          gs.probeMissAt = now;
          if (gs.probeMisses === 1) {
            this.store().audit({
              actor: 'demo-executor',
              action: 'demo_ground_probe_miss',
              subject: `${record.gridId}`,
              detail: {
                orderId,
                hit: false,
                note:
                  'probe_ground did not hit terrain (procedural planet terrain cannot be ray-cast on this build); ' +
                  'altitude keeps using the terrain height field where it covers this column, and the catalogue mean radius otherwise. Nothing is blocked by this.',
              },
              at: now,
            });
          }
        }
      }
      this.probes.delete(orderId);
    }
  }

  /**
   * THE waypoint builder. Every `move` order the executor sends is built here,
   * so no code path can hand the SE autopilot a waypoint inside
   * CLIMB_MAX_ELEVATION_DEG of the vertical in either direction.
   *
   * Measured 2026-11-10: a waypoint straight up crawled (37.6 m/s peak then
   * decay), a waypoint straight below made the ship climb AWAY at 1.1-1.2 m/s,
   * and horizontal/diagonal legs flew at 20-99.9 m/s. A leg that would exceed
   * the ceiling is therefore re-aimed: the vertical part is kept and the
   * minimum horizontal offset that brings the leg to the ceiling is added
   * (a diagonal, which the hull flies). That is the same geometry as
   * `climbLadder`, applied to single legs that are not worth a ladder.
   *
   * The params object carries a symbol-keyed marker that `send` insists on for
   * every `move`; `JSON.stringify` drops symbol keys, so it never reaches the
   * plugin.
   */
  private buildMove(
    drone: DroneRow,
    now: number,
    from: Vec3,
    to: Vec3,
    up: Vec3,
    speed: number,
    options: {
      tag?: string;
      collisionAvoidance?: boolean;
      extra?: Record<string, unknown>;
      /**
       * Called when the 60 deg ceiling re-aims the leg. The caller needs to
       * know, because the clamped waypoint is NOT the destination: it is an
       * intermediate step at the slot's altitude and ~553 m to the side.
       */
      onClamp?: (info: { point: Vec3; elevationDeg: number; addedHorizontalM: number; verticalM: number }) => void;
    } = {},
  ): Record<string, unknown> {
    const verdict = waypointAngleVerdict({ from, to, up, intent: options.tag ?? 'move' });
    let point = to;
    if (!verdict.ok) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const vertical = dx * up.x + dy * up.y + dz * up.z;
      const horizontal = {
        x: dx - up.x * vertical,
        y: dy - up.y * vertical,
        z: dz - up.z * vertical,
      };
      const horizontalLength = Math.hypot(horizontal.x, horizontal.y, horizontal.z);
      // A deterministic side direction, so the same leg always re-aims the same
      // way (the audit and the tests see one answer).
      const axis = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const axisDot = axis.x * up.x + axis.y * up.y + axis.z * up.z;
      const side = norm({
        x: axis.x - up.x * axisDot,
        y: axis.y - up.y * axisDot,
        z: axis.z - up.z * axisDot,
      });
      const sideDirection =
        horizontalLength > 1
          ? { x: horizontal.x / horizontalLength, y: horizontal.y / horizontalLength, z: horizontal.z / horizontalLength }
          : side;
      const neededHorizontalM = Math.abs(vertical) / Math.tan((CLIMB_MAX_ELEVATION_DEG * Math.PI) / 180);
      point = {
        x: from.x + up.x * vertical + sideDirection.x * neededHorizontalM,
        y: from.y + up.y * vertical + sideDirection.y * neededHorizontalM,
        z: from.z + up.z * vertical + sideDirection.z * neededHorizontalM,
      };
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_move_angle_clamped',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          tag: options.tag ?? 'move',
          requested: to,
          sent: point,
          elevationDeg: verdict.elevationDeg,
          maxElevationDeg: CLIMB_MAX_ELEVATION_DEG,
          addedHorizontalM: Math.round(neededHorizontalM),
          note:
            `a ${Math.abs(verdict.elevationDeg).toFixed(1)} deg leg would ask the autopilot for a near-vertical ` +
            `waypoint it cannot fly (measured 2026-11-10); re-aimed to ${CLIMB_MAX_ELEVATION_DEG} deg with the same ` +
            'vertical drop',
        },
        at: now,
      });
      options.onClamp?.({
        point,
        elevationDeg: verdict.elevationDeg,
        addedHorizontalM: neededHorizontalM,
        verticalM: vertical,
      });
    }
    const params: Record<string, unknown> = {
      ...point,
      speed,
      collisionAvoidance: options.collisionAvoidance ?? true,
      ...(options.extra ?? {}),
    };
    (params as Record<PropertyKey, unknown>)[WAYPOINT_GUARDED] = verdict.elevationDeg;
    return params;
  }

  /**
   * SHIP-ROLE ENFORCEMENT AT THE SEND BOUNDARY (owner decision 2026-11-11).
   *
   * Every executor order — flight, staging, block props, station, laser, guard —
   * passes through this check, so no feature can route around the role:
   *
   *   OFF      -> no order at all, ever (only telemetry reads);
   *   PERSONAL -> automatic orders refused; only explicit owner flight orders
   *               on a mission the owner confirmed, plus stop/brake/hold;
   *   BASE     -> never moved; reads and safety orders only;
   *   MANAGED  -> everything (as before).
   *
   * Returns false when the order must not be sent (and audits once per action).
   */
  private roleGate(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    action: string,
    params?: Record<string, unknown>,
  ): boolean {
    if (!drone.gridId) return true;
    const res = shipRoles.resolution(drone.gridId);
    if (res.role === 'managed') return true;
    // The undo check is a read, and the manual-handoff rule needs it even on a
    // personal ship the owner just boarded.
    if (res.role === 'personal' && action === 'is_under_control') return true;
    const confirmed = this.personalConfirmed.has(exec.missionId);
    let intent = actionIntent(action, params);
    if (res.role === 'personal' && intent === 'automatic' && confirmed) intent = 'owner-order';
    const decision: RoleDecision = orderDecision(res, intent, { action, confirmPersonal: confirmed });
    if (decision.allowed) return true;
    const key = `${exec.missionId}:${drone.gridId}:${action}`;
    if (!this.roleRefused.has(key)) {
      this.roleRefused.add(key);
      this.store().audit({
        actor: 'demo-executor',
        action: 'role_refused',
        subject: drone.gridId,
        detail: {
          missionId: exec.missionId,
          drone: drone.idx,
          action,
          role: decision.role,
          roleSource: decision.roleSource,
          code: decision.code ?? null,
          reason: decision.reason,
          note: 'no order was sent to the plugin',
        },
        at: now,
      });
    }
    this.setState(drone, drone.state, now, `role: ${decision.reason}`);
    return false;
  }

  /** One audit row per (mission, grid, action) refusal. */
  private readonly roleRefused = new Set<string>();

  /** Fire-and-forget order outside the single pending slot (guards/staging). */
  private sendRaw(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    orderType: 'hold' | 'stop' | 'test',
    params: Record<string, unknown>,
    tag: string,
  ): boolean {
    if (this.store().isKillSwitchOn() || !drone.gridId) return false;
    const rawAction = orderType === 'test' ? String(params.action ?? '') : orderType;
    if (!this.roleGate(exec, drone, now, rawAction, params)) return false;
    if (!this.deps.hub.isConnected()) return false;
    const orderId = `demo:guard:${exec.missionId}:${drone.idx}:${tag}:${now}`;
    // A `test`/`action` order carries its own action name (e.g. `land_ground`);
    // a hold/stop's action IS the order type.
    const action = orderType === 'test' ? String(params.action ?? '') : orderType;
    // T75: a legitimate action is sent on the production channel in every
    // build; admin/unknown test traffic is refused here in survival mode.
    const decision = decideOrderChannel(orderType, action, this.survivalMode);
    if (decision.refused) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'survival_refused',
        subject: drone.gridId,
        detail: { action, orderType, reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
        at: now,
      });
      this.setState(drone, drone.state, now, `survival mode: ${action} refused`);
      return false;
    }
    const wireType = decision.orderType;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: drone.gridId,
      params:
        wireType === 'test' || wireType === 'action'
          ? { action, entityId: drone.gridId, ...params }
          : { action: orderType, ...params },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: drone.gridId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: sent ? 'demo_guard_order_sent' : 'demo_guard_order_failed',
      subject: orderId,
      detail: { missionId: exec.missionId, drone: drone.idx, gridId: drone.gridId, orderType: wireType, tag },
      at: now,
    });
    return sent;
  }

  /**
   * T75: channel for a standalone test-action payload. Legitimate actions go
   * out as `action` in every build; an admin/unknown action in survival mode is
   * audited and refused (null) instead of reaching the plugin.
   */
  private orderChannel(action: string, at: number, subject: string): string | null {
    const decision = decideOrderChannel('test', action, this.survivalMode);
    if (!decision.refused) return decision.orderType;
    this.store().audit({
      actor: 'demo-executor',
      action: 'survival_refused',
      subject,
      detail: { action, orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at,
    });
    return null;
  }

  /**
   * Keep a cone-clamped waypoint as an INTERMEDIATE step of the leg (2026-11-11).
   *
   * `buildMove` never asks the autopilot for a leg steeper than 60 deg, so a
   * near-vertical leg is re-aimed to a point `|vertical| / tan(60)` metres
   * tangentially away — measured 553 m on the re-issued descent. That point is
   * at the slot's own altitude, so flying it as the destination left the ship
   * descending over the wrong column. Recorded here so the en-route tick can
   * fly the real slot column next (a lateral leg) instead.
   */
  private noteConeClamp(
    drone: DroneRow,
    now: number,
    gs: GuardState,
    previousSteps: number,
    info: { point: Vec3; elevationDeg: number; addedHorizontalM: number; verticalM: number },
    tag: string,
  ): void {
    const steps = previousSteps + 1;
    if (info.addedHorizontalM < CONE_STEP_MIN_HORIZONTAL_M) {
      // A small re-aim (a final settle, a terminal nudge): the arrival logic
      // owns those metres, exactly as before.
      return;
    }
    if (steps > CONE_STEP_MAX) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_leg_cone_step_giveup',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          tag,
          steps,
          elevationDeg: info.elevationDeg,
          addedHorizontalM: Math.round(info.addedHorizontalM),
          note: 'the leg keeps re-aiming onto the cone after the step cap; the arrival guard reports it',
        },
        at: now,
      });
      return;
    }
    gs.coneStep = { point: info.point, steps };
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_leg_cone_step',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        tag,
        step: steps,
        of: CONE_STEP_MAX,
        elevationDeg: info.elevationDeg,
        verticalM: Math.round(info.verticalM),
        addedHorizontalM: Math.round(info.addedHorizontalM),
        conePoint: info.point,
        target: drone.execSlot,
        note:
          `a ${Math.abs(info.elevationDeg).toFixed(1)} deg leg was re-aimed onto the ` +
          `${CLIMB_MAX_ELEVATION_DEG} deg cone; the clamped point is an INTERMEDIATE step, then the leg to the ` +
          'requested column is flown',
      },
      at: now,
    });
  }

  /** Re-issue a move at the guard's SpeedLimit and force collision avoidance ON. */
  private sendMoveAt(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    speed: number,
    verdict: FlightGuardVerdict,
  ): void {
    if (!drone.gridId) return;
    const gate = this.gateFor(drone, now);
    if (!gate.allowed) return;
    const unit = this.store().getUnit(drone.gridId);
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    const gs = this.guardState(drone);
    const from = unit?.pos ?? drone.execSlot;
    const frame = unit?.pos && planet ? this.groundFrame(drone, unit.pos, planet) : null;
    // Near-vertical re-issue (2026-11-11): `buildMove` re-aims the leg onto the
    // 60 deg cone, and that clamped point is ~553 m to the SIDE at the slot's
    // altitude. Sending it and calling the leg done put the ship over the wrong
    // column, descending off-column. Keep it as an intermediate step and let
    // the en-route tick fly the real slot column next.
    const previousConeSteps = gs.coneStep?.steps ?? 0;
    gs.coneStep = null;
    this.send(
      exec,
      drone,
      now,
      'move',
      drone.gridId,
      'move',
      this.buildMove(drone, now, from, drone.execSlot, frame?.up ?? norm(from), speed, {
        tag: 'guard-throttle',
        onClamp: (info) => this.noteConeClamp(drone, now, gs, previousConeSteps, info, 'guard-throttle'),
      }),
      gate,
    );
    this.enforceCollisionAvoidance(exec, drone, now, speed);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_guard_throttle',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, speed, ...verdict },
      at: now,
    });
    drone.reason = `guard: ${speed.toFixed(1)} m/s (${verdict.code})`;
    this.saveDrone(drone);
  }

  /**
   * The plugin's move action turns collision avoidance off (it can fight a
   * waypoint). The guard re-enables it immediately after every move resend via
   * the same terminal property the provisioner uses, and audits the write.
   */
  private enforceCollisionAvoidance(exec: ExecRow, drone: DroneRow, now: number, speed: number): void {
    this.setCollisionAvoidance(exec, drone, now, true, `move at ${speed} m/s`);
  }

  private setCollisionAvoidance(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    on: boolean,
    reason: string,
    /**
     * Dampeners state to write alongside collision avoidance. `undefined`
     * leaves the property alone. It used to be hard-coded `true`, which meant
     * every guard tick re-enabled dampeners and cancelled a controlled fall:
     * the ship hovered forever with the fall phase no-op'ing.
     */
    dampeners?: boolean,
  ): void {
    if (!drone.gridId) return;
    const orderId = `demo:guard:ca:${exec.missionId}:${drone.idx}:${now}`;
    const wireType = this.orderChannel('set_block_props', now, drone.gridId);
    if (!wireType) return;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: drone.gridId,
      params: {
        action: 'set_block_props',
        entityId: drone.gridId,
        filter: { type: 'RemoteControl' },
        props: dampeners === undefined
          ? { CollisionAvoidance: on }
          : { CollisionAvoidance: on, DampenersOverride: dampeners },
      },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: drone.gridId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_guard_collision_avoidance',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, on, reason, sent },
      at: now,
    });
  }

  private abortFlight(exec: ExecRow, drone: DroneRow, now: number, verdict: FlightGuardVerdict): void {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const remaining = unit?.pos ? dist(unit.pos, drone.execSlot) : null;
    const speed = unit?.vel ? len(unit.vel) : 0;
    this.recordLegResult(drone, now, remaining, speed, `aborted:${verdict.code}`);
    const text = this.postmortemText(drone, `aborted by the ${verdict.code} guard`, verdict.reason);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_flight_abort',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, ...verdict, text },
      at: now,
    });
    this.store().addAlert({
      kind: 'flight_abort',
      message: `${drone.label}: ${verdict.reason ?? verdict.code}`,
      missionId: exec.missionId,
      at: now,
    });
    this.postMortem(drone, now, text);
    this.setState(drone, 'aborted', now, verdict.reason ?? `guard ${verdict.code}`);
  }

  /** Plain-language post-mortem written to the mission and the audit trail. */
  private postmortemText(drone: DroneRow, what: string, reason: string | null): string {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const gs = this.guardState(drone);
    const v = gs.lastVerdict;
    const speed = unit?.vel ? len(unit.vel) : 0;
    const remaining = unit?.pos ? dist(unit.pos, drone.execSlot) : null;
    return (
      `${drone.label}: flight ${what}. ${reason ?? 'No further detail was reported.'} ` +
      `At the decision the ship was ${speed.toFixed(1)} m/s, ` +
      `${remaining === null ? 'position unknown' : `${remaining.toFixed(0)} m from its slot`}, ` +
      `${v ? `${v.altitudeAglM.toFixed(0)} m above the probed ground` : 'altitude unknown'} ` +
      `(braking distance ${v?.brakingDistanceM ?? '?'} m, hull decel ${v?.availableDecelMps2 ?? '?'} m/s²). ` +
      `Action: ${what.includes('thrust') ? 'autopilot stopped' : 'held at the current position'}. ` +
      `Next: check the ship in game, refuel/repair if needed, then re-plan the leg; the guards will re-check it.`
    );
  }

  private postMortem(drone: DroneRow, now: number, text: string): void {
    const gs = this.guardState(drone);
    if (gs.postmortem) return;
    gs.postmortem = true;
    try {
      const mission = this.store().getMission(drone.missionId);
      if (mission) {
        const previous = mission.plan.notes ? `${mission.plan.notes}\n` : '';
        const notes = `${previous}${new Date(now).toISOString()} ${text}`.slice(-3_900);
        this.store().updateMission(drone.missionId, { plan: { ...mission.plan, notes } }, now);
      }
    } catch {
      // The audit row below is the durable record; notes are best effort.
    }
    this.store().setKv(`demo:postmortem:${drone.missionId}:${drone.idx}`, text);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_flight_postmortem',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, text },
      at: now,
    });
  }

  private sendMove(exec: ExecRow, drone: DroneRow, now: number): void {
    if (!drone.gridId) return this.fail(drone, now, 'no grid id for move');
    if (this.flightPaused(drone, now)) return;
    // Load cap: more simultaneous climbs than this pull SimSpeed under the
    // owner's floor. A drone that cannot take a slot stays in `securing` and is
    // retried every tick, so it launches as soon as one arrives.
    const cap = this.climbCap();
    if (cap > 0) {
      const climbing = this.climbingCount();
      if (climbing >= cap) {
        this.setState(
          drone,
          'securing',
          now,
          `QUEUED: climb cap ${cap} reached (${climbing} climbing); waits for a free climb slot`,
        );
        return;
      }
    }
    const gate = this.gateFor(drone, now);
    if (!gate.allowed) {
      if (this.waitForLink(drone, now, gate)) return;
      this.fail(drone, now, `move denied by comms gate ${gate.source}: ${gate.reason}`);
      return;
    }
    drone.gateWaits = 0;
    const unit = this.store().getUnit(drone.gridId);
    const left = unit?.pos ? dist(unit.pos, drone.execSlot) : 0;
    // Contract §3: one profile per leg. The speed in the single move order is
    // the cruise the brake maths allows; a short leg gets a lower one, a long
    // vacuum leg coasts at the cap with dampeners off.
    const profile = unit ? this.legProfileFor(drone, unit, now) : null;
    // No profile means no live position to measure a leg from (left = 0); the
    // old 1/5/20/60 ladder applied the terminal caps out to 300 m. Use the same
    // braking formula as the profile instead, with the conservative unknown-hull
    // deceleration, so the taper lives only where the maths puts it.
    const speed = capPassengerSpeed(
      profile?.vCruiseMps ??
        Math.max(
          1,
          Math.round(
            safeApproachSpeedMps(
              Math.max(0.1, left),
              UNKNOWN_HULL_BRAKE_MPS2,
              this.deps.config.demo.speedLimitMps,
            ) * 10,
          ) / 10,
        ),
      this.passengerLimitsFor(drone, unit),
    );
    // T52: a long descent in gravity starts with a measurement, not a move.
    // Nothing is commanded until the plugin has reported per-thruster axes, so
    // the fall decision can never be based on an assumed lift.
    if (unit && this.beginDescentMeasure(exec, drone, unit, now)) return;
    this.dispatchLegMove(exec, drone, now, speed, profile, gate, unit);
  }

  /** Send the one move for a dampened/horizontal leg and record its profile. */
  private dispatchLegMove(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    speed: number,
    profile: LegProfile | null,
    gate: CommsGate,
    unit: ReturnType<Store['getUnit']>,
  ): void {
    if (!drone.gridId) return;
    // Ground datum rule for the hold point (2026-11-10 crash): with the real
    // ground known (terrain field or probe) a slot below it is inside the hill
    // and cannot be reached at any speed — refuse and hold instead of planning
    // a leg to it. With only the catalogue mean the descent rule owns the
    // uncertain band; an ordinary low leg stays flyable.
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    const frame = unit?.pos ? this.groundFrame(drone, unit.pos, planet) : null;
    const gs = this.guardState(drone);
    // The COME-TO-ME hold floor (owner decision 2026-11-11) is 80 m of hull
    // bottom, not the station's 100 m. It only applies to a hover that was
    // PLANNED at >= 80 m: a mission that explicitly asked for less keeps its
    // own number and is not retro-fitted with a stricter rule.
    const comeToMe = this.comeToMeOf(drone.missionId);
    const plannedHoverAglM = Number(comeToMe?.hoverAglM ?? NaN);
    const comeToMeFloorM =
      comeToMe && Number.isFinite(plannedHoverAglM) && plannedHoverAglM >= COME_TO_ME_HOLD_FLOOR_M
        ? COME_TO_ME_HOLD_FLOOR_M
        : null;
    // The slot is judged on the datum it was BUILT with (2026-11-11): the hover
    // point carries the ground radius `comeToMe` sampled (level-5 where it
    // exists), and the same column re-sampled through a cold second cache read
    // 27 m higher, turning an 80 m clearance into 59 m and refusing a legal
    // hover. The shared sampler in `ground.ts` makes the two agree; this keeps
    // the recorded datum authoritative for the mission's own slot either way,
    // and the audit names which datum decided.
    const frameSlotAgl = frame?.targetAglM ?? null;
    const recordedGroundM = Number(comeToMe?.groundRadiusM ?? NaN);
    // Only when this tick's slot sample is COARSER than the one the point was
    // built with: a finer, fresher sample (level 3+) always wins, so a hill that
    // really rose under the hover is still refused.
    const frameSlotFine = (frame?.targetGroundLevel ?? 0) >= FINE_TERRAIN_MIN_LEVEL;
    const useRecordedDatum = Number.isFinite(recordedGroundM) && recordedGroundM > 1 && comeToMe !== null && !frameSlotFine;
    const slotAglM = useRecordedDatum
      ? hullBottomAglM(
          len(sub(drone.execSlot, vec(planet?.center) ?? { x: 0, y: 0, z: 0 })) - recordedGroundM,
          this.keelFor(drone).keelM,
        )
      : frameSlotAgl;
    const datumMismatchM =
      frameSlotAgl !== null && slotAglM !== null ? Math.round((frameSlotAgl - slotAglM) * 10) / 10 : null;
    // 1 m of tolerance: the hover point is built AT the floor, so a terrain
    // sample a metre off must not refuse the leg it was planned from.
    const belowComeToMeFloor =
      comeToMeFloorM !== null && slotAglM !== null && slotAglM < comeToMeFloorM - 1;
    if (frame && frame.reason === null && frame.source !== 'mean' && (frame.targetPositionAglM < 0 || belowComeToMeFloor)) {
      // A LANDING's slot IS the ground point (`landingSlotFor` pushes it out to
      // the terrain radius on the target bearing), so its AGL is ~0 or a few
      // metres negative from the column misfit between the ship and the target
      // — the slot working as designed, not a waypoint inside a hill. The
      // ground that matters is the SHIP's own column, which the frame already
      // measured; the landing phases own the approach from here. An ordinary
      // hold with a slot below the terrain is still refused below.
      if (drone.landing !== null) {
        if (!gs.landingSlotGround) {
          gs.landingSlotGround = true;
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_landing_slot_ground',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              targetPositionAglM: Math.round(frame.targetPositionAglM),
              altitudeAglM: Math.round(frame.altitudeAglM),
              groundRadiusM: Math.round(frame.groundRadiusM),
              groundSource: frame.source,
              note:
                'landing slot accepted as the ground point: the hull is measured on its OWN column, so a slot a few ' +
                'metres below that datum is the point it is landing on, not a waypoint inside terrain',
            },
            at: now,
          });
        }
      } else {
        this.refuseHoldGround(exec, drone, now, frame, comeToMeFloorM ?? GROUND_CLEARANCE_M, {
          slotAglM,
          datumMismatchM,
          datumSource: useRecordedDatum ? `mission-recorded ${comeToMe?.groundSource ?? 'terrain'}` : `frame ${frame.source}`,
        });
        return;
      }
    }
    gs.climb = null;
    let movePoint: Vec3 = drone.execSlot;
    // Near-vertical climb (measured 2026-11-10): a leg steeper than 60 deg above
    // the horizon is flown as a ladder of shallower waypoints. The previous
    // single 120 m dogleg left 1 552 m of a 1 672 m climb at 85.6 deg, which is
    // exactly where the autopilot crawls.
    if (!drone.landing && unit?.pos && frame) {
      const ladder = climbLadder(unit.pos, drone.execSlot, frame.up);
      if (ladder && ladder.waypoints.length > 0) {
        const first = ladder.waypoints[0]!;
        movePoint = first;
        gs.climb = { ladder, index: 0 };
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_leg_climb_ladder',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            verticalM: Math.round(ladder.verticalM),
            steps: ladder.waypoints.length,
            maxElevationDeg: ladder.maxElevationDeg,
            legs: ladder.legs,
            first,
            target: drone.execSlot,
            note:
              `near-vertical leg ${Math.round(ladder.verticalM)} m: flown as ${ladder.waypoints.length} waypoints, ` +
              `steepest ${ladder.maxElevationDeg} deg above the horizon, so no leg asks the autopilot for a ` +
              'waypoint near the local up vector',
          },
          at: now,
        });
      }
    }
    const passengerLimitsHere = this.passengerLimitsFor(drone, unit);
    const moveFrom = unit?.pos ?? drone.execSlot;
    // A near-vertical DESCENT is clamped onto the 60 deg cone too (the ladder
    // only builds climbs): the clamped point is an intermediate step, and the
    // leg to the requested column follows it (2026-11-11).
    gs.coneStep = null;
    this.send(
      exec,
      drone,
      now,
      'move',
      drone.gridId,
      'move',
      this.buildMove(drone, now, moveFrom, movePoint, frame?.up ?? norm(moveFrom), speed, {
        tag: 'leg',
        onClamp: (info) => this.noteConeClamp(drone, now, gs, 0, info, 'leg'),
      }),
      gate,
    );
    this.enforceCollisionAvoidance(exec, drone, now, speed);
    gs.speedLimit = speed;
    gs.lastResendAt = now;
    gs.needsMove = false;
    gs.legProfile = profile;
    gs.legStartedAt = now;
    gs.predictedEtaS = profile?.etaS ?? null;
    gs.predictedFuelL = profile?.fuelL ?? null;
    gs.fuelAtStart = Number((unit?.meta as { fuelFraction?: number } | undefined)?.fuelFraction ?? 0);
    gs.dampenersOff = false;
    gs.dampenersOnAt = null;
    gs.descent = null;
    // A new leg gets fresh arrival bookkeeping: swings and a speed shortfall
    // from the previous leg must not abort this one.
    gs.arrival = emptyArrivalProgress();
    gs.lastRemaining = null;
    gs.awayTicks = 0;
    if (profile) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_leg_profile',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: { gridId: drone.gridId, ...profile },
        at: now,
      });
      // Vacuum cruise: dampeners off so the ship coasts between the burns.
      // T61: never with people aboard who are not flying the ship - a released
      // dampener in vacuum is a hull that will not stop itself.
      if (profile.dampeners === 'off' && !gs.dampenersOff) {
        const limits = passengerLimitsHere;
        if (limits && !limits.allowDampenersOff) {
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_passenger_dampeners',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: {
              gridId: drone.gridId,
              names: limits.names,
              refused: 'dampeners-off vacuum cruise',
              line: describePassengers(limits),
            },
            at: now,
          });
          this.setDampeners(exec, drone, now, true, 'passengers aboard: cruise stays dampened');
          gs.dampenersOff = false;
        } else {
          this.setDampeners(exec, drone, now, false, `vacuum cruise ${profile.vCruiseMps} m/s`);
          gs.dampenersOff = true;
        }
      }
    }
    this.setState(
      drone,
      'en_route',
      now,
      `move sent to scaled slot at ${speed} m/s (${gate.source} gate; ` +
        `${profile?.flightMode ?? 'OneWay'}, dampeners ${profile?.dampeners === 'off' && !passengerLimitsHere ? 'off' : 'on'}, ` +
        `eta ${profile ? Math.round(profile.etaS) : '?'} s)` +
        (passengerLimitsHere ? `; carrying ${passengerLimitsHere.names.join(', ')}` : ''),
    );
  }

  /**
   * Hold a landing on the datum rule (2026-11-11 flight set 6, defect b).
   *
   * Returns true when the caller must not plan anything this tick (waiting for
   * the finer sample, or the landing was refused with a reason).
   *
   * Two jobs:
   *  1. REFINE the slot. `landingSlotFor` pushes the slot out to the radius
   *     known when the mission was created. On a cold column that is the
   *     level-0 planning field, measured 47 m under the real terrain here: the
   *     leg then flies a plain move to a point inside the hill, crawls and
   *     trips `guard-stuck`. As soon as a landing-grade sample exists at the
   *     slot's column the slot is moved ONTO it (tangential position unchanged,
   *     so the column the order names never moves), audited old -> new.
   *  2. WAIT, then REFUSE. While the slot has only a planning-grade datum but
   *     the hull's own column already reads landing grade, the target datum is
   *     demonstrably worse than a number this ship has measured — so the fine
   *     read is awaited for `LANDING_SLOT_DATUM_WAITS` ticks and the landing is
   *     then refused with the two numbers, never flown onto a datum that sits
   *     under the ground. When NO column has a fine sample (a level-0 world)
   *     the old, bounded, LABELLED coarse path is unchanged: a descent must
   *     never wait on terrain indefinitely.
   */
  private landingSlotDatumGate(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    planet: NonNullable<ReturnType<typeof nearestPlanet>>,
    gs: GuardState,
    now: number,
    frame: { altitudeAglM: number; groundRadiusM: number; source: AltitudeSource },
  ): boolean {
    const slot = this.terrainRadiusAt(planet, drone.execSlot);
    if (slot && isLandingGrade(slot.level)) {
      gs.slotDatumWaits = 0;
      const centre = vec(planet.center);
      const up = centre ? this.upAt(planet, drone.execSlot) : null;
      if (!centre || !up) return false;
      const radius = len(sub(drone.execSlot, centre));
      if (Math.abs(radius - slot.radiusM) >= LANDING_SLOT_DATUM_MIN_FIX_M) {
        const refined: Vec3 = {
          x: centre.x + up.x * slot.radiusM,
          y: centre.y + up.y * slot.radiusM,
          z: centre.z + up.z * slot.radiusM,
        };
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_slot_datum',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            action: 'refined',
            fromRadiusM: Math.round(radius * 10) / 10,
            toRadiusM: Math.round(slot.radiusM * 10) / 10,
            deltaM: Math.round((slot.radiusM - radius) * 10) / 10,
            level: slot.level,
            source: slot.source,
            note:
              `the landing slot was pushed out on a coarser datum; it now sits on the ${slot.source} sample at the ` +
              'same column, so the leg flies to the real ground point instead of a point inside the hill',
          },
          at: now,
        });
        drone.execSlot = refined;
        this.saveDrone(drone);
      }
      return false;
    }
    // The slot has no landing-grade sample. Is there a better one under the
    // hull? If so this landing's datum is knowably wrong, not merely unknown.
    const shipGround = this.terrainRadiusAt(planet, unit.pos ?? drone.execSlot);
    if (!shipGround || !isLandingGrade(shipGround.level)) {
      gs.slotDatumWaits = 0;
      return false;
    }
    gs.slotDatumWaits = (gs.slotDatumWaits ?? 0) + 1;
    if (gs.slotDatumWaits > LANDING_SLOT_DATUM_WAITS) {
      const slotRadius = slot ? slot.radiusM : null;
      const belowM = slotRadius === null ? shipGround.radiusM : shipGround.radiusM - slotRadius;
      const reason =
        `the landing column's ground is only planning grade (level ${slot?.level ?? 'none'}` +
        `${slotRadius === null ? '' : ', ' + Math.round(slotRadius * 10) / 10 + ' m'}) after ` +
        `${gs.slotDatumWaits - 1} s, while this hull's column reads landing grade (level ${shipGround.level}, ` +
        `${Math.round(shipGround.radiusM * 10) / 10} m = ${Math.round(belowM)} m higher): refusing to fly the descent ` +
        'onto a datum that sits under the measured ground';
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_slot_datum',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          action: 'refused',
          slotLevel: slot?.level ?? null,
          slotRadiusM: slotRadius === null ? null : Math.round(slotRadius * 10) / 10,
          shipLevel: shipGround.level,
          shipRadiusM: Math.round(shipGround.radiusM * 10) / 10,
          belowM: Math.round(belowM * 10) / 10,
          waits: gs.slotDatumWaits - 1,
          reason,
        },
        at: now,
      });
      this.refuseLanding(
        exec,
        drone,
        unit,
        gs,
        { now, altitudeAgl: frame.altitudeAglM, groundSource: frame.source, groundRadiusM: frame.groundRadiusM, planet },
        reason,
      );
      return true;
    }
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_slot_datum_wait',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        slotLevel: slot?.level ?? null,
        shipLevel: shipGround.level,
        wait: gs.slotDatumWaits,
        of: LANDING_SLOT_DATUM_WAITS,
        note:
          'the landing column has only a planning-grade ground sample while the hull column reads landing grade: ' +
          'the level-5 read is in flight and no leg is flown until it lands',
      },
      at: now,
    });
    return true;
  }

  /**
   * A `land:true` mission that is already at/near its slot still LANDS
   * (2026-11-11 flight set 6, defect c).
   *
   * Measured 2f: a hull 9 m above its own column with `land:true` got one
   * `move` and a `hold` in 1.3 s and never handed over, because the descent
   * planner returned "already low, the dampened leg owns it" and the generic
   * arrival logic then treated the ground point as arrived. So a low landing
   * enters the SAME sequence every other landing uses: the lateral leg onto the
   * requested column when one is needed, the settle, then `land_at` — or the
   * backend's dampened approach when the plugin has no land controller.
   */
  private startLowLanding(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    gs: GuardState,
    now: number,
    frame: { altitudeAglM: number; targetGroundRadiusM: number; source: AltitudeSource; groundRadiusM: number },
  ): boolean {
    const intent = drone.landing;
    if (!intent) return false;
    const aglM = Math.max(0, frame.altitudeAglM);
    const approachMps = Math.max(1, Math.min(5, Math.round(this.deps.config.demo.speedLimitMps)));
    const profile: LandingProfile = {
      ok: true,
      reason: `low landing: the hull is ${Math.round(aglM)} m hull-bottom AGL, already inside the brake drop, so the landing runs from here`,
      flareAglM: Math.max(1, Math.round(aglM)),
      handoverAglM: Math.max(1, Math.round(aglM)),
      brakeStopAglM: 0,
      flareDecelMps2: 0,
      brakeShedMps2: 0,
      entryDescentMps: 0,
      stopDistanceM: 0,
      maxFallMps: approachMps,
      approachMps,
      finalMps: LANDING_FINAL_DESCENT_MPS,
    };
    const mechanism = this.finalDescentMechanism(drone, profile);
    const keelM = this.keelFor(drone).keelM;
    gs.descent = {
      phase: 'braking',
      probeId: null,
      probeAt: now,
      plan: null,
      normalProfile: null,
      rejected: null,
      startedAt: now,
      groundSource: frame.source,
      planGroundRadiusM: frame.groundRadiusM,
      altitudeAglM: Math.round(aglM),
      targetAglM: Math.round(hullBottomAglM(len(drone.execSlot) - frame.targetGroundRadiusM, keelM)),
      landing: { phase: mechanism === 'plugin-land' ? 'plugin-land' : 'approach', plan: profile },
    };
    gs.landingOrderAt = now;
    gs.landingIdleAt = null;
    gs.landingIdleAglM = null;
    gs.approach = { lastAglM: aglM, atMs: now };
    gs.speedLimit = approachMps;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_low',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        mechanism,
        altitudeAglM: Math.round(aglM),
        minBrakeDropM: LANDING_MIN_BRAKE_DROP_M,
        approachMps,
        groundSource: frame.source,
        note:
          `the hull is already below the ${LANDING_MIN_BRAKE_DROP_M} m brake drop, so the landing starts where it is ` +
          '(lateral leg if one is needed, then the settle, then the final descent) instead of only moving and holding',
      },
      at: now,
    });
    if (mechanism === 'plugin-land') {
      if (!this.startLandingLateralLegIfNeeded(exec, drone, gs, now, profile)) {
        this.handOverToPluginLand(exec, drone, gs, now, profile);
      }
      return true;
    }
    // The backend owns the last metres: autopilot off and dampeners on, then
    // `advanceLandingApproach` flies the dampened descent with its own rules.
    this.stopAutopilot(exec, drone, now, 'low landing: autopilot off');
    this.setDampeners(exec, drone, now, true, 'low landing: dampeners on');
    this.setState(
      drone,
      'en_route',
      now,
      `landing from ${Math.round(aglM)} m hull-bottom AGL (already inside the brake drop): dampened final descent`,
    );
    return true;
  }

  /**
   * T52: start a controlled fall for a long gravity descent. The first step is
   * a read-only `inspect` (per-thruster axisWorld): upward thrust must be
   * measured, never assumed. If the leg is not a descent, or the grid is
   * piloted, or the reserve is short, this returns false and the caller flies
   * today's dampened move instead.
   *
   * The altitude is measured from TELEMETRY (overnight run 2026-11-10,
   * FAILURE 1): AGL = |position - planetCentre| - groundRadius, with the ground
   * radius from the terrain height field at this column (the catalogue mean is
   * 1 616.7 m below the real ground here), else a probe hit, else the mean. A
   * target inside the ground, or inside the band the terrain could occupy when
   * only the mean is known, is refused outright. The old
   * qualification leaned on `probe_ground` for a ground radius and, because
   * that probe cannot hit procedural planet terrain on this build, the descent
   * never started (SAT-R-0002 sat at 5 000 m for 360 s). A missing planet or
   * missing position now flies the dampened leg with the reason recorded,
   * never a hang.
   */
  private beginDescentMeasure(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    now: number,
  ): boolean {
    if (!drone.gridId || !unit.pos) return false;
    // Manual silence wins, even if a tick slips past controlPass.
    if (this.controls.isManual(drone.gridId)) return false;
    // T61: no ballistic free-fall phase with a passenger (or a standing player)
    // aboard. The dampened descent flies it instead; the reason is audited once
    // per mission:drone so a long descent does not write a row every second.
    const passengerLimits = this.passengerLimitsFor(drone, unit);
    if (passengerLimits && !passengerLimits.allowFreeFall) {
      const key = `${drone.missionId}:${drone.idx}:descent`;
      if (!this.passengerDescentAudited.has(key)) {
        this.passengerDescentAudited.add(key);
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_descent_passengers',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            names: passengerLimits.names,
            standing: passengerLimits.standing,
            refused: 'controlled fall (dampeners off)',
            chosen: 'dampened descent (autopilot move with dampeners on)',
            line: describePassengers(passengerLimits),
          },
          at: now,
        });
      }
      drone.reason = 'descent: dampened (passengers aboard: no free fall)';
      this.saveDrone(drone);
      return false;
    }
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit.pos);
    if (!planet) return false;
    const gs = this.guardState(drone);
    const frame = this.groundFrame(drone, unit.pos, planet);
    // No usable telemetry frame: record why the fall is not planned (only when
    // the leg actually looks like a descent) and let the caller fly the
    // dampened descent. Never wait for a measurement that cannot arrive.
    // "Looks like a descent" is measured toward the planet centre, which is
    // known even when the AGL is not.
    if (!frame || frame.reason) {
      const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
      const closingOnCentre =
        len(sub(unit.pos, centre)) - len(sub(drone.execSlot, centre));
      if (closingOnCentre >= DESCENT_MIN_DROP_M) {
        this.rejectDescent(
          exec,
          drone,
          now,
          `${frame?.reason ?? 'no position telemetry for this grid'}: altitude AGL cannot be computed, so the controlled fall is not planned`,
        );
      }
      return false;
    }
    // The catalogue mean, falling back to the nearest planet's radius: a mean
    // of 0 m would make the refusal sentence invent a delta of tens of km.
    const surface = Number(planet?.surfaceRadiusM ?? 0) || Number(nearestPlanet(unit.pos)?.surfaceRadiusM ?? 0) || 0;
    const groundRadius = frame.groundRadiusM;
    const altitudeAgl = frame.altitudeAglM;
    const landing = drone.landing !== null;
    // ------------------------------------------------------- landing datum gate
    // (2026-11-11 flight set 6, defect b: the coarse slot datum.)
    //
    // A `land:true` target's slot is the GROUND POINT under the plan slot, and
    // `landingSlotFor` pushes it out to whatever radius was known at mission
    // creation. On the level-0 planning field that was 47 m UNDER the real
    // terrain: the executor then flew a plain 5 m/s move to an underground
    // point, the hull crawled 17 m and `guard-stuck` held it, and no landing
    // ever happened. The handover already refuses to measure a descent on a
    // planning-grade datum; the SLOT must be held to the same rule.
    if (landing) {
      const gated = this.landingSlotDatumGate(exec, drone, unit, planet, gs, now, frame);
      if (gated) return true;
    }
    // Landing mode (owner request, 2026-11-10): the slot is the GROUND POINT,
    // so the target AGL is negative by construction. The ground datum rule that
    // guards ordinary descents does not apply to it — the landing has its own
    // rule, which is stricter: NO fall of any kind unless the ground is known
    // from the terrain field or a probe hit (see the measure handler).
    if (!landing) {
      // Air-breathing brake authority only: a vacuum planet keeps the normal
      // dampened descent (no controlled fall to plan).
      if (!planet.hasAtmosphere) return false;
      // Above the atmosphere there is no measured lift to scale and the leg
      // keeps the normal profile.
      if (altitudeAgl > atmosphereTopAltitudeM(planet)) return false;
    }
    const targetAgl = frame.targetAglM;
    const drop = altitudeAgl - targetAgl;
    if (!landing && !(drop >= DESCENT_MIN_DROP_M)) return false;
    if (landing && !(altitudeAgl > LANDING_MIN_BRAKE_DROP_M)) {
      // Already below the flare (2026-11-11 flight set 6, defect c). This used
      // to `return false`, i.e. "the dampened leg owns it" — so a `land:true`
      // mission that started at/near its own slot flew one `move` and a `hold`
      // in 1.3 s and NEVER landed (measured: 9 m AGL over its own column).
      // A landing that is already low still runs the landing sequence: the
      // lateral leg onto the column if one is needed, the settle, then
      // `land_at` (or the backend's dampened approach without a land
      // controller).
      return this.startLowLanding(exec, drone, unit, gs, now, frame);
    }
    // The fall has no lateral thrust: a leg with a big side offset keeps the
    // normal 3D move, otherwise the final approach would crawl sideways.
    const slant = dist(unit.pos, drone.execSlot);
    const horizontalM = Math.sqrt(Math.max(0, slant * slant - drop * drop));
    if (horizontalM > DESCENT_MAX_HORIZONTAL_M) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_descent_rejected',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          reason: `horizontal offset ${Math.round(horizontalM)} m exceeds the ${DESCENT_MAX_HORIZONTAL_M} m vertical-fall corridor`,
          dropM: Math.round(drop),
        },
        at: now,
      });
      return false;
    }
    // Ground datum rule (the 2026-11-10 crash): the brake point must sit at
    // least GROUND_CLEARANCE_M above the REAL ground. With terrain the target
    // AGL is already measured from that ground; with only the catalogue mean
    // the target must also clear the planet's whole hill range, or the brake
    // point may be underground — SAT-R-0002 braked at "1 201 m AGL" that was
    // 415 m below the hill and hit it at 104.4 m/s. Refuse before anything is
    // sent: no fall, and no dampened move into the hill either.
    const groundSafety = groundSafetyVerdict({
      targetAglM: targetAgl,
      source: frame.source,
      groundUncertaintyM: frame.groundUncertaintyM,
      intent: 'descent',
      // The altitude an operator would recognise: the target measured from the
      // catalogue mean, i.e. what used to look safe.
      nominalAglM: targetAgl + groundRadius - surface,
      groundRadiusM: groundRadius,
      surfaceRadiusM: surface,
    });
    if (!groundSafety.ok && !landing) {
      this.refuseDescentGround(exec, drone, unit, now, frame, groundSafety);
      return true;
    }
    // Gravity is evaluated at the CENTRE-relative altitude: the old
    // `|position| - surface` read ~1.9 million metres on a planet whose centre
    // is not the origin, where gravity has already tapered to zero.
    const gravity = this.gravityAt(planet, Math.max(0, frame.radiusM - surface));
    if (!(gravity > 0.5)) return false;
    const mass = Number((unit.meta as { massKg?: number } | undefined)?.massKg ?? 0) || 1;
    const hw = this.guardHardware(drone, mass);
    const fuel = Number((unit.meta as { fuelFraction?: number } | undefined)?.fuelFraction ?? hw?.h2Fill ?? 0);
    const power = Number((unit.meta as { powerFraction?: number } | undefined)?.powerFraction ?? hw?.batteryFill ?? 0);
    const reserve = reserveVerdict({
      h2Pct: clampPct(fuel * 100),
      batteryPct: clampPct(power * 100),
      remainingM: drop,
      speedMps: this.deps.config.demo.speedLimitMps,
      massKg: mass,
      gravityMps2: gravity,
      hasAtmosphere: true,
    });
    if (!reserve.ok) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_descent_rejected',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          reason: `reserve guard: ${reserve.reason}`,
          altitudeAglM: Math.round(altitudeAgl),
          targetAglM: Math.round(targetAgl),
          dropM: Math.round(drop),
        },
        at: now,
      });
      drone.reason = `descent: dampened (reserve guard: ${reserve.reason})`;
      this.saveDrone(drone);
      return false;
    }

    gs.descent = {
      phase: 'measuring',
      probeId: null,
      probeAt: now,
      plan: null,
      normalProfile: this.legProfileFor(drone, unit, now),
      rejected: null,
      startedAt: now,
      groundSource: frame.source,
      planGroundRadiusM: null,
      altitudeAglM: Math.round(altitudeAgl),
      targetAglM: Math.round(targetAgl),
      landing: null,
    };
    // The audit says which ground reference the descent used, so a leg that
    // could only be planned because the probe was skipped is visible.
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_descent_measure',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        groundSource: frame.source,
        groundUncertaintyM: Math.round(frame.groundUncertaintyM),
        altitudeAglM: Math.round(altitudeAgl),
        targetAglM: Math.round(targetAgl),
        dropM: Math.round(drop),
        groundRadiusM: Math.round(groundRadius),
        surfaceRadiusM: Math.round(surface),
        note:
          frame.source === 'terrain'
            ? 'altitude from the terrain height field: |position - planet centre| - terrain radius at this column'
            : frame.source === 'probe'
              ? 'altitude from a probe_ground hit on the local terrain'
              : `altitude from the catalogue mean radius (no terrain field at this column): the real ground could be up to ${Math.round(frame.groundUncertaintyM)} m higher`,
      },
      at: now,
    });
    const probeId = this.sendDescentProbe(exec, drone, now);
    if (!probeId) {
      const reason = 'upward thrust not measured: inspect order could not be sent';
      this.rejectDescent(exec, drone, now, reason);
      return false;
    }
    gs.descent.probeId = probeId;
    this.setState(
      drone,
      'en_route',
      now,
      `descent ${Math.round(drop)} m: measuring upward thrust (inspect ${probeId}); ` +
        `altitude ${Math.round(altitudeAgl)} m AGL from ${frame.source}; no thrust command sent`,
    );
    return true;
  }

  /**
   * Refuse to plan a hold whose slot is inside the real terrain (2026-11-10):
   * hold where the ship is, record why. Used only when the ground is KNOWN —
   * see `dispatchLegMove`.
   */
  private refuseHoldGround(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    frame: { source: AltitudeSource; groundRadiusM: number; targetGroundRadiusM: number; groundUncertaintyM: number; altitudeAglM: number; targetAglM: number; targetGroundLevel?: number | null },
    floorM: number = GROUND_CLEARANCE_M,
    datum: { slotAglM: number | null; datumMismatchM: number | null; datumSource: string } | null = null,
  ): void {
    const gs = this.guardState(drone);
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    // Resolve the planet like every other ground read: the drone row can carry
    // no planet, and `planetByName('')` then yielded a 0 m mean radius.
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    const surface = Number(planet?.surfaceRadiusM ?? 0) || 0;
    // The slot's AGL comes from the datum the point was BUILT with when the
    // mission recorded it (`comeToMe.groundRadiusM`), else this tick's frame.
    const slotAglM = datum?.slotAglM ?? frame.targetAglM;
    const safety = groundSafetyVerdict({
      targetAglM: slotAglM,
      source: frame.source,
      groundUncertaintyM: frame.groundUncertaintyM,
      intent: 'hold',
      // A come-to-me hover passes its own 80 m floor; every other hold keeps
      // the 100 m station-grade clearance.
      floorM,
      nominalAglM: slotAglM + frame.targetGroundRadiusM - surface,
      groundRadiusM: frame.targetGroundRadiusM,
      surfaceRadiusM: surface,
    });
    const reason = safety.reason ?? `hold at ${Math.round(frame.targetAglM)} m AGL is inside terrain`;
    gs.descent = null;
    if (unit?.pos) this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-ground-hold');
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_hold_refused',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        reason,
        groundSource: frame.source,
        groundUncertaintyM: Math.round(frame.groundUncertaintyM),
        groundRadiusM: Math.round(frame.groundRadiusM),
        slotGroundRadiusM: Math.round(frame.targetGroundRadiusM),
        altitudeAglM: Math.round(frame.altitudeAglM),
        targetAglM: Math.round(slotAglM),
        datumSource: datum?.datumSource ?? `frame ${frame.source}`,
        datumMismatchM: datum?.datumMismatchM ?? null,
        note: 'leg not planned: the waypoint is inside the real ground; the ship is held where it is',
      },
      at: now,
    });
    const base: FlightGuardVerdict = gs.lastVerdict ?? {
      action: 'abort-hold',
      code: 'ground-hold',
      targetSpeedMps: 1,
      reason: null,
      availableDecelMps2: 0,
      brakingDistanceM: 0,
      altitudeAglM: Math.round(frame.altitudeAglM * 10) / 10,
      groundFloorM: GROUND_FLOOR_M,
    };
    this.abortFlight(exec, drone, now, { ...base, action: 'abort-hold', code: 'ground-hold', reason });
  }

  /**
   * Refuse a descent whose brake point could be inside terrain: hold the ship,
   * record the plain reason and end the flight leg (the 2026-11-10 crash).
   *
   * Nothing falls. Not the controlled fall, and not the dampened `move`
   * fallback either — a slot inside the hill is unreachable at any speed, so
   * flying it slowly only hides the problem until the hull arrives.
   */
  private refuseDescentGround(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    now: number,
    frame: { source: AltitudeSource; groundRadiusM: number; groundUncertaintyM: number; altitudeAglM: number },
    safety: GroundSafetyVerdict,
  ): void {
    const gs = this.guardState(drone);
    const reason = safety.reason ?? 'descent refused: the ground datum is not known well enough to brake safely';
    gs.descent = null;
    if (unit.pos) this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-ground-datum');
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_descent_rejected',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        reason,
        groundSource: frame.source,
        groundUncertaintyM: Math.round(frame.groundUncertaintyM),
        groundRadiusM: Math.round(frame.groundRadiusM),
        altitudeAglM: Math.round(frame.altitudeAglM),
        requiredAglM: Math.round(safety.requiredAglM),
        note: 'descent refused before it started: the brake point would sit inside the possible terrain; the ship is held, nothing falls',
      },
      at: now,
    });
    const base: FlightGuardVerdict = gs.lastVerdict ?? {
      action: 'abort-hold',
      code: 'ground-datum',
      targetSpeedMps: 1,
      reason: null,
      availableDecelMps2: 0,
      brakingDistanceM: 0,
      altitudeAglM: Math.round(frame.altitudeAglM * 10) / 10,
      groundFloorM: GROUND_FLOOR_M,
    };
    this.abortFlight(exec, drone, now, { ...base, action: 'abort-hold', code: 'ground-datum', reason });
  }

  /**
   * Record a fall rejection and fall back to the dampened leg. One audit row
   * and the drone reason carry the why, so a refusal is never silent.
   */
  private rejectDescent(exec: ExecRow, drone: DroneRow, now: number, reason: string): void {
    const gs = this.guardState(drone);
    const descent = gs.descent;
    if (descent) descent.rejected = reason;
    gs.descent = null;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_descent_rejected',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, reason },
      at: now,
    });
    drone.reason = `descent: dampened (${reason})`;
    this.saveDrone(drone);
  }

  /** Fire-and-forget read-only inspect (outside the single pending slot). */
  private sendDescentProbe(exec: ExecRow, drone: DroneRow, now: number): string | null {
    if (!drone.gridId || !this.deps.hub.isConnected()) return null;
    const orderId = `demo:descent:inspect:${exec.missionId}:${drone.idx}:${now}`;
    const wireType = this.orderChannel('inspect', now, drone.gridId);
    if (!wireType) return null;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: drone.gridId,
      params: { action: 'inspect', entityId: drone.gridId },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 20_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: drone.gridId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: sent ? 'demo_descent_probe_sent' : 'demo_descent_probe_failed',
      subject: orderId,
      detail: { gridId: drone.gridId, missionId: exec.missionId, drone: drone.idx },
      at: now,
    });
    return sent ? orderId : null;
  }

  /**
   * Drive one controlled-fall descent phase. Returns true when the phase owns
   * this tick (no other flight order may be sent). Exactly one order leaves at
   * each phase change; a tick that is merely waiting sends nothing.
   */
  private advanceDescent(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    gs: GuardState,
    ctx: {
      now: number;
      up: Vec3;
      altitudeAgl: number;
      targetAgl: number;
      verticalSpeed: number;
      remaining: number;
      speed: number;
      planet: ReturnType<typeof nearestPlanet>;
      mass: number;
      fuel: number;
      power: number;
      gravity: number;
      surfaceOffsetM: number;
      /** Ground radius used for this tick's AGL, m. */
      groundRadiusM: number;
      /** Where that ground radius came from. */
      groundSource: AltitudeSource;
      /** Tile level behind the ground radius (0 = coarse planning field). */
      groundLevel?: number | null;
      /** How wrong the ground radius could be, m (mean only). */
      groundUncertaintyM: number;
      /** A probe/gear read says the hull is resting on something. */
      landed?: boolean;
      /** A pointer actually hit terrain under this grid. */
      groundHit?: boolean;
      /** Measured telemetry emission period, s (live-brake look-ahead). */
      telemetryPeriodS: number;
    },
  ): boolean {
    const descent = gs.descent;
    if (!descent) {
      // A landing has no descent state once its flare is planned, but it must
      // still own the tick until touchdown: the generic arrival logic would
      // accept the ground point as "arrived" from 10 m up.
      if (drone.landing && drone.state === 'en_route') {
        return this.advanceLandingApproach(exec, drone, gs, ctx);
      }
      return false;
    }
    const { now } = ctx;

    // Any landing phase that goes silent is caught here, whatever the phase:
    // audit `demo_landing_idle`, then resume the descent or abort with a plain
    // reason. This is the guard the 290 s in-game deadlock needed.
    if (
      descent.landing &&
      this.landingIdleWatchdog(exec, drone, gs, ctx, descent.landing.phase)
    ) {
      return true;
    }

    if (descent.phase === 'measuring') {
      // Absolute bound on the measuring phase (overnight run 2026-11-10): the
      // descent must never sit here. If no measurement arrives the ship flies
      // the dampened leg, with the reason written to the audit.
      if (now - descent.startedAt > DESCENT_MEASURE_MAX_MS) {
        this.fallbackFromDescent(
          exec,
          drone,
          unit,
          gs,
          ctx,
          `descent measurement did not complete in ${Math.round(DESCENT_MEASURE_MAX_MS / 1000)} s; ` +
            'flying the dampened descent instead of waiting',
        );
        return true;
      }
      const result = descent.probeId ? this.resultFor(descent.probeId) : null;
      if (!result) {
        if (now - descent.probeAt < DESCENT_PROBE_TIMEOUT_MS) return true;
        this.fallbackFromDescent(exec, drone, unit, gs, ctx, 'upward thrust not measured: inspect timed out');
        return true;
      }
      if (result.ok === false) {
        this.fallbackFromDescent(
          exec,
          drone,
          unit,
          gs,
          ctx,
          `upward thrust not measured: inspect failed (${result.error ?? 'no error text'})`,
        );
        return true;
      }
      const measuredUpN = this.inspectUpThrustN(result.result, ctx.up);
      if (!(measuredUpN > 0)) {
        this.fallbackFromDescent(
          exec,
          drone,
          unit,
          gs,
          ctx,
          'upward thrust not measured: inspect reported no working thruster with lift along the local up vector',
        );
        return true;
      }
      if (!ctx.planet) {
        this.fallbackFromDescent(exec, drone, unit, gs, ctx, 'planet unknown for this descent');
        return true;
      }
      if (descent.landing || drone.landing) return this.planLandingFlare(exec, drone, unit, gs, ctx, measuredUpN);
      const plan = computeDescentProfile({
        massKg: ctx.mass,
        measuredUpThrustN: measuredUpN,
        measuredAtAglM: ctx.altitudeAgl,
        altitudeAglM: ctx.altitudeAgl,
        targetAglM: ctx.targetAgl,
        planet: ctx.planet,
        maxCruiseMps: this.deps.config.demo.speedLimitMps,
        surfaceOffsetM: ctx.surfaceOffsetM,
      });
      if (plan.mode !== 'controlled-fall') {
        this.fallbackFromDescent(exec, drone, unit, gs, ctx, plan.reason);
        return true;
      }
      const reserve = reserveVerdict({
        h2Pct: clampPct(ctx.fuel * 100),
        batteryPct: clampPct(ctx.power * 100),
        remainingM: Math.max(1, ctx.altitudeAgl - ctx.targetAgl),
        speedMps: plan.vFallMps,
        massKg: ctx.mass,
        gravityMps2: ctx.gravity,
        hasAtmosphere: true,
      });
      if (!reserve.ok) {
        this.fallbackFromDescent(exec, drone, unit, gs, ctx, `reserve guard: ${reserve.reason}`);
        return true;
      }
      gs.descent = { ...descent, phase: 'falling', plan, probeId: null, planGroundRadiusM: ctx.groundRadiusM };
      gs.legProfile = {
        distanceM: Math.round(Math.max(0, ctx.altitudeAgl - ctx.targetAgl) * 10) / 10,
        vCruiseMps: plan.finalApproachMps,
        accelMps2: 0,
        brakeMps2: plan.brakeDecelMps2,
        brakeStartDistM: Math.round(plan.brakeDistanceM),
        etaS: plan.etaS,
        fuelL: 0,
        dampeners: 'off',
        flightMode: 'OneWay',
        climbFloorMps: 0,
        reason: plan.reason,
      };
      gs.legStartedAt = now;
      gs.predictedEtaS = plan.etaS;
      gs.predictedFuelL = 0;
      gs.dampenersOff = true;
      gs.dampenersOnAt = null;
      // The one order that starts the fall. No thrust command: dampeners off
      // and gravity does the work.
      this.setDampeners(exec, drone, now, false, `controlled fall: dampeners off to ${Math.round(plan.brakeAltAglM)} m AGL`);
      // Collision avoidance stays on outside the terminal 30 m exactly as for
      // every other leg; the autopilot is off during the fall, so this only
      // arms the controller for the brake/final-approach phase.
      // A fall needs dampeners OFF; never let the collision-avoidance write
      // turn them back on.
      this.setCollisionAvoidance(exec, drone, now, true, 'controlled fall', false);
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_descent_fall',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          measuredUpThrustN: Math.round(measuredUpN),
          measuredAtAglM: Math.round(ctx.altitudeAgl),
          altitudeAglM: Math.round(ctx.altitudeAgl),
          targetAglM: Math.round(ctx.targetAgl),
          // FAILURE 1 + ground-datum crash: the audit must say which ground
          // reference the AGL used, and how wrong it could be when it is the
          // catalogue mean.
          groundSource: descent.groundSource,
          groundUncertaintyM: Math.round(ctx.groundUncertaintyM),
          groundRadiusM: Math.round(ctx.groundRadiusM),
          ...plan,
        },
        at: now,
      });
      this.setState(
        drone,
        'en_route',
        now,
        `controlled fall: dampeners off, ${plan.vFallMps} m/s fall, brake at ${Math.round(plan.brakeAltAglM)} m AGL`,
      );
      return true;
    }

    if (descent.phase === 'falling') {
      // ------------------------------------------------ landing mode phases
      if (descent.landing?.phase === 'flare') {
        const plan = descent.landing.plan;
        // Ground datum re-check while falling (same rule as a descent): the
        // flare altitude is AGL over the ground the plan was made against; if
        // the terrain here is higher than that, brake NOW.
        const planGroundRadiusM = descent.planGroundRadiusM ?? ctx.groundRadiusM;
        const groundShiftM = planGroundRadiusM - ctx.groundRadiusM;
        // The flare over the ground that is under the ship right now.
        const flareAglHereM = plan.flareAglM + groundShiftM;
        // The planned brake point (flare + the height the PLANNED entry speed
        // needed), rebased to the current ground. It is only a floor.
        const plannedBrakeAglM = plan.brakeStopAglM + groundShiftM;
        if (plannedBrakeAglM < LANDING_MIN_BRAKE_AGL_M) {
          this.fullBrake(exec, drone, now, gs, 'landing flare is inside terrain', {
            altitudeAglM: Math.round(ctx.altitudeAgl),
            flareAglHereM: Math.round(flareAglHereM),
            groundSource: ctx.groundSource,
          });
          return true;
        }
        // (b) LIVE brake. The plan's brake point was sized from the speed
        // believed at planning time; measured 2026-11-10 the ship free-fell to
        // -104.4 m/s and the brake fired at 427 m, ~700 m too late, because
        // nothing re-checked the speed. Re-derive the brake height from the
        // speed the ship has NOW, every tick:
        //   v²/(2a)·1.5 + flare + v·telemetryPeriod
        // and start braking at the higher of that and the planned point. This
        // is also the fall cap: the faster the ship falls the higher the brake
        // point climbs, so a lost dampener write cannot turn into a free fall.
        const liveBrakeAglM = landingBrakeAglM({
          verticalSpeedMps: ctx.verticalSpeed,
          brakeDecelMps2: this.shedForLiveBrake(gs, plan),
          flareAglM: flareAglHereM,
          telemetryPeriodS: ctx.telemetryPeriodS,
        });
        const brakeNowAglM = Math.max(plannedBrakeAglM, liveBrakeAglM);
        if (ctx.altitudeAgl > brakeNowAglM) return true;
        // (b) brake: autopilot OFF and dampeners ON. The old brake re-sent a
        // move to the ground point directly below the ship; the autopilot
        // cannot fly that waypoint (measured 2026-11-10: it climbs AWAY from a
        // point below at 1.1-1.2 m/s), so the "brake" also doubled as another
        // unfliable leg. Dampeners are the brake the game actually performs,
        // and both orders only remove energy, so the comms gate never blocks
        // them (2026-11-10: a brake was 409'd mid-fall and the hull died).
        this.stopAutopilot(exec, drone, now, 'landing brake: autopilot off');
        this.setDampeners(exec, drone, now, true, `landing brake at ${Math.round(ctx.altitudeAgl)} m AGL`);
        gs.landingOrderAt = now;
        gs.landingIdleAt = null;
        gs.landingIdleAglM = null;
        gs.speedLimit = plan.approachMps;
        gs.lastResendAt = now;
        gs.dampenersOff = false;
        gs.dampenersOnAt = now;
        gs.descent = { ...descent, landing: { ...descent.landing, phase: 'flare-brake', brakeStartedAt: now } };
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_brake',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            altitudeAglM: Math.round(ctx.altitudeAgl),
            verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
            brakeStopAglM: Math.round(brakeNowAglM),
            plannedBrakeAglM: Math.round(plannedBrakeAglM),
            liveBrakeAglM: Math.round(liveBrakeAglM),
            flareAglM: Math.round(flareAglHereM),
            brakeShedMps2: plan.brakeShedMps2,
            telemetryPeriodS: Math.round(ctx.telemetryPeriodS * 100) / 100,
            massKg: Math.round(ctx.mass),
            groundSource: ctx.groundSource,
            mechanism: 'autopilot-off+dampeners-on',
            waypointSent: false,
            note:
              `live brake: autopilot off and dampeners on at ${Math.round(ctx.altitudeAgl)} m AGL doing ` +
              `${Math.abs(ctx.verticalSpeed).toFixed(1)} m/s, no waypoint; the formula wanted ${Math.round(liveBrakeAglM)} m ` +
              `(v²/2a·${LANDING_LIVE_BRAKE_MARGIN} + ${Math.round(flareAglHereM)} m flare + ${ctx.telemetryPeriodS.toFixed(1)} s look-ahead)`,
          },
          at: now,
        });
        this.setState(
          drone,
          'en_route',
          now,
          `landing brake: autopilot off, dampeners on at ${Math.round(ctx.altitudeAgl)} m AGL (${Math.abs(ctx.verticalSpeed).toFixed(1)} m/s down)`,
        );
        return true;
      }
      if (descent.landing?.phase === 'flare-brake') {
        return this.advanceLandingFlareBrake(exec, drone, gs, {
          now,
          altitudeAgl: ctx.altitudeAgl,
          verticalSpeed: ctx.verticalSpeed,
          speed: ctx.speed,
          mass: ctx.mass,
          groundRadiusM: ctx.groundRadiusM,
          planet: ctx.planet,
        });
      }
      const plan = descent.plan;
      if (!plan) {
        this.fallbackFromDescent(exec, drone, unit, gs, ctx, 'controlled fall lost its plan');
        return true;
      }
      // Ground datum re-check while the fall is running (2026-11-10 crash).
      // The plan's brake altitude is AGL over the ground it was computed
      // against; if the terrain field has since resolved (or resolved higher),
      // convert it to the CURRENT ground and brake the moment it is unsafe.
      // SAT-R-0002 fell through a brake point that was 415 m inside the hill.
      const planGroundRadiusM = descent.planGroundRadiusM ?? ctx.groundRadiusM;
      const brakeClearanceM = plan.brakeAltAglM + planGroundRadiusM - ctx.groundRadiusM;
      if (brakeClearanceM < GROUND_CLEARANCE_M) {
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_descent_ground_unsafe',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            planGroundRadiusM: Math.round(planGroundRadiusM),
            groundRadiusM: Math.round(ctx.groundRadiusM),
            groundSource: ctx.groundSource,
            brakeAltAglM: Math.round(plan.brakeAltAglM),
            brakeClearanceM: Math.round(brakeClearanceM),
            requiredClearanceM: GROUND_CLEARANCE_M,
            reason:
              `controlled fall brake point is inside terrain: the plan brakes at ${Math.round(plan.brakeAltAglM)} m AGL ` +
              `over a ${Math.round(planGroundRadiusM)} m ground, but the ground here is ${Math.round(ctx.groundRadiusM)} m ` +
              `(${Math.round(brakeClearanceM)} m of clearance); full brake now`,
          },
          at: now,
        });
        this.fullBrake(exec, drone, now, gs, 'brake point is inside terrain', {
          brakeAltAglM: Math.round(plan.brakeAltAglM),
          planGroundRadiusM: Math.round(planGroundRadiusM),
          groundRadiusM: Math.round(ctx.groundRadiusM),
          groundSource: ctx.groundSource,
          brakeClearanceM: Math.round(brakeClearanceM),
        });
        return true;
      }
      const ground = groundVerdict({
        altitudeM: ctx.altitudeAgl,
        verticalSpeedMps: ctx.verticalSpeed,
      });
      if (ground.action === 'abort') {
        this.abortDescentAtGround(exec, drone, now, ctx, ground.reason ?? 'ground floor');
        return true;
      }
      if (ground.action === 'brake') {
        this.fullBrake(exec, drone, now, gs, 'ground guard during controlled fall', {
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
        });
        return true;
      }
      // Telemetry look-ahead, scaled to vertical speed: a ~1 s old sample at
      // 100 m/s is 100 m of unobserved fall. The extra quarter second covers
      // the tick boundary.
      const telemetryAgeS = Math.max(0, Math.min(2, (now - unit.lastSeen) / 1000));
      const lookaheadM = Math.max(10, Math.abs(ctx.verticalSpeed) * (0.25 + telemetryAgeS));
      if (ctx.altitudeAgl > plan.brakeAltAglM + lookaheadM) return true;

      const distance = Math.max(0, ctx.altitudeAgl - ctx.targetAgl);
      const vStop = descentStoppableSpeedMps(distance, plan.brakeDecelMps2);
      const vAbs = Math.abs(ctx.verticalSpeed);
      if (vAbs > Math.max(1, vStop) * 1.01) {
        this.fullBrake(exec, drone, now, gs, 'late telemetry at brake altitude', {
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(vAbs * 10) / 10,
          stoppableMps: Math.round(vStop * 10) / 10,
          plannedFallMps: plan.vFallMps,
          brakeAltAglM: Math.round(plan.brakeAltAglM),
        });
        return true;
      }
      this.sendBrakeMove(exec, drone, now, gs, plan, ctx, {
        altitudeAglM: Math.round(ctx.altitudeAgl),
        verticalSpeedMps: Math.round(vAbs * 10) / 10,
        stoppableMps: Math.round(vStop * 10) / 10,
      });
      return true;
    }

    if (descent.phase === 'late-brake') {
      const plan = descent.plan;
      if (!plan) return false;
      if (ctx.altitudeAgl <= GROUND_FLOOR_M && ctx.verticalSpeed < -2) {
        this.abortDescentAtGround(exec, drone, now, ctx, 'below the ground floor while braking');
        return true;
      }
      // Dampeners are stopping the ship. Resume the precise approach only once
      // it is genuinely slow, and then with the one brake move. A denied gate
      // waits; it must not re-send dampeners every tick.
      if (Math.abs(ctx.verticalSpeed) <= 2 && this.gateFor(drone, now).allowed) {
        this.sendBrakeMove(exec, drone, now, gs, plan, ctx, {
          resumedFromFullBrake: true,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
        });
      }
      return true;
    }

    if (descent.phase === 'braking') {
      // Set 5: a lateral leg to above the requested column runs before the
      // handover, at altitude, with the same guarded move every other leg uses.
      if (descent.landing?.phase === 'lateral') {
        return this.advanceLandingLateral(exec, drone, gs, ctx);
      }
      // Set 6: between the lateral leg and `land_at` the hull is HELD until its
      // measured rate is inside the handover envelope. Handing a hull over
      // while its last turn is still unwinding is what got the start refused
      // at 80.5 deg/s, and the idle watchdog then aborted the mission.
      if (descent.landing?.phase === 'settle') {
        return this.advanceLandingSettle(exec, drone, gs, ctx);
      }
      // Landing mode (c)+(d): the dampened final descent owns the tick until
      // touchdown, instead of the generic arrival logic (which would accept
      // "within 10 m" as arrival while still in the air).
      if (descent.landing?.phase === 'approach') {
        return this.advanceLandingApproach(exec, drone, gs, ctx);
      }
      // The plugin owns the last metres: one land_at order, then monitoring.
      if (descent.landing?.phase === 'plugin-land') {
        return this.advanceLandingPluginLand(exec, drone, gs, ctx);
      }
      return false;
    }

    return false;
  }

  /**
   * Landing phase (a)+(b), planned from the measured lift: a fast gravity fall
   * (dampeners off, capped by both the cruise cap and this hull's own brake
   * authority) and a flare height that depends on the hull's weight, because
   * the brake deceleration is `measuredUpThrust / mass − g`.
   *
   * REFUSED — with a plain reason and no fall of any kind — when the ground at
   * the column is not known from the terrain field or a probe hit, because
   * landing on an unknown ground is exactly how SAT-R-0002 was destroyed. An
   * atmospheric hull also refuses: a gravity fall has no brake without air.
   * In both cases the dampened slow descent is offered in its place.
   */
  private planLandingFlare(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; verticalSpeed: number; planet: ReturnType<typeof nearestPlanet>; mass: number; groundSource: AltitudeSource; groundUncertaintyM: number; groundRadiusM: number },
    measuredUpN: number,
  ): boolean {
    const landing = drone.landing;
    const descent = gs.descent;
    if (!landing || !descent) {
      this.fallbackFromDescent(exec, drone, unit, gs, ctx, 'landing mode lost its intent');
      return true;
    }
    const planet = ctx.planet;
    if (!planet) {
      this.refuseLanding(exec, drone, unit, gs, ctx, 'no planet for this landing: the ground cannot be measured');
      return true;
    }
    if (!planet.hasAtmosphere) {
      this.refuseLanding(
        exec,
        drone,
        unit,
        gs,
        ctx,
        'no atmosphere: a gravity fall has no atmospheric brake authority, so a fast landing cannot be braked',
      );
      return true;
    }
    const plan = computeLandingProfile({
      massKg: ctx.mass,
      measuredUpThrustN: measuredUpN,
      measuredAtAglM: ctx.altitudeAgl,
      verticalSpeedMps: ctx.verticalSpeed,
      planet,
      maxCruiseMps: this.deps.config.demo.speedLimitMps,
      groundUncertaintyM: ctx.groundUncertaintyM,
      // Measured dampened shed if this hull has flown a brake before, and the
      // handover height the backend owns the fall + brake down to.
      measuredShedMps2: gs.measuredShedMps2,
      handoverAglM: this.landingHandoverAglM(),
    });
    if (!plan.ok) {
      this.refuseLanding(exec, drone, unit, gs, ctx, plan.reason);
      return true;
    }
    // The flare is never below the owner's requested height either, and it IS
    // the handover height: below it the final-descent mechanism takes over.
    const flareAglM = Math.max(plan.flareAglM, landing.flareAglM);
    const flat: LandingProfile = { ...plan, flareAglM, handoverAglM: flareAglM };

    // ---------------------------------------------------------------- THE SEAM
    // A plugin that advertises `land_controller` owns the WHOLE descent, so it
    // is handed the ship HERE, at the current height, before a single metre of
    // fall is flown by this process. The backend's fall + brake used to run on
    // the event loop; measured 2026-11-10 that loop went 12.3 s without a
    // decision while a 1 Hz sampler saturated it and the hull reached the
    // ground at 57 m/s with the handover order never sent. From this point the
    // only thing this backend does for the grid is watch.
    if (this.finalDescentMechanism(drone, flat) === 'plugin-land') {
      if (this.deferPluginLandForGround(drone, gs, ctx.now)) return true;
      gs.descent = {
        ...descent,
        phase: 'braking',
        plan: null,
        probeId: null,
        planGroundRadiusM: ctx.groundRadiusM,
        landing: { phase: 'plugin-land', plan: flat },
      };
      gs.legStartedAt = ctx.now;
      gs.predictedEtaS = null;
      gs.predictedFuelL = 0;
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      // Set 5: the handover happens ABOVE the requested column, not where the
      // climb left the hull. The lateral leg owns the tick when it is needed.
      if (!this.startLandingLateralLegIfNeeded(exec, drone, gs, ctx.now, flat)) {
        this.startPluginLand(exec, drone, gs, ctx.now, flat);
      }
      return true;
    }

    gs.descent = { ...descent, phase: 'falling', plan: null, probeId: null, planGroundRadiusM: ctx.groundRadiusM, landing: { phase: 'flare', plan: flat } };
    gs.legProfile = {
      distanceM: Math.round(ctx.altitudeAgl * 10) / 10,
      vCruiseMps: flat.approachMps,
      accelMps2: 0,
      brakeMps2: flat.flareDecelMps2,
      brakeStartDistM: Math.round(ctx.altitudeAgl - flareAglM),
      etaS: 0,
      fuelL: 0,
      dampeners: 'off',
      flightMode: 'OneWay',
      climbFloorMps: 0,
      reason: flat.reason,
    };
    gs.legStartedAt = ctx.now;
    gs.predictedEtaS = null;
    gs.predictedFuelL = 0;
    gs.dampenersOff = true;
    gs.dampenersOnAt = null;
    // (a) the fall: dampeners off, gravity does the work.
    this.setDampeners(exec, drone, ctx.now, false, `landing flare: dampeners off to the ${flareAglM} m flare (brake re-derived from the live speed)`);
    this.setCollisionAvoidance(exec, drone, ctx.now, true, 'landing flare', false);
    gs.landingOrderAt = ctx.now;
    gs.landingIdleAt = null;
    gs.landingIdleAglM = null;
    gs.approach = { lastAglM: ctx.altitudeAgl, atMs: ctx.now };
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_flare',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        massKg: Math.round(ctx.mass),
        measuredUpThrustN: Math.round(measuredUpN),
        groundSource: ctx.groundSource,
        groundUncertaintyM: Math.round(ctx.groundUncertaintyM),
        altitudeAglM: Math.round(ctx.altitudeAgl),
        ...flat,
      },
      at: ctx.now,
    });
    this.setState(
      drone,
      'en_route',
      ctx.now,
      `landing flare: dampeners off, planned fall ${flat.maxFallMps} m/s (brake from the live speed), flare ${flareAglM} m true AGL (${flat.flareDecelMps2} m/s² net on ${Math.round(ctx.mass)} kg)`,
    );
    return true;
  }

  /**
   * (b) The brake burn. Dampeners are on while the ship descends to the ground
   * point at the approach speed, so it sheds the fall to <= 5 m/s and then
   * holds that down to the flare.
   *
   * The handover to (c) requires BOTH: at the flare AND at or below the
   * approach speed. Measured 2026-11-10 the old code handed over on altitude
   * alone and recorded `demo_landing_brake_done` at 99 m AGL while the ship was
   * still doing -58.7 m/s. A ship that reaches the flare too fast keeps
   * braking; the timeout re-issues the dampened stop and never hands a fast
   * hull to the approach.
   */
  private advanceLandingFlareBrake(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: {
      now: number;
      altitudeAgl: number;
      verticalSpeed: number;
      speed: number;
      mass: number;
      groundRadiusM: number;
      planet: ReturnType<typeof nearestPlanet>;
    },
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    if (!descent || !landing) return false;
    const plan = landing.plan;
    const descentSpeed = Math.abs(ctx.verticalSpeed);
    // Measure the hull's own dampened shed rate while the brake holds: the
    // next brake point (and the next landing) is planned from this number
    // instead of a constant (measured 7.2 m/s² in game, planned was 4.0).
    if (!landing.dampenersOff) this.recordShedSample(gs, ctx.now, ctx.verticalSpeed);
    const atFlare = ctx.altitudeAgl <= plan.handoverAglM + 2;
    const slowEnoughMps = plan.approachMps;
    const slow = descentSpeed <= slowEnoughMps;
    // In testing/ops mode a tick can be far shorter than a real second; count
    // the timeout in simulated seconds, never in a fixed number of ticks.
    const simSecondMs = this.deps.config.demo.tickMs > 0 ? Math.min(1_000, this.deps.config.demo.tickMs) : 1_000;
    const startedAt = landing.brakeStartedAt ?? ctx.now;
    const brakeTimeoutMs = LANDING_BRAKE_TIMEOUT_S * simSecondMs;
    if (atFlare && slow) {
      return this.toFinalDescent(
        exec,
        drone,
        gs,
        ctx,
        plan,
        `descent ${descentSpeed.toFixed(1)} m/s at ${Math.round(ctx.altitudeAgl)} m AGL (flare ${plan.flareAglM} m)`,
      );
    }
    if (slow) {
      // The brake is already done (the hull is slow) but it stopped ABOVE the
      // handover: resume the fall NOW rather than waiting out the brake window.
      // Waiting is exactly what deadlocked: the old code re-armed its timer.
      const resumes = (landing.resumes ?? 0) + 1;
      this.setDampeners(
        exec,
        drone,
        ctx.now,
        false,
        `landing: brake stopped ${Math.round(ctx.altitudeAgl)} m above the ${plan.handoverAglM} m handover; resuming the controlled fall`,
      );
      gs.dampenersOff = true;
      gs.dampenersOnAt = null;
      gs.landingOrderAt = ctx.now;
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      gs.descent = {
        ...descent,
        landing: { ...landing, phase: 'flare', dampenersOff: false, brakeStartedAt: undefined, resumes },
      };
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_descent_resume',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
          handoverAglM: plan.handoverAglM,
          flareAglM: plan.flareAglM,
          aboveHandoverM: Math.round(ctx.altitudeAgl - plan.handoverAglM),
          resumes,
          mechanism: 'dampeners-off fall, live brake from the new speed',
          note:
            `the brake stopped the hull at ${Math.round(ctx.altitudeAgl)} m AGL, ` +
            `${Math.round(ctx.altitudeAgl - plan.handoverAglM)} m above the ${plan.handoverAglM} m handover, ` +
            `but still descending at only ${descentSpeed.toFixed(1)} m/s: dampeners off again and the live brake ` +
            're-derives its point from the speed actually reached (the old code re-armed its timer and sent nothing)',
        },
        at: ctx.now,
      });
      this.setState(
        drone,
        'en_route',
        ctx.now,
        `landing: brake stopped ${Math.round(ctx.altitudeAgl - plan.handoverAglM)} m above the handover; resuming the controlled fall (${resumes})`,
      );
      return true;
    }
    if (ctx.now - startedAt <= brakeTimeoutMs) return true;
    // The brake has had its 30 s. Still fast: keep braking. This is the case
    // the old handover recorded as a successful brake.
    if (!slow) {
      const gate = this.gateFor(drone, ctx.now);
      if (drone.gridId) {
        // Safety orders only: autopilot off, dampeners on. No waypoint below
        // the ship (the autopilot cannot fly one, measured 2026-11-10).
        this.stopAutopilot(exec, drone, ctx.now, 'landing brake still shedding');
        this.setDampeners(exec, drone, ctx.now, true, `landing brake still shedding ${descentSpeed.toFixed(1)} m/s`);
        gs.speedLimit = plan.approachMps;
        gs.lastResendAt = ctx.now;
        gs.landingOrderAt = ctx.now;
        if (!gate.allowed) {
          const safetyReason = safetyOrderReason({ orderType: 'test', params: { action: 'set_dampeners', on: true } });
          if (safetyReason) {
            this.auditSafetyBypass(drone, ctx.now, 'test', 'set_dampeners', safetyReason, gate);
          }
        }
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_brake_held',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            altitudeAglM: Math.round(ctx.altitudeAgl),
            verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
            approachMps: plan.approachMps,
            flareAglM: plan.flareAglM,
            heldForS: Math.round((ctx.now - startedAt) / 1000),
            mechanism: 'autopilot-off+dampeners-on',
            waypointSent: false,
            note:
              `still descending at ${descentSpeed.toFixed(1)} m/s (limit ${plan.approachMps} m/s) ` +
              `${atFlare ? 'at' : 'above'} the ${plan.flareAglM} m flare: dampeners re-asserted (no waypoint), the final descent is NOT started`,
          },
          at: ctx.now,
        });
        this.setState(
          drone,
          'en_route',
          ctx.now,
          `landing brake: still ${descentSpeed.toFixed(1)} m/s at ${Math.round(ctx.altitudeAgl)} m AGL; holding the brake (no descent handover)`,
        );
      }
      return true;
    }
    // Not slow and out of time: nothing more can be done than hold the brake,
    // which the branch above just did. A fall that keeps speeding up here is
    // caught by the idle watchdog and the arrival guards.
    return true;
  }

  /**
   * The requested landing column, as the executor measures it (2026-11-11
   * flight set 5).
   *
   * For a landing, `drone.execSlot` IS the target's ground point
   * (`landingSlotFor` pushes the planned slot out to the terrain radius), so
   * the direction from the planet centre to it is the local up of the column
   * the mission asked for, and its distance from the centre is that column's
   * ground radius. The offset is TANGENTIAL: a hull 150 m above the column is
   * on it.
   *
   * The leg's target point keeps the hull at its CURRENT radius (so the leg
   * never descends) and never below the target column's ground + the clearance
   * (so it never flies level into a hill that is higher there than here).
   */
  private landingColumn(
    drone: DroneRow,
    unit: { pos: Vec3 | null },
  ): { offsetM: number; up: Vec3; target: Vec3; targetAglM: number; targetGroundRadiusM: number } | null {
    const shipPos = unit.pos;
    if (!shipPos) return null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(shipPos);
    const centre = planet ? vec(planet.center) : null;
    if (!centre) return null;
    const toTarget = sub(drone.execSlot, centre);
    const targetGroundRadiusM = len(toTarget);
    if (!(targetGroundRadiusM > 0)) return null;
    const up = norm(toTarget);
    const d = sub(shipPos, drone.execSlot);
    const radial = dot(d, up);
    const offsetM = len(sub(d, { x: up.x * radial, y: up.y * radial, z: up.z * radial }));
    const shipRadiusM = len(sub(shipPos, centre));
    const legRadiusM = Math.max(shipRadiusM, targetGroundRadiusM + LANDING_LATERAL_MIN_CLEARANCE_M);
    return {
      offsetM,
      up,
      target: { x: centre.x + up.x * legRadiusM, y: centre.y + up.y * legRadiusM, z: centre.z + up.z * legRadiusM },
      targetAglM: legRadiusM - targetGroundRadiusM,
      targetGroundRadiusM,
    };
  }

  /**
   * Fly the last horizontal leg BEFORE the plugin is handed the landing
   * (2026-11-11 flight set 5).
   *
   * WHY. Both set-5 landings came to rest 181-185 m from the `land_at` target,
   * and the earlier "drift" numbers (176/196 m) were the same artefact. It was
   * not drift during the descent: the ship climbs a <= 60 deg ladder, so at the
   * top of a 745 m climb it sits ~180 m sideways of the waypoint, and nothing
   * ever flew the leg ACROSS to the requested column — the plugin's hold was
   * handed the handover column (where the hull already was), so `hhold` logged
   * `on=true, err=0` every tick while the ship landed 182 m from the target.
   *
   * So: if the hull is further than LANDING_LATERAL_ALIGN_M from the requested
   * column, fly a lateral leg AT ALTITUDE to above it with the normal guarded
   * move (braking distance, arrival caps and the comms gate all apply), then
   * hand over. Returns true when a leg was started (the caller must not hand
   * over this tick).
   */
  private startLandingLateralLegIfNeeded(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    now: number,
    plan: LandingProfile,
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    if (!descent || !landing || landing.lateral) return false;
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    if (!unit?.pos || !drone.gridId) return false;
    const column = this.landingColumn(drone, unit);
    if (!column) return false;
    if (column.offsetM <= LANDING_LATERAL_ALIGN_M) return false;
    const lateral = {
      startedAt: now,
      lastMoveAt: now,
      offsetAtStartM: Math.round(column.offsetM * 10) / 10,
      moves: 0,
      targetAglM: Math.round(column.targetAglM * 10) / 10,
      target: column.target,
    };
    gs.descent = { ...descent, phase: 'braking', landing: { ...landing, phase: 'lateral', lateral } };
    gs.landingOrderAt = now;
    gs.landingIdleAt = null;
    gs.landingIdleAglM = null;
    gs.speedLimit = LANDING_LATERAL_SPEED_MPS;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_lateral',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        action: 'start',
        offsetM: Math.round(column.offsetM * 10) / 10,
        thresholdM: LANDING_LATERAL_ALIGN_M,
        arriveM: LANDING_LATERAL_ARRIVE_M,
        targetAglM: lateral.targetAglM,
        targetGroundRadiusM: Math.round(column.targetGroundRadiusM * 10) / 10,
        target: column.target,
        speedMps: LANDING_LATERAL_SPEED_MPS,
        planHandoverAglM: plan.handoverAglM,
        note:
          `the hull is ${Math.round(column.offsetM)} m from the requested landing column, so the handover waits ` +
          `(threshold ${LANDING_LATERAL_ALIGN_M} m): a lateral leg is flown at ${Math.round(column.targetAglM)} m AGL ` +
          `(never descending) to above the column, then land_at goes out with the target`,
      },
      at: now,
    });
    this.setState(
      drone,
      'en_route',
      now,
      `landing: ${Math.round(column.offsetM)} m off the requested column; lateral leg at ${Math.round(
        column.targetAglM,
      )} m AGL before the handover`,
    );
    this.sendLandingLateralMove(exec, drone, gs, now, plan);
    return true;
  }

  /**
   * Send (or re-send) the lateral leg's guarded move. The comms gate applies
   * exactly as it does to any other `move`: while it is denied NO order leaves,
   * and the refusal is audited. Stop/brake/hold never come through here, so
   * they stay ungated.
   */
  private sendLandingLateralMove(exec: ExecRow, drone: DroneRow, gs: GuardState, now: number, plan: LandingProfile): boolean {
    const descent = gs.descent;
    const lateral = descent?.landing?.lateral;
    if (!descent || !lateral) return false;
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    if (!unit?.pos || !drone.gridId) return false;
    const column = this.landingColumn(drone, unit);
    if (!column) return false;
    const gate = this.gateFor(drone, now);
    if (!gate.allowed) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_lateral_held',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          gate: { allowed: gate.allowed, source: gate.source, reason: gate.reason },
          offsetM: Math.round(column.offsetM * 10) / 10,
          note: 'the comms gate denies the lateral leg, so no move is sent (the leg waits; stop/brake/hold are never gated)',
        },
        at: now,
      });
      return false;
    }
    const speed = Math.max(1, Math.round(LANDING_LATERAL_SPEED_MPS));
    this.send(
      exec,
      drone,
      now,
      'move',
      drone.gridId,
      'move',
      this.buildMove(drone, now, unit.pos, column.target, column.up, speed, { tag: 'landing-lateral' }),
      gate,
    );
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_lateral',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        action: 'move',
        move: lateral.moves + 1,
        offsetM: Math.round(column.offsetM * 10) / 10,
        speedMps: speed,
        from: unit.pos,
        to: column.target,
        verticalM: Math.round(dot(sub(column.target, unit.pos), column.up) * 10) / 10,
        gate: { source: gate.source },
        planHandoverAglM: plan.handoverAglM,
        note: 'guarded move to above the requested column; the leg only flies level or up',
      },
      at: now,
    });
    gs.descent = { ...descent, landing: { ...descent.landing!, lateral: { ...lateral, lastMoveAt: now, moves: lateral.moves + 1 } } };
    gs.landingOrderAt = now;
    gs.lastResendAt = now;
    gs.speedLimit = speed;
    return true;
  }

  /**
   * The lateral leg's tick: on the column (<= LANDING_LATERAL_ARRIVE_M) hand
   * over; still away, re-send the guarded move on the resend interval; past
   * LANDING_LATERAL_TIMEOUT_MS hand over ANYWAY (the plugin refuses a target
   * beyond its own cap, so it holds the handover column instead of chasing).
   * The leg never descends and never sends a brake.
   */
  private advanceLandingLateral(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; verticalSpeed: number },
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    const lateral = landing?.lateral;
    if (!descent || !landing || !lateral) return false;
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const column = unit?.pos ? this.landingColumn(drone, unit) : null;
    if (!column) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_lateral',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          action: 'unreadable',
          note: 'the landing column cannot be measured this tick, so the leg is abandoned and the handover proceeds as before',
        },
        at: ctx.now,
      });
      this.handOverToPluginLand(exec, drone, gs, ctx.now, landing.plan);
      return true;
    }
    const elapsedS = Math.round((ctx.now - lateral.startedAt) / 1000);
    if (column.offsetM <= LANDING_LATERAL_ARRIVE_M) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_lateral_done',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          offsetM: Math.round(column.offsetM * 10) / 10,
          offsetAtStartM: lateral.offsetAtStartM,
          elapsedS,
          moves: lateral.moves,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          targetAglM: lateral.targetAglM,
          note: `on the requested column (${Math.round(column.offsetM)} m, was ${lateral.offsetAtStartM} m) in ${elapsedS} s: handing over to land_at`,
        },
        at: ctx.now,
      });
      this.setState(drone, 'en_route', ctx.now, `landing: on the requested column; handing over to the plugin`);
      this.handOverToPluginLand(exec, drone, gs, ctx.now, landing.plan);
      return true;
    }
    if (ctx.now - lateral.startedAt > LANDING_LATERAL_TIMEOUT_MS) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_lateral',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          action: 'timeout',
          offsetM: Math.round(column.offsetM * 10) / 10,
          offsetAtStartM: lateral.offsetAtStartM,
          elapsedS,
          timeoutS: LANDING_LATERAL_TIMEOUT_MS / 1000,
          note:
            'the lateral leg did not close the offset in time, so the handover proceeds where the hull is; the ' +
            'land_at order still carries the target and the plugin refuses it beyond its own cap',
        },
        at: ctx.now,
      });
      this.handOverToPluginLand(exec, drone, gs, ctx.now, landing.plan);
      return true;
    }
    if (ctx.now - lateral.lastMoveAt >= LANDING_LATERAL_RESEND_MS) {
      this.sendLandingLateralMove(exec, drone, gs, ctx.now, landing.plan);
    }
    return true;
  }

  /**
   * Leave the flare brake at the HANDOVER height and choose the final-descent
   * mechanism in exactly one place (`finalDescentMechanism`): this backend's
   * dampener pulses today, or the plugin's `land_at` controller when the
   * plugin advertises `land_controller`.
   */
  private toFinalDescent(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; verticalSpeed: number },
    plan: LandingProfile,
    detail: string,
  ): boolean {
    const landing = gs.descent?.landing;
    if (!gs.descent || !landing) return false;
    const mechanism = this.finalDescentMechanism(drone, plan);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_brake_done',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        altitudeAglM: Math.round(ctx.altitudeAgl),
        verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
        flareAglM: plan.flareAglM,
        handoverAglM: plan.handoverAglM,
        mechanism,
        note: `flare brake done at the ${plan.handoverAglM} m handover (${mechanism}): ${detail}`,
      },
      at: ctx.now,
    });
    if (mechanism === 'plugin-land') {
      if (this.deferPluginLandForGround(drone, gs, ctx.now)) return true;
      // Set 5: the handover waits for a lateral leg when the hull is not above
      // the requested column. The plugin's hold flies to the column it was
      // given; handing it over here, 180 m off, is what produced the
      // "hhold on=true, err=0, landed 182 m from the target" runs.
      if (this.startLandingLateralLegIfNeeded(exec, drone, gs, ctx.now, plan)) return true;
      this.handOverToPluginLand(exec, drone, gs, ctx.now, plan);
      return true;
    }
    gs.descent = { ...gs.descent, phase: 'braking', landing: { ...landing, phase: 'approach' } };
    this.startFinalDescent(exec, drone, gs, ctx.now, plan);
    return true;
  }

  /**
   * THE SEAM. Everything above the handover height (fall + brake) is the
   * backend's; below it, this decides who flies the last metres.
   *
   * `plugin-land` requires the plugin to have advertised `land_controller` in
   * its hello capabilities. Until one does, this returns `dampener-pulse`, i.e.
   * exactly today's behaviour, so a deployed plugin is unaffected.
   */
  finalDescentMechanism(_drone: DroneRow, _plan: LandingProfile): FinalDescentMechanism {
    return chooseFinalDescentMechanism(this.pluginCapabilities());
  }

  /** Capabilities the connected plugin reported in its hello, or null. */
  private pluginCapabilities(): string[] | null {
    const hub = this.deps.hub as { agentInfo?: () => { capabilities?: unknown } | null };
    const info = typeof hub.agentInfo === 'function' ? hub.agentInfo() : null;
    const caps = info?.capabilities;
    if (!Array.isArray(caps)) return null;
    return caps.filter((cap): cap is string => typeof cap === 'string');
  }

  /**
   * THE HANDOVER (2026-11-11 flight set 5, settle gate added in set 6). The ONE
   * place a plugin-owned landing leaves this backend: the descent phase becomes
   * `braking` with the landing in `plugin-land` (or in `settle` first), and
   * `startPluginLand` sends the single `land_at` order (carrying the requested
   * column). Called from the flare/brake seam and from the lateral leg's
   * arrival, so both paths produce exactly the same order and exactly one
   * `demo_landing_handover` row.
   *
   * SET 6: a hull that is still rotating is NOT handed over. The lateral leg's
   * last autopilot turn arrived at the column with an 80.5 deg/s residual, the
   * plugin refused the start (`spinning ... (over 30 deg/s)`) and the idle
   * watchdog aborted the mission 8 s later. So when the measured rate or speed
   * is outside the handover envelope the hull is held on autopilot-off +
   * dampeners-on until it settles (`advanceLandingSettle`), then handed over.
   */
  private handOverToPluginLand(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    now: number,
    plan: LandingProfile,
  ): void {
    const descent = gs.descent;
    if (!descent?.landing) return;
    const spinDegS = this.unitSpinDegS(drone);
    const speedMps = this.unitSpeedMps(drone);
    const settled =
      (spinDegS === null || spinDegS <= LANDING_SETTLE_SPIN_MAX_DEG_S) &&
      (speedMps === null || speedMps <= LANDING_SETTLE_SPEED_MAX_MPS);
    if (!settled) {
      this.beginLandingSettle(exec, drone, gs, now, plan, spinDegS, speedMps);
      return;
    }
    gs.descent = { ...descent, phase: 'braking', landing: { ...descent.landing, phase: 'plugin-land', settle: undefined } };
    this.startPluginLand(exec, drone, gs, now, plan);
  }

  /**
   * Hold the hull before the handover: autopilot off, dampeners on (both only
   * ever remove energy), then wait for the MEASURED rate — never a timer alone.
   * Entry, each re-assert and the exit are audited, so a flight log can say what
   * the hull was doing instead of only that it refused.
   */
  private beginLandingSettle(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    now: number,
    plan: LandingProfile,
    spinDegS: number | null,
    speedMps: number | null,
  ): void {
    const descent = gs.descent;
    if (!descent?.landing) return;
    const settle = {
      startedAt: now,
      lastOrderAt: now,
      spinAtStartDegS: spinDegS,
      speedAtStartMps: speedMps,
      orders: 0,
    };
    gs.descent = { ...descent, phase: 'braking', landing: { ...descent.landing, phase: 'settle', settle } };
    gs.landingOrderAt = now;
    gs.landingIdleAt = null;
    gs.landingIdleAglM = null;
    gs.speedLimit = plan.approachMps;
    this.stopAutopilot(exec, drone, now, 'landing settle: autopilot off before the handover');
    this.setDampeners(exec, drone, now, true, 'landing settle: dampeners on before the handover');
    gs.dampenersOff = false;
    gs.dampenersOnAt = now;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_settle',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        action: 'start',
        spinDegS: spinDegS === null ? null : Math.round(spinDegS * 10) / 10,
        speedMps: speedMps === null ? null : Math.round(speedMps * 100) / 100,
        spinLimitDegS: LANDING_SETTLE_SPIN_MAX_DEG_S,
        speedLimitMps: LANDING_SETTLE_SPEED_MAX_MPS,
        maxSettleS: LANDING_SETTLE_MAX_MS / 1000,
        mechanism: 'autopilot-off+dampeners-on',
        note:
          `the hull is not inside the handover envelope (spin ${spinDegS === null ? 'unread' : Math.round(spinDegS) + ' deg/s'}, ` +
          `speed ${speedMps === null ? 'unread' : speedMps.toFixed(2) + ' m/s'}): held until it is, then land_at goes out`,
      },
      at: now,
    });
    this.setState(
      drone,
      'en_route',
      now,
      `landing settle: holding ${spinDegS === null ? '?' : Math.round(spinDegS)} deg/s / ` +
        `${speedMps === null ? '?' : speedMps.toFixed(1)} m/s before the handover`,
    );
  }

  /**
   * The settle's tick: hand over as soon as BOTH the measured angular rate and
   * the speed are inside the envelope, or when `LANDING_SETTLE_MAX_MS` runs out
   * (the plugin's own settle has a budget too, and its start gate refuses above
   * `LandMath.SpinRefuseDegS`; a hull that stayed above that for 20 s is refused
   * there with a plain reason instead of being trusted).
   *
   * The dampeners are re-asserted on `LANDING_SETTLE_RESEND_MS`: the order is a
   * state write, and a plugin restart mid-settle must not leave the hull free.
   */
  private advanceLandingSettle(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; verticalSpeed: number },
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    const settle = landing?.settle;
    if (!descent || !landing || !settle) return false;
    const now = ctx.now;
    const spinDegS = this.unitSpinDegS(drone);
    const speedMps = this.unitSpeedMps(drone);
    const elapsedMs = now - settle.startedAt;
    const elapsedS = Math.round(elapsedMs / 1000);
    const rateKnown = spinDegS !== null && speedMps !== null;
    const settled =
      rateKnown &&
      spinDegS! <= LANDING_SETTLE_SPIN_MAX_DEG_S &&
      speedMps! <= LANDING_SETTLE_SPEED_MAX_MPS;
    if (settled || elapsedMs >= LANDING_SETTLE_MAX_MS) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_settle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          action: settled ? 'settled' : 'timeout',
          spinDegS: spinDegS === null ? null : Math.round(spinDegS * 10) / 10,
          speedMps: speedMps === null ? null : Math.round(speedMps * 100) / 100,
          spinAtStartDegS:
            settle.spinAtStartDegS === null ? null : Math.round(settle.spinAtStartDegS * 10) / 10,
          speedAtStartMps:
            settle.speedAtStartMps === null ? null : Math.round(settle.speedAtStartMps * 100) / 100,
          elapsedS,
          orders: settle.orders,
          rateKnown,
          note: settled
            ? `inside the handover envelope (spin <= ${LANDING_SETTLE_SPIN_MAX_DEG_S} deg/s, speed <= ` +
              `${LANDING_SETTLE_SPEED_MAX_MPS} m/s) after ${elapsedS} s: handing over to land_at`
            : `the settle's ${Math.round(LANDING_SETTLE_MAX_MS / 1000)} s ran out at ` +
              `${spinDegS === null ? '?' : Math.round(spinDegS)} deg/s / ` +
              `${speedMps === null ? '?' : speedMps.toFixed(2)} m/s: handing over anyway, the plugin's start gate decides`,
        },
        at: now,
      });
      gs.descent = { ...descent, landing: { ...landing, phase: 'plugin-land', settle: undefined } };
      this.startPluginLand(exec, drone, gs, now, landing.plan);
      return true;
    }
    if (now - settle.lastOrderAt >= LANDING_SETTLE_RESEND_MS) {
      this.stopAutopilot(exec, drone, now, 'landing settle: hold');
      this.setDampeners(exec, drone, now, true, `landing settle: dampeners held ${elapsedS} s`);
      gs.landingOrderAt = now;
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      gs.descent = {
        ...descent,
        landing: { ...landing, settle: { ...settle, lastOrderAt: now, orders: settle.orders + 1 } },
      };
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_settle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          action: 'hold',
          spinDegS: spinDegS === null ? null : Math.round(spinDegS * 10) / 10,
          speedMps: speedMps === null ? null : Math.round(speedMps * 100) / 100,
          elapsedS,
          orders: settle.orders + 1,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          note: 'autopilot off, dampeners on: the hull is held while the rate decays',
        },
        at: now,
      });
    }
    return true;
  }

  /** The hull's measured angular rate, deg/s, or null when telemetry has none. */
  private unitSpinDegS(drone: DroneRow): number | null {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const meta = (unit?.meta ?? {}) as {
      spinDegS?: unknown;
      angularVelocity?: { x?: unknown; y?: unknown; z?: unknown };
    };
    const direct = Number(meta.spinDegS);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const omega = meta.angularVelocity;
    if (!omega) return null;
    const values = [omega.x, omega.y, omega.z].map((v) => Number(v));
    if (!values.every((v) => Number.isFinite(v))) return null;
    return (Math.hypot(values[0]!, values[1]!, values[2]!) * 180) / Math.PI;
  }

  /** The hull's measured speed, m/s, or null when telemetry has none. */
  private unitSpeedMps(drone: DroneRow): number | null {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    if (!unit?.vel) return null;
    const values = [unit.vel.x, unit.vel.y, unit.vel.z].map((v) => Number(v));
    if (!values.every((v) => Number.isFinite(v))) return null;
    return Math.hypot(values[0]!, values[1]!, values[2]!);
  }

  /**
   * Refuse to HAND OVER a descent while the column only has a planning-grade
   * ground sample (2026-11-11).
   *
   * `land_at` hands the plugin the datum it brakes on, and the handover happens
   * at the flare height (measured: 75.4 m). A level-0 sample is ~1.5 km per
   * sample and measured 61 160.7 m where level 5 reads 61 197.8 m - a 37.1 m
   * error at 75 m of clearance is the difference between a brake and a fall.
   * `bestColumnGround` has already kicked the level-5 read for this column, so
   * waiting a few ticks costs nothing; the wait is bounded
   * (LANDING_HANDOVER_COARSE_WAITS) because a descent must never wait on
   * terrain, and after that the handover proceeds with the coarse datum
   * LABELLED and the late-jump guard protecting the last 150 m.
   *
   * Returns true when the caller must NOT hand over this tick.
   */
  private deferPluginLandForGround(drone: DroneRow, gs: GuardState, now: number): boolean {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    if (!unit?.pos || !planet) return false;
    const frame = this.groundFrame(drone, unit.pos, planet);
    if (!frame) return false;
    if (isLandingGrade(frame.terrainLevel)) {
      gs.coarseHandoverWaits = 0;
      return false;
    }
    gs.coarseHandoverWaits = (gs.coarseHandoverWaits ?? 0) + 1;
    if (gs.coarseHandoverWaits > LANDING_HANDOVER_COARSE_WAITS) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_handover_coarse',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          groundLevel: frame.terrainLevel,
          groundRadiusM: Math.round(frame.groundRadiusM * 10) / 10,
          hullBottomAglM: Math.round(frame.altitudeAglM * 10) / 10,
          waits: gs.coarseHandoverWaits - 1,
          note:
            'no landing-grade ground sample arrived for the handover column, so land_at goes out on the planning-grade ' +
            'datum (labelled): land_ground upgrades it as soon as the level-5 read lands, and the late-jump guard refuses ' +
            'a large datum move below 150 m AGL',
        },
        at: now,
      });
      return false;
    }
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_handover_deferred',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        groundLevel: frame.terrainLevel,
        groundRadiusM: Math.round(frame.groundRadiusM * 10) / 10,
        hullBottomAglM: Math.round(frame.altitudeAglM * 10) / 10,
        wait: gs.coarseHandoverWaits,
        of: LANDING_HANDOVER_COARSE_WAITS,
        note:
          `the handover column has only a planning-grade ground sample (level ${frame.terrainLevel ?? 'unknown'}), so ` +
          'land_at is not sent on it yet: the level-5 read is in flight and the hull holds its flare height',
      },
      at: now,
    });
    return true;
  }

  /**
   * plugin-land handover: ONE `land_at` order, then telemetry monitoring only.
   * The plugin owns sink rate, the final band and touchdown; the backend keeps
   * watching AGL/vertical speed so a controller that dies or lies is aborted
   * with a plain reason instead of being trusted.
   */
  private startPluginLand(exec: ExecRow, drone: DroneRow, gs: GuardState, now: number, plan: LandingProfile): void {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    if (!unit?.pos || !planet || !drone.gridId) return;
    const frame = this.groundFrame(drone, unit.pos, planet);
    if (!frame) return;
    const column = this.landingColumn(drone, unit);
    const columnOffsetM = column ? column.offsetM : Number.NaN;
    const landingBefore = gs.descent?.landing ?? null;
    const order = buildLandAtOrder({
      // The datum at the TARGET column (2026-11-11 flight set 5): after the
      // lateral leg the hull is above the requested column, and this is the
      // ground it is landing on. `frame.targetGroundRadiusM` is sampled at
      // `drone.execSlot` (the target's ground point), so an order can never
      // carry the ground under a column the ship merely flew over.
      groundRadiusM: frame.targetGroundRadiusM,
      keelDepthM: frame.keelM,
      // The hull's own cruise cap is the fall cap: faster than anything the
      // mission would have flown, slow enough for the plugin's brake to stop.
      maxFallMps: this.deps.config.demo.speedLimitMps,
      // The requested column, so the plugin's hold flies to it instead of to
      // the handover column (where the hull already is).
      targetPosition: drone.execSlot,
    });
    // Autopilot OFF and dampeners ON before handing over: the plugin controller
    // must not race the autopilot, and both orders only remove energy.
    this.stopAutopilot(exec, drone, now, 'plugin land handover: autopilot off');
    this.setDampeners(exec, drone, now, true, 'plugin land handover: dampeners on');
    gs.speedLimit = plan.approachMps;
    gs.lastResendAt = now;
    gs.needsMove = false;
    gs.dampenersOff = false;
    gs.dampenersOnAt = now;
    const { action, ...params } = order;
    this.send(exec, drone, now, 'test', drone.gridId, action, params as unknown as Record<string, unknown>);
    const orderId = drone.pendingOrder ?? null;
    gs.landingOrderAt = now;
    gs.approach = { lastAglM: frame.altitudeAglM, atMs: now };
    if (gs.descent?.landing) {
      gs.descent = {
        ...gs.descent,
        landing: {
          ...gs.descent.landing,
          phase: 'plugin-land',
          pluginOrderId: orderId,
          pluginOrderAt: now,
          pluginAbortReason: null,
          // The datum this order carries: the first `land_ground` compares
          // against it, and the rate-limit clock starts at the handover.
          pluginGroundRadiusM: frame.targetGroundRadiusM,
          groundUpdateAt: now,
          groundUpdates: 0,
        },
      };
    }
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_handover',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        mechanism: 'plugin-land',
        capability: PLUGIN_LAND_CAPABILITY,
        orderId,
        order: order,
        altitudeAglM: Math.round(frame.altitudeAglM),
        handoverAglM: plan.handoverAglM,
        keelM: frame.keelM,
        keelSource: frame.keelSource,
        groundRadiusM: Math.round(frame.targetGroundRadiusM),
        groundLevel: frame.targetGroundLevel,
        groundSource: frame.targetGroundSource,
        targetPosition: drone.execSlot,
        targetColumnOffsetM: Math.round(columnOffsetM * 10) / 10,
        lateralLeg: landingBefore?.lateral
          ? {
              offsetAtStartM: landingBefore.lateral.offsetAtStartM,
              elapsedS: Math.round((now - landingBefore.lateral.startedAt) / 1000),
              moves: landingBefore.lateral.moves,
            }
          : null,
        note:
          'one land_at order from the CURRENT height; the plugin land controller owns the whole descent ' +
          '(fall + brake + final metres), the backend only monitors telemetry for touchdown or abort',
      },
      at: now,
    });
    this.setState(
      drone,
      'en_route',
      now,
      `landing handover at ${Math.round(frame.altitudeAglM)} m hull-bottom AGL: plugin land controller owns the whole ` +
        `descent from here (${order.sinkMps} m/s, ${order.finalSinkMps} m/s under ${order.finalBandM} m, fall cap ` +
        `${order.maxFallMps} m/s)`,
    );
  }

  /**
   * A landing phase that sends no order for LANDING_PHASE_IDLE_MS is audited as
   * `demo_landing_idle` and then RESUMED or ABORTED with a plain reason.
   *
   * This is the guard the in-game run needed: `advanceLandingFlareBrake` could
   * re-arm its timer forever, so a landing sat 290 s with zero orders and zero
   * audit rows (525 m above its flare) and nothing noticed. The watchdog is
   * deliberately phase-agnostic: ANY landing phase that goes silent is caught.
   *
   * - descending (>= 1 m of progress in the window): audit and keep watching —
   *   a free fall legitimately sends nothing for 20 s;
   * - not descending and this backend owns the actuator: release the dampeners
   *   for one descent pulse (bounded by LANDING_IDLE_MAX_RESUMES);
   * - not descending and the resumes are used up (or a plugin owns the
   *   descent): abort with the plain reason, never hover silently.
   */
  private landingIdleWatchdog(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; verticalSpeed: number; groundRadiusM: number; groundSource?: AltitudeSource },
    phase: string,
  ): boolean {
    // A hull inside the CONFIRMED-contact band is down, not stalled
    // (2026-11-11): the plugin landed at 2.96 m AGL and -0.07 m/s, the idle
    // watchdog saw "no order and no descent for 41 s at 3 m AGL" and aborted a
    // landing that had already happened. Contact inside the band is handed to
    // the touchdown rule, and the watchdog records it once instead of firing.
    if (landingContactBand({ altitudeAglM: ctx.altitudeAgl, verticalSpeedMps: ctx.verticalSpeed })) {
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      if (!gs.landingContactWarned) {
        gs.landingContactWarned = true;
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_idle',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            phase,
            action: 'contact-band',
            hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
            verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
            groundSource: ctx.groundSource,
            note:
              `the hull is inside the ${LANDING_CONTACT_BAND_AGL_M} m / 1 m/s contact band, so the watchog ` +
              'does not judge it as stalled: the touchdown rule completes the landing',
          },
          at: ctx.now,
        });
      }
      return false;
    }
    const lastOrderAt = gs.landingOrderAt ?? ctx.now;
    // First tick of a window (or right after an order): open it, never judge.
    if (gs.landingIdleAt === null || gs.landingIdleAglM === null) {
      gs.landingIdleAt = ctx.now;
      gs.landingIdleAglM = ctx.altitudeAgl;
      return false;
    }
    const windowStart = gs.landingIdleAt;
    if (ctx.now - windowStart < LANDING_PHASE_IDLE_MS) return false;
    const silentS = Math.max(0, Math.round((ctx.now - lastOrderAt) / 1000));
    const droppedM = Math.round((gs.landingIdleAglM - ctx.altitudeAgl) * 10) / 10;
    gs.landingIdleAt = ctx.now;
    gs.landingIdleAglM = ctx.altitudeAgl;
    const base = {
      gridId: drone.gridId,
      phase,
      silenceSeconds: silentS,
      windowSeconds: Math.round((ctx.now - windowStart) / 1000),
      hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
      verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
      droppedM,
      resumes: gs.landingIdleResumes,
    };
    if (droppedM >= LANDING_APPROACH_STALL_MIN_DROP_M) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_idle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          ...base,
          action: 'monitoring',
          note: `no order for ${silentS} s in the landing's ${phase} phase, but the hull is descending ` +
            `(${droppedM} m in this window): nothing to resume, kept watching`,
        },
        at: ctx.now,
      });
      return false;
    }
    // Still descending fast: the phase's own brake logic owns this hull (it
    // re-asserts the dampeners), so the watchdog only records the silence.
    const bandMps = gs.descent?.landing?.plan.approachMps ?? LANDING_APPROACH_DESCENT_MPS;
    if (Math.abs(ctx.verticalSpeed) > bandMps) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_idle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          ...base,
          action: 'monitoring',
          note: `no order for ${silentS} s in the landing's ${phase} phase while still descending at ` +
            `${Math.abs(ctx.verticalSpeed).toFixed(1)} m/s (band ${bandMps} m/s): the phase keeps braking`,
        },
        at: ctx.now,
      });
      return false;
    }
    // The SETTLE phase owns the hull with its own bounded budget
    // (LANDING_SETTLE_MAX_MS): it holds on autopilot-off + dampeners-on and
    // re-asserts them every LANDING_SETTLE_RESEND_MS, so a window without a new
    // order here is not a dead phase. It is never aborted by the idle watchdog;
    // it exits into the handover itself.
    if (phase === 'settle') {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_idle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          ...base,
          action: 'monitoring',
          note: `the ${phase} phase is holding the hull (autopilot off, dampeners on) and has its own ` +
            `${Math.round(LANDING_SETTLE_MAX_MS / 1000)} s budget: nothing to resume, kept watching`,
        },
        at: ctx.now,
      });
      return false;
    }
    if (phase !== 'plugin-land' && phase !== 'lateral' && gs.landingIdleResumes < LANDING_IDLE_MAX_RESUMES) {
      gs.landingIdleResumes += 1;
      this.setDampeners(
        exec,
        drone,
        ctx.now,
        false,
        `landing idle ${silentS} s at ${Math.round(ctx.altitudeAgl)} m AGL: dampeners off for one descent`,
      );
      gs.dampenersOff = true;
      gs.landingOrderAt = ctx.now;
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_idle',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          ...base,
          action: 'resume',
          resumes: gs.landingIdleResumes,
          note: `no order and no descent for ${silentS} s in the landing's ${phase} phase at ` +
            `${Math.round(ctx.altitudeAgl)} m AGL: dampeners off for one descent instead of waiting`,
        },
        at: ctx.now,
      });
      this.setState(
        drone,
        'en_route',
        ctx.now,
        `landing idle: ${silentS} s without an order at ${Math.round(ctx.altitudeAgl)} m AGL; resuming the descent`,
      );
      return true;
    }
    const reason =
      `landing ${phase} phase made no order and no descent for ${silentS} s at ${Math.round(ctx.altitudeAgl)} m AGL ` +
      `(vertical speed ${Math.abs(ctx.verticalSpeed).toFixed(2)} m/s)` +
      (phase === 'plugin-land'
        ? ': the plugin land controller is not descending the ship, so the landing is aborted instead of trusted'
        : phase === 'lateral'
          ? ': the lateral leg to the landing column sent no order and made no progress, so the landing is aborted ' +
            'instead of hovering off the requested column'
          : `: ${gs.landingIdleResumes} resume(s) did not restart the descent, so the landing is aborted instead of hovering`);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_idle',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        ...base,
        action: 'abort',
        reason,
        note: 'the idle watchdog ends a silent landing with a plain reason',
      },
      at: ctx.now,
    });
    this.stopAutopilot(exec, drone, ctx.now, 'landing idle: hold position');
    this.setDampeners(exec, drone, ctx.now, true, 'landing idle: dampeners on');
    this.abortFlight(exec, drone, ctx.now, {
      ...(gs.lastVerdict ?? {
        action: 'abort-hold',
        code: 'landing-idle',
        targetSpeedMps: 1,
        reason: null,
        availableDecelMps2: 0,
        brakingDistanceM: 0,
        altitudeAglM: Math.round(ctx.altitudeAgl * 10) / 10,
        groundFloorM: 0,
      }),
      action: 'abort-hold',
      code: 'landing-idle',
      reason,
    });
    return true;
  }

  /**
   * The shed rate the LIVE brake is sized with. A measured rate always wins:
   * measured 2026-11-10, planning at 4.0 m/s² against an actual 7.2 fired the
   * brake ~700 m too high, and planning at the hull's full authority (16.3)
   * would fire it too low. `landingShedRateMps2` applies the 0.7 margin and the
   * 2..10 bounds to whichever number is real.
   */
  private shedForLiveBrake(gs: GuardState, plan: LandingProfile): number {
    const measured = gs.measuredShedMps2;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
      return landingShedRateMps2({ authorityMps2: plan.flareDecelMps2, measuredShedMps2: measured });
    }
    return plan.brakeShedMps2;
  }

  /**
   * Sample the hull's dampened shed rate from the running brake: Δ|v| / Δt
   * while the dampeners hold. Smoothed (0.7 old / 0.3 new) so one noisy
   * telemetry frame cannot move the next brake point, and ignored when the hull
   * is not actually decelerating.
   */
  private recordShedSample(gs: GuardState, now: number, verticalSpeedMps: number): void {
    const speed = Math.abs(verticalSpeedMps);
    const prev = gs.shedSample;
    gs.shedSample = { speedMps: speed, atMs: now };
    if (!prev) return;
    const dtS = (now - prev.atMs) / 1000;
    if (!(dtS >= 0.5) || dtS > 20) return;
    const shed = (prev.speedMps - speed) / dtS;
    if (!(shed > 0.2)) return;
    gs.measuredShedMps2 = gs.measuredShedMps2 === null ? shed : gs.measuredShedMps2 * 0.7 + shed * 0.3;
  }

  /** Handover height for this landing, m HULL BOTTOM AGL (config, default 150). */
  private landingHandoverAglM(): number {
    const configured = Number(this.deps.config.demo.landingHandoverAglM);
    return Number.isFinite(configured) && configured > 0 ? configured : LANDING_HANDOVER_AGL_M;
  }

  /**
   * (c) The dampened final descent: <= 5 m/s down to 15 m, <= 1 m/s below it.
   * (d) Touchdown is detected from TRUE AGL and vertical speed, or from a
   * landing-gear lock. One order per step, never a re-send every tick.
   */
  private advanceLandingApproach(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: {
      now: number;
      altitudeAgl: number;
      verticalSpeed: number;
      planet: ReturnType<typeof nearestPlanet>;
      groundSource: AltitudeSource;
      groundRadiusM: number;
      /** Tile level behind the datum (0 = coarse planning field). */
      groundLevel?: number | null;
      groundHit?: boolean;
      landed?: boolean;
    },
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    if (!descent || !landing) return false;
    if (drone.step === LANDING_STEP_LOCKED) {
      gs.descent = null;
      return false;
    }
    // (d) touchdown, in HULL-BOTTOM metres: the belly below 2 m above the true
    // ground and vertical speed within 0.5 m/s. A hull that is on the ground
    // but still settling (contact inside 1 m/s) is also down — measured
    // 2026-11-10 the approach touched terrain at -4.2 m/s and the contact
    // bounced the ship back up, which the old rule read as a stall.
    const descentSpeedMps = Math.abs(ctx.verticalSpeed);
    const touchAgl = ctx.altitudeAgl <= LANDING_TOUCHDOWN_AGL_M && descentSpeedMps <= LANDING_TOUCHDOWN_MPS;
    const contact =
      ctx.altitudeAgl <= LANDING_TOUCHDOWN_AGL_M && descentSpeedMps <= LANDING_CONTACT_MPS;
    // A dampened descent cannot be finer than the control period, and measured
    // 2026-11-10 this hull reached ground contact at 4.2-4.4 m/s with the
    // dampeners holding. A hull that arrives on a KNOWN ground inside the band
    // it was commanded at has landed; the strict rule above still wins whenever
    // the hull is genuinely slow.
    const dampenedContact =
      ctx.altitudeAgl <= LANDING_TOUCHDOWN_AGL_M && descentSpeedMps <= LANDING_DAMPENED_CONTACT_MPS;
    const gearLock = ctx.landed && (ctx.groundHit || ctx.altitudeAgl <= LANDING_MAX_TOUCHDOWN_AGL_M);
    const groundKnown = ctx.groundSource === 'terrain' || ctx.groundSource === 'probe';
    if (((touchAgl || contact || dampenedContact) && groundKnown) || gearLock) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_touchdown_test',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
          criterion: gearLock
            ? 'gear-lock'
            : touchAgl
              ? 'bottom-agl+slow'
              : contact
                ? 'bottom-agl+contact'
                : 'bottom-agl+dampened-contact',
          keelM: this.keelFor(drone).keelM,
          keelSource: this.keelFor(drone).source,
          groundSource: ctx.groundSource,
          groundLevel: ctx.groundLevel ?? null,
          note: 'touchdown is measured on the HULL BOTTOM, not the grid pivot',
        },
        at: ctx.now,
      });
      this.finishLanding(exec, drone, gs, { ...ctx, speed: Math.abs(ctx.verticalSpeed), landed: ctx.landed === true });
      return true;
    }
    // Nothing to prove the ground under us: refuse to keep descending into an
    // unknown datum (never fall-to-land on a mean ground).
    if (ctx.groundSource === 'mean') {
      const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
      if (unit) {
        this.refuseLanding(
          exec,
          drone,
          unit,
          gs,
          ctx,
          'ground height became unknown while landing (only the catalogue mean radius is available)',
        );
        return true;
      }
    }
    const band = landingApproachSpeedMps(ctx.altitudeAgl);
    // Stall: the descent must keep descending. Measured 2026-11-10 the ship
    // settled at ~78 m AGL with v = 0.00 and hovered forever, because the move
    // targeted the flare height. A hull that makes no downward progress for
    // LANDING_APPROACH_STALL_MS is aborted with a plain reason.
    const progressRef = gs.approach;
    if (!progressRef) {
      gs.approach = { lastAglM: ctx.altitudeAgl, atMs: ctx.now };
    } else if (progressRef.lastAglM - ctx.altitudeAgl >= LANDING_APPROACH_STALL_MIN_DROP_M) {
      gs.approach = { lastAglM: ctx.altitudeAgl, atMs: ctx.now };
    } else if (ctx.now - progressRef.atMs >= LANDING_APPROACH_STALL_MS) {
      const stalledS = Math.round((ctx.now - progressRef.atMs) / 1000);
      const stallVerdict: FlightGuardVerdict = {
        ...(gs.lastVerdict ?? {
          action: 'abort-hold',
          code: 'landing-stalled',
          targetSpeedMps: 1,
          reason: null,
          availableDecelMps2: 0,
          brakingDistanceM: 0,
          altitudeAglM: Math.round(ctx.altitudeAgl * 10) / 10,
          groundFloorM: 0,
        }),
        action: 'abort-hold',
        code: 'landing-stalled',
        reason:
          `landing approach stalled: no descent for ${stalledS} s at ${Math.round(ctx.altitudeAgl)} m AGL ` +
          `(vertical speed ${Math.abs(ctx.verticalSpeed).toFixed(2)} m/s, commanded ${band} m/s); ` +
          'held at its current position instead of hovering',
      };
      // Hold position with what can only reduce energy (autopilot off, dampeners
      // on). A hold to the ground point under the ship is a waypoint the
      // autopilot cannot fly (measured 2026-11-10), so none is sent.
      this.stopAutopilot(exec, drone, ctx.now, 'landing stalled: hold position');
      this.setDampeners(exec, drone, ctx.now, true, 'landing stalled: dampeners on');
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_stalled',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
          commandedMps: band,
          stallSeconds: stalledS,
          groundSource: ctx.groundSource,
          note: 'the approach made no downward progress; aborted instead of hovering (autopilot off, dampeners on)',
        },
        at: ctx.now,
      });
      this.abortFlight(exec, drone, ctx.now, stallVerdict);
      return true;
    }
    // (c) The final descent. NO waypoint is ever sent here: measured
    // 2026-11-10 the autopilot will not fly a point below the ship (it climbs
    // away at 1.1-1.2 m/s, and a straight-up point crawls), which is why every
    // landing stalled at 26-27 m. The phase is flown with the two commands that
    // only ever reduce energy — autopilot off (already sent) and the dampener
    // state — sized from the measured lift/mass shed rate.
    const shedMps2 = this.shedForLiveBrake(gs, landing.plan);
    const gravityMps2 = ctx.planet
      ? this.gravityAt(ctx.planet, Math.max(0, ctx.groundRadiusM + ctx.altitudeAgl - Number(ctx.planet.surfaceRadiusM ?? 0)))
      : 9.81;
    const verdict = landingDescentCommand({
      altitudeAglM: ctx.altitudeAgl,
      sinkMps: Math.max(0, -ctx.verticalSpeed),
      dampenersOff: landing.dampenersOff === true,
      shedMps2,
      gravityMps2,
      periodS: Math.max(0.5, Math.min(5, this.guardState(drone).telemetryPeriodS || 1)),
    });
    const currentlyOff = landing.dampenersOff === true;
    const wantDampenersOn = verdict.dampeners;
    if (wantDampenersOn !== null && wantDampenersOn !== !currentlyOff) {
      this.setDampeners(exec, drone, ctx.now, wantDampenersOn, `final descent: ${verdict.reason}`);
      gs.landingOrderAt = ctx.now;
      gs.landingIdleAt = null;
      gs.landingIdleAglM = null;
      gs.descent = {
        ...descent,
        landing: { ...landing, dampenersOff: wantDampenersOn === false, pulseAt: ctx.now, pulseReason: verdict.reason },
      };
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_pulse',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          dampenersOn: wantDampenersOn,
          hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
          bandMps: verdict.bandMps,
          shedMps2: Math.round(shedMps2 * 100) / 100,
          stopHeightM: verdict.stopHeightM,
          dropThisPeriodM: verdict.dropThisPeriodM,
          reason: verdict.reason,
          note: 'final descent on dampeners only: no waypoint, autopilot off',
        },
        at: ctx.now,
      });
      this.setState(
        drone,
        'en_route',
        ctx.now,
        `landing descent: dampeners ${wantDampenersOn ? 'on' : 'off at ' + verdict.bandMps + ' m/s'}, ` +
          `${Math.round(ctx.altitudeAgl)} m AGL (${Math.abs(ctx.verticalSpeed).toFixed(1)} m/s down)`,
      );
    }
    return true;
  }

  /**
   * plugin-land monitoring phase: the plugin's `land_at` controller is flying
   * the last metres. The backend sends NOTHING here (one order went out at the
   * handover) and only reads telemetry:
   *
   * - touchdown on true AGL / gear lock   -> `finishLanding` (same rule as the
   *   dampener-pulse descent: the hull bottom, not the pivot);
   * - the plugin refused the order       -> abort with its own error text;
   * - silence with no descent            -> `demo_landing_idle` + abort (the
   *   watchdog; a controller that dies must never be trusted).
   */
  private advanceLandingPluginLand(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: {
      now: number;
      altitudeAgl: number;
      verticalSpeed: number;
      planet: ReturnType<typeof nearestPlanet>;
      groundSource: AltitudeSource;
      groundRadiusM: number;
      /** Tile level behind the datum (0 = coarse planning field). */
      groundLevel?: number | null;
      groundHit?: boolean;
      landed?: boolean;
    },
  ): boolean {
    const descent = gs.descent;
    const landing = descent?.landing;
    if (!descent || !landing) return false;
    if (drone.step === LANDING_STEP_LOCKED) {
      gs.descent = null;
      return false;
    }
    const descentSpeedMps = Math.abs(ctx.verticalSpeed);
    const contact = ctx.altitudeAgl <= LANDING_TOUCHDOWN_AGL_M && descentSpeedMps <= LANDING_DAMPENED_CONTACT_MPS;
    const gearLock = ctx.landed && (ctx.groundHit || ctx.altitudeAgl <= LANDING_MAX_TOUCHDOWN_AGL_M);
    // The plugin reported touchdown itself (its `land_at` job ended `landed`),
    // or the hull is inside the confirmed-contact band: either way it is down,
    // and a datum a metre high must not turn a landing into a failure.
    const pluginTouchdown = this.pluginLandedReport(landing.pluginOrderId);
    const contactBand = landingContactBand({
      altitudeAglM: ctx.altitudeAgl,
      verticalSpeedMps: ctx.verticalSpeed,
      pluginTouchdown,
    });
    if (contact || gearLock || contactBand) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_touchdown_test',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
          criterion: gearLock
            ? 'gear-lock'
            : contactBand
              ? pluginTouchdown
                ? 'plugin-land:plugin-touchdown'
                : 'plugin-land:contact-band'
              : 'plugin-land:bottom-agl+dampened-contact',
          contactBandM: LANDING_CONTACT_BAND_AGL_M,
          mechanism: 'plugin-land',
          keelM: this.keelFor(drone).keelM,
          keelSource: this.keelFor(drone).source,
          groundSource: ctx.groundSource,
          groundLevel: ctx.groundLevel ?? null,
          note: 'the plugin land controller reached the ground; touchdown is measured on the HULL BOTTOM',
        },
        at: ctx.now,
      });
      this.finishLanding(exec, drone, gs, { ...ctx, speed: descentSpeedMps, landed: ctx.landed === true });
      return true;
    }
    // The plugin can refuse the order outright. Its error is the plain reason.
    const orderId = landing.pluginOrderId;
    const result = orderId ? this.resultFor(orderId) : null;
    const abortReason =
      landing.pluginAbortReason ??
      (result && result.ok === false
        ? `plugin land_at refused: ${result.error ?? 'no error text'}`
        : null);
    if (abortReason) {
      // SET 6: a START refused for SPIN is not a mission failure. The hull was
      // handed over while its last turn was still unwinding (measured 80.5
      // deg/s), and the old code aborted the whole mission on the plugin's own
      // "settle the hull before landing" answer. Settle once — the same hold
      // the handover uses — and re-issue `land_at`; a second spin refusal is
      // taken at face value and aborted, and an IN-FLIGHT spin abort (the
      // plugin's own 10 deg/s rule) is never retried.
      const refusalText = result && result.ok === false ? String(result.error ?? '') : '';
      const refusedAtStart =
        result !== null &&
        result.ok === false &&
        /spinn?ing/i.test(refusalText) &&
        /settle the hull|before landing/i.test(refusalText);
      if (refusedAtStart && (landing.startRetries ?? 0) < 1) {
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_start_retry',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            orderId,
            refusal: abortReason,
            spinDegS: (() => {
              const spin = this.unitSpinDegS(drone);
              return spin === null ? null : Math.round(spin * 10) / 10;
            })(),
            retry: 1,
            of: 1,
            altitudeAglM: Math.round(ctx.altitudeAgl),
            note:
              'the plugin refused the START for spin, so the hull is settled (autopilot off, dampeners on) and ' +
              'one land_at is re-issued instead of aborting the mission',
          },
          at: ctx.now,
        });
        gs.descent = {
          ...descent,
          landing: {
            ...landing,
            phase: 'settle',
            pluginOrderId: null,
            pluginAbortReason: null,
            settle: undefined,
            startRetries: (landing.startRetries ?? 0) + 1,
          },
        };
        this.beginLandingSettle(
          exec,
          drone,
          gs,
          ctx.now,
          landing.plan,
          this.unitSpinDegS(drone),
          this.unitSpeedMps(drone),
        );
        return true;
      }
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_handover_aborted',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          mechanism: 'plugin-land',
          orderId,
          altitudeAglM: Math.round(ctx.altitudeAgl),
          verticalSpeedMps: Math.round(ctx.verticalSpeed * 100) / 100,
          reason: abortReason,
          startRetries: landing.startRetries ?? 0,
          note:
            'the plugin land controller refused or aborted the final descent' +
            ((landing.startRetries ?? 0) > 0 ? ' (after the one spin-settle retry)' : ''),
        },
        at: ctx.now,
      });
      this.stopAutopilot(exec, drone, ctx.now, 'plugin land aborted: hold position');
      this.setDampeners(exec, drone, ctx.now, true, 'plugin land aborted: dampeners on');
      this.abortFlight(exec, drone, ctx.now, {
        ...(gs.lastVerdict ?? {
          action: 'abort-hold',
          code: 'plugin-land-refused',
          targetSpeedMps: 1,
          reason: null,
          availableDecelMps2: 0,
          brakingDistanceM: 0,
          altitudeAglM: Math.round(ctx.altitudeAgl * 10) / 10,
          groundFloorM: 0,
        }),
        action: 'abort-hold',
        code: 'plugin-land-refused',
        reason: abortReason,
      });
      return true;
    }
    // No order is ever re-sent: the watchdog covers a silent controller.
    //
    // The ONE exception is the ground datum (2026-11-11, defect b). `land_at`
    // carried the ground radius sampled at the HANDOVER column; the descent
    // travels hundreds of metres and the terrain under the hull is a different
    // number as the finer tiles resolve and a probe hit lands. The plugin
    // accepts `land_ground` during an active job, so push the re-sampled radius
    // whenever it moves by more than a couple of metres — rate-limited, capped,
    // and never after touchdown. This is an order to the plugin, never a poll
    // of our own HTTP API.
    this.maybeSendLandGround(drone, gs, landing, ctx);
    // The plugin's hold column (2026-11-11 flight set 6, defect d): `land_at`
    // reports `holdTargetSource` / `holdTargetFromHandoverM` /
    // `holdTargetRefusal` in its order result, and the backend used to drop all
    // three. They are the only evidence that says WHICH column the horizontal
    // hold is flying to, so they go into the audit once per order.
    this.auditLandHoldTarget(drone, gs, landing, ctx.now);
    return true;
  }

  /**
   * Record the hold column the plugin reported for this `land_at` (defect d).
   *
   * `holdTargetSource: 'order'` means the hold is flying the REQUESTED column,
   * `'handover'` means the order was refused or carried no target (so the hold
   * is on the column the hull arrived over), and `holdTargetFromHandoverM` is
   * the tangential offset between the two. Set 5 shipped the fields in the
   * plugin's JSON payload only: the human log line did not print them and
   * `grep holdTarget packages/backend/src` was empty, so a flight could not say
   * which column it landed on. One audit row per order; silence when the plugin
   * did not report them at all (an old build).
   */
  private auditLandHoldTarget(
    drone: DroneRow,
    gs: GuardState,
    landing: NonNullable<DescentState['landing']>,
    now: number,
  ): void {
    if (!landing.pluginOrderId || landing.holdTargetAudited) return;
    const result = this.resultFor(landing.pluginOrderId);
    const payload = (result?.result ?? null) as {
      holdTargetSource?: unknown;
      holdTargetFromHandoverM?: unknown;
      holdTargetRefusal?: unknown;
    } | null;
    if (!payload || typeof payload !== 'object') return;
    const source = typeof payload.holdTargetSource === 'string' ? payload.holdTargetSource : null;
    const fromM = Number(payload.holdTargetFromHandoverM);
    const refusal = typeof payload.holdTargetRefusal === 'string' ? payload.holdTargetRefusal : null;
    if (source === null && !Number.isFinite(fromM) && refusal === null) return;
    if (gs.descent?.landing) {
      gs.descent = { ...gs.descent, landing: { ...gs.descent.landing, holdTargetAudited: true } };
    }
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_hold_target',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        orderId: landing.pluginOrderId,
        source: source ?? 'unreported',
        fromHandoverM: Number.isFinite(fromM) ? Math.round(fromM * 10) / 10 : null,
        refusal,
        targetPosition: drone.execSlot,
        note:
          source === 'order'
            ? 'the plugin horizontal hold is flying the REQUESTED landing column'
            : refusal !== null
              ? 'the plugin REFUSED the ordered column for the hold, so it holds the handover column'
              : 'the plugin reported no ordered column: the hold is on the handover column',
      },
      at: now,
    });
  }

  /**
   * Push the descent's CURRENT ground radius to the plugin (`land_ground`).
   *
   * `ctx.groundRadiusM` is the frame this tick's AGL was measured against — it
   * already prefers the level-5 terrain sample and a live `probe_ground` hit, so
   * this adds no sampling of its own and no request to the backend API.
   *
   * Guards: a delta above LAND_GROUND_MIN_DELTA_M, one order per
   * LAND_GROUND_MIN_INTERVAL_MS, at most LAND_GROUND_MAX_UPDATES per landing,
   * and never while the hull is touching down or the job is over.
   */
  private maybeSendLandGround(
    drone: DroneRow,
    gs: GuardState,
    landing: NonNullable<DescentState['landing']>,
    ctx: { now: number; groundRadiusM: number; altitudeAgl: number; groundLevel?: number | null },
  ): void {
    if (!drone.gridId) return;
    if (drone.step === LANDING_STEP_LOCKED) return;
    const used = landing.pluginGroundRadiusM;
    if (typeof used !== 'number' || !Number.isFinite(used)) return;
    // ONLY a landing-grade sample may move a descent's datum. A level-0
    // planning value is ~1.5 km per sample and was 37.1 m low on this hillside:
    // pushing it mid-brake is what turned an 18 m clearance into an indicated
    // 52.5 m. The fine read is already in flight for this column (the caller
    // resolved through `bestColumnGround`), so skipping costs one tick.
    if (!isLandingGrade(ctx.groundLevel)) {
      if (!landing.coarseDatumAuditedAt) {
        landing.coarseDatumAuditedAt = ctx.now;
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_landing_ground_coarse',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: {
            gridId: drone.gridId,
            groundLevel: ctx.groundLevel ?? null,
            groundRadiusM: Math.round(ctx.groundRadiusM * 10) / 10,
            hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
            sent: false,
            note:
              'the column sample is planning grade (below level ' +
              `${FINE_TERRAIN_MIN_LEVEL}), so it is not pushed as the descent datum; the level-5 read is in flight`,
          },
          at: ctx.now,
        });
      }
      return;
    }
    const delta = ctx.groundRadiusM - used;
    if (!Number.isFinite(delta) || Math.abs(delta) <= LAND_GROUND_MIN_DELTA_M) return;
    const updates = landing.groundUpdates ?? 0;
    if (updates >= LAND_GROUND_MAX_UPDATES) return;
    if (landing.groundDisagreementAt) return;
    if (typeof landing.groundUpdateAt === 'number' && ctx.now - landing.groundUpdateAt < LAND_GROUND_MIN_INTERVAL_MS) {
      return;
    }
    const exec = this.execs().find((e) => e.missionId === drone.missionId);
    if (!exec) return;
    // LATE-DESCENT DATUM GUARD. `ctx.altitudeAgl` is already measured on the
    // NEW sample; the AGL the descent has been flying to is that minus the
    // change (`aglBefore + delta = aglNow`). The guard judges the jump against
    // the clearance in force at the time - at 18 m AGL the limit is 5 m, and
    // the measured 37.1 m jump is 7x it.
    const aglBeforeM = ctx.altitudeAgl + delta;
    const aglChangeM = Math.abs(ctx.altitudeAgl - aglBeforeM);
    const limitM = Math.max(LAND_GROUND_JUMP_MIN_M, Math.abs(aglBeforeM) * LAND_GROUND_JUMP_AGL_FRACTION);
    if (Math.abs(aglBeforeM) < LAND_GROUND_JUMP_MAX_AGL_M && aglChangeM > limitM) {
      landing.groundDisagreementAt = ctx.now;
      const held = this.sendRaw(
        exec,
        drone,
        ctx.now,
        'test',
        {
          action: 'land_stop',
          entityId: drone.gridId,
          gridId: drone.gridId,
          reason: `ground datum disagreement: ${Math.round(delta * 10) / 10} m at ${Math.round(aglBeforeM)} m AGL`,
        },
        'land-ground-disagreement',
      );
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_landing_ground_disagreement',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          reason: 'ground datum disagreement',
          groundRadiusM: Math.round(ctx.groundRadiusM * 10) / 10,
          previousGroundRadiusM: Math.round(used * 10) / 10,
          deltaM: Math.round(delta * 10) / 10,
          groundLevel: ctx.groundLevel ?? null,
          hullBottomAglM: Math.round(aglBeforeM * 10) / 10,
          aglOnNewDatumM: Math.round(ctx.altitudeAgl * 10) / 10,
          aglChangeM: Math.round(aglChangeM * 10) / 10,
          allowedAglChangeM: Math.round(limitM * 10) / 10,
          guardAglM: LAND_GROUND_JUMP_MAX_AGL_M,
          sent: false,
          holdOrderSent: held,
          heldAction: held ? 'land_stop' : null,
          note:
            'the two ground sources disagree by more than the late-descent guard allows, so the datum was NOT ' +
            'moved: the plugin holds the hull in safe hover and the disagreement is reported instead of flown',
        },
        at: ctx.now,
      });
      gs.landingOrderAt = ctx.now;
      return;
    }
    const sent = this.sendRaw(
      exec,
      drone,
      ctx.now,
      'test',
      { action: 'land_ground', entityId: drone.gridId, gridId: drone.gridId, groundRadiusM: ctx.groundRadiusM },
      'land-ground',
    );
    if (!sent) return;
    landing.pluginGroundRadiusM = ctx.groundRadiusM;
    landing.groundUpdateAt = ctx.now;
    landing.groundUpdates = updates + 1;
    gs.landingOrderAt = ctx.now;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_ground_update',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        groundRadiusM: Math.round(ctx.groundRadiusM * 10) / 10,
        previousGroundRadiusM: Math.round(used * 10) / 10,
        deltaM: Math.round(delta * 10) / 10,
        groundSource: 'terrain',
        groundLevel: ctx.groundLevel ?? null,
        update: updates + 1,
        of: LAND_GROUND_MAX_UPDATES,
        hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
        action: 'land_ground',
        note:
          'the terrain/probe sample for this column moved by more than ' +
          `${LAND_GROUND_MIN_DELTA_M} m, so the plugin land controller flies the brake and the flare on the ` +
          "current column's ground instead of the handover column's",
      },
      at: ctx.now,
    });
  }

  /**
   * Hand the ship to (c) after the flare brake: autopilot OFF and dampeners ON.
   *
   * There is no waypoint. The old code sent a move to the ground point directly
   * below the ship, which the SE autopilot will not fly — measured 2026-11-10
   * it climbs AWAY from such a waypoint at 1.1-1.2 m/s, which is exactly why
   * every landing stalled at 26-27 m. The audit still records the ground point
   * the descent is aimed at (as a POINT, not a waypoint) and its AGL is the
   * HULL BOTTOM's, because the pivot is not the part that lands.
   */
  private startFinalDescent(exec: ExecRow, drone: DroneRow, gs: GuardState, now: number, plan: LandingProfile): void {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit?.pos ?? drone.execSlot);
    if (!unit?.pos || !planet || !drone.gridId) return;
    const frame = this.groundFrame(drone, unit.pos, planet);
    if (!frame) return;
    const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    const targetRadius = pivotRadiusForHullBottomAgl(
      frame.groundRadiusM,
      frame.keelM,
      LANDING_APPROACH_TARGET_AGL_M,
    );
    const point = {
      x: centre.x + frame.up.x * targetRadius,
      y: centre.y + frame.up.y * targetRadius,
      z: centre.z + frame.up.z * targetRadius,
    };
    // Autopilot off: the `stop` action disables it and clears its waypoints.
    // This is a safety order (it only removes commanded motion), so the comms
    // gate never blocks it.
    this.stopAutopilot(exec, drone, now, 'final descent: autopilot off');
    this.setDampeners(exec, drone, now, true, 'final descent: dampeners on');
    gs.landingOrderAt = now;
    gs.landingIdleAt = null;
    gs.landingIdleAglM = null;
    gs.speedLimit = plan.approachMps;
    gs.lastResendAt = now;
    gs.needsMove = false;
    gs.dampenersOff = false;
    gs.dampenersOnAt = now;
    if (gs.descent?.landing) {
      gs.descent = {
        ...gs.descent,
        landing: { ...gs.descent.landing, phase: 'approach', dampenersOff: false, pulseAt: now },
      };
    }
    // The descent stall clock starts here: 15 s without a metre of descent
    // aborts instead of hovering.
    gs.approach = { lastAglM: frame.altitudeAglM, atMs: now };
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_approach_start',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        // The point the descent aims at, in world space. It is NOT sent as a
        // waypoint: it is the position whose hull bottom sits
        // LANDING_APPROACH_TARGET_AGL_M above the ground, which for a negative
        // keel is BELOW the terrain (the hull touches first).
        target: point,
        // AGL of the HULL BOTTOM at that point (the number every rule uses).
        targetAglM: hullBottomAglM(targetRadius - frame.groundRadiusM, frame.keelM),
        /** The same point measured from the pivot (diagnostics only). */
        positionTargetAglM: Math.round(targetRadius - frame.groundRadiusM),
        keelM: frame.keelM,
        keelSource: frame.keelSource,
        speedMps: plan.approachMps,
        altitudeAglM: Math.round(frame.altitudeAglM),
        positionAglM: Math.round(frame.positionAglM),
        autopilot: 'off',
        mechanism: 'dampener-pulse',
        note:
          `final descent from the ${plan.flareAglM} m flare at ${plan.approachMps} m/s to ` +
          `${LANDING_FINAL_DESCENT_AGL_M} m, then ${LANDING_FINAL_DESCENT_MPS} m/s: autopilot OFF (a ` +
          'waypoint below the ship cannot be flown) and dampeners the only actuator; AGL is the HULL BOTTOM',
      },
      at: now,
    });
    this.setState(
      drone,
      'en_route',
      now,
      `landing descent from ${Math.round(frame.altitudeAglM)} m hull-bottom AGL: autopilot off, dampeners on, ` +
        `${plan.approachMps} m/s to ${LANDING_FINAL_DESCENT_AGL_M} m then ${LANDING_FINAL_DESCENT_MPS} m/s`,
    );
  }

  /**
   * Landing mode: is any landing gear on the grid locked right now? The plugin
   * reports gear state in `inspect`; until it does, this is false and the
   * touchdown test uses TRUE AGL and vertical speed alone.
   */
  private landingGearLocked(gridId: string | null): boolean {
    if (!gridId) return false;
    const result = this.inspectResultFor(gridId);
    const payload = result as { landingGear?: unknown } | null;
    if (!payload || !Array.isArray(payload.landingGear)) return false;
    return (payload.landingGear as { locked?: unknown }[]).some((gear) => gear?.locked === true);
  }

  /**
   * How many landing-gear blocks / magnetic plates the last inspect reported.
   * A hull with none still lands (the touchdown test is TRUE AGL and vertical
   * speed); this only lets the audit say so plainly.
   */
  private landingGearCount(gridId: string | null): number {
    if (!gridId) return 0;
    const payload = this.inspectResultFor(gridId) as
      | { landingGear?: unknown; landingGears?: unknown; magneticPlates?: unknown }
      | null;
    if (!payload) return 0;
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    return count(payload.landingGear) + count(payload.landingGears) + count(payload.magneticPlates);
  }

  /** Most recent `inspect` body for a grid, if one was recorded. */
  private inspectResultFor(gridId: string): unknown {
    const rows = this.store()
      .db.prepare(
        `SELECT detail FROM audit WHERE actor = 'plugin' AND action = 'plugin_event' AND subject = 'order_result'
           AND detail LIKE ? ORDER BY at DESC LIMIT 1`,
      )
      .all(`%${gridId}%`) as { detail: string }[];
    const row = rows[0];
    if (!row) return null;
    try {
      const detail = JSON.parse(row.detail) as { data?: { result?: unknown } };
      return detail.data?.result ?? null;
    } catch {
      return null;
    }
  }

  /** The ground point a landing approaches (its slot), for the final orders. */
  private landingPoint(
    drone: DroneRow,
    planet: ReturnType<typeof nearestPlanet>,
    groundRadiusM: number,
    aboveGroundM = 0,
  ): Vec3 {
    if (!planet) return drone.execSlot;
    const centre = vec(planet.center) ?? { x: 0, y: 0, z: 0 };
    const from = drone.execSlot;
    const dir = sub(from, centre);
    const lenM = len(dir) || 1;
    const up = { x: dir.x / lenM, y: dir.y / lenM, z: dir.z / lenM };
    // The hold radius is the POSITION that puts the HULL BOTTOM `aboveGroundM`
    // above the ground: ground + keel + aboveGroundM (negative keel asks for a
    // position below the terrain, which the hull's contact then stops).
    const radius = pivotRadiusForHullBottomAgl(groundRadiusM, this.keelFor(drone).keelM, aboveGroundM);
    return {
      x: centre.x + up.x * radius,
      y: centre.y + up.y * radius,
      z: centre.z + up.z * radius,
    };
  }

  /**
   * (d) The mission is complete: stay a SHIP on the ground, lock the landing
   * gear (and magnetic plates when the plugin reports them) via one
   * `set_block_props`, hold at the ground point and mark the drone holding.
   * Station conversion is never used here: a station cannot take off again.
   */
  private finishLanding(
    exec: ExecRow,
    drone: DroneRow,
    gs: GuardState,
    ctx: {
      now: number;
      altitudeAgl: number;
      verticalSpeed: number;
      speed: number;
      planet: ReturnType<typeof nearestPlanet>;
      groundSource: AltitudeSource;
      groundRadiusM: number;
      landed: boolean;
    },
  ): void {
    if (!drone.gridId) return;
    const point = this.landingPoint(drone, ctx.planet, ctx.groundRadiusM);
    const gearCount = this.landingGearCount(drone.gridId);
    // Park with the two orders that can only remove energy: autopilot off
    // (waypoints cleared) and dampeners on. A hold waypoint at the ground point
    // under the ship is exactly the waypoint the autopilot cannot fly, and it
    // is what used to keep the hull sinking towards it. The grid stays dynamic
    // (no convert_to_station).
    this.stopAutopilot(exec, drone, ctx.now, 'landed: autopilot off');
    this.setDampeners(exec, drone, ctx.now, true, 'landed: dampeners on');
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_touchdown',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        // AGL here is HULL BOTTOM: the pivot is not the part that lands.
        altitudeAglM: Math.round(ctx.altitudeAgl),
        hullBottomAglM: Math.round(ctx.altitudeAgl * 10) / 10,
        keelM: this.keelFor(drone).keelM,
        keelSource: this.keelFor(drone).source,
        verticalSpeedMps: Math.round(ctx.verticalSpeed * 10) / 10,
        speedMps: Math.round(ctx.speed * 10) / 10,
        groundSource: ctx.groundSource,
        gearReported: ctx.landed,
        gearPresent: gearCount > 0,
        gearBlocks: gearCount,
        connectorsReleased: true,
        groundPoint: point,
        note: 'touched down on the true ground (hull bottom, not the pivot) and stays a ship',
      },
      at: ctx.now,
    });
    // Landing gear + magnetic plates, in one order. The plugin applies what the
    // hull has; `blocksWithErrors` in the result says what it did not.
    this.send(exec, drone, ctx.now, 'test', drone.gridId, 'set_block_props', {
      filter: { type: ['LandingGear', 'MagneticPlate'] },
      props: { Autolock: true, Lock: true },
      actions: ['Lock'],
    });
    drone.step = LANDING_STEP_LOCKED;
    gs.descent = null;
    gs.approach = null;
    this.recordLegResult(drone, ctx.now, 0, ctx.speed, 'landed');
    this.setState(
      drone,
      'holding',
      ctx.now,
      `landed: touchdown at ${Math.round(ctx.altitudeAgl)} m AGL (${ctx.groundSource} ground), vertical speed ` +
        `${Math.abs(ctx.verticalSpeed).toFixed(1)} m/s; ` +
        (gearCount > 0
          ? 'gear lock sent, held as a ship'
          : 'no landing gear or connectors on this hull — it touched down on its own hull and stays a ship'),
    );
    drone.holdAt = ctx.now;
  }

  /**
   * Refuse a landing with a plain reason and OFFER the dampened slow descent.
   * The offer is a real flight: a dampened move to a hold 100 m above the
   * ground (the ground clearance), at the approach speed — never a fall.
   */
  private refuseLanding(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    gs: GuardState,
    ctx: { now: number; altitudeAgl: number; groundSource?: AltitudeSource; groundUncertaintyM?: number; groundRadiusM?: number; planet?: ReturnType<typeof nearestPlanet> },
    reason: string,
  ): void {
    const gsState = gs;
    const now = ctx.now;
    gsState.descent = null;
    const planet = ctx.planet ?? (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit.pos ?? drone.execSlot);
    const frame = unit.pos ? this.groundFrame(drone, unit.pos, planet) : null;
    const groundRadiusM = ctx.groundRadiusM ?? frame?.groundRadiusM ?? (planet ? Number(planet.surfaceRadiusM ?? 0) || 0 : 0);
    const holdPoint = planet
      ? this.landingPoint(drone, planet, groundRadiusM + GROUND_CLEARANCE_M)
      : drone.execSlot;
    const gate = this.gateFor(drone, now);
    const offered = gate.allowed;
    if (offered && drone.gridId) {
      // The dampened slow descent: a normal move, dampeners on, at the landing
      // approach speed, to a hold 100 m above the (known or assumed) ground.
      // The waypoint goes through the angle guard: a point straight below the
      // ship is re-aimed onto the 60 deg cone, because the autopilot will not
      // fly near-vertical (measured 2026-11-10).
      const offerFrom = unit.pos ?? drone.execSlot;
      this.send(
        exec,
        drone,
        now,
        'move',
        drone.gridId,
        'move',
        this.buildMove(drone, now, offerFrom, holdPoint, frame?.up ?? norm(offerFrom), LANDING_APPROACH_DESCENT_MPS, {
          tag: 'landing-refused-offer',
        }),
        gate,
      );
      gsState.speedLimit = LANDING_APPROACH_DESCENT_MPS;
      gsState.lastResendAt = now;
      gsState.needsMove = false;
      drone.execSlot = holdPoint;
    }
    const offeredText =
      `offering the dampened slow descent instead: a ${LANDING_APPROACH_DESCENT_MPS} m/s dampened move to a hold ${GROUND_CLEARANCE_M} m above the ground` +
      (offered ? '' : ' (denied by the comms gate, so the ship is held here)');
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_refused',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        reason,
        groundSource: ctx.groundSource ?? null,
        groundUncertaintyM: ctx.groundUncertaintyM === undefined ? null : Math.round(ctx.groundUncertaintyM),
        altitudeAglM: Math.round(ctx.altitudeAgl),
        offered: offered ? 'dampened slow descent' : null,
        offer: offeredText,
        note: 'the landing was refused before any fall was commanded',
      },
      at: now,
    });
    const base: FlightGuardVerdict = gsState.lastVerdict ?? {
      action: 'abort-hold',
      code: 'landing-refused',
      targetSpeedMps: 1,
      reason: null,
      availableDecelMps2: 0,
      brakingDistanceM: 0,
      altitudeAglM: Math.round(ctx.altitudeAgl * 10) / 10,
      groundFloorM: GROUND_FLOOR_M,
    };
    if (offered) {
      // Keep flying the dampened descent; the reason says why it is not a landing.
      gsState.arrival = emptyArrivalProgress();
      gsState.lastRemaining = null;
      gsState.awayTicks = 0;
      gsState.legStartedAt = now;
      gsState.approach = null;
      // The offered descent is an ordinary leg: no landing phases may run.
      drone.landing = null;
      drone.reason = `landing refused: ${reason}; ${offeredText}`;
      this.saveDrone(drone);
      return;
    }
    this.abortFlight(exec, drone, now, { ...base, action: 'abort-hold', code: 'landing-refused', reason });
  }

  /** Fall back to today's dampened move and record why the fall was refused. */
  private fallbackFromDescent(
    exec: ExecRow,
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    gs: GuardState,
    ctx: { now: number },
    reason: string,
  ): void {
    const normal = gs.descent?.normalProfile ?? null;
    this.rejectDescent(exec, drone, ctx.now, reason);
    const gate = this.gateFor(drone, ctx.now);
    if (!gate.allowed) {
      this.fail(drone, ctx.now, `descent fallback denied by comms gate: ${gate.reason}`);
      return;
    }
    const left = unit.pos ? dist(unit.pos, drone.execSlot) : 0;
    const speed =
      normal?.vCruiseMps ??
      Math.max(
        1,
        Math.round(
          safeApproachSpeedMps(
            Math.max(0.1, left),
            UNKNOWN_HULL_BRAKE_MPS2,
            this.deps.config.demo.speedLimitMps,
          ) * 10,
        ) / 10,
      );
    this.dispatchLegMove(exec, drone, ctx.now, speed, normal, gate, unit);
  }

  /** Sum the measured upward force from a plugin `inspect` result. */
  private inspectUpThrustN(result: unknown, up: Vec3): number {
    let payload = result as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return 0;
    if (!Array.isArray(payload.thrusters) && payload.result && typeof payload.result === 'object') {
      payload = payload.result as Record<string, unknown>;
    }
    const thrusters = payload.thrusters;
    /** The plugin's own per-direction summary, N. */
    const byDirectionUpN = (): number => {
      const byDirection = payload?.thrustPerDirection as { upN?: unknown } | undefined;
      const upN = Number(byDirection?.upN ?? 0);
      return Number.isFinite(upN) && upN > 0 ? upN : 0;
    };
    if (!Array.isArray(thrusters)) {
      // No per-thruster list at all: the summary is the only measurement.
      return byDirectionUpN();
    }
    let liftN = 0;
    for (const raw of thrusters) {
      const t = raw as {
        enabled?: unknown;
        working?: unknown;
        axisWorld?: unknown;
        maxEffectiveThrustN?: unknown;
        maxThrustN?: unknown;
      };
      if (t.working === false || t.enabled === false) continue;
      const axis = vec(t.axisWorld);
      if (!axis) continue;
      // Thrust force points opposite the block's forward axis.
      const alongUp = -(axis.x * up.x + axis.y * up.y + axis.z * up.z);
      if (!(alongUp > 0)) continue;
      const force = Number(t.maxEffectiveThrustN ?? t.maxThrustN ?? 0);
      if (Number.isFinite(force) && force > 0) liftN += force * Math.min(1, alongUp);
    }
    // Some builds report every thruster axis as (0,0,0) (the live SAT-R-0002
    // profile does), which makes the per-thruster walk useless. The plugin's
    // `thrustPerDirection.upN` summary is then the measured lift: a landing
    // must not be refused as "no lift" when the ship did measure one.
    return liftN > 0 ? liftN : byDirectionUpN();
  }

  /** Send the one brake/final-approach move and hand the ship to the guard. */
  private sendBrakeMove(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    gs: GuardState,
    plan: DescentProfile,
    ctx: { altitudeAgl: number; verticalSpeed: number; remaining?: number },
    detail: Record<string, unknown>,
  ): void {
    if (!drone.gridId || !gs.descent) return;
    const gate = this.gateFor(drone, now);
    if (!gate.allowed) {
      this.fullBrake(exec, drone, now, gs, `brake move denied by comms gate: ${gate.reason}`, detail);
      return;
    }
    const speed = plan.finalApproachMps;
    // One move for the brake phase: the plugin's `move` action sets
    // DampenersOverride = true (CommandExecutor.Move), which is the brake burn
    // itself. The waypoint goes through the angle guard, so a descent slot
    // straight below the ship is re-aimed onto the 60 deg cone instead of being
    // sent as a near-vertical leg the autopilot cannot fly.
    const unit = this.store().getUnit(drone.gridId);
    const brakeFrom = unit?.pos ?? drone.execSlot;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(brakeFrom);
    const frame = unit?.pos && planet ? this.groundFrame(drone, unit.pos, planet) : null;
    this.send(
      exec,
      drone,
      now,
      'move',
      drone.gridId,
      'move',
      this.buildMove(drone, now, brakeFrom, drone.execSlot, frame?.up ?? norm(brakeFrom), speed, { tag: 'descent-brake' }),
      gate,
    );
    this.enforceCollisionAvoidance(exec, drone, now, speed);
    gs.descent.phase = 'braking';
    gs.dampenersOff = false;
    gs.dampenersOnAt = now;
    gs.speedLimit = speed;
    gs.lastResendAt = now;
    gs.needsMove = false;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_descent_brake',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, speedMps: speed, ...detail, plan },
      at: now,
    });
    this.setState(
      drone,
      'en_route',
      now,
      `descent brake: dampeners on, final approach at ${speed} m/s (${Math.round(ctx.altitudeAgl)} m AGL)`,
    );
  }

  /** Full dampener brake: the last-resort path for late telemetry or a gate denial. */
  private fullBrake(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    gs: GuardState,
    reason: string,
    detail: Record<string, unknown>,
  ): void {
    if (!gs.descent) return;
    this.setDampeners(exec, drone, now, true, `full brake: ${reason}`);
    gs.descent.phase = 'late-brake';
    gs.dampenersOff = false;
    gs.dampenersOnAt = now;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_descent_late_brake',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, reason, ...detail },
      at: now,
    });
    this.setState(drone, 'en_route', now, `descent: FULL BRAKE (${reason}); no move sent`);
  }

  /** Ground guard fired during the fall: stop and abort, exactly like a normal leg. */
  private abortDescentAtGround(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    ctx: { up: Vec3; altitudeAgl: number },
    reason: string,
  ): void {
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    if (unit?.pos) this.sendRaw(exec, drone, now, 'hold', { ...unit.pos, speed: 1 }, 'guard-ground');
    const verdict: FlightGuardVerdict = {
      action: 'abort-hold',
      code: 'ground-floor',
      targetSpeedMps: 1,
      reason: `ground guard: ${reason} at ${Math.round(ctx.altitudeAgl)} m AGL`,
      availableDecelMps2: 0,
      brakingDistanceM: Number.POSITIVE_INFINITY,
      altitudeAglM: Math.round(ctx.altitudeAgl * 10) / 10,
      groundFloorM: GROUND_FLOOR_M,
    };
    this.abortFlight(exec, drone, now, verdict);
  }

  /**
   * Contract §3: the leg profile for one ship/leg. Everything it needs is the
   * same live data the guard already reads (mass, thrust at altitude, fuel,
   * gravity, atmosphere), so predicted numbers and the guard agree.
   */
  private legProfileFor(
    drone: DroneRow,
    unit: NonNullable<ReturnType<Store['getUnit']>>,
    now: number,
  ): LegProfile | null {
    if (!unit.pos) return null;
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(unit.pos);
    const surface = Number(planet?.surfaceRadiusM ?? 0) || 0;
    const frame = this.groundFrame(drone, unit.pos, planet);
    const groundRadius = frame?.groundRadiusM ?? surface;
    const mass = Number((unit.meta as { massKg?: number } | undefined)?.massKg ?? 0) || 1;
    const hw = this.guardHardware(drone, mass);
    const radius = frame?.radiusM ?? (len(unit.pos) || 1);
    const modelAltitude = Math.max(0, radius - surface);
    const thrust: ThrustSplit =
      hw && planet
        ? thrustAtAltitude(enduranceHullFor(hw, mass), planet, modelAltitude).forceN
        : { atmo: mass * Math.max(0, this.gravityAt(planet, modelAltitude)) * 3, ion: 0, h2: 0 };
    const fuel = Number((unit.meta as { fuelFraction?: number } | undefined)?.fuelFraction ?? hw?.h2Fill ?? 0);
    const power = Number((unit.meta as { powerFraction?: number } | undefined)?.powerFraction ?? hw?.batteryFill ?? 0);
    const gravity = this.gravityAt(planet, modelAltitude);
    // No `: 5` fallback: an unmeasured hull must not fly the whole leg at the
    // arrival cap. computeLegProfile derives v_cruise from the braking maths
    // over the same fallback thrust the guard uses for its abort check.
    //
    // T61: passengers aboard cap the cruise at 60 m/s and the planning
    // acceleration at 0.5 g lateral / 1 g vertical, so the profile cannot ask
    // for a manoeuvre that would throw a seated (or standing) player around.
    const limits = this.passengerLimitsFor(drone, unit);
    const capMps = capPassengerSpeed(this.deps.config.demo.speedLimitMps, limits);
    const climbingLeg =
      typeof frame?.altitudeAglM === 'number' &&
      typeof frame?.targetAglM === 'number' &&
      frame.targetAglM > frame.altitudeAglM + 1;
    const maxAccelMps2 = limits
      ? climbingLeg || frame?.targetAglM === undefined
        ? limits.verticalAccelMps2
        : limits.lateralAccelMps2
      : undefined;
    void now;
    return computeLegProfile(
      {
        massKg: mass,
        thrustN: thrust,
        powerMW: hw?.powerMW,
        h2Fraction: fuel,
        batteryFraction: power,
      },
      unit.pos,
      drone.execSlot,
      {
        maxCruiseMps: capMps,
        gravityMps2: gravity,
        hasAtmosphere: thrust.atmo > 0,
        altitudeAglM: frame?.altitudeAglM ?? radius - groundRadius,
        targetAglM: frame?.targetAglM ?? len(drone.execSlot) - groundRadius,
        ...(maxAccelMps2 !== undefined ? { maxAccelMps2 } : {}),
      },
    );
  }

  /**
   * A SAFETY ORDER: the plugin's `stop` disables the autopilot and clears its
   * waypoints, so it can only remove commanded motion. It is exempt from the
   * comms gate — measured 2026-11-10 a brake order was refused by the gate
   * mid-fall (HTTP 409) and the hull hit the ground — and every bypass is
   * audited with the reason it was allowed through.
   */
  private stopAutopilot(exec: ExecRow, drone: DroneRow, now: number, reason: string): boolean {
    if (!this.roleGate(exec, drone, now, 'stop')) return false;
    if (!drone.gridId || !this.deps.hub.isConnected()) return false;
    const gate = this.gateFor(drone, now);
    const safetyReason = safetyOrderReason({ orderType: 'stop', params: { action: 'stop' } });
    if (!gate.allowed && safetyReason) this.auditSafetyBypass(drone, now, 'stop', 'stop', safetyReason, gate);
    const orderId = `demo:guard:stop:${exec.missionId}:${drone.idx}:${now}`;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: 'stop' as const,
      entityId: drone.gridId,
      params: { action: 'stop' },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: drone.gridId,
      orderType: 'stop',
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_guard_stop',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, reason, sent, safety: safetyReason },
      at: now,
    });
    return sent;
  }

  /** One audit row per safety order the comms gate would have refused. */
  private auditSafetyBypass(
    drone: DroneRow,
    now: number,
    orderType: string,
    action: string,
    reason: string,
    gate: CommsGate,
  ): void {
    this.store().audit({
      actor: 'demo-executor',
      action: 'safety_order_bypassed_gate',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        orderType,
        action,
        reason,
        gate: { allowed: gate.allowed, source: gate.source, gameLink: gate.gameLink, reason: gate.reason },
        note: 'this order can only reduce the ship’s energy, so the comms gate never blocks it',
      },
      at: now,
    });
  }

  private setDampeners(exec: ExecRow, drone: DroneRow, now: number, on: boolean, reason: string): void {
    if (!drone.gridId || !this.deps.hub.isConnected()) return;
    if (!this.roleGate(exec, drone, now, 'set_dampeners', { on })) return;
    // Dampeners ON is a safety order (it can only remove velocity) and is
    // audited if the gate would have refused it. OFF releases the brake, so it
    // is not exempt — it needs no gate either (it is part of a gated leg), but
    // it is never labelled a bypass.
    if (on) {
      const gate = this.gateFor(drone, now);
      const safetyReason = safetyOrderReason({ orderType: 'test', params: { action: 'set_dampeners', on: true } });
      if (!gate.allowed && safetyReason) this.auditSafetyBypass(drone, now, 'test', 'set_dampeners', safetyReason, gate);
    }
    const orderId = `demo:guard:dampeners:${exec.missionId}:${drone.idx}:${now}`;
    const wireType = this.orderChannel('set_dampeners', now, drone.gridId);
    if (!wireType) return;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: drone.gridId,
      params: { action: 'set_dampeners', entityId: drone.gridId, on },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    this.store().createOrder({
      orderId,
      missionId: exec.missionId,
      unitId: drone.gridId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_guard_dampeners',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, on, reason, sent },
      at: now,
    });
  }

  /**
   * Predicted vs actual for one flight (contract §3). Written to the audit and
   * appended to the mission notes, so a model error is visible next to the
   * flight that produced it instead of only in a log.
   */
  private recordLegResult(
    drone: DroneRow,
    now: number,
    remainingM: number | null,
    speedMps: number,
    outcome: string,
  ): void {
    const gs = this.guardState(drone);
    const profile = gs.legProfile;
    if (!profile || gs.legStartedAt === null) return;
    const unit = drone.gridId ? this.store().getUnit(drone.gridId) : null;
    const mass = Number((unit?.meta as { massKg?: number } | undefined)?.massKg ?? 0) || 1;
    const hw = this.guardHardware(drone, mass);
    const fuelMeta = (unit?.meta as { fuelFraction?: number } | undefined)?.fuelFraction;
    const actualFuelL =
      typeof fuelMeta === 'number' && gs.fuelAtStart !== null && hw
        ? Math.max(0, gs.fuelAtStart - fuelMeta) * hw.h2TankLitres
        : null;
    const actualEtaS = Math.round(((now - gs.legStartedAt) / 1000) * 10) / 10;
    const detail = {
      gridId: drone.gridId,
      outcome,
      predicted: {
        vCruiseMps: profile.vCruiseMps,
        etaS: Math.round(profile.etaS * 10) / 10,
        fuelL: profile.fuelL,
        dampeners: profile.dampeners,
        flightMode: profile.flightMode,
        brakeStartDistM: profile.brakeStartDistM,
      },
      actual: { etaS: actualEtaS, fuelL: actualFuelL === null ? null : Math.round(actualFuelL * 10) / 10, speedMps: Math.round(speedMps * 10) / 10, remainingM: remainingM === null ? null : Math.round(remainingM) },
    };
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_flight_profile',
      subject: `${drone.missionId}:${drone.idx}`,
      detail,
      at: now,
    });
    const line =
      `[profile] ${drone.label} ${outcome}: predicted ${Math.round(profile.etaS)} s / ${profile.fuelL.toFixed(0)} L, ` +
      `actual ${actualEtaS.toFixed(0)} s / ${actualFuelL === null ? '?' : actualFuelL.toFixed(0)} L ` +
      `(v ${profile.vCruiseMps} ${profile.flightMode}, dampeners ${profile.dampeners})`;
    const mission = this.store().getMission(drone.missionId);
    if (mission) {
      const plan = mission.plan ?? { steps: [] };
      const notes = `${plan.notes ? `${plan.notes}\n` : ''}${line}`;
      this.store().updateMission(drone.missionId, {
        plan: { ...plan, steps: plan.steps ?? [], notes: notes.slice(-4000) },
      }, now);
    }
    gs.legProfile = null;
    gs.legStartedAt = null;
    gs.predictedEtaS = null;
    gs.predictedFuelL = null;
    gs.fuelAtStart = null;
    // The fall is over once the leg result is recorded (arrival or abort); a
    // later unexplained descent while holding must trip the staging emergency.
    gs.descent = null;
  }

  private send(
    exec: ExecRow,
    drone: DroneRow,
    now: number,
    orderType: 'test' | 'move' | 'hold' | 'stop',
    entityId: string,
    action: string,
    params: Record<string, unknown>,
    gate?: CommsGate,
  ): void {
    if (this.store().isKillSwitchOn()) return;
    if (!this.roleGate(exec, drone, now, action, params)) return;
    // T75: legitimate actions leave on the production channel (`action`) in
    // every build; admin/unknown actions stay on `test` and are refused here in
    // survival mode, before anything reaches the plugin.
    const decision = decideOrderChannel(orderType, action, this.survivalMode);
    if (decision.refused) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'survival_refused',
        subject: entityId,
        detail: { action, orderType, reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
        at: now,
      });
      this.setState(drone, drone.state, now, `survival mode: ${action} refused`);
      return;
    }
    const wireType = decision.orderType;
    if (orderType === 'move' && typeof (params as Record<PropertyKey, unknown>)[WAYPOINT_GUARDED] !== 'number') {
      // Structural guard: a move whose waypoint did not come from `buildMove`
      // has never been checked against the 60 deg autopilot ceiling. Fail loudly
      // in the tests rather than fly it.
      throw new Error(
        `move order "${action}" was built without the waypoint-angle guard: every move must go through buildMove()`,
      );
    }
    if (!this.deps.hub.isConnected()) {
      this.setState(drone, drone.state, now, 'waiting: plugin offline');
      return;
    }
    const attempt = (drone.attempts ?? 0) + 1;
    const orderId = `demo:${exec.missionId}:${drone.idx}:${action}:a${attempt}`;
    // The plugin's test harness resolves the grid from params.entityId, while
    // move/hold/stop read the envelope's entityId. Send both.
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId,
      params: wireType === 'test' || wireType === 'action' ? { action, entityId, ...params } : { action, ...params },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    const record: OrderRecord = {
      orderId,
      missionId: exec.missionId,
      unitId: entityId,
      orderType: wireType,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: attempt,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    };
    this.store().createOrder(record);
    const sent = this.deps.hub.send(payload);
    drone.pendingOrder = sent ? orderId : null;
    drone.pendingAction = action;
    drone.pendingAt = now;
    drone.attempts = attempt;
    this.saveDrone(drone);
    this.store().audit({
      actor: 'demo-executor',
      action: sent ? 'demo_order_sent' : 'demo_order_send_failed',
      subject: orderId,
      detail: {
        missionId: exec.missionId,
        drone: drone.idx,
        orderType,
        action,
        gate: gate ? { allowed: gate.allowed, source: gate.source, reason: gate.reason } : null,
        labels: gate ? gate.labels : ['SIMULATED'],
      },
      at: now,
    });
    if (!sent) this.setState(drone, drone.state, now, 'plugin socket refused the order');
    // T50: a flight order (move/hold/stop) marks that this drone has flown a
    // leg; the fleet service uses it to tell "the new mission flew" from
    // "it is still waiting on the old state".
    if (sent && wireType !== 'test' && wireType !== 'action') {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_flight_order',
        subject: `${exec.missionId}:${drone.idx}`,
        detail: { orderType: wireType, action, gridId: entityId, orderId },
        at: now,
      });
    }
  }

  private isReleaseBlockStep(step: string | null): boolean {
    return (
      step === RELEASE_STEP_GEARS ||
      step === RELEASE_STEP_CONNECTORS ||
      step === RELEASE_STEP_RELOCK ||
      step === STAGING_STEP_HANDOFF
    );
  }

  private sendReleaseBlock(exec: ExecRow, drone: DroneRow, now: number, order: ReleaseBlockOrder): void {
    if (!drone.gridId) return this.fail(drone, now, 'no grid id for release preflight');
    this.send(exec, drone, now, 'test', drone.gridId, 'set_block_props', {
      filter: order.filter,
      props: order.props,
      actions: order.actions,
    });
  }

  /**
   * One diag read closes the release preflight: a static grid needs
   * `convert_to_ship`, then a second read; a grid with no mass or no physics
   * body is refused instead of flying a move order that cannot work.
   */
  private handleReleaseReadout(drone: DroneRow, now: number, ok: boolean, result: unknown): void {
    const readout = ok ? parseReleaseReadout(result) : null;
    if (!readout) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'launch_release_verify',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: { gridId: drone.gridId, step: drone.step, ok: false, error: 'unreadable diag result' },
        at: now,
      });
      this.fail(drone, now, 'launch refused: release profile unreadable (no mass/physics read-back)');
      return;
    }
    const verdict = releaseVerdict(readout);
    this.store().audit({
      actor: 'demo-executor',
      action: 'launch_release_verify',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: { gridId: drone.gridId, step: drone.step, readout, verdict },
      at: now,
    });
    if (verdict.needsConvert) {
      if (drone.step === RELEASE_STEP_PROFILE) {
        drone.step = RELEASE_STEP_CONVERT;
        this.saveDrone(drone);
        return;
      }
      this.fail(drone, now, STATIC_CONVERT_PENDING);
      return;
    }
    if (!verdict.ok) {
      this.fail(drone, now, verdict.reason ?? 'launch refused: grid is not flyable after release');
      return;
    }
    drone.step = 'move';
    this.saveDrone(drone);
  }

  private resolvePending(exec: ExecRow, drone: DroneRow, now: number): void {
    const orderId = drone.pendingOrder!;
    const order = this.store().getOrder(orderId);
    const action = drone.pendingAction ?? '';
    if (!order) {
      drone.pendingOrder = null;
      this.saveDrone(drone);
      return;
    }
    if (order.status === 'sent' && now - (drone.pendingAt ?? now) > ORDER_TIMEOUT_MS) {
      // No ack: retry with a new id, capped.
      drone.pendingOrder = null;
      drone.pendingAction = null;
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_order_timeout',
        subject: orderId,
        detail: { action, attempts: drone.attempts },
        at: now,
      });
      if (drone.attempts >= MAX_SAVE_ATTEMPTS) {
        // Housekeeping after a confirmed touchdown is a warning, never FAILED
        // (2026-11-11): the hull is already down and the mission is decided.
        if (this.afterTouchdown(drone)) {
          this.landedHousekeepingWarning(drone, now, action, `no ack after ${MAX_SAVE_ATTEMPTS} attempts`);
        } else {
          this.fail(drone, now, `${action}: no ack after ${MAX_SAVE_ATTEMPTS} attempts`);
        }
      }
      return;
    }
    if (order.status !== 'acked' && order.status !== 'failed') return;

    const result = this.resultFor(orderId);
    const ok = order.status === 'acked' && (result?.ok !== false);
    drone.pendingOrder = null;
    drone.pendingAction = null;
    this.saveDrone(drone);

    // Launch preflight: the release steps are deliberately tolerant. A landing
    // gear may be absent, a connector may not know `Disconnect`, and a static
    // grid cannot be converted until the plugin ships that action; the final
    // diag read is what decides whether the drone may fly.
    if (action === 'set_block_props' && this.isReleaseBlockStep(drone.step)) {
      const r = result?.result as { count?: number; blocksWithErrors?: number } | undefined;
      this.store().audit({
        actor: 'demo-executor',
        action: 'launch_release',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          step: drone.step,
          ok,
          error: result?.error ?? null,
          count: r?.count ?? null,
          blocksWithErrors: r?.blocksWithErrors ?? null,
        },
        at: now,
      });
      if (drone.step === RELEASE_STEP_GEARS) drone.step = RELEASE_STEP_CONNECTORS;
      else if (drone.step === RELEASE_STEP_CONNECTORS) drone.step = RELEASE_STEP_PROFILE;
      else if (drone.step === RELEASE_STEP_RELOCK) drone.step = 'relock_done';
      else if (drone.step === STAGING_STEP_HANDOFF) drone.step = 'ai_off';
      this.saveDrone(drone);
      return;
    }
    if (action === 'is_under_control' && drone.step === 'station_check') {
      const under = !!(result?.result as { underControl?: unknown } | undefined)?.underControl;
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_station_check',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: { gridId: drone.gridId, underControl: under, ok, error: result?.error ?? null },
        at: now,
      });
      if (!ok) {
        drone.step = null;
        this.saveDrone(drone);
        return;
      }
      if (under) {
        // Manual handoff: a player owns this ship now. Fly nothing, station nothing.
        drone.step = null;
        drone.reason = 'manual control: not stationing';
        this.saveDrone(drone);
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_station_skipped',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: { gridId: drone.gridId, reason: 'manual control' },
          at: now,
        });
        return;
      }
      // SE refuses IsStatic while the body still moves, and a hovering relay
      // sits at ~1 m/s forever. Zero both speed vectors first, let them settle
      // for 2 s, then convert; up to 3 attempts.
      const stationGuard = this.guardState(drone);
      stationGuard.stationAttempts = 0;
      stationGuard.stationSpeedMps = null;
      stationGuard.stationGiveUpAt = null;
      if (this.survivalMode) {
        // T74: zero_velocity IS a teleport. In survival the only legal way to
        // stop a hull is its own dampeners, so ask for that and let the poll
        // loop below convert once |v| < 0.5 m/s. No spawn, no matrix write.
        this.store().audit({
          actor: 'demo-executor',
          action: 'demo_station_stop',
          subject: `${drone.missionId}:${drone.idx}`,
          detail: { gridId: drone.gridId, mode: 'dampeners', reason: 'survival mode: no zero_velocity', at: now },
          at: now,
        });
        this.setDampeners(exec, drone, now, true, 'station stop (survival)');
        stationGuard.stationZeroAt = now;
        drone.step = 'station_wait';
        this.saveDrone(drone);
        return;
      }
      this.send(exec, drone, now, 'test', drone.gridId!, 'zero_velocity', zeroVelocityOrder(drone.gridId!));
      drone.step = 'station_zeroing';
      this.saveDrone(drone);
      return;
    }
    if (action === 'zero_velocity' && (drone.step === 'station_zeroing' || drone.step === 'station_retry')) {
      const gs = this.guardState(drone);
      const r = result?.result as { speedBeforeMs?: unknown; speedAfterMs?: unknown; zeroed?: unknown } | undefined;
      const speedBeforeMs = typeof r?.speedBeforeMs === 'number' ? r.speedBeforeMs : null;
      const speedAfterMs = typeof r?.speedAfterMs === 'number' ? r.speedAfterMs : null;
      gs.stationSpeedMps = speedAfterMs ?? speedBeforeMs ?? gs.stationSpeedMps;
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_station_zero',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          ok,
          speedBeforeMs,
          speedAfterMs,
          zeroed: r?.zeroed === true,
          attempt: gs.stationAttempts + 1,
          error: result?.error ?? null,
        },
        at: now,
      });
      if (!ok) {
        gs.stationAttempts += 1;
        if (gs.stationAttempts >= STATION_MAX_ATTEMPTS) {
          gs.stationGiveUpAt = now;
          drone.step = null;
          drone.reason = `station refused: zero_velocity failed ${gs.stationAttempts}x (${result?.error ?? 'nack'})`;
          this.saveDrone(drone);
          return;
        }
        this.send(exec, drone, now, 'test', drone.gridId!, 'zero_velocity', zeroVelocityOrder(drone.gridId!));
        drone.step = 'station_zeroing';
        this.saveDrone(drone);
        return;
      }
      gs.stationZeroAt = now;
      drone.step = 'station_wait';
      this.saveDrone(drone);
      return;
    }
    if (action === 'convert_to_station') {
      const r = result?.result as { isStaticAfter?: unknown; positionDriftM?: unknown; aglM?: unknown; speedBeforeMs?: unknown } | undefined;
      const staticNow = r?.isStaticAfter === true;
      const gs = this.guardState(drone);
      const speedMs = typeof r?.speedBeforeMs === 'number' ? r.speedBeforeMs : gs.stationSpeedMps;
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_station',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: {
          gridId: drone.gridId,
          ok,
          static: staticNow,
          driftM: r?.positionDriftM ?? null,
          aglM: r?.aglM ?? null,
          speedMs,
          attempt: gs.stationAttempts + 1,
          error: result?.error ?? null,
        },
        at: now,
      });
      if (!ok || !staticNow) {
        gs.stationAttempts += 1;
        const refusal = String(result?.error ?? 'grid did not become static');
        // The plugin's refusal names the speed it measured ("refused: speed
        // 1.4 m/s > 0.5 m/s"); report that number, never the pre-zeroing one.
        const named = /speed\s+([0-9]+(?:\.[0-9]+)?)\s*m\/s/i.exec(refusal);
        const refusedSpeed = typeof r?.speedBeforeMs === 'number'
          ? r.speedBeforeMs
          : named
            ? Number(named[1])
            : speedMs;
        if (refusedSpeed !== null) gs.stationSpeedMps = refusedSpeed;
        if (gs.stationAttempts < STATION_MAX_ATTEMPTS) {
          this.store().audit({
            actor: 'demo-executor',
            action: 'demo_station_retry',
            subject: `${drone.missionId}:${drone.idx}`,
            detail: { gridId: drone.gridId, attempt: gs.stationAttempts, speedMs: refusedSpeed, refusal },
            at: now,
          });
          if (this.survivalMode) {
            // Retry = dampeners again and wait; never a zeroing.
            this.setDampeners(exec, drone, now, true, 'station retry (survival)');
            gs.stationZeroAt = now;
            drone.step = 'station_wait';
            this.saveDrone(drone);
            return;
          }
          this.send(exec, drone, now, 'test', drone.gridId!, 'zero_velocity', zeroVelocityOrder(drone.gridId!));
          drone.step = 'station_retry';
          this.saveDrone(drone);
          return;
        }
        gs.stationGiveUpAt = now;
        drone.step = null;
        drone.reason = `station refused after ${gs.stationAttempts} tries` +
          (refusedSpeed !== null ? ` at ${refusedSpeed.toFixed(2)} m/s` : '') +
          `: ${refusal}`;
        this.saveDrone(drone);
        return;
      }
      drone.step = STATIONED_STEP;
      drone.reason = 'stationed: static grid, free hold, no thrust';
      drone.holdAt = now;
      gs.stationAttempts = 0;
      gs.stationGiveUpAt = null;
      this.saveDrone(drone);
      return;
    }
    if (action === 'diag') {
      this.handleReleaseReadout(drone, now, ok, result?.result);
      return;
    }
    if (action === 'convert_to_ship') {
      this.store().audit({
        actor: 'demo-executor',
        action: 'launch_release_convert',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: { gridId: drone.gridId, ok, error: result?.error ?? null },
        at: now,
      });
      if (!ok) {
        // Documented refusal: the plugin action is added by the next plugin
        // restart; until then a static grid cannot be launched.
        this.fail(drone, now, STATIC_CONVERT_PENDING);
        return;
      }
      drone.step = RELEASE_STEP_VERIFY;
      this.saveDrone(drone);
      return;
    }

    if (!ok) {
      const error = String(result?.error ?? order.payload?.error ?? 'nack');
      if (this.afterTouchdown(drone)) {
        // The hull is on the ground: a rejected gear lock / mag plate / save
        // order is a warning on a completed landing, never a FAILED mission.
        this.landedHousekeepingWarning(drone, now, action, `${error} (after ${drone.attempts} attempts)`);
      } else if (drone.attempts >= MAX_SAVE_ATTEMPTS) {
        this.fail(drone, now, `${action} failed ${drone.attempts}x: ${error}`);
      } else {
        this.setState(drone, drone.state, now, `${action} failed, retrying: ${error}`);
      }
      return;
    }

    switch (action) {
      case 'identity': {
        const id = String((result?.result as { identityId?: string } | undefined)?.identityId ?? '');
        if (id) {
          this.identityId = id;
          this.store().setKv('demo:identityId', id);
        }
        return;
      }
      case 'spawn_prefab':
      case 'clone_grid': {
        // The harness returns the new grid id when it resolves synchronously;
        // DisplayName is the prefab name, so a name match is not reliable.
        const spawned = (result?.result as { gridId?: string } | undefined)?.gridId;
        if (typeof spawned === 'string' && spawned.startsWith('grid:')) {
          drone.gridId = spawned;
          drone.step = 'ownership_check';
          this.recordSpawn(spawned, drone, now);
          this.setState(drone, 'securing', now, `grid ${spawned} spawned (id from the order result)`);
          return;
        }
        this.setState(drone, 'spawning', now, 'spawn acked; locating the grid');
        return;
      }
      case 'list_grids': {
        // DisplayName is the prefab name, not the requested name, so identify
        // the new grid by position (unique spawn points, 220 m apart) and by
        // the fact that no other drone in this mission has claimed it.
        type GridRow = { gridId: string; name?: string; position?: Vec3 };
        const grids = ((result?.result as { grids?: GridRow[] } | undefined)?.grids ?? []);
        const claimed = new Set(
          (this.store().db
            .prepare(`SELECT grid_id FROM demo_drones WHERE mission_id = ? AND grid_id IS NOT NULL AND idx <> ?`)
            .all(drone.missionId, drone.idx) as { grid_id: string }[]).map((r) => r.grid_id),
        );
        const hit = grids.find(
          (g) =>
            g.position &&
            !claimed.has(g.gridId) &&
            dist(g.position, drone.spawn) < 400,
        );
        if (hit) {
          drone.gridId = hit.gridId;
          drone.step = 'ownership_check';
          this.recordSpawn(hit.gridId, drone, now, hit.name ?? null);
          this.setState(drone, 'securing', now, `grid ${hit.gridId} found`);
        } else if ((drone.attempts ?? 0) >= 8) {
          this.fail(drone, now, `spawned grid near ${JSON.stringify(drone.spawn)} never appeared in list_grids`);
        }
        return;
      }
      case 'ownership':
        drone.step = 'ownership_check';
        this.saveDrone(drone);
        return;
      case 'ownership_check': {
        const applied = Boolean((result?.result as { applied?: boolean } | undefined)?.applied);
        if (applied) {
          drone.step = 'wake';
          this.saveDrone(drone);
          return;
        }
        // Not ours. The takeover is an admin action: the test world may do it,
        // survival may not, and survival must say so in plain language rather
        // than retrying a refused order (2026-11-11).
        if (!this.survivalMode) {
          drone.step = 'ownership';
          this.saveDrone(drone);
          return;
        }
        this.fail(
          drone,
          now,
          `grid ${drone.gridId} is not owned by you: the ownership takeover is an admin action, so in survival the grid ` +
            'must be claimed in game (sit in it and take ownership, or use the owner\'s own console) before a mission can fly it',
        );
        return;
      }
      case 'wake':
        // Staging owns hydrogen: `wake` turns every thruster on, so hand the
        // hydrogen bank to the controller before the first move instead of
        // burning the tank from the pad.
        drone.step = this.staging.enabled && !this.staging.dryRun ? STAGING_STEP_HANDOFF : 'ai_off';
        this.saveDrone(drone);
        return;
      case 'ai_off': {
        const r = result?.result as { stillAutopilot?: number; stillAiEnabled?: number } | undefined;
        if ((r?.stillAutopilot ?? 0) > 0 || (r?.stillAiEnabled ?? 0) > 0) {
          this.fail(drone, now, 'built-in AI still active after ai_off');
          return;
        }
        drone.step = RELEASE_STEP_GEARS;
        this.saveDrone(drone);
        return;
      }
      case 'move':
        this.setState(drone, 'en_route', now, 'move acked');
        return;
      case 'hold':
        // Come to me parks in `waiting_pilot`; its arrival hold settling is not
        // a normal hold (a normal hold would re-anchor and finish the mission).
        if (drone.state === 'waiting_pilot') return;
        this.setState(drone, 'holding', now, 'holding at slot');
        return;
      case 'stop':
        this.setState(drone, 'stopped', now, 'stop acked (kill switch)');
        return;
      default:
        return;
    }
  }

  /**
   * A grid that just spawned reports no antenna state for a tick or two, so
   * `gameLink: unknown` is retryable (bounded); a reported link-down is not.
   * Without this, the first post-wake move order was denied and the drone was
   * failed with "telemetry is stale (187 ms old)" even though it was fresh.
   */
  private waitForLink(drone: DroneRow, now: number, gate: CommsGate): boolean {
    const retryable = gate.gameLink === 'unknown' || gate.gameLink === 'no-telemetry';
    if (!retryable) return false;
    drone.gateWaits += 1;
    if (drone.gateWaits > GATE_WAIT_TICKS) {
      this.fail(drone, now, `no link telemetry after ${GATE_WAIT_TICKS} s: ${gate.reason}`);
      return true;
    }
    this.setState(drone, drone.state, now, `waiting for link telemetry (${drone.gateWaits}/${GATE_WAIT_TICKS}): ${gate.reason}`);
    return true;
  }

  /**
   * Concurrency budget for climbs. `settings.maxActive` is the owner's ceiling
   * for a demo; `RTS_DEMO_MAX_CLIMB` (default 3) is what the test server can
   * carry without dropping SimSpeed below the floor. 0 disables the cap.
   */
  private climbCap(): number {
    const configured = this.deps.config.demo.maxClimbConcurrent;
    if (!Number.isFinite(configured) || configured <= 0) return 0;
    const settings = readDesignerSettings(this.store());
    return Math.max(1, Math.min(configured, settings.maxActive));
  }

  /** Drones currently under a move order (climbing), across every execution. */
  private climbingCount(): number {
    const row = this.store().db
      .prepare(`SELECT COUNT(*) AS n FROM demo_drones WHERE state = 'en_route'`)
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Owner rule: no new flight orders while SimSpeed is below the configured
   * threshold (`RTS_SIMSPEED_MIN`, default 0.95). Unknown SimSpeed never
   * blocks. The drone keeps its current state so the order is retried as soon
   * as a healthy sample arrives.
   */
  private flightPaused(drone: DroneRow, now: number): boolean {
    const gate = this.deps.simSpeed;
    if (!gate || gate.flightsAllowed()) return false;
    const st = gate.status();
    const value = st.value === null ? 'unknown' : st.value.toFixed(2);
    this.setState(
      drone,
      drone.state,
      now,
      `SIMSPEED HOLD: ${value} < ${st.threshold.toFixed(2)} (${st.blocked ? 'sustained ' + Math.round(st.belowForMs / 1000) + ' s' : 'fresh sample'}); flight order withheld`,
    );
    return true;
  }

  private gateFor(drone: DroneRow, now: number): CommsGate {
    if (drone.adminOverride) {
      // T10 admin override (test server only): the reach half of the gate is
      // skipped, the game-link half is not. Every order still carries the
      // label so the audit trail never looks like a normal gate pass.
      const base = drone.gridId
        ? evaluateGate({
            store: this.store(),
            world: this.world(),
            now,
            nodeId: drone.gridId,
            freshMs: this.deps.config.demo.gateFreshMs,
            prefabFor: (id) => this.prefabForGrid(id),
          })
        : null;
      return {
        nodeId: drone.gridId ?? `drone:${drone.idx}`,
        gate: 'comms',
        allowed: true,
        source: 'SIMULATED',
        reason: `ADMIN OVERRIDE (test server): reachability bypassed${base ? `; link state: ${base.gameLink}` : ''}`,
        gameLink: base?.gameLink ?? 'no-telemetry',
        telemetryAgeMs: base?.telemetryAgeMs ?? null,
        plannerPath: base?.plannerPath ?? null,
        virtual: base?.virtual ?? false,
        labels: ['SIMULATED', 'ADMIN OVERRIDE (test server)'],
      };
    }
    if (!drone.gridId) {
      return {
        nodeId: `drone:${drone.idx}`,
        gate: 'comms',
        allowed: false,
        source: 'SIMULATED',
        reason: 'no grid id yet',
        gameLink: 'no-telemetry',
        telemetryAgeMs: null,
        plannerPath: null,
        virtual: false,
        labels: ['SIMULATED'],
      };
    }
    return evaluateGate({
      store: this.store(),
      world: this.world(),
      now,
      nodeId: drone.gridId,
      freshMs: this.deps.config.demo.gateFreshMs,
      prefabFor: (id) => this.prefabForGrid(id),
    });
  }

  private prefabForGrid(gridId: string): string | null {
    return sharedPrefabForGrid(this.store(), gridId);
  }

  private world(): DemoWorld {
    return loadWorld(this.store(), this.deps.fixturePath, this.now());
  }

  // -------------------------------------------------------------- safety

  emergencyStop(now: number): void {
    for (const exec of this.execs()) {
      for (const drone of this.drones(exec.missionId)) {
        if (!drone.gridId) {
          if (!TERMINAL.includes(drone.state)) this.setState(drone, 'stopped', now, 'kill switch: nothing spawned yet');
          continue;
        }
        // T27: a player-piloted grid gets no stop either; the pilot owns it.
        if (this.controls.isManual(drone.gridId)) continue;
        // A failed grid is still in the world and may be falling: stop it too.
        if (drone.stopSentAt || drone.state === 'skipped') continue;
        const orderId = `demo:${exec.missionId}:${drone.idx}:stop:k${now}`;
        const payload = {
          schemaVersion: 1 as const,
          type: 'order' as const,
          orderId,
          orderType: 'stop' as const,
          entityId: drone.gridId,
          params: { action: 'stop' },
          tick: 0,
          issuedAt: now,
          expiresAt: now + 30_000,
        };
        this.store().createOrder({
          orderId,
          missionId: exec.missionId,
          unitId: drone.gridId,
          orderType: 'stop',
          payload: payload as unknown as Record<string, unknown>,
          status: 'pending',
          attempts: 1,
          nextAttemptAt: 0,
          createdAt: now,
          ackedAt: null,
        });
        const sent = this.deps.hub.send(payload);
        drone.stopSentAt = now;
        drone.pendingOrder = null;
        drone.pendingAction = null;
        this.setState(drone, 'stopped', now, sent ? 'kill switch: stop sent' : 'kill switch: stop send failed (plugin offline)');
      }
    }
    this.store().setKv('demo:lastKillStopAt', String(now));
  }

  // --------------------------------------------------------------- debris

  /** Remember every grid we spawn so cleanup can delete exactly our debris. */
  private recordSpawn(gridId: string, drone: DroneRow, now: number, name: string | null = null): void {
    this.store().db
      .prepare(
        `INSERT OR IGNORE INTO demo_spawned (grid_id, mission_id, idx, name, spawned_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(gridId, drone.missionId, drone.idx, name, now);
  }

  /** Send a harness delete_grid order (test action, no comms gate: it removes). */
  private deleteGrid(gridId: string, now: number, reason: string): boolean {
    // T74: deleting a grid is admin-only. In survival ownership decides: the
    // operator grinds or re-tags the hull, the backend only stops commanding it.
    if (this.survivalMode) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'survival_refused',
        subject: gridId,
        detail: { reason: SURVIVAL_REASON, attempted: 'delete_grid', cleanupReason: reason },
        at: now,
      });
      this.store().db
        .prepare(`UPDATE demo_spawned SET deleted_at = ? WHERE grid_id = ? AND deleted_at IS NULL`)
        .run(now, gridId);
      return false;
    }
    const orderId = `demo-clean:${gridId}:${now}`;
    const wireType = this.orderChannel('delete_grid', now, gridId);
    if (!wireType) return false;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: wireType,
      entityId: gridId,
      params: { action: 'delete_grid', entityId: gridId },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    const sent = this.deps.hub.send(payload);
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_debris_delete',
      subject: gridId,
      detail: { reason, sent, orderId },
      at: now,
    });
    return sent;
  }

  /**
   * Delete grids whose drone is terminal. Holding grids survive only when the
   * operator opted in with RTS_DEMO_LEAVE_HOLDING=1 (owner inspection).
   */
  private cleanupTerminal(now: number): void {
    const rows = this.store().db
      .prepare(`SELECT grid_id, mission_id, idx, spawned_at FROM demo_spawned WHERE deleted_at IS NULL`)
      .all() as { grid_id: string; mission_id: string; idx: number; spawned_at: number }[];
    for (const row of rows) {
      const drone = this.drones(row.mission_id).find((d) => d.idx === row.idx);
      const exec = this.execs().find((e) => e.missionId === row.mission_id);
      const holding = drone?.state === 'holding';
      const terminalDrone = drone && ['failed', 'stopped', 'skipped'].includes(drone.state);
      const finished = exec && ['done', 'failed', 'cancelled'].includes(exec.state);
      // A waiting hover or a hand-piloted grid is the owner's ship, never
      // debris: deleting it would make "come to me" hand the pilot nothing.
      if (drone?.state === 'manual' || drone?.state === 'waiting_pilot') continue;
      // leaveHolding is the operator opt-in for "keep my ship in the world".
      // A kill-switch stop is not debris: deleting the stopped drone made the
      // owner's ship vanish the moment the switch was released.
      const keep = (holding || drone?.state === 'stopped') && this.deps.config.demo.leaveHolding;
      if (keep) continue;
      // Give a stop/fail grace period so the stop order lands before removal.
      if (terminalDrone && now - (drone?.updatedAt ?? now) < 3_000) continue;
      if (!terminalDrone && !finished) continue;
      if (drone && holding && finished) {
        // Mission ended with the drone still holding: delete unless opted in.
      }
      if (this.deleteGrid(row.grid_id, now, terminalDrone ? `drone ${drone!.state}` : 'mission finished')) {
        this.store().db.prepare(`UPDATE demo_spawned SET deleted_at = ? WHERE grid_id = ?`).run(now, row.grid_id);
      }
    }
  }

  /**
   * Delete harness-spawned grids older than `olderThanMin` minutes (0 = all).
   * Uses the spawn registry only: a player grid is never in it. `dryRun` only
   * reports what would be removed, so a pre-run check can use the same code.
   */
  cleanupStale(
    olderThanMin: number,
    now = this.now(),
    dryRun = false,
    missionId?: string,
  ): { considered: number; deleted: string[]; failed: string[]; dryRun: boolean; liveGrids: number } {
    const cutoff = now - Math.max(0, olderThanMin) * 60_000;
    const rows = this.store().db
      .prepare(
        `SELECT grid_id, mission_id, idx, spawned_at FROM demo_spawned
         WHERE deleted_at IS NULL AND spawned_at <= ?${missionId ? ' AND mission_id = ?' : ''}
         ORDER BY spawned_at`,
      )
      .all(...(missionId ? [cutoff, missionId] : [cutoff])) as {
      grid_id: string;
      mission_id: string;
      idx: number;
      spawned_at: number;
    }[];
    const deleted: string[] = [];
    const failed: string[] = [];
    if (dryRun) return { considered: rows.length, deleted, failed, dryRun, liveGrids: this.liveGridCount(now) };
    for (const row of rows) {
      if (this.deleteGrid(row.grid_id, now, `cleanup_stale (>${olderThanMin} min)`)) {
        this.store().db.prepare(`UPDATE demo_spawned SET deleted_at = ? WHERE grid_id = ?`).run(now, row.grid_id);
        deleted.push(row.grid_id);
      } else {
        failed.push(row.grid_id);
      }
    }
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_cleanup_stale',
      subject: missionId ?? 'all',
      detail: { olderThanMin, considered: rows.length, deleted: deleted.length, failed: failed.length },
      at: now,
    });
    return { considered: rows.length, deleted, failed, dryRun, liveGrids: this.liveGridCount(now) };
  }

  /** Live grid count from fresh plugin telemetry (stale rows are ignored). */
  liveGridCount(now = this.now()): number {
    const freshMs = Math.max(this.deps.config.demo.gateFreshMs, 60_000);
    const row = this.store().db
      .prepare(`SELECT COUNT(*) AS n FROM units WHERE last_seen >= ?`)
      .get(now - freshMs) as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Refuse a new run when the world already holds too much debris. */
  assertWorldReady(now = this.now()): { ok: true; liveGrids: number } | { ok: false; liveGrids: number; max: number } {
    const liveGrids = this.liveGridCount(now);
    const max = this.deps.config.demo.maxGridsBeforeRun;
    if (liveGrids > max) {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_run_refused',
        subject: 'grid-count',
        detail: { liveGrids, max, note: 'run cleanup_stale before starting a demo mission' },
        at: now,
      });
      return { ok: false, liveGrids, max };
    }
    return { ok: true, liveGrids };
  }

  // --------------------------------------------------------------- helpers

  private planetCenterFor(drone: DroneRow, _exec: ExecRow): Vec3 {
    const planet = (drone.planet ? planetByName(drone.planet) : null) ?? nearestPlanet(drone.spawn);
    return vec(planet?.center) ?? { x: 0, y: 0, z: 0 };
  }

  private ensureIdentity(now: number): void {
    if (this.identityId) return;
    const cached = this.store().getKv('demo:identityId');
    if (cached && /^\d+$/.test(cached)) {
      this.identityId = cached;
      return;
    }
    // Resolved by the first spawn step's identity order; see resolvePending.
    void now;
  }

  private resultFor(orderId: string): { ok?: boolean; error?: string; result?: unknown } | null {
    const entries = this.store().listOrderResults(500);
    for (const entry of entries) {
      const detail = entry.detail as { eventType?: string; data?: { orderId?: string } };
      if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result') continue;
      const data = detail.data as { orderId?: string; ok?: boolean; error?: string; result?: unknown };
      if (data?.orderId === orderId) return data;
    }
    return null;
  }

  /**
   * Did the plugin's `land_at` job report TOUCHDOWN? Its end state carries
   * `phase: 'landed'` (and the plain reason "touchdown: hull bottom N m AGL" or
   * "contact: ..."), and a job that ended `aborted` never reports landed.
   * Absent or unreadable = false: the telemetry contact band decides instead.
   */
  private pluginLandedReport(orderId: string | null | undefined): boolean {
    if (!orderId) return false;
    const result = this.resultFor(orderId);
    if (!result || result.ok === false) return false;
    const payload = result.result as { phase?: unknown; landed?: unknown; state?: unknown } | null;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.landed === true) return true;
    const phase = typeof payload.phase === 'string' ? payload.phase.toLowerCase() : '';
    const state = typeof payload.state === 'string' ? payload.state.toLowerCase() : '';
    return phase === 'landed' || state === 'landed';
  }

  /**
   * The hull is DOWN and the mission's outcome is decided (2026-11-11).
   *
   * `finishLanding` sends the gear lock as housekeeping AFTER the touchdown
   * rule has already fired; the drone's step is `landed` from then on. A plugin
   * that rejects that order (the pre-cf3e70b build cast the `type` array to a
   * string) must not turn a landed mission into FAILED — measured in game, the
   * ship was on the ground and the mission list said FAILED.
   */
  private afterTouchdown(drone: DroneRow): boolean {
    return drone.step === LANDING_STEP_LOCKED;
  }

  /**
   * A housekeeping order (gear lock / magnetic plate / save attempt) failed
   * after a CONFIRMED touchdown: record a WARNING (audit row naming the step +
   * the mission's own note), keep the landed state and let the mission complete
   * as landed. A real touchdown failure (impact, block loss, abort) never gets
   * here: those abort the descent BEFORE `finishLanding`, so the step is not
   * `landed` and `fail()` is still used.
   */
  private landedHousekeepingWarning(drone: DroneRow, now: number, action: string, reason: string): void {
    const note = `landed; housekeeping order ${action} failed: ${reason}`;
    this.store().audit({
      actor: 'demo-executor',
      action: 'demo_landing_housekeeping_warning',
      subject: `${drone.missionId}:${drone.idx}`,
      detail: {
        gridId: drone.gridId,
        step: drone.step,
        failedAction: action,
        reason,
        level: 'warning',
        note:
          'the hull touched down and stays landed; the rejected order was housekeeping (gear lock / ' +
          'magnetic plate / save), not flight, so the mission completes as landed with this warning',
      },
      at: now,
    });
    // The mission's own note (demo_exec.note, exposed as `executions[].note`)
    // names the step that failed, so the warning survives in the record.
    this.store().db
      .prepare(
        `UPDATE demo_exec SET note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || '; ' || ? END,
           updated_at = ? WHERE mission_id = ?`,
      )
      .run(note, note, now, drone.missionId);
    this.store().addAlert({
      kind: 'landing_warning',
      message: `${drone.label}: ${note}`,
      missionId: drone.missionId,
      at: now,
    });
    this.setState(drone, 'holding', now, `landed with a warning: ${action} failed (${reason})`);
  }

  private fail(drone: DroneRow, now: number, reason: string): void {
    drone.pendingOrder = null;
    drone.pendingAction = null;
    // A failed flight gets the same plain-language post-mortem as an abort.
    const text = this.postmortemText(drone, 'failed', reason);
    this.postMortem(drone, now, text);
    this.store().addAlert({
      kind: 'flight_failed',
      message: `${drone.label}: ${reason}`,
      missionId: drone.missionId,
      at: now,
    });
    this.setState(drone, 'failed', now, reason);
  }

  private setState(drone: DroneRow, state: DroneState, now: number, reason: string | null): void {
    const changed = drone.state !== state;
    drone.state = state;
    drone.reason = reason;
    drone.updatedAt = now;
    this.saveDrone(drone);
    if (changed || state === 'failed') {
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_drone_state',
        subject: `${drone.missionId}:${drone.idx}`,
        detail: { state, reason, gridId: drone.gridId },
        at: now,
      });
    }
    // T50: a fleet step is a mission on one grid; its completion is read from
    // this executor state (gridStates), never from raw telemetry distance.
  }

  // ----------------------------------------------------- T50 fleet accessors

  /** T50: flight orders sent for one executor drone (a fleet step is one flight). */
  ordersSent(drone: DroneRow): number {
    if (typeof drone.ordersSent === 'number') return drone.ordersSent;
    return this.store().countAudit('demo_flight_order', `${drone.missionId}:${drone.idx}`);
  }

  /**
   * T50: read-only view of the executor's per-drone state for one grid. The
   * fleet service tracks a step from this (holding / stationed / failed /
   * aborted / manual), never by inferring arrival from raw telemetry.
   */
  gridStates(gridId: string): { missionId: string; state: DroneState; step: string | null; reason: string | null; ordersSent: number }[] {
    const out: { missionId: string; state: DroneState; step: string | null; reason: string | null; ordersSent: number }[] = [];
    for (const exec of this.execs()) {
      for (const drone of this.drones(exec.missionId)) {
        if (drone.gridId !== gridId) continue;
        out.push({
          missionId: drone.missionId,
          state: drone.state,
          step: drone.step,
          reason: drone.reason,
          ordersSent: this.ordersSent(drone),
        });
      }
    }
    return out;
  }

  private saveDrone(drone: DroneRow): void {
    this.store().db
      .prepare(
        `UPDATE demo_drones SET state = ?, grid_id = ?, attempts = ?, reason = ?, step = ?, gate_waits = ?, pending_order = ?,
           pending_action = ?, pending_at = ?, hold_at = ?, stop_sent_at = ?, spawn_mode = ?, admin_override = ?, landing_json = ?,
           exec_slot_json = ?, updated_at = ?
         WHERE mission_id = ? AND idx = ?`,
      )
      .run(
        drone.state,
        drone.gridId,
        drone.attempts,
        drone.reason,
        drone.step,
        drone.gateWaits,
        drone.pendingOrder,
        drone.pendingAction,
        drone.pendingAt,
        drone.holdAt,
        drone.stopSentAt,
        drone.spawnMode,
        drone.adminOverride ? 1 : 0,
        drone.landing ? JSON.stringify(drone.landing) : null,
        // The exec slot IS a state field: a correction written to `drone.execSlot`
        // (the come-to-me hold datum, 2026-11-11) used to be in-memory only and
        // was lost on the next tick's re-read, so the hold flew the old point.
        JSON.stringify(drone.execSlot),
        drone.updatedAt,
        drone.missionId,
        drone.idx,
      );
  }

  private execs(): ExecRow[] {
    const rows = this.store().db.prepare(`SELECT * FROM demo_exec`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      missionId: String(r.mission_id),
      state: String(r.state),
      scaled: Number(r.scaled) === 1,
      total: Number(r.total),
      cap: Number(r.cap),
      note: (r.note as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  private drones(missionId: string): DroneRow[] {
    const rows = this.store().db
      .prepare(`SELECT * FROM demo_drones WHERE mission_id = ? ORDER BY idx`)
      .all(missionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      missionId: String(r.mission_id),
      idx: Number(r.idx),
      label: String(r.label),
      prefab: String(r.prefab),
      role: (r.role as string | null) ?? null,
      planet: (r.planet as string | null) ?? null,
      planSlot: json(String(r.plan_slot_json), { x: 0, y: 0, z: 0 }),
      execSlot: json(String(r.exec_slot_json), { x: 0, y: 0, z: 0 }),
      spawn: json(String(r.spawn_json), { x: 0, y: 0, z: 0 }),
      state: String(r.state) as DroneState,
      gridId: (r.grid_id as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
      reason: (r.reason as string | null) ?? null,
      step: (r.step as string | null) ?? null,
      gateWaits: Number(r.gate_waits ?? 0),
      pendingOrder: (r.pending_order as string | null) ?? null,
      pendingAction: (r.pending_action as string | null) ?? null,
      pendingAt: r.pending_at === null ? null : Number(r.pending_at),
      holdAt: r.hold_at === null ? null : Number(r.hold_at),
      stopSentAt: r.stop_sent_at === null ? null : Number(r.stop_sent_at),
      spawnMode: (r.spawn_mode as SpawnMode | null) ?? 'surface',
      adminOverride: Number(r.admin_override ?? 0) === 1,
      landing: (json(String(r.landing_json ?? ''), null) as LandingIntent | null) ?? null,
      updatedAt: Number(r.updated_at),
    }));
  }

  private finishIfDone(exec: ExecRow, now: number): void {
    const drones = this.drones(exec.missionId);
    if (!drones.length) return;
    const comeToMe = this.comeToMeOf(exec.missionId);
    const pending = drones.filter((d) => !TERMINAL.includes(d.state));
    // A mission paused for manual control is not finished: the owner's ship is
    // still in the world and a new order is what resumes work.
    const missionStatus = this.store().getMission(exec.missionId)?.status;
    if (missionStatus === 'paused') return;
    const anyHolding = drones.some((d) => d.state === 'holding');
    // Come to me owns its own end while somebody can still take over: a
    // waiting hover is not "done" (nobody has landed it yet) and a handed-over
    // one is already marked done by `handToPilot`. Letting the generic rule run
    // then would report a hover as finished the moment it arrived.
    //
    // It does NOT own the end of a run whose drones are all terminal
    // (2026-11-11, the phantom `running` execution): a come-to-me mission whose
    // only drone aborted sat in `running` for ever, so every consumer of
    // `executions.active` over-counted it and the site showed a mission that no
    // ship was flying. All-terminal means the run is over, whatever the mode.
    if (comeToMe && (pending.length > 0 || drones.some((d) => d.state === 'waiting_pilot'))) return;
    if (pending.length === 0 && exec.state === 'running') {
      const mission = this.store().getMission(exec.missionId);
      // A SUPERSEDED run did not fail (2026-11-11, set 3): when a newer order
      // for the grid cancelled this mission, every drone is `stopped` and the
      // generic rule below recorded the run as `failed` with "the come-to-me
      // hover ended without a handoff" - a controller blamed for obeying. A
      // cancelled mission ends its run `cancelled`, with the reason.
      const cancelledByOrder = mission?.status === 'cancelled';
      const finalState = cancelledByOrder ? 'cancelled' : anyHolding ? 'done' : 'failed';
      const reason = cancelledByOrder
        ? `closed: ${mission?.pauseReason ?? 'the mission was cancelled by a newer order for this grid'}; ` +
          `this run ended on that order, not on a controller failure (${drones.map((d) => `${d.idx}:${d.state}`).join(', ')})`
        : comeToMe
          ? `closed: no drone is hovering for a pilot any more (${drones
              .map((d) => `${d.idx}:${d.state}`)
              .join(', ')}); the come-to-me hover ended without a handoff`
          : null;
      this.store().db
        .prepare(`UPDATE demo_exec SET state = ?, note = COALESCE(?, note), updated_at = ? WHERE mission_id = ?`)
        .run(finalState, reason, now, exec.missionId);
      if (mission && (mission.status === 'executing' || mission.status === 'approved')) {
        this.store().updateMission(exec.missionId, { status: finalState, ...(reason ? { pauseReason: reason } : {}) }, now);
      }
      this.store().audit({
        actor: 'demo-executor',
        action: 'demo_exec_finished',
        subject: exec.missionId,
        detail: {
          state: finalState,
          drones: drones.length,
          droneStates: drones.map((d) => `${d.idx}:${d.state}`),
          ...(reason ? { reason } : {}),
        },
        at: now,
      });
    }
  }

  // ------------------------------------------------------------------ view

  summary(): Record<string, unknown> {
    const now = this.now();
    const execs = this.execs().map((exec) => {
      const drones = this.drones(exec.missionId).map((d) => {
        const unit = d.gridId ? this.store().getUnit(d.gridId) : null;
        const remaining = unit?.pos ? dist(unit.pos, d.execSlot) : null;
        const speed = unit?.vel ? Math.hypot(unit.vel.x, unit.vel.y, unit.vel.z) : 0;
        const speedForEta = Math.max(speed, this.deps.config.demo.speedLimitMps * 0.5);
        return {
          idx: d.idx,
          label: d.label,
          prefab: d.prefab,
          role: d.role,
          planet: d.planet,
          spawnMode: d.spawnMode,
          state: d.state,
          gridId: d.gridId,
          adminOverride: d.adminOverride,
          reason: d.reason,
          attempts: d.attempts,
          planSlot: d.planSlot,
          execSlot: d.execSlot,
          spawn: d.spawn,
          position: unit?.pos ?? null,
          remainingM: remaining,
          speedMps: speed,
          etaSec: remaining !== null && d.state === 'en_route' ? Math.ceil(remaining / speedForEta) : null,
          holdSince: d.holdAt,
          guard: this.guards.get(`${d.missionId}:${d.idx}`)?.lastVerdict ?? null,
          staging: this.staging.view(d.gridId),
          stagingLine: this.staging.line(d.gridId),
          /** T27: live player-control view (state already reads 'manual'). */
          control: this.controls.view(d.gridId),
          /** T61: who is aboard and the limits the grid is flown under. */
          crew: d.gridId ? this.controls.crew(d.gridId) : null,
          passengers: d.gridId ? this.passengerLimitsFor(d, unit) : null,
          // T19: station mode (static grid, free hold).
          stationed: d.step === STATIONED_STEP,
          stationState: d.step === STATIONED_STEP
            ? 'stationed'
            : d.step === STATIONING_STEP || d.step === 'station_check'
              ? 'converting'
              : d.state === 'holding'
                ? 'ship'
                : null,
          updatedAt: d.updatedAt,
        };
      });
      const holding = drones.filter((d) => d.state === 'holding').length;
      return {
        missionId: exec.missionId,
        state: exec.state,
        scaled: exec.scaled,
        total: exec.total,
        cap: exec.cap,
        note: exec.note,
        counts: {
          queued: drones.filter((d) => d.state === 'queued').length,
          spawning: drones.filter((d) => d.state === 'spawning').length,
          securing: drones.filter((d) => d.state === 'securing').length,
          enRoute: drones.filter((d) => d.state === 'en_route').length,
          holding,
          stopped: drones.filter((d) => d.state === 'stopped').length,
          failed: drones.filter((d) => d.state === 'failed').length,
          skipped: drones.filter((d) => d.state === 'skipped').length,
          deferred: drones.filter((d) => d.state === 'deferred').length,
          manual: drones.filter((d) => d.state === 'manual').length,
          waitingPilot: drones.filter((d) => d.state === 'waiting_pilot').length,
        },
        drones,
      };
    });
    const designerSettings = readDesignerSettings(this.store());
    return {
      enabled: this.enabled(),
      killSwitch: this.store().isKillSwitchOn(),
      speedLimitMps: this.deps.config.demo.speedLimitMps,
      maxDronesPerMission: designerSettings.maxActive,
      maxActiveStandIns: this.deps.config.demo.maxActiveStandIns,
      legM: this.deps.config.demo.legM,
      simSpeedMin: designerSettings.simSpeedMin,
      simSpeed: this.deps.simSpeed?.status() ?? null,
      flightGate: this.deps.simSpeed
        ? this.deps.simSpeed.flightsAllowed()
          ? 'open'
          : 'SIMSPEED HOLD'
        : 'not-wired',
      debris: {
        liveGrids: this.liveGridCount(now),
        maxBeforeRun: this.deps.config.demo.maxGridsBeforeRun,
        leaveHolding: this.deps.config.demo.leaveHolding,
        registered: Number(
          (this.store().db.prepare(`SELECT COUNT(*) AS n FROM demo_spawned WHERE deleted_at IS NULL`).get() as { n: number }).n,
        ),
        deleted: Number(
          (this.store().db.prepare(`SELECT COUNT(*) AS n FROM demo_spawned WHERE deleted_at IS NOT NULL`).get() as { n: number }).n,
        ),
      },
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      identity: this.identityId !== null,
      staging: { enabled: this.staging.enabled, dryRun: this.staging.dryRun, tickMs: this.staging.tickMs },
      /** T27: grids held for manual control; no order leaves for these. */
      manualControl: this.controls.list(),
      active: execs.reduce((n, e) => n + e.drones.filter((d) => FLYING.includes(d.state as DroneState)).length, 0),
      executions: execs,
      labels: ['SIMULATED', 'SCALED DEMO'],
      now,
    };
  }
}

export function isDemoMission(mission: Mission): boolean {
  if (isDesignerMission(mission)) return true;
  return (mission.plan.steps ?? []).some(
    (s) => s.id === 'gate' && typeof s.params?.demoGateNode === 'string',
  );
}

/** T50: input for a single-grid move mission, exactly the shape move-to creates. */
export interface GridMoveMissionInput {
  gridId: string;
  target: { x: number; y: number; z: number };
  gateNodeId: string;
  /** Ship roles: the owner confirmed an explicit fleet move of a PERSONAL ship. */
  personalConfirmed?: boolean;
}

/** Grid ids are strings and may contain ':' — mirrors the route's idPart. */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

/**
 * T50: create the same `move:` demo mission that POST /api/demo/move-to
 * creates, so an existing grid is flown by the executor and gets every flight
 * guard (brakes, arrival caps, ground/reserve, collision, manual silence,
 * descent profile, station verify, staging). Nothing is sent here: the caller
 * approves the mission and ticks the executor.
 */
export function gridMoveMission(input: GridMoveMissionInput): MissionCreate {
  return {
    type: 'move',
    priority: 50,
    desiredState: {
      shipSpec: 'stand-in-grid',
      station: `move:${idPart(input.gridId)}`,
      formation: 'none',
      position: input.target,
      ...(input.personalConfirmed === true ? { personalConfirmed: true } : {}),
    },
    budget: { resources: {}, timeMin: 60, lossLimit: 0 },
    approval: 'approve',
    assignedUnits: [input.gridId],
    plan: {
      steps: [
        { id: 'validate', kind: 'validate_spec', params: {}, done: false },
        { id: 'move', kind: 'move', params: { gridId: input.gridId, target: input.target }, done: false },
        { id: 'gate', kind: 'custom', params: { demoGateNode: input.gateNodeId, action: 'move' }, done: false },
      ],
      notes: `[SIMULATED] fleet move ${input.gridId} -> ${input.target.x.toFixed(0)}, ${input.target.y.toFixed(0)}, ${input.target.z.toFixed(0)}. Executor owns every flight order.`,
    },
  };
}

/** T6 designer missions carry `desiredState.designer` and one `slot-N` step. */
export function isDesignerMission(mission: Mission): boolean {
  const desired = mission.desiredState as { designer?: unknown; station?: unknown };
  return desired.designer === true || String(desired.station ?? '').startsWith('designer:');
}

function nearestPlanet(pos: Vec3) {
  const planets = loadPlanetCatalog();
  let best: (typeof planets)[number] | null = null;
  let bestDelta = Infinity;
  for (const p of planets) {
    const c = vec(p.center);
    if (!c) continue;
    const delta = Math.abs(dist(pos, c) - Number(p.surfaceRadiusM ?? 0));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  return best;
}

function short(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(-6);
}
