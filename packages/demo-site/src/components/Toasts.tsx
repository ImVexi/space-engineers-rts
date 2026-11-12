export interface ToastItem {
  id: number;
  kind: 'ok' | 'err' | 'info';
  text: string;
  hint: string | null;
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" data-testid="toasts" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} data-testid="toast" data-kind={toast.kind}>
          <div>
            <p>{toast.text}</p>
            {toast.hint && <p className="hint">{toast.hint}</p>}
          </div>
          <button type="button" aria-label="Dismiss message" onClick={() => onDismiss(toast.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
