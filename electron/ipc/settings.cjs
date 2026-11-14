/**
 * Studio resources: MCP, skills, extensions, Agent tools, and subagents.
 *
 * Every mutation is persisted in Studio SQLite or a Studio-owned directory and
 * immediately refreshes the live Durable registry. Existing conversations pick
 * the new selection up before their next request.
 */

const os = require('node:os');
const path = require('node:path');
const { dialog, ipcMain, shell, webContents } = require('electron');
const { DEFAULT_CWD } = require('../core/state.cjs');
const {
  normalizeExternalHttpUrl,
  normalizeSecureHttpUrl,
} = require('../core/external-url.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  deleteHarnessProfile,
  getConversationExtensionUiPreferences,
  getExtensionRegistryUrl,
  getHarnessSettings,
  resetHarnessProfile,
  saveConversationExtensionUiPreferences,
  saveHarnessProfile,
  saveRuntimePolicy,
  selectHarnessProfile,
  setExtensionRegistryUrl,
} = require('../core/app-settings.cjs');
const {
  refreshExtensionRuntime,
  reconcileRuntimeForWorkspace,
} = require('../runtime/durable-runtime.cjs');
const {
  closeAllExtensionDataViews,
  closeExtensionDataViews,
} = require('./sessions.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');
const { createExtensionInstallRecovery } = require('../services/extension-install-recovery.cjs');
const { createExtensionMutationRecovery } = require('../services/extension-mutation-recovery.cjs');
const {
  invalidateMcpConnection,
  testMcpConnection,
} = require('../integrations/mcp/index.cjs');
const {
  authorizeMcpServer,
  clearMcpOAuth,
} = require('../integrations/mcp/index.cjs');
const {
  agentToolCatalog,
  saveInstalledToolSelection,
} = require('../runtime/tool-selection.cjs');
const {
  saveSubagentSettings,
  subagentBudgetSnapshot,
  subagentSettings,
} = require('../capabilities/subagents/index.cjs');
const {
  autoUpdateOfficialExtensions,
  extensionHostSnapshot,
  extensionDistributionService,
  importStudioExtension,
  officialExtensionService,
  officialExtensionsSnapshot,
  removeStudioExtension,
  setOfficialExtensionAutoUpdate,
  setStudioExtensionEnabled,
  setStudioExtensionTrusted,
  stableExtensionId,
} = require('../services/studio-extensions.cjs');
const {
  importSkill,
  removeSkill,
  setSkillTrusted,
} = require('../capabilities/skills/index.cjs');
const {
  disposePreparedSkill,
  installPreparedSkill,
  prepareSkillInstall,
  pruneSkillPrepared,
  removeSkillSource,
  addSkillSource,
  setSkillSourceEnabled,
  skillHubSnapshot,
} = require('../capabilities/skills/index.cjs');
const {
  listSecrets,
  removeSecret,
  writeSecret,
} = require('../services/secret-vault.cjs');
const {
  applyManagedWorktree,
  cleanupManagedWorktrees,
  discardManagedWorktree,
  inspectManagedWorktree,
  listManagedWorktrees,
} = require('../capabilities/subagents/index.cjs');

function runtimeRefresh(reason, status = 'ready', message = '配置已热更新') {
  return {
    status,
    revision: Date.now(),
    reason,
    appliedSessions: 0,
    pendingSessions: 0,
    failedSessions: 0,
    background: false,
    message,
    errors: [],
    at: Date.now(),
  };
}

function notifyExtensionsChanged() {
  for (const target of webContents.getAllWebContents()) {
    if (!target.isDestroyed()) target.send('pi:extensions-changed');
  }
}

function revokeInstalledProjectTrust({ scope, installed, trustBaseline }) {
  if (scope !== 'project' || !installed.contentChanged || !trustBaseline?.trusted) return false;
  const id = stableExtensionId(scope, installed.id);
  const current = getStudioDatabase().getExtension(id);
  if (!current) return false;
  // A previous attempt may have committed the revoke before its follow-up read
  // failed. Do not write again, and never revoke a later explicit trust grant.
  if (!current.trusted) return true;
  if (current.contentHash !== trustBaseline.contentHash) return false;
  getStudioDatabase().setExtensionTrusted(id, false, '');
  return true;
}

async function settingsWithRuntime(cwd, reason) {
  try {
    await refreshExtensionRuntime(cwd);
    if (reason.includes('扩展')) notifyExtensionsChanged();
    return {
      ...await settingsSnapshot(cwd),
      runtimeRefresh: runtimeRefresh(reason),
    };
  } catch (error) {
    return {
      ...await settingsSnapshot(cwd),
      runtimeRefresh: {
        ...runtimeRefresh(reason, 'error', '运行时刷新失败'),
        errors: [error instanceof Error ? error.message : String(error)],
      },
    };
  }
}

// Credential changes must retire the old authenticated connection before a
// read-only recovery can publish fresh state. Keep failed invalidations pending.
const pendingMcpOAuthInvalidations = new Map();

async function readMcpSettingsWithRuntime(cwd) {
  try {
    for (const [name, revision] of pendingMcpOAuthInvalidations) {
      await invalidateMcpConnection(name);
      if (pendingMcpOAuthInvalidations.get(name) === revision) pendingMcpOAuthInvalidations.delete(name);
    }
    const snapshot = await settingsWithRuntime(cwd, 'MCP 配置');
    if (snapshot.runtimeRefresh?.status === 'error' || snapshot.runtimeRefresh?.failedSessions > 0) {
      throw new Error('MCP runtime projection requires refresh');
    }
    return snapshot;
  } catch {
    throw new Error('MCP 刷新未完成，请稍后重试。');
  }
}

async function committedMcpProjection(cwd) {
  try {
    return { committed: true, projection: { status: 'ready', value: await readMcpSettingsWithRuntime(cwd) } };
  } catch {
    return { committed: true, projection: { status: 'error', message: 'MCP 配置已保存，但运行时与列表刷新未完成。请重试刷新。' } };
  }
}

async function readSkillSettingsWithRuntime(cwd) {
  try {
    notifyExtensionsChanged();
    await refreshExtensionRuntime(cwd);
    return { ...await settingsSnapshot(cwd), runtimeRefresh: runtimeRefresh('技能') };
  } catch {
    throw new Error('技能运行时与列表刷新未完成，请重试刷新。');
  }
}

async function committedSkillProjection(cwd) {
  try {
    return { committed: true, projection: { status: 'ready', value: await readSkillSettingsWithRuntime(cwd) } };
  } catch {
    return { committed: true, projection: { status: 'error', message: '技能更改已保存，但运行时与列表刷新未完成。请重试刷新。' } };
  }
}

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string')
      .map(([key, entry]) => [key.trim(), entry]),
  );
}

function parseSecretLines(value, current, keyPattern) {
  const next = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey).trim();
      const entry = String(rawValue ?? '').trim();
      if (!keyPattern.test(key)) continue;
      if (entry) next[key] = entry;
      else if (typeof current[key] === 'string') next[key] = current[key];
    }
    return next;
  }
  for (const line of String(value || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const entry = line.slice(index + 1).trim();
    if (!keyPattern.test(key)) continue;
    if (entry) next[key] = entry;
    else if (typeof current[key] === 'string') next[key] = current[key];
  }
  return next;
}

function normalizeToolExposure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawPattern, rawExposure] of Object.entries(value).slice(0, 256)) {
    const pattern = String(rawPattern).trim().slice(0, 160);
    if (!pattern || !['direct', 'deferred', 'hidden'].includes(rawExposure)) continue;
    result[pattern] = rawExposure;
  }
  return result;
}

function normalizeMcpInput(input = {}, current = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('MCP 名称需要 1–64 个字母、数字、横线或下划线');
  }
  const transport = input.transport === 'http' ? 'http' : 'stdio';
  const args = Array.isArray(input.args)
    ? input.args.map((item) => String(item)).filter(Boolean)
    : String(input.args || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const currentEnv = stringMap(current.env);
  const currentHeaders = stringMap(current.headers);
  const env = input.clearEnv
    ? {}
    : parseSecretLines(input.env, currentEnv, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const headers = input.clearHeaders
    ? {}
    : parseSecretLines(input.headers, currentHeaders, /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
  const command = transport === 'stdio' ? String(input.command || '').trim() : '';
  const rawCwd = transport === 'stdio' ? String(input.mcpCwd || '').trim() : '';
  const expandedCwd = rawCwd === '~'
    ? os.homedir()
    : rawCwd.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), rawCwd.slice(2))
      : rawCwd;
  if (expandedCwd && !path.isAbsolute(expandedCwd)) {
    throw new Error('MCP 工作目录必须使用绝对路径或以 ~/ 开头；Studio 的 MCP 连接是应用级共享连接。');
  }
  const url = transport === 'http'
    ? normalizeSecureHttpUrl(input.url, { label: 'MCP 地址' })
    : '';
  if (transport === 'stdio' && !command) throw new Error('stdio MCP 需要启动命令');
  const exposure = ['direct', 'deferred', 'hidden'].includes(input.exposure)
    ? input.exposure
    : current.exposure || 'deferred';
  const timeoutSeconds = Math.max(
    1,
    Math.min(3_600, Number(input.timeoutSeconds) || current.timeoutSeconds || 60),
  );
  return {
    name,
    transport,
    command,
    args,
    cwd: expandedCwd,
    url,
    description: String(input.description || '').trim().slice(0, 1_200),
    env,
    headers,
    exposure,
    toolExposure: normalizeToolExposure(input.toolExposure),
    timeoutSeconds,
    enabled: input.enabled !== false,
  };
}

function registerSettingsIpc() {
  let mutationRecovery;
  function extensionMutationRecovery() {
    mutationRecovery ??= createExtensionMutationRecovery({
      revokeTrust: revokeInstalledProjectTrust,
      closeViews: record => closeExtensionDataViews(record.id),
      readSettings: async record => {
        const snapshot = await settingsWithRuntime(record.cwd, '扩展更改');
        if (snapshot.runtimeRefresh?.status === 'error' || snapshot.runtimeRefresh?.failedSessions > 0) {
          throw new Error('Extension runtime projection requires recovery');
        }
        return snapshot;
      },
    });
    return mutationRecovery;
  }
  const mutationOwners = new WeakSet();
  function mutationOwner(sender) {
    if (sender.isDestroyed()) throw new Error('扩展更改窗口已关闭。');
    if (!mutationOwners.has(sender)) {
      mutationOwners.add(sender);
      sender.once('destroyed', () => mutationRecovery?.closeOwner(sender.id));
    }
    return sender.id;
  }
  const installRecovery = createExtensionInstallRecovery({
    revokeTrust: revokeInstalledProjectTrust,
    closeViews: record => closeExtensionDataViews(`${record.scope}:${record.installed.id}`),
    readSettings: async record => {
      const snapshot = await settingsWithRuntime(record.cwd, '扩展安装');
      if (snapshot.runtimeRefresh?.status === 'error' || snapshot.runtimeRefresh?.failedSessions > 0) {
        throw new Error('Extension runtime projection requires recovery');
      }
      return snapshot;
    },
  });
  const installOwners = new WeakSet();
  function installOwner(sender) {
    if (sender.isDestroyed()) throw new Error('扩展安装窗口已关闭。');
    if (!installOwners.has(sender)) {
      installOwners.add(sender);
      sender.once('destroyed', () => installRecovery.closeOwner(sender.id));
    }
    return sender.id;
  }
  ipcMain.handle('pi:settings', async (_event, cwd) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    await reconcileRuntimeForWorkspace(workspace);
    return settingsSnapshot(workspace);
  });

  ipcMain.handle('pi:conversation-extension-ui-preferences', () => (
    getConversationExtensionUiPreferences()
  ));

  ipcMain.handle('pi:save-conversation-extension-ui-preferences', (_event, payload = {}) => (
    saveConversationExtensionUiPreferences(payload)
  ));

  ipcMain.handle('pi:agent-tool-catalog', async (_event, { cwd, refresh } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    await reconcileRuntimeForWorkspace(workspace);
    return agentToolCatalog(Boolean(refresh));
  });

  ipcMain.handle('pi:set-agent-tools', async (_event, { tools, cwd } = {}) => {
    saveInstalledToolSelection(tools);
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      '智能体工具权限',
    );
  });

  ipcMain.handle('pi:subagent-settings', async (_event, cwd) => (
    subagentSettings(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:subagent-budget', async (_event, { id, cwd } = {}) => (
    subagentBudgetSnapshot(id, typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:save-subagent-settings', async (_event, { cwd, scope, settings } = {}) => {
    const snapshot = await saveSubagentSettings(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      scope,
      settings,
    );
    return { ...snapshot, runtimeRefresh: runtimeRefresh('子智能体配置') };
  });

  ipcMain.handle('pi:managed-worktrees', async (_event, { cwd, includeTerminal } = {}) => (
    listManagedWorktrees({
      workspace: typeof cwd === 'string' ? cwd : '',
      includeTerminal: includeTerminal === true,
    })
  ));

  ipcMain.handle('pi:managed-worktree', async (_event, id) => (
    inspectManagedWorktree(String(id || ''))
  ));

  ipcMain.handle('pi:apply-managed-worktree', async (_event, id) => (
    applyManagedWorktree(String(id || ''))
  ));

  ipcMain.handle('pi:discard-managed-worktree', async (_event, { id, force } = {}) => (
    discardManagedWorktree(String(id || ''), { force: force === true })
  ));

  ipcMain.handle('pi:cleanup-managed-worktrees', async () => cleanupManagedWorktrees());

  ipcMain.handle('pi:reveal-managed-worktree', async (_event, id) => {
    const worktree = await inspectManagedWorktree(String(id || ''));
    if (!worktree.directoryExists) throw new Error('托管工作树目录不存在');
    shell.showItemInFolder(worktree.path);
    return { ok: true };
  });

  ipcMain.handle('pi:harness-settings', async (_event, cwd) => (
    getHarnessSettings(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:save-harness-profile', async (_event, payload = {}) => {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const harness = saveHarnessProfile({ ...payload, cwd });
    return { ...harness, runtimeRefresh: runtimeRefresh('编码 Harness') };
  });

  ipcMain.handle('pi:select-harness-profile', async (_event, payload = {}) => {
    if (!['global', 'workspace', 'inherit'].includes(payload.scope)) {
      throw new Error('Harness 应用范围无效');
    }
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const harness = selectHarnessProfile({ ...payload, cwd });
    return { ...harness, runtimeRefresh: runtimeRefresh('编码 Harness') };
  });

  ipcMain.handle('pi:reset-harness-profile', async (_event, payload = {}) => {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const harness = resetHarnessProfile({ ...payload, cwd });
    return { ...harness, runtimeRefresh: runtimeRefresh('编码 Harness') };
  });

  ipcMain.handle('pi:delete-harness-profile', async (_event, payload = {}) => {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const harness = deleteHarnessProfile({ ...payload, cwd });
    return { ...harness, runtimeRefresh: runtimeRefresh('编码 Harness') };
  });

  ipcMain.handle('pi:save-runtime-policy', async (_event, payload = {}) => {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    saveRuntimePolicy(payload.policy);
    return {
      ...getHarnessSettings(cwd),
      runtimeRefresh: runtimeRefresh('Durable 运行策略'),
    };
  });

  ipcMain.handle('pi:mcp-config', async (_event, name) => {
    const server = await getStudioDatabase().getMcpServerAsync(name, { includeSecrets: true });
    if (!server) throw new Error('MCP 不存在');
    return {
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      url: server.url,
      description: server.description,
      env: Object.keys(server.env || {}).sort().map((key) => `${key}=`).join('\n'),
      headers: Object.keys(server.headers || {}).sort().map((key) => `${key}=`).join('\n'),
      envKeys: Object.keys(server.env || {}).sort(),
      headerKeys: Object.keys(server.headers || {}).sort(),
      exposure: server.exposure,
      toolExposure: server.toolExposure,
      timeoutSeconds: server.timeoutSeconds,
      enabled: server.enabled,
    };
  });

  ipcMain.handle('pi:secrets-list', () => listSecrets());
  ipcMain.handle('pi:secret-set', (_event, payload = {}) => writeSecret(payload));
  ipcMain.handle('pi:secret-remove', (_event, name) => {
    removeSecret(name);
    return { ok: true };
  });

  ipcMain.handle('pi:test-mcp', async (_event, input = {}) => {
    const db = getStudioDatabase();
    const current = await db.getMcpServerAsync(input?.originalName || input?.name, { includeSecrets: true }) || {};
    return testMcpConnection(normalizeMcpInput(input, current));
  });

  ipcMain.handle('pi:test-saved-mcp', async (_event, name) => {
    const server = await getStudioDatabase().getMcpServerAsync(name, { includeSecrets: true });
    if (!server) throw new Error('MCP 不存在');
    return testMcpConnection(server);
  });

  ipcMain.handle('pi:mcp-oauth-start', async (_event, { name, cwd } = {}) => {
    const db = getStudioDatabase();
    const stored = await db.getMcpServerAsync(name, { includeSecrets: true });
    if (!stored) throw new Error('MCP 不存在');
    if (stored.transport !== 'http') throw new Error('只有 HTTP MCP 可以使用 OAuth');
    const server = {
      ...stored,
      url: normalizeSecureHttpUrl(stored.url, {
        label: `MCP「${stored.name}」地址`,
      }),
    };
    try {
      await authorizeMcpServer(server, async (url) => {
        await shell.openExternal(normalizeExternalHttpUrl(url));
      });
    } catch {
      throw new Error('OAuth 授权未完成，请检查连接后重试。');
    }
    pendingMcpOAuthInvalidations.set(stored.name, Symbol());
    return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:mcp-oauth-logout', async (_event, { name, cwd } = {}) => {
    const server = await getStudioDatabase().getMcpServerAsync(name, { includeSecrets: true });
    if (!server) throw new Error('MCP 不存在');
    if (server.transport !== 'http') throw new Error('只有 HTTP MCP 可以使用 OAuth');
    const url = normalizeSecureHttpUrl(server.url, { label: `MCP「${server.name}」地址` });
    try { clearMcpOAuth(url); } catch {
      throw new Error('OAuth 凭据未能清除，请重试。');
    }
    pendingMcpOAuthInvalidations.set(server.name, Symbol());
    return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:add-mcp', async (_event, input) => {
    const db = getStudioDatabase();
    if (Object.hasOwn(db, 'upsertMcpServer')) {
      db.transaction(() => {
        const current = db.getMcpServer(input?.originalName || input?.name, { includeSecrets: true }) || {};
        const next = normalizeMcpInput(input, current);
        if (input?.originalName && input.originalName !== next.name && db.getMcpServer(next.name)) {
          throw new Error('目标 MCP 名称已被使用，请换一个名称。');
        }
        const normalizedName = next.name.replace(/[^A-Za-z0-9_]/g, '_');
        const collision = db.listMcpServers().find((server) => (
          server.name !== input?.originalName
          && server.name !== next.name
          && server.name.replace(/[^A-Za-z0-9_]/g, '_') === normalizedName
        ));
        if (collision) {
          throw new Error(`MCP 名称「${next.name}」与「${collision.name}」会映射到同一工具命名空间，请换一个名称`);
        }
        db.upsertMcpServer(next);
        if (input?.originalName && input.originalName !== next.name) db.removeMcpServer(input.originalName);
      });
      return committedMcpProjection(typeof input?.cwd === 'string' ? input.cwd : DEFAULT_CWD);
    }
    const current = await db.getMcpServerAsync(input?.originalName || input?.name, { includeSecrets: true }) || {};
    const next = normalizeMcpInput(input, current);
    if (input?.originalName && input.originalName !== next.name && await db.getMcpServerAsync(next.name)) {
      throw new Error('目标 MCP 名称已被使用，请换一个名称。');
    }
    const normalizedName = next.name.replace(/[^A-Za-z0-9_]/g, '_');
    const collision = (await db.listMcpServersAsync()).find((server) => (
      server.name !== input?.originalName
      && server.name !== next.name
      && server.name.replace(/[^A-Za-z0-9_]/g, '_') === normalizedName
    ));
    if (collision) {
      throw new Error(`MCP 名称「${next.name}」与「${collision.name}」会映射到同一工具命名空间，请换一个名称`);
    }
    await db.upsertMcpServerAsync(next);
    if (input?.originalName && input.originalName !== next.name) db.removeMcpServer(input.originalName);
    return committedMcpProjection(typeof input?.cwd === 'string' ? input.cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:remove-mcp', async (_event, name, cwd) => {
    const db = getStudioDatabase();
    if (Object.hasOwn(db, 'removeMcpServer')) {
      db.transaction(() => {
        if (!db.getMcpServer(name)) throw new Error('MCP 不存在');
        db.removeMcpServer(name);
      });
      return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
    }
    if (!await db.getMcpServerAsync(name)) throw new Error('MCP 不存在');
    db.removeMcpServer(name);
    return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:set-mcp-enabled', async (_event, { name, enabled, cwd } = {}) => {
    const db = getStudioDatabase();
    if (Object.hasOwn(db, 'setMcpEnabled')) {
      db.transaction(() => {
        if (!db.getMcpServer(name) || typeof enabled !== 'boolean') throw new Error('参数无效');
        db.setMcpEnabled(name, enabled);
      });
      return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
    }
    if (!await db.getMcpServerAsync(name) || typeof enabled !== 'boolean') throw new Error('参数无效');
    await db.setMcpEnabledAsync(name, enabled);
    return committedMcpProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:mcp-refresh', (_event, cwd) => (
    readMcpSettingsWithRuntime(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:add-skill', async (_event, { scope, cwd } = {}) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    importSkill(
      result.filePaths[0],
      scope === 'project' ? 'project' : 'user',
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
    );
    return committedSkillProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:skills-refresh', (_event, cwd) => (
    readSkillSettingsWithRuntime(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:pick-skill-source-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('pi:pick-skill-registry-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Skill registry', extensions: ['json'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('pi:skill-hub', async (_event, { refresh } = {}) => {
    pruneSkillPrepared();
    return skillHubSnapshot({ refresh: refresh === true });
  });

  ipcMain.handle('pi:add-skill-source', async (_event, input = {}) => {
    pruneSkillPrepared();
    return addSkillSource(input);
  });

  ipcMain.handle('pi:set-skill-source-enabled', async (_event, { id, enabled } = {}) => (
    setSkillSourceEnabled(id, enabled === true)
  ));

  ipcMain.handle('pi:remove-skill-source', async (_event, id) => {
    removeSkillSource(id);
    return { ok: true };
  });

  ipcMain.handle('pi:prepare-skill-install', async (_event, input = {}) => {
    pruneSkillPrepared();
    return prepareSkillInstall(input);
  });

  ipcMain.handle('pi:install-prepared-skill', async (_event, input = {}) => {
    const installed = installPreparedSkill(input);
    return {
      installed,
      ...await committedSkillProjection(typeof input.cwd === 'string' ? input.cwd : DEFAULT_CWD),
    };
  });

  ipcMain.handle('pi:dispose-prepared-skill', async (_event, token) => (
    disposePreparedSkill(token)
  ));

  ipcMain.handle('pi:remove-skill', async (_event, skillPath, cwd) => {
    removeSkill(skillPath, typeof cwd === 'string' ? cwd : DEFAULT_CWD);
    return committedSkillProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:skill-trust', async (_event, { path: skillPath, trusted, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    setSkillTrusted(skillPath, workspace, trusted === true);
    return committedSkillProjection(workspace);
  });

  ipcMain.handle('pi:add-extension', async (_event, { scope, cwd } = {}) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    importStudioExtension(
      result.filePaths[0],
      scope === 'project' ? 'project' : 'user',
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
    );
    await closeAllExtensionDataViews();
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      '扩展',
    );
  });

  ipcMain.handle('pi:pick-extension-source', async (_event, { kind } = {}) => {
    const directory = kind === 'directory';
    const result = await dialog.showOpenDialog({
      properties: directory ? ['openDirectory'] : ['openFile'],
      filters: directory
        ? undefined
        : [{ name: 'Pi Studio Extension', extensions: ['zip', 'pi-extension'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle('pi:extension-prepare', async (_event, payload = {}) => {
    const source = typeof payload.source === 'string' ? payload.source.trim() : '';
    if (!source) throw new Error('请输入扩展目录、扩展包或安装来源');
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const registryUrl = payload.registryUrl === undefined
      ? getExtensionRegistryUrl()
      : setExtensionRegistryUrl(payload.registryUrl);
    return extensionDistributionService().prepare(source, {
      scope,
      cwd: workspace,
      registryUrl: registryUrl || undefined,
      expectedSha256: typeof payload.expectedSha256 === 'string'
        ? payload.expectedSha256
        : undefined,
      allowPrerelease: payload.allowPrerelease === true,
    });
  });

  ipcMain.handle('pi:extensions-check-updates', async (_event, payload = {}) => {
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const registryUrl = payload.registryUrl === undefined
      ? getExtensionRegistryUrl()
      : setExtensionRegistryUrl(payload.registryUrl);
    return extensionDistributionService().checkUpdates({
      scope,
      cwd: workspace,
      registryUrl: registryUrl || undefined,
      allowPrerelease: payload.allowPrerelease === true,
    });
  });

  ipcMain.handle('pi:official-extensions', async (_event, { cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    const update = await autoUpdateOfficialExtensions();
    if (update.updated.length > 0) {
      await closeAllExtensionDataViews();
      await refreshExtensionRuntime(workspace);
      notifyExtensionsChanged();
    }
    return {
      ...officialExtensionsSnapshot(),
      autoUpdate: update,
    };
  });

  ipcMain.handle('pi:official-extension-prepare', async (_event, { id } = {}) => {
    if (typeof id !== 'string' || !id) throw new Error('官方扩展 ID 无效');
    return officialExtensionService().prepare(id);
  });

  ipcMain.handle('pi:official-extension-auto-update', async (_event, { id, enabled } = {}) => {
    if (typeof id !== 'string' || !id) throw new Error('官方扩展 ID 无效');
    return setOfficialExtensionAutoUpdate(id, enabled === true);
  });

  ipcMain.handle('pi:extension-install', async (event, payload = {}) => {
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const ownerId = installOwner(event.sender);
    // Capture old consent before committing. If this read fails, no installation
    // has occurred; later recovery can distinguish old trust from a new grant.
    const trustBaselines = scope === 'project' ? new Map(getStudioDatabase().listExtensions()
      .filter(row => row.scope === 'project')
      .map(row => [row.id, { trusted: row.trusted, contentHash: row.contentHash }])) : undefined;
    return installRecovery.install({ ownerId, scope, cwd: workspace, trustBaselines,
      install: () => extensionDistributionService().installPrepared(payload.token, {
        scope,
        cwd: workspace,
        acceptedPermissions: Array.isArray(payload.acceptedPermissions)
          ? payload.acceptedPermissions.filter((item) => typeof item === 'string')
          : [],
        acceptedProviderAccess: Array.isArray(payload.acceptedProviderAccess)
          ? payload.acceptedProviderAccess.filter((item) => typeof item === 'string')
          : [],
        acceptedRequirements: payload.acceptedRequirements === true,
        acceptedExecution: payload.acceptedExecution === true,
        acceptedPublisherKey: payload.acceptedPublisherKey === true,
        trusted: scope === 'user',
      }),
    });
  });

  ipcMain.handle('pi:extension-install-refresh', (event, { token } = {}) => (
    installRecovery.refresh(event.sender.id, token)
  ));

  ipcMain.handle('pi:extension-install-recovery-dispose', (event, { token } = {}) => {
    installRecovery.dispose(event.sender.id, token);
  });

  ipcMain.handle('pi:extension-dispose', async (_event, { token } = {}) => {
    if (typeof token === 'string' && token) {
      extensionDistributionService().disposePrepared(token);
    }
  });

  ipcMain.handle('pi:extension-mutation-refresh', (event, { token } = {}) => (
    extensionMutationRecovery().refresh(event.sender.id, token)
  ));

  ipcMain.handle('pi:extension-mutation-recovery-dispose', (event, { token } = {}) => {
    extensionMutationRecovery().dispose(event.sender.id, token);
  });

  ipcMain.handle('pi:extension-rollback', async (event, payload = {}) => {
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const id = typeof payload.id === 'string'
      ? payload.id.replace(/^(?:user|project):/, '')
      : '';
    if (!id) throw new Error('扩展 ID 无效');
    const stableId = stableExtensionId(scope, id);
    const previous = scope === 'project' ? getStudioDatabase().getExtension(stableId) : undefined;
    const trustBaseline = previous ? { trusted: previous.trusted, contentHash: previous.contentHash } : undefined;
    return extensionMutationRecovery().mutate({
      ownerId: mutationOwner(event.sender), action: 'rollback', id: stableId, scope, cwd: workspace,
      trustBaseline, needsCloseViews: true,
      mutate: () => extensionDistributionService().rollback(id, { scope, cwd: workspace }),
    });
  });

  ipcMain.handle('pi:extension-registry-set', async (_event, { url } = {}) => ({
    extensionRegistryUrl: setExtensionRegistryUrl(url),
  }));

  ipcMain.handle('pi:extension-publisher-trust', async () => (
    extensionDistributionService().publisherTrustSnapshot()
  ));

  ipcMain.handle('pi:extension-publisher-revoke', async (_event, payload = {}) => (
    extensionDistributionService().revokePublisherKey({
      publisher: payload.publisher,
      keyId: payload.keyId,
    })
  ));

  ipcMain.handle('pi:extensions-snapshot', async (_event, cwd) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    await reconcileRuntimeForWorkspace(workspace);
    return extensionHostSnapshot();
  });

  ipcMain.handle('pi:extensions-reload', async (_event, cwd) => {
    await closeAllExtensionDataViews();
    return refreshExtensionRuntime(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:extensions-enable', async (event, { id, enabled, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    return extensionMutationRecovery().mutate({
      ownerId: mutationOwner(event.sender), action: 'enable', id, cwd: workspace, needsCloseViews: !enabled,
      mutate: () => setStudioExtensionEnabled(id, enabled, workspace),
    });
  });

  ipcMain.handle('pi:extensions-trust', async (event, { id, trusted, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    return extensionMutationRecovery().mutate({
      ownerId: mutationOwner(event.sender), action: 'trust', id, cwd: workspace, needsCloseViews: !trusted,
      mutate: () => setStudioExtensionTrusted(id, trusted, workspace),
    });
  });

  ipcMain.handle('pi:remove-extension', async (event, { id, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    return extensionMutationRecovery().mutate({
      ownerId: mutationOwner(event.sender), action: 'remove', id, cwd: workspace, needsCloseViews: true,
      mutate: () => removeStudioExtension(id, workspace),
    });
  });
}

module.exports = { registerSettingsIpc };
