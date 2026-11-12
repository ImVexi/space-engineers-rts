/**
 * Wake handoff to thrust staging (T15 follow-up).
 *
 * The plugin `wake` action enables every functional block on a freshly spawned
 * grid, thrusters included. That is right for antennas, reactors and batteries
 * but wrong for hydrogen: a clone launched with H2 burning from the pad spends
 * its tank while the atmosphere could still carry the climb (SAT-L-0009 was
 * aborted by the reserve guard at ~9 km for exactly this reason).
 *
 * The executor therefore sends one `set_block_props` order right after `wake`
 * that switches every hydrogen thruster off and leaves the decision to the
 * staging controller, which knows the altitude, the bank split and the tank
 * state. Nothing else in the wake result is changed.
 */

export const STAGING_STEP_HANDOFF = 'staging_handoff';

export interface HandoffOrder {
  label: string;
  filter: Record<string, unknown>;
  props: Record<string, unknown>;
  actions: string[];
}

/** Hydrogen off, tanks not stockpiling: staging decides from here on. */
export function hydrogenStagingHandoffOrder(): HandoffOrder {
  return {
    label: 'Hydrogen:OnOff=false (wake handoff to staging)',
    filter: { type: 'Thruster', subtype: 'Hydrogen' },
    props: { OnOff: false },
    actions: ['OnOff_Off'],
  };
}
