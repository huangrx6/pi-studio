/**
 * Studio resources: MCP, skills, extensions, Agent tools, and subagents.
 *
 * Every mutation is persisted in Studio SQLite or a Studio-owned directory and
 * immediately refreshes the live Durable registry. Existing conversations pick
 * the new selection up before their next request.
 */

const os = require('node:os');
const path = require('node:path');
const { dialog, ipcMain, webContents } = require('electron');
const { DEFAULT_CWD } = require('../core/state.cjs');
const { normalizeSecureHttpUrl } = require('../core/external-url.cjs');
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
} = require('../services/durable-runtime.cjs');
const {
  closeAllExtensionDataViews,
  closeExtensionDataViews,
} = require('./sessions.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');
const {
  agentToolCatalog,
  saveInstalledToolSelection,
} = require('../services/tool-selection.cjs');
const {
  saveSubagentSettings,
  subagentSettings,
} = require('../services/subagent-settings.cjs');
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
} = require('../services/studio-skills.cjs');

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

function revokeProjectExtensionTrust(scope, id, contentChanged) {
  if (scope !== 'project' || !contentChanged) return false;
  const stableId = stableExtensionId('project', id);
  const current = getStudioDatabase().getExtension(stableId);
  if (!current?.trusted) return false;
  // A content switch invalidates consent for the old code. This automatic
  // revocation must not be blocked by active dependents: the refresh below
  // makes those dependents unavailable until the new content is reviewed.
  getStudioDatabase().setExtensionTrusted(stableId, false, '');
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
      'Agent 工具权限',
    );
  });

  ipcMain.handle('pi:subagent-settings', async (_event, cwd) => (
    subagentSettings(typeof cwd === 'string' ? cwd : DEFAULT_CWD)
  ));

  ipcMain.handle('pi:save-subagent-settings', async (_event, { cwd, scope, settings } = {}) => {
    const snapshot = await saveSubagentSettings(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      scope,
      settings,
    );
    return { ...snapshot, runtimeRefresh: runtimeRefresh('子 Agent 配置') };
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
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
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
    const server = getStudioDatabase().getMcpServer(name, { includeSecrets: true });
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

  ipcMain.handle('pi:add-mcp', async (_event, input) => {
    const db = getStudioDatabase();
    const current = db.getMcpServer(input?.originalName || input?.name, { includeSecrets: true }) || {};
    const next = normalizeMcpInput(input, current);
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
    if (input?.originalName && input.originalName !== next.name) {
      db.removeMcpServer(input.originalName);
    }
    return settingsWithRuntime(
      typeof input?.cwd === 'string' ? input.cwd : DEFAULT_CWD,
      'MCP 配置',
    );
  });

  ipcMain.handle('pi:remove-mcp', async (_event, name, cwd) => {
    const db = getStudioDatabase();
    if (!db.getMcpServer(name)) throw new Error('MCP 不存在');
    db.removeMcpServer(name);
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      'MCP 配置',
    );
  });

  ipcMain.handle('pi:set-mcp-enabled', async (_event, { name, enabled, cwd } = {}) => {
    const db = getStudioDatabase();
    if (!db.getMcpServer(name) || typeof enabled !== 'boolean') throw new Error('参数无效');
    db.setMcpEnabled(name, enabled);
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      'MCP 配置',
    );
  });

  ipcMain.handle('pi:add-skill', async (_event, { scope, cwd } = {}) => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    importSkill(
      result.filePaths[0],
      scope === 'project' ? 'project' : 'user',
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
    );
    notifyExtensionsChanged();
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      '技能',
    );
  });

  ipcMain.handle('pi:remove-skill', async (_event, skillPath, cwd) => {
    removeSkill(skillPath, typeof cwd === 'string' ? cwd : DEFAULT_CWD);
    notifyExtensionsChanged();
    return settingsWithRuntime(
      typeof cwd === 'string' ? cwd : DEFAULT_CWD,
      '技能',
    );
  });

  ipcMain.handle('pi:skill-trust', async (_event, { path: skillPath, trusted, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    setSkillTrusted(skillPath, workspace, trusted === true);
    notifyExtensionsChanged();
    return settingsWithRuntime(workspace, '项目技能信任');
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

  ipcMain.handle('pi:extension-install', async (_event, payload = {}) => {
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const installed = await extensionDistributionService().installPrepared(payload.token, {
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
    });
    const trustRevoked = revokeProjectExtensionTrust(
      scope,
      installed.id,
      installed.contentChanged,
    );
    await closeExtensionDataViews(`${scope}:${installed.id}`);
    return {
      installed: {
        id: installed.id,
        version: installed.version,
        activeCodePath: installed.activeCodePath,
        dataPath: installed.dataPath,
        contentChanged: installed.contentChanged,
        trustRevoked,
      },
      settings: await settingsWithRuntime(workspace, '扩展安装'),
    };
  });

  ipcMain.handle('pi:extension-dispose', async (_event, { token } = {}) => {
    if (typeof token === 'string' && token) {
      extensionDistributionService().disposePrepared(token);
    }
  });

  ipcMain.handle('pi:extension-rollback', async (_event, payload = {}) => {
    const workspace = typeof payload.cwd === 'string' ? payload.cwd : DEFAULT_CWD;
    const scope = payload.scope === 'project' ? 'project' : 'user';
    const id = typeof payload.id === 'string'
      ? payload.id.replace(/^(?:user|project):/, '')
      : '';
    if (!id) throw new Error('扩展 ID 无效');
    const installed = await extensionDistributionService().rollback(id, {
      scope,
      cwd: workspace,
    });
    const trustRevoked = revokeProjectExtensionTrust(
      scope,
      installed.id,
      installed.contentChanged,
    );
    await closeExtensionDataViews(`${scope}:${installed.id}`);
    return {
      installed: {
        id: installed.id,
        version: installed.version,
        activeCodePath: installed.activeCodePath,
        dataPath: installed.dataPath,
        contentChanged: installed.contentChanged,
        trustRevoked,
      },
      settings: await settingsWithRuntime(workspace, '扩展回滚'),
    };
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

  ipcMain.handle('pi:extensions-enable', async (_event, { id, enabled, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    setStudioExtensionEnabled(id, enabled, workspace);
    if (!enabled) await closeExtensionDataViews(id);
    return settingsWithRuntime(workspace, '扩展启停');
  });

  ipcMain.handle('pi:extensions-trust', async (_event, { id, trusted, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    setStudioExtensionTrusted(id, trusted, workspace);
    if (!trusted) await closeExtensionDataViews(id);
    return settingsWithRuntime(workspace, '扩展信任');
  });

  ipcMain.handle('pi:remove-extension', async (_event, { id, cwd } = {}) => {
    const workspace = typeof cwd === 'string' ? cwd : DEFAULT_CWD;
    await removeStudioExtension(id, workspace);
    await closeExtensionDataViews(id);
    return settingsWithRuntime(workspace, '扩展卸载');
  });
}

module.exports = { registerSettingsIpc };
