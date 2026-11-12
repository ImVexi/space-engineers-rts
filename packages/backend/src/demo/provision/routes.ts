/**
 * HTTP surface for auto-provisioning (test server only; same token + env lock
 * as the rest of /api/demo).
 *
 *   GET  /api/demo/provision/state    bases, drones, lastRun, issues
 *   POST /api/demo/provision/apply    {gridId}  force one re-apply
 *   POST /api/demo/provision/teleport {target}  move the owner's character
 *   GET  /api/demo/provision/profiles the profile data as sent to the plugin
 */
import type http from 'node:http';
import { z } from 'zod';
import { formatIssues } from '@se-rts/schemas';
import { DemoHttpError } from '../routes.js';
import { resolveDemoEnv } from '../env.js';
import type { DemoRoute } from '../routes.js';
import {
  ProvisionError,
  callPlugin,
  loadProfiles,
  provisionerFor,
  teleportOwner,
  type ProvisionDeps,
  type TeleportTarget,
} from './provisioner.js';

const MAX_BODY_BYTES = 64 * 1024;

const TeleportBody = z.object({
  target: z.union([
    z.string().min(1),
    z.object({ x: z.number(), y: z.number(), z: z.number() }),
  ]),
});

const ApplyBody = z.object({ gridId: z.string().min(1) });

const InspectBody = z.object({
  gridId: z.string().min(1),
  filter: z.record(z.unknown()).optional(),
  ids: z.array(z.string()).optional(),
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

/** Re-throw provision errors as the error type the server already maps. */
function wrap(err: unknown): never {
  if (err instanceof ProvisionError) throw new DemoHttpError(err.status, err.code, err.message, err.issues);
  throw err;
}

export function provisionRoutesFor(deps: ProvisionDeps): DemoRoute[] {
  const env = resolveDemoEnv();
  if (!env) return [];

  return [
    {
      method: 'GET',
      pattern: /^\/api\/demo\/provision\/state$/,
      handler: ({ res }) => {
        const provisioner = provisionerFor(deps);
        sendJson(res, 200, { ...provisioner.state(), demoEnv: env.badge });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/demo\/provision\/profiles$/,
      handler: ({ res }) => {
        const profiles = loadProfiles();
        sendJson(res, 200, {
          version: profiles.version,
          owner: profiles.owner,
          tags: profiles.tags,
          enums: profiles.enums,
          profiles: profiles.profiles,
          note: 'the provisioner sends these steps to the plugin set_block_props action as data; editing this file needs a backend restart only',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/provision\/apply$/,
      handler: async ({ req, res }) => {
        const parsed = ApplyBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'apply needs {gridId}', formatIssues(parsed.error));
        try {
          const provisioner = provisionerFor(deps);
          const run = await provisioner.runOnce(parsed.data.gridId);
          const record = provisioner.record(parsed.data.gridId);
          if (!record) {
            throw new DemoHttpError(
              404,
              'not_tagged',
              `${parsed.data.gridId} is not a tagged grid the provisioner can see (or its owner is not the owner identity)`,
              run.errors,
            );
          }
          sendJson(res, 200, { run, grid: record, state: provisioner.state() });
        } catch (err) {
          wrap(err);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/provision\/save$/,
      handler: async ({ res }) => {
        // Force a world save through the plugin (the DS does not save on stop).
        // Used before a restart so nothing built since the last autosave is lost.
        try {
          const result = await callPlugin(deps, 'save', {}, 30_000);
          sendJson(res, 200, result);
        } catch (err) {
          wrap(err);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/provision\/inspect$/,
      handler: async ({ req, res }) => {
        // Read-only passthrough to the plugin's get_block_props: the only honest
        // way to learn a property id or its range before writing a profile step.
        const parsed = InspectBody.safeParse(await readJson(req));
        if (!parsed.success) throw new DemoHttpError(400, 'invalid', 'inspect needs {gridId, filter?, ids?}', formatIssues(parsed.error));
        try {
          const result = await callPlugin(deps, 'get_block_props', {
            entityId: parsed.data.gridId,
            filter: parsed.data.filter ?? {},
            ...(parsed.data.ids ? { ids: parsed.data.ids } : {}),
          }, 20_000);
          sendJson(res, 200, result);
        } catch (err) {
          wrap(err);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/demo\/provision\/teleport$/,
      handler: async ({ req, res }) => {
        const parsed = TeleportBody.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new DemoHttpError(400, 'invalid', 'teleport needs {target:"planet:<name>"|"grid:<id>"|{x,y,z}}', formatIssues(parsed.error));
        }
        try {
          const result = await teleportOwner(deps, parsed.data.target as TeleportTarget);
          sendJson(res, 200, result);
        } catch (err) {
          wrap(err);
        }
      },
    },
  ];
}
