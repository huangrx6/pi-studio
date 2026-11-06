import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentView } from '../../shell/app-types';
import type { NotificationTone } from '../../shell/NotificationCenter';
import type {
  SubagentBudgetSnapshot,
  SubagentChild,
  SubagentTranscript,
} from '../../types/subagent-types';
import { errorText } from '../../shared/error-text';
import { mergeSubagentChild, mergeSubagentChildren } from './subagent-state.mjs';
import type { SubagentOverviewMode } from './SubagentViews';
import type { SessionStateForPersistence } from '../conversation/useMessageDelivery';

type Setter<T> = Dispatch<SetStateAction<T>>;

type SubagentWorkspaceDependencies = {
  session: SessionStateForPersistence;
  sessionRef: MutableRefObject<SessionStateForPersistence>;
  agentView: AgentView;
  setAgentView: Setter<AgentView>;
  turnActive: boolean;
  actionConfirmation: {
    confirm: (options: {
      title: string;
      description: string;
      confirmLabel: string;
      tone: 'danger';
    }) => Promise<boolean>;
  };
  pushNotification: (
    message: string,
    tone?: NotificationTone,
    title?: string,
    sessionId?: string,
  ) => void;
  loadState: () => Promise<void>;
  rememberMainScrollPosition: () => void;
};

export function useSubagentWorkspace({
  session,
  sessionRef,
  agentView,
  setAgentView,
  turnActive,
  actionConfirmation,
  pushNotification,
  loadState,
  rememberMainScrollPosition,
}: SubagentWorkspaceDependencies) {
  const [subagentChildren, setSubagentChildren] = useState<SubagentChild[]>([]);
  const [subagentBudget, setSubagentBudget] = useState<SubagentBudgetSnapshot | null>(null);
  const [subagentTranscript, setSubagentTranscript] = useState<SubagentTranscript | null>(null);
  const [subagentOverviewMode, setSubagentOverviewMode] = useState<SubagentOverviewMode>('list');
  const [subagentLoading, setSubagentLoading] = useState(false);
  const [subagentRefreshing, setSubagentRefreshing] = useState(false);
  const [subagentError, setSubagentError] = useState<string | null>(null);
  const [subagentDeletingKey, setSubagentDeletingKey] = useState<string | null>(null);
  const [subagentReplyingKey, setSubagentReplyingKey] = useState<string | null>(null);
  const subagentRequestRef = useRef(0);
  const subagentListRequestRef = useRef(0);

  useEffect(() => {
    ++subagentRequestRef.current;
    setAgentView({ kind: 'conversation' });
    // openSession owns child-session hydration; clearing here would erase the
    // children that were loaded in the same session transition.
  }, [session?.id, setAgentView]);

  async function refreshSubagentChildren(showSpinner = false): Promise<void> {
    const currentSession = sessionRef.current;
    if (!currentSession?.id) return;
    const sessionId = currentSession.id;
    const request = ++subagentListRequestRef.current;
    if (showSpinner) setSubagentRefreshing(true);
    try {
      const [children, budget] = await Promise.all([
        window.piApi.sessionSubagents(sessionId),
        window.piApi.subagentBudget({
          id: sessionId,
          cwd: currentSession.cwd,
        }).catch(() => null),
      ]);
      if (
        request !== subagentListRequestRef.current
        || sessionRef.current?.id !== sessionId
      ) return;
      setSubagentChildren((current) => mergeSubagentChildren(current, Array.isArray(children) ? children : []));
      setSubagentBudget(budget);
    } catch (error) {
      // Automatic refresh is best effort and must not cover the active transcript
      // with a transport error while a Durable run is still settling, but a
      // failure must stay diagnosable instead of silently emptying the list.
      console.warn('Unable to load subagent children:', error);
    } finally {
      if (showSpinner && request === subagentListRequestRef.current) setSubagentRefreshing(false);
    }
  }

  function openAgentOverview() {
    if (!session?.id) return;
    rememberMainScrollPosition();
    setAgentView({ kind: 'agents' });
    void refreshSubagentChildren(true);
  }

  function openAgentTranscript(child: SubagentChild) {
    if (!session?.id || !child.hasTranscript) {
      setSubagentError('这个子智能体没有可安全读取的本地会话。');
      return;
    }
    rememberMainScrollPosition();
    const request = ++subagentRequestRef.current;
    const sessionId = session.id;
    setAgentView({ kind: 'agents', child });
    setSubagentTranscript(null);
    setSubagentError(null);
    setSubagentLoading(true);
    void window.piApi.subagentTranscript({ sessionId, childKey: child.key })
      .then((transcript) => {
        if (request !== subagentRequestRef.current || sessionRef.current?.id !== sessionId) return;
        setSubagentTranscript((current) => current
          ? { ...transcript, child: mergeSubagentChild(current.child, transcript.child) }
          : transcript);
        setAgentView((current) => current.kind === 'agents' && current.child?.key === child.key
          ? { kind: 'agents', child: mergeSubagentChild(current.child, transcript.child) }
          : current);
      })
      .catch((cause) => {
        if (request === subagentRequestRef.current && sessionRef.current?.id === sessionId) {
          setSubagentError(errorText(cause));
        }
      })
      .finally(() => {
        if (request === subagentRequestRef.current && sessionRef.current?.id === sessionId) setSubagentLoading(false);
      });
  }

  const activeChild = agentView.kind === 'agents' ? agentView.child : undefined;

  useEffect(() => {
    if (!activeChild || !session?.id || subagentLoading) return;
    if (!['pending', 'running', 'waiting', 'paused'].includes(activeChild.status)) return;
    let disposed = false;
    let fetching = false;
    const sessionId = session.id;
    const childKey = activeChild.key;
    const timer = window.setInterval(() => {
      if (fetching) return;
      fetching = true;
      void window.piApi.subagentTranscript({ sessionId, childKey })
        .then((transcript) => {
          if (disposed || sessionRef.current?.id !== sessionId) return;
          setSubagentTranscript((current) => current
            ? { ...transcript, child: mergeSubagentChild(current.child, transcript.child) }
            : transcript);
          setSubagentError(null);
          setAgentView((current) => current.kind === 'agents' && current.child?.key === childKey
            ? { kind: 'agents', child: transcript.child }
            : current);
        })
        .catch((cause) => {
          if (!disposed) setSubagentError(errorText(cause));
        })
        .finally(() => { fetching = false; });
    }, 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    agentView.kind,
    activeChild?.key,
    activeChild?.status,
    session?.id,
    subagentLoading,
    setAgentView,
  ]);

  const hasActiveSubagents = subagentChildren.some((child) => (
    child.status === 'running' || child.status === 'pending' || child.status === 'waiting'
  ));

  useEffect(() => {
    if (!session?.id) return;
    const shouldPoll = turnActive || hasActiveSubagents || agentView.kind === 'agents';
    if (!shouldPoll) return;
    let disposed = false;
    let fetching = false;
    const delay = turnActive || hasActiveSubagents ? 1_800 : 6_000;
    const tick = () => {
      if (disposed || fetching) return;
      fetching = true;
      void refreshSubagentChildren(false).finally(() => { fetching = false; });
    };
    const timer = window.setInterval(tick, delay);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [agentView.kind, hasActiveSubagents, session?.id, turnActive]);

  async function deleteSubagent(child: SubagentChild) {
    const sessionId = session?.id;
    if (!sessionId || subagentDeletingKey) return;
    const active = ['pending', 'running', 'waiting', 'paused'].includes(child.status);
    const accepted = await actionConfirmation.confirm({
      title: '永久删除这个子智能体？',
      description: `${active ? '它会先被停止。' : ''}它的独立会话、消息、工具记录、任务和附件都会从 Pi Studio 删除，无法恢复。父会话和其他子智能体不受影响。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (!accepted) return;
    setSubagentDeletingKey(child.key);
    setSubagentError(null);
    try {
      const result = await window.piApi.deleteSubagent({
        sessionId,
        childKey: child.key,
      });
      setSubagentChildren((current) => current.filter((item) => item.key !== child.key));
      setSubagentTranscript((current) => current?.child.key === child.key ? null : current);
      setAgentView((current) => (
        current.kind === 'agents' && current.child?.key === child.key
          ? { kind: 'agents' }
          : current
      ));
      pushNotification(`${result.name || child.name || '子智能体'} 已永久删除`, 'success');
      await loadState();
    } catch (error) {
      const message = errorText(error);
      setSubagentError(message);
      pushNotification(message, 'error', '删除子智能体失败');
    } finally {
      setSubagentDeletingKey(null);
    }
  }

  async function replySubagentSupervisor(child: SubagentChild, requestId: string, message: string) {
    const sessionId = session?.id;
    if (!sessionId || subagentReplyingKey) return;
    setSubagentReplyingKey(child.key);
    setSubagentError(null);
    try {
      await window.piApi.replySubagentSupervisor({
        sessionId,
        childKey: child.key,
        requestId,
        message,
      });
      pushNotification(`已回复 ${child.name || child.agent}`, 'success');
      await refreshSubagentChildren(true);
    } catch (error) {
      const messageText = errorText(error);
      setSubagentError(messageText);
      pushNotification(messageText, 'error', '回复子智能体失败');
      throw error;
    } finally {
      setSubagentReplyingKey(null);
    }
  }

  return {
    subagentChildren,
    setSubagentChildren,
    subagentBudget,
    setSubagentBudget,
    subagentTranscript,
    setSubagentTranscript,
    subagentOverviewMode,
    setSubagentOverviewMode,
    subagentLoading,
    setSubagentLoading,
    subagentRefreshing,
    subagentError,
    setSubagentError,
    subagentDeletingKey,
    subagentReplyingKey,
    subagentRequestRef,
    refreshSubagentChildren,
    openAgentOverview,
    openAgentTranscript,
    deleteSubagent,
    replySubagentSupervisor,
    hasActiveSubagents,
  };
}
