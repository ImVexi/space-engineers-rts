import type { DemoOption, DemoPlan } from '../types';

export interface OptionComparisonProps {
  plan: DemoPlan;
  selected: string | null;
  onSelect: (id: DemoOption['id']) => void;
}

function km(value: number): string {
  return `${Math.round(value / 1000).toLocaleString('en-US')} km`;
}

function StatusBadge({ status }: { status: 'UNVERIFIED' | 'SIMULATED' }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status}</span>;
}

/**
 * Side-by-side comparison of the planner's radio / laser / mixed options.
 * Pure presentational component (no DOM/WebGL), so it is rendered directly in
 * unit tests.
 */
export function OptionComparison({ plan, selected, onSelect }: OptionComparisonProps) {
  return (
    <div className="option-grid" data-testid="option-comparison">
      {plan.options.map((option) => {
        const isSelected = selected === option.id;
        return (
          <article
            key={option.id}
            className={`option-card${isSelected ? ' selected' : ''}${option.available ? '' : ' unavailable'}`}
            data-testid={`option-${option.id}`}
            aria-selected={isSelected}
          >
            <header className="option-head">
              <h3>{option.label}</h3>
              {plan.preferred === option.id && <span className="preferred">preferred</span>}
            </header>
            {!option.available ? (
              <p className="muted" data-testid={`unavailable-${option.id}`}>
                {option.unavailableReason ?? 'hardware unavailable'}
              </p>
            ) : (
              <>
                <div className="option-counts">
                  <div>
                    <span className="big" data-testid={`count-${option.id}`}>
                      {option.count}
                    </span>
                    <span className="muted"> nodes</span>
                  </div>
                  <div className="muted">{option.relayCount} relays</div>
                </div>
                <dl className="option-facts">
                  <div>
                    <dt>Spacing</dt>
                    <dd>{km(option.spacingM)}</dd>
                  </div>
                  <div>
                    <dt>Max gap</dt>
                    <dd>{km(option.maxGapM)}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>{option.detour ? `detour via ${option.blockedBy.join(', ')}` : 'direct'}</dd>
                  </div>
                  <div>
                    <dt>Laser ports</dt>
                    <dd>
                      {option.portsOk ? 'within capacity' : 'OVER CAPACITY'} ·{' '}
                      {option.portUsage.filter((p) => p.used > 0).length} nodes used
                    </dd>
                  </div>
                  <div>
                    <dt>Link check</dt>
                    <dd>{option.linksOk ? 'every hop links' : `${option.missingLinks.length} broken hop(s)`}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd className="muted">{option.cost.totalCredits === null ? 'placeholder (not modelled)' : `${option.cost.totalCredits} cr`}</dd>
                  </div>
                </dl>
                <ul className="assumptions">
                  {option.assumptions.map((a) => (
                    <li key={a.id}>
                      <StatusBadge status={a.status} /> {a.text}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={isSelected ? 'primary' : ''}
                  disabled={!option.linksOk || !option.portsOk}
                  onClick={() => onSelect(option.id)}
                  data-testid={`select-${option.id}`}
                >
                  {isSelected ? 'Selected for preview' : 'Preview this option'}
                </button>
                {(!option.linksOk || !option.portsOk) && (
                  <p className="warn">This option fails its own link/port check and cannot be approved.</p>
                )}
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
