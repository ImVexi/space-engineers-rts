import { useState } from 'react';
import { ApiError, api } from '../api';
import type { DemoNode, ShipRole } from '../types';

export interface RolePanelProps {
  nodes: DemoNode[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (kind: 'info' | 'ok' | 'err', title: string, detail?: string) => void;
}

const ROLES: ShipRole[] = ['managed', 'personal', 'base', 'off'];

const ROLE_HELP: Record<ShipRole, string> = {
  managed: 'full autonomy (the system may provision, tune, fly and heal it)',
  personal: 'owner ship: no automatic action, only confirmed owner orders',
  base: 'station: never moved, never assigned a slot',
  off: 'shown read-only: the backend sends it no orders at all',
};

/**
 * Ship roles ("marking"). The role is normally set IN GAME with a tag on any
 * block name or a CustomData line; that always wins and the select here is
 * disabled with the reason. This panel is the fallback for an untagged grid.
 */
export function RolePanel({ nodes, onClose, onChanged, onToast }: RolePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const rows = nodes.filter((n) => n.source === 'GAME');

  const change = async (node: DemoNode, role: ShipRole) => {
    setBusy(node.id);
    try {
      await api.setRole(node.id, role);
      onToast('info', `${node.name}: role ${role}`, ROLE_HELP[role]);
      onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'role change failed';
      onToast('err', `${node.name}: role not changed`, message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel role-panel" data-testid="role-panel" aria-label="Ship roles">
      <div className="panel-head">
        <h3>Ship roles</h3>
        <button type="button" onClick={onClose} aria-label="Close ship roles">
          ✕
        </button>
      </div>
      <p className="muted small">
        A tag in game (<code>[PERSONAL]</code>, <code>[BASE]</code>, <code>[OFF]</code>, <code>HERMES_ROLE=...</code>)
        always wins. The toggle only applies when the grid carries no tag.
      </p>
      {rows.length === 0 ? (
        <p className="muted small">No live grid to mark yet.</p>
      ) : (
        <ul className="role-rows" data-testid="role-rows">
          {rows.map((node) => {
            const role = node.role ?? 'managed';
            const inGame = node.roleSource === 'in-game-tag';
            return (
              <li key={node.id} className={`role-row role-${role}`} data-testid={`role-row-${node.id}`} data-role={role}>
                <div className="role-row-head">
                  <span className="role-row-name">{node.name}</span>
                  <span className={`badge role-badge role-${role}`} data-testid="role-badge">
                    {role.toUpperCase()}
                  </span>
                  <span className="badge badge-muted" data-testid="role-source">
                    {node.roleSource === 'in-game-tag'
                      ? 'in game'
                      : node.roleSource === 'site-toggle'
                        ? 'site'
                        : node.roleSource === 'default-live'
                          ? 'untagged'
                          : node.roleSource === 'ownership'
                            ? 'not yours'
                            : 'default'}
                  </span>
                </div>
                <p className="muted small">{node.roleReason}</p>
                <select
                  aria-label={`Role for ${node.name}`}
                  data-testid={`role-select-${node.id}`}
                  value={role}
                  disabled={inGame || busy === node.id}
                  title={inGame ? 'Set in game: change the block tag to change the role' : 'Site fallback (no in-game tag)'}
                  onChange={(event) => void change(node, event.target.value as ShipRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small" data-testid="role-legend">
        OFF &gt; PERSONAL &gt; BASE &gt; MANAGED: conflicting tags use the most restrictive and raise an alert.
      </p>
    </section>
  );
}
