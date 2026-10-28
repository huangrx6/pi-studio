import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function DetailDialog({ children, onClose, className = '' }: { children: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="detail-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`detail-dialog ${className}`}>{children}</div>
    </div>,
    document.body,
  );
}
