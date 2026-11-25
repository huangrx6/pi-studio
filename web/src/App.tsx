import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ExtensionSlot } from './features/extensions/ExtensionSlot';
import { ExtensionSummaries } from './features/extensions/ExtensionSummaries';
import type { ExtensionPanelPickerProps } from './features/extensions/ExtensionPanelPicker';
import { ConversationExtensionsMenu } from './shell/ConversationExtensionsMenu';
import { SessionWorkbenchPanel } from './shell/right-panel/SessionWorkbenchPanel';
import { useSettingsToast } from './shared/SettingsToast';
import { SurfaceActiveContext } from './shared/surface-visibility';
import { ExtensionAppearanceContext } from './features/extensions/ExtensionStatusIcon';
import { ConversationActionPalette } from './features/conversation/ConversationActionPalette';
import type { QueuedPreview } from './features/conversation/QueuedMessages';
import { AppSidebar } from './shell/AppSidebar';
import { AppDialogs } from './shell/AppDialogs';
import { BackgroundLayer, BackgroundMediaNode } from './shell/BackgroundLayer';
import { ConversationProgress } from './shell/ConversationProgress';
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
import { MarkdownActions } from './shared/markdown-actions';
import { errorText } from './shared/error-text';

const WorkbenchPane = lazy(async () => {
  const module = await import('./shell/right-panel/WorkbenchPane');
  return { default: module.WorkbenchPane };
});

/** Application composition root: foundation state, conversation runtime, then layout. */
export function App() {
  useWindowChrome();
  const showSettingsToast = useSettingsToast();
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
    composerMentionOptions,
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
    focusConversation,
    openTrace,
    conversationExtensions,
    extensionMenuOpen,
    setExtensionMenuOpen,
    openExtensionPanel,
    quotaSource,
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
    updateComposerMenu,
    sendPromptFromExtension,
    executeExtensionCommand,
    selectComposerOption,
    retryConversationSubscription,
    refreshConversationList,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
    deleteArchivedGroup,
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
  const openGit = workbench.openGitTab;
  const progressContent = (
    <ConversationProgress
      key={session?.id}
      sessionId={session?.id}
      goal={session?.longTask}
      running={turnActive}
      goalBusy={longTaskBusy}
      onGoalAction={changeLongTaskStatus}
      onEditGoal={() => {
        focusConversation();
        sendPromptFromExtension('/goal ', false);
      }}
      tasks={todoDetails}
      onOpenTasks={() => workbench.openProgressTab('tasks')}
      onOpenHistory={() => workbench.openProgressTab('history')}
      agents={subagentWorkspace.subagentChildren}
      onAgents={subagentWorkspace.openAgentOverview}
      onAgent={subagentWorkspace.openAgentTranscript}
    />
  );
  const workbenchTrace = useMemo(() => ({
    turns: transcriptTurns,
    toolResults: toolResultMap,
    requestPlacement,
    turnActive,
  }), [transcriptTurns, toolResultMap, requestPlacement, turnActive]);
  /** Latest browser opener, read through a ref so the context value stays stable. */
  const markdownLinkRef = useRef<(url: string) => void>(() => {});
  markdownLinkRef.current = (url: string) => {
    void (async () => {
      const raw = String(url || '').trim();
      if (!raw) return;
      try {
        const settings = await window.piApi.browserAdvancedSettings?.();
        let local = false;
        try {
          const parsed = new URL(raw);
          local = parsed.protocol === 'file:'
            || parsed.hostname === 'localhost'
            || parsed.hostname === '127.0.0.1'
            || parsed.hostname === '[::1]'
            || parsed.hostname.endsWith('.localhost');
        } catch {
          // Absolute/relative filesystem paths and bare localhost hosts.
          local = raw.startsWith('file:')
            || raw.startsWith('/')
            || raw.startsWith('~/')
            || raw.startsWith('./')
            || raw.startsWith('../')
            || /^[A-Za-z]:[\\/]/.test(raw)
            || /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(raw)
            || /^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(raw);
        }
        const target = (local ? settings?.localLinkOpenTarget : settings?.webLinkOpenTarget) === 'system'
          ? 'system'
          : 'workbench';

        if (target === 'system') {
          if (/^https?:\/\//i.test(raw)) {
            await window.piApi.openLink(raw, 'external');
            return;
          }
          if (local) {
            const filePath = (() => {
              try {
                if (/^file:/i.test(raw)) return decodeURIComponent(new URL(raw).pathname || '');
              } catch {
                // fall through
              }
              return raw.replace(/^file:\/\//i, '');
            })();
            if (filePath) {
              await window.piApi.openWith({ path: filePath, source: 'external' });
              return;
            }
          }
        }

        // workbench: browsable pages → side browser; other local files → in-app preview.
        const browsable = raw === 'about:blank'
          || /^https?:\/\//i.test(raw)
          || /^file:.*\.html?([?#].*)?$/i.test(raw)
          || /\.html?([?#].*)?$/i.test(raw)
          || /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(raw)
          || /^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(raw);
        if (local && !browsable) {
          const filePath = (() => {
            try {
              if (/^file:/i.test(raw)) return decodeURIComponent(new URL(raw).pathname || '');
            } catch {
              // fall through
            }
            return raw.replace(/^file:\/\//i, '');
          })();
          if (filePath) {
            void openFile(filePath, session?.id, 'external');
            return;
          }
        }
      } catch {
        // Fall through to workbench browser.
      }
      openBrowserTab(raw);
    })();
  };

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
      isNewConversation={!session && !settingsOpen}
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
    onSidebarCollapse,
    onSidebarOpenSearch,
    onSidebarOpenSettings,
    onSidebarRefreshList,
    onSidebarStartSession,
    openTemporaryChat,
    searchCollapsed,
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
    workspaceQuery,
    workspaceSearchOpen,
    workspaceSearchTrigger,
    workspace,
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
  const workspaceShell = useMemo(() => ({
    isNewConversation,
    sessionLoading,
    messageCount: messages.length,
    sidebarCollapsed,
    setSidebarCollapsed,
    session,
    preferences,
    turnActive,
    busy,
    error,
    setError,
    compaction,
    retryInfo,
    liveDiff,
    conversationSubscriptionError,
    retryConversationSubscription,
    settingsOpen,
    visible: !settingsOpen && !panelFullscreen,
  }), [
    busy,
    compaction,
    conversationSubscriptionError,
    error,
    isNewConversation,
    liveDiff,
    messages.length,
    panelFullscreen,
    preferences,
    retryConversationSubscription,
    retryInfo,
    session,
    sessionLoading,
    setError,
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

  const extensionPicker: ExtensionPanelPickerProps = {
    surface: conversationExtensions.surface,
    groups: conversationExtensions.groups,
    cwd: panelWorkspace,
    sessionId: session?.id,
    modelRef: modelSelection.modelRef,
    quotaSource,
    onOpenPanel: panelId => { void openExtensionPanel(panelId); },
    onOpenSettings: openSettingsPage,
    onSendPrompt: sendPromptFromExtension,
    onNotify: notifyExtension,
    onManage: () => openSettingsPage('extensions'),
  };
  const selectedTool = workbench.panelEntered ? workbench.activePanelTab?.kind : undefined;
  const workspaceHeader = {
    update: headerUpdate,
    gitStatus,
    panelExpanded: workbench.panelEntered,
    onOpenPanel: openPanel,
    onOpenProgress: workbench.openProgressTab,
    onOpenTrace: openTrace,
    onOpenGit: openGit,
    activeTool: selectedTool === 'progress' || selectedTool === 'trace' ? selectedTool : undefined,
    status: !panelFullscreen && conversationExtensions.headerItems.length > 0 ?
      <ExtensionSummaries {...extensionPicker} slot="status.chip" items={conversationExtensions.headerItems} />
      : undefined,
    extensionMenu: <ConversationExtensionsMenu {...extensionPicker}
      open={extensionMenuOpen} onOpenChange={setExtensionMenuOpen} />,
  };
  const openGitChangesRef = useRef<() => void>(() => {});
  openGitChangesRef.current = () => openGit('changes');
  const handleOpenGitChanges = useCallback(() => {
    openGitChangesRef.current();
  }, []);
  const workspaceActions = useMemo(() => ({
    openAttachment: handleOpenAttachment,
    openFile: handleOpenFile,
    openChanges: handleOpenChanges,
    openGit: handleOpenGitChanges,
    undoTurnDiff,
    editMessage: handleEditMessage,
  }), [
    handleEditMessage,
    handleOpenAttachment,
    handleOpenChanges,
    handleOpenFile,
    handleOpenGitChanges,
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
    composerMentionOptions,
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
    extensionAboveItems: conversationExtensions.aboveItems,
    extensionBelowItems: conversationExtensions.belowItems,
    extensionSurface: conversationExtensions.surface,
    openExtensionPanel,
    notifyExtension,
  }), [
    activeContextPolicy,
    addComposerFiles,
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
    composerMentionOptions,
    composerImageIndexes,
    composerImages,
    composerMenu,
    composerMenuError,
    composerMenuIndex,
    composerMenuLoading,
    composerWrapRef,
    contextUsageInfo,
    conversationExtensions.aboveItems,
    conversationExtensions.belowItems,
    conversationExtensions.surface,
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
    openExtensionPanel,
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
    openLocalFile: (path: string) => {
      // All local links honor localLinkOpenTarget (one setting; Studio picks the surface).
      void (async () => {
        const raw = String(path || '').trim();
        if (!raw) return;
        try {
          const settings = await window.piApi.browserAdvancedSettings?.();
          if (settings?.localLinkOpenTarget === 'system') {
            await window.piApi.openWith({ path: raw, source: 'external' });
            return;
          }
        } catch {
          // Fall through to workbench / in-app preview.
        }
        // App-internal: pages the browser can load → side browser; other files → preview.
        if (/\.html?$/i.test(raw.split(/[?#]/)[0] || '')) {
          markdownLinkRef.current(raw);
          return;
        }
        void openFile(raw, session?.id, 'external');
      })();
    },
    openLink: (url: string) => markdownLinkRef.current(url),
  }), [panelWorkspace, session?.id, handleOpenFile, openFile]);

  const extensionWorkspaces = useMemo(
    () => workspaces.map(item => ({ name: item.name, path: item.cwd })),
    [workspaces],
  );
  useEffect(() => (
    window.piApi.onWorkbenchRefresh?.(event => {
      if (event.scope === 'all' || event.scope === 'sessions') void loadState();
    })
  ), [loadState]);

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
      {!settingsOpen && actionPaletteOpen && <ConversationActionPalette
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
      <SurfaceActiveContext.Provider value={workspaceShell.visible}>
      <ConversationWorkspace
        shell={workspaceShell}
        header={workspaceHeader}
        actions={workspaceActions}
        transcript={workspaceTranscript}
        outline={workspaceOutline}
        composer={workspaceComposer}
      />
      </SurfaceActiveContext.Provider>

      {filesOpen && <Suspense fallback={null}><WorkbenchPane
        controller={workbench}
        settingsOpen={settingsOpen}
        renderToolPanel={tab => <SessionWorkbenchPanel
          tab={tab}
          session={session}
          preferences={preferences}
          workspaces={extensionWorkspaces}
          modelSelection={modelSelection}
          progress={progressContent}
          trace={workbenchTrace}
          subagents={subagentWorkspace}
          extensions={extensionPicker}
          onOpenTemporaryChat={openTemporaryChat}
          onOpenProgress={workbench.openProgressTab}
          onOpenGit={openGit}
          onOpenGitFile={openGitFile}
          onOpenFile={handleOpenFile}
          onFocusConversation={focusConversation}
        />}
        extensionPicker={extensionPicker}
        launcherOrder={preferences.workbenchLauncherOrder}
        onLauncherOrderChange={(order) => foundation.updatePreference('workbenchLauncherOrder', order)}
        showTrace={preferences.showCodeView}
        workspace={workspace}
        workspaces={workspaces}
        session={session}
        modelSelection={modelSelection}
        workspaceName={panelWorkspaceName}
        dragPreviewRef={dragPreviewRef}
        makeDragPreview={makeDragPreview}
        onSelectWorkspace={selectDraftWorkspace}
        onChooseWorkspace={chooseFile}
        onOpenSettings={(page) => { void openSettings(page); }}
        terminalAppearance={terminalAppearance}
        terminalShellIntegration={preferences.terminalShellIntegration}
        onTerminalFontSize={(size) => foundation.updatePreference('terminalFontSize', size)}
      /></Suspense>}
      </ShellLayout>

      <SettingsOverlay
        onOpenWorktree={async cwd => { await loadState(); await startSession(cwd); }}
        onOpenGitChanges={() => openGit('changes')}
        onChooseWorkspace={chooseFile}
        onOpenBrowser={(view) => openBrowserTab('', { library: view })}
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
        extensionOrder={{
          items: conversationExtensions.orderableItems,
          order: conversationExtensions.order,
          saving: conversationExtensions.savingOrder,
          onSave: conversationExtensions.saveOrder,
          onRetry: conversationExtensions.retryOrder,
        }}
        appearance={{
          preferences,
          onChange: foundation.updatePreference,
          backgroundBusy: foundation.backgroundBusy,
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
        about={{
          snapshot: updateSnapshot,
          paths: settingsData!,
          runtime: settingsData?.runtimeVersions,
          onOpenUpdates: openUpdateDialog,
          onOpenBrowserSettings: () => { void openSettings('browser'); },
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
          display: { preferences, onChange: foundation.updatePreference },
          settingsPanel: extensionDetail?.available && extensionDetail.manifest?.contributes?.settings?.length ? <ExtensionSlot
            key={extensionDetail.id}
            slot="settings.panel"
            extensionId={extensionDetail.id}
            cwd={workspace}
            sessionId={session?.cwd === workspace ? session?.id : undefined}
            modelRef={modelSelection.modelRef}
            onOpenSettings={openSettingsPage}
            onOpenPanel={extensionPicker.onOpenPanel}
            onSendPrompt={sendPromptFromExtension}
            onNotify={({ message, tone }) => showSettingsToast(message, tone === 'error' || tone === 'success' ? tone : 'info')}
          /> : undefined,
          setDetail: setExtensionDetail,
          busy: settingsBusy || resourceWriteBusy || extensionRefreshBusy || Boolean(extensionRefreshError),
          refreshError: extensionRefreshError,
          refreshing: extensionRefreshBusy || resourceWriteBusy,
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
          error: skillRefreshError ? `${skillRefreshSummary}，刷新尚未完成。${skillRefreshError}` : null,
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
