/**
 * 设置页数据聚合。
 *
 * Pi 的配置分散在 ~/.pi/agent 下的多个文件里（auth / models / mcp / settings / 技能目录），
 * 渲染进程只需要「一次调用拿到全部」的快照，所以这里统一组装成 settingsSnapshot。
 * 本模块只读，不写文件；写操作见 ipc/models.cjs 与 ipc/settings.cjs。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CWD,
  piModule,
  getRuntime,
  getModelRef,
  readAuth,
  readMcp,
  readJson,
  modelsFile,
  authFile,
  mcpFile,
  settingsFile,
  agentDir,
  configPath,
} = require('../core/state.cjs');
const { readAgentToolSelection, visibleProviderIds } = require('../settings-config.cjs');
const { envNameOf } = require('../credential-env.cjs');
const { modelInfo } = require('./models.cjs');
const { listExtensions } = require('./extensions.cjs');

/**
 * 组装设置页快照：
 *  - providers      可见的模型提供方（是否已配置、认证方式、图标、模型数）
 *  - customModels   models.json 里的自定义模型
 *  - mcp / skills / extensions / packages / extensionData  各类资源清单
 *  - enabledModels  settings.json 中启用的模型
 *  - agentTools     Pi Studio 本地 config.json 中的 Agent 工具白名单
 *  - 各配置文件的绝对路径（前端「打开目录」用）
 *  - model          当前模型信息
 */
async function settingsSnapshot(cwd = DEFAULT_CWD) {
  const pi = piModule();
  const runtime = await getRuntime();
  const auth = readAuth();
  const allModels = runtime.getModels();
  const configuredModels = readJson(modelsFile(), { providers: {} });
  const settings = readJson(settingsFile(), {});
  const enabledModels = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const agentTools = readAgentToolSelection(readJson(configPath(), {}));
  const visible = visibleProviderIds(
    auth,
    configuredModels.providers || {},
    enabledModels,
    getModelRef(),
    runtime.getProviders().filter((provider) => runtime.hasConfiguredAuth(provider.id)).map((provider) => provider.id),
  );

  // 提供方列表：把 auth.json 的认证方式翻译成前端能显示的 mode
  const providers = runtime.getProviders()
    .filter((provider) => visible.has(provider.id))
    .map((provider) => {
      const stored = auth[provider.id];
      const key = stored?.key;
      const envName = envNameOf(key);
      return {
        id: provider.id,
        name: provider.name,
        authConfigured: stored !== undefined || runtime.hasConfiguredAuth(provider.id),
        mode: stored?.type === 'oauth' ? 'oauth' : envName ? 'env' : 'key',
        icon: configuredModels.providers?.[provider.id]?.icon || '',
        envName,
        envAvailable: envName ? Boolean(stored?.env?.[envName] || process.env[envName]) : false,
        models: allModels.filter((model) => model.provider === provider.id).length,
      };
    });

  // MCP 服务器：把配置翻译成列表项（stdio 用 command + args 拼成一行展示）
  const mcp = readMcp();
  const servers = Object.entries(mcp.mcpServers).map(([name, value]) => ({
    name,
    transport: value.type === 'stdio' || value.command ? 'stdio' : 'http',
    enabled: value.enabled !== false,
    target: value.command ? [value.command, ...(value.args || [])].join(' ') : value.url || '',
    description: value.description || '',
  }));

  // 技能：只列用户级位置（项目级技能在会话内使用，不在设置页展示）
  let skills = [];
  try {
    const result = pi.loadSkills({
      cwd,
      agentDir: agentDir(),
      skillPaths: [path.join(agentDir(), 'skills'), path.join(os.homedir(), '.agents', 'skills')],
      includeDefaults: false,
    });
    skills = result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      scope: 'user',
    }));
  } catch {
    /* 技能发现是可选的 */
  }

  // 通过包管理器安装的扩展（settings.json 里的 packages）
  const configuredPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const extensions = listExtensions(cwd);

  // Pi 的扩展运行数据目录（扩展自己写完留下的数据）
  let extensionData = [];
  try {
    extensionData = fs
      .readdirSync(path.join(agentDir(), 'extensions-data'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    /* 没有扩展数据 */
  }

  return {
    providers,
    customModels: Object.entries(configuredModels.providers || {}).flatMap(([providerId, provider]) =>
      (provider.models || []).map((model) => ({
        providerId,
        modelId: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.input?.includes('image') ?? false,
        reasoning: model.reasoning ?? false,
      })),
    ),
    mcp: servers,
    skills,
    extensions: extensions.map((item) => ({ ...item, source: 'directory' })),
    packages: configuredPackages.map((source) => ({ source, name: source.replace(/^(npm:|git:)/, '') })),
    extensionData,
    enabledModels,
    agentTools,
    agentToolsPath: configPath(),
    authPath: authFile(),
    mcpPath: mcpFile(),
    modelsPath: modelsFile(),
    model: await modelInfo(cwd),
  };
}

module.exports = { settingsSnapshot };
