import type { DesignerOption } from '../lib/designer';
import { coverageLabel, formatDurationS, formatGravity, formatKm, redundancyLabel, shortRedundancyLabel } from '../lib/designer';

export interface DesignerOptionCardsProps {
  options: DesignerOption[];
  selectedId: string | null;
  onSelect: (option: DesignerOption) => void;
  /** Hover previews the option in 3D without changing the selection. */
  onHover?: (option: DesignerOption | null) => void;
}

function Badge({ text }: { text: string }) {
  return <span className={`badge badge-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{text}</span>;
}

/**
 * Side-by-side planner options (up to 4). Presentational only, so it renders
 * in unit tests without a browser or a backend.
 */
export function DesignerOptionCards({ options, selectedId, onSelect, onHover }: DesignerOptionCardsProps) {
  if (options.length === 0) {
    return (
      <p className="muted small" data-testid="designer-options-empty">
        No options yet — set the parameters and press Plan.
      </p>
    );
  }
  return (
    <div className="designer-options-grid" data-testid="designer-options" data-option-count={options.length}>
      {options.map((option) => {
        const selected = option.id === selectedId;
        const endurance = option.endurance;
        return (
          <article
            key={option.id}
            className={`designer-option${selected ? ' selected' : ''}${option.feasible ? '' : ' infeasible'}`}
            data-testid={`designer-option-${option.id}`}
            data-option-id={option.id}
            data-count={option.count}
            data-redundancy={String(option.redundancyAchieved)}
            data-feasible={String(option.feasible)}
            data-slot-count={option.positions.length}
            aria-selected={selected}
            onMouseEnter={() => onHover?.(option)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(option)}
            onBlur={() => onHover?.(null)}
          >
            <header className="designer-option-head">
              <h4>{option.pattern}</h4>
              <span className={`badge ${option.feasible ? 'badge-ok' : 'badge-danger'}`} data-testid="designer-option-feasible">
                {option.feasible ? 'feasible' : 'infeasible'}
              </span>
            </header>

            <div className="designer-option-count">
              <span className="designer-option-big" data-testid="designer-option-count">
                {option.count}
              </span>
              <span className="muted small"> slots</span>
              <span className="designer-option-red" data-testid="designer-option-redundancy" title={redundancyLabel(option.redundancyAchieved)}>
                {shortRedundancyLabel(option.redundancyAchieved)}
              </span>
            </div>

            <dl className="designer-facts">
              <div>
                <dt>Redundancy</dt>
                <dd>{redundancyLabel(option.redundancyAchieved)}</dd>
              </div>
              <div>
                <dt>SPOFs</dt>
                <dd data-testid="designer-option-spofs">
                  {option.spofs.length
                    ? `${option.spofs.length}${option.spofs.length <= 3 ? ` (${option.spofs.join(', ')})` : ` (${option.spofs.slice(0, 3).join(', ')}…)`}`
                    : 'none'}
                </dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd data-testid="designer-option-coverage">{coverageLabel(option.coveragePct)}</dd>
              </div>
              <div>
                <dt>Gravity at slot</dt>
                <dd data-testid="designer-option-gravity">{formatGravity(option.gravityAtSlotMps2)}</dd>
              </div>
              <div>
                <dt>Max gap</dt>
                <dd>{formatKm(option.maxGapM)}</dd>
              </div>
              <div>
                <dt>Altitude</dt>
                <dd>{formatKm(option.altitudeM)}</dd>
              </div>
              {endurance?.available && (
                <>
                  <div>
                    <dt>Ascent / ETA</dt>
                    <dd data-testid="designer-option-eta">
                      {formatDurationS(endurance.ascentTimeS)} / {formatDurationS(endurance.etaS)}
                    </dd>
                  </div>
                  <div>
                    <dt>Reserve</dt>
                    <dd data-testid="designer-option-reserve">{formatPct(endurance.reservePct)}</dd>
                  </div>
                  <div>
                    <dt>Hold</dt>
                    <dd data-testid="designer-option-hold">{endurance.holdEnduranceText}</dd>
                  </div>
                </>
              )}
            </dl>

            <p className="designer-summary">{option.summary}</p>

            {endurance && (
              <div
                className={`designer-endurance${endurance.canReachSlot === false ? ' blocked' : ''}`}
                data-testid="designer-option-endurance"
                data-can-reach={String(endurance.canReachSlot)}
              >
                <p className="small">
                  <strong>{endurance.available ? (endurance.canReachSlot ? 'reachable' : 'cannot reach') : 'endurance n/a'}</strong>
                  {endurance.launch ? ` · ${endurance.launch} launch` : ''}
                  {endurance.available
                    ? ` · H2 ${formatPct(endurance.fuelUsedPct)} · battery ${formatPct(endurance.batteryUsedPct)}`
                    : ''}
                  {endurance.holdPowerMW !== null ? ` · hold ${endurance.holdPowerMW.toFixed(2)} MW` : ''}
                  {endurance.holdH2BurnLps !== null && endurance.holdH2BurnLps > 0
                    ? ` · ${endurance.holdH2BurnLps.toFixed(1)} L/s`
                    : ''}
                </p>
                {endurance.failureReason && (
                  <p className="small designer-endurance-failure" data-testid="designer-option-endurance-reason">
                    {endurance.failureReason}
                  </p>
                )}
                <p className="small muted">{endurance.recommendation}</p>
              </div>
            )}

            {!option.feasible && option.reasons.length > 0 && (
              <ul className="designer-reasons" data-testid="designer-option-reasons">
                {option.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}

            <div className="designer-option-labels">
              {option.labels.map((label) => (
                <Badge key={label} text={label} />
              ))}
            </div>

            <button
              type="button"
              className={selected ? 'primary' : ''}
              aria-pressed={selected}
              onClick={() => onSelect(option)}
              data-testid={`designer-select-${option.id}`}
            >
              {selected ? 'Selected' : 'Preview'}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}
