import { Fragment, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Globe2,
  GripVertical,
  LayoutGrid,
  MessageSquare,
  Plug,
  RotateCcw,
  Rows3,
} from 'lucide-react';
import type {
  ConversationExtensionLayout,
  ConversationExtensionOrderScope,
  ExtensionSettingsPage,
  ExtensionUiItem,
  ExtensionUiSnapshot,
} from '../types/extension-types';
import { ExtensionSlot, type ExtensionNotice } from './ExtensionSlot';

function contentSummary(item: ExtensionUiItem): string {
  const kinds = new Set(item.content.map((block) => block.kind));
  if (kinds.has('dataView')) return '实时数据';
  if (kinds.has('metricGrid')) return '运行指标';
  if (kinds.has('table')) return '明细表格';
  if (kinds.has('chart') || kinds.has('sparkline')) return '趋势图表';
  if (kinds.has('timeline')) return '执行时间线';
  return '扩展视图';
}

export function ConversationExtensionDock({
  items,
  surface,
  placement,
  cwd,
  sessionId,
  modelRef,
  onOpenSettings,
  onSendPrompt,
  onNotify,
}: {
  items: ExtensionUiItem[];
  surface: ExtensionUiSnapshot;
  placement: 'header' | 'footer';
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: (notice: ExtensionNotice) => void;
}) {
  if (items.length === 0) return null;
  return <nav
    className={`conversation-extension-dock is-${placement}`}
    aria-label={placement === 'header' ? '会话顶部扩展' : '会话底部扩展'}
  >
    <div className="conversation-extension-dock-items">
      {items.map((item, index) => <Fragment key={item.id}>
        {index > 0 && <span className="conversation-extension-dock-separator" aria-hidden="true" />}
        <article
          className="conversation-extension-dock-item"
          aria-label={item.title}
        >
          <ExtensionSlot
            slot={item.slot}
            presentation="compact"
            snapshot={surface}
            selectedItemId={item.id}
            cwd={cwd}
            sessionId={sessionId}
            modelRef={modelRef}
            onOpenSettings={onOpenSettings}
            onSendPrompt={onSendPrompt}
            onNotify={onNotify}
          />
        </article>
      </Fragment>)}
    </div>
  </nav>;
}

export function ConversationExtensionHub({
  items,
  surface,
  sessionId,
  cwd,
  modelRef,
  layout,
  orderScope,
  hasSessionOverride,
  onLayoutChange,
  onOrderScopeChange,
  onOrderChange,
  onRestoreGlobalOrder,
  onOpenSettings,
  onSendPrompt,
  onNotify,
}: {
  items: ExtensionUiItem[];
  surface: ExtensionUiSnapshot;
  sessionId: string;
  cwd?: string;
  modelRef?: string;
  layout: ConversationExtensionLayout;
  orderScope: ConversationExtensionOrderScope;
  hasSessionOverride: boolean;
  onLayoutChange: (layout: ConversationExtensionLayout) => void;
  onOrderScopeChange: (scope: ConversationExtensionOrderScope) => void;
  onOrderChange: (extensionIds: string[]) => void;
  onRestoreGlobalOrder: () => void;
  onOpenSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: (notice: ExtensionNotice) => void;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const ordered = useMemo(() => items, [items]);

  function persistExtensionOrder(nextItems: ExtensionUiItem[]) {
    onOrderChange([...new Set(nextItems.map((item) => item.extensionId))]);
  }

  function move(itemId: string, direction: -1 | 1) {
    const current = [...ordered];
    const from = current.findIndex((item) => item.id === itemId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    current.splice(to, 0, ...current.splice(from, 1));
    persistExtensionOrder(current);
  }

  function dropBefore(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const current = [...ordered];
    const from = current.findIndex((item) => item.id === draggedId);
    const to = current.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    current.splice(to, 0, ...current.splice(from, 1));
    persistExtensionOrder(current);
    setDraggedId(null);
    setDropId(null);
  }

  return <div className="conversation-extension-hub">
    <header className="extension-hub-head">
      <div>
        <h2>会话扩展</h2>
        <p>{orderScope === 'session'
          ? '当前会话使用独立顺序；恢复全局后移除这份覆盖。底部摘要始终只占一行。'
          : '全局顺序会用于新会话和尚未单独排序的会话；底部摘要始终只占一行。'}</p>
      </div>
      <div className="extension-hub-tools">
        <div className="extension-hub-scope" role="group" aria-label="扩展排序范围">
          <button
            type="button"
            className={orderScope === 'global' ? 'is-active' : ''}
            aria-pressed={orderScope === 'global'}
            onClick={() => onOrderScopeChange('global')}
          ><Globe2 />全局</button>
          <button
            type="button"
            className={orderScope === 'session' ? 'is-active' : ''}
            aria-pressed={orderScope === 'session'}
            onClick={() => onOrderScopeChange('session')}
          ><MessageSquare />当前会话</button>
        </div>
        {orderScope === 'session' && hasSessionOverride && <button
          type="button"
          className="extension-hub-reset"
          title="恢复全局顺序"
          onClick={onRestoreGlobalOrder}
        ><RotateCcw />恢复全局</button>}
        <div className="extension-hub-layout" role="group" aria-label="扩展卡片布局">
          <button
            type="button"
            className={layout === 'grid' ? 'is-active' : ''}
            aria-pressed={layout === 'grid'}
            title="卡片布局"
            onClick={() => onLayoutChange('grid')}
          ><LayoutGrid /></button>
          <button
            type="button"
            className={layout === 'list' ? 'is-active' : ''}
            aria-pressed={layout === 'list'}
            title="紧凑列表"
            onClick={() => onLayoutChange('list')}
          ><Rows3 /></button>
        </div>
      </div>
    </header>

    {ordered.length === 0
      ? <div className="extension-hub-empty">
        <Plug />
        <strong>当前会话没有扩展详情</strong>
        <span>扩展可以分别声明完整详情和会话内摘要；两者使用各自适合的布局。</span>
      </div>
      : <div className={`extension-hub-items is-${layout}`} role="list" data-order-scope={orderScope}>
        {ordered.map((item, index) => <article
          className={`extension-hub-card ${dropId === item.id ? 'is-drop-target' : ''} ${draggedId === item.id ? 'is-dragging' : ''}`}
          role="listitem"
          key={item.id}
          onDragOver={(event) => {
            if (!draggedId || draggedId === item.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropId(item.id);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropId(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dropBefore(item.id);
          }}
        >
          <div className="extension-hub-card-copy">
            <div className="extension-hub-card-title">
              <button
                type="button"
                className="extension-hub-card-drag"
                draggable
                aria-label={`拖动排序 ${item.title}`}
                title="拖动排序"
                onDragStart={(event) => {
                  setDraggedId(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.id);
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDropId(null);
                }}
              >
                <GripVertical aria-hidden="true" />
              </button>
              <strong>{item.title}</strong>
              <div className="extension-hub-card-actions">
                <button type="button" disabled={index === 0} aria-label={`上移 ${item.title}`} title="上移" onClick={() => move(item.id, -1)}><ArrowUp /></button>
                <button type="button" disabled={index === ordered.length - 1} aria-label={`下移 ${item.title}`} title="下移" onClick={() => move(item.id, 1)}><ArrowDown /></button>
              </div>
            </div>
            <p className="extension-hub-card-description">{item.description || `${item.extensionName} 提供的会话视图。`}</p>
            <div className="extension-hub-card-meta">
              <span className={`extension-hub-source is-${item.scope}`}>
                {item.scope === 'project' ? '项目' : item.scope === 'user' ? '用户' : '内置'}
              </span>
              <span>{contentSummary(item)}</span>
            </div>
            <div className="extension-hub-card-content">
              <ExtensionSlot
                slot={item.slot}
                presentation="inline"
                snapshot={surface}
                selectedItemId={item.id}
                cwd={cwd}
                sessionId={sessionId}
                modelRef={modelRef}
                onOpenSettings={onOpenSettings}
                onSendPrompt={onSendPrompt}
                onNotify={onNotify}
              />
            </div>
          </div>
        </article>)}
      </div>}
  </div>;
}
