import {
  ChevronsDown, ChevronsUp, FolderOpen, MessageCirclePlus, Package,
  Search, Settings, SquarePen,
} from 'lucide-react';
import { memo } from 'react';
import type { SettingsTab } from './app-shell-config';
import { ShellSidebar } from './ShellLayout';
import type { PiWorkspace } from './app-types';
import { ConversationListNotice } from './ConversationListNotice';
import type { SidebarWorkspaceActions } from './SidebarWorkspaceList';
import { SidebarWorkspaceList } from './SidebarWorkspaceList';
import { SidebarSearch } from './SidebarSearch';
import type { SidebarSessionFilter } from './sidebar-filter';

type AppSidebarProps = {
  onStartSession: () => void;
  onOpenTemporaryChat: () => void;
  onOpenSettings: (page?: SettingsTab) => void;
  workspace: string;
  sessionId?: string;
  isNewConversation?: boolean;
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

function AppSidebarView({
  onStartSession,
  onOpenTemporaryChat,
  onOpenSettings,
  workspace,
  sessionId,
  isNewConversation = false,
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
    <ShellSidebar className="sidebar" onCollapse={onCollapse}>
      <nav className="nav" aria-label="快捷入口">
        <button
          type="button"
          className={`nav-row new-chat${isNewConversation ? ' is-active' : ''}`}
          aria-current={isNewConversation ? 'page' : undefined}
          title="新对话"
          onClick={onStartSession}
        >
          <SquarePen aria-hidden="true" /><span>新对话</span>
        </button>
        <button type="button" className="nav-row" title="临时聊天" onClick={onOpenTemporaryChat}>
          <MessageCirclePlus aria-hidden="true" /><span>临时聊天</span>
        </button>
        <button type="button" className="nav-row" title="插件" onClick={() => onOpenSettings('plugins')}>
          <Package aria-hidden="true" /><span>插件</span>
        </button>
      </nav>
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
        <button className="bottom-row" title="设置" onClick={() => onOpenSettings()}><Settings /><span>设置</span></button>
      </div>
    </ShellSidebar>
  );
}

/** Isolate sidebar from conversation stream/composer re-renders when its props are stable. */
export const AppSidebar = memo(AppSidebarView);
