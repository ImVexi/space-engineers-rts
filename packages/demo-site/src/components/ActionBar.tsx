import type { ActionDef } from '../lib/actions';
import { selectionSummary } from '../lib/actions';

export interface ActionBarProps {
  count: number;
  actions: ActionDef[];
  /** actions whose backend route 404s (feature not deployed yet) */
  comingSoon: string[];
  killOn: boolean;
  followName: string | null;
  /** explicit camera entry (double-click equivalent, always two clicks away) */
  canFocus?: boolean;
  focusLabel?: string;
  onFocus?: () => void;
  onAction: (id: ActionDef['id']) => void;
  onKill: () => void;
  onHelp: () => void;
  /** active group: the middle buttons become bulk actions for it */
  group?: { id: string; name: string; color: string; count: number } | null;
  onGroupBulk?: (action: 'move' | 'launch' | 'station' | 'stop') => void;
  /** T51/T60 operator screens (alerts, optimiser, send to, fleet ops) */
  opsActive?: boolean;
  onOps?: () => void;
  opsBadge?: number;
}

/**
 * Always visible, never nested. The three middle buttons follow the selection;
 * STOP ALL and Help never move.
 */
export function ActionBar({
  count,
  actions,
  comingSoon,
  killOn,
  followName,
  canFocus = false,
  focusLabel = 'Focus selection',
  onFocus,
  onAction,
  onKill,
  onHelp,
  group = null,
  onGroupBulk,
  opsActive = false,
  onOps,
  opsBadge = 0,
}: ActionBarProps) {
  return (
    <div className="action-bar" data-testid="action-bar">
      <div className="action-selection" data-testid="selection-count" data-count={count}>
        <strong>{group ? group.name : selectionSummary(count)}</strong>
        <span>
          {group
            ? `${group.count} member(s) · bulk actions hit this group only`
            : count === 0
              ? 'Click a ship on the map'
              : followName
                ? `Following ${followName}`
                : 'Shift-click adds · Shift-drag box-select'}
        </span>
      </div>
      {group ? (
        <div className="action-group group-bar" data-testid="group-action-bar" data-group={group.id} style={{ borderColor: group.color }}>
          <button type="button" data-testid="groupbar-move" onClick={() => onGroupBulk?.('move')}>
            Move here
          </button>
          <button type="button" data-testid="groupbar-launch" onClick={() => onGroupBulk?.('launch')}>
            Launch to orbit
          </button>
          <button type="button" data-testid="groupbar-station" onClick={() => onGroupBulk?.('station')}>
            Station / Ship
          </button>
          <button type="button" className="groupbar-stop" data-testid="groupbar-stop" onClick={() => onGroupBulk?.('stop')}>
            Stop group
          </button>
        </div>
      ) : (
      <div className="action-group">
        {actions.map((action) => {
          const soon = comingSoon.includes(action.id);
          return (
            <button
              key={action.id}
              type="button"
              className={action.primary ? 'primary' : ''}
              data-testid={`action-${action.id}`}
              title={soon ? 'This backend route is not deployed yet — coming soon.' : action.hint}
              onClick={() => onAction(action.id)}
            >
              <span className="btn-label-long">{action.label}</span>
              <span className="btn-label-short">{action.label.split(' ')[0]}</span>
              {soon && <span className="soon-tag">coming soon</span>}
            </button>
          );
        })}
      </div>
      )}
      <div className="action-danger">
        <button type="button" className={`chip${opsActive ? ' active' : ''}`} data-testid="ops-toggle" aria-pressed={opsActive} onClick={onOps} title="Alerts, optimiser, send-to and fleet operations">
          Ops{opsBadge > 0 ? ` (${opsBadge})` : ''}
        </button>
        <button
          type="button"
          className="chip action-focus"
          data-testid="action-focus"
          onClick={onFocus}
          disabled={!canFocus}
          title="Fly to the selected ship or group (also: double-click it)"
        >
          <span className="btn-label-long">{focusLabel}</span>
          <span className="btn-label-short">Focus</span>
        </button>
        <button type="button" className="help-btn" data-testid="help-open" onClick={onHelp} title="Keyboard and mouse shortcuts (?)">
          ?
        </button>
        <button
          type="button"
          className={`kill${killOn ? ' on' : ''}`}
          data-testid="kill-switch"
          aria-pressed={killOn}
          onClick={onKill}
          title="Stop every moving grid on the test server"
        >
          {killOn ? 'STOPPED — resume' : 'STOP ALL'}
        </button>
      </div>
    </div>
  );
}
