import type { DesignerSettings } from '../lib/designer';
import { MAX_ACTIVE, MAX_RESERVE_PCT, MAX_SIMSPEED, MIN_ACTIVE, MIN_RESERVE_PCT, MIN_SIMSPEED } from '../lib/designer';

export interface DesignerSettingsPanelProps {
  draft: DesignerSettings;
  liveSimSpeed: number | null;
  simSpeedThreshold: number | null;
  blocked: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: DesignerSettings) => void;
  onApply: () => void;
}

/**
 * SimSpeed floor + active-drone cap. The executor reads the saved values, so
 * the panel always shows the live sample next to the editable floor.
 */
export function DesignerSettingsPanel({
  draft,
  liveSimSpeed,
  simSpeedThreshold,
  blocked,
  dirty,
  saving,
  error,
  onChange,
  onApply,
}: DesignerSettingsPanelProps) {
  const live = liveSimSpeed === null ? 'unknown' : liveSimSpeed.toFixed(2);
  return (
    <section className="designer-section" data-testid="designer-settings">
      <h4>Executor limits</h4>
      <label className="designer-slider">
        <span>
          SimSpeed min <strong data-testid="designer-simspeed-value">{draft.simSpeedMin.toFixed(2)}</strong>
          <span className="muted small"> · live {live}</span>
        </span>
        <input
          type="range"
          min={MIN_SIMSPEED}
          max={MAX_SIMSPEED}
          step={0.01}
          value={draft.simSpeedMin}
          onChange={(e) => onChange({ ...draft, simSpeedMin: Number(e.target.value) })}
          data-testid="designer-simspeed"
        />
      </label>
      <p className="muted small" data-testid="designer-simspeed-live" data-live={liveSimSpeed ?? ''}>
        live SimSpeed {live}
        {simSpeedThreshold !== null ? ` · flight gate ${blocked ? 'BLOCKED' : 'open'} at ${simSpeedThreshold.toFixed(2)}` : ''}
      </p>
      <label className="designer-slider">
        <span>
          Max active drones <strong data-testid="designer-maxactive-value">{draft.maxActive}</strong>
        </span>
        <input
          type="range"
          min={MIN_ACTIVE}
          max={MAX_ACTIVE}
          step={1}
          value={draft.maxActive}
          onChange={(e) => onChange({ ...draft, maxActive: Number(e.target.value) })}
          data-testid="designer-maxactive"
        />
      </label>
      <label className="designer-slider">
        <span>
          Launch reserve <strong data-testid="designer-reserve-value">{draft.launchReservePct ?? 15}%</strong>
          <span className="muted small"> · preflight refuses below this</span>
        </span>
        <input
          type="range"
          min={MIN_RESERVE_PCT}
          max={MAX_RESERVE_PCT}
          step={1}
          value={draft.launchReservePct ?? 15}
          onChange={(e) => onChange({ ...draft, launchReservePct: Number(e.target.value) })}
          data-testid="designer-reserve"
        />
      </label>
      <div className="row">
        <button type="button" onClick={onApply} disabled={!dirty || saving} data-testid="designer-settings-save">
          {saving ? 'Saving…' : dirty ? 'Apply limits' : 'Limits applied'}
        </button>
      </div>
      {error && (
        <p className="error small" data-testid="designer-settings-error">
          {error}
        </p>
      )}
    </section>
  );
}
