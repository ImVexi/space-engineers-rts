import type http from 'node:http';
import { DemoHttpError, type DemoRoute } from './routes.js';

/**
 * GET-only proxy to an optional world-geometry service.
 *
 * The service publishes terrain height fields and block-shape models for a
 * world. It is a SEPARATE program, not part of this repository and not
 * distributed with it: point RTS_TELEMETRY_TEST_BASE at it, or leave it unset
 * and the map falls back to an approximate planet shell with no terrain
 * occlusion. Everything here is optional.
 *
 * Only reads are exposed, the upstream paths are fixed (no arbitrary URL
 * proxying), and the manifest's grid asset URLs are rewritten to the demo
 * prefix so the browser never learns the service's path layout.
 */
export const TELEMETRY_TEST_BASE_ENV = 'RTS_TELEMETRY_TEST_BASE';
export const DEFAULT_TELEMETRY_TEST_BASE = 'http://127.0.0.1:8786';

export function telemetryTestBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env[TELEMETRY_TEST_BASE_ENV]?.trim() || DEFAULT_TELEMETRY_TEST_BASE).replace(/\/+$/, '');
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

function sendBytes(
  res: http.ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  cacheControl: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': cacheControl,
  });
  res.end(body);
}

export interface UpstreamReply {
  status: number;
  contentType: string;
  cacheControl: string;
  body: Buffer;
}

/** One upstream GET; never throws for a non-2xx status, only for transport errors. */
export async function fetchUpstream(
  path: string,
  base = telemetryTestBase(),
  timeoutMs = 15_000,
): Promise<UpstreamReply> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DemoHttpError(
      502,
      'telemetry_test_unavailable',
      `test-world telemetry instance is not answering (${err instanceof Error ? err.message : 'fetch failed'})`,
      undefined,
      'Start the world-geometry service (RTS_TELEMETRY_TEST_BASE) and retry. Terrain and ship shapes are read-only; nothing is sent to the game.',
    );
  }
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    cacheControl: res.headers.get('cache-control') ?? 'no-cache',
    body,
  };
}

/** Grid asset URLs from the service manifest point at /api/world/…; remap them. */
export function rewriteManifestAssets(manifest: Record<string, unknown>): Record<string, unknown> {
  const grids = Array.isArray(manifest.grids) ? manifest.grids : [];
  const rewritten = grids.map((grid) => {
    if (!grid || typeof grid !== 'object') return grid;
    const row = grid as Record<string, unknown>;
    const asset = typeof row.asset === 'string' ? row.asset.replace(/^\/api\/world\//, '/api/demo/world/') : row.asset;
    return { ...row, asset };
  });
  return { ...manifest, grids: rewritten };
}

export function worldProxyRoutesFor(env: NodeJS.ProcessEnv = process.env): DemoRoute[] {
  const base = telemetryTestBase(env);

  const passJson = async (res: http.ServerResponse, path: string, transform?: (body: unknown) => unknown) => {
    const reply = await fetchUpstream(path, base);
    if (reply.status !== 200) {
      sendJson(res, reply.status, {
        error: {
          code: 'telemetry_test_error',
          message: `test-world telemetry returned ${reply.status} for ${path}`,
          hint: 'Wait for the test-world save to finish rendering (GET /api/demo/world/status), then retry.',
        },
      });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(reply.body.toString('utf8'));
    } catch {
      throw new DemoHttpError(502, 'telemetry_test_bad_json', `test-world telemetry returned non-JSON for ${path}`);
    }
    sendJson(res, 200, transform ? transform(body) : body);
  };

  return [
    {
      method: 'GET',
      pattern: /^\/api\/demo\/world\/status$/,
      handler: ({ res }) => passJson(res, '/api/world/status'),
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/world\/manifest$/,
      handler: ({ res }) =>
        passJson(res, '/api/world/manifest', (body) => rewriteManifestAssets(body as Record<string, unknown>)),
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/world\/grid\/([^/]+)$/,
      handler: async ({ res, params, url }) => {
        const h = url.searchParams.get('h');
        const path = `/api/world/grid/${encodeURIComponent(decodeURIComponent(params[0]!))}${h ? `?h=${encodeURIComponent(h)}` : ''}`;
        const reply = await fetchUpstream(path, base, 30_000);
        if (reply.status !== 200) {
          sendJson(res, reply.status === 404 ? 404 : reply.status, {
            error: { code: 'telemetry_test_error', message: `test-world grid asset not available (${reply.status})` },
          });
          return;
        }
        sendBytes(
          res,
          200,
          reply.body,
          'application/octet-stream',
          h ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/terrain\/planets$/,
      handler: ({ res }) => passJson(res, '/api/terrain/planets'),
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/terrain\/([^/]+)\/([^/]+)$/,
      handler: async ({ res, params, url }) => {
        const planet = encodeURIComponent(decodeURIComponent(params[0]!));
        const face = encodeURIComponent(decodeURIComponent(params[1]!));
        const query = new URLSearchParams();
        for (const key of ['level', 'tx', 'ty', 'h']) {
          const value = url.searchParams.get(key);
          if (value !== null) query.set(key, value);
        }
        const path = `/api/terrain/${planet}/${face}${query.size ? `?${query.toString()}` : ''}`;
        const reply = await fetchUpstream(path, base, 30_000);
        if (reply.status !== 200) {
          sendJson(res, reply.status === 404 ? 404 : reply.status, {
            error: { code: 'telemetry_test_error', message: `test-world terrain tile not available (${reply.status})` },
          });
          return;
        }
        sendBytes(res, 200, reply.body, 'application/octet-stream', reply.cacheControl);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/blocks\/catalog$/,
      handler: ({ res }) => passJson(res, '/api/blocks/catalog'),
    },
  ];
}
