import { useMemo, useState } from 'react';

export interface ShipSearchRow {
  id: string;
  name: string;
  /** short state words, e.g. "holding · 12 km" */
  meta: string;
  planet: string | null;
  /** Ship role (owner decision 2026-11-11). */
  role?: 'managed' | 'personal' | 'base' | 'off';
}

export interface ShipSearchPanelProps {
  rows: ShipSearchRow[];
  /** select AND focus (an explicit list pick, per the context rules) */
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * Searchable ship list. One search box, one list: typing filters by name (and
 * planet), Enter picks the first match, a row click selects + focuses. This is
 * the reliable alternative to hunting a 3-pixel dot on the globe.
 */
export function ShipSearchPanel({ rows, onPick, onClose }: ShipSearchPanelProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(needle) || (row.planet ?? '').toLowerCase().includes(needle));
  }, [rows, needle]);
  const shown = matches.slice(0, 80);
  return (
    <aside className="sheet ship-finder" data-testid="ship-finder" aria-label="Find a ship">
      <header className="sheet-head">
        <h2>Find a ship</h2>
        <button type="button" onClick={onClose} aria-label="Close ship finder">✕</button>
      </header>
      <input
        type="search"
        className="ship-finder-input"
        data-testid="ship-finder-input"
        placeholder="Type a name, e.g. SAT-L"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown[0]) {
            event.preventDefault();
            onPick(shown[0].id);
          }
        }}
      />
      <p className="ship-finder-count" data-testid="ship-finder-count">
        {matches.length === rows.length ? `${rows.length} ships` : `${matches.length} of ${rows.length} match`}
      </p>
      <ul className="ship-finder-list">
        {shown.map((row) => (
          <li key={row.id}>
            <button type="button" data-testid="ship-finder-row" data-ship-id={row.id} onClick={() => onPick(row.id)}>
              <span className="ship-finder-name">
                {row.name}
                {row.role && row.role !== 'managed' && (
                  <span className={`badge role-badge role-${row.role}`} data-testid="ship-role-badge">
                    {row.role.toUpperCase()}
                  </span>
                )}
              </span>
              <span className="ship-finder-meta">{row.meta}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="ship-finder-empty">Nothing matches “{query}”.</li>}
      </ul>
    </aside>
  );
}
