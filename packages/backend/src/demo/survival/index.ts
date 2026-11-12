/**
 * T66 survival loop: the refuel/recharge round trip for MANAGED grids.
 *
 * `loop.ts` is pure (trigger, home, landing spot, states). `service.ts` runs it
 * against live telemetry and starts missions through the normal guarded path.
 */
export * from './loop.js';
export { SurvivalService, altitudeAgl, type SurvivalDeps, type SurvivalTickResult } from './service.js';
