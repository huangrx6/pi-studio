import {
  ArrowUp, Download, GitBranch, LoaderCircle, PanelLeft, PanelRightOpen,
} from 'lucide-react';
import {
  NotificationCenter,
  type AppNotification,
} from './NotificationCenter';
import type { ExtensionChipEntry, ExtensionChips } from '../features/extensions/ExtensionChips';
import { ConversationWorkspaceMenu } from './ConversationWorkspaceMenu';
import type { ExtensionSettingsPage, ExtensionUiSnapshot } from '../types/extension-types';
import type { GitWorkspaceStatus } from '../types/git-types';

/** 顶栏的更新入口：有可更新时替代侧栏品牌旁的旧徽标。 */
export type UpdateEntryState = 'available' | 'downloading' | 'downloaded';

type ConversationHeaderProps = {
  update?: {
    state: UpdateEntryState;
    latestVersion?: string;
    onOpen: () => void;
  } | null;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  isNewConversation: boolean;
  title: string;
  gitStatus: GitWorkspaceStatus | null;
  agentKind: 'conversation' | 'agents' | 'extensions' | 'trace';
  subagentCount: number;
  hasActiveSubagents: boolean;
  extensionCount: number;
  notifications: AppNotification[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onOpenNotificationSession: (id: string) => Promise<void>;
  onRunNotificationAction: (item: AppNotification) => Promise<void>;
  panelExpanded: boolean;
  onOpenPanel: () => void;
  onReturnToMainAgent: () => void;
  onOpenAgentOverview: () => void;
  onOpenConversationExtensionHub: () => void;
  /** 扩展声明的顶栏 chip（status.chip），点击打开各自的详情面板。 */
  chips: ExtensionChipEntry[];
  extensionSurface: ExtensionUiSnapshot;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenChip: (chip: ExtensionChipEntry) => void;
  onOpenExtensionSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPromptFromExtension?: (text: string, submit: boolean) => void;
  onNotifyExtension?: React.ComponentProps<typeof ExtensionChips>['onNotify'];
  onOpenTrace: () => void;
  /** 「显示代码工作视图」关闭时，工作区面板不显示轨迹入口。 */
  showTrace: boolean;
};

export function ConversationHeader({
  sidebarCollapsed,
  onExpandSidebar,
  isNewConversation,
  title,
  gitStatus,
  agentKind,
  subagentCount,
  hasActiveSubagents,
  extensionCount,
  notifications,
  onMarkAllRead,
  onClearNotifications,
  onOpenNotificationSession,
  onRunNotificationAction,
  panelExpanded,
  onOpenPanel,
  onReturnToMainAgent,
  onOpenAgentOverview,
  onOpenConversationExtensionHub,
  chips,
  extensionSurface,
  cwd,
  sessionId,
  modelRef,
  onOpenChip,
  onOpenExtensionSettings,
  onSendPromptFromExtension,
  onNotifyExtension,
  onOpenTrace,
  showTrace,
  update,
}: ConversationHeaderProps) {
  return (
    <>
      <header className="chat-header">
        {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={onExpandSidebar}><PanelLeft /></button>}
        {!isNewConversation && <div className="chat-heading">
          <h1>{title}</h1>
          <GitWorkspaceSummary status={gitStatus} />
        </div>}
        <div className="chat-actions">
          {!isNewConversation && <ConversationWorkspaceMenu
            agentKind={agentKind}
            subagentCount={subagentCount}
            hasActiveSubagents={hasActiveSubagents}
            extensionCount={extensionCount}
            chips={chips}
            extensionSurface={extensionSurface}
            cwd={cwd}
            sessionId={sessionId}
            modelRef={modelRef}
            onReturnToMainAgent={onReturnToMainAgent}
            onOpenAgentOverview={onOpenAgentOverview}
            onOpenConversationExtensionHub={onOpenConversationExtensionHub}
            onOpenTrace={showTrace ? onOpenTrace : undefined}
            onOpenChip={onOpenChip}
            onOpenExtensionSettings={onOpenExtensionSettings}
            onSendPromptFromExtension={onSendPromptFromExtension}
            onNotifyExtension={onNotifyExtension}
          />}
          {update && <button
            type="button"
            className={`icon-button update-entry is-${update.state}`}
            aria-label={update.state === 'downloaded'
              ? '更新已下载，点击安装'
              : update.state === 'downloading'
                ? '正在下载更新，点击查看进度'
                : `有新版本${update.latestVersion ? ` v${update.latestVersion}` : ''}，点击查看`}
            title={update.state === 'downloaded'
              ? '更新已下载，点击安装'
              : update.state === 'downloading'
                ? '正在下载更新'
                : `发现新版本${update.latestVersion ? ` v${update.latestVersion}` : ''}`}
            onClick={update.onOpen}
          >
            {update.state === 'downloading' ? <LoaderCircle className="spin" /> : update.state === 'downloaded' ? <ArrowUp /> : <Download />}
          </button>}
          <NotificationCenter
            items={notifications}
            onMarkAllRead={onMarkAllRead}
            onClear={onClearNotifications}
            onOpenSession={onOpenNotificationSession}
            onRunAction={onRunNotificationAction}
          />
          <button
            type="button"
            className="icon-button panel-open-entry"
            aria-label="打开右侧面板"
            aria-hidden={panelExpanded || undefined}
            disabled={panelExpanded}
            title="打开右侧面板"
            onClick={onOpenPanel}
          >
            <PanelRightOpen />
          </button>
        </div>
      </header>
    </>
  );
}

function GitWorkspaceSummary({ status }: { status: GitWorkspaceStatus | null }) {
  if (!status) return <span className="git-workspace-summary is-loading" aria-label="正在读取 Git 状态" />;
  if (!status.available) return <span className="git-workspace-summary is-unavailable" title="当前目录不是 Git 仓库">非 Git 项目</span>;
  const dirty = status.dirty.total;
  const worktree = status.worktree.isWorktree ? status.worktree.name : undefined;
  return <div className="git-workspace-summary" title={status.repositoryRoot || undefined} aria-label="Git 工作区状态">
    {status.branch && <span className="git-workspace-branch"><GitBranch aria-hidden="true" />{status.branch}</span>}
    {status.commit && <span className="git-workspace-commit">{status.commit}</span>}
    <span className={`git-workspace-dirty ${dirty ? 'is-dirty' : ''}`}>{dirty ? `${dirty} 项变更` : '干净'}</span>
    {worktree && <span className="git-workspace-worktree">工作树 · {worktree}</span>}
  </div>;
}
