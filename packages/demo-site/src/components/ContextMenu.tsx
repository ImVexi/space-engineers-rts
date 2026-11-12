import { useEffect, useRef } from 'react';
import type { ContextItem } from '../lib/actions';

export interface ContextMenuState {
  x: number;
  y: number;
  /** null = empty space / planet surface */
  shipId: string | null;
  title: string;
  subtitle: string | null;
  items: ContextItem[];
}

/** One small menu, clamped into the viewport. Esc / outside click closes it. */
export function ContextMenu({ menu, onPick, onClose }: { menu: ContextMenuState; onPick: (key: ContextItem['key']) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const width = 232;
  const height = 46 + menu.items.length * 42;
  const left = Math.min(menu.x, window.innerWidth - width - 8);
  const top = Math.min(menu.y, window.innerHeight - height - 8);

  return (
    <div
      ref={ref}
      className="context-menu"
      data-testid="context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top), width }}
    >
      <header className="context-head">
        <strong>{menu.title}</strong>
        {menu.subtitle && <span>{menu.subtitle}</span>}
      </header>
      {menu.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`ctx-${item.key}`}
          disabled={item.key === 'move-here' && menu.shipId === null && !menu.subtitle}
          onClick={() => onPick(item.key)}
          title={item.hint}
        >
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
