import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  Columns2,
  FileDiff,
  FileText,
  Folder,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  PanelRight,
  Plus,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { RightPanelToolList, type RightPanelToolAction } from './RightPanelStart';
import { usePanelTabScroll } from './usePanelTabScroll';

export type PanelTabItem = {
  id: string;
  kind: 'files' | 'file' | 'diff' | 'changes' | 'temporary' | 'terminal' | 'services';
  title: string;
};

const TAB_ICONS: Record<PanelTabItem['kind'], LucideIcon> = {
  files: Folder,
  file: FileText,
  diff: FileDiff,
  changes: FileDiff,
  temporary: MessageCirclePlus,
  terminal: Terminal,
  services: Activity,
};

export function PanelTabBar<T extends PanelTabItem>({
  tabs,
  activeId,
  workspaceName,
  fullscreen,
  split,
  resizing,
  toolActions,
  onActivate,
  onClose,
  onReorder,
  onContextMenu,
  onToggleSplit,
  onToggleFullscreen,
  onCollapse,
  onMakeDragPreview,
  onClearDragPreview,
}: {
  tabs: T[];
  activeId: string;
  workspaceName: string;
  fullscreen: boolean;
  split: boolean;
  resizing: boolean;
  toolActions: RightPanelToolAction[];
  onActivate: (tab: T) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onToggleSplit: () => void;
  onToggleFullscreen: () => void;
  onCollapse: () => void;
  onMakeDragPreview: (event: DragEvent<HTMLElement>, title: string) => void;
  onClearDragPreview: () => void;
}) {
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { rootRef, revealTab } = usePanelTabScroll({ activeId, tabCount: tabs.length, resizing, split });

  useEffect(() => {
    if (!toolMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setToolMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setToolMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [toolMenuOpen]);

  const finishDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
    onClearDragPreview();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, tab: T, index: number) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(tab.id, rect.left, rect.bottom);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(tab);
      return;
    }
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowLeft'
          ? Math.max(0, index - 1)
          : event.key === 'ArrowRight'
            ? Math.min(tabs.length - 1, index + 1)
            : -1;
    if (nextIndex < 0 || nextIndex === index) return;
    event.preventDefault();
    const target = rootRef.current?.querySelectorAll<HTMLElement>('.panel-tab')[nextIndex];
    target?.focus();
    if (target) revealTab(target);
  };

  if (tabs.length === 0) {
    return <div className="panel-tabbar is-empty">
      <strong className="panel-context-name" title={workspaceName}>{workspaceName || '工具'}</strong>
      <div className="panel-tools">
        <button className="icon-button" type="button" aria-label="收起右侧面板" title="收起右侧面板" onClick={onCollapse}><PanelRight /></button>
      </div>
    </div>;
  }

  return <div className="panel-tabbar">
    <div
      className="panel-tabs"
      ref={rootRef}
      role="tablist"
      aria-label="右侧面板标签"
      onDragOver={(event) => {
        if (!draggingId || !rootRef.current) return;
        const rect = rootRef.current.getBoundingClientRect();
        if (event.clientX < rect.left + 32) rootRef.current.scrollLeft -= 10;
        else if (event.clientX > rect.right - 32) rootRef.current.scrollLeft += 10;
      }}
    >
      {tabs.map((tab, index) => {
        const Icon = TAB_ICONS[tab.kind];
        return <div
          key={tab.id}
          role="tab"
          tabIndex={activeId === tab.id ? 0 : -1}
          aria-selected={activeId === tab.id}
          title={tab.title}
          className={`panel-tab ${activeId === tab.id ? 'is-active' : ''} ${draggingId === tab.id ? 'is-dragging' : ''} ${dropTarget === tab.id ? 'tab-drop-before' : ''}`}
          draggable
          onClick={() => onActivate(tab)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu(tab.id, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => onTabKeyDown(event, tab, index)}
          onDragStart={(event) => {
            setDraggingId(tab.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', tab.id);
            onMakeDragPreview(event, tab.title);
          }}
          onDragOver={(event) => {
            if (!draggingId || draggingId === tab.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(tab.id);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (draggingId) onReorder(draggingId, tab.id);
            finishDrag();
          }}
          onDragEnd={finishDrag}
        >
          <span className={`panel-tab-icon is-${tab.kind}`}><Icon aria-hidden /></span>
          <span className="panel-tab-label">{tab.title}</span>
          <button
            type="button"
            className="panel-tab-close"
            draggable={false}
            aria-label={`关闭 ${tab.title}`}
            onDragStart={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          ><X /></button>
        </div>;
      })}
    </div>
    <div className="panel-tools">
      <div className="panel-tool-menu-anchor" ref={menuRef}>
        <button
          className={`icon-button panel-tab-add ${toolMenuOpen ? 'is-active' : ''}`}
          type="button"
          aria-label="打开工具"
          title="打开工具"
          aria-haspopup="menu"
          aria-expanded={toolMenuOpen}
          onClick={() => setToolMenuOpen((value) => !value)}
        ><Plus /></button>
        {toolMenuOpen && <div className="panel-tool-menu">
          <RightPanelToolList
            menu
            actions={toolActions.map((action) => ({
              ...action,
              onSelect: () => {
                setToolMenuOpen(false);
                action.onSelect();
              },
            }))}
          />
        </div>}
      </div>
      <button className={`icon-button ${split ? 'is-active' : ''}`} type="button" aria-label={split ? '退出分栏' : '分栏'} title={split ? '退出分栏' : '分栏'} onClick={onToggleSplit}><Columns2 /></button>
      <button className="icon-button" type="button" aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '应用内全屏'} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      <button className="icon-button" type="button" aria-label="收起右侧面板" title="收起右侧面板" onClick={onCollapse}><PanelRight /></button>
    </div>
  </div>;
}
