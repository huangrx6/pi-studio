/** Synthetic projections consumed through the same renderer entry points as Electron. */
export function installSessionViewsFixture() {
  const api = window.piApi;
  const now = Date.now();
  localStorage.setItem('pi-studio:preferences', JSON.stringify({ theme: 'dark', showCodeView: true }));
  const originalSettings = api.settings;
  api.settings = async cwd => ({ ...await originalSettings(cwd), extensions: [], extensionErrors: [] });
  const originalState = api.state;
  api.state = async () => {
    const state = await originalState();
    state.workspaces[0].name = 'Pi Studio';
    state.workspaces[0].sessions[0].title = '工作区交互审查';
    return state;
  };
  const qa = window.sessionViewsQa = { replies: [], reads: 0, failList: false, failReply: false, failSnapshot: false, failTranscript: false };
  // Exercise the copy action without modifying the system clipboard.
  Object.defineProperty(navigator.clipboard, 'writeText', { value: async value => { qa.copied = value; } });
  const child = { runId: 'qa-run', agent: 'subagent', source: 'background', context: 'fresh', model: 'qa/reviewer',
    thinking: 'medium', cwd: '/qa/synthetic/performance', isolation: 'worktree', hasTranscript: true, preview: '', toolCount: 3, tokens: 1420 };
  const children = [
    { name: '接口核对', status: 'waiting', task: '核对工作区的接口约定，整理需要确认的字段。', startedAt: now - 42_000,
      supervisorRequests: [{ id: 'format', question: '导出文件使用哪种格式？' }, { id: 'locale', question: '是否保留英文列名？' }] },
    { name: '回归检查', status: 'failed', task: '检查历史会话的恢复流程。', error: '读取历史样例时找不到 fixtures/session.json。', hasTranscript: false, durationMs: 1200 },
    { name: '索引整理', status: 'running', task: '按功能整理工作区索引，并核对文档链接。', currentTool: 'read', startedAt: now - 65_000 },
    { name: '布局审查', status: 'completed', task: '检查桌面布局\n核对导航\n核对表格\n核对工具栏\n检查面板边界', preview: '已完成六处布局检查，两个窄屏边界已记录。', durationMs: 0 },
  ].map((data, index) => ({ ...child, key: `child-${index}`, index, ...data }));
  api.sessionSubagents = async () => { if (qa.failList) throw new Error('暂时无法读取任务'); return structuredClone(children); };
  api.subagentBudget = async () => ({ tokens: 7840, budgetTokens: 25_000, requests: 12, costUsd: 0.024, budgetCostUsd: 0.5, exceeded: false });
  api.replySubagentSupervisor = async input => {
    if (qa.failReply) throw new Error('回复暂未送达');
    qa.replies.push(input);
    const entry = children.find(child => child.key === input.childKey);
    entry.supervisorRequests = entry.supervisorRequests.filter(q => q.id !== input.requestId);
    return { ok: true };
  };
  api.subagentTranscript = async ({ childKey }) => {
    if (qa.failTranscript) throw new Error('暂时无法读取记录');
    const entry = children.find(child => child.key === childKey);
    return { child: structuredClone(entry), messages: [{ role: 'user', sourceIndex: 0, content: [{ type: 'text', text: entry.task }] },
      { role: 'assistant', sourceIndex: 1, content: [{ type: 'text', text: '已核对页面边界和返回路径。' }] }], totalMessages: 2 };
  };
  const messages = [];
  const requestTraces = [];
  for (let i = 0; i < 18; i++) {
    const at = now - (18 - i) * 60_000;
    const name = i % 3 === 0 ? 'read' : 'list';
    messages.push({ role: 'user', timestamp: at, content: [{ type: 'text', text: `检查第 ${i + 1} 个工作区模块` }] });
    requestTraces.push({ id: `trace-${i}`, requestId: `request-${i}`, conversationId: 'perf-0', taskId: `turn-${i}`, attempt: 1,
      createdAt: at + 200, userTimestamp: at, snapshot: 'deferred', model: { provider: 'qa', modelId: 'reviewer' },
      stats: { messageCount: 2, estimatedChars: 1480, toolDefinitionCount: 1 }, truncated: false });
    messages.push({ role: 'assistant', taskId: `turn-${i}`, timestamp: at + 500, content: [
      { type: 'thinking', thinking: '核对模块的文件结构与导出路径。' }, { type: 'toolCall', id: `tool-${i}`, name, arguments: { path: `src/modules/${i}.ts` } }] });
    messages.push({ role: 'toolResult', toolCallId: `tool-${i}`, isError: i === 3, timestamp: at + 900, durationMs: 260,
      content: [{ type: 'text', text: i === 3 ? '路径不存在，请检查模块入口。' : '模块文件与索引匹配。' }] });
    messages.push({ role: 'assistant', taskId: `turn-${i}`, timestamp: at + 1400, content: [{ type: 'text', text: '已整理本轮检查结果。' }] });
  }
  messages.forEach((message, index) => { message.sourceIndex = index; });
  for (const name of ['conversationPage', 'subscribeConversation', 'conversationSnapshot']) {
    const original = api[name];
    api[name] = async input => ({ ...await original(input), requestTraces, ...(name === 'conversationPage' ? { messages, messageStart: 0, page: { hasOlder: false } } : {}) });
  }
  api.conversationRequestTrace = async (_id, requestId) => {
    qa.reads++;
    if (qa.failSnapshot) throw new Error('暂时无法读取快照');
    return { ...requestTraces.find(trace => trace.requestId === requestId), snapshot: undefined, messages: [
      { role: 'system', index: 0, content: [{ type: 'text', text: '按文件证据核对结论。' }] },
      { role: 'user', index: 1, content: [{ type: 'text', text: '核对模块文件。' }] },
    ], tools: [{ name: 'read', description: '读取指定文件。', parameters: { type: 'object' } }] };
  };
  const items = [
    ['monitor', '运行监测', 'builtin', 'usage', '会话用量', '查看本轮的请求数和已记录用量。', '模型请求', '18 次'],
    ['monitor', '运行监测', 'builtin', 'latency', '请求耗时', '查看最近一次模型响应的计时。', '首个响应', '1.42 秒'],
    ['workspace', '工作区工具', 'project', 'changes', '变更摘要', '检查当前工作树中有改动的文件。', '变更文件', '3 个'],
  ].map(([extensionId, extensionName, scope, contributionId, title, description, label, value], sourceOrder) => ({
    id: `${extensionId}/${contributionId}`, extensionId, extensionName, scope, contributionId, title, description, sourceOrder,
    slot: 'conversation.detail', slots: ['conversation.detail'], size: 'regular', priority: 0, content: [{ kind: 'keyValue', items: [{ label, value }] }],
  }));
  api.extensionsUi = async () => ({ items, errors: [], syncedAt: now, apiVersion: 1 });
  qa.order = { version: 1, layout: 'grid', globalOrder: [], sessionOrders: {} };
  api.conversationExtensionUiPreferences = async () => structuredClone(qa.order);
  api.saveConversationExtensionUiPreferences = async patch => {
    if (patch.layout) qa.order.layout = patch.layout;
    if (patch.globalOrder) qa.order.globalOrder = patch.globalOrder;
    if (patch.sessionId && patch.sessionOrder) qa.order.sessionOrders[patch.sessionId] = patch.sessionOrder;
    if (patch.sessionOrder === null) delete qa.order.sessionOrders[patch.sessionId];
    const saved = structuredClone(qa.order);
    if (qa.holdNextWrite) {
      qa.holdNextWrite = false;
      return new Promise(resolve => { qa.releaseWrite = () => resolve(saved); });
    }
    return saved;
  };
  if (new URLSearchParams(location.search).has('empty')) {
    api.sessionSubagents = async () => [];
    api.extensionsUi = async () => ({ items: [], errors: [], syncedAt: now, apiVersion: 1 });
    for (const name of ['conversationPage', 'subscribeConversation', 'conversationSnapshot']) {
      const original = api[name];
      api[name] = async input => ({ ...await original(input), requestTraces: [], messages: [], messageCount: 0 });
    }
  }

}
