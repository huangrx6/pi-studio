import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ModelSelection } from '../types/model-types';
import type { SessionStateForPersistence } from '../features/conversation/useMessageDelivery';
import type { PiWorkspace } from './app-types';
import { useSidebarWorkspace } from './useSidebarWorkspace';

type WorkspaceStateOptions = {
  sessionRef: MutableRefObject<SessionStateForPersistence>;
  sessionLoadRef: MutableRefObject<number>;
  modelRevisionRef: MutableRefObject<Map<string, number>>;
  modelWritesRef: MutableRefObject<Set<string>>;
  defaultModelWorkspaceRef: MutableRefObject<string>;
  conversationListNeedsRefreshRef: MutableRefObject<boolean>;
  setConversationListRefreshError: Dispatch<SetStateAction<boolean>>;
  setSession: Dispatch<SetStateAction<SessionStateForPersistence>>;
  setDefaultModelSelection: Dispatch<SetStateAction<ModelSelection>>;
  setModelSelection: Dispatch<SetStateAction<ModelSelection>>;
};

export function useWorkspaceState({
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
}: WorkspaceStateOptions) {
  const [workspaces, setWorkspaces] = useState<PiWorkspace[]>([]);
  const [stateLoading, setStateLoading] = useState(true);
  const [workspace, setWorkspace] = useState('');
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const stateRequestRef = useRef(0);

  const sidebar = useSidebarWorkspace({ workspaces, setWorkspaces, workspace });
  const {
    workspaceOrderRef,
    sessionOrderRef,
    setWorkspaceOrder,
    setSessionOrder,
  } = sidebar;

  function changeWorkspace(cwd: string) {
    if (workspaceRef.current === cwd) return;
    workspaceRef.current = cwd;
    setWorkspace(cwd);
    // A list read belongs to the workspace that started it. Invalidate the old
    // result immediately so an abandoned read cannot leave controls disabled.
    ++stateRequestRef.current;
    setStateLoading(false);
  }

  const loadState = useCallback(async () => {
    const loadGeneration = sessionLoadRef.current;
    const request = ++stateRequestRef.current;
    const revision = modelRevisionRef.current.get(`default:${workspace}`) ?? 0;
    setStateLoading(true);
    // 兜底：任何异常路径（IPC 未返回、主进程忙）都不该让「正在载入」永远挂着。
    const release = setTimeout(() => {
      clearTimeout(release);
      if (request === stateRequestRef.current) setStateLoading(false);
    }, 8000);
    try {
      const next = await window.piApi.state(workspace);
      if (request !== stateRequestRef.current || workspace !== workspaceRef.current) return;
      const savedWorkspaceOrder = workspaceOrderRef.current;
      const savedWorkspaceCwds = new Set(savedWorkspaceOrder);
      const savedSessionOrder = sessionOrderRef.current;
      const byCwd = new Map(next.workspaces.map((item) => [item.cwd, item]));
      const ordered = [
        ...savedWorkspaceOrder.flatMap((cwd) => byCwd.has(cwd) ? [byCwd.get(cwd)!] : []),
        ...next.workspaces.filter((item) => !savedWorkspaceCwds.has(item.cwd)),
      ];
      const nextSessionOrder: Record<string, string[]> = {};
      const orderedSessions = ordered.map((item) => {
        const byId = new Map(item.sessions.map((entry) => [entry.id, entry]));
        const saved = savedSessionOrder[item.cwd] ?? [];
        const savedIds = new Set(saved);
        const sessions = [
          ...saved.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
          ...item.sessions.filter((entry) => !savedIds.has(entry.id)),
        ].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
        nextSessionOrder[item.cwd] = sessions.map((entry) => entry.id);
        return { ...item, sessions };
      });
      workspaceOrderRef.current = ordered.map((item) => item.cwd);
      sessionOrderRef.current = nextSessionOrder;
      setWorkspaceOrder(ordered.map((item) => item.cwd));
      setSessionOrder(nextSessionOrder);
      setWorkspaces(orderedSessions);
      conversationListNeedsRefreshRef.current = false;
      setConversationListRefreshError(false);
      setSession((current) => {
        if (!current) return current;
        const title = orderedSessions
          .flatMap((item) => item.sessions)
          .find((item) => item.id === current.id)?.title;
        return title && title !== current.title ? { ...current, title } : current;
      });
      if (
        revision === (modelRevisionRef.current.get(`default:${workspace}`) ?? 0)
        && !modelWritesRef.current.has(`default:${workspace}`)
      ) {
        defaultModelWorkspaceRef.current = workspace;
        setDefaultModelSelection(next.model);
        if (!sessionRef.current && sessionLoadRef.current === loadGeneration) {
          setModelSelection(next.model);
        }
      }
    } catch (error) {
      if (request === stateRequestRef.current && workspace === workspaceRef.current) {
        if (conversationListNeedsRefreshRef.current) setConversationListRefreshError(true);
        throw error;
      }
    } finally {
      // 只按请求序号判断：最后一次发起的请求完成时一定要把「正在载入」收掉。
      // 之前还要求 workspace 等于闭包里的值，切工作区的竞态下会永远为 false，
      // 新会话页就一直卡在「正在载入…」。
      if (request === stateRequestRef.current) setStateLoading(false);
    }
  }, [
    conversationListNeedsRefreshRef,
    defaultModelWorkspaceRef,
    modelRevisionRef,
    modelWritesRef,
    sessionLoadRef,
    sessionRef,
    setConversationListRefreshError,
    setDefaultModelSelection,
    setModelSelection,
    setSession,
    sessionOrderRef,
    setSessionOrder,
    setWorkspaceOrder,
    workspaceOrderRef,
    workspace,
  ]);

  return {
    workspaces,
    stateLoading,
    workspace,
    workspaceRef,
    stateRequestRef,
    changeWorkspace,
    loadState,
    ...sidebar,
  };
}
