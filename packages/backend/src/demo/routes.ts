import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PROTOCOL_LIMITS,
  Vec3Schema,
  formatIssues,
  type Mission,
  type NetworkNode,
} from '@se-rts/schemas';
import type { Config } from '../config.js';
import type { Store, UnitRecord, GroupRecord } from '../store.js';
import type { PluginHub, StateHub } from '../pluginHub.js';
import { approveMission, createMission, supersedeGridMissions } from '../missions.js';
import { isFresh } from '../comms.js';
import { buildGraph, loadPlanetCatalog, resolveTemplate, whatIfRemove } from '../planner/index.js';
import { resolveDemoEnv, type DemoEnv } from './env.js';
import { getStandIn, getStandInByName, hardwareSummary, listStandIns, STANDINS, type StandIn } from './standins.js';
import { evaluateGate, authoritySnapshot, prefabForGrid as sharedPrefabForGrid, type CommsGate } from './gate.js';
import { capabilitiesFromStore, liveGraph, networkSnapshot, type GridCapability, type SourcedEdge } from './network.js';
import { buildLinksView, nodeMatchesPlanet, radioGroupsFromPlugin, type LinkNode } from './links.js';
import { callPlugin, provisionerFor } from './provision/provisioner.js';
import { LaserLinker } from './laser.js';
import { DemoStateCache, demoStateCacheTtlMs } from './stateCache.js';
import { decideTestIgnoreReach, resolveSurvivalMode, SURVIVAL_REASON, survivalRefusal } from './survival.js';
import { decideOrderChannel } from './channel.js';
import { orderDecision, roleFieldsFor, shipRoles, type OrderIntent } from './roles.js';
import { crewFromMeta, passengerLimits, STANDARD_GRAVITY_MPS2 } from './passengers.js';
import type { DemoExecutor } from './executor.js';
import {
  aliveNodes,
  demoGraph,
  laserPortUsage,
  loadWorld,
  planetByName,
  saveWorld,
  toNetworkNode,
  type DemoNode,
  type DemoWorld,
} from './world.js';
import { buildConnectPlan, optionById, type DemoConnectPlan, type OptionId } from './options.js';
import {
  computeRunway,
  estimateRates,
  evaluatePowerAlerts,
  isDaylight,
  powerBudget,
  powerTelemetry,
  sunElevationDeg,
  type PowerAlert,
  type PowerPoller,
  type SlotRegion,
  type BudgetDesign,
} from './power/index.js';
import { applyTune, clearPin, previewTune, readPins, writePin } from './autotune/index.js';
import { FleetService, type FleetCreateRequest } from './fleet/service.js';
import type { AlertsService } from './alerts/service.js';
import type { SurvivalService } from './survival/index.js';
import { readAlertsSettings, writeAlertsSettings } from './alerts/settings.js';
import { readPlayerSettings, writePlayerSettings, type PlayerSettings } from './players/settings.js';
import type { PlayerTracker, PlayerView } from './players/index.js';
import {
  computeComeToMePoint,
  COME_TO_ME_MAX_PLAYER_AGE_MS,
  groundSampler,
  levelFromGroundSource,
  type ComeToMeError,
} from './comeToMe.js';
import {
  formatDurationShort,
  moveEtaS,
  nearestPlanetTo,
  preflightMove,
  reachAtPoint,
  resolveMoveTarget,
  type MoveTargetSpec,
  type ReachNode,
  type ResolvedTarget,
  type ShipState,
} from './moveTo.js';

/**
 * `radio_links` is one plugin call that builds O(n²) antenna pairs on the game
 * thread (sim-speed audit #4). Two cheap filters before it is asked:
 *   1. only grids that actually carry an antenna with a positive radius, and
 *   2. only grids with a neighbour inside 2x the larger reach — a pair that
 *      cannot possibly hear each other is not a pair to read.
 * The answer is then reused for a short window, because a site refresh loop
 * used to re-run the whole pair build every ~28 s.
 */
export const RADIO_LINKS_TTL_MS = 20_000;
const radioLinksCache = new Map<string, { at: number; result: ReturnType<typeof radioGroupsFromPlugin> }>();

export function radioPollCandidates(
  nodes: { id: string; position: { x: number; y: number; z: number }; radioRadiusM?: number | null }[],
): string[] {
  const withRadio = nodes.filter((n) => (n.radioRadiusM ?? 0) > 0);
  const keep = new Set<string>();
  for (let i = 0; i < withRadio.length; i += 1) {
    for (let j = i + 1; j < withRadio.length; j += 1) {
      const a = withRadio[i]!;
      const b = withRadio[j]!;
      const reach = Math.max(a.radioRadiusM ?? 0, b.radioRadiusM ?? 0) * 2;
      const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
      if (d > reach) continue;
      keep.add(a.id);
      keep.add(b.id);
    }
  }
  return [...keep];
}

/**
 * Owner-facing hint for a failure code: the same {code, message, hint} shape
 * is returned by every demo route, so the site can always tell the owner what
 * to do next instead of only what went wrong.
 *
 * T75: in survival mode the hint never offers an admin override (there is
 * none); pass `opts.survivalMode` explicitly when the caller already resolved
 * the flag, so the function stays pure for tests.
 */
export function hintForCode(code: string, opts?: { survivalMode?: boolean }): string {
  const survivalMode = opts?.survivalMode ?? resolveSurvivalMode();
  const hints: Record<string, string> = {
    comms_denied: survivalMode
      ? 'No [HERMES-BASE] grid with a broadcasting antenna is in range of that ship. Build or power an antenna on a [HERMES-BASE] grid within radio range, then retry.'
      : "Ship is outside your base's 50 km radio range. Move it closer, add a relay, or use Admin override.",
    not_reachable: survivalMode
      ? 'The destination is outside your network. Pick a closer point, or add a relay within radio range.'
      : "The destination is outside your network. Pick a closer point, add a relay, or turn on Admin override.",
    no_fuel:
      'The ship has no hydrogen and no ion thrust to manoeuvre. Refuel it, or pick a destination it can coast to.',
    unknown_grid: 'The grid id is not in live telemetry. Refresh the page and pick the ship again.',
    unknown_planet: 'Pick a planet from the list (EarthLike, Moon, …).',
    unknown_node: 'That grid is not known to the backend. Refresh and retry.',
    kill_switch: 'Turn the kill switch off first, then retry.',
    plugin_offline: 'The test-server plugin is not connected. Start Space Engineers and load the test world.',
    plugin_timeout: 'The plugin did not answer in time. Check that the game is running and retry.',
    not_owned: 'Pick a grid tagged [HERMES-TEST] that you own, or ask for it to be provisioned.',
    unknown_option: 'Run Plan again and pick one of the returned options.',
    no_plan: 'Run Plan first, then approve.',
    unknown_group: 'Refresh the groups list: that group no longer exists on the backend.',
    group_exists: 'Reload the page so the server list is current, then create the group again.',
    plan_infeasible: 'Change the pattern, altitude, count or range margin until an option is feasible.',
    endurance_refused: 'Pick a closer slot, raise the launch reserve, or refuel the ship.',
    nothing_to_launch: 'Select at least one drone that passes preflight, or enable fillWithClones.',
    grid_position_unknown: 'Wait for telemetry from that grid and retry.',
    cap_reached: 'Wait for the running mission to finish, or raise the active-drone cap.',
    admin_override_not_allowed: 'Admin override is only available on the test server.',
    unknown_player: 'Check the identityId or steamId: GET /api/demo/players lists everyone the backend has seen.',
    player_position_stale:
      'That position is more than 5 minutes old. Ask the player to log in, or use a GPS stand-in: target: { gps: {x,y,z} }, comeToMe: true.',
    player_position_unknown: 'Wait for a telemetry sample with a position, or use a GPS stand-in point.',
    standoff_too_close: 'Ask for at least 25 m of lateral offset: the ship never hovers directly over the player.',
    standoff_too_low: 'Ask for at least 25 m of hull-bottom height (default 80 m), or use a landing order.',
    standoff_refused: 'The hover would be more than 180 m from the player (suit radio 200 m): lower it or give it more room.',
    player_not_on_ground: 'Come-to-me parks beside a player on foot; use a GPS stand-in point for an airborne player.',
    ground_unknown: 'The terrain service has no tiles for that column yet; retry, or use a plain GPS move-to.',
  };
  return hints[code] ?? 'Check the request and the test-server state (plugin connected, kill switch off), then retry.';
}

/** Come-to-me geometry refusals: a conflict with the world, not a bad request. */
function comeToMeHttpError(error: ComeToMeError): DemoHttpError {
  const conflict = new Set(['standoff_refused', 'standoff_too_close', 'standoff_too_low', 'player_not_on_ground']);
  return new DemoHttpError(conflict.has(error.code) ? 409 : 400, error.code, error.message, undefined, error.hint);
}

export class DemoHttpError extends Error {
  readonly hint: string;
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: string[],
    hint?: string,
  ) {
    super(message);
    this.name = 'DemoHttpError';
    this.hint = hint ?? hintForCode(code);
  }
}

export interface DemoDeps {
  config: Config;
  store: Store;
  hub: PluginHub;
  stateHub: StateHub;
  clock?: () => number;
  executor?: DemoExecutor;
  /** T20 power poller; absent in tests that do not opt in. */
  power?: PowerPoller | null;
  /** T68 alerts engine; absent when the demo env is off. */
  alerts?: AlertsService | null;
  /** T66 survival loop (return-home / NEEDS_REFUEL / relaunch). */
  survival?: SurvivalService | null;
  /** T61 player tracker; absent in tests that do not opt in (endpoints 503). */
  players?: PlayerTracker | null;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  url: URL;
}

export interface DemoRoute {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<void> | void;
}

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new DemoHttpError(413, 'payload_too_large', 'request body exceeds 256 KiB');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DemoHttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

function actorOf(req: http.IncomingMessage): string {
  const raw = req.headers['x-actor'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 128);
  return 'demo-site';
}

const ConnectBody = z.object({
  planetA: z.string().min(1),
  planetB: z.string().min(1),
  hardware: z.enum(['auto', 'radio', 'laser', 'mixed']).default('auto'),
  templates: z
    .object({
      radio: z.string().min(1).optional(),
      laser: z.string().min(1).optional(),
      laserSpacingM: z.number().positive().optional(),
    })
    .optional(),
});

const ConnectMissionsBody = ConnectBody.extend({
  optionId: z.enum(['radio', 'laser', 'mixed']),
  note: z.string().max(500).optional(),
});

const SpawnBody = z.object({
  prefab: z.string().min(1),
  planet: z.string().min(1).optional(),
  pos: Vec3Schema.optional(),
  note: z.string().max(500).optional(),
});

const MoveBody = z.object({
  gridId: z.string().min(1),
  pos: Vec3Schema,
  note: z.string().max(500).optional(),
});

const MoveTargetSchema = z.union([
  z.object({ gps: Vec3Schema }),
  z.object({ planet: z.string().min(1), altitudeM: z.number().positive().max(1_000_000) }),
  z.enum(['orbit-zero-g', 'orbit-low']),
  /**
   * Come to me: the player to come to (identityId or steamId as a string) and
   * an optional standoff. Defaults: 40 m to the side, hull bottom 80 m above
   * the true ground at the hover column. The hover is always inside 180 m of
   * the player (suit radio 200 m) and never closer than 25 m horizontally.
   */
  z.object({
    player: z.string().trim().min(1).max(64),
    standoff: z
      .object({
        lateralM: z.number().positive().max(500).optional(),
        aboveGroundM: z.number().positive().max(1_000).optional(),
      })
      .optional(),
  }),
]);

const RolesSetBody = z.object({
  gridId: z.string().min(1),
  /** null clears the toggle (back to the in-game tag / default). */
  role: z.enum(['managed', 'personal', 'base', 'off']).nullable(),
});

/** T66: the return/relaunch loop's two operator inputs. */
const SurvivalSettingsBody = z.object({
  approvalMode: z.enum(['auto', 'approve']).optional(),
  marginPct: z.number().min(0).max(100).optional(),
  relaunchPct: z.number().min(50).max(100).optional(),
  /**
   * TEST-ENV-ONLY: carry the audited ignoreReach override on the loop's own
   * return/relaunch missions. Refused in survival mode (409 `survival_mode`),
   * refused outside the demo env, and ignored if already persisted there.
   */
  testIgnoreReach: z.boolean().optional(),
});

const SurvivalHomeBody = z
  .object({
    /** Per-ship override when present; the default home otherwise. */
    gridId: z.string().min(1).optional(),
    /**
     * A home: a BASE grid id/name, an encoded point (`point:x,y,z` or a GPS
     * string), or `homePoint {x,y,z}` (a map click). `null` clears.
     */
    homeGridId: z.string().min(1).nullable().optional(),
    /**
     * `null` clears the per-ship override (or the default point home) — the
     * document has said so since T66, but the schema only accepted an object.
     */
    homePoint: Vec3Schema.nullable().optional(),
  })
  .refine((value) => value.homeGridId !== undefined || value.homePoint !== undefined, {
    message: 'send homeGridId (a BASE grid id/name, or a point:/GPS: key) or homePoint {x,y,z}',
  });

/** TEST-ENV-ONLY: a per-grid runway reading the trigger uses instead of live. */
const SurvivalTestRunwayBody = z.object({
  gridId: z.string().min(1),
  resource: z.enum(['h2', 'power']),
  runwayMin: z.number().positive().max(100_000),
  pct: z.number().min(0).max(100),
  /** Minutes until it expires by itself; default 30, capped at 120. */
  ttlMin: z.number().positive().max(120).optional(),
});

const SurvivalReturnBody = z.object({
  gridId: z.string().min(1),
  confirm: z.boolean().optional(),
});

const SurvivalRelaunchBody = z.object({
  gridId: z.string().min(1),
  /** Relaunch is an owner order: without this it is refused, always. */
  confirm: z.boolean(),
});

const MoveToBody = z
  .object({
    gridId: z.string().min(1),
    target: MoveTargetSchema,
    /** Test-server admin override: skip the reachability half of the gate. */
    ignoreReach: z.boolean().default(false),
    /** Compute and return the preflight without creating a mission. */
    dryRun: z.boolean().default(false),
    /**
     * Landing mode (owner request, 2026-11-10): land ON the ground at the
     * target instead of holding above it. `mode: 'land'` is the same request as
     * a word; `landing.flareAglM` sets the flare height (>= 40 m).
     */
    land: z.boolean().optional(),
    /**
     * Park: stop AT the target. A target on the ground is a landing; an
     * airborne target is held in the air (never a surprise landing).
     */
    park: z.boolean().optional(),
    mode: z.enum(['land', 'park', 'hold']).optional(),
    landing: z.object({ flareAglM: z.number().min(40).max(2_000).optional() }).optional(),
    /**
     * Come to me with a GPS stand-in point (nobody online to come to): the GPS
     * point is treated as where the player is standing, and the same standoff
     * geometry applies. With a `player` target this is implied.
     */
    comeToMe: z.boolean().optional(),
    /** Override the 10-minute "nobody took control" timeout for this mission. */
    comeToMeTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
    /**
     * Ship roles (owner decision 2026-11-11): confirm an explicit order for a
     * PERSONAL ship. Without it the route returns 409 and shows the reason; the
     * site asks in a dialog before sending true.
     */
    confirmPersonal: z.boolean().optional(),
  })
  .refine(
    (body) => {
      const land = body.land === true || body.mode === 'land';
      const park = body.park === true || body.mode === 'park';
      return !(land && park);
    },
    {
      message: 'land and park are mutually exclusive: a landing is park-on-the-ground',
      path: ['park'],
    },
  )
  .refine(
    (body) => {
      const playerTarget = typeof body.target === 'object' && body.target !== null && 'player' in body.target;
      if (!(body.comeToMe === true || playerTarget)) return true;
      // A come-to-me hover is for a MANUAL landing: asking it to land itself
      // is a contradiction, and a silent preference would be a surprise.
      return !(body.land === true || body.park === true || body.mode === 'land' || body.mode === 'park');
    },
    {
      message: 'comeToMe is a hover for a manual landing: it cannot also land or park itself',
      path: ['comeToMe'],
    },
  )
  .refine(
    (body) => {
      const playerTarget = typeof body.target === 'object' && body.target !== null && 'player' in body.target;
      // A GPS stand-in is the only other come-to-me anchor; a planet/altitude
      // or orbit target has no "player point" to offset from.
      if (body.comeToMe !== true || playerTarget) return true;
      return typeof body.target === 'object' && body.target !== null && 'gps' in body.target;
    },
    {
      message: 'comeToMe with no player needs target: { gps: {x,y,z} } as the stand-in point',
      path: ['target'],
    },
  );


const ExpandBody = z.object({ fromNodeId: z.string().min(1), count: z.number().int().min(1).max(6).default(3) });
const WhatIfBody = z.object({ nodeId: z.string().min(1) });
const KillBody = z.object({ on: z.boolean() });
const ResetBody = z.object({ snapshot: z.string().min(1).max(256), confirm: z.string() });
const AutotuneBody = z.object({
  gridIds: z.array(z.string().min(1)).max(64).optional(),
  /** Coverage footprints the plan needs, metres. */
  footprints: z.record(z.string(), z.number().positive().max(500_000)).optional(),
  roles: z.record(z.string(), z.enum(['base', 'coverage', 'backbone'])).optional(),
  dryRun: z.boolean().default(false),
});
const PinBody = z.object({
  gridId: z.string().min(1),
  radioM: z.number().positive().max(500_000).nullable().optional(),
  laserM: z.number().positive().max(500_000).nullable().optional(),
  footprintM: z.number().positive().max(500_000).nullable().optional(),
  note: z.string().max(200).optional(),
  clear: z.boolean().default(false),
});

/** T68: ack/resolve are the only alert mutations. `by` is the actor label. */
const AlertActionBody = z.object({
  by: z.string().trim().min(1).max(120).optional(),
  note: z.string().max(500).optional(),
});

const AlertSettingsBody = z.object({
  discordWebhook: z.string().max(2048).optional(),
  runwayHours: z.number().min(0.5).max(168).optional(),
  runwayCriticalMin: z.number().min(1).max(1_440).optional(),
  coverageHoleCells: z.number().int().min(1).max(100_000).optional(),
  coverageDropPct: z.number().min(0.1).max(100).optional(),
  coverageDropWindowMs: z.number().int().min(60_000).max(24 * 3_600_000).optional(),
  coverageGoalPct: z.number().min(0).max(100).optional(),
  gridLostAfterMs: z.number().int().min(10_000).max(3_600_000).optional(),
  telemetryStaleMs: z.number().int().min(30_000).max(24 * 3_600_000).optional(),
  simSpeedHoldMs: z.number().int().min(10_000).max(3_600_000).optional(),
  missionFailWindowMs: z.number().int().min(60_000).max(24 * 3_600_000).optional(),
  batchMs: z.number().int().min(0).max(60_000).optional(),
  readingStaleMs: z.number().int().min(60_000).max(24 * 3_600_000).optional(),
});

/**
 * T61 player-map settings. The faction filter defaults to ON (owner's faction
 * only); turning it off is an explicit, audited decision.
 */
const PlayerSettingsBody = z.object({
  filterToOwnerFaction: z.boolean().optional(),
  ownerFactionTag: z.string().max(64).optional(),
  includeNoFaction: z.boolean().optional(),
  staleAfterMs: z.number().int().min(5_000).max(600_000).optional(),
});

/**
 * CONTRACT-FEATURES §4 satellite groups. `members` are grid ids as *strings*
 * (SE ids exceed 2^53). The id is optional on create so the client may keep
 * its local id; the server generates one when it is absent.
 */
const GroupCreateBody = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().min(1).max(64).optional(),
  members: z.array(z.string().min(1)).max(500).default([]),
});

const GroupPatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    color: z.string().trim().min(1).max(64).nullable().optional(),
    members: z.array(z.string().min(1)).max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined || v.members !== undefined, {
    message: 'at least one of name, color or members is required',
  });

const GroupStopBody = z.object({
  /** Optional subset; defaults to every member of the group. */
  gridIds: z.array(z.string().min(1)).max(500).optional(),
});

/**
 * T50 fleet operations. `members` are grid ids as strings; a `groupId` is an
 * alternative to listing them. `dryRun` defaults true: create+plan must never
 * move a grid by accident.
 */
const FleetOpCreateBody = z.object({
  kind: z.enum(['swap', 'recall', 'reshape', 'relocate', 'scuttle']),
  members: z.array(z.string().min(1)).max(500).optional(),
  groupId: z.string().min(1).max(128).optional(),
  planet: z.string().min(1).max(64).optional(),
  minSeparationM: z.number().positive().max(100_000).default(100),
  dryRun: z.boolean().default(true),
  abortPolicy: z.enum(['hold', 'return', 'continue']).default('hold'),
  base: z
    .object({ name: z.string().min(1).max(200).optional(), position: Vec3Schema.optional() })
    .optional(),
  slots: z
    .array(z.object({ gridId: z.string().min(1), target: Vec3Schema }))
    .max(500)
    .optional(),
  region: z.object({ center: Vec3Schema, label: z.string().max(120).optional() }).optional(),
  confirm: z.boolean().optional(),
  acceptedCoverageLoss: z.boolean().optional(),
  includeTerrain: z.boolean().default(true),
  parentOperationId: z.string().min(1).max(128).optional(),
});

const FleetApproveBody = z.object({ confirm: z.boolean().optional() });

const FleetActionBody = z.object({
  policy: z.enum(['hold', 'return', 'continue']).optional(),
  policies: z.record(z.string(), z.enum(['hold', 'return', 'continue'])).optional(),
});

export interface ExecutionState {
  status: string;
  pluginConnected: boolean;
  detail: string;
}

function executionState(hub: PluginHub, store?: Store): ExecutionState {
  if (!hub.isConnected()) {
    return {
      status: 'pending: plugin not connected',
      pluginConnected: false,
      detail: 'queued in the mission queue; no command is sent until the plugin connects',
    };
  }
  if (store && store.getFlags().demo_execute !== true) {
    return {
      status: 'approved: executor flag demo_execute is OFF',
      pluginConnected: true,
      detail: 'the plugin is connected but demo execution is disabled; no order leaves the backend',
    };
  }
  return {
    status: 'approved: executors will run the order sequence',
    pluginConnected: true,
    detail: 'spawn -> ownership -> ai_off -> move -> hold; every flight order passes the comms gate',
  };
}

function findPlanetOrThrow(name: string) {
  const planet = planetByName(name);
  if (!planet) throw new DemoHttpError(400, 'unknown_planet', `unknown planet ${name}`);
  return planet;
}

function deniedGate(nodeId: string, reason: string): CommsGate {
  return {
    nodeId,
    gate: 'comms',
    allowed: false,
    source: 'SIMULATED',
    reason,
    gameLink: 'no-telemetry',
    telemetryAgeMs: null,
    plannerPath: null,
    virtual: false,
    labels: ['SIMULATED'],
  };
}

function gateForNode(deps: DemoDeps, world: DemoWorld, nodeId: string): CommsGate {
  return evaluateGate({
    store: deps.store,
    world,
    now: deps.clock?.() ?? Date.now(),
    nodeId,
    freshMs: deps.config.demo.gateFreshMs,
    prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
  });
}

/**
 * Relay/base nodes for the move-to reach check: the live network (provisioned
 * bases are control sources, every grid with a live radio relay), not the
 * built-in fixture. Range math only.
 */
function moveNodesFor(deps: DemoDeps, world: DemoWorld, now: number): ReachNode[] {
  const snapshot = networkSnapshot({
    store: deps.store,
    world,
    now,
    freshMs: Math.max(deps.config.demo.gateFreshMs, 60_000),
    prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
  });
  return snapshot.nodes.map((n) => ({
    id: n.id,
    name: deps.store.getUnit(n.id)?.name ?? snapshot.capability.get(n.id)?.name ?? n.id,
    position: n.position,
    radioRangeM: n.radioRadiusM,
    controlSource: n.controlSource,
  }));
}

/**
 * Live thrust split for a direct move-to preflight. `profile` is read-only and
 * runs on the plugin's game thread; results are cached for 60 s so an
 * interactive dry-run does not queue a plugin order per keystroke. A missing
 * profile is not an error: the preflight then refuses only above the
 * atmosphere (see `preflightMove`).
 */
const shipHardwareCache = new Map<string, { at: number; value: LiveShipHardware | null }>();

interface LiveShipHardware {
  massKg: number | null;
  thrust: { atmo: number; ion: number; h2: number };
}

async function liveShipHardware(deps: DemoDeps, gridId: string): Promise<LiveShipHardware | null> {
  const cached = shipHardwareCache.get(gridId);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (!deps.hub.isConnected()) return null;
  const now = deps.clock?.() ?? Date.now();
  const orderId = `demo:profile:${randomUUID()}`;
  // T75: a profile read is a legitimate action: production channel in both builds.
  const decision = decideOrderChannel('test', 'profile', resolveSurvivalMode());
  if (decision.refused) {
    deps.store.audit({
      actor: 'demo-routes',
      action: 'survival_refused',
      subject: gridId,
      detail: { action: 'profile', orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at: now,
    });
    return null;
  }
  const frame = {
    schemaVersion: 1 as const,
    type: 'order' as const,
    orderId,
    orderType: decision.orderType,
    entityId: gridId,
    params: { action: 'profile', entityId: gridId },
    tick: 0,
    issuedAt: now,
    expiresAt: now + 4_000,
  };
  if (!deps.hub.send(frame)) return null;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    for (const entry of deps.store.listOrderResults(160)) {
      const detail = entry.detail as { eventType?: string; data?: { orderId?: string; result?: Record<string, unknown> } };
      if (entry.action !== 'plugin_event' || detail?.eventType !== 'order_result' || detail?.data?.orderId !== orderId) continue;
      const result = (detail.data.result ?? {}) as Record<string, unknown>;
      const thrusters = (result.thrusters ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const value: LiveShipHardware = {
        massKg: typeof result.massKg === 'number' && Number.isFinite(result.massKg) ? result.massKg : null,
        thrust: { atmo: n(thrusters.atmoN), ion: n(thrusters.ionN), h2: n(thrusters.h2N) },
      };
      shipHardwareCache.set(gridId, { at: Date.now(), value });
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Control-source anchor for a planet (live base first, then any live node). */
function anchorForPlanet(deps: DemoDeps, world: DemoWorld, planetId: string): CommsGate {
  const now = deps.clock?.() ?? Date.now();
  const snapshot = networkSnapshot({
    store: deps.store,
    world,
    now,
    freshMs: Math.max(deps.config.demo.gateFreshMs, 60_000),
    prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
  });
  const planets = loadPlanetCatalog();
  const planet = planets.find((p) => p.name === planetId || p.id === planetId) ?? planetByName(planetId);
  const source = snapshot.nodes.find((n) => {
    if (!n.controlSource) return false;
    if (!planet) return true;
    const nearest = nearestPlanetTo(n.position, planets);
    if (!nearest || nearest.name !== planet.name) return false;
    const distance = Math.hypot(
      n.position.x - planet.center.x,
      n.position.y - planet.center.y,
      n.position.z - planet.center.z,
    );
    // A base counts as "at this planet" when it sits in its sphere of influence.
    return distance <= planet.maxHillRadiusM * 4;
  });
  if (!source) {
    return deniedGate(`planet:${planetId}`, 'no provisioned base with a broadcasting radio is registered at this planet');
  }
  return gateForNode(deps, world, source.id);
}

/** Gate for a spawn at an arbitrary point: any reachable control source. */
function anyControlSourceGate(deps: DemoDeps, world: DemoWorld): CommsGate {
  const now = deps.clock?.() ?? Date.now();
  const snapshot = networkSnapshot({
    store: deps.store,
    world,
    now,
    freshMs: Math.max(deps.config.demo.gateFreshMs, 60_000),
    prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
  });
  const source = snapshot.nodes.find((n) => n.controlSource);
  if (!source) {
    return deniedGate('no-control-source', 'no provisioned base with a broadcasting radio is registered for a deep-space spawn');
  }
  return gateForNode(deps, world, source.id);
}

function assertKillSwitchOff(store: Store): void {
  if (store.isKillSwitchOn()) {
    throw new DemoHttpError(409, 'kill_switch', 'global kill switch is ON; mission creation and approvals are blocked');
  }
}

function assertGate(gate: CommsGate): void {
  if (!gate.allowed) {
    throw new DemoHttpError(403, 'comms_denied', `comms gate denied ${gate.nodeId}: ${gate.reason}`);
  }
}

interface GroupStopSkipped {
  gridId: string;
  reason: string;
  stage: 'membership' | 'manual' | 'comms' | 'role' | 'send';
  gateSource?: 'GAME' | 'SIMULATED';
}

/**
 * CONTRACT-FEATURES §4 scoped stop. Each member is checked independently:
 * the comms gate must allow it (same gate the move/hold paths use), a grid the
 * owner is piloting by hand is left alone (T27), and a grid whose stop order
 * could not be handed to the plugin is reported as skipped, never as stopped.
 */
function sendGroupStop(
  deps: DemoDeps,
  env: DemoEnv,
  group: GroupRecord,
  requested: string[],
  now: number,
): { stopped: string[]; skipped: GroupStopSkipped[]; orderIds: string[] } {
  const targets = [...new Set(requested.length > 0 ? requested : group.members)];
  const members = new Set(group.members);
  const world = loadWorld(deps.store, env.fixturePath, now);
  const stopped: string[] = [];
  const skipped: GroupStopSkipped[] = [];
  const orderIds: string[] = [];

  for (const gridId of targets) {
    if (!members.has(gridId)) {
      skipped.push({ gridId, reason: 'not a member of this group', stage: 'membership' });
      continue;
    }
    // SHIP ROLE: stop is always allowed for PERSONAL/BASE, but an OFF grid
    // receives no orders at all (owner decision 2026-11-11).
    if (shipRoles.roleOf(gridId) === 'off') {
      skipped.push({ gridId, reason: 'marked OFF in game: this grid receives no orders', stage: 'role' });
      continue;
    }
    const manual = deps.store.getKv(`demo:control:${gridId}`);
    if (manual) {
      try {
        if ((JSON.parse(manual) as { underControl?: unknown }).underControl === true) {
          skipped.push({ gridId, reason: 'under manual control (the pilot owns this grid)', stage: 'manual' });
          continue;
        }
      } catch {
        /* corrupt mark: fall through to the gate */
      }
    }
    const gate = gateForNode(deps, world, gridId);
    if (!gate.allowed) {
      skipped.push({ gridId, reason: gate.reason, stage: 'comms', gateSource: gate.source });
      continue;
    }
    if (!deps.hub.isConnected()) {
      skipped.push({ gridId, reason: 'plugin_offline: no stop order was sent', stage: 'send' });
      continue;
    }
    const orderId = `demo:group-stop:${idPart(group.id)}:${idPart(gridId)}:${now}`;
    const payload = {
      schemaVersion: 1 as const,
      type: 'order' as const,
      orderId,
      orderType: 'stop' as const,
      entityId: gridId,
      params: { action: 'stop' },
      tick: 0,
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    deps.store.createOrder({
      orderId,
      missionId: `group-stop:${group.id}`,
      unitId: gridId,
      orderType: 'stop',
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: now,
      ackedAt: null,
    });
    if (!deps.hub.send(payload)) {
      skipped.push({ gridId, reason: 'plugin_offline: no stop order was sent', stage: 'send' });
      continue;
    }
    stopped.push(gridId);
    orderIds.push(orderId);
  }
  return { stopped, skipped, orderIds };
}

/**
 * Ship-role gate for a mission request (owner decision 2026-11-11). A grid's
 * in-game role decides what it may be asked to do, before any mission exists:
 *
 *   OFF      -> 409 "marked OFF in game" for every order;
 *   BASE     -> 409 on any movement mission (a base is never moved);
 *   PERSONAL -> 409 unless `confirmPersonal: true`, and then only explicit
 *               owner orders (build/repair/replace/slot missions stay refused
 *               because those are automatic features).
 *
 * Returns the 409 (caller throws) or null when the request may proceed.
 */
export function roleRefusalForMission(
  deps: DemoDeps,
  req: http.IncomingMessage,
  input: Record<string, unknown>,
): DemoHttpError | null {
  const units = Array.isArray(input.assignedUnits)
    ? (input.assignedUnits as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (!units.length) return null;
  const type = String(input.type ?? 'move');
  const desired = (input.desiredState ?? {}) as Record<string, unknown>;
  const confirmPersonal = input.confirmPersonal === true || desired.personalConfirmed === true;
  // Build/repair/replace/slot work is an AUTOMATIC feature: a personal grid is
  // never eligible even when the owner confirmed something else.
  const automaticType = ['build_deploy', 'repair', 'replace', 'cover'].includes(type);
  const intent: OrderIntent = automaticType ? 'automatic' : 'owner-order';
  for (const gridId of units) {
    const res = shipRoles.resolution(gridId);
    const decision = orderDecision(res, intent, { action: 'move', confirmPersonal });
    if (decision.allowed) continue;
    deps.store.audit({
      actor: actorOf(req),
      action: 'role_refused',
      subject: gridId,
      detail: {
        route: 'createDemoMission',
        missionType: type,
        role: decision.role,
        roleSource: decision.roleSource,
        code: decision.code ?? null,
        reason: decision.reason,
        note: 'no mission was created',
      },
      at: deps.clock?.() ?? Date.now(),
    });
    return new DemoHttpError(409, decision.code ?? 'role_refused', decision.reason, undefined,
      'Change the role tag in game (or the site toggle) to send this order.');
  }
  return null;
}

function createDemoMission(
  deps: DemoDeps,
  req: http.IncomingMessage,
  input: Record<string, unknown>,
): Mission {
  const refusal = roleRefusalForMission(deps, req, input);
  if (refusal) throw refusal;
  const now = deps.clock?.() ?? Date.now();
  const result = createMission(deps.store, input, {
    now,
    actor: actorOf(req),
    autoMissionTypes: deps.config.autoMissionTypes,
    maxQueuedBuilds: deps.config.caps.maxQueuedBuilds,
  });
  if (!result.ok) {
    throw new DemoHttpError(result.code === 'cap_reached' ? 409 : 400, result.code, result.message, result.issues);
  }
  if (result.created) deps.stateHub.broadcast({ type: 'mission', at: now, event: 'created', mission: result.mission });
  return result.mission;
}

function audit(deps: DemoDeps, req: http.IncomingMessage, action: string, subject: string, detail: Record<string, unknown>): void {
  deps.store.audit({ actor: actorOf(req), action, subject, detail, at: deps.clock?.() ?? Date.now() });
}

function speedOf(vel: { x: number; y: number; z: number } | null): number {
  return vel ? Math.hypot(vel.x, vel.y, vel.z) : 0;
}

function telemetryOf(unit: { name: string; lastSeen: number; pos: { x: number; y: number; z: number } | null; vel: { x: number; y: number; z: number } | null; linkStatus: string; meta: Record<string, unknown> }, now: number) {
  const speedMps = speedOf(unit.vel);
  return {
    name: unit.name,
    lastSeen: unit.lastSeen,
    ageMs: Math.max(0, now - unit.lastSeen),
    fresh: now - unit.lastSeen <= PROTOCOL_LIMITS.telemetryFreshMs,
    pos: unit.pos,
    vel: unit.vel,
    speedMps,
    moving: speedMps > 0.5,
    linkStatus: unit.linkStatus,
    ownership: (unit.meta?.ownerName as string | undefined) ?? null,
  };
}

/**
 * The plugin keeps one `units` row per entity id it has ever seen, and SE hands
 * out a new id when an NPC encounter respawns — so a 12-grid world ends up with
 * hundreds of rows. Keep the freshest row per id (defensive: the store upserts
 * by id, but a second telemetry writer must not double-render a grid) and let
 * callers decide how old is too old to show.
 */
function dedupeUnits(units: UnitRecord[]): UnitRecord[] {
  const byId = new Map<string, UnitRecord>();
  for (const unit of units) {
    const prev = byId.get(unit.id);
    if (!prev || unit.lastSeen > prev.lastSeen) byId.set(unit.id, unit);
  }
  return [...byId.values()];
}

/** Same zero-g edge the Fleet page uses. */
const ZERO_G_ALT_M = 43_700;

function sunFromStore(store: Store): { x: number; y: number; z: number } | null {
  const raw = store.getKv('telemetry:sun');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { sun?: { x?: unknown; y?: unknown; z?: unknown } };
    const s = parsed.sun;
    if (!s) return null;
    const { x, y, z } = s;
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' &&
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x, y, z };
    }
  } catch {
    /* older writers stored a bare string; no sun hint then */
  }
  return null;
}

/**
 * T20: merge the cached power/fuel snapshot into a node's telemetry.
 *
 * The flat field names are the ones `packages/demo-site/src/lib/fleet.ts`
 * feature-detects; the nested `power` object is the structured view. Every
 * number here came from the plugin's read-only `profile` action.
 */
function powerForNode(
  deps: DemoDeps,
  gridId: string,
  pos: { x: number; y: number; z: number } | null,
  now: number,
): { block: Record<string, unknown>; alerts: PowerAlert[] } | null {
  const poller = deps.power;
  if (!poller) return null;
  const snap = poller.snapshot(gridId);
  if (!snap) return null;
  const planets = loadPlanetCatalog();
  const planet = pos ? nearestPlanetTo(pos, planets) : null;
  const altitudeM = pos && planet
    ? Math.max(0, Math.hypot(pos.x - planet.center.x, pos.y - planet.center.y, pos.z - planet.center.z) - planet.surfaceRadiusM)
    : null;
  const zeroG = Boolean(planet?.hasAtmosphere && altitudeM !== null && altitudeM >= ZERO_G_ALT_M);
  const sun = sunFromStore(deps.store);
  const daylight = pos ? isDaylight(pos, sun, planet) : null;
  const rates = estimateRates(poller.series(gridId, 1));
  const runway = computeRunway(snap, rates, { zeroG });
  const alerts = evaluatePowerAlerts({ snap, runway, rates, daylight, zeroG, now });
  const block = powerTelemetry(snap, { rates, runway, daylight, zeroG, alerts });
  return {
    block: {
      ...block,
      powerAgeMs: Math.max(0, now - snap.at),
      sunElevationDeg: pos ? sunElevationDeg(pos, sun, planet) : null,
      altitudeM: altitudeM === null ? null : Math.round(altitudeM),
    },
    alerts,
  };
}

/**
 * T61: the players view for the current settings. The faction filter is
 * applied HERE so every consumer (state, /players, tests) sees one answer.
 * Faction "owner" means: the explicit tag from settings, else the tag observed
 * on the owner's own live sample, else - if the owner is not in a faction - the
 * no-faction case (includeNoFaction, default true).
 */
function playersView(deps: DemoDeps, settings: PlayerSettings, now: number): PlayerView | null {
  if (!deps.players) return null;
  const ownerTag = settings.ownerFactionTag || deps.players.ownerFactionTag(deps.config.owner.steamId);
  const factions = settings.filterToOwnerFaction ? [ownerTag] : null;
  return deps.players.view(
    {
      factions,
      includeNoFaction: settings.includeNoFaction,
      staleAfterMs: settings.staleAfterMs,
    },
    now,
  );
}

function demoState(deps: DemoDeps, env: DemoEnv, options: { includeArchived?: boolean } = {}): Record<string, unknown> {
  const now = deps.clock?.() ?? Date.now();
  // T74: the site has to say which rules are in force. Resolved from the env on
  // every read (it is two string compares, and the state body is cached).
  const survivalMode = resolveSurvivalMode();
  const world = loadWorld(deps.store, env.fixturePath, now);
  const snapshot = networkSnapshot({
    store: deps.store,
    world,
    now,
    freshMs: Math.max(deps.config.demo.gateFreshMs, 60_000),
    prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
  });
  const graph = liveGraph(snapshot);
  const caps = snapshot.capability;
  const livePairs = snapshot.livePairs;
  const ports: Record<string, { used: number; capacity: number }> = {};
  for (const cap of caps.values()) ports[cap.gridId] = { used: 0, capacity: cap.laserCount };
  for (const pair of livePairs) {
    for (const id of [pair.a, pair.b]) {
      ports[id] = ports[id] ?? { used: 0, capacity: 0 };
      ports[id].used += 1;
    }
  }
  const reachable = graph.nodes.filter((n) => n.reachable).map((n) => n.id);
  const isolated = graph.nodes.filter((n) => !n.reachable).map((n) => n.id);
  const archivedAfterMs = deps.config.demo.archivedAfterMs || 6 * 60 * 60 * 1000;
  const allUnits = dedupeUnits(deps.store.listUnits());
  const positioned = allUnits.filter((u) => u.pos);
  const recentUnits = allUnits.filter((u) => now - u.lastSeen <= archivedAfterMs);
  // Archived rows stay reachable with ?archived=1 but never pollute the map.
  const units = options.includeArchived ? allUnits : recentUnits;
  const byId = new Map(units.map((u) => [u.id, u]));
  const freshCount = positioned.filter((u) => now - u.lastSeen <= PROTOCOL_LIMITS.telemetryFreshMs).length;
  const recentCount = positioned.filter((u) => now - u.lastSeen <= archivedAfterMs).length;
  const telemetrySummary = {
    source: 'plugin' as const,
    connected: deps.hub.isConnected(),
    gridCount: positioned.length,
    freshCount,
    staleCount: positioned.length - freshCount,
    recentCount,
    archivedCount: positioned.length - recentCount,
    archivedAfterMs,
    movingCount: positioned.filter(
      (u) => now - u.lastSeen <= PROTOCOL_LIMITS.telemetryFreshMs && speedOf(u.vel) > 0.5,
    ).length,
    latestAgeMs: positioned.length ? Math.min(...positioned.map((u) => Math.max(0, now - u.lastSeen))) : null,
    pollMs: 2_000,
    note: 'positions from plugin telemetry, ~2 s',
  };

  const capabilityOfNode = (id: string, prefab: string | null): Record<string, unknown> | null => {
    const cap: GridCapability | undefined = caps.get(id);
    if (cap) {
      return {
        role: cap.profile === 'BASE' ? 'station' : cap.profile === 'DRONE' ? 'drone' : 'relay',
        radioRadiusM: cap.radioRadiusM,
        laserRangeM: cap.laserRangeM,
        laserPorts: cap.laserCount,
        controllable: cap.profile === 'BASE' ? false : true,
        sizeClass: 'large',
        isStatic: cap.isStatic,
        massKg: cap.massKg,
        profile: cap.profile,
        source: cap.source === 'provisioned-base' || cap.source === 'provisioned-grid' ? 'GAME' : 'SIMULATED',
        sourceNote:
          cap.source === 'provisioned-base' || cap.source === 'provisioned-grid'
            ? 'provisioned capability profile: antenna state read back from the block, range maths simulated'
            : 'stand-in capability profile (no provisioning record)',
      };
    }
    const standin = prefab ? getStandIn(prefab) : null;
    if (standin) {
      return {
        role: standin.role,
        radioRadiusM: standin.radioRadiusM,
        laserRangeM: standin.laserRangeM,
        laserPorts: standin.laserPorts,
        controllable: standin.controllable,
        sizeClass: standin.sizeClass,
        isStatic: standin.isStatic,
        massKg: null,
        profile: null,
        source: 'SIMULATED',
        sourceNote: standin.sourceNote,
      };
    }
    return null;
  };
  // Adjacency index, built ONCE. `linksFor` used to filter the whole edge list
  // per node, which is O(nodes x edges) - the reason a 200-grid state read cost
  // 1.5 s and blocked the flight tick. Measured 2026-11-10: exactly this shape
  // of blocking starved the executor for 12.3 s mid-fall.
  const edgesByNode = new Map<string, SourcedEdge[]>();
  for (const edge of graph.edges as SourcedEdge[]) {
    const ids = edge.kind === 'laser' ? [edge.from, edge.to] : [edge.from];
    for (const id of ids) {
      const list = edgesByNode.get(id);
      if (list) list.push(edge);
      else edgesByNode.set(id, [edge]);
    }
  }
  const reachableSet = new Set(reachable);
  // ONE authority snapshot for every gate this response needs. Each
  // `evaluateGate` used to rebuild the whole network model, so a page gating N
  // nodes did N full builds (200 grids -> 1.5 s of blocked event loop, which is
  // how a state read starved the flight tick on 2026-11-10).
  let gateCtx: { snapshot: ReturnType<typeof authoritySnapshot>; graph: ReturnType<typeof liveGraph> } | null = null;
  const gates = () => {
    if (!gateCtx) {
      const snapshot = authoritySnapshot({
        store: deps.store,
        world,
        now: deps.clock?.() ?? Date.now(),
        nodeId: '',
        freshMs: deps.config.demo.gateFreshMs,
        prefabFor: (id: string) => sharedPrefabForGrid(deps.store, id),
      });
      gateCtx = { snapshot, graph: liveGraph(snapshot) };
    }
    return gateCtx;
  };
  const gateOf = (nodeId: string) => {
    const ctx = gates();
    return evaluateGate({
      store: deps.store,
      world,
      now: deps.clock?.() ?? Date.now(),
      nodeId,
      freshMs: deps.config.demo.gateFreshMs,
      prefabFor: (id: string) => sharedPrefabForGrid(deps.store, id),
      snapshot: ctx.snapshot,
      graph: ctx.graph,
    });
  };

  const linksFor = (id: string) => {
    const seen = new Set<string>();
    const out: { to: string; kind: string; distanceM: number; source: string }[] = [];
    for (const e of edgesByNode.get(id) ?? []) {
      const to = e.from === id ? e.to : e.from;
      const key = `${e.kind}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ to, kind: e.kind, distanceM: e.distanceM, source: e.source });
    }
    return out;
  };

  // Only show a world node when a real grid stands behind it. Built-in fixture
  // nodes (earthlike-hq, relay-1, ...) are planner stand-ins with no grid in
  // the game; rendering them as if they existed produced phantom map nodes.
  const plannedVisible = world.planned.filter((node) => {
    const match = /planned by ([^;]+);/.exec(node.note ?? '');
    const missionId = match?.[1];
    if (!missionId) return false;
    const mission = deps.store.getMission(missionId);
    return Boolean(mission && ['approved', 'executing'].includes(mission.status));
  });
  const worldNodes = [...aliveNodes(world).filter((n) => byId.has(n.id)), ...plannedVisible];
  const powerAlerts: PowerAlert[] = [];

  const nodes: Record<string, unknown>[] = worldNodes.map((node) => {
    const unit = byId.get(node.id);
    const telemetryPosition = unit?.pos ?? null;
    const source = unit && telemetryPosition ? 'GAME' : 'SIMULATED';
    const merged: DemoNode = telemetryPosition ? { ...node, position: telemetryPosition } : node;
    const capability = capabilityOfNode(node.id, node.prefab);
    const power = telemetryPosition ? powerForNode(deps, node.id, telemetryPosition, now) : null;
    if (power) powerAlerts.push(...power.alerts);
    const unitTelemetry = unit ? telemetryOf(unit, now) : null;
    // T61: who is aboard this node. `carrying` is true for a seated passenger;
    // `standing` is a player inside the hull who is not seated. The limits are
    // informational (the executor derives its own from the live local gravity).
    const crew = unit ? crewFromMeta((unit.meta ?? {}) as Record<string, unknown>) : null;
    return {
      id: node.id,
      name: node.name,
      prefab: node.prefab,
      planet: node.planet,
      position: merged.position,
      controlSource: caps.get(node.id)?.controlSource ?? node.controlSource,
      status: node.status,
      origin: node.origin,
      note: node.note,
      source,
      // SHIP ROLE (owner decision 2026-11-11): what the system may do with this
      // grid, where that came from, and why. Never merged with capability.role
      // (that is the functional class: relay / solar / ...).
      ...roleFieldsFor(node.id),
      // T66: the survival-loop row (state, reason, slot vacancy) lives next to
      // the role so the site can show both without a second request.
      ...(deps.survival?.rowFor(node.id) ? { survival: deps.survival.rowFor(node.id) } : {}),
      telemetry: unitTelemetry || power ? { ...(unitTelemetry ?? {}), ...(power?.block ?? {}) } : null,
      capabilityKnown: Boolean(capability),
      capability: capability ?? {
        role: 'unknown',
        radioRadiusM: null,
        laserRangeM: null,
        laserPorts: 0,
        controllable: 'unknown',
        sizeClass: 'unknown',
        isStatic: 'unknown',
        sourceNote: 'no capability profile for this telemetry grid',
      },
      links: linksFor(node.id),
      ports: ports[node.id] ?? { used: 0, capacity: 0 },
      reachable: node.status === 'planned' ? false : reachableSet.has(node.id),
      gate: node.status === 'planned' ? null : gateOf(node.id),
      /** T61 passenger rule: pilot / passengers / standing players (null = unknown). */
      crew: crew
        ? {
            underControl: crew.underControl,
            pilot: crew.pilot,
            passengers: crew.passengers,
            aboard: crew.aboard,
            carrying: crew.carried,
            standing: crew.standing,
            limits: passengerLimits(crew, STANDARD_GRAVITY_MPS2),
          }
        : null,
    };
  });

  // Telemetry grids with no fixture node: the capability profile (when the
  // grid is owner-tagged and provisioned) drives their links and gate.
  for (const unit of units) {
    if (world.nodes.some((n) => n.id === unit.id) || world.planned.some((n) => n.id === unit.id)) continue;
    if (!unit.pos) continue;
    const capability = capabilityOfNode(unit.id, typeof unit.meta?.prefab === 'string' ? unit.meta.prefab : null);
    const power = powerForNode(deps, unit.id, unit.pos, now);
    if (power) powerAlerts.push(...power.alerts);
    nodes.push({
      id: unit.id,
      name: unit.name,
      prefab: String(unit.meta?.prefab ?? caps.get(unit.id)?.profile ?? 'unknown'),
      planet: null,
      position: unit.pos,
      controlSource: caps.get(unit.id)?.controlSource ?? false,
      status: 'alive',
      origin: 'fixture',
      note: capability
        ? 'plugin-reported grid; capability from the provisioning snapshot'
        : 'plugin-reported grid; no capability profile',
      source: 'GAME',
      ...roleFieldsFor(unit.id),
      ...(deps.survival?.rowFor(unit.id) ? { survival: deps.survival.rowFor(unit.id) } : {}),
      telemetry: { ...telemetryOf(unit, now), ...(power?.block ?? {}) },
      capabilityKnown: Boolean(capability),
      capability,
      links: linksFor(unit.id),
      ports: ports[unit.id] ?? { used: 0, capacity: 0 },
      reachable: reachableSet.has(unit.id),
      gate: gateOf(unit.id),
      /** T61 passenger rule: pilot / passengers / standing players (null = unknown). */
      crew: (() => {
        const c = crewFromMeta((unit.meta ?? {}) as Record<string, unknown>);
        if (!c) return null;
        return {
          underControl: c.underControl,
          pilot: c.pilot,
          passengers: c.passengers,
          aboard: c.aboard,
          carrying: c.carried,
          standing: c.standing,
          limits: passengerLimits(c, STANDARD_GRAVITY_MPS2),
        };
      })(),
    });
  }

  const missions = deps.store.listMissions({ limit: 200 });
  return {
    schemaVersion: 1,
    now,
    env: {
      name: env.badge,
      locked: true,
      rtsEnv: 'test',
      marker: 'se-rts-test',
      productionFallback: false,
    },
    planets: loadPlanetCatalog(),
    world: { snapshot: world.snapshot, nodes: world.nodes.length, planned: world.planned.length },
    nodes,
    telemetry: telemetrySummary,
    graph,
    liveLinks: livePairs.map((p) => ({
      from: p.a,
      to: p.b,
      kind: 'laser' as const,
      status: 'Connected',
      mutual: p.mutual,
      distanceM: p.distanceM,
      lasers: p.lasers,
      source: 'GAME' as const,
      sampledAt: p.at,
    })),
    network: {
      provisioned: snapshot.provisioned,
      capabilityProfiles: caps.size,
      controlSources: [...caps.values()].filter((c) => c.controlSource).map((c) => c.gridId),
      excludedFixtures: snapshot.excludedFixtures,
      labels: snapshot.labels,
    },
    reachability: { reachable: reachable.sort(), isolated: isolated.sort(), sources: graph.nodes.filter((n) => n.controlSource).map((n) => n.id) },
    spofs: graph.articulationPoints,
    bridges: graph.bridges,
    ports,
    flags: deps.store.getFlags(),
    killSwitch: deps.store.isKillSwitchOn(),
    // T68: the alert feed itself is GET /api/alerts; this is the compact
    // summary the map header and toasts read alongside the state poll.
    alerts: deps.alerts
      ? deps.alerts.summary(now)
      : { open: 0, acked: 0, critical: 0, enabled: false, reason: 'alerts engine not attached (demo disabled at startup)' },
    plugin: {
      connected: deps.hub.isConnected(),
      agentId: deps.hub.agentId(),
      lastStatus: deps.hub.lastStatus(),
      /** Age of the newest plugin telemetry sample; drives the UI status. */
      lastHeartbeatAgeMs: telemetrySummary.latestAgeMs,
      gridCount: telemetrySummary.gridCount,
    },
    // T20: fleet-wide power view. Per-node values live under nodes[].telemetry.
    power: deps.power
      ? {
          ...deps.power.summary(now),
          alerts: powerAlerts,
          grids: deps.power.allSnapshots().map((snap) => ({
            gridId: snap.gridId,
            name: snap.name,
            batteryPct: snap.batteryPct,
            charge: snap.charge,
            netMw: snap.netMw,
            solarPct: snap.solarEfficiency === null ? null : Math.round(snap.solarEfficiency * 1000) / 10,
            h2Pct: snap.h2Pct,
            uraniumPct: snap.uraniumPct,
            isStatic: snap.isStatic,
            underControl: snap.underControl,
            sampledAt: snap.at,
            ageMs: Math.max(0, now - snap.at),
          })),
        }
      : {
          enabled: false,
          reason: 'power poller not attached (demo disabled at startup)',
          alerts: [],
          grids: [],
        },
    // T74: true on any non-test backend; the site shows it and disables the
    // spawn/clone/delete controls instead of letting them fail at the plugin.
    survivalMode,
    executions: deps.executor?.summary() ?? {
      enabled: false,
      reason: 'executor not attached (demo disabled at startup)',
      executions: [],
    },
    standins: listStandIns(),
    hardwareSummary: hardwareSummary(),
    // T61: compact players block - who is online this instant, with the age of
    // the sample. Last-known positions with their age are on GET
    // /api/demo/players (this block stays small for the 1-2 s state poll).
    players: (() => {
      const settings = readPlayerSettings(deps.store);
      const view = playersView(deps, settings, now);
      if (!view) {
        return { enabled: false, reason: 'player tracker not attached (demo disabled at startup)', online: [], onlineCount: 0, lastKnownCount: 0 };
      }
      return {
        enabled: true,
        onlineCount: view.onlineCount,
        lastKnownCount: deps.players!.summary(now).lastKnownCount,
        hiddenByFactionFilter: view.hiddenByFactionFilter,
        filter: view.filter,
        sampledAt: view.sampledAt,
        online: view.online.map((p) => ({
          identityId: p.identityId,
          steamId: p.steamId,
          displayName: p.displayName,
          pos: p.pos,
          planet: p.planet,
          aglM: p.aglM,
          gridId: p.gridId,
          seatName: p.seatName,
          piloting: p.piloting,
          onFoot: p.onFoot,
          isDead: p.isDead,
          ageMs: p.ageMs,
          fresh: p.fresh,
          factionTag: p.factionTag,
          source: p.source,
        })),
      };
    })(),
    missions: {
      open: missions.filter((m) => ['queued', 'planned', 'approved', 'executing', 'paused'].includes(m.status)).length,
      awaitingApproval: missions.filter((m) => m.approval === 'approve' && m.status === 'queued').length,
      recent: missions.slice(0, 12),
    },
    // T66: the survival-loop state machine, its settings and every grid that has
    // an opinion attached (OK grids with no recommendation are omitted).
    survival: deps.survival
      ? deps.survival.view()
      : {
          settings: { approvalMode: 'auto', marginPct: 20, relaunchPct: 90 },
          defaultHomeId: null,
          overrides: {},
          grids: [],
        },
    assumptions: [
      { id: 'graph', text: 'overlay graph nodes/positions come from plugin telemetry; radio reach is range maths over provisioned capability profiles', status: 'SIMULATED' },
      { id: 'network', text: 'control sources are provisioned [HERMES-BASE] grids whose antenna state was read back from the block (GAME)', status: 'GAME' },
      { id: 'laser_range', text: 'laser links use a 100,000 m demo cap; a Connected pair reported by laser_state is a GAME edge', status: 'UNVERIFIED' },
      { id: 'capability', text: 'radio radius comes from the provisioning read-back (50 km); mass/laser counts from list_tagged', status: 'GAME' },
      { id: 'power', text: 'battery/solar/H2/uranium values come from the read-only profile poll (30 s); rates and runways are maths over those samples', status: 'GAME' },
    ],
    labels: ['GAME', 'SIMULATED', 'UNVERIFIED'],
  };
}

function planResponse(plan: DemoConnectPlan) {
  return {
    ...plan,
    gatePreview: plan.options.map((o) => ({ optionId: o.id, count: o.count, portsOk: o.portsOk, linksOk: o.linksOk })),
  };
}

function resolvePlanTemplates(body: z.infer<typeof ConnectBody>): {
  radio?: ReturnType<typeof resolveTemplate>;
  laser?: ReturnType<typeof resolveTemplate>;
  laserSpacingM?: number;
} {
  const out: {
    radio?: ReturnType<typeof resolveTemplate>;
    laser?: ReturnType<typeof resolveTemplate>;
    laserSpacingM?: number;
  } = {};
  try {
    if (body.templates?.radio) out.radio = resolveTemplate(body.templates.radio);
    if (body.templates?.laser) out.laser = resolveTemplate(body.templates.laser);
    if (body.templates?.laserSpacingM !== undefined) out.laserSpacingM = body.templates.laserSpacingM;
  } catch (err) {
    throw new DemoHttpError(400, 'unknown_template', err instanceof Error ? err.message : 'unknown template');
  }
  return out;
}

function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

function chainMissionPayload(plan: DemoConnectPlan, optionId: OptionId, note?: string) {
  const option = optionById(plan, optionId);
  const first = option.nodes.find((n) => n.role === 'radio-relay' || n.role === 'laser-bridge') ?? option.nodes[0]!;
  const steps = [
    { id: 'validate', kind: 'validate_spec', params: {}, done: false },
    ...option.nodes.map((n, i) => ({
      id: `deploy-${i}`,
      kind: 'print',
      params: { prefab: n.prefab, position: n.position, role: n.role, option: option.id },
      done: false,
    })),
    ...option.nodes.map((n, i) => ({
      id: `move-${i}`,
      kind: 'move',
      params: { target: n.position, role: n.role, option: option.id },
      done: false,
    })),
    { id: 'gate', kind: 'custom', params: { demoGateNode: 'earthlike-hq', option: option.id }, done: false },
  ];
  return {
    option,
    input: {
      type: 'build_deploy',
      priority: 60,
      desiredState: {
        shipSpec: option.id === 'radio' ? 'relay-chain-radio' : option.id === 'laser' ? 'relay-chain-laser' : 'relay-chain-mixed',
        station: `chain:${idPart(plan.from)}:${idPart(plan.to)}:${option.id}`,
        formation: 'line',
        qty: Math.min(500, option.count),
        position: first.position,
      },
      budget: { resources: {}, timeMin: 240, lossLimit: 0, maxUnits: Math.min(500, option.count) },
      approval: 'approve',
      assignedUnits: [],
      plan: {
        steps,
        notes:
          `[SIMULATED] planner chain ${plan.from}->${plan.to} (${option.id}), ${option.count} nodes, ` +
          `${option.relayCount} relays. Positions, spacing and links are planner math. ` +
          `Laser range cap 100 km, radio 50 km: UNVERIFIED against the game. ` +
          `Nothing executes until a plugin is connected, the dispatch flag is on and an operator approves.` +
          (note ? ` Operator note: ${note}` : ''),
      },
      idempotencyKey: `demo-connect:${plan.from}:${plan.to}:${option.id}`,
    },
  };
}

/**
 * Per-server `GET /api/demo/state` cache. Keyed by the deps object so two
 * runtimes in one process (tests, or a before/after measurement) can never
 * serve each other's state. See `stateCache.ts` for why a 1 s map read is
 * worth it: the flight tick must not be starved by state samplers.
 */
const stateCaches = new WeakMap<object, DemoStateCache>();

/**
 * A cheap fingerprint of what `demoState` reads, so a cached body is only
 * reused while nothing it was built from has changed. Counts plus the newest
 * timestamp of each mutable table: six indexed reads, microseconds against a
 * payload this size, and it makes the cache correct for direct store writes
 * (tests do that, and so does every non-HTTP producer: the executor, the
 * provisioner, the power poller).
 *
 * An unreadable schema returns a unique token, i.e. caching is skipped.
 */
function demoStateFingerprint(store: Store): string {
  try {
    const q = (sql: string): string => {
      const row = store.db.prepare(sql).get() as { n?: unknown; last?: unknown } | undefined;
      return `${Number(row?.n ?? 0)}:${Number(row?.last ?? 0)}`;
    };
    const units = q('SELECT COUNT(*) AS n, COALESCE(MAX(last_seen), 0) AS last FROM units');
    const drones = q('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS last FROM demo_drones');
    const exec = q('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS last FROM demo_exec');
    const groups = q('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS last FROM groups');
    const orders = q('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last FROM orders');
    const audit = q('SELECT COALESCE(MAX(rowid), 0) AS n, 0 AS last FROM audit');
    return [units, drones, exec, groups, orders, audit].join('|');
  } catch {
    return `nocache:${Date.now()}:${Math.random()}`;
  }
}

/** Drop the cached state (called on every non-GET request: a write is never masked). */
export function invalidateDemoStateCache(deps: object): void {
  stateCaches.get(deps)?.clear();
}

/** Cache counters for the ops surface / tests. */
export function demoStateCacheStats(deps: object): ReturnType<DemoStateCache['stats']> | null {
  return stateCaches.get(deps)?.stats() ?? null;
}

export function demoRoutesFor(deps: DemoDeps): DemoRoute[] {
  const env = resolveDemoEnv();
  if (!env) return [];
  const clock = () => deps.clock?.() ?? Date.now();
  const stateCache = new DemoStateCache();
  stateCaches.set(deps, stateCache);
  const fleet = new FleetService({
    store: deps.store,
    hub: deps.hub,
    config: deps.config,
    clock,
    fixturePath: env.fixturePath,
    // T50: fleet steps are executor missions; without the executor, approve
    // refuses to execute (it never falls back to raw hub orders).
    executor: deps.executor ?? null,
  });

  const routes: DemoRoute[] = [
    // ---------------------------------------------------------------- T68 alerts
    {
      method: 'GET',
      pattern: /^\/api\/alerts$/,
      handler: ({ res, url }) => {
        if (!deps.alerts) {
          sendJson(res, 200, {
            enabled: false,
            reason: 'alerts engine not attached (demo disabled at startup)',
            alerts: [],
            counts: { open: 0, acked: 0, critical: 0 },
          });
          return;
        }
        const listOf = (name: string, allowed: readonly string[]): string[] | undefined => {
          const raw = url.searchParams
            .getAll(name)
            .flatMap((value) => value.split(','))
            .map((value) => value.trim())
            .filter(Boolean);
          if (raw.length === 0) return undefined;
          const bad = raw.filter((value) => !allowed.includes(value));
          if (bad.length) {
            throw new DemoHttpError(400, 'invalid', `invalid ${name}: ${bad.join(', ')}`);
          }
          return [...new Set(raw)];
        };
        const states = listOf('state', ['open', 'acked', 'resolved']);
        const severities = listOf('severity', ['info', 'warn', 'critical']);
        const subjectType = url.searchParams.get('subjectType') ?? undefined;
        if (subjectType && !['grid', 'planet', 'system'].includes(subjectType)) {
          throw new DemoHttpError(400, 'invalid', `invalid subjectType: ${subjectType}`);
        }
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? 100 : Number(limitRaw);
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          throw new DemoHttpError(400, 'invalid', 'limit must be a number between 1 and 1000');
        }
        const alerts = deps.alerts.list({
          ...(states ? { state: states as ('open' | 'acked' | 'resolved')[] } : {}),
          ...(severities ? { severity: severities as ('info' | 'warn' | 'critical')[] } : {}),
          ...(subjectType ? { subjectType: subjectType as 'grid' | 'planet' | 'system' } : {}),
          ...(url.searchParams.get('subjectId') ? { subjectId: url.searchParams.get('subjectId')! } : {}),
          ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind')! } : {}),
          limit,
        });
        const settings = readAlertsSettings(deps.store);
        sendJson(res, 200, {
          enabled: true,
          now: clock(),
          alerts,
          counts: deps.store.countActiveAlerts(),
          filters: { state: states ?? null, severity: severities ?? null, subjectType: subjectType ?? null, limit },
          delivery: { discord: settings.discordWebhook ? 'configured' : 'disabled', batchMs: settings.batchMs },
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/alerts\/evaluate$/,
      handler: async ({ res }) => {
        if (!deps.alerts) throw new DemoHttpError(503, 'alerts_disabled', 'alerts engine is not attached');
        const result = await deps.alerts.evaluate();
        sendJson(res, 200, {
          ...result,
          summary: deps.alerts.summary(clock()),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/alerts\/settings$/,
      handler: ({ res }) => {
        const settings = readAlertsSettings(deps.store);
        sendJson(res, 200, {
          settings: {
            ...settings,
            // The webhook is a credential (Discord embeds a token in it).
            discordWebhook: settings.discordWebhook ? '[set]' : '',
            webhookConfigured: Boolean(settings.discordWebhook),
          },
        });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/alerts\/settings$/,
      handler: async ({ req, res }) => {
        const parsed = AlertSettingsBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid alerts settings', formatIssues(parsed.error));
        }
        const next = writeAlertsSettings(deps.store, parsed.data, actorOf(req), clock());
        sendJson(res, 200, {
          settings: {
            ...next,
            discordWebhook: next.discordWebhook ? '[set]' : '',
            webhookConfigured: Boolean(next.discordWebhook),
          },
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/alerts\/([^/]+)\/ack$/,
      handler: async ({ req, res, params }) => {
        if (!deps.alerts) throw new DemoHttpError(503, 'alerts_disabled', 'alerts engine is not attached');
        const alert = deps.alerts.get(params[0]!);
        if (!alert) throw new DemoHttpError(404, 'unknown_alert', `unknown alert ${params[0]}`);
        if (alert.state === 'resolved') {
          throw new DemoHttpError(409, 'alert_resolved', 'the condition cleared; this alert is already resolved');
        }
        const parsed = AlertActionBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid ack body', formatIssues(parsed.error));
        }
        const updated = deps.alerts.acknowledge(params[0]!, parsed.data.by ?? actorOf(req), clock());
        sendJson(res, 200, { alert: updated, audit: 'alert_acked' });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/alerts\/([^/]+)\/resolve$/,
      handler: async ({ req, res, params }) => {
        if (!deps.alerts) throw new DemoHttpError(503, 'alerts_disabled', 'alerts engine is not attached');
        const alert = deps.alerts.get(params[0]!);
        if (!alert) throw new DemoHttpError(404, 'unknown_alert', `unknown alert ${params[0]}`);
        const parsed = AlertActionBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid resolve body', formatIssues(parsed.error));
        }
        const updated = deps.alerts.resolve(params[0]!, parsed.data.by ?? actorOf(req), clock());
        sendJson(res, 200, { alert: updated, audit: 'alert_resolved' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/state$/,
      handler: ({ req, res }) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const includeArchived = ['1', 'true', 'yes'].includes((url.searchParams.get('archived') ?? '').toLowerCase());
        // A burst of state reads must never consume the event loop the flight
        // tick needs (measured 2026-11-10: 1 Hz sampling starved it for 12.3 s
        // mid-fall and a hull hit the ground at 57 m/s). 1 s of map staleness
        // is honest; every non-GET request clears the entry.
        const key = DemoStateCache.key(includeArchived);
        const ttlMs = demoStateCacheTtlMs();
        const fingerprint = demoStateFingerprint(deps.store);
        if (ttlMs > 0) {
          const cached = stateCache.get(key, Date.now(), fingerprint);
          if (cached !== null) {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(cached),
              'cache-control': 'no-store',
              'x-demo-state': 'cached',
            });
            res.end(cached);
            return;
          }
        }
        const body = demoState(deps, env, { includeArchived });
        if (ttlMs > 0) {
          // Serialize ONCE, here: a hit must not re-run JSON.stringify on the
          // largest payload this server produces.
          const payload = JSON.stringify(body);
          stateCache.set(key, payload, Date.now(), fingerprint);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'cache-control': 'no-store',
            'x-demo-state': 'fresh',
          });
          res.end(payload);
          return;
        }
        sendJson(res, 200, body);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/players$/,
      handler: ({ res, url }) => {
        const now = clock();
        const settings = readPlayerSettings(deps.store);
        const view = playersView(deps, settings, now);
        if (!view || !deps.players) {
          throw new DemoHttpError(503, 'players_disabled', 'player tracker is not attached (demo disabled at startup)');
        }
        // Owner-facing filters; each is optional and none changes what is
        // stored. `all=1` is the owner's explicit override of the faction
        // filter for this request only (an audited read, never a write).
        const all = ['1', 'true', 'yes'].includes((url.searchParams.get('all') ?? '').toLowerCase());
        const onlineOnly = ['1', 'true', 'yes'].includes((url.searchParams.get('onlineOnly') ?? '').toLowerCase());
        const steamId = (url.searchParams.get('steamId') ?? '').trim();
        const effective = all ? { ...settings, filterToOwnerFaction: false } : settings;
        const filtered = all ? playersView(deps, effective, now) : view;
        const answer = filtered ?? view;
        const pick = (p: PlayerView['online'][number]) => ({
          ...p,
          isOwner: p.steamId === deps.config.owner.steamId,
        });
        const matches = (p: { steamId: string }) => !steamId || p.steamId === steamId;
        const online = answer.online.map(pick).filter(matches);
        const lastKnown = onlineOnly ? [] : answer.lastKnown.map(pick).filter(matches);
        if (steamId && online.length === 0 && lastKnown.length === 0) {
          throw new DemoHttpError(404, 'unknown_player', `no player with steamId ${steamId} has been seen on this server`);
        }
        sendJson(res, 200, {
          // Faction filter + the age of every position are part of the answer
          // on purpose: the UI must be able to say "last seen 4h ago".
          filter: answer.filter,
          factions: answer.filter.ownerFactionTag,
          online,
          lastKnown,
          onlineCount: online.length,
          lastKnownCount: lastKnown.length,
          hiddenByFactionFilter: all ? 0 : answer.hiddenByFactionFilter,
          lastKnownRetentionMs: deps.config.demo.archivedAfterMs,
          sampledAt: answer.sampledAt,
          now,
          source: 'GAME',
          note:
            'players come from the plugin telemetry players[] sample (identities as strings); ' +
            'lastKnown rows keep the last position with its age after a disconnect or death; ' +
            'other factions are never included unless all=1 is passed explicitly',
        });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/demo\/players\/settings$/,
      handler: async ({ req, res }) => {
        const raw = await readJson(req);
        const body = PlayerSettingsBody.safeParse(raw);
        if (!body.success) throw new DemoHttpError(400, 'invalid', 'invalid player settings', formatIssues(body.error));
        const next = writePlayerSettings(deps.store, body.data, actorOf(req), clock());
        sendJson(res, 200, { settings: next });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/players\/settings$/,
      handler: ({ res }) => {
        sendJson(res, 200, { settings: readPlayerSettings(deps.store) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/players\/(list|probe)$/,
      handler: async ({ res }) => {
        // Read-only liveness probe for the map: ask the plugin for
        // `list_players` RIGHT NOW and return its answer next to the cached
        // telemetry sample, so "nobody is online" can be proven rather than
        // assumed. No world state is changed by the action.
        const now = clock();
        if (!deps.hub.isConnected()) {
          throw new DemoHttpError(503, 'plugin_offline', 'the test-server plugin is not connected');
        }
        const cached = deps.store.getKv('telemetry:players');
        let plugin: Record<string, unknown>;
        try {
          const result = await callPlugin({ config: deps.config, store: deps.store, hub: deps.hub, clock } as never, 'list_players', {}, 20_000);
          plugin = { ok: result.ok, ...(result.result ?? {}), error: result.error ?? null };
        } catch (err) {
          plugin = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const settings = readPlayerSettings(deps.store);
        const view = playersView(deps, settings, now);
        sendJson(res, 200, {
          plugin,
          cached: cached ? (JSON.parse(cached) as unknown) : null,
          view,
          filter: view?.filter ?? null,
          audit: 'demo_players_probe',
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/links$/,
      handler: async ({ res, url }) => {
        // Contract §1: current (GAME) vs possible (SIMULATED range/LOS/ports).
        const now = clock();
        const world = loadWorld(deps.store, env.fixturePath, now);
        const snapshot = networkSnapshot({
          store: deps.store,
          world,
          now,
          freshMs: Math.max(deps.config.demo.gateFreshMs, 60_000),
          prefabFor: (id) => sharedPrefabForGrid(deps.store, id),
        });
        const graph = liveGraph(snapshot);
        const planets = loadPlanetCatalog();
        const caps = snapshot.capability;
        const usedPorts = new Map<string, number>();
        for (const pair of snapshot.livePairs) {
          for (const id of [pair.a, pair.b]) usedPorts.set(id, (usedPorts.get(id) ?? 0) + 1);
        }
        const planetParam = (url.searchParams.get('planet') ?? '').trim();
        if (planetParam && !planets.some((p) => p.name.toLowerCase() === planetParam.toLowerCase() || p.id.toLowerCase() === planetParam.toLowerCase())) {
          throw new DemoHttpError(404, 'unknown_planet', `unknown planet ${planetParam}`);
        }
        const inPlanet = (node: LinkNode): boolean => !planetParam || nodeMatchesPlanet(node, planets, planetParam);
        const nodes: LinkNode[] = snapshot.nodes
          .map((n) => {
            const cap = caps.get(n.id);
            return {
              id: n.id,
              name: cap?.name ?? n.id,
              position: n.position,
              radioRadiusM: n.radioRadiusM ?? cap?.radioRadiusM ?? null,
              laserPorts: cap?.laserCount ?? 0,
              laserUsedPorts: usedPorts.get(n.id) ?? 0,
              laserRangeM: n.laserRangeM ?? cap?.laserRangeM ?? null,
            } satisfies LinkNode;
          })
          .filter(inPlanet);

        // GAME radio groups: one read-only plugin order, short timeout. A slow
        // or offline plugin leaves the SIMULATED range edges as the fallback.
        let radioGroups: ReturnType<typeof radioGroupsFromPlugin> = [];
        if (deps.hub.isConnected() && nodes.length > 0) {
          const candidates = radioPollCandidates(nodes);
          const cacheKey = candidates.join(',');
          const cached = radioLinksCache.get(cacheKey);
          if (cached && now - cached.at < RADIO_LINKS_TTL_MS) {
            radioGroups = cached.result;
          } else if (candidates.length >= 2) {
            try {
              const live = await callPlugin(deps, 'radio_links', { entityIds: candidates }, 2_500);
              if (live.ok) {
                radioGroups = radioGroupsFromPlugin(live.result);
                radioLinksCache.set(cacheKey, { at: now, result: radioGroups });
              }
            } catch {
              /* plugin too slow this tick: labels say SIMULATED instead */
            }
          }
        }
        const view = await buildLinksView({
          nodes,
          planets,
          radioGroups,
          liveLaserPairs: snapshot.livePairs.map((p) => ({ a: p.a, b: p.b, distanceM: p.distanceM, mutual: p.mutual })),
          simulatedEdges: (graph.edges as SourcedEdge[])
            .filter((e) => e.source === 'SIMULATED')
            .map((e) => ({ from: e.from, to: e.to, kind: e.kind, distanceM: e.distanceM })),
        });
        sendJson(res, 200, {
          ...view,
          planet: planetParam || null,
          nodeCount: nodes.length,
          generatedAt: now,
          sources: {
            radioGroups: radioGroups.length,
            liveLaserPairs: snapshot.livePairs.length,
            provisioned: snapshot.provisioned,
          },
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/links\/connect$/,
      handler: async ({ req, res }) => {
        // Planner link creation / "link these two" share one sequence: OnOff ->
        // target the partner laser BLOCK -> connect -> poll <= 20 s -> retry.
        const body = z
          .object({
            a: z.string().min(1),
            b: z.string().min(1),
            permanent: z.boolean().optional(),
            timeoutMs: z.number().int().min(2_000).max(60_000).optional(),
          })
          .parse(await readJson(req));
        if (body.a === body.b) throw new DemoHttpError(400, 'invalid', 'a and b must be different grids');
        // SHIP ROLE: aiming/connecting lasers is an automatic settings change.
        // PERSONAL ships and OFF grids are never laser-tuned by the system.
        for (const gridId of [body.a, body.b]) {
          const role = shipRoles.roleOf(gridId);
          if (role !== 'managed') {
            throw new DemoHttpError(409, `role_${role}`, `role ${role}: laser linking only touches managed grids`);
          }
        }
        if (!deps.hub.isConnected()) throw new DemoHttpError(503, 'plugin_offline', 'the test-server plugin is not connected');
        const now = clock();
        const link = await new LaserLinker({
          call: (action, params, timeout) => callPlugin(deps, action, params, timeout),
          now: clock,
        }).connect({
          a: { gridId: body.a },
          b: { gridId: body.b },
          permanent: body.permanent,
          timeoutMs: body.timeoutMs ?? 20_000,
        });
        deps.store.audit({
          actor: 'owner-request',
          action: 'demo_laser_connect',
          subject: `${body.a}<->${body.b}`,
          detail: { ...link },
          at: now,
        });
        // Sim-speed audit #4: a laser command just changed these two grids'
        // link state, so their backed-off `laser_state` sample is due now.
        try {
          provisionerFor(deps).markLaserActivity(body.a);
          provisionerFor(deps).markLaserActivity(body.b);
        } catch {
          /* the link route must not fail because the poller is not running */
        }
        sendJson(res, link.ok ? 200 : 502, link);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/groups$/,
      handler: ({ res }) => {
        // CONTRACT-FEATURES §4: server-persisted groups, members as strings.
        sendJson(res, 200, { groups: deps.store.listGroups() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/groups$/,
      handler: async ({ req, res }) => {
        const parsed = GroupCreateBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid group', formatIssues(parsed.error));
        const id = parsed.data.id ?? `g-${randomUUID()}`;
        const members = [...new Set(parsed.data.members)];
        const group = deps.store.createGroup({
          id,
          name: parsed.data.name,
          color: parsed.data.color ?? null,
          members,
        });
        if (!group) {
          throw new DemoHttpError(409, 'group_exists', `group ${id} already exists`);
        }
        audit(deps, req, 'demo_group_create', group.id, {
          name: group.name,
          color: group.color,
          members: group.members,
        });
        sendJson(res, 201, { group });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/demo\/groups\/([^/]+)$/,
      handler: async ({ req, res, params }) => {
        const groupId = params[0]!;
        const existing = deps.store.getGroup(groupId);
        if (!existing) throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        const parsed = GroupPatchBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid group patch', formatIssues(parsed.error));
        const patch: { name?: string; color?: string | null; members?: string[] } = {};
        if (parsed.data.name !== undefined) patch.name = parsed.data.name;
        if (parsed.data.color !== undefined) patch.color = parsed.data.color;
        if (parsed.data.members !== undefined) patch.members = [...new Set(parsed.data.members)];
        const group = deps.store.updateGroup(groupId, patch);
        if (!group) throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        audit(deps, req, 'demo_group_update', group.id, { patch });
        sendJson(res, 200, { group });
      },
    },
    {
      // PUT is the shape the first client build shipped; keep it as an alias.
      method: 'PUT',
      pattern: /^\/api\/demo\/groups\/([^/]+)$/,
      handler: async ({ req, res, params }) => {
        const groupId = params[0]!;
        const existing = deps.store.getGroup(groupId);
        if (!existing) throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        const parsed = GroupPatchBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid group patch', formatIssues(parsed.error));
        const patch: { name?: string; color?: string | null; members?: string[] } = {};
        if (parsed.data.name !== undefined) patch.name = parsed.data.name;
        if (parsed.data.color !== undefined) patch.color = parsed.data.color;
        if (parsed.data.members !== undefined) patch.members = [...new Set(parsed.data.members)];
        const group = deps.store.updateGroup(groupId, patch);
        if (!group) throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        audit(deps, req, 'demo_group_update', group.id, { patch, via: 'PUT' });
        sendJson(res, 200, { group });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/demo\/groups\/([^/]+)$/,
      handler: ({ req, res, params }) => {
        const groupId = params[0]!;
        if (!deps.store.deleteGroup(groupId)) {
          throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        }
        audit(deps, req, 'demo_group_delete', groupId, {});
        sendJson(res, 200, { deleted: true, id: groupId });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/groups\/([^/]+)\/stop$/,
      handler: async ({ req, res, params }) => {
        const groupId = params[0]!;
        const group = deps.store.getGroup(groupId);
        if (!group) throw new DemoHttpError(404, 'unknown_group', `unknown group ${groupId}`);
        const parsed = GroupStopBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid group stop request', formatIssues(parsed.error));
        const now = clock();
        const requested = parsed.data.gridIds ?? group.members;
        const result = sendGroupStop(deps, env, group, requested, now);
        audit(deps, req, 'demo_group_stop', group.id, {
          requested,
          stopped: result.stopped,
          skipped: result.skipped,
        });
        const total = new Set(requested).size;
        sendJson(res, 200, {
          groupId: group.id,
          requested: total,
          stopped: result.stopped.length,
          stoppedGrids: result.stopped,
          skipped: result.skipped,
          orders: result.orderIds,
          note:
            result.stopped.length === 0
              ? `no stop order was sent; ${result.skipped.length} grid(s) skipped with the reason listed`
              : `stop order sent to ${result.stopped.length} of ${total} grid(s)` +
                (result.skipped.length ? `; ${result.skipped.length} skipped with the reason listed` : ''),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/fleet-ops$/,
      handler: ({ res }) => {
        sendJson(res, 200, { operations: fleet.list() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/fleet-ops$/,
      handler: async ({ req, res }) => {
        assertKillSwitchOff(deps.store);
        const parsed = FleetOpCreateBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid fleet operation', formatIssues(parsed.error));
        }
        const result = await fleet.create(parsed.data as FleetCreateRequest, actorOf(req));
        if (!result.ok) {
          audit(deps, req, 'fleet_op_create_refused', result.operation?.id ?? 'fleet-op', {
            code: result.code,
            kind: parsed.data.kind,
            failure: result.failure ?? null,
          });
          sendJson(res, result.status, {
            error: { code: result.code, message: result.message },
            operation: result.operation ?? null,
            invariant: result.failure ?? null,
          });
          return;
        }
        audit(deps, req, 'fleet_op_create', result.operation.id, {
          kind: result.operation.kind,
          members: result.operation.members,
          dryRun: result.operation.dryRun,
          abortPolicy: result.operation.abortPolicy,
          steps: result.operation.steps.length,
          invariantOk: result.operation.invariants.ok,
          coverageBefore: result.coverage?.before?.coveragePct ?? null,
          coverageAfter: result.coverage?.after?.coveragePct ?? null,
        });
        sendJson(res, 201, {
          operation: result.operation,
          coverage: result.coverage ?? null,
          note: result.note,
          labels: [
            'SIMULATED',
            result.operation.dryRun ? 'DRY-RUN' : 'AWAITING-APPROVAL',
            ...(result.operation.kind === 'scuttle' ? ['DESTRUCTIVE-PLAN-ONLY'] : []),
          ],
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/fleet-ops\/([^/]+)$/,
      handler: ({ res, params }) => {
        // Polling a running operation also advances it (arrival -> next wave).
        const operation = fleet.get(params[0]!);
        if (!operation) throw new DemoHttpError(404, 'unknown_operation', `unknown fleet operation ${params[0]}`);
        sendJson(res, 200, { operation });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/fleet-ops\/([^/]+)\/approve$/,
      handler: async ({ req, res, params }) => {
        assertKillSwitchOff(deps.store);
        const id = params[0]!;
        const parsed = FleetApproveBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid approve request', formatIssues(parsed.error));
        }
        const result = fleet.approve(id, actorOf(req), parsed.data);
        if (!result.ok) {
          audit(deps, req, 'fleet_op_approve_refused', id, {
            code: result.code,
            failure: result.failure ?? null,
          });
          sendJson(res, result.status, {
            error: { code: result.code, message: result.message },
            operation: result.operation ?? null,
            invariant: result.failure ?? null,
          });
          return;
        }
        audit(deps, req, 'fleet_op_approve', id, {
          kind: result.operation.kind,
          status: result.operation.status,
          dryRun: result.operation.dryRun,
          execution: result.execution ?? null,
        });
        sendJson(res, 200, {
          operation: result.operation,
          execution: result.execution ?? null,
          note: result.note ?? null,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/fleet-ops\/([^/]+)\/cancel$/,
      handler: async ({ req, res, params }) => {
        const id = params[0]!;
        const parsed = FleetActionBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid cancel request', formatIssues(parsed.error));
        }
        const result = fleet.cancel(id, actorOf(req), parsed.data);
        if (!result.ok) {
          sendJson(res, result.status, {
            error: { code: result.code, message: result.message },
            operation: result.operation ?? null,
          });
          return;
        }
        audit(deps, req, 'fleet_op_cancel', id, {
          status: result.operation.status,
          abort: result.operation.invariants.abort ?? [],
        });
        sendJson(res, 200, {
          operation: result.operation,
          abort: result.operation.invariants.abort ?? [],
          note: result.note ?? null,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/fleet-ops\/([^/]+)\/abort$/,
      handler: async ({ req, res, params }) => {
        const id = params[0]!;
        const parsed = FleetActionBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'invalid abort request', formatIssues(parsed.error));
        }
        const result = fleet.abort(id, actorOf(req), parsed.data);
        if (!result.ok) {
          sendJson(res, result.status, {
            error: { code: result.code, message: result.message },
            operation: result.operation ?? null,
          });
          return;
        }
        audit(deps, req, 'fleet_op_abort', id, {
          status: result.operation.status,
          policy: result.operation.abortPolicy,
          abort: result.operation.invariants.abort ?? [],
        });
        sendJson(res, 200, {
          operation: result.operation,
          abort: result.operation.invariants.abort ?? [],
          note: result.note ?? null,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/power\/budget$/,
      handler: ({ res, url }) => {
        const numParam = (name: string): number | null => {
          const raw = url.searchParams.get(name);
          if (raw === null || raw === '') return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        };
        const gridId = url.searchParams.get('gridId');
        const cap = gridId ? capabilitiesFromStore(deps.store).get(gridId) : undefined;
        const snap = gridId ? deps.power?.snapshot(gridId) ?? null : null;
        if (gridId && !cap && !snap) {
          throw new DemoHttpError(404, 'unknown_grid', `unknown grid ${gridId} (no capability profile or power sample)`);
        }
        const now = clock();
        const planets = loadPlanetCatalog();
        const unit = gridId ? deps.store.getUnit(gridId) : null;
        const planetName = url.searchParams.get('planet');
        const planet = planetName
          ? planets.find((p) => p.name.toLowerCase() === planetName.toLowerCase()) ?? null
          : unit?.pos
            ? nearestPlanetTo(unit.pos, planets)
            : null;
        const altitudeM = numParam('slotAltM')
          ?? (unit?.pos && planet
            ? Math.max(0, Math.hypot(unit.pos.x - planet.center.x, unit.pos.y - planet.center.y, unit.pos.z - planet.center.z) - planet.surfaceRadiusM)
            : 0);
        const isStatic = snap?.isStatic === true;
        const zeroG = Boolean(planet?.hasAtmosphere && altitudeM >= ZERO_G_ALT_M);
        const flightModeRaw = url.searchParams.get('flightMode');
        const flightMode = flightModeRaw === 'station' || flightModeRaw === 'zero-g' || flightModeRaw === 'atmo-hover' || flightModeRaw === 'ion-hover'
          ? flightModeRaw
          : isStatic ? 'station' as const : zeroG ? 'zero-g' as const : 'atmo-hover' as const;

        const fromSnapshot = snap
          ? {
              radioRangeM: snap.radioRangeM,
              radioAntennas: Math.max(1, snap.radio.length),
              lasers: snap.lasers.length,
              solarLarge: snap.solar.filter((p) => (p.maxMw ?? 0) >= 0.12).length,
              solarSmall: snap.solar.filter((p) => (p.maxMw ?? 0) < 0.12).length,
              batteryLarge: Math.round(((snap.batteryMaxMWh ?? 0) / 3) * 10) / 10,
            }
          : {};
        const design: Partial<BudgetDesign> = {
          radioRangeM: numParam('radioRangeM') ?? cap?.radioRadiusM ?? fromSnapshot.radioRangeM ?? null,
          radioAntennas: numParam('radioAntennas') ?? fromSnapshot.radioAntennas ?? 1,
          lasers: numParam('lasers') ?? cap?.laserCount ?? fromSnapshot.lasers ?? 0,
          solarLarge: numParam('solarLarge') ?? fromSnapshot.solarLarge ?? 0,
          solarSmall: numParam('solarSmall') ?? fromSnapshot.solarSmall ?? 0,
          batteryLarge: numParam('batteryLarge') ?? fromSnapshot.batteryLarge ?? 0,
          batterySmall: numParam('batterySmall') ?? 0,
          batterySmallSmall: numParam('batterySmallSmall') ?? 0,
          reactorMw: numParam('reactorMw') ?? snap?.reactorMaxMw ?? 0,
          hoverDrawMw: numParam('hoverDrawMw') ?? 0,
          housekeepingMw: numParam('housekeepingMw') ?? 0.01,
        };
        const regionRaw = url.searchParams.get('region');
        const region = regionRaw === 'polar' || regionRaw === 'equator' || regionRaw === 'valley' || regionRaw === 'zero-g'
          ? regionRaw as SlotRegion
          : null;
        const budget = powerBudget({
          gridId,
          slotAltM: altitudeM,
          lat: numParam('lat') ?? 0,
          planet,
          region,
          flightMode,
          design,
        });
        sendJson(res, 200, {
          ...budget,
          now,
          derivedFrom: snap
            ? 'live profile snapshot + provisioning read-back'
            : gridId ? 'provisioning read-back (no power sample yet)' : 'query only',
          advisory: budget.verdict === 'ok-24-7'
            ? 'slot power is fine; no design change needed'
            : `suggest a ${budget.suggestion.region} variant: ${Object.entries(budget.suggestion.blocks).map(([k, v]) => `${v}x ${k}`).join(', ')}`,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/power\/([^/]+)$/,
      handler: ({ res, params, url }) => {
        const gridId = decodeURIComponent(params[0]!);
        const poller = deps.power;
        const hoursRaw = Number(url.searchParams.get('hours') ?? 24);
        const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(24, hoursRaw)) : 24;
        if (!poller) {
          throw new DemoHttpError(503, 'power_disabled', 'power poller is not attached (demo disabled at startup)');
        }
        const snap = poller.snapshot(gridId);
        if (!snap) {
          throw new DemoHttpError(404, 'unknown_grid', `no power sample for ${gridId} yet (first poll can take 30 s)`);
        }
        const unit = deps.store.getUnit(gridId);
        const derived = powerForNode(deps, gridId, unit?.pos ?? null, clock());
        sendJson(res, 200, {
          gridId,
          name: snap.name,
          hours,
          bucketMs: 60_000,
          source: 'GAME',
          series: poller.buckets(gridId, hours, 60_000),
          telemetry: derived?.block ?? null,
          alerts: derived?.alerts ?? [],
          note: 'one sample per 30 s; buckets are 1 minute',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/autotune\/preview$/,
      handler: async ({ req, res }) => {
        const parsed = AutotuneBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid autotune request', formatIssues(parsed.error));
        const plan = previewTune(
          { store: deps.store, fixturePath: env.fixturePath, power: deps.power ?? null, clock },
          {
            gridIds: parsed.data.gridIds ?? null,
            footprints: parsed.data.footprints,
            roles: parsed.data.roles,
          },
        );
        sendJson(res, 200, {
          plan,
          pins: readPins(deps.store),
          enabled: deps.hub.isConnected(),
          note: plan.note,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/autotune\/apply$/,
      handler: async ({ req, res }) => {
        const parsed = AutotuneBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid autotune request', formatIssues(parsed.error));
        assertKillSwitchOff(deps.store);
        if (!deps.hub.isConnected()) {
          throw new DemoHttpError(503, 'plugin_offline', 'the plugin is not connected: ranges cannot be written');
        }
        const plan = previewTune(
          { store: deps.store, fixturePath: env.fixturePath, power: deps.power ?? null, clock },
          {
            gridIds: parsed.data.gridIds ?? null,
            footprints: parsed.data.footprints,
            roles: parsed.data.roles,
          },
        );
        const pins = readPins(deps.store);
        if (parsed.data.dryRun) {
          sendJson(res, 200, { dryRun: true, plan, pins, note: 'dry run: no block was written' });
          return;
        }
        const result = await applyTune({ store: deps.store, hub: deps.hub, clock }, plan, {
          gridIds: parsed.data.gridIds ?? null,
          pins,
        });
        for (const row of result.applied) {
          audit(deps, req, 'demo_autotune_apply', row.gridId, {
            name: row.name,
            fromM: row.fromM,
            toM: row.toM,
            appliedM: row.appliedM,
            before: row.before,
            after: row.after,
            drawDropMw: row.drawDropMw,
          });
        }
        sendJson(res, 200, {
          ...result,
          plan: { totals: plan.totals, changes: plan.changes },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/autotune\/pins$/,
      handler: ({ res }) => {
        sendJson(res, 200, { pins: readPins(deps.store), note: 'a pin keeps the exact range; apply never overwrites a pinned node' });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/autotune\/pins$/,
      handler: async ({ req, res }) => {
        const parsed = PinBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid pin request', formatIssues(parsed.error));
        const body = parsed.data;
        if (body.clear) {
          const removed = clearPin(deps.store, body.gridId);
          audit(deps, req, 'demo_autotune_pin_clear', body.gridId, { removed });
          sendJson(res, 200, { cleared: removed, pins: readPins(deps.store) });
          return;
        }
        const pin = writePin(deps.store, {
          gridId: body.gridId,
          radioM: body.radioM ?? null,
          laserM: body.laserM ?? null,
          footprintM: body.footprintM ?? null,
          at: clock(),
          by: actorOf(req),
          note: body.note ?? null,
        });
        audit(deps, req, 'demo_autotune_pin', body.gridId, { ...pin });
        sendJson(res, 200, { pin, pins: readPins(deps.store) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/plan\/connect$/,
      handler: async ({ req, res }) => {
        const parsed = ConnectBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid connect plan request', formatIssues(parsed.error));
        const from = findPlanetOrThrow(parsed.data.planetA);
        const to = findPlanetOrThrow(parsed.data.planetB);
        if (from.id === to.id || from.name === to.name) throw new DemoHttpError(400, 'same_planet', 'planetA and planetB must differ');
        const plan = buildConnectPlan({
          from,
          to,
          planets: loadPlanetCatalog(),
          hardware: parsed.data.hardware,
          templates: resolvePlanTemplates(parsed.data),
        });
        audit(deps, req, 'demo_connect_plan', `${from.name}->${to.name}`, {
          hardware: parsed.data.hardware,
          counts: Object.fromEntries(plan.options.map((o) => [o.id, o.count])),
        });
        sendJson(res, 200, planResponse(plan));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/missions\/connect$/,
      handler: async ({ req, res }) => {
        assertKillSwitchOff(deps.store);
        const parsed = ConnectMissionsBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid connect mission request', formatIssues(parsed.error));
        const from = findPlanetOrThrow(parsed.data.planetA);
        const to = findPlanetOrThrow(parsed.data.planetB);
        if (from.id === to.id || from.name === to.name) throw new DemoHttpError(400, 'same_planet', 'planetA and planetB must differ');
        const world = loadWorld(deps.store, env.fixturePath, clock());
        const gate = anchorForPlanet(deps, world, from.id);
        assertGate(gate);
        const plan = buildConnectPlan({
          from,
          to,
          planets: loadPlanetCatalog(),
          hardware: parsed.data.hardware,
          templates: resolvePlanTemplates(parsed.data),
        });
        const option = optionById(plan, parsed.data.optionId);
        if (!option.linksOk || !option.portsOk) {
          throw new DemoHttpError(409, 'plan_invalid', `option ${option.id} fails its own link/port check; fix the plan first`);
        }
        const { input } = chainMissionPayload(plan, parsed.data.optionId, parsed.data.note);
        // The gate step must point at the node the gate actually evaluated.
        const gateStep = (input.plan.steps as { id: string; params: Record<string, unknown> }[]).find((s) => s.id === 'gate');
        if (gateStep) gateStep.params.demoGateNode = gate.nodeId;
        const mission = createDemoMission(deps, req, input as unknown as Record<string, unknown>);
        audit(deps, req, 'demo_missions_connect', mission.id, {
          from: plan.from,
          to: plan.to,
          option: option.id,
          count: option.count,
          gate,
        });
        sendJson(res, 201, {
          mission,
          option: { id: option.id, label: option.label, count: option.count, relayCount: option.relayCount },
          approvalState: { status: mission.status, approval: mission.approval, awaitingApproval: true },
          commsGate: gate,
          execution: executionState(deps.hub, deps.store),
          labels: ['SIMULATED', 'UNVERIFIED'],
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/missions\/([^/]+)\/approve$/,
      handler: async ({ req, res, params }) => {
        assertKillSwitchOff(deps.store);
        const id = decodeURIComponent(params[0]!);
        const mission = deps.store.getMission(id);
        if (!mission) throw new DemoHttpError(404, 'not_found', `unknown mission ${id}`);
        // Debt hygiene: never start a run on top of leftover harness grids.
        // They drag SimSpeed down and make arrival numbers meaningless.
        const ready = deps.executor?.assertWorldReady(clock());
        if (ready && !ready.ok) {
          throw new DemoHttpError(
            409,
            'too_many_grids',
            `refusing to start: ${ready.liveGrids} live grids exist (max ${ready.max}); run POST /api/demo/cleanup first`,
            [`liveGrids=${ready.liveGrids}`, `max=${ready.max}`],
          );
        }
        const gateNode = mission.plan.steps.find((s) => s.id === 'gate')?.params?.demoGateNode;
        if (typeof gateNode === 'string') {
          const world = loadWorld(deps.store, env.fixturePath, clock());
          const gate = gateForNode(deps, world, gateNode);
          assertGate(gate);
        }
        const result = approveMission(deps.store, id, actorOf(req), clock());
        if (!result.ok) throw new DemoHttpError(409, result.code, result.message);
        audit(deps, req, 'demo_approve', id, { status: result.mission.status });
        // Start the executor immediately so the operator sees the first spawn
        // order without waiting for the next 1 s tick.
        deps.executor?.tick();
        sendJson(res, 200, {
          mission: result.mission,
          execution: executionState(deps.hub, deps.store),
          executor: deps.executor?.summary() ?? null,
          labels: ['SIMULATED'],
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/spawn$/,
      handler: async ({ req, res }) => {
        assertKillSwitchOff(deps.store);
        const parsed = SpawnBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid spawn request', formatIssues(parsed.error));
        const standIn = getStandIn(parsed.data.prefab);
        if (!standIn) throw new DemoHttpError(400, 'unknown_prefab', `unknown stand-in prefab ${parsed.data.prefab}`);
        const world = loadWorld(deps.store, env.fixturePath, clock());
        let position = parsed.data.pos ?? null;
        let planetName: string | null = null;
        if (!position) {
          if (!parsed.data.planet) throw new DemoHttpError(400, 'invalid', 'spawn needs planet or pos');
          const planet = findPlanetOrThrow(parsed.data.planet);
          planetName = planet.name;
          const other = loadPlanetCatalog().find((p) => p.id !== planet.id)!;
          const dx = other.center.x - planet.center.x;
          const dy = other.center.y - planet.center.y;
          const dz = other.center.z - planet.center.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          const radius = planet.maxHillRadiusM + 2_000;
          position = {
            x: planet.center.x + (dx / len) * radius,
            y: planet.center.y + (dy / len) * radius,
            z: planet.center.z + (dz / len) * radius,
          };
        }
        const gate = parsed.data.planet ? anchorForPlanet(deps, world, findPlanetOrThrow(parsed.data.planet).id) : anyControlSourceGate(deps, world);
        assertGate(gate);
        const mission = createDemoMission(deps, req, {
          type: 'build_deploy',
          priority: 50,
          desiredState: { shipSpec: idPart(standIn.role), station: `spawn:${idPart(standIn.prefab)}`, formation: 'none' },
          budget: { resources: {}, timeMin: 60, lossLimit: 0 },
          approval: 'approve',
          assignedUnits: [],
          plan: {
            steps: [
              { id: 'validate', kind: 'validate_spec', params: {}, done: false },
              { id: 'print', kind: 'print', params: { prefab: standIn.prefab, position }, done: false },
              { id: 'move', kind: 'move', params: { target: position }, done: false },
              { id: 'gate', kind: 'custom', params: { demoGateNode: gate.nodeId, action: 'spawn' }, done: false },
            ],
            notes: `[SIMULATED] spawn ${standIn.prefab} via stand-in build mission. Gate: ${gate.source}. Nothing spawns until approved and a plugin is connected.`,
          },
        });
        const ghost: DemoNode = {
          id: `planned-${mission.id}`,
          name: `planned ${standIn.prefab}`,
          prefab: standIn.prefab,
          planet: planetName,
          position,
          controlSource: false,
          origin: 'spawn',
          status: 'planned',
          note: `planned by ${mission.id}; not spawned (SIMULATED)`,
        };
        world.planned.push(ghost);
        saveWorld(deps.store, world);
        audit(deps, req, 'demo_spawn', mission.id, { prefab: standIn.prefab, position, planet: planetName, gate });
        sendJson(res, 201, {
          mission,
          plannedNode: ghost,
          commsGate: gate,
          execution: executionState(deps.hub, deps.store),
          labels: ['SIMULATED'],
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/move$/,
      handler: async ({ req, res }) => {
        assertKillSwitchOff(deps.store);
        const parsed = MoveBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid move request', formatIssues(parsed.error));
        const world = loadWorld(deps.store, env.fixturePath, clock());
        // A move target may be a fixture node OR any live plugin grid. The map
        // shows telemetry grids too, so refusing them here made every real
        // drone un-movable from the UI ("unknown demo grid").
        const now = clock();
        const live = deps.store.getUnit(parsed.data.gridId);
        const liveGrid = Boolean(live?.pos) && now - (live?.lastSeen ?? 0) <= deps.config.demo.gateFreshMs;
        if (!aliveNodes(world).some((n) => n.id === parsed.data.gridId) && !liveGrid) {
          throw new DemoHttpError(
            404,
            'unknown_grid',
            `unknown demo grid ${parsed.data.gridId} (not a fixture node and no fresh plugin telemetry)`,
          );
        }
        const gate = gateForNode(deps, world, parsed.data.gridId);
        assertGate(gate);
        const mission = createDemoMission(deps, req, {
          type: 'move',
          priority: 50,
          desiredState: {
            shipSpec: 'stand-in-grid',
            station: `move:${idPart(parsed.data.gridId)}`,
            formation: 'none',
            position: parsed.data.pos,
          },
          budget: { resources: {}, timeMin: 30, lossLimit: 0 },
          approval: 'approve',
          assignedUnits: [parsed.data.gridId],
          plan: {
            steps: [
              { id: 'validate', kind: 'validate_spec', params: {}, done: false },
              { id: 'move', kind: 'move', params: { gridId: parsed.data.gridId, target: parsed.data.pos }, done: false },
              { id: 'gate', kind: 'custom', params: { demoGateNode: gate.nodeId, action: 'move' }, done: false },
            ],
            notes: `[SIMULATED] move order for ${parsed.data.gridId}. Gate: ${gate.source}. Nothing moves until approved and a plugin is connected.`,
          },
        });
        audit(deps, req, 'demo_move', mission.id, { gridId: parsed.data.gridId, pos: parsed.data.pos, gate });
        // One grid, one mission: a new move supersedes any older active mission.
        const superseded = supersedeGridMissions(
          deps.store, parsed.data.gridId, mission.id, actorOf(req), clock(),
          `superseded by a new move (${mission.id})`,
        );
        sendJson(res, 201, {
          mission,
          superseded,
          commsGate: gate,
          execution: executionState(deps.hub, deps.store),
          labels: ['SIMULATED'],
        });
      },
    },
    {
      // SHIP ROLES (owner decision 2026-11-11). A grid's role is set in game by
      // a tag in any block name or a CustomData line; that always wins. This
      // toggle is the fallback for a grid with no in-game tag, stored server-side
      // and audited. The site shows which source set the role.
      method: 'GET',
      pattern: /^\/api\/demo\/roles$/,
      handler: async ({ res }) => {
        const known = new Map<string, { gridId: string; name: string | null }>();
        for (const row of shipRoles.known()) known.set(row.gridId, { gridId: row.gridId, name: row.name });
        for (const unit of deps.store.listUnits()) {
          if (unit.pos && !known.has(unit.id)) known.set(unit.id, { gridId: unit.id, name: unit.name });
        }
        sendJson(res, 200, {
          roles: [...known.values()].map(({ gridId, name }) => {
            const resolution = shipRoles.resolution(gridId);
            return { gridId, name, ...resolution };
          }),
          siteToggles: [...known.keys()]
            .map((gridId) => ({ gridId, toggle: shipRoles.siteToggle(gridId) }))
            .filter((row) => row.toggle !== null),
          labels: {
            'in-game-tag': 'set in game (a block tag) — the site toggle cannot override it',
            'site-toggle': 'set on the site (no in-game tag)',
            default: 'untagged: existing behaviour',
          },
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/roles$/,
      handler: async ({ req, res }) => {
        const parsed = RolesSetBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid role request', formatIssues(parsed.error));
        const outcome = shipRoles.setSiteRole(deps.store, parsed.data.gridId, parsed.data.role, actorOf(req), clock());
        if (!outcome.ok) {
          throw new DemoHttpError(409, outcome.code ?? 'role_refused', outcome.reason);
        }
        sendJson(res, 200, { gridId: parsed.data.gridId, ...outcome.resolution });
      },
    },
    {
      /**
       * T66 SURVIVAL LOOP. One read for the site (settings + every grid the
       * loop has an opinion on), then the three owner inputs: the approval
       * mode, the home base, and the two buttons (approve a return, relaunch).
       * A grid the loop does not manage is still visible; it just never moves.
       */
      method: 'GET',
      pattern: /^\/api\/demo\/survival$/,
      handler: ({ res }) => {
        if (!deps.survival) {
          sendJson(res, 200, { enabled: false, note: 'survival loop is not running in this process' });
          return;
        }
        sendJson(res, 200, { enabled: true, ...deps.survival.settingsState(), ...deps.survival.view() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/settings$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const parsed = SurvivalSettingsBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid survival settings', formatIssues(parsed.error));
        // T77: `testIgnoreReach` is the loop's own admin override. It exists only
        // to exercise the loop on the test world (BASE-01 has no antenna), so a
        // survival backend refuses it outright and audits the attempt.
        const override = decideTestIgnoreReach({
          requested: parsed.data.testIgnoreReach === true,
          survivalMode: resolveSurvivalMode(),
          demoEnv: resolveDemoEnv() !== null,
          route: '/api/demo/survival/settings',
        });
        if (!override.allow) {
          if (override.code === SURVIVAL_REASON) {
            deps.store.audit({
              actor: actorOf(req),
              action: 'survival_refused',
              subject: 'survival',
              detail: override.detail ?? {},
              at: clock(),
            });
          }
          throw new DemoHttpError(409, override.code!, override.message!);
        }
        const settings = deps.survival.writeSettings(parsed.data, actorOf(req));
        sendJson(res, 200, { settings, defaults: deps.survival.settingsState().defaults });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/home$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const parsed = SurvivalHomeBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid home request', formatIssues(parsed.error));
        const outcome = await deps.survival.setHome(
          {
            gridId: parsed.data.gridId ?? null,
            homeGridId: parsed.data.homeGridId ?? null,
            homePoint: parsed.data.homePoint ?? null,
          },
          actorOf(req),
        );
        // No silent ignore: an unknown grid, a non-BASE grid, or a point that
        // is not on landing-grade surface ground is a plain 400 with the why.
        if (!outcome.ok) throw new DemoHttpError(400, outcome.code, outcome.reason);
        sendJson(res, 200, { defaultHomeId: outcome.flags.defaultHomeId, overrides: outcome.flags.overrides });
      },
    },
    {
      /**
       * TEST-ENV-ONLY: per-grid runway override. Replaces the trigger's reading
       * for one grid so the full return/land/refuel/relaunch flight can be
       * exercised on the test world, where every ship is full. Refused with
       * 409 `survival_mode` in survival (and audited), and ignored there even
       * if a value was already persisted.
       */
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/test-runway$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const override = decideTestIgnoreReach({
          requested: true,
          survivalMode: resolveSurvivalMode(),
          demoEnv: resolveDemoEnv() !== null,
          route: '/api/demo/survival/test-runway',
        });
        if (!override.allow) {
          if (override.code === SURVIVAL_REASON) {
            deps.store.audit({
              actor: actorOf(req),
              action: 'survival_refused',
              subject: 'survival',
              detail: { ...(override.detail ?? {}), flag: 'testRunwayOverride' },
              at: clock(),
            });
          }
          throw new DemoHttpError(409, override.code!, override.message!);
        }
        const parsed = SurvivalTestRunwayBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid test runway request', formatIssues(parsed.error));
        const outcome = deps.survival.setTestRunway(parsed.data, actorOf(req));
        if (!outcome.ok) throw new DemoHttpError(409, outcome.code, outcome.reason);
        sendJson(res, 200, { gridId: parsed.data.gridId, override: outcome.override, testRunway: deps.survival.testRunwayState() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/test-runway\/clear$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const parsed = z.object({ gridId: z.string().min(1).nullable().optional() }).safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid test runway clear request', formatIssues(parsed.error));
        const remaining = deps.survival.clearTestRunway(parsed.data.gridId ?? null, actorOf(req));
        sendJson(res, 200, { testRunway: remaining });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/return$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const parsed = SurvivalReturnBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid return request', formatIssues(parsed.error));
        const outcome = deps.survival.approveReturn(parsed.data.gridId, actorOf(req));
        if (!outcome.ok) throw new DemoHttpError(409, 'return_refused', outcome.reason);
        sendJson(res, 200, { gridId: parsed.data.gridId, ...deps.survival.rowFor(parsed.data.gridId) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/survival\/relaunch$/,
      handler: async ({ req, res }) => {
        if (!deps.survival) throw new DemoHttpError(503, 'survival_unavailable', 'the survival loop is not running');
        const parsed = SurvivalRelaunchBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid relaunch request', formatIssues(parsed.error));
        const outcome = deps.survival.relaunch(parsed.data.gridId, parsed.data.confirm, actorOf(req));
        if (!outcome.ok) throw new DemoHttpError(409, 'relaunch_refused', outcome.reason);
        sendJson(res, 200, { gridId: parsed.data.gridId, missionId: outcome.missionId, ...deps.survival.rowFor(parsed.data.gridId) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/move-to$/,
      handler: async ({ req, res }) => {
        const parsed = MoveToBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid move-to request', formatIssues(parsed.error));
        assertKillSwitchOff(deps.store);
        // T75: `ignoreReach` is an admin override - it flies a ship outside the
        // network, which only the test world may ask for. In survival the route
        // refuses before the preflight and audits it.
        if (parsed.data.ignoreReach && resolveSurvivalMode()) {
          const refusal = survivalRefusal('ignoreReach admin override');
          deps.store.audit({
            actor: actorOf(req),
            action: 'survival_refused',
            subject: parsed.data.gridId,
            detail: { route: '/api/demo/move-to', flag: 'ignoreReach', reason: SURVIVAL_REASON },
            at: clock(),
          });
          throw new DemoHttpError(409, SURVIVAL_REASON, refusal.message, undefined, refusal.note);
        }
        if (parsed.data.ignoreReach && !resolveDemoEnv()) {
          throw new DemoHttpError(409, 'admin_override_not_allowed', 'admin override is only available on the test server');
        }
        const now = deps.clock?.() ?? Date.now();
        const world = loadWorld(deps.store, env.fixturePath, now);
        const unit = deps.store.getUnit(parsed.data.gridId);
        if (!unit || !unit.pos) {
          throw new DemoHttpError(404, 'unknown_grid', `unknown demo grid ${parsed.data.gridId} (no live telemetry)`);
        }
        const planets = loadPlanetCatalog();
        // One grid, one thing: a player target (or `comeToMe: true` with a GPS
        // stand-in) resolves to a HOVER POINT beside the player, not to the
        // player's feet. Everything downstream (preflight, mission, executor)
        // then treats it as an ordinary move to an airborne point.
        const playerTarget =
          typeof parsed.data.target === 'object' && parsed.data.target !== null && 'player' in parsed.data.target;
        const wantsComeToMe = parsed.data.comeToMe === true || playerTarget;
        let target: ResolvedTarget;
        let comeToMe: {
          player: string | null;
          playerName: string | null;
          standIn: { x: number; y: number; z: number } | null;
          positionAgeMs: number | null;
          online: boolean | null;
          standoff: { lateralM: number; aboveGroundM: number };
          hover: { x: number; y: number; z: number };
          hoverAglM: number;
          groundRadiusM: number;
          groundSource: string;
          distanceToPlayerM: number;
          horizontalM: number;
          shrunk: boolean;
          direction: string;
          timeoutMs: number;
        } | null = null;
        if (wantsComeToMe) {
          let anchor: { x: number; y: number; z: number };
          let playerId: string | null = null;
          let playerName: string | null = null;
          let standIn: { x: number; y: number; z: number } | null = null;
          let positionAgeMs: number | null = null;
          let online: boolean | null = null;
          let standoff: { lateralM?: number; aboveGroundM?: number } = {};
          if (playerTarget) {
            const key = (parsed.data.target as { player: string; standoff?: typeof standoff }).player;
            standoff = (parsed.data.target as { standoff?: typeof standoff }).standoff ?? {};
            if (!deps.players) {
              throw new DemoHttpError(
                503,
                'players_unavailable',
                'player positions are not available on this backend, so a player target cannot be resolved',
                undefined,
                'Send a GPS stand-in point instead: target: { gps: {x,y,z} }, comeToMe: true.',
              );
            }
            const snap = deps.players.snapshot(key, now);
            if (!snap) {
              throw new DemoHttpError(404, 'unknown_player', `no player is known by the id ${key} (identityId or steamId)`);
            }
            if (!snap.pos) {
              throw new DemoHttpError(
                409,
                'player_position_unknown',
                `${snap.displayName || snap.identityId} is known but has no reported position`,
                undefined,
                'Wait for a telemetry sample, or send a GPS stand-in point instead.',
              );
            }
            positionAgeMs = Math.max(0, now - snap.lastSeenAt);
            online = snap.online;
            if (positionAgeMs > COME_TO_ME_MAX_PLAYER_AGE_MS) {
              throw new DemoHttpError(
                409,
                'player_position_stale',
                `${snap.displayName || snap.identityId}'s last known position is ${formatDurationShort(positionAgeMs / 1000)} old ` +
                  `(limit ${formatDurationShort(COME_TO_ME_MAX_PLAYER_AGE_MS / 1000)}), so it is not where they are standing now`,
                undefined,
                'Ask them to log in, or send a GPS stand-in point: target: { gps: {x,y,z} }, comeToMe: true.',
              );
            }
            anchor = snap.pos;
            playerId = snap.identityId;
            playerName = snap.displayName || null;
          } else {
            anchor = (parsed.data.target as { gps: { x: number; y: number; z: number } }).gps;
            standIn = anchor;
          }
          const planet = nearestPlanetTo(anchor, planets);
          if (!planet) {
            throw new DemoHttpError(
              400,
              'no_planet_below',
              'there is no planet under the come-to-me point, so there is no ground to hover above',
              undefined,
              'Pick a point above a planet (the nearest planet is reported by a plain GPS move-to preflight).',
            );
          }
          const unitMeta = (unit.meta ?? {}) as Record<string, unknown>;
          const rawKeel = unitMeta.keelDepthM;
          const keel =
            typeof rawKeel === 'number' && Number.isFinite(rawKeel)
              ? rawKeel
              : typeof rawKeel === 'string' && rawKeel.trim() !== '' && Number.isFinite(Number(rawKeel))
                ? Number(rawKeel)
                : 0;
          const lateralM = standoff.lateralM ?? deps.config.demo.comeToMe.lateralM;
          const aboveGroundM = standoff.aboveGroundM ?? deps.config.demo.comeToMe.aboveGroundM;
          const computed = await computeComeToMePoint({
            playerPos: anchor,
            shipPos: unit.pos,
            planet,
            keelDepthM: keel ?? 0,
            lateralM,
            aboveGroundM,
            groundAt: groundSampler(planet),
          });
          if ('error' in computed) throw comeToMeHttpError(computed.error);
          const point = computed.point;
          target = {
            position: point.position,
            planet: point.planet,
            altitudeM: point.altitudeM,
            label: `${playerName ?? 'stand-in point'}: ${point.label}`,
            preset: null,
          };
          comeToMe = {
            player: playerId,
            playerName,
            standIn,
            positionAgeMs,
            online,
            standoff: { lateralM: point.lateralM, aboveGroundM: point.aboveGroundM },
            hover: point.position,
            hoverAglM: point.hoverAglM,
            // The datum the point was built with, so the hold guard cannot
            // re-judge the same column on a coarser sample (2026-11-11).
            groundRadiusM: point.groundRadiusM,
            groundSource: point.groundSource,
            distanceToPlayerM: point.distanceToPlayerM,
            horizontalM: point.horizontalM,
            shrunk: point.shrunk,
            direction: point.directionSource,
            timeoutMs: parsed.data.comeToMeTimeoutMs ?? deps.config.demo.comeToMe.timeoutMs,
          };
        } else {
          const resolved = resolveMoveTarget({
            target: parsed.data.target as MoveTargetSpec,
            ship: unit.pos,
            planets,
          });
          if ('error' in resolved) {
            throw new DemoHttpError(400, resolved.error.code, resolved.error.message, undefined, resolved.error.hint);
          }
          target = resolved.target;
        }
        // Landing / parking request (owner request, 2026-11-10). A landing needs
        // a planet under the target: there is no ground to land on otherwise,
        // and the refusal belongs at the API boundary, not 3 km up.
        const wantsLand = parsed.data.land === true || parsed.data.mode === 'land' || parsed.data.landing !== undefined;
        const wantsPark = parsed.data.park === true || parsed.data.mode === 'park';
        if (wantsLand && !target.planet) {
          throw new DemoHttpError(
            400,
            'no_planet_below',
            `cannot land at ${target.label}: there is no planet below the target, so there is no ground to land on`,
            undefined,
            'Pick a GPS point above a planet (the response reports the planet it resolved), or use park to hold in space.',
          );
        }
        const request: 'land' | 'park' | 'come-to-me' | null = wantsComeToMe
          ? 'come-to-me'
          : wantsLand
            ? 'land'
            : wantsPark
              ? 'park'
              : null;
        const planet = target.planet ? planets.find((p) => p.name === target.planet) ?? null : nearestPlanetTo(unit.pos, planets);
        const altitudeM = planet
          ? Math.max(
              0,
              Math.round(
                Math.hypot(unit.pos.x - planet.center.x, unit.pos.y - planet.center.y, unit.pos.z - planet.center.z) -
                  planet.surfaceRadiusM,
              ),
            )
          : null;
        const meta = unit.meta as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const fuelFraction = num(meta.fuelFraction);
        const powerFraction = num(meta.powerFraction);
        const hardware = await liveShipHardware(deps, parsed.data.gridId);
        const telemetryMass = num(meta.massKg);
        const ship: ShipState = {
          gridId: parsed.data.gridId,
          name: unit.name,
          position: unit.pos,
          altitudeM,
          massKg: telemetryMass && telemetryMass > 0 ? telemetryMass : hardware?.massKg ?? telemetryMass,
          fuelPct: fuelFraction === null ? null : Math.round(fuelFraction * 1000) / 10,
          batteryPct: powerFraction === null ? null : Math.round(powerFraction * 1000) / 10,
          thrust: hardware?.thrust ?? null,
          planet,
        };
        const reach = reachAtPoint(target.position, moveNodesFor(deps, world, now));
        const preflight = preflightMove({
          ship,
          target,
          reach,
          speedMps: deps.config.demo.speedLimitMps,
          ignoreReach: parsed.data.ignoreReach,
          survivalMode: resolveSurvivalMode(),
        });
        const gate = gateForNode(deps, world, parsed.data.gridId);
        const labels = ['SIMULATED', ...(parsed.data.ignoreReach ? ['ADMIN OVERRIDE (test server)'] : [])];
        const plain = {
          summary: preflight.ok
            ? `${ship.name} -> ${target.label}: ${preflight.linkText}; ${preflight.fuelText}; ${preflight.etaText}.`
            : `${ship.name} cannot move to ${target.label}: ${preflight.block?.message ?? 'preflight refused'}`,
          ...preflight,
        };
        const targetInfo = {
          position: target.position,
          planet: target.planet,
          altitudeM: target.altitudeM,
          label: target.label,
          preset: target.preset,
        };

        // The role gate belongs to the ORDER, not to mission creation. A dry run
        // that answers "ok" for a grid whose role refuses the order is a lie:
        // measured 2026-11-11, a PERSONAL grid without confirmPersonal returned
        // 200 on a dry run and only the real call refused.
        const roleRefusal = roleRefusalForMission(deps, req, {
          assignedUnits: [parsed.data.gridId],
          type: 'move',
          confirmPersonal: parsed.data.confirmPersonal === true,
        });
        if (roleRefusal) throw roleRefusal;

        if (parsed.data.dryRun) {
          audit(deps, req, 'demo_move_to_preflight', parsed.data.gridId, {
            target: targetInfo,
            preflight,
            ignoreReach: parsed.data.ignoreReach,
            gate,
            request,
            ...(comeToMe ? { comeToMe } : {}),
          });
          sendJson(res, 200, {
            dryRun: true,
            gridId: parsed.data.gridId,
            target: targetInfo,
            preflight: plain,
            commsGate: gate,
            adminOverride: parsed.data.ignoreReach,
            request,
            comeToMe,
            labels,
          });
          return;
        }

        if (!gate.allowed && !parsed.data.ignoreReach) {
          throw new DemoHttpError(
            403,
            'comms_denied',
            `comms gate denied ${gate.nodeId}: ${gate.reason}`,
            undefined,
            hintForCode('comms_denied'),
          );
        }
        if (!preflight.ok && !parsed.data.ignoreReach) {
          const block = preflight.block!;
          throw new DemoHttpError(409, block.code, block.message, undefined, block.hint);
        }

        const mission = createDemoMission(deps, req, {
          type: 'move',
          priority: 50,
          desiredState: {
            shipSpec: 'stand-in-grid',
            station: `move:${idPart(parsed.data.gridId)}`,
            formation: 'none',
            position: target.position,
            targetLabel: target.label,
            altitudeM: target.altitudeM,
            adminOverride: parsed.data.ignoreReach,
            // The planet under the target, so the drone row carries it: without
            // it a landing (or any move) measured its ground from a 0 m mean.
            ...(target.planet ? { planet: target.planet } : {}),
            // Ship roles: an explicit owner order for a PERSONAL ship carries
            // the confirmation into the mission, where the executor's send
            // boundary reads it.
            ...(parsed.data.confirmPersonal === true ? { personalConfirmed: true } : {}),
            ...(request === 'land' ? { land: true } : {}),
            ...(request === 'park' ? { park: true } : {}),
            ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
            ...(parsed.data.landing ? { landing: parsed.data.landing } : {}),
            // Come to me: what was asked for, the computed hover point and the
            // phase the executor writes back. `mode: 'hold'` says explicitly
            // that arrival is a hover, never a landing.
            ...(comeToMe
              ? {
                  mode: 'hold' as const,
                  comeToMe: {
                    player: comeToMe.player,
                    playerName: comeToMe.playerName,
                    ...(comeToMe.standIn ? { standIn: comeToMe.standIn } : {}),
                    standoff: comeToMe.standoff,
                    hover: comeToMe.hover,
                    hoverAglM: comeToMe.hoverAglM,
                    // THE DATUM the hover point was BUILT with. The executor's
                    // hold guard and `comeToMeArrival` judge the slot on this
                    // radius so a second, coarser sample of the same column
                    // cannot re-open a hover that was planned on level 5
                    // (2026-11-11). It was described here since the ground
                    // unification but never written, so every hover fell back
                    // to the tick's own column sample - level 0 in set 3,
                    // 61 160.7 m, 37.5 m under the level-5 read.
                    groundRadiusM: comeToMe.groundRadiusM,
                    groundLevel: levelFromGroundSource(comeToMe.groundSource),
                    groundSource: comeToMe.groundSource,
                    distanceToPlayerM: comeToMe.distanceToPlayerM,
                    phase: 'flying' as const,
                    timeoutMs: comeToMe.timeoutMs,
                  },
                }
              : {}),
          },
          budget: { resources: {}, timeMin: 60, lossLimit: 0 },
          approval: 'approve',
          assignedUnits: [parsed.data.gridId],
          plan: {
            steps: [
              {
                id: 'validate',
                kind: 'validate_spec',
                params: parsed.data.ignoreReach ? { adminOverride: true } : {},
                done: false,
              },
              { id: 'move', kind: 'move', params: { gridId: parsed.data.gridId, target: target.position }, done: false },
              { id: 'gate', kind: 'custom', params: { demoGateNode: gate.nodeId, action: 'move' }, done: false },
            ],
            notes:
              `[SIMULATED] move-to ${parsed.data.gridId} -> ${target.label}. Preflight: ${plain.summary}` +
              (request === 'land'
                ? ` [LANDING: braked descent onto the ground under the target${parsed.data.landing?.flareAglM ? `, flare ${parsed.data.landing.flareAglM} m` : ''}]`
                : request === 'park'
                  ? ' [PARK: stop at the target; land only if it is on the ground]'
                  : request === 'come-to-me'
                    ? ` [COME TO ME: hover ${Math.round(comeToMe!.standoff.lateralM)} m to the side at ${Math.round(
                        comeToMe!.hoverAglM,
                      )} m hull-bottom AGL, ${Math.round(comeToMe!.distanceToPlayerM)} m from ${
                        comeToMe!.playerName ?? 'the stand-in point'
                      }; waits for a pilot, never lands]`
                    : '') +
              (parsed.data.ignoreReach ? ' [ADMIN OVERRIDE (test server): reachability check bypassed]' : ''),
          },
        });
        audit(deps, req, 'demo_move_to', mission.id, {
          gridId: parsed.data.gridId,
          target: targetInfo,
          preflight,
          gate,
          ignoreReach: parsed.data.ignoreReach,
          request,
          ...(parsed.data.landing ? { landing: parsed.data.landing } : {}),
          ...(comeToMe ? { comeToMe } : {}),
        });
        // One grid, one mission: a new move-to supersedes older active missions.
        const superseded = supersedeGridMissions(
          deps.store, parsed.data.gridId, mission.id, actorOf(req), clock(),
          `superseded by a new move-to (${mission.id})`,
        );
        // A move-to from the site is a direct owner command: approve it so the
        // executor picks it up (missions start 'queued' and would otherwise sit
        // there forever). Failures are surfaced, never swallowed.
        let approved = mission;
        let autoApproved = false;
        try {
          const res2 = approveMission(deps.store, mission.id, 'demo-site', clock());
          if (res2 && (res2 as { mission?: unknown }).mission) approved = (res2 as { mission: typeof mission }).mission;
          autoApproved = approved.status === 'approved';
        } catch (err) {
          audit(deps, req, 'demo_move_to_approve_failed', mission.id, { error: String(err) });
        }
        deps.executor?.tick();
        sendJson(res, 201, {
          mission: approved,
          gridId: parsed.data.gridId,
          target: targetInfo,
          preflight: plain,
          commsGate: gate,
          adminOverride: parsed.data.ignoreReach,
          request,
          comeToMe,
          superseded,
          // THIS ROUTE ALREADY APPROVED THE MISSION. A client that follows up
          // with PATCH /api/missions/<id> {status:'approved'} gets a 409 ("not
          // queued"), which is what happened in the field. Say it in the body.
          approved: autoApproved,
          autoApproved,
          approval: autoApproved ? 'auto' : 'queued',
          approvalNote: autoApproved
            ? 'this route approved the mission for you (execution is already queued); do NOT send PATCH /api/missions/<id> {status:"approved"} — it would 409'
            : 'the mission is queued but was NOT auto-approved; approve it explicitly to fly it',
          execution: executionState(deps.hub, deps.store),
          labels,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/expand$/,
      handler: async ({ req, res }) => {
        const parsed = ExpandBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid expand request', formatIssues(parsed.error));
        const world = loadWorld(deps.store, env.fixturePath, clock());
        const from = aliveNodes(world).find((n) => n.id === parsed.data.fromNodeId);
        if (!from) throw new DemoHttpError(404, 'unknown_node', `unknown node ${parsed.data.fromNodeId}`);
        const source = aliveNodes(world).find((n) => n.controlSource) ?? from;
        let dx = from.position.x - source.position.x;
        let dy = from.position.y - source.position.y;
        let dz = from.position.z - source.position.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1) {
          dx = 0;
          dy = 0;
          dz = 1;
        } else {
          dx /= len;
          dy /= len;
          dz /= len;
        }
        const spacing = 45_000;
        const proposals = Array.from({ length: parsed.data.count }, (_, i) => {
          const step = spacing * (i + 1);
          return {
            id: `expand-${from.id}-${i + 1}`,
            position: { x: from.position.x + dx * step, y: from.position.y + dy * step, z: from.position.z + dz * step },
            kind: 'relay' as const,
            planet: null,
            prefab: 'Eradicator_mk.1',
            radioRadiusM: 50_000,
          };
        });
        const extra: DemoNode[] = proposals.map((p) => ({
          id: p.id,
          name: `proposed relay ${p.id}`,
          prefab: 'Eradicator_mk.1',
          planet: null,
          position: p.position,
          controlSource: false,
          origin: 'fixture',
          status: 'alive',
          note: 'expand proposal (SIMULATED)',
        }));
        const before = demoGraph(world);
        const after = buildGraph(
          [...aliveNodes(world).map(toNetworkNode), ...extra.map(toNetworkNode)] as NetworkNode[],
          loadPlanetCatalog(),
        );
        const beforeReach = before.nodes.filter((n) => n.reachable).length;
        const afterReach = after.graph.nodes.filter((n) => n.reachable).length;
        audit(deps, req, 'demo_expand_proposal', parsed.data.fromNodeId, { count: proposals.length, beforeReach, afterReach });
        sendJson(res, 200, {
          fromNodeId: from.id,
          direction: { x: dx, y: dy, z: dz },
          proposals,
          links: proposals.map((p, i) => ({
            from: i === 0 ? from.id : proposals[i - 1]!.id,
            to: p.id,
            kind: 'radio',
            distanceM: spacing,
          })),
          beforeReachable: beforeReach,
          afterReachable: afterReach,
          wouldExtendReach: afterReach > beforeReach,
          assumptions: [
            { id: 'geometry', text: 'proposal extends the existing vector away from the control source; planner math only', status: 'SIMULATED' },
            { id: 'radio_range', text: '45,000 m spacing is 0.9 x the Eradicator 50 km radio; unverified in game', status: 'UNVERIFIED' },
          ],
          labels: ['SIMULATED', 'UNVERIFIED'],
          note: 'proposal only: no mission was created',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/what-if$/,
      handler: async ({ req, res }) => {
        const parsed = WhatIfBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'invalid what-if request', formatIssues(parsed.error));
        const world = loadWorld(deps.store, env.fixturePath, clock());
        if (!aliveNodes(world).some((n) => n.id === parsed.data.nodeId)) {
          throw new DemoHttpError(404, 'unknown_node', `unknown node ${parsed.data.nodeId}`);
        }
        const network = aliveNodes(world).map(toNetworkNode);
        const result = whatIfRemove(parsed.data.nodeId, network, loadPlanetCatalog());
        audit(deps, req, 'demo_what_if', parsed.data.nodeId, { newlyIsolated: result.newlyIsolated });
        sendJson(res, 200, {
          ...result,
          nodeStillListed: false,
          labels: ['SIMULATED'],
          note: 'planner node-removal simulation, not a game command',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/kill$/,
      handler: async ({ req, res }) => {
        const parsed = KillBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'body must be {on: boolean}', formatIssues(parsed.error));
        const actor = actorOf(req);
        const previous = deps.store.setKillSwitch(parsed.data.on, actor);
        deps.stateHub.broadcast({ type: 'kill_switch', at: clock(), on: parsed.data.on, previous });
        audit(deps, req, 'demo_kill_switch', 'global', { on: parsed.data.on, previous });
        sendJson(res, 200, {
          killSwitch: parsed.data.on,
          previous,
          note: parsed.data.on
            ? 'kill switch ON: mission creation and approvals are blocked; nothing executes'
            : 'kill switch OFF: missions can be queued for approval again',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/cleanup$/,
      handler: async ({ req, res }) => {
        const body = (await readJson(req)) as { olderThanMin?: unknown; dryRun?: unknown; missionId?: unknown };
        const olderThanMin = Number(body.olderThanMin ?? 0);
        if (!Number.isFinite(olderThanMin) || olderThanMin < 0) {
          throw new DemoHttpError(400, 'invalid', 'olderThanMin must be a number >= 0');
        }
        if (!deps.executor) throw new DemoHttpError(409, 'executor_off', 'executor not attached (demo disabled at startup)');
        const result = deps.executor.cleanupStale(
          olderThanMin,
          clock(),
          body.dryRun === true,
          typeof body.missionId === 'string' ? body.missionId : undefined,
        );
        audit(deps, req, 'demo_cleanup_stale', 'all', {
          olderThanMin,
          dryRun: result.dryRun,
          considered: result.considered,
          deleted: result.deleted.length,
          failed: result.failed.length,
          liveGrids: result.liveGrids,
        });
        sendJson(res, 200, {
          ...result,
          note: result.dryRun
            ? `dry run: ${result.considered} harness grid(s) older than ${olderThanMin} min would be deleted; ${result.liveGrids} live grids now`
            : `${result.deleted.length} harness grid(s) deleted, ${result.failed.length} failed; ${result.liveGrids} live grids now`,
          labels: ['SIMULATED'],
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/reset$/,
      handler: async ({ req, res }) => {
        assertKillSwitchOff(deps.store);
        const parsed = ResetBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'reset needs {snapshot, confirm}', formatIssues(parsed.error));
        if (parsed.data.confirm !== 'RESET') {
          throw new DemoHttpError(400, 'confirm_required', 'typed confirmation must be exactly "RESET"');
        }
        const mission = createDemoMission(deps, req, {
          type: 'logistics',
          priority: 90,
          desiredState: { shipSpec: 'world-reset', station: `snapshot:${idPart(parsed.data.snapshot)}`, formation: 'none' },
          budget: { resources: {}, timeMin: 60, lossLimit: 0 },
          approval: 'approve',
          assignedUnits: [],
          plan: {
            steps: [
              { id: 'validate', kind: 'validate_spec', params: {}, done: false },
              { id: 'reset', kind: 'custom', params: { action: 'reset_world', snapshot: parsed.data.snapshot }, done: false },
            ],
            notes:
              `[SIMULATED] world reset REQUEST only. Snapshot "${parsed.data.snapshot}" is not restored by the backend. ` +
              `A plugin on the test server must execute the restore; nothing happens offline.`,
          },
        });
        audit(deps, req, 'demo_reset_requested', mission.id, { snapshot: parsed.data.snapshot, missionOnly: true });
        sendJson(res, 201, {
          mission,
          snapshot: parsed.data.snapshot,
          missionOnly: true,
          execution: executionState(deps.hub, deps.store),
          labels: ['SIMULATED'],
          note: 'mission only: the backend does not restore snapshots itself',
        });
      },
    },
  ];
  return routes;
}

export { buildConnectPlan, optionById };
