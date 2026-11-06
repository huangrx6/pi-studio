/** Wrap the synthetic performance API with sidebar actions and external navigation. */
export function installSidebarVirtualizationFixture({ splitAt = 0 } = {}) {
  const base = window.piApi;
  const listeners = new Set();
  const secondCwd = '/qa/synthetic/performance-b';
  if (splitAt) localStorage.setItem('pi-studio:expanded-workspaces', JSON.stringify(['/qa/synthetic/performance', secondCwd]));
  const pending = [];
  const qa = window.__sidebarQa = {
    calls: [], holdActions: false,
    open: (id) => { for (const listener of listeners) listener({ id, cwd: '/qa/synthetic/performance' }); },
    releaseActions: () => { for (const resolve of pending.splice(0)) resolve(); },
    pendingActions: () => pending.length,
  };
  window.piApi = new Proxy({
    state: async () => {
      const state = await base.state();
      if (!splitAt) return state;
      const sessions = state.workspaces[0].sessions;
      for (const session of sessions.slice(splitAt)) session.cwd = secondCwd;
      return { ...state, workspaces: [{ ...state.workspaces[0], sessions: sessions.slice(0, splitAt) }, { cwd: secondCwd, name: '第二组合成会话', sessions: sessions.slice(splitAt) }] };
    },
    onOpenSession: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    conversationAction: async (request) => {
      qa.calls.push(request);
      if (qa.holdActions) await new Promise((resolve) => pending.push(resolve));
      const state = await base.state();
      const session = state.workspaces.flatMap((workspace) => workspace.sessions).find((item) => item.id === request.id);
      if (!session) throw new Error(`Unknown synthetic session ${request.id}`);
      if (request.action === 'rename') session.title = request.name;
      else if (request.action === 'pin') session.pinned = !session.pinned;
      else if (request.action === 'archive') session.archived = !session.archived;
      else throw new Error(`Unimplemented synthetic sidebar action ${request.action}`);
      return { ok: true };
    },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
