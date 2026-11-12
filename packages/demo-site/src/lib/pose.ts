import type { DemoNode, Vec3 } from '../types';
import type { WorldGrid } from './worldMapTypes';

/**
 * Live-pose helpers for the block-shape layer.
 *
 * The demo places every grid's block model at the plugin telemetry position
 * (2 s cadence). Orientation is not in the plugin's telemetry message yet, so
 * the save quat is the fallback; the moment the plugin reports `quat` on a
 * telemetry entry this picks it up.
 */
export const GRID_PREFIX = 'grid:';

export function gridKey(nodeId: string): string {
  return nodeId.startsWith(GRID_PREFIX) ? nodeId.slice(GRID_PREFIX.length) : nodeId;
}

export interface TelemetryQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function poseQuat(node: DemoNode, grid: WorldGrid): [number, number, number, number] {
  const live = (node.telemetry as unknown as { quat?: TelemetryQuat } | null)?.quat;
  if (
    live &&
    Number.isFinite(live.x) &&
    Number.isFinite(live.y) &&
    Number.isFinite(live.z) &&
    Number.isFinite(live.w)
  ) {
    return [live.x, live.y, live.z, live.w];
  }
  return [grid.quat.x, grid.quat.y, grid.quat.z, grid.quat.w];
}

export function livePos(node: DemoNode, grid: WorldGrid): Vec3 {
  return node.telemetry?.pos ?? node.position ?? grid.pos;
}
