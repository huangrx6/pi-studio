import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  ChatMessage,
  ComposerAttachment,
  RequestTrace,
} from '../../types/chat-types';
import type {
  ConversationPage,
  ConversationSummary,
} from '../../types/durable-types';
import type { ModelSelection } from '../../types/model-types';
import type {
  DispatchOutcome,
  PiSessionSummary,
  PiWorkspace,
} from '../../shell/app-types';
import type { AppNotificationAction, NotificationTone } from '../../shell/NotificationCenter';
import { errorText } from '../../shared/error-text';
import {
  composerDraftMatches,
  retainedComposerRequestId,
  snapshotComposerDraft,
} from './composer-preparation';
import {
  markRejectedQueuedSubmission,
  mergeRejectedComposerDraft,
  removeAdmittedQueuedSubmission,
} from './composer-delivery.mjs';
import {
  clearComposerDraft,
  composerDraftKeyForSession,
  emptyComposerDraft,
  moveComposerDraft,
  readComposerDraft,
  saveComposerDraft,
  type ComposerDraft,
} from './composer-drafts';
import type {
  PreparedSubmission,
  QueuedEditContext,
  QueuedPrompt,
} from './composer-types';
import { extractComposerMentions, normalizeComposerText } from './references';
import { mergeComposerAttachments, recoverComposerPaste, type PendingComposerPaste } from './composer-paste';
import { loadTranscriptWindow } from './transcript-load.mjs';
import type { OutlineData } from './outline-model';
import { isLongMessage } from './composer-budget.mjs';
import { parseStudioCommand } from './composer-command-routes.mjs';
import type { LongTaskState } from '../../types/durable-types';
import type { TurnDiff } from '../../types/chat-types';
import type { ModelPickerRequest } from '../models/ModelPicker';
import type { ComposerMenuState } from './useComposerSuggestions';

type Setter<T> = Dispatch<SetStateAction<T>>;
export type SessionStateForPersistence = {
  id: string;
  cwd: string;
  title: string;
  longTask?: LongTaskState;
  turnDiffs?: TurnDiff[];
  totalMessages?: number;
} | null;
type SessionState = SessionStateForPersistence;

type MessageDeliveryDependencies = {
  session: SessionState;
  sessionRef: MutableRefObject<SessionState>;
  sessionLoadRef: MutableRefObject<number>;
  /** 当前会话已载入窗口的分页游标；提交后要跟着新的一页更新。 */
  transcriptPageRef: MutableRefObject<{ sessionId: string; page: { hasOlder?: boolean; nextCursor?: string } } | null>;
  workspaces: PiWorkspace[];
  workspace: string;
  modelSelection: ModelSelection;
  busy: boolean;
  setBusy: Setter<boolean>;
  setError: Setter<string | null>;
  setRetryInfo: Setter<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>;
  setLiveDiff: Setter<import('../../types/chat-types').TurnDiff | null>;
  setCompaction: Setter<{ active: boolean; reason?: string }>;
  compaction: { active: boolean; reason?: string };
  turnActive: boolean;
  turnActiveRef: MutableRefObject<boolean>;
  sendBlockedRef: MutableRefObject<boolean>;
  stopping: boolean;
  setStoppingSessionIds: Setter<string[]>;
  longTaskBusy: boolean;
  setLongTaskBusy: Setter<boolean>;
  sessionLoading: boolean;
  stateLoading: boolean;
  prompt: string;
  queuedPrompts: QueuedPrompt[];
  queuedPromptsBySession: Record<string, QueuedPrompt[]>;
  setQueuedPromptsBySession: Setter<Record<string, QueuedPrompt[]>>;
  queuedPromptsRef: MutableRefObject<Record<string, QueuedPrompt[]>>;
  queuedDrainSessionsRef: MutableRefObject<Set<string>>;
  queueAdmissionPendingBySession: Record<string, string>;
  setQueueAdmissionPendingBySession: Setter<Record<string, string>>;
  queueAdmissionPendingRef: MutableRefObject<Record<string, string>>;
  queuedEditContextsRef: MutableRefObject<Record<string, QueuedEditContext>>;
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  composerPersistenceStartedRef: MutableRefObject<boolean>;
  setComposerPersistenceStarted: Setter<boolean>;
  composerAttachments: ComposerAttachment[];
  composerDeliveryRetriesRef: MutableRefObject<Map<string, { draft: ComposerDraft; requestId: string }>>;
  latestComposerAttemptByKeyRef: MutableRefObject<Map<string, string>>;
  latestPromptBySessionRef: MutableRefObject<Map<string, string>>;
  preparingDraftsRef: MutableRefObject<Set<string>>;
  setPreparingDraftKeys: Setter<string[]>;
  setComposerMenu: Setter<ComposerMenuState | null>;
  setComposerFeedback: Setter<{ message: string; tone: 'info' | 'warning' } | null>;
  setPrompt: Setter<string>;
  setComposerAttachments: Setter<ComposerAttachment[]>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  requestRef: MutableRefObject<string | null>;
  modelPickerRequestRef: MutableRefObject<number>;
  setModelPickerRequest: Setter<ModelPickerRequest | null>;
  setTodoPanelOpen: Setter<boolean>;
  setSession: Setter<SessionState>;
  setMessages: Setter<ChatMessage[]>;
  setRequestTraces: Setter<RequestTrace[]>;
  loadState: () => Promise<void>;
  applyOutline: (data: OutlineData | undefined, messages: ChatMessage[], fallbackStart?: number) => void;
  refreshOutline: (sessionId: string, generation?: number) => Promise<OutlineData | undefined>;
  refreshSubagentChildren: (showSpinner?: boolean) => Promise<void>;
  resumeTranscriptFollow: () => void;
  pushNotification: (
    message: string,
    tone?: NotificationTone,
    title?: string,
    sessionId?: string,
    action?: AppNotificationAction,
  ) => void;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  commandHandlersRef: MutableRefObject<{
    findExtensionCommand: (input: string) => Promise<{ commandId: string; argument: string } | undefined>;
    executeBuiltinCommand: (input: string) => Promise<boolean>;
    executeExtensionCommand: (commandId: string, input?: string) => Promise<boolean>;
  }>;
};

export function useMessageDelivery({
  session,
  sessionRef,
  sessionLoadRef,
  transcriptPageRef,
  workspaces,
  workspace,
  modelSelection,
  busy,
  setBusy,
  setError,
  setRetryInfo,
  setLiveDiff,
  setCompaction,
  compaction,
  turnActive,
  turnActiveRef,
  sendBlockedRef,
  stopping,
  setStoppingSessionIds,
  longTaskBusy,
  setLongTaskBusy,
  sessionLoading,
  stateLoading,
  prompt,
  queuedPrompts,
  queuedPromptsBySession,
  setQueuedPromptsBySession,
  queuedPromptsRef,
  queuedDrainSessionsRef,
  queueAdmissionPendingBySession,
  setQueueAdmissionPendingBySession,
  queueAdmissionPendingRef,
  queuedEditContextsRef,
  composerDraftKeyRef,
  composerDraftsRef,
  composerPersistenceStartedRef,
  setComposerPersistenceStarted,
  composerAttachments,
  composerDeliveryRetriesRef,
  latestComposerAttemptByKeyRef,
  latestPromptBySessionRef,
  preparingDraftsRef,
  setPreparingDraftKeys,
  setComposerMenu,
  setComposerFeedback,
  setPrompt,
  setComposerAttachments,
  textareaRef,
  requestRef,
  modelPickerRequestRef,
  setModelPickerRequest,
  setTodoPanelOpen,
  setSession,
  setMessages,
  setRequestTraces,
  loadState,
  applyOutline,
  refreshOutline,
  refreshSubagentChildren,
  resumeTranscriptFollow,
  pushNotification,
  showComposerFeedback,
  commandHandlersRef,
}: MessageDeliveryDependencies) {
  const isNewConversation = !session?.id;

  function currentComposerDraft(): ComposerDraft {
    return { text: prompt, attachments: composerAttachments };
  }

  function checkpointComposerDraft(): void {
    saveComposerDraft(
      composerDraftsRef.current,
      composerDraftKeyRef.current,
      currentComposerDraft(),
    );
  }

  function installComposerDraft(key: string, restore = true): void {
    const next = restore
      ? readComposerDraft(composerDraftsRef.current, key)
      : emptyComposerDraft();
    composerDraftKeyRef.current = key;
    setPrompt(next.text);
    setComposerAttachments(next.attachments);
    if (!composerPersistenceStartedRef.current) {
      composerPersistenceStartedRef.current = true;
      setComposerPersistenceStarted(true);
    }
  }

  function clearActiveComposerDraftText(): void {
    const key = composerDraftKeyRef.current;
    saveComposerDraft(composerDraftsRef.current, key, {
      ...currentComposerDraft(),
      text: '',
    });
    setPrompt('');
  }

  function clearActiveComposerDraft(): void {
    clearComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current);
    setPrompt('');
    setComposerAttachments([]);
  }

  function readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function appendComposerAttachments(
    additions: ComposerAttachment[],
    targetKey = composerDraftKeyRef.current,
  ): void {
    if (additions.length === 0) return;
    const next = mergeComposerAttachments(readComposerDraft(composerDraftsRef.current, targetKey), additions);
    saveComposerDraft(composerDraftsRef.current, targetKey, next);
    if (targetKey === composerDraftKeyRef.current) setComposerAttachments(next.attachments);
  }

  async function attachPastedText(paste: PendingComposerPaste): Promise<void> {
    const targetKey = composerDraftKeyRef.current;
    try {
      const saved = await window.piApi.saveAttachment({ sessionId: session?.id || 'draft', text: paste.text });
      const attachment: ComposerAttachment = {
        id: crypto.randomUUID(), kind: 'file', name: saved.name, mime: saved.mime || 'text/plain',
        bytes: saved.bytes, lines: saved.lines, path: saved.path, marker: saved.marker,
      };
      appendComposerAttachments([attachment], targetKey);
    } catch {
      const current = readComposerDraft(composerDraftsRef.current, targetKey);
      const recovered = recoverComposerPaste(current.text, paste);
      saveComposerDraft(composerDraftsRef.current, targetKey, { ...current, text: recovered.text });
      if (composerDraftKeyRef.current === targetKey) {
        setPrompt(recovered.text);
        showComposerFeedback(recovered.appended
          ? '文本附件保存失败，粘贴内容已保留在草稿末尾，后续输入未被覆盖。'
          : '文本附件保存失败，粘贴内容已恢复为草稿文本。');
      }
    }
  }

  async function addComposerFiles(files: File[]) {
    const targetKey = composerDraftKeyRef.current;
    const report = (message: string) => {
      if (composerDraftKeyRef.current === targetKey) showComposerFeedback(message);
    };
    const images = files.filter((file) => file.type.startsWith('image/'));
    const accepted = modelSelection.supportsImages === false && images.length > 0
      ? files.filter((file) => !file.type.startsWith('image/'))
      : files;
    if (accepted.length !== files.length) {
      report(`${modelSelection.label || '当前模型'} 不支持图片输入。请切换到支持图片的模型后再添加图片。`);
    } else if (images.length > 0) {
      setComposerFeedback(null);
    }
    for (const file of accepted) {
      if (file.size > 20_000_000) { report(`文件「${file.name}」超过 20MB`); continue; }
      try {
        if (file.type.startsWith('image/')) {
          const data = await readFileBase64(file);
          const attachment: ComposerAttachment = { id: crypto.randomUUID(), kind: 'image', name: file.name || 'image.png', mime: file.type || 'image/png', bytes: file.size, data };
          appendComposerAttachments([attachment], targetKey);
        } else {
          const data = await readFileBase64(file);
          const saved = await window.piApi.saveUpload({ sessionId: session?.id, name: file.name || 'attachment', mime: file.type, data });
          const attachment: ComposerAttachment = { ...saved, id: crypto.randomUUID() };
          appendComposerAttachments([attachment], targetKey);
        }
      } catch (error) { report(errorText(error)); }
    }
  }

  async function pickComposerAttachments() {
    const targetKey = composerDraftKeyRef.current;
    try {
      const result = await window.piApi.pickAttachments({ sessionId: session?.id });
      const rejectedImages = modelSelection.supportsImages === false
        ? result.attachments.filter((attachment) => attachment.kind === 'image').length
        : 0;
      const accepted = rejectedImages > 0
        ? result.attachments.filter((attachment) => attachment.kind !== 'image')
        : result.attachments;
      if (rejectedImages > 0 && composerDraftKeyRef.current === targetKey) {
        showComposerFeedback(`${modelSelection.label || '当前模型'} 不支持图片输入，已保留可发送的普通文件。`);
      }
      appendComposerAttachments(accepted, targetKey);
    } catch (error) {
      if (composerDraftKeyRef.current === targetKey) showComposerFeedback(errorText(error));
    }
  }

  function removeComposerAttachment(id: string) {
    const nextAttachments = composerAttachments.filter((attachment) => attachment.id !== id);
    saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
      ...currentComposerDraft(),
      attachments: nextAttachments,
    });
    setComposerAttachments(nextAttachments);
  }

  /** 排队消息按会话隔离；更新时保留其他会话的队列。 */
  function updateSessionQueuedPrompts(
    sessionId: string,
    update: (items: QueuedPrompt[]) => QueuedPrompt[],
  ) {
    setQueuedPromptsBySession((current) => {
      const items = update(current[sessionId] ?? []);
      if (items.length === 0) {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      }
      return { ...current, [sessionId]: items };
    });
  }

  function clearSessionQueuedPrompts(sessionId: string) {
    setQueuedPromptsBySession((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    clearQueueAdmissionPending(sessionId);
  }

  function markQueueAdmissionPending(sessionId: string, requestId: string) {
    if (queueAdmissionPendingRef.current[sessionId] === requestId) return;
    queueAdmissionPendingRef.current = {
      ...queueAdmissionPendingRef.current,
      [sessionId]: requestId,
    };
    setQueueAdmissionPendingBySession((current) => {
      if (current[sessionId] === requestId) return current;
      return { ...current, [sessionId]: requestId };
    });
  }

  function clearQueueAdmissionPending(sessionId: string, requestId?: string) {
    if (
      !(sessionId in queueAdmissionPendingRef.current)
      || (requestId && queueAdmissionPendingRef.current[sessionId] !== requestId)
    ) return;
    const next = { ...queueAdmissionPendingRef.current };
    delete next[sessionId];
    queueAdmissionPendingRef.current = next;
    setQueueAdmissionPendingBySession((current) => {
      if (!(sessionId in current) || (requestId && current[sessionId] !== requestId)) return current;
      const updated = { ...current };
      delete updated[sessionId];
      return updated;
    });
  }

  function isQueueAdmissionPending(sessionId: string, requestId: string) {
    return queueAdmissionPendingRef.current[sessionId] === requestId;
  }

  /**
   * 组装一次提交：
   *  - 超长文本落盘为附件（界面显示摘要，模型收到标记）
   *  - 附件文件与图片分别转成标记 / 图片块
   *  - 从文本里解析 @ 引用，交给主进程读取文件内容
   */
  async function prepareSubmission(
    text: string,
    attachments: ComposerAttachment[],
    sessionId: string,
    requestId?: string,
  ): Promise<PreparedSubmission> {
    // 输入框用 em space 给引用徽章的图标留位置，发送前还原成普通空格。
    text = normalizeComposerText(text);
    const files = attachments.filter((attachment) => attachment.kind === 'file');
    const images = attachments.filter((attachment) => attachment.kind === 'image');
    if (images.length > 0 && modelSelection.supportsImages === false) {
      const message = `${modelSelection.label || '当前模型'} 不支持图片输入。请先移除图片，或切换到支持图片的模型。`;
      showComposerFeedback(message);
      throw new Error(message);
    }
    let displayText = text;
    let outgoingText = text;
    let longAttachments: ChatMessage['attachments'] = [];
    if (text && isLongMessage(text)) {
      try {
        const saved = await window.piApi.saveAttachment({ sessionId, text });
        outgoingText = text;
        displayText = saved.notice;
        longAttachments = [{ name: saved.name, path: saved.path, bytes: saved.bytes, lines: saved.lines, kind: 'text', mime: 'text/plain' }];
      } catch { /* fall back to inline text */ }
    }
    const fileAttachments = files.map((file) => ({ name: file.name, path: file.path as string, bytes: file.bytes, lines: file.lines || 0, kind: 'file' as const, mime: file.mime }));
    if (!displayText) {
      displayText = files.length > 0 ? '请查看附件。' : images.length > 0 ? '请查看图片。' : '';
      if (!text) outgoingText = displayText;
    }
    const content: ChatMessage['content'] = [];
    if (displayText) content.push({ type: 'text', text: displayText });
    for (const image of images) {
      if (image.data) content.push({ type: 'image', data: image.data, mimeType: image.mime });
    }
    const persistentAttachments = [...(longAttachments ?? []), ...fileAttachments];
    const imagePayload = images.filter((image) => image.data).map((image) => ({ type: 'image' as const, data: image.data as string, mimeType: image.mime }));
    const mentions = extractComposerMentions(text);
    return {
      sessionId,
      requestId: requestId || crypto.randomUUID(),
      displayText,
      outgoingText,
      content,
      persistentAttachments,
      imagePayload,
      mentions,
      attachmentPaths: persistentAttachments.map((attachment) => attachment.path),
    };
  }

  /**
   * 真正发出消息。
   *  - steer：插话到正在运行的任务，不进入排队
   *  - prompt：正常发送，先乐观插入用户消息，结束后用主进程返回的历史校准
   *
   * conversationSubmit 只有在 Durable 接受输入后才 resolve；后续读取失败
   * 由主进程作为 postCommitError 返回，不能把已经准入的消息重新退化为草稿。
   */
  async function dispatchSubmission(
    submission: PreparedSubmission,
    mode: 'prompt' | 'steer',
  ): Promise<DispatchOutcome> {
    if (sendBlockedRef.current) {
      return {
        state: 'rejected',
        current: true,
        error: compaction.active
          ? '上下文压缩期间暂时不能发送。'
          : '会话状态正在变化，请稍后重试。',
      };
    }
    const requestId = submission.requestId;
    const visibleConversation = () => sessionRef.current?.id === submission.sessionId;
    const canApplyPromptResult = () => (
      visibleConversation()
      && latestPromptBySessionRef.current.get(submission.sessionId) === requestId
    );
    if (mode === 'prompt') {
      latestPromptBySessionRef.current.set(submission.sessionId, requestId);
    }
    resumeTranscriptFollow();
    const optimisticMessage: ChatMessage & { optimisticRequestId: string } = {
      role: 'user',
      content: submission.content,
      timestamp: Date.now(),
      optimisticRequestId: submission.requestId,
      ...(submission.persistentAttachments.length > 0 ? { attachments: submission.persistentAttachments } : {}),
    };
    setMessages((existing) => [...existing, optimisticMessage]);
    const removeOptimistic = () => {
      setMessages((existing) => existing.filter((message) => (
        (message as ChatMessage & { optimisticRequestId?: string }).optimisticRequestId
          !== submission.requestId
      )));
    };
    if (mode === 'prompt') {
      setBusy(true);
      setError(null);
      setRetryInfo(null);
      setLiveDiff(null);
      setCompaction({ active: false });
      requestRef.current = requestId;
    }
    let result: Awaited<ReturnType<typeof window.piApi.conversationSubmit>>;
    try {
      result = await window.piApi.conversationSubmit({
        id: submission.sessionId,
        text: submission.outgoingText,
        requestId,
        whenBusy: mode === 'steer' ? 'steer' : 'followUp',
        mentions: submission.mentions,
        attachments: submission.attachmentPaths,
        images: submission.imagePayload,
      });
    } catch (error) {
      removeOptimistic();
      const current = mode === 'prompt' ? canApplyPromptResult() : visibleConversation();
      if (current) {
        if (mode === 'prompt' && requestRef.current === requestId) requestRef.current = '';
        setRetryInfo(null);
        setError(errorText(error));
        if (mode === 'prompt') setBusy(false);
      }
      if (latestPromptBySessionRef.current.get(submission.sessionId) === requestId) {
        latestPromptBySessionRef.current.delete(submission.sessionId);
      }
      return {
        state: 'rejected',
        current,
        error: errorText(error),
      };
    }

    try {
      void loadState().catch(() => {});
      let postCommitError = result.postCommitError || '';
      if (mode === 'prompt' && canApplyPromptResult()) {
        try {
          const [saved, outline] = await Promise.all([
            loadTranscriptWindow(window.piApi.conversationPage, submission.sessionId),
            refreshOutline(submission.sessionId),
          ]);
          if (canApplyPromptResult() && saved) {
            transcriptPageRef.current = { sessionId: saved.id, page: saved.page ?? { hasOlder: false } };
            setSession({
              id: saved.id,
              cwd: saved.cwd,
              title: saved.title,
              longTask: saved.longTask,
              turnDiffs: saved.turnDiffs,
              totalMessages: outline?.totalMessages,
            });
            setMessages(saved.messages.map((message) => ({ ...message })));
            setRequestTraces(Array.isArray(saved.requestTraces) ? saved.requestTraces : []);
            if (outline) applyOutline(outline, saved.messages, saved.messageStart);
            else applyOutline(undefined, saved.messages, saved.messageStart);
          }
        } catch {
          postCommitError ||= '消息已提交，但对话记录暂时无法刷新。';
        }
      }
      const current = mode === 'prompt' ? canApplyPromptResult() : visibleConversation();
      if (latestPromptBySessionRef.current.get(submission.sessionId) === requestId) {
        latestPromptBySessionRef.current.delete(submission.sessionId);
      }
      if (postCommitError) {
        if (current) setError(null);
        try {
          pushNotification(
            postCommitError,
            'warning',
            mode === 'prompt' ? '消息已提交' : '排队消息已发送',
            submission.sessionId,
          );
        } catch {
          // The admitted state remains authoritative if notifications fail.
        }
      }
      return postCommitError
        ? {
            state: 'admitted-but-postcommit-read-failed',
            current,
            error: postCommitError,
          }
        : { state: 'admitted', current };
    } catch {
      const current = mode === 'prompt' ? canApplyPromptResult() : visibleConversation();
      const message = '消息已提交，但界面暂时无法刷新。';
      if (latestPromptBySessionRef.current.get(submission.sessionId) === requestId) {
        latestPromptBySessionRef.current.delete(submission.sessionId);
      }
      if (current) {
        setError(null);
      }
      try {
        pushNotification(
          result.postCommitError || message,
          'warning',
          mode === 'prompt' ? '消息已提交' : '排队消息已发送',
          submission.sessionId,
        );
      } catch {
        // The admitted state is still preserved if notifications fail.
      }
      return {
        state: 'admitted-but-postcommit-read-failed',
        current,
        error: result.postCommitError || message,
      };
    }
  }

  /**
   * Replace a user message and rebuild the active branch from that point.
   * Durable applies the context boundary before generating the replacement,
   * so this is a real edit rather than a renderer-only transcript mask.
   */
  async function handleEditMessage(entryId: number, text: string) {
    const sessionId = session?.id;
    if (!sessionId) throw new Error('会话不存在，请重新打开后再试');
    if (turnActive || compaction.active) {
      throw new Error('当前会话仍在运行，请停止回答后再编辑消息');
    }
    latestPromptBySessionRef.current.delete(sessionId);
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    resumeTranscriptFollow();
    setBusy(true);
    setError(null);
    setRetryInfo(null);
    try {
      await window.piApi.conversationEdit({
        id: sessionId,
        entryId,
        text: normalizeComposerText(text),
        requestId,
        mentions: extractComposerMentions(text),
      });
      void loadState().catch(() => {});
      if (requestRef.current !== requestId) return;
      const [saved, outline] = await Promise.all([
        loadTranscriptWindow(window.piApi.conversationPage, sessionId),
        refreshOutline(sessionId),
      ]);
      if (requestRef.current !== requestId) return;
      if (saved) {
        transcriptPageRef.current = { sessionId: saved.id, page: saved.page ?? { hasOlder: false } };
        setSession({
          id: saved.id,
          cwd: saved.cwd,
          title: saved.title,
          longTask: saved.longTask,
          turnDiffs: saved.turnDiffs,
          totalMessages: outline?.totalMessages,
        });
        setMessages(saved.messages.map((message) => ({ ...message })));
        setRequestTraces(Array.isArray(saved.requestTraces) ? saved.requestTraces : []);
        if (outline) applyOutline(outline, saved.messages, saved.messageStart);
        else applyOutline(undefined, saved.messages, saved.messageStart);
      }
    } catch (error) {
      if (requestRef.current === requestId) {
        setBusy(false);
        setRetryInfo(null);
      }
      throw new Error(errorText(error));
    }
  }

  /** 非当前会话的队列不能写入当前聊天 UI，直接提交到它自己的 Durable 会话。 */
  async function submitQueuedInBackground(submission: PreparedSubmission): Promise<DispatchOutcome> {
    let result: Awaited<ReturnType<typeof window.piApi.conversationSubmit>>;
    try {
      result = await window.piApi.conversationSubmit({
        id: submission.sessionId,
        text: submission.outgoingText,
        requestId: submission.requestId,
        whenBusy: 'followUp',
        mentions: submission.mentions,
        attachments: submission.attachmentPaths,
        images: submission.imagePayload,
      });
    } catch (error) {
      const message = errorText(error);
      pushNotification(
        `排队消息未能继续发送：${message}`,
        'error',
        '排队发送失败',
        submission.sessionId,
      );
      return { state: 'rejected', current: false, error: message };
    }
    try {
      void loadState().catch(() => {});
      if (result.postCommitError) {
        pushNotification(
          result.postCommitError,
          'warning',
          '排队消息已发送',
          submission.sessionId,
        );
      }
      return result.postCommitError
        ? {
            state: 'admitted-but-postcommit-read-failed',
            current: false,
            error: result.postCommitError,
          }
        : { state: 'admitted', current: false };
    } catch {
      const message = '排队消息已提交，但界面暂时无法刷新。';
      try {
        pushNotification(message, 'warning', '排队消息已发送', submission.sessionId);
      } catch {
        // Do not convert an admitted Durable input into a retryable failure.
      }
      return {
        state: 'admitted-but-postcommit-read-failed',
        current: false,
        error: result.postCommitError || message,
      };
    }
  }

  /**
   * 输入框的发送入口。
   * 依次处理内置命令、懒创建会话、长消息/附件预处理，
   * 最后根据是否正在运行决定「直接发送 / 插话 / 排队」。
   */
  async function send(overrideText?: string, busyBehavior: 'steer' | 'queue' = 'steer') {
    if (sendBlockedRef.current) return;
    const sourceDraftKey = composerDraftKeyRef.current;
    if (preparingDraftsRef.current.has(sourceDraftKey)) return;
    const latest = readComposerDraft(composerDraftsRef.current, sourceDraftKey);
    const original = snapshotComposerDraft(overrideText === undefined ? latest : { ...latest, text: overrideText });
    const text = original.text.trim();
    if (!text && original.attachments.length === 0) return;
    if (overrideText !== undefined) saveComposerDraft(composerDraftsRef.current, sourceDraftKey, original);
    const generation = sessionLoadRef.current;
    let ownerKey = sourceDraftKey;
    let createdSession = false;
    const lockedKeys = new Set<string>();
    const lock = (key: string) => {
      lockedKeys.add(key);
      preparingDraftsRef.current.add(key);
      setPreparingDraftKeys(keys => keys.includes(key) ? keys : [...keys, key]);
    };
    const release = () => {
      if (!lockedKeys.size) return;
      const releasing = new Set(lockedKeys);
      for (const key of releasing) preparingDraftsRef.current.delete(key);
      lockedKeys.clear();
      setPreparingDraftKeys(keys => keys.filter(key => !releasing.has(key)));
    };
    const ownsDraft = () => sessionLoadRef.current === generation && composerDraftKeyRef.current === ownerKey;
    const unchanged = () => composerDraftMatches(readComposerDraft(composerDraftsRef.current, ownerKey), original);
    const canContinue = () => {
      if (!ownsDraft()) return false;
      if (!unchanged()) {
        showComposerFeedback('准备消息期间草稿已更新，最新内容已保留，请重新发送。');
        return false;
      }
      if (sendBlockedRef.current) {
        showComposerFeedback('会话状态已变化，草稿已保留，请稍后重新发送。');
        return false;
      }
      return true;
    };
    const consumeCommand = () => {
      if (!ownsDraft() || !unchanged()) return;
      clearActiveComposerDraftText();
      setComposerMenu(null);
    };
    lock(sourceDraftKey);
    try {
      if (!turnActiveRef.current && original.attachments.length === 0 && text === '/todos') {
        setTodoPanelOpen(true);
        consumeCommand();
        return;
      }
      if (busyBehavior !== 'queue' && original.attachments.length === 0 && text.startsWith('/')) {
        const extensionCommand = await commandHandlersRef.current.findExtensionCommand(text);
        if (!canContinue()) return;
        if (extensionCommand) {
          setComposerMenu(null);
          release();
          if (await commandHandlersRef.current.executeExtensionCommand(extensionCommand.commandId, extensionCommand.argument)) consumeCommand();
          return;
        }
        if (await commandHandlersRef.current.executeBuiltinCommand(text)) {
          if (parseStudioCommand(text)?.route !== 'session.new') consumeCommand();
          return;
        }
        if (!canContinue()) return;
      }
      setComposerMenu(null);
      if (!workspace) {
        setError('请先选择一个工作区，再发送消息。');
        return;
      }
      if (!modelSelection.modelRef || modelSelection.unavailable) {
        setError(modelSelection.unavailableReason || (session
          ? '这个会话的模型不可用，请先选择新的模型。'
          : '还没有可用模型，请先配置模型来源并选择模型。你的草稿已保留。'));
        if (!isNewConversation) {
          setModelPickerRequest({ id: ++modelPickerRequestRef.current, view: 'models' });
        }
        return;
      }
      setError(null);
      let current = sessionRef.current;
      if (!current) {
        let created;
        try { created = await window.piApi.createConversation({ cwd: workspace }); }
        catch (error) { if (ownsDraft()) setError(errorText(error)); return; }
        if (!ownsDraft()) return;
        current = { id: created.id, cwd: created.cwd, title: created.title, longTask: created.longTask } as SessionState;
        const nextDraftKey = composerDraftKeyForSession(current!.id);
        const latestDraft = readComposerDraft(composerDraftsRef.current, sourceDraftKey);
        moveComposerDraft(composerDraftsRef.current, sourceDraftKey, nextDraftKey, latestDraft);
        ownerKey = nextDraftKey;
        lock(nextDraftKey);
        composerDraftKeyRef.current = nextDraftKey;
        sessionRef.current = current;
        setSession(current);
        setPrompt(latestDraft.text);
        setComposerAttachments(latestDraft.attachments);
        setMessages([]);
        setRequestTraces([]);
        createdSession = true;
        if (!canContinue()) return;
      }
      const savedRetry = composerDeliveryRetriesRef.current.get(ownerKey);
      const retryRequestId = retainedComposerRequestId(savedRetry, original);
      if (savedRetry && !retryRequestId) composerDeliveryRetriesRef.current.delete(ownerKey);
      let prepared: PreparedSubmission;
      try { prepared = await prepareSubmission(text, original.attachments, current!.id, retryRequestId); }
      catch (error) {
        if (ownsDraft()) showComposerFeedback(errorText(error));
        return;
      }
      if (!canContinue()) return;
      clearActiveComposerDraft();
      const editContext = queuedEditContextsRef.current[current!.id];
      const queuedItem: QueuedPrompt = {
        id: editContext?.id ?? crypto.randomUUID(), order: 1,
        text, attachments: original.attachments, submission: prepared,
      };
      const running = turnActiveRef.current;
      if (running && busyBehavior === 'queue') {
        updateSessionQueuedPrompts(current!.id, items => {
          const remaining = items.filter(item => item.id !== queuedItem.id);
          const insertAt = editContext ? Math.min(Math.max(editContext.index, 0), remaining.length) : remaining.length;
          const next = [...remaining];
          next.splice(insertAt, 0, queuedItem);
          return next.map((item, index) => ({ ...item, order: index + 1 }));
        });
        composerDeliveryRetriesRef.current.delete(ownerKey);
        delete queuedEditContextsRef.current[current!.id];
        return;
      }
      delete queuedEditContextsRef.current[current!.id];
      latestComposerAttemptByKeyRef.current.set(ownerKey, prepared.requestId);
      release();
      const delivery = await dispatchSubmission(prepared, running ? 'steer' : 'prompt');
      const latestAttempt = latestComposerAttemptByKeyRef.current.get(ownerKey)
        === prepared.requestId;
      if (delivery.state === 'rejected' && latestAttempt) {
        composerDeliveryRetriesRef.current.set(ownerKey, {
          draft: snapshotComposerDraft(original),
          requestId: prepared.requestId,
        });
        const currentDraft = readComposerDraft(composerDraftsRef.current, ownerKey);
        const recoveredDraft = mergeRejectedComposerDraft(currentDraft, original);
        saveComposerDraft(composerDraftsRef.current, ownerKey, recoveredDraft);
        const visibleDraft = composerDraftKeyRef.current === ownerKey;
        if (visibleDraft) {
          setPrompt(recoveredDraft.text);
          setComposerAttachments(recoveredDraft.attachments);
          showComposerFeedback(
            currentDraft.text || currentDraft.attachments.length
              ? '消息未发送，原草稿已恢复，等待期间的新输入也已保留。'
              : '消息未发送，原草稿已恢复。',
          );
        } else {
          pushNotification(
            `消息未发送：${delivery.error}。原草稿已保存在该会话。`,
            'error',
            '消息未发送',
            prepared.sessionId,
          );
        }
      } else if (latestAttempt) {
        composerDeliveryRetriesRef.current.delete(ownerKey);
      }
      if (latestAttempt) latestComposerAttemptByKeyRef.current.delete(ownerKey);
      if (createdSession) {
        createdSession = false;
        void loadState().catch(() => {});
      }
    } finally {
      release();
      if (createdSession && ownsDraft()) void loadState().catch(() => {});
    }
  }

  async function sendQueuedNow(id: string) {
    const sessionId = sessionRef.current?.id;
    if (!sessionId || sendBlockedRef.current || queuedDrainSessionsRef.current.has(sessionId)) return;
    const item = queuedPromptsRef.current[sessionId]?.find((candidate) => candidate.id === id);
    if (!item) return;
    const requestId = item.submission.requestId;
    const mode = turnActiveRef.current ? 'steer' : 'prompt';
    queuedDrainSessionsRef.current.add(sessionId);
    markQueueAdmissionPending(sessionId, requestId);
    try {
      const outcome = await dispatchSubmission(item.submission, mode);
      if (outcome.state === 'rejected') {
        updateSessionQueuedPrompts(sessionId, items => (
          markRejectedQueuedSubmission(items, id, requestId, outcome.error)
        ));
        if (!outcome.current) {
          pushNotification(
            `排队消息未能发送：${outcome.error}`,
            'error',
            '排队发送失败',
            sessionId,
          );
        }
        return;
      }
      updateSessionQueuedPrompts(sessionId, items => (
        removeAdmittedQueuedSubmission(items, id, requestId)
      ));
    } catch (error) {
      const message = errorText(error);
      updateSessionQueuedPrompts(sessionId, items => (
        markRejectedQueuedSubmission(items, id, requestId, message)
      ));
      pushNotification(
        `排队消息未能发送：${message}`,
        'error',
        '排队发送失败',
        sessionId,
      );
    } finally {
      clearQueueAdmissionPending(sessionId, requestId);
      queuedDrainSessionsRef.current.delete(sessionId);
    }
  }

  async function sendAllQueued() {
    const sessionId = sessionRef.current?.id;
    if (!sessionId || sendBlockedRef.current || queuedDrainSessionsRef.current.has(sessionId)) return;
    const initiallyActive = turnActiveRef.current;
    const initialRequests = new Set(
      (queuedPromptsRef.current[sessionId] ?? []).map(item => item.submission.requestId),
    );
    if (initialRequests.size === 0) return;
    const handledRequests = new Set<string>();
    let admittedCount = 0;
    let activeItem: QueuedPrompt | undefined;
    queuedDrainSessionsRef.current.add(sessionId);
    try {
      while (initialRequests.size > handledRequests.size) {
        if (sessionRef.current?.id !== sessionId || sendBlockedRef.current) break;
        const item = (queuedPromptsRef.current[sessionId] ?? [])
          .find(candidate => !handledRequests.has(candidate.submission.requestId));
        if (!item || !initialRequests.has(item.submission.requestId)) break;
        const requestId = item.submission.requestId;
        activeItem = item;
        handledRequests.add(requestId);
        const mode = initiallyActive || admittedCount > 0 ? 'steer' : 'prompt';
        markQueueAdmissionPending(sessionId, requestId);
        let outcome: DispatchOutcome;
        try {
          outcome = await dispatchSubmission(item.submission, mode);
        } finally {
          clearQueueAdmissionPending(sessionId, requestId);
        }
        if (outcome.state === 'rejected') {
          updateSessionQueuedPrompts(sessionId, items => (
            markRejectedQueuedSubmission(items, item.id, requestId, outcome.error)
          ));
          if (!outcome.current) {
            pushNotification(
              `排队消息未能发送：${outcome.error}`,
              'error',
              '排队发送失败',
              sessionId,
            );
          }
          break;
        }
        admittedCount += 1;
        updateSessionQueuedPrompts(sessionId, items => (
          removeAdmittedQueuedSubmission(items, item.id, requestId)
        ));
        activeItem = undefined;
      }
    } catch (error) {
      const message = errorText(error);
      if (activeItem) {
        updateSessionQueuedPrompts(sessionId, items => (
          markRejectedQueuedSubmission(
            items,
            activeItem!.id,
            activeItem!.submission.requestId,
            message,
          )
        ));
      }
      pushNotification(
        `排队消息未能发送：${message}`,
        'error',
        '排队发送失败',
        sessionId,
      );
    } finally {
      queuedDrainSessionsRef.current.delete(sessionId);
    }
  }

  async function executeLongTaskAction(
    action:
      | 'long-task-set'
      | 'long-task-edit'
      | 'long-task-complete'
      | 'long-task-clear'
      | 'long-task-pause'
      | 'long-task-resume',
    payload: { goal?: string; completionCriteria?: string; summary?: string } = {},
  ) {
    const currentSession = sessionRef.current;
    if (!currentSession?.id || longTaskBusy) return;
    const sessionId = currentSession.id;
    setLongTaskBusy(true);
    try {
      const result = await window.piApi.conversationAction({
        kind: 'session',
        id: sessionId,
        action,
        ...payload,
      });
      if (sessionRef.current?.id !== sessionId) return;
      setComposerFeedback(null);
      if ('longTask' in result && result.longTask) {
        setSession((current) => current?.id === sessionId
          ? { ...current, longTask: result.longTask }
          : current);
      }
      const started = 'started' in result && result.started;
      if (started) {
        setBusy(true);
        setError(null);
      } else if (action === 'long-task-pause'
        || action === 'long-task-complete'
        || action === 'long-task-clear') {
        setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
        setBusy(false);
        setError(null);
        requestRef.current = '';
      }
      await loadState();
      void refreshSubagentChildren(false).catch(() => {});
    } catch (error) {
      if (sessionRef.current?.id === sessionId) setError(errorText(error));
    } finally {
      setLongTaskBusy(false);
    }
  }

  async function changeLongTaskStatus(action: 'long-task-pause' | 'long-task-resume') {
    await executeLongTaskAction(action);
  }

  async function stopGeneration() {
    const currentSession = sessionRef.current;
    if (!currentSession?.id || stopping || !turnActive) return;
    const sessionId = currentSession.id;
    setStoppingSessionIds((ids) => ids.includes(sessionId) ? ids : [...ids, sessionId]);
    try {
      await window.piApi.conversationInterrupt(sessionId);
      if (sessionRef.current?.id !== sessionId) return;
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setBusy(false);
      setCompaction({ active: false });
      setRetryInfo(null);
      setError(null);
      requestRef.current = '';
      await Promise.all([
        loadState().catch(() => {}),
        refreshSubagentChildren(false).catch(() => {}),
        window.piApi.conversationSnapshot(sessionId).then((snapshot) => {
          const longTask = snapshot?.longTask;
          if (sessionRef.current?.id === sessionId && longTask) {
            setSession((current) => current?.id === sessionId
              ? { ...current, longTask }
              : current);
          }
        }).catch(() => {}),
      ]);
    } catch (cause) {
      if (sessionRef.current?.id === sessionId) setError(errorText(cause));
    } finally {
      setStoppingSessionIds((ids) => ids.filter((id) => id !== sessionId));
    }
  }

  function editQueued(id: string) {
    const sessionId = sessionRef.current?.id;
    if (!sessionId) return;
    if (prompt.trim() || composerAttachments.length) {
      showComposerFeedback('输入框中还有未发送内容，请先发送或清空，再编辑排队消息。', 'info');
      return;
    }
    const index = queuedPrompts.findIndex((candidate) => candidate.id === id);
    const item = queuedPrompts[index];
    if (!item) return;
    if (isQueueAdmissionPending(sessionId, item.submission.requestId)) return;
    queuedEditContextsRef.current[sessionId] = { id, index };
    updateSessionQueuedPrompts(sessionId, (items) => items.filter((candidate) => candidate.id !== id));
    saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
      text: item.text,
      attachments: item.attachments,
    });
    setPrompt(item.text);
    setComposerAttachments(item.attachments);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function deleteQueued(id: string) {
    const sessionId = sessionRef.current?.id;
    if (!sessionId) return;
    const item = queuedPromptsRef.current[sessionId]?.find(candidate => candidate.id === id);
    if (!item || isQueueAdmissionPending(sessionId, item.submission.requestId)) return;
    updateSessionQueuedPrompts(sessionId, (items) => items.filter((candidate) => candidate.id !== id));
  }

  function reorderQueued(fromId: string, toId: string) {
    const sessionId = sessionRef.current?.id;
    if (!sessionId) return;
    const current = queuedPromptsRef.current[sessionId] ?? [];
    const fromItem = current.find(item => item.id === fromId);
    const toItem = current.find(item => item.id === toId);
    if (
      !fromItem
      || !toItem
      || isQueueAdmissionPending(sessionId, fromItem.submission.requestId)
      || isQueueAdmissionPending(sessionId, toItem.submission.requestId)
    ) return;
    updateSessionQueuedPrompts(sessionId, (items) => {
      const from = items.findIndex((item) => item.id === fromId);
      const to = items.findIndex((item) => item.id === toId);
      if (from < 0 || to < 0 || from === to) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next.map((item, index) => ({ ...item, order: index + 1 }));
    });
  }

  /** Consume one idle queue head; admission is the only successful cleanup. */
  async function drainQueuedSession(
    sessionId: string,
    next: QueuedPrompt,
    sameActiveSession: boolean,
  ) {
    if (next.autoRetryError || queuedDrainSessionsRef.current.has(sessionId)) return;
    queuedDrainSessionsRef.current.add(sessionId);
    markQueueAdmissionPending(sessionId, next.submission.requestId);
    try {
      const outcome = sameActiveSession
        ? await dispatchSubmission(next.submission, 'prompt')
        : await submitQueuedInBackground(next.submission);
      if (outcome.state === 'rejected') {
        updateSessionQueuedPrompts(sessionId, (current) => (
          markRejectedQueuedSubmission(
            current,
            next.id,
            next.submission.requestId,
            outcome.error,
          )
        ));
        if (sameActiveSession && !outcome.current) {
          pushNotification(
            `排队消息未能发送：${outcome.error}`,
            'error',
            '排队发送失败',
            sessionId,
          );
        }
        return;
      }
      updateSessionQueuedPrompts(sessionId, (current) => (
        removeAdmittedQueuedSubmission(
          current,
          next.id,
          next.submission.requestId,
        )
      ));
    } catch (error) {
      const message = errorText(error);
      updateSessionQueuedPrompts(sessionId, (current) => (
        markRejectedQueuedSubmission(
          current,
          next.id,
          next.submission.requestId,
          message,
        )
      ));
      pushNotification(
        `排队消息未能发送：${message}`,
        'error',
        '排队发送失败',
        sessionId,
      );
    } finally {
      clearQueueAdmissionPending(sessionId, next.submission.requestId);
      queuedDrainSessionsRef.current.delete(sessionId);
    }
  }

  useEffect(() => {
    for (const [sessionId, items] of Object.entries(queuedPromptsBySession)) {
      if (items.length === 0 || queuedDrainSessionsRef.current.has(sessionId)) continue;
      const sameActiveSession = session?.id === sessionId;
      const summary = workspaces
        .flatMap((item) => item.sessions)
        .find((item) => item.id === sessionId);
      const running = sameActiveSession ? turnActive : Boolean(summary?.running);
      if (running || (sameActiveSession && sendBlockedRef.current) || (!sameActiveSession && !summary)) continue;
      const next = items[0];
      if (next.autoRetryError) continue;
      void drainQueuedSession(sessionId, next, sameActiveSession);
    }
  }, [
    queuedPromptsBySession,
    session?.id,
    turnActive,
    workspaces,
    compaction.active,
    sessionLoading,
    stateLoading,
    stopping,
  ]);

  return {
    currentComposerDraft,
    checkpointComposerDraft,
    installComposerDraft,
    clearActiveComposerDraftText,
    clearActiveComposerDraft,
    attachPastedText,
    addComposerFiles,
    pickComposerAttachments,
    removeComposerAttachment,
    updateSessionQueuedPrompts,
    clearSessionQueuedPrompts,
    prepareSubmission,
    dispatchSubmission,
    handleEditMessage,
    send,
    sendQueuedNow,
    sendAllQueued,
    executeLongTaskAction,
    changeLongTaskStatus,
    stopGeneration,
    editQueued,
    deleteQueued,
    reorderQueued,
    drainQueuedSession,
  };
}
