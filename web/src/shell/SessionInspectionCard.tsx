import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Maximize2, Minimize2, X } from 'lucide-react';
import {
  dragInspectionBounds, inspectionResizeEdges, minimumInspectionSize, type CardBounds, type CardPosition, type Inspection, type InspectionHandle,
} from './session-inspection';
import './styles/session-inspection.css';

type Drag = { id: number; x: number; y: number; handle: InspectionHandle; start: CardBounds; target: HTMLElement };
const origin = { right: 0, top: 0 };

export function SessionInspectionCard({ view, title, summary, detail, toggleRef, onChange, onClose, children }: {
  view: Inspection; title: string; summary: string; detail: string;
  toggleRef: RefObject<HTMLButtonElement>;
  onChange: (next: Partial<Inspection>) => void; onClose: () => void; children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const labelId = useId();
  const drag = useRef<Drag>();
  const [preview, setPreview] = useState<{ bounds: CardBounds; resizing: boolean }>();
  const [limits, setLimits] = useState<CardPosition>(origin);
  useLayoutEffect(() => {
    const container = stage.current!, panel = card.current!;
    const measure = () => {
      const area = container.getBoundingClientRect(), rect = panel.getBoundingClientRect();
      const right = Math.max(0, area.width - rect.width), top = Math.max(0, area.height - rect.height);
      setLimits(old => old.right === right && old.top === top ? old : { right, top });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
  const expanded = view.mode === 'expanded';
  const maximized = expanded && view.maximized === true;
  useLayoutEffect(() => {
    if (drag.current) cancelDrag();
  }, [expanded, maximized]);
  const size = expanded ? (preview?.resizing ? preview.bounds : view.size) : undefined;
  const preferred = view.position ?? origin;
  const offset = maximized ? origin : preview?.bounds ?? {
    right: Math.max(0, Math.min(preferred.right, limits.right)), top: Math.max(0, Math.min(preferred.top, limits.top)),
  };
  const maximizeLabel = maximized ? '还原会话详情大小' : '放大会话详情';
  const dimensions = size && !maximized ? {
    width: Math.max(minimumInspectionSize.width, size.width), height: Math.max(minimumInspectionSize.height, size.height),
  } : undefined;

  function currentBounds(): CardBounds {
    const area = stage.current!.getBoundingClientRect(), rect = card.current!.getBoundingClientRect();
    return { right: area.right - rect.right, top: rect.top - area.top, width: rect.width, height: rect.height };
  }
  function saveBounds(handle: InspectionHandle, start: CardBounds, end: CardBounds) {
    if (end.right === start.right && end.top === start.top && end.width === start.width && end.height === start.height) return;
    const position = {
      right: end.right === start.right ? preferred.right : end.right,
      top: end.top === start.top ? preferred.top : end.top,
    };
    if (handle === 'move') {
      onChange({ position });
      return;
    }
    onChange({ position, size: {
      width: end.width === start.width ? view.size?.width ?? end.width : end.width,
      height: end.height === start.height ? view.size?.height ?? end.height : end.height,
    } });
  }
  function startDrag(event: PointerEvent<HTMLElement>, handle: InspectionHandle) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, handle, x: event.clientX, y: event.clientY, start: currentBounds(), target: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function dragTo(from: Drag, event: PointerEvent<HTMLElement>) {
    return dragInspectionBounds(from.start, stage.current!.getBoundingClientRect(), from.handle, event.clientX - from.x, event.clientY - from.y);
  }
  function cancelDrag() {
    const from = drag.current;
    drag.current = undefined;
    setPreview(undefined);
    if (from?.target.hasPointerCapture(from.id)) from.target.releasePointerCapture(from.id);
  }
  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id === event.pointerId) cancelDrag();
  }
  function arrowKey(event: KeyboardEvent<HTMLElement>, handle: InspectionHandle) {
    const step = event.shiftKey ? 32 : 8;
    const deltas: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const start = currentBounds();
    saveBounds(handle, start, dragInspectionBounds(start, stage.current!.getBoundingClientRect(), handle, ...delta));
  }
  function collapse() {
    onChange({ mode: 'compact' });
    toggleRef.current?.focus({ preventScroll: true });
  }
  return <div ref={stage} className="inspection-stage">
    <aside ref={card} className="inspection-card" data-mode={view.mode} aria-label="会话详情"
      data-maximized={maximized || undefined} data-sized={Boolean(size) || undefined}
      style={{ right: offset.right, top: offset.top, ...dimensions }}
      onPointerMove={event => {
        const from = drag.current;
        if (from?.id === event.pointerId) setPreview({ bounds: dragTo(from, event), resizing: from.handle !== 'move' });
      }}
      onPointerUp={event => {
        const from = drag.current;
        if (from?.id !== event.pointerId) return;
        saveBounds(from.handle, from.start, dragTo(from, event));
        endDrag(event);
      }}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={event => {
        if (event.key === 'Escape' && (expanded || drag.current) && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation();
          if (drag.current) cancelDrag();
          else if (maximized) onChange({ maximized: false });
          else collapse();
        }
      }}>
      <div className="inspection-content">
        <div className="inspection-bar">
          {!maximized && <button type="button" className="inspection-grip" aria-label="移动会话浮卡" title="拖动或用方向键移动"
            onPointerDown={event => startDrag(event, 'move')} onKeyDown={event => arrowKey(event, 'move')}><GripVertical aria-hidden="true" /></button>}
          <button ref={toggleRef} type="button" className="inspection-toggle"
            aria-expanded={expanded} aria-label={expanded ? '收起会话详情' : '展开会话详情'}
            aria-describedby={labelId}
            title={expanded ? '收起会话详情' : [summary, detail].filter(Boolean).join(' · ')}
            onClick={() => expanded ? collapse() : onChange({ mode: 'expanded' })}>
            <strong id={labelId}>{expanded ? title : summary}</strong>
            {!expanded && detail && <small aria-live="polite">{detail}</small>}
            {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
          {expanded && <button type="button" title={maximizeLabel} aria-label={maximizeLabel} aria-pressed={maximized}
            onClick={() => onChange({ maximized: !maximized })}>
            {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>}
          <button type="button" className="inspection-close" title="关闭会话详情" aria-label="关闭会话详情"
            onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        {expanded && children}
      </div>
      {expanded && !maximized && inspectionResizeEdges.map(edge => edge === 'sw'
        ? <button key={edge} type="button" className="inspection-resize" data-edge={edge} aria-label="调整会话浮卡大小"
            title="拖动此角或用方向键调整大小" onPointerDown={event => startDrag(event, edge)} onKeyDown={event => arrowKey(event, edge)} />
        : <div key={edge} className="inspection-resize" data-edge={edge} aria-hidden="true" onPointerDown={event => startDrag(event, edge)} />)}
    </aside>
  </div>;
}
