/**
 * Model-source IPC backed entirely by Studio SQLite.
 *
 * Mutations rebuild the live pi-ai Models instance. Durable reads that
 * instance through a getter, so newly saved keys and catalogs are available to
 * the next request without reopening the harness.
 */

const { ipcMain } = require('electron');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  getStudioModelsRuntime,
  rebuildStudioModels,
} = require('../core/studio-models.cjs');
const {
  availableModels,
  persistDefaultModel,
  persistDefaultThinkingLevel,
  resolveProviderApiKey,
  supportedThinkingLevels,
} = require('../services/models.cjs');
const { settingsSnapshot } = require('../services/settings.cjs');
const { DEFAULT_CWD } = require('../core/state.cjs');
const { fetchProviderModelDiscovery, httpUrl } = require('../model-discovery.cjs');
const {
  effectiveThinkingLevels,
} = require('../core/thinking-levels.cjs');
const {
  loadCachedModelsDevCatalog,
  loadModelsDevCatalog,
  mergeDiscoveredModelMetadata,
  modelSources,
  storedModelMetadata,
} = require('../core/model-metadata.cjs');

function normalizeUrl(value, label = '模型列表地址') {
  const url = typeof value === 'string' ? value.trim() : '';
  if (url && !httpUrl(url)) throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址`);
  return url;
}

function providerIdOf(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error('模型来源 ID 格式无效');
  return id;
}

async function setDefaultModel(modelRef) {
  const runtime = await getStudioModelsRuntime();
  return persistDefaultModel(runtime, modelRef);
}

async function setDefaultThinkingLevel(level) {
  const runtime = await getStudioModelsRuntime();
  return persistDefaultThinkingLevel(runtime, level);
}

async function rebuildAndSnapshot(cwd = DEFAULT_CWD) {
  await rebuildStudioModels();
  return settingsSnapshot(cwd);
}

async function rebuildAndRefresh(cwd = DEFAULT_CWD) {
  await rebuildStudioModels();
  return {
    models: await availableModels(),
    settings: await settingsSnapshot(cwd),
  };
}

function registerModelsIpc() {
  ipcMain.handle('pi:models', async () => availableModels());
  ipcMain.handle('pi:set-model', async (_event, modelRef) => setDefaultModel(modelRef));
  ipcMain.handle('pi:set-default-model', async (_event, modelRef) => setDefaultModel(modelRef));
  ipcMain.handle('pi:set-thinking-level', async (_event, { level } = {}) => setDefaultThinkingLevel(level));
  ipcMain.handle('pi:set-default-thinking-level', async (_event, { level } = {}) => setDefaultThinkingLevel(level));

  ipcMain.handle('pi:provider-models', async (_event, providerId) => {
    const db = getStudioDatabase();
    const provider = db.getProvider(providerId);
    if (!provider) throw new Error('模型来源不存在');
    const runtime = await getStudioModelsRuntime();
    const metadataCatalogs = [
      loadCachedModelsDevCatalog(),
      runtime.officialCatalog,
    ];
    return {
      models: db.listModels(providerId).map((model) => {
        const sources = modelSources(metadataCatalogs, {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          modelId: model.modelId,
        });
        const metadata = storedModelMetadata(model, sources);
        const runtimeModel = runtime.models.getModel(model.providerId, model.modelId);
        return {
          id: `${model.providerId}/${model.modelId}`,
          model: model.modelId,
          name: metadata.name,
          enabled: model.enabled,
          contextWindow: metadata.contextWindow,
          maxTokens: metadata.maxTokens,
          supportsImages: Boolean(metadata.supportsImages),
          reasoning: Boolean(runtimeModel?.reasoning ?? metadata.reasoning),
          thinkingLevels: runtimeModel && metadata.reasoning
            ? supportedThinkingLevels(runtimeModel, runtime)
            : effectiveThinkingLevels(metadata.thinkingLevels, metadata.reasoning),
          origin: model.source === 'builtin' ? 'builtin' : model.source === 'override' ? 'override' : 'configured',
          deletable: model.source !== 'builtin',
        };
      }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  });

  ipcMain.handle('pi:provider-config', async (_event, providerId) => {
    const provider = getStudioDatabase().getProvider(providerId);
    if (!provider) throw new Error('模型来源不存在');
    return {
      providerId: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      icon: provider.icon,
      modelsUrl: provider.modelsUrl,
      builtin: provider.builtin,
      enabled: provider.enabled,
    };
  });

  ipcMain.handle('pi:add-provider', async (_event, input = {}) => {
    const id = providerIdOf(input.providerId);
    const db = getStudioDatabase();
    const existing = db.getProvider(id);
    const api = typeof input.api === 'string' && input.api ? input.api : existing?.api || 'openai-completions';
    const baseUrl = normalizeUrl(input.baseUrl, 'Base URL');
    db.upsertProvider({
      id,
      name: String(input.name || existing?.name || id).trim(),
      baseUrl,
      api,
      icon: String(input.icon || existing?.icon || ''),
      modelsUrl: normalizeUrl(input.modelsUrl),
      builtin: existing?.builtin ?? false,
      enabled: input.enabled ?? existing?.enabled ?? true,
    });
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      const runtime = await getStudioModelsRuntime();
      await runtime.credentials.modify(id, () => ({ type: 'api_key', key: input.apiKey.trim() }));
    }
    return rebuildAndRefresh(input.cwd);
  });

  ipcMain.handle('pi:set-provider-enabled', async (_event, { providerId, enabled, cwd } = {}) => {
    const id = providerIdOf(providerId);
    const db = getStudioDatabase();
    if (!db.getProvider(id)) throw new Error('模型来源不存在');
    db.setProviderEnabled(id, enabled !== false);
    return rebuildAndSnapshot(cwd);
  });

  ipcMain.handle('pi:remove-provider', async (_event, { providerId, cwd } = {}) => {
    const id = providerIdOf(providerId);
    const db = getStudioDatabase();
    const provider = db.getProvider(id);
    if (!provider) return rebuildAndSnapshot(cwd);
    db.deleteProvider(id);
    return rebuildAndSnapshot(cwd);
  });

  ipcMain.handle('pi:add-custom-model', async (_event, input = {}) => {
    const providerId = providerIdOf(input.providerId);
    const db = getStudioDatabase();
    const provider = db.getProvider(providerId);
    if (!provider) throw new Error('请先创建或选择模型来源');
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
    if (!modelId) throw new Error('模型 ID 不能为空');
    const existing = db.getModel(providerId, modelId);
    const reasoning = input.reasoning ?? existing?.reasoning ?? false;
    const thinkingLevels = effectiveThinkingLevels(
      input.thinkingLevels ?? existing?.thinkingLevels,
      reasoning,
    );
    db.upsertModel({
      providerId,
      modelId,
      name: String(input.name || existing?.name || modelId).trim(),
      api: input.api || existing?.api || provider.api,
      contextWindow: Number(input.contextWindow) || existing?.contextWindow,
      maxTokens: Number(input.maxTokens) || existing?.maxTokens,
      supportsImages: input.supportsImages ?? existing?.supportsImages ?? false,
      reasoning,
      thinkingLevels,
      metadataSource: 'manual',
      enabled: input.enabled ?? existing?.enabled ?? true,
      source: existing?.source === 'builtin' ? 'override' : existing?.source || 'custom',
    });
    return rebuildAndSnapshot(input.cwd);
  });

  ipcMain.handle('pi:remove-custom-model', async (_event, { providerId, modelId, cwd } = {}) => {
    const db = getStudioDatabase();
    const model = db.getModel(providerId, modelId);
    if (!model) return rebuildAndSnapshot(cwd);
    if (model.source === 'builtin') db.upsertModel({ ...model, enabled: false });
    else db.deleteModel(providerId, modelId);
    return rebuildAndSnapshot(cwd);
  });

  ipcMain.handle('pi:set-enabled-models', async (_event, { models, cwd } = {}) => {
    const refs = models;
    if (!Array.isArray(refs)) throw new Error('模型列表无效');
    getStudioDatabase().setEnabledModels(refs);
    return rebuildAndSnapshot(cwd);
  });

  ipcMain.handle('pi:discover-provider-models', async (_event, { providerId } = {}) => {
    const id = providerIdOf(providerId);
    const provider = getStudioDatabase().getProvider(id);
    if (!provider) throw new Error('模型来源不存在');
    const apiKey = await resolveProviderApiKey(id);
    const runtime = await getStudioModelsRuntime();
    const remoteCatalogPromise = loadModelsDevCatalog();
    const discovery = await fetchProviderModelDiscovery({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      modelsUrl: provider.modelsUrl,
      api: provider.api,
      apiKey,
      officialCatalog: runtime.officialCatalog,
    });
    const remoteCatalog = await remoteCatalogPromise;
    return {
      ...discovery,
      models: mergeDiscoveredModelMetadata(discovery.models, {
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        catalogs: [remoteCatalog, runtime.officialCatalog],
      }),
    };
  });

  ipcMain.handle('pi:import-provider-models', async (_event, { providerId, models, cwd } = {}) => {
    const provider = getStudioDatabase().getProvider(providerId);
    if (!provider) throw new Error('模型来源不存在');
    if (!Array.isArray(models)) throw new Error('模型列表无效');
    const db = getStudioDatabase();
    for (const item of models) {
      const modelId = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!modelId) continue;
      const existing = db.getModel(providerId, modelId);
      const reasoning = item.reasoning ?? existing?.reasoning ?? false;
      db.upsertModel({
        providerId,
        modelId,
        name: String(item.name || existing?.name || modelId),
        api: item.api || existing?.api || provider.api,
        contextWindow: item.contextWindow ?? existing?.contextWindow,
        maxTokens: item.maxTokens ?? existing?.maxTokens,
        supportsImages: item.supportsImages ?? existing?.supportsImages ?? false,
        reasoning,
        thinkingLevels: effectiveThinkingLevels(
          item.thinkingLevels ?? existing?.thinkingLevels,
          reasoning,
        ),
        metadataSource: 'resolved',
        // The renderer only submits models explicitly selected by the user.
        // Newly imported models therefore enter the picker immediately;
        // re-importing an existing row keeps its current enabled state.
        enabled: existing?.enabled ?? true,
        source: existing?.source === 'builtin' ? 'builtin' : existing?.source || 'custom',
      });
    }
    return rebuildAndSnapshot(cwd);
  });

  ipcMain.handle('pi:set-key', async (_event, { providerId, apiKey } = {}) => {
    const id = providerIdOf(providerId);
    if (!getStudioDatabase().getProvider(id)) throw new Error('模型来源不存在');
    const value = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!value) throw new Error('API Key 不能为空');
    const runtime = await getStudioModelsRuntime();
    await runtime.credentials.modify(id, () => ({ type: 'api_key', key: value }));
    return rebuildAndRefresh();
  });

  ipcMain.handle('pi:delete-key', async (_event, { providerId } = {}) => {
    const runtime = await getStudioModelsRuntime();
    await runtime.credentials.delete(providerId);
    return rebuildAndRefresh();
  });
}

module.exports = {
  registerModelsIpc,
  setDefaultModel,
  setDefaultThinkingLevel,
};
