/**
 * Thrust staging (T8): fuel-saving bank management for demo drones.
 *
 * See docs/staging.md. The module is backend-only: it drives the existing
 * plugin `set_block_props` action, so no plugin rebuild or game restart.
 */
export * from './hardware.js';
export * from './policy.js';
export * from './controller.js';
