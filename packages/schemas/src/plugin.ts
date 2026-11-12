import { z } from 'zod';
import { EpochMs, IdString, ParamBag, SchemaVersion, Vec3Schema } from './common.js';

/**
 * Plugin <-> backend WebSocket protocol (plugin-initiated connection).
 * Every order carries an orderId; the plugin dedupes and acks. Unknown fields
 * are ignored (zod strips them), so both sides can add fields additively.
 */

export const GridRef = IdString;

/**
 * T61 passenger rule: one person attached to a ship controller.
 * `seat` is the block's custom name, `subtype` its definition subtype.
 */
export const PluginCrewMember = z.object({
  identityId: z.string().max(32).default(''),
  name: z.string().max(200).default(''),
  seat: z.string().max(200).default(''),
  controllerType: z.string().max(64).default(''),
  subtype: z.string().max(128).default(''),
  remoteControl: z.boolean().default(false),
  main: z.boolean().default(false),
});

/**
 * T61: the classified control state the plugin reports per grid.
 *
 * `underControl` is the compatibility boolean and means PILOT ONLY: an occupied
 * controller whose CanControlShip is true (a cockpit/flight seat/control seat),
 * or a Remote Control a player is actively driving. A seated passenger sets
 * `passengers[]` and `carryingPassengers`, never `underControl`; a player
 * standing on/inside the hull but not seated sets `aboard[]`/`standingAboard`.
 */
export const PluginControl = z.object({
  underControl: z.boolean().default(false),
  by: z.string().max(200).nullable().default(null),
  pilot: PluginCrewMember.nullable().default(null),
  passengers: z.array(PluginCrewMember).default([]),
  aboard: z.array(PluginCrewMember).default([]),
  carryingPassengers: z.boolean().default(false),
  standingAboard: z.boolean().default(false),
  controllers: z.array(z.record(z.unknown())).default([]),
});

export const PluginGrid = z.object({
  gridId: GridRef,
  name: z.string().max(200).default(''),
  pos: Vec3Schema.optional(),
  vel: Vec3Schema.optional(),
  massKg: z.number().nonnegative().optional(),
  powerFraction: z.number().min(0).max(1).optional(),
  fuelFraction: z.number().min(0).max(1).optional(),
  /** Battery stored / capacity as a percentage (same sample as powerFraction). */
  batteryPct: z.number().min(0).max(100).optional(),
  /** Hydrogen fill as a percentage (capacity-weighted, same sample as fuelFraction). */
  h2Pct: z.number().min(0).max(100).optional(),
  /** Current solar panel output in MW, summed over the grid. */
  solarOutputMw: z.number().nonnegative().optional(),
  /** Installed solar capacity in MW, summed over the grid. */
  solarMaxMw: z.number().nonnegative().optional(),
  /** Latest direct link state of this grid as seen by the plugin. */
  link: z.enum(['up', 'down', 'unknown']).default('unknown'),
  /** Set by the plugin when the grid reports itself on station. */
  onStation: IdString.optional(),
  /**
   * Signed pivot -> lowest hull point along local down, metres (plugin
   * `keelDepthM`, from the grid's block AABB). Negative means the hull ends
   * ABOVE the pivot (measured -18.76 on SAT-R-0001). Every ground rule is
   * phrased on the hull bottom, so this must survive the parse: it is declared
   * here because zod strips fields the schema does not know.
   */
  keelDepthM: z.number().optional(),
  /** Where `keelDepthM` came from (plugin: 'local-aabb'). */
  keelSource: z.string().max(64).optional(),
  /** World-space lowest hull point, same sample as `keelDepthM`. */
  hullBottom: Vec3Schema.optional(),
  /**
   * MEASURED attitude rate, the same sample `land_at` refuses a start on:
   * `spinDegS` = |angularVelocity| in deg/s (2026-11-11 flight set 6). The
   * backend's pre-handover settle waits on it, so a hull is never handed a
   * descent while it is still spinning. Declared here because zod strips
   * fields the schema does not know.
   */
  spinDegS: z.number().nonnegative().optional(),
  /** World-space angular velocity, rad/s (`spinDegS` is its magnitude). */
  angularVelocity: Vec3Schema.optional(),
  /** ShipSpec id from the per-grid config, when known. */
  specId: z.string().max(128).optional(),
  health: z.number().min(0).max(1).optional(),
  /**
   * T61 passenger rule: classified control state. `underControl` inside it is
   * PILOT ONLY (see PluginControl), so a seated passenger no longer reads as a
   * pilot. Declared here because zod strips fields the schema does not know.
   */
  control: PluginControl.optional(),
});

export const PluginContact = z.object({
  contactId: IdString,
  pos: Vec3Schema,
  at: EpochMs,
  source: z.enum(['sensor', 'camera', 'antenna', 'manual']),
  faction: z.string().max(64).optional(),
});

export const PluginLink = z.object({
  a: GridRef,
  b: GridRef,
  status: z.enum(['up', 'down']),
  rttMs: z.number().nonnegative().optional(),
  rangeM: z.number().nonnegative().optional(),
});

export const HelloMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('hello'),
  agentId: IdString,
  serverId: IdString,
  version: z.string().min(1).max(64),
  capabilities: z.array(z.string().max(64)).default([]),
  /** Optional bearer token for clients that cannot set headers. */
  token: z.string().max(256).optional(),
});

/**
 * T61: one online character as the plugin sees it. Every identity/entity id is
 * a STRING because SE ids exceed 2^53 (identity ids are ~1.4e17, entity ids up
 * to 2^63-1) and a JS number would silently round them.
 */
export const PluginPlayer = z.object({
  identityId: z.string().min(1).max(32),
  steamId: z.string().min(1).max(32),
  displayName: z.string().max(200).default(''),
  /** Character entity id, as a string. */
  characterEntityId: z.string().min(1).max(32).nullable().default(null),
  pos: Vec3Schema.nullable().default(null),
  vel: Vec3Schema.nullable().default(null),
  /** The grid the player is in control of (pilot/seat), when any. */
  gridId: GridRef.nullable().default(null),
  /** Name of the controller block the player is seated in. */
  seatName: z.string().max(200).nullable().default(null),
  /** True when the player is driving the grid (cockpit/RC under control). */
  piloting: z.boolean().default(false),
  /** Name of the planet whose gravity the character is inside, when any. */
  planet: z.string().max(64).nullable().default(null),
  /** Metres above that planet's real terrain surface; null = not in gravity. */
  aglM: z.number().nullable().default(null),
  /** Height above the planet's mean sphere, metres. */
  altitudeM: z.number().nullable().default(null),
  /** Local gravity magnitude at the character, m/s2; null when not sampled. */
  gravityMps2: z.number().nonnegative().nullable().default(null),
  onFoot: z.boolean().default(true),
  isDead: z.boolean().default(false),
  /** Faction tag + id, read from the live session (null = no faction). */
  factionTag: z.string().max(64).nullable().default(null),
  factionId: z.string().max(32).nullable().default(null),
  /** T61 privacy: the owner may hide a player from the map. */
  optOut: z.boolean().default(false),
});

/**
 * The plugin's in-process simulation ratio (`SimRatioRead`), sent on every
 * telemetry frame. The LIVE server has `RemoteApiEnabled=false`, so this frame
 * field - not the Remote API - is the backend's SimSpeed source there. A failed
 * read carries `value: null` and a `state` that says why, never a fake 1.0.
 */
export const PluginSimRatio = z.object({
  /** `MyAPIGateway.Physics.SimulationRatio` (falls back to the server ratio). */
  value: z.number().min(0).max(100).nullable().optional(),
  simulationRatio: z.number().min(0).max(100).nullable().optional(),
  serverSimulationRatio: z.number().min(0).max(100).nullable().optional(),
  /** Where the number came from, or 'unavailable'. */
  source: z.string().max(200).default('unavailable'),
  /** 'readable', or 'UNVERIFIED: ...' with the reason. */
  state: z.string().max(400).default('UNVERIFIED'),
  /** Wall clock of the plugin's own read, ms since the epoch. */
  sampledAt: EpochMs.optional(),
});

export const TelemetryMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('telemetry'),
  tick: z.number().int().nonnegative(),
  at: EpochMs.optional(),
  grids: z.array(PluginGrid).default([]),
  /**
   * T79: the game's simulation ratio, frame-level (one per server, not per
   * grid). Declared here because zod strips fields it does not know, which is
   * how the field the plugin has been sending since `SimRatioRead` was merged
   * never reached the backend.
   */
  simRatio: PluginSimRatio.optional(),
  /** T61: online characters (owners + their faction), never other factions. */
  players: z.array(PluginPlayer).default([]),
  /** "readable" when the player sample was taken; UNVERIFIED reason otherwise. */
  playersState: z.string().max(200).optional(),
  /** World-space unit vector towards the sun (MySector.DirectionToSunNormalized). */
  sun: Vec3Schema.optional(),
  /** "readable" when the engine value was sampled; UNVERIFIED reason otherwise. */
  sunState: z.string().max(200).optional(),
  contacts: z.array(PluginContact).default([]),
  links: z.array(PluginLink).default([]),
  ledgerDelta: z
    .array(
      z.object({
        site: IdString,
        item: z.string().max(64),
        qty: z.number(),
      }),
    )
    .default([]),
});

export const EventMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('event'),
  eventType: z.string().min(1).max(64),
  entityId: IdString.optional(),
  data: ParamBag.default({}),
  at: EpochMs,
});

export const OrderType = z.enum([
  'move',
  'waypoint',
  'drive',
  'dock',
  'undock',
  'spawn',
  'delete',
  'laser',
  'stop',
  'repair',
  'test',
  /** T75: the production action channel, compiled into every plugin build. */
  'action',
]);
export type OrderType = z.infer<typeof OrderType>;

export const OrderMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('order'),
  orderId: IdString,
  missionId: IdString.optional(),
  orderType: OrderType,
  entityId: GridRef,
  params: ParamBag.default({}),
  tick: z.number().int().nonnegative().default(0),
  issuedAt: EpochMs,
  /** Orders are only ever addressed to a unit the comms gate considers reachable. */
  expiresAt: EpochMs.optional(),
});

export const AckMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('ack'),
  orderId: IdString,
  ok: z.boolean(),
  error: z.string().max(500).optional(),
  at: EpochMs,
});

export const StatusMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('status'),
  simSpeed: z.number().min(0).max(1).optional(),
  pcus: z.number().nonnegative().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  /** Backend -> plugin server-side state hint (e.g. 'ready'). */
  hubState: z.enum(['ready', 'degraded', 'rejected']).optional(),
  note: z.string().max(300).optional(),
});

export const TestMessage = z.object({
  schemaVersion: SchemaVersion,
  type: z.literal('test'),
  action: z.enum(['spawn_blueprint', 'delete_grid', 'teleport', 'damage', 'cut_link', 'set_resources', 'wave', 'reset']),
  params: ParamBag.default({}),
});

export const PluginMessageSchema = z.discriminatedUnion('type', [
  HelloMessage,
  TelemetryMessage,
  EventMessage,
  OrderMessage,
  AckMessage,
  StatusMessage,
  TestMessage,
]);
export type PluginMessage = z.infer<typeof PluginMessageSchema>;
export type PluginMessageType = PluginMessage['type'];

/** Messages the backend is allowed to send to a plugin. */
export const ServerToPluginSchema = z.discriminatedUnion('type', [OrderMessage, StatusMessage, EventMessage]);
export type ServerToPlugin = z.infer<typeof ServerToPluginSchema>;

export type PluginGrid = z.infer<typeof PluginGrid>;
export type PluginContact = z.infer<typeof PluginContact>;
export type PluginPlayer = z.infer<typeof PluginPlayer>;
export type PluginLink = z.infer<typeof PluginLink>;
export type HelloMessage = z.infer<typeof HelloMessage>;
export type TelemetryMessage = z.infer<typeof TelemetryMessage>;
export type EventMessage = z.infer<typeof EventMessage>;
export type OrderMessage = z.infer<typeof OrderMessage>;
export type AckMessage = z.infer<typeof AckMessage>;
export type StatusMessage = z.infer<typeof StatusMessage>;
export type TestMessage = z.infer<typeof TestMessage>;

/** Schema aliases so callers can `X.parse(...)` without knowing the names. */
export const HelloMessageSchema = HelloMessage;
export const TelemetryMessageSchema = TelemetryMessage;
export const EventMessageSchema = EventMessage;
export const OrderMessageSchema = OrderMessage;
export const AckMessageSchema = AckMessage;
export const StatusMessageSchema = StatusMessage;
export const TestMessageSchema = TestMessage;

export const PROTOCOL_LIMITS = {
  /** A hello must arrive this soon after the socket opens. */
  helloTimeoutMs: 5000,
  /** Max accepted frame size, bytes. */
  maxPayloadBytes: 2 * 1024 * 1024,
  /** A unit is commandable only while its telemetry is this fresh. */
  telemetryFreshMs: 30_000,
} as const;
