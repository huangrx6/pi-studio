import {
  Bot, Columns2, MessageSquare, PanelLeft, PanelRightClose, PanelRightOpen, Plug,
} from 'lucide-react';
import {
  NotificationCenter,
  type AppNotification,
} from './NotificationCenter';
import { ConversationTraceTab, type ConversationTraceSummary } from './ConversationTraceMenu';

type ConversationHeaderProps = {
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  isNewConversation: boolean;
  title: string;
  agentKind: 'conversation' | 'agents' | 'comparison' | 'extensions' | 'trace';
  subagentCount: number;
  hasActiveSubagents: boolean;
  comparisonBranchCount: number;
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
  onOpenModelComparison: () => void;
  onOpenConversationExtensionHub: () => void;
  onOpenTrace: () => void;
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
  comparisonBranchCount,
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
  onOpenModelComparison,
  onOpenConversationExtensionHub,
  onOpenTrace,
  traceSummary,
}: ConversationHeaderProps) {
  return (
    <>
      <header className="chat-header">
        {sidebarCollapsed && <button className="icon-button sidebar-expand" aria-label="展开侧边栏" title="展开侧边栏" onClick={onExpandSidebar}><PanelLeft /></button>}
        {!isNewConversation && <div className="chat-heading">
          <h1>{title}</h1>
        </div>}
        <div className="chat-actions">
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
              {subagentCount > 0 && <span
                className={`tab-count agent-tab-count ${hasActiveSubagents ? 'is-live' : ''}`}
                aria-live="polite"
                aria-label={`${subagentCount} 个子智能体${hasActiveSubagents ? '，有任务正在运行' : '，当前无任务运行'}`}
              >{subagentCount}</span>}
            </span>
          </button>
          <button type="button" role="tab" aria-selected={agentKind === 'comparison'} className={`tab comparison-tab ${agentKind === 'comparison' ? 'is-active' : ''}`} onClick={onOpenModelComparison}>
            <Columns2 />
            <span className="tab-label">
              双跑
              {comparisonBranchCount > 0 && <span className="tab-count">{comparisonBranchCount}</span>}
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
            <span className="tab-label">扩展<span className="tab-count">{extensionCount}</span></span>
          </button>}
          <ConversationTraceTab summary={traceSummary} active={agentKind === 'trace'} onOpen={onOpenTrace} />
        </div>
      </div>}
      {isNewConversation && <div className="chat-tabs is-placeholder" aria-hidden="true" />}
    </>
  );
}
