import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ActionConfirmOptions } from '../shared/ConfirmDialog';
import { useSettingsToast } from '../shared/SettingsToast';
import type { SidebarAction } from './SidebarActions';
import type { PiSessionSummary, PiWorkspace } from './app-types';
import type { ConversationSummary } from '../types/durable-types';
import type { LongTaskState } from '../types/durable-types';
import type { TurnDiff } from '../types/chat-types';
import {
  clearComposerDraft,
  composerDraftKeyForNew,
  composerDraftKeyForSession,
  type ComposerDraft,
} from '../features/conversation/composer-drafts';
import type { QueuedEditContext } from '../features/conversation/composer-types';

type Setter<T> = Dispatch<SetStateAction<T>>;
type SessionSummary = {
  id: string;
  cwd: string;
  title: string;
  longTask?: LongTaskState;
  turnDiffs?: TurnDiff[];
  totalMessages?: number;
} | null;

type SidebarActionsDependencies = {
  workspaces: PiWorkspace[];
  removeWorkspaceFromList: (cwd: string) => void;
  sessionRef: MutableRefObject<SessionSummary>;
  sessionLoadRef: MutableRefObject<number>;
  workspaceRef: MutableRefObject<string>;
  stateRequestRef: MutableRefObject<number>;
  sidebarMutationRef: MutableRefObject<boolean>;
  setSidebarMutating: Setter<boolean>;
  conversationListNeedsRefreshRef: MutableRefObject<boolean>;
  conversationListRetryRef: MutableRefObject<boolean>;
  setConversationListRefreshError: Setter<boolean>;
  loadStateRef: MutableRefObject<() => Promise<void>>;
  setSession: Setter<{
    id: string;
    cwd: string;
    title: string;
    [key: string]: unknown;
  } | null>;
  clearSessionQueuedPrompts: (sessionId: string) => void;
  queuedEditContextsRef: MutableRefObject<Record<string, QueuedEditContext>>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  persistDeletedComposerSessions: (ids: string[]) => Promise<void>;
  conversationNavigationRef: MutableRefObject<{
    open: (item: PiSessionSummary) => Promise<boolean>;
    start: (cwd: string) => Promise<void>;
  }>;
  actionConfirmation: { confirm: (options: ActionConfirmOptions) => Promise<boolean> };
};

export function useSidebarActions({
  workspaces,
  removeWorkspaceFromList,
  sessionRef,
  sessionLoadRef,
  workspaceRef,
  stateRequestRef,
  sidebarMutationRef,
  setSidebarMutating,
  conversationListNeedsRefreshRef,
  conversationListRetryRef,
  setConversationListRefreshError,
  loadStateRef,
  setSession,
  clearSessionQueuedPrompts,
  queuedEditContextsRef,
  composerDraftsRef,
  persistDeletedComposerSessions,
  conversationNavigationRef,
  actionConfirmation,
}: SidebarActionsDependencies) {
  const showToast = useSettingsToast();
  async function refreshConversationList() {
    if (conversationListRetryRef.current) return;
    conversationListRetryRef.current = true;
    try { await loadStateRef.current(); }
    catch { setConversationListRefreshError(true); }
    finally { conversationListRetryRef.current = false; }
  }

  async function sidebarAction(
    kind: 'workspace' | 'session',
    id: string,
    action: SidebarAction | 'remove-archived',
    name?: string,
    options: { preserveCurrentView?: boolean; showDeleteToast?: boolean; sessionIds?: string[] } = {},
  ) {
    if (sidebarMutationRef.current) throw new Error('会话操作正在完成，请稍后再试。');
    if (conversationListNeedsRefreshRef.current) throw new Error('请先刷新会话列表，再继续操作。');
    sidebarMutationRef.current = true;
    setSidebarMutating(true);
    const generation = sessionLoadRef.current;
    const targetSummary = workspaces.flatMap((item) => item.sessions).find((item) => item.id === id);
    try {
      const result = await window.piApi.conversationAction({ kind, id, action, name, ...(options.sessionIds && { sessionIds: options.sessionIds }) });
      conversationListNeedsRefreshRef.current = true;
      ++stateRequestRef.current;
      const removingWorkspace = kind === 'workspace' && action === 'remove';
      const removedWorkspace = removingWorkspace ? workspaces.find((item) => item.cwd === id) : undefined;
      const deletedIds = action === 'remove' || action === 'remove-archived'
        ? ('deletedSessionIds' in result && result.deletedSessionIds) || (
          removingWorkspace ? (removedWorkspace?.sessions ?? []).map(item => item.id)
            : action === 'remove-archived' ? options.sessionIds ?? [] : [id]
        )
        : [];
      if (removingWorkspace) removeWorkspaceFromList(id);
      if (kind === 'session' && action === 'archive') {
        clearSessionQueuedPrompts(id);
        delete queuedEditContextsRef.current[id];
      }
      for (const deletedId of deletedIds) {
        clearSessionQueuedPrompts(deletedId);
        delete queuedEditContextsRef.current[deletedId];
      }
      try {
        const current = sessionRef.current;
        if (action === 'remove-archived' && current && options.sessionIds?.includes(current.id) && generation === sessionLoadRef.current) {
          await conversationNavigationRef.current.start(current.cwd);
        }
        if (generation === sessionLoadRef.current && removingWorkspace && workspaceRef.current === id) await conversationNavigationRef.current.start('');
        if (!options.preserveCurrentView && generation === sessionLoadRef.current && kind === 'session' && action === 'archive' && current?.id === id && !targetSummary?.archived) await conversationNavigationRef.current.start(current.cwd);
        if (generation === sessionLoadRef.current && kind === 'session' && action === 'remove' && current?.id === id) await conversationNavigationRef.current.start(current.cwd);
        if (kind === 'session' && action === 'rename' && current?.id === id) {
          setSession(value => value ? { ...value, title: name!.trim() } : value);
        }
      } catch {
        // Mutation already succeeded; list refresh below reconciles state.
      }
      for (const deletedId of deletedIds) {
        clearComposerDraft(composerDraftsRef.current, composerDraftKeyForSession(deletedId));
      }
      if (removingWorkspace) clearComposerDraft(composerDraftsRef.current, composerDraftKeyForNew(id));
      if (deletedIds.length || removingWorkspace) await persistDeletedComposerSessions(deletedIds);
      try { await loadStateRef.current(); }
      catch { setConversationListRefreshError(true); }
      if (kind === 'session' && action === 'remove' && options.showDeleteToast) {
        const subagents = 'deletedSubagents' in result ? Number(result.deletedSubagents) || 0 : 0;
        const message = `会话数据已清理${subagents ? `，同时删除了 ${subagents} 个关联子智能体` : ''}。`;
        showToast(message);
      }
      if (action === 'fork' && 'id' in result && result.id) {
        if (generation !== sessionLoadRef.current) return;
        await conversationNavigationRef.current.open({
          ...result,
          updatedAt: result.updatedAt,
          messageCount: result.messageCount ?? 0,
        });
      }
    } finally {
      sidebarMutationRef.current = false;
      setSidebarMutating(false);
    }
  }

  async function restoreArchivedConversation(item: ConversationSummary) {
    await sidebarAction('session', item.id, 'archive', undefined, { preserveCurrentView: true });
    showToast(`「${item.title}」已恢复到对应工作区。`);
  }

  async function permanentlyDeleteArchivedConversation(item: ConversationSummary) {
    const accepted = await actionConfirmation.confirm({
      title: '永久删除这个归档会话？',
      description: `「${item.title}」及其消息、任务、附件、画布、关联子智能体和会话设置都会被删除，无法恢复。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (accepted) await sidebarAction('session', item.id, 'remove', undefined, { showDeleteToast: true });
  }

  async function deleteArchivedGroup(cwd: string, label: string, sessionIds: string[]) {
    const accepted = await actionConfirmation.confirm({
      title: `永久删除这 ${sessionIds.length} 个归档会话？`,
      description: `将删除「${label}」中选定的 ${sessionIds.length} 个归档会话及其消息、任务、附件、画布和关联子智能体。此操作无法撤销。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (!accepted) return;
    await sidebarAction('workspace', cwd, 'remove-archived', undefined, { sessionIds });
    showToast(`「${label}」中的 ${sessionIds.length} 个归档会话已删除。`);
  }

  return {
    refreshConversationList,
    sidebarAction,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
    deleteArchivedGroup,
  };
}
