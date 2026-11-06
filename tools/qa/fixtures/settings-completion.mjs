/** Browser-only settings completion fixture. Every write stays in memory. */
export function installSettingsCompletionFixture() {
  const base = window.piApi;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const a = '/qa/synthetic/performance'; const b = '/qa/synthetic/execution-b';
  const calls = []; const holds = {}; const pending = {}; const failures = {};
  const mainListeners = new Set(); const settingsListeners = new Set();
  const qa = window.__settingsCompletionQa = {
    calls, zeroUsage: false,
    hold(method, key = true) { holds[method] = key; },
    fail(method) { failures[method] = true; },
    pending(method) { return pending[method]?.length || 0; },
    release(method) { delete holds[method]; for (const item of (pending[method] || []).splice(0)) item.resolve(); },
    reject(method) { delete holds[method]; for (const item of (pending[method] || []).splice(0)) item.reject(new Error(`QA ${method} delayed failure`)); },
    open(id) { window.__settingsExecutionQa.open(id); },
    openMain() { for (const listener of mainListeners) listener(); },
    openSettings() { for (const listener of settingsListeners) listener(); },
  };
  async function respond(method, value, key) {
    const captured = clone(value);
    if (failures[method]) { delete failures[method]; throw new Error(`QA ${method} synthetic failure`); }
    if (holds[method] === true || holds[method] === key) await new Promise((resolve, reject) => (pending[method] ??= []).push({ resolve, reject }));
    return captured;
  }
  const config = (overrides = {}) => ({ defaultModel: '', defaultProvider: '', defaultThinking: '', maxThinking: '', allowedTools: [], backgroundEnabled: true, defaultMode: 'foreground', supervisorEnabled: true, maxConcurrent: 4, maxSpawns: 32, waitTimeoutMs: 30000, worktreeIsolation: 'background', worktreeLimit: 8, budgetTokens: 0, budgetCostUsd: 0, budgetAction: 'warn', ...overrides });
  let user = config(); const projects = { [a]: config(), [b]: config({ maxConcurrent: 7, budgetTokens: 22222, allowedTools: ['read', 'missing_legacy_tool'] }) };
  const worktree = (id, status, name) => ({ id, status, name, parentConversationId: 'perf-0', childConversationId: `child-${id}`, workspace: a, repositoryRoot: a, path: `/qa/private/worktrees/${id}/特别长的任务路径用于验证窄窗口展示`, baseCommit: 'qa-base', createdAt: Date.now() - 10000, updatedAt: Date.now(), error: '', changed: true, changedFiles: 1, files: [{ path: 'src/long-path/long-feature-name-with-configuration-handling.ts', status: 'modified', added: 3, removed: 1, binary: false }], totalAdded: 3, totalRemoved: 1, sizeBytes: 10240, fileEntries: 3, sizeTruncated: false, directoryExists: true });
  const worktrees = [worktree('qa-finished', 'finished', '已结束的配置审查任务——包含长名称和工作树状态'), worktree('qa-active', 'active', '仍在运行的子任务')];
  function snapshot(cwd = a) { return { installed: true, userPath: '/qa/storage/studio.sqlite', projectPath: '/qa/storage/studio.sqlite', projectRoot: cwd, projectRootExists: true, user: clone(user), project: clone(projects[cwd] || config()), models: [{ modelRef: 'qa/model-a', provider: 'qa', label: 'QA 推理模型 A', reasoning: true, thinkingLevels: ['off', 'low', 'high'] }, { modelRef: 'qa/model-b', provider: 'qa', label: 'QA 长名称审查模型 B——用于验证选择和继承边界', reasoning: true, thinkingLevels: ['off', 'low', 'high'] }], currentModel: 'qa/model-a', thinkingLevels: ['off', 'low', 'high'], worktrees: cwd === a ? clone(worktrees) : [] }; }
  const source = { key: 'core', source: 'core', label: '核心工具', kind: 'core', scope: 'builtin', path: '', baseDir: '' };
  const catalog = { tools: ['read', 'write', 'bash', 'subagent'].map((name) => ({ name, description: `QA ${name} 工具说明`, exposure: 'direct', source })), commands: [], errors: [], warnings: [], refreshedAt: Date.now() };
  const dayKey = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const dayOffset = (offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return dayKey(date); };
  const totals = (zero = false) => zero ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0, activeDays: 0 } : { input: 9900, output: 1, cacheRead: 90, cacheWrite: 9, totalTokens: 10000, cost: 0.0123, requests: 4, activeDays: 1 };
  const modelA = { providerId: 'qa', providerName: 'QA 合成提供商', modelId: 'a', displayName: '主要审查模型——长名称仍应完整可识别' };
  const modelB = { providerId: 'qa', providerName: 'QA 合成提供商', modelId: 'b', displayName: '小占比模型 B' };
  function summary(days = 365) { const total = totals(qa.zeroUsage); return { generatedAt: Date.now(), days, sinceDay: dayOffset(1 - days), collection: { enabled: true, store: 'studio-sqlite' }, allTime: { ...total, totalTokens: total.totalTokens * 2, requests: total.requests * 2, currentStreak: qa.zeroUsage ? 0 : 1, longestStreak: qa.zeroUsage ? 0 : 3 }, range: total, daily: qa.zeroUsage ? [] : [{ ...total, day: dayOffset(0) }], dailyModels: qa.zeroUsage ? [] : [{ ...modelA, ...total, output: 0, totalTokens: 9999, day: dayOffset(0) }, { ...modelB, ...totals(true), output: 1, totalTokens: 1, requests: 1, day: dayOffset(0) }], filterModels: [modelA, modelB].map((model) => ({ ...model, enabled: true, inUse: true })) }; }
  function mix(input = {}) { const total = totals(qa.zeroUsage); return { generatedAt: Date.now(), window: { all: Boolean(input.all), days: input.days || null, sinceDay: input.all ? null : input.sinceDay || dayOffset(1 - (input.days || 1)), untilDay: input.all ? null : input.untilDay || dayOffset(0) }, totals: total, models: qa.zeroUsage ? [] : [{ ...modelA, ...total, output: 0, totalTokens: 9999 }, { ...modelB, ...totals(true), output: 1, totalTokens: 1, requests: 1 }] }; }
  window.piApi = new Proxy({
    setSecret: async () => { calls.push({ method: 'setSecret' }); throw new Error('Secret writes are not part of this QA'); },
    settings: async (cwd) => ({ ...await base.settings(cwd), agentTools: { enabled: ['read', 'write', 'bash', 'subagent'] } }),
    onOpenMain: (listener) => { mainListeners.add(listener); return () => mainListeners.delete(listener); },
    onOpenSettings: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
    agentToolCatalog: async () => clone(catalog),
    subagentSettings: async (cwd) => { calls.push({ method: 'subagentSettings', cwd }); return respond('subagentSettings', snapshot(cwd), cwd); },
    saveSubagentSettings: async (input) => { calls.push({ method: 'saveSubagentSettings', ...clone(input) }); await respond('saveSubagentSettings', {}, input.cwd); if (input.scope === 'user') user = clone(input.settings); else projects[input.cwd] = clone(input.settings); return snapshot(input.cwd); },
    managedWorktrees: async (input) => { calls.push({ method: 'managedWorktrees', ...input }); return respond('managedWorktrees', input?.cwd === b ? [] : worktrees, input?.cwd); },
    applyManagedWorktree: async (id) => { calls.push({ method: 'applyManagedWorktree', id }); await respond('applyManagedWorktree', {}, id); worktrees.find((item) => item.id === id).status = 'applied'; return { ok: true }; },
    discardManagedWorktree: async (input) => { calls.push({ method: 'discardManagedWorktree', ...input }); await respond('discardManagedWorktree', {}, input.id); worktrees.find((item) => item.id === input.id).status = 'discarded'; return { ok: true }; },
    cleanupManagedWorktrees: async () => { calls.push({ method: 'cleanupManagedWorktrees' }); return { removed: 0 }; },
    revealManagedWorktree: async (id) => { calls.push({ method: 'revealManagedWorktree', id }); return { ok: true }; },
    usageSummary: async (input) => { calls.push({ method: 'usageSummary', ...input }); return respond('usageSummary', summary(input?.days), input?.days); },
    usageModels: async (input) => { calls.push({ method: 'usageModels', ...input }); return respond('usageModels', mix(input), input?.days || (input?.all ? 'all' : 'custom')); },
  }, { get(target, key) { return key in target ? target[key] : base[key]; } });
}
