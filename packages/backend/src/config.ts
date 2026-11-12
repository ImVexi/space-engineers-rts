import { isIP } from 'node:net';
import path from 'node:path';
import { DEFAULT_SPEED_LIMIT_MPS, normalizeSpeedLimitMps } from './demo/safety.js';
import { LANDING_HANDOVER_AGL_M } from './demo/flight.js';

/**
 * All new capabilities ship behind feature flags, default OFF. The operator
 * enables them explicitly (RTS_FLAGS=reconciler,dispatch).
 */
export const FEATURE_FLAGS = ['reconciler', 'dispatch', 'plugin_orders', 'detector', 'test_api', 'demo_execute'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export interface Config {
  bind: string;
  port: number;
  token: string;
  dbPath: string;
  dataDir: string;
  flags: Record<FeatureFlag, boolean>;
  caps: {
    /** Hard cap on open build missions in the queue. */
    maxQueuedBuilds: number;
    /** Hard cap on orders created per rolling minute. */
    maxOrdersPerMinute: number;
    /** Minimum gap between reconciler missions for the same desired entry. */
    minReconcileIntervalMs: number;
    /** Retry cap per order (first send included). */
    maxOrderAttempts: number;
    /** Backoff base for order retries, ms. */
    orderBackoffMs: number;
  };
  /** Mission types explicitly allowed to skip approval. Shipped default: none. */
  autoMissionTypes: string[];
  owner: { steamId: string; identityNames: string[] };
  detector: { sbsPath: string; sbcPath: string; refreshMs: number };
  /** Units the comms graph treats as control sources (antennas/stations). */
  controlSources: string[];
  tickMs: { reconcile: number; dispatch: number };
  /** DemoS executor limits (T5). Only read when the demo is enabled. */
  demo: {
    /**
     * Cruise cap for a flight leg, m/s. Default 100 (SE autopilot maximum);
     * clamped to 1..100 because the Remote Control ignores higher values.
     * Override with RTS_DEMO_SPEED_MPS.
     */
    speedLimitMps: number;
    maxDronesPerMission: number;
    maxActiveStandIns: number;
    /**
     * How many drones may climb (be `en_route`) under a move order at once.
     * 0 disables the cap. Clamped to the designer `maxActive` setting.
     */
    maxClimbConcurrent: number;
    /** Compressed leg length for the scaled live demo, metres. */
    legM: number;
    tickMs: number;
    gateFreshMs: number;
    /** Owner's flight rule: no new flight orders below this SimSpeed (0.95). */
    simSpeedMin: number;
    simSpeedSampleMs: number;
    /** Sustained-low window that counts as "stop" (30 s). */
    simSpeedHoldMs: number;
    /** Spawn altitude above the surface for gravity/ion hulls, metres. */
    spawnAglM: number;
    /** Lower spawn altitude used for gravity-capable hulls, metres. */
    gravitySpawnAglM: number;
    /** Orbital spawn altitude above the surface, metres. Measured on the test
     * server 2026-11-09: gravity is still 9.8 m/s2 at 20 km AGL (the Eradicator
     * falls), 0.67 m/s2 at 40 km, where ion thrust holds it. */
    orbitAglM: number;
    /** Opt-in gravity hull for atmospheric slots; null keeps the planned hull. */
    gravityHull: string | null;
    /** Keep healthy holding drones on mission end instead of deleting them. */
    leaveHolding: boolean;
    /** Refuse to start a demo run when more live grids than this exist. */
    maxGridsBeforeRun: number;
    /** File holding the SE Remote API host/port/key for SimSpeed samples. */
    simSpeedEnvPath: string;
    /** T19 station mode: park a relay as a static grid once it is really holding. */
    station: {
      enabled: boolean;
      afterMs: number;
      maxSpeedMps: number;
      /** Up to this speed the plugin zeroes the drift before converting. */
      zeroSpeedMps: number;
      minAglM: number;
    };
    /** Telemetry grids unseen for longer than this are archived (default 6 h).
     * The plugin keeps a row per entity id ever seen; without this the map
     * fills with hundreds of phantom ships from earlier sessions. */
    archivedAfterMs: number;
    /**
     * Height above the true ground (HULL BOTTOM) at which the backend hands a
     * landing to the final-descent mechanism, m. The backend owns the fall and
     * the brake down to here; below it either its own dampener pulses fly the
     * ship (default) or a plugin that advertises `land_controller` does.
     * Override with RTS_DEMO_HANDOVER_AGL; clamped to 20..2000.
     */
    landingHandoverAglM: number;
    /**
     * Come to me: the hover an autopilot parks beside a player for a manual
     * landing. `timeoutMs` only raises an info alert - the ship keeps hovering.
     */
    comeToMe: {
      /** Default horizontal offset from the player, m (min 25, max 180). */
      lateralM: number;
      /** Default HULL-BOTTOM height above true ground at the hover, m. */
      aboveGroundM: number;
      /** Nobody took control after this long: info alert, keep hovering. */
      timeoutMs: number;
    };
  };
}

/**
 * No owner is assumed. The operator sets RTS_OWNER_STEAM_ID (and optionally
 * RTS_OWNER_IDENTITIES) or plugin.json's ownerSteamIds; without it the backend
 * warns at startup and treats every grid as not owned, so nothing is automated.
 */
export const DEFAULT_OWNER = {
  steamId: '',
  identityNames: [] as string[],
};

/** Local save copy used by the read-only handoff detector when RTS_SAVE_DIR is unset. */
export const DEFAULT_SAVE_DIR = path.resolve('data', 'save');

function parseFlags(raw: string | undefined): Record<FeatureFlag, boolean> {
  const enabled = new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out = {} as Record<FeatureFlag, boolean>;
  for (const flag of FEATURE_FLAGS) out[flag] = enabled.has(flag);
  return out;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isLoopbackBind(bind: string): boolean {
  if (bind === 'localhost') return true;
  const family = isIP(bind);
  if (family === 4) return bind.startsWith('127.');
  if (family === 6) return bind === '::1' || bind === '0:0:0:0:0:0:0:1';
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = env.RTS_BIND?.trim() || '127.0.0.1';
  const token = env.RTS_TOKEN?.trim() || '';
  const dataDir = path.resolve(env.RTS_DATA_DIR?.trim() || 'data');

  // Hard rule: control endpoints are never published. Non-loopback requires a
  // bearer token on every route and WebSocket; without one we refuse to start.
  if (!isLoopbackBind(bind) && token.length < 16) {
    throw new Error(
      `refusing to bind ${bind}: non-loopback binds require RTS_TOKEN (>=16 chars) so every route and WS is authenticated`,
    );
  }

  const saveDir = env.RTS_SAVE_DIR?.trim() || DEFAULT_SAVE_DIR;

  const flags = parseFlags(env.RTS_FLAGS);
  // demo_execute ships OFF. The test env config turns it on: execution only
  // exists together with the demo routes, which are themselves hard-locked to
  // the test server. An explicit RTS_FLAGS entry always wins.
  if (env.RTS_DEMO === '1' && env.RTS_ENV === 'test' && !/demo_execute/.test(env.RTS_FLAGS ?? '')) {
    flags.demo_execute = true;
  }

  return {
    bind,
    port: Number(env.RTS_PORT ?? 8761),
    token,
    dataDir,
    dbPath: path.resolve(env.RTS_DB_PATH?.trim() || path.join(dataDir, 'rts.db')),
    flags,
    caps: {
      maxQueuedBuilds: Number(env.RTS_MAX_QUEUED_BUILDS ?? 8),
      maxOrdersPerMinute: Number(env.RTS_MAX_ORDERS_PER_MIN ?? 60),
      minReconcileIntervalMs: Number(env.RTS_RECONCILE_MIN_INTERVAL_MS ?? 5000),
      maxOrderAttempts: 3,
      orderBackoffMs: Number(env.RTS_ORDER_BACKOFF_MS ?? 500),
    },
    // Approval defaults to 'approve'. Only an operator env var can change it.
    autoMissionTypes: parseList(env.RTS_AUTO_MISSION_TYPES),
    owner: {
      steamId: env.RTS_OWNER_STEAM_ID?.trim() || DEFAULT_OWNER.steamId,
      identityNames: parseList(env.RTS_OWNER_IDENTITIES) .length
        ? parseList(env.RTS_OWNER_IDENTITIES)
        : DEFAULT_OWNER.identityNames,
    },
    detector: {
      sbsPath: env.RTS_SBS_PATH?.trim() || path.join(saveDir, 'SANDBOX_0_0_0_.sbs'),
      sbcPath: env.RTS_SBC_PATH?.trim() || path.join(saveDir, 'Sandbox.sbc'),
      refreshMs: Number(env.RTS_DETECTOR_REFRESH_MS ?? 60000),
    },
    controlSources: parseList(env.RTS_CONTROL_SOURCES),
    tickMs: {
      reconcile: Number(env.RTS_RECONCILE_TICK_MS ?? 5000),
      dispatch: Number(env.RTS_DISPATCH_TICK_MS ?? 1000),
    },
    demo: {
      speedLimitMps: normalizeSpeedLimitMps(env.RTS_DEMO_SPEED_MPS ?? DEFAULT_SPEED_LIMIT_MPS),
      maxDronesPerMission: Number(env.RTS_DEMO_MAX_PER_MISSION ?? 6),
      maxActiveStandIns: Number(env.RTS_DEMO_MAX_ACTIVE ?? 10),
      maxClimbConcurrent: Number(env.RTS_DEMO_MAX_CLIMB ?? 3),
      legM: Number(env.RTS_DEMO_LEG_M ?? 2500),
      tickMs: Number(env.RTS_DEMO_TICK_MS ?? 1000),
      gateFreshMs: Number(env.RTS_DEMO_GATE_FRESH_MS ?? 30_000),
      simSpeedMin: Number(env.RTS_SIMSPEED_MIN ?? 0.95),
      simSpeedSampleMs: Number(env.RTS_SIMSPEED_SAMPLE_MS ?? 5_000),
      simSpeedHoldMs: Number(env.RTS_SIMSPEED_HOLD_MS ?? 30_000),
      spawnAglM: Number(env.RTS_DEMO_SPAWN_AGL ?? 8_000),
      gravitySpawnAglM: Number(env.RTS_DEMO_GRAVITY_AGL ?? 2_500),
      orbitAglM: Number(env.RTS_DEMO_ORBIT_AGL ?? 40_000),
      gravityHull: env.RTS_DEMO_HULL_GRAVITY?.trim() || null,
      leaveHolding: env.RTS_DEMO_LEAVE_HOLDING === '1',
      maxGridsBeforeRun: Number(env.RTS_DEMO_MAX_GRIDS ?? 20),
      simSpeedEnvPath: env.RTS_SIMSPEED_ENV?.trim() || '',
      archivedAfterMs: Number(env.RTS_DEMO_ARCHIVE_MS ?? 6 * 60 * 60 * 1000),
      landingHandoverAglM: Math.min(
        2_000,
        Math.max(20, Number(env.RTS_DEMO_HANDOVER_AGL ?? LANDING_HANDOVER_AGL_M)),
      ),
      station: {
        // Default ON for the test server (approved T19). RTS_STATION=0 turns
        // every station write off; the executor keeps flying as before.
        enabled: env.RTS_STATION !== '0',
        afterMs: Number(env.RTS_STATION_AFTER_MS ?? 30_000),
        maxSpeedMps: Number(env.RTS_STATION_MAX_SPEED ?? 0.5),
        zeroSpeedMps: Number(env.RTS_STATION_ZERO_SPEED ?? 5),
        minAglM: Number(env.RTS_STATION_MIN_AGL ?? 100),
      },
      comeToMe: {
        // 40 m to the side and 80 m of hull clearance: inside the 200 m suit
        // radio with margin, far enough that the ship never sits over the
        // player, low enough that a hand-flown landing is a short descent.
        lateralM: Math.min(180, Math.max(25, Number(env.RTS_COME_TO_ME_LATERAL_M ?? 40))),
        aboveGroundM: Math.min(1_000, Math.max(25, Number(env.RTS_COME_TO_ME_AGL_M ?? 80))),
        timeoutMs: Math.min(3_600_000, Math.max(30_000, Number(env.RTS_COME_TO_ME_TIMEOUT_MS ?? 600_000))),
      },
    },
  };
}
