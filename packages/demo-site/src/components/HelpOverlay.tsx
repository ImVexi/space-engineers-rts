export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Controls" data-testid="help-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Fly and act</h2>
          <button type="button" onClick={onClose} aria-label="Close help">
            ✕
          </button>
        </header>
        <div className="help-grid">
          <section>
            <h3>Camera</h3>
            <ul>
              <li><b>Left-drag</b> orbits the current level, level to its horizon</li>
              <li><b>Right-drag</b> pans · in <b>Fly mode</b> it looks in place (never orbits)</li>
              <li><b>Middle-drag</b> always orbits</li>
              <li><b>Wheel</b> zooms toward the cursor, 13 % per notch</li>
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> fly · <kbd>Q</kbd>/<kbd>E</kbd> (or <kbd>Ctrl</kbd>/<kbd>Space</kbd>) down / up</li>
              <li><kbd>Shift</kbd> faster · <kbd>Tab</kbd> toggles Fly / Orbit mode</li>
              <li>Breadcrumb: <b>System › planet › group › ship</b>. <kbd>Esc</kbd> steps out one level</li>
              <li><b>Double-click</b> a ship or planet, or press <kbd>F</kbd> / <b>Focus</b>, to enter that level</li>
            </ul>
          </section>
          <section>
            <h3>Act</h3>
            <ul>
              <li><b>Left-click</b> only selects — it never moves the camera</li>
              <li><b>Find ship</b> searches by name and flies there</li>
              <li><kbd>Shift</kbd>+click adds · <kbd>Shift</kbd>+left-drag a box selects many</li>
              <li><b>Right-click</b> a ship or the map for actions</li>
              <li><b>Move…</b> picks a destination, then shows reach, fuel and ETA</li>
              <li><b>Launch satellites</b> walks through sats, base, orbit, review</li>
              <li><kbd>?</kbd> this panel · <b>STOP ALL</b> is always visible</li>
            </ul>
          </section>
        </div>
        <p className="muted small">Test server only. Nothing here talks to production.</p>
      </div>
    </div>
  );
}
