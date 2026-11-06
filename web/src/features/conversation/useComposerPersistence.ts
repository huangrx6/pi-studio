import { useCallback, useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ComposerAttachment } from '../../types/chat-types';
import type { PiSessionSummary, PiWorkspace } from '../../shell/app-types';
import type { ComposerDraft } from './composer-drafts';
import {
  clearComposerDraft,
  saveComposerDraft,
  subscribeComposerDraftStore,
} from './composer-drafts';
import type { QueuedPrompt } from './composer-types';
import type { RestoredComposerInputState } from './persisted-composer-state';
import {
  buildPersistedComposerInputState,
  loadPersistedComposerInputState,
  savePersistedComposerInputState,
} from './persisted-composer-state';
import type { SessionStateForPersistence } from './useMessageDelivery';
import { STORED_UI_KEYS, loadStoredActiveSession } from '../../shared/stored-ui-state';
import { errorText } from '../../shared/error-text';

type Setter<T> = Dispatch<SetStateAction<T>>;

type ComposerPersistenceDependencies = {
  session: SessionStateForPersistence;
  workspace: string;
  workspaces: PiWorkspace[];
  stateLoading: boolean;
  prompt: string;
  composerAttachments: ComposerAttachment[];
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  persistedComposerActiveDraftKeyRef: MutableRefObject<string>;
  composerPersistenceReadyRef: MutableRefObject<boolean>;
  composerPersistenceStartedRef: MutableRefObject<boolean>;
  composerPersistenceTimerRef: MutableRefObject<number | null>;
  composerPersistenceWriteRef: MutableRefObject<Promise<void>>;
  composerPersistenceErrorRef: MutableRefObject<boolean>;
  queuedPromptsRef: MutableRefObject<Record<string, QueuedPrompt[]>>;
  restoredRef: MutableRefObject<boolean>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  composerPersistenceReady: boolean;
  composerPersistenceStarted: boolean;
  queuedPromptsBySession: Record<string, QueuedPrompt[]>;
  setQueuedPromptsBySession: Setter<Record<string, QueuedPrompt[]>>;
  setComposerPersistenceReady: Setter<boolean>;
  setComposerPersistenceStarted: Setter<boolean>;
  setExpanded: Setter<Set<string>>;
  setError: Setter<string | null>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  changeWorkspace: (cwd: string) => void;
  openSession: (item: PiSessionSummary) => Promise<boolean>;
  startSession: (
    cwd?: string,
    options?: { restoreDraft?: boolean; checkpoint?: boolean },
  ) => Promise<void>;
  loadStateRef: MutableRefObject<() => Promise<void>>;
};

export function useComposerPersistence({
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
}: ComposerPersistenceDependencies) {
  const persistComposerStateNow = useCallback((): Promise<void> => {
    if (!composerPersistenceReadyRef.current || !composerPersistenceStartedRef.current) {
      return Promise.resolve();
    }
    if (composerPersistenceTimerRef.current !== null) {
      window.clearTimeout(composerPersistenceTimerRef.current);
      composerPersistenceTimerRef.current = null;
    }
    const snapshot = buildPersistedComposerInputState(
      composerDraftsRef.current,
      queuedPromptsRef.current,
      composerDraftKeyRef.current,
    );
    const write = composerPersistenceWriteRef.current
      .catch(() => {})
      .then(() => savePersistedComposerInputState(snapshot));
    composerPersistenceWriteRef.current = write
      .then(() => { composerPersistenceErrorRef.current = false; })
      .catch(() => {
        if (composerPersistenceErrorRef.current) return;
        composerPersistenceErrorRef.current = true;
        showComposerFeedback('本地草稿暂时无法保存。本次输入仍可使用，请检查磁盘空间后继续。');
      });
    return composerPersistenceWriteRef.current;
  }, [composerDraftKeyRef, composerDraftsRef, composerPersistenceErrorRef, composerPersistenceReadyRef, composerPersistenceStartedRef, composerPersistenceTimerRef, composerPersistenceWriteRef, queuedPromptsRef, showComposerFeedback]);

  const scheduleComposerStatePersistence = useCallback(() => {
    if (
      !composerPersistenceReadyRef.current
      || !composerPersistenceStartedRef.current
      || composerPersistenceTimerRef.current !== null
    ) return;
    composerPersistenceTimerRef.current = window.setTimeout(() => {
      composerPersistenceTimerRef.current = null;
      void persistComposerStateNow();
    }, 180);
  }, [composerPersistenceReadyRef, composerPersistenceStartedRef, composerPersistenceTimerRef, persistComposerStateNow]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      let restoreFailed = false;
      let restored: RestoredComposerInputState;
      try {
        restored = await loadPersistedComposerInputState();
      } catch {
        restoreFailed = true;
        restored = {
          activeDraftKey: '',
          drafts: new Map(),
          queues: {},
        };
      }
      if (disposed) return;
      composerDraftsRef.current = restored.drafts;
      persistedComposerActiveDraftKeyRef.current = restored.activeDraftKey;
      queuedPromptsRef.current = restored.queues;
      setQueuedPromptsBySession(restored.queues);
      composerPersistenceReadyRef.current = true;
      setComposerPersistenceReady(true);
      if (restoreFailed) {
        composerPersistenceErrorRef.current = true;
        showComposerFeedback('本地草稿读取失败。本次输入仍可使用，但上次未发送内容没有恢复。');
      }
      void loadStateRef.current().catch((error) => setError(errorText(error)));
    })();
    return () => { disposed = true; };
  }, [composerDraftsRef, composerPersistenceErrorRef, composerPersistenceReadyRef, loadStateRef, persistedComposerActiveDraftKeyRef, queuedPromptsRef, setComposerPersistenceReady, setError, setQueuedPromptsBySession, showComposerFeedback]);

  useEffect(() => {
    if (!composerPersistenceReady) return;
    const unsubscribe = subscribeComposerDraftStore(
      composerDraftsRef.current,
      scheduleComposerStatePersistence,
    );
    scheduleComposerStatePersistence();
    return unsubscribe;
  }, [composerDraftsRef, composerPersistenceReady, scheduleComposerStatePersistence]);

  useEffect(() => {
    if (!composerPersistenceReady || !composerPersistenceStarted) return;
    scheduleComposerStatePersistence();
  }, [composerPersistenceReady, composerPersistenceStarted, queuedPromptsBySession, scheduleComposerStatePersistence]);

  useEffect(() => {
    if (!composerPersistenceReady || !composerPersistenceStarted) return;
    scheduleComposerStatePersistence();
  }, [composerPersistenceReady, composerPersistenceStarted, session?.id, scheduleComposerStatePersistence, workspace]);

  useEffect(() => {
    if (!composerPersistenceReady || !composerPersistenceStarted) return;
    const flush = () => { void persistComposerStateNow(); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [composerPersistenceReady, composerPersistenceStarted, persistComposerStateNow]);

  useEffect(() => {
    if (!composerPersistenceReady || stateLoading || restoredRef.current || workspaces.length === 0) return;
    const saved = loadStoredActiveSession();
    const sessions = workspaces.flatMap((item) => item.sessions);
    const knownSessionIds = new Set(sessions.map((item) => item.id));
    const knownWorkspaces = new Set(workspaces.map((item) => item.cwd));
    const nextQueues = Object.fromEntries(
      Object.entries(queuedPromptsRef.current)
        .filter(([sessionId]) => knownSessionIds.has(sessionId)),
    );
    if (Object.keys(nextQueues).length !== Object.keys(queuedPromptsRef.current).length) {
      queuedPromptsRef.current = nextQueues;
      setQueuedPromptsBySession(nextQueues);
    }
    for (const key of [...composerDraftsRef.current.keys()]) {
      const sessionId = key.startsWith('session:') ? key.slice('session:'.length) : '';
      const cwd = key.startsWith('new:') ? key.slice('new:'.length) : '';
      if ((sessionId && !knownSessionIds.has(sessionId))
        || (cwd && !knownWorkspaces.has(cwd))) {
        clearComposerDraft(composerDraftsRef.current, key);
      }
    }
    const savedSummary = saved?.id
      ? sessions.find((item) => item.id === saved.id && !item.archived)
      : undefined;
    const fallbackKey = persistedComposerActiveDraftKeyRef.current;
    const fallbackSessionId = fallbackKey.startsWith('session:')
      ? fallbackKey.slice('session:'.length)
      : '';
    const fallbackSession = fallbackSessionId
      ? sessions.find((item) => item.id === fallbackSessionId && !item.archived)
      : undefined;
    const fallbackWorkspace = fallbackKey.startsWith('new:')
      ? fallbackKey.slice('new:'.length)
      : '';
    const summary = savedSummary || fallbackSession;
    restoredRef.current = true;
    if (summary) {
      changeWorkspace(summary.cwd);
      setExpanded((current) => {
        if (current.has(summary.cwd)) return current;
        const next = new Set(current);
        next.add(summary.cwd);
        return next;
      });
      void openSession(summary);
      return;
    }
    if (fallbackWorkspace && knownWorkspaces.has(fallbackWorkspace)) {
      void startSession(fallbackWorkspace, { checkpoint: false });
      return;
    }
    if (saved) {
      try { window.localStorage.setItem(STORED_UI_KEYS.activeSession, 'null'); } catch { /* storage unavailable */ }
    }
    composerPersistenceStartedRef.current = true;
    setComposerPersistenceStarted(true);
  }, [changeWorkspace, composerDraftsRef, composerPersistenceReady, composerPersistenceStartedRef, openSession, persistedComposerActiveDraftKeyRef, queuedPromptsRef, restoredRef, setComposerPersistenceStarted, setExpanded, setQueuedPromptsBySession, startSession, stateLoading, workspaces]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; }
  }, [prompt, textareaRef]);

  useEffect(() => {
    if (!composerPersistenceReady || !composerPersistenceStarted) return;
    saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
      text: prompt,
      attachments: composerAttachments,
    });
  }, [composerAttachments, composerDraftKeyRef, composerDraftsRef, composerPersistenceReady, composerPersistenceStarted, prompt]);
}
