import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ExtensionNotice } from '../features/extensions/ExtensionSlot';
import type { AppNotification, NotificationTone } from './NotificationCenter';
import { useMessageDelivery } from '../features/conversation/useMessageDelivery';
import { useConversationSessions } from '../features/conversation/useConversationSessions';
import { useConversationSubscription } from '../features/conversation/useConversationSubscription';
import { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import { useComposerCommands } from '../features/conversation/useComposerCommands';
import { useComposerPersistence } from '../features/conversation/useComposerPersistence';
import type { ChatMessage, TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { SubagentChild } from '../types/subagent-types';
import type { ConversationPage } from '../types/durable-types';
import type { OutlineData } from '../features/conversation/outline-model';
import type { PiSessionSummary, PanelFileSource } from './app-types';
import { useSettingsWorkspace } from './useSettingsWorkspace';
import { useConversationExtensions } from './useConversationExtensions';
import { useConversationViewState } from './useConversationViewState';
import { useSidebarActions } from './useSidebarActions';
import { useAppCommandPalette } from './useAppCommandPalette';
import { useSidebarWorkspaceActions } from './useSidebarWorkspaceActions';
import { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import { runtimeRefreshFailure } from '../shared/runtime-refresh';
import { STORED_UI_KEYS } from '../shared/stored-ui-state';
import type { AppFoundation } from './useAppFoundation';

function writeStored(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/**
 * Owns conversation and settings hook composition. It deliberately returns
 * concrete fields rather than JSX so the main application remains a composition
 * root and individual conversation surfaces stay independently testable.
 */
export function useConversationController(foundation: AppFoundation) {
  const {
    actionConfirmation,
    settingsLeaveConfirmation,
    settingsDraftGuard,
    sessionLoading,
    setSessionLoading,
    settingsError,
    setSettingsError,
    retryInfo,
    setRetryInfo,
    setNotifications,
    pushNotification,
    compaction,
    setCompaction,
    todoPanelOpen,
    setTodoPanelOpen,
    queuedPromptsBySession,
    setQueuedPromptsBySession,
    queuedPromptsRef,
    queuedDrainSessionsRef,
    queueAdmissionPendingBySession,
    setQueueAdmissionPendingBySession,
    queueAdmissionPendingRef,
    queuedEditContextsRef,
    outlineActive,
    setOutlineActive,
    outlineHover,
    setOutlineHover,
    outlineItems,
    setOutlineItems,
    setOutlineTotalMessages,
    outlineRequestRef,
    defaultModelWorkspaceRef,
    modelRevisionRef,
    modelWritesRef,
    modelWriteResultsRef,
    settingsRequestRef,
    catalogRequestRef,
    modelSelection,
    setModelSelection,
    defaultModelSelection,
    setDefaultModelSelection,
    modelPickerRequest,
    setModelPickerRequest,
    longTaskBusy,
    setLongTaskBusy,
    session,
    setSession,
    sessionRef,
    sessionLoadRef,
    workspaces,
    stateLoading,
    workspace,
    workspaceRef,
    stateRequestRef,
    changeWorkspace,
    expandWorkspace,
    loadState,
    expanded,
    setExpanded,
    queuedPrompts,
    queuedEditContext,
    messages,
    setMessages,
    contextPolicy,
    setContextPolicy,
    requestTraces,
    setRequestTraces,
    agentView,
    setAgentView,
    prompt,
    setPrompt,
    composerAttachments,
    setComposerAttachments,
    composerMenu,
    setComposerMenu,
    composerMenuIndex,
    setComposerMenuIndex,
    composerCommands,
    composerCommandOptions,
    composerFileOptions,
    retryComposerSuggestions,
    composerDraftKeyRef,
    composerDraftsRef,
    composerPersistenceReady,
    setComposerPersistenceReady,
    composerPersistenceReadyRef,
    composerPersistenceStarted,
    setComposerPersistenceStarted,
    composerPersistenceStartedRef,
    persistedComposerActiveDraftKeyRef,
    composerPersistenceTimerRef,
    composerPersistenceWriteRef,
    composerPersistenceErrorRef,
    composerDeliveryRetriesRef,
    latestComposerAttemptByKeyRef,
    latestPromptBySessionRef,
    preparingDraftsRef,
    setPreparingDraftKeys,
    textareaRef,
    busy,
    setBusy,
    stoppingSessionIds,
    setStoppingSessionIds,
    stopping,
    turnActive,
    turnActiveRef,
    sendBlockedRef,
    error,
    setError,
    conversationSubscriptionError,
    setConversationSubscriptionError,
    conversationSubscriptionRetryRef,
    composerFeedback,
    setComposerFeedback,
    filesOpen,
    openFile,
    openChangesTab,
    models,
    setModels,
    showComposerFeedback,
    transcriptCacheRef,
  } = foundation;

  const settingsWorkspace = useSettingsWorkspace({
    workspace,
    workspaceRef,
    sessionId: session?.id,
    sessionRef,
    sessionLoadRef,
    workspaces,
    modelSelection,
    setModelSelection,
    setDefaultModelSelection,
    models,
    setModels,
    modelRevisionRef,
    modelWritesRef,
    modelWriteResultsRef,
    defaultModelWorkspaceRef,
    settingsRequestRef,
    catalogRequestRef,
    setSettingsError,
    settingsDraftGuard,
    settingsLeaveConfirmation,
    actionConfirmation,
    messages,
    compaction,
    setCompaction,
    contextPolicy,
    setContextPolicy,
    turnActiveRef,
    transcriptCacheRef,
    composerAttachments,
    setComposerFeedback,
    showComposerFeedback,
    pushNotification,
  });
  const {
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    settingsData,
    settingsBusy,
    setMcpRefreshError,
    setMcpRefreshSummary,
    skillRefreshError,
    skillRefreshSummary,
    skillRefreshBusy,
    extensionRefreshError,
    extensionRefreshBusy,
    resourceWriteBusy,
    extensionInstallerOpen,
    setExtensionInstallerOpen,
    extensionInstallPreview,
    setExtensionInstallPreview,
    extensionDetail,
    setExtensionDetail,
    skillDetail,
    skillDetailError,
    toggleSkillTrust,
    closeSkillDetail,
    mcpDetail,
    closeMcpDetail,
    mcpDetailOwnerGeneration,
    settingsContentRef,
    settingsReturnFocusRef,
    mcpOAuthRecoveryRef,
    mcpRefreshRequestRef,
    resourcePendingRef,
    mcpDetailGenerationRef,
  } = settingsWorkspace.state;
  const {
    scrollRef,
    topSentinelRef,
    chatContentRef,
    turnWindowFrom,
    visibleTurns,
    todoDetails,
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    nextUserTimestamps,
    requestPlacement,
    pendingAssistantVisible,
    pendingTurnError,
    outlineSamples,
    markUserScrollIntent,
    pauseTranscriptFollow,
    resumeTranscriptFollow,
    handleTranscriptScroll,
    jumpToOutline,
  } = useTranscriptNavigation({
    sessionId: session?.id,
    messages,
    requestTraces,
    busy,
    turnActive,
    error,
    agentView,
    filesOpen,
    outlineItems,
    outlineActive,
    setOutlineActive,
    showComposerFeedback,
  });

  const notifyExtension = useCallback((notice: ExtensionNotice) => {
    const tone: NotificationTone = notice.tone === 'success'
      || notice.tone === 'warning'
      || notice.tone === 'error'
      ? notice.tone
      : 'info';
    pushNotification(notice.message, tone);
  }, [pushNotification]);
  const {
    comparisonByParent,
    setComparisonByParent,
    comparisonStartPending,
    comparisonStarting,
    setComparisonStarting,
    comparisonPanelContext,
    setComparisonPanelContext,
    rememberMainScrollPosition,
    returnToMainAgent,
    openModelComparison,
    openTrace,
  } = useConversationViewState({
    scrollRef,
    session,
    workspace,
    agentView,
    setAgentView,
    modelSelection,
    filesOpen,
    closePanel: foundation.closePanel,
    openComparisonTab: foundation.workbench.openComparisonTab,
  });
  const conversationExtensions = useConversationExtensions({
    cwd: session?.cwd,
    sessionId: session?.id,
    agentView,
    setAgentView,
    pushNotification,
    rememberMainScrollPosition,
  });
  const {
    surface: conversationExtensionSurface,
    preferences: conversationExtensionUiPreferences,
    orderScope: conversationExtensionOrderScope,
    setOrderScope: setConversationExtensionOrderScope,
    items: conversationExtensionItems,
    headerItems: conversationHeaderExtensionItems,
    detailItems: conversationDetailExtensionItems,
    footerItems: conversationFooterExtensionItems,
    chipItems: conversationExtensionChipItems,
    hubItems: conversationExtensionHubItems,
    activeItem: activeExtensionItem,
    hasSessionOrder: hasConversationExtensionSessionOrder,
    updateUi: updateConversationExtensionUi,
    openItem: openConversationExtension,
    openChip: openConversationExtensionChip,
    openHub: openConversationExtensionHub,
  } = conversationExtensions;
  const [liveDiff, setLiveDiff] = useState<TurnDiff | null>(null);
  const requestRef = useRef<string | null>(null);
  const modelPickerRequestRef = useRef(0);
  const prefetchedSessionsRef = useRef<Set<string>>(new Set());
  const restoredRef = useRef(false);
  // Native navigation and keyboard shortcuts outlive individual renders.
  // Always checkpoint the latest composer draft when they switch conversations.
  const conversationNavigationRef = useRef<{
    open: (item: PiSessionSummary, reportError?: boolean) => Promise<boolean>;
    start: (
      cwd?: string,
      options?: { restoreDraft?: boolean; checkpoint?: boolean },
    ) => Promise<void>;
  }>({
    open: async () => false,
    start: async () => {},
  });
  const openFileHandlerRef = useRef<(path: string, source?: PanelFileSource) => Promise<boolean>>(async () => false);
  const openChangesHandlerRef = useRef<(file: TurnDiffFile | undefined, turn: TurnDiff) => void>(() => {});
  openFileHandlerRef.current = (path, source = 'diff') => openFile(path, session?.id, source);
  openChangesHandlerRef.current = (nextFile, turn) => {
    if (session) openChangesTab(nextFile, turn, session);
  };
  const handleOpenFile = useCallback((path: string) => openFileHandlerRef.current(path, 'diff'), []);
  const handleOpenAttachment = useCallback((path: string) => {
    openFileHandlerRef.current(path, 'attachment');
  }, []);
  const handleOpenChanges = useCallback((nextFile: TurnDiffFile | undefined, turn: TurnDiff) => {
    openChangesHandlerRef.current(nextFile, turn);
  }, []);

  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;
  const subagentWorkspace = useSubagentWorkspace({
    session,
    sessionRef,
    agentView,
    setAgentView,
    turnActive,
    actionConfirmation,
    pushNotification,
    loadState,
    rememberMainScrollPosition,
  });
  const {
    subagentChildren,
    setSubagentChildren,
    setSubagentBudget,
    setSubagentTranscript,
    setSubagentLoading,
    setSubagentError,
    subagentRequestRef,
    refreshSubagentChildren,
    openAgentOverview,
  } = subagentWorkspace;
  const {
    canLeaveSettings,
    selectSettingsTab,
    closeSettings,
    openSettings,
    loadOfficialExtensions,
    refreshSavedSkillConfiguration,
    loadModelCatalog,
    selectModel,
    activeContextPolicy,
    contextUsageInfo,
    compactContext,
    selectThinking,
  } = settingsWorkspace.controller;
  const outlineHandlersRef = useRef<{
    applyOutline: (data: OutlineData | undefined, loadedMessages: ChatMessage[], fallbackStart?: number) => void;
    refreshOutline: (sessionId: string, generation?: number) => Promise<OutlineData | undefined>;
  }>({
    applyOutline: () => {},
    refreshOutline: async () => undefined,
  });
  const composerCommandHandlersRef = useRef<{
    findExtensionCommand: (input: string) => Promise<{ commandId: string; argument: string } | undefined>;
    executeBuiltinCommand: (input: string) => Promise<boolean>;
    executeExtensionCommand: (commandId: string, input?: string) => Promise<boolean>;
  }>({
    findExtensionCommand: async () => undefined,
    executeBuiltinCommand: async () => false,
    executeExtensionCommand: async () => false,
  });
  const {
    clearSessionQueuedPrompts,
    currentComposerDraft,
    checkpointComposerDraft,
    installComposerDraft,
    clearActiveComposerDraftText,
    clearActiveComposerDraft,
    attachPastedText,
    addComposerFiles,
    pickComposerAttachments,
    removeComposerAttachment,
    handleEditMessage,
    send,
    sendQueuedNow,
    sendAllQueued,
    executeLongTaskAction,
    changeLongTaskStatus,
    stopGeneration,
    editQueued,
    deleteQueued,
    reorderQueued,
  } = useMessageDelivery({
    session,
    sessionRef,
    sessionLoadRef,
    workspaces,
    workspace,
    modelSelection,
    busy,
    setBusy,
    setError,
    setRetryInfo,
    setLiveDiff,
    setCompaction,
    compaction,
    turnActive,
    turnActiveRef,
    sendBlockedRef,
    stopping,
    setStoppingSessionIds,
    longTaskBusy,
    setLongTaskBusy,
    sessionLoading,
    stateLoading,
    prompt,
    queuedPrompts,
    queuedPromptsBySession,
    setQueuedPromptsBySession,
    queuedPromptsRef,
    queuedDrainSessionsRef,
    queueAdmissionPendingBySession,
    setQueueAdmissionPendingBySession,
    queueAdmissionPendingRef,
    queuedEditContextsRef,
    composerDraftKeyRef,
    composerDraftsRef,
    composerPersistenceStartedRef,
    setComposerPersistenceStarted,
    composerAttachments,
    composerDeliveryRetriesRef,
    latestComposerAttemptByKeyRef,
    latestPromptBySessionRef,
    preparingDraftsRef,
    setPreparingDraftKeys,
    setComposerMenu,
    setComposerFeedback,
    setPrompt,
    setComposerAttachments,
    textareaRef,
    requestRef,
    modelPickerRequestRef,
    setModelPickerRequest,
    setTodoPanelOpen,
    setSession,
    setMessages,
    setRequestTraces,
    loadState,
    applyOutline: (data, loadedMessages, fallbackStart) => (
      outlineHandlersRef.current.applyOutline(data, loadedMessages, fallbackStart)
    ),
    refreshOutline: (sessionId, generation) => (
      outlineHandlersRef.current.refreshOutline(sessionId, generation)
    ),
    refreshSubagentChildren,
    resumeTranscriptFollow,
    pushNotification,
    showComposerFeedback,
    commandHandlersRef: composerCommandHandlersRef,
  });
  const {
    startSession,
    selectDraftWorkspace,
    prefetchSession,
    applyOutline,
    refreshOutline,
    openSession,
    openNotificationSession,
  } = useConversationSessions({
    session,
    sessionRef,
    sessionLoadRef,
    workspace,
    workspaces,
    settingsOpen,
    canLeaveSettings,
    modelSelection,
    defaultModelSelection,
    defaultModelWorkspaceRef,
    modelRevisionRef,
    modelWriteResultsRef,
    transcriptCacheRef,
    prefetchedSessionsRef,
    outlineRequestRef,
    subagentRequestRef,
    composerDraftKeyRef,
    composerDraftsRef,
    requestRef,
    textareaRef,
    setSettingsOpen,
    setSessionLoading,
    setSession,
    setModelSelection,
    setDefaultModelSelection,
    setMessages,
    setRequestTraces,
    setAgentView,
    setSubagentChildren,
    setSubagentBudget,
    setSubagentTranscript,
    setSubagentError,
    setSubagentLoading,
    setOutlineItems,
    setOutlineTotalMessages,
    setOutlineActive,
    setOutlineHover,
    setComposerMenu,
    setModelPickerRequest,
    setBusy,
    setCompaction,
    setRetryInfo,
    setError,
    loadState,
    loadModelCatalog,
    changeWorkspace,
    expandWorkspace,
    checkpointComposerDraft,
    installComposerDraft,
    currentComposerDraft,
  });
  outlineHandlersRef.current = { applyOutline, refreshOutline };
  conversationNavigationRef.current = { open: openSession, start: startSession };
  const {
    updateComposerMenu,
    executeBuiltinCommand,
    sendPromptFromExtension,
    executeExtensionCommand,
    findExtensionCommand,
    selectComposerOption,
  } = useComposerCommands({
    session,
    sessionRef,
    sessionLoadRef,
    workspace,
    modelSelection,
    busy,
    stateLoading,
    sessionLoading,
    isNewConversation: !session?.id,
    messages,
    prompt,
    composerAttachments,
    composerDraftKeyRef,
    composerDraftsRef,
    composerMenu,
    composerFileOptions,
    composerCommandOptions,
    composerCommands,
    textareaRef,
    modelPickerRequestRef,
    conversationExtensionItems,
    conversationNavigationRef,
    setBusy,
    setError,
    setLongTaskBusy,
    setComposerMenu,
    setComposerMenuIndex,
    setModelPickerRequest,
    setPrompt,
    currentComposerDraft,
    clearActiveComposerDraftText,
    clearActiveComposerDraft,
    send,
    executeLongTaskAction,
    startSession,
    openSettings,
    selectModel,
    selectThinking,
    loadState,
    showComposerFeedback,
    pushNotification,
    openConversationExtension,
  });
  composerCommandHandlersRef.current = {
    findExtensionCommand,
    executeBuiltinCommand,
    executeExtensionCommand,
  };
  useComposerPersistence({
    session,
    workspace,
    workspaces,
    stateLoading,
    prompt,
    composerAttachments,
    composerDraftKeyRef,
    composerDraftsRef,
    persistedComposerActiveDraftKeyRef,
    composerPersistenceReadyRef,
    composerPersistenceStartedRef,
    composerPersistenceTimerRef,
    composerPersistenceWriteRef,
    composerPersistenceErrorRef,
    queuedPromptsRef,
    restoredRef,
    textareaRef,
    composerPersistenceReady,
    composerPersistenceStarted,
    queuedPromptsBySession,
    setQueuedPromptsBySession,
    setComposerPersistenceReady,
    setComposerPersistenceStarted,
    setExpanded,
    setError,
    showComposerFeedback,
    changeWorkspace,
    openSession,
    startSession,
    loadStateRef,
  });
  const settingsNavigationRef = useRef({ open: openSettings, close: closeSettings, select: selectSettingsTab });
  settingsNavigationRef.current = { open: openSettings, close: closeSettings, select: selectSettingsTab };

  useEffect(() => {
    if (!restoredRef.current) return;
    writeStored(STORED_UI_KEYS.activeSession, session ? { id: session.id, cwd: session.cwd } : null);
  }, [session]);

  // 扩展请求工具确认时，渲染进程负责显示统一样式的弹窗。
  useEffect(() => window.piApi.onConfirmRequest((request) => foundation.setConfirmRequest(request)), [foundation.setConfirmRequest]);

  // Viewing one finished conversation acknowledges only that result. Opening
  // the application itself must not clear completion marks for other sessions.
  useEffect(() => {
    if (session?.id && !turnActive) window.piApi.markMenuBarSessionSeen?.(session.id);
  }, [session?.id, turnActive]);

  useEffect(() => window.piApi.onOpenSettings(() => { void settingsNavigationRef.current.open(); }), []);
  useEffect(() => window.piApi.onOpenMain(() => { void settingsNavigationRef.current.close(); }), []);
  useEffect(() => window.piApi.onOpenSession((target) => {
    if (!target?.id) return;
    const summary = workspaces
      .flatMap((item) => item.sessions)
      .find((item) => item.id === target.id)
      ?? {
        id: target.id,
        cwd: target.cwd,
        title: target.title || '会话',
        kind: 'conversation',
        goal: '',
        pinned: false,
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      };
    void conversationNavigationRef.current.open(summary);
  }), [workspaces]);

  useEffect(() => { settingsContentRef.current?.scrollTo({ top: 0 }); }, [settingsTab, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'extensions') return;
    void loadOfficialExtensions();
  }, [settingsOpen, settingsTab, workspace]);

  useEffect(() => {
    if (!settingsOpen) settingsReturnFocusRef.current?.focus();
  }, [settingsOpen]);

  useLayoutEffect(() => {
    setTodoPanelOpen(false);
    setCompaction({ active: false });
  }, [session?.id]);

  useEffect(() => window.piApi.onConversationListChanged(() => { void loadState(); }), [loadState]);
  useEffect(() => window.piApi.onRuntimeRefresh((snapshot) => {
    // Applied, ready and idle-deferred refreshes are successful lifecycle
    // states. The settings UI already reflects the saved value; only a real
    // runtime failure needs a separate surface.
    const failure = runtimeRefreshFailure(snapshot);
    if (!failure) return;
    pushNotification(failure, 'error', '配置热加载失败', snapshot.sessionId);
  }), [pushNotification]);

  const { retryConversationSubscription } = useConversationSubscription({
    sessionId: session?.id,
    turnActive,
    sessionRef,
    modelRevisionRef,
    modelWritesRef,
    requestRef,
    textareaRef,
    subscriptionRetryRef: conversationSubscriptionRetryRef,
    loadState,
    refreshSubagentChildren,
    refreshOutline,
    pushNotification,
    setBusy,
    setRequestTraces,
    setCompaction,
    setRetryInfo,
    setModelSelection,
    setSession,
    setMessages,
    setError,
    setLiveDiff,
    setOutlineItems,
    setOutlineTotalMessages,
    setOutlineActive,
    setConversationSubscriptionError,
  });

  const {
    refreshConversationList,
    sidebarAction,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
  } = useSidebarActions({
    workspaces,
    sessionRef,
    sessionLoadRef,
    workspaceRef,
    stateRequestRef,
    sidebarMutationRef: foundation.sidebarMutationRef,
    setSidebarMutating: foundation.setSidebarMutating,
    conversationListNeedsRefreshRef: foundation.conversationListNeedsRefreshRef,
    conversationListRetryRef: foundation.conversationListRetryRef,
    setConversationListRefreshError: foundation.setConversationListRefreshError,
    loadStateRef,
    setSession,
    clearSessionQueuedPrompts,
    queuedEditContextsRef,
    composerDraftsRef,
    conversationNavigationRef,
    actionConfirmation,
    pushNotification,
  });

  const isNewConversation = !session?.id;
  const sidebarActions = useSidebarWorkspaceActions({
    workspaces,
    isNewConversation,
    sidebarFiltering: foundation.sidebarFiltering,
    dragPreviewRef: foundation.dragPreviewRef,
    setExpanded,
    setSearchCollapsed: foundation.setSearchCollapsed,
    selectDraftWorkspace,
    openSession,
    prefetchSession,
    startSession: (cwd) => startSession(cwd),
    sidebarAction,
    reorderWorkspaces: foundation.reorderWorkspaces,
    reorderSessions: foundation.reorderSessions,
    clearSidebarFilters: foundation.clearSidebarFilters,
    makeDragPreview: foundation.makeDragPreview,
  });

  const {
    actionPaletteOpen,
    setActionPaletteOpen,
    availableConversationActions,
    actionResourcesLoading,
    actionResourcesError,
    executeConversationAction,
  } = useAppCommandPalette({
    preferences: foundation.preferences,
    visibleWorkspaces: foundation.visibleWorkspaces,
    session,
    workspace,
    settingsOpen,
    filesOpen,
    turnActive,
    compactionActive: compaction.active,
    stateLoading,
    sessionLoading,
    messageCount: messages.length,
    subagentCount: subagentChildren.length,
    extensionCount: conversationDetailExtensionItems.length,
    prompt,
    conversationNavigationRef,
    setComposerMenu,
    setSidebarCollapsed: foundation.setSidebarCollapsed,
    openSettings,
    closePanel: foundation.closePanel,
    openPanel: foundation.openPanel,
    openBrowserTab: foundation.openBrowserTab,
    openTerminalTab: foundation.openTerminalTab,
    stopGeneration,
    openModelComparison,
    returnToMainAgent,
    openAgentOverview,
    openConversationExtensionHub,
    openTemporaryChat: foundation.openTemporaryChat,
    openFilesTab: foundation.openFilesTab,
    sendPromptFromExtension,
    executeExtensionCommand,
    sidebarAction,
    openSettingsPage: page => openSettings(page),
  });

  async function runNotificationAction(item: AppNotification): Promise<void> {
    const action = item.action;
    if (!action) return;
    if (action.kind !== 'unarchive-session') throw new Error('这个通知操作暂不可用。');
    const target = workspaces
      .flatMap(workspaceEntry => workspaceEntry.sessions)
      .find(sessionEntry => sessionEntry.id === action.sessionId);
    if (!target) throw new Error('这个会话已不在列表中，无法撤销归档。');
    if (!target.archived) throw new Error('会话已经恢复，请刷新列表后再确认当前状态。');
    await sidebarAction('session', action.sessionId, 'archive', undefined, {
      preserveCurrentView: true,
      notify: false,
    });
    setNotifications(current => current.filter(notification => notification.id !== item.id));
    pushNotification(
      `「${target.title || '会话'}」已恢复到原工作区。`,
      'success',
      '已撤销归档',
      action.sessionId,
    );
  }

  return {
    settingsWorkspace,
    settingsOpen,
    settingsTab,
    settingsData,
    settingsBusy,
    settingsError,
    setMcpRefreshError,
    setMcpRefreshSummary,
    skillRefreshError,
    skillRefreshSummary,
    skillRefreshBusy,
    extensionRefreshError,
    extensionRefreshBusy,
    resourceWriteBusy,
    extensionInstallerOpen,
    setExtensionInstallerOpen,
    extensionInstallPreview,
    setExtensionInstallPreview,
    extensionDetail,
    setExtensionDetail,
    skillDetail,
    skillDetailError,
    toggleSkillTrust,
    closeSkillDetail,
    mcpDetail,
    closeMcpDetail,
    mcpDetailOwnerGeneration,
    settingsContentRef,
    settingsReturnFocusRef,
    mcpOAuthRecoveryRef,
    mcpRefreshRequestRef,
    resourcePendingRef,
    mcpDetailGenerationRef,
    canLeaveSettings,
    selectSettingsTab,
    closeSettings,
    openSettings,
    loadOfficialExtensions,
    refreshSavedSkillConfiguration,
    loadModelCatalog,
    selectModel,
    activeContextPolicy,
    contextUsageInfo,
    compactContext,
    selectThinking,
    scrollRef,
    topSentinelRef,
    chatContentRef,
    turnWindowFrom,
    visibleTurns,
    todoDetails,
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    nextUserTimestamps,
    requestPlacement,
    pendingAssistantVisible,
    pendingTurnError,
    outlineSamples,
    markUserScrollIntent,
    pauseTranscriptFollow,
    resumeTranscriptFollow,
    handleTranscriptScroll,
    jumpToOutline,
    notifyExtension,
    comparisonByParent,
    setComparisonByParent,
    comparisonStartPending,
    comparisonStarting,
    setComparisonStarting,
    comparisonPanelContext,
    setComparisonPanelContext,
    rememberMainScrollPosition,
    returnToMainAgent,
    openModelComparison,
    openTrace,
    conversationExtensionSurface,
    conversationExtensionUiPreferences,
    conversationExtensionOrderScope,
    setConversationExtensionOrderScope,
    conversationExtensionItems,
    conversationHeaderExtensionItems,
    conversationDetailExtensionItems,
    conversationFooterExtensionItems,
    conversationExtensionChipItems,
    conversationExtensionHubItems,
    activeExtensionItem,
    hasConversationExtensionSessionOrder,
    updateConversationExtensionUi,
    openConversationExtension,
    openConversationExtensionChip,
    openConversationExtensionHub,
    liveDiff,
    handleOpenFile,
    handleOpenAttachment,
    handleOpenChanges,
    subagentWorkspace,
    subagentChildren,
    clearSessionQueuedPrompts,
    attachPastedText,
    addComposerFiles,
    pickComposerAttachments,
    removeComposerAttachment,
    handleEditMessage,
    send,
    sendQueuedNow,
    sendAllQueued,
    executeLongTaskAction,
    changeLongTaskStatus,
    stopGeneration,
    editQueued,
    deleteQueued,
    reorderQueued,
    startSession,
    selectDraftWorkspace,
    prefetchSession,
    openSession,
    openNotificationSession,
    updateComposerMenu,
    executeBuiltinCommand,
    sendPromptFromExtension,
    executeExtensionCommand,
    findExtensionCommand,
    selectComposerOption,
    retryConversationSubscription,
    conversationSubscriptionError,
    refreshConversationList,
    sidebarAction,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
    runNotificationAction,
    sidebarActions,
    actionPaletteOpen,
    setActionPaletteOpen,
    availableConversationActions,
    actionResourcesLoading,
    actionResourcesError,
    executeConversationAction,
    isNewConversation,
  };
}

export type ConversationController = ReturnType<typeof useConversationController>;
