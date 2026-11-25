import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from './useModalDialog';
import './styles/detail-dialog.css';

/** Resource details share native modal focus/escape behavior with settings forms. */
export function DetailDialog({ children, onClose, className = '', label, dismissable = true }: {
  children: ReactNode | ((close: () => void) => ReactNode);
  onClose: () => void;
  className?: string;
  label?: string;
  dismissable?: boolean;
}) {
  const { dialogRef, onKeyDown, dismiss } = useModalDialog();
  const titleId = useId();
  const close = () => { if (dismissable) void dismiss(onClose); };

  useEffect(() => {
    if (label) return;
    const heading = dialogRef.current?.querySelector('h2, h1, h3');
    if (heading) {
      if (!heading.id) heading.id = titleId;
      dialogRef.current?.setAttribute('aria-labelledby', heading.id);
    }
  }, [dialogRef, label, titleId]);

  return createPortal(
    <dialog ref={dialogRef} className="detail-overlay native-dialog-motion" aria-label={label || '详情'} onKeyDown={onKeyDown}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className={`detail-dialog ${className}`}>{typeof children === 'function' ? children(close) : children}</div>
    </dialog>,
    document.body,
  );
}
