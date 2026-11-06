/** Editor contracts only. All resources, credentials, installs and connections are synthetic in-memory DTOs. */
export function installResourceEditorsFixture() {
  const base = window.piApi, clone = value => structuredClone(value), calls = [];
  const mainListeners = new Set(), receipts = new Map(), previewOwners = new Map(), committedFailures = new Set();
  const holds = new Set(), failures = new Set(), replies = new Map(), pending = new Map();
  const cwd = '/qa/synthetic/performance';
  const provider = { id: 'qa-provider', name: '隔离模型来源——验证长名称与编辑保存恢复', baseUrl: 'https://qa.invalid/v1', api: 'openai-completions', enabled: true, models: 1, mode: 'api-key', authConfigured: true, icon: '', modelsUrl: '' };
  const providerConfig = { providerId: provider.id, name: provider.name, baseUrl: provider.baseUrl, api: provider.api, apiKey: '', icon: '', modelsUrl: '' };
  const model = { id: 'qa-provider/qa-model', provider: provider.id, providerId: provider.id, model: 'qa-model', modelId: 'qa-model', name: '隔离测试模型', contextWindow: 128000, maxTokens: 8000, supportsImages: false, reasoning: false, thinkingLevels: [], origin: 'configured', deletable: true };
  const mcpNames = { A: '编辑 MCP A', B: '编辑 MCP B' };
  const mcpConfig = name => ({ name, transport: 'http', command: '', args: ['a path with spaces', '--flag'], cwd: '', url: `https://qa.invalid/mcp/${name.endsWith('A') ? 'A' : 'B'}`, description: '只使用内存模拟连接，不发送网络请求', env: '', headers: 'Authorization=', exposure: 'deferred', timeoutSeconds: 60, toolExposure: {} });
  const mcpConfigs = new Map(Object.values(mcpNames).map(name => [name, mcpConfig(name)]));
  const servers = Object.values(mcpNames).map(name => ({ ...mcpConfig(name), enabled: true, target: mcpConfig(name).url, envKeys: [], headerKeys: ['Authorization'], connected: false, toolCount: 0, tools: [], error: '', stderr: '' }));
  let customModels = [{ ...model }], serial = 0;
  const settings = async () => ({ ...(await base.settings()), providers: [clone(provider)], customModels: clone(customModels), enabledModels: [model.id], mcp: clone(servers), skills: [], skillErrors: [], extensions: [], extensionErrors: [], extensionRegistryUrl: '' });
  const models = () => ({ models: [clone(model)], enabled: [model.id], selection: { modelRef: model.id, label: model.name, thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' }, defaultSelection: { modelRef: model.id, label: model.name, thinkingLevel: 'default', thinkingLevels: ['default'], effectiveThinkingLevel: 'off' } });
  const key = (method, scope = '') => `${method}:${scope}`;
  async function respond(method, scope = '', fallback, payload) {
    const id = key(method, scope), failed = failures.delete(id), response = clone(replies.has(id) ? replies.get(id) : fallback); replies.delete(id);
    calls.push({ method, scope, failed, held: holds.has(id), payload: clone(payload) });
    if (holds.has(id)) await new Promise(resolve => { const list = pending.get(id) || []; list.push(resolve); pending.set(id, list); });
    if (failed) throw new Error(`QA ${method} ${scope} 失败，请重试`);
    return response;
  }
  const preview = () => ({ token: `qa-token-${++serial}`, scope: 'user', id: 'qa-editor-extension', name: '隔离扩展安装验证——长名称和来源完整展示', version: '1.0.0', publisher: 'QA publisher', description: '纯模拟预览，不写入真实扩展目录，不执行代码。', permissions: [], providerAccess: [], requires: [], addedRequirements: [], missingDependencies: [], addedPermissions: [], addedProviderAccess: [], executable: false, executableExpansion: false, sourceKind: 'local-directory', source: '/qa/很长的隔离扩展开发目录用于验证窄窗口完整路径显示/resource-editor-extension', resolvedRef: null, archiveSha256: null, treeSha256: 'a'.repeat(64), integrityFileSha256: 'b'.repeat(64), signatureStatus: 'unsigned', publisherTrust: 'not-applicable', requiresPublisherTrust: false, upgrade: false, alreadyInstalled: false, requiresPermissionConsent: false, requiresCapabilityConsent: false });
  const testResult = (label = 'OLD_TEST_RESULT') => ({ ok: true, durationMs: 12, instructions: label, capabilities: { tools: true, resources: false, prompts: false }, tools: [], resources: [], prompts: [], stderr: '' });
  window.__resourceEditorsQa = {
    calls, provider: clone(provider), mcpNames, testResult, preview,
    receiptTokens() { return [...receipts.keys()]; },
    async projection() { return { settings: await settings(), models: models() }; },
    openMain() { for (const listener of mainListeners) listener(); },
    commitError(method) { committedFailures.add(method); },
    hold(method, scope = '') { holds.add(key(method, scope)); },
    fail(method, scope = '') { failures.add(key(method, scope)); },
    reply(method, value, scope = '') { replies.set(key(method, scope), clone(value)); },
    pending(method, scope = '') { return pending.get(key(method, scope))?.length || 0; },
    release(method, scope = '') { const id = key(method, scope); holds.delete(id); for (const resolve of pending.get(id) || []) resolve(); pending.delete(id); },
  };
  window.piApi = new Proxy({
    state: async () => { const value = await base.state(); value.workspaces.push({ cwd: '/qa/synthetic/second', name: '第二个隔离工作区', sessions: [] }); return respond('state', '', value); },
    settings: async target => respond('settings', '', await settings(), { cwd: target }),
    models: async () => respond('models', '', models()),
    refreshModels: async target => respond('refreshModels', '', { settings: await settings(), models: models() }, { cwd: target }),
    onOpenMain: listener => { mainListeners.add(listener); return () => mainListeners.delete(listener); },
    providerConfig: async id => respond('providerConfig', id, providerConfig),
    providerModels: async id => respond('providerModels', id, { models: [clone(model)] }),
    addProvider: async payload => { const result = await respond('addProvider', '', { committed: true, projection: { status: 'ready', value: { settings: await settings(), models: models() } } }, payload); Object.assign(providerConfig, payload); Object.assign(provider, { name: payload.name, baseUrl: payload.baseUrl }); if (result.projection.status === 'ready') result.projection.value.settings = await settings(); return result; },
    addCustomModel: async payload => { const value = await respond('addCustomModel', '', { committed: true, projection: { status: 'ready', value: { settings: await settings(), models: models() } } }, payload); customModels = [{ ...model, ...payload }]; return value; },
    mcpConfig: async name => respond('mcpConfig', name, mcpConfigs.get(name)),
    testMcp: async payload => respond('testMcp', '', testResult(), payload),
    addMcp: async payload => {
      if (!failures.has(key('addMcp'))) {
        const original = payload.originalName || payload.name;
        const saved = { ...mcpConfigs.get(original), ...clone(payload), headers: payload.clearHeaders ? '' : 'Authorization=', env: '' };
        mcpConfigs.delete(original); mcpConfigs.set(payload.name, saved);
        const index = servers.findIndex(item => item.name === original);
        const server = { ...(servers[index] || {}), ...saved, target: saved.url || saved.command, headerKeys: payload.clearHeaders ? [] : ['Authorization'] };
        if (index >= 0) servers.splice(index, 1, server); else servers.push(server);
      }
      return respond('addMcp', '', { committed: true, projection: committedFailures.delete('addMcp') ? { status: 'error', message: 'QA MCP 已保存，主进程投影刷新失败' } : { status: 'ready', value: await settings() } }, payload);
    },
    refreshMcp: async target => respond('refreshMcp', '', await settings(), { cwd: target }),
    addSkill: async payload => respond('addSkill', '', { committed: true, projection: committedFailures.delete('addSkill') ? { status: 'error', message: 'QA 技能已导入，主进程投影刷新失败' } : { status: 'ready', value: await settings() } }, payload),
    refreshSkills: async target => respond('refreshSkills', '', await settings(), { cwd: target }),
    skillHub: async () => ({ refreshedAt: 1780000000000, sources: [], catalogs: [] }),
    officialExtensions: async () => ({ extensions: [], errors: [] }),
    extensionPublisherTrust: async () => ({ schemaVersion: 1, publishers: [] }),
    pickExtensionSource: async kind => respond('pickExtensionSource', '', '/qa/很长的隔离扩展开发目录用于验证窄窗口完整路径显示/resource-editor-extension', { kind }),
    prepareExtensionInstall: async payload => { const next = await respond('prepareExtensionInstall', '', { ...preview(), scope: payload.scope }, payload); previewOwners.set(next.token, { scope: next.scope, cwd: payload.cwd }); return next; },
    disposeExtensionInstall: async token => respond('disposeExtensionInstall', token, { ok: true }, { token }),
    installExtension: async payload => {
      const owner = previewOwners.get(payload.token); if (!owner || owner.scope !== payload.scope || owner.cwd !== payload.cwd) throw new Error('QA install owner mismatch');
      const result = await respond('installExtension', '', { committed: true, installed: { id: 'qa-editor-extension', version: '1.0.0', contentChanged: true, trustRevoked: false }, projection: committedFailures.delete('installExtension') ? { status: 'error', message: 'QA 扩展已安装，主进程投影刷新失败' } : { status: 'ready', value: await settings() }, recoveryToken: `qa-receipt-${++serial}` }, payload);
      receipts.set(result.recoveryToken, { owner: clone(owner), result: clone(result) }); previewOwners.delete(payload.token); return result;
    },
    refreshExtensionInstall: async token => { const receipt = receipts.get(token); if (!receipt) throw new Error('QA recovery receipt missing'); return respond('refreshExtensionInstall', token, { ...receipt.result, projection: { status: 'ready', value: await settings() } }, { token, scope: receipt.owner.scope, cwd: receipt.owner.cwd }); },
    disposeExtensionInstallRecovery: async token => { await respond('disposeExtensionInstallRecovery', token, undefined, { token }); receipts.delete(token); },
    conversationSubmit: async () => { throw new Error('Resource editors QA cannot send model requests'); },
  }, { get(target, property) { return property in target ? target[property] : base[property]; } });
}
