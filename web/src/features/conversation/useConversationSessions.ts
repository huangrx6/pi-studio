import { useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  ChatMessage,
  RequestTrace,
  TurnDiff,
} from '../../types/chat-types';
import type {
  ConversationPage,
  LongTaskState,
} from '../../types/durable-types';
import type {
  ModelSelection,
} from '../../types/model-types';
import {
  createEmptyModelSelection,
} from '../../types/model-types';
import type {
  AgentView,
  PiSessionSummary,
  PiWorkspace,
} from '../../shell/app-types';
import type {
  SubagentBudgetSnapshot,
  SubagentChild,
  SubagentTranscript,
} from '../../types/subagent-types';
import type { OutlineData, OutlineItem } from './outline-model';
import {
  lastLoadedOutlineIndex,
  outlineFromMessages,
} from './outline-model';
import {
  clearComposerDraft,
  composerDraftKeyForNew,
  composerDraftKeyForSession,
  moveComposerDraft,
  type ComposerDraft,
} from './composer-drafts';
import { loadOlderPage, loadTranscriptWindow } from './transcript-load.mjs';
import { messagesHaveMarkdownCode } from '../../shared/markdown-code.mjs';
import { preloadMarkdownHighlighter, preloadMarkdownRenderer } from '../../shared/Markdown';
import { errorText } from '../../shared/error-text';
import { STORED_UI_KEYS } from '../../shared/stored-ui-state';
import type { ComposerMenuState } from './useComposerSuggestions';
import type { ModelPickerRequest } from '../models/ModelPicker';
import type { SessionStateForPersistence } from './useMessageDelivery';

type Setter<T> = Dispatch<SetStateAction<T>>;
type SessionState = SessionStateForPersistence;
type TranscriptCacheEntry = {
  at: number;
  detail: ConversationPage;
  outline?: OutlineData;
  children: SubagentChild[];
};

type ConversationSessionsDependencies = {
  session: SessionState;
  sessionRef: MutableRefObject<SessionState>;
  sessionLoadRef: MutableRefObject<number>;
  workspace: string;
  workspaces: PiWorkspace[];
  settingsOpen: boolean;
  canLeaveSettings: () => Promise<boolean>;
  modelSelection: ModelSelection;
  defaultModelSelection: ModelSelection;
  defaultModelWorkspaceRef: MutableRefObject<string>;
  modelRevisionRef: MutableRefObject<Map<string, number>>;
  modelWriteResultsRef: MutableRefObject<Map<string, { revision: number; selection: ModelSelection }>>;
  transcriptCacheRef: MutableRefObject<Map<string, TranscriptCacheEntry>>;
  /** 当前会话已载入窗口的分页游标，用于向上补页。 */
  transcriptPageRef: MutableRefObject<{ sessionId: string; page: { hasOlder?: boolean; nextCursor?: string } } | null>;
  prefetchedSessionsRef: MutableRefObject<Set<string>>;
  outlineRequestRef: MutableRefObject<number>;
  subagentRequestRef: MutableRefObject<number>;
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  requestRef: MutableRefObject<string | null>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  setSettingsOpen: Setter<boolean>;
  setSessionLoading: Setter<boolean>;
  setSession: Setter<SessionState>;
  setModelSelection: Setter<ModelSelection>;
  setDefaultModelSelection: Setter<ModelSelection>;
  setMessages: Setter<ChatMessage[]>;
  setRequestTraces: Setter<RequestTrace[]>;
  setAgentView: Setter<AgentView>;
  setSubagentChildren: Setter<SubagentChild[]>;
  setSubagentBudget: Setter<SubagentBudgetSnapshot | null>;
  setSubagentTranscript: Setter<SubagentTranscript | null>;
  setSubagentError: Setter<string | null>;
  setSubagentLoading: Setter<boolean>;
  setOutlineItems: Setter<OutlineItem[]>;
  setOutlineTotalMessages: Setter<number>;
  setOutlineActive: Setter<number>;
  setOutlineHover: Setter<number | null>;
  setComposerMenu: Setter<ComposerMenuState | null>;
  setModelPickerRequest: Setter<ModelPickerRequest | null>;
  setBusy: Setter<boolean>;
  setCompaction: Setter<{ active: boolean; reason?: string }>;
  setRetryInfo: Setter<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>;
  setError: Setter<string | null>;
  loadState: () => Promise<void>;
  loadModelCatalog: (cwd: string) => Promise<unknown>;
  changeWorkspace: (cwd: string) => void;
  expandWorkspace: (cwd: string) => void;
  checkpointComposerDraft: () => void;
  installComposerDraft: (key: string, restore?: boolean) => void;
  currentComposerDraft: () => ComposerDraft;
};

export function useConversationSessions({
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
  transcriptPageRef,
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
}: ConversationSessionsDependencies) {
  // 向上补页的并发保护：滚动哨兵会连续触发，不能同时发两页请求。
  const olderLoadingRef = useRef(false);

  async function startSession(
    cwd = session?.cwd || workspace,
    options: { restoreDraft?: boolean; checkpoint?: boolean } = {},
  ) {
    if (settingsOpen) {
      if (!await canLeaveSettings()) return;
      setSettingsOpen(false);
    }
    if (options.checkpoint !== false) checkpointComposerDraft();
    ++sessionLoadRef.current;
    ++outlineRequestRef.current;
    ++subagentRequestRef.current;
    requestRef.current = '';
    setSessionLoading(false);
    sessionRef.current = null;
    setSession(null);
    try { window.localStorage.setItem(STORED_UI_KEYS.activeSession, 'null'); } catch { /* storage unavailable */ }
    setMessages([]);
    setRequestTraces([]);
    setAgentView({ kind: 'conversation' });
    setSubagentChildren([]);
    setSubagentBudget(null);
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(false);
    setOutlineItems([]);
    setOutlineTotalMessages(0);
    setOutlineActive(0);
    setOutlineHover(null);
    setError(null);
    changeWorkspace(cwd);
    const nextKey = composerDraftKeyForNew(cwd);
    const restoreDraft = options.restoreDraft !== false;
    if (!restoreDraft) clearComposerDraft(composerDraftsRef.current, nextKey);
    installComposerDraft(nextKey, restoreDraft);
    if (cwd) expandWorkspace(cwd);
    setComposerMenu(null);
    setModelPickerRequest(null);
    const defaultsKnown = defaultModelWorkspaceRef.current === cwd;
    setModelSelection(defaultsKnown ? defaultModelSelection : createEmptyModelSelection());
    if (!defaultsKnown) setDefaultModelSelection(createEmptyModelSelection());
    if (!defaultsKnown || !defaultModelSelection.modelRef) void loadModelCatalog(cwd).catch(() => {});
    setBusy(false);
    setRetryInfo(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectDraftWorkspace(cwd: string) {
    const previousKey = composerDraftKeyRef.current;
    const pending = currentComposerDraft();
    const hasPending = Boolean(pending.text.trim()) || pending.attachments.length > 0;
    checkpointComposerDraft();
    ++sessionLoadRef.current;
    ++outlineRequestRef.current;
    ++subagentRequestRef.current;
    setSessionLoading(false);
    sessionRef.current = null;
    setSession(null);
    try { window.localStorage.setItem(STORED_UI_KEYS.activeSession, 'null'); } catch { /* storage unavailable */ }
    setAgentView({ kind: 'conversation' });
    setSubagentChildren([]);
    setSubagentBudget(null);
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(false);
    setOutlineItems([]);
    setOutlineTotalMessages(0);
    setOutlineActive(0);
    setOutlineHover(null);
    changeWorkspace(cwd);
    const nextKey = composerDraftKeyForNew(cwd);
    if (hasPending) {
      moveComposerDraft(composerDraftsRef.current, previousKey, nextKey, pending);
    }
    installComposerDraft(nextKey);
    setComposerMenu(null);
    setModelPickerRequest(null);
    const defaultsKnown = defaultModelWorkspaceRef.current === cwd;
    setModelSelection(defaultsKnown ? defaultModelSelection : createEmptyModelSelection());
    if (!defaultsKnown) setDefaultModelSelection(createEmptyModelSelection());
    if (!defaultsKnown || !defaultModelSelection.modelRef) void loadModelCatalog(cwd).catch(() => {});
    setError(null);
    if (cwd) expandWorkspace(cwd);
  }

  function prefetchSession(id: string) {
    if (prefetchedSessionsRef.current.has(id)) return;
    prefetchedSessionsRef.current.add(id);
    void preloadMarkdownRenderer().catch(() => { /* optional renderer remains on plain-text fallback */ });
    void window.piApi.conversationPage({ id, limit: 200 })
      .then((page) => {
        if (page?.messages && messagesHaveMarkdownCode(page.messages)) {
          void preloadMarkdownHighlighter().catch(() => { /* code remains readable without highlighting */ });
        }
      })
      .catch(() => {
        /* prefetch is best effort */
      });
  }

  function applyOutline(data: OutlineData | undefined, loadedMessages: ChatMessage[], fallbackStart = 0) {
    const next = data ?? outlineFromMessages(loadedMessages, fallbackStart);
    setOutlineItems(next.items);
    setOutlineTotalMessages(next.totalMessages);
    setOutlineActive(lastLoadedOutlineIndex(next, loadedMessages));
  }

  async function refreshOutline(sessionId: string, generation = sessionLoadRef.current): Promise<OutlineData | undefined> {
    const request = ++outlineRequestRef.current;
    try {
      const data = await window.piApi.conversationOutline(sessionId);
      if (request !== outlineRequestRef.current || generation !== sessionLoadRef.current) return undefined;
      if (!data) return undefined;
      return { items: data.items, totalMessages: data.totalMessages };
    } catch {
      return undefined;
    }
  }

  async function openSession(item: PiSessionSummary, reportError = true): Promise<boolean> {
    if (settingsOpen) {
      if (!await canLeaveSettings()) return false;
      setSettingsOpen(false);
    }
    checkpointComposerDraft();
    void preloadMarkdownRenderer().catch(() => { /* Markdown renders as readable plain text */ });
    const load = ++sessionLoadRef.current;
    const modelScope = `session:${item.id}`;
    const modelRevision = modelRevisionRef.current.get(modelScope) ?? 0;
    const outlineRequest = ++outlineRequestRef.current;
    const cached = transcriptCacheRef.current.get(item.id);
    const cacheFresh = cached && Date.now() - cached.at < 60_000;
    setSessionLoading(!cacheFresh);
    try {
      const [detail, outline, children] = cacheFresh
        ? [cached.detail, cached.outline, cached.children]
        : await Promise.all([
          loadTranscriptWindow(window.piApi.conversationPage, item.id),
          window.piApi.conversationOutline(item.id).catch(() => undefined),
          window.piApi.sessionSubagents(item.id).catch(() => [] as SubagentChild[]),
        ]);
      if (load !== sessionLoadRef.current) return false;
      if (!detail) {
        if (reportError) setError('这个会话已经不存在，列表已刷新。');
        void loadState().catch(() => { /* 列表刷新失败时保留错误提示 */ });
        return false;
      }
      const nextSession = {
        id: detail.id,
        cwd: detail.cwd,
        title: detail.title,
        longTask: detail.longTask,
        turnDiffs: detail.turnDiffs,
        totalMessages: outline?.totalMessages,
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      const lastWrite = modelWriteResultsRef.current.get(modelScope);
      const configuredModel = lastWrite && lastWrite.revision >= modelRevision
        ? lastWrite.selection : undefined;
      setModelSelection(configuredModel
        ? { ...configuredModel, pending: Boolean(detail.running) }
        : detail.model ?? createEmptyModelSelection());
      setMessages(detail.messages);
      transcriptPageRef.current = { sessionId: detail.id, page: detail.page ?? { hasOlder: false } };
      setRequestTraces(Array.isArray(detail.requestTraces) ? detail.requestTraces : []);
      setSubagentChildren(Array.isArray(children) ? children : []);
      setSubagentTranscript(null);
      setSubagentError(null);
      setSubagentLoading(false);
      setAgentView({ kind: 'conversation' });
      if (outlineRequest === outlineRequestRef.current) {
        applyOutline(outline ? { items: outline.items, totalMessages: outline.totalMessages } : undefined, detail.messages, detail.messageStart);
      }
      changeWorkspace(detail.cwd);
      installComposerDraft(composerDraftKeyForSession(detail.id));
      setComposerMenu(null);
      expandWorkspace(detail.cwd);
      setModelPickerRequest(null);
      setError(null);
      requestRef.current = detail.requestId || '';
      setBusy(Boolean(detail.running));
      setCompaction({ active: Boolean(detail.compacting) });
      setRetryInfo(null);
      if (!detail.running) {
        transcriptCacheRef.current.delete(item.id);
        transcriptCacheRef.current.set(item.id, {
          at: Date.now(),
          detail: configuredModel ? { ...detail, model: configuredModel } : detail,
          outline,
          children,
        });
        while (transcriptCacheRef.current.size > 1) {
          transcriptCacheRef.current.delete(transcriptCacheRef.current.keys().next().value as string);
        }
      }
      return true;
    } catch (error) {
      if (load === sessionLoadRef.current) {
        if (reportError) setError(errorText(error));
        void loadState().catch(() => { /* 列表刷新失败时保留错误提示 */ });
      }
      return false;
    } finally {
      if (load === sessionLoadRef.current) setSessionLoading(false);
    }
  }

  /**
   * 向上补一页更早的历史。
   *
   * 返回 false 表示没有更早的内容（或正在加载），调用方据此停止滚动加载。
   */
  async function loadOlderMessages(): Promise<boolean> {
    const sessionId = sessionRef.current?.id;
    const cursor = transcriptPageRef.current;
    if (!sessionId || !cursor || cursor.sessionId !== sessionId) return false;
    if (!cursor.page?.nextCursor || olderLoadingRef.current) return false;
    olderLoadingRef.current = true;
    try {
      const older = await loadOlderPage(window.piApi.conversationPage, sessionId, cursor.page);
      if (!older) {
        transcriptPageRef.current = { sessionId, page: { hasOlder: false } };
        return false;
      }
      if (sessionRef.current?.id !== sessionId) return false;
      transcriptPageRef.current = { sessionId, page: older.page };
      // 函数式插入：加载期间新到的流式消息不会被这次替换覆盖。
      setMessages((current) => [...older.messages, ...current]);
      return true;
    } catch {
      return false;
    } finally {
      olderLoadingRef.current = false;
    }
  }

  async function openNotificationSession(id: string): Promise<void> {
    const target = workspaces.flatMap(item => item.sessions).find(item => item.id === id);
    if (!target) throw new Error('这个会话不在当前列表中，可能已被删除或移除。');
    if (target.archived) throw new Error('这个会话已归档，可在设置的归档会话中恢复。');
    const opened = await openSession(target, false);
    if (!opened) throw new Error('暂时无法打开这个会话，请稍后再试。');
    if (document.activeElement?.closest('.notification-panel')) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }

  return {
    startSession,
    selectDraftWorkspace,
    prefetchSession,
    applyOutline,
    refreshOutline,
    openSession,
    openNotificationSession,
    loadOlderMessages,
  };
}
