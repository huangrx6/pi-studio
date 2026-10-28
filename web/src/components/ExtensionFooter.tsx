import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export type FooterCell = { text: string; width: number; tone?: string; bold?: boolean };
type FooterPanel = {
  lines: FooterCell[][];
  /** rule 行来自扩展的 ─── 分隔线，渲染成原生细线，同时保留行高以对齐命中坐标。 */
  rowTypes?: Array<'text' | 'rule'>;
  /** 扩展面板的标题；只在内置卡片外框被识别时出现。 */
  title?: string;
  /** 扩展自己的关闭按钮在面板中的单元格坐标。 */
  close?: { row: number; col: number } | null;
  /** 面板内容被裁掉的行 / 列数，点击时需要加回去。 */
  offset?: { row: number; col: number } | null;
  /** 去掉外框后的内容宽度（单元格）。 */
  contentWidth?: number;
};
export type FooterView = {
  lines: FooterCell[][];
  interactive: boolean;
  overlay: (FooterPanel & { col: number; row: number; width: number }) | null;
};
export type FooterAction = {
  sessionId: string;
  type: 'resize' | 'click' | 'wheel' | 'close' | 'key';
  target?: 'footer' | 'overlay';
  columns?: number;
  rows?: number;
  appearance?: string;
  x?: number;
  y?: number;
  delta?: number;
  key?: string;
};
const FALLBACK_CELL = 7.2;
const FALLBACK_LINE = 22;
const PANEL_PADDING = 20;
const TONES = new Set(['text', 'muted', 'faint', 'dim', 'accent', 'error', 'warning', 'success', 'info', 'link']);

function cellClass(cell: FooterCell): string | undefined {
  const tone = cell.tone && TONES.has(cell.tone) ? `tone-${cell.tone}` : '';
  const bold = cell.bold ? 'is-bold' : '';
  return [tone, bold].filter(Boolean).join(' ') || undefined;
}

/** 把扩展的字符单元画成等宽行；rule 行保留原行高，避免后面的点击坐标错位。 */
function Rows({ panel, cell, line }: { panel: FooterPanel; cell: number; line: number }) {
  return <>{panel.lines.map((row, index) => panel.rowTypes?.[index] === 'rule'
    ? <div className="extension-terminal-rule" key={index} style={{ height: line }}><span /></div>
    : <div className="extension-terminal-row" key={index}>
      {row.map((item, column) => <span key={column} className={cellClass(item)} style={{ width: item.width * cell }}>{item.text}</span>)}
    </div>)}</>;
}

/**
 * 扩展底栏只负责渲染扩展给出的字符单元并回传鼠标坐标。
 * 分段文本、浮层内容、浮层宽度和点击后的行为全部由扩展决定；
 * 这里不包含任何额度 / 上下文 / 性能等业务知识。
 */
export function ExtensionFooter({ sessionId }: { sessionId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<FooterView | null>(null);
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState('');
  // 等宽字体实际宽度可能不是 7.2px，测量一次后所有命中坐标都用同一个值。
  const cellRef = useRef(FALLBACK_CELL);
  const lineRef = useRef(FALLBACK_LINE);
  const [layout, setLayout] = useState({ width: 0, cell: FALLBACK_CELL, line: FALLBACK_LINE });

  const act = (input: Omit<FooterAction, 'sessionId'>) => {
    if (!window.piApi.footerAction) return;
    void window.piApi.footerAction({ sessionId, ...input })
      .then((next) => { if (next) setView(next as FooterView); })
      .catch(() => setError('扩展暂时无法响应，请重试。'));
  };

  // 订阅扩展推来的快照；挂载时先取一次当前状态，避免错过绑定完成前的更新。
  useEffect(() => {
    let disposed = false;
    let received = false;
    const off = window.piApi.onExtensionFooter?.((event) => {
      if (disposed || event.sessionId !== sessionId) return;
      received = true;
      setView(event.view || null);
      setFallback(event.text || '');
      setError('');
    });
    if (window.piApi.extensionState) {
      void window.piApi.extensionState(sessionId).then((state) => {
        if (disposed || received || !state) return;
        setView(state.view || null);
        setFallback(state.footer || '');
      }).catch(() => { /* 扩展还没绑定好，等待后续推送 */ });
    }
    return () => {
      disposed = true;
      off?.();
      // 离开会话时收起扩展自己的浮层，避免下次挂载时残留一个旧面板。
      void window.piApi.footerAction?.({ sessionId, type: 'close' }).catch(() => {});
    };
  }, [sessionId]);

  // 把桌面窗口的真实尺寸换算成终端的列 / 行；主题切换也要通知扩展。
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let previous = '';
    const resize = () => {
      const style = getComputedStyle(node);
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
      probe.textContent = '0000000000';
      node.appendChild(probe);
      const measured = probe.getBoundingClientRect().width / 10;
      probe.remove();
      const cell = measured > 0 ? measured : FALLBACK_CELL;
      const line = parseFloat(style.lineHeight) || FALLBACK_LINE;
      cellRef.current = cell;
      lineRef.current = line;
      const columns = Math.max(22, Math.floor(node.clientWidth / cell));
      const rows = Math.max(12, Math.floor((node.getBoundingClientRect().top || 0) / line));
      const appearance = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const width = node.clientWidth;
      setLayout((current) => current.width === width && current.cell === cell && current.line === line
        ? current
        : { width, cell, line });
      const key = `${columns}:${rows}:${appearance}`;
      if (key === previous) return;
      previous = key;
      act({ type: 'resize', columns, rows, appearance });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    const theme = new MutationObserver(resize);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', resize);
    resize();
    return () => {
      observer.disconnect();
      theme.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [sessionId]);

  // 浮层打开的这段生命周期里，点击外部或按 Esc 都交回扩展关闭。
  useEffect(() => {
    if (!view?.overlay) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) act({ type: 'close' });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); act({ type: 'close' }); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta' || event.key === 'Tab') return;
      // 焦点在面板里（例如关闭按钮）时不因为按键收起；否则用户继续在输入框打字，收起浮层。
      const target = event.target as Node | null;
      if (target && root.current?.querySelector('.extension-footer-popover')?.contains(target)) return;
      act({ type: 'close' });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [Boolean(view?.overlay), sessionId]);

  /** 把像素坐标换算成扩展使用的单元格坐标；浮层要补回裁掉的外框偏移。 */
  function mouse(event: React.MouseEvent | React.WheelEvent, target: 'footer' | 'overlay') {
    const bounds = event.currentTarget.getBoundingClientRect();
    const cell = cellRef.current || FALLBACK_CELL;
    const line = lineRef.current || FALLBACK_LINE;
    const offset = target === 'overlay' ? view?.overlay?.offset : undefined;
    act({
      type: 'deltaY' in event ? 'wheel' : 'click',
      target,
      x: Math.max(0, Math.floor((event.clientX - bounds.left) / cell)) + (offset?.col || 0),
      y: Math.max(0, Math.floor((event.clientY - bounds.top) / line)) + (offset?.row || 0),
      ...('deltaY' in event ? { delta: event.deltaY } : {}),
    });
  }

  const overlay = view?.overlay;
  const gridWidth = overlay ? Math.min(layout.width, Math.max(1, (overlay.contentWidth || overlay.width) * layout.cell)) : 0;
  const cardWidth = overlay ? Math.min(layout.width, Math.max(220, gridWidth + PANEL_PADDING)) : 0;
  const overlayLeft = overlay ? Math.max(0, Math.min(overlay.col * layout.cell - PANEL_PADDING / 2, layout.width - cardWidth)) : 0;

  return <div className="extension-footer" ref={root}>
    {/* 点击底栏不抢输入框焦点：浮层打开后继续打字会由 keydown 监听收起。 */}
    {view?.lines.length
      ? <div
        className="extension-footer-text"
        role={view.interactive ? 'button' : undefined}
        tabIndex={view.interactive ? 0 : undefined}
        aria-label={view.interactive ? `${fallback.replace(/\s+/g, ' ').slice(0, 80) || '扩展底栏'}，点击对应文字查看详情` : undefined}
        aria-expanded={view.interactive ? Boolean(view.overlay) : undefined}
        onMouseDown={(event) => { if (view.interactive) event.preventDefault(); }}
        onClick={(event) => {
          // 选中文本时不要误触分段。
          if (window.getSelection()?.toString()) return;
          mouse(event, 'footer');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            act({ type: 'click', target: 'footer', x: 0, y: 0 });
          }
        }}
      ><Rows panel={view} cell={layout.cell} line={layout.line} /></div>
      : fallback ? <div className="extension-footer-text">{fallback}</div> : null}
    {overlay && <div className="extension-footer-popover" role="dialog" aria-label={overlay.title || '扩展详情'} style={{ left: overlayLeft, width: cardWidth }}>
      {(overlay.title || overlay.close) && <header className="extension-footer-popover-head">
        <span>{overlay.title || '扩展详情'}</span>
        <button
          type="button"
          className="extension-footer-popover-close"
          aria-label="关闭扩展详情"
          onClick={() => {
            // 优先点击扩展自己的关闭按钮，保持它的状态机同步；没有命中区域时退回 Esc。
            if (overlay.close) act({ type: 'click', target: 'overlay', x: overlay.close.col, y: overlay.close.row });
            else act({ type: 'close' });
          }}
        ><X size={14} /></button>
      </header>}
      <div className="extension-footer-popover-body">
        <div
          className="extension-footer-popover-grid"
          style={{ width: gridWidth }}
          onClick={(event) => mouse(event, 'overlay')}
          onWheel={(event) => { event.stopPropagation(); mouse(event, 'overlay'); }}
        ><Rows panel={overlay} cell={layout.cell} line={layout.line} /></div>
      </div>
    </div>}
    {error && <span className="extension-footer-error" role="status">{error}</span>}
  </div>;
}
