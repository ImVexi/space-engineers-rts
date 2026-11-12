import { API_BASE, TOKEN_STORAGE_KEY } from './config';
import type {
  AuditEntry,
  ConnectMissionResponse,
  DemoPlan,
  DemoState,
  ExpandResponse,
  MissionResponse,
  MoveToResponse,
  ShipRole,
  NamingGrid,
  NamingResponse,
  ProvisionState,
  ResetResponse,
  WhatIfResponse,
} from './types';
import type {
  DesignerExecuteResponse,
  DesignerPlanResponse,
  DesignerSettings,
  DesignerSettingsResponse,
  Hull,
  LaunchMode,
  PlanRequestBody,
} from './lib/designer';
import type { LinksResponse } from './lib/links';
import type { CoverageResponse } from './lib/coverage';
import type { OptimisePlan } from './lib/optimise';
import type { AlertsResponse, FleetOperation2 } from './lib/ops';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Backend fix suggestion for refusals (plain words). */
    public readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let memoryToken = '';

/** Token is entered once in the UI and kept in localStorage; never built in. */
export function getApiToken(): string {
  if (memoryToken) return memoryToken;
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setApiToken(token: string): void {
  memoryToken = token.trim();
  try {
    if (memoryToken) localStorage.setItem(TOKEN_STORAGE_KEY, memoryToken);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage unavailable: keep it in memory only */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const token = getApiToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      cache: 'no-store',
    });
  } catch (err) {
    throw new ApiError(0, 'network', `backend unreachable at ${API_BASE} (${err instanceof Error ? err.message : 'fetch failed'})`);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'bad_json', `backend returned non-JSON (${res.status})`);
    }
  }
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'http_error',
      error?.message ?? `request failed (${res.status})`,
      error?.hint ?? null,
    );
  }
  return body as T;
}

interface DesignerSettingsWire {
  settings?: Partial<DesignerSettings>;
  defaults?: Partial<DesignerSettings>;
  live?: { simSpeed?: number | null; threshold?: number };
  simSpeedMin?: number;
  maxActive?: number;
  launchReservePct?: number;
  liveSimSpeed?: number | null;
}

/**
 * The backend wraps settings in `{settings, defaults, live}`, while the
 * contract's client shape is flat. Accept both so a backend refactor cannot
 * blank the sliders, and never let undefined reach an <input>.
 */
export function adaptDesignerSettings(body: unknown): DesignerSettingsResponse {
  const wire = (body ?? {}) as DesignerSettingsWire;
  const flat = wire.settings ?? wire;
  const simSpeedMin = Number(flat.simSpeedMin ?? wire.defaults?.simSpeedMin ?? 0.95);
  const maxActive = Number(flat.maxActive ?? wire.defaults?.maxActive ?? 5);
  const reserve = Number(flat.launchReservePct ?? wire.defaults?.launchReservePct ?? 15);
  return {
    simSpeedMin: Number.isFinite(simSpeedMin) ? simSpeedMin : 0.95,
    maxActive: Number.isFinite(maxActive) ? maxActive : 5,
    launchReservePct: Number.isFinite(reserve) ? reserve : 15,
    liveSimSpeed: wire.live?.simSpeed ?? wire.liveSimSpeed ?? null,
    threshold: wire.live?.threshold ?? null,
  };
}

export const api = {
  state: (opts: { archived?: boolean } = {}) => request<DemoState>(opts.archived ? '/demo/state?archived=1' : '/demo/state'),
  planConnect: (body: { planetA: string; planetB: string; hardware: 'auto' | 'radio' | 'laser' | 'mixed' }) =>
    request<DemoPlan>('/demo/plan/connect', { method: 'POST', body: JSON.stringify(body) }),
  connectMissions: (body: {
    planetA: string;
    planetB: string;
    hardware: 'auto' | 'radio' | 'laser' | 'mixed';
    optionId: 'radio' | 'laser' | 'mixed';
    note?: string;
  }) => request<ConnectMissionResponse>('/demo/missions/connect', { method: 'POST', body: JSON.stringify(body) }),
  approve: (missionId: string) =>
    request<MissionResponse>(`/demo/missions/${encodeURIComponent(missionId)}/approve`, { method: 'POST', body: '{}' }),
  spawn: (body: { prefab: string; planet?: string; pos?: { x: number; y: number; z: number } }) =>
    request<MissionResponse>('/demo/spawn', { method: 'POST', body: JSON.stringify(body) }),
  move: (body: { gridId: string; pos: { x: number; y: number; z: number } }) =>
    request<MissionResponse>('/demo/move', { method: 'POST', body: JSON.stringify(body) }),
  expand: (fromNodeId: string) =>
    request<ExpandResponse>('/demo/expand', { method: 'POST', body: JSON.stringify({ fromNodeId }) }),
  whatIf: (nodeId: string) =>
    request<WhatIfResponse>('/demo/what-if', { method: 'POST', body: JSON.stringify({ nodeId }) }),
  kill: (on: boolean) =>
    request<{ killSwitch: boolean; previous: boolean; note: string }>('/demo/kill', {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),
  reset: (snapshot: string, confirm: string) =>
    request<ResetResponse>('/demo/reset', { method: 'POST', body: JSON.stringify({ snapshot, confirm }) }),
  audit: () => request<{ entries: AuditEntry[] }>('/audit'),

  // ---- T11 direct manipulation: move-to, naming, provisioning ----
  moveTo: (body: {
    gridId: string;
    target: string | { planet: string; altitudeM: number } | { gps: { x: number; y: number; z: number } };
    dryRun?: boolean;
    ignoreReach?: boolean;
    /** Ship roles: explicit owner confirmation for a PERSONAL ship. */
    confirmPersonal?: boolean;
  }) => request<MoveToResponse>('/demo/move-to', { method: 'POST', body: JSON.stringify(body) }),
  roles: () =>
    request<{ roles: { gridId: string; name: string | null; role: ShipRole; roleSource: string; roleReason: string }[] }>(
      '/demo/roles',
    ),
  setRole: (gridId: string, role: ShipRole | null) =>
    request<{ gridId: string; role: ShipRole; roleSource: string; roleReason: string }>('/demo/roles', {
      method: 'POST',
      body: JSON.stringify({ gridId, role }),
    }),
  /** T66 survival loop: settings, home, and the two owner buttons. */
  survival: () => request<unknown>('/demo/survival'),
  survivalSettings: (body: { approvalMode?: 'auto' | 'approve'; marginPct?: number; relaunchPct?: number }) =>
    request<{ settings: { approvalMode: 'auto' | 'approve'; marginPct: number; relaunchPct: number } }>(
      '/demo/survival/settings',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  survivalHome: (body: { gridId?: string; homeGridId?: string | null; homePoint?: { x: number; y: number; z: number } }) =>
    request<{ defaultHomeId: string | null; overrides: Record<string, string> }>('/demo/survival/home', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** TEST-ENV-ONLY: per-grid runway override so the flight can be exercised. */
  survivalTestRunway: (body: { gridId: string; resource: 'h2' | 'power'; runwayMin: number; pct: number; ttlMin?: number }) =>
    request<unknown>('/demo/survival/test-runway', { method: 'POST', body: JSON.stringify(body) }),
  survivalTestRunwayClear: (body: { gridId?: string | null } = {}) =>
    request<{ testRunway: Record<string, unknown> }>('/demo/survival/test-runway/clear', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  survivalReturn: (gridId: string) =>
    request<unknown>('/demo/survival/return', { method: 'POST', body: JSON.stringify({ gridId }) }),
  survivalRelaunch: (gridId: string, confirm: boolean) =>
    request<unknown>('/demo/survival/relaunch', { method: 'POST', body: JSON.stringify({ gridId, confirm }) }),
  naming: () => request<NamingResponse>('/demo/naming'),
  provisionState: () => request<ProvisionState>('/demo/provision/state'),
  teleport: (target: { x: number; y: number; z: number }) =>
    request<{ ok?: boolean; gridId?: string; note?: string }>('/demo/provision/teleport', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  rename: (gridId: string, name: string) =>
    request<{ grid?: NamingGrid; name?: string }>('/demo/naming/rename', {
      method: 'POST',
      body: JSON.stringify({ gridId, name }),
    }),

  // ---- T6 constellation designer (all test-env locked on the backend) ----
  designerHulls: () => request<{ hulls: Hull[]; labels?: string[] }>('/demo/designer/hulls'),
  designerPlan: (body: PlanRequestBody) =>
    request<DesignerPlanResponse>('/demo/designer/plan', { method: 'POST', body: JSON.stringify(body) }),
  /** T43 read-only optimiser: honest before/after, moves, assignment by grid. */
  optimise: (body: {
    planet: string;
    target:
      | 'whole'
      | 'hemisphere'
      | { hemisphereFrom: { latDeg: number; lonDeg: number } }
      | { kind?: 'radius'; radiusM: number; center: { latDeg: number; lonDeg: number } };
    k?: 1 | 2;
    cellDeg?: number;
    rangeMarginPct?: number;
    maxMoves?: number | null;
    includeGridIds?: string[];
    altitudeMode?: 'manual' | 'max-reach' | 'cheapest';
  }) => request<OptimisePlan>('/demo/designer/optimise', { method: 'POST', body: JSON.stringify(body) }),
  designerExecute: (body: {
    optionId: string;
    launch: LaunchMode;
    nearGps?: { x: number; y: number; z: number };
    maxActive?: number;
    useGridIds?: string[];
    fillWithClones?: boolean;
    dryRun?: boolean;
    ignoreReach?: boolean;
  }) => request<DesignerExecuteResponse>('/demo/designer/execute', { method: 'POST', body: JSON.stringify(body) }),
  designerSettings: () => request<unknown>('/demo/designer/settings').then(adaptDesignerSettings),
  designerSaveSettings: (body: DesignerSettings) =>
    request<unknown>('/demo/designer/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(adaptDesignerSettings),
  designerGps: (missionId: string, on: boolean) =>
    request<{ missionId: string; on: boolean; added?: number; removed?: number; labels?: string[] }>('/demo/designer/gps', {
      method: on ? 'POST' : 'DELETE',
      body: JSON.stringify({ missionId }),
    }),

  // ---- groups / links / coverage (feature-detected: a 404 hides the feature) ----
  groups: () => request<unknown>('/demo/groups'),
  groupCreate: (body: { id: string; name: string; color: string; members: string[] }) =>
    request<unknown>('/demo/groups', { method: 'POST', body: JSON.stringify(body) }),
  groupUpdate: (id: string, body: { name?: string; color?: string; members?: string[] }) =>
    request<unknown>(`/demo/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  groupDelete: (id: string) =>
    request<unknown>(`/demo/groups/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' }),
  /** Scoped stop: only this group's members. 404/405 means "not deployed yet". */
  groupStop: (id: string, gridIds: string[]) =>
    request<{
      stopped?: number;
      requested?: number;
      stoppedGrids?: string[];
      skipped?: { gridId: string; reason: string; stage: string }[];
      note?: string;
    }>(`/demo/groups/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ gridIds }),
    }),
  links: (planet: string) => request<LinksResponse>(`/demo/links?planet=${encodeURIComponent(planet)}`),

  // ---- T51/T60 operator screens: alerts, fleet operations, health ----
  /** T68 alert feed. `enabled:false` is a real answer, not an error. */
  alerts: (params: { state?: string; severity?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set('state', params.state);
    if (params.severity) q.set('severity', params.severity);
    if (params.limit) q.set('limit', String(params.limit));
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return request<AlertsResponse>(`/alerts${suffix}`);
  },
  alertAck: (id: string, by?: string) =>
    request<{ alert: unknown }>(`/alerts/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      body: JSON.stringify(by ? { by } : {}),
    }),
  alertResolve: (id: string, by?: string) =>
    request<{ alert: unknown }>(`/alerts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(by ? { by } : {}),
    }),
  fleetOps: () => request<{ operations: FleetOperation2[] }>('/demo/fleet-ops'),
  fleetOpCreate: (body: {
    kind: 'swap' | 'recall' | 'reshape' | 'relocate' | 'scuttle';
    members?: string[];
    groupId?: string;
    planet?: string;
    dryRun?: boolean;
    abortPolicy?: 'hold' | 'return' | 'continue';
    slots?: { gridId: string; target: { x: number; y: number; z: number } }[];
    base?: { name?: string; position?: { x: number; y: number; z: number } };
    confirm?: boolean;
    acceptedCoverageLoss?: boolean;
  }) =>
    request<{ operation: FleetOperation2; coverage?: unknown; note?: string; labels?: string[] }>('/demo/fleet-ops', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  fleetOpApprove: (id: string, confirm = true) =>
    request<{ operation: FleetOperation2; execution?: unknown; note?: string | null }>(
      `/demo/fleet-ops/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: JSON.stringify({ confirm }) },
    ),
  fleetOpCancel: (id: string) =>
    request<{ operation: FleetOperation2; note?: string | null }>(`/demo/fleet-ops/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
  /** Health is optional: 404 simply hides the survival badge. */
  health: () => request<Record<string, unknown>>('/health'),

  coverage: (params: { planet: string; mode?: string; k?: 1 | 2; cellDeg?: number; hullId?: string }) => {
    const q = new URLSearchParams({ planet: params.planet, mode: params.mode ?? 'cover-planet' });
    if (params.k) q.set('k', String(params.k));
    if (params.cellDeg) q.set('cellDeg', String(params.cellDeg));
    if (params.hullId) q.set('hullId', params.hullId);
    return request<CoverageResponse>(`/demo/designer/coverage?${q.toString()}`);
  },
};

