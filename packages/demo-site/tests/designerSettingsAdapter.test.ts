import { describe, expect, it } from 'vitest';
import { adaptDesignerSettings } from '../src/api';

/**
 * The shipped backend wraps settings as {settings, defaults, live}; the
 * contract shape is flat. Both must produce a usable, finite form state.
 */
describe('adaptDesignerSettings', () => {
  it('reads the flat contract shape', () => {
    expect(adaptDesignerSettings({ simSpeedMin: 0.92, maxActive: 7 })).toMatchObject({
      simSpeedMin: 0.92,
      maxActive: 7,
    });
  });

  it('reads the nested backend shape and its live SimSpeed', () => {
    const adapted = adaptDesignerSettings({
      settings: { simSpeedMin: 0.97, maxActive: 4 },
      defaults: { simSpeedMin: 0.95, maxActive: 5 },
      live: { simSpeed: 1.01, threshold: 0.97 },
    });
    expect(adapted).toMatchObject({ simSpeedMin: 0.97, maxActive: 4, liveSimSpeed: 1.01, threshold: 0.97 });
  });

  it('never yields undefined/NaN for an empty or partial payload', () => {
    for (const payload of [{}, null, undefined, { settings: {} }, { defaults: { maxActive: 3 } }]) {
      const adapted = adaptDesignerSettings(payload);
      expect(Number.isFinite(adapted.simSpeedMin)).toBe(true);
      expect(Number.isFinite(adapted.maxActive)).toBe(true);
      expect(adapted.simSpeedMin).toBeGreaterThanOrEqual(0.5);
      expect(adapted.maxActive).toBeGreaterThanOrEqual(1);
    }
  });
});
