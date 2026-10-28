/**
 * 扩展 UI 的通用桌面槽位。
 *
 * 这里不认识任何具体扩展：widget、custom 浮层、状态和输入框都来自
 * Pi 的 `ctx.ui` 原语；组件只负责摆放、字符单元渲染和输入坐标回传。
 * 扩展在终端里画什么，这里就显示什么；终端与桌面共用同一份组件代码。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FooterCell } from './ExtensionFooter';

type Widget = {
  key: string;
  placement: 'aboveEditor' | 'belowEditor';
  lines: FooterCell[][];
};

type CustomPanel = {
  id: string;
  overlay: boolean;
  interactive: boolean;
  lines: FooterCell[][];
  rowTypes?: Array<'text' | 'rule'>;
  title?: string;
  close?: { row: number; col: number } | null;
  offset?: { row: number; col: number } | null;
};

type DialogRequest = {
  id: string;
  kind: 'input' | 'editor';
  title: string;
  placeholder?: string;
  prefill?: string;
};

const CELL = 7.2;
const LINE = 20;
const TONES = new Set(['text', 'muted', 'faint', 'dim', 'accent', 'error', 'warning', 'success', 'info', 'link']);

function cellClass(cell: FooterCell): string | undefined {
  const tone = cell.tone && TONES.has(cell.tone) ? `tone-${cell.tone}` : '';
  return [tone, cell.bold ? 'is-bold' : ''].filter(Boolean).join(' ') || undefined;
}

/** 把字符单元画成等宽行；尺寸与扩展的终端坐标系一致，点击换算才能对齐。 */
function SurfaceRows({ lines, rowTypes, cell = CELL, line = LINE, onPointer }: {
  lines: FooterCell[][];
  rowTypes?: Array<'text' | 'rule'>;
  cell?: number;
  line?: number;
  onPointer?: (event: React.MouseEvent | React.WheelEvent) => void;
}) {
  return <div className="extension-surface-rows" onMouseDown={onPointer} onWheel={onPointer}>
    {lines.map((row, index) => rowTypes?.[index] === 'rule'
      ? <div className="extension-terminal-rule" key={index} style={{ height: line }}><span /></div>
      : <div className="extension-terminal-row" key={index} style={{ minHeight: line }}>
        {row.map((item, column) => <span key={column} className={cellClass(item)} style={{ width: item.width * cell }}>{item.text}</span>)}
      </div>)}
  </div>;
}

/** 坐标换算：像素 → 字符单元格；浮层要补回扩展卡片外框的偏移。 */
function pointOf(event: React.MouseEvent | React.WheelEvent, offset?: { row: number; col: number } | null) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.floor((event.clientX - bounds.left) / CELL)) + (offset?.col || 0),
    y: Math.max(0, Math.floor((event.clientY - bounds.top) / LINE)) + (offset?.row || 0),
  };
}

/** 输入框上方的扩展状态条（setStatus）。 */
export function ExtensionStatusBar({ sessionId }: { sessionId: string }) {
  const [statuses, setStatuses] = useState<Array<[string, string]>>([]);
  useEffect(() => {
    let disposed = false;
    void window.piApi.extensionState(sessionId).then((state) => {
      if (!disposed && state?.statuses) setStatuses(state.statuses);
    }).catch(() => { /* 扩展未绑定 */ });
    const off = window.piApi.onExtensionStatus?.((event) => {
      if (event.sessionId !== sessionId) return;
      setStatuses((current) => {
        const next = new Map(current);
        if (!event.text) next.delete(event.key);
        else next.set(event.key, event.text);
        return [...next];
      });
    }) ?? (() => {});
    return () => { disposed = true; off(); };
  }, [sessionId]);
  if (statuses.length === 0) return null;
  return <div className="extension-statusbar" aria-label="扩展状态">
    {statuses.map(([key, text]) => <span className="extension-status-chip" key={key} title={key}>{text || key}</span>)}
  </div>;
}

/** setWidget：按 placement 放在输入框上方或下方。 */
export function ExtensionWidgets({ sessionId, placement }: { sessionId: string; placement: 'aboveEditor' | 'belowEditor' }) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastColumns = useRef(0);
  useEffect(() => {
    let disposed = false;
    void window.piApi.extensionState(sessionId).then((state) => {
      if (!disposed && state?.widgets) setWidgets(state.widgets);
    }).catch(() => { /* 扩展未绑定 */ });
    const off = window.piApi.onExtensionWidgets?.((event) => {
      if (event.sessionId === sessionId) setWidgets(event.widgets || []);
    }) ?? (() => {});
    return () => { disposed = true; off(); };
  }, [sessionId]);
  const visible = widgets.filter((widget) => widget.placement === placement);

  // 组件型 widget 需要按实际宽度重排；字符串 widget 的 resize 会被宿主忽略。
  useEffect(() => {
    const node = rootRef.current;
    if (!node || visible.length === 0) return;
    const resize = () => {
      const columns = Math.max(20, Math.floor((node.clientWidth - 20) / CELL));
      if (columns === lastColumns.current) return;
      lastColumns.current = columns;
      const appearance = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      for (const widget of visible) {
        void window.piApi.extensionAction?.({ sessionId, surface: 'widget', key: widget.key, type: 'resize', columns, rows: 36, appearance });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [sessionId, visible.map((widget) => widget.key).join(',')]);

  if (visible.length === 0) return null;
  return <div className={`extension-widgets is-${placement}`} ref={rootRef}>
    {visible.map((widget) => <div className="extension-widget" key={widget.key}>
      <SurfaceRows
        lines={widget.lines}
        onPointer={(event) => {
          const point = pointOf(event);
          void window.piApi.extensionAction?.({
            sessionId, surface: 'widget', key: widget.key,
            type: 'deltaY' in event ? 'wheel' : 'click',
            ...point,
            ...('deltaY' in event ? { delta: event.deltaY } : {}),
          });
        }}
      />
    </div>)}
  </div>;
}

/** custom()：通用浮层；键盘、鼠标和 done() 都回传给扩展组件。 */
export function ExtensionCustomOverlay({ sessionId }: { sessionId: string }) {
  const [panel, setPanel] = useState<CustomPanel | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const last = useRef('');
  useEffect(() => {
    let disposed = false;
    void window.piApi.extensionState(sessionId).then((state) => {
      if (!disposed) setPanel(state?.custom || null);
    }).catch(() => { /* 扩展未绑定 */ });
    const off = window.piApi.onExtensionCustom?.((event) => {
      if (event.sessionId === sessionId) setPanel(event.custom);
    }) ?? (() => {});
    return () => { disposed = true; off(); };
  }, [sessionId]);

  // 浮层打开时把键盘序列交给扩展；扩展自己决定选择、确认或关闭。
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
      event.preventDefault();
      event.stopPropagation();
      void window.piApi.extensionAction?.({ sessionId, surface: 'custom', type: 'key', key });
    };
    document.addEventListener('keydown', onKey, true);
    bodyRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [panel, sessionId]);

  // 打开时按实际宽度重排一次，避免按默认 100 列渲染后换行错位。
  useEffect(() => {
    if (!panel) return;
    const node = bodyRef.current;
    if (!node) return;
    const resize = () => {
      const columns = Math.max(30, Math.floor(node.clientWidth / CELL));
      const rows = Math.max(10, Math.floor((window.innerHeight * 0.7) / LINE));
      const key = `${columns}:${rows}`;
      if (key === last.current) return;
      last.current = key;
      void window.piApi.extensionAction?.({ sessionId, surface: 'custom', type: 'resize', columns, rows, appearance: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [panel?.id, sessionId]);

  if (!panel || panel.lines.length === 0) return null;
  return <div className="extension-custom-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) void window.piApi.extensionAction?.({ sessionId, surface: 'custom', type: 'close' }); }}>
    <section className="extension-custom-card" role="dialog" aria-modal="true" aria-label={panel.title || '扩展界面'}>
      <header className="extension-custom-head">
        <strong>{panel.title || '扩展界面'}</strong>
        <button type="button" className="extension-custom-close" aria-label="关闭扩展界面" onClick={() => {
          if (panel.close) void window.piApi.extensionAction?.({ sessionId, surface: 'custom', type: 'click', target: 'overlay', ...panel.close });
          else void window.piApi.extensionAction?.({ sessionId, surface: 'custom', type: 'key', key: 'Escape' });
        }}><X /></button>
      </header>
      <div className="extension-custom-body" ref={bodyRef} tabIndex={-1}>
        <SurfaceRows
          lines={panel.lines}
          rowTypes={panel.rowTypes}
          onPointer={(event) => {
            const point = pointOf(event, panel.offset);
            void window.piApi.extensionAction?.({
              sessionId, surface: 'custom',
              type: 'deltaY' in event ? 'wheel' : 'click',
              ...point,
              ...('deltaY' in event ? { delta: event.deltaY } : {}),
            });
          }}
        />
      </div>
    </section>
  </div>;
}

/** input()/editor()：统一输入对话框。 */
export function ExtensionDialogHost({ sessionId }: { sessionId: string }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => window.piApi.onExtensionDialog?.((event) => {
    if (event.sessionId !== sessionId) return;
    setRequest({ id: event.id, kind: event.kind, title: event.title, placeholder: event.placeholder, prefill: event.prefill });
    setValue(event.prefill || '');
  }) ?? (() => {}), [sessionId]);

  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(() => (request.kind === 'editor' ? areaRef.current : inputRef.current)?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [request]);

  function finish(result: string | undefined) {
    if (!request) return;
    void window.piApi.extensionDialogResult?.({ id: request.id, value: result });
    setRequest(null);
    setValue('');
  }

  if (!request) return null;
  return <div className="confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(undefined); }}>
    <section className="confirm-card extension-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
      <header className="confirm-head">
        <div className="confirm-heading"><span className="confirm-eyebrow">{request.kind === 'editor' ? '编辑文本' : '扩展输入'}</span><h2>{request.title}</h2></div>
        <button type="button" className="confirm-close" aria-label="关闭输入框" onClick={() => finish(undefined)}><X /></button>
      </header>
      <div className="confirm-body">
        {request.kind === 'editor'
          ? <textarea ref={areaRef} className="extension-dialog-textarea" rows={8} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); finish(undefined); } if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(value); } }} />
          : <input ref={inputRef} className="extension-dialog-input" value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); finish(undefined); } if (event.key === 'Enter') { event.preventDefault(); finish(value); } }} />}
      </div>
      <footer className="confirm-actions">
        <button type="button" className="confirm-cancel" onClick={() => finish(undefined)}>取消</button>
        <button type="button" className="confirm-accept" onClick={() => finish(value)}>{request.kind === 'editor' ? '保存' : '确定'}</button>
      </footer>
    </section>
  </div>;
}

type SelectRequest = { id: string; title: string; options: string[] };

/** select()：扩展选择器统一用应用内列表，替代系统原生对话框。 */
export function ExtensionSelectDialog({ sessionId }: { sessionId: string }) {
  const [request, setRequest] = useState<SelectRequest | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => window.piApi.onExtensionSelect?.((event) => {
    if (event.sessionId !== sessionId) return;
    setRequest({ id: event.id, title: event.title, options: event.options || [] });
    setActive(0);
  }) ?? (() => {}), [sessionId]);

  useEffect(() => window.piApi.onExtensionSelectClose?.((event) => {
    if (event.sessionId === sessionId) setRequest((current) => current?.id === event.id ? null : current);
  }) ?? (() => {}), [sessionId]);

  function finish(value: string | undefined) {
    if (!request) return;
    void window.piApi.extensionSelectResult?.({ id: request.id, value });
    setRequest(null);
  }

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(undefined); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => (index + 1) % Math.max(1, request.options.length)); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index - 1 + request.options.length) % Math.max(1, request.options.length)); return; }
      if (event.key === 'Enter') { event.preventDefault(); finish(request.options[active]); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [request, active]);

  if (!request) return null;
  return <div className="confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(undefined); }}>
    <section className="confirm-card extension-select" role="dialog" aria-modal="true" aria-label={request.title}>
      <header className="confirm-head">
        <div className="confirm-heading"><span className="confirm-eyebrow">扩展选择</span><h2>{request.title}</h2></div>
        <button type="button" className="confirm-close" aria-label="关闭选择器" onClick={() => finish(undefined)}><X /></button>
      </header>
      <div className="extension-select-list" role="listbox" aria-label={request.title}>
        {request.options.map((option, index) => {
          // 扩展常用「标题 — 说明」的纯文本格式；这里只做排版拆分，不解释业务含义。
          const [main, ...rest] = option.split(' — ');
          return <button type="button" role="option" aria-selected={index === active} className={`extension-select-option ${index === active ? 'is-active' : ''}`} key={`${index}-${option}`} onMouseEnter={() => setActive(index)} onClick={() => finish(option)}>
            <span className="extension-select-main">{main}</span>
            {rest.length > 0 && <span className="extension-select-desc">{rest.join(' — ')}</span>}
          </button>;
        })}
      </div>
      <footer className="confirm-actions">
        <button type="button" className="confirm-cancel" onClick={() => finish(undefined)}>取消</button>
      </footer>
    </section>
  </div>;
}
