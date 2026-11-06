/** Maintenance UI contracts only: updater/MCP calls stay in memory and never perform updates or connections. */
export function installMaintenanceFixture() {
  const base = window.piApi, clone = value => structuredClone(value);
  const calls = [], holds = new Set(['updateState:']), failures = new Set(), pending = new Map(), replies = new Map();
  const updateListeners = new Set(), openUpdateListeners = new Set();
  const names = { A: '维护 MCP A', B: '维护 MCP B——跨工作区发布审查与超长服务器名称的阅读和错误恢复验证', C: '已停用 MCP C' };
  const workspace = '/qa/synthetic/performance';
  let update = { currentVersion: '2.5.6', currentBuildId: '11111111111111111111111111111111', state: 'idle' };
  const available = { ...update, state: 'available', latestVersion: '2.5.6', latestBuildId: '22222222222222222222222222222222', updateKind: 'same-version', releaseName: '同版本构建更新与完整修复说明', releaseNotes: '修复终端历史恢复。\n完善资源详情的工作区归属与键盘使用。\n保留明确的失败恢复入口。', publishedAt: '2026-10-01T00:00:00Z' };
  const makeMcp = (scope, extra = {}) => ({ name: names[scope], transport: 'http', enabled: true, target: `https://qa.invalid/mcp/${scope}/很长的目标地址用于验证详情断行与作用域归属`, cwd: workspace, description: `内存模拟 ${scope}，不会启动进程或访问 HTTP/OAuth 服务。`, exposure: 'deferred', toolExposure: {}, timeoutSeconds: 60, envKeys: [], headerKeys: ['Authorization', 'X-QA-Key'], oauthConnected: false, connected: false, toolCount: 0, error: '', stderr: '', tools: [], ...extra });
  const servers = [makeMcp('A'), makeMcp('B', { error: 'QA B 尚未连接：需要检查服务地址。', stderr: 'QA_B_DIAGNOSTIC\nAuthorization: [REDACTED]' }), makeMcp('C', { transport: 'stdio', enabled: false, target: '/qa/很长的本地命令路径用于验证诊断与目录断行/maintenance-server', connected: false, error: '', stderr: 'QA_C_LAST_DIAGNOSTIC', headerKeys: [], envKeys: ['QA_ENV_NAME'] })];
  const settings = async () => ({ ...(await base.settings()), mcp: clone(servers), skills: [], skillErrors: [], extensions: [], extensionErrors: [], databasePath: '/qa/隔离数据/很长的数据库目录用于验证关于页面诊断信息换行/studio.sqlite', skillsPath: '/qa/隔离技能目录/无需读取真实磁盘', extensionsPath: '/qa/隔离扩展目录/无需读取真实磁盘' });
  const key = (method, scope = '') => `${method}:${scope}`;
  async function respond(method, scope, fallback) {
    const id = key(method, scope), failure = failures.delete(id), value = clone(replies.has(id) ? replies.get(id) : fallback);
    replies.delete(id); calls.push({ method, scope, failed: failure, held: holds.has(id) });
    if (holds.has(id)) await new Promise(resolve => { const list = pending.get(id) || []; list.push(resolve); pending.set(id, list); });
    if (failure) throw new Error(`QA ${method} ${scope} 失败，请重试`);
    return value;
  }
  const scopeFor = name => Object.keys(names).find(scope => names[scope] === name) || name;
  const testResult = scope => ({ ok: true, durationMs: 28, instructions: `${scope}_ONLY_TEST_RESULT`, capabilities: { tools: true, resources: true, prompts: false }, tools: [{ name: `${scope}_tool`, title: `${scope} tool`, description: `${scope} 仅属于当前服务器的工具`, argumentCount: 1, requiredCount: 1, exposure: 'deferred' }], resources: [{ uri: `qa://${scope}/resource`, name: `${scope} resource`, mimeType: 'text/plain' }], prompts: [], stderr: `${scope}_ONLY_TEST_DIAGNOSTIC` });
  window.__maintenanceQa = {
    calls, names, available: clone(available),
    hold(method, scope = '') { holds.add(key(method, scope)); },
    fail(method, scope = '') { failures.add(key(method, scope)); },
    reply(method, value, scope = '') { replies.set(key(method, scope), clone(value)); },
    pending(method, scope = '') { return pending.get(key(method, scope))?.length || 0; },
    release(method, scope = '') { const id = key(method, scope); holds.delete(id); for (const resolve of pending.get(id) || []) resolve(); pending.delete(id); },
    emit(patch) { update = { ...update, ...clone(patch) }; for (const listener of updateListeners) listener(clone(update)); },
    openUpdate() { for (const listener of openUpdateListeners) listener(); },
    testResult,
  };
  window.piApi = new Proxy({
    settings: async () => respond('settings', '', await settings()),
    refreshMcp: async cwd => { calls.push({ method: 'refreshMcpScope', cwd }); return respond('refreshMcp', '', await settings()); },
    updateState: async () => respond('updateState', '', update),
    onUpdateState: listener => { updateListeners.add(listener); return () => updateListeners.delete(listener); },
    onOpenUpdate: listener => { openUpdateListeners.add(listener); return () => openUpdateListeners.delete(listener); },
    checkForUpdates: async options => { calls.push({ method: 'checkOptions', ...options }); return respond('checkForUpdates', '', available); },
    downloadUpdate: async () => respond('downloadUpdate', '', { ...available, state: 'downloading', progress: 0 }),
    installUpdate: async () => respond('installUpdate', '', { started: true }),
    testSavedMcp: async name => respond('testSavedMcp', scopeFor(name), testResult(scopeFor(name))),
    startMcpOAuth: async (name, cwd) => { const scope = scopeFor(name); calls.push({ method: 'oauthScope', action: 'start', name, cwd }); const value = await respond('startMcpOAuth', scope, null); Object.assign(servers.find(item => item.name === name), { oauthConnected: true, connected: true, error: '' }); return value || { committed: true, projection: { status: 'ready', value: await settings() } }; },
    logoutMcpOAuth: async (name, cwd) => { const scope = scopeFor(name); calls.push({ method: 'oauthScope', action: 'logout', name, cwd }); const value = await respond('logoutMcpOAuth', scope, null); Object.assign(servers.find(item => item.name === name), { oauthConnected: false, connected: false }); return value || { committed: true, projection: { status: 'ready', value: await settings() } }; },
    openExternal: async url => { calls.push({ method: 'openExternal', url }); return { ok: true }; },
    conversationSubmit: async () => { calls.push({ method: 'conversationSubmit' }); throw new Error('Maintenance QA must not submit model requests'); },
  }, { get(target, property) { return property in target ? target[property] : base[property]; } });
}
