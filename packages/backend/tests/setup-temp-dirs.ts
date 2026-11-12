/**
 * Temp-dir hygiene for the suite (2026-11-11).
 *
 * `tempDir()` (helpers.ts) makes one `se-rts-test-*` dir per in-memory store /
 * runtime a test builds and nothing ever removed them: 22 478 dirs, 1.4 GB,
 * after a few days. This setup file runs once per test FILE, and `afterAll`
 * removes exactly the dirs that file created — no cross-run sweep, so a
 * second suite running at the same time keeps its own dirs.
 *
 * A dir is only removed by the file that made it; `cleanupTempDirs()` is also
 * exported so a test can assert the registry works.
 */
import { afterAll } from 'vitest';
import { cleanupTempDirs } from './helpers.js';

afterAll(() => {
  cleanupTempDirs();
});
