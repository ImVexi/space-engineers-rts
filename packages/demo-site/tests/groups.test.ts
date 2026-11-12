import { describe, expect, it } from 'vitest';
import {
  bracketFor,
  GROUP_COLORS,
  groupColor,
  groupsReducer,
  membershipOf,
  nextGroupName,
  parseGroups,
  pruneGroups,
  type ShipGroup,
} from '../src/lib/groups';

const base: ShipGroup[] = [{ id: 'g1', name: 'Alpha', color: GROUP_COLORS[0]!, members: ['grid:1', 'grid:2'] }];

describe('groupsReducer', () => {
  it('adds a group, trims the name and de-duplicates members', () => {
    const next = groupsReducer([], { type: 'add', id: 'g2', name: '  Belt  ', color: GROUP_COLORS[2]!, members: ['a', 'a', 'b'] });
    expect(next).toHaveLength(1);
    expect(next[0]!.name).toBe('Belt');
    expect(next[0]!.members).toEqual(['a', 'b']);
  });

  it('refuses an empty name or no members', () => {
    expect(groupsReducer([], { type: 'add', id: 'x', name: '   ', color: '#fff', members: ['a'] })).toEqual([]);
    expect(groupsReducer([], { type: 'add', id: 'x', name: 'X', color: '#fff', members: [] })).toEqual([]);
  });

  it('renames, recolours and deletes without touching other groups', () => {
    const renamed = groupsReducer(base, { type: 'rename', id: 'g1', name: 'Bravo' });
    expect(renamed[0]!.name).toBe('Bravo');
    expect(groupsReducer(base, { type: 'rename', id: 'g1', name: '  ' })[0]!.name).toBe('Alpha');
    expect(groupsReducer(base, { type: 'recolor', id: 'g1', color: '#123456' })[0]!.color).toBe('#123456');
    expect(groupsReducer(base, { type: 'delete', id: 'g1' })).toEqual([]);
  });

  it('replaces members and toggles one grid in and out', () => {
    const replaced = groupsReducer(base, { type: 'members', id: 'g1', members: ['grid:9', 'grid:9'] });
    expect(replaced[0]!.members).toEqual(['grid:9']);
    const off = groupsReducer(base, { type: 'toggleMember', id: 'g1', gridId: 'grid:2' });
    expect(off[0]!.members).toEqual(['grid:1']);
    const on = groupsReducer(base, { type: 'toggleMember', id: 'g1', gridId: 'grid:3' });
    expect(on[0]!.members).toEqual(['grid:1', 'grid:2', 'grid:3']);
  });

  it('lets one grid live in several groups', () => {
    const groups = groupsReducer(base, { type: 'add', id: 'g2', name: 'Beta', color: '#000', members: ['grid:1'] });
    expect(groups).toHaveLength(2);
    expect(membershipOf(groups).get('grid:1')).toEqual(['g1', 'g2']);
  });
});

describe('group helpers', () => {
  it('cycles the palette and names the next free group', () => {
    expect(groupColor(0)).toBe(GROUP_COLORS[0]);
    expect(groupColor(GROUP_COLORS.length + 1)).toBe(GROUP_COLORS[1]);
    expect(nextGroupName([])).toBe('Group 1');
    expect(nextGroupName([{ id: 'a', name: 'Group 1', color: '#000', members: [] }])).toBe('Group 2');
  });

  it('parses the wire shape and falls back on a missing colour', () => {
    const parsed = parseGroups({ groups: [{ id: 'g1', name: 'Alpha', members: ['grid:1'], color: '#abc' }, { id: 3 }, null] });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.color).toBe('#abc');
    expect(parseGroups([{ id: 'g2', name: 'Bare', members: [] }])[0]!.color).toBe(GROUP_COLORS[0]);
    expect(parseGroups(null)).toEqual([]);
  });

  it('prunes members that no longer exist', () => {
    const next = pruneGroups(base, ['grid:1']);
    expect(next[0]!.members).toEqual(['grid:1']);
    expect(pruneGroups(base, ['grid:1', 'grid:2'])).toBe(base);
  });

  it('brackets a group with a padded axis-aligned box', () => {
    const box = bracketFor([
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 500, z: -500 },
    ])!;
    expect(box.center).toEqual({ x: 500, y: 250, z: -250 });
    expect(box.size.x).toBeCloseTo(1150, 5);
    expect(box.size.y).toBeCloseTo(575, 5);
    expect(box.members).toBe(2);
    expect(bracketFor([])).toBeNull();
  });

  it('gives a single ship a visible minimum bracket', () => {
    const box = bracketFor([{ x: 10, y: 20, z: 30 }])!;
    expect(box.size.x).toBeCloseTo(230, 6);
    expect(box.size.y).toBeCloseTo(230, 6);
    expect(box.size.z).toBeCloseTo(230, 6);
  });
});
