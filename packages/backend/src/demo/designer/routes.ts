import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatIssues, type Mission } from '@se-rts/schemas';
import { DemoHttpError } from '../routes.js';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { PluginHub, StateHub } from '../../pluginHub.js';
import { createMission, supersedeGridMissions } from '../../missions.js';
import { loadPlanetCatalog } from '../../planner/index.js';
import { add, normalize, scale, sub, v3, type V3 } from '../../planner/geometry.js';
import { resolveDemoEnv } from '../env.js';
import { SURVIVAL_MESSAGE, SURVIVAL_REASON, isAdminAction, resolveSurvivalMode } from '../survival.js';
import { decideOrderChannel } from '../channel.js';
import { waitForOrderResult } from '../../orderResults.js';
import { shipRoles } from '../roles.js';
import type { DemoExecutor } from '../executor.js';
import { prefabHulls, taggedHull, findHull, type DesignerHull, type TaggedGridProfile } from './hulls.js';
import { buildDesignerPlan, type DesignerPlan } from './plan.js';
import { hullForDesigner, preflightLaunch } from '../endurance/index.js';
import { readDesignerSettings, writeDesignerSettings, validateSettings } from './settings.js';
import { assignGridsToSlots, preflightGridLaunch, OWNER_IDENTITY_ID } from './assignment.js';
import { loadPowerBudget } from './powerBridge.js';
import { classifyHulls } from './classification.js';
import { gravityFreeAltitudeM, planetGravity } from './gravity.js';
import { atmosphereTopAltitudeM } from '../endurance/model.js';
import { planRadioChain, planLayered } from '../../planner/relay.js';
import { loadTerrainField } from '../terrain.js';
import { loadWorld } from '../world.js';
import { capabilitiesFromStore } from '../network.js';
import { evaluateGate, prefabForGrid } from '../gate.js';
import {
  loadOptimiseFleet,
  solveOptimise,
  type OptimiseBase,
  type OptimiseTargetInput,
} from './optimise.js';
import {
  coverageGridFromNodes,
  planPlanetCoverage,
  type CoverageTierId,
  type CoverageTierSpec,
} from '../../planner/planetCoverage.js';

export class DesignerHttpError extends DemoHttpError {
  constructor(status: number, code: string, message: string, issues?: string[], hint?: string) {
    super(status, code, message, issues, hint);
    this.name = 'DesignerHttpError';
  }
}

export interface DesignerDeps {
  config: Config;
  store: Store;
  hub: PluginHub;
  stateHub: StateHub;
  clock?: () => number;
  executor?: DemoExecutor;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  url: URL;
}

export interface DesignerRoute {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<void> | void;
}

const MAX_BODY_BYTES = 256 * 1024;
const LAST_PLAN_KEY = 'designer:lastPlan';

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
    if (size > MAX_BODY_BYTES) throw new DesignerHttpError(413, 'payload_too_large', 'request body exceeds 256 KiB');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DesignerHttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

function actorOf(req: http.IncomingMessage): string {
  const raw = req.headers['x-actor'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 128);
  return 'designer';
}

const PlanBody = z.object({
  mode: z.enum(['constellation', 'connect', 'radio-chain', 'layered', 'cover-planet']),
  planet: z.string().min(1).optional(),
  a: z.object({ planet: z.string().min(1).optional(), gps: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }).optional(),
  b: z.object({ planet: z.string().min(1).optional(), gps: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }).optional(),
  /** Base station for the relay modes; default BASE-01 at 1.8 km AGL. */
  base: z
    .object({
      planet: z.string().min(1).optional(),
      gps: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      altitudeM: z.number().min(100).max(100_000).optional(),
    })
    .optional(),
  pattern: z.enum(['ring', 'inclined-rings', 'shell', 'chain', 'auto']).default('auto'),
  altitudeM: z.number().min(0).max(500_000).optional(),
  count: z.number().int().min(2).max(2_000).optional(),
  spacingM: z.number().positive().max(2_000_000).optional(),
  hullId: z.string().min(1),
  /** T22: restrict the assignment pool (default: every available hull). */
  hullIds: z.array(z.string().min(1)).max(40).optional(),
  rangeMargin: z.number().min(0.5).max(1).default(0.9),
  redundancy: z.union([z.literal(1), z.literal(2), z.literal('no-spof')]).default(1),
  /** T16 radio-chain. */
  maxHopM: z.number().min(1_000).max(500_000).optional(),
  keepFirstHopOnBase: z.boolean().optional(),
  reachM: z.number().min(0).max(2_000_000).optional(),
  bearingDeg: z.number().min(-360).max(360).optional(),
  /** T17 layered counts/altitudes. */
  atmoCount: z.number().int().min(1).max(60).optional(),
  h2Count: z.number().int().min(1).max(60).optional(),
  zeroGCount: z.number().int().min(1).max(120).optional(),
  atmoAltitudeM: z.number().min(100).max(20_000).optional(),
  h2AltitudeM: z.number().min(1_000).max(60_000).optional(),
  /** T28 cover-planet. */
  k: z.union([z.literal(1), z.literal(2)]).optional(),
  cellDeg: z.number().min(2).max(30).optional(),
  roverFallback: z.boolean().optional(),
  /** T52: altitude policy for cover slots (default 'cheapest'). */
  altitudeMode: z.enum(['manual', 'max-reach', 'cheapest']).optional(),
  /** T52: CHEAPEST cost weights (documented defaults apply when omitted). */
  costWeights: z
    .object({
      ship: z.number().min(0).max(1_000).optional(),
      h2PerL: z.number().min(0).max(1_000).optional(),
      batteryPerMWh: z.number().min(0).max(1_000).optional(),
      mw: z.number().min(0).max(1_000).optional(),
      holdHours: z.number().min(0).max(1_000).optional(),
    })
    .optional(),
  /** T53: coverage target (default whole planet). */
  target: z.enum(['whole', 'hemisphere', 'radius']).optional(),
  targetRadiusM: z.number().min(1_000).max(2_000_000).optional(),
  facing: z.string().min(1).optional(),
  /** T49: 'none' skips terrain correction (default 'auto'). */
  terrain: z.enum(['auto', 'none']).optional(),
  /** Assignment: hard cap on new prefab builds. */
  maxNewBuilds: z.number().int().min(0).max(500).optional(),
});

const ExecuteBody = z.object({
  optionId: z.string().min(1),
  launch: z.enum(['surface', 'orbital']),
  nearGps: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  maxActive: z.number().int().min(1).max(10).optional(),
  /** T10: launch these existing owner-tagged grids in place instead of cloning. */
  useGridIds: z.array(z.string().min(1)).max(20).optional(),
  /** T10: clone the planned hull into slots the owner did not fill. */
  fillWithClones: z.boolean().default(false),
  /** T10: compute the assignment + preflight and return it without a mission. */
  dryRun: z.boolean().default(false),
  /** Test-server admin override: bypass the reachability half of the gate. */
  ignoreReach: z.boolean().default(false),
});

const GpsBody = z.object({ missionId: z.string().min(1) });

const LatLon = z.union([
  z.object({ gps: z.object({ x: z.number(), y: z.number(), z: z.number() }) }),
  z.object({ latDeg: z.number().min(-90).max(90), lonDeg: z.number().min(-180).max(180) }),
]);

const OptimiseBody = z.object({
  planet: z.string().min(1).optional(),
  planetId: z.string().min(1).optional(),
  /** 'whole' (default), 'hemisphere' (facing `facing`, default the base), or a ground radius. */
  target: z
    .union([
      z.literal('whole'),
      z.literal('hemisphere'),
      z.object({ hemisphereFrom: z.union([z.string().min(1), LatLon]) }),
      z.object({ radiusM: z.number().positive().max(2_000_000), center: LatLon }),
    ])
    .default('whole'),
  /** Grid id or name the hemisphere faces (default: the base). */
  facing: z.string().min(1).optional(),
  k: z.union([z.literal(1), z.literal(2)]).default(1),
  cellDeg: z.number().min(1).max(30).default(5),
  rangeMarginPct: z.number().min(0).max(50).default(10),
  /** Hard cap on moved ships; omitted = every movable ship. */
  maxMoves: z.number().int().min(0).max(200).optional(),
  /** Informational only: the owner's SimSpeed budget for the operation. */
  maxSimSpeedBudget: z.number().positive().max(100).optional(),
  includeGridIds: z.array(z.string().min(1)).max(200).optional(),
  baseGridId: z.string().min(1).optional(),
  /** Reserve the endurance model must leave at the destination (default 15 %). */
  minReservePct: z.number().min(0).max(90).optional(),
  maxHoles: z.number().int().min(1).max(200).optional(),
  dryRun: z.boolean().default(true),
  terrain: z.enum(['auto', 'none']).optional(),
  /** T52: manual keeps each ship's altitude (default); the other modes move it. */
  altitudeMode: z.enum(['manual', 'max-reach', 'cheapest']).default('manual'),
  costWeights: z
    .object({
      ship: z.number().min(0).max(1_000).optional(),
      h2PerL: z.number().min(0).max(1_000).optional(),
      batteryPerMWh: z.number().min(0).max(1_000).optional(),
      mw: z.number().min(0).max(1_000).optional(),
      holdHours: z.number().min(0).max(1_000).optional(),
    })
    .optional(),
});

interface PluginTestResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function nowOf(deps: DesignerDeps): number {
  return deps.clock?.() ?? Date.now();
}

/**
 * Send one plugin action order and wait for its `order_result` audit entry.
 * Legitimate actions ride the production channel (`action`); admin/test-only
 * names keep `test` and are refused in survival mode (T75). The plugin executes
 * on the game thread, so this is bounded (the default tick drains 8 orders per
 * second) and every call is audited.
 */
async function callPlugin(deps: DesignerDeps, action: string, params: Record<string, unknown>, timeoutMs = 8_000): Promise<PluginTestResult> {
  if (!deps.hub.isConnected()) {
    throw new DesignerHttpError(503, 'plugin_offline', 'the test-server plugin is not connected');
  }
  const now = nowOf(deps);
  const orderId = `designer:${action}:${randomUUID()}`;
  // T75: legitimate actions use the production channel in both modes; an
  // admin/test-only action in survival mode is refused before the wire.
  const decision = decideOrderChannel('test', action, resolveSurvivalMode());
  if (decision.refused) {
    deps.store.audit({
      actor: 'designer',
      action: 'survival_refused',
      subject: orderId,
      detail: { action, orderType: 'test', reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
      at: now,
    });
    throw new DesignerHttpError(409, SURVIVAL_REASON, `${SURVIVAL_MESSAGE}: ${action}`);
  }
  const payload = {
    schemaVersion: 1 as const,
    type: 'order' as const,
    orderId,
    orderType: decision.orderType,
    entityId: 'grid:0',
    params: { action, entityId: 'grid:0', ...params },
    tick: 0,
    issuedAt: now,
    expiresAt: now + timeoutMs,
  };
  deps.store.audit({
    actor: 'designer',
    action: 'designer_plugin_order',
    subject: orderId,
    detail: { action, params },
    at: now,
  });
  // The result is no longer an audit row for a non-control order (routine
  // traffic is counted, not written), so read it from the order-result bus:
  // event-first, resolved on the tick the frame arrives.
  const sinceRowid = deps.store.maxAuditRowid();
  if (!deps.hub.send(payload)) {
    throw new DesignerHttpError(503, 'plugin_send_failed', 'the plugin socket refused the order');
  }
  const hit = await waitForOrderResult(deps.store, orderId, timeoutMs, { sinceRowid });
  if (hit) return hit;
  throw new DesignerHttpError(504, 'plugin_timeout', `plugin did not return a result for ${action} within ${timeoutMs} ms`);
}

interface LiveGridInfo {
  gridId: string;
  profile: TaggedGridProfile;
  hull: DesignerHull;
  position: { x: number; y: number; z: number } | null;
  owned: boolean;
  live: { h2Pct: number | null; batteryPct: number | null; massKg: number | null } | null;
}

/** Naming-service names keyed by grid id (T9 registry, read-only). */
function namingNames(store: Store): Map<string, string> {
  const out = new Map<string, string>();
  const raw = store.getKv('naming:registry');
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as { grids?: { gridId?: unknown; name?: unknown }[] };
    for (const g of parsed.grids ?? []) {
      if (typeof g.gridId === 'string' && typeof g.name === 'string') out.set(g.gridId, g.name);
    }
  } catch {
    /* a corrupt registry must not break the designer */
  }
  return out;
}

function liveOf(store: Store, gridId: string): LiveGridInfo['live'] {
  const unit = store.getUnit(gridId);
  const meta = (unit?.meta ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fuel = num(meta.fuelFraction);
  const power = num(meta.powerFraction);
  const mass = num(meta.massKg);
  if (fuel === null && power === null && mass === null) return null;
  return {
    h2Pct: fuel === null ? null : Math.round(fuel * 1000) / 10,
    batteryPct: power === null ? null : Math.round(power * 1000) / 10,
    massKg: mass,
  };
}

/**
 * The hull list is the ONE caller that needs the expensive profile scalars
 * (thrust, TWR, gravity) from `list_tagged`; since sim-speed audit #1 the
 * plugin returns the cheap scan unless this flag is present.
 */
export const HULL_LIST_OPTS = { tag: '[HERMES-TEST]', withProfile: true } as const;

/**
 * Live owner-tagged grids: profile from `list_tagged`, mass/fuel/charge from
 * telemetry, display name from the naming registry. Ownership is checked
 * against the owner identity, because launching somebody else's grid is not a
 * feature.
 */
async function loadOwnerTagged(deps: DesignerDeps): Promise<{ grids: LiveGridInfo[]; reason: string | null }> {
  if (!deps.hub.isConnected()) {
    return { grids: [], reason: 'plugin not connected: owner-tagged grids cannot be profiled live' };
  }
  const res = await callPlugin(deps, 'list_tagged', { ...HULL_LIST_OPTS }, 8_000);
  const profiles = (res.result?.grids as TaggedGridProfile[] | undefined) ?? [];
  const names = namingNames(deps.store);
  // SHIP ROLE: the designer only offers MANAGED grids. A PERSONAL ship is never
  // a slot candidate and an OFF grid is not flown at all.
  const managed = profiles.filter((profile) => shipRoles.roleOf(profile.gridId) === 'managed');
  const grids = managed.map((profile): LiveGridInfo => {
    const live = liveOf(deps.store, profile.gridId);
    const owners = [profile.owner, ...(profile.owners ?? [])].filter((v): v is string => typeof v === 'string');
    return {
      gridId: profile.gridId,
      profile,
      hull: taggedHull(profile, { displayName: names.get(profile.gridId) ?? null, live }),
      position: profile.position ?? null,
      owned: owners.includes(OWNER_IDENTITY_ID),
      live,
    };
  });
  return { grids, reason: grids.length ? null : 'no grid in the test world has a programmable block named [HERMES-TEST]' };
}

async function ownerTaggedHulls(deps: DesignerDeps): Promise<{ hulls: DesignerHull[]; available: boolean; reason: string | null }> {
  try {
    const { grids, reason } = await loadOwnerTagged(deps);
    return { hulls: grids.filter((g) => g.owned).map((g) => g.hull), available: deps.hub.isConnected(), reason };
  } catch (err) {
    return { hulls: [], available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function allHulls(deps: DesignerDeps): Promise<{ hulls: DesignerHull[]; ownerTagged: { available: boolean; reason: string | null } }> {
  const prefab = prefabHulls();
  const tagged = await ownerTaggedHulls(deps);
  return {
    hulls: [...tagged.hulls, ...prefab],
    ownerTagged: { available: tagged.available, reason: tagged.reason },
  };
}

function storePlan(store: Store, plan: DesignerPlan): void {
  store.setKv(LAST_PLAN_KEY, JSON.stringify(plan));
}

function loadPlan(store: Store): DesignerPlan | null {
  const raw = store.getKv(LAST_PLAN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DesignerPlan;
  } catch {
    return null;
  }
}

function short(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(-6);
}

/** Farthest slot from the first slot: the worst-case transit leg. */
function transitDistanceM(option: DesignerPlan['options'][number]): number {
  if (option.positions.length < 2) return 0;
  const first = option.positions[0]!;
  let max = 0;
  for (const p of option.positions.slice(1)) {
    max = Math.max(max, Math.hypot(p.x - first.x, p.y - first.y, p.z - first.z));
  }
  return max;
}

/**
 * Executor preflight: refuse a launch that cannot reach its slot with the
 * configured reserve. Returns the evaluated numbers so the refusal is
 * auditable, not a bare boolean.
 */
function launchGateFor(
  plan: DesignerPlan,
  option: DesignerPlan['options'][number],
  launch: 'surface' | 'orbital',
  requiredReservePct: number,
): { ok: boolean; reason: string | null; reservePct: number | null; requiredReservePct: number; altitudeM: number | null } {
  const adapted = hullForDesigner(plan.hull);
  const planetName = plan.planets.a ?? plan.planets.b;
  const planet = planetName ? loadPlanetCatalog().find((p) => p.name === planetName || p.id === planetName) ?? null : null;
  if (option.endurance?.enforced === false) {
    return { ok: true, reason: null, reservePct: null, requiredReservePct, altitudeM: null };
  }
  if (!adapted.hull || !planet || option.positions.length === 0) {
    return { ok: true, reason: null, reservePct: null, requiredReservePct, altitudeM: null };
  }
  const first = option.positions[0]!;
  const altitudeM = Math.max(
    0,
    Math.round(Math.hypot(first.x - planet.center.x, first.y - planet.center.y, first.z - planet.center.z) - planet.surfaceRadiusM),
  );
  const gate = preflightLaunch({
    hull: adapted.hull,
    planet,
    altitudeM,
    transitDistanceM: transitDistanceM(option),
    launch,
    requiredReservePct,
  });
  return {
    ok: gate.ok,
    reason: gate.reason,
    reservePct: gate.reservePct,
    requiredReservePct,
    altitudeM,
  };
}

function designerMission(
  deps: DesignerDeps,
  req: http.IncomingMessage,
  plan: DesignerPlan,
  option: DesignerPlan['options'][number],
  launch: 'surface' | 'orbital',
  maxActive: number,
  nearGps?: { x: number; y: number; z: number },
  slotSpecs?: { position: { x: number; y: number; z: number }; useGridId?: string; gridName?: string }[],
  adminOverride = false,
): Mission {
  const planetKind = plan.mode === 'connect' ? 'connect' : 'constellation';
  // Mission schema only accepts ring/line/wedge/grid/none; map the designer
  // patterns onto those without changing the planner vocabulary.
  const formation =
    option.pattern === 'ring' || option.pattern === 'inclined-rings'
      ? 'ring'
      : option.pattern === 'shell' || option.pattern === 'cover-planet'
        ? 'grid'
        : option.pattern === 'auto'
          ? 'none'
          : 'line';
  const specs: { position: { x: number; y: number; z: number }; useGridId?: string; gridName?: string }[] =
    slotSpecs ?? option.positions.map((p) => ({ position: { x: p.x, y: p.y, z: p.z } }));
  const steps = [
    { id: 'validate', kind: 'validate_spec', params: adminOverride ? { adminOverride: true } : {}, done: false },
    ...specs.map((spec, i) => ({
      id: `slot-${i + 1}`,
      kind: 'print',
      params: {
        prefab: plan.hull.name,
        hullId: plan.hull.id,
        position: spec.position,
        role: 'slot',
        pattern: option.pattern,
        launch,
        ...(spec.useGridId ? { useGridId: spec.useGridId, gridName: spec.gridName ?? null, inPlace: true } : {}),
      },
      done: false,
    })),
  ];
  const inPlace = specs.some((s) => Boolean(s.useGridId));
  const input = {
    type: 'build_deploy',
    priority: 70,
    desiredState: {
      shipSpec: `designer-${planetKind}`,
      station: `designer:${planetKind}:${option.pattern}:${plan.hull.id}`,
      formation,
      qty: specs.length,
      position: option.positions[0],
      planet: plan.input.mode === 'connect' ? plan.input.a?.planet : plan.input.planet ?? plan.input.base?.planet,
      launch,
      designer: true,
      inPlace,
      adminOverride,
      optionId: option.id,
      planId: plan.id,
      maxActive,
      nearGps: nearGps ?? null,
      summary: option.summary,
    },
    budget: { resources: {}, timeMin: 240, lossLimit: 0, maxUnits: specs.length },
    approval: 'approve',
    assignedUnits: [],
    plan: {
      steps,
      notes:
        `[SIMULATED] T6 designer ${planetKind} plan ${plan.id} option ${option.id}: ${option.summary} ` +
        (inPlace
          ? 'Owner-tagged drones launch in place (release -> move -> hold); no spawn, no ownership transfer. '
          : 'Approved missions spawn, secure, move and hold; every flight order still passes the comms gate.') +
        (adminOverride ? ' [ADMIN OVERRIDE (test server): reachability check bypassed]' : ''),
    },
    idempotencyKey: `designer:${plan.id}:${option.id}:${launch}${inPlace ? ':inplace:' + specs.filter((s) => s.useGridId).map((s) => s.useGridId).join(',') : ''}${adminOverride ? ':override' : ''}`,
  };
  const result = createMission(deps.store, input as unknown as Record<string, unknown>, {
    now: nowOf(deps),
    actor: actorOf(req),
    autoMissionTypes: deps.config.autoMissionTypes,
    maxQueuedBuilds: deps.config.caps.maxQueuedBuilds,
  });
  if (!result.ok) {
    throw new DesignerHttpError(result.code === 'cap_reached' ? 409 : 400, result.code, result.message, result.issues);
  }
  if (result.created) deps.stateHub.broadcast({ type: 'mission', at: nowOf(deps), event: 'created', mission: result.mission });
  return result.mission;
}

function droneRows(store: Store, missionId: string): Record<string, unknown>[] {
  return store.db.prepare(`SELECT * FROM demo_drones WHERE mission_id = ? ORDER BY idx`).all(missionId) as Record<string, unknown>[];
}

export function designerRoutesFor(deps: DesignerDeps): DesignerRoute[] {
  if (!resolveDemoEnv()) return [];
  const clock = () => nowOf(deps);

  return [
    {
      method: 'GET',
      pattern: /^\/api\/demo\/designer\/hulls$/,
      handler: async ({ res }) => {
        const { hulls, ownerTagged } = await allHulls(deps);
        sendJson(res, 200, {
          hulls,
          ownerTagged,
          labels: ['SIMULATED', 'RADIO-UNVERIFIED'],
          note: 'owner-tagged hulls are profiled live via the plugin; prefab values are measured profiles',
        });
      },
    },
    {
      // T28 heatmap data: lat/long cells with the number of sky nodes that see
      // them. `mode` picks the geometry (cover-planet tiers, layered tiers or a
      // radio-chain footprint). Read-only, no mission, no orders.
      method: 'GET',
      pattern: /^\/api\/demo\/designer\/coverage$/,
      handler: async ({ res, url }) => {
        const planetName = url.searchParams.get('planet') ?? 'EarthLike';
        const planet = loadPlanetCatalog().find((p) => p.name === planetName || p.id === planetName);
        if (!planet) throw new DesignerHttpError(404, 'unknown_planet', `unknown planet ${planetName}`);
        const mode = url.searchParams.get('mode') ?? 'cover-planet';
        if (!['cover-planet', 'layered', 'radio-chain'].includes(mode)) {
          throw new DesignerHttpError(400, 'invalid_mode', `mode must be cover-planet, layered or radio-chain`);
        }
        const k = url.searchParams.get('k') === '2' ? (2 as const) : (1 as const);
        const cellDeg = Math.max(2, Math.min(30, Number(url.searchParams.get('cellDeg') ?? 10) || 10));
        const margin = Math.max(0.5, Math.min(1, Number(url.searchParams.get('rangeMargin') ?? 0.9) || 0.9));
        const { hulls } = await allHulls(deps);
        if (!hulls.length) throw new DesignerHttpError(409, 'no_hulls', 'no hull profiles are available');
        const caps = classifyHulls(hulls);
        const bestRadio = (predicate: (cap: (typeof caps)[number]) => boolean): number => {
          const values = caps.filter(predicate).map((cap) => cap.radioRangeM ?? 0).filter((value) => value > 0);
          return values.length ? Math.max(...values) : 0;
        };
        const anyRadio = bestRadio(() => true);
        if (!(anyRadio > 0)) throw new DesignerHttpError(409, 'no_radio_hulls', 'no available hull has a radio antenna');
        const requestedHull = url.searchParams.get('hullId');
        const hull = (requestedHull ? hulls.find((h) => h.id === requestedHull) : undefined) ??
          hulls.find((h) => (h.radioRangeM ?? 0) > 0) ??
          hulls[0]!;
        const zeroG = Math.ceil(gravityFreeAltitudeM(planetGravity(planet)));
        const atmoCeiling = Math.min(10_000, Math.round(atmosphereTopAltitudeM(planet)));
        const baseAltitudeM = Math.max(100, Number(url.searchParams.get('baseAltitudeM') ?? 1_800) || 1_800);
        const maxHopM = Math.max(1_000, Number(url.searchParams.get('maxHopM') ?? 45_000) || 45_000);
        const tierParam = url.searchParams.get('tier');
        const terrainParam = url.searchParams.get('terrain');
        const labels = ['SIMULATED', 'COVERAGE-GEOMETRY'];
        const terrain = terrainParam === 'none' ? null : await loadTerrainField(planet);

        if (mode === 'radio-chain' || mode === 'layered') {
          const radio = hull.radioRangeM ?? 0;
          if (!(radio > 0)) throw new DesignerHttpError(409, 'no_radio_hull', `hull ${hull.name} has no radio antenna`);
          const plan =
            mode === 'radio-chain'
              ? planRadioChain(planet, {
                  radioRangeM: radio,
                  zeroGAltitudeM: zeroG,
                  atmoCeilingM: atmoCeiling,
                  baseAltitudeM,
                  maxHopM,
                  rangeMargin: margin,
                })
              : planLayered(planet, {
                  radioRangeM: radio,
                  zeroGAltitudeM: zeroG > 0 ? zeroG : 45_000,
                  atmoCeilingM: atmoCeiling,
                  baseAltitudeM,
                  maxHopM,
                  rangeMargin: margin,
                });
          const nodes =
            plan.kind === 'radio-chain'
              ? plan.nodes.map((node) => ({ id: node.id, position: node.position, altitudeM: node.altitudeM }))
              : plan.nodes.map((node) => ({ id: node.id, position: node.position, altitudeM: node.altitudeM }));
          const grid = coverageGridFromNodes(planet, nodes, radio, { k, cellDeg, rangeMargin: margin, terrain });
          sendJson(res, 200, {
            planet: planet.name,
            mode,
            hull: { id: hull.id, name: hull.name, radioRangeM: radio },
            k,
            cellDeg,
            rangeMargin: margin,
            zeroGAltitudeM: zeroG,
            atmoCeilingM: atmoCeiling,
            nodes: nodes.map((node) => ({ id: node.id, altitudeM: node.altitudeM })),
            coveragePct: grid.coveragePct,
            coveredCells: grid.coveredCells,
            totalCells: grid.totalCells,
            cells: grid.cells,
            terrain: grid.terrain,
            terrainReason: grid.terrainReason,
            blockedCells: grid.blockedCells,
            geometricCoveragePct: grid.totalCells
              ? Math.round((grid.geometricCoveredCells / grid.totalCells) * 1000) / 10
              : 0,
            sampling: grid.sampling,
            warnings: plan.warnings,
            reasons: plan.reasons,
            labels: grid.terrain === 'corrected' ? [...labels, 'TERRAIN-CORRECTED'] : grid.terrain === 'unavailable' ? [...labels, 'TERRAIN-UNAVAILABLE'] : labels,
          });
          return;
        }

        const atmoRadio = bestRadio((cap) => cap.tierEligibility.atmo && cap.canHoverInGravity) || anyRadio;
        const allSpecs: CoverageTierSpec[] = [
          { id: 'atmo', altitudeM: Math.min(8_000, atmoCeiling - 500), radioRangeM: atmoRadio },
          { id: 'station', altitudeM: 15_000, radioRangeM: anyRadio },
          { id: 'zero-g', altitudeM: Math.max(45_000, zeroG), radioRangeM: anyRadio },
        ];
        const specs = allSpecs.filter((spec) => !tierParam || spec.id === (tierParam as CoverageTierId));
        if (!specs.length) {
          throw new DesignerHttpError(400, 'invalid_tier', `tier must be atmo, station or zero-g`);
        }
        const plan = planPlanetCoverage(planet, specs, {
          k,
          cellDeg,
          rangeMargin: margin,
          maxHopM,
          baseAltitudeM,
          terrain,
        });
        sendJson(res, 200, {
          planet: planet.name,
          mode: 'cover-planet',
          k,
          cellDeg,
          rangeMargin: margin,
          recommendedTier: plan.recommendedTier,
          recommendation: plan.recommendation,
          tiers: plan.tiers.map((tier) => ({
            id: tier.id,
            altitudeM: tier.altitudeM,
            radioRangeM: tier.radioRangeM,
            count: tier.count,
            bridgeCount: tier.bridgeCount,
            coveragePct: tier.coveragePct,
            footprintRadiusM: tier.footprintRadiusM,
            flatFootprintRadiusM: tier.flatFootprintRadiusM,
            connectedToBase: tier.connectedToBase,
            spofs: tier.spofs,
            geometricCoveredCells: tier.geometricCoveredCells,
            terrainBlockedCells: tier.terrainBlockedCells,
            nodes: tier.nodes.map((node) => ({
              id: node.id,
              role: node.role,
              altitudeM: node.altitudeM,
              latDeg: node.latDeg,
              lonDeg: node.lonDeg,
            })),
            warnings: tier.warnings,
          })),
          uncoveredCells: plan.uncoveredCells,
          uncoveredPct: plan.uncoveredPct,
          rovers: plan.rovers,
          cells: plan.cells,
          terrain: plan.terrain,
          terrainReason: plan.terrainReason,
          blockedCells: plan.terrainBlockedCells,
          geometricCoveragePct: plan.cells.length
            ? Math.round((plan.cells.filter((cell) => (cell.geometricCoveredBy ?? cell.coveredBy) >= 1).length / plan.cells.length) * 1000) / 10
            : 0,
          sampling: plan.sampling,
          labels: plan.labels,
          reasons: plan.reasons,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/plan$/,
      handler: async ({ req, res }) => {
        const parsed = PlanBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DesignerHttpError(400, 'invalid', 'invalid designer plan request', formatIssues(parsed.error));
        const body = parsed.data;
        const relayMode = body.mode === 'radio-chain' || body.mode === 'layered' || body.mode === 'cover-planet';
        const planetName = body.planet ?? body.base?.planet;
        if (relayMode && !planetName) {
          throw new DesignerHttpError(400, 'invalid', `${body.mode} mode needs planet or base.planet`);
        }
        if (body.mode === 'constellation' && !body.planet) throw new DesignerHttpError(400, 'invalid', 'constellation mode needs planet');
        if (body.mode === 'connect' && (!body.a || !body.b)) throw new DesignerHttpError(400, 'invalid', 'connect mode needs a and b');
        const { hulls } = await allHulls(deps);
        const hull = findHull(hulls, body.hullId);
        if (!hull) throw new DesignerHttpError(400, 'unknown_hull', `unknown hull ${body.hullId}`);
        // T49: terrain only matters for the coverage-driven modes; a failure is
        // carried into the plan as terrain:'unavailable', never guessed.
        const catalog = loadPlanetCatalog();
        const terrainPlanet =
          body.mode === 'constellation' || body.mode === 'cover-planet'
            ? catalog.find((p) => p.name === planetName || p.id === planetName) ?? null
            : null;
        const terrain =
          terrainPlanet && body.terrain !== 'none' ? await loadTerrainField(terrainPlanet) : null;
        let plan: DesignerPlan;
        // T30 is a separate workstream: load its budget function when present,
        // otherwise the assignment records that power was skipped.
        const power = relayMode ? await loadPowerBudget() : { check: null, note: null };
        try {
          plan = buildDesignerPlan(body as never, hulls, catalog, clock(), undefined, {
            powerCheck: power.check,
            powerNote: power.note,
            terrain,
          });
        } catch (err) {
          throw new DesignerHttpError(400, 'plan_error', err instanceof Error ? err.message : String(err));
        }
        storePlan(deps.store, plan);
        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_plan',
          subject: plan.id,
          detail: {
            mode: body.mode,
            hullId: body.hullId,
            pattern: body.pattern,
            redundancy: body.redundancy,
            counts: plan.options.map((o) => o.count),
            feasible: plan.options.map((o) => o.feasible),
          },
          at: clock(),
        });
        sendJson(res, 200, {
          planId: plan.id,
          mode: plan.mode,
          hull: plan.hull,
          options: plan.options,
          assumptions: plan.assumptions,
          labels: plan.labels,
          settings: readDesignerSettings(deps.store),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/execute$/,
      handler: async ({ req, res }) => {
        if (deps.store.isKillSwitchOn()) {
          throw new DesignerHttpError(409, 'kill_switch', 'global kill switch is ON; execution is blocked');
        }
        const parsed = ExecuteBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DesignerHttpError(400, 'invalid', 'invalid execute request', formatIssues(parsed.error));
        // T74: fillWithClones builds the unfilled slots out of a clone of the
        // prefab, which is a spawn. Survival mode refuses it and says what to do
        // instead rather than silently moving fewer ships than the plan.
        if (parsed.data.fillWithClones && resolveSurvivalMode()) {
          deps.store.audit({
            actor: actorOf(req),
            action: 'survival_refused',
            subject: 'fillWithClones',
            detail: { reason: SURVIVAL_REASON, route: 'POST /api/demo/designer/execute' },
            at: clock(),
          });
          throw new DesignerHttpError(409, SURVIVAL_REASON, `${SURVIVAL_MESSAGE}: fillWithClones`, [
            'survival mode cannot clone a hull into a slot: assign owned spares that can reach it, or emit a build request',
          ]);
        }
        // T75: `ignoreReach` is an admin override (fly outside the network);
        // only the test world may ask for it.
        if (parsed.data.ignoreReach && resolveSurvivalMode()) {
          deps.store.audit({
            actor: actorOf(req),
            action: 'survival_refused',
            subject: 'ignoreReach',
            detail: { reason: SURVIVAL_REASON, route: 'POST /api/demo/designer/execute', flag: 'ignoreReach' },
            at: clock(),
          });
          throw new DesignerHttpError(409, SURVIVAL_REASON, `${SURVIVAL_MESSAGE}: ignoreReach admin override`);
        }
        const plan = loadPlan(deps.store);
        if (!plan) throw new DesignerHttpError(404, 'no_plan', 'no designer plan is stored; call /plan first');
        const option = plan.options.find((o) => o.id === parsed.data.optionId);
        if (!option) throw new DesignerHttpError(404, 'unknown_option', `option ${parsed.data.optionId} is not in the last plan ${plan.id}`);
        if (!option.feasible && !(parsed.data.useGridIds ?? []).length) {
          throw new DesignerHttpError(409, 'plan_infeasible', `option ${option.id} is infeasible: ${option.reasons.join('; ')}`);
        }
        const settings = readDesignerSettings(deps.store);
        // The per-mission cap is the audited designer setting; a request may
        // lower it but never exceed it (and never exceed the hard cap of 10).
        const maxActive = Math.max(
          1,
          Math.min(parsed.data.maxActive ?? settings.maxActive, settings.maxActive, 10),
        );
        const useGridIds = [...new Set(parsed.data.useGridIds ?? [])];

        // T22 heterogeneous plans assign different hulls per slot. The executor
        // clones plan.hull into every slot, so it must not silently launch the
        // wrong hull; refuse with the per-slot hulls listed instead.
        if (useGridIds.length === 0 && option.assignment) {
          const foreign = option.assignment.assignments.filter((assignment) => assignment.hullId !== plan.hull.id);
          if (foreign.length > 0) {
            throw new DesignerHttpError(
              409,
              'hetero_execute_unsupported',
              `this plan assigns ${foreign.length} slot(s) to other hulls; execute supports one hull per mission in this build`,
              foreign.slice(0, 8).map((assignment) => `${assignment.slotId}: ${assignment.hullName} (${assignment.hullId})`),
              'Launch each assigned hull in its own mission, or restrict hullIds to the requested hull and replan.',
            );
          }
        }

        // ---------------------------------------------------------- T10 in place
        if (useGridIds.length > 0) {
          const { grids } = await loadOwnerTagged(deps);
          const byId = new Map(grids.map((g) => [g.gridId, g]));
          const unknown = useGridIds.filter((id) => !byId.has(id));
          if (unknown.length) {
            throw new DesignerHttpError(400, 'unknown_grid', `not owner-tagged [HERMES-TEST] grids: ${unknown.join(', ')}`);
          }
          const foreign = useGridIds.filter((id) => !byId.get(id)!.owned);
          if (foreign.length) {
            throw new DesignerHttpError(
              409,
              'not_owned',
              `refused: these grids are not owned by identity ${OWNER_IDENTITY_ID}: ${foreign.join(', ')}`,
            );
          }
          const noPos = useGridIds.filter((id) => !byId.get(id)!.position);
          if (noPos.length) {
            throw new DesignerHttpError(409, 'grid_position_unknown', `the plugin reported no position for: ${noPos.join(', ')}`);
          }
          const selected = useGridIds.map((id) => byId.get(id)!);
          // Persist the measured radio radii: the executor's comms gate needs a
          // capability profile for a grid that is not a prefab, and this is the
          // only place the live profile is available.
          const radios: Record<string, number> = {};
          try {
            Object.assign(radios, JSON.parse(deps.store.getKv('designer:gridRadios') ?? '{}') as Record<string, number>);
          } catch {
            /* start a fresh map */
          }
          for (const g of selected) {
            if (typeof g.hull.radioRangeM === 'number' && g.hull.radioRangeM > 0) radios[g.gridId] = g.hull.radioRangeM;
          }
          deps.store.setKv('designer:gridRadios', JSON.stringify(radios));
          const slots = option.positions.map((p, i) => ({ id: p.id || `s${i + 1}`, x: p.x, y: p.y, z: p.z }));
          const pairs = assignGridsToSlots(
            selected.map((g) => ({
              gridId: g.gridId,
              name: g.hull.displayName || g.hull.name,
              position: g.position!,
            })),
            slots,
          );
          const planetName = plan.planets.a ?? plan.planets.b ?? null;
          const planet = planetName
            ? loadPlanetCatalog().find((p) => p.name === planetName || p.id === planetName) ?? null
            : null;
          // Per-grid endurance + range preflight. A refusal drops that pair;
          // every other drone still launches.
          const evaluated = pairs.map((pair) => {
            const grid = byId.get(pair.gridId)!;
            const slot = slots[pair.slotIndex]!;
            const range = grid.hull.radioRangeM !== null ? grid.hull.radioRangeM * plan.input.rangeMargin : null;
            const radioOk = range !== null && range + 0.5 >= option.maxGapM;
            const base = planet
              ? preflightGridLaunch({
                  hull: grid.hull,
                  planet,
                  slot: { x: slot.x, y: slot.y, z: slot.z },
                  gridPosition: grid.position!,
                  requiredReservePct: settings.launchReservePct,
                  liveFuelPct: grid.live?.h2Pct === null || grid.live?.h2Pct === undefined ? null : grid.live.h2Pct / 100,
                })
              : {
                  status: 'unverified' as const,
                  code: 'endurance_model_unavailable',
                  canReachSlot: null,
                  reason: 'the plan has no planet, so altitude/gravity are unknown',
                  hint: 'Use a constellation plan (planet known) to get an endurance verdict.',
                  reservePct: null,
                  requiredReservePct: settings.launchReservePct,
                  altitudeM: 0,
                  holdEnduranceText: null,
                  labels: ['SIMULATED', 'ENDURANCE-UNVERIFIED', 'IN-PLACE'],
                };
            const endurance = radioOk
              ? base
              : {
                  ...base,
                  status: 'refused' as const,
                  code: 'radio_range_short',
                  canReachSlot: false,
                  reason:
                    `radio ${((grid.hull.radioRangeM ?? 0) / 1000).toFixed(0)} km ` +
                    `(margin ${plan.input.rangeMargin} -> ${((range ?? 0) / 1000).toFixed(1)} km) ` +
                    `is shorter than the planned max gap ${(option.maxGapM / 1000).toFixed(1)} km`,
                  hint: 'Raise the range margin, pick a denser ring (smaller spacing), or use a hull with a longer antenna.',
                };
            return {
              gridId: pair.gridId,
              gridName: pair.gridName,
              slotId: pair.slotId,
              slotIndex: pair.slotIndex,
              distanceM: pair.distanceM,
              fuelPct: grid.live?.h2Pct ?? null,
              batteryPct: grid.live?.batteryPct ?? null,
              endurance: {
                status: endurance.status,
                code: endurance.code,
                message: endurance.reason,
                hint: endurance.hint,
                canReachSlot: endurance.canReachSlot,
                reason: endurance.reason,
                reservePct: endurance.reservePct,
                requiredReservePct: endurance.requiredReservePct,
                altitudeM: endurance.altitudeM,
                holdEnduranceText: endurance.holdEnduranceText,
                labels: endurance.labels,
              },
            };
          });
          const launchable = evaluated.filter((e) => e.endurance.status !== 'refused');
          const launched = launchable.slice(0, maxActive);
          const deferred = launchable.slice(maxActive);
          const launchedIds = new Set(launched.map((e) => e.gridId));
          const filledSlots = new Set(launched.map((e) => e.slotIndex));
          const unfilled = slots
            .map((slot, i) => ({ slotId: slot.id, slotIndex: i, position: { x: slot.x, y: slot.y, z: slot.z } }))
            .filter((s) => !filledSlots.has(s.slotIndex));
          const cloneSpecs = parsed.data.fillWithClones
            ? unfilled.map((s) => ({ position: s.position, clone: true as const }))
            : [];
          // Preserve slot order: each step is slot-N of the planned option, so
          // executor labels and GPS markers line up with the preview.
          const slotSpecs: { position: { x: number; y: number; z: number }; useGridId?: string; gridName?: string }[] = [];
          slots.forEach((slot, i) => {
            const hit = launched.find((e) => e.slotIndex === i);
            if (hit) slotSpecs.push({ position: { x: slot.x, y: slot.y, z: slot.z }, useGridId: hit.gridId, gridName: hit.gridName });
            else if (parsed.data.fillWithClones && !filledSlots.has(i)) slotSpecs.push({ position: { x: slot.x, y: slot.y, z: slot.z } });
          });
          const disposition = evaluated.map((e) => ({
            ...e,
            disposition: launchedIds.has(e.gridId)
              ? 'launch'
              : e.endurance.status === 'refused'
                ? 'refused'
                : 'queued',
          }));
          const labels = [
            'SIMULATED',
            'IN-PLACE',
            ...(deferred.length ? ['QUEUED'] : []),
            ...(cloneSpecs.length ? ['CLONES'] : []),
            ...(parsed.data.ignoreReach ? ['ADMIN OVERRIDE (test server)'] : []),
          ];
          const assignmentResponse = {
            useGridIds,
            fillWithClones: parsed.data.fillWithClones,
            maxActive,
            scaled: launchable.length > maxActive,
            assignment: disposition,
            queued: disposition.filter((e) => e.disposition === 'queued').map((e) => ({ gridId: e.gridId, gridName: e.gridName, reason: `active cap ${maxActive}` })),
            refused: disposition.filter((e) => e.disposition === 'refused').map((e) => ({ gridId: e.gridId, gridName: e.gridName, reason: e.endurance.reason })),
            unfilledSlots: unfilled
              .filter((s) => !parsed.data.fillWithClones)
              .map((s) => ({ slotId: s.slotId, reason: 'no drone selected and fillWithClones=false' })),
            clones: cloneSpecs.map((s, i) => ({ slotId: unfilled[i]!.slotId, hullId: plan.hull.id })),
            missionExecution: 'release (gears/connectors/diag/convert) -> move -> hold; staging active; no spawn or ownership transfer',
            labels,
          };
          if (slotSpecs.length === 0) {
            deps.store.audit({
              actor: actorOf(req),
              action: 'designer_inplace_refused',
              subject: plan.id,
              detail: { optionId: option.id, ...assignmentResponse },
              at: clock(),
            });
            throw new DesignerHttpError(409, 'nothing_to_launch', 'no selected drone passed the per-grid endurance/range preflight');
          }
          if (parsed.data.dryRun) {
            deps.store.audit({
              actor: actorOf(req),
              action: 'designer_inplace_dry_run',
              subject: plan.id,
              detail: { optionId: option.id, ...assignmentResponse },
              at: clock(),
            });
            sendJson(res, 200, {
              dryRun: true,
              planId: plan.id,
              option: { id: option.id, pattern: option.pattern, count: option.count, maxGapM: option.maxGapM, summary: option.summary },
              launch: 'in-place',
              ...assignmentResponse,
            });
            return;
          }
          const mission = designerMission(deps, req, plan, option, 'orbital', maxActive, parsed.data.nearGps, slotSpecs, parsed.data.ignoreReach);
          // One grid, one mission: an execute that uses existing grids supersedes
          // any older active mission on each of them.
          const superseded = [...new Set(slotSpecs.filter((s) => 'useGridId' in s).map((s) => s.useGridId as string))]
            .flatMap((gid) => supersedeGridMissions(
              deps.store, gid, mission.id, actorOf(req), clock(),
              `superseded by designer execute (${mission.id})`,
            ));
          deps.store.audit({
            actor: actorOf(req),
            action: 'designer_execute_inplace',
            subject: mission.id,
            detail: {
              planId: plan.id,
              optionId: option.id,
              launch: 'in-place',
              count: slotSpecs.length,
              maxActive,
              gridIds: slotSpecs.filter((s) => 'useGridId' in s).map((s) => s.useGridId),
              queued: assignmentResponse.queued.length,
              refused: assignmentResponse.refused.length,
              clones: cloneSpecs.length,
              superseded,
            },
            at: clock(),
          });
          deps.executor?.tick();
          sendJson(res, 201, {
            mission,
            missionId: mission.id,
            planId: plan.id,
            option: { id: option.id, pattern: option.pattern, count: option.count, summary: option.summary },
            launch: 'in-place',
            superseded,
            ...assignmentResponse,
            approvalState: { status: mission.status, approval: mission.approval, awaitingApproval: true },
            execution: {
              pluginConnected: deps.hub.isConnected(),
              executorEnabled: deps.executor?.enabled() ?? false,
              detail: 'existing grids launch in place: release preflight -> move -> hold; every flight order passes the comms gate',
            },
          });
          return;
        }

        if (parsed.data.launch === 'surface' && plan.hull.canGroundLaunch !== true) {
          throw new DesignerHttpError(
            409,
            'no_ground_launch',
            `surface launch refused: ${plan.hull.name} is ${plan.hull.canGroundLaunch === 'unknown' ? 'unverified for ground launch' : 'not ground-launch capable'}; use launch=orbital`,
          );
        }
        // Propulsion/energy preflight: a hull that cannot reach the slot with
        // the configured reserve is refused before any grid is spawned.
        const gate = launchGateFor(plan, option, parsed.data.launch, settings.launchReservePct);
        if (!gate.ok) {
          deps.store.audit({
            actor: actorOf(req),
            action: 'designer_launch_refused',
            subject: plan.id,
            detail: { optionId: option.id, launch: parsed.data.launch, ...gate },
            at: clock(),
          });
          throw new DesignerHttpError(409, 'endurance_refused', gate.reason ?? 'endurance preflight refused the launch');
        }
        const mission = designerMission(deps, req, plan, option, parsed.data.launch, maxActive, parsed.data.nearGps, undefined, parsed.data.ignoreReach);
        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_execute',
          subject: mission.id,
          detail: {
            planId: plan.id,
            optionId: option.id,
            hullId: plan.hull.id,
            launch: parsed.data.launch,
            count: option.count,
            maxActive,
            scaled: option.count > maxActive,
            endurance: { reservePct: gate.reservePct, requiredReservePct: gate.requiredReservePct, altitudeM: gate.altitudeM },
          },
          at: clock(),
        });
        deps.executor?.tick();
        sendJson(res, 201, {
          mission,
          planId: plan.id,
          option: {
            id: option.id,
            pattern: option.pattern,
            count: option.count,
            redundancyAchieved: option.redundancyAchieved,
            summary: option.summary,
          },
          launch: parsed.data.launch,
          activeCap: maxActive,
          scaled: option.count > maxActive,
          label: option.count > maxActive ? 'SCALED' : null,
          approvalState: { status: mission.status, approval: mission.approval, awaitingApproval: true },
          endurance: {
            reservePct: gate.reservePct,
            requiredReservePct: gate.requiredReservePct,
            altitudeM: gate.altitudeM,
            detail: 'fuel/charge reserve at the slot must stay at or above the audited launch reserve',
          },
          execution: {
            pluginConnected: deps.hub.isConnected(),
            executorEnabled: deps.executor?.enabled() ?? false,
            detail: 'spawn -> ownership -> wake -> ai_off -> move -> hold; every flight order passes the comms gate',
          },
          labels: ['SIMULATED', ...(option.count > maxActive ? ['SCALED'] : []), ...(parsed.data.ignoreReach ? ['ADMIN OVERRIDE (test server)'] : [])],
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/designer\/settings$/,
      handler: ({ res }) => {
        const settings = readDesignerSettings(deps.store);
        const simSpeed = deps.executor?.summary().simSpeed as { value?: number | null; threshold?: number } | null | undefined;
        sendJson(res, 200, {
          settings,
          defaults: { simSpeedMin: 0.95, maxActive: 5, launchReservePct: 15 },
          live: { simSpeed: simSpeed?.value ?? null, threshold: simSpeed?.threshold ?? settings.simSpeedMin },
          note: 'the executor reads simSpeedMin and maxActive live from this store; changes are audited',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/settings$/,
      handler: async ({ req, res }) => {
        const body = (await readJson(req)) as Record<string, unknown>;
        const next = writeDesignerSettings(deps.store, body, actorOf(req), clock());
        sendJson(res, 200, {
          settings: next,
          validated: validateSettings(next),
          live: { threshold: next.simSpeedMin, maxActive: next.maxActive },
          note: 'applied live: the SimSpeed gate and the execute cap read this store on every tick',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/gps$/,
      handler: async ({ req, res }) => {
        const parsed = GpsBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DesignerHttpError(400, 'invalid', 'gps needs {missionId}', formatIssues(parsed.error));
        const missionId = parsed.data.missionId;
        const drones = droneRows(deps.store, missionId);
        if (!drones.length) throw new DesignerHttpError(404, 'unknown_mission', `no execution rows for mission ${missionId}`);
        const identity = await callPlugin(deps, 'identity', {});
        const identityId = String(identity.result?.identityId ?? '');
        if (!identityId) throw new DesignerHttpError(502, 'no_identity', 'plugin returned no owner identity');
        const prefix = `H6 ${short(missionId)}`;
        const markers: { name: string; x: number; y: number; z: number; description: string }[] = [];
        for (const row of drones.slice(0, 40)) {
          const idx = Number(row.idx) + 1;
          let slot: { x: number; y: number; z: number } | null = null;
          try {
            slot = JSON.parse(String(row.plan_slot_json)) as { x: number; y: number; z: number };
          } catch {
            slot = null;
          }
          if (slot) {
            markers.push({ name: `${prefix} S${idx}`, x: slot.x, y: slot.y, z: slot.z, description: `slot ${idx} for ${missionId}` });
          }
          if (row.grid_id) {
            markers.push({
              name: `${prefix} D${idx}`,
              x: slot?.x ?? 0,
              y: slot?.y ?? 0,
              z: slot?.z ?? 0,
              description: `drone grid ${String(row.grid_id)} for ${missionId}`,
            });
          }
        }
        const added: unknown[] = [];
        for (const marker of markers) {
          const result = await callPlugin(deps, 'gps_add', { identityId, name: marker.name, x: marker.x, y: marker.y, z: marker.z, color: 'cyan', description: marker.description }, 6_000);
          added.push(result.result ?? { ok: result.ok });
        }
        const readBack = await callPlugin(deps, 'gps_list', { identityId }, 6_000);
        const visible = ((readBack.result?.gps as { name?: string }[] | undefined) ?? []).map((g) => g.name ?? '');
        const expected = markers.map((m) => m.name);
        const missing = expected.filter((name) => !visible.includes(name));
        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_gps_add',
          subject: missionId,
          detail: { identityId, prefix, expected: expected.length, visible: visible.length, missing },
          at: clock(),
        });
        sendJson(res, 200, {
          missionId,
          identityId,
          prefix,
          added: added.length,
          expected,
          visibleCount: visible.filter((n) => n.startsWith(prefix)).length,
          verified: missing.length === 0,
          missing,
          readBack: 'plugin GetGpsList for the owner identity',
          status: missing.length === 0 ? 'GAME' : 'UNVERIFIED',
        });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/demo\/designer\/gps$/,
      handler: async ({ req, res }) => {
        const parsed = GpsBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DesignerHttpError(400, 'invalid', 'gps needs {missionId}', formatIssues(parsed.error));
        const missionId = parsed.data.missionId;
        const identity = await callPlugin(deps, 'identity', {});
        const identityId = String(identity.result?.identityId ?? '');
        const prefix = `H6 ${short(missionId)}`;
        const removed = await callPlugin(deps, 'gps_remove', { identityId, namePrefix: prefix }, 8_000);
        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_gps_remove',
          subject: missionId,
          detail: { identityId, prefix, removed: removed.result?.removed ?? null },
          at: clock(),
        });
        sendJson(res, 200, {
          missionId,
          identityId,
          prefix,
          removed: removed.result?.removed ?? null,
          remaining: removed.result?.remaining ?? null,
          verified: removed.result?.verified ?? false,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/plugin$/,
      handler: async ({ req, res }) => {
        // Narrow test-harness proxy: the designer needs a way to prove plugin
        // actions that no public route exposes (clone_grid, delete_grid,
        // profile, list_tagged, gps_*). Same env lock, token and audit; the
        // action whitelist is fixed and mutating actions respect the kill
        // switch. Not part of the public UI surface.
        const body = (await readJson(req)) as { action?: unknown; params?: unknown };
        const action = String(body.action ?? '');
        const allowed = ['clone_grid', 'delete_grid', 'list_tagged', 'profile', 'gps_add', 'gps_remove', 'gps_list', 'identity'];
        if (!allowed.includes(action)) {
          throw new DesignerHttpError(400, 'action_not_allowed', `action must be one of ${allowed.join(', ')}`);
        }
        // T74: clone_grid, delete_grid and the ownership path are test-server
        // capabilities. In survival the route refuses with a plain reason and
        // an audit row instead of failing at the plugin.
        if (resolveSurvivalMode() && isAdminAction(action)) {
          deps.store.audit({
            actor: actorOf(req),
            action: 'survival_refused',
            subject: action,
            detail: { reason: SURVIVAL_REASON, route: 'POST /api/demo/designer/plugin', params: body.params ?? null },
            at: clock(),
          });
          throw new DesignerHttpError(409, SURVIVAL_REASON, `${SURVIVAL_MESSAGE}: ${action}`, [
            'survival mode: a lost node is recovered by re-shaping neighbours, assigning an owned spare, or a build request',
          ]);
        }
        const mutating = action === 'clone_grid' || action === 'delete_grid' || action === 'gps_add' || action === 'gps_remove';
        if (mutating && deps.store.isKillSwitchOn()) {
          throw new DesignerHttpError(409, 'kill_switch', 'global kill switch is ON');
        }
        const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
        const result = await callPlugin(deps, action, params, action === 'clone_grid' ? 20_000 : 8_000);
        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_plugin_action',
          subject: action,
          detail: { params, ok: result.ok },
          at: clock(),
        });
        sendJson(res, 200, { action, ...result });
      },
    },
    {
      // T43 'optimise my network': the plan that gives the best coverage this
      // fleet can give for the least movement, with honest holes and costs.
      // Read-only: it never executes, spawns or orders anything.
      method: 'POST',
      pattern: /^\/api\/demo\/designer\/optimise$/,
      handler: async ({ req, res }) => {
        const parsed = OptimiseBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DesignerHttpError(400, 'invalid', 'invalid optimise request', formatIssues(parsed.error));
        }
        const body = parsed.data;
        const planetName = body.planet ?? body.planetId;
        if (!planetName) throw new DesignerHttpError(400, 'invalid', 'optimise needs planet or planetId');
        const catalog = loadPlanetCatalog();
        const planet = catalog.find((p) => p.name === planetName || p.id === planetName);
        if (!planet) throw new DesignerHttpError(404, 'unknown_planet', `unknown planet ${planetName}`);
        const now = clock();
        const cellDegUsed = Math.max(2, Math.min(30, body.cellDeg));
        const store = deps.store;
        const caps = capabilitiesFromStore(store);

        // Base: the requested grid, else the first provisioned control source
        // that has telemetry, else an explicit default (never guessed as a real
        // base: the source field says so).
        const controlSources = [...caps.values()]
          .filter((cap) => cap.controlSource)
          .map((cap) => cap.gridId)
          .filter((id) => store.getUnit(id)?.pos)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const requestedBase = body.baseGridId ? caps.get(body.baseGridId) ?? null : null;
        if (body.baseGridId && !requestedBase) {
          throw new DesignerHttpError(404, 'unknown_base', `no capability profile for base ${body.baseGridId}`);
        }
        const baseId = requestedBase?.gridId ?? controlSources[0] ?? null;
        const baseUnit = baseId ? store.getUnit(baseId) : null;
        const basePosition = baseUnit?.pos ?? add(planet.center, scale(v3(0, 1, 0), planet.surfaceRadiusM + 1_800));
        const baseAltitudeM = Math.round(
          Math.hypot(basePosition.x - planet.center.x, basePosition.y - planet.center.y, basePosition.z - planet.center.z) -
            planet.surfaceRadiusM,
        );
        const baseLl = latLonOfDir(sub(basePosition, planet.center));
        const base: OptimiseBase = {
          gridId: baseId,
          name: baseUnit?.name ?? requestedBase?.name ?? 'default base',
          position: basePosition,
          altitudeM: Math.max(0, baseAltitudeM),
          radioRangeM: requestedBase?.radioRadiusM ?? (baseId ? caps.get(baseId)?.radioRadiusM ?? null : null),
          latDeg: baseLl.latDeg,
          lonDeg: baseLl.lonDeg,
          source: requestedBase ? 'request' : baseId ? 'control-source' : 'default',
        };

        // Target geometry.
        const dirFromLatLon = (latDeg: number, lonDeg: number) => {
          const lat = (latDeg * Math.PI) / 180;
          const lon = (lonDeg * Math.PI) / 180;
          return v3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
        };
        const dirFromPoint = (
          point: { gps: { x: number; y: number; z: number } } | { latDeg: number; lonDeg: number },
        ) =>
          'gps' in point
            ? normalize(sub(point.gps, planet.center))
            : dirFromLatLon(point.latDeg, point.lonDeg);
        const gridPoint = (idOrName: string): V3 | null => {
          const unit =
            store.getUnit(idOrName) ??
            store.listUnits().find((candidate) => candidate.name === idOrName) ??
            null;
          if (unit?.pos) return normalize(sub(unit.pos, planet.center));
          const cap = caps.get(idOrName);
          if (cap) {
            const other = store.getUnit(cap.gridId);
            if (other?.pos) return normalize(sub(other.pos, planet.center));
          }
          return null;
        };

        let target: OptimiseTargetInput;
        if (body.target === 'whole') {
          target = { kind: 'whole' };
        } else if (body.target === 'hemisphere') {
          const facingName = body.facing ?? baseId ?? null;
          const dir = facingName ? gridPoint(facingName) : null;
          if (facingName && !dir) {
            throw new DesignerHttpError(404, 'unknown_facing', `no telemetry position for ${facingName}`);
          }
          target = {
            kind: 'hemisphere',
            facingDir: dir ?? normalize(sub(basePosition, planet.center)),
            facingLabel: facingName ?? base.name,
          };
        } else if ('hemisphereFrom' in body.target) {
          const from = body.target.hemisphereFrom;
          const dir = typeof from === 'string' ? gridPoint(from) : dirFromPoint(from);
          if (!dir) throw new DesignerHttpError(404, 'unknown_facing', `no telemetry position for ${from as string}`);
          target = {
            kind: 'hemisphere',
            facingDir: dir,
            facingLabel: typeof from === 'string' ? from : 'the requested point',
          };
        } else {
          const center = dirFromPoint(body.target.center);
          target = {
            kind: 'radius',
            radiusM: body.target.radiusM,
            centerDir: center,
            centerLabel: 'the requested centre',
          };
        }

        const terrain = body.terrain === 'none' ? null : await loadTerrainField(planet);
        const world = loadWorld(store, resolveDemoEnv()?.fixturePath ?? null, now);
        const fleet = loadOptimiseFleet({
          store,
          planet,
          now,
          includeGridIds: body.includeGridIds,
          gateFor: (gridId) => {
            const gate = evaluateGate({
              store,
              world,
              now,
              nodeId: gridId,
              prefabFor: (id) => prefabForGrid(store, id),
            });
            return { allowed: gate.allowed, reason: gate.reason };
          },
          prefabFor: (gridId) => prefabForGrid(store, gridId),
        });

        const plan = solveOptimise({
          planet,
          ships: fleet.ships,
          excluded: fleet.excluded,
          base,
          target,
          targetDescription: describeTarget(target),
          k: body.k,
          cellDeg: body.cellDeg,
          cellDegUsed,
          rangeMarginPct: body.rangeMarginPct,
          maxMoves: body.maxMoves ?? null,
          maxSimSpeedBudget: body.maxSimSpeedBudget,
          minReservePct: body.minReservePct ?? 15,
          maxHoles: body.maxHoles ?? 24,
          terrain,
          now,
          dryRun: body.dryRun,
          includeGridIds: body.includeGridIds ?? null,
          altitudeMode: body.altitudeMode,
          costWeights: body.costWeights ?? null,
        });

        deps.store.audit({
          actor: actorOf(req),
          action: 'designer_optimise',
          subject: plan.planId,
          detail: {
            planet: planet.name,
            target: describeTarget(target),
            k: body.k,
            cellDeg: cellDegUsed,
            ships: plan.fleet.total,
            moves: plan.moves.length,
            gainPct: plan.gainPct,
            altitudeMode: plan.request.altitudeMode,
            buildRequests: plan.buildRequests.length,
            dryRun: body.dryRun,
          },
          at: now,
        });
        sendJson(res, 200, plan);
      },
    },
  ];
}

function describeTarget(target: OptimiseTargetInput): string {
  if (target.kind === 'whole') return 'whole planet';
  if (target.kind === 'hemisphere') return `hemisphere facing ${target.facingLabel}`;
  return `${Math.round(target.radiusM)} m radius around ${target.centerLabel}`;
}

function latLonOfDir(dir: { x: number; y: number; z: number }): { latDeg: number; lonDeg: number } {
  const unit = normalize(dir);
  return {
    latDeg: Math.round((Math.asin(Math.max(-1, Math.min(1, unit.y))) * 180) / Math.PI * 10) / 10,
    lonDeg: Math.round(((Math.atan2(unit.z, unit.x) * 180) / Math.PI) * 10) / 10,
  };
}
