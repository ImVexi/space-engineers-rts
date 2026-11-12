/**
 * Planet A → planet B selection used by the "Connect these two" flow.
 *
 * Rules:
 *  - first click selects A
 *  - second, different click selects B and arms Connect
 *  - clicking A again clears A (and B if it was set)
 *  - clicking a third planet starts a new pair with A = that planet
 */
export interface SelectionState {
  planetA: string | null;
  planetB: string | null;
  nodeId: string | null;
}

export type SelectionAction =
  | { type: 'planet'; name: string }
  | { type: 'node'; id: string | null }
  | { type: 'clearPlanets' }
  | { type: 'clearAll' };

export const initialSelection: SelectionState = { planetA: null, planetB: null, nodeId: null };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'planet': {
      if (state.planetA === action.name) {
        return { ...state, planetA: state.planetB, planetB: null };
      }
      if (!state.planetA) return { ...state, planetA: action.name, planetB: null };
      if (state.planetB === action.name) return { ...state, planetB: null };
      if (!state.planetB) return { ...state, planetB: action.name };
      return { ...state, planetA: action.name, planetB: null };
    }
    case 'node':
      return { ...state, nodeId: action.id };
    case 'clearPlanets':
      return { ...state, planetA: null, planetB: null };
    case 'clearAll':
      return initialSelection;
    default:
      return state;
  }
}

/**
 * Resolve the selected node by id against a freshly polled node list.
 *
 * Selection is stored as an id, never as an object: every poll replaces the
 * node objects, so holding a reference would snap the inspector back to a
 * stale node (or null) twice a second. Missing ids resolve to null without
 * clearing `state.nodeId`, so a node that drops out of one poll comes back
 * selected on the next one.
 */
export function resolveSelectedNode<T extends { id: string }>(nodes: T[], nodeId: string | null): T | null {
  if (!nodeId) return null;
  return nodes.find((node) => node.id === nodeId) ?? null;
}

export function pairReady(state: SelectionState): boolean {
  return Boolean(state.planetA && state.planetB && state.planetA !== state.planetB);
}

export function selectionPrompt(state: SelectionState): string {
  if (!state.planetA) return 'Click planet A to start a relay chain';
  if (!state.planetB) return `A = ${state.planetA} — now click planet B`;
  return `${state.planetA} → ${state.planetB}`;
}
