import { useMemo, useState } from 'react';
import type { MissionSummary } from '../types';

export interface MissionStripProps {
  missions: MissionSummary[];
  dismissed: Set<string>;
  onDismiss: (id: string) => void;
  onClearFailed: () => void;
  onOpenMission: (id: string) => void;
}

function missionWords(mission: MissionSummary): string {
  const type = mission.type;
  const status = mission.status;
  if (type === 'move') {
    if (status === 'failed') return 'Move failed';
    if (status === 'running' || status === 'approved') return 'Ship moving';
    return 'Move';
  }
  if (type === 'build_deploy') {
    if (status === 'failed') return 'Launch failed';
    if (status === 'running') return 'Launching satellites';
    if (status === 'approved') return 'Launch approved';
    return 'Launch';
  }
  if (type === 'reset') return 'World reset';
  return `${type.replace(/_/g, ' ')} · ${status}`;
}

function statusTone(status: string): string {
  if (status === 'failed') return 'bad';
  if (status === 'running') return 'ok';
  return 'muted';
}

/** Compact mission list: plain words, failures collapsed behind one toggle. */
export function MissionStrip({ missions, dismissed, onDismiss, onClearFailed, onOpenMission }: MissionStripProps) {
  const [showFailed, setShowFailed] = useState(false);
  const visible = useMemo(() => missions.filter((m) => !dismissed.has(m.id)), [missions, dismissed]);
  const active = visible.filter((m) => m.status !== 'failed').slice(0, 3);
  const failed = visible.filter((m) => m.status === 'failed');

  if (visible.length === 0) return null;

  return (
    <div className="mission-strip" data-testid="mission-strip">
      <div className="mission-head">
        <strong>Missions</strong>
        {failed.length > 0 && (
          <span className="mission-failed">
            {failed.length} failed
            <button type="button" onClick={() => setShowFailed((v) => !v)} data-testid="mission-toggle-failed">
              {showFailed ? 'hide' : 'show'}
            </button>
            <button type="button" onClick={onClearFailed} data-testid="mission-clear-failed">
              clear
            </button>
          </span>
        )}
      </div>
      <ul>
        {active.map((m) => (
          <li key={m.id}>
            <span className={`dot-status ${statusTone(m.status)}`} />
            <button type="button" className="mission-name" onClick={() => onOpenMission(m.id)} title={m.id}>
              {missionWords(m)}
            </button>
            <span className="muted small">{m.status === 'approved' ? 'queued' : m.status}</span>
            <button type="button" className="mission-dismiss" aria-label={`Dismiss ${m.id}`} onClick={() => onDismiss(m.id)}>
              ✕
            </button>
          </li>
        ))}
        {showFailed &&
          failed.slice(0, 5).map((m) => (
            <li key={m.id} className="mission-failure">
              <span className="dot-status bad" />
              <span className="mission-name">{missionWords(m)}</span>
              <span className="muted small">{new Date(m.createdAt).toLocaleTimeString()}</span>
              <button type="button" className="mission-dismiss" aria-label={`Dismiss ${m.id}`} onClick={() => onDismiss(m.id)}>
                ✕
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
