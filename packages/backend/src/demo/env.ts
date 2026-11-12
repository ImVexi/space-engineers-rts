/**
 * Hard test-environment lock for the demo routes.
 *
 * The demo site and its write routes exist ONLY for the isolated test server
 * (`SE-RTS Test Lab`). There is no production fallback: enabling the demo
 * without `RTS_ENV=test` is a startup error, never a warning. T74: the test
 * MARKER is no longer a boot requirement - without it the process boots as a
 * hosted/survival deployment and refuses every admin capability at runtime
 * (demo/survival.ts) instead of refusing to start.
 */
export const DEMO_ENV = 'test';
export const DEMO_MARKER = 'se-rts-test';
/**
 * T78: a HOSTED deployment (the owner's live survival server) that mounts the
 * demo runtime in survival mode. Before this, the only way to boot the runtime
 * on a non-test server was to claim `RTS_ENV=test` and rely on the missing
 * marker - an env name that lies, and one copied `RTS_TEST_SERVER_MARKER` line
 * away from being a cheat-enabled backend pointed at the live world.
 *
 * `RTS_ENV=live` additionally requires `RTS_DEMO_SURVIVAL=1` (an explicit
 * opt-in, never a default) and REFUSES to boot when the test marker or a world
 * fixture is present: on this env survival mode is structural, not a value the
 * environment could talk its way out of.
 */
export const HOSTED_ENV = 'live';
export const HOSTED_OPT_IN = 'RTS_DEMO_SURVIVAL';

export interface DemoEnv {
  /** JSON world fixture; omitted means the built-in stand-in world. */
  fixturePath: string | null;
  /** UI badge text, fixed so it cannot be changed to something reassuring. */
  badge: string;
  /** T74: true only on the marked test world (see demo/survival.ts). */
  testLocked: boolean;
}

export class DemoEnvError extends Error {
  constructor(message: string) {
    super(`demo routes refused to start: ${message}`);
    this.name = 'DemoEnvError';
  }
}

/**
 * Returns the demo config when `RTS_DEMO=1`, or `null` when the demo is not
 * requested. Throws when requested without the test-server lock.
 */
export function resolveDemoEnv(env: NodeJS.ProcessEnv = process.env): DemoEnv | null {
  if (env.RTS_DEMO !== '1') return null;

  const name = (env.RTS_ENV ?? '').trim().toLowerCase();
  const marker = (env.RTS_TEST_SERVER_MARKER ?? '').trim();
  const fixture = env.RTS_DEMO_STATE?.trim();
  const problems: string[] = [];

  if (name === HOSTED_ENV) {
    // Hosted/survival deployment. Survival mode is structural here: the opt-in
    // is explicit, and the two things that could quietly turn this into a test
    // world are a boot error instead of a warning.
    if ((env[HOSTED_OPT_IN] ?? '').trim() !== '1') {
      problems.push(`${HOSTED_OPT_IN}=1 is required with RTS_ENV="${HOSTED_ENV}" (survival runtime, opt-in only)`);
    }
    if (marker) {
      problems.push(
        `RTS_ENV="${HOSTED_ENV}" must not carry RTS_TEST_SERVER_MARKER (got "${marker}"): that pair is the test world`,
      );
    }
    if (fixture) {
      problems.push(`RTS_DEMO_STATE (world fixture) is test-server only and is refused on RTS_ENV="${HOSTED_ENV}"`);
    }
  } else if (name !== DEMO_ENV) {
    problems.push(`RTS_ENV must be "${DEMO_ENV}" (got "${env.RTS_ENV ?? ''}") or "${HOSTED_ENV}" with ${HOSTED_OPT_IN}=1`);
  }
  if (problems.length) throw new DemoEnvError(problems.join('; '));
  // T74: the marker decides SURVIVAL MODE, not whether the routes load. Without
  // it the process is a hosted/survival deployment: every route still serves,
  // but the admin capabilities are refused (demo/survival.ts) and the badge says
  // so. Before T74 the marker was a boot lock; a hosted server now starts and
  // says plainly what it will not do, which is what a vanilla operator needs.
  // T78: `RTS_ENV=live` refuses the marker above, so testLocked is false there
  // by construction.
  const testLocked = name !== HOSTED_ENV && marker === DEMO_MARKER;

  return {
    fixturePath: fixture ? fixture : null,
    badge: testLocked ? 'TEST SERVER — SE-RTS Test Lab' : 'SURVIVAL MODE — no spawning, no deletes, no teleports',
    testLocked,
  };
}
