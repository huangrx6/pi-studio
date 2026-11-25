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
import { useSidebarActions } from './useSidebarActions';
import { useAppCommandPalette } from './useAppCommandPalette';
import { useSidebarWorkspaceActions } from './useSidebarWorkspaceActions';
import { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import { runtimeRefreshFailure } from '../shared/runtime-refresh';
import type { AppFoundation } from './useAppFoundation';

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
    composerMentionOptions,
    retryComposerSuggestions,
    composerDraftKeyRef,
    composerDraftsRef,
    composerPersistenceReady,
    setComposerPersistenceReady,
    composerPersistenceReadyRef,
    composerPersistenceTimerRef,
    composerPersistenceWriteRef,
    composerPersistenceErrorRef,
    composerDeliveryRetriesRef,
    latestComposerAttemptByKeyRef,
    latestPromptBySessionRef,
    preparingDraftsRef,
    setPreparingDraftKeys,
    composerEditorRef,
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
    composerFeedbackScopeRef,
    filesOpen,
    openFile,
    openChangesTab,
    models,
    setModels,
    showComposerFeedback,
    transcriptCacheRef,
  } = foundation;

  // 输入框提示按会话归属：切到别的对话后，上一条会话的错误/提示不再显示。
  composerFeedbackScopeRef.current = session?.id;

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
  });
  const {
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    pluginSection,
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
  const transcriptPageRef = useRef<{ sessionId: string; page: { hasOlder?: boolean; hasNewer?: boolean; nextCursor?: string; olderCursor?: string } } | null>(null);
  // useTranscriptNavigation 先于 useConversationSessions 调用，用 ref 把补页函数桥接过去。
  const resetToLatestRef = useRef<() => Promise<void>>(async () => {});
  const [transcriptTruncated, setTranscriptTruncated] = useState(false);
  const loadOlderMessagesRef = useRef<(beforeApply: () => number[]) => Promise<boolean>>(async () => false);
  const loadNewerMessagesRef = useRef<(beforeApply: () => number[]) => Promise<boolean>>(async () => false);
  const loadMessageWindowRef = useRef<(id: number) => Promise<boolean>>(async () => false);
  const {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
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
    jumpToMessage,
  } = useTranscriptNavigation({
    onLoadOlder: (beforeApply) => loadOlderMessagesRef.current(beforeApply),
    onLoadNewer: (beforeApply) => loadNewerMessagesRef.current(beforeApply),
    hasNewer: transcriptTruncated,
    onLoadTarget: (id) => loadMessageWindowRef.current(id),
    sessionId: session?.id,
    goalUpdatedAt: session?.longTask?.updatedAt,
    messages,
    requestTraces,
    busy,
    turnActive,
    error,
    visible: !settingsOpen && !foundation.panelFullscreen,
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
  const workbench = foundation.workbench;
  const focusConversation = useCallback(() => {
    workbench.setPanelFullscreen(false);
    if (workbench.panelOverlay) workbench.closePanel();
    requestAnimationFrame(() => composerEditorRef.current?.focus());
  }, [workbench.closePanel, workbench.panelOverlay, workbench.setPanelFullscreen, composerEditorRef]);
  const openTrace = workbench.openTraceTab;
  const [extensionMenuOpen, setExtensionMenuOpen] = useState(false);
  const openExtensionMenu = () => {
    workbench.setPanelFullscreen(false);
    setExtensionMenuOpen(true);
  };
  const currentProviderId = modelSelection.modelRef.split('/')[0];
  const source = settingsData?.providers.find(item => item.id === currentProviderId);
  const quotaSource = settingsData
    ? source?.enabled && source.quotaEnabled ? { id: source.id, name: source.name } : undefined
    : modelSelection.quotaProvider?.id === currentProviderId ? modelSelection.quotaProvider : undefined;
  const conversationExtensions = useConversationExtensions({
    sourceQuotaEnabled: Boolean(quotaSource),
    cwd: session?.cwd || workspace,
    sessionId: session?.id,
    turnActive,
    extensionPlacements: foundation.preferences.extensionPlacements,
  });
  const openExtensionPanel = useCallback(async (panelId: string) => {
    const item = conversationExtensions.panels.find(panel => panel.id === panelId);
    if (!item) {
      pushNotification('这个扩展面板当前不可用。', 'warning');
      return;
    }
    if (settingsOpen) {
      if (!await settingsWorkspace.controller.closeSettings({ restoreFocus: false })) return;
      if (sessionRef.current?.id !== session?.id || workspaceRef.current !== workspace) return;
      setExtensionDetail(null);
    }
    workbench.openExtensionTab(item);
  }, [conversationExtensions.panels, pushNotification, session?.id, sessionRef, setExtensionDetail,
    settingsOpen, settingsWorkspace.controller, workbench.openExtensionTab, workspace, workspaceRef]);

  useEffect(() => window.piApi.onExtensionPanelRequested?.(({ sessionId, panelId }) => {
    if (sessionId !== sessionRef.current?.id || sessionId !== session?.id || settingsOpen) return;
    const panel = conversationExtensions.panels.find(item => item.id === panelId);
    if (panel) workbench.openExtensionTab(panel);
  }), [conversationExtensions.panels, session?.id, sessionRef, settingsOpen, workbench.openExtensionTab]);

  useEffect(() => { setExtensionMenuOpen(false); }, [session?.id, workspace, settingsOpen]);
  const [liveDiff, setLiveDiff] = useState<TurnDiff | null>(null);
  const requestRef = useRef<string | null>(null);
  const modelPickerRequestRef = useRef(0);
  const prefetchedSessionsRef = useRef<Set<string>>(new Set());
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
  const undoSessionId = session?.id;
  const undoTurnDiff = useCallback(async (at: number) => {
    if (!undoSessionId) throw new Error('找不到当前会话。');
    await window.piApi.undoTurnDiff({ sessionId: undoSessionId, at });
    if (sessionRef.current?.id !== undoSessionId) return;
    setSession(current => current?.id === undoSessionId ? {
      ...current, turnDiffs: current.turnDiffs?.map(turn => turn.at === at ? { ...turn, undone: true } : turn),
    } : current);
    setLiveDiff(current => current?.at === at ? { ...current, undone: true } : current);
  }, [undoSessionId, sessionRef, setSession]);
  const handleOpenChanges = useCallback((nextFile: TurnDiffFile | undefined, turn: TurnDiff) => {
    openChangesHandlerRef.current(nextFile, turn);
  }, []);

  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;
  const subagentWorkspace = useSubagentWorkspace({
    session,
    sessionRef,
    childKey: workbench.panelTabs.find(tab => tab.kind === 'subagents')?.childKey,
    visible: !settingsOpen && filesOpen && workbench.activePanelTab?.kind === 'subagents',
    openSubagentsTab: workbench.openSubagentsTab,
    turnActive,
    actionConfirmation,
    pushNotification,
    loadState,
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
    selectPluginSection,
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
    transcriptPageRef,
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
    composerEditorRef,
    requestRef,
    modelPickerRequestRef,
    setModelPickerRequest,
    openTodoHistory: () => workbench.openProgressTab('history'),
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
    loadOlderMessages,
    loadNewerMessages,
    loadMessageWindow,
    resetToLatest,
  } = useConversationSessions({
    session,
    messages,
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
    transcriptPageRef,
    prefetchedSessionsRef,
    outlineRequestRef,
    subagentRequestRef,
    composerDraftKeyRef,
    composerDraftsRef,
    requestRef,
    composerEditorRef,
    setSettingsOpen,
    setSessionLoading,
    setSession,
    setModelSelection,
    setDefaultModelSelection,
    setMessages,
    setTranscriptTruncated,
    setRequestTraces,
    setSubagentChildren,
    setSubagentBudget,
    setSubagentTranscript,
    setSubagentError,
    setSubagentLoading,
    setOutlineItems,
    setOutlineTotalMessages,
    setOutlineActive,
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
  loadOlderMessagesRef.current = loadOlderMessages;
  loadNewerMessagesRef.current = loadNewerMessages;
  loadMessageWindowRef.current = loadMessageWindow;
  resetToLatestRef.current = resetToLatest;
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
    composerMentionOptions,
    composerCommandOptions,
    composerCommands,
    composerEditorRef,
    modelPickerRequestRef,
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
    openExtensionPanel,
  });
  composerCommandHandlersRef.current = {
    findExtensionCommand,
    executeBuiltinCommand,
    executeExtensionCommand,
  };
  const { persistDeletedComposerSessions } = useComposerPersistence({
    session,
    workspace,
    workspaces,
    stateLoading,
    workspacesLoaded: foundation.workspacesLoaded,
    prompt,
    composerAttachments,
    composerDraftKeyRef,
    composerDraftsRef,
    composerPersistenceReadyRef,
    composerPersistenceTimerRef,
    composerPersistenceWriteRef,
    composerPersistenceErrorRef,
    queuedPromptsRef,
    composerPersistenceReady,
    queuedPromptsBySession,
    setQueuedPromptsBySession,
    setComposerPersistenceReady,
    setError,
    showComposerFeedback,
    loadStateRef,
  });
  const settingsNavigationRef = useRef({ open: openSettings, close: closeSettings, select: selectSettingsTab });
  settingsNavigationRef.current = { open: openSettings, close: closeSettings, select: selectSettingsTab };

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

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'plugins' || pluginSection !== 'extensions') return;
    void loadOfficialExtensions();
  }, [settingsOpen, settingsTab, pluginSection, workspace]);

  useEffect(() => {
    const opener = settingsReturnFocusRef.current;
    if (settingsOpen || !opener) return;
    opener.focus();
    // The settings toggle may have folded the sidebar containing the opener.
    if (document.activeElement === document.body) {
      document.querySelector<HTMLButtonElement>('.chat-header .sidebar-expand')?.focus();
    }
  }, [settingsOpen]);

  useLayoutEffect(() => {
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
    composerEditorRef,
    subscriptionRetryRef: conversationSubscriptionRetryRef,
    loadState,
    refreshSubagentChildren,
    refreshOutline,
    pushNotification,
    setBusy,
    setStoppingSessionIds,
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
    deleteArchivedGroup,
  } = useSidebarActions({
    workspaces,
    removeWorkspaceFromList: foundation.removeWorkspaceFromList,
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
    persistDeletedComposerSessions,
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
    extensionCount: conversationExtensions.groups.length,
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

    focusConversation,
    openAgentOverview,
    openExtensions: openExtensionMenu,
    openProgress: workbench.openProgressTab,
    openTrace,
    openGit: workbench.openGitTab,
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
    selectPluginSection,
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
    bottomSentinelRef,
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
    jumpToMessage,
    resetToLatest: async () => {
      await resetToLatestRef.current();
      resumeTranscriptFollow(true);
    },
    transcriptTruncated,
    notifyExtension,
    focusConversation,
    openTrace,
    quotaSource,
    conversationExtensions,
    extensionMenuOpen,
    setExtensionMenuOpen,
    openExtensionPanel,
    liveDiff,
    handleOpenFile,
    handleOpenAttachment,
    handleOpenChanges,
    undoTurnDiff,
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
    deleteArchivedGroup,
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
