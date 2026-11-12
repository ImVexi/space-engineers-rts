#!/usr/bin/env node
/**
 * Verify a demo-site build/deploy is test-locked before calling it done.
 *
 * The site renders "Demo site locked" when it was built without
 * VITE_DEMO_ENV=test or without VITE_DEMO_API_BASE. That string is always in
 * the JS bundle (it is the lock screen), so grepping the bundle is useless.
 * Instead vite.config.ts stamps the resolved build values into <head>:
 *
 *   <meta name="demo-build-env" content="test">
 *   <meta name="demo-build-api-base" content="/api">
 *
 * This script checks the local dist and, with --url, the live page served by
 * the backend (a headless HTTP load of the deployed artifact).
 *
 * Usage:
 *   node scripts/verify-demo-deploy.mjs [--dist packages/demo-site/dist] [--url http://127.0.0.1:8762/demo/]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dist = resolve(opt('--dist', 'packages/demo-site/dist'));
const liveUrl = opt('--url', null);
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function pass(message) {
  console.log(`ok   ${message}`);
}

function meta(html, name) {
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function checkHtml(html, where) {
  const env = meta(html, 'demo-build-env');
  const api = meta(html, 'demo-build-api-base');
  if (env === 'test') pass(`${where}: demo-build-env=test`);
  else fail(`${where}: demo-build-env is ${JSON.stringify(env)} (expected "test")`);
  if (api === '/api') pass(`${where}: demo-build-api-base=/api`);
  else fail(`${where}: demo-build-api-base is ${JSON.stringify(api)} (expected "/api")`);
  if (/demo-build-env["']?\s+content=["']test/i.test(html) && /Demo site locked/i.test(html)) {
    fail(`${where}: page markup contains the lock screen title`);
  }
}

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`FAIL no index.html at ${indexPath} (build first)`);
  process.exit(1);
}
checkHtml(readFileSync(indexPath, 'utf8'), `dist ${dist}`);

if (liveUrl) {
  const base = liveUrl.endsWith('/') ? liveUrl : `${liveUrl}/`;
  let html;
  try {
    const res = await fetch(base, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
    pass(`live ${base}: HTTP ${res.status}`);
  } catch (err) {
    fail(`live ${base}: ${err instanceof Error ? err.message : String(err)}`);
    html = null;
  }
  if (html) {
    checkHtml(html, `live ${base}`);
    const script = html.match(/<script[^>]+src=["']([^"']+\.js)["']/i)?.[1];
    if (!script) {
      fail(`live ${base}: no JS bundle referenced`);
    } else {
      const url = new URL(script, base).toString();
      try {
        const res = await fetch(url);
        const body = await res.text();
        if (!res.ok) fail(`live bundle ${url}: HTTP ${res.status}`);
        else if (!body.includes('se-rts-demo-token')) fail(`live bundle ${url}: not the demo app bundle`);
        else pass(`live bundle ${url}: ${Math.round(body.length / 1024)} KiB, app marker present`);
      } catch (err) {
        fail(`live bundle ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — do NOT report the deploy as done.`);
  process.exit(1);
}
console.log('\nDemo deploy verified: test lock present, /api base present, live page loads.');
