import { useEffect, useState } from 'react';
import { GROUP_COLORS, nextGroupName, type ShipGroup } from '../lib/groups';

export type GroupBulkAction = 'move' | 'launch' | 'station' | 'stop';

interface GroupsPanelProps {
  groups: ShipGroup[];
  activeId: string | null;
  /** ids currently selected on the map */
  selection: string[];
  /** server persistence: ok = saved, local = localStorage only */
  server: 'checking' | 'ok' | 'local';
  onActivate: (id: string | null) => void;
  onCreate: (name: string, color: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddSelection: (id: string) => void;
  onRemoveSelection: (id: string) => void;
  onBulk: (group: ShipGroup, action: GroupBulkAction) => void;
  onConstellation: (group: ShipGroup) => void;
  onFocusMember: (id: string) => void;
  onClose: () => void;
  /** opened from the Fleet "Group as…" button */
  startCreating?: boolean;
}

/**
 * Groups (CONTRACT §4). One list, one creation form, and the active group's
 * actions; the destructive and rare actions sit under "More".
 */
export function GroupsPanel(props: GroupsPanelProps) {
  const { groups, activeId, selection, server } = props;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(() => nextGroupName(groups));
  const [color, setColor] = useState(() => GROUP_COLORS[groups.length % GROUP_COLORS.length]!);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const active = groups.find((g) => g.id === activeId) ?? null;

  useEffect(() => {
    if (!creating) setName(nextGroupName(groups));
  }, [groups, creating]);

  useEffect(() => {
    setRenameOpen(false);
  }, [activeId]);

  useEffect(() => {
    if (props.startCreating) setCreating(true);
  }, [props.startCreating]);

  return (
    <aside className="groups-panel" data-testid="groups-panel" aria-label="Satellite groups">
      <header className="sheet-head">
        <div>
          <h2>Groups</h2>
          <p className="muted small" data-testid="groups-persist">
            {server === 'ok'
              ? 'Saved on the server.'
              : server === 'local'
                ? 'Kept in this browser — not saved to server yet.'
                : 'Checking server…'}
          </p>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close groups" data-testid="groups-close">
          ✕
        </button>
      </header>

      <div className="group-chips" data-testid="group-chips" role="list">
        {groups.length === 0 && <p className="muted small">No groups yet. Select ships, then “Group as…”.</p>}
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            role="listitem"
            className={`group-chip${group.id === activeId ? ' active' : ''}`}
            style={{ borderColor: group.color }}
            aria-pressed={group.id === activeId}
            data-testid="group-chip"
            data-id={group.id}
            data-count={group.members.length}
            onClick={() => props.onActivate(group.id === activeId ? null : group.id)}
            title={`Select all ${group.members.length} member(s) of ${group.name}`}
          >
            <i className="group-dot" style={{ background: group.color }} />
            {group.name}
            <span className="group-count">{group.members.length}</span>
          </button>
        ))}
      </div>

      {active && (
        <section className="group-active" data-testid="group-active" data-id={active.id}>
          <div className="group-active-head">
            <strong>{active.name}</strong>
            <span className="muted small">{active.members.length} members</span>
          </div>
          <div className="group-actions">
            <button type="button" className="primary" data-testid="group-constellation" onClick={() => props.onConstellation(active)}>
              Constellation…
            </button>
            <button type="button" data-testid="group-move" onClick={() => props.onBulk(active, 'move')}>
              Move here
            </button>
            <button type="button" data-testid="group-launch" onClick={() => props.onBulk(active, 'launch')}>
              Launch to orbit
            </button>
          </div>
          <details className="flow-advanced">
            <summary>More group actions</summary>
            <div className="group-actions">
              <button type="button" data-testid="group-station" onClick={() => props.onBulk(active, 'station')}>
                Station / Ship
              </button>
              <button type="button" className="danger" data-testid="group-stop" onClick={() => props.onBulk(active, 'stop')}>
                Stop group
              </button>
              <button
                type="button"
                data-testid="group-rename-open"
                onClick={() => {
                  setRenameValue(active.name);
                  setRenameOpen((v) => !v);
                }}
              >
                Rename
              </button>
              <button type="button" data-testid="group-delete" onClick={() => props.onDelete(active.id)}>
                Delete
              </button>
            </div>
            {renameOpen && (
              <form
                className="group-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (renameValue.trim()) props.onRename(active.id, renameValue.trim());
                  setRenameOpen(false);
                }}
              >
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  aria-label="Group name"
                  data-testid="group-rename-input"
                  autoFocus
                />
                <button type="submit" data-testid="group-rename-save">
                  Save name
                </button>
              </form>
            )}
            <div className="group-members-edit">
              <button type="button" disabled={selection.length === 0} data-testid="group-add-selection" onClick={() => props.onAddSelection(active.id)}>
                + Add selection ({selection.length})
              </button>
              <button type="button" disabled={selection.length === 0} data-testid="group-remove-selection" onClick={() => props.onRemoveSelection(active.id)}>
                − Remove selection
              </button>
            </div>
            <div className="group-member-list" data-testid="group-members">
              {active.members.slice(0, 8).map((id) => (
                <button key={id} type="button" className="chip" onClick={() => props.onFocusMember(id)} title="Focus this member on the map">
                  {id.replace(/^grid:/, '').slice(0, 10)}
                </button>
              ))}
              {active.members.length > 8 && <span className="muted small">+{active.members.length - 8} more</span>}
            </div>
          </details>
        </section>
      )}

      {creating ? (
        <form
          className="group-create"
          data-testid="group-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || selection.length === 0) return;
            props.onCreate(name.trim(), color);
            setCreating(false);
          }}
        >
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="group-name" autoFocus />
          </label>
          <div className="group-colors" role="group" aria-label="Group colour">
            {GROUP_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`group-swatch${swatch === color ? ' active' : ''}`}
                style={{ background: swatch }}
                aria-label={`Colour ${swatch}`}
                aria-pressed={swatch === color}
                data-testid="group-color"
                onClick={() => setColor(swatch)}
              />
            ))}
          </div>
          <p className="muted small">{selection.length} selected ship(s) will join.</p>
          <div className="row">
            <button type="submit" className="primary" disabled={!name.trim() || selection.length === 0} data-testid="group-create-save">
              Create group
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="primary big group-as"
          data-testid="group-as"
          disabled={selection.length === 0}
          title={selection.length === 0 ? 'Select ships on the map or in the Fleet first' : 'Name the selected ships as one group'}
          onClick={() => {
            setName(nextGroupName(groups));
            setColor(GROUP_COLORS[groups.length % GROUP_COLORS.length]!);
            setCreating(true);
          }}
        >
          Group as… {selection.length > 0 ? `(${selection.length})` : ''}
        </button>
      )}
    </aside>
  );
}
