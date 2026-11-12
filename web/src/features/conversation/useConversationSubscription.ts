import type { ComposerEditorHandle } from './ComposerEditor';
import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { ChatMessage, RequestTrace, TurnDiff } from '../../types/chat-types';
import type { ConversationEvent, ConversationSnapshot } from '../../types/durable-types';
import type { LongTaskState } from '../../types/durable-types';
import type { ModelSelection } from '../../types/model-types';
import type { NotificationTone } from '../../shell/NotificationCenter';
import { errorText } from '../../shared/error-text';
import { eventSaysConversationRunning } from './conversation-activity';
import type { OutlineData, OutlineItem } from './outline-model';
import { submissionFailureText } from './submission-failure';
import { mergeRequestTrace, mergeStreamMessage, type StreamMessageType } from './transcript-events';

type SessionState = {
  id: string;
  cwd: string;
  title: string;
  longTask?: LongTaskState;
  turnDiffs?: TurnDiff[];
  totalMessages?: number;
};

type SubscriptionError = {
  sessionId: string;
  message: string;
  retrying: boolean;
};

type SubscriptionRecovery = {
  sessionId: string;
  retry: (restoreFocus?: boolean) => void;
};

type ConversationSubscriptionOptions = {
  sessionId?: string;
  turnActive: boolean;
  sessionRef: MutableRefObject<SessionState | null>;
  modelRevisionRef: MutableRefObject<Map<string, number>>;
  modelWritesRef: MutableRefObject<Set<string>>;
  requestRef: MutableRefObject<string | null>;
  composerEditorRef: RefObject<ComposerEditorHandle | null>;
  subscriptionRetryRef: MutableRefObject<SubscriptionRecovery | null>;
  loadState: () => Promise<void>;
  refreshSubagentChildren: (showSpinner?: boolean) => Promise<void>;
  refreshOutline: (sessionId: string, generation?: number) => Promise<OutlineData | undefined>;
  pushNotification: (message: string, tone?: NotificationTone, title?: string, sessionId?: string) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setStoppingSessionIds: Dispatch<SetStateAction<string[]>>;
  setRequestTraces: Dispatch<SetStateAction<RequestTrace[]>>;
  setCompaction: Dispatch<SetStateAction<{ active: boolean; reason?: string }>>;
  setRetryInfo: Dispatch<SetStateAction<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>>;
  setModelSelection: Dispatch<SetStateAction<ModelSelection>>;
  setSession: Dispatch<SetStateAction<SessionState | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLiveDiff: Dispatch<SetStateAction<TurnDiff | null>>;
  setOutlineItems: Dispatch<SetStateAction<OutlineItem[]>>;
  setOutlineTotalMessages: Dispatch<SetStateAction<number>>;
  setOutlineActive: Dispatch<SetStateAction<number>>;
  setConversationSubscriptionError: Dispatch<SetStateAction<SubscriptionError | null>>;
};

/**
 * Owns the Durable conversation event lifecycle, reconnect recovery and the
 * low-frequency run-state verification that backs up the event stream.
 */
export function useConversationSubscription({
  sessionId,
  turnActive,
  sessionRef,
  modelRevisionRef,
  modelWritesRef,
  requestRef,
  composerEditorRef,
  subscriptionRetryRef,
  loadState,
  refreshSubagentChildren,
  refreshOutline,
  pushNotification,
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
}: ConversationSubscriptionOptions) {
  useEffect(() => {
    setConversationSubscriptionError((current) => (
      current?.sessionId === sessionId ? current : null
    ));
  }, [sessionId, setConversationSubscriptionError]);

  // 会话通过一个明确的 subscription 生命周期接收事件。首次快照与后续增量
  // 来自同一 Durable 事件流；重连只依赖快照，不重放旧消息。
  useEffect(() => {
    const conversationId = sessionId;
    if (!conversationId) return;
    let disposed = false;
    let ready = false;
    let connecting = false;
    let bufferEvents = true;
    let connectionGeneration = 0;
    let batch: Array<{ message: ChatMessage; type: StreamMessageType }> = [];
    let frame = 0;
    const buffered: ConversationEvent[] = [];
    let recoveringClosedStream = false;
    let streamRunActive = false;
    const modelScope = `session:${conversationId}`;
    const subscriptionModelRevision = modelRevisionRef.current.get(modelScope) ?? 0;
    const clearStopping = () => {
      setStoppingSessionIds((ids) => ids.filter((id) => id !== conversationId));
    };
    const modelReadCurrent = (revision: number) => !disposed
      && sessionRef.current?.id === conversationId
      && revision === (modelRevisionRef.current.get(modelScope) ?? 0)
      && !modelWritesRef.current.has(modelScope);

    const flush = () => {
      frame = 0;
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      setMessages((current) => pending.reduce(
        (list, item) => mergeStreamMessage(list, item.message, item.type),
        current,
      ));
    };
    const flushNow = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
    };
    const schedule = (message: ChatMessage, type: StreamMessageType) => {
      batch.push({ message, type });
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const applySnapshot = (snapshot: ConversationSnapshot | undefined) => {
      if (disposed || !snapshot) return;
      streamRunActive = Boolean(snapshot.running);
      setBusy(streamRunActive);
      setRequestTraces(Array.isArray(snapshot.requestTraces) ? snapshot.requestTraces : []);
      setCompaction({ active: Boolean(snapshot.compacting) });
      setRetryInfo(snapshot.retry ? {
        attempt: 1,
        maxAttempts: 1,
        errorMessage: snapshot.retry.error,
      } : null);
      if (modelReadCurrent(subscriptionModelRevision)) {
        setModelSelection(current => ({
          ...snapshot.model,
          pending: snapshot.running && current.modelRef !== snapshot.model.modelRef,
        }));
      }
      if (snapshot.longTask) {
        setSession((current) => current?.id === conversationId
          ? { ...current, longTask: snapshot.longTask }
          : current);
      }
      if (snapshot.requestId) requestRef.current = snapshot.requestId;
      if (snapshot.generation && snapshot.generation.role === 'assistant') {
        schedule({ ...snapshot.generation, streaming: true }, 'message_update');
      }
    };

    const refreshCompletion = () => {
      flushNow();
      setRetryInfo(null);
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
      setError(null);
      setCompaction({ active: false });
      requestRef.current = '';
      clearStopping();
      void loadState();
      const revision = modelRevisionRef.current.get(modelScope) ?? 0;
      void window.piApi.conversationSnapshot(conversationId).then((snapshot) => {
        if (modelReadCurrent(revision) && snapshot?.model) setModelSelection(snapshot.model);
        if (!disposed && Array.isArray(snapshot?.requestTraces)) {
          setRequestTraces(snapshot.requestTraces);
        }
        // The turn diff can land after its event or be missed entirely; re-read
        // the stored rows so the file summary shows git counts, not a fallback.
        if (!disposed && Array.isArray(snapshot?.turnDiffs)) {
          setSession((current) => current?.id === conversationId
            ? { ...current, turnDiffs: snapshot.turnDiffs as TurnDiff[] }
            : current);
        }
        if (!disposed && snapshot?.longTask) {
          setSession((current) => current?.id === conversationId
            ? { ...current, longTask: snapshot.longTask }
            : current);
        }
      }).catch(() => {});
      void refreshOutline(conversationId).then((outline) => {
        if (!outline || disposed) return;
        setOutlineItems(outline.items);
        setOutlineTotalMessages(outline.totalMessages);
        setOutlineActive((current) => Math.min(current, Math.max(0, outline.items.length - 1)));
      });
    };

    const handle = (event: ConversationEvent) => {
      if (event.conversationId !== conversationId) return;
      if (!ready) {
        if (bufferEvents) buffered.push(event);
        return;
      }
      switch (event.type) {
        case 'snapshot':
          streamRunActive = eventSaysConversationRunning(
            event.payload,
            Boolean(event.payload.run),
          );
          setBusy(streamRunActive);
          setCompaction({ active: event.payload.compactions.length > 0 });
          if (event.payload.generation?.role === 'assistant') {
            schedule({ ...event.payload.generation, streaming: true }, 'message_update');
          }
          return;
        case 'assistant.updated':
          if (event.payload.message.role === 'assistant') {
            schedule(event.payload.message, 'message_update');
          }
          return;
        case 'assistant.completed':
          if (event.payload.message.role === 'assistant') {
            schedule(event.payload.message, 'message_end');
            flushNow();
          }
          return;
        case 'transcript.appended':
          for (const message of event.payload.messages) {
            if (message.role === 'toolResult') schedule(message, 'message_end');
          }
          return;
        case 'request.trace':
          setRequestTraces((current) => mergeRequestTrace(current, event.payload.trace));
          return;
        case 'run.started':
          streamRunActive = true;
          setBusy(true);
          setError(null);
          return;
        case 'run.completed':
          if (eventSaysConversationRunning(event.payload, false)) {
            streamRunActive = true;
            flushNow();
            setBusy(true);
            setError(null);
            void loadState().catch(() => {});
            void refreshSubagentChildren(false);
            return;
          }
          streamRunActive = false;
          refreshCompletion();
          clearStopping();
          void refreshSubagentChildren(false);
          return;
        case 'run.failed': {
          flushNow();
          setRetryInfo(null);
          setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
          setCompaction({ active: false });
          const failure = submissionFailureText(event.payload.reason, event.payload.detail);
          if (event.payload.reason === 'aborted') {
            // 用户主动中止：保留上下文，不当作错误。
            streamRunActive = eventSaysConversationRunning(event.payload, false);
            setBusy(streamRunActive);
            setError(null);
            requestRef.current = '';
            if (!streamRunActive) clearStopping();
            void refreshSubagentChildren(false);
            return;
          }
          streamRunActive = eventSaysConversationRunning(event.payload, false);
          setBusy(streamRunActive);
          if (!streamRunActive) clearStopping();
          const message = failure || event.payload.message || '执行失败，请检查原因后继续';
          setError(message);
          pushNotification(message, 'error', '会话执行失败', conversationId);
          if (event.payload.running) void loadState().catch(() => {});
          void refreshSubagentChildren(false);
          return;
        }
        case 'retry.updated':
          setRetryInfo(event.payload.active ? {
            attempt: event.payload.attempt,
            maxAttempts: 1,
            errorMessage: event.payload.errorMessage,
          } : null);
          return;
        case 'compaction.started':
          setCompaction({ active: true, reason: String(event.payload.reason || '') });
          return;
        case 'compaction.completed':
          setCompaction({ active: false });
          if (typeof event.payload.error === 'string' && event.payload.error) {
            setError(event.payload.error);
            pushNotification(event.payload.error, 'error', '上下文压缩未完成', conversationId);
          }
          return;
        case 'turn.diff':
          setLiveDiff(event.payload.diff);
          setSession((current) => current
            ? {
                ...current,
                turnDiffs: [
                  ...(current.turnDiffs ?? []).filter((diff) => diff.at !== event.payload.diff.at),
                  event.payload.diff,
                ],
              }
            : current);
          return;
        case 'stream.closed':
          // Durable ended the watch without replaying its task state. Keep the
          // last visible content intact and make reconnection the only action.
          ready = false;
          bufferEvents = true;
          recoveringClosedStream = true;
          setConversationSubscriptionError({
            sessionId: conversationId,
            message: '实时连接已中断，当前状态可能不是最新。重新连接后会同步已保存的进度。',
            retrying: false,
          });
          return;
        default:
          return;
      }
    };

    const connect = (restoreFocus = false) => {
      if (disposed || connecting) return;
      connecting = true;
      bufferEvents = true;
      const generation = ++connectionGeneration;
      void window.piApi.subscribeConversation(conversationId).then((snapshot) => {
        if (disposed || generation !== connectionGeneration) return;
        const recoveredClosedStream = recoveringClosedStream;
        recoveringClosedStream = false;
        connecting = false;
        applySnapshot(snapshot);
        ready = true;
        setConversationSubscriptionError(null);
        for (const event of buffered.splice(0)) handle(event);
        if (recoveredClosedStream && !streamRunActive) refreshCompletion();
        if (restoreFocus) {
          requestAnimationFrame(() => composerEditorRef.current?.focus({ preventScroll: true }));
        }
      }).catch((cause) => {
        if (disposed || generation !== connectionGeneration) return;
        connecting = false;
        bufferEvents = false;
        buffered.length = 0;
        setConversationSubscriptionError({
          sessionId: conversationId,
          message: errorText(cause),
          retrying: false,
        });
      });
    };

    const unsubscribe = window.piApi.onConversationEvent(handle);
    const recovery: SubscriptionRecovery = { sessionId: conversationId, retry: connect };
    subscriptionRetryRef.current = recovery;
    connect();
    return () => {
      disposed = true;
      connectionGeneration += 1;
      if (subscriptionRetryRef.current === recovery) {
        subscriptionRetryRef.current = null;
      }
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      void window.piApi.unsubscribeConversation(conversationId).catch(() => {});
    };
  }, [loadState, sessionId]);

  function retryConversationSubscription() {
    const recovery = subscriptionRetryRef.current;
    const currentSessionId = sessionRef.current?.id;
    if (!recovery || !currentSessionId || recovery.sessionId !== currentSessionId) return;
    setConversationSubscriptionError((current) => (
      current?.sessionId === currentSessionId ? { ...current, retrying: true } : current
    ));
    recovery.retry(true);
  }

  useEffect(() => {
    if (!sessionId || !turnActive) return;
    let disposed = false;
    const verifyRunState = async () => {
      try {
        const snapshot = await window.piApi.conversationSnapshot(sessionId);
        if (disposed || snapshot?.running) return;
        setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
        setBusy(false);
        setCompaction({ active: false });
        setRetryInfo(null);
        setError(null);
        requestRef.current = '';
        await loadState();
        await refreshSubagentChildren(false);
      } catch {
        // The event subscription remains the primary real-time channel.
      }
    };
    const timer = window.setInterval(() => void verifyRunState(), 8_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadState, sessionId, turnActive]);

  return { retryConversationSubscription };
}
