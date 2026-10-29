/**
 * Unified model metadata resolution.
 *
 * Source priority is:
 *   1. Explicit values from the provider's model-list response.
 *   2. The independently maintained models.dev catalog.
 *   3. Pi's bundled catalog, including provider-specific thinking maps.
 *
 * Remote catalog failures never prevent model discovery. Reader code works
 * with normalized plain objects so additional catalog adapters can be added
 * without changing SQLite, IPC, or the renderer.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  effectiveThinkingLevels,
  normalizeThinkingLevels,
  thinkingLevelsFromMap,
} = require('./thinking-levels.cjs');
const {
  userDataDirectory,
} = require('./studio-paths.cjs');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_CACHE_VERSION = 1;
const MODELS_DEV_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
const MODELS_DEV_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const DISCOVERY_DECLARATIONS = Symbol('pi-studio.discovery-declarations');
const catalogIndexes = new WeakMap();
let modelsDevMemory;
let modelsDevLoad;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.search = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return '';
  }
}

function baseUrlCandidates(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return [];
  const candidates = new Set([normalized]);
  if (normalized.endsWith('/models')) {
    candidates.add(normalized.slice(0, -'/models'.length));
  }
  for (const candidate of [...candidates]) {
    if (candidate.endsWith('/v1')) candidates.add(candidate.slice(0, -'/v1'.length));
  }
  return [...candidates];
}

function providerBaseUrl(provider) {
  return provider?.baseUrl || provider?.getModels?.()[0]?.baseUrl || '';
}

function createOfficialCatalog(providers) {
  return (providers || []).map((provider) => ({
    id: provider.id,
    name: provider.name || provider.id,
    baseUrl: providerBaseUrl(provider),
    models: provider.getModels?.() || [],
  }));
}

function catalogIndex(catalog) {
  const existing = catalogIndexes.get(catalog);
  if (existing) return existing;
  const byId = new Map();
  const byUrl = new Map();
  for (const provider of catalog) {
    const models = new Map();
    for (const model of provider.models || []) {
      models.set(model.id, model);
      models.set(String(model.id).toLowerCase(), model);
    }
    const entry = { provider, models };
    byId.set(provider.id, entry);
    for (const candidate of baseUrlCandidates(provider.baseUrl)) {
      if (!byUrl.has(candidate)) byUrl.set(candidate, entry);
    }
  }
  const index = { byId, byUrl };
  catalogIndexes.set(catalog, index);
  return index;
}

/**
 * Prefer an exact endpoint match, then the provider ID. This lets a Studio
 * source named "zhipu" reuse metadata from a catalog provider named
 * "zhipuai-coding-plan" without coupling to a specific catalog name.
 */
function resolveOfficialModel(catalog, { providerId, baseUrl, modelId } = {}) {
  const providers = Array.isArray(catalog) ? catalog : [];
  const index = catalogIndex(providers);
  const urls = new Set(baseUrlCandidates(baseUrl));
  for (const url of urls) {
    const entry = index.byUrl.get(url);
    const model = entry?.models.get(modelId)
      || entry?.models.get(String(modelId).toLowerCase());
    if (model) {
      return { provider: entry.provider, model };
    }
  }
  const entry = index.byId.get(providerId);
  const model = entry?.models.get(modelId)
    || entry?.models.get(String(modelId).toLowerCase());
  return model ? { provider: entry.provider, model } : undefined;
}

function markDiscoveryDeclarations(model, declarations) {
  if (!model || typeof model !== 'object') return model;
  Object.defineProperty(model, DISCOVERY_DECLARATIONS, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...declarations }),
    writable: false,
  });
  return model;
}

function discoveryDeclarations(model) {
  return model?.[DISCOVERY_DECLARATIONS] || {};
}

function normalizedSource(source) {
  if (!source) return undefined;
  const input = Array.isArray(source.input)
    ? source.input
    : Array.isArray(source.modalities?.input)
      ? source.modalities.input
      : [];
  const reasoning = Boolean(source.reasoning);
  let thinkingLevels = normalizeThinkingLevels(source.thinkingLevels, reasoning);
  if (thinkingLevels.length === 0 && reasoning && source.thinkingLevelMap) {
    thinkingLevels = thinkingLevelsFromMap(source.thinkingLevelMap);
  }
  return {
    name: source.name || source.id,
    api: source.api,
    supportsImages: input.includes('image'),
    reasoning,
    thinkingLevels,
    thinkingLevelMap: source.thinkingLevelMap,
    contextWindow: positiveInteger(source.contextWindow || source.limit?.context),
    maxTokens: positiveInteger(source.maxTokens || source.limit?.output),
  };
}

/**
 * Merge normalized sources in priority order. Discovery models carry
 * non-enumerable declarations so an explicit API false remains authoritative.
 */
function mergeModelMetadataSources(model, sources, declarations = discoveryDeclarations(model)) {
  const next = { ...model };
  const normalized = (Array.isArray(sources) ? sources : [sources])
    .map(normalizedSource)
    .filter(Boolean);

  const first = (pick) => {
    for (const source of normalized) {
      const value = pick(source);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
  const sourceForImage = normalized.find((source) => typeof source.supportsImages === 'boolean');
  const sourceForReasoning = normalized.find((source) => typeof source.reasoning === 'boolean');

  if (!declarations.nameDeclared && (!next.name || next.name === next.id)) {
    const name = first((source) => source.name);
    if (name) next.name = name;
  }
  next.supportsImages = declarations.supportsImagesDeclared
    ? Boolean(next.supportsImages)
    : Boolean(sourceForImage?.supportsImages ?? next.supportsImages);
  next.reasoning = declarations.reasoningDeclared
    ? Boolean(next.reasoning)
    : Boolean(sourceForReasoning?.reasoning ?? next.reasoning);

  if (next.reasoning) {
    if (!declarations.thinkingLevelsDeclared) {
      const levels = first((source) => source.thinkingLevels.length > 0 ? source.thinkingLevels : undefined);
      if (levels) next.thinkingLevels = levels;
    }
    next.thinkingLevels = effectiveThinkingLevels(next.thinkingLevels, true);
  } else {
    next.thinkingLevels = [];
  }

  if (!next.contextWindow) {
    const contextWindow = first((source) => source.contextWindow);
    if (contextWindow) next.contextWindow = contextWindow;
  }
  if (!next.maxTokens) {
    const maxTokens = first((source) => source.maxTokens);
    if (maxTokens) next.maxTokens = maxTokens;
  }
  if (!next.api) {
    const api = first((source) => source.api);
    if (api) next.api = api;
  }
  Object.defineProperty(next, 'thinkingLevelMap', {
    configurable: true,
    enumerable: false,
    value: first((source) => source.thinkingLevelMap),
    writable: false,
  });
  if (declarations && Object.keys(declarations).length > 0) {
    Object.defineProperty(next, DISCOVERY_DECLARATIONS, {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ ...declarations }),
      writable: false,
    });
  }
  return next;
}

function mergeOfficialModelMetadata(model, official, declarations = discoveryDeclarations(model)) {
  return mergeModelMetadataSources(model, [official], declarations);
}

function storedModelMetadata(row, sources) {
  if (!row) return undefined;
  const settled = row.metadataSource && row.metadataSource !== 'legacy'
    ? {
        contextWindowDeclared: row.contextWindow !== undefined,
        maxTokensDeclared: row.maxTokens !== undefined,
        nameDeclared: true,
        reasoningDeclared: true,
        supportsImagesDeclared: true,
        thinkingLevelsDeclared: row.thinkingLevels !== undefined,
      }
    : undefined;
  return mergeModelMetadataSources({
    id: row.modelId,
    name: row.name || row.modelId,
    api: row.api,
    supportsImages: Boolean(row.supportsImages),
    reasoning: Boolean(row.reasoning),
    thinkingLevels: row.thinkingLevels,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
  }, sources, settled);
}

function modelSources(catalogs, query) {
  return (Array.isArray(catalogs) ? catalogs : [catalogs])
    .map((catalog) => resolveOfficialModel(catalog, query)?.model)
    .filter(Boolean);
}

function mergeDiscoveredModelMetadata(models, {
  providerId,
  baseUrl,
  catalogs = [],
  officialCatalog = [],
} = {}) {
  const allCatalogs = catalogs.length > 0
    ? catalogs
    : officialCatalog
      ? [officialCatalog]
      : [];
  return (models || []).map((model) => mergeModelMetadataSources(
    model,
    modelSources(allCatalogs, { providerId, baseUrl, modelId: model.id }),
  ));
}

function modelsDevThinkingLevels(model) {
  const values = [];
  for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
    if (Array.isArray(option?.values)) values.push(...option.values);
  }
  if (Array.isArray(model.reasoning_levels)) values.push(...model.reasoning_levels);
  return normalizeThinkingLevels(values, true);
}

function createModelsDevCatalog(payload) {
  const providers = payload?.providers && typeof payload.providers === 'object'
    ? payload.providers
    : payload;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Object.entries(providers).flatMap(([providerId, provider]) => {
    if (!provider || typeof provider !== 'object') return [];
    const rawModels = provider.models && typeof provider.models === 'object'
      ? provider.models
      : {};
    const models = Object.entries(rawModels).flatMap(([modelId, model]) => {
      if (!model || typeof model !== 'object') return [];
      const id = typeof model.id === 'string' && model.id.trim() ? model.id.trim() : modelId;
      return [{
        id,
        name: model.name || id,
        api: model.provider?.api || provider.api,
        input: Array.isArray(model.modalities?.input)
          ? model.modalities.input
          : model.attachment
            ? ['text', 'image']
            : ['text'],
        reasoning: Boolean(model.reasoning),
        thinkingLevels: modelsDevThinkingLevels(model),
        contextWindow: positiveInteger(model.limit?.context),
        maxTokens: positiveInteger(model.limit?.output),
      }];
    });
    return models.length > 0
      ? [{
          id: provider.id || providerId,
          name: provider.name || providerId,
          baseUrl: provider.api || '',
          models,
        }]
      : [];
  });
}

function modelsDevCacheFile(cacheDirectory) {
  return path.join(cacheDirectory || userDataDirectory(), 'model-catalogs', 'models.dev.json');
}

function readModelsDevCache(file) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached?.version !== MODELS_DEV_CACHE_VERSION || !cached.payload) return undefined;
    return {
      catalog: createModelsDevCatalog(cached.payload),
      etag: typeof cached.etag === 'string' ? cached.etag : '',
      fetchedAt: Number(cached.fetchedAt) || 0,
      payload: cached.payload,
    };
  } catch {
    return undefined;
  }
}

async function writeModelsDevCache(file, payload, etag, fetchedAt) {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify({
      version: MODELS_DEV_CACHE_VERSION,
      fetchedAt,
      etag,
      payload,
    }));
    await fs.promises.rename(temporary, file);
  } catch {
    // A read-only or full disk must not break model discovery.
  }
}

async function responseTextLimited(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('模型目录响应过大');
  if (!response.body?.getReader) return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('模型目录响应过大');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchModelsDevCatalog({
  cacheDirectory,
  fetcher = globalThis.fetch,
  force = false,
  maxAgeMs = MODELS_DEV_MAX_AGE_MS,
  now = Date.now(),
  timeoutMs = 4_500,
} = {}) {
  const file = modelsDevCacheFile(cacheDirectory);
  const cached = readModelsDevCache(file);
  if (!force && cached && now - cached.fetchedAt < maxAgeMs) return cached.catalog;
  if (typeof fetcher !== 'function') return cached?.catalog || [];

  try {
    const headers = { Accept: 'application/json', 'User-Agent': 'Pi-Studio' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const response = await fetcher(MODELS_DEV_URL, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304 && cached) {
      await writeModelsDevCache(file, cached.payload, cached.etag, now);
      return cached.catalog;
    }
    if (!response.ok) return cached?.catalog || [];
    const text = await responseTextLimited(response, MODELS_DEV_MAX_RESPONSE_BYTES);
    const payload = JSON.parse(text);
    const catalog = createModelsDevCatalog(payload);
    if (catalog.length === 0) return cached?.catalog || [];
    const etag = response.headers?.get?.('etag') || '';
    await writeModelsDevCache(file, payload, etag, now);
    return catalog;
  } catch {
    return cached?.catalog || [];
  }
}

async function loadModelsDevCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force
    && modelsDevMemory
    && now - modelsDevMemory.fetchedAt < MODELS_DEV_MAX_AGE_MS) {
    return modelsDevMemory.catalog;
  }
  let cached;
  try {
    cached = readModelsDevCache(modelsDevCacheFile());
  } catch {
    cached = undefined;
  }
  if (!force && cached && now - cached.fetchedAt < MODELS_DEV_MAX_AGE_MS) {
    modelsDevMemory = { catalog: cached.catalog, fetchedAt: cached.fetchedAt };
    return cached.catalog;
  }
  // Stale data is useful immediately. Refresh in the background and use the
  // newer snapshot on the next model discovery instead of delaying the UI.
  if (!force && cached?.catalog.length) {
    modelsDevLoad ??= fetchModelsDevCatalog({ force: true })
      .then((catalog) => {
        modelsDevMemory = { catalog, fetchedAt: Date.now() };
        return catalog;
      })
      .finally(() => {
        modelsDevLoad = undefined;
      });
    return cached.catalog;
  }
  modelsDevLoad ??= fetchModelsDevCatalog({ force })
    .then((catalog) => {
      modelsDevMemory = { catalog, fetchedAt: Date.now() };
      return catalog;
    })
    .finally(() => {
      modelsDevLoad = undefined;
    });
  return modelsDevLoad;
}

function loadCachedModelsDevCatalog({ cacheDirectory } = {}) {
  try {
    return readModelsDevCache(modelsDevCacheFile(cacheDirectory))?.catalog || [];
  } catch {
    return [];
  }
}

async function loadOfficialCatalog() {
  return import('@earendil-works/pi-ai/providers/all').then(({ builtinModels }) => {
    const credentials = {
      async read() { return undefined; },
      async list() { return []; },
      async modify() { return undefined; },
      async delete() {},
    };
    const models = builtinModels({
      credentials,
      authContext: {
        async env() { return undefined; },
        async fileExists() { return false; },
      },
    });
    return createOfficialCatalog(models.getProviders());
  });
}

module.exports = {
  MODELS_DEV_URL,
  baseUrlCandidates,
  createModelsDevCatalog,
  createOfficialCatalog,
  discoveryDeclarations,
  fetchModelsDevCatalog,
  loadCachedModelsDevCatalog,
  loadModelsDevCatalog,
  loadOfficialCatalog,
  markDiscoveryDeclarations,
  mergeDiscoveredModelMetadata,
  mergeModelMetadataSources,
  mergeOfficialModelMetadata,
  modelSources,
  normalizeBaseUrl,
  resolveOfficialModel,
  storedModelMetadata,
};
