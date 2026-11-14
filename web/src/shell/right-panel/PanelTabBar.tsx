import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  Columns2,
  FileDiff,
  FileText,
  Folder,
  Globe,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  PanelRightClose,
  Plus,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { RightPanelToolList, type RightPanelToolAction } from './RightPanelStart';
import { usePanelTabScroll } from './usePanelTabScroll';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';

export type PanelTabItem = {
  id: string;
  kind: 'files' | 'file' | 'diff' | 'changes' | 'temporary' | 'terminal' | 'services' | 'browser' | 'comparison';
  title: string;
  tooltip?: string;
};

const TAB_ICONS: Record<PanelTabItem['kind'], LucideIcon> = {
  files: Folder,
  file: FileText,
  diff: FileDiff,
  changes: FileDiff,
  temporary: MessageCirclePlus,
  terminal: Terminal,
  services: Activity,
  browser: Globe,
  comparison: Columns2,
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
  renamingId,
  onStartRename,
  onRename,
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
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toolTrigger = useRef<HTMLButtonElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const closeToolMenu = (restore = false) => {
    setToolMenuOpen(false);
    if (restore && menuRef.current?.contains(document.activeElement)) toolTrigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!toolMenuOpen) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus({ preventScroll: true });
  }, [toolMenuOpen]);
  const { rootRef, revealTab } = usePanelTabScroll({ activeId, tabCount: tabs.length, resizing, split });

  useEffect(() => {
    if (!toolMenuOpen) return;
    const outside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setToolMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [toolMenuOpen]);

  const finishDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
    onClearDragPreview();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, tab: T, index: number) => {
    if (event.target !== event.currentTarget || isComposingKey(event.nativeEvent)) return;
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
        <button className="icon-button panel-collapse-entry" type="button" aria-label="收起右侧面板" title="收起右侧面板" onClick={onCollapse}><PanelRightClose /></button>
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
          title={tab.tooltip || tab.title}
          className={`panel-tab ${activeId === tab.id ? 'is-active' : ''} ${draggingId === tab.id ? 'is-dragging' : ''} ${dropTarget === tab.id ? 'tab-drop-before' : ''}`}
          draggable
          onClick={() => onActivate(tab)}
          onDoubleClick={(event) => {
            event.preventDefault();
            onStartRename(tab.id);
          }}
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
          {renamingId === tab.id
            ? <input
              className="panel-tab-rename"
              defaultValue={tab.title}
              autoFocus
              aria-label={`重命名 ${tab.title}`}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => onRename(tab.id, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (isComposingKey(event.nativeEvent)) return;
                if (event.key === 'Enter') { event.preventDefault(); onRename(tab.id, event.currentTarget.value); }
                if (event.key === 'Escape') { event.preventDefault(); onRename(tab.id, tab.title); }
              }}
            />
            : <span className="panel-tab-label">{tab.title}</span>}
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
          ref={toolTrigger}
          className={`icon-button panel-tab-add ${toolMenuOpen ? 'is-active' : ''}`}
          type="button"
          aria-label="打开工具"
          title="打开工具"
          aria-haspopup="menu"
          aria-expanded={toolMenuOpen}
          aria-controls={toolMenuOpen ? menuId : undefined}
          onClick={() => { focusLast.current = false; setToolMenuOpen((value) => !value); }}
          onKeyDown={event => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setToolMenuOpen(true);
            }
            if (event.key === 'Escape' && toolMenuOpen) { event.preventDefault(); event.stopPropagation(); closeToolMenu(true); }
          }}
        ><Plus /></button>
        {toolMenuOpen && <div className="panel-tool-menu" id={menuId} onKeyDown={event => {
          if (isComposingKey(event.nativeEvent)) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeToolMenu(true); return; }
          if (event.key === 'Tab') { event.stopPropagation(); closeToolMenu(true); return; }
          const items = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
          const index = menuFocusIndex(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length, true);
          if (index === null) return;
          event.preventDefault(); items[index]?.focus({ preventScroll: true });
        }}>
          <RightPanelToolList
            menu
            actions={toolActions.map((action) => ({
              ...action,
              onSelect: () => {
                closeToolMenu(true);
                action.onSelect();
              },
            }))}
          />
        </div>}
      </div>
      <button className={`icon-button ${split ? 'is-active' : ''}`} type="button" aria-label={split ? '退出分栏' : '分栏'} title={split ? '退出分栏' : '分栏'} onClick={onToggleSplit}><Columns2 /></button>
      <button className="icon-button" type="button" aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '应用内全屏'} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      <button className="icon-button panel-collapse-entry" type="button" aria-label="收起右侧面板" title="收起右侧面板" onClick={onCollapse}><PanelRightClose /></button>
    </div>
  </div>;
}
