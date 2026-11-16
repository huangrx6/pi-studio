import { useEffect, useRef, useState, type PointerEvent } from 'react';

const STORAGE_KEY = 'pi-studio:sidebar-width';

function readSidebarWidth() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function useSidebarWidth() {
  const [width, setWidth] = useState(readSidebarWidth);
  useEffect(() => {
    if (width === undefined) return;
    try { localStorage.setItem(STORAGE_KEY, String(width)); }
    catch { /* The layout can still be resized when storage is unavailable. */ }
  }, [width]);
  return [width, setWidth] as const;
}

type SidebarDrag = { pointerId: number; offset: number; min: number; max: number };

export function SidebarResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const drag = useRef<SidebarDrag | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add('is-sidebar-resizing');
    return () => document.body.classList.remove('is-sidebar-resizing');
  }, [resizing]);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const style = getComputedStyle(handle);
    drag.current = {
      offset: event.clientX - parseFloat(style.left),
      min: parseFloat(style.getPropertyValue('--sidebar-min-width')),
      max: parseFloat(style.getPropertyValue('--sidebar-max-width')),
      pointerId: event.pointerId,
    };
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const bounds = drag.current;
    if (!bounds || event.pointerId !== bounds.pointerId) return;
    const width = Math.round(event.clientX - bounds.offset);
    onResize(Math.min(bounds.max, Math.max(bounds.min, width)));
  }

  function finish() {
    drag.current = null;
    setResizing(false);
  }

  return <div
    className={`sidebar-resize-handle${resizing ? ' is-resizing' : ''}`}
    role="separator"
    aria-label="调整侧边栏宽度"
    aria-orientation="vertical"
    onPointerDown={start}
    onPointerMove={move}
    onLostPointerCapture={finish}
  />;
}
