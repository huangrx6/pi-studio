import { useRef, type PointerEvent, type ReactNode } from 'react';
import { errorText } from '../../shared/error-text';
import { useSettingsToast } from '../../shared/SettingsToast';
import type { ToolWindowDrag, ToolWindowDragHandle } from '../../types/tool-window';

const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export function ToolWindowFrame({ children }: { children: ReactNode }) {
  const active = useRef<{ id: number; handle: ToolWindowDragHandle }>();
  const toast = useSettingsToast();
  function send(phase: ToolWindowDrag['phase'], handle: ToolWindowDragHandle, event: PointerEvent) {
    void window.toolWindowApi.drag({ phase, handle, x: event.screenX, y: event.screenY })
      .catch(error => toast(errorText(error), 'error'));
  }
  function start(event: PointerEvent) {
    const target = event.target as HTMLElement;
    const grip = target.closest<HTMLElement>('[data-tool-drag]');
    if (!grip || active.current || event.button !== 0 || !event.isPrimary || target.closest('button, .tool-tab')) return;
    const handle = grip.dataset.toolDrag as ToolWindowDragHandle;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    active.current = { id: event.pointerId, handle };
    event.currentTarget.setAttribute('data-dragging', '');
    send('start', handle, event);
  }
  function update(phase: 'update' | 'end' | 'cancel', event: PointerEvent) {
    const current = active.current;
    if (!current || event.pointerId !== current.id) return;
    if (phase !== 'update') {
      active.current = undefined;
      event.currentTarget.removeAttribute('data-dragging');
    }
    send(phase, current.handle, event);
  }
  return <div className="tool-window-frame" onPointerDown={start}
    onPointerMove={event => update('update', event)} onPointerUp={event => update('end', event)}
    onPointerCancel={event => update('cancel', event)} onLostPointerCapture={event => update('cancel', event)}>
    <main className="tool-window" aria-label="工具面板">{children}</main>
    {edges.map(edge => <div key={edge} className="tool-resize-handle" data-tool-drag={edge} aria-hidden="true" />)}
  </div>;
}
