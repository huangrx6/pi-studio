import { memo } from 'react';
import {
  Activity, ArrowUp, Download, ListChecks, PanelRightOpen,
} from 'lucide-react';
import { GitBranchPicker } from '../features/git/GitBranchPicker';
import { GitRepositoryPicker } from '../features/git/GitRepositoryPicker';
import { LoadingIndicator } from '../shared/LoadingState';
import {
  NotificationCenter,
  type AppNotification,
} from './NotificationCenter';
import { ShellHeader } from './ShellLayout';
import type { GitWorkspaceStatus } from '../types/git-types';

/** 顶栏的更新入口：有可更新时替代侧栏品牌旁的旧徽标。 */
export type UpdateEntryState = 'available' | 'downloading' | 'downloaded';

type ConversationHeaderProps = {
  update?: {
    state: UpdateEntryState;
    latestVersion?: string;
    /** 0–100；下载中用于环形进度。未知时不传。 */
    progress?: number | null;
    onOpen: () => void;
  } | null;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  isNewConversation: boolean;
  title: string;
  gitStatus: GitWorkspaceStatus | null;
  notifications: AppNotification[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onOpenNotificationSession: (id: string) => Promise<void>;
  onRunNotificationAction: (item: AppNotification) => Promise<void>;
  panelExpanded: boolean;
  onOpenPanel: () => void;
  onOpenGit: () => void;
  onOpenProgress: () => void;
  onOpenTrace: () => void;
  activeTool?: 'progress' | 'trace';
  sessionId?: string;
  status?: React.ReactNode;
  extensionMenu?: React.ReactNode;
  /** 轨迹入口遵循「显示代码工作视图」偏好。 */
  showTrace: boolean;
};

function ConversationHeaderComponent({
  sidebarCollapsed,
  onExpandSidebar,
  isNewConversation,
  title,
  gitStatus,
  notifications,
  onMarkAllRead,
  onClearNotifications,
  onOpenNotificationSession,
  onRunNotificationAction,
  panelExpanded,
  onOpenPanel,
  onOpenGit,
  onOpenProgress,
  onOpenTrace,
  activeTool,
  sessionId,
  status,
  extensionMenu,
  showTrace,
  update,
}: ConversationHeaderProps) {
  return (
      <ShellHeader className="chat-header" onExpandSidebar={sidebarCollapsed ? onExpandSidebar : undefined}>
        {!isNewConversation && <div className="chat-heading">
          <h1 title={title}>{title}</h1>
          <GitRepositoryPicker label="顶栏项目仓库" />
          <GitBranchPicker key={sessionId} status={gitStatus} sessionId={sessionId} onOpenGit={onOpenGit} />
        </div>}
        {status && <div className="chat-header-status">{status}</div>}
        <div className="chat-actions">
          {!isNewConversation && <>
            <button type="button" className={`icon-button${activeTool === 'progress' ? ' is-active' : ''}`} aria-pressed={activeTool === 'progress'}
              aria-label="进展" title="进展" onClick={() => onOpenProgress()}><ListChecks aria-hidden="true" /></button>
            {showTrace && <button type="button" className={`icon-button${activeTool === 'trace' ? ' is-active' : ''}`} aria-pressed={activeTool === 'trace'}
              aria-label="轨迹" title="轨迹" onClick={onOpenTrace}><Activity aria-hidden="true" /></button>}
          </>}
          {extensionMenu}
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
            {update.state === 'downloading' && (
              <svg className="update-entry-ring" viewBox="0 0 32 32" aria-hidden="true">
                <circle className="update-entry-ring-track" cx="16" cy="16" r="13" />
                <circle
                  className="update-entry-ring-value"
                  cx="16"
                  cy="16"
                  r="13"
                  style={{
                    strokeDasharray: `${2 * Math.PI * 13}`,
                    strokeDashoffset: `${2 * Math.PI * 13 * (1 - Math.min(1, Math.max(0, (update.progress ?? 8) / 100)))}`,
                  }}
                />
              </svg>
            )}
            {update.state === 'downloading' ? <LoadingIndicator /> : update.state === 'downloaded' ? <ArrowUp /> : <Download />}
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
      </ShellHeader>
  );
}

/** Stable chrome while only the composer or transcript updates underneath. */
export const ConversationHeader = memo(ConversationHeaderComponent);
