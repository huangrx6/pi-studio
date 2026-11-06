/** Isolated in-memory renderer fixture. No provider, filesystem, or real IPC. */
export function installStatusRecoveryFixture() {
  const cwd = '/qa/status-recovery';
  const now = Date.now();
  const model = { modelRef: 'qa/model', label: 'QA Model', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
  const longReason = '需要补充项目验收标准与依赖版本，再继续检查剩余文件。'.repeat(12);
  const cases = [
    ['active-running', '任务正在运行', 'active', true],
    ['active-idle', '任务等待继续', 'active', false],
    ['paused', '任务已暂停', 'paused', false],
    ['blocked', '任务等待补充', 'blocked', false],
    ['failed', '任务执行失败', 'failed', false],
    ['completed', '任务已完成', 'completed', false],
    ['idle', '任务尚未开始', 'idle', false],
    ['paused-running', '任务暂停但后台运行', 'paused', true],
    ['blocked-running', '任务阻塞但后台运行', 'blocked', true],
    ['failed-running', '任务失败但后台运行', 'failed', true],
    ['subscription-recovery', '实时连接恢复', 'active', false],
    ['notification-target', '通知对应会话', 'completed', false],
    ['unavailable', '暂不可用会话', 'completed', false],
  ];
  const sessions = cases.map(([id, title, status, running]) => ({
    id, cwd, title, kind: 'conversation', goal: '', pinned: false, archived: false, running,
    createdAt: now - 90_000, updatedAt: now - 60_000, messageCount: 2,
    longTask: { enabled: true, goal: '完成项目可读性与键盘操作检查', completionCriteria: '检查通过并保留可追溯结果', status, iteration: 3, lastProgress: '已检查主要界面', nextStep: '检查剩余交互与错误恢复', pauseReason: longReason, blockReason: longReason, completionSummary: '任务检查完成', createdAt: now - 90_000, updatedAt: now - 60_000, completedAt: 0, blockedAt: 0 },
  }));
  const listeners = new Set();
  const runtimeListeners = new Set();
  const calls = [];
  const unavailable = new Set(['unavailable']);
  const subscriptionFailures = new Map();
  const subscriptionAttempts = {};
  let pendingAction;
  const messages = (id) => [
    { role: 'user', timestamp: now - 50_000, content: [{ type: 'text', text: `请继续处理 ${id}。` }] },
    { role: 'assistant', timestamp: now - 40_000, content: [{ type: 'text', text: '此前工作已保存，可以根据当前状态继续处理。' }] },
  ];
  const snapshot = (id) => ({ ...sessions.find((item) => item.id === id), model, requestId: `qa-${id}`, requestTraces: [], turnDiffs: [], compacting: false, inbox: [], tools: [], nestedTools: [], usage: {}, agent: { cwd, name: 'QA Agent' } });
  const emit = (id, type, payload) => {
    const item = sessions.find((session) => session.id === id);
    if (item && typeof payload.running === 'boolean') item.running = payload.running;
    for (const listener of listeners) listener({ conversationId: id, type, payload, at: Date.now() });
  };
  const applyAction = (input) => {
    const item = sessions.find((session) => session.id === input.id);
    if (input.action === 'archive') {
      item.archived = !item.archived;
      return { ok: true };
    }
    const paused = input.action === 'long-task-pause';
    item.longTask = { ...item.longTask, status: paused ? 'paused' : 'active', pauseReason: paused ? '已按要求暂停' : '', updatedAt: Date.now() };
    item.running = !paused;
    return { longTask: item.longTask, started: !paused };
  };
  window.__statusQa = {
    calls,
    holdActions: false,
    rejectActions: false,
    emit,
    runtimeRefresh: (snapshot) => { for (const listener of runtimeListeners) listener(snapshot); },
    notify: (detail) => window.dispatchEvent(new CustomEvent('pi-studio:notify', { detail })),
    failSubscriptions: (id, count = 1) => { subscriptionFailures.set(id, Math.max(1, count)); },
    closeConversationStream: (id) => emit(id, 'stream.closed', { reason: 'failed' }),
    subscriptionAttempts: (id) => subscriptionAttempts[id] || 0,
    releaseAction: (fail = false) => {
      if (!pendingAction) throw new Error('No held QA action');
      const pending = pendingAction;
      pendingAction = undefined;
      if (fail) pending.reject(new Error('QA_ACTION_FAILURE：暂时无法继续，请检查后重试。'));
      else pending.resolve(applyAction(pending.input));
    },
    setAvailable: (id, available) => { if (available) unavailable.delete(id); else unavailable.add(id); },
    setLongTask: (id, patch) => { const item = sessions.find((session) => session.id === id); item.longTask = { ...item.longTask, ...patch }; },
  };
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'light', stepDisplay: 'standard', stepCollapse: 'after-answer' }));
  window.piApi = new Proxy({
    state: async () => ({
      workspaces: [{
        cwd,
        name: '状态恢复 QA',
        // Production state includes archived rows; the sidebar filters them.
        sessions: sessions.map(session => ({
          ...session,
          longTask: session.longTask && { ...session.longTask },
        })),
      }],
      model,
    }),
    conversationPage: async ({ id }) => {
      calls.push({ method: 'conversationPage', id });
      if (unavailable.has(id)) throw new Error('QA_LOAD_FAILURE：会话暂时不可用。');
      return { ...snapshot(id), messages: messages(id), page: { hasOlder: false }, messageStart: 0 };
    },
    conversationOutline: async (id) => ({ id, items: [{ sourceIndex: 0, text: `请继续处理 ${id}。` }], totalMessages: 2 }),
    conversationSnapshot: async (id) => snapshot(id),
    subscribeConversation: async (id) => {
      calls.push({ method: 'subscribeConversation', id });
      subscriptionAttempts[id] = (subscriptionAttempts[id] || 0) + 1;
      const remaining = subscriptionFailures.get(id) || 0;
      if (remaining > 0) {
        if (remaining === 1) subscriptionFailures.delete(id);
        else subscriptionFailures.set(id, remaining - 1);
        throw new Error('QA_SUBSCRIBE_FAILURE：会话正文已载入，但实时状态暂时无法连接。');
      }
      return snapshot(id);
    },
    unsubscribeConversation: async () => ({ ok: true }),
    onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    onRuntimeRefresh: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
    conversationAction: async (input) => {
      calls.push(input);
      if (window.__statusQa.rejectActions) throw new Error('QA_ACTION_FAILURE：暂时无法继续，请检查后重试。');
      if (window.__statusQa.holdActions) return new Promise((resolve, reject) => { pendingAction = { input, resolve, reject }; });
      return applyAction(input);
    },
    conversationSubmit: async () => { throw new Error('QA must never submit a provider request'); },
    sessionSubagents: async () => [],
    modeGet: async () => ({ available: true, mode: 'smart' }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: now, apiVersion: 1 }),
    conversationExtensionUiPreferences: async () => ({ version: 1, layout: 'grid', globalOrder: [], sessionOrders: {} }),
    saveConversationExtensionUiPreferences: async (value) => ({ version: 1, ...value, sessionOrders: {} }),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => undefined;
    },
  });
}
