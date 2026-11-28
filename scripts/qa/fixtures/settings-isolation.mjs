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
  window.piApi = new Proxy({
    sessionSubagents: async () => children,
    subagentTranscript: async ({ childKey }) => ({ child: children.find(child => child.key === childKey), messages: [{ role: 'user', content: [{ type: 'text', text: '检查设置页面' }] }, { role: 'assistant', content: [{ type: 'text', text: '独立子智能体正文' }] }], totalMessages: 2, hasMore: false }),
    conversationTodoHistory: async () => ({ plans: [], cursor: null }),
    gitRepositories: async () => [],
  }, { get: (target, key) => key in target ? target[key] : base[key] });
}
