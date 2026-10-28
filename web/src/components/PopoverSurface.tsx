import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Shared surface for anchored menus and compact detail panels. Positioning stays with the caller. */
export const PopoverSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  heading?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}>(function PopoverSurface({ heading, onClose, closeLabel = '关闭', className = '', children, ...props }, ref) {
  return <div ref={ref} className={`popover-surface ${className}`} {...props}>
    {heading && <header className="popover-heading">
      <div className="popover-title">{heading}</div>
      {onClose && <button type="button" className="popover-close" aria-label={closeLabel} onClick={onClose}><X /></button>}
    </header>}
    {children}
  </div>;
});
