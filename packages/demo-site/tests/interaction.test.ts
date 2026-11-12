import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  clickSelected,
  pruneSelection,
  selectMany,
  selectOnly,
  toggleSelected,
} from '../src/lib/selectionSet';
import { actionsFor, shipMenuItems, spaceMenuItems, selectionSummary } from '../src/lib/actions';
import { blockText, orbitCards, preflightRows, targetSpecLabel, wireTarget } from '../src/lib/flows';
import type { MovePreflight } from '../src/types';

describe('direct-manipulation selection', () => {
  it('plain click replaces, shift-click adds and removes', () => {
    let sel = selectOnly('a');
    expect(sel.ids).toEqual(['a']);
    sel = clickSelected(sel, 'b', true);
    expect(sel.ids).toEqual(['a', 'b']);
    expect(sel.primary).toBe('b');
    sel = clickSelected(sel, 'a', true);
    expect(sel.ids).toEqual(['b']);
    sel = clickSelected(sel, 'c', false);
    expect(sel.ids).toEqual(['c']);
  });

  it('a drag box replaces or extends the selection', () => {
    expect(selectMany(['a', 'b', 'a']).ids).toEqual(['a', 'b']);
    const extended = selectMany(['c', 'd'], true, { ids: ['a'], primary: 'a' });
    expect(extended.ids).toEqual(['a', 'c', 'd']);
    expect(extended.primary).toBe('d');
    expect(selectMany(['c'], false, { ids: ['a'], primary: 'a' }).ids).toEqual(['c']);
  });

  it('prunes despawned grids but keeps the rest', () => {
    expect(pruneSelection(selectOnly('gone'), ['a']).ids).toEqual([]);
    expect(pruneSelection({ ids: ['a', 'gone'], primary: 'gone' }, ['a'])).toEqual({ ids: ['a'], primary: 'a' });
    expect(pruneSelection(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });

  it('toggling the last item leaves no primary', () => {
    expect(toggleSelected(selectOnly('a'), 'a')).toEqual({ ids: [], primary: null });
  });
});

describe('selection-driven action bar', () => {
  it('offers launch + network with nothing selected', () => {
    expect(actionsFor(0).map((a) => a.id)).toEqual(['launch-satellites', 'network']);
    expect(selectionSummary(0)).toBe('Nothing selected');
  });

  it('offers move / launch orbit / follow for one ship', () => {
    expect(actionsFor(1).map((a) => a.label)).toEqual(['Move…', 'Launch to orbit…', 'Follow']);
  });

  it('offers shared move, form network and orbit for many', () => {
    expect(actionsFor(3).map((a) => a.id)).toEqual(['move-here', 'form-network', 'launch-orbit']);
    expect(selectionSummary(3)).toBe('3 ships selected');
  });

  it('context menus carry the required direct actions', () => {
    expect(shipMenuItems().map((i) => i.key)).toEqual(['move', 'follow', 'launch-orbit', 'rename', 'copy-gps', 'teleport']);
    expect(spaceMenuItems(true).map((i) => i.key)).toEqual(['move-here', 'copy-gps', 'teleport']);
    expect(spaceMenuItems(false)[0]!.hint).toContain('Select a ship');
  });
});

describe('move flow targets and plain preflight', () => {
  it('maps quick picks to the wire target the backend accepts', () => {
    expect(wireTarget({ kind: 'preset', preset: 'orbit-zero-g' })).toBe('orbit-zero-g');
    expect(wireTarget({ kind: 'planet', planet: 'EarthLike', altitudeM: 60000 })).toEqual({
      planet: 'EarthLike',
      altitudeM: 60000,
    });
    expect(wireTarget({ kind: 'gps', pos: { x: 1, y: 2, z: 3 } })).toEqual({ gps: { x: 1, y: 2, z: 3 } });
  });

  it('labels the three target kinds in words', () => {
    expect(targetSpecLabel({ kind: 'preset', preset: 'orbit-zero-g' })).toContain('Zero-g orbit');
    expect(targetSpecLabel({ kind: 'planet', planet: 'Mars', altitudeM: 25000 })).toBe('25 km above Mars');
    expect(targetSpecLabel({ kind: 'gps', pos: { x: 5000, y: -2000, z: 0 } })).toBe('GPS 5, -2, 0 km');
    expect(targetSpecLabel(null)).toBe('No destination yet');
  });

  it('describes low vs zero-g honestly', () => {
    const [low, zero] = orbitCards('3 h', 'indefinite');
    expect(low!.caution).toContain('3 h');
    expect(low!.detail).toContain('hydrogen');
    expect(zero!.detail).toContain('free');
    expect(zero!.headline).toContain('60');
  });

  const refusal: MovePreflight = {
    ok: false,
    canReach: false,
    linkText: 'not linked: 120 km from BASE-01',
    fuelText: 'fuel: hydrogen 50 %',
    etaText: 'ETA ~4 min',
    distanceM: 120000,
    etaS: 240,
    altitudeM: 20000,
    fuelPct: 50,
    batteryPct: 100,
    block: { code: 'not_reachable', message: 'Not reachable.', hint: 'Add a relay or use Admin override.' },
    warnings: [],
  };

  it('surfaces the refusal message and fix hint, never a bare code', () => {
    const rows = preflightRows(refusal);
    expect(rows[0]!.tone).toBe('bad');
    expect(rows[0]!.value).toContain('No');
    const block = blockText(refusal);
    expect(block?.message).toBe('Not reachable.');
    expect(block?.hint).toContain('Admin override');
    expect(blockText({ ...refusal, ok: true, block: null })).toBeNull();
  });
});
