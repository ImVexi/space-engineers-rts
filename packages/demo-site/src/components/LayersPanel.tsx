import { useMemo, useState } from 'react';
import type { Planet } from '../types';
import type { Overlays } from './Scene';
import { LINK_MODES, countChip, filterLinks, linkHoverText, type LinkMode, type LinksResponse } from '../lib/links';
import { coverageColor, coveragePct } from '../lib/coverage';
import type { CoverageDatum } from './CoverageLayer';

interface LayersPanelProps {
  planets: Planet[];
  overlays: Overlays;
  onOverlays: (next: Overlays) => void;
  linksMode: LinkMode;
  onLinksMode: (mode: LinkMode) => void;
  links: LinksResponse | null;
  linksAvailable: 'checking' | 'ok' | 'missing';
  coveragePlanet: string;
  onCoveragePlanet: (planet: string) => void;
  coverageData: CoverageDatum | null;
  coverageAvailable: 'checking' | 'ok' | 'missing';
  /** non-null when the heatmap is approximate (no terrain) — T51.10 honesty */
  coverageApproximate: string | null;
  names: Record<string, string>;
  onClose: () => void;
}

/**
 * One home for the two new map layers (CONTRACT §1 + T44). Four link modes,
 * one coverage switch and its planet. Everything read-only is a legend, so the
 * visible control count stays small.
 */
export function LayersPanel({
  planets,
  overlays,
  onOverlays,
  linksMode,
  onLinksMode,
  links,
  linksAvailable,
  coveragePlanet,
  onCoveragePlanet,
  coverageData,
  coverageAvailable,
  coverageApproximate,
  names,
  onClose,
}: LayersPanelProps) {
  const [hover, setHover] = useState<string | null>(null);
  const shown = useMemo(() => filterLinks(links, linksMode), [links, linksMode]);
  const pct = coverageData && coverageData.planet === coveragePlanet ? coveragePct(coverageData.response.cells ?? [], coverageData.response.k ?? 1) : null;

  function label(id: string): string {
    return names[id] ?? id.replace(/^grid:/, '').slice(0, 14);
  }

  return (
    <aside className="sheet layers-panel" data-testid="layers-panel" aria-label="Map layers">
      <header className="sheet-head">
        <h2>Layers</h2>
        <button type="button" onClick={onClose} aria-label="Close layers" data-testid="layers-close">
          ✕
        </button>
      </header>

      <section className="layer-section" data-testid="links-section">
        <div className="layer-head">
          <h3>Links</h3>
          <span className="chip count-chip" data-testid="link-count">
            {countChip(links)}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Link layer">
          {LINK_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={linksMode === mode.value ? 'active' : ''}
              aria-pressed={linksMode === mode.value}
              title={mode.hint}
              data-testid={`link-mode-${mode.value}`}
              onClick={() => onLinksMode(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {linksAvailable === 'missing' ? (
          <p className="soon-note" data-testid="links-coming-soon">
            Current vs possible links is coming soon — the backend route is not deployed yet. No link lines are drawn rather
            than guessing from planner maths.
          </p>
        ) : (
          <>
            <div className="legend-row" data-testid="links-legend">
              <span>
                <i className="swatch live" /> current · GAME (measured)
              </span>
              <span>
                <i className="swatch dashed" /> current · SIMULATED (planner)
              </span>
              <span>
                <i className="swatch possible" /> possible (SIMULATED)
              </span>
              <span>
                <i className="swatch laser" /> laser
              </span>
            </div>
            {linksMode !== 'off' && (
              <ul className="link-list" data-testid="link-list">
                {shown.current.slice(0, 5).map((l) => {
                  const text = linkHoverText(l);
                  return (
                    <li key={`c-${l.a}-${l.b}-${l.kind}`} onMouseEnter={() => setHover(text)} onMouseLeave={() => setHover(null)}>
                      <span className="link-kind">{l.kind === 'laser' ? 'L' : 'R'}</span>
                      {label(l.a)} ↔ {label(l.b)}
                      <span className="link-tag game">{l.label}</span>
                    </li>
                  );
                })}
                {shown.possible.slice(0, 5).map((l) => {
                  const text = linkHoverText(l);
                  return (
                    <li
                      key={`p-${l.a}-${l.b}-${l.kind}`}
                      className="possible"
                      onMouseEnter={() => setHover(text)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span className="link-kind">{l.kind === 'laser' ? 'L' : 'R'}</span>
                      {label(l.a)} ↔ {label(l.b)}
                      <span className="link-tag sim">SIM</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="link-hover" data-testid="link-hover">
              {hover ?? 'Hover a link for kind, length and GAME / SIMULATED.'}
            </p>
          </>
        )}
      </section>

      <section className="layer-section" data-testid="coverage-section">
        <div className="layer-head">
          <h3>Coverage</h3>
          {pct !== null && (
            <span className="chip count-chip" data-testid="coverage-pct">
              {pct}% covered
            </span>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={overlays.coverage}
            data-testid="coverage-toggle"
            onChange={(e) => onOverlays({ ...overlays, coverage: e.target.checked })}
          />
          Coverage heatmap
        </label>
        {overlays.coverage && (
          <label className="coverage-planet">
            Planet
            <select value={coveragePlanet} data-testid="coverage-planet" onChange={(e) => onCoveragePlanet(e.target.value)}>
              {planets.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {coverageAvailable === 'missing' ? (
          <p className="soon-note" data-testid="coverage-coming-soon">
            Coverage is coming soon — the planner route is not answering. No cells were invented.
          </p>
        ) : (
          <>
            <div className="legend-row" data-testid="coverage-legend">
              <span>
                <i className="swatch" style={{ background: coverageColor(0) }} /> 0 uncovered
              </span>
              <span>
                <i className="swatch" style={{ background: coverageColor(1) }} /> 1 relay
              </span>
              <span>
                <i className="swatch" style={{ background: coverageColor(2) }} /> 2+ relays
              </span>
              {/* T51.10: the grid is planner output until the plugin reports the live one. */}
              <span className="chip" data-testid="coverage-source">
                SIMULATED
              </span>
            </div>
            {coverageApproximate && (
              <p className="soon-note" role="status" data-testid="coverage-approximate">
                {coverageApproximate}
              </p>
            )}
          </>
        )}
        {overlays.coverage && coverageData && (
          <p className="muted small">Click a red cell for why it is uncovered and a prefilled fix.</p>
        )}
      </section>
    </aside>
  );
}
