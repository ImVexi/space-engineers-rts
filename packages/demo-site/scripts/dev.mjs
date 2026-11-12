#!/usr/bin/env node
/**
 * `npm run demo:dev` — starts the TEST-LOCKED demo backend and the demo site.
 *
 * Both processes are bound to loopback. The backend refuses to start unless
 * RTS_ENV=test and RTS_TEST_SERVER_MARKER=se-rts-test are set here; the
 * site is compiled with VITE_DEMO_ENV=test and an explicit API base.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../../..');
const backendPort = process.env.DEMO_BACKEND_PORT ?? '8763';
const sitePort = '8764';

const backendEnv = {
  ...process.env,
  RTS_DEMO: '1',
  RTS_ENV: 'test',
  RTS_TEST_SERVER_MARKER: 'se-rts-test',
  RTS_BIND: '127.0.0.1',
  RTS_PORT: backendPort,
  RTS_DATA_DIR: path.join(root, 'data/demo'),
};
const siteEnv = {
  ...process.env,
  VITE_DEMO_ENV: 'test',
  VITE_DEMO_API_BASE: '/api',
  DEMO_BACKEND_PORT: backendPort,
};

const children = [];
function run(label, command, args, cwd, env) {
  // Same process group as this script: Ctrl-C reaches the real server children.
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[demo:dev] ${label} exited with ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown(signal) {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[demo:dev] backend  http://127.0.0.1:${backendPort} (TEST LOCKED)`);
console.log(`[demo:dev] site     http://127.0.0.1:${sitePort} (TEST LOCKED)`);
run('backend', 'npx', ['tsx', 'packages/backend/src/index.ts'], root, backendEnv);

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${backendPort}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('demo backend did not become healthy on 127.0.0.1:' + backendPort);
}

try {
  await waitForHealth();
  console.log('[demo:dev] backend healthy; starting site');
  run('site', 'npm', ['--workspace', '@se-rts/demo-site', 'run', 'dev'], root, siteEnv);
} catch (err) {
  console.error('[demo:dev]', err instanceof Error ? err.message : err);
  shutdown('SIGTERM');
}
