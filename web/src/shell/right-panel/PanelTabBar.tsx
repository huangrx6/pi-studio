import type { PanelTab } from '../app-types';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Activity,
  Columns2,
  FileDiff,
  FileText,
  Folder,
  GitBranch,
  Globe,
  ListChecks,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  PanelRightClose,
  Plug,
  Plus,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { RightPanelToolList, type RightPanelToolAction } from './RightPanelStart';
import { PanelTabSwitcher } from './PanelTabSwitcher';
import { usePanelTabScroll } from './usePanelTabScroll';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import { ExtensionPanelPicker, type ExtensionPanelPickerProps } from '../../features/extensions/ExtensionPanelPicker';
import { ExtensionStatusIcon } from '../../features/extensions/ExtensionStatusIcon';

export type PanelTabItem = {
  id: string;
  kind: PanelTab['kind'];
  title: string;
  tooltip?: string;
  path?: string;
  extensionPanel?: PanelTab['extensionPanel'];
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
  progress: ListChecks,
  trace: Activity,
  subagents: Users,
  git: GitBranch,
  extension: Plug,
};

export function PanelTabBar<T extends PanelTabItem>({
  tabs,
  activeId,
  workspaceName,
  fullscreen,
  split,
  resizing,
  toolActions,
  extensionPicker,
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
  extensionPicker: ExtensionPanelPickerProps;
  onActivate: (tab: T) => void;
  onClose: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onToggleSplit?: () => void;
  onToggleFullscreen: () => void;
  onCollapse: () => void;
  onMakeDragPreview: (event: DragEvent<HTMLElement>, title: string) => void;
  onClearDragPreview: () => void;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, title?: string) => void;
}) {
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [pickingExtension, setPickingExtension] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toolTrigger = useRef<HTMLButtonElement>(null);
  const initialRenameTitle = useRef('');
  const focusLast = useRef(false);
  const menuId = useId();
  const closeToolMenu = (restore = false) => {
    setToolMenuOpen(false);
    setPickingExtension(false);
    if (restore && menuRef.current?.contains(document.activeElement)) toolTrigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!toolMenuOpen) return;
    const selector = pickingExtension ? '.extension-panel-picker button:not(:disabled)' : '[role="menuitem"]:not(:disabled)';
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>(selector);
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus({ preventScroll: true });
  }, [pickingExtension, toolMenuOpen]);
  const { rootRef, trackRef, hasOverflow, revealTab } = usePanelTabScroll({ activeId, tabs, resizing, split });

  const renderTabIcon = (tab: T) => {
    const Icon = TAB_ICONS[tab.kind];
    const extension = tab.extensionPanel && extensionPicker.surface.items.find(item => item.id === tab.extensionPanel?.panelId);
    return <span className={`panel-tab-icon is-${tab.kind}`} aria-hidden="true">
      {tab.kind === 'file' || tab.kind === 'diff' ? <FileKindIcon path={tab.path || tab.tooltip || tab.title} />
        : extension ? <ExtensionStatusIcon item={extension} /> : <Icon />}
    </span>;
  };

  const selectFromSwitcher = (tab: T) => {
    onActivate(tab);
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab.id)}"]`);
    target?.focus({ preventScroll: true });
    if (target) revealTab(target, 'auto');
  };

  useEffect(() => {
    if (!toolMenuOpen) return;
    const outside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) closeToolMenu();
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
    target?.focus({ preventScroll: true });
    if (target) revealTab(target);
  };

  return <div className={`panel-tabbar${tabs.length ? '' : ' is-empty'}`}>
    {!tabs.length ? <strong className="panel-context-name" title={workspaceName}>{workspaceName || '工具'}</strong> : <div className="panel-tab-navigation">
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
        <div className="panel-tab-track" ref={trackRef} role="presentation">
          {tabs.map((tab, index) => <div
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            aria-label={tab.title}
            tabIndex={activeId === tab.id ? 0 : -1}
            aria-selected={activeId === tab.id}
            title={tab.tooltip || tab.title}
            className={`panel-tab ${activeId === tab.id ? 'is-active' : ''} ${draggingId === tab.id ? 'is-dragging' : ''} ${dropTarget === tab.id ? 'tab-drop-before' : ''}`}
            draggable={renamingId !== tab.id}
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
            {renderTabIcon(tab)}
            <div className="panel-tab-caption">
              <span className="panel-tab-label">{tab.title}</span>
              <button
                type="button"
                className="panel-tab-close"
                tabIndex={activeId === tab.id ? 0 : -1}
                draggable={false}
                aria-label={`关闭 ${tab.title}`}
                onDragStart={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              ><X /></button>
              {renamingId === tab.id && <input
                className="panel-tab-rename"
                defaultValue={tab.title}
                autoFocus
                spellCheck={false}
                aria-label={`重命名 ${tab.title}`}
                onClick={event => event.stopPropagation()}
                onDoubleClick={event => event.stopPropagation()}
                onContextMenu={event => event.stopPropagation()}
                onDragStart={event => event.stopPropagation()}
                onFocus={event => {
                  initialRenameTitle.current = event.currentTarget.value;
                  const owner = event.currentTarget.closest<HTMLElement>('[role="tab"]');
                  if (owner) revealTab(owner, 'auto');
                  event.currentTarget.select();
                }}
                onBlur={event => {
                  const { value } = event.currentTarget;
                  onRename(tab.id, value === initialRenameTitle.current ? undefined : value);
                }}
                onKeyDown={event => {
                  if (isComposingKey(event.nativeEvent) || (event.key !== 'Enter' && event.key !== 'Escape')) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const input = event.currentTarget;
                  if (event.key === 'Escape') input.value = initialRenameTitle.current;
                  input.closest<HTMLElement>('[role="tab"]')?.focus({ preventScroll: true });
                }}
              />}
            </div>
          </div>)}
        </div>
      </div>
      {hasOverflow && <PanelTabSwitcher tabs={tabs} activeId={activeId} renderIcon={renderTabIcon} onSelect={selectFromSwitcher} />}
    </div>}
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
          onClick={() => { focusLast.current = false; setToolMenuOpen((value) => !value); setPickingExtension(false); }}
          onKeyDown={event => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setToolMenuOpen(true);
            }
            if (event.key === 'Escape' && toolMenuOpen) { event.preventDefault(); event.stopPropagation(); closeToolMenu(true); }
          }}
        ><Plus /></button>
        {toolMenuOpen && <div className={`panel-tool-menu${pickingExtension ? ' is-extension-picker' : ''}`} id={menuId}
          role={pickingExtension ? 'dialog' : 'menu'} aria-label={pickingExtension ? '扩展' : '打开工具'} onKeyDown={event => {
          if (isComposingKey(event.nativeEvent)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (pickingExtension) {
              focusLast.current = true;
              setPickingExtension(false);
            } else closeToolMenu(true);
            return;
          }
          if (event.key === 'Tab') {
            if (!pickingExtension) closeToolMenu(true);
            return;
          }
          const selector = pickingExtension ? '.extension-panel-picker button:not(:disabled)' : '[role="menuitem"]:not(:disabled)';
          const items = [...menuRef.current!.querySelectorAll<HTMLButtonElement>(selector)];
          const index = menuFocusIndex(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length, true);
          if (index === null) return;
          event.preventDefault(); items[index]?.focus({ preventScroll: true });
        }}>
          {pickingExtension ? <ExtensionPanelPicker {...extensionPicker}
              onOpenPanel={id => { closeToolMenu(true); extensionPicker.onOpenPanel(id); }}
              onManage={() => { closeToolMenu(true); extensionPicker.onManage(); }} /> : <>
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
            <button type="button" role="menuitem" tabIndex={-1} className="panel-tool panel-extensions-launcher"
              onClick={() => { focusLast.current = false; setPickingExtension(true); }}>
              <span className="panel-tool-icon"><Plug aria-hidden="true" /></span><span>打开扩展…</span>
            </button>
          </>}
        </div>}
      </div>
      {onToggleSplit && <button className={`icon-button ${split ? 'is-active' : ''}`} type="button" aria-label={split ? '退出分栏' : '分栏'} title={split ? '退出分栏' : '分栏'} onClick={onToggleSplit}><Columns2 /></button>}
      <button className="icon-button" type="button" aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '应用内全屏'} onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      <button className="icon-button panel-collapse-entry" type="button" aria-label="收起右侧面板" title="收起右侧面板" onClick={onCollapse}><PanelRightClose /></button>
    </div>
  </div>;
}
