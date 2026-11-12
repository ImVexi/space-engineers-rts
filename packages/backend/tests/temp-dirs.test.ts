import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanupTempDirs, openTempDirCount, tempDir } from './helpers.js';

/**
 * The temp-dir registry (2026-11-11): the suite left one `se-rts-test-*` dir
 * per temp store behind (22 478 dirs / 1.4 GB). `tempDir()` now registers what
 * it creates and `setup-temp-dirs.ts` removes the file's dirs at afterAll.
 * This file asserts the removal path itself, on its own registry.
 */
describe('C temp dirs: created dirs are tracked and removable', () => {
  it('creates a dir, registers it, and removes it on cleanup', () => {
    expect(openTempDirCount()).toBe(0);
    const dir = tempDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir.split('/').pop()).toMatch(/^se-rts-test-/);
    expect(openTempDirCount()).toBe(1);

    const second = tempDir('se-rts-test-extra-');
    expect(openTempDirCount()).toBe(2);

    expect(cleanupTempDirs()).toBe(2);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(openTempDirCount()).toBe(0);
  });

  it('cleanup is idempotent (a second call removes nothing and throws nothing)', () => {
    tempDir();
    expect(cleanupTempDirs()).toBe(1);
    expect(cleanupTempDirs()).toBe(0);
  });
});
