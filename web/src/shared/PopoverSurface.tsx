import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './styles/settings-popover.css';

/** Keep portaled controls inside the owning modal's accessibility tree and palette. */
export function popoverPortalTarget(anchor: Element | null) {
  return anchor?.closest('dialog, .settings-overlay') ??
    anchor?.closest('[aria-modal="true"]')?.parentElement ?? document.body;
}

/** Shared surface for anchored menus and compact detail panels. Positioning stays with the caller. */
export const PopoverSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  heading?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  topLayer?: boolean;
}>(function PopoverSurface({ heading, onClose, closeLabel = '关闭', className = '', topLayer, children, ...props }, ref) {
  const surface = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => surface.current!, []);
  useLayoutEffect(() => {
    if (!topLayer) return;
    const panel = surface.current!;
    // Keep modal focus ownership while escaping animated containing blocks and overflow.
    panel.popover = 'manual';
    panel.showPopover();
    return () => {
      if (panel.matches(':popover-open')) panel.hidePopover();
      panel.removeAttribute('popover');
    };
  }, [topLayer]);
  return <div ref={surface} className={`popover-surface ${className}`} {...props}>
    {heading && <header className="popover-heading">
      <div className="popover-title">{heading}</div>
      {onClose && <button type="button" className="popover-close" aria-label={closeLabel} onClick={onClose}><X /></button>}
    </header>}
    {children}
  </div>;
});
