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
  modelOptionsModule,
} = require('../core/state.cjs');
const { updateProvider, updateCustomModel } = require('../settings-config.cjs');
const { prepareKey } = require('../credential-env.cjs');
const { modelInfo, availableModels } = require('../services/models.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');

/** 切换当前模型：校验存在性 → 持久化 → 清空运行中的会话。 */
async function setModel(modelRef, cwd) {
  if (typeof modelRef !== 'string' || !modelRef.includes('/')) throw new Error('模型格式无效');
  const [provider, ...parts] = modelRef.split('/');
  if (!(await getRuntime()).getModel(provider, parts.join('/'))) throw new Error('模型已不存在，请刷新后重试');
  saveConfig(modelRef);
  setModelRef(modelRef);
  invalidateModelRuntime();
  return modelInfo(cwd || DEFAULT_CWD);
}

function registerModelsIpc() {
  // 模型选择器数据
  ipcMain.handle('pi:models', async (_event, cwd) => availableModels(cwd || DEFAULT_CWD));

  // 切换模型
  ipcMain.handle('pi:set-model', async (_event, modelRef, cwd) => setModel(modelRef, cwd));

  // 调整推理强度（只作用于当前模型）
  ipcMain.handle('pi:set-thinking-level', async (_event, { modelRef, level, cwd }) => {
    if (modelRef !== getModelRef()) throw new Error('当前模型已改变，请重新选择推理等级');
    const [provider, ...parts] = getModelRef().split('/');
    const model = (await getRuntime()).getModel(provider, parts.join('/'));
    if (!model) throw new Error('当前模型不存在');
    modelOptionsModule().validateThinkingLevel(model, level);

    const preferences = { ...getThinkingPreferences(), [getModelRef()]: level };
    saveConfig(getModelRef(), preferences);
    setThinkingPreferences(preferences);
    return modelInfo(cwd || DEFAULT_CWD);
  });

  // 某个提供方下的模型 + 是否启用
  ipcMain.handle('pi:provider-models', async (_event, providerId) => {
    const runtime = await getRuntime();
    const settings = readJson(settingsFile(), {});
    const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : []);
    return {
      models: runtime.getModels()
        .filter((model) => model.provider === providerId)
        .map((model) => ({
          id: `${model.provider}/${model.id}`,
          model: model.id,
          name: model.name,
          enabled: enabled.has(`${model.provider}/${model.id}`),
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsImages: Array.isArray(model.input) && model.input.includes('image'),
        })),
    };
  });

  // 提供方编辑框的初始值（自定义配置优先，其次用目录默认值）
  ipcMain.handle('pi:provider-config', async (_event, providerId) => {
    const runtime = await getRuntime();
    const providers = readConfig(modelsFile(), { providers: {} }).providers || {};
    const defaults = runtime.getModels().find((model) => model.provider === providerId);
    if (!Object.hasOwn(providers, providerId) && !defaults) throw new Error('模型来源不存在');
    const config = providers[providerId] || {};
    return {
      providerId,
      baseUrl: config.baseUrl || defaults?.baseUrl || '',
      api: config.api || defaults?.api || 'openai-completions',
      icon: config.icon || '',
    };
  });

  // 添加 / 编辑提供方（可同时保存 API Key）
  ipcMain.handle('pi:add-provider', async (_event, input) => {
    const runtime = await getRuntime();
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? await prepareKey(input.apiKey) : '';
    const auth = readConfig(authFile(), {});
    const models = updateProvider(
      readConfig(modelsFile(), { providers: {} }),
      input,
      input.editing ? runtime.getProviders().map((provider) => provider.id) : Object.keys(auth),
    );
    writeConfig(modelsFile(), models);
    if (apiKey) writeConfig(authFile(), { ...auth, [input.providerId.trim()]: { type: 'api_key', key: apiKey } }, 0o600);
    invalidateModelRuntime();
    return { settings: await settingsSnapshot(DEFAULT_CWD), models: await availableModels() };
  });

  // 添加 / 编辑自定义模型
  ipcMain.handle('pi:add-custom-model', async (_event, input) => {
    const runtime = await getRuntime();
    const config = readConfig(modelsFile(), { providers: {} });
    writeConfig(modelsFile(), updateCustomModel(config, input, runtime.getProviders().map((provider) => provider.id)));
    invalidateModelRuntime();
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 删除自定义模型，并把它从启用列表里移除
  ipcMain.handle('pi:remove-custom-model', async (_event, { providerId, modelId }) => {
    const config = readConfig(modelsFile(), { providers: {} });
    const provider = config.providers?.[providerId];
    if (!provider || !Array.isArray(provider.models)) throw new Error('模型不存在');
    provider.models = provider.models.filter((model) => model.id !== modelId);
    writeConfig(modelsFile(), config);

    const settings = readConfig(settingsFile(), {});
    settings.enabledModels = (settings.enabledModels || []).filter((id) => id !== `${providerId}/${modelId}`);
    writeConfig(settingsFile(), settings);
    invalidateModelRuntime();
    return settingsSnapshot(DEFAULT_CWD);
  });

  // 保存启用的模型子集（写回 Pi 的 settings.json，CLI 也生效）
  ipcMain.handle('pi:set-enabled-models', async (_event, models) => {
    if (!Array.isArray(models)) throw new Error('模型列表无效');
    const settings = readJson(settingsFile(), {});
    settings.enabledModels = models.filter((item) => typeof item === 'string');
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    return settingsSnapshot(DEFAULT_CWD);
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
    invalidateModelRuntime();
    return settingsSnapshot();
  });
}

module.exports = { registerModelsIpc };
