export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Camera focus request: fly to a point (planet or grid) and frame it. */
export interface FocusTarget {
  id: string;
  label: string;
  pos: Vec3;
  radiusKm: number;
}

export interface FocusRequest {
  nonce: number;
  target: FocusTarget;
}

export interface Planet {
  id: string;
  name: string;
  center: Vec3;
  surfaceRadiusM: number;
  maxHillRadiusM: number;
  hasAtmosphere: boolean;
}

export type StateSource = 'GAME' | 'SIMULATED';

export interface Capability {
  role: string;
  radioRadiusM: number | null;
  laserRangeM: number | null;
  laserPorts: number;
  controllable: boolean | 'unknown';
  sizeClass: string;
  isStatic: boolean | 'unknown';
  sourceNote: string;
}

export interface NodeLink {
  to: string;
  kind: 'radio' | 'laser';
  distanceM: number;
}

export interface CommsGate {
  nodeId: string;
  gate: 'comms';
  allowed: boolean;
  source: StateSource;
  reason: string;
  gameLink?: 'up' | 'down' | 'unknown' | 'no-telemetry';
  telemetryAgeMs?: number | null;
  plannerPath?: boolean | null;
  virtual?: boolean;
  labels?: string[];
}

export interface DemoStaging {
  mode: string;
  reason: string | null;
  enabled: boolean;
  dryRun: boolean;
  /** Applied actuator state (what the game was told), not the latest desire. */
  h2: 'on' | 'off' | null;
  desiredH2: 'on' | 'off' | null;
  h2Scope: 'all' | 'up' | null;
  stockpile: boolean | null;
  desiredStockpile: boolean | null;
  emergency: boolean;
  emergencyReason: string | null;
  phase: string | null;
  altitudeM: number | null;
  gravityMps2: number | null;
  requiredN: number | null;
  availableN: Record<string, number> | null;
  coverPct: Record<string, number> | null;
  h2GapN: number | null;
  h2FillPct: number | null;
  batteryPct: number | null;
  fuelSavedL: number;
  fuelSavedLps: number;
  h2BurnLpsStaged: number;
  h2BurnLpsAllOn: number;
  h2PctPerHour: number | null;
  switches: number;
  lastSwitchAt: number | null;
  lastError: string | null;
  labels: string[];
}

export interface DemoDroneProgress {
  idx: number;
  label: string;
  prefab: string;
  role: string | null;
  planet: string | null;
  state: 'queued' | 'spawning' | 'securing' | 'en_route' | 'holding' | 'stopped' | 'failed' | 'skipped';
  gridId: string | null;
  reason: string | null;
  attempts: number;
  planSlot: Vec3;
  execSlot: Vec3;
  spawn: Vec3;
  position: Vec3 | null;
  remainingM: number | null;
  speedMps: number;
  etaSec: number | null;
  holdSince: number | null;
  /** T8 thrust staging; absent while the backend predates it. */
  staging?: DemoStaging | null;
  stagingLine?: string | null;
  updatedAt: number;
}

export interface DemoExecution {
  missionId: string;
  state: string;
  scaled: boolean;
  total: number;
  cap: number;
  note: string | null;
  counts: {
    queued: number;
    spawning: number;
    securing: number;
    enRoute: number;
    holding: number;
    stopped: number;
    failed: number;
    skipped: number;
  };
  drones: DemoDroneProgress[];
}

export interface SimSpeedSample {
  value: number | null;
  threshold?: number;
  blocked?: boolean;
  belowForMs?: number;
  holdMs?: number;
  source?: string;
  error?: string | null;
  at?: number;
}

export interface ExecutionsState {
  enabled: boolean;
  killSwitch: boolean;
  speedLimitMps: number;
  /** Optional: the T6 designer writes these; older backends omit them. */
  simSpeedMin?: number;
  simSpeed?: SimSpeedSample | null;
  maxDronesPerMission: number;
  maxActiveStandIns: number;
  legM: number;
  lastTickAt: number | null;
  lastError: string | null;
  active: number;
  executions: DemoExecution[];
  labels: string[];
  /** T8 staging controller status, when the backend reports it. */
  staging?: { enabled: boolean; dryRun: boolean; tickMs: number };
  note?: string;
  reason?: string;
}

export interface NodeTelemetry {
  name: string;
  lastSeen: number;
  ageMs: number;
  fresh: boolean;
  pos: Vec3 | null;
  vel: Vec3 | null;
  speedMps: number;
  moving: boolean;
  linkStatus: 'up' | 'down' | 'unknown';
  ownership: string | null;
  /**
   * Optional live orientation. The plugin telemetry message does not carry
   * rotation yet (position only), so the shape layer falls back to the save
   * quat; a plugin change adds `quat` here and the layers pick it up.
   */
  quat?: { x: number; y: number; z: number; w: number } | null;
}

export type ShipRole = 'managed' | 'personal' | 'base' | 'off';
export type ShipRoleSource = 'in-game-tag' | 'site-toggle' | 'default' | 'default-live' | 'ownership';

/** T66: the survival refuel loop, per grid. */
export type SurvivalLoopState = 'OK' | 'RETURN_PENDING' | 'RETURNING' | 'NEEDS_REFUEL' | 'READY_TO_RELAUNCH' | 'STRANDED';

export interface SurvivalLoopRow {
  gridId: string;
  name: string | null;
  state: SurvivalLoopState;
  label: string;
  reason: string;
  phase: 'return' | 'relaunch' | null;
  needsRefuel: boolean;
  slotStatus: string | null;
  recommendation: string | null;
  missionId: string | null;
  refuelPct: number | null;
  home: string | null;
}

export interface DemoSurvival {
  settings: { approvalMode: 'auto' | 'approve'; marginPct: number; relaunchPct: number };
  defaultHomeId?: string | null;
  overrides?: Record<string, string>;
  /** TEST-ENV-ONLY runway overrides in force (empty outside the test world). */
  testRunway?: Record<string, { resource: 'h2' | 'power'; runwayMin: number; pct: number; expiresAt: number }>;
  grids: SurvivalLoopRow[];
}

export interface DemoNode {
  id: string;
  name: string;
  prefab: string;
  planet: string | null;
  position: Vec3;
  controlSource: boolean;
  status: 'alive' | 'planned';
  origin: string;
  note: string;
  source: StateSource;
  telemetry?: NodeTelemetry | null;
  capabilityKnown: boolean;
  capability: Capability | null;
  links: NodeLink[];
  ports: { used: number; capacity: number };
  reachable: boolean;
  gate: CommsGate | null;
  /** Ship roles (owner decision 2026-11-11). */
  role?: ShipRole;
  roleSource?: ShipRoleSource;
  roleReason?: string;
  roleConflict?: boolean;
  /** T66: survival-loop state, reason and slot vacancy for this grid. */
  survival?: Omit<SurvivalLoopRow, 'gridId' | 'name' | 'home'> | null;
}

export interface LinkEdge {
  from: string;
  to: string;
  kind: 'radio' | 'laser';
  distanceM: number;
}

export interface LinkGraph {
  schemaVersion: number;
  nodes: { id: string; controlSource: boolean; reachable: boolean }[];
  edges: LinkEdge[];
  articulationPoints: string[];
  bridges: { a: string; b: string }[];
  components: string[][];
  config: Record<string, unknown>;
}

export interface StandIn {
  prefab: string;
  label: string;
  role: string;
  radioRadiusM: number | null;
  laserRangeM: number | null;
  laserPorts: number;
  controllable: boolean;
  sizeClass: string;
  isStatic: boolean;
  sourceNote: string;
}

export interface MissionSummary {
  id: string;
  type: string;
  status: string;
  approval: string;
  desiredState: { shipSpec: string; station: string; qty?: number };
  createdAt: number;
}

export interface DemoState {
  schemaVersion: number;
  now: number;
  env: { name: string; locked: boolean; rtsEnv: string; marker: string; productionFallback: boolean };
  planets: Planet[];
  world: { snapshot: string; nodes: number; planned: number };
  nodes: DemoNode[];
  telemetry: {
    source: 'plugin';
    connected: boolean;
    /** every positioned row the plugin has ever reported */
    gridCount: number;
    /** seen within the 60 s telemetry window */
    freshCount: number;
    /** positioned rows older than the freshness window */
    staleCount?: number;
    /** seen within the archive window (default 6 h) — what the map shows */
    recentCount?: number;
    /** older than the archive window; only fetched via ?archived=1 */
    archivedCount?: number;
    archivedAfterMs?: number;
    movingCount: number;
    latestAgeMs: number | null;
    pollMs: number;
    note: string;
  };
  graph: LinkGraph;
  reachability: { reachable: string[]; isolated: string[]; sources: string[] };
  spofs: string[];
  bridges: { a: string; b: string }[];
  ports: Record<string, { used: number; capacity: number }>;
  flags: Record<string, boolean>;
  killSwitch: boolean;
  plugin: { connected: boolean; agentId: string | null; lastStatus: unknown; lastHeartbeatAgeMs?: number | null; gridCount?: number };
  executions?: ExecutionsState;
  standins: StandIn[];
  hardwareSummary: { radio: string; laser: string; mixed: string; lasersAvailable: number; radioRelaysAvailable: number };
  missions: { open: number; awaitingApproval: number; recent: MissionSummary[] };
  assumptions: { id: string; text: string; status: 'UNVERIFIED' | 'SIMULATED' }[];
  labels: string[];
  /** T66: return-home / refuel / relaunch state and settings. */
  survival?: DemoSurvival;
}

export interface OptionNode {
  id: string;
  position: Vec3;
  kind: 'anchor' | 'relay';
  role: 'station' | 'radio-relay' | 'laser-bridge';
  prefab: string;
  radioRadiusM: number | null;
  laserRangeM: number | null;
  laserPorts: number;
  planet: string | null;
  controlSource: boolean;
}

export interface OptionHop {
  from: string;
  to: string;
  distanceM: number;
  kind: 'radio' | 'laser' | 'none';
  losClear: boolean;
}

export interface DemoOption {
  id: 'radio' | 'laser' | 'mixed';
  label: string;
  available: boolean;
  unavailableReason: string | null;
  templateId: string;
  spacingM: number;
  maxGapM: number;
  totalDistanceM: number;
  detour: boolean;
  blockedBy: string[];
  count: number;
  relayCount: number;
  nodes: OptionNode[];
  hops: OptionHop[];
  portUsage: { nodeId: string; used: number; capacity: number; ok: boolean }[];
  portsOk: boolean;
  linksOk: boolean;
  missingLinks: { from: string; to: string; distanceM: number }[];
  cost: { perNodeCredits: number | null; totalCredits: number | null; note: string };
  assumptions: { id: string; text: string; status: 'UNVERIFIED' | 'SIMULATED' }[];
}

export interface DemoPlan {
  from: string;
  to: string;
  hardware: 'auto' | 'radio' | 'laser' | 'mixed';
  preferred: 'radio' | 'laser' | 'mixed';
  hardwareSummary: DemoState['hardwareSummary'];
  options: DemoOption[];
  assumptions: { id: string; text: string; status: 'UNVERIFIED' | 'SIMULATED' }[];
  labels: string[];
}

export interface ConnectMissionResponse {
  mission: MissionSummary & { plan: { notes: string } };
  option: { id: string; label: string; count: number; relayCount: number };
  approvalState: { status: string; approval: string; awaitingApproval: boolean };
  commsGate: CommsGate;
  execution: { status: string; pluginConnected: boolean; detail: string };
  labels: string[];
}

export interface MissionResponse {
  mission: MissionSummary & { plan?: { notes: string } };
  commsGate?: CommsGate;
  execution?: { status: string; pluginConnected: boolean; detail: string };
  labels?: string[];
  plannedNode?: DemoNode;
  snapshot?: string;
  missionOnly?: boolean;
  error?: { code: string; message: string };
}

export interface ExpandProposal {
  id: string;
  position: Vec3;
  kind: 'relay';
  planet: null;
  prefab: string;
  radioRadiusM: number;
}

export interface ExpandResponse {
  fromNodeId: string;
  proposals: ExpandProposal[];
  links: { from: string; to: string; kind: 'radio'; distanceM: number }[];
  beforeReachable: number;
  afterReachable: number;
  wouldExtendReach: boolean;
  assumptions: { id: string; text: string; status: string }[];
  labels: string[];
  note: string;
}

export interface WhatIfResponse {
  removed: string;
  reachableBefore: string[];
  reachableAfter: string[];
  newlyIsolated: string[];
  labels: string[];
  note: string;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail?: Record<string, unknown>;
}

export interface ResetResponse {
  mission: MissionSummary;
  snapshot: string;
  missionOnly: boolean;
  execution: { status: string; pluginConnected: boolean; detail: string };
  labels: string[];
  note: string;
}

/** ---- T11 move-to (single ship, plain-language preflight) ---- */

export interface MoveBlock {
  code: string;
  message: string;
  hint: string;
}

export interface MoveTargetInfo {
  position: Vec3;
  planet: string | null;
  altitudeM: number | null;
  label: string;
  preset: 'orbit-zero-g' | 'orbit-low' | null;
}

export interface MovePreflight {
  ok: boolean;
  canReach: boolean;
  linkText: string;
  fuelText: string;
  etaText: string;
  distanceM: number;
  etaS: number;
  altitudeM: number | null;
  fuelPct: number | null;
  batteryPct: number | null;
  block: MoveBlock | null;
  warnings: string[];
  summary?: string;
}

export interface MoveToResponse {
  dryRun?: boolean;
  gridId: string;
  target: MoveTargetInfo;
  preflight: MovePreflight;
  commsGate?: CommsGate;
  adminOverride?: boolean;
  mission?: MissionSummary;
  execution?: { status: string; pluginConnected: boolean; detail: string };
  labels?: string[];
}

/** ---- T9 naming ---- */

export interface NamingGrid {
  gridId: string;
  name: string;
  kind: 'SAT' | 'BASE' | string;
  cls: string;
  number: number;
  tag: string;
  ownerOverride: boolean;
  observedName?: string;
}

export interface NamingResponse {
  grids: NamingGrid[];
  count?: number;
  labels?: string[];
  names?: Record<string, string>;
}

/** ---- Provisioning (bases list for the launch flow) ---- */

export interface ProvisionGrid {
  gridId: string;
  name: string;
  profile: string;
  tag: string;
  owner: string | null;
  ok: boolean;
  radio: { count: number; broadcasting: boolean | null; radiusM: number | null };
}

export interface ProvisionState {
  bases: ProvisionGrid[];
  drones: ProvisionGrid[];
  lastRun?: { at: number; ok: boolean; scanned: number; provisioned: number } | null;
  issues?: { at: number; gridId: string | null; reason: string }[];
  labels?: string[];
}
