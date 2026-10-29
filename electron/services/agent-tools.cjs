/**
 * Agent 工具白名单与工具目录。
 *
 * 白名单保存在 Pi Studio 自己的 config.json，不修改 Pi 的全局 defaultTools，
 * 因此不会悄悄改变 CLI 的工具行为。工具目录通过一个不落盘、不发送 prompt 的
 * 内存会话加载扩展，用来展示工具来自核心、扩展包还是本地扩展。
 */

const path = require('node:path');
const {
  DEFAULT_CWD,
  agentDir,
  configPath,
  getModelRef,
  getRuntime,
  piModule,
  readConfig,
  writeConfig,
} = require('../core/state.cjs');
const {
  readAgentToolSelection,
  updateAgentTools,
} = require('../settings-config.cjs');

const catalogSessions = new Map();
const catalogPromises = new Map();

function installedToolSelection() {
  return readAgentToolSelection(readConfig(configPath(), {}));
}

function saveInstalledToolSelection(input) {
  const config = readConfig(configPath(), {});
  writeConfig(configPath(), updateAgentTools(config, input));
  return installedToolSelection();
}

function sourceDescriptor(sourceInfo = {}) {
  const source = String(sourceInfo.source || 'unknown');
  let label = source;
  let kind = 'extension';
  if (source === 'builtin' || source.startsWith('builtin:')) {
    label = 'Pi 核心';
    kind = 'core';
  } else if (source.startsWith('npm:')) {
    label = source.slice(4);
    kind = 'package';
  } else if (source.startsWith('git:')) {
    label = source.slice(4);
    kind = 'git';
  } else if (source === 'local' || source === 'auto') {
    label = path.basename(sourceInfo.baseDir || sourceInfo.path || '') || '本地扩展';
    kind = 'local';
  } else if (source === 'inline') {
    label = 'Pi Studio';
    kind = 'inline';
  }
  const identity = sourceInfo.baseDir || sourceInfo.path || label;
  return {
    // Multiple local extensions share source="local"; include the resolved
    // directory so separate providers never collapse into one visual group.
    key: `${source}:${sourceInfo.scope || 'user'}:${identity}`,
    source,
    label,
    kind,
    scope: sourceInfo.scope || 'user',
    path: sourceInfo.path || '',
    baseDir: sourceInfo.baseDir || '',
  };
}

function serializeCatalog(session, extensionsResult) {
  const tools = session.getAllTools()
    .filter((tool) => tool.exposure !== 'hidden')
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      exposure: tool.exposure || 'direct',
      source: sourceDescriptor(tool.sourceInfo),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const commands = session.extensionRunner.getRegisteredCommands()
    .map((command) => ({
      // `name` can be shared by several extensions. The runtime resolves the
      // concrete command through invocationName, which is what users can type.
      name: command.invocationName,
      description: command.description || '',
      source: sourceDescriptor(command.sourceInfo),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const errors = extensionsResult.errors.map((entry) => ({
    path: entry.path || '',
    message: entry.error?.message || String(entry.error || entry.message || '扩展加载失败'),
  }));
  const warnings = (extensionsResult.warnings || []).map((entry) => ({
    path: entry.path || '',
    message: entry.error?.message || String(entry.error || entry.message || entry),
  }));
  return { tools, commands, errors, warnings };
}

async function createCatalogSession(cwd) {
  const pi = piModule();
  const runtime = await getRuntime();
  const settingsManager = pi.SettingsManager.create(cwd, pi.getAgentDir());
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: pi.getAgentDir(),
    settingsManager,
  });
  await resourceLoader.reload();

  const [provider, ...parts] = getModelRef().split('/');
  const model = provider && parts.length > 0 ? runtime.getModel(provider, parts.join('/')) : undefined;
  const result = await pi.createAgentSession({
    cwd,
    model,
    modelRuntime: runtime,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(cwd),
    // 目录扫描必须注册全部扩展工具；该会话不会发送 prompt，也不会写入会话文件。
    tools: ['*'],
  });
  await result.session.bindExtensions({ mode: 'tui' });
  return result.session;
}

/**
 * 返回当前工作区的可用工具。扫描会话按工作区缓存；手动刷新时在原 session
 * 上 reload，避免反复创建扩展运行时而产生后台定时器。
 */
async function agentToolCatalog(cwd = DEFAULT_CWD, refresh = false) {
  const resolvedCwd = path.resolve(cwd || DEFAULT_CWD);
  if (refresh) {
    const session = catalogSessions.get(resolvedCwd);
    if (session) {
      await session.reload();
      const catalog = serializeCatalog(session, session.resourceLoader.getExtensions());
      return { ...catalog, agentDir: agentDir(), refreshedAt: Date.now() };
    }
  }
  const cached = catalogSessions.get(resolvedCwd);
  if (cached) {
    return {
      ...serializeCatalog(cached, cached.resourceLoader.getExtensions()),
      agentDir: agentDir(),
      refreshedAt: Date.now(),
    };
  }
  const pending = catalogPromises.get(resolvedCwd);
  if (pending) return pending;
  const request = (async () => {
    const session = await createCatalogSession(resolvedCwd);
    catalogSessions.set(resolvedCwd, session);
    return {
      ...serializeCatalog(session, session.resourceLoader.getExtensions()),
      agentDir: agentDir(),
      refreshedAt: Date.now(),
    };
  })().finally(() => catalogPromises.delete(resolvedCwd));
  catalogPromises.set(resolvedCwd, request);
  return request;
}

/**
 * Invalidate in-memory discovery sessions after extensions or packages change.
 * The next catalog read creates a fresh runtime, without making package
 * installation wait for every workspace that was scanned earlier.
 */
function invalidateAgentToolCatalog() {
  for (const session of catalogSessions.values()) {
    try { session.dispose(); } catch { /* already disposed */ }
  }
  catalogSessions.clear();
  catalogPromises.clear();
}

module.exports = {
  agentToolCatalog,
  invalidateAgentToolCatalog,
  installedToolSelection,
  saveInstalledToolSelection,
  sourceDescriptor,
};
