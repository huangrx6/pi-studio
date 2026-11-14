/**
 * Model-source IPC backed entirely by Studio SQLite.
 *
 * Mutations rebuild the live pi-ai Models instance. Durable reads that
 * instance through a getter, so newly saved keys and catalogs are available to
 * the next request without reopening the harness.
 */

const { ipcMain } = require('electron');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { encryptValueAsync } = require('../core/secure-value.cjs');
const { getRuntimePolicy } = require('../core/app-settings.cjs');
const { autoCompactReserveTokens } = require('../core/context-policy.cjs');
const {
  getStudioModelsRuntime,
  rebuildStudioModels,
  withProviderCredentialLock,
  invalidateProviderCredentials,
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

async function rebuildAndRefresh(cwd = DEFAULT_CWD) {
  await rebuildStudioModels();
  return {
    models: await availableModels(),
    settings: await settingsSnapshot(cwd),
  };
}

const MODEL_REFRESH_ERROR = '模型运行时或设置列表刷新失败，请重试刷新。';

async function refreshModelsProjection(cwd) {
  try {
    return await rebuildAndRefresh(cwd);
  } catch {
    // Runtime/provider errors can contain connection details. Never return the
    // raw cause, credentials, or a failed projection as though the write failed.
    throw new Error(MODEL_REFRESH_ERROR);
  }
}

async function committedModelsProjection(cwd) {
  try {
    return { committed: true, projection: { status: 'ready', value: await refreshModelsProjection(cwd) } };
  } catch {
    return { committed: true, projection: { status: 'error', message: MODEL_REFRESH_ERROR } };
  }
}

function registerModelsIpc() {
  ipcMain.handle('pi:models', async () => availableModels());
  ipcMain.handle('pi:models-refresh', async (_event, cwd) => refreshModelsProjection(cwd));
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

  ipcMain.handle('pi:context-policy', async (_event, { modelRef } = {}) => {
    const ref = typeof modelRef === 'string' ? modelRef.trim() : '';
    const slash = ref.indexOf('/');
    const providerId = slash > 0 ? ref.slice(0, slash) : '';
    const modelId = slash > 0 ? ref.slice(slash + 1) : '';
    const model = providerId && modelId
      ? getStudioDatabase().getModel(providerId, modelId)
      : undefined;
    const policy = getRuntimePolicy().compaction;
    const contextWindow = Math.max(0, Number(model?.contextWindow) || 0);
    return {
      modelRef: ref,
      contextWindow,
      autoCompactPercent: policy.autoCompactPercent,
      // 当前模型实际生效的自动压缩阈值；未知窗口或阈值关闭时为 null。
      compactAtTokens: contextWindow > 0 && policy.enabled && policy.autoCompactPercent > 0
        ? contextWindow - autoCompactReserveTokens(contextWindow, policy.autoCompactPercent)
        : null,
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
    const baseUrl = normalizeUrl(input.baseUrl, 'Base URL');
    const modelsUrl = normalizeUrl(input.modelsUrl);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    try {
      // Keep the synchronous transaction seam for tests and older embedders
      // that wrap the legacy method. Production Electron uses the async path.
      if (Object.hasOwn(db, 'writeCredential')) {
        await withProviderCredentialLock(id, () => db.transaction(() => {
          const existing = db.getProvider(id);
          const api = typeof input.api === 'string' && input.api ? input.api : existing?.api || 'openai-completions';
          db.upsertProvider({
            id,
            name: String(input.name || existing?.name || id).trim(),
            baseUrl,
            api,
            icon: String(input.icon || existing?.icon || ''),
            modelsUrl,
            builtin: existing?.builtin ?? false,
            enabled: input.enabled ?? existing?.enabled ?? true,
          });
          if (apiKey) db.writeCredential(id, { type: 'api_key', key: apiKey });
        }));
        return committedModelsProjection(input.cwd);
      }
      const encryptedCredential = apiKey
        ? await encryptValueAsync({ type: 'api_key', key: apiKey })
        : undefined;
      await withProviderCredentialLock(id, () => db.transaction(() => {
        const existing = db.getProvider(id);
        const api = typeof input.api === 'string' && input.api ? input.api : existing?.api || 'openai-completions';
        db.upsertProvider({
          id,
          name: String(input.name || existing?.name || id).trim(),
          baseUrl,
          api,
          icon: String(input.icon || existing?.icon || ''),
          modelsUrl,
          builtin: existing?.builtin ?? false,
          enabled: input.enabled ?? existing?.enabled ?? true,
        });
        // Both rows share one synchronous SQLite transaction. Encryption failure
        // rolls back the provider too; empty input intentionally retains its key.
        if (encryptedCredential) {
          db.writeCredentialEnvelope(id, encryptedCredential, Date.now(), { type: 'api_key', key: apiKey });
        }
      }));
    } catch (error) {
      throw new Error(error?.code === 'SECURE_STORAGE_UNAVAILABLE'
        ? '系统安全存储不可用，模型来源与凭据均未更改。'
        : '模型来源保存失败，配置与凭据均未更改。请重试。');
    }
    return committedModelsProjection(input.cwd);
  });

  ipcMain.handle('pi:set-provider-enabled', async (_event, { providerId, enabled, cwd } = {}) => {
    const id = providerIdOf(providerId);
    const db = getStudioDatabase();
    if (!db.getProvider(id)) throw new Error('模型来源不存在');
    try { db.transaction(() => db.setProviderEnabled(id, enabled !== false)); }
    catch { throw new Error('模型来源启停失败，配置未更改。请重试。'); }
    return committedModelsProjection(cwd);
  });

  ipcMain.handle('pi:remove-provider', async (_event, { providerId, cwd } = {}) => {
    const id = providerIdOf(providerId);
    const db = getStudioDatabase();
    try {
      // deleteProvider owns its synchronous transaction. Queue it behind an
      // in-flight credential refresh; later modify calls check provider existence.
      await withProviderCredentialLock(id, () => {
        db.deleteProvider(id);
        invalidateProviderCredentials(id);
      });
    } catch { throw new Error('模型来源删除失败，配置与凭据均未更改。请重试。'); }
    return committedModelsProjection(cwd);
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
    try {
      db.transaction(() => db.upsertModel({
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
      }));
    } catch {
      throw new Error('模型保存失败，配置未更改。请重试。');
    }
    return committedModelsProjection(input.cwd);
  });

  ipcMain.handle('pi:remove-custom-model', async (_event, { providerId, modelId, cwd } = {}) => {
    const db = getStudioDatabase();
    try {
      db.transaction(() => {
        const model = db.getModel(providerId, modelId);
        if (!model) return;
        if (model.source === 'builtin') db.upsertModel({ ...model, enabled: false });
        else db.deleteModel(providerId, modelId);
      });
    } catch { throw new Error('模型移除失败，配置未更改。请重试。'); }
    return committedModelsProjection(cwd);
  });

  ipcMain.handle('pi:set-enabled-models', async (_event, { models, cwd } = {}) => {
    const refs = models;
    if (!Array.isArray(refs)) throw new Error('模型列表无效');
    try { getStudioDatabase().setEnabledModels(refs); }
    catch { throw new Error('模型启停失败，配置未更改。请重试。'); }
    return committedModelsProjection(cwd);
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
    try {
      db.transaction(() => {
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
      });
    } catch { throw new Error('模型导入失败，所选模型均未更改。请重试。'); }
    return committedModelsProjection(cwd);
  });

  ipcMain.handle('pi:set-key', async (_event, { providerId, apiKey, cwd } = {}) => {
    const id = providerIdOf(providerId);
    if (!getStudioDatabase().getProvider(id)) throw new Error('模型来源不存在');
    const value = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!value) throw new Error('API Key 不能为空');
    try {
      const runtime = await getStudioModelsRuntime();
      await runtime.credentials.modify(id, () => ({ type: 'api_key', key: value }));
    } catch (error) {
      // Only fixed ownership errors may cross IPC. Storage/runtime causes can
      // contain credentials; neither failure has committed a credential change.
      const message = error?.message;
      if (message === '模型来源不存在，凭据未写入。' || message === '模型来源已变化，凭据未写入。') throw new Error(message);
      throw new Error('凭据保存失败，凭据未更改。请重试。');
    }
    return committedModelsProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });

  ipcMain.handle('pi:delete-key', async (_event, { providerId, cwd } = {}) => {
    const id = providerIdOf(providerId);
    try {
      const runtime = await getStudioModelsRuntime();
      await runtime.credentials.delete(id);
    } catch (error) {
      if (error?.message === '模型来源已变化，凭据未清除。') throw new Error(error.message);
      throw new Error('凭据清除失败，凭据未更改。请重试。');
    }
    return committedModelsProjection(typeof cwd === 'string' ? cwd : DEFAULT_CWD);
  });
}

module.exports = {
  registerModelsIpc,
  setDefaultModel,
  setDefaultThinkingLevel,
};
