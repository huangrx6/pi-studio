/** Deterministic in-memory data. No Electron bridge, disk data, or model calls. */
export function installPerformanceFixture({ sessionCount, turnCount }) {
  const started = performance.now();
  const now = 1_780_000_000_000;
  const cwd = '/qa/synthetic/performance';
  const model = { modelRef: 'qa/model', label: 'Synthetic model', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' };
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    id: `perf-${index}`, title: `性能会话 ${String(index).padStart(4, '0')}`, cwd,
    kind: 'conversation', goal: '', pinned: false, archived: false, running: false,
    createdAt: now - index * 60_000, updatedAt: now - index * 60_000,
    messageCount: index === 0 ? turnCount * 2 : 16,
  }));
  const makeMessages = (count) => Array.from({ length: count }, (_, index) => [
    { role: 'user', sourceIndex: index * 2, timestamp: now + index * 1000, content: [{ type: 'text', text: `第 ${index + 1} 轮：请检查组件的可读性、边界条件和键盘使用体验。` }] },
    { role: 'assistant', sourceIndex: index * 2 + 1, timestamp: now + index * 1000 + 500, content: [{ type: 'text', text: `第 ${index + 1} 轮检查完成。保持布局清晰，让常用操作自然可达。\n\n- 验证空状态和恢复路径。\n- 检查输入与滚动反馈。\n- 保留明确的焦点。\n\n\`\`\`typescript\nconst item = { index: ${index}, ready: true };\nconsole.log(item.ready);\n\`\`\`\n\n| 项目 | 状态 |\n| --- | --- |\n| 阅读 | 已检查 |\n| 键盘 | 已检查 |` }] },
  ]).flat();
  const longMessages = makeMessages(turnCount);
  const shortMessages = makeMessages(8);
  const messagesFor = (id) => id === 'perf-0' ? longMessages : shortMessages;
  const snapshot = (id) => ({ ...sessions.find((item) => item.id === id), model, requestId: '', requestTraces: [], turnDiffs: [], compacting: false, inbox: [], tools: [], nestedTools: [], usage: {}, agent: { cwd, name: 'Synthetic Agent' } });
  const qa = { fixtureMs: performance.now() - started, sessionCount, turnCount, pageCalls: [], submitCalls: 0, longTasks: [], longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
  window.__performanceQa = qa;
  if (qa.longTaskSupported) new PerformanceObserver((list) => qa.longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: 'longtask', buffered: true });
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'light', stepDisplay: 'standard', stepCollapse: 'after-answer', showCodeView: false }));
  localStorage.setItem('pi-studio:expanded-workspaces', JSON.stringify([cwd]));
  window.piApi = new Proxy({
    state: async () => ({ workspaces: [{ cwd, name: '合成性能数据', sessions }], model }),
    settings: async () => ({ providers: [], customModels: [], mcp: [], skills: [] }),
    models: async () => ({ models: [], enabled: [], selection: model, defaultSelection: model }),
    conversationPage: async ({ id, limit, cursor }) => {
      qa.pageCalls.push({ id, limit, cursor: cursor || null });
      const messages = messagesFor(id);
      const end = cursor ? Number(cursor) : messages.length;
      const start = Math.max(0, end - limit);
      return { ...snapshot(id), messages: messages.slice(start, end), messageStart: start, page: { hasOlder: start > 0, nextCursor: start > 0 ? String(start) : undefined } };
    },
    conversationOutline: async (id) => ({ id, items: messagesFor(id).filter((item) => item.role === 'user').map((item) => ({ sourceIndex: item.sourceIndex, text: item.content[0].text, timestamp: item.timestamp })), totalMessages: messagesFor(id).length }),
    conversationSnapshot: async (id) => snapshot(id),
    subscribeConversation: async (id) => snapshot(id),
    unsubscribeConversation: async () => ({ ok: true }),
    conversationSubmit: async () => { qa.submitCalls++; throw new Error('Performance fixture never submits model requests'); },
    sessionSubagents: async () => [],
    modeGet: async () => ({ available: true, mode: 'smart' }),
    composerResources: async () => ({ commands: [], skills: [] }),
    extensionsUi: async () => ({ items: [], errors: [], syncedAt: now, apiVersion: 1 }),
    conversationExtensionUiPreferences: async () => ({ version: 1, layout: 'grid', globalOrder: [], sessionOrders: {} }),
  }, { get(target, key) { if (key in target) return target[key]; if (String(key).startsWith('on')) return () => () => {}; return async () => undefined; } });
}
