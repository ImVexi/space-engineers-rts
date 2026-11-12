import type { AckMessage, EventMessage, HelloMessage, StatusMessage, TelemetryMessage, TestMessage } from '@se-rts/schemas';
import { openDb, type Db } from './db.js';
import { Store } from './store.js';
import { FEATURE_FLAGS, type Config } from './config.js';
import { Dispatcher, type OrderSender } from './dispatcher.js';
import { Reconciler } from './reconciler.js';
import { PluginHub, StateHub } from './pluginHub.js';
import { buildSnapshot } from './state.js';
import { createHttpServer } from './server.js';
import { normaliseLinks } from './comms.js';
import { DetectorService } from './detector/saveDetector.js';
import { DemoExecutor } from './demo/executor.js';
import { PowerPoller } from './demo/power/index.js';
import { AlertsService } from './demo/alerts/index.js';
import { SurvivalService } from './demo/survival/index.js';
import { applyTune, previewTune, readPins } from './demo/autotune/index.js';
import { SimSpeedMonitor } from './demo/simSpeed.js';
import { readDesignerSettings } from './demo/designer/settings.js';
import { resolveDemoEnv } from './demo/env.js';
import { PlayerTracker } from './demo/players/index.js';
import { isRoutineOrderId, loadProfiles, requestProvisionPass, requestProvisionPassForAck, requestProvisionPassForGrid, callPlugin } from './demo/provision/provisioner.js';
import { shipRoles } from './demo/roles.js';
import { buildOwnerPolicy, isLiveInstance, parseOwnerSteamIds, type OwnerPolicy } from './demo/ownership.js';
import { orderResults } from './orderResults.js';
import type http from 'node:http';

/**
 * One telemetry grid -> the unit row the store keeps.
 *
 * Extracted (and exported) so the landing tests can push a REAL telemetry
 * message through the same mapping the hub uses. `meta` is a whitelist, and
 * that whitelist dropping `keelDepthM`/`keelSource` is why every in-game
 * landing audit read `keelM:0, keelSource:'none'` while the plugin was sending
 * the hull geometry every frame (measured 2026-11-10, run B).
 */
export function telemetryUnitRecord(grid: TelemetryMessage['grids'][number], at: number, tick: number) {
  return {
    id: grid.gridId,
    name: grid.name,
    specId: grid.specId ?? null,
    station: grid.onStation ?? null,
    linkStatus: grid.link,
    lastSeen: at,
    pos: grid.pos ?? null,
    vel: grid.vel ?? null,
    meta: {
      massKg: grid.massKg ?? null,
      powerFraction: grid.powerFraction ?? null,
      fuelFraction: grid.fuelFraction ?? null,
      batteryPct: grid.batteryPct ?? null,
      h2Pct: grid.h2Pct ?? null,
      solarOutputMw: grid.solarOutputMw ?? null,
      solarMaxMw: grid.solarMaxMw ?? null,
      health: grid.health ?? null,
      // Hull geometry: the reported position is the PIVOT, so AGL from it is
      // not the hull's clearance. These three must reach `meta` or every ground
      // rule falls back to a 0 m keel.
      ...(grid.keelDepthM !== undefined ? { keelDepthM: grid.keelDepthM } : {}),
      ...(grid.keelSource !== undefined ? { keelSource: grid.keelSource } : {}),
      ...(grid.hullBottom !== undefined ? { hullBottom: grid.hullBottom } : {}),
      // Measured attitude rate (2026-11-11 flight set 6): the pre-handover
      // settle waits on `spinDegS`, and `land_at` refuses a start on the same
      // sample. Without it in the whitelist the executor can only guess.
      ...(grid.spinDegS !== undefined ? { spinDegS: grid.spinDegS } : {}),
      ...(grid.angularVelocity !== undefined ? { angularVelocity: grid.angularVelocity } : {}),
      // T61 passenger rule: pilot / passengers / standing players per grid. The
      // backend stops sending orders only for a real pilot, and flies a
      // passenger-carrying grid under passenger limits; without this in the
      // whitelist the classification never reaches the executor.
      ...(grid.control !== undefined ? { control: grid.control } : {}),
      tick,
    } as Record<string, unknown>,
  };
}

export interface RuntimeOptions {
  config: Config;
  /** Override the DB file (tests use a temp file to prove restart safety). */
  dbPath?: string;
  memory?: boolean;
  clock?: () => number;
  detector?: DetectorService;
}

export interface Runtime {
  config: Config;
  db: Db;
  store: Store;
  hub: PluginHub;
  stateHub: StateHub;
  dispatcher: Dispatcher;
  reconciler: Reconciler;
  executor: DemoExecutor | null;
  /** T79 flight gate; null outside the demo env. */
  simSpeed: SimSpeedMonitor | null;
  /** T20 power poller; null outside the demo env. */
  power: PowerPoller | null;
  /** T61 player tracker (also outside the demo env: it only reads telemetry). */
  players: PlayerTracker;
  /** T68 alerts engine; null outside the demo env. */
  alerts: AlertsService | null;
  /** T66 survival loop (return-home, NEEDS_REFUEL, owner-approved relaunch). */
  survival: SurvivalService | null;
  detector: DetectorService;
  server: http.Server;
  startedAt: number;
  /** T79: feed one telemetry frame through the same handler the hub runs. */
  ingestTelemetry: (msg: TelemetryMessage) => void;
  listen: (port?: number) => Promise<number>;
  startLoops: () => void;
  stopLoops: () => void;
  close: () => Promise<void>;
  snapshot: () => Record<string, unknown>;
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { config } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const db = openDb(opts.dbPath ?? config.dbPath, { memory: opts.memory });
  const store = new Store(db, clock);
  store.ensureFlags(FEATURE_FLAGS, config.flags);

  const detector =
    opts.detector ??
    new DetectorService({
      sbsPath: config.detector.sbsPath,
      sbcPath: config.detector.sbcPath,
      owner: config.owner,
      clock,
    });

  // T61: player positions. Constructed before the hub so the telemetry
  // callback can ingest into it; reads/writes only the DB and memory.
  const players = new PlayerTracker(store, clock);

  // T79 live ownership. On the owner's shared world a non-OFF role additionally
  // requires the grid's big owner to be a configured owner identity or in his
  // faction. The Steam ids come from `RTS_OWNER_STEAM_IDS` (default: the owner); the
  // identities/faction tags are resolved from the players telemetry the plugin
  // already sends (plus the provisioner's owner identity), rebuilt lazily so a
  // friend added later is picked up once he has been observed.
  //
  // The TEST instance installs no policy: its existing owner-identity rule and
  // everything else stay exactly as they were.
  if (isLiveInstance()) {
    const identityForSteam = (steamId: string): string | null => {
      try {
        const row = store.db
          .prepare('SELECT identity_id FROM players WHERE steam_id = ? ORDER BY last_seen_at DESC LIMIT 1')
          .get(steamId) as { identity_id: string } | undefined;
        return row?.identity_id ?? null;
      } catch {
        return null;
      }
    };
    const factionTagForSteam = (steamId: string): string | null => {
      try {
        const row = store.db
          .prepare(
            'SELECT faction_tag FROM players WHERE steam_id = ? AND faction_tag IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
          )
          .get(steamId) as { faction_tag: string | null } | undefined;
        return row?.faction_tag ?? null;
      } catch {
        return null;
      }
    };
    let policy: OwnerPolicy | null = null;
    let policyAt = Number.NEGATIVE_INFINITY;
    shipRoles.configureOwnerPolicy(() => {
      const now = clock();
      if (policy && now - policyAt < 30_000) return policy;
      let extraIds: string[] = [];
      try {
        const profiles = loadProfiles();
        if (parseOwnerSteamIds().includes(profiles.owner.steamId)) extraIds = [profiles.owner.identityId];
      } catch {
        // profiles.json unreadable: the players lookup is still authoritative.
      }
      policy = buildOwnerPolicy(process.env, { identityForSteam, factionTagForSteam }, { identityIds: extraIds });
      policyAt = now;
      return policy;
    });
  }

  let hub: PluginHub;
  const sender: OrderSender = {
    send: (message) => (hub ? hub.send(message) : false),
    isConnected: () => (hub ? hub.isConnected() : false),
    agentId: () => (hub ? hub.agentId() : null),
  };

  const dispatcher = new Dispatcher(
    store,
    sender,
    {
      maxAttempts: config.caps.maxOrderAttempts,
      backoffMs: config.caps.orderBackoffMs,
      maxOrdersPerMinute: config.caps.maxOrdersPerMinute,
      comms: { sources: config.controlSources },
      enabled: () => store.getFlags().dispatch === true,
    },
    clock,
  );

  const reconciler = new Reconciler(
    store,
    {
      minIntervalMs: config.caps.minReconcileIntervalMs,
      maxQueuedBuilds: config.caps.maxQueuedBuilds,
      autoMissionTypes: config.autoMissionTypes,
      enabled: () => store.getFlags().reconciler === true,
    },
    clock,
  );

  // Demo executor exists only when the demo routes are enabled (test env lock);
  // the demo_execute flag decides whether a tick sends anything.
  const demoEnv = resolveDemoEnv();
  let executor: DemoExecutor | null = null;
  let simSpeed: SimSpeedMonitor | null = null;
  let power: PowerPoller | null = null;
  let alerts: AlertsService | null = null;
  let survival: SurvivalService | null = null;

  let stateHub: StateHub;
  const snapshot = () => buildSnapshot({ config, store, hub, startedAt, clock });
  stateHub = new StateHub({ token: config.token, snapshot });
  /**
   * Grid ids ever seen in telemetry. The first sighting of a grid is what asks
   * provisioning for an immediate pass (sim-speed audit #3); the 30 s steady
   * cadence would otherwise leave a new hull unconfigured for half a minute.
   */
  const seenGridIds = new Set<string>();

  /**
   * One telemetry frame, from the plugin hub or a test.
   *
   * Extracted from the hub callback so a booted runtime can be fed a real frame
   * (the live sim-speed proof needs exactly that: no WebSocket plugin, a frame
   * carrying `simRatio`, and the flight gate read back from `executions`).
   */
  const handleTelemetry = (msg: TelemetryMessage): void => {
    const at = msg.at ?? clock();
    // T61: online characters for the map (ids stay strings). The tracker also
    // keeps each identity's last-known position/time in the DB.
    players.ingest(msg.players ?? [], at);
    for (const grid of msg.grids) {
      store.upsertUnit(telemetryUnitRecord(grid, at, msg.tick));
      // Sim-speed audit #3: a grid we have never scanned needs its config and
      // roles applied now, not at the end of the 30 s tick.
      if (!seenGridIds.has(grid.gridId)) {
        seenGridIds.add(grid.gridId);
        requestProvisionPassForGrid(grid.gridId);
      }
    }
    // T79: the frame's `simRatio` is the LIVE server's SimSpeed source - the
    // Remote API is disabled there, so the 5 s sampler has nothing to poll.
    // Ingested here, on the frame, so the flight gate reacts at telemetry
    // cadence; a frame whose read failed (`value: null`) changes nothing.
    const ratio = msg.simRatio;
    if (ratio) {
      const raw = ratio.value ?? ratio.simulationRatio ?? ratio.serverSimulationRatio;
      const value = Number(raw);
      if (raw !== null && raw !== undefined && Number.isFinite(value)) {
        simSpeed?.observeTelemetry(value, ratio.sampledAt ?? at);
      }
    }
    // Sun direction is engine state, not a per-grid field; keep the latest
    // sample where the readout endpoints can see it (T9).
    if (msg.sun || msg.sunState) {
      store.setKv('telemetry:sun', JSON.stringify({ sun: msg.sun ?? null, state: msg.sunState ?? null, at }));
    }
    store.replaceLinks(hub.agentId() ?? 'unknown', normaliseLinks(msg.links), at);
    // T61: when the server reports nobody online, that is the answer - do not
    // leave an older "players" reading standing as if it were live.
    store.setKv(
      'telemetry:players',
      JSON.stringify({ count: (msg.players ?? []).length, at, state: msg.playersState ?? null }),
    );
    stateHub.broadcast({
      type: 'telemetry',
      at,
      tick: msg.tick,
      grids: msg.grids.length,
      contacts: msg.contacts.length,
      links: msg.links.length,
    });
  };

  hub = new PluginHub({
    token: config.token,
    testApiEnabled: () => store.getFlags().test_api === true,
    callbacks: {
      onHello: (hello: HelloMessage) => {
        store.audit({
          actor: 'plugin',
          action: 'plugin_hello',
          subject: hello.agentId,
          detail: { serverId: hello.serverId, version: hello.version, capabilities: hello.capabilities },
          at: clock(),
        });
        stateHub.broadcast({ type: 'agent', at: clock(), agent: hello.agentId, state: 'connected' });
        // Sim-speed audit #3: a reconnect means everything the provisioner knew
        // may be stale (the plugin was restarted). One immediate pass, not a
        // shortened cadence.
        requestProvisionPass('plugin reconnect');
      },
      onTelemetry: (msg: TelemetryMessage) => handleTelemetry(msg),
      onEvent: (msg: EventMessage) => {
        // A poller order's result (`provision:*`) is routine traffic: recorded
        // on the routine channel (the order-result lookups read it), never in
        // the business audit where a landing's evidence lives.
        const orderId = (msg.data as { orderId?: unknown } | undefined)?.orderId;
        const routine = msg.eventType === 'order_result' && isRoutineOrderId(orderId);
        store.audit({
          actor: 'plugin',
          action: 'plugin_event',
          subject: msg.entityId ?? 'plugin',
          detail: { eventType: msg.eventType, data: msg.data, at: msg.at },
          at: clock(),
          routine,
        });
        // Sim-speed audit #7: hand the result body to the waiter in memory, on
        // this tick, instead of letting every poller rescan the audit table.
        if (msg.eventType === 'order_result') {
          const data = msg.data as
            | { orderId?: string; ok?: boolean; error?: string; result?: Record<string, unknown> }
            | undefined;
          if (data?.orderId) {
            orderResults.record(
              data.orderId,
              { ok: data.ok !== false, result: data.result, error: data.error },
              clock(),
            );
          }
        }
        stateHub.broadcast({ type: 'event', at: msg.at, event: msg.eventType, entityId: msg.entityId });
      },
      onAck: (msg: AckMessage) => {
        dispatcher.onAck(msg.orderId, msg.ok, msg.error, clock());
        stateHub.broadcast({ type: 'ack', at: msg.at, orderId: msg.orderId, ok: msg.ok });
        // Sim-speed audit #3: an owner/executor order was just executed on a
        // grid, so config/roles for that grid must be current before the next
        // one. Routine poller orders do not count (their acks used to re-run
        // `list_tagged` every 5 s on the test world).
        requestProvisionPassForAck(msg.orderId);
      },
      onStatus: (msg: StatusMessage) => {
        store.setKv('plugin_status', JSON.stringify(msg));
        stateHub.broadcast({ type: 'plugin_status', at: clock(), status: msg });
      },
      onTest: (msg: TestMessage) => {
        store.audit({
          actor: 'plugin',
          action: 'plugin_test',
          subject: msg.action,
          detail: msg.params,
          at: clock(),
        });
      },
      onProtocolError: (detail) => {
        store.audit({
          actor: 'plugin',
          action: 'plugin_protocol_error',
          subject: 'plugin',
          detail,
          at: clock(),
        });
      },
    },
  });

  // Constructed after the hub exists: the executor sends through it.
  simSpeed = demoEnv
    ? new SimSpeedMonitor({
        envPath: config.demo.simSpeedEnvPath,
        min: config.demo.simSpeedMin,
        sampleMs: config.demo.simSpeedSampleMs,
        holdMs: config.demo.simSpeedHoldMs,
        clock,
        // Owner-editable in the T6 admin panel; the monitor reads it live.
        threshold: () => readDesignerSettings(store).simSpeedMin,
        // T79: the live server has RemoteApiEnabled=false, so the Remote API
        // read above has no source there. Ask the plugin for the game's own
        // simulation ratio instead (the `action` channel, read-only). The test
        // server still uses its Remote API sample first.
        pluginSample: async () => {
          try {
            const hit = await callPlugin({ config, store, hub, clock }, 'sim_ratio', {}, 10_000);
            const result = hit.result ?? {};
            const raw = result.simulationRatio ?? result.value;
            const value = Number(raw);
            return Number.isFinite(value) ? value : null;
          } catch {
            return null;
          }
        },
      })
    : null;
  if (demoEnv) {
    // T20: read-only profile poll for power/fuel telemetry. It only sends the
    // `profile` action, never a command, so it is safe to run next to the
    // executor and to leave enabled while ships are piloted by hand.
    power = new PowerPoller({ store, hub, clock });
    executor = new DemoExecutor({
      store,
      hub,
      config,
      clock,
      fixturePath: demoEnv.fixturePath,
      ...(simSpeed ? { simSpeed } : {}),
      // T27: the power poll snapshot carries `control.underControl`, so the
      // executor can spot a hand-piloted grid without one extra order.
      ...(power ? { power } : {}),
    });
    simSpeed?.start();
    // T68: one evaluator over the collectors above. It runs on the power
    // poller's 30 s pass and on demand; delivery is audited and, only when a
    // webhook is configured, sent to Discord.
    alerts = new AlertsService({
      store,
      clock,
      fixturePath: demoEnv.fixturePath,
      power,
      executor,
      simSpeed,
      pluginConnected: () => hub.isConnected(),
    });
    if (power) power.onTick = (now) => void alerts?.tick(now);
    // T66: reads the poller's cached snapshots on its own 30 s pass and starts
    // returns through the executor's normal mission path. It sends no order of
    // its own, so it cannot bypass the role or comms gates.
    survival = new SurvivalService({
      store,
      clock,
      power,
      executor,
      fixturePath: demoEnv.fixturePath,
    });
  }

  const server = createHttpServer({
    config,
    store,
    hub,
    stateHub,
    reconciler,
    dispatcher,
    detector,
    executor: executor ?? undefined,
    power,
    alerts,
    survival,
    players,
    startedAt,
    clock,
  });

  let timers: NodeJS.Timeout[] = [];
  let autoTuneTimer: NodeJS.Timeout | null = null;
  let autoTuneBusy = false;

  const startLoops = () => {
    if (timers.length) return;
    // Heartbeat: the plugin's safe mode trips after `safeModeAfterSec` of
    // backend silence, and a quiet backend would otherwise block every order
    // 60 s after the hello. A status frame every 20 s is also a liveness check.
    {
      const t = setInterval(() => {
        try {
          if (!hub.isConnected()) return;
          hub.send({
            schemaVersion: 1,
            type: 'status',
            hubState: 'ready',
            queueDepth: 0,
            note: 'heartbeat',
          });
        } catch {
          /* hub handles its own errors */
        }
      }, 20_000);
      t.unref?.();
      timers.push(t);
    }
    // Timers always exist; the feature-flag gates inside the reconciler and
    // dispatcher decide whether a tick does anything, so toggling a flag at
    // runtime takes effect without a restart.
    {
      const t = setInterval(() => {
        try {
          reconciler.cycle();
        } catch (err) {
          store.audit({
            actor: 'reconciler',
            action: 'reconcile_error',
            subject: 'cycle',
            detail: { error: err instanceof Error ? err.message : String(err) },
            at: clock(),
          });
        }
      }, config.tickMs.reconcile);
      t.unref?.();
      timers.push(t);
    }
    {
      const t = setInterval(() => {
        try {
          dispatcher.cycle(clock());
        } catch (err) {
          store.audit({
            actor: 'dispatcher',
            action: 'dispatch_error',
            subject: 'cycle',
            detail: { error: err instanceof Error ? err.message : String(err) },
            at: clock(),
          });
        }
      }, config.tickMs.dispatch);
      t.unref?.();
      timers.push(t);
    }
    if (store.getFlags().detector) {
      detector.start(config.detector.refreshMs);
    }
    executor?.start();
    power?.start();
    alerts?.start();
    survival?.start();
    // T29 auto mode: OFF by default (manual apply on the test server). When
    // RTS_AUTOTUNE_AUTO_MS is set, re-tune on a timer; every write is audited.
    const autoTuneMs = Number(process.env.RTS_AUTOTUNE_AUTO_MS ?? 0);
    if (demoEnv && Number.isFinite(autoTuneMs) && autoTuneMs >= 60_000) {
      autoTuneTimer = setInterval(async () => {
        if (autoTuneBusy || !hub.isConnected() || store.isKillSwitchOn()) return;
        autoTuneBusy = true;
        try {
          const plan = previewTune({ store, fixturePath: demoEnv.fixturePath, power, clock });
          if (plan.changes.length === 0) return;
          const result = await applyTune({ store, hub, clock }, plan, { pins: readPins(store) });
          for (const row of result.applied) {
            store.audit({
              actor: 'autotune',
              action: 'demo_autotune_auto',
              subject: row.gridId,
              detail: { fromM: row.fromM, toM: row.toM, drawDropMw: row.drawDropMw },
              at: clock(),
            });
          }
        } catch (err) {
          store.audit({
            actor: 'autotune',
            action: 'demo_autotune_error',
            subject: 'auto',
            detail: { error: err instanceof Error ? err.message : String(err) },
            at: clock(),
          });
        } finally {
          autoTuneBusy = false;
        }
      }, autoTuneMs);
      autoTuneTimer.unref?.();
    }
  };

  const stopLoops = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    detector.stop();
    executor?.stop();
    power?.stop();
    alerts?.stop();
    survival?.stop();
    if (autoTuneTimer) clearInterval(autoTuneTimer);
    autoTuneTimer = null;
    simSpeed?.stop();
  };

  const listen = (port = config.port) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, config.bind, () => {
        server.removeListener('error', reject);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });

  const close = async () => {
    stopLoops();
    await stateHub.close();
    await hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    store.close();
  };

  return {
    config,
    db,
    store,
    hub,
    stateHub,
    dispatcher,
    reconciler,
    executor,
    simSpeed,
    power,
    players,
    alerts,
    survival,
    detector,
    server,
    startedAt,
    ingestTelemetry: handleTelemetry,
    listen,
    startLoops,
    stopLoops,
    close,
    snapshot,
  };
}
