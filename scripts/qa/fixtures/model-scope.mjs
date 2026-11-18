export function installModelScopeFixture() {
  const base = window.piApi;
  const a = '/qa/workspace-a'; const b = '/qa/workspace-b';
  const selection = (key, label) => ({ modelRef: `qa/${key}`, label, thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off', defaultThinkingLevel: 'off' });
  const selections = { a: selection('a', 'Session A'), b: selection('b', 'Session B'), c: selection('c', 'Session C') };
  const defaults = { [a]: selection('default-a', 'Default A'), [b]: selection('default-b', 'Default B') };
  const sessions = Object.entries(selections).map(([id]) => ({ id, cwd: id === 'c' ? b : a, title: `Race ${id.toUpperCase()}`, kind: 'conversation', goal: '', pinned: false, archived: false, running: false, createdAt: 1, updatedAt: 2, messageCount: 1 }));
  const messages = [{ role: 'user', content: [{ type: 'text', text: '模型设置竞态验证，不发送请求。' }] }];
  const snapshot = (id) => ({ ...sessions.find((item) => item.id === id), model: selections[id], requestId: '', requestTraces: [], turnDiffs: [], compacting: false, inbox: [], tools: [], nestedTools: [], usage: {}, agent: {} });
  const options = [...Object.values(selections), ...Object.values(defaults), selection('new', 'New Model')].map((item) => ({ id: item.modelRef, name: item.label, provider: 'qa', providerName: 'QA', model: item.modelRef, supportsImages: true, reasoning: false }));
  const pending = { configure: [], catalog: [], defaults: [], subscription: [], completion: [], page: [] };
  const listeners = new Set();
  window.__modelScopeQa = {
    holdConfigure: false, holdCatalogFor: '', holdDefaultsFor: '', holdSubscriptionFor: '', holdCompletionFor: '', holdPageFor: '', calls: [],
    pending: (kind) => pending[kind].length,
    release: (kind) => { const queue = pending[kind].splice(0); if (!queue.length) throw new Error(`No pending ${kind}`); for (const resolve of queue) resolve(); },
    emit: (conversationId, type, payload) => { for (const listener of listeners) listener({ conversationId, type, payload, at: Date.now() }); },
  };
  window.piApi = new Proxy({
    state: async (cwd) => ({ workspaces: [{ cwd: a, name: 'Workspace A', sessions: sessions.filter((item) => item.cwd === a) }, { cwd: b, name: 'Workspace B', sessions: sessions.filter((item) => item.cwd === b) }], model: defaults[cwd] || defaults[a] }),
    conversationPage: async ({ id }) => { const value = { ...snapshot(id), messages, page: { hasOlder: false }, messageStart: 0 }; if (window.__modelScopeQa.holdPageFor === id) await new Promise((resolve) => pending.page.push(resolve)); return value; },
    conversationSnapshot: async (id) => { const value = snapshot(id); if (window.__modelScopeQa.holdCompletionFor === id) await new Promise((resolve) => pending.completion.push(resolve)); return value; },
    subscribeConversation: async (id) => { const value = snapshot(id); if (window.__modelScopeQa.holdSubscriptionFor === id) await new Promise((resolve) => pending.subscription.push(resolve)); return value; },
    onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    conversationOutline: async (id) => ({ id, items: [{ sourceIndex: 0, text: '模型设置竞态验证' }], totalMessages: 1 }),
    models: async (cwd) => {
      window.__modelScopeQa.calls.push({ method: 'models', cwd });
      const chosen = defaults[cwd] || defaults[a];
      const value = { models: options, enabled: options.map((option) => option.id), current: chosen.modelRef, selection: chosen, defaultSelection: chosen };
      if (window.__modelScopeQa.holdCatalogFor === cwd) await new Promise((resolve) => pending.catalog.push(resolve));
      return value;
    },
    conversationConfigure: async ({ id, modelRef }) => {
      window.__modelScopeQa.calls.push({ method: 'conversationConfigure', id, modelRef });
      if (window.__modelScopeQa.holdConfigure) await new Promise((resolve) => pending.configure.push(resolve));
      const next = options.find((option) => option.id === modelRef);
      selections[id] = { ...selections[id], modelRef, label: next.name };
      return selections[id];
    },
    setDefaultModel: async (modelRef, cwd) => {
      window.__modelScopeQa.calls.push({ method: 'setDefaultModel', cwd, modelRef });
      if (window.__modelScopeQa.holdDefaultsFor === cwd) await new Promise((resolve) => pending.defaults.push(resolve));
      const next = options.find((option) => option.id === modelRef);
      defaults[cwd] = { ...defaults[cwd], modelRef, label: next.name };
      return defaults[cwd];
    },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
