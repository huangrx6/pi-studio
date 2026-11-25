import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { OUTLINE } from './appearance';

export const SIDEBAR_BOUNDS = { minimum: 196, maximum: 420, initial: 244 } as const;

type Bounds = { minimum: number; maximum: number };

function usePaneResize(
  bounds: Bounds,
  width: number,
  onResize: (width: number) => void,
  direction: 1 | -1,
  reserveOtherPane: (overlayMatches: boolean) => number,
) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; current: number }>();
  const [preview, setPreview] = useState<number>();
  const [maximum, setMaximum] = useState(bounds.maximum);
  const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(bounds.minimum, value)));
  const visible = clamp(preview ?? width);

  useLayoutEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    const overlay = matchMedia('(max-width: 900px)');
    const update = () => setMaximum(Math.max(bounds.minimum,
      Math.min(bounds.maximum, Math.floor(container.clientWidth - reserveOtherPane(overlay.matches)))));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    overlay.addEventListener('change', update);
    return () => { observer.disconnect(); overlay.removeEventListener('change', update); };
  }, [bounds.maximum, bounds.minimum, reserveOtherPane]);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: visible, current: visible };
    setPreview(visible);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current.current = clamp(drag.current.width + (event.clientX - drag.current.x) * direction);
    setPreview(drag.current.current);
  }

  function finish(save: boolean) {
    if (!drag.current) return;
    const { current, width: starting } = drag.current;
    drag.current = undefined;
    setPreview(undefined);
    if (save && current !== starting) onResize(current);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next;
    if (event.key === 'ArrowLeft') next = visible - 16 * direction;
    else if (event.key === 'ArrowRight') next = visible + 16 * direction;
    else if (event.key === 'Home') next = bounds.minimum;
    else if (event.key === 'End') next = maximum;
    else return;
    event.preventDefault();
    onResize(clamp(next));
  }

  return {
    ref,
    visible,
    maximum,
    resizerProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': bounds.minimum,
      'aria-valuemax': maximum,
      'aria-valuenow': visible,
      tabIndex: 0,
      'data-dragging': preview !== undefined,
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: () => finish(true),
      onLostPointerCapture: () => finish(true),
      onPointerCancel: () => finish(false),
      onKeyDown,
    },
  };
}

export function ResizableOutline({ width, onResize, children }: { width: number; onResize: (width: number) => void; children: ReactNode }) {
  const { ref, visible, resizerProps } = usePaneResize(
    OUTLINE,
    width,
    onResize,
    -1,
    overlay => (overlay ? 36 : 286),
  );
  return <aside ref={ref} className="notes-pane notes-outline" aria-label="大纲与反向链接" style={{ width: visible }}>
    <div className="outline-resizer" aria-label="调整大纲宽度" title="拖动或用方向键调整大纲宽度" {...resizerProps} />
    {children}
  </aside>;
}

export function ResizableSidebar({ width, onResize, children }: { width: number; onResize: (width: number) => void; children: ReactNode }) {
  const { ref, visible, resizerProps } = usePaneResize(
    SIDEBAR_BOUNDS,
    width,
    onResize,
    1,
    () => 340,
  );
  return <aside ref={ref} className="notes-pane notes-sidebar" aria-label="笔记目录" style={{ width: visible }}>
    {children}
    <div className="sidebar-resizer" aria-label="调整目录宽度" title="拖动或用方向键调整目录宽度" {...resizerProps} />
  </aside>;
}
