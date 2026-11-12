import type { DemoState } from '../types';
import type { Overlays } from './Scene';

export interface NetworkPanelProps {
  state: DemoState;
  overlays: Overlays;
  showStale: boolean;
  showAll: boolean;
  /** include rows older than the 6 h archive window (fetched on demand) */
  showArchived: boolean;
  archivedCount: number;
  onOverlays: (next: Overlays) => void;
  onShowStale: (value: boolean) => void;
  onShowAll: (value: boolean) => void;
  onShowArchived: (value: boolean) => void;
  /** T23 pulse speed slider: slow / normal / off */
  pulseSpeed: 'slow' | 'normal' | 'off';
  onPulseSpeed: (value: 'slow' | 'normal' | 'off') => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** Network view: one compact sheet, no submenus. */
export function NetworkPanel({
  state,
  overlays,
  showStale,
  showAll,
  showArchived,
  archivedCount,
  onOverlays,
  onShowStale,
  onShowAll,
  onShowArchived,
  pulseSpeed,
  onPulseSpeed,
  onSelect,
  onClose,
}: NetworkPanelProps) {
  type BoolKey = {
    [K in keyof Overlays]: Overlays[K] extends boolean ? K : never;
  }[keyof Overlays];
  const toggle = (key: BoolKey) => onOverlays({ ...overlays, [key]: !overlays[key] });
  return (
    <aside className="sheet network-sheet" data-testid="network-panel" aria-label="Network view">
      <header className="sheet-head">
        <h2>Network</h2>
        <button type="button" onClick={onClose} aria-label="Close network view">
          ✕
        </button>
      </header>
      <div className="network-stats">
        <span className="ok">{state.reachability.reachable.length} reachable</span>
        <span className="warn">{state.reachability.isolated.length} isolated</span>
        <span className={state.spofs.length ? 'bad' : 'muted'}>
          {state.spofs.length ? `▲ ${state.spofs.length} single points of failure` : 'No single points of failure'}
        </span>
      </div>
      <div className="checks">
        <label className="pulse-speed" title="Radio range ring animation speed">
          Pulse speed
          <select
            value={pulseSpeed}
            data-testid="pulse-speed"
            onChange={(e) => onPulseSpeed(e.target.value as 'slow' | 'normal' | 'off')}
          >
            <option value="slow">Slow (12 s)</option>
            <option value="normal">Normal (6 s)</option>
            <option value="off">Off</option>
          </select>
        </label>
        {(
          [
            ['radioSpheres', 'Radio range spheres'],
            ['radioRings', 'Radio range pulses (true scale)'],
            ['reachableColours', 'Reachable vs isolated colours'],
            ['labels', 'Show labels'],
            ['terrain', 'Planet terrain (when available)'],
            ['shapes', 'Real ship shapes (block models)'],
            ['blockByFunction', 'Colour blocks by function (not paint)'],
          ] as [BoolKey, string][]
        ).map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={overlays[key]} onChange={() => toggle(key)} data-testid={`overlay-${key}`} />
            {label}
          </label>
        ))}
        <label>
          <input type="checkbox" checked={showStale} onChange={(e) => onShowStale(e.target.checked)} data-testid="toggle-stale" />
          Show stale grids
        </label>
        <label>
          <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} data-testid="toggle-show-all" />
          Show all {state.nodes.length} recent grids
        </label>
        {archivedCount > 0 && (
          <label title="Telemetry rows the plugin saw more than 6 h ago; kept as history, not live ships">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => onShowArchived(e.target.checked)}
              data-testid="toggle-show-archived"
            />
            Show archived ({archivedCount})
          </label>
        )}
      </div>
      <div className="legend-row" aria-label="Map legend">
        <span><i className="swatch live" /> live</span>
        <span><i className="swatch isolated" /> isolated</span>
        <span><i className="swatch laser" /> laser</span>
        <span><i className="swatch radio" /> radio</span>
        <span><i className="swatch spof" /> ▲ single point of failure</span>
      </div>
      {state.spofs.length > 0 && (
        <div className="spof-list" data-testid="spof-list">
          <h3>Single points of failure</h3>
          {state.spofs.map((id) => {
            const node = state.nodes.find((n) => n.id === id);
            return (
              <button key={id} type="button" onClick={() => onSelect(id)} title="If this grid dies, everything behind it is cut off.">
                <span className="spof-icon">▲</span>
                {node?.name ?? id}
              </button>
            );
          })}
          <p className="muted small">Add one more relay on the far side to remove the single path.</p>
        </div>
      )}
    </aside>
  );
}
