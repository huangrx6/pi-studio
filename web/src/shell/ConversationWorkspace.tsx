import { Fragment, lazy, Suspense, useMemo, type ComponentProps } from 'react';
import { ChevronLeft, LoaderCircle } from 'lucide-react';
import { AssistantTurnView, ChatMessageView } from '../features/conversation/ChatMessage';
import { ComposerDock } from '../features/conversation/ComposerDock';
import { ConversationError } from '../features/conversation/ConversationError';
import { ConversationOutline } from '../features/conversation/ConversationOutline';
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
import type { AgentView, PiSessionSummary } from './app-types';
import type { SettingsTab } from './app-shell-config';
import type { ModelSelection } from '../types/model-types';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import type {
  ConversationExtensionLayout,
  ConversationExtensionOrderScope,
  ConversationExtensionUiPreferences,
  ExtensionSettingsPage,
  ExtensionUiItem,
} from '../types/extension-types';
import type { StoredModelComparisonMap } from '../shared/stored-ui-state';
import { ConversationHeader } from './ConversationHeader';
import { ConversationTracePage } from './ConversationTraceMenu';
import type { ConversationTraceSummary, ConversationTraceItem } from './ConversationTraceMenu';
import type { ChatMessage, RequestTrace, ToolCallBlock } from '../types/chat-types';
import {
  isNearBottom,
  nestedScrollableConsumesWheel,
  shouldReleaseFollowOnWheel,
} from '../features/conversation/chat-scroll.mjs';

const ModelComparisonPanel = lazy(async () => {
  const module = await import('../features/comparison/ModelComparisonPanel');
  return { default: module.ModelComparisonPanel };
});
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
  comparisonBranchCount: number;
  conversationDetailExtensionCount: number;
  openNotificationSession: (id: string) => Promise<void>;
  runNotificationAction: (item: AppNotification) => Promise<void>;
  togglePanel: () => void;
  returnToMainAgent: () => void;
  openAgentOverview: () => void;
  openModelComparison: () => void;
  openConversationExtensionHub: () => void;
  openTrace: () => void;
};

function compactTraceText(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function toolPreview(call: ToolCallBlock): string {
  const args = call.arguments ?? {};
  for (const value of [args.command, args.path, args.file_path, args.query, args.pattern, args.url, args.name]) {
    if (typeof value === 'string' && value.trim()) return compactTraceText(value);
  }
  return '';
}

function toolDetail(call: ToolCallBlock): string {
  try { return JSON.stringify(call.arguments ?? {}, null, 2); } catch { return ''; }
}

function traceItemFromRequest(trace: RequestTrace, status: ConversationTraceItem['status']): ConversationTraceItem {
  const model = trace.model ? `${trace.model.provider}/${trace.model.modelId}` : '模型请求';
  return { id: `request:${trace.id}`, kind: 'model', preview: model, label: '模型调用', detail: `消息 ${trace.stats.messageCount} 条 · 预计 ${trace.stats.estimatedChars} 字符`, status, at: trace.createdAt };
}

function buildTraceSummary(input: {
  turns: ReturnType<typeof useTranscriptNavigation>['transcriptTurns'];
  toolResults: Map<string, ChatMessage>;
  requestPlacement: ReturnType<typeof useTranscriptNavigation>['requestPlacement'];
  turnActive: boolean;
}): ConversationTraceSummary {
  const items: ConversationTraceItem[] = [];
  const requests = [...input.requestPlacement.byAssistantTurn.values(), ...input.requestPlacement.unansweredByUserTurn.values(), input.requestPlacement.pending]
    .flat()
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const latestRequestId = requests.at(-1)?.id;
  requests.forEach(trace => items.push(traceItemFromRequest(trace, input.turnActive && trace.id === latestRequestId ? 'running' : 'done')));
  input.turns.forEach((turn, turnIndex) => {
    if (turn.kind !== 'assistant') return;
    turn.messages.forEach((message, messageIndex) => message.content.forEach((block, blockIndex) => {
      if (block.type === 'thinking') {
        items.push({
          id: `decision:${turnIndex}:${messageIndex}:${blockIndex}`,
          kind: 'decision',
          label: '决策',
          preview: compactTraceText(block.thinking) || '模型思考',
          detail: block.redacted ? '模型未提供推理正文。' : block.thinking,
          status: input.turnActive && turnIndex === input.turns.length - 1 ? 'running' : 'done',
          at: message.timestamp,
        });
      }
      if (block.type === 'toolCall') {
        const result = input.toolResults.get(block.id);
        items.push({
          id: `tool:${block.id}`,
          kind: 'tool',
          label: block.namespace ? `${block.namespace}/${block.name}` : block.name,
          preview: toolPreview(block),
          detail: toolDetail(block),
          status: result?.isError ? 'error' : !result && input.turnActive ? 'running' : 'done',
          at: message.timestamp,
        });
      }
    }));
  });
  items.sort((left, right) => (left.at ?? 0) - (right.at ?? 0) || left.id.localeCompare(right.id));
  const errors = items.filter(item => item.status === 'error').length;
  const tools = items.filter(item => item.kind === 'tool').length;
  const requestCount = items.filter(item => item.kind === 'model').length;
  const state = items.length === 0 ? 'idle' : input.turnActive ? 'running' : errors > 0 ? 'error' : 'done';
  return { steps: items.length, requests: requestCount, tools, errors, state, items };
}

type ExtensionWorkspaceState = {
  headerItems: ExtensionUiItem[];
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

type ComparisonState = {
  byParent: StoredModelComparisonMap;
  setByParent: React.Dispatch<React.SetStateAction<StoredModelComparisonMap>>;
  loadState: () => Promise<void>;
  openSession: (item: PiSessionSummary) => Promise<boolean>;
  openSettings: (page?: SettingsTab) => void | Promise<void>;
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
  comparison: ComparisonState;
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
  comparison,
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
  } = transcript;
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
  const showSessionError = Boolean(error)
    && !(Boolean(error) && !turnActive && lastAssistantError === error);

  function renderModelComparisonWorkspace() {
    if (agentView.kind !== 'comparison') return null;
    const activeComparison = agentView.comparison;
    return <div className="model-comparison-workspace">
      <Suspense fallback={
        <div className="panel-route-loading" role="status" aria-label="正在加载模型对比">
          <LoaderCircle aria-hidden="true" />
        </div>
      }>
        <ModelComparisonPanel
          parentId={activeComparison.parentId}
          cwd={activeComparison.cwd}
          initialPrompt={activeComparison.prompt}
          initialComparison={comparison.byParent[activeComparison.parentId]?.result ?? null}
          initialModelRef={activeComparison.initialModelRef}
          initialThinkingLevel={activeComparison.initialThinkingLevel}
          mentions={activeComparison.mentions}
          attachments={activeComparison.attachments}
          images={activeComparison.images}
          onStarted={(started) => {
            comparison.setByParent((current) => ({
              ...current,
              [started.parentId]: {
                result: started,
                cwd: activeComparison.cwd,
                initialModelRef: activeComparison.initialModelRef,
                initialThinkingLevel: activeComparison.initialThinkingLevel,
              },
            }));
          }}
          onAdopt={(sessionId) => {
            void comparison.loadState().catch(() => {});
            void comparison.openSession({
              id: sessionId,
              cwd: activeComparison.cwd,
              title: '模型对比分支',
              kind: 'durable',
              goal: '',
              pinned: false,
              archived: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messageCount: 0,
            });
          }}
          onManageModels={() => comparison.openSettings('models')}
        />
      </Suspense>
    </div>;
  }

  return (
    <main className={`main ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
      <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
      <ConversationHeader
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        isNewConversation={isNewConversation}
        title={agentView.kind === 'comparison'
          ? '模型同题双跑'
          : agentView.kind === 'agents' && agentView.child
            ? `${agentView.child.name || agentView.child.agent} · 子智能体`
            : (session?.title || 'Pi Studio')}
        agentKind={agentView.kind}
        subagentCount={subagents.subagentChildren.length}
        hasActiveSubagents={subagents.hasActiveSubagents}
        comparisonBranchCount={header.comparisonBranchCount}
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
        onOpenModelComparison={header.openModelComparison}
        onOpenConversationExtensionHub={header.openConversationExtensionHub}
        onOpenTrace={header.openTrace}
        traceSummary={traceSummary}
      />
      {!isNewConversation && agentView.kind === 'conversation' && extensions.headerItems.length > 0 && (
        <ConversationExtensionDock
          items={extensions.headerItems}
          surface={extensions.surface}
          placement="header"
          cwd={session?.cwd}
          sessionId={session?.id}
          modelRef={modelSelection.modelRef}
          onOpenSettings={extensions.openSettings}
          onSendPrompt={extensions.sendPrompt}
          onNotify={extensions.notify}
        />
      )}
      {!isNewConversation && agentView.kind === 'conversation' && <div
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
              {turnWindowFrom > 0 && <div ref={topSentinelRef} className="transcript-window-sentinel" aria-hidden="true" />}
              {visibleTurns.map((turn, offset) => {
                const index = offset + turnWindowFrom;
                if (turn.kind === 'user') {
                  return <Fragment key={`user-${turn.message.sourceIndex ?? turn.message.timestamp ?? index}`}>
                    <ChatMessageView
                      id={`chat-turn-${turn.message.sourceIndex ?? `pending-${turn.message.timestamp ?? index}`}`}
                      message={turn.message}
                      onOpenFile={actions.openAttachment}
                      onEdit={actions.editMessage}
                      editDisabled={turnActive || compaction.active}
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

      {!isNewConversation && agentView.kind === 'comparison' && renderModelComparisonWorkspace()}

      {!isNewConversation && agentView.kind === 'trace' && <ConversationTracePage summary={traceSummary} />}

      {!settingsOpen && !filesOpen && !isNewConversation && agentView.kind === 'conversation' && outline.items.length > 1 && (
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
      <ComposerDock {...composer} open={agentView.kind === 'conversation'} />
    </main>
  );
}
