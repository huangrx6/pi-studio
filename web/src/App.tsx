import { lazy, Suspense, useCallback, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ExtensionSlot } from './features/extensions/ExtensionSlot';
import { ExtensionAppearanceContext } from './features/extensions/ExtensionStatusIcon';
import { ConversationActionPalette } from './features/conversation/ConversationActionPalette';
import type { QueuedPreview } from './features/conversation/QueuedMessages';
import { AppSidebar } from './shell/AppSidebar';
import { AppDialogs } from './shell/AppDialogs';
import { BackgroundLayer, BackgroundMediaNode } from './shell/BackgroundLayer';
import { ConversationProgress, ProgressTrigger } from './shell/ConversationProgress';
import { useGitWorkspaceStatus } from './shell/useGitWorkspaceStatus';
import { GitRepositoryContext, useWorkspaceRepositories } from './features/git/useWorkspaceRepositories';
import { ConversationWorkspace } from './shell/ConversationWorkspace';
import { SettingsOverlay } from './shell/SettingsOverlay';
import { ShellLayout } from './shell/ShellLayout';
import { SidebarResizeHandle, useSidebarWidth } from './shell/SidebarResizeHandle';
import { useAppFoundation } from './shell/useAppFoundation';
import { useWindowChrome } from './shell/useWindowChrome';
import { useLaunchScreen } from './shell/useLaunchScreen';
import { useConversationController } from './shell/useConversationController';
import { ComparisonWorkbench } from './features/comparison/ComparisonWorkbench';
import { MarkdownActions } from './shared/markdown-actions';
import { errorText } from './shared/error-text';

const WorkbenchPane = lazy(async () => {
  const module = await import('./shell/right-panel/WorkbenchPane');
  return { default: module.WorkbenchPane };
});

/** Application composition root: foundation state, conversation runtime, then layout. */
export function App() {
  useWindowChrome();
  const foundation = useAppFoundation();
  const conversation = useConversationController(foundation);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const {
    preferences,
    handleBackgroundUnavailable,
    updateSnapshot,
    updateProgress,
    openUpdateDialog,
    updateDialogOpen,
    closeUpdateDialog,
    checkUpdates,
    downloadUpdate,
    installUpdate,
    shortcutsOpen,
    setShortcutsOpen,
    notifications,
    setNotifications,
    markAllNotificationsRead,
    clearNotifications,
    workspaces,
    workspace,
    session,
    modelSelection,
    models,
    defaultModelSelection,
    allExpanded,
    toggleAllExpanded,
    workspaceSearchOpen,
    workspaceSearchTrigger,
    setWorkspaceSearchOpen,
    closeSidebarSearch,
    workspaceQuery,
    sidebarSessionFilter,
    changeWorkspaceQuery,
    changeSidebarFilter,
    conversationListRefreshError,
    stateLoading,
    sidebarMutating,
    visibleWorkspaces,
    expanded,
    sidebarFiltering,
    searchCollapsed,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeWorkspace,
    queuedPrompts,
    queueAdmissionPendingBySession,
    openTemporaryChat,
    filesOpen,
    panelFullscreen,
    workbench,
    openPanel,
    openBrowserTab,
    openTerminalTab,
    openFile,
    dragPreviewRef,
    makeDragPreview,
    loadState,
    actionConfirmation,
    settingsLeaveConfirmation,
    settingsDraftGuard,
    confirmRequest,
    setConfirmRequest,
    fullPermissionOpen,
    fullPermissionAck,
    setFullPermissionAck,
    setFullPermissionOpen,
    applyPermission,
    settingsError,
    outlineItems,
    outlineActive,
    setError,
    error,
    agentView,
    turnActive,
    compaction,
    retryInfo,
    conversationSubscriptionError,
    sessionLoading,
    messages,
    busy,
    stopping,
    preparing,
    composerFeedback,
    setComposerFeedback,
    visiblePermission,
    changePermission,
    retryPermissionMode,
    modelPickerRequest,
    setModelPickerRequest,
    sessionLoadRef,
    longTaskBusy,
    progressView,
    setProgressView,
    prompt,
    setPrompt,
    composerAttachments,
    composerImages,
    composerImageIndexes,
    composerDraftKeyRef,
    composerDraftsRef,
    composerEditorRef,
    composerWrapRef,
    composerComposingRef,
    composerMenu,
    composerMenuIndex,
    composerMenuLoading,
    composerMenuError,
    composerCommandOptions,
    composerFileOptions,
    composerCommands,
    retryComposerSuggestions,
    queuedEditContext,
  } = foundation;
  const { setOuterReady, setInnerSettled } = useLaunchScreen(
    foundation.initialStateSettled && foundation.composerPersistenceReady
      && (visiblePermission?.status === 'ready' || visiblePermission?.status === 'error'),
    preferences.backgroundMedia?.url,
    preferences.backgroundInsideVisibility > 0,
  );
  const terminalAppearance = useMemo(() => ({
    fontSize: preferences.terminalFontSize,
    fontFamily: preferences.terminalFontFamily,
    lineHeight: preferences.terminalLineHeight,
    cursorStyle: preferences.terminalCursorStyle,
    themeId: preferences.terminalTheme,
  }), [
    preferences.terminalCursorStyle,
    preferences.terminalFontFamily,
    preferences.terminalFontSize,
    preferences.terminalLineHeight,
    preferences.terminalTheme,
  ]);
  const {
    settingsWorkspace,
    settingsOpen,
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
    mcpOAuthRecoveryRef,
    mcpRefreshRequestRef,
    resourcePendingRef,
    mcpDetailGenerationRef,
    openSettings,
    refreshSavedSkillConfiguration,
    loadModelCatalog,
    selectModel,
    selectThinking,
    activeContextPolicy,
    contextUsageInfo,
    compactContext,
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
    resetToLatest,
    transcriptTruncated,
    notifyExtension,
    comparisonByParent,
    setComparisonByParent,
    comparisonStartPending,
    comparisonStarting,
    setComparisonStarting,
    comparisonPanelContext,
    setComparisonPanelContext,
    returnToMainAgent,
    openModelComparison,
    openTrace,
    conversationExtensionSurface,
    conversationExtensionUiPreferences,
    conversationExtensionOrderScope,
    setConversationExtensionOrderScope,
    conversationDetailExtensionItems,
    conversationFooterExtensionItems,
    conversationExtensionChipItems,
    openConversationExtensionChip,
    openConversationExtension,
    conversationExtensionHubItems,
    activeExtensionItem,
    hasConversationExtensionSessionOrder,
    updateConversationExtensionUi,
    openConversationExtensionHub,
    quotaProvider,
    liveDiff,
    handleOpenFile,
    handleOpenAttachment,
    handleOpenChanges,
    undoTurnDiff,
    subagentWorkspace,
    handleEditMessage,
    addComposerFiles,
    attachPastedText,
    removeComposerAttachment,
    pickComposerAttachments,
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
    openSession,
    openNotificationSession,
    updateComposerMenu,
    sendPromptFromExtension,
    executeExtensionCommand,
    selectComposerOption,
    retryConversationSubscription,
    refreshConversationList,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
    deleteArchivedGroup,
    runNotificationAction,
    actionPaletteOpen,
    setActionPaletteOpen,
    availableConversationActions,
    actionResourcesLoading,
    actionResourcesError,
    executeConversationAction,
    sidebarActions,
    isNewConversation,
  } = conversation;

  /** 选择工作区文件夹；新对话里只切换草稿工作区，已有对话则直接开始新会话。 */
  const chooseFile = useCallback(() => {
    void window.piApi.chooseWorkspace().then((selected) => {
      if (selected) {
        if (isNewConversation) selectDraftWorkspace(selected);
        else void startSession(selected);
        void loadState();
      }
    }).catch(error => setError(errorText(error)));
  }, [isNewConversation, loadState, selectDraftWorkspace, setError, startSession]);

  const queuedPreviews: QueuedPreview[] = useMemo(() => queuedPrompts.map((item) => ({
    id: item.id,
    text: item.text.trim() || (item.attachments.some((attachment) => attachment.kind === 'image') ? '图片消息' : '附件消息'),
    images: item.attachments.filter((attachment) => attachment.kind === 'image').length,
    files: item.attachments.filter((attachment) => attachment.kind === 'file').length,
    error: item.autoRetryError,
    admissionPending: Boolean(
      session?.id
      && queueAdmissionPendingBySession[session.id] === item.submission.requestId,
    ),
  })), [queuedPrompts, queueAdmissionPendingBySession, session?.id]);
  const queueAdmissionPending = Boolean(
    session?.id && queueAdmissionPendingBySession[session.id],
  );
  const panelWorkspace = session?.cwd || workspace;
  const panelWorkspaceName = activeWorkspace?.name
    || panelWorkspace.split(/[\\/]/).filter(Boolean).at(-1)
    || '工具';
  const repositories = useWorkspaceRepositories(session?.cwd, workspaces.find(item => item.cwd === session?.cwd)?.name);
  const { status: gitStatus } = useGitWorkspaceStatus(session?.cwd, repositories.selected?.id);
  const progressPinned = workbench.panelTabs.some(tab => tab.kind === 'progress');
  const dismissProgress = useCallback(() => setProgressView(view => view.floating
    ? { ...view, floating: false } : view), [setProgressView]);
  const navigateFromProgress = useCallback((action: () => void) => {
    dismissProgress();
    if (workbench.panelFullscreen) workbench.setPanelFullscreen(false);
    action();
  }, [dismissProgress, workbench.panelFullscreen, workbench.setPanelFullscreen]);
  const openProgressPage = useCallback((action: () => void) => {
    navigateFromProgress(action);
    if (filesOpen && window.matchMedia('(max-width: 1100px)').matches) workbench.closePanel();
  }, [filesOpen, navigateFromProgress, workbench.closePanel]);
  const openGit = useCallback((tab: import('./types/git-types').GitTab) => {
    openProgressPage(() => {
      conversation.rememberMainScrollPosition();
      foundation.setAgentView({ kind: 'git', tab });
    });
  }, [conversation.rememberMainScrollPosition, foundation.setAgentView, openProgressPage]);
  const onProgressPinChange = useCallback(() => {
    setProgressView(view => ({ ...view, floating: progressPinned && Boolean(session) }));
    if (progressPinned) {
      workbench.setPanelFullscreen(false);
      workbench.closePanelTab('progress');
    } else workbench.openProgressTab();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.conversation-progress .progress-pin')?.focus());
  }, [progressPinned, session, setProgressView, workbench.closePanelTab, workbench.openProgressTab, workbench.setPanelFullscreen]);
  const onProgressGitSettings = useCallback(() => {
    navigateFromProgress(() => void openSettings('git'));
  }, [navigateFromProgress, openSettings]);
  const onProgressEditGoal = useCallback(() => {
    navigateFromProgress(() => { returnToMainAgent(); sendPromptFromExtension('/goal ', false); });
  }, [navigateFromProgress, returnToMainAgent, sendPromptFromExtension]);
  const onProgressOpenTasks = useCallback(() => {
    openProgressPage(() => {
      conversation.rememberMainScrollPosition();
      foundation.setAgentView({ kind: 'tasks' });
    });
  }, [conversation.rememberMainScrollPosition, foundation.setAgentView, openProgressPage]);
  const onProgressToggleHistory = useCallback(() => {
    setProgressView(view => ({ ...view, history: !view.history }));
  }, [setProgressView]);
  const onProgressAgents = useCallback(() => {
    openProgressPage(subagentWorkspace.openAgentOverview);
  }, [openProgressPage, subagentWorkspace.openAgentOverview]);
  const onProgressAgent = useCallback((child: import('./types/subagent-types').SubagentChild) => {
    openProgressPage(() => subagentWorkspace.openAgentTranscript(child));
  }, [openProgressPage, subagentWorkspace.openAgentTranscript]);
  const progressVisible = progressPinned || progressView.floating;
  const progressContent = useMemo(() => {
    if (!progressVisible) return null;
    return (
      <ConversationProgress
        key={session?.id}
        sessionId={session?.id}
        pinned={progressPinned}
        onPinChange={onProgressPinChange}
        git={gitStatus}
        onGitSettings={onProgressGitSettings}
        onOpenGit={openGit}
        goal={session?.longTask}
        running={turnActive}
        goalBusy={longTaskBusy}
        onGoalAction={changeLongTaskStatus}
        onEditGoal={onProgressEditGoal}
        onOpenTasks={onProgressOpenTasks}
        tasks={todoDetails}
        history={progressView.history}
        onToggleHistory={onProgressToggleHistory}
        agents={subagentWorkspace.subagentChildren}
        onAgents={onProgressAgents}
        onAgent={onProgressAgent}
      />
    );
  }, [
    changeLongTaskStatus,
    gitStatus,
    longTaskBusy,
    onProgressAgent,
    onProgressAgents,
    onProgressEditGoal,
    onProgressGitSettings,
    onProgressOpenTasks,
    onProgressPinChange,
    onProgressToggleHistory,
    openGit,
    progressPinned,
    progressView.history,
    progressVisible,
    session?.id,
    session?.longTask,
    subagentWorkspace.subagentChildren,
    todoDetails,
    turnActive,
  ]);
    /** Latest browser opener, read through a ref so the context value stays stable. */
  const markdownLinkRef = useRef<(url: string) => void>(() => {});
  markdownLinkRef.current = (url: string) => openBrowserTab(url);
  const onSidebarStartSession = useCallback(() => { void startSession(); }, [startSession]);
  const onSidebarOpenSettings = useCallback((page?: Parameters<typeof openSettings>[0]) => { void openSettings(page); }, [openSettings]);
  const onSidebarOpenSearch = useCallback(() => setWorkspaceSearchOpen(true), [setWorkspaceSearchOpen]);
  const onSidebarRefreshList = useCallback(() => { void refreshConversationList(); }, [refreshConversationList]);
  const onSidebarCollapse = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed]);
  const sidebarFilterKey = useMemo(
    () => `${workspaceQuery}\u0000${sidebarSessionFilter}`,
    [workspaceQuery, sidebarSessionFilter],
  );
  const sidebarNode = useMemo(() => (
    <AppSidebar
      onStartSession={onSidebarStartSession}
      onOpenTemporaryChat={openTemporaryChat}
      onOpenSettings={onSidebarOpenSettings}
      workspace={workspace}
      sessionId={session?.id}
      modelRef={modelSelection.modelRef}
      onSendPrompt={sendPromptFromExtension}
      onNotify={notifyExtension}
      workspaces={workspaces}
      allExpanded={allExpanded}
      onToggleAllExpanded={toggleAllExpanded}
      workspaceSearchOpen={workspaceSearchOpen}
      workspaceSearchTrigger={workspaceSearchTrigger}
      onOpenWorkspaceSearch={onSidebarOpenSearch}
      onCloseWorkspaceSearch={closeSidebarSearch}
      onChooseFile={chooseFile}
      workspaceQuery={workspaceQuery}
      sidebarSessionFilter={sidebarSessionFilter}
      onWorkspaceQueryChange={changeWorkspaceQuery}
      onSidebarFilterChange={changeSidebarFilter}
      conversationListRefreshError={conversationListRefreshError}
      stateLoading={stateLoading}
      settingsOpen={settingsOpen}
      onRefreshConversationList={onSidebarRefreshList}
      sidebarMutating={sidebarMutating}
      visibleWorkspaces={visibleWorkspaces}
      expanded={expanded}
      sidebarFiltering={sidebarFiltering}
      searchCollapsed={searchCollapsed}
      filterKey={sidebarFilterKey}
      sidebarCollapsed={sidebarCollapsed}
      sidebarActions={sidebarActions}
      onCollapse={onSidebarCollapse}
    />
  ), [
    allExpanded,
    changeSidebarFilter,
    changeWorkspaceQuery,
    chooseFile,
    closeSidebarSearch,
    conversationListRefreshError,
    expanded,
    modelSelection.modelRef,
    notifyExtension,
    onSidebarCollapse,
    onSidebarOpenSearch,
    onSidebarOpenSettings,
    onSidebarRefreshList,
    onSidebarStartSession,
    openTemporaryChat,
    searchCollapsed,
    sendPromptFromExtension,
    session?.id,
    settingsOpen,
    sidebarActions,
    sidebarCollapsed,
    sidebarFilterKey,
    sidebarFiltering,
    sidebarMutating,
    sidebarSessionFilter,
    stateLoading,
    toggleAllExpanded,
    visibleWorkspaces,
    workspace,
    workspaceQuery,
    workspaceSearchOpen,
    workspaceSearchTrigger,
    workspaces,
  ]);

  const sidebarResizeHandle = !sidebarCollapsed && <SidebarResizeHandle onResize={setSidebarWidth} />;


  const openGitFile = useCallback((root: string, path: string) => {
    void openFile(path, session?.id, 'workspace', { cwd: root, refresh: true });
  }, [openFile, session?.id]);
  const openSettingsPage = useCallback((page?: Parameters<typeof openSettings>[0]) => {
    void openSettings(page);
  }, [openSettings]);
  const openModelsSettings = useCallback(() => {
    void openSettings('models');
  }, [openSettings]);
  const resetTranscriptToLatest = useCallback(() => resetToLatest(), [resetToLatest]);
  const toggleProgressFloating = useCallback(() => {
    if (progressPinned) workbench.openProgressTab();
    else setProgressView(view => ({ ...view, floating: !view.floating }));
  }, [progressPinned, setProgressView, workbench.openProgressTab]);

  const notificationCount = useMemo(
    () => notifications.filter((item) => !item.read).length,
    [notifications],
  );

  const workspaceShell = useMemo(() => ({
    isNewConversation,
    sessionLoading,
    messageCount: messages.length,
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
    notificationCount,
    notifications,
    setNotifications,
    markAllRead: markAllNotificationsRead,
    clearNotifications,
    conversationSubscriptionError,
    retryConversationSubscription,
    settingsOpen,
  }), [
    agentView,
    busy,
    clearNotifications,
    compaction,
    conversationSubscriptionError,
    error,
    isNewConversation,
    liveDiff,
    markAllNotificationsRead,
    messages.length,
    modelSelection,
    notificationCount,
    notifications,
    preferences,
    retryConversationSubscription,
    retryInfo,
    session,
    sessionLoading,
    setError,
    setNotifications,
    setSidebarCollapsed,
    settingsOpen,
    sidebarCollapsed,
    turnActive,
  ]);

  const headerUpdate = useMemo(() => (
    updateSnapshot.state === 'available'
    || updateSnapshot.state === 'downloading'
    || updateSnapshot.state === 'downloaded'
      ? {
        state: updateSnapshot.state,
        latestVersion: updateSnapshot.latestVersion,
        progress: updateProgress,
        onOpen: openUpdateDialog,
      }
      : null
  ), [openUpdateDialog, updateProgress, updateSnapshot.latestVersion, updateSnapshot.state]);

  const progressTrigger = useMemo(() => (
    <ProgressTrigger
      open={!progressPinned && progressView.floating}
      pinned={progressPinned}
      active={progressPinned && workbench.panelEntered && workbench.activePanelTabId === 'progress'}
      onDismiss={dismissProgress}
      onToggle={toggleProgressFloating}
    >
      {progressContent}
    </ProgressTrigger>
  ), [
    dismissProgress,
    progressContent,
    progressPinned,
    progressView.floating,
    toggleProgressFloating,
    workbench.activePanelTabId,
    workbench.panelEntered,
  ]);

  const workspaceHeader = useMemo(() => ({
    update: headerUpdate,
    conversationDetailExtensionCount: conversationDetailExtensionItems.length,
    quotaProvider,
    openNotificationSession,
    runNotificationAction,
    panelExpanded: workbench.panelEntered,
    openPanel,
    returnToMainAgent,
    gitStatus,
    openGit,
    progressTrigger,
    openConversationExtensionHub,
    openTrace,
  }), [
    conversationDetailExtensionItems.length,
    gitStatus,
    headerUpdate,
    openConversationExtensionHub,
    openGit,
    openNotificationSession,
    openPanel,
    openTrace,
    progressTrigger,
    quotaProvider,
    returnToMainAgent,
    runNotificationAction,
    workbench.panelEntered,
  ]);

  const workspaceActions = useMemo(() => ({
    openAttachment: handleOpenAttachment,
    openFile: handleOpenFile,
    openGitFile,
    openChanges: handleOpenChanges,
    undoTurnDiff,
    editMessage: handleEditMessage,
  }), [
    handleEditMessage,
    handleOpenAttachment,
    handleOpenChanges,
    handleOpenFile,
    openGitFile,
    undoTurnDiff,
  ]);

  const workspaceTranscript = useMemo(() => ({
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
    jumpToMessage,
    resetToLatest: resetTranscriptToLatest,
    transcriptTruncated,
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
  }), [
    bottomSentinelRef,
    chatContentRef,
    handleTranscriptScroll,
    jumpToMessage,
    jumpToOutline,
    lastAssistantTurnIndex,
    markUserScrollIntent,
    nextUserTimestamps,
    outlineSamples,
    pauseTranscriptFollow,
    pendingAssistantVisible,
    pendingTurnError,
    requestPlacement,
    resetTranscriptToLatest,
    resumeTranscriptFollow,
    scrollRef,
    todoDetails,
    toolResultMap,
    topSentinelRef,
    transcriptTruncated,
    transcriptTurns,
    turnWindowFrom,
    visibleTurns,
  ]);

  const workspaceExtensions = useMemo(() => ({
    chipItems: conversationExtensionChipItems,
    openChip: openConversationExtensionChip,
    openItem: openConversationExtension,
    surface: conversationExtensionSurface,
    hubItems: conversationExtensionHubItems,
    activeItem: activeExtensionItem,
    preferences: conversationExtensionUiPreferences,
    orderScope: conversationExtensionOrderScope,
    setOrderScope: setConversationExtensionOrderScope,
    hasSessionOrder: hasConversationExtensionSessionOrder,
    updateUi: updateConversationExtensionUi,
    openSettings: openSettingsPage,
    sendPrompt: sendPromptFromExtension,
    notify: notifyExtension,
    openHub: openConversationExtensionHub,
  }), [
    activeExtensionItem,
    conversationExtensionChipItems,
    conversationExtensionHubItems,
    conversationExtensionOrderScope,
    conversationExtensionSurface,
    conversationExtensionUiPreferences,
    hasConversationExtensionSessionOrder,
    notifyExtension,
    openConversationExtension,
    openConversationExtensionChip,
    openConversationExtensionHub,
    openSettingsPage,
    sendPromptFromExtension,
    setConversationExtensionOrderScope,
    updateConversationExtensionUi,
  ]);

  const workspaceOutline = useMemo(() => ({
    items: outlineItems,
    samples: outlineSamples,
    active: outlineActive,
    jump: jumpToOutline,
  }), [
    jumpToOutline,
    outlineActive,
    outlineItems,
    outlineSamples,
  ]);

  const modelPickerContextKey = `${workspace}:${session?.id ?? 'draft'}:${sessionLoadRef.current}`;

  const workspaceComposer = useMemo(() => ({
    open: agentView.kind === 'conversation',
    isNewConversation,
    workspace,
    workspaces,
    session,
    modelSelection,
    prompt,
    setPrompt,
    composerAttachments,
    composerImages,
    composerImageIndexes,
    composerDraftKeyRef,
    composerDraftsRef,
    composerEditorRef,
    composerWrapRef,
    composerComposingRef,
    composerMenu,
    composerMenuIndex,
    composerMenuLoading,
    composerMenuError,
    composerCommandOptions,
    composerFileOptions,
    composerCommands,
    updateComposerMenu,
    setComposerMenu: foundation.setComposerMenu,
    setComposerMenuIndex: foundation.setComposerMenuIndex,
    selectComposerOption,
    retryComposerSuggestions,
    addComposerFiles,
    attachPastedText,
    removeComposerAttachment,
    pickComposerAttachments,
    openFile,
    send,
    stopGeneration,
    sendQueuedNow,
    sendAllQueued,
    editQueued,
    deleteQueued,
    reorderQueued,
    queuedPrompts,
    queuedPreviews,
    queuedEditContext,
    queueAdmissionPending,
    sendPromptFromExtension,
    turnActive,
    stopping,
    busy,
    stateLoading,
    sessionLoading,
    preparing,
    compaction,
    composerFeedback,
    setComposerFeedback,
    visiblePermission,
    changePermission,
    retryPermissionMode,
    contextUsageInfo,
    activeContextPolicy,
    compactContext,
    settingsOpen,
    loadModelCatalog,
    selectModel,
    selectThinking,
    modelPickerRequest,
    modelPickerContextKey,
    setModelPickerRequest,
    onConfigureModels: openModelsSettings,
    onOpenSettings: openSettingsPage,
    selectDraftWorkspace,
    chooseFile,
    setActionPaletteOpen,
    error,
    setError,
    conversationFooterExtensionItems,
    extensionPlacements: preferences.extensionPlacements,
    extensionSurface: conversationExtensionSurface,
    notifyExtension,
  }), [
    activeContextPolicy,
    addComposerFiles,
    agentView.kind,
    attachPastedText,
    busy,
    changePermission,
    chooseFile,
    compactContext,
    compaction,
    composerAttachments,
    composerCommandOptions,
    composerCommands,
    composerComposingRef,
    composerDraftKeyRef,
    composerDraftsRef,
    composerEditorRef,
    composerFeedback,
    composerFileOptions,
    composerImageIndexes,
    composerImages,
    composerMenu,
    composerMenuError,
    composerMenuIndex,
    composerMenuLoading,
    composerWrapRef,
    contextUsageInfo,
    conversationExtensionSurface,
    conversationFooterExtensionItems,
    deleteQueued,
    editQueued,
    error,
    foundation.setComposerMenu,
    foundation.setComposerMenuIndex,
    isNewConversation,
    loadModelCatalog,
    modelPickerContextKey,
    modelPickerRequest,
    modelSelection,
    notifyExtension,
    openFile,
    openModelsSettings,
    openSettingsPage,
    pickComposerAttachments,
    preferences.extensionPlacements,
    preparing,
    prompt,
    queueAdmissionPending,
    queuedEditContext,
    queuedPreviews,
    queuedPrompts,
    removeComposerAttachment,
    reorderQueued,
    retryComposerSuggestions,
    retryPermissionMode,
    selectComposerOption,
    selectDraftWorkspace,
    selectModel,
    selectThinking,
    send,
    sendAllQueued,
    sendPromptFromExtension,
    sendQueuedNow,
    session,
    sessionLoading,
    setActionPaletteOpen,
    setComposerFeedback,
    setError,
    setModelPickerRequest,
    setPrompt,
    settingsOpen,
    stateLoading,
    stopGeneration,
    stopping,
    turnActive,
    updateComposerMenu,
    visiblePermission,
    workspace,
    workspaces,
  ]);

  const markdownActionsValue = useMemo(() => ({
    cwd: panelWorkspace,
    openFile: handleOpenFile,
    openLocalFile: (path: string) => { void openFile(path, session?.id, 'external'); },
    openLink: (url: string) => markdownLinkRef.current(url),
  }), [panelWorkspace, session?.id, handleOpenFile, openFile]);

  return (
    <GitRepositoryContext.Provider value={repositories}>
    <MarkdownActions.Provider value={markdownActionsValue}>
    <ExtensionAppearanceContext.Provider value={preferences.extensionAppearances}>
    {/* 四周留白使用独立的背景透明度、柔化和遮罩设置。 */}
    {preferences.backgroundMedia && <BackgroundLayer
      media={preferences.backgroundMedia}
      opacity={preferences.backgroundOpacity}
      blur={preferences.backgroundBlur}
      scrim={preferences.backgroundSurfaceOpacity}
      still={preferences.backgroundInsideVisibility > 0 && preferences.backgroundMedia.kind === 'video'}
      onReady={setOuterReady}
      onError={() => handleBackgroundUnavailable(preferences.backgroundMedia!.url)}
    />}
    <div
      className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${filesOpen && panelFullscreen ? 'is-panel-fullscreen' : ''} ${preferences.backgroundMedia ? 'has-custom-background' : ''} ${preferences.backgroundMedia && preferences.backgroundInsideVisibility > 0 ? 'is-wallpaper-inside' : ''}`}
      style={{
        '--wallpaper-inside': preferences.backgroundInsideVisibility / 100,
        '--sidebar-preferred-width': sidebarWidth ? `${sidebarWidth}px` : undefined,
      } as CSSProperties}
    >
      {preferences.backgroundMedia && preferences.backgroundInsideVisibility > 0 && <div className="window-wallpaper" aria-hidden="true">
        <BackgroundMediaNode media={preferences.backgroundMedia} className="window-wallpaper-media" onReady={setInnerSettled}
          onError={() => setInnerSettled(preferences.backgroundMedia!.url)} />
      </div>}
      {actionPaletteOpen && <ConversationActionPalette
        actions={availableConversationActions}
        loading={actionResourcesLoading}
        resourceError={actionResourcesError}
        onExecute={executeConversationAction}
        onClose={() => setActionPaletteOpen(false)}
      />}
      <ShellLayout
        active={!settingsOpen}
        isNewConversation={isNewConversation}
        resizeHandle={!settingsOpen && !(filesOpen && panelFullscreen) && sidebarResizeHandle}
        sidebar={sidebarNode}
      >
      <ConversationWorkspace
        shell={workspaceShell}
        header={workspaceHeader}
        actions={workspaceActions}
        transcript={workspaceTranscript}
        extensions={workspaceExtensions}
        subagents={subagentWorkspace}
        outline={workspaceOutline}
        composer={workspaceComposer}
      />

      {filesOpen && <Suspense fallback={null}><WorkbenchPane
        controller={workbench}
        settingsOpen={settingsOpen}
        progressPanel={progressContent}
        onOpenComparison={openModelComparison}
        comparisonPanel={<ComparisonWorkbench
          context={comparisonPanelContext}
          starting={comparisonStarting}
          onStartingChange={setComparisonStarting}
          startPending={comparisonStartPending}
          onContextChange={setComparisonPanelContext}
          history={comparisonByParent}
          setHistory={setComparisonByParent}
          workspace={workspace}
          modelSelection={modelSelection}
          onOpenSettings={() => void openSettings('models')}
          onAdopt={id => {
            void loadState().catch(() => {});
            void openSession({
              id, cwd: comparisonPanelContext?.cwd || workspace, title: '模型评估',
              kind: 'durable', goal: '', pinned: false, archived: false,
              createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
            });
          }}
        />}
        workspace={workspace}
        session={session}
        modelSelection={modelSelection}
        workspaceName={panelWorkspaceName}
        dragPreviewRef={dragPreviewRef}
        makeDragPreview={makeDragPreview}
        onChooseWorkspace={chooseFile}
        onOpenSettings={(page) => { void openSettings(page); }}
        terminalAppearance={terminalAppearance}
        terminalShellIntegration={preferences.terminalShellIntegration}
        onTerminalFontSize={(size) => foundation.updatePreference('terminalFontSize', size)}
        extensionDock={<ExtensionSlot
          slot="panel.side"
          cwd={workspace}
          sessionId={session?.id}
          modelRef={modelSelection.modelRef}
          onOpenSettings={(page) => void openSettings(page as typeof settingsTab)}
          onSendPrompt={sendPromptFromExtension}
          onNotify={notifyExtension}
        />}
      /></Suspense>}
      </ShellLayout>

      <SettingsOverlay
        onOpenWorktree={async cwd => { await loadState(); await startSession(cwd); }}
        sidebar={{ collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed, resizeHandle: sidebarResizeHandle }}
        workspace={workspace}
        workspaces={workspaces}
        workspaceRef={foundation.workspaceRef}
        sessionId={session?.id}
        activeWorkspaceName={activeWorkspace?.name}
        models={models}
        defaultModelSelection={defaultModelSelection}
        settings={settingsWorkspace}
        settingsError={settingsError}
        draftGuard={settingsDraftGuard}
        workspaceNotices={{
          conversationListRefreshError,
          stateLoading,
          onRefreshConversations: () => void refreshConversationList(),
        }}
        appearance={{
          preferences,
          onChange: foundation.updatePreference,
          backgroundBusy: foundation.backgroundBusy,
          backgroundError: foundation.backgroundError,
          onChooseBackground: () => void foundation.chooseBackground(),
          onRemoveBackground: () => void foundation.removeBackground(),
          onBackgroundUnavailable: handleBackgroundUnavailable,
          menuBar: foundation.menuBarPreference,
          menuBarBusy: foundation.menuBarBusy,
          onMenuBarChange: (enabled) => void foundation.changeMenuBarVisibility(enabled),
        }}
        permission={{
          cwd: workspace,
          sessionId: session?.id,
          onPolicyChanged: foundation.acceptPermissionState,
        }}
        archives={{
          actionsDisabled: sidebarMutating || conversationListRefreshError,
          workspaces,
          onRestore: restoreArchivedConversation,
          onDelete: permanentlyDeleteArchivedConversation,
          onDeleteGroup: deleteArchivedGroup,
        }}
        skillActions={{
          notify: foundation.pushNotification,
        }}
        extensionContext={{
          sendPrompt: sendPromptFromExtension,
          notify: notifyExtension,
          modelRef: modelSelection.modelRef,
        }}
        about={{
          snapshot: updateSnapshot,
          paths: settingsData!,
          runtime: settingsData?.runtimeVersions,
          onOpenUpdates: openUpdateDialog,
        }}
      />

      <AppDialogs
        confirmation={{
          actionDialog: actionConfirmation.dialog,
          settingsLeaveDialog: settingsLeaveConfirmation.dialog,
          request: confirmRequest,
          setRequest: setConfirmRequest,
          fullPermissionOpen,
          fullPermissionAck,
          setFullPermissionAck,
          setFullPermissionOpen,
          applyPermission,
        }}
        extensions={{
          detail: extensionDetail,
          setDetail: setExtensionDetail,
          busy: settingsBusy || resourceWriteBusy || extensionRefreshBusy || Boolean(extensionRefreshError),
          installerOpen: extensionInstallerOpen,
          installPreview: extensionInstallPreview,
          setInstallerOpen: setExtensionInstallerOpen,
          setInstallPreview: setExtensionInstallPreview,
          workspace,
          workspaceName: activeWorkspace?.name,
          registryUrl: settingsData?.extensionRegistryUrl || '',
        }}
        updates={{
          open: updateDialogOpen,
          snapshot: updateSnapshot,
          close: closeUpdateDialog,
          check: checkUpdates,
          download: downloadUpdate,
          install: installUpdate,
        }}
        mcp={{
          server: mcpDetail,
          close: closeMcpDetail,
          workspace,
          ownerGeneration: mcpDetailOwnerGeneration,
          ownerGenerationRef: mcpDetailGenerationRef,
          workspaceRef: foundation.workspaceRef,
          recoveryRef: mcpOAuthRecoveryRef,
          requestRef: mcpRefreshRequestRef,
          pendingRef: resourcePendingRef,
          setSummary: setMcpRefreshSummary,
          setError: setMcpRefreshError,
        }}
        skills={{
          detail: skillDetail,
          busy: settingsBusy || resourceWriteBusy || resourcePendingRef.current.skills,
          error: skillDetailError || (skillRefreshError ? `${skillRefreshSummary}，刷新尚未完成。${skillRefreshError}` : null),
          refreshing: skillRefreshBusy,
          onRefresh: skillRefreshError ? () => void refreshSavedSkillConfiguration() : undefined,
          onClose: closeSkillDetail,
          onTrust: (skill, trusted) => void toggleSkillTrust(skill, trusted),
        }}
        shortcuts={{ open: shortcutsOpen, close: () => setShortcutsOpen(false) }}
        controller={settingsWorkspace.controller}
      />

    </div>
    </ExtensionAppearanceContext.Provider>
    </MarkdownActions.Provider>
    </GitRepositoryContext.Provider>
  );
}
