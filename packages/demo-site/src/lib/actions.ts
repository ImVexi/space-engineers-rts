/**
 * One always-visible action bar whose buttons follow the selection.
 *
 * The rule the owner asked for: no menus inside menus. So the bar exposes at
 * most three verbs for the current selection, and every verb opens exactly one
 * compact flow. This module is pure so the mapping is unit-tested.
 */
export type ActionId =
  | 'launch-satellites'
  | 'network'
  | 'move'
  | 'move-here'
  | 'launch-orbit'
  | 'follow'
  | 'form-network';

export interface ActionDef {
  id: ActionId;
  label: string;
  /** One-line explanation shown under the button / in its tooltip. */
  hint: string;
  /** The one dark-blue button of the group. */
  primary?: boolean;
}

const LAUNCH_SATS: ActionDef = {
  id: 'launch-satellites',
  label: 'Launch satellites',
  hint: 'Pick satellites, a ground station and an orbit. The planner does the rest.',
  primary: true,
};

const NETWORK: ActionDef = {
  id: 'network',
  label: 'Network view',
  hint: 'Radio and laser coverage, reachable vs isolated, single points of failure.',
};

const MOVE: ActionDef = {
  id: 'move',
  label: 'Move…',
  hint: 'Choose a destination on the map or a quick orbit, then check the preflight.',
  primary: true,
};

const MOVE_HERE: ActionDef = {
  id: 'move-here',
  label: 'Move here…',
  hint: 'Send every selected ship to the same destination.',
  primary: true,
};

const LAUNCH_ORBIT: ActionDef = {
  id: 'launch-orbit',
  label: 'Launch to orbit…',
  hint: 'Move the selection to a gravity-free holding orbit.',
};

const FOLLOW: ActionDef = {
  id: 'follow',
  label: 'Follow',
  hint: 'Keep this ship centred while it flies. Esc stops following.',
};

const FORM_NETWORK: ActionDef = {
  id: 'form-network',
  label: 'Form network',
  hint: 'Plan a relay chain across the selected ships and link them to a base.',
};

/** Buttons for 0 / 1 / N ships selected. Order is the render order. */
export function actionsFor(count: number): ActionDef[] {
  if (count <= 0) return [LAUNCH_SATS, NETWORK];
  if (count === 1) return [MOVE, LAUNCH_ORBIT, FOLLOW];
  return [MOVE_HERE, FORM_NETWORK, LAUNCH_ORBIT];
}

/** Context-menu items: a stable key for the handler, plus a plain label. */
export type ContextKey =
  | 'move'
  | 'follow'
  | 'launch-orbit'
  | 'rename'
  | 'copy-gps'
  | 'teleport'
  | 'move-here';

export interface ContextItem {
  key: ContextKey;
  label: string;
  hint: string;
}

/** Context-menu items for a ship (right-click on a marker or in 3D). */
export function shipMenuItems(): ContextItem[] {
  return [
    { key: 'move', label: 'Move…', hint: 'Choose a destination, check the preflight, then go.' },
    { key: 'follow', label: 'Follow', hint: 'Keep this ship centred while it flies. Esc stops following.' },
    { key: 'launch-orbit', label: 'Launch to orbit…', hint: 'Move this ship to a gravity-free holding orbit.' },
    { key: 'rename', label: 'Rename…', hint: 'Give this ship a name the site and the game share.' },
    { key: 'copy-gps', label: 'Copy GPS', hint: 'Copy a Space Engineers GPS string for this ship.' },
    { key: 'teleport', label: 'Teleport me here', hint: 'Move your character next to this ship (test server).' },
  ];
}

/** Context-menu items on a planet surface or empty space. */
export function spaceMenuItems(hasSelection: boolean): ContextItem[] {
  return [
    {
      key: 'move-here',
      label: 'Move selected here…',
      hint: hasSelection ? 'Send the selected ships to this point.' : 'Select a ship first.',
    },
    { key: 'copy-gps', label: 'Copy GPS', hint: 'Copy a GPS string for this point.' },
    { key: 'teleport', label: 'Teleport me here', hint: 'Move your character to this point (test server).' },
  ];
}

/** Plain-language summary of what the bar is acting on. */
export function selectionSummary(count: number): string {
  if (count <= 0) return 'Nothing selected';
  if (count === 1) return '1 ship selected';
  return `${count} ships selected`;
}
