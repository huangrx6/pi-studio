import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const EDGE_TOLERANCE = 1;

type PanelTabScrollOptions = {
  activeId: string;
  tabs: readonly { id: string }[];
  resizing: boolean;
  split: boolean;
};

export function usePanelTabScroll({ activeId, tabs, resizing, split }: PanelTabScrollOptions) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;
  const tabCount = tabs.length;
  const activeIndex = tabs.findIndex(tab => tab.id === activeId);

  const revealTab = useCallback((tab: HTMLElement, behavior?: ScrollBehavior) => {
    const root = rootRef.current;
    if (!root) return;
    const viewport = root.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    const offset = bounds.left < viewport.left ? bounds.left - viewport.left : Math.max(0, bounds.right - viewport.right);
    if (Math.abs(offset) <= EDGE_TOLERANCE) return;
    const instant = resizingRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.scrollBy({ left: offset, behavior: behavior ?? (instant ? 'auto' : 'smooth') });
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;
    const navigation = root?.parentElement;
    if (!root || !track || !navigation) {
      setHasOverflow(false);
      return;
    }

    const updateEdges = () => {
      root.dataset.overflowStart = String(root.scrollLeft > EDGE_TOLERANCE);
      root.dataset.overflowEnd = String(root.scrollWidth - root.clientWidth - root.scrollLeft > EDGE_TOLERANCE);
    };
    let raf = 0;
    const measure = () => {
      raf = 0;
      // Measure against the space for the whole navigation, including the switcher itself.
      const overflow = tabCount > 1 && track.getBoundingClientRect().width > navigation.clientWidth + EDGE_TOLERANCE;
      setHasOverflow((current) => (current === overflow ? current : overflow));
      const active = track.querySelector<HTMLElement>('[aria-selected="true"]');
      if (active) revealTab(active, 'auto');
      updateEdges();
    };
    const scheduleMeasure = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || root.scrollWidth <= root.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      root.scrollLeft += event.deltaY;
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(navigation);
    observer.observe(track);
    observer.observe(root);
    root.addEventListener('scroll', updateEdges, { passive: true });
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      root.removeEventListener('scroll', updateEdges);
      root.removeEventListener('wheel', onWheel);
    };
  }, [tabCount, revealTab]);

  useLayoutEffect(() => {
    const active = trackRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active) revealTab(active);
  }, [activeId, activeIndex, split, revealTab]);

  return { rootRef, trackRef, hasOverflow, revealTab };
}
