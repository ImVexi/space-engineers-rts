import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoHttpError, type DemoRoute } from '../src/demo/routes.js';
import { fetchUpstream, rewriteManifestAssets, worldProxyRoutesFor } from '../src/demo/worldProxy.js';

/**
 * T14 proxy contract: only GET, only the fixed world/terrain/catalog paths,
 * manifest asset URLs rewritten to /api/demo/world/…, and a clear 502 when the
 * test-world telemetry instance is down.
 */
const MANIFEST = {
  save_hash: 'h1',
  save_mtime: 1,
  generated_at: 2,
  grids: [
    { id: 'g1', name: 'BASE-01', asset: '/api/world/grid/g1?h=h1', block_count: 69 },
    { id: 'g2', name: 'SAT-L-0001', asset: '/api/demo/world/grid/g2?h=h1' },
  ],
};

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: Buffer | string) {
      captured.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(route: DemoRoute, path: string): Promise<Captured> {
  const url = new URL(path, 'http://localhost');
  const params = route.pattern.exec(url.pathname)?.slice(1) ?? [];
  const { res, captured } = fakeRes();
  await route.handler({ req: {} as http.IncomingMessage, res, params, url });
  return captured;
}

describe('test-world world proxy', () => {
  let upstream: http.Server;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      hits.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === '/api/world/manifest') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(MANIFEST));
        return;
      }
      if (url.pathname === '/api/world/status') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ grid_count: 18, block_count: 4959 }));
        return;
      }
      if (url.pathname.startsWith('/api/world/grid/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'immutable' }).end(Buffer.from([1, 2, 3, 4]));
        return;
      }
      if (url.pathname === '/api/terrain/planets') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ planets: [{ id: 'p', available: true }] }));
        return;
      }
      if (url.pathname.startsWith('/api/terrain/')) {
        res
          .writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' })
          .end(Buffer.from('SETR'));
        return;
      }
      if (url.pathname === '/api/blocks/catalog') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subtypes: [{ name: 'AirDuct1' }], coverage: { resolved: 1, total: 1 } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('only exposes GET routes', () => {
    for (const route of worldProxyRoutesFor({ RTS_TELEMETRY_TEST_BASE: base })) {
      expect(route.method).toBe('GET');
    }
  });

  it('rewrites manifest grid asset URLs to the demo prefix, once', async () => {
    const routes = worldProxyRoutesFor({ RTS_TELEMETRY_TEST_BASE: base });
    const route = routes.find((r) => r.pattern.test('/api/demo/world/manifest'))!;
    const out = await call(route, '/api/demo/world/manifest');
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body.toString('utf8')) as typeof MANIFEST;
    expect(body.grids[0]!.asset).toBe('/api/demo/world/grid/g1?h=h1');
    expect(body.grids[1]!.asset).toBe('/api/demo/world/grid/g2?h=h1');
    expect(rewriteManifestAssets(MANIFEST).save_hash).toBe('h1');
  });

  it('passes grid bytes and the save-hash cache header through', async () => {
    const routes = worldProxyRoutesFor({ RTS_TELEMETRY_TEST_BASE: base });
    const route = routes.find((r) => r.pattern.test('/api/demo/world/grid/g1'))!;
    const out = await call(route, '/api/demo/world/grid/g1?h=h1');
    expect(out.status).toBe(200);
    expect([...out.body]).toEqual([1, 2, 3, 4]);
    expect(out.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(hits.some((h) => h.startsWith('GET /api/world/grid/g1'))).toBe(true);
  });

  it('forwards terrain tile level/tx/ty and keeps immutable caching', async () => {
    const routes = worldProxyRoutesFor({ RTS_TELEMETRY_TEST_BASE: base });
    const route = routes.find((r) => r.pattern.test('/api/demo/terrain/3737/front'))!;
    const out = await call(route, '/api/demo/terrain/3737/front?level=2&tx=1&ty=2&h=key');
    expect(out.status).toBe(200);
    expect(out.body.toString('utf8')).toBe('SETR');
    expect(hits).toContain('GET /api/terrain/3737/front?level=2&tx=1&ty=2&h=key');
    expect(out.headers['cache-control']).toContain('immutable');
  });

  it('serves terrain planets, world status and the block catalog as JSON', async () => {
    const routes = worldProxyRoutesFor({ RTS_TELEMETRY_TEST_BASE: base });
    for (const [path, key] of [
      ['/api/demo/terrain/planets', 'planets'],
      ['/api/demo/world/status', 'block_count'],
      ['/api/demo/blocks/catalog', 'subtypes'],
    ] as const) {
      const route = routes.find((r) => r.pattern.test(path))!;
      const out = await call(route, path);
      expect(out.status).toBe(200);
      expect(Object.keys(JSON.parse(out.body.toString('utf8')))).toContain(key);
    }
  });

  it('reports a clear 502 when the test-world instance is down', async () => {
    await expect(fetchUpstream('/api/world/status', 'http://127.0.0.1:9', 500)).rejects.toMatchObject({
      status: 502,
      code: 'telemetry_test_unavailable',
    });
    await expect(fetchUpstream('/api/world/status', 'http://127.0.0.1:9', 500)).rejects.toBeInstanceOf(DemoHttpError);
  });
});
