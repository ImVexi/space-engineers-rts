/**
 * HTTP surface for auto-naming and the laser link readout (test server only;
 * same token + RTS_DEMO env lock as the rest of /api/demo).
 *
 *   GET  /api/demo/naming             names, counters, last run, last laser test
 *   POST /api/demo/naming/sync        force one naming pass over tagged grids
 *   POST /api/demo/naming/rename      {gridId, name} — rename + set owner override
 *   POST /api/demo/naming/laser-test  {gridA?, gridB?, timeoutMs?, permanent?}
 */
import type http from 'node:http';
import { z } from 'zod';
import { formatIssues } from '@se-rts/schemas';
import { DemoHttpError } from '../routes.js';
import { resolveDemoEnv } from '../env.js';
import type { DemoRoute } from '../routes.js';
import { namingFor, type NamingDeps } from './naming.js';

const MAX_BODY_BYTES = 64 * 1024;

const RenameBody = z.object({
  gridId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
});

const LaserBody = z.object({
  gridA: z.string().min(1).optional(),
  gridB: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(5_000).max(120_000).optional(),
  permanent: z.boolean().optional(),
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new DemoHttpError(413, 'body_too_large', 'request body is too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DemoHttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function namingRoutesFor(deps: NamingDeps): DemoRoute[] {
  const env = resolveDemoEnv();
  if (!env) return [];

  return [
    {
      method: 'GET',
      pattern: /^\/api\/demo\/naming$/,
      handler: ({ res }) => {
        sendJson(res, 200, { ...namingFor(deps).state(), names: namingFor(deps).names(), demoEnv: env.badge });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/naming\/sync$/,
      handler: async ({ res }) => {
        const { callPlugin, loadProfiles } = await import('../provision/provisioner.js');
        const profiles = loadProfiles();
        try {
          const listed = await callPlugin(deps, 'list_tagged', {
            tags: [profiles.tags.BASE, profiles.tags.DRONE],
          });
          const grids = ((listed.result?.grids as import('../provision/provisioner.js').TaggedGrid[] | undefined) ?? []).filter(Boolean);
          const run = await namingFor(deps).sync(grids);
          sendJson(res, 200, { run, state: namingFor(deps).state() });
        } catch (err) {
          if (err instanceof DemoHttpError) throw err;
          throw new DemoHttpError(502, 'plugin_error', err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/naming\/rename$/,
      handler: async ({ req, res }) => {
        const parsed = RenameBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'rename needs {gridId, name}', formatIssues(parsed.error));
        }
        try {
          const result = await namingFor(deps).manualRename(parsed.data.gridId, parsed.data.name);
          sendJson(res, 200, { ...result, state: namingFor(deps).state() });
        } catch (err) {
          throw new DemoHttpError(502, 'rename_failed', err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/naming\/lasers$/,
      handler: async ({ req, res, url }) => {
        // Live laser readout: status, target, connected-to, range, power.
        const gridId = url?.searchParams.get('gridId') ?? undefined;
        try {
          const { callPlugin, loadProfiles } = await import('../provision/provisioner.js');
          let params: Record<string, unknown>;
          if (gridId) {
            params = { gridId };
          } else {
            const listed = await callPlugin(deps, 'list_tagged', { tags: [loadProfiles().tags.DRONE] }, 15_000);
            const ids = ((listed.result?.grids as { gridId: string }[] | undefined) ?? []).map((g) => g.gridId);
            params = { gridIds: ids };
          }
          const result = await callPlugin(deps, 'laser_state', params, 20_000);
          sendJson(res, 200, result);
        } catch (err) {
          throw new DemoHttpError(502, 'plugin_error', err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/naming\/laser-test$/,
      handler: async ({ req, res }) => {
        const parsed = LaserBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'laser-test body is {gridA?, gridB?, timeoutMs?, permanent?}', formatIssues(parsed.error));
        }
        try {
          const result = await namingFor(deps).runLaserTest(parsed.data);
          sendJson(res, 200, result);
        } catch (err) {
          // A missing laser pair is a refusal, not a server fault; report the
          // reason with the last known state so the caller sees why.
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 409, { ok: false, reason: message, last: namingFor(deps).laserTest() });
        }
      },
    },
  ];
}
