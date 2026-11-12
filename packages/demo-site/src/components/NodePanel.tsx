import type { DemoNode, ExpandResponse, WhatIfResponse } from '../types';

export interface NodePanelProps {
  node: DemoNode | null;
  busy: boolean;
  whatIf: WhatIfResponse | null;
  expand: ExpandResponse | null;
  onClose: () => void;
  onMove: (node: DemoNode) => void;
  onExpand: (node: DemoNode) => void;
  onWhatIf: (node: DemoNode) => void;
}

function km(m: number): string {
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

export function NodePanel({ node, busy, whatIf, expand, onClose, onMove, onExpand, onWhatIf }: NodePanelProps) {
  if (!node) {
    return (
      <section className="panel" data-testid="node-panel-empty">
        <h3>Node inspector</h3>
        <p className="muted">Click a relay, bridge or station in the 3D map to inspect its ports, links and gate state.</p>
      </section>
    );
  }
  const cap = node.capability;
  const free = node.ports.capacity - node.ports.used;
  return (
    <section className="panel" data-testid="node-panel" data-node-id={node.id}>
      <header className="panel-head">
        <div>
          <h3>{node.name}</h3>
          <p className="muted small">
            {node.prefab} · {node.planet ?? 'deep space'} · {node.origin}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close node panel">
          ✕
        </button>
      </header>

      <div className="fact-row">
        <span className={`badge badge-${node.source === 'GAME' ? 'game' : 'simulated'}`}>{node.source}</span>
        <span className={`badge ${node.reachable ? 'badge-ok' : 'badge-warn'}`}>{node.reachable ? 'reachable' : 'isolated'}</span>
        {node.controlSource && <span className="badge badge-control">control source</span>}
        {node.status === 'planned' && <span className="badge badge-warn">planned only</span>}
      </div>

      <dl className="facts">
        <div>
          <dt>Radio</dt>
          <dd>{cap?.radioRadiusM ? km(cap.radioRadiusM) : 'none / unknown'}</dd>
        </div>
        <div>
          <dt>Laser</dt>
          <dd>{cap?.laserRangeM ? `${km(cap.laserRangeM)} model cap` : 'none / unknown'}</dd>
        </div>
        <div>
          <dt>Laser ports</dt>
          <dd data-testid="port-usage">
            {node.ports.used} used / {Math.max(0, free)} free (cap {node.ports.capacity})
          </dd>
        </div>
        <div>
          <dt>Controllable</dt>
          <dd>{String(cap?.controllable ?? 'unknown')}</dd>
        </div>
        <div>
          <dt>Gate</dt>
          <dd>
            {node.gate ? (node.gate.allowed ? 'allowed' : 'DENIED') : 'n/a'} · {node.gate?.source ?? 'n/a'}
          </dd>
        </div>
      </dl>

      <h4>Links ({node.links.length})</h4>
      {node.links.length === 0 ? (
        <p className="muted small">No links in the planner graph.</p>
      ) : (
        <ul className="link-list" data-testid="node-links">
          {node.links.map((link) => (
            <li key={`${link.to}-${link.kind}`}>
              <span className={`link-dot ${link.kind}`} /> {link.kind} → {link.to} ({km(link.distanceM)})
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        {node.source === 'GAME'
          ? 'Link state: GAME — plugin telemetry is authoritative.'
          : 'Link state: UNVERIFIED — planner geometry; laser range, LOS and moving-grid tracking are unmeasured in game.'}
      </p>
      <p className="muted small">{node.note}</p>

      <div className="panel-actions">
        <button type="button" disabled={busy || node.status !== 'alive'} onClick={() => onMove(node)} data-testid="move-here">
          Move this grid…
        </button>
        <button type="button" disabled={busy} onClick={() => onExpand(node)} data-testid="expand-here">
          Expand network from here
        </button>
        <button type="button" disabled={busy} onClick={() => onWhatIf(node)} data-testid="what-if">
          What if this node dies?
        </button>
      </div>

      {whatIf && (
        <div className="callout" data-testid="what-if-result">
          <strong>What-if: {whatIf.removed} dies</strong>
          <p>
            {whatIf.newlyIsolated.length === 0
              ? 'No other reachable node becomes isolated (redundant path).'
              : `Newly isolated: ${whatIf.newlyIsolated.join(', ')}`}
          </p>
          <p className="muted small">{whatIf.note}</p>
        </div>
      )}

      {expand && (
        <div className="callout" data-testid="expand-result">
          <strong>Expansion proposal</strong>
          <p>
            {expand.proposals.length} relay(s); reachable nodes {expand.beforeReachable} → {expand.afterReachable} (
            {expand.wouldExtendReach ? 'extends reach' : 'no new reach'}).
          </p>
          <ul className="small">
            {expand.proposals.map((p) => (
              <li key={p.id}>
                {p.id}: {p.position.x.toFixed(0)}, {p.position.y.toFixed(0)}, {p.position.z.toFixed(0)} m · {km(45_000)} hop
              </li>
            ))}
          </ul>
          <p className="muted small">{expand.note}</p>
        </div>
      )}
    </section>
  );
}
