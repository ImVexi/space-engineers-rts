import type { DemoNode } from '../types';
import { LIVE_MS } from '../lib/markers';

export interface LiveGridsPanelProps {
  nodes: DemoNode[];
  selectedId: string | null;
  showStale: boolean;
  onFocus: (node: DemoNode) => void;
}

function ageText(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 1) return 'now';
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function GridRow({ node, live, selected, onFocus }: { node: DemoNode; live: boolean; selected: boolean; onFocus: (n: DemoNode) => void }) {
  const telemetry = node.telemetry!;
  return (
    <li>
      <button
        type="button"
        className={`grid-row${live ? '' : ' stale'}${selected ? ' selected' : ''}`}
        data-testid={`grid-row-${node.id}`}
        data-id={node.id}
        data-live={live ? 'true' : 'false'}
        onClick={() => onFocus(node)}
        title={`Fly to ${node.name}`}
      >
        <span className="grid-row-name">
          <i className={`dot ${live ? (telemetry.moving ? 'cyan' : 'green') : 'grey'}`} />
          {node.name}
        </span>
        <span className="grid-row-meta">
          {Math.round(telemetry.speedMps)} m/s · {ageText(telemetry.ageMs)}
          {telemetry.ownership ? ` · ${telemetry.ownership}` : ''}
        </span>
      </button>
    </li>
  );
}

/**
 * Side list of telemetry grids. Live rows are always listed; stale rows only
 * appear when the operator opts into "Show stale" so the default view matches
 * the map (live only). Every row flies the camera to that grid.
 */
export function LiveGridsPanel({ nodes, selectedId, showStale, onFocus }: LiveGridsPanelProps) {
  const withTelemetry = nodes.filter((n) => n.source === 'GAME' && n.telemetry);
  const live = withTelemetry
    .filter((n) => (n.telemetry?.ageMs ?? Infinity) <= LIVE_MS)
    .sort((a, b) => Number(b.telemetry?.moving ?? false) - Number(a.telemetry?.moving ?? false) || a.name.localeCompare(b.name));
  const stale = withTelemetry
    .filter((n) => (n.telemetry?.ageMs ?? Infinity) > LIVE_MS)
    .sort((a, b) => (a.telemetry?.ageMs ?? 0) - (b.telemetry?.ageMs ?? 0));

  return (
    <section className="panel live-grids" data-testid="live-grids-panel">
      <div className="panel-head">
        <h3>Live grids</h3>
        <span className={`badge ${live.length ? 'badge-ok' : 'badge-warn'}`} data-testid="live-grids-count">
          {live.length} live
        </span>
      </div>
      {live.length === 0 ? (
        <p className="muted small">
          No grid has sent telemetry in the last {Math.round(LIVE_MS / 1000)} s.
          {stale.length > 0 ? ` ${stale.length} stale grid${stale.length === 1 ? '' : 's'} hidden.` : ''}
        </p>
      ) : (
        <ul className="grid-rows" data-testid="live-grid-rows">
          {live.map((node) => (
            <GridRow key={node.id} node={node} live selected={selectedId === node.id} onFocus={onFocus} />
          ))}
        </ul>
      )}
      {showStale && stale.length > 0 && (
        <>
          <h4 className="stale-head">Stale · {stale.length}</h4>
          <ul className="grid-rows stale-rows" data-testid="stale-grid-rows">
            {stale.map((node) => (
              <GridRow key={node.id} node={node} live={false} selected={selectedId === node.id} onFocus={onFocus} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
