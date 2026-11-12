import type {
  CSSProperties, DragEvent, KeyboardEvent, PointerEvent, ReactNode,
} from 'react';
import { FolderOpen } from 'lucide-react';
import { PanelTabBar } from './PanelTabBar';
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
  if (!open) return null;
  return (
    <>
      {!fullscreen && <button className="file-panel-backdrop" aria-label="关闭右侧面板" tabIndex={-1} onClick={onClose} />}
      <aside className={`file-panel ${entered ? 'is-open' : ''} ${fullscreen ? 'is-fullscreen' : ''} ${split ? 'is-split' : ''} ${resizing ? 'is-resizing' : ''}`} style={{ '--panel-w': `${panelWidth}px` } as CSSProperties}>
        {!fullscreen && <div
          className="panel-resize-handle"
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
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
          <div className={`panel-body ${split ? 'is-split' : ''}`}>
            {split ? <>
              <div className="panel-split-tree">{fileTree}</div>
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
