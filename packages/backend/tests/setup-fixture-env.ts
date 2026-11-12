/**
 * T74: the suite runs as the MARKED TEST WORLD.
 *
 * `resolveSurvivalMode()` (demo/survival.ts) is ON unless the process is
 * `RTS_ENV=test` AND `RTS_TEST_SERVER_MARKER=se-rts-test`. That default is
 * the safe one for a hosted deployment, but most demo tests exercise the
 * harness capabilities (spawn, clone, zero_velocity, delete_grid) that only
 * exist on the test world - they were written for it and must keep running as
 * it.
 *
 * So the fixture env is declared once, here, instead of every test file
 * repeating it. The rule itself is still asserted WITHOUT this fixture, by
 * passing explicit env objects to `resolveSurvivalMode()` /
 * `isTestEnvironment()` in tests/survival-mode.test.ts; nothing about survival
 * mode is proven by the ambient env.
 *
 * Only the two T74 keys are set: RTS_DEMO/RTS_FLAGS stay untouched so the
 * config defaults every other test relies on do not move.
 */
process.env.RTS_ENV = 'test';
process.env.RTS_TEST_SERVER_MARKER = 'se-rts-test';
