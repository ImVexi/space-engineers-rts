import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import {
  LinkModelConfigSchema,
  MissionPatchSchema,
  MissionStatus,
  NetworkNodeSchema,
  NodeTemplateSchema,
  PlanetSchema,
  Vec3Schema,
  formatIssues,
  type Mission,
} from '@se-rts/schemas';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { approveMission, cancelMission, createMission } from './missions.js';
import type { Reconciler } from './reconciler.js';
import type { Dispatcher } from './dispatcher.js';
import type { PluginHub, StateHub } from './pluginHub.js';
import type { DetectorService } from './detector/saveDetector.js';
import { buildSnapshot } from './state.js';
import { DemoHttpError, demoRoutesFor, hintForCode, invalidateDemoStateCache } from './demo/index.js';
import type { PlayerTracker } from './demo/players/index.js';
import type { PowerPoller } from './demo/power/index.js';
import type { AlertsService } from './demo/alerts/index.js';
import type { SurvivalService } from './demo/survival/index.js';
import { worldProxyRoutesFor } from './demo/worldProxy.js';
import { designerRoutesFor } from './demo/designer/index.js';
import { provisionRoutesFor, startProvisioner } from './demo/provision/index.js';
import { namingRoutesFor, namingSyncHook } from './demo/naming/index.js';
import type { DemoExecutor } from './demo/executor.js';
import { evaluateGate } from './demo/gate.js';
import { shipRoles } from './demo/roles.js';
import { safetyOrderReason } from './demo/safety-order.js';
import { snapDockDecision } from './demo/docking.js';
import { loadWorld } from './demo/world.js';
import { resolveDemoEnv } from './demo/env.js';
import { serveDemoStatic } from './demo/static.js';
import { resolveSurvivalMode, SURVIVAL_REASON } from './demo/survival.js';
import { isUnitReachable, reachableUnits } from './comms.js';
import {
  LINK_MODEL_DEFAULTS,
  findPlanet,
  linkGraph,
  loadPlanetCatalog,
  planChain,
  planCoverage,
  planetRegion,
  presetTemplateNames,
  resolveTemplate,
  whatIfRemove,
} from './planner/index.js';

export interface ServerDeps {
  config: Config;
  store: Store;
  hub: PluginHub;
  stateHub: StateHub;
  reconciler: Reconciler;
  dispatcher: Dispatcher;
  detector?: DetectorService;
  executor?: DemoExecutor;
  /** T20 power poller; only present when the demo env is active. */
  power?: PowerPoller | null;
  /** T68 alerts engine; only present when the demo env is active. */
  alerts?: AlertsService | null;
  /** T66 survival loop; only present when the demo env is active. */
  survival?: SurvivalService | null;
  /** T61 player tracker; present whenever the runtime has one. */
  players?: PlayerTracker | null;
  startedAt: number;
  clock?: () => number;
}

const MAX_BODY_BYTES = 1024 * 1024;

const PlanChainBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  template: NodeTemplateSchema.optional(),
  templateId: z.string().min(1).optional(),
  planets: z.array(PlanetSchema).optional(),
  config: LinkModelConfigSchema.partial().optional(),
  maxSpacingM: z.number().positive().optional(),
});

const PlanCoverageBodySchema = z.object({
  planet: z.string().min(1).optional(),
  region: z
    .object({ center: Vec3Schema, surfaceRadiusM: z.number().positive() })
    .optional(),
  template: NodeTemplateSchema.optional(),
  templateId: z.string().min(1).optional(),
  k: z.union([z.literal(1), z.literal(2)]).optional(),
  altitudeM: z.number().nonnegative().optional(),
  reuseExisting: z.array(NetworkNodeSchema).optional(),
  planets: z.array(PlanetSchema).optional(),
  config: LinkModelConfigSchema.partial().optional(),
  maxSpacingM: z.number().positive().optional(),
});

const PlanGraphBodySchema = z.object({
  nodes: z.array(NetworkNodeSchema),
  planets: z.array(PlanetSchema).optional(),
  config: LinkModelConfigSchema.partial().optional(),
});

const PlanWhatIfBodySchema = PlanGraphBodySchema.extend({ nodeId: z.string().min(1) });

const TestOrderBody = z.object({
  orderType: z.enum(['test', 'action', 'move', 'hold', 'stop', 'waypoint']),
  entityId: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  note: z.string().max(300).optional(),
});

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: string[],
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: http.IncomingMessage, config: Config): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return safeEqual(header.slice(7).trim(), config.token);
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = url.searchParams.get('token');
  return Boolean(query && safeEqual(query, config.token));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'request body exceeds 1 MiB');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

function actorOf(req: http.IncomingMessage): string {
  const header = req.headers['x-actor'];
  if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 128);
  return 'api';
}

export function createHttpServer(deps: ServerDeps): http.Server {
  const { config, store, hub, stateHub } = deps;
  const clock = deps.clock ?? (() => Date.now());

  const snapshot = () =>
    buildSnapshot({ config, store, hub, startedAt: deps.startedAt, clock });

  const broadcast = (type: string, data: Record<string, unknown>) =>
    stateHub.broadcast({ type, at: clock(), ...data });

  const missionEvent = (kind: string, mission: Mission) =>
    broadcast('mission', { event: kind, mission });

  // When the demo is enabled, the test order route uses exactly the demo/
  // executor gate (planner path + fresh game link). Outside the demo the
  // legacy telemetry-only gate below stays in force.
  const demoEnv = (() => {
    try {
      return resolveDemoEnv();
    } catch {
      return null;
    }
  })();

  const authorityGate = (entityId: string) => {
    if (!demoEnv) return gateFor(entityId);
    const gate = evaluateGate({
      store,
      world: loadWorld(store, demoEnv.fixturePath, clock()),
      now: clock(),
      nodeId: entityId,
      freshMs: config.demo.gateFreshMs,
      prefabFor: (id) => {
        const row = store.db.prepare(`SELECT prefab FROM demo_drones WHERE grid_id = ? LIMIT 1`).get(id) as
          | { prefab?: string }
          | undefined;
        return row?.prefab ?? null;
      },
    });
    return {
      ...gate,
      unitId: entityId,
      found: Boolean(store.getUnit(entityId)),
      reachable: gate.plannerPath === true && gate.allowed,
      simulated: true,
      label: `${gate.source}: planner path over range math + fresh game link (${gate.gameLink}); not a measured link graph`,
    };
  };

  /**
   * Comms gate for direct test orders. It is the same rule the dispatcher
   * uses: telemetry must be fresh and the unit must be graph-reachable from a
   * control source. The graph itself comes from plugin-reported antenna state,
   * so it is labelled SIMULATED; the radio range/LOS planner is not consulted.
   */
  const gateFor = (entityId: string) => {
    const now = clock();
    const units = store.listUnits();
    const links = store.listLinks();
    const unit = units.find((u) => u.id === entityId);
    const reachable = reachableUnits(units, links, now, { sources: config.controlSources });
    return {
      unitId: entityId,
      found: Boolean(unit),
      linkStatus: unit?.linkStatus ?? null,
      lastSeenAgeMs: unit ? now - unit.lastSeen : null,
      reachable: reachable.has(entityId),
      allowed: Boolean(unit) && reachable.has(entityId),
      reason: !unit
        ? 'no plugin telemetry for this grid'
        : reachable.has(entityId)
          ? 'fresh plugin link, reachable from a control source'
          : 'link down/stale or not reachable from a control source',
      graph: { units: units.length, links: links.length, sources: config.controlSources },
      source: 'SIMULATED' as const,
      simulated: true,
      label:
        'SIMULATED: reachability uses plugin-reported antenna state + telemetry freshness, not a measured radio/LOS graph',
    };
  };

  const routes: {
    method: string;
    pattern: RegExp;
    handler: (ctx: { req: http.IncomingMessage; res: http.ServerResponse; params: string[]; url: URL }) => Promise<void> | void;
  }[] = [
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      handler: ({ res }) => {
        sendJson(res, 200, {
          ok: true,
          service: 'se-rts-backend',
          schemaVersion: 1,
          now: clock(),
          uptimeSec: Math.round((clock() - deps.startedAt) / 1000),
          killSwitch: store.isKillSwitchOn(),
          agentConnected: hub.isConnected(),
          // T74: ON unless RTS_ENV=test AND RTS_TEST_SERVER_MARKER=se-rts-test.
          // The plugin's live build has no admin code compiled in, so this flag
          // is the other half of the same rule.
          survivalMode: resolveSurvivalMode(),
          flags: store.getFlags(),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/state$/,
      handler: ({ res }) => sendJson(res, 200, snapshot()),
    },
    {
      method: 'GET',
      pattern: /^\/api\/missions$/,
      handler: ({ res, url }) => {
        const statusParam = url.searchParams.get('status');
        const statuses = statusParam
          ? statusParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const parsed = statuses?.map((s) => {
          const status = MissionStatus.safeParse(s);
          if (!status.success) throw new HttpError(400, 'invalid', `unknown mission status ${s}`);
          return status.data;
        });
        sendJson(res, 200, { missions: store.listMissions({ status: parsed, limit: 200 }) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/missions$/,
      handler: async ({ req, res }) => {
        const body = await readJson(req);
        // SHIP ROLE (owner decision 2026-11-11): the generic mission API cannot
        // be a side door around the role. PERSONAL needs the explicit
        // confirmation; BASE is never moved; OFF gets nothing at all.
        const units = Array.isArray((body as { assignedUnits?: unknown }).assignedUnits)
          ? ((body as { assignedUnits: unknown[] }).assignedUnits.filter((v): v is string => typeof v === 'string'))
          : [];
        const desired = ((body as { desiredState?: unknown }).desiredState ?? {}) as { personalConfirmed?: unknown };
        for (const gridId of units) {
          const role = shipRoles.roleOf(gridId);
          const confirm = desired.personalConfirmed === true;
          if (role === 'off') throw new HttpError(409, 'role_off', 'marked OFF in game: this grid receives no orders');
          if (role === 'base' && String((body as { type?: unknown }).type ?? '') !== 'repair') {
            throw new HttpError(409, 'role_base', 'a base is never moved');
          }
          if (role === 'personal' && !confirm) {
            throw new HttpError(409, 'personal_confirmation_required', 'this is a personal ship: confirm the order (confirmPersonal) before it is sent');
          }
        }
        const result = createMission(
          store,
          body,
          {
            now: clock(),
            actor: actorOf(req),
            autoMissionTypes: config.autoMissionTypes,
            maxQueuedBuilds: config.caps.maxQueuedBuilds,
          },
        );
        if (!result.ok) {
          throw new HttpError(
            result.code === 'cap_reached' ? 409 : result.code === 'conflict' ? 409 : 400,
            result.code,
            result.message,
            result.issues,
          );
        }
        missionEvent(result.created ? 'created' : 'deduped', result.mission);
        sendJson(res, result.created ? 201 : 200, { mission: result.mission, created: result.created });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/missions\/([^/]+)$/,
      handler: async ({ req, res, params }) => {
        const id = decodeURIComponent(params[0]!);
        const body = await readJson(req);
        const parsed = MissionPatchSchema.safeParse(body);
        if (!parsed.success) {
          throw new HttpError(400, 'invalid', 'invalid patch body', formatIssues(parsed.error));
        }
        const action = parsed.data.action ?? (parsed.data.status === 'approved' ? 'approve' : parsed.data.status === 'cancelled' ? 'cancel' : undefined);
        if (action !== 'approve' && action !== 'cancel') {
          throw new HttpError(400, 'invalid', 'only approve and cancel actions are supported');
        }
        const result =
          action === 'approve'
            ? approveMission(store, id, actorOf(req), clock())
            : cancelMission(store, id, actorOf(req), clock(), parsed.data.note);
        if (!result.ok) {
          throw new HttpError(result.code === 'not_found' ? 404 : 409, result.code, result.message);
        }
        missionEvent(action === 'approve' ? 'approved' : 'cancelled', result.mission);
        sendJson(res, 200, { mission: result.mission });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/approvals$/,
      handler: ({ res }) => {
        const pending = store
          .listMissions({ status: ['queued'], limit: 200 })
          .filter((m) => m.approval === 'approve');
        sendJson(res, 200, { approvals: pending });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/ledger$/,
      handler: ({ res }) => sendJson(res, 200, { entries: store.listLedger() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/audit$/,
      handler: ({ res, url }) => {
        const requested = Number(url.searchParams.get('limit') ?? '200');
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(2000, Math.trunc(requested))) : 200;
        // Routine poller traffic (provision:*/radio_links/laser_state/
        // list_tagged/profile results and acks) is on its own channel: it is
        // what used to make 2 000 rows a four-minute window and wipe a
        // landing's evidence. `?routine=1` asks for it explicitly.
        const routine = url.searchParams.get('routine') === '1';
        sendJson(res, 200, { entries: store.listAudit(limit, { includeRoutine: routine }), routine });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/handoff\/candidates$/,
      handler: async ({ res, url }) => {
        if (!deps.detector) {
          sendJson(res, 200, { candidates: [], gridsScanned: 0, note: 'detector not configured' });
          return;
        }
        const report = url.searchParams.get('refresh') === '1' ? await deps.detector.refresh() : deps.detector.getReport() ?? (await deps.detector.refresh());
        sendJson(res, 200, report);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/admin\/kill-switch$/,
      handler: async ({ req, res }) => {
        const body = (await readJson(req)) as { on?: unknown };
        if (typeof body.on !== 'boolean') throw new HttpError(400, 'invalid', 'body must be {on: boolean}');
        const previous = store.setKillSwitch(body.on, actorOf(req));
        broadcast('kill_switch', { on: body.on, previous });
        sendJson(res, 200, { killSwitch: body.on, previous });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/test\/gate$/,
      handler: ({ res, url }) => {
        const entityId = url.searchParams.get('entityId');
        if (!entityId) throw new HttpError(400, 'invalid', 'entityId query parameter is required');
        sendJson(res, 200, gateFor(entityId));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/test\/order$/,
      handler: async ({ req, res }) => {
        // T75: /api/test/order is the test channel's front door. A survival
        // build has no test channel, so the whole endpoint is refused before
        // the body is even validated - a 409, not a confusing plugin failure.
        if (resolveSurvivalMode()) {
          store.audit({
            actor: actorOf(req),
            action: 'survival_refused',
            subject: '/api/test/order',
            detail: { route: '/api/test/order', action: null, reason: SURVIVAL_REASON, note: 'no order was sent to the plugin' },
            at: clock(),
          });
          throw new HttpError(409, SURVIVAL_REASON, 'not available in survival build: /api/test/order is a test endpoint');
        }
        if (store.isKillSwitchOn()) throw new HttpError(409, 'kill_switch', 'kill switch is on');
        if (!hub.isConnected()) throw new HttpError(409, 'plugin_offline', 'plugin is not connected');

        const parsed = TestOrderBody.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid', 'invalid order request', formatIssues(parsed.error));
        const { orderType, entityId, params } = parsed.data;

        const gate = authorityGate(entityId);
        // SAFETY EXEMPTION (2026-11-10): a command whose only effect is to
        // slow or stop a ship is never refused by the comms gate. Measured: a
        // brake was 409'd mid-fall at 142 m / -47 m/s and the hull was
        // destroyed on the ground. Such an order can only remove energy, so
        // the gate has nothing to protect here; the bypass is audited.
        const unit = store.getUnit(entityId);
        const safetyReason = safetyOrderReason({ orderType, params, position: unit?.pos ?? null });
        if (safetyReason) {
          store.audit({
            actor: actorOf(req),
            action: 'safety_order_bypassed_gate',
            subject: entityId,
            detail: {
              orderType,
              action: (params as { action?: unknown }).action ?? null,
              reason: safetyReason,
              gate: {
                allowed: gate.allowed,
                found: gate.found,
                source: gate.source,
                gameLink: 'gameLink' in gate ? gate.gameLink : null,
                reason: gate.reason ?? null,
              },
              note: 'this order can only reduce the ship’s energy, so the comms gate never blocks it',
            },
            at: clock(),
          });
        }
        if (orderType !== 'test' && !safetyReason) {
          if (!gate.found) throw new HttpError(409, 'unit_unknown', `no telemetry for ${entityId}`);
          if (!gate.allowed) {
            throw new HttpError(409, 'comms_rejected', `${entityId} rejected by the comms gate: ${gate.reason}`, [
              `gate source ${gate.source}`,
            ]);
          }
        }

        // snap_dock destroyed the hull it docked (overnight run 2026-11-10):
        // the connect geometry ignores hull depth. Until that is fixed the
        // flag stays OFF and the backend refuses to put the order on the wire.
        const docking = snapDockDecision(store, params);
        if (docking.refused) {
          store.audit({
            actor: actorOf(req),
            action: 'snap_dock_refused',
            subject: `${entityId}`,
            detail: {
              orderType,
              entityId,
              flag: docking.flag,
              flagOn: docking.flagOn,
              reason: docking.reason,
              note: 'no order was sent to the plugin',
            },
            at: clock(),
          });
          throw new HttpError(409, 'flag_off', docking.reason ?? 'snap_dock is disabled', [
            `feature flag ${docking.flag} is OFF`,
            'snap_dock destroyed the source hull on 2026-11-10; the backend will not send it',
          ]);
        }

        const orderId = `ord-${randomUUID()}`;
        const frame = {
          schemaVersion: 1,
          type: 'order',
          orderId,
          orderType,
          entityId,
          params,
          tick: 0,
          issuedAt: clock(),
          expiresAt: clock() + 30_000,
        };
        if (!hub.send(frame)) throw new HttpError(502, 'send_failed', 'plugin socket refused the order');
        store.audit({
          actor: actorOf(req),
          action: 'test_order_sent',
          subject: orderId,
          detail: { orderType, entityId, params, gate, note: parsed.data.note ?? null },
          at: clock(),
        });
        sendJson(res, 200, {
          orderId,
          sent: true,
          orderType,
          entityId,
          commsGate: gate,
          safetyBypass: safetyReason
            ? { exempt: true, reason: safetyReason, gateAllowed: gate.allowed }
            : null,
          labels: orderType === 'test' ? ['SIMULATED_GATE_NOT_APPLICABLE'] : ['SIMULATED'],
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/admin\/flags\/([^/]+)$/,
      handler: async ({ req, res, params }) => {
        const name = decodeURIComponent(params[0]!);
        const body = (await readJson(req)) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'invalid', 'body must be {enabled: boolean}');
        store.setFlag(name, body.enabled, actorOf(req));
        broadcast('flag', { name, enabled: body.enabled });
        sendJson(res, 200, { flags: store.getFlags() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/desired$/,
      handler: async ({ req, res }) => {
        const body = (await readJson(req)) as Record<string, unknown>;
        const id = String(body.id ?? '').trim();
        if (!id) throw new HttpError(400, 'invalid', 'desired entry needs an id');
        const entry = store.upsertDesired({
          id,
          spec: String(body.spec ?? ''),
          station: String(body.station ?? ''),
          count: Number(body.count ?? 0),
          formation: String(body.formation ?? 'none'),
          budget: (body.budget as never) ?? null,
          enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        });
        broadcast('desired', { entry });
        sendJson(res, 200, { desired: entry });
      },
    },
    // ---------------------------------------------------------------- planning
    // Every /api/plan route is pure computation over the request body plus the
    // read-only planet snapshot. Nothing here writes state or talks to a game.
    {
      method: 'GET',
      pattern: /^\/api\/plan\/config$/,
      handler: ({ res }) => {
        sendJson(res, 200, { linkModel: LINK_MODEL_DEFAULTS, note: 'assumptions are UNVERIFIED where the game is the authority; see docs/reality-check.md' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/plan\/planets$/,
      handler: ({ res }) => sendJson(res, 200, { planets: loadPlanetCatalog() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/plan\/templates$/,
      handler: ({ res }) => sendJson(res, 200, { presets: presetTemplateNames() }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/plan\/chain$/,
      handler: async ({ req, res }) => {
        const parsed = PlanChainBodySchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid', 'invalid chain request', formatIssues(parsed.error));
        const body = parsed.data;
        const catalog = body.planets ?? loadPlanetCatalog();
        const from = findPlanet(catalog, body.from);
        const to = findPlanet(catalog, body.to);
        if (!from || !to) {
          throw new HttpError(400, 'invalid', `unknown planet ${!from ? body.from : body.to}`);
        }
        const template = body.template ?? resolveTemplate(body.templateId ?? 'radio-50km');
        sendJson(res, 200, planChain(from, to, template, {
          planets: catalog,
          config: body.config,
          maxSpacingM: body.maxSpacingM,
        }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/plan\/coverage$/,
      handler: async ({ req, res }) => {
        const parsed = PlanCoverageBodySchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid', 'invalid coverage request', formatIssues(parsed.error));
        const body = parsed.data;
        const catalog = body.planets ?? loadPlanetCatalog();
        const planet = body.planet ? findPlanet(catalog, body.planet) : undefined;
        if (body.planet && !planet) throw new HttpError(400, 'invalid', `unknown planet ${body.planet}`);
        const region = body.region ?? (planet ? planetRegion(planet) : undefined);
        if (!region) throw new HttpError(400, 'invalid', 'coverage needs planet or region');
        const template = body.template ?? resolveTemplate(body.templateId ?? 'radio-50km');
        sendJson(res, 200, planCoverage(region, template, {
          k: body.k ?? 1,
          altitudeM: body.altitudeM,
          reuseExisting: body.reuseExisting,
          config: body.config,
          maxSpacingM: body.maxSpacingM,
        }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/plan\/graph$/,
      handler: async ({ req, res }) => {
        const parsed = PlanGraphBodySchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid', 'invalid graph request', formatIssues(parsed.error));
        const body = parsed.data;
        sendJson(res, 200, linkGraph(body.nodes, body.planets ?? [], body.config));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/plan\/what-if$/,
      handler: async ({ req, res }) => {
        const parsed = PlanWhatIfBodySchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid', 'invalid what-if request', formatIssues(parsed.error));
        const body = parsed.data;
        sendJson(res, 200, whatIfRemove(body.nodeId, body.nodes, body.planets ?? [], body.config));
      },
    },
  ];

  // Demo routes are appended only when RTS_DEMO=1 and the test-server lock is
  // satisfied; resolveDemoEnv throws at startup otherwise (no silent fallback).
  routes.push(...demoRoutesFor({ config, store, hub, stateHub, clock, executor: deps.executor, power: deps.power ?? null, alerts: deps.alerts ?? null, survival: deps.survival ?? null, players: deps.players ?? null }));
  // T14: GET-only world-geometry proxy to the TEST-world telemetry instance.
  // The demo routes are the only consumers; both are locked to the test env.
  if (demoEnv) routes.push(...worldProxyRoutesFor());
  // T6 admin designer (same test-env lock, token, kill switch and audit).
  routes.push(...designerRoutesFor({ config, store, hub, stateHub, clock, executor: deps.executor }));
  // Auto-provisioning of owner-tagged grids ([HERMES-BASE] / [HERMES-TEST]).
  // T9 naming rides on the same 10 s scan (no second list_tagged call) and has
  // its own GET/POST surface plus the laser link test.
  const namingOnGrids = namingSyncHook({ config, store, hub, clock });
  routes.push(...provisionRoutesFor({ config, store, hub, clock, onGrids: namingOnGrids }));
  routes.push(...namingRoutesFor({ config, store, hub, clock }));
  if (process.env.RTS_DEMO === '1') startProvisioner({ config, store, hub, clock, onGrids: namingOnGrids });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        // Any write invalidates the cached /api/demo/state: a mutation must
        // never be masked by the 1 s read cache.
        if (req.method !== 'GET') invalidateDemoStateCache(deps);
        // Same-origin demo site at /demo/ (public shell; API calls need the token).
        if (process.env.RTS_DEMO === '1' && serveDemoStatic(req, res, url)) return;
        const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!route) {
          throw new HttpError(404, 'not_found', `no route for ${req.method} ${url.pathname}`);
        }
        if (!authorized(req, config)) {
          res.setHeader('www-authenticate', 'Bearer');
          throw new HttpError(401, 'unauthorized', 'bearer token required');
        }
        const params = route.pattern.exec(url.pathname)?.slice(1) ?? [];
        await route.handler({ req, res, params, url });
      } catch (err) {
        if (err instanceof DemoHttpError) {
          sendJson(res, err.status, { error: { code: err.code, message: err.message, hint: err.hint, issues: err.issues } });
        } else if (err instanceof HttpError) {
          sendJson(res, err.status, {
            error: { code: err.code, message: err.message, hint: hintForCode(err.code), issues: err.issues },
          });
        } else {
          sendJson(res, 500, {
            error: { code: 'internal', message: err instanceof Error ? err.message : 'unexpected error' },
          });
        }
      }
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/plugin') {
      hub.handleUpgrade(req, socket, head);
    } else if (url.pathname === '/ws') {
      stateHub.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  return server;
}
