/**
 * T23 radio range pulses: pure geometry/animation maths.
 *
 * Scene units are kilometres. A ring's radius is the node's real radio radius
 * in metres / 1000 — never exaggerated. The pulse only animates the drawn
 * radius between 15 % and 100 % of that real radius, so the outer edge always
 * shows the true footprint.
 */
import type { Vec3 } from '../types';

export const PULSE_PERIOD_S = 6;
/** Radius share at the start of a pulse. */
export const RING_MIN_SCALE = 0.15;
/** Peak opacity: gentle, the ring is an annotation, not a light show. */
export const RING_MAX_OPACITY = 0.35;
/** Slow / normal pulse speeds offered by the overlay toggle. */
export const PULSE_PERIOD_SLOW_S = 12;
/** Rings thinner than this on screen are noise. */
export const RING_HIDE_BELOW_PX = 0.5;
/** Ring stroke never drops below 2 px. */
export const RING_MIN_WIDTH_PX = 2;
export const RING_MAX_WIDTH_PX = 8;
/** At most this many rings pulse at once (nearest to the camera). */
export const RING_MAX_ACTIVE = 40;
export const METERS_PER_KM = 1000;

/** Stable per-node phase in [0,1): same node always starts at the same offset. */
export function phaseForId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

export interface Pulse {
  /** 0.15 .. 1.0 */
  scale: number;
  /** 0 .. 1, brightest at the start of the cycle */
  opacity: number;
}

/** Cubic ease-out: expands fast, settles at the true radius. */
export function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

/** Pulse state at time `t` seconds for a node with `phase` in [0,1). */
export function pulseAt(t: number, phase: number, period = PULSE_PERIOD_S): Pulse {
  const p = period > 0 ? period : PULSE_PERIOD_S;
  const cycle = ((t / p + phase) % 1 + 1) % 1;
  return {
    scale: RING_MIN_SCALE + (1 - RING_MIN_SCALE) * easeOutCubic(cycle),
    opacity: RING_MAX_OPACITY * Math.pow(1 - cycle, 1.2),
  };
}

/** Ring radius in scene units for a real radius in metres. */
export function ringRadiusUnits(radiusM: number, scale = 1): number {
  if (!Number.isFinite(radiusM) || radiusM <= 0) return 0;
  const clamped = scale > 0 ? scale : 0;
  return (radiusM / METERS_PER_KM) * clamped;
}

/** Screen radius in pixels for a world radius at a camera distance. */
export function screenRadiusPx(
  radiusUnits: number,
  cameraDistanceUnits: number,
  fovDeg: number,
  viewportHeightPx: number,
): number {
  if (!Number.isFinite(radiusUnits) || radiusUnits <= 0) return 0;
  if (!Number.isFinite(cameraDistanceUnits) || cameraDistanceUnits <= 0) return 0;
  const height = Math.max(viewportHeightPx, 1);
  const worldHeight = 2 * cameraDistanceUnits * Math.tan((fovDeg * Math.PI) / 360);
  if (worldHeight <= 0) return 0;
  return (radiusUnits / worldHeight) * height;
}

export function ringVisible(radiusPx: number): boolean {
  return Number.isFinite(radiusPx) && radiusPx >= RING_HIDE_BELOW_PX;
}

/** Stroke width in pixels: clamped to at least 2 px so far rings stay visible. */
export function ringWidthPx(radiusPx: number): number {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return RING_MIN_WIDTH_PX;
  return Math.min(RING_MAX_WIDTH_PX, Math.max(RING_MIN_WIDTH_PX, radiusPx * 0.012));
}

/**
 * Inner radius of the annulus in unit space so the stroke is `widthPx` wide
 * on screen. Keeping `inner` close to 1 avoids a giant filled disc.
 */
export function ringInnerRatio(radiusPx: number): number {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return 0.99;
  const width = ringWidthPx(radiusPx);
  const ratio = 1 - width / radiusPx;
  return Math.max(0.5, Math.min(0.995, ratio));
}

export interface RingNode {
  id: string;
  position: Vec3;
  radioRadiusM: number | null;
}

/**
 * The nearest `max` nodes with a real radius, measured from the camera in
 * scene units (km). Stable order: distance, then id.
 */
export function pickPulsingNodes(nodes: RingNode[], cameraPos: Vec3, max = RING_MAX_ACTIVE): RingNode[] {
  const candidates = nodes
    .filter((n) => n.radioRadiusM !== null && n.radioRadiusM > 0)
    .map((n) => ({
      node: n,
      d: Math.hypot(n.position.x / METERS_PER_KM - cameraPos.x, n.position.y / METERS_PER_KM - cameraPos.y, n.position.z / METERS_PER_KM - cameraPos.z),
    }));
  candidates.sort((a, b) => (a.d === b.d ? a.node.id.localeCompare(b.node.id) : a.d - b.d));
  return candidates.slice(0, Math.max(0, max)).map((c) => c.node);
}
