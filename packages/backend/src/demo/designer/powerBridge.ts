/**
 * Bridge to the T30 power-budget module.
 *
 * The power module is being added by another workstream, so this file may not
 * exist yet. It is loaded at request time (not at import time): when it is
 * absent the planner skips the power constraint with an explicit note instead
 * of fabricating MW numbers, and when it is present only a recognised slot
 * budget export is used.
 */
import type { SlotPowerCheck } from './hetero.js';

export interface PowerBridge {
  check: SlotPowerCheck | null;
  note: string;
}

const CANDIDATE_EXPORTS = ['slotPowerBudget', 'powerBudgetForSlot', 'estimateSlotPowerBudget', 'checkSlotPower'];

/** Load `.next`-free optional module; never throws. */
export async function loadPowerBudget(): Promise<PowerBridge> {
  try {
    // Optional cross-workstream module: absent in builds that predate T30.
    // @ts-ignore -- resolved at runtime; the path is intentionally optional.
    const mod = (await import('../power/index.js')) as Record<string, unknown>;
    for (const name of CANDIDATE_EXPORTS) {
      const candidate = mod[name];
      if (typeof candidate === 'function') {
        return {
          check: candidate as SlotPowerCheck,
          note: `T30 power budget applied as a hard constraint (${name})`,
        };
      }
    }
    return {
      check: null,
      note: 'T30 power module is present but exposes no slot power budget function; power constraint skipped',
    };
  } catch {
    return {
      check: null,
      note: 'T30 power module is not available in this build: power budget skipped (no MW numbers are invented)',
    };
  }
}
