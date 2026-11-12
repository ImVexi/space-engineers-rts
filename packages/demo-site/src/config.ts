/**
 * Build-time lock. There is deliberately NO production fallback: a build
 * without `VITE_DEMO_ENV=test` (SE-RTS Test Lab) or `VITE_DEMO_ENV=live` (the
 * separate survival instance on 8763) renders a lockdown screen instead of the
 * map. The API base may be empty only when the site is served same-origin from
 * the backend at /demo/; an environment token is never inlined — the browser
 * asks for it once and keeps it in localStorage.
 *
 * The two env values differ in wording only (never "TEST SERVER" on the live
 * instance) and in nothing else: every admin capability is refused by the
 * backend's survival mode, not by this file.
 */
const rawApiBase = (import.meta.env.VITE_DEMO_API_BASE as string | undefined) ?? '';
const rawEnv = (import.meta.env.VITE_DEMO_ENV as string | undefined) ?? '';

export const API_BASE = rawApiBase.trim().replace(/\/+$/, '');
export const DEMO_ENV = rawEnv.trim().toLowerCase();
export const TOKEN_STORAGE_KEY = 'se-rts-demo-token';

/**
 * Compared inline (not through `DEMO_ENV`) so a minified build keeps only the
 * branch it was compiled for: the live bundle must not carry the test strings.
 */
export const IS_LIVE = (import.meta.env.VITE_DEMO_ENV as string | undefined) === 'live';

const LOOPBACK_OR_TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '127.0.0.1']);

/** Returns a human-readable refusal, or null when the build targets a real backend. */
export function lockRefusal(): string | null {
  if (DEMO_ENV !== 'test' && DEMO_ENV !== 'live') {
    return 'Refusing to run: this build must be compiled with VITE_DEMO_ENV=test (test world) or VITE_DEMO_ENV=live (survival instance).';
  }
  if (!API_BASE) {
    return 'Refusing to run: VITE_DEMO_API_BASE is required (use /api when served same-origin at /demo/).';
  }
  if (/^https?:\/\//i.test(API_BASE)) {
    let url: URL;
    try {
      url = new URL(API_BASE);
    } catch {
      return `Refusing to run: invalid VITE_DEMO_API_BASE ${API_BASE}`;
    }
    if (url.protocol !== 'http:') {
      return 'Refusing to run: the demo API must be plain http on a loopback/LAN host.';
    }
    if (!LOOPBACK_OR_TEST_HOSTS.has(url.hostname)) {
      return `Refusing to run: ${url.hostname} is not a LAN backend host (127.0.0.1 / localhost / 127.0.0.1).`;
    }
  }
  return null;
}

// Exact match on the raw value (no method calls) so the bundler folds the
// branch and the live bundle keeps ONLY the survival wording.
const LIVE_ENV = (import.meta.env.VITE_DEMO_ENV as string | undefined) === 'live';

export const TEST_SERVER_BADGE = LIVE_ENV ? 'SURVIVAL MODE — live server' : 'TEST SERVER — SE-RTS Test Lab';
export const TELEMETRY_BADGE = LIVE_ENV
  ? 'LIVE — positions from plugin telemetry, ~2 s'
  : 'TEST SERVER — positions from plugin telemetry, ~2 s';

/** Header badge for this build: the survival instance never says "TEST SERVER". */
export const SERVER_BADGE = TEST_SERVER_BADGE;
