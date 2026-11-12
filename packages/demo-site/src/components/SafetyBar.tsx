export interface SafetyBarProps {
  killSwitch: boolean;
  pluginConnected: boolean;
  /** Fresh plugin telemetry in the last 60 s — the same source the map uses. */
  linkFresh: boolean;
  heartbeatAgeMs: number | null;
  awaitingApproval: number;
  lastStatus: string | null;
  busy: boolean;
  onKill: () => void;
  onReset: () => void;
}

function ageText(ms: number | null): string {
  if (ms === null) return 'no heartbeat';
  if (ms < 2000) return 'now';
  if (ms < 120_000) return `${Math.round(ms / 1000)} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

export function SafetyBar({
  killSwitch,
  pluginConnected,
  linkFresh,
  heartbeatAgeMs,
  awaitingApproval,
  lastStatus,
  busy,
  onKill,
  onReset,
}: SafetyBarProps) {
  return (
    <footer className={`safety-bar${killSwitch ? ' killed' : ''}`} data-testid="safety-bar">
      <button
        type="button"
        className={`stop-button${killSwitch ? ' on' : ''}`}
        onClick={onKill}
        disabled={busy}
        data-testid="kill-switch"
        aria-pressed={killSwitch}
        title={
          killSwitch
            ? 'Kill switch is ON: all flights stopped, new orders blocked'
            : 'Stop every executing drone and block new orders'
        }
      >
        <span className="kill-dot" />
        {killSwitch ? 'STOPPED — click to resume commands' : '■ STOP ALL DRONES'}
      </button>
      <div className="safety-status">
        <span className={`badge ${linkFresh ? 'badge-ok' : 'badge-warn'}`} data-testid="link-badge">
          {linkFresh ? 'telemetry live' : pluginConnected ? 'plugin connected, no fresh telemetry' : 'plugin offline'} ·{' '}
          {ageText(heartbeatAgeMs)}
        </span>
        {awaitingApproval > 0 && <span className="badge badge-warn">{awaitingApproval} awaiting approval</span>}
        {lastStatus && <span className="muted small">last: {lastStatus}</span>}
      </div>
      <details className="danger-menu" data-testid="danger-menu">
        <summary title="Destructive actions live here, apart from the kill switch">⚙ Danger zone</summary>
        <div className="danger-menu-body">
          <p className="muted small">
            Reset creates a reset mission with a typed confirm; it is not the emergency stop. Use STOP ALL DRONES for that.
          </p>
          <button type="button" className="danger-outline" onClick={onReset} disabled={busy} data-testid="reset-open">
            Reset test world (snapshot + typed confirm)
          </button>
        </div>
      </details>
    </footer>
  );
}
