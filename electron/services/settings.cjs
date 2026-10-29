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
 *  - mcp / skills / extensions / packages  各类资源清单
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
  const studioConfig = readJson(configPath(), {});
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

  // 提供方列表：运行时目录 + models.json 中已经保存但没有模型的来源。
  // 后者必须继续显示，否则用户添加来源后无法从来源卡片里添加第一个模型。
  const runtimeProviders = runtime.getProviders();
  const runtimeById = new Map(runtimeProviders.map((provider) => [provider.id, provider]));
  const providerIds = [
    ...runtimeProviders.map((provider) => provider.id).filter((id) => visible.has(id)),
    ...Object.keys(configuredModels.providers || {}).filter((id) => !runtimeById.has(id)),
  ];
  const providers = providerIds
    .filter((id, index) => providerIds.indexOf(id) === index)
    .map((providerId) => {
      const provider = runtimeById.get(providerId);
      const configured = configuredModels.providers?.[providerId] || {};
      const stored = auth[providerId];
      const key = stored?.key;
      const envName = envNameOf(key);
      const runtimeModels = allModels.filter((model) => model.provider === providerId);
      const configuredModelIds = (configured.models || []).map((model) => model.id);
      const modelCount = new Set([...runtimeModels.map((model) => model.id), ...configuredModelIds]).size;
      return {
        id: providerId,
        name: configured.name || provider?.name || providerId,
        authConfigured: stored !== undefined || configured.apiKey !== undefined || Boolean(provider && runtime.hasConfiguredAuth(providerId)),
        mode: stored?.type === 'oauth' ? 'oauth' : envName ? 'env' : 'key',
        icon: configured.icon || '',
        envName,
        envAvailable: envName ? Boolean(stored?.env?.[envName] || process.env[envName]) : false,
        models: modelCount,
        modelsUrl: studioConfig.providerDiscovery?.[providerId]?.modelsUrl || '',
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
  const configuredPackages = (Array.isArray(settings.packages) ? settings.packages : [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.source)
    .filter((source) => typeof source === 'string' && source.trim())
    .map((source) => source.trim());
  const extensions = listExtensions(cwd);

  return {
    providers,
    customModels: Object.entries(configuredModels.providers || {}).flatMap(([providerId, provider]) => {
      const rows = (provider.models || []).map((model) => ({
        providerId,
        modelId: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.input?.includes('image') ?? false,
        reasoning: model.reasoning ?? false,
        origin: 'configured',
      }));
      const seen = new Set(rows.map((model) => model.modelId));
      for (const [modelId, model] of Object.entries(provider.modelOverrides || {})) {
        if (seen.has(modelId)) continue;
        rows.push({
          providerId,
          modelId,
          name: model.name || modelId,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsImages: model.input?.includes('image') ?? false,
          reasoning: model.reasoning ?? false,
          origin: 'override',
        });
      }
      return rows;
    }),
    mcp: servers,
    skills,
    extensions: extensions.map((item) => ({ ...item, source: 'directory' })),
    packages: configuredPackages.map((source) => ({
      source,
      name: source.replace(/^(npm:|git:)/, ''),
      scope: 'user',
    })),
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
