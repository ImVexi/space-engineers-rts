import { describe, expect, it } from 'vitest';
import { initialSelection, pairReady, resolveSelectedNode, selectionPrompt, selectionReducer } from '../src/lib/selection';

describe('planet A/B selection flow', () => {
  it('selects A, then B, and arms the connect action', () => {
    let state = selectionReducer(initialSelection, { type: 'planet', name: 'EarthLike' });
    expect(state.planetA).toBe('EarthLike');
    expect(state.planetB).toBeNull();
    expect(pairReady(state)).toBe(false);
    expect(selectionPrompt(state)).toContain('now click planet B');

    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    expect(state.planetB).toBe('Alien');
    expect(pairReady(state)).toBe(true);
    expect(selectionPrompt(state)).toBe('EarthLike → Alien');
  });

  it('clicking A again clears the pair', () => {
    let state = selectionReducer(initialSelection, { type: 'planet', name: 'EarthLike' });
    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    state = selectionReducer(state, { type: 'planet', name: 'EarthLike' });
    expect(state.planetB).toBeNull();
    expect(pairReady(state)).toBe(false);
  });

  it('clicking B again clears only B', () => {
    let state = selectionReducer(initialSelection, { type: 'planet', name: 'EarthLike' });
    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    expect(state.planetA).toBe('EarthLike');
    expect(state.planetB).toBeNull();
  });

  it('a third planet starts a new pair', () => {
    let state = selectionReducer(initialSelection, { type: 'planet', name: 'EarthLike' });
    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    state = selectionReducer(state, { type: 'planet', name: 'Mars' });
    expect(state.planetA).toBe('Mars');
    expect(state.planetB).toBeNull();
  });

  it('tracks node selection independently and clears on demand', () => {
    let state = selectionReducer(initialSelection, { type: 'node', id: 'relay-1' });
    expect(state.nodeId).toBe('relay-1');
    state = selectionReducer(state, { type: 'planet', name: 'EarthLike' });
    expect(state.nodeId).toBe('relay-1');
    state = selectionReducer(state, { type: 'clearAll' });
    expect(state).toEqual(initialSelection);
  });
});

describe('node selection persists across polls', () => {
  // Polling replaces every node object; selection is kept as an id and
  // resolved against the newest list so the inspector cannot snap back.
  const poll = (tag: string) => [
    { id: 'grid:a', name: `A ${tag}`, telemetry: { ageMs: 1 } },
    { id: 'grid:b', name: `B ${tag}`, telemetry: { ageMs: 1 } },
    { id: 'grid:c', name: `C ${tag}`, telemetry: { ageMs: 1 } },
  ];

  it('keeps the selected id while the node list is replaced', () => {
    let state = selectionReducer(initialSelection, { type: 'node', id: 'grid:b' });
    for (let i = 0; i < 3; i += 1) {
      const nodes = poll(String(i));
      const node = resolveSelectedNode(nodes, state.nodeId);
      expect(node?.id).toBe('grid:b');
      expect(node?.name).toBe(`B ${i}`); // live data, same selection
    }
    expect(state.nodeId).toBe('grid:b');
    state = selectionReducer(state, { type: 'node', id: 'grid:c' });
    expect(resolveSelectedNode(poll('x'), state.nodeId)?.id).toBe('grid:c');
  });

  it('resolves to null without forgetting the id when a node is missing for one poll', () => {
    const state = selectionReducer(initialSelection, { type: 'node', id: 'grid:b' });
    expect(resolveSelectedNode([{ id: 'grid:a' }], state.nodeId)).toBeNull();
    expect(state.nodeId).toBe('grid:b');
    expect(resolveSelectedNode([{ id: 'grid:a' }, { id: 'grid:b' }], state.nodeId)?.id).toBe('grid:b');
  });

  it('clearing the selection clears it for good', () => {
    let state = selectionReducer(initialSelection, { type: 'node', id: 'grid:a' });
    state = selectionReducer(state, { type: 'node', id: null });
    expect(resolveSelectedNode(poll('y'), state.nodeId)).toBeNull();
  });

  it('planet A/B selection is independent of the node selection', () => {
    let state = selectionReducer(initialSelection, { type: 'planet', name: 'EarthLike' });
    state = selectionReducer(state, { type: 'planet', name: 'Alien' });
    state = selectionReducer(state, { type: 'node', id: 'grid:a' });
    expect(state.planetA).toBe('EarthLike');
    expect(state.planetB).toBe('Alien');
    expect(pairReady(state)).toBe(true);
  });
});
