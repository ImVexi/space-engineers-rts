import { describe, expect, it } from 'vitest';
import { FEATURE_FLAGS, isLoopbackBind, loadConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

describe('config and the "never published" rule', () => {
  it('defaults to loopback, all feature flags off, and no auto mission types', () => {
    const config = loadConfig({ RTS_DATA_DIR: tempDir() });
    expect(config.bind).toBe('127.0.0.1');
    expect(config.token).toBe('');
    for (const flag of FEATURE_FLAGS) expect(config.flags[flag]).toBe(false);
    expect(config.autoMissionTypes).toEqual([]);
    expect(config.caps.maxQueuedBuilds).toBe(8);
    expect(config.caps.maxOrderAttempts).toBe(3);
  });

  it('refuses a non-loopback bind without a strong token', () => {
    expect(() => loadConfig({ RTS_DATA_DIR: tempDir(), RTS_BIND: '0.0.0.0' })).toThrow(/RTS_TOKEN/);
    expect(() =>
      loadConfig({ RTS_DATA_DIR: tempDir(), RTS_BIND: '192.0.2.10', RTS_TOKEN: 'short' }),
    ).toThrow(/RTS_TOKEN/);
  });

  it('allows a LAN bind only with a token', () => {
    const config = loadConfig({
      RTS_DATA_DIR: tempDir(),
      RTS_BIND: '192.0.2.10',
      RTS_TOKEN: 'a-sufficiently-long-token',
    });
    expect(config.bind).toBe('192.0.2.10');
    expect(config.token).toBe('a-sufficiently-long-token');
  });

  it('parses flags and auto-mission allowlists explicitly', () => {
    const config = loadConfig({
      RTS_DATA_DIR: tempDir(),
      RTS_FLAGS: 'reconciler, dispatch',
      RTS_AUTO_MISSION_TYPES: 'move,scout',
    });
    expect(config.flags.reconciler).toBe(true);
    expect(config.flags.dispatch).toBe(true);
    expect(config.flags.plugin_orders).toBe(false);
    expect(config.autoMissionTypes).toEqual(['move', 'scout']);
  });

  it('defaults the demo flight cap to 100 m/s and clamps RTS_DEMO_SPEED_MPS', () => {
    expect(loadConfig({ RTS_DATA_DIR: tempDir() }).demo.speedLimitMps).toBe(100);
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: '80' }).demo.speedLimitMps).toBe(80);
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: '100' }).demo.speedLimitMps).toBe(100);
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: '60' }).demo.speedLimitMps).toBe(60);
    // The running unit's drop-in sets RTS_DEMO_SPEED_MPS=120 (owner-set,
    // 2026-11-09). SE's autopilot tops out at 100 m/s, so 120 must resolve to
    // 100 - not 120, and not an error.
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: '120' }).demo.speedLimitMps).toBe(100);
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: '400' }).demo.speedLimitMps).toBe(100);
    expect(loadConfig({ RTS_DATA_DIR: tempDir(), RTS_DEMO_SPEED_MPS: 'nope' }).demo.speedLimitMps).toBe(100);
  });

  it('classifies loopback addresses', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('127.10.0.5')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('localhost')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(isLoopbackBind('192.0.2.10')).toBe(false);
  });
});
