import {
  ChevronsDown, ChevronsUp, FolderOpen, Layers3, LoaderCircle, MessageCirclePlus,
  MessageSquare, PanelLeft, Search, Settings, Sparkles, SquarePen, ArrowUp,
} from 'lucide-react';
import type { UpdateSnapshot } from '../types/update-types';
import { ExtensionSlot, type ExtensionNotice } from '../features/extensions/ExtensionSlot';
import { BrandMark, type SettingsTab } from './app-shell-config';
import type { PiWorkspace } from './app-types';
import { ConversationListNotice } from './ConversationListNotice';
import type { SidebarWorkspaceActions } from './SidebarWorkspaceList';
import { SidebarWorkspaceList } from './SidebarWorkspaceList';
import { SidebarSearch } from './SidebarSearch';
import type { SidebarSessionFilter } from './sidebar-filter';

type AppSidebarProps = {
  updateSnapshot: UpdateSnapshot;
  updateProgress: number | null;
  onOpenUpdateDialog: () => void;
  onStartSession: () => void;
  onOpenTemporaryChat: () => void;
  onOpenSettings: (page?: SettingsTab) => void;
  workspace: string;
  sessionId?: string;
  modelRef: string;
  onSendPrompt: (text: string, submit: boolean) => void;
  onNotify: (notice: ExtensionNotice) => void;
  workspaces: PiWorkspace[];
  allExpanded: boolean;
  onToggleAllExpanded: () => void;
  workspaceSearchOpen: boolean;
  workspaceSearchTrigger: React.RefObject<HTMLButtonElement>;
  onOpenWorkspaceSearch: () => void;
  onCloseWorkspaceSearch: () => void;
  onChooseFile: () => void;
  workspaceQuery: string;
  sidebarSessionFilter: SidebarSessionFilter;
  onWorkspaceQueryChange: (value: string) => void;
  onSidebarFilterChange: (value: SidebarSessionFilter) => void;
  conversationListRefreshError: boolean;
  stateLoading: boolean;
  settingsOpen: boolean;
  onRefreshConversationList: () => void;
  sidebarMutating: boolean;
  visibleWorkspaces: PiWorkspace[];
  expanded: Set<string>;
  sidebarFiltering: boolean;
  searchCollapsed: Set<string>;
  filterKey: string;
  sidebarCollapsed: boolean;
  sidebarActions: SidebarWorkspaceActions;
  onCollapse: () => void;
};

export function AppSidebar({
  updateSnapshot,
  updateProgress,
  onOpenUpdateDialog,
  onStartSession,
  onOpenTemporaryChat,
  onOpenSettings,
  workspace,
  sessionId,
  modelRef,
  onSendPrompt,
  onNotify,
  workspaces,
  allExpanded,
  onToggleAllExpanded,
  workspaceSearchOpen,
  workspaceSearchTrigger,
  onOpenWorkspaceSearch,
  onCloseWorkspaceSearch,
  onChooseFile,
  workspaceQuery,
  sidebarSessionFilter,
  onWorkspaceQueryChange,
  onSidebarFilterChange,
  conversationListRefreshError,
  stateLoading,
  settingsOpen,
  onRefreshConversationList,
  sidebarMutating,
  visibleWorkspaces,
  expanded,
  sidebarFiltering,
  searchCollapsed,
  filterKey,
  sidebarCollapsed,
  sidebarActions,
  onCollapse,
}: AppSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <button className="icon-button sidebar-top-toggle" aria-label="收起侧边栏" title="收起侧边栏" onClick={onCollapse}><PanelLeft /></button>
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Pi Studio</span>
        {(updateSnapshot.state === 'available'
          || updateSnapshot.state === 'downloading'
          || updateSnapshot.state === 'downloaded') && <button
            type="button"
            className={`brand-update is-${updateSnapshot.state}`}
            aria-label={updateSnapshot.state === 'downloaded'
              ? '重启并安装更新'
              : updateSnapshot.state === 'downloading'
                ? `正在下载 Pi Studio 更新${updateProgress === null ? '' : `，${Math.round(updateProgress)}%`}`
                : updateSnapshot.updateKind === 'same-version'
                  ? `Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion} ` : ''}有新构建`
                  : `Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion} ` : ''}可以更新`}
            title={updateSnapshot.state === 'downloaded'
              ? `Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion} ` : ''}已下载，点击安装`
              : updateSnapshot.state === 'downloading'
                ? `正在下载 Pi Studio 更新${updateProgress === null ? '' : ` · ${Math.round(updateProgress)}%`}`
                : updateSnapshot.updateKind === 'same-version'
                  ? `发现 Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion}` : '当前版本'} 的新构建`
                  : `发现 Pi Studio ${updateSnapshot.latestVersion ? `v${updateSnapshot.latestVersion}` : '新版本'}`}
            onClick={onOpenUpdateDialog}
          >
            {updateSnapshot.state === 'downloading'
              ? <LoaderCircle className="spin" />
              : updateSnapshot.state === 'downloaded'
                ? <ArrowUp />
                : <Sparkles />}
            {updateSnapshot.state === 'available' && <i aria-hidden="true" />}
          </button>}
      </div>
      <button className="new-chat" title="新会话" onClick={onStartSession}><SquarePen /><span>新会话</span></button>
      <nav className="nav">
        <button className="nav-row" title="临时聊天" onClick={onOpenTemporaryChat}><MessageCirclePlus /><span>临时聊天</span></button>
        <button className="nav-row is-active" title="对话" aria-current="page"><MessageSquare /><span>对话</span></button>
        <button className="nav-row" title="扩展" onClick={() => onOpenSettings('extensions')}><Layers3 /><span>扩展</span></button>
      </nav>
      <ExtensionSlot
        slot="workspace.sidebar"
        cwd={workspace}
        sessionId={sessionId}
        modelRef={modelRef}
        onOpenSettings={(page) => onOpenSettings(page as SettingsTab)}
        onSendPrompt={onSendPrompt}
        onNotify={onNotify}
      />
      <div className="workspace-head">
        <span>工作区</span>
        <div>
          {workspaces.length > 0 && <>
            <button className="icon-button" aria-label={allExpanded ? '收起所有工作区' : '展开所有工作区'} title={allExpanded ? '收起所有工作区' : '展开所有工作区'} onClick={onToggleAllExpanded}>{allExpanded ? <ChevronsUp /> : <ChevronsDown />}</button>
            <button ref={workspaceSearchTrigger} className={`icon-button ${workspaceSearchOpen ? 'is-active' : ''}`} aria-label="搜索工作区" aria-expanded={workspaceSearchOpen} title="搜索工作区或会话" onClick={() => {
              if (workspaceSearchOpen) onCloseWorkspaceSearch();
              else onOpenWorkspaceSearch();
            }}><Search /></button>
          </>}
          <button className="icon-button" onClick={onChooseFile} aria-label="打开工作区" title="打开工作区"><FolderOpen /></button>
        </div>
      </div>
      {workspaceSearchOpen && workspaces.length > 0 && <SidebarSearch
        query={workspaceQuery}
        filter={sidebarSessionFilter}
        onQueryChange={onWorkspaceQueryChange}
        onFilterChange={onSidebarFilterChange}
        onClose={onCloseWorkspaceSearch}
      />}
      {conversationListRefreshError && !settingsOpen && <ConversationListNotice busy={stateLoading} onRefresh={onRefreshConversationList} />}
      <SidebarWorkspaceList
        actionsDisabled={sidebarMutating || conversationListRefreshError}
        workspaces={visibleWorkspaces}
        loading={stateLoading}
        hasWorkspaces={workspaces.length > 0}
        activeWorkspace={workspace}
        activeSessionId={sessionId}
        expanded={expanded}
        filtering={sidebarFiltering}
        searchCollapsed={searchCollapsed}
        filterKey={filterKey}
        visible={!sidebarCollapsed && !settingsOpen}
        actions={sidebarActions}
      />
      <div className="sidebar-bottom">
        <button className="bottom-row" title="设置" onClick={() => onOpenSettings()}><Settings /><span>设置</span><span className="status"><i />本地运行</span></button>
      </div>
    </aside>
  );
}
