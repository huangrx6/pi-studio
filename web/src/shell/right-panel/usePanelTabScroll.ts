import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const EDGE_TOLERANCE = 1;
const MIN_TAB_WIDTH = 96;
const MAX_TAB_WIDTH = 140;

type PanelTabScrollOptions = {
  activeId: string;
  tabCount: number;
  resizing: boolean;
  split: boolean;
};

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keeps the active tab readable while retaining a meaningful slice of its
 * neighbour. The neighbour is context: showing only a tab's empty tail makes
 * the overflow look like a layout hole instead of another selectable tab.
 */
export function usePanelTabScroll({ activeId, tabCount, resizing, split }: PanelTabScrollOptions) {
  const rootRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;

  const updateMetrics = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const maxScroll = Math.max(0, root.scrollWidth - root.clientWidth);
    root.dataset.overflowStart = String(maxScroll > EDGE_TOLERANCE && root.scrollLeft > EDGE_TOLERANCE);
    root.dataset.overflowEnd = String(maxScroll > EDGE_TOLERANCE && root.scrollLeft < maxScroll - EDGE_TOLERANCE);

    const visibleTabs = Math.max(1, Math.min(2, tabCount));
    const proposed = Math.floor((root.clientWidth - Math.max(0, visibleTabs - 1) * 2) / visibleTabs);
    const width = Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, proposed));
    root.style.setProperty('--panel-tab-width', `${width}px`);
  }, [tabCount]);

  const revealTab = useCallback((tab: HTMLElement, behavior?: ScrollBehavior) => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const left = tabRect.left - rootRect.left + root.scrollLeft;
    const right = left + tabRect.width;
    const nextBehavior = behavior ?? (resizingRef.current || reducedMotion() ? 'auto' : 'smooth');

    if (left < root.scrollLeft) {
      root.scrollTo({ left, behavior: nextBehavior });
      return;
    }
    if (right > root.scrollLeft + root.clientWidth) {
      const availableContext = Math.max(0, root.clientWidth - tabRect.width);
      const leadingContext = Math.min(88, availableContext);
      root.scrollTo({ left: Math.max(0, left - leadingContext), behavior: nextBehavior });
    }
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !activeId) return;
    const active = root.querySelector<HTMLElement>('.panel-tab.is-active');
    if (active) revealTab(active);
  }, [activeId, revealTab, split, tabCount]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateMetrics();
        const active = root.querySelector<HTMLElement>('.panel-tab.is-active');
        // A ResizeObserver callback may run just after pointer-up, when the
        // React resizing flag is already false. Size changes still need an
        // immediate correction so the active tab cannot be clipped.
        if (active) revealTab(active, 'auto');
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('scroll', schedule);
    };
  }, [revealTab, updateMetrics]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if (root.scrollWidth <= root.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      root.scrollLeft += event.deltaY;
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [tabCount]);

  return { rootRef, revealTab };
}
