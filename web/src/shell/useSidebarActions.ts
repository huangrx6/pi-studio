import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ActionConfirmOptions } from '../shared/ConfirmDialog';
import type { AppNotificationAction, NotificationTone } from './NotificationCenter';
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
  conversationNavigationRef: MutableRefObject<{
    open: (item: PiSessionSummary) => Promise<boolean>;
    start: (cwd: string) => Promise<void>;
  }>;
  actionConfirmation: { confirm: (options: ActionConfirmOptions) => Promise<boolean> };
  pushNotification: (
    message: string,
    tone?: NotificationTone,
    title?: string,
    sessionId?: string,
    action?: AppNotificationAction,
  ) => void;
};

export function useSidebarActions({
  workspaces,
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
  conversationNavigationRef,
  actionConfirmation,
  pushNotification,
}: SidebarActionsDependencies) {
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
    action: SidebarAction,
    name?: string,
    options: { preserveCurrentView?: boolean; notify?: boolean } = {},
  ) {
    if (sidebarMutationRef.current) throw new Error('会话操作正在完成，请稍后再试。');
    if (conversationListNeedsRefreshRef.current) throw new Error('请先刷新会话列表，再继续操作。');
    sidebarMutationRef.current = true;
    setSidebarMutating(true);
    const generation = sessionLoadRef.current;
    const targetSummary = workspaces.flatMap((item) => item.sessions).find((item) => item.id === id);
    try {
      const result = await window.piApi.conversationAction({ kind, id, action, name });
      conversationListNeedsRefreshRef.current = true;
      ++stateRequestRef.current;
      try {
        if (kind === 'session' && (action === 'archive' || action === 'remove')) {
          clearSessionQueuedPrompts(id);
          delete queuedEditContextsRef.current[id];
        }
        if (kind === 'workspace' && action === 'remove') {
          const removedWorkspace = workspaces.find((item) => item.cwd === id);
          for (const item of removedWorkspace?.sessions ?? []) {
            clearSessionQueuedPrompts(item.id);
            delete queuedEditContextsRef.current[item.id];
          }
        }
        const current = sessionRef.current;
        if (generation === sessionLoadRef.current && kind === 'workspace' && action === 'remove' && workspaceRef.current === id) await conversationNavigationRef.current.start('');
        if (!options.preserveCurrentView && generation === sessionLoadRef.current && kind === 'session' && action === 'archive' && current?.id === id && !targetSummary?.archived) await conversationNavigationRef.current.start(current.cwd);
        if (generation === sessionLoadRef.current && kind === 'session' && action === 'remove' && current?.id === id) await conversationNavigationRef.current.start(current.cwd);
        if (kind === 'session' && action === 'remove') {
          clearComposerDraft(composerDraftsRef.current, composerDraftKeyForSession(id));
        }
        if (kind === 'workspace' && action === 'remove') {
          const removedWorkspace = workspaces.find((item) => item.cwd === id);
          for (const item of removedWorkspace?.sessions ?? []) {
            clearComposerDraft(composerDraftsRef.current, composerDraftKeyForSession(item.id));
          }
          clearComposerDraft(composerDraftsRef.current, composerDraftKeyForNew(id));
        }
        if (kind === 'session' && action === 'rename' && current?.id === id) {
          setSession(value => value ? { ...value, title: name!.trim() } : value);
        }
      } catch {
        pushNotification('操作已完成，但当前视图未能切换。请从会话列表选择会话。', 'warning', '会话视图待更新');
      }
      try { await loadStateRef.current(); }
      catch { setConversationListRefreshError(true); }
      if (kind === 'session'
        && action === 'archive'
        && options.notify !== false
        && targetSummary
        && !targetSummary.archived) {
        const title = targetSummary.title || '当前会话';
        pushNotification(
          `「${title}」已移到归档。`,
          'success',
          '会话已归档',
          id,
          {
            kind: 'unarchive-session',
            label: '撤销归档',
            pendingLabel: '正在恢复…',
            sessionId: id,
            hideSessionLink: true,
          },
        );
      } else if (kind === 'workspace' && action === 'remove') {
        const sessions = 'deletedSessions' in result ? Number(result.deletedSessions) || 0 : 0;
        const subagents = 'deletedSubagents' in result ? Number(result.deletedSubagents) || 0 : 0;
        pushNotification(
          `已永久删除 ${sessions} 个会话${subagents ? `和 ${subagents} 个关联子智能体` : ''}。磁盘中的项目文件夹仍保留。`,
          'success',
          '工作区已从 Studio 删除',
        );
      } else if (kind === 'session' && action === 'remove') {
        const subagents = 'deletedSubagents' in result ? Number(result.deletedSubagents) || 0 : 0;
        pushNotification(
          `会话数据已清理${subagents ? `，同时删除了 ${subagents} 个关联子智能体` : ''}。`,
          'success',
          '会话已永久删除',
        );
      }
      if (action === 'fork' && 'id' in result && result.id) {
        if (generation !== sessionLoadRef.current) {
          pushNotification('分叉已创建，可从会话列表打开。', 'success', '会话分叉已创建', result.id);
          return;
        }
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
    pushNotification(`「${item.title}」已恢复到对应工作区。`, 'success', '会话已恢复');
  }

  async function permanentlyDeleteArchivedConversation(item: ConversationSummary) {
    const accepted = await actionConfirmation.confirm({
      title: '永久删除这个归档会话？',
      description: `「${item.title}」及其全部消息、任务、附件、关联子智能体和 Studio 设置都会被删除，无法恢复。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (accepted) await sidebarAction('session', item.id, 'remove');
  }

  return {
    refreshConversationList,
    sidebarAction,
    restoreArchivedConversation,
    permanentlyDeleteArchivedConversation,
  };
}
