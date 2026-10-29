import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { PopoverSurface } from './PopoverSurface';
export type MenuAction = { label: string; run: () => void; disabled?: boolean; checked?: boolean };
export function ActionMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x, y });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box = ref.current!.getBoundingClientRect();
    setPoint({ x: Math.max(8, Math.min(x, innerWidth-box.width-8)), y: Math.max(8, Math.min(y, innerHeight-box.height-8)) });
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const close = () => onClose();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [x, y, onClose]);
  return createPortal(<PopoverSurface ref={ref} className="action-menu" role="menu" style={{ left: point.x, top: point.y }} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (current+(event.key === 'ArrowDown' ? 1 : -1)+buttons.length)%buttons.length;
      buttons[index]?.focus();
    }
  }}>{items.map(item => <button key={item.label} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled} onClick={() => { onClose(); item.run(); }}><span>{item.label}</span>{item.checked && <Check />}</button>)}</PopoverSurface>, document.body);
}
