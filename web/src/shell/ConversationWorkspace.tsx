import { lazy, memo, Suspense, useEffect, useMemo, type ComponentProps } from 'react';
import { ChevronLeft } from 'lucide-react';
import { LoadingState } from '../shared/LoadingState';
import { ComposerDock } from '../features/conversation/ComposerDock';
import { useConversationSearch } from '../features/conversation/useConversationSearch';
import { ConversationSearchBar } from './ConversationSearchBar';
import { ConversationTranscriptPane } from './ConversationTranscriptPane';
import type { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import type { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import {
  type OutlineItem,
} from '../features/conversation/outline-model';
import {
  ConversationExtensionDock,
  ConversationExtensionHub,
} from '../features/extensions/ConversationExtensionHub';
import { ExtensionSlot } from '../features/extensions/ExtensionSlot';
import type { Preferences } from '../shared/preferences';
import type { AppNotification } from './NotificationCenter';
import type { AgentView } from './app-types';
import type { ModelSelection } from '../types/model-types';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import type {
  ConversationExtensionLayout,
  ConversationExtensionOrderScope,
  ConversationExtensionUiPreferences,
  ExtensionSettingsPage,
  ExtensionUiItem,
} from '../types/extension-types';
import { ConversationHeader } from './ConversationHeader';
import { scopedExtensionChips } from '../features/extensions/extension-chip-scope';
import { ConversationTracePage } from './ConversationTraceMenu';
import { buildTraceSummary } from '../features/conversation/trace-model';

const GitWorkspacePage = lazy(() => import('../features/git/GitWorkspacePage'));
const ConversationTasksPage = lazy(() => import('../features/conversation/ConversationTasksPage'));

const SubagentOverview = lazy(async () => {
  const module = await import('../features/subagents/SubagentViews');
  return { default: module.SubagentOverview };
});
const SubagentTranscriptView = lazy(async () => {
  const module = await import('../features/subagents/SubagentViews');
  return { default: module.SubagentTranscriptView };
});

type SessionView = {
  id: string;
  cwd: string;
  title: string;
  turnDiffs?: TurnDiff[];
  longTask?: { updatedAt: number };
} | null;

type ConversationShell = {
  isNewConversation: boolean;
  sessionLoading: boolean;
  messageCount: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  agentView: AgentView;
  session: SessionView;
  modelSelection: ModelSelection;
  preferences: Preferences;
  turnActive: boolean;
  /** 提交已写入但本轮还没结束：编辑必须和主进程一样等到空闲。 */
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  compaction: { active: boolean; reason?: string };
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  liveDiff: TurnDiff | null;
  notificationCount: number;
  notifications: AppNotification[];
  setNotifications: React.Dispatch<React.SetStateAction<AppNotification[]>>;
  markAllRead: () => void;
  clearNotifications: () => void;
  conversationSubscriptionError: {
    sessionId: string;
    message: string;
    retrying: boolean;
  } | null;
  retryConversationSubscription: () => void;
  settingsOpen: boolean;
};

type HeaderState = {
  /** 顶栏更新入口；没有可更新目标时为 null。 */
  update: ComponentProps<typeof ConversationHeader>['update'];
  quotaProvider?: ComponentProps<typeof ConversationHeader>['quotaProvider'];
  conversationDetailExtensionCount: number;
  openNotificationSession: (id: string) => Promise<void>;
  runNotificationAction: (item: AppNotification) => Promise<void>;
  panelExpanded: boolean;
  openPanel: () => void;
  returnToMainAgent: () => void;
  gitStatus: ComponentProps<typeof ConversationHeader>['gitStatus'];
  openGit: (tab: import('../types/git-types').GitTab) => void;
  progressTrigger: React.ReactNode;
  openConversationExtensionHub: () => void;
  openTrace: () => void;
};

type ExtensionWorkspaceState = {
  chipItems: Array<{ item: ExtensionUiItem; targetId: string }>;
  openItem: (id: string) => void;
  openChip: (chip: { item: ExtensionUiItem; targetId: string }) => void;
  surface: ComponentProps<typeof ConversationExtensionDock>['surface'];
  hubItems: ExtensionUiItem[];
  activeItem: ExtensionUiItem | null;
  preferences: ConversationExtensionUiPreferences;
  orderScope: ConversationExtensionOrderScope;
  setOrderScope: (scope: ConversationExtensionOrderScope) => void;
  hasSessionOrder: boolean;
  updateUi: (patch: Parameters<typeof import('../features/conversation/conversation-extension-order').applyConversationExtensionUiPatch>[1]) => Promise<boolean>;
  openSettings: (page?: ExtensionSettingsPage) => void;
  sendPrompt: (text: string, submit: boolean) => void;
  notify: ComponentProps<typeof ExtensionSlot>['onNotify'];
  openHub: () => void;
};

type OutlineState = {
  items: OutlineItem[];
  samples: ReturnType<typeof useTranscriptNavigation>['outlineSamples'];
  active: number;
  jump: (index: number) => void;
};

type ConversationActions = {
  openGitFile: (root: string, path: string) => void;
  openAttachment: (path: string) => void;
  openFile: (path: string) => void;
  undoTurnDiff: (at: number) => Promise<void>;
  openChanges: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  editMessage: (entryId: number, text: string) => Promise<void>;
};

export type ConversationWorkspaceProps = {
  shell: ConversationShell;
  header: HeaderState;
  actions: ConversationActions;
  transcript: ReturnType<typeof useTranscriptNavigation> & {
    /** 重新载入最新窗口（跳转截断后的回到底部）。 */
    resetToLatest: () => Promise<void>;
    /** 当前窗口是否缺少较新的一段。 */
    transcriptTruncated: boolean;
  };
  extensions: ExtensionWorkspaceState;
  subagents: ReturnType<typeof useSubagentWorkspace>;
  outline: OutlineState;
  composer: ComponentProps<typeof ComposerDock>;
};

function ConversationWorkspaceComponent({
  shell,
  header,
  actions,
  transcript,
  extensions,
  subagents,
  outline,
  composer,
}: ConversationWorkspaceProps) {
  const {
    isNewConversation,
    sessionLoading,
    messageCount,
    sidebarCollapsed,
    setSidebarCollapsed,
    agentView,
    session,
    modelSelection,
    preferences,
    turnActive,
    busy,
    error,
    setError,
    compaction,
    retryInfo,
    liveDiff,
    notifications,
    setNotifications,
    markAllRead,
    clearNotifications,
    conversationSubscriptionError,
    retryConversationSubscription,
    settingsOpen,
  } = shell;
  const {
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    requestPlacement,
    jumpToMessage,
  } = transcript;

  const search = useConversationSearch({ sessionId: session?.id, onJump: jumpToMessage });
  const searchOpen = search.state.open;
  // 搜索只属于已有会话的正文视图；新会话、扩展中心、子智能体和轨迹页
  // 都没有可供搜索的当前会话正文，不应显示或响应 ⌘F / Ctrl+F。
  const searchEnabled = Boolean(session?.id) && agentView.kind === 'conversation';

  useEffect(() => {
    if (!searchEnabled && searchOpen) search.close();
  }, [search.close, searchEnabled, searchOpen]);

  // ⌘F / Ctrl+F 打开对话搜索；焦点在终端里时让终端自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!searchEnabled) return;
      if (event.isComposing) return;
      const primary = event.metaKey || event.ctrlKey;
      if (!primary || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.terminal-host')) return;
      if (target?.closest?.('.file-panel')) return;
      event.preventDefault();
      if (searchOpen) { search.close(); return; }
      search.open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search, searchEnabled, searchOpen]);
  // 轨迹页只在「显示代码工作视图」开启时出现；关闭后回落到对话视图。
  const traceEnabled = preferences.showCodeView;
  const showTrace = agentView.kind === 'trace' && traceEnabled;
  const transcriptVisible = agentView.kind === 'conversation' || (agentView.kind === 'trace' && !traceEnabled);
  const headerKind = agentView.kind === 'trace' && !traceEnabled ? 'conversation' : agentView.kind;
  const traceSummary = useMemo(() => buildTraceSummary({
    turns: transcriptTurns,
    toolResults: toolResultMap,
    requestPlacement,
    turnActive,
  }), [transcriptTurns, toolResultMap, requestPlacement, turnActive]);
  const lastAssistantTurn = transcriptTurns[lastAssistantTurnIndex];
  const lastAssistantError = lastAssistantTurn?.kind === 'assistant'
    ? lastAssistantTurn.messages.at(-1)?.errorMessage
    : undefined;
  // chip 属于会话视图：草稿态没有 session，交给纯函数统一裁掉。
  const scopedChips = scopedExtensionChips(session?.id, extensions.chipItems);
  const showSessionError = Boolean(error)
    && !(Boolean(error) && !turnActive && lastAssistantError === error);


  return (
    <>
      <ConversationHeader
        update={header.update}
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        isNewConversation={isNewConversation}
        title={agentView.kind === 'agents' && agentView.child
            ? `${agentView.child.name || agentView.child.agent} · 子智能体`
            : (session?.title || 'Pi Studio')}
        gitStatus={header.gitStatus}
        progressTrigger={header.progressTrigger}
        agentKind={headerKind}
        extensionCount={header.conversationDetailExtensionCount}
        notifications={notifications}
        onMarkAllRead={markAllRead}
        onClearNotifications={clearNotifications}
        onOpenNotificationSession={header.openNotificationSession}
        onRunNotificationAction={header.runNotificationAction}
        panelExpanded={header.panelExpanded}
        onOpenPanel={header.openPanel}
        onReturnToMainAgent={header.returnToMainAgent}
        onOpenConversationExtensionHub={header.openConversationExtensionHub}
        quotaProvider={header.quotaProvider}
        chips={scopedChips}
        extensionSurface={extensions.surface}
        cwd={session?.cwd}
        sessionId={session?.id}
        modelRef={modelSelection.modelRef}
        onOpenChip={extensions.openChip}
        onOpenExtensionSettings={extensions.openSettings}
        onSendPromptFromExtension={extensions.sendPrompt}
        onNotifyExtension={extensions.notify}
        onOpenTrace={header.openTrace}
        showTrace={traceEnabled}
      />
      <main className={`main shell-canvas ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
        <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
      {searchEnabled && searchOpen && <ConversationSearchBar
        state={search.state}
        onQueryChange={search.setQuery}
        onStep={(direction) => { void search.step(direction); }}
        onClose={search.close}
      />}
      {!isNewConversation && transcriptVisible && <ConversationTranscriptPane
        sessionId={session?.id}
        sessionCwd={session?.cwd}
        messageCount={messageCount}
        turnActive={turnActive}
        busy={busy}
        compactionActive={compaction.active}
        error={error}
        setError={setError}
        retryInfo={retryInfo}
        liveDiff={liveDiff}
        turnDiffs={session?.turnDiffs}
        preferences={preferences}
        settingsOpen={settingsOpen}
        conversationSubscriptionError={conversationSubscriptionError}
        retryConversationSubscription={retryConversationSubscription}
        showSessionError={showSessionError}
        transcript={transcript}
        outline={outline}
        actions={actions}
      />}

      {!isNewConversation && agentView.kind === 'extensions' && <div className="conversation-extension-scroll">
        <div className="conversation-extension-column">
          {extensions.activeItem
            ? <>
              <div className="extension-panel-bar">
                <button type="button" onClick={extensions.openHub}><ChevronLeft />扩展中心</button>
                <span>{extensions.activeItem.title}</span>
              </div>
              <ExtensionSlot
                slot={extensions.activeItem.slot}
                presentation="page"
                snapshot={extensions.surface}
                selectedItemId={extensions.activeItem.id}
                cwd={session?.cwd}
                sessionId={session?.id}
                modelRef={modelSelection.modelRef}
                onOpenSettings={extensions.openSettings}
                onSendPrompt={extensions.sendPrompt}
                onNotify={extensions.notify}
              />
            </>
            : <ConversationExtensionHub
              onOpenItem={extensions.openItem}
              items={extensions.hubItems}
              surface={extensions.surface}
              sessionId={session?.id || 'new'}
              cwd={session?.cwd}
              modelRef={modelSelection.modelRef}
              layout={extensions.preferences.layout}
              orderScope={extensions.orderScope}
              hasSessionOverride={extensions.hasSessionOrder}
              onLayoutChange={(layout: ConversationExtensionLayout) => {
                void extensions.updateUi({ layout });
              }}
              onOrderScopeChange={extensions.setOrderScope}
              onOrderChange={(extensionIds) => {
                if (extensions.orderScope === 'session' && session?.id) {
                  void extensions.updateUi({ sessionId: session.id, sessionOrder: extensionIds });
                } else {
                  void extensions.updateUi({ globalOrder: extensionIds });
                }
              }}
              onRestoreGlobalOrder={() => {
                if (!session?.id) return;
                void (async () => {
                  const saved = await extensions.updateUi({ sessionId: session.id, sessionOrder: null });
                  if (saved) extensions.setOrderScope('global');
                })();
              }}
              onOpenSettings={extensions.openSettings}
              onSendPrompt={extensions.sendPrompt}
              onNotify={extensions.notify}
            />}
        </div>
      </div>}

      {!isNewConversation && showTrace && <ConversationTracePage key={session?.id} summary={traceSummary} />}

      {session && agentView.kind === 'git' && <Suspense fallback={<LoadingState variant="panel">正在读取 Git…</LoadingState>}>
        <GitWorkspacePage key={session.id} sessionId={session.id} tab={agentView.tab} onTab={header.openGit} diffPreferences={preferences} openFile={actions.openGitFile} />
      </Suspense>}
      {session && agentView.kind === 'tasks' && <Suspense fallback={<LoadingState variant="panel">正在读取任务…</LoadingState>}>
        <ConversationTasksPage key={session.id} sessionId={session.id} goalUpdatedAt={session.longTask?.updatedAt} />
      </Suspense>}
      {agentView.kind === 'agents' && (
        <div className="agent-workspace">
          <Suspense fallback={
            <LoadingState variant="panel">正在加载子智能体…</LoadingState>
          }>
            <SubagentOverview
              hidden={Boolean(agentView.child)}
              children={subagents.subagentChildren}
              budget={subagents.subagentBudget}
              selection={modelSelection}
              refreshing={subagents.subagentRefreshing}
              error={subagents.subagentListError}
              onRefresh={() => void subagents.refreshSubagentChildren(true)}
              onOpenChild={subagents.openAgentTranscript}
              onDeleteChild={(child) => void subagents.deleteSubagent(child)}
              onReplyChild={subagents.replySubagentSupervisor}
              deletingChildKey={subagents.subagentDeletingKey || undefined}
              replyingChildKey={subagents.subagentReplyingKey || undefined}
              onReturnMain={header.returnToMainAgent}
              mode={subagents.subagentOverviewMode}
              onModeChange={subagents.setSubagentOverviewMode}
            />
            {agentView.child && (
              <SubagentTranscriptView
                key={agentView.child.key}
                child={agentView.child}
                onRetry={() => { if (agentView.child) subagents.openAgentTranscript(agentView.child); }}
                transcript={subagents.subagentTranscript}
                loading={subagents.subagentLoading}
                error={subagents.subagentError}
                stepDisplay={preferences.stepDisplay}
                stepCollapse={preferences.stepCollapse}
                showCodeView={preferences.showCodeView}
                onBackMain={header.returnToMainAgent}
                onOverview={subagents.openAgentOverview}
                onOpenFile={actions.openFile}
              />
            )}
          </Suspense>
        </div>
      )}
      <ComposerDock {...composer} open={transcriptVisible} />
      </main>
    </>
  );
}

/** Prefer stable prop bags from App; shallow memo still skips pure chrome-only parent renders. */
export const ConversationWorkspace = memo(ConversationWorkspaceComponent);
