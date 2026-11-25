import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ComposerAttachment } from '../../types/chat-types';
import type { PiWorkspace } from '../../shell/app-types';
import type { ComposerDraft } from './composer-drafts';
import {
  clearComposerDraft,
  composerDraftKeyForSession,
  saveComposerDraft,
  subscribeComposerDraftStore,
} from './composer-drafts';
import type { QueuedPrompt } from './composer-types';
import {
  buildPersistedComposerInputState,
  loadPersistedComposerInputState,
  savePersistedComposerInputState,
} from './persisted-composer-state';
import type { SessionStateForPersistence } from './useMessageDelivery';
import { errorText } from '../../shared/error-text';

type Setter<T> = Dispatch<SetStateAction<T>>;

type ComposerPersistenceDependencies = {
  session: SessionStateForPersistence;
  workspace: string;
  workspaces: PiWorkspace[];
  stateLoading: boolean;
  workspacesLoaded: boolean;
  prompt: string;
  composerAttachments: ComposerAttachment[];
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  composerPersistenceReadyRef: MutableRefObject<boolean>;
  composerPersistenceTimerRef: MutableRefObject<number | null>;
  composerPersistenceWriteRef: MutableRefObject<Promise<void>>;
  composerPersistenceErrorRef: MutableRefObject<boolean>;
  queuedPromptsRef: MutableRefObject<Record<string, QueuedPrompt[]>>;
  composerPersistenceReady: boolean;
  queuedPromptsBySession: Record<string, QueuedPrompt[]>;
  setQueuedPromptsBySession: Setter<Record<string, QueuedPrompt[]>>;
  setComposerPersistenceReady: Setter<boolean>;
  setError: Setter<string | null>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  loadStateRef: MutableRefObject<() => Promise<void>>;
};

export function useComposerPersistence({
  session,
  workspace,
  workspaces,
  stateLoading,
  workspacesLoaded,
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
}: ComposerPersistenceDependencies) {
  const prunedDrafts = useRef(false);
  const removedSessionIds = useRef(new Set<string>());
  const removedDraftKeys = useRef(new Set<string>());
  const persistComposerStateNow = useCallback((): Promise<void> => {
    if (!composerPersistenceReadyRef.current) {
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
    snapshot.drafts = snapshot.drafts.filter(draft => !removedDraftKeys.current.has(draft.key));
    snapshot.queues = snapshot.queues.filter(queue => !removedSessionIds.current.has(queue.sessionId));
    if (removedDraftKeys.current.has(snapshot.activeDraftKey)) snapshot.activeDraftKey = '';
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
  }, [composerDraftKeyRef, composerDraftsRef, composerPersistenceErrorRef, composerPersistenceReadyRef, composerPersistenceTimerRef, composerPersistenceWriteRef, queuedPromptsRef, showComposerFeedback]);

  function persistDeletedComposerSessions(ids: string[]) {
    for (const id of ids) {
      removedSessionIds.current.add(id);
      removedDraftKeys.current.add(composerDraftKeyForSession(id));
    }
    return persistComposerStateNow();
  }

  const scheduleComposerStatePersistence = useCallback(() => {
    if (
      !composerPersistenceReadyRef.current
      || composerPersistenceTimerRef.current !== null
    ) return;
    composerPersistenceTimerRef.current = window.setTimeout(() => {
      composerPersistenceTimerRef.current = null;
      void persistComposerStateNow();
    }, 180);
  }, [composerPersistenceReadyRef, composerPersistenceTimerRef, persistComposerStateNow]);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) void loadStateRef.current().catch((error) => { if (!disposed) setError(errorText(error)); });
    });
    // Recover each draft under its owner. Cold start always opens the unscoped, empty composer.
    void loadPersistedComposerInputState().then((restored) => {
      if (disposed) return;
      composerDraftsRef.current = restored.drafts;
      queuedPromptsRef.current = restored.queues;
      setQueuedPromptsBySession(restored.queues);
      composerPersistenceReadyRef.current = true;
    }).catch(() => {
      if (disposed) return;
      // Keep the unread snapshot on disk so a later launch can recover it.
      showComposerFeedback('本地草稿读取失败。本次输入仅保留在当前窗口，重新打开后可重试。');
    }).finally(() => {
      if (!disposed) setComposerPersistenceReady(true);
    });
    return () => { disposed = true; };
  }, [composerDraftsRef, composerPersistenceReadyRef, loadStateRef, queuedPromptsRef, setComposerPersistenceReady, setError, setQueuedPromptsBySession, showComposerFeedback]);

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
    if (!composerPersistenceReady) return;
    scheduleComposerStatePersistence();
  }, [composerPersistenceReady, queuedPromptsBySession, session?.id, scheduleComposerStatePersistence, workspace]);

  useEffect(() => {
    if (!composerPersistenceReady) return;
    const flush = () => { void persistComposerStateNow(); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [composerPersistenceReady, persistComposerStateNow]);

  useEffect(() => {
    if (!composerPersistenceReady || stateLoading || prunedDrafts.current || !workspacesLoaded) return;
    prunedDrafts.current = true;
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
  }, [composerDraftsRef, composerPersistenceReady, queuedPromptsRef, setQueuedPromptsBySession, stateLoading, workspaces, workspacesLoaded]);

  useEffect(() => {
    if (!composerPersistenceReady) return;
    saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
      text: prompt,
      attachments: composerAttachments,
    });
  }, [composerAttachments, composerDraftKeyRef, composerDraftsRef, composerPersistenceReady, prompt]);

  return { persistDeletedComposerSessions };
}
