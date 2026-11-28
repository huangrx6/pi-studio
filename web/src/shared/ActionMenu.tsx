import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceActive } from './surface-visibility';
import { Check, ChevronLeft, ChevronRight, Trash2, type LucideIcon } from 'lucide-react';
import { PopoverSurface, popoverPortalTarget, scrollMovedAnchor } from './PopoverSurface';
import { isComposingKey, menuFocusIndex } from './keyboard-navigation';
export type MenuAction = {
  label: string; run: () => void; icon?: LucideIcon; destructive?: boolean; disabled?: boolean; checked?: boolean;
  id?: string; dividerBefore?: boolean; navigation?: 'forward' | 'back';
  iconUrl?: string; shortcut?: string[];
};
type MenuPosition =
  | { x: number; y: number; anchor?: HTMLElement; placement?: never }
  | { anchor: HTMLElement; placement: 'above' | 'below'; x?: never; y?: never };

export function ActionMenu({ x, y, items, align = 'start', anchor, placement, className = '', id, label, initialFocus, onClose }: MenuPosition & {
  align?: 'start' | 'end'; items: MenuAction[]; className?: string; id?: string; label?: string; initialFocus?: string; onClose: () => void;
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
    const openingRect = anchor?.getBoundingClientRect();
    function positionMenu() {
      const edge = 8;
      let left: number, top: number;
      if (placement) {
        const gap = 5;
        const rect = openingRect!;
        const above = Math.max(0, rect.top - gap - edge);
        const below = Math.max(0, innerHeight - rect.bottom - gap - edge);
        const preferAbove = placement === 'above';
        const fullHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
        const fits = fullHeight <= (preferAbove ? above : below);
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
    }
    positionMenu();
    const resize = placement ? new ResizeObserver(positionMenu) : null;
    resize?.observe(menu);
    const first = menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (menu.querySelector<HTMLButtonElement>('[data-initial-focus]:not(:disabled)') ?? first ?? menu).focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) { skipRestore.current = true; closeRef.current(); }
    };
    const close = () => closeRef.current();
    const onScroll = (event: Event) => {
      if (anchor && openingRect && scrollMovedAnchor(event, anchor, openingRect)) close();
    };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    if (anchor) document.addEventListener('scroll', onScroll, true);
    return () => {
      resize?.disconnect();
      document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close);
      if (anchor) document.removeEventListener('scroll', onScroll, true);
      const active = document.activeElement;
      if (!skipRestore.current && previous?.isConnected && (active === document.body || menu.contains(active))) previous.focus({ preventScroll: true });
    };
  }, [x, y, align, anchor, placement, active]);
  if (!active) return null;
  return createPortal(<PopoverSurface ref={ref} topLayer={portalTarget.matches('dialog, .settings-overlay')} id={id}
    className={`action-menu ${className}`.trim()} role="menu" aria-label={label ?? (anchor?.getAttribute('aria-label') || undefined)} tabIndex={-1} onKeyDown={event => {
    if (isComposingKey(event.nativeEvent)) return;
    const back = items.find(item => item.navigation === 'back');
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && back)) {
      event.preventDefault(); event.stopPropagation(); (back?.run ?? closeRef.current)(); return;
    }
    if (event.key === 'ArrowRight' && document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.navigation === 'forward') {
      event.preventDefault(); event.stopPropagation(); document.activeElement.click(); return;
    }
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
  }}>{items.map((item, index) => {
    const Icon = item.icon ?? (item.navigation === 'back' ? ChevronLeft : item.destructive ? Trash2 : null);
    return <Fragment key={item.id ?? item.label}>
      {item.dividerBefore && index > 0 && <div className="popover-divider" role="separator" />}
      <button type="button" className={item.destructive ? 'is-danger' : undefined} tabIndex={-1}
      role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled}
      data-navigation={item.navigation} aria-haspopup={item.navigation === 'forward' ? 'menu' : undefined}
      data-initial-focus={initialFocus && item.id === initialFocus ? true : undefined}
      onClick={() => { if (!item.navigation) closeRef.current(); item.run(); }}>
      {item.iconUrl ? <img src={item.iconUrl} alt="" /> : Icon && <Icon aria-hidden="true" />}<span>{item.label}</span>
      {item.shortcut && <kbd aria-hidden="true">{item.shortcut.join(' ')}</kbd>}
      {item.checked && <Check aria-hidden="true" />}
      {item.navigation === 'forward' && <ChevronRight aria-hidden="true" />}
    </button></Fragment>;
  })}</PopoverSurface>, portalTarget);
}
