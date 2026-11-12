import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useActionConfirmation, type ConfirmRequest } from '../shared/ConfirmDialog';
import { isConversationTurnActive } from '../features/conversation/conversation-activity';
import type {
  QueuedEditContext,
  QueuedPrompt,
} from '../features/conversation/composer-types';
import type {
  ChatMessage,
  RequestTrace,
  TurnDiff,
} from '../types/chat-types';
import { createSettingsDraftGuard } from '../shared/settings-draft-guard';
import { useAppUpdates } from '../features/update/useAppUpdates';
import { normalizeUpdateProgress } from '../features/update/update-presentation';
import type { SubagentChild } from '../types/subagent-types';
import type { LongTaskState } from '../types/durable-types';
import type { ModelPickerRequest } from '../features/models/ModelPicker';
import type { ContextPolicy } from '../features/conversation/ContextUsageChip';
import { useAppAppearance } from './useAppAppearance';
import { usePermissionControl } from './usePermissionControl';
import { useWorkspaceState } from './useWorkspaceState';
import { useAppWorkbenchController } from './right-panel/useAppWorkbench';
import { useNotifications } from './useNotifications';
import { useComposerInputState } from './useComposerInputState';
import {
  type ModelOption,
  type ModelSelection,
  createEmptyModelSelection,
} from '../types/model-types';
import type { ConversationPage } from '../types/durable-types';
import type { AgentView } from './app-types';
import type { OutlineData, OutlineItem } from '../features/conversation/outline-model';

/**
 * Owns the state shared by both the conversation runtime and the application
 * chrome. Domain hooks can be composed above this layer without re-parenting
 * session, composer, model or panel state.
 */
export function useAppFoundation() {
  const actionConfirmation = useActionConfirmation();
  const settingsLeaveConfirmation = useActionConfirmation();
  const settingsDraftGuard = useRef(createSettingsDraftGuard()).current;
  const sidebarMutationRef = useRef(false);
  const [sidebarMutating, setSidebarMutating] = useState(false);
  const conversationListNeedsRefreshRef = useRef(false);
  const [conversationListRefreshError, setConversationListRefreshError] = useState(false);
  const conversationListRetryRef = useRef(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const {
    preferences,
    backgroundBusy,
    backgroundError,
    menuBarPreference,
    menuBarBusy,
    updatePreference,
    chooseBackground,
    removeBackground,
    changeMenuBarVisibility,
    handleBackgroundUnavailable,
  } = useAppAppearance(setSettingsError);
  const {
    snapshot: updateSnapshot,
    dialogOpen: updateDialogOpen,
    close: closeUpdateDialog,
    open: openUpdateDialog,
    check: checkUpdates,
    download: downloadUpdate,
    install: installUpdate,
  } = useAppUpdates();
  const updateProgress = normalizeUpdateProgress(updateSnapshot.progress);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number;
    maxAttempts: number;
    errorMessage?: string;
  } | null>(null);
  const {
    notifications,
    setNotifications,
    pushNotification,
    markAllRead: markAllNotificationsRead,
    clearNotifications,
  } = useNotifications();
  const [compaction, setCompaction] = useState<{ active: boolean; reason?: string }>({ active: false });
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [queuedPromptsBySession, setQueuedPromptsBySession] = useState<Record<string, QueuedPrompt[]>>({});
  const queuedPromptsRef = useRef(queuedPromptsBySession);
  queuedPromptsRef.current = queuedPromptsBySession;
  const queuedDrainSessionsRef = useRef<Set<string>>(new Set());
  const [queueAdmissionPendingBySession, setQueueAdmissionPendingBySession] = useState<Record<string, string>>({});
  const queueAdmissionPendingRef = useRef<Record<string, string>>({});
  const queuedEditContextsRef = useRef<Record<string, QueuedEditContext>>({});
  const [outlineActive, setOutlineActive] = useState(0);
  const [outlineHover, setOutlineHover] = useState<number | null>(null);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [, setOutlineTotalMessages] = useState(0);
  const outlineRequestRef = useRef(0);
  const defaultModelWorkspaceRef = useRef('');
  const modelRevisionRef = useRef(new Map<string, number>());
  const modelWritesRef = useRef(new Set<string>());
  const modelWriteResultsRef = useRef(new Map<string, { revision: number; selection: ModelSelection }>());
  const settingsRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);
  const [modelSelection, setModelSelection] = useState<ModelSelection>(createEmptyModelSelection);
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection>(createEmptyModelSelection);
  const [modelPickerRequest, setModelPickerRequest] = useState<ModelPickerRequest | null>(null);
  const [longTaskBusy, setLongTaskBusy] = useState(false);
  const [session, setSession] = useState<{
    id: string;
    cwd: string;
    title: string;
    longTask?: LongTaskState;
    turnDiffs?: TurnDiff[];
    totalMessages?: number;
  } | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionLoadRef = useRef(0);
  const {
    workspaces,
    stateLoading,
    workspace,
    workspaceRef,
    stateRequestRef,
    changeWorkspace,
    loadState,
    expanded,
    setExpanded,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    workspaceQuery,
    sidebarSessionFilter,
    searchCollapsed,
    setSearchCollapsed,
    workspaceSearchTrigger,
    dragPreviewRef,
    activeWorkspace,
    sidebarFiltering,
    visibleWorkspaces,
    allExpanded,
    changeWorkspaceQuery,
    changeSidebarFilter,
    clearSidebarFilters,
    closeSidebarSearch,
    toggleAllExpanded,
    expandWorkspace,
    makeDragPreview,
    reorderWorkspaces,
    reorderSessions,
  } = useWorkspaceState({
    sessionRef,
    sessionLoadRef,
    modelRevisionRef,
    modelWritesRef,
    defaultModelWorkspaceRef,
    conversationListNeedsRefreshRef,
    setConversationListRefreshError,
    setSession,
    setDefaultModelSelection,
    setModelSelection,
  });
  const queuedPrompts = session?.id ? queuedPromptsBySession[session.id] ?? [] : [];
  const queuedEditContext = session?.id ? queuedEditContextsRef.current[session.id] : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy | null>(null);
  const [requestTraces, setRequestTraces] = useState<RequestTrace[]>([]);
  const [agentView, setAgentView] = useState<AgentView>({ kind: 'conversation' });
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const {
    prompt,
    setPrompt,
    composerAttachments,
    setComposerAttachments,
    composerImages,
    composerImageIndexes,
    composerMenu,
    setComposerMenu,
    composerMenuIndex,
    setComposerMenuIndex,
    composerCommands,
    composerCommandOptions,
    composerFileOptions,
    composerMenuLoading,
    composerMenuError,
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
    preparing,
    composerComposingRef,
    composerWrapRef,
    textareaRef,
    composerHighlightRef,
  } = useComposerInputState({
    workspace,
    sessionId: session?.id,
  });
  const [busy, setBusy] = useState(false);
  const [stoppingSessionIds, setStoppingSessionIds] = useState<string[]>([]);
  const stopping = Boolean(session?.id && stoppingSessionIds.includes(session.id));
  const selectedSessionSummary = useMemo(() => {
    if (!session?.id) return undefined;
    for (const item of workspaces) {
      const found = item.sessions.find(entry => entry.id === session.id);
      if (found) return found;
    }
    return undefined;
  }, [workspaces, session?.id]);
  const turnActive = stopping || isConversationTurnActive({
    requestRunning: busy,
    compacting: compaction.active,
    conversationRunning: Boolean(selectedSessionSummary?.running),
  });
  const turnActiveRef = useRef(turnActive);
  turnActiveRef.current = turnActive;
  const sendBlockedRef = useRef(false);
  sendBlockedRef.current = stateLoading || sessionLoading || stopping || compaction.active;
  const [error, setError] = useState<string | null>(null);
  const {
    visiblePermission,
    retryPermissionMode,
    acceptPermissionState,
    applyPermission,
    changePermission,
    fullPermissionOpen,
    setFullPermissionOpen,
    fullPermissionAck,
    setFullPermissionAck,
  } = usePermissionControl({
    workspace,
    sessionId: session?.id,
    setError,
  });
  const [conversationSubscriptionError, setConversationSubscriptionError] = useState<{
    sessionId: string;
    message: string;
    retrying: boolean;
  } | null>(null);
  const conversationSubscriptionRetryRef = useRef<{
    sessionId: string;
    retry: (restoreFocus?: boolean) => void;
  } | null>(null);
  const [composerFeedback, setComposerFeedback] = useState<{
    message: string;
    tone: 'info' | 'warning';
    /** 归属会话：只在同一条对话的输入框上显示，切换会话后自动让位。 */
    sessionId?: string;
  } | null>(null);
  // 由 controller 每次渲染写入当前会话 id，showComposerFeedback 用它打归属。
  const composerFeedbackScopeRef = useRef<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const workbench = useAppWorkbenchController({
    workspace,
    workspaceRef,
    sessionId: session?.id,
    sessionRef,
    sidebarCollapsed,
    setError,
  });
  const {
    filesOpen,
    panelFullscreen,
    openPanel,
    closePanel,
    openTemporaryChat,
    openTerminalTab,
    openBrowserTab,
    openFilesTab,
    openFile,
    openChangesTab,
  } = workbench;
  const [models, setModels] = useState<ModelOption[]>([]);
  const showComposerFeedback = useCallback((message: string, tone: 'info' | 'warning' = 'warning') => {
    setComposerFeedback({ message, tone, sessionId: composerFeedbackScopeRef.current });
  }, []);
  const transcriptCacheRef = useRef(new Map<string, {
    at: number;
    detail: ConversationPage;
    outline?: OutlineData;
    children: SubagentChild[];
  }>());

  return {
    actionConfirmation,
    settingsLeaveConfirmation,
    settingsDraftGuard,
    sidebarMutationRef,
    sidebarMutating,
    setSidebarMutating,
    conversationListNeedsRefreshRef,
    conversationListRefreshError,
    setConversationListRefreshError,
    conversationListRetryRef,
    sessionLoading,
    setSessionLoading,
    settingsError,
    setSettingsError,
    preferences,
    backgroundBusy,
    backgroundError,
    menuBarPreference,
    menuBarBusy,
    updatePreference,
    chooseBackground,
    removeBackground,
    changeMenuBarVisibility,
    handleBackgroundUnavailable,
    updateSnapshot,
    updateDialogOpen,
    closeUpdateDialog,
    openUpdateDialog,
    checkUpdates,
    downloadUpdate,
    installUpdate,
    updateProgress,
    shortcutsOpen,
    setShortcutsOpen,
    retryInfo,
    setRetryInfo,
    notifications,
    setNotifications,
    pushNotification,
    markAllNotificationsRead,
    clearNotifications,
    compaction,
    setCompaction,
    confirmRequest,
    setConfirmRequest,
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
    loadState,
    expanded,
    setExpanded,
    workspaceSearchOpen,
    setWorkspaceSearchOpen,
    workspaceQuery,
    sidebarSessionFilter,
    searchCollapsed,
    setSearchCollapsed,
    workspaceSearchTrigger,
    dragPreviewRef,
    activeWorkspace,
    sidebarFiltering,
    visibleWorkspaces,
    allExpanded,
    changeWorkspaceQuery,
    changeSidebarFilter,
    clearSidebarFilters,
    closeSidebarSearch,
    toggleAllExpanded,
    expandWorkspace,
    makeDragPreview,
    reorderWorkspaces,
    reorderSessions,
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
    composerImages,
    composerImageIndexes,
    composerMenu,
    setComposerMenu,
    composerMenuIndex,
    setComposerMenuIndex,
    composerCommands,
    composerCommandOptions,
    composerFileOptions,
    composerMenuLoading,
    composerMenuError,
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
    preparing,
    composerComposingRef,
    composerWrapRef,
    textareaRef,
    composerHighlightRef,
    busy,
    setBusy,
    stoppingSessionIds,
    setStoppingSessionIds,
    stopping,
    selectedSessionSummary,
    turnActive,
    turnActiveRef,
    sendBlockedRef,
    error,
    setError,
    visiblePermission,
    retryPermissionMode,
    acceptPermissionState,
    applyPermission,
    changePermission,
    fullPermissionOpen,
    setFullPermissionOpen,
    fullPermissionAck,
    setFullPermissionAck,
    conversationSubscriptionError,
    setConversationSubscriptionError,
    conversationSubscriptionRetryRef,
    composerFeedback,
    setComposerFeedback,
    composerFeedbackScopeRef,
    sidebarCollapsed,
    setSidebarCollapsed,
    workbench,
    filesOpen,
    panelFullscreen,
    openPanel,
    closePanel,
    openTemporaryChat,
    openTerminalTab,
    openBrowserTab,
    openFilesTab,
    openFile,
    openChangesTab,
    models,
    setModels,
    showComposerFeedback,
    transcriptCacheRef,
  };
}

export type AppFoundation = ReturnType<typeof useAppFoundation>;
