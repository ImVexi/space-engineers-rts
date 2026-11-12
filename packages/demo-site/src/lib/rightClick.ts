/**
 * Right-click arbitration for the map.
 *
 * Chromium fires `contextmenu` at mousedown on Linux/X11 but at mouseup on
 * Windows/macOS, so a contextmenu handler cannot tell a click from a pan by
 * itself. This module suppresses the native menu unconditionally inside the
 * map and only opens our own menu when a real click happened: right button,
 * released within 5 px and 400 ms of the press.
 *
 * Handlers that know *what* was hit (a ship mesh, a marker, the planet
 * surface) call `begin(open)` at contextmenu time; the gate decides whether
 * that pending hit is ever shown.
 */

export const CLICK_MAX_MOVE_PX = 5;
export const CLICK_MAX_MS = 400;
/** How long a completed click waits for a contextmenu that arrives after it. */
const ARMED_MS = 700;

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  t: number;
}

export function movedPx(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A press is a click when it stayed put and was released quickly. */
export function isClickGesture(
  start: TimedPoint,
  end: TimedPoint,
  maxMovePx: number = CLICK_MAX_MOVE_PX,
  maxMs: number = CLICK_MAX_MS,
): boolean {
  const elapsed = end.t - start.t;
  return elapsed >= 0 && elapsed <= maxMs && movedPx(start, end) <= maxMovePx;
}

export function isMapTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return Boolean(el && typeof el.closest === 'function' && el.closest('[data-map-surface]'));
}

interface PointerLike {
  button: number;
  clientX: number;
  clientY: number;
}

interface ContextMenuLike {
  target: EventTarget | null;
  preventDefault: () => void;
}

export interface RightClickGateOptions {
  now?: () => number;
  maxMovePx?: number;
  maxMs?: number;
  armedMs?: number;
  isMapTarget?: (target: EventTarget | null) => boolean;
}

export class RightClickGate {
  private readonly now: () => number;
  private readonly maxMovePx: number;
  private readonly maxMs: number;
  private readonly armedMs: number;
  private readonly inMap: (target: EventTarget | null) => boolean;

  private down: TimedPoint | null = null;
  private moved = false;
  private pending: (() => void) | null = null;
  /** set when our pointerup qualified but the contextmenu has not arrived yet */
  private released: TimedPoint | null = null;

  constructor(options: RightClickGateOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxMovePx = options.maxMovePx ?? CLICK_MAX_MOVE_PX;
    this.maxMs = options.maxMs ?? CLICK_MAX_MS;
    this.armedMs = options.armedMs ?? ARMED_MS;
    this.inMap = options.isMapTarget ?? isMapTarget;
  }

  pointerDown(event: PointerLike): void {
    this.pending = null;
    this.released = null;
    this.moved = false;
    this.down = event.button === 2 ? { x: event.clientX, y: event.clientY, t: this.now() } : null;
  }

  pointerMove(event: PointerLike): void {
    if (!this.down) return;
    if (movedPx(this.down, { x: event.clientX, y: event.clientY }) > this.maxMovePx) this.moved = true;
  }

  pointerUp(event: PointerLike): void {
    if (event.button !== 2) return;
    const down = this.down;
    this.down = null;
    const moved = this.moved;
    this.moved = false;
    if (!down) return;
    const end = { x: event.clientX, y: event.clientY, t: this.now() };
    if (moved || !isClickGesture(down, end, this.maxMovePx, this.maxMs)) {
      this.pending = null;
      this.released = null;
      return;
    }
    const open = this.pending;
    this.pending = null;
    if (open) {
      this.released = null;
      open();
      return;
    }
    // No hit reported yet: Windows/macOS contextmenu arrives after pointerup.
    this.released = end;
  }

  /** A handler resolved a right-click hit and wants a menu for it. */
  begin(open: () => void): void {
    const released = this.released;
    if (released && this.now() - released.t <= this.armedMs) {
      this.released = null;
      this.pending = null;
      open();
      return;
    }
    this.pending = open;
  }

  /** The native menu never opens inside the map. */
  contextMenu(event: ContextMenuLike): void {
    if (this.inMap(event.target)) event.preventDefault();
  }

  pointerCancel(): void {
    this.down = null;
    this.moved = false;
    this.pending = null;
    this.released = null;
  }

  /** true while a right-button press is in flight (used by stage handlers). */
  get pressing(): boolean {
    return this.down !== null;
  }
}

/** One gate for the whole map: the canvas and the HTML overlay share it. */
export const mapRightClick = new RightClickGate();

/**
 * Install the window-level listeners (capture phase). Returns a disposer.
 * Call once from the app root.
 */
export function installRightClickGate(gate: RightClickGate = mapRightClick): () => void {
  const down = (event: PointerEvent) => gate.pointerDown(event);
  const move = (event: PointerEvent) => gate.pointerMove(event);
  const up = (event: PointerEvent) => gate.pointerUp(event);
  const cancel = () => gate.pointerCancel();
  const menu = (event: MouseEvent) => gate.contextMenu(event);
  const blur = () => gate.pointerCancel();

  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('contextmenu', menu, true);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('contextmenu', menu, true);
    window.removeEventListener('blur', blur);
  };
}
