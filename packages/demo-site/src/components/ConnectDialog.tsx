import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { ConnectMissionResponse, DemoOption, DemoPlan, DemoState } from '../types';
import { OptionComparison } from './OptionComparison';

type Hardware = 'auto' | 'radio' | 'laser' | 'mixed';

export interface ConnectDialogProps {
  state: DemoState;
  planetA: string;
  planetB: string;
  onClose: () => void;
  onPreview: (option: DemoOption | null) => void;
  onMissionCreated: (result: ConnectMissionResponse) => void;
  onChanged: () => void;
}

export function ConnectDialog({ state, planetA, planetB, onClose, onPreview, onMissionCreated, onChanged }: ConnectDialogProps) {
  const [hardware, setHardware] = useState<Hardware>('auto');
  const [plan, setPlan] = useState<DemoPlan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<ConnectMissionResponse | null>(null);
  const [missionNote, setMissionNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(null);
    onPreview(null);
    api
      .planConnect({ planetA, planetB, hardware })
      .then((next) => {
        if (cancelled) return;
        setPlan(next);
        const preferred = next.options.find((o) => o.id === next.preferred && o.available && o.linksOk && o.portsOk) ?? next.options.find((o) => o.available && o.linksOk && o.portsOk);
        if (preferred) {
          setSelected(preferred.id);
          onPreview(preferred);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'plan failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [planetA, planetB, hardware]);

  const option = plan?.options.find((o) => o.id === selected) ?? null;

  const approve = async () => {
    if (!option) return;
    setApproving(true);
    setError(null);
    try {
      const created = await api.connectMissions({
        planetA,
        planetB,
        hardware,
        optionId: option.id,
        note: missionNote ?? undefined,
      });
      setResult(created);
      onMissionCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'approval failed');
    } finally {
      setApproving(false);
    }
  };

  const approveMission = async () => {
    if (!result) return;
    setApproving(true);
    setError(null);
    try {
      const approved = await api.approve(result.mission.id);
      setResult({ ...result, mission: { ...result.mission, status: approved.mission.status }, approvalState: { ...result.approvalState, status: approved.mission.status, awaitingApproval: false } });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'approve failed');
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Connect two planets" data-testid="connect-dialog">
      <div className="modal wide">
        <header className="modal-head">
          <div>
            <h2>
              Connect {planetA} → {planetB}
            </h2>
            <p className="muted">Planner comparison. Nothing spawns from this screen; approving only queues missions.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-testid="close-connect">
            ✕
          </button>
        </header>

        <div className="connect-controls">
          <label>
            Hardware preference
            <select
              value={hardware}
              onChange={(e) => setHardware(e.target.value as Hardware)}
              data-testid="hardware-select"
            >
              <option value="auto">auto (compare all)</option>
              <option value="radio">radio only</option>
              <option value="laser">laser only</option>
              <option value="mixed">mixed</option>
            </select>
          </label>
          <div className="hardware-summary">
            <div>{plan?.hardwareSummary.radio ?? state.hardwareSummary.radio}</div>
            <div>{plan?.hardwareSummary.laser ?? state.hardwareSummary.laser}</div>
            <div>{plan?.hardwareSummary.mixed ?? state.hardwareSummary.mixed}</div>
          </div>
        </div>

        {loading && <p data-testid="plan-loading">Computing planner options…</p>}
        {error && (
          <p className="error" data-testid="connect-error">
            {error}
          </p>
        )}

        {plan && !result && (
          <>
            <OptionComparison plan={plan} selected={selected} onSelect={(id) => {
              setSelected(id);
              onPreview(plan.options.find((o) => o.id === id) ?? null);
            }} />
            <div className="modal-actions">
              <label className="note-field">
                Operator note (optional)
                <input value={missionNote ?? ''} onChange={(e) => setMissionNote(e.target.value)} maxLength={400} />
              </label>
              <button
                type="button"
                className="primary big"
                disabled={!option || approving}
                onClick={() => void approve()}
                data-testid="approve-connect"
              >
                {approving ? 'Creating missions…' : `Approve plan — create ${option?.count ?? 0} node mission`}
              </button>
            </div>
            <p className="muted small">
              Approval creates a mission in <code>queued / approval: approve</code>. Execution stays{' '}
              <strong>{state.plugin.connected ? 'blocked on operator approval + dispatch flag' : 'pending: plugin not connected'}</strong>.
            </p>
          </>
        )}

        {result && (
          <div className="mission-result" data-testid="mission-state">
            <h3>Mission queued — awaiting approval</h3>
            <dl>
              <div>
                <dt>Mission</dt>
                <dd>{result.mission.id}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{result.mission.type}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd data-testid="mission-status">
                  {result.mission.status} / approval: {result.mission.approval}
                </dd>
              </div>
              <div>
                <dt>Nodes</dt>
                <dd>{result.option.count} ({result.option.relayCount} relays)</dd>
              </div>
              <div>
                <dt>Comms gate</dt>
                <dd>
                  {result.commsGate.source} — {result.commsGate.reason}
                </dd>
              </div>
              <div>
                <dt>Execution</dt>
                <dd data-testid="execution-state">{result.execution.status}</dd>
              </div>
            </dl>
            <p className="muted small">{result.mission.plan.notes}</p>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={approving || !result.approvalState.awaitingApproval}
                onClick={() => void approveMission()}
                data-testid="approve-mission"
              >
                Approve mission (queue only)
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
