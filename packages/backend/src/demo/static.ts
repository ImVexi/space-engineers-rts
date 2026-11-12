import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

/**
 * Same-origin static hosting for the built demo site at /demo/.
 *
 * LAN-only by construction: the backend itself binds to the test host. The
 * page is public so it can load and ask for a token; every /api call still
 * requires the bearer token. No environment token is ever inlined.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function demoDistDir(): string {
  return process.env.RTS_DEMO_DIST?.trim() || path.resolve(process.cwd(), 'packages/demo-site/dist');
}

/** Serve GET/HEAD /demo/* from the built site. Returns true when handled. */
export function serveDemoStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname !== '/demo' && !url.pathname.startsWith('/demo/')) return false;

  const root = demoDistDir();
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice('/demo'.length));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad path\n');
    return true;
  }
  if (url.pathname === '/demo') {
    res.writeHead(302, { location: '/demo/' }).end();
    return true;
  }
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const target = path.resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden\n');
    return true;
  }
  // Unknown extensionless paths fall back to the SPA entry point.
  const file = fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(root, 'index.html');
  if (!fs.existsSync(file)) return false;

  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}
