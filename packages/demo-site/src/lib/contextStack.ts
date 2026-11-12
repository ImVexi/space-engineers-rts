/**
 * The context stack: which camera level you are looking from, and the pose you
 * last had at each level so Esc can put it back exactly.
 *
 * Pure (no React, no three.js) so the enter/exit/restore rules are unit-testable
 * and so a poll can never rewrite the stack. Levels are stored as descriptors,
 * never as resolved objects: two polls produce different node objects, and
 * holding them would make "restore my pose" orbit a stale position.
 */
import type { CameraContext, ContextTarget, ContextWorld } from './cameraContext';
import { contextKey, systemTarget } from './cameraContext';

export interface ContextPose {
  yaw: number;
  pitch: number;
  distance: number;
  /**
   * Orbit centre at the time the pose was saved (km). Panning and flying move
   * the target inside a level, so restoring the angles alone would bring back
   * the wrong place; null/absent means "use this level's pivot".
   */
  target?: { x: number; y: number; z: number };
}

/**
 * Levels nest system > planet > group > ship. Entering a level drops any
 * trailing levels that cannot be its ancestors (e.g. picking a planet while
 * inside a ship level replaces the ship level instead of nesting it under it).
 */
const CONTEXT_RANK: Record<ContextTarget['kind'], number> = { system: 0, planet: 1, group: 2, ship: 3 };

export function contextRank(kind: ContextTarget['kind']): number {
  return CONTEXT_RANK[kind];
}

export interface CameraStackState {
  /** index 0 is always the system level */
  stack: ContextTarget[];
  /** saved pose per level key */
  poses: Record<string, ContextPose>;
}

export function initialStack(): CameraStackState {
  return { stack: [systemTarget()], poses: {} };
}

export function topTarget(state: CameraStackState): ContextTarget {
  return state.stack[state.stack.length - 1]!;
}

export function stackDepth(state: CameraStackState): number {
  return state.stack.length;
}

/** Remember the camera pose for the level you are on (called before leaving). */
export function savePose(state: CameraStackState, pose: ContextPose): CameraStackState {
  const key = contextKey(topTarget(state));
  return { ...state, poses: { ...state.poses, [key]: { ...pose } } };
}

export function poseFor(state: CameraStackState, target: ContextTarget): ContextPose | null {
  return state.poses[contextKey(target)] ?? null;
}

/**
 * Enter a level. Saving the pose of the level you are leaving is part of the
 * operation, so callers cannot forget it. Entering a level already in the stack
 * (a breadcrumb jump upward) truncates back to it instead of duplicating it.
 */
export function enterContext(state: CameraStackState, target: ContextTarget, pose: ContextPose): CameraStackState {
  const saved = savePose(state, pose);
  const key = contextKey(target);
  const rank = contextRank(target.kind);
  // Keep the ancestors that can actually contain this level (rank < target).
  const kept = saved.stack.filter((t, index) => index === 0 || contextRank(t.kind) < rank);
  const existing = kept.findIndex((t) => contextKey(t) === key);
  if (existing >= 0) return { ...saved, stack: kept.slice(0, existing + 1) };
  return { ...saved, stack: [...kept, target] };
}

export interface ExitResult {
  state: CameraStackState;
  /** the level you are now on, or null when already at the top level */
  parent: ContextTarget | null;
  /** that level's saved pose, or null when it was never visited */
  restored: ContextPose | null;
}

/** Esc: pop exactly one level and hand back the pose to restore. */
export function exitContext(state: CameraStackState, pose: ContextPose): ExitResult {
  if (state.stack.length <= 1) return { state: savePose(state, pose), parent: null, restored: null };
  const saved = savePose(state, pose);
  const stack = saved.stack.slice(0, -1);
  const parent = stack[stack.length - 1]!;
  return { state: { ...saved, stack }, parent, restored: poseFor(saved, parent) };
}

/**
 * Breadcrumb click: go to an ancestor level (never invents a level). Returns
 * the pose saved there, or null when this level has not been visited yet.
 */
export function jumpToLevel(
  state: CameraStackState,
  index: number,
  pose: ContextPose,
): { state: CameraStackState; target: ContextTarget | null; restored: ContextPose | null } {
  if (index < 0 || index >= state.stack.length - 1) {
    return { state, target: null, restored: null };
  }
  const saved = savePose(state, pose);
  const target = saved.stack[index]!;
  return {
    state: { ...saved, stack: saved.stack.slice(0, index + 1) },
    target,
    restored: poseFor(saved, target),
  };
}

export interface BreadcrumbItem {
  key: string;
  label: string;
  kind: ContextTarget['kind'];
  index: number;
  current: boolean;
}

/** Resolve the stack to clickable breadcrumb labels (live data, no stale names). */
export function breadcrumb(state: CameraStackState, world: ContextWorld): BreadcrumbItem[] {
  return state.stack.map((target, index) => {
    const label =
      target.kind === 'system'
        ? 'System'
        : target.kind === 'planet'
          ? target.id
          : target.kind === 'group'
            ? (world.groups.find((g) => g.id === target.id)?.name ?? 'Group')
            : (world.names[target.id] ?? target.id);
    return { key: contextKey(target), label, kind: target.kind, index, current: index === state.stack.length - 1 };
  });
}

/**
 * What a click means. A single click only ever selects; it returns the SAME
 * stack and `entered: null`, which is what keeps the camera still. A
 * double-click is an explicit context entry.
 */
export function sessionAfterClick(
  state: CameraStackState,
  click: { id: string; kind: ContextTarget['kind']; double: boolean; upMode?: ContextTarget['upMode'] },
): { stack: CameraStackState; entered: ContextTarget | null } {
  if (!click.double) return { stack: state, entered: null };
  const target: ContextTarget = { kind: click.kind, id: click.id, upMode: click.upMode ?? 'gravity' };
  return { stack: state, entered: target };
}

/** Convenience for the UI: the resolved current level, or null if it vanished. */
export function currentContext(state: CameraStackState, resolve: (t: ContextTarget) => CameraContext | null): CameraContext | null {
  return resolve(topTarget(state));
}
