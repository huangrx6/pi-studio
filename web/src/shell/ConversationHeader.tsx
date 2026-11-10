import {
  ArrowUp, Bot, Download, LoaderCircle, MessageSquare, PanelLeft, PanelRightClose, PanelRightOpen, Plug,
} from 'lucide-react';
import {
  NotificationCenter,
  type AppNotification,
} from './NotificationCenter';
import { ConversationTraceTab, type ConversationTraceSummary } from './ConversationTraceMenu';
import { ExtensionChips, type ExtensionChipEntry } from '../features/extensions/ExtensionChips';
import type { ExtensionSettingsPage, ExtensionUiItem, ExtensionUiSnapshot } from '../types/extension-types';

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
  agentKind: 'conversation' | 'agents' | 'extensions' | 'trace';
  subagentCount: number;
  hasActiveSubagents: boolean;
  extensionCount: number;
  notifications: AppNotification[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onOpenNotificationSession: (id: string) => Promise<void>;
  onRunNotificationAction: (item: AppNotification) => Promise<void>;
  filesOpen: boolean;
  onTogglePanel: () => void;
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
  /** 「显示代码工作视图」关闭时，轨迹标签不出现。 */
  showTrace: boolean;
  traceSummary: ConversationTraceSummary;
};

export function ConversationHeader({
  sidebarCollapsed,
  onExpandSidebar,
  isNewConversation,
  title,
  agentKind,
  subagentCount,
  hasActiveSubagents,
  extensionCount,
  notifications,
  onMarkAllRead,
  onClearNotifications,
  onOpenNotificationSession,
  onRunNotificationAction,
  filesOpen,
  onTogglePanel,
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
  traceSummary,
  update,
}: ConversationHeaderProps) {
  return (
    <>
      <header className="chat-header">
        {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={onExpandSidebar}><PanelLeft /></button>}
        {!isNewConversation && <div className="chat-heading">
          <h1>{title}</h1>
        </div>}
        <div className="chat-actions">
          <ExtensionChips
            chips={chips}
            surface={extensionSurface}
            cwd={cwd}
            sessionId={sessionId}
            modelRef={modelRef}
            onOpenChip={onOpenChip}
            onOpenSettings={onOpenExtensionSettings}
            onSendPrompt={onSendPromptFromExtension}
            onNotify={onNotifyExtension}
          />
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
            className={`icon-button ${filesOpen ? 'is-active' : ''}`}
            aria-label={filesOpen ? '收起右侧面板' : '打开右侧面板'}
            aria-pressed={filesOpen}
            title={filesOpen ? '收起右侧面板' : '打开右侧面板'}
            onClick={onTogglePanel}
          >
            {filesOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </button>
        </div>
      </header>
      {!isNewConversation && <div className="chat-tabs">
        <div className="chat-tab-list" role="tablist" aria-label="对话视图">
          <button type="button" role="tab" aria-selected={agentKind === 'conversation'} className={`tab ${agentKind === 'conversation' ? 'is-active' : ''}`} onClick={onReturnToMainAgent}><MessageSquare /><span>对话</span></button>
          <button type="button" role="tab" aria-selected={agentKind === 'agents'} className={`tab agent-tab ${agentKind === 'agents' ? 'is-active' : ''}`} onClick={onOpenAgentOverview}>
            <Bot />
            <span className="tab-label">
              子智能体

            </span>
          </button>
          {extensionCount > 0 && <button
            type="button"
            role="tab"
            aria-selected={agentKind === 'extensions'}
            className={`tab extension-tab ${agentKind === 'extensions' ? 'is-active' : ''}`}
            title="当前会话的扩展视图"
            onClick={onOpenConversationExtensionHub}
          >
            <Plug />
            <span className="tab-label">扩展</span>
          </button>}
          {showTrace && <ConversationTraceTab summary={traceSummary} active={agentKind === 'trace'} onOpen={onOpenTrace} />}
        </div>
      </div>}
    </>
  );
}
