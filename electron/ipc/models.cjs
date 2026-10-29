/**
 * IPC：模型与提供方。
 * 模型列表 / 切换模型 / 推理强度 / 提供方配置 / 自定义模型 / 启用列表 / API Key。
 *
 * 任何会改变「可用密钥或模型目录」的操作，都必须调用 invalidateModelRuntime()，
 * 否则运行时还持有旧配置。
 */

const fs = require('node:fs');
const { ipcMain } = require('electron');
const {
  DEFAULT_CWD,
  getRuntime,
  getModelRef,
  setModelRef,
  getThinkingPreferences,
  setThinkingPreferences,
  saveConfig,
  invalidateModelRuntime,
  readAuth,
  readConfig,
  writeConfig,
  readJson,
  authFile,
  modelsFile,
  settingsFile,
  configPath,
  modelOptionsModule,
  piModule,
} = require('../core/state.cjs');
const {
  updateProvider,
  updateCustomModel,
  removeCustomModel,
  importDiscoveredModels,
} = require('../settings-config.cjs');
const { prepareKey } = require('../credential-env.cjs');
const { fetchProviderModelDiscovery, httpUrl } = require('../model-discovery.cjs');
const { modelInfo, availableModels, runtimeModelFor } = require('../services/models.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');
const { requestAgentRuntimeRefresh } = require('../services/runtime-refresh.cjs');

async function refreshModelRuntime(reason) {
  invalidateModelRuntime();
  return requestAgentRuntimeRefresh(reason);
}

async function settingsAfterRuntimeChange(reason) {
  const runtimeRefresh = await refreshModelRuntime(reason);
  return {
    ...await settingsSnapshot(DEFAULT_CWD),
    runtimeRefresh,
  };
}

function discoverySettings() {
  const config = readConfig(configPath(), {});
  const value = config.providerDiscovery;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateDiscoveryUrl(modelsUrl) {
  const value = typeof modelsUrl === 'string' ? modelsUrl.trim() : '';
  if (value && !httpUrl(value)) throw new Error('模型列表地址必须是有效的 HTTP 或 HTTPS 地址');
  return value;
}

function saveDiscoverySettings(providerId, modelsUrl) {
  const config = readConfig(configPath(), {});
  const all = discoverySettings();
  const next = { ...all };
  const value = validateDiscoveryUrl(modelsUrl);
  if (value) {
    next[providerId] = { modelsUrl: value };
  } else {
    delete next[providerId];
  }
  writeConfig(configPath(), { ...config, providerDiscovery: next });
}

/** 切换新对话默认模型，并把同一个默认值同步给 Pi CLI。 */
async function setDefaultModel(modelRef, cwd) {
  if (typeof modelRef !== 'string' || !modelRef.includes('/')) throw new Error('模型格式无效');
  const [provider, ...parts] = modelRef.split('/');
  const runtime = await getRuntime();
  if (!runtimeModelFor(runtime, modelRef)) throw new Error('模型已不存在，请刷新后重试');

  const settings = piModule().SettingsManager.create(cwd || DEFAULT_CWD);
  settings.setDefaultModelAndProvider(provider, parts.join('/'));
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors.length > 0) throw errors[0].error;

  saveConfig(modelRef);
  setModelRef(modelRef);
  return modelInfo(cwd || DEFAULT_CWD);
}

/** 调整新对话默认推理等级，并同步 Pi 的 startup thinking。 */
async function setDefaultThinkingLevel(level, cwd) {
  if (typeof level !== 'string') throw new Error('推理等级参数无效');
  const runtime = await getRuntime();
  const model = runtimeModelFor(runtime, getModelRef());
  if (!model) throw new Error('当前默认模型不存在');
  modelOptionsModule().validateThinkingLevel(model, level);

  const resolvedRef = `${model.provider}/${model.id}`;
  const preferences = { ...getThinkingPreferences(), [resolvedRef]: level };
  if (level !== 'default') {
    const settings = piModule().SettingsManager.create(cwd || DEFAULT_CWD);
    settings.setDefaultThinkingLevel(level);
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length > 0) throw errors[0].error;
  }
  saveConfig(resolvedRef, preferences);
  setModelRef(resolvedRef);
  setThinkingPreferences(preferences);
  return modelInfo(cwd || DEFAULT_CWD);
}

/** 兼容旧调用名；它始终只表示新对话默认模型。 */
async function setModel(modelRef, cwd) {
  return setDefaultModel(modelRef, cwd);
}

function registerModelsIpc() {
  // 模型选择器数据
  ipcMain.handle('pi:models', async (_event, cwd) => availableModels(cwd || DEFAULT_CWD));

  // 切换模型
  ipcMain.handle('pi:set-model', async (_event, modelRef, cwd) => setModel(modelRef, cwd));
  ipcMain.handle('pi:set-default-model', async (_event, modelRef, cwd) => setDefaultModel(modelRef, cwd));

  // 调整新对话默认推理强度，并同步到 Pi settings.json。
  ipcMain.handle('pi:set-thinking-level', async (_event, { level, cwd }) => setDefaultThinkingLevel(level, cwd));
  ipcMain.handle('pi:set-default-thinking-level', async (_event, { level, cwd }) => setDefaultThinkingLevel(level, cwd));

  // 某个提供方下的模型 + 是否启用
  ipcMain.handle('pi:provider-models', async (_event, providerId) => {
    const runtime = await getRuntime();
    const settings = readJson(settingsFile(), {});
    const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : []);
    const configured = readConfig(modelsFile(), { providers: {} }).providers || {};
    const provider = configured[providerId];
    const runtimeProvider = runtime.getProviders().find((item) => item.id === providerId);
    if (!provider && !runtimeProvider) throw new Error('模型来源不存在');
    const configuredModels = Array.isArray(provider?.models) ? provider.models : [];
    const overrides = provider?.modelOverrides && typeof provider.modelOverrides === 'object' && !Array.isArray(provider.modelOverrides)
      ? provider.modelOverrides
      : {};
    const models = new Map();
    for (const model of runtime.getModels().filter((item) => item.provider === providerId)) {
      const configuredModel = configuredModels.find((item) => item.id === model.id);
      const override = overrides[model.id];
      const effective = { ...model, ...override, ...configuredModel };
      const origin = configuredModel ? 'configured' : override ? 'override' : 'builtin';
      models.set(model.id, {
        id: `${providerId}/${model.id}`,
        model: model.id,
        name: effective.name || model.id,
        enabled: enabled.has(`${providerId}/${model.id}`),
        contextWindow: effective.contextWindow,
        maxTokens: effective.maxTokens,
        supportsImages: Array.isArray(effective.input) && effective.input.includes('image'),
        reasoning: Boolean(effective.reasoning),
        origin,
        deletable: origin !== 'builtin',
      });
    }
    // 配置存在但运行时尚未列出的模型仍需可见，方便修复或删除。
    for (const model of configuredModels) {
      if (models.has(model.id)) continue;
      models.set(model.id, {
        id: `${providerId}/${model.id}`,
        model: model.id,
        name: model.name || model.id,
        enabled: enabled.has(`${providerId}/${model.id}`),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: Array.isArray(model.input) && model.input.includes('image'),
        reasoning: Boolean(model.reasoning),
        origin: 'configured',
        deletable: true,
      });
    }
    return {
      models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  });

  // 提供方编辑框的初始值（自定义配置优先，其次用目录默认值）
  ipcMain.handle('pi:provider-config', async (_event, providerId) => {
    const runtime = await getRuntime();
    const providers = readConfig(modelsFile(), { providers: {} }).providers || {};
    const defaults = runtime.getProviders().find((provider) => provider.id === providerId);
    const defaultModel = runtime.getModels().find((model) => model.provider === providerId);
    if (!Object.hasOwn(providers, providerId) && !defaults) throw new Error('模型来源不存在');
    const config = providers[providerId] || {};
    return {
      providerId,
      name: config.name || defaults?.name || providerId,
      baseUrl: config.baseUrl || defaults?.baseUrl || defaultModel?.baseUrl || '',
      api: config.api || defaultModel?.api || 'openai-completions',
      icon: config.icon || '',
      modelsUrl: discoverySettings()[providerId]?.modelsUrl || '',
    };
  });

  // 添加 / 编辑提供方（可同时保存 API Key）
  ipcMain.handle('pi:add-provider', async (_event, input) => {
    const discoveryUrl = validateDiscoveryUrl(input.modelsUrl);
    const runtime = await getRuntime();
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? await prepareKey(input.apiKey) : '';
    const auth = readConfig(authFile(), {});
    const models = updateProvider(
      readConfig(modelsFile(), { providers: {} }),
      input,
      input.editing ? runtime.getProviders().map((provider) => provider.id) : Object.keys(auth),
    );
    writeConfig(modelsFile(), models);
    saveDiscoverySettings(input.providerId.trim(), discoveryUrl);
    if (apiKey) writeConfig(authFile(), { ...auth, [input.providerId.trim()]: { type: 'api_key', key: apiKey } }, 0o600);
    const runtimeRefresh = await refreshModelRuntime('模型来源');
    return {
      settings: { ...await settingsSnapshot(DEFAULT_CWD), runtimeRefresh },
      models: await availableModels(),
    };
  });

  // 添加 / 编辑模型配置。origin=builtin 时写入 modelOverrides，保护内置目录。
  ipcMain.handle('pi:add-custom-model', async (_event, input) => {
    const runtime = await getRuntime();
    const config = readConfig(modelsFile(), { providers: {} });
    writeConfig(modelsFile(), updateCustomModel(
      config,
      input,
      runtime.getProviders().map((provider) => provider.id),
      runtime.getModels().filter((model) => model.provider === input.providerId).map((model) => model.id),
    ));
    return settingsAfterRuntimeChange('模型目录');
  });

  // 删除自定义模型或覆盖配置，并把它从启用列表里移除
  ipcMain.handle('pi:remove-custom-model', async (_event, { providerId, modelId }) => {
    const config = readConfig(modelsFile(), { providers: {} });
    writeConfig(modelsFile(), removeCustomModel(config, { providerId, modelId }));

    const settings = readConfig(settingsFile(), {});
    settings.enabledModels = (settings.enabledModels || []).filter((id) => id !== `${providerId}/${modelId}`);
    writeConfig(settingsFile(), settings);
    return settingsAfterRuntimeChange('模型目录');
  });

  // 预览第三方 /models 接口。API Key 只在主进程内解析，不返回给渲染进程。
  ipcMain.handle('pi:discover-provider-models', async (_event, { providerId }) => {
    if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('请选择模型来源');
    const runtime = await getRuntime();
    const config = readConfig(modelsFile(), { providers: {} });
    const configured = config.providers?.[providerId];
    const runtimeProvider = runtime.getProviders().find((provider) => provider.id === providerId);
    if (!configured && !runtimeProvider) throw new Error('模型来源不存在');
    const runtimeModel = runtime.getModels().find((model) => model.provider === providerId);
    let apiKey = '';
    try {
      const resolved = await runtime.getAuth(providerId);
      apiKey = resolved?.auth?.apiKey || '';
    } catch {
      /* 公共端点可能不要求认证。 */
    }
    return fetchProviderModelDiscovery({
      baseUrl: configured?.baseUrl || runtimeProvider?.baseUrl || runtimeModel?.baseUrl || '',
      modelsUrl: discoverySettings()[providerId]?.modelsUrl || '',
      api: configured?.api || runtimeModel?.api || 'openai-completions',
      apiKey,
    });
  });

  // 合并已发现的模型；已存在模型及其高级字段保持不变。
  ipcMain.handle('pi:import-provider-models', async (_event, { providerId, models }) => {
    const runtime = await getRuntime();
    const config = readConfig(modelsFile(), { providers: {} });
    writeConfig(modelsFile(), importDiscoveredModels(
      config,
      { providerId, models },
      runtime.getProviders().map((provider) => provider.id),
      runtime.getModels().filter((model) => model.provider === providerId).map((model) => model.id),
    ));
    return settingsAfterRuntimeChange('模型目录');
  });

  // 保存启用的模型子集（写回 Pi 的 settings.json，CLI 也生效）
  ipcMain.handle('pi:set-enabled-models', async (_event, models) => {
    if (!Array.isArray(models)) throw new Error('模型列表无效');
    const settings = readJson(settingsFile(), {});
    settings.enabledModels = models.filter((item) => typeof item === 'string');
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    return {
      ...await settingsSnapshot(DEFAULT_CWD),
      runtimeRefresh: await requestAgentRuntimeRefresh('启用模型'),
    };
  });

  // 保存 API Key：写 auth.json（600），并清掉 models.json 里的旧 apiKey 覆盖
  ipcMain.handle('pi:set-key', async (_event, { providerId, apiKey }) => {
    if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('请选择模型来源');
    const value = await prepareKey(apiKey);
    const auth = readAuth();
    auth[providerId] = { type: 'api_key', key: value };
    writeConfig(authFile(), auth, 0o600);

    const configured = readConfig(modelsFile(), { providers: {} });
    if (configured.providers?.[providerId]?.apiKey !== undefined) {
      delete configured.providers[providerId].apiKey;
      writeConfig(modelsFile(), configured);
    }
    return settingsAfterRuntimeChange('模型凭据');
  });
}

module.exports = { registerModelsIpc, setDefaultModel, setDefaultThinkingLevel };
