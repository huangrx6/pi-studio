/** In-memory archive/model/context data; no real persistence or model calls. */
export function installSettingsUtilitiesFixture() {
  const base = window.piApi; const clone = value => JSON.parse(JSON.stringify(value));
  const a = '/qa/synthetic/performance'; const b = '/qa/long-project-path/多工作区归档与上下文用量验证';
  const activeArchived = {}; const calls = []; const holds = {}; const failures = {}; const pending = {}; const opens = new Set();
  const archived = Array.from({ length: 126 }, (_, index) => ({ id: `arch-${index}`, cwd: index < 63 ? a : b, title: index === 125 ? '远端 NEEDLE 发布审查与跨工作区验证——长名称保持可读并保留完整恢复操作' : `归档会话 ${String(index).padStart(3, '0')}`, kind: 'conversation', archived: true, pinned: index === 0, running: false, createdAt: 1780000000000, updatedAt: 1780000000000 - index * 1000 }));
  const model = ref => ({ modelRef: ref, label: ref === 'qa/a' ? 'Context A' : 'Context B', thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' });
  const selections = { 'perf-0': model('qa/a'), 'perf-1': model('qa/b') };
  const policies = { 'qa/a': { modelRef: 'qa/a', contextWindow: 100000, autoCompactPercent: 85, compactAtTokens: 85000 }, 'qa/b': { modelRef: 'qa/b', contextWindow: 200000, autoCompactPercent: 85, compactAtTokens: 170000 } };
  window.__settingsUtilitiesQa = {
    calls, policies,
    expireTranscriptCache() { const now = Date.now; Date.now = () => now() + 61000; },
    hold(method, key = true) { holds[method] = key; },
    fail(method) { failures[method] = true; },
    pending(method) { return pending[method]?.length || 0; },
    release(method) { delete holds[method]; for (const resolve of (pending[method] || []).splice(0)) resolve(); },
    open(id) { for (const listener of opens) listener({ id, cwd: a }); },
  };
  async function respond(method, value, key) {
    const result = clone(value);
    if (failures[method]) { delete failures[method]; throw new Error(`QA ${method} 读取或操作失败`); }
    if (holds[method] === true || (key !== undefined && holds[method] === key)) await new Promise(resolve => (pending[method] ??= []).push(resolve));
    return result;
  }
  const snapshot = async id => ({ ...(await base.conversationSnapshot(id)), model: selections[id] });
  window.piApi = new Proxy({
    state: async () => { calls.push({ method: 'state' }); const value = clone(await base.state()); value.model = model('qa/a'); value.workspaces[0].sessions = value.workspaces[0].sessions.map(item => ({ ...item, archived: activeArchived[item.id] ?? item.archived })); value.workspaces[0].sessions.push(...clone(archived.filter(item => item.cwd === a))); value.workspaces.push({ cwd: b, name: '发布验证 B', sessions: clone(archived.filter(item => item.cwd === b)) }); return respond('state', value); },
    conversationPage: async input => { const value = await base.conversationPage(input); value.model = selections[input.id]; value.messages.at(-1).usage = { input: 38000, output: 2000 }; calls.push({ method: 'conversationPage', id: input.id }); return respond('conversationPage', value, input.id); },
    conversationSnapshot: snapshot, subscribeConversation: snapshot,
    onOpenSession: listener => { opens.add(listener); return () => opens.delete(listener); },
    conversationAction: async input => { calls.push({ method: 'conversationAction', ...input }); await respond('conversationAction', {}, input.id); const index = archived.findIndex(item => item.id === input.id); if (input.action === 'archive') { if (index >= 0) archived[index].archived = !archived[index].archived; else activeArchived[input.id] = !activeArchived[input.id]; } else if (input.action === 'remove') archived.splice(index, 1); return { ok: true }; },
    contextPolicy: async input => { calls.push({ method: 'contextPolicy', ...input }); return respond('contextPolicy', policies[input.modelRef], input.modelRef); },
    models: async () => ({ models: ['qa/a', 'qa/b'].map(ref => ({ id: ref, name: model(ref).label, provider: 'qa', providerName: 'QA', model: ref, supportsImages: false, reasoning: false })), enabled: ['qa/a', 'qa/b'], selection: model('qa/a'), defaultSelection: model('qa/a') }),
    conversationConfigure: async input => { calls.push({ method: 'conversationConfigure', ...input }); selections[input.id] = model(input.modelRef); return clone(selections[input.id]); },
    conversationCompact: async input => { calls.push({ method: 'conversationCompact', ...input }); throw new Error('QA 手动压缩失败，原会话内容保留'); },
    conversationSubmit: async () => { calls.push({ method: 'conversationSubmit' }); throw new Error('Forbidden model submission'); },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
