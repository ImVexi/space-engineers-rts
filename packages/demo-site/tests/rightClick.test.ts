import { describe, expect, it, vi } from 'vitest';
import {
  CLICK_MAX_MOVE_PX,
  CLICK_MAX_MS,
  RightClickGate,
  type RightClickGateOptions,
  isClickGesture,
  isMapTarget,
} from '../src/lib/rightClick';

/** Fake clock so duration rules are exact. */
function makeGate(overrides: Partial<RightClickGateOptions> = {}) {
  const clock = { t: 0 };
  const gate = new RightClickGate({ now: () => clock.t, isMapTarget: () => true, ...overrides });
  return { gate, clock };
}

describe('right-click gesture', () => {
  it('accepts a short press that did not move', () => {
    expect(isClickGesture({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 120 })).toBe(true);
    expect(isClickGesture({ x: 10, y: 10, t: 0 }, { x: 14, y: 13, t: 399 })).toBe(true);
  });

  it('rejects a drag or a long press', () => {
    expect(isClickGesture({ x: 10, y: 10, t: 0 }, { x: 10 + CLICK_MAX_MOVE_PX + 0.5, y: 10, t: 100 })).toBe(false);
    expect(isClickGesture({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: CLICK_MAX_MS + 1 })).toBe(false);
  });
});

describe('RightClickGate', () => {
  it('opens the queued menu on a right-click release', () => {
    const { gate, clock } = makeGate();
    const open = vi.fn();
    gate.pointerDown({ button: 2, clientX: 40, clientY: 60 });
    clock.t = 90;
    gate.begin(open);
    gate.pointerUp({ button: 2, clientX: 41, clientY: 61 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('never opens a menu for a right-drag pan', () => {
    const { gate, clock } = makeGate();
    const open = vi.fn();
    gate.pointerDown({ button: 2, clientX: 40, clientY: 60 });
    clock.t = 20;
    gate.begin(open);
    gate.pointerMove({ button: 2, clientX: 220, clientY: 140 });
    clock.t = 200;
    gate.pointerUp({ button: 2, clientX: 220, clientY: 140 });
    expect(open).not.toHaveBeenCalled();
    // A contextmenu arriving after the drag must not resurrect the menu.
    gate.begin(open);
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores a stationary press held longer than 400 ms', () => {
    const { gate, clock } = makeGate();
    const open = vi.fn();
    gate.pointerDown({ button: 2, clientX: 40, clientY: 60 });
    gate.begin(open);
    clock.t = 650;
    gate.pointerUp({ button: 2, clientX: 40, clientY: 60 });
    expect(open).not.toHaveBeenCalled();
  });

  it('opens when contextmenu arrives after pointerup (Windows order)', () => {
    const { gate, clock } = makeGate();
    const open = vi.fn();
    gate.pointerDown({ button: 2, clientX: 40, clientY: 60 });
    clock.t = 80;
    gate.pointerUp({ button: 2, clientX: 40, clientY: 60 });
    clock.t = 95;
    gate.begin(open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(gate.pressing).toBe(false);
  });

  it('does not arm on a left-button press', () => {
    const { gate, clock } = makeGate();
    const open = vi.fn();
    gate.pointerDown({ button: 0, clientX: 40, clientY: 60 });
    clock.t = 50;
    gate.begin(open);
    gate.pointerUp({ button: 0, clientX: 40, clientY: 60 });
    expect(open).not.toHaveBeenCalled();
  });

  it('suppresses the native menu only inside the map', () => {
    const map = { closest: () => ({}) } as unknown as Element;
    const chrome = { closest: () => null } as unknown as Element;
    expect(isMapTarget(map)).toBe(true);
    expect(isMapTarget(chrome)).toBe(false);

    const { gate } = makeGate({ isMapTarget });
    const inside = { target: map, preventDefault: vi.fn() };
    const outside = { target: chrome, preventDefault: vi.fn() };
    gate.contextMenu(inside);
    gate.contextMenu(outside);
    expect(inside.preventDefault).toHaveBeenCalledTimes(1);
    expect(outside.preventDefault).not.toHaveBeenCalled();
  });
});
