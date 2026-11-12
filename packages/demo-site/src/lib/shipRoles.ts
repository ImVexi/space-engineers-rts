/**
 * Ship roles in the site (owner decision 2026-11-11). Pure helpers so the
 * confirm/refuse rules can be tested without a DOM, and so the badge and the
 * dialog read from the same place.
 */
export type ShipRole = 'managed' | 'personal' | 'base' | 'off';

export interface RoleShip {
  id: string;
  name: string;
  role?: ShipRole;
}

export interface MoveRoleCheck {
  /** Ships the flow must refuse to order (OFF every time, BASE never moves). */
  blocked: { id: string; name: string; reason: string }[];
  /** PERSONAL ships: allowed, but only after the owner confirms. */
  personal: string[];
}

export const ROLE_REASON: Record<Exclude<ShipRole, 'managed'>, string> = {
  personal: 'personal ship: no automatic action — confirm this order',
  base: 'a base is never moved',
  off: 'marked OFF in game: no orders are sent',
};

/** What a move flow may send, per role. */
export function moveRoleCheck(ships: RoleShip[]): MoveRoleCheck {
  const blocked: MoveRoleCheck['blocked'] = [];
  const personal: string[] = [];
  for (const ship of ships) {
    if (ship.role === 'off' || ship.role === 'base') {
      blocked.push({ id: ship.id, name: ship.name, reason: ROLE_REASON[ship.role] });
    } else if (ship.role === 'personal') {
      personal.push(ship.name);
    }
  }
  return { blocked, personal };
}

/** Short badge text; MANAGED is the default and stays quiet. */
export function roleBadge(role: ShipRole | undefined): string | null {
  return role && role !== 'managed' ? role.toUpperCase() : null;
}
