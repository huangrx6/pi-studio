/** Synthetic composer IPC. No disk, models, shell, file picker, or external network. */
export function installComposerInputFixture() {
  const base = window.piApi; const clone = (value) => JSON.parse(JSON.stringify(value));
  const calls = []; const holds = {}; const failures = {}; const pending = {}; const listeners = new Set(); const dataViewListeners = new Set();
  let sequence = 0; let pickerSequence = 0; let dataViewSequence = 0; const created = [];
  const dataViews = new Map(); const dataViewResponses = new Map();
  const extensionItems = [
    {
      id: 'project:qa-extension/scope-launcher',
      extensionId: 'qa-extension',
      extensionName: 'QA Extension',
      scope: 'project',
      contributionId: 'scope-launcher',
      title: '扩展归属测试',
      description: '验证切换会话后旧结果不会进入新范围',
      slot: 'composer.before',
      size: 'compact',
      priority: 10,
      sourceOrder: 0,
      content: [{
        kind: 'actions',
        buttons: [
          { id: 'open-scope-panel', label: '打开 QA 范围面板', action: { kind: 'openPanel', panelId: 'project:qa-extension/scope-panel' } },
          { id: 'run-scope-command', label: '执行 QA 延迟命令', action: { kind: 'runCommand', commandId: 'qa:extension-scope' } },
        ],
      }],
    },
    {
      id: 'project:qa-extension/scope-panel',
      extensionId: 'qa-extension',
      extensionName: 'QA Extension',
      scope: 'project',
      contributionId: 'scope-panel',
      title: 'QA 范围面板',
      description: '只属于打开它的会话',
      slot: 'composer.before',
      size: 'compact',
      priority: 5,
      sourceOrder: 1,
      content: [{ kind: 'text', text: '当前范围内的合成扩展面板。' }],
    },
    {
      id: 'project:qa-extension/live-data',
      extensionId: 'qa-extension',
      extensionName: 'QA Extension',
      scope: 'project',
      contributionId: 'live-data',
      title: '实时扩展数据',
      description: '验证订阅切换与重连',
      slot: 'composer.before',
      size: 'compact',
      priority: 1,
      sourceOrder: 2,
      content: [{ kind: 'dataView', sourceId: 'project:qa-extension/live-data' }],
    },
  ];
  const qa = window.__composerInputQa = {
    calls, resourceRevision: 1, uploadSequence: 0,
    hold(method, key = true) { holds[method] = key; },
    fail(method) { failures[method] = true; },
    pending(method) { return (pending[method] || []).map(({ id, key }) => ({ id, key })); },
    release(method, key) { delete holds[method]; const batch = pending[method] || []; pending[method] = batch.filter(item => key !== undefined && item.key !== key); for (const item of batch) if (key === undefined || item.key === key) item.resolve(); },
    releaseAt(method, index) { const item = pending[method]?.splice(index, 1)[0]; item?.resolve(); },
    reject(method, key) { delete holds[method]; const batch = pending[method] || []; pending[method] = batch.filter(item => key !== undefined && item.key !== key); for (const item of batch) if (key === undefined || item.key === key) item.reject(new Error(`QA ${method} failure`)); },
    open(id) { window.__settingsExecutionQa.open(id); },
    emit(type, conversationId, payload = {}) { for (const listener of listeners) listener({ type, conversationId, payload, sequence: ++sequence }); },
    dataViewResponse(key, response) { dataViewResponses.set(key, response); },
    dataViewSubscription(key) { return dataViews.get(key) || null; },
    emitDataView(subscriptionId, snapshot) { for (const listener of dataViewListeners) listener({ subscriptionId, snapshot: clone(snapshot) }); },
  };
  async function respond(method, value, key) {
    const captured = clone(value);
    if (failures[method]) { delete failures[method]; throw new Error(`QA ${method} failure`); }
    if (holds[method] === true || holds[method] === key) await new Promise((resolve, reject) => (pending[method] ??= []).push({ id: ++sequence, key, resolve, reject }));
    return captured;
  }
  const file = (name, id = name) => ({ id, kind: 'file', name, path: `/qa/attachments/${name}`, mime: 'text/plain', bytes: 24, lines: 1, marker: `@/qa/attachments/${name}` });
  window.piApi = new Proxy({
    state: async () => { const result = await base.state(); for (const item of created) result.workspaces.find(workspace => workspace.cwd === item.cwd)?.sessions.push(clone(item)); return result; },
    createConversation: async (input) => { calls.push({ method: 'createConversation', ...input }); const item = { id: 'qa-created', cwd: input.cwd, title: 'QA 新创建会话', kind: 'conversation', running: false, archived: false, messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() }; await respond('createConversation', {}, input.cwd); created.push(item); return clone(item); },
    subscribeConversation: async (id) => { const result = await base.subscribeConversation(id === 'qa-created' ? 'perf-0' : id); return id === 'qa-created' ? { ...result, ...created.find(item => item.id === id) } : result; },
    composerResources: async (input) => {
      calls.push({ method: 'composerResources', ...input });
      const scope = input.sessionId === 'perf-1' ? 'b' : 'a';
      return respond('composerResources', { commands: [{ name: 'qa-extension', description: '只返回合成内容的 QA 命令', source: 'extension', commandId: 'qa:composer-late' }, { name: `qa-review-${scope}`, description: `QA workspace ${scope} revision ${qa.resourceRevision}`, source: 'prompt', argumentHint: '<目标>' }, { name: `qa-check-${scope}`, description: '执行前检查输入，不会自动发送', source: 'prompt', argumentHint: '<范围>' }], skills: [{ name: `qa-skill-${scope}`, description: 'QA 隔离技能说明', source: 'skill', argumentHint: '<任务>' }] }, input.sessionId || input.cwd);
    },
    searchFiles: async (input) => { calls.push({ method: 'searchFiles', ...input }); return respond('searchFiles', { files: [{ name: `${input.query || 'index'}.txt`, path: `docs/${input.query || 'index'}.txt`, type: 'file' }, { name: 'QA notes.md', path: 'docs/QA notes.md', type: 'file' }] }, input.query); },
    saveAttachment: async (input) => { calls.push({ method: 'saveAttachment', sessionId: input.sessionId, text: input.text }); const name = `long-paste-${calls.filter(item => item.method === 'saveAttachment').length}.txt`; return respond('saveAttachment', { ...file(name), kind: 'text', bytes: new TextEncoder().encode(input.text).length, lines: input.text.split('\n').length, notice: '已作为文本附件保留', promptText: `@/qa/attachments/${name}`, marker: `@/qa/attachments/${name}` }, input.sessionId); },
    pickAttachments: async (input) => { const id = ++pickerSequence; calls.push({ method: 'pickAttachments', ...input, id }); return respond('pickAttachments', { attachments: [file(`picked-${id}.txt`)] }, input.sessionId); },
    saveUpload: async (input) => { calls.push({ method: 'saveUpload', sessionId: input.sessionId, name: input.name, mime: input.mime }); return respond('saveUpload', file(input.name, `upload-${++qa.uploadSequence}`), input.name); },
    onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    conversationSubmit: async (input) => { calls.push({ method: 'conversationSubmit', ...clone(input) }); throw new Error('Composer QA forbids actual submission'); },
    extensionsUi: async (cwd) => {
      calls.push({ method: 'extensionsUi', cwd });
      return { items: clone(extensionItems), errors: [], syncedAt: Date.now(), apiVersion: 1 };
    },
    onExtensionDataView: (listener) => {
      dataViewListeners.add(listener);
      return () => dataViewListeners.delete(listener);
    },
    openExtensionDataView: async (input) => {
      calls.push({ method: 'openExtensionDataView', ...clone(input) });
      const key = input.sessionId || input.cwd || 'draft';
      const subscriptionId = `qa-data-view-${++dataViewSequence}`;
      dataViews.set(key, subscriptionId);
      const configured = dataViewResponses.get(key);
      const response = configured || {
        sourceId: input.sourceId,
        revision: 1,
        updatedAt: Date.now(),
        content: [{ kind: 'text', text: input.sessionId === 'perf-1' ? 'B 实时数据' : 'A 实时数据' }],
      };
      return respond('openExtensionDataView', { subscriptionId, snapshot: response }, key);
    },
    closeExtensionDataView: async (subscriptionId) => {
      calls.push({ method: 'closeExtensionDataView', subscriptionId });
      for (const [key, id] of dataViews) if (id === subscriptionId) dataViews.delete(key);
      return respond('closeExtensionDataView', { closed: true }, subscriptionId);
    },
    runExtensionCommand: async (input) => {
      calls.push({ method: 'runExtensionCommand', ...clone(input) });
      if (input.commandId === 'qa:composer-late') {
        return respond('runExtensionCommand', { promptText: '不应覆盖新的草稿内容', submit: true }, input.sessionId);
      }
      if (input.commandId === 'qa:extension-scope') {
        return respond('runExtensionCommand', {
          promptText: 'A 范围结果',
          submit: false,
          panelId: 'project:qa-extension/scope-panel',
          message: 'A 范围的延迟结果',
        }, input.sessionId);
      }
      throw new Error('Composer QA forbids unknown extension command');
    },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
