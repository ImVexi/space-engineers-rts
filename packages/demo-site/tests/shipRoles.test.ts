import { describe, expect, it } from 'vitest';
import { moveRoleCheck, roleBadge } from '../src/lib/shipRoles';

describe('ship roles on the site', () => {
  it('MANAGED ships move with no dialog and no badge', () => {
    expect(moveRoleCheck([{ id: 'g1', name: 'SAT-1', role: 'managed' }])).toEqual({ blocked: [], personal: [] });
    expect(roleBadge('managed')).toBeNull();
    expect(roleBadge(undefined)).toBeNull();
  });

  it('PERSONAL ships are allowed but listed for the confirm dialog', () => {
    const check = moveRoleCheck([{ id: 'g2', name: 'My Tug', role: 'personal' }]);
    expect(check.blocked).toEqual([]);
    expect(check.personal).toEqual(['My Tug']);
  });

  it('BASE and OFF are blocked with the backend’s plain reason', () => {
    const check = moveRoleCheck([
      { id: 'g3', name: 'BASE-01', role: 'base' },
      { id: 'g4', name: 'Hangar queen', role: 'off' },
    ]);
    expect(check.blocked.map((b) => b.reason)).toEqual(['a base is never moved', 'marked OFF in game: no orders are sent']);
    expect(check.personal).toEqual([]);
  });

  it('badges only show non-default roles', () => {
    expect(roleBadge('personal')).toBe('PERSONAL');
    expect(roleBadge('base')).toBe('BASE');
    expect(roleBadge('off')).toBe('OFF');
  });
});
