import { useState } from 'react';
import { ApiError, api } from '../api';
import type { DemoState, SurvivalLoopRow } from '../types';

export interface SurvivalLoopPanelProps {
  state: DemoState;
  onFocus?: (gridId: string) => void;
  onChanged?: () => void;
  onToast?: (kind: 'info' | 'ok' | 'err', title: string, detail?: string) => void;
}

const STATE_TONE: Record<SurvivalLoopRow['state'], string> = {
  OK: 'ok',
  RETURN_PENDING: 'warn',
  RETURNING: 'warn',
  NEEDS_REFUEL: 'info',
  READY_TO_RELAUNCH: 'ok',
  STRANDED: 'bad',
};

/**
 * T66 survival loop, kept deliberately small: what each ship is doing about its
 * fuel, the one setting that decides whether a return asks first, and the two
 * buttons an owner presses (approve a return, relaunch to slot). Everything it
 * shows is the backend's own reason line, numbers included.
 */
export function SurvivalLoopPanel({ state, onFocus, onChanged, onToast }: SurvivalLoopPanelProps) {
  const survival = state.survival;
  const [busy, setBusy] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);

  if (!survival) return null;
  const rows = survival.grids ?? [];

  const setMode = async (approvalMode: 'auto' | 'approve') => {
    setModeBusy(true);
    try {
      await api.survivalSettings({ approvalMode });
      onToast?.('info', approvalMode === 'auto' ? 'Returns start on their own' : 'Returns wait for approval',
        approvalMode === 'auto'
          ? 'a MANAGED grid that cannot reach home flies itself home and lands; relaunch still needs you'
          : 'a MANAGED grid is recommended home; nothing moves until you approve it');
      onChanged?.();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'setting not changed';
      onToast?.('err', 'Approval mode not changed', message);
    } finally {
      setModeBusy(false);
    }
  };

  const act = async (row: SurvivalLoopRow, kind: 'return' | 'relaunch') => {
    if (kind === 'relaunch' && !window.confirm(`Relaunch ${row.name ?? row.gridId} to its slot? It is refuelled and will fly the normal climb path.`)) {
      return;
    }
    setBusy(`${kind}:${row.gridId}`);
    try {
      if (kind === 'return') await api.survivalReturn(row.gridId);
      else await api.survivalRelaunch(row.gridId, true);
      onToast?.('ok', kind === 'return' ? `${row.name ?? row.gridId}: return approved` : `${row.name ?? row.gridId}: relaunching`,
        kind === 'return' ? 'the guarded mission path flies it home and lands beside the base' : 'it flies back to its remembered slot');
      onChanged?.();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'order refused';
      onToast?.('err', `${row.name ?? row.gridId}: nothing was sent`, message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="survival-loop" data-testid="survival-loop" aria-label="Survival refuel loop">
      <div className="survival-head">
        <h3>Return &amp; refuel</h3>
        <label className="survival-mode" title="What a MANAGED grid does when its fuel/charge runway cannot cover the trip home">
          <input
            type="radio"
            name="survival-approval"
            checked={survival.settings.approvalMode === 'auto'}
            disabled={modeBusy}
            onChange={() => void setMode('auto')}
            data-testid="survival-mode-auto"
          />
          return automatically
          <input
            type="radio"
            name="survival-approval"
            checked={survival.settings.approvalMode === 'approve'}
            disabled={modeBusy}
            onChange={() => void setMode('approve')}
            data-testid="survival-mode-approve"
          />
          ask me first
        </label>
      </div>
      <p className="muted small">
        margin {survival.settings.marginPct} % over the trip home + 15 % reserve · relaunch at {survival.settings.relaunchPct} %
        {' '}· home {survival.defaultHomeId ?? 'BASE-01'}
      </p>
      {rows.length === 0 ? (
        <p className="muted small" data-testid="survival-empty">No grid needs a return: every tank and battery covers the trip home.</p>
      ) : (
        <ul className="survival-rows">
          {rows.map((row) => (
            <li key={row.gridId} className={`survival-row tone-${STATE_TONE[row.state]}`} data-testid={`survival-row-${row.gridId}`}>
              <div className="survival-line">
                <button type="button" className="linkish" onClick={() => onFocus?.(row.gridId)}>
                  {row.name ?? row.gridId}
                </button>
                <span className={`badge survival-state state-${row.state.toLowerCase()}`}>{row.label}</span>
                {row.slotStatus ? <span className="muted small">{row.slotStatus}</span> : null}
                {row.refuelPct !== null ? <span className="muted small">{Math.round(row.refuelPct)} %</span> : null}
              </div>
              <p className="survival-reason small" data-testid={`survival-reason-${row.gridId}`}>{row.reason}</p>
              <div className="survival-actions">
                {row.state === 'RETURN_PENDING' ? (
                  <button type="button" disabled={busy === `return:${row.gridId}`} onClick={() => void act(row, 'return')}>
                    Approve return
                  </button>
                ) : null}
                {row.state === 'READY_TO_RELAUNCH' ? (
                  <button type="button" disabled={busy === `relaunch:${row.gridId}`} onClick={() => void act(row, 'relaunch')}>
                    Relaunch to slot
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
