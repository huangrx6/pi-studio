/**
 * 输入框上方的统一状态栏。
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal, X } from 'lucide-react';

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

  useEffect(() => {
    let disposed = false;
    void window.piApi.extensionState(sessionId).then((state) => {
      if (disposed || !state) return;
      setStatuses(state.statuses || []);
      setFooter(state.footer || '');
    }).catch(() => { /* 扩展未绑定 */ });
    const offStatus = window.piApi.onExtensionStatus?.((event) => {
      if (event.sessionId !== sessionId) return;
      setStatuses((current) => {
        const next = new Map(current);
        if (!event.text) next.delete(event.key);
        else next.set(event.key, event.text);
        return [...next];
      });
    }) ?? (() => {});
    const offFooter = window.piApi.onExtensionFooter?.((event) => {
      if (event.sessionId === sessionId) setFooter(event.text || '');
    }) ?? (() => {});
    return () => { disposed = true; offStatus(); offFooter(); };
  }, [sessionId]);

  // 点击外部关闭详情/管理浮层。
  useEffect(() => {
    if (!detailsKey && !manageOpen) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setDetailsKey(null); setManageOpen(false); }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
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
        onClick={() => { setManageOpen(false); setDetailsKey((current) => current === item.key ? null : item.key); }}
      >
        <span>{item.label}</span>
        <ChevronDown className="status-chip-chevron" />
      </button>)}
      <button type="button" className={`status-dock-manage ${manageOpen ? 'is-open' : ''}`} aria-label="管理状态栏" title="管理状态栏" onClick={() => { setDetailsKey(null); setManageOpen((value) => !value); }}><SlidersHorizontal /></button>
    </div>

    {details && <div className="status-dock-popover">
      <div className="status-dock-popover-head">
        <div className="status-dock-heading">
          <span className="status-dock-eyebrow">{details.kind === 'footer' ? 'PI-FOOTER-COMPOSER · 终端 footer' : details.key.replace(/^status:/, '')}</span>
          <strong>{details.kind === 'footer' ? '运行指标' : '状态详情'}</strong>
        </div>
        <button type="button" className="status-dock-close" aria-label="关闭状态详情" onClick={() => setDetailsKey(null)}><X /></button>
      </div>
      <div className="status-dock-detail">{details.detail.split('\n').map((line, index) => <div className="status-detail-line" key={index}>{line}</div>)}</div>
      <div className="status-dock-actions">
        <button type="button" onClick={() => reorder(details.key, -1)} aria-label="向前移动"><ChevronLeft /><span>前移</span></button>
        <button type="button" onClick={() => reorder(details.key, 1)} aria-label="向后移动"><ChevronRight /><span>后移</span></button>
        <button type="button" onClick={() => { toggle(details.key); setDetailsKey(null); }}><X /><span>隐藏</span></button>
        <button type="button" onClick={() => { setDetailsKey(null); setManageOpen(true); }}><SlidersHorizontal /><span>管理</span></button>
      </div>
    </div>}

    {manageOpen && <div className="status-dock-popover is-manage">
      <div className="status-dock-popover-head">
        <div className="status-dock-heading">
          <span className="status-dock-eyebrow">STATUS BAR</span>
          <strong>状态栏管理</strong>
        </div>
        <button type="button" className="status-dock-close" aria-label="关闭状态栏管理" onClick={() => setManageOpen(false)}><X /></button>
      </div>
      <p className="status-dock-hint">调整显示顺序与显隐；设置会保存在本机。</p>
      <div className="status-manage-list">{items.map((item) => <div className={`status-manage-row ${config.hidden.includes(item.key) ? 'is-hidden' : ''}`} key={item.key}>
        <button type="button" className={`status-manage-check ${config.hidden.includes(item.key) ? '' : 'is-on'}`} aria-label={config.hidden.includes(item.key) ? `显示 ${item.label}` : `隐藏 ${item.label}`} onClick={() => toggle(item.key)}>{config.hidden.includes(item.key) ? null : <Check />}</button>
        <span className="status-manage-label" title={item.label}>{item.label}</span>
        <button type="button" className="status-manage-move" aria-label="上移" onClick={() => reorder(item.key, -1)}><ChevronLeft /></button>
        <button type="button" className="status-manage-move" aria-label="下移" onClick={() => reorder(item.key, 1)}><ChevronRight /></button>
      </div>)}</div>
    </div>}
  </div>;
}
