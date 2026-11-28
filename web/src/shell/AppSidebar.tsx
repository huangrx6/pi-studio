import {
  CalendarCheck, ChevronsDown, ChevronsRight, FolderPlus,
  History, LayoutGrid, Search, MessageCirclePlus,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { mobileMenu, sidebarSections, teamMenu, type MobileView, type SettingsTab, type SidebarSection, type TeamView } from './app-shell-config';
import { ShellSidebar } from './ShellLayout';
import { HintButton } from '../shared/HintButton';
import { SurfaceActiveContext } from '../shared/surface-visibility';
import { SidebarRail } from './SidebarRail';
import type { PiWorkspace } from './app-types';
import type { TeamRoute } from './TeamCanvas';
import { TeamSidebarProjects } from './TeamSidebarProjects';
import type { ExtensionUiItem } from '../types/extension-types';
import { ExtensionStatusIcon } from '../features/extensions/ExtensionStatusIcon';
import { LoadingState } from '../shared/LoadingState';
import { ConversationListNotice } from './ConversationListNotice';
import type { SidebarWorkspaceActions } from './SidebarWorkspaceList';
import { SidebarWorkspaceList } from './SidebarWorkspaceList';
import { SidebarSearch } from './SidebarSearch';
import type { SidebarSessionFilter } from './sidebar-filter';
import type { SidebarProject } from './sidebar-projects';

import './styles/sidebar-navigation.css';

export { sidebarSections };
export type { MobileView, SidebarSection, TeamView };
export type PlansView = 'plans' | 'runs';

type AppSidebarProps = {
  section: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  plansView: PlansView;
  onPlansViewChange: (view: PlansView) => void;
  teamRoute: TeamRoute;
  onTeamNavigate: (route: TeamRoute) => void;
  mobileView: MobileView;
  onMobileViewChange: (view: MobileView) => void;
  temporaryHistory: readonly { id: string; title: string }[];
  activeTemporaryId: string | null;
  temporaryHistoryLoading?: boolean;
  temporaryHistoryError?: string;
  onRetryTemporaryHistory?: () => void;
  onOpenTemporaryHistory: (id: string) => void;
  onStartSession: () => void;
  onOpenTemporaryChat: () => void;
  onOpenSettings: (page?: SettingsTab) => void;
  launchableApps?: ExtensionUiItem[];
  appHubOpen?: boolean;
  onOpenAppHub: () => void;
  onOpenApp: (panelId: string) => void;
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
  settingsNavigation: ReactNode;
  onRefreshConversationList: () => void;
  sidebarMutating: boolean;
  visibleProjects: SidebarProject<PiWorkspace>[];
  expanded: Set<string>;
  sidebarFiltering: boolean;
  searchCollapsed: Set<string>;
  filterKey: string;
  sidebarCollapsed: boolean;
  sidebarActions: SidebarWorkspaceActions;
  onCollapse: () => void;
};

function NavigationRow({ icon, label, active = false, onClick, className = '', title = label }: {
  icon?: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  className?: string;
  title?: string;
}) {
  return <button type="button" className={`nav-row ${className}${active ? ' is-active' : ''}`}
    title={title} aria-current={active ? 'page' : undefined} onClick={onClick}>
    {icon}<span>{label}</span>
  </button>;
}

function PluginNavigation({ panels, onOpen }: {
  panels: ExtensionUiItem[];
  onOpen: (id: string) => void;
}) {
  const groups = new Map<string, ExtensionUiItem[]>();
  for (const panel of panels) {
    const group = groups.get(panel.extensionId);
    if (group) group.push(panel);
    else groups.set(panel.extensionId, [panel]);
  }
  return <div className="sidebar-context-scroll">
    <h3 className="sidebar-group-title">已安装插件</h3>
    {panels.length === 0 && <p className="sidebar-list-notice">暂无可打开的插件</p>}
    {Array.from(groups, ([extensionId, items]) => <div key={extensionId} className="sidebar-plugin-group">
      {items.length > 1 && <h4>{items[0].extensionName}</h4>}
      {items.map(panel => <NavigationRow key={panel.id}
        icon={<span aria-hidden="true" className="sidebar-plugin-icon"><ExtensionStatusIcon item={panel} /></span>}
        label={items.length > 1 ? panel.title : panel.extensionName}
        onClick={() => onOpen(panel.id)}
      />)}
    </div>)}
  </div>;
}

function AppSidebarView({
  section, onSectionChange, plansView, onPlansViewChange,
  teamRoute, onTeamNavigate, mobileView, onMobileViewChange,
  temporaryHistory, activeTemporaryId, temporaryHistoryLoading,
  temporaryHistoryError, onRetryTemporaryHistory, onOpenTemporaryHistory,
  onStartSession,
  onOpenTemporaryChat,
  onOpenSettings,
  launchableApps = [],
  appHubOpen = false,
  onOpenAppHub,
  onOpenApp,
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
  settingsNavigation,
  onRefreshConversationList,
  sidebarMutating,
  visibleProjects,
  expanded,
  sidebarFiltering,
  searchCollapsed,
  filterKey,
  sidebarCollapsed,
  sidebarActions,
  onCollapse,
}: AppSidebarProps) {
  return (
    <ShellSidebar className="sidebar" label="导航侧边栏" onCollapse={onCollapse}>
      <div className="sidebar-columns">
        <SidebarRail section={settingsOpen ? 'settings' : section} hidden={sidebarCollapsed}
          onSelect={onSectionChange} onSettings={() => onOpenSettings()} />
        {settingsNavigation}
        <SurfaceActiveContext.Provider value={!settingsOpen && !sidebarCollapsed}>
        <div className="sidebar-secondary" hidden={settingsOpen}>
          <section className="sidebar-context" hidden={section !== 'conversations'} aria-label="对话菜单">
            <NavigationRow icon={<MessageCirclePlus />} label="新聊天" className="new-chat"
              active={isNewConversation} onClick={onStartSession} />
            <div className="workspace-head">
              <span>项目</span>
              <div>
                {workspaces.length > 0 && <>
                  <HintButton className="icon-button" aria-expanded={allExpanded}
                    aria-label={allExpanded ? '收起所有工作区' : '展开所有工作区'} onClick={onToggleAllExpanded}>
                    {allExpanded ? <ChevronsDown aria-hidden="true" /> : <ChevronsRight aria-hidden="true" />}
                  </HintButton>
                  <HintButton ref={workspaceSearchTrigger} className={`icon-button ${workspaceSearchOpen ? 'is-active' : ''}`} aria-label="搜索工作区" aria-expanded={workspaceSearchOpen} hint="搜索工作区或会话" onClick={() => {
                    if (workspaceSearchOpen) onCloseWorkspaceSearch();
                    else onOpenWorkspaceSearch();
                  }}><Search /></HintButton>
                </>}
                <HintButton className="icon-button" onClick={onChooseFile} aria-label="打开工作区" hint="添加工作区">
                  <FolderPlus aria-hidden="true" />
                </HintButton>
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
              projects={visibleProjects}
              loading={stateLoading}
              hasWorkspaces={workspaces.length > 0}
              onOpenRoom={(cwd, roomId) => onTeamNavigate({ view: 'workspace', cwd, roomId })}
              activeWorkspace={workspace}
              activeSessionId={sessionId}
              expanded={expanded}
              filtering={sidebarFiltering}
              searchCollapsed={searchCollapsed}
              filterKey={filterKey}
              visible={section === 'conversations' && !sidebarCollapsed && !settingsOpen}
              actions={sidebarActions}
            />
          </section>
          {section === 'temporary' && <section className="sidebar-context" aria-label="临时对话菜单">
            <NavigationRow icon={<MessageCirclePlus />} label="新建临时对话"
              active={!temporaryHistory.some(chat => chat.id === activeTemporaryId)}
              onClick={onOpenTemporaryChat} />
            <div className="sidebar-context-scroll">
              <h3 className="sidebar-group-title">对话记录</h3>
              {temporaryHistoryLoading && !temporaryHistory.length && <LoadingState className="sidebar-list-notice">正在读取记录…</LoadingState>}
              {temporaryHistoryError ? <div className="sidebar-list-notice" role="alert">
                {temporaryHistoryError}
                {onRetryTemporaryHistory && <button type="button" onClick={onRetryTemporaryHistory}>重试</button>}
              </div> : !temporaryHistoryLoading && !temporaryHistory.length && <p className="sidebar-list-notice">暂无临时对话记录</p>}
              {temporaryHistory.map(chat => <NavigationRow key={chat.id}
                label={chat.title || '临时对话'} active={chat.id === activeTemporaryId}
                onClick={() => onOpenTemporaryHistory(chat.id)} />)}
            </div>
          </section>}
          {section === 'plugins' && <section className="sidebar-context" aria-label="插件菜单">
            <NavigationRow icon={<LayoutGrid />} label="插件目录" active={appHubOpen} onClick={onOpenAppHub} />
            <PluginNavigation panels={launchableApps} onOpen={onOpenApp} />
          </section>}
          {section === 'plans' && <nav className="sidebar-context" aria-label="计划菜单">
            <NavigationRow icon={<CalendarCheck />} label="计划列表" active={plansView === 'plans'}
              onClick={() => onPlansViewChange('plans')} />
            <NavigationRow icon={<History />} label="运行记录" active={plansView === 'runs'}
              onClick={() => onPlansViewChange('runs')} />
          </nav>}
          {section === 'team' && <nav className="sidebar-context" aria-label="团队菜单">
            {teamMenu.map(({ id, label, icon: Icon }) =>
              <NavigationRow key={id} icon={<Icon />} label={label}
                active={teamRoute.view === id && !(teamRoute.view === 'workspace' && teamRoute.cwd)} onClick={() => onTeamNavigate({ view: id })} />)}
            <TeamSidebarProjects workspaces={workspaces} expanded={expanded} route={teamRoute} navigate={onTeamNavigate}
              toggle={(key, open) => sidebarActions.onToggleWorkspace(key, open, false)} />
          </nav>}
          {section === 'mobile' && <nav className="sidebar-context" aria-label="手机端菜单">
            {mobileMenu.map(({ id, label, icon: Icon }) =>
              <NavigationRow key={id} icon={<Icon />} label={label}
                active={mobileView === id} onClick={() => onMobileViewChange(id)} />)}
          </nav>}
        </div>
        </SurfaceActiveContext.Provider>
      </div>
    </ShellSidebar>
  );
}

/** Isolate sidebar from conversation stream/composer re-renders when its props are stable. */
export const AppSidebar = memo(AppSidebarView);
