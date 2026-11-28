import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ExtensionNotice } from '../features/extensions/ExtensionSlot';
import { useSettingsToast } from '../shared/SettingsToast';
import { useMessageDelivery } from '../features/conversation/useMessageDelivery';
import { useConversationSessions } from '../features/conversation/useConversationSessions';
import { useConversationSubscription } from '../features/conversation/useConversationSubscription';
import { peekTemporary } from '../features/conversation/temporary-chat-store';
import { errorText } from '../shared/error-text';
import { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import { useComposerCommands } from '../features/conversation/useComposerCommands';
import { useComposerPersistence } from '../features/conversation/useComposerPersistence';
import type { ChatMessage, TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { OutlineData } from '../features/conversation/outline-model';
import type { PiSessionSummary, PanelFileSource } from './app-types';
import { useSessionInspection } from './useSessionInspection';
import { inspectionSummary, type Inspection } from './session-inspection';
import { useSettingsWorkspace } from './useSettingsWorkspace';
import { useConversationExtensions } from './useConversationExtensions';
import { modelQuotaSource } from '../types/provider-quota';
import { useSidebarActions } from './useSidebarActions';
import { useAppCommandPalette } from './useAppCommandPalette';
import { useSidebarWorkspaceActions } from './useSidebarWorkspaceActions';
import { useSubagentWorkspace } from '../features/subagents/useSubagentWorkspace';
import type { AppFoundation } from './useAppFoundation';

/**
 * Owns conversation and settings hook composition. It deliberately returns
 * concrete fields rather than JSX so the main application remains a composition
 * root and individual conversation surfaces stay independently testable.
 */
export function useConversationController(foundation: AppFoundation) {
  const createFromDraft = (input: Parameters<typeof window.piApi.createConversation>[0]) =>
    window.piApi.createConversation({ ...input, adoptDraftTools: true });
  const showToast = useSettingsToast();
  const workbench = foundation.workbench;
  const { section, setSection: selectSection, temporary } = foundation;
  const {
    actionConfirmation,
    settingsLeaveConfirmation,
    settingsDraftGuard,
    sessionLoading,
    setSessionLoading,
    settingsError,
    setSettingsError,
    setRetryInfo,
    compaction,
    setCompaction,
    queuedPromptsBySession,
    setQueuedPromptsBySession,
    queuedPromptsRef,
    queuedDrainSessionsRef,
    setQueueAdmissionPendingBySession,
    queueAdmissionPendingRef,
    queuedEditContextsRef,
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
    setExpanded,
    queuedPrompts,
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
    setComposerMenuIndex,
    composerCommands,
    composerCommandOptions,
    composerMentionOptions,
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
    savedReading: workbench.reading, layoutReady: workbench.ready, onReading: workbench.saveReading,
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
    visible: section === 'conversations' && !settingsOpen && !workbench.activeTab,
    filesOpen,
    outlineItems,
    setOutlineActive,
    showComposerFeedback,
  });

  const notifyExtension = useCallback((notice: ExtensionNotice) => {
    showToast(notice.message, notice.tone === 'error' || notice.tone === 'success' ? notice.tone : 'info');
  }, [showToast]);
  const focusConversation = useCallback(() => {
    selectSection('conversations');
    workbench.activate('chat');
    requestAnimationFrame(() => composerEditorRef.current?.focus());
  }, [selectSection, composerEditorRef, workbench.activate]);
  const inspection = useSessionInspection(session?.id, setError);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const openInspection = (details: Partial<Inspection>) => {
    if (!session) return;
    selectSection('conversations');
    workbench.activate('chat');
    inspection.patch({ ...details, mode: 'expanded' });
  };
  const openProgress = (progressPage: Inspection['progressPage'] = 'summary') => openInspection({ tab: 'progress', progressPage });
  const openTrace = () => openInspection({ tab: 'trace' });
  const appHubOpen = section === 'plugins';
  const [statusPanelId, setStatusPanelId] = useState<string | null>(null);
  const closeStatusPanel = useCallback(() => setStatusPanelId(null), []);
  const temporaryId = section === 'temporary' ? temporary.activeId : undefined;
  useEffect(closeStatusPanel, [closeStatusPanel, section, session?.id, temporaryId, workspace]);
  useEffect(() => { if (settingsOpen) closeStatusPanel(); }, [closeStatusPanel, settingsOpen]);
  const chatModel = section === 'temporary' ? temporary.selection : modelSelection;
  const quotaSource = modelQuotaSource(chatModel, settingsData?.providers);
  const conversationExtensions = useConversationExtensions({
    sourceQuotaEnabled: Boolean(quotaSource),
    cwd: section === 'conversations' ? session?.cwd || workspace : workspace,
    sessionId: section === 'conversations' ? session?.id : undefined,
    turnActive: section === 'conversations' && turnActive,
    extensionPlacements: foundation.preferences.extensionPlacements,
  });
  const openExtensionPanel = useCallback(async (panelId: string) => {
    const item = conversationExtensions.panels.find(panel => panel.id === panelId);
    if (!item) {
      showToast('这个扩展视图当前不可用。', 'error');
      return;
    }
    if (item.slot === 'status.detail') {
      setExtensionDetail(null);
      setStatusPanelId(current => current === item.id ? null : item.id);
      return;
    }
    try {
      await window.piApi.openToolWindow({ kind: 'extension', panelId: item.id });
    } catch (error) {
      showToast(errorText(error), 'error');
    }
  }, [conversationExtensions.panels, setExtensionDetail, showToast]);

  const openAppHub = useCallback(() => selectSection('plugins'), [selectSection]);
  useEffect(() => window.piApi.onExtensionPanelRequested?.(({ ownerKey, sessionId, panelId }) => {
    const matches = ownerKey ? ownerKey === (workbench.owner || 'studio')
      : section === 'conversations' && sessionId && sessionId === sessionRef.current?.id && sessionId === session?.id;
    if (matches && (ownerKey || !settingsOpen)) void openExtensionPanel(panelId);
  }), [openExtensionPanel, section, session?.id, sessionRef, settingsOpen, workbench.owner]);
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
  const openFileHandlerRef = useRef<(path: string, source?: PanelFileSource, title?: string) => Promise<boolean>>(async () => false);
  const openChangesHandlerRef = useRef<(file: TurnDiffFile | undefined, turn: TurnDiff) => void>(() => {});
  openFileHandlerRef.current = (path, source = 'diff', title) => openFile(path, undefined, source, {title});
  openChangesHandlerRef.current = (nextFile, turn) => {
    if (session) openChangesTab(nextFile, turn, session);
  };
  const handleOpenFile = useCallback((path: string) => openFileHandlerRef.current(path, 'diff'), []);
  const handleOpenAttachment = useCallback((path: string, title?: string) => {
    openFileHandlerRef.current(path, 'attachment', title);
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
    childKey: inspection.view.childKey,
    visible: !settingsOpen && !workbench.activeTab && section === 'conversations' && inspection.view.mode === 'expanded' && inspection.view.tab === 'subagents',
    openSubagentsTab: childKey => openInspection({ tab: 'subagents', childKey }),
    turnActive,
    actionConfirmation,
    loadState,
  });
  const cardSummary = useMemo(() => inspectionSummary(todoDetails, subagentWorkspace.subagentChildren, session?.longTask),
    [todoDetails, subagentWorkspace.subagentChildren, session?.longTask]);
  useEffect(() => {
    if (cardSummary.activity) inspection.hydrate(cardSummary.activity);
  }, [cardSummary.activity, inspection.hydrate]);
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
    onDraftCreated: created => workbench.showConversation(created.cwd, created),
    createFromDraft,
    session,
    sessionRef,
    sessionLoadRef,
    transcriptPageRef,
    workspaces,
    workspace,
    modelSelection,
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
    openTodoHistory: () => openProgress('history'),
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
    showComposerFeedback,
    commandHandlersRef: composerCommandHandlersRef,
  });
  const {
    draftModelLoading,
    startSession,
    selectDraftWorkspace,
    prefetchSession,
    applyOutline,
    refreshOutline,
    openSession,
    loadOlderMessages,
    loadNewerMessages,
    loadMessageWindow,
    resetToLatest,
  } = useConversationSessions({
    onNavigate: () => selectSection('conversations'),
    onPresent: workbench.showConversation,
    session,
    messages,
    sessionRef,
    sessionLoadRef,
    workspace,
    workspaces,
    settingsOpen,
    canLeaveSettings,
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
    createFromDraft,
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
    openExtensionPanel,
    onCompose: () => selectSection('conversations'),
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
  useEffect(() => window.piApi.onConfirmDismissed?.(id =>
    foundation.setConfirmRequest(current => current?.id === id ? null : current)), [foundation.setConfirmRequest]);

  // Viewing one finished conversation acknowledges only that result. Opening
  // the application itself must not clear completion marks for other sessions.
  useEffect(() => {
    if (section === 'conversations' && !settingsOpen && session?.id && !turnActive) window.piApi.markMenuBarSessionSeen?.(session.id);
  }, [section, settingsOpen, session?.id, turnActive]);

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
    // A sidebar opener can still be fading out when the user returns to the workbench.
    const folded = opener.closest('.is-sidebar-collapsed .shell-sidebar');
    if (!folded && opener.isConnected) opener.focus({ preventScroll: true });
    if (folded || document.activeElement === document.body) {
      document.querySelector<HTMLButtonElement>('.app > .content-region:not([hidden]) .sidebar-expand')?.focus();
    }
  }, [settingsOpen]);

  useLayoutEffect(() => {
    setCompaction({ active: false });
  }, [session?.id]);

  useEffect(() => {
    const refresh = () => { void loadState(); };
    const unsubscribe = window.piApi.onConversationListChanged(refresh);
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, [loadState]);

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
    forgetConversations: workbench.forgetConversations,
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
  });

  const isNewConversation = !session?.id;
  async function openWorktree(cwd: string) {
    const generation = ++sessionLoadRef.current;
    const last = await workbench.workspaceConversation(cwd);
    if (sessionLoadRef.current !== generation) return;
    if (last && await openSession({ id: last }, true, false)) return;
    if (!last || sessionLoadRef.current === generation + 1) await startSession(cwd, { focusTab: false });
  }
  async function inspectSession(id: string) {
    if (sessionRef.current?.id === id && section === 'conversations') {
      workbench.activate('chat');
    } else if (!await openSession({ id })) return;
    inspection.patch({ mode: 'expanded' }, id);
    requestAnimationFrame(() => {
      if (sessionRef.current?.id === id) inspectorToggleRef.current?.focus({ preventScroll: true });
    });
  }
  const sidebarActions = useSidebarWorkspaceActions({
    inspectSession,
    openWorktree,
    workspaces,
    sidebarFiltering: foundation.sidebarFiltering,
    dragPreviewRef: foundation.dragPreviewRef,
    setExpanded,
    setSearchCollapsed: foundation.setSearchCollapsed,
    openSession,
    prefetchSession,
    startSession,
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
    extensionCount: conversationExtensions.toolPanels.length,
    prompt,
    conversationNavigationRef,
    setComposerMenu,
    setSidebarCollapsed: foundation.setSidebarCollapsed,
    openSettings,
    closePanel: foundation.closePanel,
    openPanel: foundation.openPanel,
    openBrowserTab: foundation.openBrowserTab,
    openTerminalTab: foundation.openTerminalTab,
    stopFocusedGeneration: () => {
      if (section === 'temporary' && peekTemporary(temporary.activeId)?.busy) {
        void window.piApi.temporaryStop(temporary.activeId).catch(cause => showToast(errorText(cause), 'error'));
      } else if (section === 'conversations' && turnActive) {
        void stopGeneration();
      }
    },
    focusConversation,
    openAgentOverview,
    openExtensions: openAppHub,
    openProgress,
    openTrace,
    openGit: workbench.openGitTab,
    openTemporaryChat: foundation.openTemporaryChat,
    openFilesTab: foundation.openFilesTab,
    sendPromptFromExtension,
    executeExtensionCommand,
    sidebarAction,
    openSettingsPage: page => openSettings(page),
  });

  return {
    settingsWorkspace,
    settingsOpen,
    settingsTab,
    settingsData,
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
    inspection, inspectorToggleRef, cardSummary, openProgress, inspectSession,
    appHubOpen,
    openAppHub,
    section,
    selectSection,
    temporary,
    statusPanelId,
    closeStatusPanel,
    draftModelLoading,
    quotaSource,
    conversationExtensions,
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
    sidebarActions, openWorktree,
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
