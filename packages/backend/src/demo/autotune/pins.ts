/**
 * Owner overrides for T29 auto-tune.
 *
 * A pin says "this node keeps this range" (a base uplink someone wants at max,
 * or a coverage node whose footprint the plan needs). Pinned nodes are shown
 * in the preview and skipped by apply — the tuner never overwrites an owner
 * decision, in-game renames included.
 */
import type { Store } from '../../store.js';

export const AUTOTUNE_PINS_KV = 'autotune:pins';

export interface TunePin {
  gridId: string;
  /** Exact radio radius to keep, metres. */
  radioM: number | null;
  /** Exact laser range to keep, metres. */
  laserM: number | null;
  /** Footprint the coverage plan needs, metres (drives the needed radius). */
  footprintM: number | null;
  at: number;
  by: string | null;
  note: string | null;
}

export type PinMap = Record<string, TunePin>;

export function readPins(store: Store): PinMap {
  const raw = store.getKv(AUTOTUNE_PINS_KV);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<TunePin>>;
    const out: PinMap = {};
    for (const [gridId, pin] of Object.entries(parsed)) {
      if (!gridId || !pin || typeof pin !== 'object') continue;
      out[gridId] = {
        gridId,
        radioM: num(pin.radioM),
        laserM: num(pin.laserM),
        footprintM: num(pin.footprintM),
        at: num(pin.at) ?? 0,
        by: typeof pin.by === 'string' ? pin.by : null,
        note: typeof pin.note === 'string' ? pin.note : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writePin(store: Store, pin: Omit<TunePin, 'at'> & { at?: number }): TunePin {
  const pins = readPins(store);
  const saved: TunePin = {
    gridId: pin.gridId,
    radioM: pin.radioM ?? null,
    laserM: pin.laserM ?? null,
    footprintM: pin.footprintM ?? null,
    at: pin.at ?? Date.now(),
    by: pin.by ?? null,
    note: pin.note ?? null,
  };
  pins[pin.gridId] = saved;
  store.setKv(AUTOTUNE_PINS_KV, JSON.stringify(pins));
  return saved;
}

export function clearPin(store: Store, gridId: string): boolean {
  const pins = readPins(store);
  if (!(gridId in pins)) return false;
  delete pins[gridId];
  store.setKv(AUTOTUNE_PINS_KV, JSON.stringify(pins));
  return true;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
