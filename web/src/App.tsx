import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ExtensionSlot } from './features/extensions/ExtensionSlot';
import { ConversationActionPalette } from './features/conversation/ConversationActionPalette';
import type { QueuedPreview } from './features/conversation/QueuedMessages';
import { AppSidebar } from './shell/AppSidebar';
import { AppDialogs } from './shell/AppDialogs';
import { BackgroundLayer, BackgroundMediaNode } from './shell/BackgroundLayer';
import { ConversationWorkspace } from './shell/ConversationWorkspace';
import { SettingsOverlay } from './shell/SettingsOverlay';
import { useAppFoundation } from './shell/useAppFoundation';
import { useWindowChrome } from './shell/useWindowChrome';
import { useConversationController } from './shell/useConversationController';
import { ComparisonWorkbench } from './features/comparison/ComparisonWorkbench';
import { WorkbenchPane } from './shell/right-panel/WorkbenchPane';
import { MarkdownActions } from './shared/markdown-actions';
import { errorText } from './shared/error-text';
import './shell/right-panel/panel-file.css';

/** Application composition root: foundation state, conversation runtime, then layout. */
export function App() {
  useWindowChrome();
  const foundation = useAppFoundation();
  const conversation = useConversationController(foundation);
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
    closePanel,
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
    todoPanelOpen,
    setTodoPanelOpen,
    prompt,
    setPrompt,
    composerAttachments,
    composerImages,
    composerImageIndexes,
    composerDraftKeyRef,
    composerDraftsRef,
    textareaRef,
    composerHighlightRef,
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
    conversationExtensionHubItems,
    activeExtensionItem,
    hasConversationExtensionSessionOrder,
    updateConversationExtensionUi,
    openConversationExtensionHub,
    liveDiff,
    handleOpenFile,
    handleOpenAttachment,
    handleOpenChanges,
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
  /** Latest browser opener, read through a ref so the context value stays stable. */
  const markdownLinkRef = useRef<(url: string) => void>(() => {});
  markdownLinkRef.current = (url: string) => openBrowserTab(url);
  // 窗口内壁纸层的不透明度：0 表示完全不透出（设置里的「窗口内可见度」为 0）。
  const insideWallpaperStyle = useMemo(() => ({
    '--wallpaper-inside': preferences.backgroundInsideVisibility / 100,
  }) as CSSProperties, [preferences.backgroundInsideVisibility]);

  const markdownActionsValue = useMemo(() => ({
    cwd: session?.cwd,
    openFile: handleOpenFile,
    openLink: (url: string) => markdownLinkRef.current(url),
  }), [session?.cwd, handleOpenFile]);

  return (
    <MarkdownActions.Provider value={markdownActionsValue}>
    {/* 壁纸在应用卡片之外：卡片内所有表面不透明，壁纸只在四周留白可见。 */}
    {preferences.backgroundMedia && <BackgroundLayer
      media={preferences.backgroundMedia}
      opacity={preferences.backgroundOpacity}
      blur={preferences.backgroundBlur}
      scrim={preferences.backgroundSurfaceOpacity}
      onError={() => handleBackgroundUnavailable(preferences.backgroundMedia!.url)}
    />}
    <div
      className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${filesOpen && panelFullscreen ? 'is-panel-fullscreen' : ''} ${preferences.backgroundMedia ? 'has-custom-background' : ''} ${preferences.backgroundMedia && preferences.backgroundInsideVisibility > 0 ? 'is-wallpaper-inside' : ''}`}
      style={insideWallpaperStyle}
    >
      {/* 窗口内的壁纸副本：只铺在画布层，气泡、输入框与菜单仍然不透明。 */}
      {preferences.backgroundMedia && preferences.backgroundInsideVisibility > 0 && <div className="window-wallpaper" aria-hidden="true">
        <BackgroundMediaNode media={preferences.backgroundMedia} className="window-wallpaper-media" />
      </div>}
      {actionPaletteOpen && <ConversationActionPalette
        actions={availableConversationActions}
        loading={actionResourcesLoading}
        resourceError={actionResourcesError}
        onExecute={executeConversationAction}
        onClose={() => setActionPaletteOpen(false)}
      />}
      <AppSidebar
        updateSnapshot={updateSnapshot}
        updateProgress={updateProgress}
        onOpenUpdateDialog={openUpdateDialog}
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
      />

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
          filesOpen,
        }}
        header={{
          conversationDetailExtensionCount: conversationDetailExtensionItems.length,
          openNotificationSession,
          runNotificationAction,
          togglePanel: () => {
            if (filesOpen) closePanel();
            else openPanel();
          },
          returnToMainAgent,
          openAgentOverview: subagentWorkspace.openAgentOverview,
          openConversationExtensionHub,
          openTrace,
        }}
        actions={{
          openAttachment: handleOpenAttachment,
          openFile: handleOpenFile,
          openChanges: handleOpenChanges,
          editMessage: handleEditMessage,
        }}
        transcript={{
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
        }}
        extensions={{
          chipItems: conversationExtensionChipItems,
          openChip: openConversationExtensionChip,
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
          textareaRef,
          composerHighlightRef,
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
          todoDetails,
          todoPanelOpen,
          setTodoPanelOpen,
          longTaskBusy,
          changeLongTaskStatus,
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
          extensionSurface: conversationExtensionSurface,
          notifyExtension,
        }}
      />

      <SettingsOverlay
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

      {filesOpen && <WorkbenchPane
        controller={workbench}
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
    </div>
    </MarkdownActions.Provider>
  );
}
