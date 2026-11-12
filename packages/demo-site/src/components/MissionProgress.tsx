import { useState } from 'react';
import type { DemoExecution, ExecutionsState } from '../types';

function km(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function eta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

const STATE_CLASS: Record<string, string> = {
  queued: 'badge',
  spawning: 'badge badge-warn',
  securing: 'badge badge-warn',
  en_route: 'badge badge-ok',
  holding: 'badge badge-ok',
  stopped: 'badge badge-danger',
  failed: 'badge badge-danger',
  skipped: 'badge',
};

function ExecutionCard({ exec }: { exec: DemoExecution }) {
  const [open, setOpen] = useState(true);
  const active = exec.drones.filter((d) => d.state !== 'skipped');
  return (
    <div className="exec-card" data-testid={`exec-${exec.missionId}`}>
      <button type="button" className="exec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mono small">{exec.missionId}</span>
        <span className={STATE_CLASS[exec.state] ?? 'badge'}>{exec.state}</span>
        {exec.scaled && (
          <span className="badge badge-warn" title="Plan slots are compressed to a short local leg for the LAN demo">
            SCALED DEMO
          </span>
        )}
        <span className="muted small">
          {exec.counts.holding}/{active.length} holding · {exec.counts.enRoute} flying · {exec.counts.failed} failed
        </span>
      </button>
      {exec.note && <p className="exec-note">{exec.note}</p>}
      {open && (
        <ul className="drone-rows">
          {active.map((d) => (
            <li key={d.idx} data-testid={`drone-${exec.missionId}-${d.idx}`} data-state={d.state}>
              <span className={STATE_CLASS[d.state] ?? 'badge'}>{d.state}</span>
              <span className="drone-label">
                {d.label}
                <span className="muted small"> · {d.prefab}</span>
              </span>
              <span className="drone-meta">
                {d.state === 'en_route' || d.state === 'holding' ? (
                  <>
                    {km(d.remainingM)} to slot · ETA {eta(d.etaSec)}
                  </>
                ) : (
                  d.reason ?? '—'
                )}
              </span>
              {d.stagingLine && (
                <span
                  className={`drone-staging${d.staging?.emergency ? ' drone-staging-emergency' : ''}`}
                  title={d.staging ? `altitude ${km(d.staging.altitudeM)} · required ${d.staging.requiredN ?? '—'} N · H2 ${d.staging.h2} · fuel saved ${d.staging.fuelSavedL} L (${d.staging.labels.join(', ')})` : undefined}
                >
                  {d.stagingLine}
                  {d.staging && d.staging.fuelSavedL > 0 ? ` · saved ${d.staging.fuelSavedL} L` : ''}
                </span>
              )}
              {d.state === 'failed' && d.reason && <span className="drone-reason">{d.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {exec.counts.skipped > 0 && (
        <p className="muted small">
          {exec.counts.skipped} of {exec.total} planned nodes not executed (demo cap {exec.cap}) — clearly labelled, not a
          full deployment.
        </p>
      )}
    </div>
  );
}

export interface MissionProgressProps {
  executions: ExecutionsState | undefined;
}

export function MissionProgress({ executions }: MissionProgressProps) {
  const enabled = executions?.enabled === true;
  const list = executions?.executions ?? [];
  return (
    <section className="panel mission-progress" data-testid="mission-progress">
      <div className="panel-head">
        <h3>Mission progress</h3>
        <span className={`badge ${enabled ? 'badge-ok' : 'badge-warn'}`} data-testid="executor-flag">
          executor {enabled ? 'ON' : 'OFF'}
        </span>
      </div>
      {!enabled && (
        <p className="muted small">
          demo_execute is off: missions are queued only, nothing is sent to the plugin.
        </p>
      )}
      {enabled && list.length === 0 && (
        <p className="muted small">
          No approved demo mission yet. Connect two planets, approve the mission, and drones appear here within a second of
          the spawn order.
        </p>
      )}
      {list.map((exec) => (
        <ExecutionCard key={exec.missionId} exec={exec} />
      ))}
      {executions && (
        <p className="muted small">
          speed limit {executions.speedLimitMps} m/s · per-mission cap {executions.maxDronesPerMission} · active{' '}
          {executions.active}/{executions.maxActiveStandIns} · labels {executions.labels.join(', ')}
          {executions.staging && (
            <>
              {' '}· staging {executions.staging.enabled ? 'ON' : 'OFF'}
              {executions.staging.dryRun ? ' (dry-run)' : ''} every {Math.round(executions.staging.tickMs / 1000)} s
            </>
          )}
        </p>
      )}
    </section>
  );
}
