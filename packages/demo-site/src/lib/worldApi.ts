import { API_BASE } from '../config';
import { getApiToken } from '../api';
import type {
  BlocksCatalogResponse,
  TerrainPlanetsResponse,
  WorldManifest,
  WorldStatus,
} from './worldMapTypes';

/**
 * Read-only world-geometry client for the optional world-geometry service.
 *
 * The se-rts backend proxies a GET-only subset at /api/demo/…, so the browser
 * never talks to the world-geometry service on 8785 directly. Everything here is
 * geometry: terrain tiles (SETR), grid block assets (SEGB), the block catalog.
 */
const PREFIX = `${API_BASE}/demo`;

function authHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = getApiToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${PREFIX}${path}`, { signal, headers: authHeaders('application/json') });
  if (!res.ok) throw new Error(`GET ${PREFIX}${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchWorldStatus(signal?: AbortSignal): Promise<WorldStatus> {
  return getJson<WorldStatus>('/world/status', signal);
}

export async function fetchWorldManifest(signal?: AbortSignal): Promise<WorldManifest> {
  return getJson<WorldManifest>('/world/manifest', signal);
}

/** Raw SEGB bytes for one grid (absolute demo asset URL from the manifest). */
export async function fetchGridAsset(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal, headers: authHeaders('application/octet-stream') });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.arrayBuffer();
}

export async function fetchTerrainPlanets(signal?: AbortSignal): Promise<TerrainPlanetsResponse> {
  return getJson<TerrainPlanetsResponse>('/terrain/planets', signal);
}

/** One SETR tile. `key` is a quadtree tile key ("front:2:1:3"). */
export async function fetchTerrainTile(
  planetId: string,
  key: { face: string; level: number; tx: number; ty: number },
  signal?: AbortSignal,
  /** save hash: makes the tile URL immutable so the browser can cache it */
  cacheKey?: string | null,
): Promise<ArrayBuffer> {
  const params = new URLSearchParams({ level: String(key.level), tx: String(key.tx), ty: String(key.ty) });
  if (cacheKey) params.set('h', cacheKey);
  const path = `/terrain/${encodeURIComponent(planetId)}/${key.face}?${params.toString()}`;
  const res = await fetch(`${PREFIX}${path}`, { signal, headers: authHeaders('application/octet-stream') });
  if (!res.ok) throw new Error(`GET ${PREFIX}${path} -> ${res.status}`);
  return res.arrayBuffer();
}

export async function fetchBlocksCatalog(signal?: AbortSignal): Promise<BlocksCatalogResponse> {
  return getJson<BlocksCatalogResponse>('/blocks/catalog', signal);
}
