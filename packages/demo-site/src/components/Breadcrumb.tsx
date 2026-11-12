import type { BreadcrumbItem } from '../lib/contextStack';

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  /** ship level only: toggle 'up = gravity' vs 'up = the ship' */
  upMode?: 'gravity' | 'ship';
  onUpMode?: () => void;
  /** one plain sentence about the active level (frame + pivot) */
  description: string;
  onJump: (index: number) => void;
  onUp: () => void;
  canUp: boolean;
}

/**
 * Where the camera is, as a clickable path: System > EarthLike > Group 1 >
 * SAT-L-0003. Every ancestor is one click away (and restores its own pose).
 */
export function Breadcrumb({ items, description, onJump, onUp, canUp, upMode, onUpMode }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb" data-testid="breadcrumb" data-depth={items.length} aria-label="Camera level">
      <div className="breadcrumb-path">
        {canUp && (
          <button type="button" className="crumb-up" data-testid="crumb-up" onClick={onUp} title="One level up (Esc)">
            ← Up
          </button>
        )}
        {items.map((item, index) => (
          <span key={item.key} className="crumb-wrap">
            {index > 0 && <i className="crumb-sep" aria-hidden="true">›</i>}
            <button
              type="button"
              className={`crumb kind-${item.kind}${item.current ? ' current' : ''}`}
              data-testid={`crumb-${index}`}
              data-kind={item.kind}
              data-key={item.key}
              aria-current={item.current ? 'true' : undefined}
              onClick={() => onJump(index)}
              title={item.current ? 'Current camera level' : `Back to ${item.label}`}
            >
              {item.label}
            </button>
          </span>
        ))}
      </div>
      <span className="breadcrumb-note" data-testid="breadcrumb-note">
        {description}
        {upMode && (
          <button
            type="button"
            className="up-mode"
            data-testid="up-mode-toggle"
            data-up-mode={upMode}
            onClick={onUpMode}
            title="Choose which way is up at this ship level"
          >
            Up: {upMode === 'ship' ? 'ship' : 'gravity'}
          </button>
        )}
      </span>
    </nav>
  );
}
