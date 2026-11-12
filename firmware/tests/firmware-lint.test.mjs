import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lintFirmware, MAX_CHARS } from '../tools/firmware-lint.mjs';

const FIRMWARE = readFileSync(new URL('../HermesFirmware.cs', import.meta.url), 'utf8');

describe('firmware lint', () => {
  it('accepts the shipped firmware', () => {
    const result = lintFirmware(FIRMWARE);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stats.chars).toBeLessThan(MAX_CHARS);
  });

  it('rejects a script over the PB size limit', () => {
    const big = FIRMWARE + '\n//' + 'x'.repeat(MAX_CHARS);
    const result = lintFirmware(big);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('over the');
  });

  it('rejects forbidden namespaces', () => {
    const bad = FIRMWARE.replace('public Program()', 'using System.Net;\npublic Program()');
    const result = lintFirmware(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('no network');
  });

  it('rejects a script missing required entry points', () => {
    const result = lintFirmware('const string FIRMWARE_VERSION = "x";');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('public void Main');
    expect(result.errors.join(' ')).toContain('public void Save');
  });

  it('warns about unbounded loops', () => {
    const result = lintFirmware(FIRMWARE + '\nvoid Spin(){ while (true) { } }');
    expect(result.warnings.join(' ')).toContain('unbounded while(true)');
  });
});
