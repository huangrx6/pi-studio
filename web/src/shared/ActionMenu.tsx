import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceActive } from './surface-visibility';
import { Check, Trash2, type LucideIcon } from 'lucide-react';
import { PopoverSurface, popoverPortalTarget } from './PopoverSurface';
import { isComposingKey, menuFocusIndex } from './keyboard-navigation';
export type MenuAction = { label: string; icon?: LucideIcon; destructive?: boolean; run: () => void; disabled?: boolean; checked?: boolean };
type MenuPosition =
  | { x: number; y: number; anchor?: HTMLElement; placement?: never }
  | { anchor: HTMLElement; placement: 'above' | 'below'; x?: never; y?: never };

export function ActionMenu({ x, y, items, align = 'start', anchor, placement, className = '', id, onClose }: MenuPosition & {
  align?: 'start' | 'end'; items: MenuAction[]; className?: string; id?: string; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useSurfaceActive();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const previousRef = useRef<HTMLElement | null>(null);
  const skipRestore = useRef(false);
  const [portalTarget] = useState(() => popoverPortalTarget(anchor ?? document.activeElement));
  useLayoutEffect(() => { if (!active) closeRef.current(); }, [active]);
  useLayoutEffect(() => {
    if (!active) return;
    const previous = anchor ?? (document.activeElement as HTMLElement | null);
    previousRef.current = previous;
    const menu = ref.current!;
    menu.style.removeProperty('max-height');
    const edge = 8;
    let left: number, top: number;
    if (placement) {
      const gap = 5;
      const rect = anchor.getBoundingClientRect();
      const above = Math.max(0, rect.top - gap - edge);
      const below = Math.max(0, innerHeight - rect.bottom - gap - edge);
      const preferAbove = placement === 'above';
      const fits = menu.offsetHeight <= (preferAbove ? above : below);
      const showAbove = fits ? preferAbove : above >= below;
      menu.style.maxHeight = (showAbove ? above : below) + 'px';
      left = align === 'end' ? rect.right - menu.offsetWidth : rect.left;
      top = showAbove ? rect.top - gap - menu.offsetHeight : rect.bottom + gap;
    } else {
      left = align === 'end' ? x - menu.offsetWidth : x;
      top = y;
    }
    menu.style.left = Math.max(edge, Math.min(left, innerWidth - menu.offsetWidth - edge)) + 'px';
    menu.style.top = Math.max(edge, Math.min(top, innerHeight - menu.offsetHeight - edge)) + 'px';
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) { skipRestore.current = true; closeRef.current(); }
    };
    const close = () => closeRef.current();
    const onScroll = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    if (anchor) document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close);
      if (anchor) document.removeEventListener('scroll', onScroll, true);
      const active = document.activeElement;
      if (!skipRestore.current && previous?.isConnected && (active === document.body || menu.contains(active))) previous.focus({ preventScroll: true });
    };
  }, [x, y, align, anchor, placement, active]);
  if (!active) return null;
  return createPortal(<PopoverSurface ref={ref} topLayer={portalTarget.matches('dialog, .settings-overlay')} id={id}
    className={`action-menu ${className}`.trim()} role="menu" aria-label={anchor?.getAttribute('aria-label') || undefined} tabIndex={-1} onKeyDown={event => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
    if (event.key === 'Tab') {
      // Return to the opener before the native default moves to its logical neighbour.
      previousRef.current?.focus({ preventScroll: true });
      skipRestore.current = true;
      closeRef.current();
      return;
    }
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const next = menuFocusIndex(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, true);
    if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
  }}>{items.map(item => {
    const Icon = item.icon ?? (item.destructive ? Trash2 : null);
    return <button type="button" key={item.label} className={item.destructive ? 'is-danger' : undefined} tabIndex={-1}
      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled}
      onClick={() => { closeRef.current(); item.run(); }}>
      {Icon && <Icon aria-hidden="true" />}<span>{item.label}</span>{item.checked && <Check aria-hidden="true" />}
    </button>;
  })}</PopoverSurface>, portalTarget);
}
