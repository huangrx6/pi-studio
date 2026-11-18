/** Browser-only data: no filesystem, provider, or production IPC is accessed. */
export function installConversationFixture() {
  const now = Date.now();
  const cwd = '/qa/workspaces/alpha';
  const beta = '/qa/workspaces/beta';
  const model = { modelRef: 'qa/model', label: 'QA Model', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
  const makeSession = (id, title, extra = {}) => ({ id, title, cwd, kind: 'conversation', goal: '', pinned: false, archived: false, running: false, createdAt: now - 120_000, updatedAt: now - 60_000, messageCount: 4, ...extra });
  const sessions = [
    makeSession('running', '运行中的构建检查', { running: true, pinned: true }),
    makeSession('pinned', '已置顶的发布清单', { pinned: true }),
    makeSession('history', '精准目标：组件可读性审查'),
    makeSession('archived', '归档专属关键词', { archived: true }),
    ...Array.from({ length: 120 }, (_, index) => makeSession(`history-${index}`, `历史记录 ${String(index + 1).padStart(3, '0')}`)),
    makeSession('beta', '文档核对', { cwd: beta }),
  ];
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=' };
  const calls = [
    { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/readable.tsx' } },
    { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'pnpm check --fixture-only' } },
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'toolCall', id: `trace-${index}`, name: 'read', arguments: { path: `src/module-${index}.ts` } })),
  ];
  const messages = [
    { role: 'user', timestamp: now - 100_000, content: [{ type: 'text', text: '请审查这段界面实现。' }] },
    { role: 'assistant', timestamp: now - 90_000, content: [{ type: 'thinking', thinking: '先检查组件结构，再验证键盘与布局。**完整决策正文**仅在展开后显示。' }, ...calls] },
    ...calls.map((call, index) => ({ role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: now - 80_000, isError: index === 1, content: [{ type: 'text', text: index === 1 ? 'QA_EXPECTED_FAILURE: fixture validation failed' : `QA_TOOL_OUTPUT_${index}\n${'A long tool result for mount checks.\n'.repeat(100)}` }, ...(index === 0 ? [image] : [])] })),
    { role: 'assistant', timestamp: now - 70_000, content: [{ type: 'text', text: '审查已完成。正文保持可读，详细记录可以按需展开。' }] },
  ];
  const snapshot = (id) => ({ ...sessions.find((item) => item.id === id), model, requestId: id === 'running' ? 'qa-request' : '', requestTraces: [], turnDiffs: [], compacting: false, inbox: [], tools: [], nestedTools: [], usage: {}, agent: { cwd: sessions.find((item) => item.id === id)?.cwd || cwd, name: 'QA Agent' } });
  const callsLog = [];
  window.__conversationQa = { calls: callsLog };
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'light', stepDisplay: 'standard', stepCollapse: 'after-answer', showCodeView: false }));
  window.piApi = new Proxy({
    state: async () => ({ workspaces: [{ cwd, name: 'Alpha 项目', sessions: sessions.filter((item) => item.cwd === cwd) }, { cwd: beta, name: 'Beta 文档', sessions: sessions.filter((item) => item.cwd === beta) }], model }),
    settings: async () => ({ providers: [], customModels: [], mcp: [], skills: [] }),
    models: async () => ({ models: [], enabled: [], selection: model, defaultSelection: model }),
    conversationPage: async ({ id }) => ({ ...snapshot(id), messages, page: { hasOlder: false }, messageStart: 0 }),
    conversationOutline: async (id) => ({ id, items: [{ sourceIndex: 0, text: '请审查这段界面实现。', timestamp: now - 100_000 }], totalMessages: messages.length }),
    conversationSnapshot: async (id) => snapshot(id),
    subscribeConversation: async (id) => snapshot(id),
    unsubscribeConversation: async () => ({ ok: true }),
    conversationAction: async (input) => {
      callsLog.push(input);
      const item = sessions.find((session) => session.id === input.id);
      if (input.action === 'pin') item.pinned = !item.pinned;
      if (input.action === 'rename') item.title = input.name;
      if (input.action === 'archive') item.archived = !item.archived;
      return { ok: true };
    },
    conversationSubmit: async () => { throw new Error('QA must never submit a model request'); },
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
