/**
 * Studio-owned model runtime.
 *
 * Pi ships provider definitions, while Studio persists only the sources and
 * models the user explicitly configures. Enablement, overrides, defaults, and
 * encrypted credentials all live in Studio SQLite. This module never reads
 * ~/.pi, settings.json, models.json, auth.json, shell API-key variables, or
 * pi-coding-agent.
 */

const { getStudioDatabase } = require('./studio-db.cjs');
const { thinkingLevelMapForLevels } = require('./thinking-levels.cjs');
const {
  createOfficialCatalog,
  loadCachedModelsDevCatalog,
  modelSources,
  storedModelMetadata,
} = require('./model-metadata.cjs');
const CATALOG_REVISION_KEY = 'studio.models.catalogRevision';
// v1 copied every bundled provider and model into SQLite as enabled. v2 keeps
// the bundled definitions as a lookup catalog and requires explicit setup.
const CATALOG_REVISION = 2;

const API_FACTORIES = Object.freeze({
  'openai-completions': ['@earendil-works/pi-ai/api/openai-completions.lazy', 'openAICompletionsApi'],
  'openai-responses': ['@earendil-works/pi-ai/api/openai-responses.lazy', 'openAIResponsesApi'],
  'openai-codex-responses': ['@earendil-works/pi-ai/api/openai-codex-responses.lazy', 'openAICodexResponsesApi'],
  'anthropic-messages': ['@earendil-works/pi-ai/api/anthropic-messages.lazy', 'anthropicMessagesApi'],
  'google-generative-ai': ['@earendil-works/pi-ai/api/google-generative-ai.lazy', 'googleGenerativeAIApi'],
  'google-vertex': ['@earendil-works/pi-ai/api/google-vertex.lazy', 'googleVertexApi'],
  'mistral-conversations': ['@earendil-works/pi-ai/api/mistral-conversations.lazy', 'mistralConversationsApi'],
  'bedrock-converse-stream': ['@earendil-works/pi-ai/api/bedrock-converse-stream.lazy', 'bedrockConverseStreamApi'],
  'azure-openai-responses': ['@earendil-works/pi-ai/api/azure-openai-responses.lazy', 'azureOpenAIResponsesApi'],
  'pi-messages': ['@earendil-works/pi-ai/api/pi-messages.lazy', 'piMessagesApi'],
});

let current;
let initialization;
let revision = 0;
const lockTails = new Map();

function importCached(specifier) {
  return import(specifier);
}

function createCredentialStore(db) {
  async function enqueue(providerId, task) {
    const previous = lockTails.get(providerId) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    lockTails.set(providerId, tail);
    try {
      return await run;
    } finally {
      if (lockTails.get(providerId) === tail) lockTails.delete(providerId);
    }
  }

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return db.readCredential(providerId);
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return db.listCredentials().flatMap(({ providerId, credential }) => {
        return credential?.type ? [{ providerId, type: credential.type }] : [];
      });
    },
    modify(providerId, callback, options) {
      return enqueue(providerId, async () => {
        options?.signal?.throwIfAborted();
        const currentCredential = db.readCredential(providerId);
        const next = await callback(currentCredential);
        options?.signal?.throwIfAborted();
        if (next === undefined) return currentCredential;
        db.writeCredential(providerId, next);
        return next;
      });
    },
    delete(providerId, options) {
      return enqueue(providerId, async () => {
        options?.signal?.throwIfAborted();
        db.deleteCredential(providerId);
      });
    },
  };
}

async function apiMapForModels(models) {
  const apiNames = [...new Set(models.map((model) => model.api).filter(Boolean))];
  const entries = await Promise.all(apiNames.map(async (api) => {
    const definition = API_FACTORIES[api];
    if (!definition) throw new Error(`暂不支持模型 API 类型：${api}`);
    const [specifier, exportName] = definition;
    const module = await importCached(specifier);
    return [api, module[exportName]()];
  }));
  return Object.fromEntries(entries);
}

function customAuth(baseUrl) {
  return {
    apiKey: {
      name: 'Pi Studio API Key',
      async resolve({ credential }) {
        if (!credential?.key) return undefined;
        return {
          auth: {
            apiKey: credential.key,
            ...(baseUrl ? { baseUrl } : {}),
          },
          env: credential.env,
          source: 'Studio SQLite',
        };
      },
    },
  };
}

function providerBaseUrl(provider) {
  return provider?.baseUrl || provider?.getModels?.()[0]?.baseUrl || '';
}

function estimatedCost(model) {
  return model?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function databaseModel(provider, row, metadataCatalogs = []) {
  const sources = modelSources(metadataCatalogs, {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    modelId: row.modelId,
  });
  const resolved = storedModelMetadata(row, sources);
  const officialMap = sources.find((source) => source?.thinkingLevelMap)?.thinkingLevelMap;
  const model = {
    id: resolved.id,
    name: resolved.name || resolved.id,
    api: resolved.api || provider.api || 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: Boolean(resolved.reasoning),
    input: ['text', ...(resolved.supportsImages ? ['image'] : [])],
    cost: estimatedCost(),
    contextWindow: resolved.contextWindow || 128_000,
    maxTokens: resolved.maxTokens || 16_384,
  };
  if (resolved.reasoning) {
    model.thinkingLevelMap = thinkingLevelMapForLevels(
      resolved.thinkingLevels,
      officialMap,
    );
  }
  return model;
}

function applyModelRow(model, row) {
  const next = {
    ...model,
    name: row.name || model.name,
    api: row.api || model.api,
    reasoning: row.reasoning ?? model.reasoning,
    input: row.supportsImages === undefined
      ? model.input
      : ['text', ...(row.supportsImages ? ['image'] : []), ...(model.input || []).filter((item) => item !== 'text' && item !== 'image')],
    contextWindow: row.contextWindow || model.contextWindow,
    maxTokens: row.maxTokens || model.maxTokens,
  };
  if (row.thinkingLevels !== undefined) {
    next.thinkingLevelMap = thinkingLevelMapForLevels(row.thinkingLevels, model.thinkingLevelMap);
  }
  return next;
}

function needsCustomProvider(provider, baseProvider, rows) {
  if (!provider.builtin || !baseProvider) return true;
  const nativeBase = providerBaseUrl(baseProvider);
  if (provider.baseUrl && nativeBase && provider.baseUrl !== nativeBase) return true;
  return rows.some((row) => row.source !== 'builtin');
}

function isPristineSeededProvider(provider, builtin, providerModels, credentialIds) {
  if (!provider.builtin || !builtin || credentialIds.has(provider.id) || !provider.enabled) {
    return false;
  }
  const expectedName = builtin.name || builtin.id;
  const expectedBaseUrl = providerBaseUrl(builtin) || builtin.getModels?.()[0]?.baseUrl || '';
  if (provider.name !== expectedName) return false;
  if ((provider.baseUrl || '') !== expectedBaseUrl) return false;
  if (provider.modelsUrl) return false;
  return providerModels.every((model) => model.source === 'builtin' && model.enabled);
}

/**
 * Retire the v1 bulk seed without touching a provider the user configured.
 *
 * It is intentionally conservative: credentials, disabled providers or models,
 * custom/override rows, and edited connection details all protect a provider
 * from cleanup. Only the exact untouched catalog copied by v1 is removed.
 */
function retireAutoSeededCatalog(db, models) {
  const storedRevision = Number(db.getSetting(CATALOG_REVISION_KEY, 0));
  if (storedRevision >= CATALOG_REVISION) return;

  if (storedRevision === 1) {
    const baseProviders = new Map(models.getProviders().map((provider) => [provider.id, provider]));
    const credentialIds = new Set(db.listCredentials().map(({ providerId }) => providerId));
    for (const provider of db.listProviders()) {
      const builtin = baseProviders.get(provider.id);
      if (isPristineSeededProvider(
        provider,
        builtin,
        db.listModels(provider.id),
        credentialIds,
      )) {
        db.deleteProvider(provider.id);
      }
    }

    const defaultRef = db.getSetting('studio.models.defaultModelRef', '');
    if (defaultRef && !db.listEnabledModels().some(
      (model) => `${model.providerId}/${model.modelId}` === defaultRef,
    )) {
      db.deleteSetting('studio.models.defaultModelRef');
    }
  }

  db.setSetting(CATALOG_REVISION_KEY, CATALOG_REVISION);
}

async function buildRuntime(db) {
  const [{ createProvider, getSupportedThinkingLevels }, { builtinModels }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/providers/all'),
  ]);
  const credentials = createCredentialStore(db);
  const models = builtinModels({
    credentials,
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
    identity: {
      userAgent: 'detailed',
      attribution: {
        name: 'Pi Studio',
        url: 'https://github.com/huangrx6/pi-studio',
        categories: ['desktop-agent'],
      },
    },
  });
  const officialCatalog = createOfficialCatalog(models.getProviders());
  const metadataCatalogs = [loadCachedModelsDevCatalog(), officialCatalog];
  retireAutoSeededCatalog(db, models);

  const baseProviders = new Map(models.getProviders().map((provider) => [provider.id, provider]));
  for (const provider of db.listProviders().filter((item) => item.enabled)) {
    const providerModels = db.listModels(provider.id);
    const builtin = baseProviders.get(provider.id);
    const baseCatalog = builtin?.getModels() || [];
    const byId = new Map(baseCatalog.map((model) => [model.id, model]));
    let catalog;
    if (provider.builtin && baseCatalog.length > 0) {
      catalog = baseCatalog.map((model) => {
        const row = providerModels.find((item) => item.modelId === model.id);
        return row ? applyModelRow(model, row) : model;
      });
      for (const row of providerModels) {
        if (!byId.has(row.modelId)) catalog.push(databaseModel(provider, row, metadataCatalogs));
      }
    } else {
      catalog = providerModels.map((row) => databaseModel(provider, row, metadataCatalogs));
    }
    // A source may be configured before its first model. Keep it in Studio
    // SQLite, but Pi AI providers require at least one API implementation.
    if (catalog.length === 0) continue;
    if (!needsCustomProvider(provider, builtin, providerModels)) continue;
    catalog = catalog.map((model) => ({
      ...model,
      provider: provider.id,
      baseUrl: provider.baseUrl || model.baseUrl,
    }));
    models.setProvider(createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl || providerBaseUrl(builtin),
      auth: customAuth(provider.baseUrl || providerBaseUrl(builtin)),
      models: catalog,
      api: await apiMapForModels(catalog),
    }));
  }

  return {
    db,
    models,
    officialCatalog,
    metadataCatalogs,
    credentials,
    getSupportedThinkingLevels,
    providerBaseUrl,
  };
}

async function initializeStudioModels() {
  if (current?.db?.isOpen()) return current;
  if (current) current = undefined;
  initialization ??= buildRuntime(getStudioDatabase()).then((runtime) => {
    current = runtime;
    revision += 1;
    return runtime;
  }).finally(() => {
    initialization = undefined;
  });
  return initialization;
}

function closeStudioModelsRuntime() {
  current = undefined;
  initialization = undefined;
}

async function getStudioModelsRuntime() {
  return initializeStudioModels();
}

async function getStudioModels() {
  return (await getStudioModelsRuntime()).models;
}

function getStudioModelsRuntimeSync() {
  return current;
}

async function getCredentialStore() {
  return (await getStudioModelsRuntime()).credentials;
}

async function rebuildStudioModels() {
  current = await buildRuntime(getStudioDatabase());
  revision += 1;
  return current.models;
}

function studioModelsRevision() {
  return revision;
}

async function getProviderCatalog() {
  const { models, providerBaseUrl: baseUrlOf } = await getStudioModelsRuntime();
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: baseUrlOf(provider),
    authenticated: false,
  }));
}

module.exports = {
  closeStudioModelsRuntime,
  getCredentialStore,
  getProviderCatalog,
  getStudioModels,
  getStudioModelsRuntime,
  getStudioModelsRuntimeSync,
  initializeStudioModels,
  providerBaseUrl,
  rebuildStudioModels,
  retireAutoSeededCatalog,
  studioModelsRevision,
};
