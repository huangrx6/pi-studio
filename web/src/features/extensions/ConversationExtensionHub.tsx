import { Fragment, useMemo, useState } from 'react';
import {
  ArrowDown,
  ChevronRight,
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
} from '../../types/extension-types';
import { ExtensionSlot, type ExtensionNotice } from './ExtensionSlot';
import { SessionViewHeader } from '../../shell/SessionViewHeader';

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
  placement: 'footer';
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
    aria-label="会话底部扩展"
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
  onOpenItem,
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
  onOpenItem: (itemId: string) => void;
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

  const groups = useMemo(() => {
    const grouped = new Map<string, ExtensionUiItem[]>();
    for (const item of items) {
      const group = grouped.get(item.extensionId);
      if (group) group.push(item);
      else grouped.set(item.extensionId, [item]);
    }
    return [...grouped.values()];
  }, [items]);
  const ids = groups.map(group => group[0].extensionId);
  function move(from: number, to: number) {
    if (from < 0 || to < 0 || from === to || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onOrderChange(next);
  }

  return <div className="conversation-extension-hub">
    <SessionViewHeader className="extension-hub-head" title="会话扩展"
      summary={items.length ? `${groups.length} 个扩展 · ${items.length} 个会话面板` : undefined}>
      {onOpenSettings && <button className="secondary-button extension-hub-manage" type="button" onClick={() => onOpenSettings('extensions')}><Plug aria-hidden="true" /><span>管理扩展</span></button>}
    </SessionViewHeader>
    {items.length > 0 && <div className="extension-hub-tools">
        {groups.length > 1 && <><span className="extension-sort-label">排序范围</span><div className="extension-hub-scope" role="group" aria-label="扩展排序范围">
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
        </div></>}
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
      </div>}

    {!items.length
      ? <div className="extension-hub-empty"><Plug /><strong>暂无会话扩展</strong><p>启用提供会话面板的扩展后，可以在这里查看它的状态和操作。</p></div>
      : <div className={`extension-hub-items is-${layout}`} role="list" data-order-scope={orderScope}>
        {groups.map((group, index) => {
          const { extensionId, extensionName, scope } = group[0];
          return <article key={extensionId} role="listitem" className={`extension-hub-card${dropId === extensionId ? ' is-drop-target' : ''}${draggedId === extensionId ? ' is-dragging' : ''}`}
            onDragOver={event => {
              if (!draggedId || draggedId === extensionId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropId(extensionId);
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropId(null); }}
            onDrop={event => { event.preventDefault(); if (draggedId) move(ids.indexOf(draggedId), index); setDraggedId(null); setDropId(null); }}>
            <div className="extension-group-head">
              <Plug /><strong>{extensionName || extensionId}</strong><small>{scope === 'project' ? '项目' : scope === 'user' ? '用户' : '内置'}</small>
              {groups.length > 1 && <div className="extension-hub-card-actions">
                <span className="extension-hub-card-drag" draggable title="拖动调整扩展顺序"
                  onDragStart={event => { setDraggedId(extensionId); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', extensionId); }}
                  onDragEnd={() => { setDraggedId(null); setDropId(null); }}><GripVertical /></span>
                <button type="button" disabled={!index} aria-label={`上移 ${extensionName}`} title="上移扩展" onClick={() => move(index, index - 1)}><ArrowUp /></button>
                <button type="button" disabled={index === groups.length - 1} aria-label={`下移 ${extensionName}`} title="下移扩展" onClick={() => move(index, index + 1)}><ArrowDown /></button>
              </div>}
            </div>
            {group.map(item => <section className="extension-hub-panel" key={item.id}>
              <h3 className="extension-hub-card-title"><button type="button" aria-label={`打开 ${item.title} 详情`} onClick={() => onOpenItem(item.id)}><strong>{item.title}</strong><ChevronRight /></button></h3>
              {item.description && <p className="extension-hub-description">{item.description}</p>}
              <div className="extension-hub-card-content"><ExtensionSlot
                slot={item.slot} presentation="inline" snapshot={surface} selectedItemId={item.id}
                cwd={cwd} sessionId={sessionId} modelRef={modelRef}
                onOpenSettings={onOpenSettings} onSendPrompt={onSendPrompt} onNotify={onNotify}
              /></div>
            </section>)}
          </article>;
        })}
      </div>}
  </div>;
}
