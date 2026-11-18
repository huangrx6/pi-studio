/** Resource DTOs and controlled promises only; no real files, configuration or model requests. */
export function installResourceDetailsFixture() {
  const base = window.piApi;
  const clone = value => JSON.parse(JSON.stringify(value));
  const calls = [], holds = new Set(), failures = new Set(), persistentFailures = new Set(), pending = new Map();
  const workspaceA = '/qa/synthetic/performance', workspaceB = '/qa/synthetic/resource-details-b';
  const openListeners = new Set(), stoppedPids = new Set();
  const roots = { A: '/qa/resources/技能-A', B: '/qa/resources/很长的项目技能目录用于验证窄窗口路径换行与范围归属/技能-B' };
  const names = { A: '资源技能 A', B: '资源技能 B——跨工作区发布审查与长名称可读性验证' };
  const skills = Object.entries(roots).map(([scope, baseDir]) => ({ name: names[scope], description: `仅用于隔离 QA 的 ${scope} 技能。检查目录、文件和迟到响应是否属于当前资源。`, baseDir, path: `${baseDir}/SKILL.md`, scope: scope === 'A' ? 'user' : 'project', origin: 'studio', available: true, trusted: true, trustChanged: false, disableModelInvocation: scope === 'B' }));
  const permissionless = {
    id: 'qa.permissionless-runtime', name: '零声明权限的可执行扩展——长名称与技术信息按需展开验证', version: '2.0.0', scope: 'user', tier: 'user', source: '/qa/extensions/长路径用于验证技术信息断行/permissionless',
    manifest: { format: 1, id: 'qa.permissionless-runtime', name: '零声明权限的可执行扩展', version: '2.0.0', description: '没有声明扩展权限，但明确包含主进程 Node 入口。', author: 'QA Publisher', permissions: [], runtime: { durableEntry: './index.cjs' }, contributes: { tools: [], commands: [], panels: [], settings: [], composer: [], dataSources: [] } },
    enabled: true, trusted: true, contentHash: 'abcdef0123456789'.repeat(4), installedAt: 1780000000000, updatedAt: 1780000100000, runtimeName: 'qa.permissionless-runtime', runtimeNames: ['qa.permissionless-runtime'], available: true, health: 'ready', blockedReason: '', requirements: [], dependents: [], activeDependents: [], missingDependencies: [], disabledDependencies: [], untrustedDependencies: [], unavailableDependencies: [], cycleDependencies: [], canDisable: true, canRemove: true, disableBlockedReason: '', removeBlockedReason: '', manageBlockedReason: '', commandIds: [], panelIds: [], dataSourceIds: [],
    installation: { managed: true, version: '2.0.0', activeCodePath: '/qa/managed/code', dataPath: '/qa/managed/data', sha256: '1234567890abcdef'.repeat(4), source: '/qa/managed/很长的发行来源路径/permissionless-extension.tar.gz', sourceKind: 'file', resolvedRef: null, publisher: 'QA Publisher', activeHistoryIndex: 0, canRollback: true, versions: [{ version: '2.0.0', sourceKind: 'file', activatedAt: 1780000100000, active: true }, { version: '1.0.0', sourceKind: 'file', activatedAt: 1780000000000, active: false }] },
  };
  const restricted = { ...clone(permissionless), id: 'qa.project-runtime', name: '项目扩展与依赖状态', scope: 'project', tier: 'project', trusted: false, available: false, health: 'untrusted', blockedReason: '项目扩展尚未信任，主进程代码不会加载。', manifest: { ...clone(permissionless.manifest), id: 'qa.project-runtime', permissions: ['network', 'agent.tools'] }, installation: undefined };
  const keyFor = (method, scope, target = '') => `${method}\u0000${scope}\u0000${target}`;
  const scopeFor = cwd => Object.keys(roots).find(scope => roots[scope] === cwd) || cwd;
  async function respond(method, scope, target, value) {
    const key = keyFor(method, scope, target); calls.push({ method, scope, target, at: Date.now() });
    const failure = failures.delete(key) || persistentFailures.has(key); calls.at(-1).failure = failure; calls.at(-1).held = holds.has(key);
    if (holds.has(key)) await new Promise(resolve => { const list = pending.get(key) || []; list.push(resolve); pending.set(key, list); });
    if (failure) throw new Error(`QA ${scope} ${method} ${target || '根目录'} 失败`);
    return clone(value);
  }
  window.__resourceDetailsQa = {
    calls, roots, names, extensionName: permissionless.name,
    open(id) { for (const listener of openListeners) listener({ id, cwd: id === 'perf-1' ? workspaceB : workspaceA }); },
    visibility(hidden) { Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')); },
    hold(method, scope, target = '') { holds.add(keyFor(method, scope, target)); },
    fail(method, scope, target = '') { failures.add(keyFor(method, scope, target)); },
    failUntilClear(method, scope, target = '') { persistentFailures.add(keyFor(method, scope, target)); },
    clearFailure(method, scope, target = '') { persistentFailures.delete(keyFor(method, scope, target)); },
    pending(method, scope, target = '') { return pending.get(keyFor(method, scope, target))?.length || 0; },
    release(method, scope, target = '') { const key = keyFor(method, scope, target); holds.delete(key); for (const resolve of pending.get(key) || []) resolve(); pending.delete(key); },
  };
  const file = (scope, target) => ({ path: target, name: target.split('/').at(-1), size: 180, mimeType: target.endsWith('.bin') ? 'application/octet-stream' : 'text/markdown', kind: target.endsWith('.bin') ? 'binary' : 'text', text: target.endsWith('.bin') ? undefined : `# ${scope} ${target}\n\n${scope}_ONLY_CONTENT：该内容只能出现在资源 ${scope} 详情。\n\n保持清晰的阅读节奏与错误恢复路径。` });
  const session = async id => ({ ...(await base.conversationSnapshot(id)), cwd: id === 'perf-1' ? workspaceB : workspaceA });
  const serviceSnapshot = scope => {
    const pid = scope === 'A' ? 41001 : 42001, firstPort = scope === 'A' ? 43001 : 44001;
    const make = (port, processId, ownership) => ({ id: `${scope}:${port}`, port, protocol: 'tcp', address: `127.0.0.1:${port}`, host: '127.0.0.1', scope: 'local', url: `http://127.0.0.1:${port}`, pid: processId, processName: `${scope}-service`, command: `${scope}-fixture-server`, cwd: scope === 'A' ? workspaceA : workspaceB, elapsedSeconds: 120, startedAt: 1780000000000 + processId, ownership, canStop: true, stopBlockedReason: '', evidence: [`${scope} scope fixture`], firstObservedAt: 1780000000000, isNew: false });
    const services = [make(firstPort, pid, 'workspace'), make(firstPort + 1, pid, 'workspace'), make(45001, 45001, 'other')].filter(item => !stoppedPids.has(item.pid));
    return { scannedAt: Date.now(), supported: true, warning: '', services, summary: { total: services.length, related: services.filter(item => item.ownership === 'workspace').length, agent: 0, workspace: services.filter(item => item.ownership === 'workspace').length, other: services.filter(item => item.ownership === 'other').length } };
  };
  window.piApi = new Proxy({
    state: async () => { const state = clone(await base.state()); const sessions = state.workspaces[0].sessions; state.workspaces[0].sessions = sessions.filter(item => item.id === 'perf-0'); state.workspaces.push({ cwd: workspaceB, name: '资源工作区 B', sessions: sessions.filter(item => item.id === 'perf-1').map(item => ({ ...item, cwd: workspaceB })) }); return state; },
    conversationPage: async input => ({ ...(await base.conversationPage(input)), cwd: input.id === 'perf-1' ? workspaceB : workspaceA }),
    conversationSnapshot: session, subscribeConversation: session,
    onOpenSession: listener => { openListeners.add(listener); return () => openListeners.delete(listener); },
    runtimeServices: async input => { calls.push({ method: 'runtimeServicesPayload', ...input }); const scope = input.cwd === workspaceB ? 'B' : 'A'; return respond('runtimeServices', scope, '', serviceSnapshot(scope)); },
    runtimeServiceStop: async input => { calls.push({ method: 'runtimeServiceStopPayload', ...input }); const scope = input.pid === 42001 ? 'B' : 'A'; await respond('runtimeServiceStop', scope, String(input.pid), { ok: true }); stoppedPids.add(input.pid); return { ok: true, pid: input.pid, port: input.port, affectedPorts: input.pid === 41001 ? [43001, 43002] : [44001, 44002], forced: false }; },
    settings: async () => ({ ...(await base.settings()), skills: clone(skills), skillErrors: [], skillsPath: '/qa/resources', agentsSkillsPath: '', projectSkillsPath: '/qa/project/.pi-studio/skills', projectAgentsSkillsPath: '', extensions: clone([permissionless, restricted]), extensionErrors: [], extensionRegistryUrl: '' }),
    skillHub: async () => ({ refreshedAt: 1780000000000, sources: [], catalogs: [] }),
    officialExtensions: async () => ({ extensions: [], errors: [], updatedAt: 1780000000000 }),
    extensionPublisherTrust: async () => ({ publishers: [] }),
    files: async (cwd, target = '') => { const scope = scopeFor(cwd); const entries = target ? [{ name: `${scope}-nested.md`, path: `${target}/${scope}-nested.md`, type: 'file', size: 180 }] : [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file', size: 180 }, { name: `${scope}-only`, path: `${scope}-only`, type: 'directory' }, { name: 'notes.md', path: 'notes.md', type: 'file', size: 180 }, { name: 'artifact.bin', path: 'artifact.bin', type: 'file', size: 24 }]; return respond('files', scope, target, { path: target, entries }); },
    filePreview: async (cwd, target) => respond('filePreview', scopeFor(cwd), target, file(scopeFor(cwd), target)),
    openWith: async input => respond('openWith', scopeFor(input.cwd), input.path, { ok: true }),
    setSkillTrusted: async () => { throw new Error('Resource details QA must not change trust'); },
    removeSkill: async () => { throw new Error('Resource details QA must not remove skills'); },
    rollbackExtension: async () => { throw new Error('Resource details QA must not roll back extensions'); },
    conversationSubmit: async () => { calls.push({ method: 'conversationSubmit' }); throw new Error('Resource details QA must not submit model requests'); },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
