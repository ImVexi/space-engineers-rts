export interface PickItem {
  id: string;
  label: string;
  meta?: string;
}

export interface PickListProps {
  /** stage-local px of the click */
  x: number;
  y: number;
  items: PickItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * Disambiguation list: shown when more than one ship is inside the pick radius.
 * Picking from this list is an explicit context entry (select + focus), so the
 * camera only moves on the deliberate second gesture.
 */
export function PickList({ x, y, items, onPick, onClose }: PickListProps) {
  return (
    <div
      className="pick-list"
      data-testid="pick-list"
      data-count={items.length}
      role="dialog"
      aria-label="Choose a ship"
      style={{ left: x, top: y }}
    >
      <header>
        <strong>{items.length} ships here</strong>
        <button type="button" onClick={onClose} aria-label="Close ship choices">✕</button>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" data-testid="pick-item" data-pick-id={item.id} onClick={() => onPick(item.id)}>
              <span className="pick-name">{item.label}</span>
              {item.meta && <span className="pick-meta">{item.meta}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
