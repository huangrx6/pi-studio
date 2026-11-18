import { useCallback, useMemo, useRef } from 'react';
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
import { WorkbenchPane } from './shell/right-panel/WorkbenchPane';
import { MarkdownActions } from './shared/markdown-actions';
import { errorText } from './shared/error-text';
import './shell/right-panel/styles/panel-file.css';

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
    outlineHover,
    setOutlineHover,
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
  function chooseFile() {
    void window.piApi.chooseWorkspace().then((selected) => {
      if (selected) {
        if (isNewConversation) selectDraftWorkspace(selected);
        else void startSession(selected);
        void loadState();
      }
    }).catch(error => setError(errorText(error)));
  }

  const queuedPreviews: QueuedPreview[] = queuedPrompts.map((item) => ({
    id: item.id,
    text: item.text.trim() || (item.attachments.some((attachment) => attachment.kind === 'image') ? '图片消息' : '附件消息'),
    images: item.attachments.filter((attachment) => attachment.kind === 'image').length,
    files: item.attachments.filter((attachment) => attachment.kind === 'file').length,
    error: item.autoRetryError,
    admissionPending: Boolean(
      session?.id
      && queueAdmissionPendingBySession[session.id] === item.submission.requestId,
    ),
  }));
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
  function navigateFromProgress(action: () => void) {
    dismissProgress();
    if (workbench.panelFullscreen) workbench.setPanelFullscreen(false);
    action();
  }
  function openProgressPage(action: () => void) {
    navigateFromProgress(action);
    if (filesOpen && window.matchMedia('(max-width: 1100px)').matches) workbench.closePanel();
  }
  function openGit(tab: import('./types/git-types').GitTab) {
    openProgressPage(() => {
      conversation.rememberMainScrollPosition();
      foundation.setAgentView({ kind: 'git', tab });
    });
  }
  const progressContent = <ConversationProgress key={session?.id} sessionId={session?.id} pinned={progressPinned}
    onPinChange={() => {
      setProgressView(view => ({ ...view, floating: progressPinned && Boolean(session) }));
      if (progressPinned) {
        workbench.setPanelFullscreen(false);
        workbench.closePanelTab('progress');
      } else workbench.openProgressTab();
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.conversation-progress .progress-pin')?.focus());
    }}
    git={gitStatus} onGitSettings={() => navigateFromProgress(() => void openSettings('git'))}
    onOpenGit={openGit}
    goal={session?.longTask} running={turnActive} goalBusy={longTaskBusy} onGoalAction={changeLongTaskStatus}
    onEditGoal={() => navigateFromProgress(() => { returnToMainAgent(); sendPromptFromExtension('/goal ', false); })}
    onOpenTasks={() => openProgressPage(() => {
      conversation.rememberMainScrollPosition();
      foundation.setAgentView({ kind: 'tasks' });
    })}
    tasks={todoDetails} history={progressView.history} onToggleHistory={() => setProgressView(view => ({ ...view, history: !view.history }))}
    agents={subagentWorkspace.subagentChildren} onAgents={() => openProgressPage(subagentWorkspace.openAgentOverview)}
    onAgent={child => openProgressPage(() => subagentWorkspace.openAgentTranscript(child))} />;
  /** Latest browser opener, read through a ref so the context value stays stable. */
  const markdownLinkRef = useRef<(url: string) => void>(() => {});
  markdownLinkRef.current = (url: string) => openBrowserTab(url);
  const sidebarResizeHandle = !sidebarCollapsed && <SidebarResizeHandle onResize={setSidebarWidth} />;

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
        sidebar={<AppSidebar
        onStartSession={() => void startSession()}
        onOpenTemporaryChat={openTemporaryChat}
        onOpenSettings={(page) => { void openSettings(page); }}
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
        onOpenWorkspaceSearch={() => setWorkspaceSearchOpen(true)}
        onCloseWorkspaceSearch={closeSidebarSearch}
        onChooseFile={chooseFile}
        workspaceQuery={workspaceQuery}
        sidebarSessionFilter={sidebarSessionFilter}
        onWorkspaceQueryChange={changeWorkspaceQuery}
        onSidebarFilterChange={changeSidebarFilter}
        conversationListRefreshError={conversationListRefreshError}
        stateLoading={stateLoading}
        settingsOpen={settingsOpen}
        onRefreshConversationList={() => void refreshConversationList()}
        sidebarMutating={sidebarMutating}
        visibleWorkspaces={visibleWorkspaces}
        expanded={expanded}
        sidebarFiltering={sidebarFiltering}
        searchCollapsed={searchCollapsed}
        filterKey={`${workspaceQuery}\u0000${sidebarSessionFilter}`}
        sidebarCollapsed={sidebarCollapsed}
        sidebarActions={sidebarActions}
        onCollapse={() => setSidebarCollapsed(true)}
        />}
      >
      <ConversationWorkspace
        shell={{
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
          notificationCount: notifications.filter((item) => !item.read).length,
          notifications,
          setNotifications,
          markAllRead: markAllNotificationsRead,
          clearNotifications,
          conversationSubscriptionError,
          retryConversationSubscription,
          settingsOpen,
        }}
        header={{
          update: updateSnapshot.state === 'available' || updateSnapshot.state === 'downloading' || updateSnapshot.state === 'downloaded'
            ? {
              state: updateSnapshot.state,
              latestVersion: updateSnapshot.latestVersion,
              onOpen: openUpdateDialog,
            }
            : null,
          conversationDetailExtensionCount: conversationDetailExtensionItems.length,
          quotaProvider,
          openNotificationSession,
          runNotificationAction,
          panelExpanded: workbench.panelEntered,
          openPanel,
          returnToMainAgent,
          gitStatus,
          openGit,
          progressTrigger: <ProgressTrigger open={!progressPinned && progressView.floating} pinned={progressPinned}
            active={progressPinned && workbench.panelEntered && workbench.activePanelTabId === 'progress'}
            onDismiss={dismissProgress} onToggle={() => {
              if (progressPinned) workbench.openProgressTab();
              else setProgressView(view => ({ ...view, floating: !view.floating }));
            }}>{progressContent}</ProgressTrigger>,
          openConversationExtensionHub,
          openTrace,
        }}
        actions={{
          openAttachment: handleOpenAttachment,
          openFile: handleOpenFile,
          openGitFile: (root, path) => { void openFile(path, session?.id, 'workspace', { cwd: root, refresh: true }); },
          openChanges: handleOpenChanges,
          undoTurnDiff,
          editMessage: handleEditMessage,
        }}
        transcript={{
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
          resetToLatest: () => resetToLatest(),
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
        }}
        extensions={{
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
          openSettings: (page) => { void openSettings(page); },
          sendPrompt: sendPromptFromExtension,
          notify: notifyExtension,
          openHub: openConversationExtensionHub,
        }}
        subagents={subagentWorkspace}
        outline={{
          items: outlineItems,
          samples: outlineSamples,
          active: outlineActive,
          hover: outlineHover,
          setHover: setOutlineHover,
          jump: jumpToOutline,
        }}
        composer={{
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
          modelPickerContextKey: `${workspace}:${session?.id ?? 'draft'}:${sessionLoadRef.current}`,
          setModelPickerRequest,
          onConfigureModels: () => { void openSettings('models'); },
          onOpenSettings: (page) => { void openSettings(page); },
          selectDraftWorkspace,
          chooseFile,
          setActionPaletteOpen,
          error,
          setError,
          conversationFooterExtensionItems,
          extensionPlacements: preferences.extensionPlacements,
          extensionSurface: conversationExtensionSurface,
          notifyExtension,
        }}
      />

      {filesOpen && <WorkbenchPane
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
      />}
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
