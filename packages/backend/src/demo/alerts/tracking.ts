/**
 * Persistent state that makes disappearance and coverage deltas visible.
 *
 * The condition evaluator is pure: it only sees `AlertContext`. Detecting a
 * grid that is *gone* requires remembering what was there last time, and
 * detecting a coverage drop requires remembering the last percentage. Both
 * records live in SQLite kv and are read/written by `context.ts` once per
 * evaluation (30 s). Nothing here polls the game.
 *
 * Deletions are deliberately not recorded by the alerts engine: the route that
 * sends `delete_grid` already audits it. We replay that audit into a kv set so
 * a grid the owner deleted through our API is never reported as lost, even
 * after the audit table is pruned.
 */
import type { AuditEntry, Store } from '../../store.js';
import type { AlertCoverageBaseline, AlertKnownGrid, AlertLinkedGrid } from './types.js';

const REGISTRY_KEY = 'alerts:grid-registry';
const COVERAGE_KEY = 'alerts:coverage-history';
const DELETION_KEY = 'alerts:grid-deletions';

/** How many recent audit rows to replay on each pass. */
const AUDIT_SCAN_LIMIT = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function vec(value: unknown): { x: number; y: number; z: number } | null {
  if (!isRecord(value)) return null;
  const x = num(value.x);
  const y = num(value.y);
  const z = num(value.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function linked(value: unknown): AlertLinkedGrid[] {
  if (!Array.isArray(value)) return [];
  const out: AlertLinkedGrid[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    out.push({
      id,
      name: str(item.name),
      kind: str(item.kind) ?? 'link',
      distanceM: num(item.distanceM),
    });
  }
  return out;
}

/** Grids remembered from earlier evaluations, newest state per id. */
export function readKnownGrids(store: Store): AlertKnownGrid[] {
  const parsed = parseJson(store.getKv(REGISTRY_KEY));
  const rows = isRecord(parsed) && Array.isArray(parsed.grids) ? parsed.grids : [];
  const out: AlertKnownGrid[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const lastSeenAt = num(row.lastSeenAt);
    if (!id || lastSeenAt === null) continue;
    out.push({
      id,
      name: str(row.name) ?? id,
      planet: str(row.planet),
      altitudeM: num(row.altitudeM),
      position: vec(row.position),
      lastSeenAt,
      linkedTo: linked(row.linkedTo),
    });
  }
  return out;
}

export function writeKnownGrids(store: Store, grids: AlertKnownGrid[]): void {
  store.setKv(REGISTRY_KEY, JSON.stringify({ version: 1, grids }));
}

/** Coverage percentages from the previous evaluation, one row per planet. */
export function readCoverageBaseline(store: Store): AlertCoverageBaseline[] {
  const parsed = parseJson(store.getKv(COVERAGE_KEY));
  const rows = isRecord(parsed) && Array.isArray(parsed.planets) ? parsed.planets : [];
  const out: AlertCoverageBaseline[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const planet = str(row.planet);
    const coveragePct = num(row.coveragePct);
    const at = num(row.at);
    if (!planet || coveragePct === null || at === null) continue;
    out.push({ planet, coveragePct, at });
  }
  return out;
}

export function writeCoverageBaseline(store: Store, samples: AlertCoverageBaseline[]): void {
  store.setKv(COVERAGE_KEY, JSON.stringify({ version: 1, planets: samples }));
}

/**
 * Grid ids the owner deleted through our own API. The designer proxy already
 * audits `designer_plugin_action`/`delete_grid` with the entity id; a dedicated
 * `grid_deleted` action is accepted too so a future cleaner route needs no
 * change here. Ids are merged into kv so an old deletion stays suppressed after
 * the audit window moves on.
 */
export function readDeletedGridIds(store: Store): Set<string> {
  const cached = new Set<string>();
  const raw = parseJson(store.getKv(DELETION_KEY));
  if (isRecord(raw) && Array.isArray(raw.ids)) {
    for (const id of raw.ids) {
      const value = str(id);
      if (value) cached.add(value);
    }
  }

  let changed = false;
  for (const entry of store.listAudit(AUDIT_SCAN_LIMIT)) {
    for (const id of deletedIdsOf(entry)) {
      if (!cached.has(id)) {
        cached.add(id);
        changed = true;
      }
    }
  }
  if (changed) store.setKv(DELETION_KEY, JSON.stringify({ version: 1, ids: [...cached] }));
  return cached;
}

/** IDs named by one audit row, or [] when the row is not a successful delete. */
export function deletedIdsOf(entry: AuditEntry): string[] {
  const detail = entry.detail;
  const ids: string[] = [];
  const fromDetail = (value: unknown): void => {
    const id = str(value);
    if (id) ids.push(id);
  };

  if (entry.action === 'designer_plugin_action' && entry.subject === 'delete_grid') {
    // The route writes {params:{entityId}, ok}; a failed delete must not suppress.
    if (detail.ok === false) return [];
    const params = isRecord(detail.params) ? detail.params : {};
    fromDetail(params.entityId);
    fromDetail(detail.entityId);
    return ids;
  }
  if (entry.action === 'grid_deleted' || entry.action === 'demo_grid_delete') {
    if (detail.ok === false) return [];
    const target = isRecord(detail.target) ? detail.target : {};
    fromDetail(detail.gridId);
    fromDetail(detail.entityId);
    fromDetail(target.gridId);
    fromDetail(target.entityId);
    return ids;
  }
  return [];
}
