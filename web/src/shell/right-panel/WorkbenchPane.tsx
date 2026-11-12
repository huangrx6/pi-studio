import { lazy, Suspense, useEffect, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import {
  AppWindow,
  ChevronDown,
  ChevronLeft,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  RotateCw,
} from 'lucide-react';
import type { ModelSelection } from '../../types/model-types';
import type { FilePreviewResult } from '../../types/file-preview-types';
import type { SessionStateForPersistence } from '../../features/conversation/useMessageDelivery';
import { TemporaryChat } from '../../features/conversation/TemporaryChat';
import { ChangesView } from '../../features/conversation/ChangesView';
import { DiffView } from '../../features/conversation/DiffView';
import { DeferredFilePreview } from '../../shared/DeferredFilePreview';
import { ActionMenu } from '../../shared/ActionMenu';
import { formatFileSize } from '../../shared/filesize';
import { AppWorkbench } from './AppWorkbench';
import { BrowserPanel } from './BrowserPanel';
import { RightPanelStart, type RightPanelToolAction } from './RightPanelStart';
import type { useAppWorkbenchController } from './useAppWorkbench';
import type { TerminalAppearance } from '../../features/terminal/TerminalPanel';

const LazyTerminalPanel = lazy(async () => {
  const module = await import('../../features/terminal/TerminalPanel');
  return { default: module.TerminalPanel };
});
const RuntimeServicesPanel = lazy(async () => {
  const module = await import('../../features/runtime-services/RuntimeServicesPanel');
  return { default: module.RuntimeServicesPanel };
});

type WorkbenchPaneProps = {
  controller: ReturnType<typeof useAppWorkbenchController>;
  workspace: string;
  session: SessionStateForPersistence;
  modelSelection: ModelSelection;
  workspaceName: string;
  extensionDock: ReactNode;
  comparisonPanel: ReactNode;
  onOpenComparison: () => void;
  dragPreviewRef: MutableRefObject<HTMLDivElement | null>;
  onChooseWorkspace: () => void;
  onOpenSettings: (page: 'models') => void;
  terminalAppearance: TerminalAppearance;
  onTerminalFontSize: (size: number) => void;
  makeDragPreview: (event: React.DragEvent, label: string, kind: '工作区' | '会话' | '标签') => void;
};

export function WorkbenchPane({
  controller,
  workspace,
  session,
  modelSelection,
  workspaceName,
  extensionDock,
  comparisonPanel,
  onOpenComparison,
  dragPreviewRef,
  onChooseWorkspace,
  onOpenSettings,
  terminalAppearance,
  onTerminalFontSize,
  makeDragPreview,
}: WorkbenchPaneProps) {
  const {
    filesOpen,
    treePath,
    entries,
    file,
    fileError,
    panelTabs,
    tabMenu,
    closeTabMenu,
    activePanelTabId,
    activePanelTab,
    panelFullscreen,
    setPanelFullscreen,
    panelWidth,
    panelMaxWidth,
    resizePanel,
    panelResizing,
    setPanelResizing,
    panelDrag,
    panelEntered,
    panelSplit,
    setPanelSplit,
    fileBusy,
    treeBusy,
    treeError,
    treeOwner,
    fileMenuOpen,
    fileApps,
    fileActionsRef,
    loadTree,
    closePanel,
    openTemporaryChat,
    openTerminalTab,
    openBrowserTab,
    openFilesTab,
    openServicesTab,
    loadFileToTab,
    activatePanelTab,
    openFile,
    closePanelTab,
    reorderPanelTabs,
    openDiffTab,
    closePanelTabs,
    showFileActions,
    openFileWith,
    revealCurrentFile,
    setTabMenu,
    setPanelTabs,
  } = controller;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const panelWorkspace = session?.cwd || workspace;

  /** 重命名标签：空标题回退到原名，避免出现没有文字的标签。 */
  function renamePanelTab(id: string, title: string) {
    const next = title.trim();
    if (next) setPanelTabs((current) => current.map((tab) => tab.id === id ? { ...tab, title: next, customTitle: true } : tab));
    setRenamingId(null);
  }

  /** 重启终端：先结束旧会话，再用同一个 id 重新挂载面板。 */
  async function restartTerminal(id: string) {
    await window.piApi.terminalClose(id).catch(() => {});
    setPanelTabs((current) => current.map((tab) => tab.id === id ? { ...tab, restart: (tab.restart ?? 0) + 1 } : tab));
  }

  // 面板级快捷键：⌘W 关当前标签，⌘1..9 切标签。终端内的组合键由终端自己先拦。
  useEffect(() => {
    if (!filesOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      // 终端里只认 ⌘（Ctrl+W 是 readline 的删词，不能抢）。
      const inTerminal = (event.target as HTMLElement | null)?.closest?.('.terminal-host');
      if (inTerminal && !event.metaKey) return;
      const tabs = panelTabs;
      if (event.key.toLowerCase() === 'w') {
        if (!activePanelTabId) return;
        event.preventDefault();
        closePanelTab(activePanelTabId);
        return;
      }
      if (!/^[1-9]$/u.test(event.key)) return;
      const target = tabs[Number(event.key) - 1];
      if (!target) return;
      event.preventDefault();
      activatePanelTab(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activatePanelTab, activePanelTabId, closePanelTab, filesOpen, panelTabs]);
  const toolActions: RightPanelToolAction[] = [
    { id: 'comparison', label: '模型双跑', description: '独立评估两个模型的回答与性能', onSelect: onOpenComparison },
    { id: 'files', label: '工作区文件', description: '浏览和预览项目文件', disabled: !panelWorkspace, onSelect: openFilesTab },
    { id: 'terminal', label: '新建终端', description: '在当前工作区运行命令', disabled: !panelWorkspace, onSelect: openTerminalTab },
    { id: 'services', label: '运行服务', description: '查看正在运行的服务', disabled: !panelWorkspace, onSelect: openServicesTab },
    { id: 'browser', label: '浏览器', description: '打开网页并保留在工作台', onSelect: () => openBrowserTab() },
    { id: 'temporary', label: '临时聊天', description: '开始一个独立的临时会话', onSelect: openTemporaryChat },
  ];

  function renderFileTree() {
    if (!workspace) {
      return <div className="panel-empty">
        <strong>先选择工作区</strong>
        <button className="text-button" onClick={onChooseWorkspace}>打开工作区</button>
      </div>;
    }
    const visibleEntries = treeOwner === workspace ? entries : [];
    const visiblePath = treeOwner === workspace ? treePath : '';
    return <div className="panel-file-browser">
      <div className="file-toolbar">
        <button className="icon-button" aria-label="返回上级目录" title="返回上级目录" disabled={!visiblePath} onClick={() => void loadTree(visiblePath.split('/').slice(0, -1).join('/'))}><ChevronLeft /></button>
        <span className="path-label">{visiblePath ? `/${visiblePath}` : '/'}</span>
        <button className="icon-button" aria-label="刷新文件列表" title="刷新" onClick={() => void loadTree(visiblePath)}><RotateCw /></button>
        <small>{visibleEntries.length} 项</small>
      </div>
      {treeError && treeOwner === workspace && <div className="panel-file-error" role="alert"><p>{treeError}</p><button className="text-button" onClick={() => void loadTree(visiblePath)}>重试读取目录</button></div>}
      <div className="file-tree">
        {!treeBusy && visibleEntries.map((entry) => (
          <button key={entry.path} className={`file-row ${entry.type === 'directory' ? 'is-directory' : ''}`} title={entry.name} onClick={() => entry.type === 'directory' ? void loadTree(entry.path) : void openFile(entry.path, undefined, 'workspace')}>
            {entry.type === 'directory' ? <Folder size={15} /> : <FileText size={15} />}
            <span>{entry.name}</span>
            {entry.type === 'file' && <small>{formatFileSize(entry.size, '')}</small>}
            {entry.type === 'directory' && <ChevronDown size={13} className="chevron-left" />}
          </button>
        ))}
        {!treeBusy && !treeError && visibleEntries.length === 0 && <div className="file-empty"><FolderOpen /><strong>目录为空</strong></div>}
      </div>
      {treeBusy && <div className="file-loading" role="status"><LoaderCircle className="spin" />正在读取文件…</div>}
    </div>;
  }

  function renderFilePreview() {
    if (fileError) {
      return <div className="panel-file-error" role="alert">
        <p>{fileError}</p>
        <button className="text-button" onClick={() => { if (activePanelTab) void loadFileToTab(activePanelTab); }}>重试读取文件</button>
      </div>;
    }
    if (!file) {
      return fileBusy
        ? <div className="panel-empty" role="status" aria-label="正在读取文件"><LoaderCircle className="spin" /><strong>正在读取文件</strong></div>
        : <div className="panel-empty"><FileText /><strong>在左侧选择文件</strong></div>;
    }
    const preview: FilePreviewResult = file.preview ?? {
      path: file.path,
      name: file.path.split('/').pop() || file.path,
      size: file.size,
      mimeType: '',
      kind: file.binary ? 'binary' : 'text',
      text: file.text,
    };
    // 文件标签复用共享预览组件：Markdown/HTML 可切换渲染与源码，PDF 走内置阅读器。
    return <div className="panel-file-preview">
      <DeferredFilePreview
        file={preview}
        loading={fileBusy}
        onOpenExternal={() => void openFileWith()}
        actions={<div className="file-actions" ref={fileActionsRef}>
          <button className="icon-button" aria-label="文件操作" title="文件操作" aria-expanded={fileMenuOpen} onClick={() => void showFileActions()}><MoreHorizontal /></button>
          {fileMenuOpen && <div className="file-actions-menu" role="menu">
            <div className="file-actions-label">打开方式</div>
            <button className="file-action" role="menuitem" onClick={() => void openFileWith()}><Eye /><span>预览（默认）</span></button>
            <div className="file-actions-sep" />
            {fileApps.map((app) => <button className="file-action" role="menuitem" key={app.path} onClick={() => void openFileWith(app.path)}>{app.icon ? <img src={app.icon} alt="" /> : <AppWindow />}<span>{app.name}</span></button>)}
            <div className="file-actions-sep" />
            <button className="file-action" role="menuitem" onClick={() => void revealCurrentFile()}><FolderOpen /><span>显示文件位置</span></button>
          </div>}
        </div>}
      />
    </div>;
  }

  function renderPanelContent() {
    if (!activePanelTab) {
      return <RightPanelStart
        workspace={workspace}
        cwd={session?.cwd}
        actions={toolActions}
        onChooseWorkspace={onChooseWorkspace}
      />;
    }
    if (activePanelTab.kind === 'comparison') return comparisonPanel;
    if (activePanelTab.kind === 'temporary') {
      return <TemporaryChat key={activePanelTab.id} id={activePanelTab.id} selection={modelSelection} onManage={() => onOpenSettings('models')} />;
    }
    if (activePanelTab.kind === 'terminal') {
      return <Suspense fallback={
        <div className="panel-route-loading" role="status" aria-label="正在加载终端">
          <LoaderCircle aria-hidden="true" />
        </div>
      }>
        <LazyTerminalPanel
          key={`${activePanelTab.id}:${activePanelTab.restart ?? 0}`}
          id={activePanelTab.id}
          cwd={activePanelTab.cwd || session?.cwd || workspace}
          appearance={terminalAppearance}
          onFontSizeChange={onTerminalFontSize}
          onNewTerminal={openTerminalTab}
          onOpenFile={(path) => { void openFile(path.replace(/:\d+(?::\d+)?$/u, ''), session?.id, 'external'); }}
          onOpenUrl={(url) => openBrowserTab(url)}
          onTitle={(title) => setPanelTabs((current) => current.map((tab) => (
            tab.id === activePanelTab.id && !tab.customTitle ? { ...tab, title } : tab
          )))}
        />
      </Suspense>;
    }
    if (activePanelTab.kind === 'services') {
      return <Suspense fallback={
        <div className="panel-route-loading" role="status" aria-label="正在加载服务面板">
          <LoaderCircle aria-hidden="true" />
        </div>
      }>
        <RuntimeServicesPanel cwd={session?.cwd} workspace={workspace} />
      </Suspense>;
    }
    if (activePanelTab.kind === 'browser') {
      return <BrowserPanel
        key={activePanelTab.id}
        url={activePanelTab.url || ''}
        onUrlChange={(next) => setPanelTabs((current) => current.map((tab) => tab.id === activePanelTab.id ? { ...tab, url: next } : tab))}
        onClose={() => closePanelTab(activePanelTab.id)}
      />;
    }
    if (activePanelTab.kind === 'files') return renderFileTree();
    if (activePanelTab.kind === 'changes' && activePanelTab.review) {
      return <ChangesView
        key={`${activePanelTab.id}:${activePanelTab.review.initial.at}:${activePanelTab.review.focusPath}`}
        {...activePanelTab.review}
        onOpenFile={path => void openFile(path, activePanelTab.review!.sessionId, 'diff')}
        onOpenDiff={(file, at) => openDiffTab(file, at, activePanelTab.review!.sessionId)}
      />;
    }
    if (activePanelTab.kind === 'diff' && activePanelTab.diff) return <DiffView file={activePanelTab.diff} />;
    return renderFilePreview();
  }

  return <>
    {tabMenu && <ActionMenu x={tabMenu.x} y={tabMenu.y} onClose={closeTabMenu} items={[
      { label: '重命名', run: () => { setRenamingId(tabMenu.id); closeTabMenu(); } },
      ...(panelTabs.find((tab) => tab.id === tabMenu.id)?.kind === 'terminal'
        ? [{ label: '重启终端', run: () => { void restartTerminal(tabMenu.id); closeTabMenu(); } }]
        : []),
      { label: '关闭标签页', run: () => closePanelTab(tabMenu.id) },
      { label: '关闭左侧标签页', disabled: panelTabs.findIndex(tab => tab.id === tabMenu.id) <= 0, run: () => closePanelTabs(tabMenu.id, 'left') },
      { label: '关闭右侧标签页', disabled: panelTabs.findIndex(tab => tab.id === tabMenu.id) === panelTabs.length - 1, run: () => closePanelTabs(tabMenu.id, 'right') },
      { label: '关闭其他标签页', disabled: panelTabs.length <= 1, run: () => closePanelTabs(tabMenu.id, 'others') },
      { label: '关闭所有标签页', run: () => closePanelTabs(tabMenu.id, 'all') },
    ]} />}
    <AppWorkbench
      open={filesOpen}
      fullscreen={panelFullscreen}
      split={panelSplit}
      resizing={panelResizing}
      panelWidth={panelWidth}
      panelMaxWidth={panelMaxWidth}
      entered={panelEntered}
      workspaceName={workspaceName}
      tabs={panelTabs}
      activeTabId={activePanelTabId}
      activeTab={activePanelTab}
      toolActions={toolActions}
      fileTree={renderFileTree()}
      panelContent={renderPanelContent()}
      extensionDock={extensionDock}
      onClose={closePanel}
      onActivate={activatePanelTab}
      onCloseTab={closePanelTab}
      onReorder={reorderPanelTabs}
      onContextMenu={(id, x, y) => setTabMenu({ id, x, y })}
      renamingId={renamingId}
      onStartRename={setRenamingId}
      onRename={renamePanelTab}
      onToggleSplit={() => setPanelSplit((value) => !value)}
      onToggleFullscreen={() => setPanelFullscreen((value) => !value)}
      onMakeDragPreview={(event, title) => makeDragPreview(event, title, '标签')}
      onClearDragPreview={() => {
        dragPreviewRef.current?.remove();
        dragPreviewRef.current = null;
      }}
      onResizeStart={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        panelDrag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width };
        setPanelResizing(true);
      }}
      onResizeMove={event => {
        if (panelDrag.current) resizePanel(panelDrag.current.width + panelDrag.current.x - event.clientX);
      }}
      onResizeEnd={event => {
        panelDrag.current = null;
        setPanelResizing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onResizeLostCapture={() => {
        panelDrag.current = null;
        setPanelResizing(false);
      }}
      onResizeKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          resizePanel(panelWidth + (event.key === 'ArrowLeft' ? 40 : -40));
        }
      }}
    />
  </>;
}
