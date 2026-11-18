/** Synthetic settings over the browser-only history fixture. All mutations stay in memory. */
export function installSettingsResourcesFixture() {
  const base = window.piApi;
  const cwd = '/qa/synthetic/performance';
  const longProvider = '团队统一模型来源——用于验证跨项目发布审查与超长供应商名称在最小窗口中的布局';
  const longMcp = '发布检查服务——用于验证很长服务器名称和连接原因在最小窗口中清晰展示';
  const longSkill = '项目发布安全审查技能——覆盖跨工作区依赖审查、变更检查、文档完整性与发布前验证';
  const options = Array.from({ length: 350 }, (_, index) => ({ id: `qa/model-${index}`, model: `model-${index}`, provider: 'qa', providerName: longProvider, name: index === 0 ? '当前会话模型' : index === 1 ? '新的默认模型' : index === 349 ? '目录末端模型 0349' : `目录模型 ${String(index).padStart(4, '0')}`, contextWindow: 128000, maxTokens: 8192, supportsImages: true, reasoning: true, thinkingLevels: ['off', 'high'], origin: 'configured', deletable: true }));
  const providers = [{ id: 'qa', name: longProvider, mode: 'key', authConfigured: true, models: 350, enabled: true, builtin: false }, { id: 'missing', name: '缺少认证的来源', mode: 'env', authConfigured: false, envAvailable: false, envName: 'QA_MISSING_TOKEN', models: 1, enabled: true, builtin: false }];
  let enabled = ['qa/model-0', 'qa/model-1'];
  const selection = (modelRef, level = 'default') => ({ modelRef, label: options.find((item) => item.id === modelRef)?.name || modelRef, thinkingLevel: level, thinkingLevels: ['default', 'off', 'high'], effectiveThinkingLevel: level === 'default' ? 'off' : level, defaultThinkingLevel: 'off', supportsImages: true });
  let defaultSelection = selection('qa/model-0');
  const sessionSelection = selection('qa/model-0');
  const selectedDefault = () => ({ ...defaultSelection, ...(providers.find((item) => item.id === 'qa')?.enabled === false ? { unavailable: true, unavailableReason: '模型来源已停用，请先启用来源或选择其他模型。' } : {}) });
  const makeMcp = (name, extra) => ({ name, transport: 'stdio', enabled: true, target: '/qa/mock/no-process-started', cwd, description: '隔离 QA 数据，不启动 MCP 进程。', exposure: 'deferred', toolExposure: {}, timeoutSeconds: 60, envKeys: [], headerKeys: [], oauthConnected: false, connected: false, toolCount: 0, error: '', stderr: '', tools: [], ...extra });
  let mcp = [makeMcp('已停用服务', { enabled: false }), makeMcp('等待连接服务', {}), makeMcp(longMcp, { error: '无法建立连接：QA 模拟的连接失败原因。请检查连接参数后再由用户明确发起测试。' }), makeMcp('已连接零工具服务', { connected: true, toolCount: 0 })];
  const makeSkill = (name, scope, origin, id, extra) => ({ name, scope, origin, description: '用于核对已安装技能的来源、调用方式与信任状态。', path: `/qa/${scope}/${origin}/${id}/SKILL.md`, baseDir: `/qa/${scope}/${origin}/${id}`, bytes: 1000, version: '1.0.0', promptTokens: 250, resourceCount: 2, totalBytes: 2048, fingerprint: 'qa-hash', trusted: true, trustChanged: false, available: true, disableModelInvocation: false, warnings: [], ...extra });
  let skills = [makeSkill('显式调用技能', 'user', 'studio', 'explicit', { disableModelInvocation: true }), makeSkill('用户共享技能', 'user', 'agents', 'shared', {}), makeSkill(longSkill, 'project', 'studio', 'changed', { trusted: false, trustChanged: true, available: false }), makeSkill('待信任项目共享技能', 'project', 'agents', 'untrusted', { trusted: false, available: false }), makeSkill('可用项目技能', 'project', 'studio', 'trusted', {})];
  let marketplaceEnabled = false, skillTokenSerial = 0;
  const skillTokens = new Map();
  const marketSource = { id: 'qa-market', name: '隔离本地技能源', type: 'directory', location: '/qa/synthetic/market', enabled: true, itemCount: 1, lastError: '', createdAt: 1, updatedAt: 1 };
  const marketItem = { id: 'qa-market/item', listingId: 'market-item', sourceId: marketSource.id, sourceName: marketSource.name, sourceType: 'directory', name: '市场安装恢复验证技能', description: '纯内存技能预览，不读取目录，不执行安装。', version: '1.0.0', invocation: 'explicit', repository: '', homepage: '', resourceCount: 1, totalBytes: 100, promptTokens: 20, installed: false, updateAvailable: false };
  const calls = [], holds = new Set(), failures = new Set(), committedErrors = new Set(), replies = new Map(), pending = new Map(), mainListeners = new Set(), sessionListeners = new Set();
  async function operation(method, payload, work, committed = false) {
    const failed = failures.delete(method), afterCommit = committedErrors.delete(method);
    calls.push({ method, ...structuredClone(payload), failed, afterCommit, held: holds.has(method) });
    let value;
    if (!failed) { const actual = work(); value = structuredClone(replies.has(method) ? replies.get(method) : committed ? { committed: true, projection: afterCommit ? { status: 'error', message: `QA ${method} 已完成，主进程投影刷新失败` } : { status: 'ready', value: actual } } : actual); }
    replies.delete(method);
    if (holds.has(method)) await new Promise(resolve => { const list = pending.get(method) || []; list.push(resolve); pending.set(method, list); });
    if (failed) throw new Error(`QA ${method} 写入或读取失败`);
    return value;
  }
  const snapshot = () => ({ providers: providers.map((item) => ({ ...item })), customModels: [], mcp: mcp.map((item) => ({ ...item })), skills: skills.map((item) => ({ ...item })), skillErrors: [{ path: '/qa/project/studio/unreadable/SKILL.md', message: 'QA 模拟技能解析诊断，路径应完整保留。' }], skillSources: [], extensions: [], officialExtensions: [], extensionErrors: [], extensionApiVersion: 1, extensionRegistryUrl: '', enabledModels: [...enabled], model: selectedDefault(), skillsPath: '/qa/user/studio', agentsSkillsPath: '/qa/user/agents', projectSkillsPath: '/qa/project/studio', projectAgentsSkillsPath: '/qa/project/agents', storagePath: '/qa/storage', databasePath: '/qa/storage/studio.sqlite', extensionsPath: '/qa/extensions', projectExtensionsPath: '/qa/project/extensions' });
  const catalog = () => ({ models: options.map(item => ({ ...item })), enabled: [...enabled], current: defaultSelection.modelRef, selection: selectedDefault(), defaultSelection: selectedDefault() });
  const modelSnapshot = () => ({ settings: snapshot(), models: catalog() });
  window.__settingsResourcesQa = { calls, longProvider, longMcp, longSkill, failNextTrust: false, failNextCatalog: true, forbidden: [],
    enableMarketplace() { marketplaceEnabled = true; },
    hold(method) { holds.add(method); }, fail(method) { failures.add(method); }, commitError(method) { committedErrors.add(method); },
    reply(method, value) { replies.set(method, structuredClone(value)); }, pending(method) { return pending.get(method)?.length || 0; },
    release(method) { holds.delete(method); for (const resolve of pending.get(method) || []) resolve(); pending.delete(method); },
    projection() { return modelSnapshot(); }, mcpProjection() { return snapshot(); }, openFirstSession() { for (const listener of sessionListeners) listener({ id: 'perf-0', cwd, title: '性能会话 0000' }); }, openSecondSession() { for (const listener of sessionListeners) listener({ id: 'perf-1', cwd: '/qa/synthetic/second', title: '性能会话 0001' }); }, openMain() { for (const listener of mainListeners) listener(); },
  };
  window.piApi = new Proxy({
    state: async () => { const value = await base.state(); const second = value.workspaces[0].sessions.find(item => item.id === 'perf-1'); value.workspaces[0].sessions = value.workspaces[0].sessions.filter(item => item.id !== 'perf-1'); value.workspaces.push({ cwd: '/qa/synthetic/second', name: '第二个隔离工作区', sessions: [{ ...second, cwd: '/qa/synthetic/second' }] }); return { ...value, model: selectedDefault() }; },
    settings: async targetCwd => operation('settings', { cwd: targetCwd }, snapshot),
    refreshModels: async targetCwd => operation('refreshModels', { cwd: targetCwd }, modelSnapshot),
    refreshMcp: async targetCwd => operation('refreshMcp', { cwd: targetCwd }, snapshot),
    refreshSkills: async targetCwd => operation('refreshSkills', { cwd: targetCwd }, snapshot),
    onOpenMain: listener => { mainListeners.add(listener); return () => mainListeners.delete(listener); },
    onOpenSession: listener => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
    models: async () => ({ models: options.map((item) => ({ ...item })), enabled: [...enabled], current: defaultSelection.modelRef, selection: selectedDefault(), defaultSelection: selectedDefault() }),
    conversationPage: async (request) => ({ ...(await base.conversationPage(request)), cwd: request.id === 'perf-1' ? '/qa/synthetic/second' : cwd, model: sessionSelection }),
    conversationSnapshot: async (id) => ({ ...(await base.conversationSnapshot(id)), cwd: id === 'perf-1' ? '/qa/synthetic/second' : cwd, model: sessionSelection }),
    subscribeConversation: async (id) => ({ ...(await base.subscribeConversation(id)), cwd: id === 'perf-1' ? '/qa/synthetic/second' : cwd, model: sessionSelection }),
    setDefaultModel: async (modelRef, targetCwd) => { calls.push({ method: 'setDefaultModel', modelRef, cwd: targetCwd }); defaultSelection = selection(modelRef); return selectedDefault(); },
    setDefaultThinkingLevel: async ({ level, cwd: targetCwd }) => { calls.push({ method: 'setDefaultThinkingLevel', level, cwd: targetCwd }); defaultSelection = selection(defaultSelection.modelRef, level); return selectedDefault(); },
    conversationConfigure: async (request) => { calls.push({ method: 'conversationConfigure', ...request }); throw new Error('Settings QA must not configure an existing conversation'); },
    providerModels: async (providerId) => { calls.push({ method: 'providerModels', providerId }); if (window.__settingsResourcesQa.failNextCatalog) { window.__settingsResourcesQa.failNextCatalog = false; throw new Error('QA 模拟目录暂时不可用'); } return { models: options.filter((item) => item.provider === providerId).map((item) => ({ ...item, enabled: enabled.includes(item.id) })) }; },
    providerConfig: async (providerId) => ({ providerId, name: providers.find((item) => item.id === providerId)?.name || providerId, baseUrl: 'https://qa.invalid/v1', api: 'openai-completions', apiKey: '', modelsUrl: '', icon: '' }),
    setEnabledModels: async request => operation('setEnabledModels', request, () => { enabled = [...request.models]; return modelSnapshot(); }, true),
    setProviderEnabled: async request => operation('setProviderEnabled', request, () => { providers.find(item => item.id === request.providerId).enabled = request.enabled; return modelSnapshot(); }, true),
    removeProvider: async request => operation('removeProvider', request, () => { const index = providers.findIndex(item => item.id === request.providerId); if (index >= 0) providers.splice(index, 1); for (let i = options.length - 1; i >= 0; i--) if (options[i].provider === request.providerId) options.splice(i, 1); enabled = enabled.filter(id => !id.startsWith(`${request.providerId}/`)); return modelSnapshot(); }, true),
    removeCustomModel: async request => operation('removeCustomModel', request, () => { const index = options.findIndex(item => item.provider === request.providerId && item.model === request.modelId); if (index >= 0) options.splice(index, 1); enabled = enabled.filter(id => id !== `${request.providerId}/${request.modelId}`); providers.find(item => item.id === request.providerId).models = options.filter(item => item.provider === request.providerId).length; return modelSnapshot(); }, true),
    discoverProviderModels: async (providerId) => { calls.push({ method: 'discoverProviderModels', providerId }); return { endpoint: 'https://qa.invalid/models', models: [{ id: 'model-0', name: '当前会话模型' }, { id: 'discovered-new', name: '发现的新模型' }, { id: 'discovered-other', name: '另一个发现模型' }] }; },
    importProviderModels: async request => operation('importProviderModels', request, () => { for (const model of request.models) if (!options.some(item => item.id === `${request.providerId}/${model.id}`)) options.push({ ...options[0], id: `${request.providerId}/${model.id}`, model: model.id, name: model.name }); enabled = [...new Set([...enabled, ...request.models.map(model => `${request.providerId}/${model.id}`)])]; providers[0].models = options.length; return modelSnapshot(); }, true),
    setMcpEnabled: async request => operation('setMcpEnabled', request, () => { mcp.find(item => item.name === request.name).enabled = request.enabled; return snapshot(); }, true),
    removeMcp: async (name, targetCwd) => operation('removeMcp', { name, cwd: targetCwd }, () => { mcp = mcp.filter(item => item.name !== name); return snapshot(); }, true),
    testMcp: async () => { window.__settingsResourcesQa.forbidden.push('testMcp'); throw new Error('QA must not start MCP connections'); },
    setSkillTrusted: async request => {
      if (window.__settingsResourcesQa.failNextTrust) { window.__settingsResourcesQa.failNextTrust = false; failures.add('setSkillTrusted'); }
      return operation('setSkillTrusted', request, () => { Object.assign(skills.find(item => item.path === request.path), { trusted: request.trusted, available: request.trusted, trustChanged: false }); return snapshot(); }, true);
    },
    removeSkill: async (skillPath, targetCwd) => operation('removeSkill', { path: skillPath, cwd: targetCwd }, () => { skills = skills.filter(item => item.path !== skillPath); return snapshot(); }, true),
    skillHub: async () => ({ refreshedAt: Date.now(), sources: marketplaceEnabled ? [marketSource] : [], catalogs: marketplaceEnabled ? [{ source: marketSource, items: [{ ...marketItem, installed: skills.some(item => item.name === marketItem.name), installedVersion: skills.some(item => item.name === marketItem.name) ? '1.0.0' : undefined }], diagnostics: [] }] : [] }),
    prepareSkillInstall: async request => operation('prepareSkillInstall', request, () => { const token = `qa-skill-token-${++skillTokenSerial}`; skillTokens.set(token, structuredClone(request)); return { ...marketItem, token, scope: request.scope, requiresTrust: request.scope === 'project', canUpdate: false, installedVersion: '', resourceCount: 1, totalBytes: 100, files: [{path:'SKILL.md',size:100}], sha256: 'a'.repeat(64) }; }),
    disposePreparedSkill: async token => { calls.push({method:'disposePreparedSkill',token}); skillTokens.delete(token); return {ok:true}; },
    files: async (_cwd, target) => ({ path: target || '', entries: [] }),
    installPreparedSkill: async request => {
      const owner = skillTokens.get(request.token); if (!owner || owner.cwd !== request.cwd) throw new Error('QA skill token owner mismatch');
      const installed = { name: marketItem.name, version: marketItem.version, scope: owner.scope, path: `/qa/${owner.scope}/studio/market-item/SKILL.md`, baseDir: `/qa/${owner.scope}/studio/market-item` };
      const result = await operation('installPreparedSkill', request, () => { skillTokens.delete(request.token); skills = skills.filter(item => item.path !== installed.path); skills.push(makeSkill(marketItem.name, owner.scope, 'studio', 'market-item', { trusted: owner.scope !== 'project', available: owner.scope !== 'project' })); return snapshot(); }, true);
      return { ...result, installed };
    },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
