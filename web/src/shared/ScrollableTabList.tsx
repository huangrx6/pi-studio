import { useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import './styles/scrollable-tab-list.css';

export function TabActionsButton({ buttonRef, expanded, menuId, onOpen, onClose }: {
  buttonRef: Ref<HTMLButtonElement>; expanded: boolean; menuId: string;
  onOpen: (button: HTMLButtonElement) => void; onClose: () => void;
}) {
  return <button ref={buttonRef} type="button" className="icon-button tab-actions-button"
    title="标签页操作" aria-label="标签页操作" aria-haspopup="menu" aria-expanded={expanded}
    aria-controls={expanded ? menuId : undefined}
    onClick={event => expanded ? onClose() : onOpen(event.currentTarget)}
    onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); onOpen(event.currentTarget); } }}>
    <ChevronDown/>
  </button>;
}

export function ScrollableTabList({ activeId, children, className, label, role = 'tablist', visible = true, onKeyDown }: {
  activeId?: string; children: ReactNode; className: string; label: string;
  role?: 'navigation' | 'tablist'; visible?: boolean; onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const strip = stripRef.current, list = listRef.current;
    if (!visible || !strip || !list) return;
    const measure = () => {
      // Both arrows disappear as soon as the tabs fit in the full strip.
      const overflows = list.scrollWidth > strip.clientWidth + 1;
      const left = overflows && list.scrollLeft > 1;
      const right = overflows && list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const resize = new ResizeObserver(measure);
    const observeTabs = () => {
      resize.disconnect();
      resize.observe(strip);
      resize.observe(list);
      for (const tab of list.children) resize.observe(tab);
      measure();
    };
    observeTabs();
    const mutations = new MutationObserver(observeTabs);
    mutations.observe(list, { childList: true });
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const limit = list.scrollWidth - list.clientWidth;
      if (event.deltaY < 0 ? list.scrollLeft <= 0 : list.scrollLeft >= limit) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      event.preventDefault();
      list.scrollBy({ left: event.deltaY * unit, behavior: 'instant' });
    };
    list.addEventListener('wheel', wheel, { passive: false });
    list.addEventListener('scroll', measure);
    return () => {
      mutations.disconnect();
      resize.disconnect();
      list.removeEventListener('wheel', wheel);
      list.removeEventListener('scroll', measure);
    };
  }, [visible]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const slot = list?.querySelector(':scope > [data-current-tab]');
    if (!visible || !list || !slot) return;
    const reveal = () => {
      const bounds = list.getBoundingClientRect(), tab = slot.getBoundingClientRect();
      const style = getComputedStyle(list);
      const delta = Math.min(0, tab.left - bounds.left - parseFloat(style.paddingLeft))
        || Math.max(0, tab.right - bounds.right + parseFloat(style.paddingRight));
      if (Math.abs(delta) >= 1) list.scrollBy({ left: delta });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(slot);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, visible]);

  const scrollPage = (direction: number) => {
    const list = listRef.current;
    if (list) list.scrollBy({ left: direction * list.clientWidth * 0.8 });
  };
  const overflowing = edges.left || edges.right;
  return <div ref={stripRef} className="scrollable-tab-strip">
    {overflowing && <button type="button" className="icon-button tab-scroll-arrow" title="向左滚动标签页"
      disabled={!edges.left} onClick={() => scrollPage(-1)}><ChevronLeft/></button>}
    <div ref={listRef} className={'scrollable-tab-list ' + className} role={role} aria-label={label}
      onKeyDown={onKeyDown}>{children}</div>
    {overflowing && <button type="button" className="icon-button tab-scroll-arrow" title="向右滚动标签页"
      disabled={!edges.right} onClick={() => scrollPage(1)}><ChevronRight/></button>}
  </div>;
}
