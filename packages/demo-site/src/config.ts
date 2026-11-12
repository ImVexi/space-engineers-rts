/**
 * Build-time test lock. There is deliberately NO production fallback:
 * a build without `VITE_DEMO_ENV=test` renders a lockdown screen instead of
 * the map. The API base may be empty only when the site is served same-origin
 * from the backend at /demo/; an environment token is never inlined — the
 * browser asks for it once and keeps it in localStorage.
 */
const rawApiBase = (import.meta.env.VITE_DEMO_API_BASE as string | undefined) ?? '';
const rawEnv = (import.meta.env.VITE_DEMO_ENV as string | undefined) ?? '';

export const API_BASE = rawApiBase.trim().replace(/\/+$/, '');
export const DEMO_ENV = rawEnv.trim().toLowerCase();
export const TOKEN_STORAGE_KEY = 'se-rts-demo-token';

const LOOPBACK_OR_TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '127.0.0.1']);

/** Returns a human-readable refusal, or null when the build is locked to test. */
export function lockRefusal(): string | null {
  if (DEMO_ENV !== 'test') {
    return 'Refusing to run: this demo build must be compiled with VITE_DEMO_ENV=test. It is hard-locked to the SE-RTS Test Lab server.';
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
      return 'Refusing to run: the test demo API must be plain http on a loopback/LAN host.';
    }
    if (!LOOPBACK_OR_TEST_HOSTS.has(url.hostname)) {
      return `Refusing to run: ${url.hostname} is not the test host (127.0.0.1 / localhost / 127.0.0.1). Never point this site at production.`;
    }
  }
  return null;
}

export const TEST_SERVER_BADGE = 'TEST SERVER — SE-RTS Test Lab';
export const TELEMETRY_BADGE = 'TEST SERVER — positions from plugin telemetry, ~2 s';
