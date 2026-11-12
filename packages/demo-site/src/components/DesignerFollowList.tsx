import { useState } from 'react';
import type { DemoExecution, DemoDroneProgress } from '../types';
import { TELEPORT_HINT, formatGpsString } from '../lib/designer';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function copyable(drone: DemoDroneProgress): string | null {
  if (!drone.position) return null;
  return formatGpsString(drone.label || `drone-${drone.idx}`, drone.position, '#75FF75');
}

/**
 * Per-drone "Follow": copies an SE GPS string for the drone's last known
 * position (plugin telemetry) and shows the in-game teleport path. Nothing
 * here moves a grid — it only prepares a clipboard string for the owner.
 */
export function DesignerFollowList({ executions }: { executions: DemoExecution[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const drones = executions.flatMap((exec) => exec.drones.map((drone) => ({ exec, drone })));

  if (drones.length === 0) {
    return (
      <section className="designer-section" data-testid="designer-follow">
        <h4>Follow a drone</h4>
        <p className="muted small">No executive drones yet. Approve a designer option to launch.</p>
      </section>
    );
  }

  return (
    <section className="designer-section" data-testid="designer-follow">
      <h4>Follow a drone</h4>
      <ul className="designer-follow-list">
        {drones.map(({ exec, drone }) => {
          const gps = copyable(drone);
          const key = `${exec.missionId}:${drone.idx}`;
          return (
            <li key={key} data-testid="designer-follow-row" data-drone={drone.label}>
              <span className={`badge ${drone.state === 'holding' ? 'badge-ok' : drone.state === 'failed' ? 'badge-danger' : 'badge-warn'}`}>
                {drone.state}
              </span>
              <span className="designer-follow-name" title={`${exec.missionId} · slot ${drone.idx}`}>
                {drone.label}
              </span>
              <button
                type="button"
                disabled={!gps}
                title={gps ?? 'no position yet'}
                onClick={() => {
                  if (!gps) return;
                  void copyText(gps).then((ok) => {
                    setCopied(ok ? key : null);
                    setFailed(ok ? null : key);
                  });
                }}
                data-testid="designer-follow-copy"
              >
                {copied === key ? 'Copied' : failed === key ? 'Copy failed' : 'Copy GPS'}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small" data-testid="designer-follow-hint">
        Paste the GPS into the SE chat, then <strong>{TELEPORT_HINT}</strong> and pick the grid.
      </p>
    </section>
  );
}
