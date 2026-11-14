import type {
  CSSProperties, DragEvent, KeyboardEvent, PointerEvent, ReactNode,
} from 'react';
import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { PanelTabBar } from './PanelTabBar';
import { splitPanelWidth } from './panel-width.mjs';
import type { PanelTab } from '../app-types';
import type { RightPanelToolAction } from './RightPanelStart';

type AppWorkbenchProps = {
  open: boolean;
  fullscreen: boolean;
  split: boolean;
  resizing: boolean;
  panelWidth: number;
  panelMaxWidth: number;
  entered: boolean;
  workspaceName: string;
  tabs: PanelTab[];
  activeTabId: string;
  activeTab?: PanelTab;
  toolActions: RightPanelToolAction[];
  fileTree: ReactNode;
  panelContent: ReactNode;
  persistentPanelContent: ReactNode;
  extensionDock: ReactNode;
  onClose: () => void;
  onActivate: (tab: PanelTab) => void;
  onCloseTab: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onToggleSplit: () => void;
  onToggleFullscreen: () => void;
  onMakeDragPreview: (event: DragEvent, title: string) => void;
  onClearDragPreview: () => void;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeLostCapture: () => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

export function AppWorkbench({
  open,
  fullscreen,
  split,
  resizing,
  panelWidth,
  panelMaxWidth,
  entered,
  workspaceName,
  tabs,
  activeTabId,
  activeTab,
  toolActions,
  fileTree,
  panelContent,
  persistentPanelContent,
  extensionDock,
  onClose,
  onActivate,
  onCloseTab,
  onReorder,
  onContextMenu,
  onToggleSplit,
  onToggleFullscreen,
  onMakeDragPreview,
  onClearDragPreview,
  renamingId,
  onStartRename,
  onRename,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeLostCapture,
  onResizeKeyDown,
}: AppWorkbenchProps) {
  const [splitTreeWidth, setSplitTreeWidth] = useState(38);
  const [splitResizing, setSplitResizing] = useState(false);
  const layoutPanelWidth = split ? splitPanelWidth(panelWidth, panelMaxWidth) : panelWidth;

  function updateSplitWidth(event: PointerEvent<HTMLDivElement>) {
    if (!splitResizing) return;
    const body = event.currentTarget.parentElement;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const next = Math.min(70, Math.max(20, ((event.clientX - rect.left) / rect.width) * 100));
    setSplitTreeWidth(next);
  }

  function startSplitResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSplitResizing(true);
  }

  function endSplitResize(event: PointerEvent<HTMLDivElement>) {
    setSplitResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function keySplitResize(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setSplitTreeWidth((value) => Math.min(70, Math.max(20, value + (event.key === 'ArrowLeft' ? -4 : 4))));
  }

  if (!open) return null;
  return (
    <>
      {!fullscreen && <button className="file-panel-backdrop" aria-label="关闭右侧面板" tabIndex={-1} onClick={onClose} />}
      <aside className={`file-panel ${entered ? 'is-open' : ''} ${fullscreen ? 'is-fullscreen' : ''} ${split ? 'is-split' : ''} ${resizing ? 'is-resizing' : ''}`} style={{ '--panel-w': `${layoutPanelWidth}px` } as CSSProperties}>
        {!fullscreen && <div
          className="panel-resize-handle"
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          aria-valuenow={layoutPanelWidth}
          aria-valuemin={320}
          aria-valuemax={panelMaxWidth}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onLostPointerCapture={onResizeLostCapture}
          onKeyDown={onResizeKeyDown}
        />}
        <div className="file-panel-inner">
          <PanelTabBar
            tabs={tabs}
            activeId={activeTabId}
            workspaceName={workspaceName}
            fullscreen={fullscreen}
            split={split}
            resizing={resizing}
            toolActions={toolActions}
            onActivate={onActivate}
            onClose={onCloseTab}
            onReorder={onReorder}
            onContextMenu={onContextMenu}
            onToggleSplit={onToggleSplit}
            onToggleFullscreen={onToggleFullscreen}
            onCollapse={onClose}
            onMakeDragPreview={onMakeDragPreview}
            onClearDragPreview={onClearDragPreview}
            renamingId={renamingId}
            onStartRename={onStartRename}
            onRename={onRename}
          />
          <div
            className={`panel-body ${split ? 'is-split' : ''}`}
            style={split ? { '--split-tree-width': `${splitTreeWidth}%` } as CSSProperties : undefined}
          >
            {split ? <>
              <div className="panel-split-tree">{fileTree}</div>
              <div
                className={`panel-split-handle ${splitResizing ? 'is-active' : ''}`}
                role="separator"
                aria-label="调整文件树与预览宽度"
                aria-orientation="vertical"
                aria-valuenow={Math.round(splitTreeWidth)}
                aria-valuemin={20}
                aria-valuemax={70}
                tabIndex={0}
                onPointerDown={startSplitResize}
                onPointerMove={updateSplitWidth}
                onPointerUp={endSplitResize}
                onPointerCancel={endSplitResize}
                onLostPointerCapture={() => setSplitResizing(false)}
                onKeyDown={keySplitResize}
              />
              <div className="panel-split-main">
                {activeTab?.kind === 'files' ? <div className="panel-empty"><FolderOpen /><strong>选择文件进行预览</strong></div> : panelContent}
                {persistentPanelContent}
              </div>
            </> : <>
              {panelContent}
              {persistentPanelContent}
            </>}
          </div>
          <div className="panel-extension-dock">{extensionDock}</div>
        </div>
      </aside>
    </>
  );
}
