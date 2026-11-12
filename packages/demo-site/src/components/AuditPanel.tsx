import type { AuditEntry } from '../types';

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

export function AuditPanel({ entries, connected }: { entries: AuditEntry[]; connected: boolean }) {
  return (
    <section className="panel audit" data-testid="audit-panel">
      <header className="panel-head">
        <h3>Audit log</h3>
        <span className={`badge ${connected ? 'badge-ok' : 'badge-warn'}`}>{connected ? 'live' : 'offline'}</span>
      </header>
      {entries.length === 0 ? (
        <p className="muted small">No audit entries yet.</p>
      ) : (
        <ul className="audit-list">
          {entries.slice(0, 30).map((entry) => (
            <li key={entry.id}>
              <time>{time(entry.at)}</time>
              <span className="audit-action">{entry.action}</span>
              <span className="muted small">
                {entry.actor} · {entry.subject}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
