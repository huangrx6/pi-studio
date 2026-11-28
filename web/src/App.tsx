import { seedTemporaryChat } from './features/conversation/temporary-chat-store';
import { RightEditorGroup, SessionDocument, SessionContentTabs } from './shell/SessionContent';
import { useSessionNavigation } from './shell/useSessionNavigation';
import { SessionInspectorPanel } from './shell/SessionInspectorPanel';
import { SessionInspectionCard } from './shell/SessionInspectionCard';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ExtensionSlot } from './features/extensions/ExtensionSlot';
import type { ExtensionSummaryContext } from './features/extensions/ExtensionSummaries';
import { AppHubCanvas, preloadAppHub } from './shell/AppHubCanvas';
import { StudioStatusBar } from './shell/StudioStatusBar';
import { useSettingsToast } from './shared/SettingsToast';
import { SurfaceActiveContext } from './shared/surface-visibility';
import { ExtensionAppearanceContext } from './features/extensions/ExtensionStatusIcon';
import { ConversationActionPalette } from './features/conversation/ConversationActionPalette';
import type { QueuedPreview } from './features/conversation/QueuedMessages';
import { TemporaryChatCanvas } from './features/conversation/TemporaryChatCanvas';
import { PlansCanvas } from './shell/PlansCanvas';
import { MobileCanvas } from './shell/MobileCanvas';
import { TeamCanvas, type TeamRoute } from './shell/TeamCanvas';
import { AppSidebar, type MobileView, type PlansView, type SidebarSection } from './shell/AppSidebar';
import { isPluginWorkspaceTab, pluginSettingsSearchPages, settingsPages, type SettingsTab } from './shell/app-shell-config';
import { AppDialogs } from './shell/AppDialogs';
import { BackgroundLayer, BackgroundMediaNode } from './shell/BackgroundLayer';
import { ConversationProgress } from './shell/ConversationProgress';
import { useGitWorkspaceStatus } from './shell/useGitWorkspaceStatus';
import { GitRepositoryContext, useWorkspaceRepositories } from './features/git/useWorkspaceRepositories';
import { GitBranchPicker } from './features/git/GitBranchPicker';
import { GitRepositoryPicker } from './features/git/GitRepositoryPicker';
import { GitWorktreePicker } from './features/git/GitWorktreePicker';
import { ConversationWorkspace } from './shell/ConversationWorkspace';
import { SettingsNavigation } from './shell/SettingsNavigation';
import { SettingsOverlay, preloadSettingsTab } from './shell/SettingsOverlay';
import { ShellLayout, WorkspacePanelToggle } from './shell/ShellLayout';
import { SidebarResizeHandle, useSidebarWidth } from './shell/SidebarResizeHandle';
import { useAppFoundation } from './shell/useAppFoundation';
import { useWindowChrome } from './shell/useWindowChrome';
import { trackDismissFocus } from './shared/keyboard-navigation';
import { useLaunchScreen } from './shell/useLaunchScreen';
import { useConversationController } from './shell/useConversationController';
import { MarkdownActions } from './shared/markdown-actions';
import { preloadFilePreview } from './shared/DeferredFilePreview';
import { errorText } from './shared/error-text';

let workbenchPanePromise: Promise<typeof import('./shell/right-panel/WorkbenchPane')> | null = null;

function preloadWorkbenchPane() {
  workbenchPanePromise ??= import('./shell/right-panel/WorkbenchPane').catch((error) => {
    workbenchPanePromise = null;
    throw error;
  });
  return workbenchPanePromise;
}

const WorkbenchPane = lazy(async () => {
  const module = await preloadWorkbenchPane();
  return { default: module.WorkbenchPane };
});
const ComparisonFileDialog = lazy(() => import('./shell/right-panel/WorkspaceFiles').then(module => ({ default: module.ComparisonFileDialog })));

/** Application composition root: foundation state, conversation runtime, then layout. */
export function App() {
  useWindowChrome();
  useEffect(trackDismissFocus, []);
  const showSettingsToast = useSettingsToast();
  useEffect(() => {
    const warm = () => {
      void preloadWorkbenchPane().catch(() => {});
      void preloadFilePreview().catch(() => {});
      void preloadAppHub().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(warm, 600);
    return () => window.clearTimeout(timer);
  }, []);
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
    visibleProjects,
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
    teamRoute, setTeamRoute,
    workbench,
    openPanel,
    openBrowserTab,
    openFile,
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
  const {
    settingsWorkspace,
    settingsOpen,
    settingsTab,
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
    mcpOAuthRecoveryRef,
    mcpRefreshRequestRef,
    resourcePendingRef,
    mcpDetailGenerationRef,
    openSettings,
    closeSettings,
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
    inspection, inspectorToggleRef, cardSummary, openProgress, inspectSession,
    appHubOpen,
    openAppHub,
    section,
    selectSection,
    statusPanelId,
    closeStatusPanel,
    conversationExtensions,
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
    changeLongTaskStatus,
    stopGeneration,
    editQueued,
    deleteQueued,
    reorderQueued,
    startSession,
    selectDraftWorkspace,
    updateComposerMenu,
    sendPromptFromExtension,
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
  const panelWorkspace = workbench.cwd;
  const repositories = useWorkspaceRepositories(panelWorkspace);
  const { status: gitStatus } = useGitWorkspaceStatus(panelWorkspace, repositories.selected?.id, workbench.layoutOwner);
  const checkout = gitStatus?.worktrees.find(tree => tree.path === panelWorkspace);
  const checkedOutBranch = checkout?.branch || checkout?.head?.slice(0, 8);
  const listedBranch = workspaces.find(row => row.cwd === panelWorkspace)?.worktree?.branch;
  useEffect(() => {
    if (checkedOutBranch && checkedOutBranch !== listedBranch) void loadState().catch(cause => setError(errorText(cause)));
  }, [panelWorkspace, checkedOutBranch, listedBranch, loadState, setError]);
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
      onOpenTasks={() => openProgress('tasks')}
      onOpenHistory={() => openProgress('history')}
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
            void openFile(filePath, undefined, 'external');
            return;
          }
        }
      } catch {
        // Fall through to workbench browser.
      }
      openBrowserTab(raw);
    })();
  };

  const [plansView, setPlansView] = useState<PlansView>('plans');
  const navigateTeam = useCallback((route: TeamRoute) => {
    if (route.view === 'workspace' && route.cwd) foundation.expandWorkspace(route.cwd);
    selectSection('team');
    setTeamRoute(route);
  }, [selectSection, setTeamRoute, foundation.expandWorkspace]);
  const [mobileView, setMobileView] = useState<MobileView>('pairing');
  const { activeId: temporaryId, selection: temporaryModel, history: temporaryHistory, loading: temporaryHistoryLoading,
    error: temporaryHistoryError, open: openTemporaryHistory,
    refresh: refreshTemporaryHistory } = conversation.temporary;
  const onSidebarStartSession = useCallback(() => { void startSession(); }, [startSession]);
  const runInWorkbench = useCallback(async (action: () => void | Promise<unknown>) => {
    if (settingsOpen && !await closeSettings({ restoreFocus: false })) return;
    await action();
  }, [settingsOpen, closeSettings]);
  const onSidebarSectionChange = useCallback((next: SidebarSection) => {
    void runInWorkbench(() => selectSection(next));
  }, [runInWorkbench, selectSection]);
  const onSidebarOpenSettings = useCallback((page?: Parameters<typeof openSettings>[0]) => { void openSettings(page); }, [openSettings]);
  const onSidebarOpenSearch = useCallback(() => setWorkspaceSearchOpen(true), [setWorkspaceSearchOpen]);
  const onSidebarRefreshList = useCallback(() => { void refreshConversationList(); }, [refreshConversationList]);
  const onSidebarCollapse = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed]);
  const sidebarLaunchableApps = conversationExtensions.toolPanels;
  const openLaunchableApp = useCallback((panelId: string) => {
    void openExtensionPanel(panelId);
  }, [openExtensionPanel]);
  const onAppHubOpenResource = useCallback((section: 'mcp' | 'skills' | 'extensions') => {
    void openSettings(section);
  }, [openSettings]);
  const onAppHubPluginsChanged = useCallback((settings: Parameters<typeof settingsWorkspace.controller.acceptRuntimeSnapshot>[0], message: string) => {
    settingsWorkspace.controller.invalidateResourceReads();
    settingsWorkspace.controller.acceptRuntimeSnapshot(settings, message);
  }, [settingsWorkspace.controller]);
  const sidebarFilterKey = useMemo(
    () => `${workspaceQuery}\u0000${sidebarSessionFilter}`,
    [workspaceQuery, sidebarSessionFilter],
  );
  const settingsNavigation = settingsOpen && <SettingsNavigation
    pages={settingsPages} searchPages={pluginSettingsSearchPages}
    activeId={settingsTab} searchActiveId={isPluginWorkspaceTab(settingsTab) ? settingsWorkspace.state.pluginSection : settingsTab}
    searchShortcut={preferences.shortcuts.palette} onPreload={preloadSettingsTab}
    onSelect={id => { void settingsWorkspace.controller.selectSettingsTab(id as SettingsTab); }}
    collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}
  />;
  const sidebarNode = useMemo(() => (
    <AppSidebar
      onStartSession={onSidebarStartSession}
      section={section}
      onSectionChange={onSidebarSectionChange}
      plansView={plansView}
      onPlansViewChange={setPlansView}
      teamRoute={teamRoute}
      onTeamNavigate={navigateTeam}
      mobileView={mobileView}
      onMobileViewChange={setMobileView}
      onOpenTemporaryChat={openTemporaryChat}
      activeTemporaryId={temporaryId}
      temporaryHistory={temporaryHistory}
      temporaryHistoryLoading={temporaryHistoryLoading}
      temporaryHistoryError={temporaryHistoryError}
      onRetryTemporaryHistory={refreshTemporaryHistory}
      onOpenTemporaryHistory={openTemporaryHistory}
      onOpenSettings={onSidebarOpenSettings}
      launchableApps={sidebarLaunchableApps}
      appHubOpen={appHubOpen}
      onOpenAppHub={openAppHub}
      onOpenApp={openLaunchableApp}
      workspace={workspace}
      sessionId={section === 'conversations' ? session?.id : undefined}
      isNewConversation={!session && !settingsOpen && section === 'conversations'}
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
      settingsNavigation={settingsNavigation}
      onRefreshConversationList={onSidebarRefreshList}
      sidebarMutating={sidebarMutating}
      visibleProjects={visibleProjects}
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
    appHubOpen,
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
    openAppHub,
    openTemporaryHistory,
    mobileView,
    plansView,
    refreshTemporaryHistory,
    section,
    onSidebarSectionChange,
    openTemporaryChat,
    navigateTeam, teamRoute,
    temporaryHistory,
    temporaryHistoryError,
    temporaryHistoryLoading,
    temporaryId,
    searchCollapsed,
    session?.id,
    settingsOpen,
    settingsNavigation,
    sidebarActions,
    sidebarCollapsed,
    sidebarFilterKey,
    sidebarFiltering,
    sidebarLaunchableApps, openLaunchableApp,
    sidebarMutating,
    sidebarSessionFilter,
    stateLoading,
    toggleAllExpanded,
    visibleProjects,
    workspaceQuery,
    workspaceSearchOpen,
    workspaceSearchTrigger,
    workspace,
    workspaces,
  ]);

  const sidebarResizeHandle = !sidebarCollapsed && <SidebarResizeHandle onResize={setSidebarWidth} />;


  const openGitFile = useCallback((root: string, path: string) => {
    void openFile(path, undefined, 'workspace', { cwd: root });
  }, [openFile]);
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
    visible: section === 'conversations' && !settingsOpen && !workbench.activeTab,
  }), [
    busy,
    compaction,
    conversationSubscriptionError,
    error,
    isNewConversation,
    liveDiff,
    messages.length,
    workbench.activeTab,
    preferences,
    retryConversationSubscription,
    retryInfo,
    section,
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

  const extensionPicker = useMemo<ExtensionSummaryContext>(() => ({
    surface: conversationExtensions.surface,
    cwd: panelWorkspace,
    sessionId: session?.id,
    modelRef: modelSelection.modelRef,
    quotaSource,
    onOpenPanel: panelId => { void openExtensionPanel(panelId); },
    onOpenSettings: openSettingsPage,
    onSendPrompt: (text, submit) => { void runInWorkbench(() => sendPromptFromExtension(text, submit)); },
    onNotify: notifyExtension,
  }), [
    conversationExtensions.surface,
    modelSelection.modelRef,
    notifyExtension,
    openExtensionPanel,
    openSettingsPage,
    panelWorkspace,
    quotaSource,
    runInWorkbench,
    sendPromptFromExtension,
    session?.id,
  ]);
  const chatExtensions = useMemo(() => section === 'temporary'
    ? { ...extensionPicker, sessionId: undefined, modelRef: temporaryModel?.modelRef }
    : extensionPicker, [section, temporaryModel?.modelRef, extensionPicker]);
  const temporaryChat = section === 'temporary' ? temporaryHistory.find(row => row.id === temporaryId) : undefined;
  const sessionTitle = section === 'temporary' ? temporaryChat?.title || '临时对话'
    : section === 'team' && teamRoute.view === 'workspace'
      ? workspaces.find(item => item.cwd === teamRoute.cwd)?.rooms?.find(room => room.id === teamRoute.roomId)?.name || '团队群聊'
      : session?.title || '对话';
  const chatTabTitle = workbench.shared || (section === 'temporary' && !temporaryChat) ? undefined : sessionTitle;
  const contentTabs = workbench.owner && (chatTabTitle || workbench.layout.tabs.length > 0) ? <SessionContentTabs
    controller={workbench} chatTabTitle={chatTabTitle}
    sessions={workspaces.find(row => row.cwd === workbench.cwd)?.sessions}
    onOpenConversation={id => { void conversation.openSession({ id }); }}
    onInspectConversation={inspectSession}
    onClose={(ids, keepId) => {
      const next = workbench.closeTabs(ids, 'left', keepId);
      if (!next || !workbench.shared || session?.id === next.lastConversationId) return;
      if (next.lastConversationId) void conversation.openSession({ id: next.lastConversationId }, true, false);
      else void startSession(workbench.cwd, { focusTab: false });
    }} /> : undefined;
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const tabNavigation = useRef(conversation);
  tabNavigation.current = conversation;
  const openRegisteredWorktree = useCallback(async (cwd: string) => {
    await loadState();
    await tabNavigation.current.openWorktree(cwd);
  }, [loadState]);
  const workspaceHeader = { tabs: contentTabs, update: headerUpdate };
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
    workspacesLoaded: foundation.workspacesLoaded,
    session,
    modelSelection,
    prompt,
    setPrompt,
    composerAttachments,
    composerImages,
    composerImageIndexes,
    composerDraftKeyRef,
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
    foundation.workspacesLoaded,
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
        if (/\.html?$/i.test(raw.split(/[?#]/)[0] || '')) {
          markdownLinkRef.current(raw);
          return;
        }
        void openFile(raw, undefined, 'external');
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

  const toolKey = workbench.owner || 'studio';
  useEffect(() => {
    if (settingsOpen) void window.piApi.hideToolWindow().catch(cause => setError(errorText(cause)));
  }, [settingsOpen, setError]);
  const toolSessionId = section === 'conversations' ? session?.id : undefined;
  useLayoutEffect(() => {
    void window.piApi.setToolWindowContext?.({key: toolKey, cwd: panelWorkspace, sessionId: toolSessionId,
      title: workbench.owner ? sessionTitle : 'Pi Studio', workspaces: extensionWorkspaces}).catch(cause => setError(errorText(cause)));
  }, [toolKey, panelWorkspace, toolSessionId, sessionTitle, workbench.owner, extensionWorkspaces, setError]);
  useLayoutEffect(() => window.piApi.onToolWindowAction?.(action => {
    if (action.ownerKey !== toolKey) return;
    if (action.kind === 'settings') {
      openSettingsPage(action.page);
      return;
    }
    void runInWorkbench(() => {
      if (action.kind === 'file') return openFile(action.path, toolSessionId, 'external');
      if (action.kind === 'temporary') return openTemporaryChat(action.options);
      if (action.kind === 'prompt' && section === 'temporary') {
        seedTemporaryChat(temporaryId, action.text, action.submit);
        workbench.activate('chat');
      }
      if (action.kind === 'prompt' && section === 'conversations') {
        workbench.activate('chat');
        sendPromptFromExtension(action.text, action.submit);
      }
    });
  }), [toolKey, toolSessionId, temporaryId, section, openFile, openSettingsPage, openTemporaryChat, runInWorkbench, sendPromptFromExtension, workbench.activate]);
  const navigationReady = useSessionNavigation(foundation, conversation);
  const statusBarLoading = !foundation.initialStateSettled || (foundation.workspacesLoaded && !navigationReady)
    || !conversationExtensions.ready || !repositories.ready || Boolean(repositories.selected && !gitStatus)
    || (section === 'conversations' && (sessionLoading || conversation.draftModelLoading))
    || (section === 'temporary' && !temporaryModel);
  const previousTree = useRef<{ cwd: string; owner: string }>();
  useEffect(() => {
    if (!navigationReady || !workbench.ready || !workbench.shared) return;
    const last = previousTree.current;
    previousTree.current = { cwd: workbench.cwd, owner: workbench.layoutOwner };
    if (last?.cwd !== workbench.cwd || last.owner === workbench.layoutOwner) return;
    void tabNavigation.current.openWorktree(workbench.cwd);
  }, [navigationReady, workbench.ready, workbench.shared, workbench.cwd, workbench.layoutOwner]);
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
      className={`app ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${preferences.backgroundMedia ? 'has-custom-background' : ''} ${preferences.backgroundMedia && preferences.backgroundInsideVisibility > 0 ? 'is-wallpaper-inside' : ''}`}
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
        isNewConversation={isNewConversation && section === 'conversations'}
        resizeHandle={sidebarResizeHandle}
        sidebar={sidebarNode}
      >
      {(() => {
        if (section === 'temporary') return <TemporaryChatCanvas
          id={temporaryId}
          tabs={contentTabs} layout={workbench}
          onManage={openModelsSettings}
          onExpandSidebar={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
        />;
        if (section === 'plans') return <PlansCanvas
          view={plansView}
          onViewChange={setPlansView}
          workspaces={workspaces}
          currentWorkspace={workspace}
          onReloadProjects={loadState}
          onOpenSession={id => { void conversation.openSession({ id }); }}
          onExpandSidebar={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
        />;
        if (section === 'team') return <TeamCanvas
          tabs={contentTabs}
          route={teamRoute}
          onNavigate={navigateTeam}
          workspaces={workspaces}
          loadingProjects={stateLoading}
          projectsError={conversationListRefreshError}
          onReloadProjects={loadState}
          onExpandSidebar={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
        />;
        if (section === 'mobile') return <MobileCanvas
          view={mobileView}
          sidebarCollapsed={sidebarCollapsed}
          onExpandSidebar={() => setSidebarCollapsed(false)}
        />;
        return appHubOpen ? (
          <SurfaceActiveContext.Provider value={!settingsOpen && !workbench.activeTab}>
            <AppHubCanvas
              cwd={panelWorkspace}
              initialPlugins={settingsWorkspace.state.settingsData?.plugins}
              panels={conversationExtensions.panels}
              sidebarCollapsed={sidebarCollapsed}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              onOpenApp={openLaunchableApp}
              onOpenResource={onAppHubOpenResource}
              onPluginsChanged={onAppHubPluginsChanged}
            />
          </SurfaceActiveContext.Provider>
        ) : (
          <SurfaceActiveContext.Provider value={workspaceShell.visible}>
            <ConversationWorkspace
              shell={workspaceShell}
              header={workspaceHeader}
              actions={workspaceActions}
              transcript={workspaceTranscript}
              outline={workspaceOutline}
              composer={workspaceComposer}
              inspector={session && inspection.view.mode !== 'hidden' && <SessionInspectionCard key={session.id}
                view={inspection.view} title={session.title} summary={cardSummary.title} detail={cardSummary.detail} toggleRef={inspectorToggleRef}
                onChange={inspection.patch} onClose={() => { inspection.patch({ mode: 'hidden' }); focusConversation(); }}>
                <SessionInspectorPanel view={inspection.view} session={session} preferences={preferences} modelSelection={modelSelection}
                  progress={progressContent} trace={workbenchTrace} subagents={subagentWorkspace}
                  onSelectTab={tab => inspection.patch({ tab })} onOpenProgress={openProgress}
                  onOpenFile={handleOpenFile} onFocusConversation={() => { inspection.patch({ mode: 'compact' }); focusConversation(); }} />
              </SessionInspectionCard>}
            />
          </SurfaceActiveContext.Provider>
        );
      })()}

      {workbench.activeTab && workbench.owner && <SessionDocument key={workbench.layoutOwner + workbench.activeTab.id}
        tab={workbench.activeTab} controller={workbench} turns={workbench.activeTab.sessionId === session?.id ? (liveDiff ? [...(session?.turnDiffs ?? []), liveDiff] : session?.turnDiffs) : undefined} preferences={preferences} />}
      {workbench.owner && workbench.layout.right && <RightEditorGroup controller={workbench} preferences={preferences} />}
      {workbench.comparisonSource && <Suspense fallback={null}>
        <ComparisonFileDialog key={workbench.comparisonSource.id} source={workbench.comparisonSource} layout={workbench.layout}
          onChoose={workbench.compareWith} onClose={workbench.cancelComparison} />
      </Suspense>}
      {workbench.panelAvailable && <WorkspacePanelToggle expanded={filesOpen} toggleRef={panelToggleRef}
        onToggle={filesOpen ? workbench.closePanel : openPanel} />}
      {filesOpen && <Suspense fallback={<aside id="workspace-side-panel" className={'file-panel is-open' + (workbench.panelOverlay ? ' is-overlay' : '')} aria-busy="true" />}>
        <WorkbenchPane key={workbench.owner || panelWorkspace} controller={workbench} toggleRef={panelToggleRef} gitSessionId={section === 'conversations' ? session?.id : workbench.owner.startsWith('room:') ? workbench.owner : undefined}
          openGitFile={openGitFile} />
      </Suspense>}
      </ShellLayout>

      <SettingsOverlay
        onOpenWorktree={openRegisteredWorktree}
        onOpenGitChanges={() => openGit('changes')}
        onChooseWorkspace={chooseFile}
        onOpenBrowser={(url) => openBrowserTab(url || '')}
        sidebar={{ collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed }}
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

      <StudioStatusBar
        loading={statusBarLoading}
        gitControls={panelWorkspace && repositories.selected && <div className="git-status-context" role="group" aria-label="Git 工作目录"
          key={JSON.stringify([panelWorkspace, repositories.selected.id])}>
          <GitRepositoryPicker label="状态栏项目仓库" />
          {gitStatus?.available && <>
            <GitBranchPicker cwd={panelWorkspace} repository={repositories.selected.id} status={gitStatus}
              onOpenGit={section === 'conversations' && !isNewConversation ? () => { void runInWorkbench(() => openGit()); } : undefined} />
            <GitWorktreePicker cwd={panelWorkspace} repository={repositories.selected.id} status={gitStatus}
              onOpen={cwd => runInWorkbench(async () => {
                if (section === 'team') {
                  await loadState();
                  navigateTeam({ view: 'workspace', cwd });
                } else await openRegisteredWorktree(cwd);
              })} />
          </>}
        </div>}
        extensions={chatExtensions}
        items={section === 'conversations' || section === 'temporary' ? conversationExtensions.statusBarItems : conversationExtensions.globalStatusBarItems}
        panel={conversationExtensions.statusPanels.find(item => item.id === statusPanelId)}
        workspace={workspace}
        workspaces={extensionWorkspaces}
        onOpenTemporaryChat={options => { void runInWorkbench(() => openTemporaryChat(options)); }}
        onClose={closeStatusPanel}
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
          busy: resourceWriteBusy || extensionRefreshBusy || Boolean(extensionRefreshError),
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
          busy: resourceWriteBusy || resourcePendingRef.current.skills,
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
