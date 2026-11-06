/** Browser-only execution settings, no permission engine/process/user data writes. */
export function installSettingsExecutionFixture() {
  const base = window.piApi;
  const a = '/qa/synthetic/performance'; const b = '/qa/synthetic/execution-b';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const calls = []; const pending = {}; const holds = {}; const failures = {}; const openListeners = new Set();
  const qa = window.__settingsExecutionQa = {
    calls, forbidden: [], toolRefreshFailureNext: false, longSource: '团队发布审查工具来源——跨工作区依赖检查、运行验证与文档审查工具集合',
    hold: (method, key = true) => { holds[method] = key; },
    fail: (method) => { failures[method] = true; },
    pending: (method) => pending[method]?.length || 0,
    release: (method) => { delete holds[method]; for (const item of (pending[method] || []).splice(0)) item.resolve(); },
    reject: (method) => { delete holds[method]; for (const item of (pending[method] || []).splice(0)) item.reject(new Error(`QA ${method} 延迟保存失败，请重试`)); },
    open: (id) => { for (const listener of openListeners) listener({ id, cwd: id === 'perf-1' ? b : a }); },
  };
  async function respond(method, value, key) {
    const captured = clone(value);
    if (failures[method]) { delete failures[method]; throw new Error(`QA ${method} 保存失败，请重试`); }
    if (holds[method] === true || holds[method] === key) await new Promise((resolve, reject) => (pending[method] ??= []).push({ resolve, reject }));
    return captured;
  }
  const policy = (preset = 'smart', decision = 'ask', label = '全局安全规则') => ({ version: 1, preset, default: decision, tools: { read: 'allow' }, rules: [{ id: 'protect', label, decision: 'deny', match: { tool: 'write', pathGlob: '**/.env*' } }] });
  let globalPolicy = policy();
  const workspacePolicies = { [a]: null, [b]: policy('ask', 'deny', '工作区 B 独立规则') };
  const sessionPolicies = {};
  function permissions(cwd = a, sessionId = '') {
    const workspace = workspacePolicies[cwd] || null; const session = sessionPolicies[sessionId] || null;
    return clone({ available: true, mode: (session || workspace || globalPolicy).preset, effectivePolicy: session || workspace || globalPolicy, effectiveScope: session ? 'session' : workspace ? 'workspace' : 'user', layers: [{ scope: 'user', policy: globalPolicy }, ...(workspace ? [{ scope: 'workspace', policy: workspace }] : []), ...(session ? [{ scope: 'session', policy: session }] : [])], cwd, sessionId, scopes: { user: globalPolicy, workspace, session }, catalog: { modes: [{ id: 'ask', label: '每次询问', description: '未命中规则时询问。', defaultDecision: 'ask' }, { id: 'smart', label: '帮我批准', description: '低风险操作允许，其他操作询问。', defaultDecision: 'ask' }, { id: 'full', label: '完全权限', description: '普通操作允许，仍保留明确规则。', defaultDecision: 'allow' }], decisions: [{ id: 'allow', label: '允许' }, { id: 'ask', label: '询问' }, { id: 'deny', label: '拒绝' }], decisionsAreValid: ['allow', 'ask', 'deny'], presetDefaults: { ask: 'ask', smart: 'ask', full: 'allow' } }, path: '/qa/storage/studio.sqlite' });
  }
  const sections = ['preamble', 'tools', 'rules', 'repositoryDocs', 'projectContext', 'skills', 'cwd', 'addendum'].map((id, index) => ({ id, label: ['前言', '工具', '规则', '仓库文档', '项目上下文', '技能', '工作目录', '附加说明'][index], description: `QA ${id} section` }));
  const runtime = { version: 1, streamTimeoutMs: 120000, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 }, compaction: { enabled: true, reserveTokens: 12000, keepRecentTokens: 10000, backgroundTokens: 2000, autoCompactPercent: 80 }, toolExecution: 'parallel', afterFailedRun: 'keep', restartLimit: 3, longTask: { maxContinuations: 20, maxStalledContinuations: 3 }, contextRetentionMs: 300000, documentRetentionMs: 600000 };
  const makeProfile = (id, name, builtin, text) => ({ id, name, builtin, sections: Object.fromEntries(sections.map(({ id }) => [id, true])), sectionOverrides: {}, customInstructions: text, toolGuidance: { read: '读取前先检查目标路径。' } });
  const profileNames = ['Studio 基线', '团队审查配置——覆盖长名称展示、跨项目审查与运行验证'];
  const profiles = [makeProfile('studio', profileNames[0], true, '保留清晰的验证记录。'), makeProfile('review', profileNames[1], false, '审查模式原始指令。')];
  let runtimePolicy = clone(runtime); let globalProfileId = 'studio'; const workspaceProfiles = { [a]: '', [b]: 'review' };
  function harness(cwd = a) {
    const active = workspaceProfiles[cwd] || globalProfileId;
    return clone({ version: 1, activeProfileId: active, globalProfileId, workspaceProfileId: workspaceProfiles[cwd] || '', sections, profiles, activeProfile: profiles.find((item) => item.id === active), path: '/qa/storage/studio.sqlite', globalInstructionsPath: '/qa/user/AGENTS.md', globalInstructionsStatus: 'missing', runtimePolicy, runtimePolicyDefaults: runtime, runtimePolicyPath: '/qa/storage/studio.sqlite' });
  }
  const core = { key: 'core', source: 'core', label: '核心工具', kind: 'core', scope: 'builtin', path: '', baseDir: '' };
  const extension = { key: 'qa-extension', source: 'npm:qa-release', label: qa.longSource, kind: 'extension', scope: 'workspace', path: '/qa/extensions/release/index.cjs', baseDir: '/qa/extensions/release' };
  const toolCatalog = { tools: [{ name: 'read', description: '读取文件', exposure: 'direct', source: core }, { name: 'write', description: '写入文件', exposure: 'direct', source: core }, { name: 'mcp__qa__search', description: '搜索发布记录', exposure: 'deferred', source: extension }, { name: 'mcp__qa__inspect', description: '审查发布候选及相关验证记录', exposure: 'deferred', source: extension }], commands: [{ name: 'release-review', description: '只读命令入口，生命周期由扩展控制。', source: extension }], errors: [], warnings: [], storage: '/qa/storage/studio.sqlite', refreshedAt: Date.now() };
  let toolSelection = { enabled: ['read', 'mcp__qa__*', 'missing_old_tool'], sources: { missing_old_tool: { source: 'npm:uninstalled-release', label: '已卸载的发布扩展', scope: 'user', path: '/qa/removed', baseDir: '/qa/removed' } } };
  async function settings(cwd = a) { return { ...(await base.settings()), providers: [], enabledModels: [], extensions: [], extensionErrors: [], skillErrors: [], agentTools: clone(toolSelection), harness: harness(cwd), skillsPath: '/qa/skills', agentsSkillsPath: '/qa/shared', projectSkillsPath: '/qa/project-skills', projectAgentsSkillsPath: '/qa/project-shared' }; }
  window.piApi = new Proxy({
    state: async () => { const result = await base.state(); result.workspaces[0].sessions[1].cwd = b; return { ...result, workspaces: [{ cwd: a, name: '执行设置 A', sessions: [result.workspaces[0].sessions[0]] }, { cwd: b, name: '执行设置 B', sessions: [result.workspaces[0].sessions[1]] }] }; },
    settings: async (cwd) => clone(await settings(cwd)),
    onOpenSession: (listener) => { openListeners.add(listener); return () => openListeners.delete(listener); },
    modeGet: async (input) => { calls.push({ method: 'modeGet', ...input }); return respond('modeGet', permissions(input?.cwd, input?.sessionId), input?.cwd); },
    permissionPolicyGet: async (input) => { calls.push({ method: 'permissionPolicyGet', ...input }); return respond('permissionPolicyGet', permissions(input?.cwd, input?.sessionId), input?.cwd); },
    permissionPolicySet: async (input) => { calls.push({ method: 'permissionPolicySet', ...clone(input) }); await respond('permissionPolicySet', {}, input.scope); if (input.scope === 'user') globalPolicy = clone(input.policy); else if (input.scope === 'workspace') workspacePolicies[input.cwd] = clone(input.policy); else sessionPolicies[input.sessionId] = clone(input.policy); return permissions(input.cwd, input.sessionId); },
    permissionPolicyReset: async (input) => { calls.push({ method: 'permissionPolicyReset', ...input }); if (input.scope === 'user') globalPolicy = policy(); else if (input.scope === 'workspace') workspacePolicies[input.cwd] = null; else sessionPolicies[input.sessionId] = null; return permissions(input.cwd, input.sessionId); },
    permissionEvaluate: async (input) => { calls.push({ method: 'permissionEvaluate', ...clone(input) }); return respond('permissionEvaluate', { decision: input.policy.default, explanation: `QA 未保存草稿预览 ${input.scope}`, previewScope: input.scope, matches: [], risk: { level: 'low', title: '只做模拟预览', detail: '没有执行工具或命令。' }, context: { tool: input.call.name, command: input.call.arguments.command || '' }, rememberScopes: [], cwd: input.cwd, sessionId: input.sessionId }, input.scope); },
    listSecrets: async () => [],
    harnessSettings: async (cwd) => { calls.push({ method: 'harnessSettings', cwd }); return respond('harnessSettings', harness(cwd), cwd); },
    saveHarnessProfile: async (input) => { calls.push({ method: 'saveHarnessProfile', ...clone(input) }); await respond('saveHarnessProfile', {}, input.cwd); const index = profiles.findIndex((item) => item.id === input.profile.id); if (index < 0) profiles.push(clone(input.profile)); else profiles[index] = clone(input.profile); return harness(input.cwd); },
    selectHarnessProfile: async (input) => { calls.push({ method: 'selectHarnessProfile', ...input }); if (input.scope === 'global') globalProfileId = input.id; else workspaceProfiles[input.cwd] = input.id; return harness(input.cwd); },
    saveRuntimePolicy: async (input) => { calls.push({ method: 'saveRuntimePolicy', ...clone(input) }); await respond('saveRuntimePolicy', {}, input.cwd); runtimePolicy = clone(input.policy); return harness(input.cwd); },
    resetHarnessProfile: async (input) => { calls.push({ method: 'resetHarnessProfile', ...input }); return harness(input.cwd); },
    agentToolCatalog: async (input) => { calls.push({ method: 'agentToolCatalog', ...input }); return respond('agentToolCatalog', input?.cwd === b ? { ...toolCatalog, tools: [...toolCatalog.tools.filter((item) => item.source.kind === 'core'), { name: 'workspace_b_tool', description: 'B 工作区来源工具', exposure: 'direct', source: { ...extension, label: 'B 工作区专用工具来源' } }] } : toolCatalog, input?.cwd); },
    setAgentTools: async (input) => { calls.push({ method: 'setAgentTools', ...clone(input) }); await respond('setAgentTools', {}, input.cwd); toolSelection = clone(input.tools); const value = clone(await settings(input.cwd)); if (qa.toolRefreshFailureNext) { qa.toolRefreshFailureNext = false; value.runtimeRefresh = { status: 'error', failedSessions: 1, pendingSessions: 0, errors: ['QA 运行时暂未应用工具配置'] }; } return value; },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
