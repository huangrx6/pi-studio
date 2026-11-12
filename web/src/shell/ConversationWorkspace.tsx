import { Fragment, lazy, Suspense, useEffect, useMemo, type ComponentProps } from 'react';
import { ChevronLeft, LoaderCircle } from 'lucide-react';
import { AssistantTurnView, ChatMessageView } from '../features/conversation/ChatMessage';
import { ComposerDock } from '../features/conversation/ComposerDock';
import { ConversationError } from '../features/conversation/ConversationError';
import { ConversationOutline } from '../features/conversation/ConversationOutline';
import { useConversationSearch } from '../features/conversation/useConversationSearch';
import { ConversationSearchBar } from './ConversationSearchBar';
import {
  findTurnDiff,
} from '../features/conversation/file-changes';
import type { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import type { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import {
  NO_ANSWER_TEXT,
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
import {
  isNearBottom,
  nestedScrollableConsumesWheel,
  shouldReleaseFollowOnWheel,
} from '../features/conversation/chat-scroll.mjs';

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
  filesOpen: boolean;
};

type HeaderState = {
  /** 顶栏更新入口；没有可更新目标时为 null。 */
  update: ComponentProps<typeof ConversationHeader>['update'];
  conversationDetailExtensionCount: number;
  openNotificationSession: (id: string) => Promise<void>;
  runNotificationAction: (item: AppNotification) => Promise<void>;
  togglePanel: () => void;
  returnToMainAgent: () => void;
  openAgentOverview: () => void;
  openConversationExtensionHub: () => void;
  openTrace: () => void;
};

type ExtensionWorkspaceState = {
  chipItems: Array<{ item: ExtensionUiItem; targetId: string }>;
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
  hover: number | null;
  setHover: (index: number | null) => void;
  jump: (index: number) => void;
};

type ConversationActions = {
  openAttachment: (path: string) => void;
  openFile: (path: string) => void;
  openChanges: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  editMessage: (entryId: number, text: string) => Promise<void>;
};

export type ConversationWorkspaceProps = {
  shell: ConversationShell;
  header: HeaderState;
  actions: ConversationActions;
  transcript: ReturnType<typeof useTranscriptNavigation>;
  extensions: ExtensionWorkspaceState;
  subagents: ReturnType<typeof useSubagentWorkspace>;
  outline: OutlineState;
  composer: ComponentProps<typeof ComposerDock>;
};

export function ConversationWorkspace({
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
    filesOpen,
  } = shell;
  const {
    scrollRef,
    topSentinelRef,
    chatContentRef,
    turnWindowFrom,
    visibleTurns,
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    nextUserTimestamps,
    requestPlacement,
    pendingAssistantVisible,
    pendingTurnError,
    markUserScrollIntent,
    pauseTranscriptFollow,
    resumeTranscriptFollow,
    handleTranscriptScroll,
    jumpToOutline,
    jumpToMessage,
  } = transcript;

  const search = useConversationSearch({ sessionId: session?.id, onJump: jumpToMessage });
  const searchOpen = search.state.open;

  // ⌘F / Ctrl+F 打开对话搜索；焦点在终端里时让终端自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const primary = event.metaKey || event.ctrlKey;
      if (!primary || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.terminal-host')) return;
      event.preventDefault();
      if (searchOpen) { search.close(); return; }
      search.open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search, searchOpen]);
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
    <main className={`main ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
      <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
      <ConversationHeader
        update={header.update}
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        isNewConversation={isNewConversation}
        title={agentView.kind === 'agents' && agentView.child
            ? `${agentView.child.name || agentView.child.agent} · 子智能体`
            : (session?.title || 'Pi Studio')}
        agentKind={headerKind}
        subagentCount={subagents.subagentChildren.length}
        hasActiveSubagents={subagents.hasActiveSubagents}
        extensionCount={header.conversationDetailExtensionCount}
        notifications={notifications}
        onMarkAllRead={markAllRead}
        onClearNotifications={clearNotifications}
        onOpenNotificationSession={header.openNotificationSession}
        onRunNotificationAction={header.runNotificationAction}
        filesOpen={filesOpen}
        onTogglePanel={header.togglePanel}
        onReturnToMainAgent={header.returnToMainAgent}
        onOpenAgentOverview={header.openAgentOverview}
        onOpenConversationExtensionHub={header.openConversationExtensionHub}
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
        traceSummary={traceSummary}
      />
      {searchOpen && <ConversationSearchBar
        state={search.state}
        onQueryChange={search.setQuery}
        onStep={(direction) => { void search.step(direction); }}
        onClose={search.close}
      />}
      {!isNewConversation && transcriptVisible && <div
        className="chat-scroll"
        ref={scrollRef}
        onWheel={(event) => {
          if (!event.deltaY) return;
          if (nestedScrollableConsumesWheel(event.target, event.currentTarget, event.deltaY)) return;
          markUserScrollIntent();
          if (shouldReleaseFollowOnWheel({ deltaX: event.deltaX, deltaY: event.deltaY, nestedScrollable: false })) {
            pauseTranscriptFollow();
          } else if (event.deltaY > 0 && isNearBottom(event.currentTarget)) {
            resumeTranscriptFollow();
          }
        }}
        onTouchMove={() => {
          markUserScrollIntent();
          pauseTranscriptFollow();
        }}
        onPointerDown={() => {
          markUserScrollIntent();
          pauseTranscriptFollow();
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 0) markUserScrollIntent();
        }}
        onKeyDown={(event) => {
          if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
            markUserScrollIntent();
            pauseTranscriptFollow();
          } else if (event.key === 'PageDown' || event.key === 'ArrowDown' || event.key === 'End') {
            markUserScrollIntent();
          }
        }}
        onScroll={handleTranscriptScroll}
      >
        <div className="chat-column" ref={chatContentRef}>
          {messageCount > 0 && (
            <div className="messages">
              {/* 顶部哨兵：先展开已渲染的轮次，再向主进程要更早的一页 */}
              <div ref={topSentinelRef} className="transcript-window-sentinel" aria-hidden="true" />
              {visibleTurns.map((turn, offset) => {
                const index = offset + turnWindowFrom;
                if (turn.kind === 'user') {
                  return <Fragment key={`user-${turn.message.sourceIndex ?? turn.message.timestamp ?? index}`}>
                    <ChatMessageView
                      id={`chat-turn-${turn.message.sourceIndex ?? `pending-${turn.message.timestamp ?? index}`}`}
                      message={turn.message}
                      onOpenFile={actions.openAttachment}
                      onEdit={actions.editMessage}
                      editDisabled={turnActive || busy || compaction.active}
                    />
                    {requestPlacement.unansweredByUserTurn.has(index) && <AssistantTurnView messages={[]} toolResults={toolResultMap} requestTraces={requestPlacement.unansweredByUserTurn.get(index)} cwd={session?.cwd} busy={false} turnError={NO_ANSWER_TEXT} stepDisplay={preferences.stepDisplay} stepCollapse={preferences.stepCollapse} showCodeView={false} />}
                  </Fragment>;
                }
                return <AssistantTurnView
                  key={`assistant-${turn.messages[0]?.sourceIndex ?? turn.messages[0]?.timestamp ?? index}`}
                  id={turn.messages[0]?.sourceIndex !== undefined ? `chat-assistant-turn-${turn.messages[0].sourceIndex}` : undefined}
                  messages={turn.messages}
                  toolResults={toolResultMap}
                  requestTraces={requestPlacement.byAssistantTurn.get(index)}
                  cwd={session?.cwd}
                  busy={turnActive && index === transcriptTurns.length - 1}
                  retry={index === lastAssistantTurnIndex && retryInfo ? retryInfo : undefined}
                  stepDisplay={preferences.stepDisplay}
                  stepCollapse={preferences.stepCollapse}
                  showCodeView={preferences.showCodeView}
                  gitDiff={index === lastAssistantTurnIndex && liveDiff ? liveDiff : findTurnDiff(session?.turnDiffs, { from: turn.messages.at(-1)?.timestamp, until: nextUserTimestamps[index] })}
                  onOpenDiff={actions.openChanges}
                  onOpenFile={actions.openFile}
                />;
              })}
              {pendingAssistantVisible && (
                <AssistantTurnView
                  key={`assistant-pending-${requestPlacement.pending[0]?.id || messageCount}`}
                  messages={[]}
                  toolResults={toolResultMap}
                  requestTraces={requestPlacement.pending}
                  cwd={session?.cwd}
                  busy={turnActive}
                  turnError={pendingTurnError}
                  retry={turnActive ? retryInfo ?? undefined : undefined}
                  stepDisplay={preferences.stepDisplay}
                  stepCollapse={preferences.stepCollapse}
                  showCodeView={false}
                />
              )}
            </div>
          )}
          {conversationSubscriptionError && conversationSubscriptionError.sessionId === session?.id && <ConversationError
            message={conversationSubscriptionError.message}
            actionLabel="重新连接"
            actionBusy={conversationSubscriptionError.retrying}
            onAction={retryConversationSubscription}
          />}
          {showSessionError && (!pendingAssistantVisible || turnActive) && <ConversationError message={error!} onDismiss={() => setError(null)} />}
        </div>
      </div>}

      {!isNewConversation && agentView.kind === 'extensions' && <div className="conversation-extension-scroll">
        <div className="chat-column">
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

      {!settingsOpen && !filesOpen && !isNewConversation && transcriptVisible && outline.items.length > 1 && (
        <ConversationOutline
          items={outline.items}
          samples={outline.samples}
          activeIndex={outline.active}
          hoverIndex={outline.hover}
          onHover={outline.setHover}
          onJump={outline.jump}
        />
      )}
      {agentView.kind === 'agents' && (
        <div className="agent-workspace">
          <Suspense fallback={
            <div className="agent-transcript-loading" role="status" aria-label="正在加载子智能体视图">
              <LoaderCircle className="spin" aria-hidden="true" />
              正在加载子智能体…
            </div>
          }>
            {!agentView.child && <SubagentOverview
              children={subagents.subagentChildren}
              budget={subagents.subagentBudget}
              selection={modelSelection}
              refreshing={subagents.subagentRefreshing}
              onRefresh={() => void subagents.refreshSubagentChildren(true)}
              onOpenChild={subagents.openAgentTranscript}
              onDeleteChild={(child) => void subagents.deleteSubagent(child)}
              onReplyChild={subagents.replySubagentSupervisor}
              deletingChildKey={subagents.subagentDeletingKey || undefined}
              replyingChildKey={subagents.subagentReplyingKey || undefined}
              onReturnMain={header.returnToMainAgent}
              mode={subagents.subagentOverviewMode}
              onModeChange={subagents.setSubagentOverviewMode}
            />}
            {agentView.child && (
              <SubagentTranscriptView
                child={agentView.child}
                transcript={subagents.subagentTranscript}
                loading={subagents.subagentLoading}
                error={subagents.subagentError}
                stepDisplay={preferences.stepDisplay}
                stepCollapse={preferences.stepCollapse}
                showCodeView={preferences.showCodeView}
                onBackMain={header.returnToMainAgent}
                onOverview={header.openAgentOverview}
                onOpenFile={actions.openFile}
              />
            )}
          </Suspense>
        </div>
      )}
      <ComposerDock {...composer} open={transcriptVisible} />
    </main>
  );
}
