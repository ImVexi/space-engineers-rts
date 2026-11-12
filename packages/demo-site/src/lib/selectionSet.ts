/**
 * Direct-manipulation selection: a plain set of grid ids plus the last one
 * clicked ("primary"), which drives the compact inspector, F-to-focus and the
 * single-ship actions.
 *
 * Ids are stored, never node objects: polling replaces node objects every two
 * seconds, so holding references would blank the selection.
 */
export interface SelectionSet {
  ids: string[];
  primary: string | null;
}

export const EMPTY_SELECTION: SelectionSet = { ids: [], primary: null };

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

/** One click: select exactly this grid. */
export function selectOnly(id: string): SelectionSet {
  return { ids: id ? [id] : [], primary: id || null };
}

/** Shift-click: add or remove one grid, keeping the rest. */
export function toggleSelected(selection: SelectionSet, id: string): SelectionSet {
  if (!id) return selection;
  if (selection.ids.includes(id)) {
    const ids = selection.ids.filter((x) => x !== id);
    return { ids, primary: selection.primary === id ? ids[ids.length - 1] ?? null : selection.primary };
  }
  return { ids: [...selection.ids, id], primary: id };
}

/** Click with `additive` = true behaves like shift-click. */
export function clickSelected(selection: SelectionSet, id: string, additive: boolean): SelectionSet {
  return additive ? toggleSelected(selection, id) : selectOnly(id);
}

/** Drag box: replace, or extend when shift is held. */
export function selectMany(ids: string[], additive = false, seed: SelectionSet = EMPTY_SELECTION): SelectionSet {
  const incoming = unique(ids);
  if (!additive) return { ids: incoming, primary: incoming[incoming.length - 1] ?? null };
  const merged = unique([...seed.ids, ...incoming]);
  return { ids: merged, primary: incoming[incoming.length - 1] ?? seed.primary };
}

export function clearSelection(): SelectionSet {
  return EMPTY_SELECTION;
}

export function removeSelected(selection: SelectionSet, id: string): SelectionSet {
  if (!selection.ids.includes(id)) return selection;
  const ids = selection.ids.filter((x) => x !== id);
  return { ids, primary: selection.primary === id ? ids[ids.length - 1] ?? null : selection.primary };
}

export function hasSelected(selection: SelectionSet, id: string): boolean {
  return selection.ids.includes(id);
}

export function selectionCount(selection: SelectionSet): number {
  return selection.ids.length;
}

/** Drop ids that no longer exist in the newest poll (a despawned grid). */
export function pruneSelection(selection: SelectionSet, knownIds: string[]): SelectionSet {
  if (selection.ids.length === 0) return selection;
  const known = new Set(knownIds);
  const ids = selection.ids.filter((id) => known.has(id));
  if (ids.length === selection.ids.length) return selection;
  return { ids, primary: ids.includes(selection.primary ?? '') ? selection.primary : ids[ids.length - 1] ?? null };
}
