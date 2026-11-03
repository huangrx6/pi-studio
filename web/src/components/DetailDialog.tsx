import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from './useModalDialog';

/** Resource details share native modal focus/escape behavior with settings forms. */
export function DetailDialog({ children, onClose, className = '' }: { children: ReactNode; onClose: () => void; className?: string }) {
  const { dialogRef, onKeyDown } = useModalDialog();
  const titleId = useId();

  useEffect(() => {
    const heading = dialogRef.current?.querySelector('h2, h1, h3');
    if (heading) {
      if (!heading.id) heading.id = titleId;
      dialogRef.current?.setAttribute('aria-labelledby', heading.id);
    }
  }, [dialogRef, titleId]);

  return createPortal(
    <dialog ref={dialogRef} className="detail-overlay" aria-label="详情" onKeyDown={onKeyDown}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`detail-dialog ${className}`}>{children}</div>
    </dialog>,
    document.body,
  );
}
