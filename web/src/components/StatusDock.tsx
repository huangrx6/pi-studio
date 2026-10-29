/**
 * 输入框下方的统一状态栏。
 *
 * 数据来自两个 Pi 原语：
 *  - `ctx.ui.setStatus(key, text)`：状态 chip
 *  - `ctx.ui.setFooter(...)`：运行指标（轮数、步数、速率、token、缓存、上下文）
 *
 * 旧实现把 footer 单独渲染成一行，导致与状态 chip 重复、位置还随扩展加载顺序变化。
 * 这里合并成一个 Dock：
 *  - footer 只取第一段作为紧凑 chip，点击展开完整指标；
 *  - 状态 chip 默认按 key 稳定排序，可通过右侧「管理」调整顺序/显隐；
 *  - 顺序与显隐存在 localStorage，跨会话保持。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { PopoverSurface } from './PopoverSurface';

type DockItem = {
  key: string;
  label: string;
  detail: string;
  kind: 'footer' | 'status';
};

type DockConfig = { order: string[]; hidden: string[] };

const STORAGE_KEY = 'pi-studio:status-dock';
const DEFAULT_CONFIG: DockConfig = { order: [], hidden: [] };

function readConfig(): DockConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter((item: unknown) => typeof item === 'string') : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((item: unknown) => typeof item === 'string') : [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(config: DockConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* 隐私模式忽略 */ }
}

/** footer 是终端单元格拼成的一行，用连续空白切成指标段。 */
function footerItems(text: string): DockItem[] {
  const segments = text.split(/\s{2,}/u).map((part) => part.trim()).filter((part) => part && !/^[.·…]+$/.test(part));
  if (segments.length === 0) return [];
  return [{
    key: 'footer',
    label: segments[0],
    detail: segments.join('\n'),
    kind: 'footer',
  }];
}

function statusItems(statuses: Array<[string, string]>): DockItem[] {
  return statuses
    .filter(([, text]) => text.trim())
    .map(([key, text]) => ({ key: `status:${key}`, label: text, detail: text, kind: 'status' as const }));
}

/** 默认顺序：footer 固定第一，其余按 key 排序，保证跨扩展加载顺序稳定。 */
function sortItems(items: DockItem[], order: string[]): DockItem[] {
  const rank = (key: string) => {
    const index = order.indexOf(key);
    if (index >= 0) return index;
    return key === 'footer' ? -1 : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

export function StatusDock({ sessionId }: { sessionId: string }) {
  const [statuses, setStatuses] = useState<Array<[string, string]>>([]);
  const [footer, setFooter] = useState('');
  const [config, setConfig] = useState<DockConfig>(() => readConfig());
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState({ left: 0, bottom: 34, width: 360 });

  function close(restoreFocus = false) {
    setDetailsKey(null); setManageOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (!detailsKey && !manageOpen) return;
    const place = () => {
      const root = rootRef.current, trigger = triggerRef.current;
      if (!root || !trigger) return;
      const r = root.getBoundingClientRect(), t = trigger.getBoundingClientRect();
      const width = Math.min(manageOpen ? 400 : 360, r.width);
      setAnchor({ width, left: Math.max(0, Math.min(t.left - r.left, r.width - width)), bottom: r.bottom - t.top + 8 });
    };
    place();
    const observer = new ResizeObserver(place);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [detailsKey, manageOpen, footer, statuses, config]);

  useEffect(() => {
    let disposed = false, statusRevision = 0, footerRevision = 0;
    setStatuses([]); setFooter(''); setDetailsKey(null); setManageOpen(false);
    void window.piApi.extensionState(sessionId).then((state) => {
      if (disposed || !state) return;
      if (!statusRevision) setStatuses(state.statuses || []);
      if (!footerRevision) setFooter(state.footer || '');
    }).catch(() => { /* 扩展未绑定 */ });
    const offStatus = window.piApi.onExtensionStatus?.((event) => {
      if (event.sessionId !== sessionId) return;
      statusRevision++;
      setStatuses((current) => {
        const next = new Map(current);
        if (!event.text) next.delete(event.key);
        else next.set(event.key, event.text);
        return [...next];
      });
    }) ?? (() => {});
    const offFooter = window.piApi.onExtensionFooter?.((event) => {
      if (event.sessionId === sessionId) { footerRevision++; setFooter(event.text || ''); }
    }) ?? (() => {});
    return () => { disposed = true; offStatus(); offFooter(); };
  }, [sessionId]);

  // 点击外部关闭详情/管理浮层。
  useEffect(() => {
    if (!detailsKey && !manageOpen) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setDetailsKey(null); setManageOpen(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [detailsKey, manageOpen]);

  const items = useMemo(() => sortItems([...footerItems(footer), ...statusItems(statuses)], config.order), [footer, statuses, config.order]);
  const visible = items.filter((item) => !config.hidden.includes(item.key));
  const details = items.find((item) => item.key === detailsKey) || null;

  function update(next: DockConfig) {
    setConfig(next);
    writeConfig(next);
  }

  function reorder(key: string, direction: -1 | 1) {
    const keys = items.map((item) => item.key);
    const index = keys.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= keys.length) return;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    update({ ...config, order: keys });
  }

  function toggle(key: string) {
    const hidden = config.hidden.includes(key) ? config.hidden.filter((item) => item !== key) : [...config.hidden, key];
    update({ ...config, hidden });
  }

  if (!footer && statuses.length === 0) return null;

  return <div className="status-dock" ref={rootRef}>
    <div className="status-dock-items">
      {visible.map((item) => <button
        type="button"
        className={`status-chip ${item.kind === 'footer' ? 'is-footer' : ''} ${detailsKey === item.key ? 'is-open' : ''}`}
        key={item.key}
        title={item.detail}
        aria-expanded={detailsKey === item.key}
        aria-haspopup="dialog"
        onClick={(event) => { triggerRef.current = event.currentTarget; setManageOpen(false); setDetailsKey((current) => current === item.key ? null : item.key); }}
      >
        <span>{item.label}</span>
        <ChevronDown className="status-chip-chevron" />
      </button>)}
      <button type="button" className={`status-dock-manage ${manageOpen ? 'is-open' : ''}`} aria-label="管理状态栏" title="管理状态栏" aria-expanded={manageOpen} aria-haspopup="dialog" onClick={(event) => { triggerRef.current = event.currentTarget; setDetailsKey(null); setManageOpen((value) => !value); }}><SlidersHorizontal /></button>
    </div>

    {details && <PopoverSurface className="status-dock-popover" style={anchor} role="dialog" aria-label="状态详情"
      heading={details.kind === 'footer' ? '运行指标' : '状态详情'} onClose={() => close(true)} closeLabel="关闭状态详情">
      <div className="status-dock-detail">
        {details.detail.split(/\n|\s+[·•]\s+/u).filter(part => part.trim()).map((part, index) => {
          // Only split explicit label/value text; never infer plugin semantics or calculate metrics.
          const pair = part.trim().match(/^([^:：]{1,24})[:：]\s+(.+)$/u);
          return pair
            ? <div className="status-detail-row" key={index}><span>{pair[1]}</span><strong>{pair[2]}</strong></div>
            : <div className="status-detail-line" key={index}>{part.trim()}</div>;
        })}
      </div>
      <div className="status-dock-source">来源 · {details.kind === 'footer' ? '扩展底栏' : details.key.replace(/^status:/, '')}</div>
    </PopoverSurface>}

    {manageOpen && <PopoverSurface className="status-dock-popover is-manage" style={anchor} role="dialog" aria-label="状态栏管理"
      heading="状态栏管理" onClose={() => close(true)} closeLabel="关闭状态栏管理">
      <p className="status-dock-hint">调整显示顺序与显隐；设置会保存在本机。</p>
      <div className="status-manage-list">{items.map((item, index) => <div className={`status-manage-row ${config.hidden.includes(item.key) ? 'is-hidden' : ''}`} key={item.key}>
        <button type="button" className={`status-manage-check ${config.hidden.includes(item.key) ? '' : 'is-on'}`} aria-label={config.hidden.includes(item.key) ? `显示 ${item.label}` : `隐藏 ${item.label}`} onClick={() => toggle(item.key)}>{config.hidden.includes(item.key) ? null : <Check />}</button>
        <span className="status-manage-label" title={item.label}>{item.label}</span>
        <button type="button" className="status-manage-move" aria-label="上移" disabled={index === 0} onClick={() => reorder(item.key, -1)}><ChevronLeft /></button>
        <button type="button" className="status-manage-move" aria-label="下移" disabled={index === items.length - 1} onClick={() => reorder(item.key, 1)}><ChevronRight /></button>
      </div>)}</div>
    </PopoverSurface>}
  </div>;
}
