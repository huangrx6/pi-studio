/** Synthetic workspace data; no user's files, credentials or shell are accessed. */
export function installSettingsIsolationFixture() {
  const preferences = JSON.parse(localStorage.getItem('pi-studio:preferences') || '{}');
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ ...preferences, showCodeView: true }));
  const base = window.piApi;
  const children = ['alpha', 'bravo'].map((name, index) => ({
    key: `child-${index}`, index, name, agent: 'subagent', status: 'completed',
    task: `设置页面不应出现这段任务：${name}`, model: 'qa/model', tokens: 120,
    providerRequests: 1, turnCount: 1, toolCount: 0, durationMs: 1000,
    hasTranscript: true, startedAt: Date.now() - 1000, updatedAt: Date.now(),
  }));
  const qa = window.__settingsIsolationQa = { terminalCreates: 0, terminalWrites: [], terminalCloses: 0 };
  window.piApi = new Proxy({
    extensionsUi: async () => ({
      items: [{
        id: 'user:qa.isolation/details', contributionId: 'details', extensionId: 'user:qa.isolation',
        extensionName: '隔离检查', title: '隔离检查', scope: 'user', slot: 'panel.side', size: 'regular',
        priority: 0, sourceOrder: 0, content: [{ kind: 'text', text: '仅在工作台显示的扩展内容' }],
      }],
      errors: [], apiVersion: 1, syncedAt: 1,
    }),
    sessionSubagents: async () => children,
    subagentTranscript: async ({ childKey }) => ({ child: children.find(child => child.key === childKey), messages: [{ role: 'user', content: [{ type: 'text', text: '检查设置页面' }] }, { role: 'assistant', content: [{ type: 'text', text: '独立子智能体正文' }] }], totalMessages: 2, hasMore: false }),
    conversationTodoHistory: async () => ({ plans: [], cursor: null }),
    gitRepositories: async () => [],
    terminalCreate: async input => {
      qa.terminalCreates++;
      return { id: input.id, cwd: input.cwd, shell: '/synthetic/shell', status: 'running', sequence: 0 };
    },
    terminalWrite: async (id, data) => { qa.terminalWrites.push({ id, data }); },
    terminalClose: async () => { qa.terminalCloses++; },
  }, { get: (target, key) => key in target ? target[key] : base[key] });
}
