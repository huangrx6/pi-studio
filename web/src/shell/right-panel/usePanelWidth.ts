import { useCallback, useLayoutEffect, useState } from 'react';
import { maximumPanelWidth, MIN_PANEL_WIDTH, normalizePanelWidth } from './panel-width.mjs';

const STORAGE_KEY = 'pi-studio:panel-width';

/** Preserve the user's preferred width while temporarily clamping it to the current window. */
export function usePanelWidth(sidebarCollapsed: boolean) {
  const [preferred, setPreferred] = useState<number>(() => {
    try { return normalizePanelWidth(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { return normalizePanelWidth(null); }
  });
  const [maximum, setMaximum] = useState(() => maximumPanelWidth(window.innerWidth, 0));
  useLayoutEffect(() => {
    const sidebar = document.querySelector('.sidebar');
    const measure = () => {
      // Fullscreen temporarily hides the sidebar; its configured width still
      // applies when returning to the conversation after a window resize.
      const sidebarWidth = sidebarCollapsed ? 0 : sidebar ? Number.parseFloat(getComputedStyle(sidebar).width) || 0 : 0;
      setMaximum(maximumPanelWidth(window.innerWidth, sidebarWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sidebarCollapsed]);
  const resizePanel = useCallback((width: number) => {
    if (!Number.isFinite(width)) return;
    const next = Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(maximum, width)));
    setPreferred(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* The window remains usable if storage is unavailable. */ }
  }, [maximum]);
  return { panelWidth: Math.min(preferred, maximum), panelMaxWidth: maximum, resizePanel };
}
