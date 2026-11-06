import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { PopoverSurface } from './PopoverSurface';
import { isComposingKey, menuFocusIndex } from './keyboard-navigation';
export type MenuAction = { label: string; run: () => void; disabled?: boolean; checked?: boolean };
export function ActionMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const previousRef = useRef<HTMLElement | null>(null);
  const skipRestore = useRef(false);
  const [portalTarget] = useState(() => document.activeElement?.closest('dialog') ?? document.body);
  const [point, setPoint] = useState({ x, y });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    previousRef.current = previous;
    const menu = ref.current!;
    const box = menu.getBoundingClientRect();
    setPoint({ x: Math.max(8, Math.min(x, innerWidth - box.width - 8)), y: Math.max(8, Math.min(y, innerHeight - box.height - 8)) });
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) { skipRestore.current = true; closeRef.current(); }
    };
    const close = () => closeRef.current();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close);
      const active = document.activeElement;
      if (!skipRestore.current && previous?.isConnected && (active === document.body || menu.contains(active))) previous.focus({ preventScroll: true });
    };
  }, [x, y]);
  return createPortal(<PopoverSurface ref={ref} className="action-menu" role="menu" tabIndex={-1} style={{ left: point.x, top: point.y }} onKeyDown={event => {
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
  }}>{items.map(item => <button type="button" key={item.label} tabIndex={-1} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled} onClick={() => { closeRef.current(); item.run(); }}><span>{item.label}</span>{item.checked && <Check />}</button>)}</PopoverSurface>, portalTarget);
}
