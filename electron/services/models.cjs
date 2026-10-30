/**
 * Read-only model projection used by IPC, settings, and conversation creation.
 *
 * Every value comes from Studio's SQLite catalog and the live pi-ai Models
 * instance. Thinking levels are calculated by pi-ai itself because provider
 * capabilities differ per model.
 */

const { getStudioDatabase } = require('../core/studio-db.cjs');
const {
  getStudioModelsRuntime,
  providerBaseUrl,
} = require('../core/studio-models.cjs');

const DEFAULT_CWD = process.cwd();

function splitModelRef(modelRef) {
  if (typeof modelRef !== 'string') return undefined;
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash === modelRef.length - 1) return undefined;
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

function modelRefFor(model) {
  return model ? `${model.provider}/${model.id}` : '';
}

function runtimeModelFor(runtime, modelRef) {
  const ref = typeof modelRef === 'object' ? modelRef : splitModelRef(modelRef);
  if (!ref?.provider || !ref?.modelId) return undefined;
  return runtime.getModel(ref.provider, ref.modelId);
}

function enabledDatabaseModel(ref) {
  if (!ref?.provider || !ref?.modelId) return undefined;
  const db = getStudioDatabase();
  const row = db.getModel(ref.provider, ref.modelId);
  const provider = db.getProvider(ref.provider);
  return row?.enabled && provider?.enabled ? row : undefined;
}

function enabledRuntimeModel(runtime, modelRef) {
  const ref = typeof modelRef === 'object' ? modelRef : splitModelRef(modelRef);
  if (!enabledDatabaseModel(ref)) return undefined;
  return runtimeModelFor(runtime, ref);
}

function supportedThinkingLevels(model, runtime) {
  if (!model?.reasoning) return [];
  return runtime.getSupportedThinkingLevels(model);
}

function preferredLevel(model, getSupportedThinkingLevels, preference) {
  const levels = getSupportedThinkingLevels(model);
  if (!model?.reasoning || levels.length === 0) return 'off';
  if (levels.includes(preference)) return preference;
  if (levels.includes('medium')) return 'medium';
  return levels[0] || 'off';
}

function thinkingOptions(model, preference, runtime) {
  const levels = model ? runtime.getSupportedThinkingLevels(model) : [];
  const db = getStudioDatabase();
  const perModel = db.getSetting('studio.models.thinkingByModel', {}) || {};
  const globalPreference = db.getSetting('studio.models.defaultThinkingLevel', 'default');
  const requested = preference === undefined
    ? perModel[modelRefFor(model)] ?? globalPreference
    : preference;
  const defaultLevel = preferredLevel(model, runtime.getSupportedThinkingLevels, globalPreference);
  const explicit = requested === 'default' ? defaultLevel : requested;
  const supported = model?.reasoning ? levels : [];
  const selectedLevel = requested !== 'default' && supported.includes(requested)
    ? requested
    : 'default';
  return {
    thinkingLevel: selectedLevel,
    thinkingLevels: ['default', ...supported],
    defaultThinkingLevel: defaultLevel,
    effectiveThinkingLevel: preferredLevel(model, runtime.getSupportedThinkingLevels, explicit),
  };
}

function modelInfoFor(model, _cwd = DEFAULT_CWD, thinkingLevelOverride, modelRefOverride, runtimeOverride) {
  const runtime = runtimeOverride;
  if (!model) {
    return {
      modelRef: modelRefOverride || '',
      label: modelRefOverride || '未选择模型',
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      supportsImages: false,
    };
  }
  const actualRuntime = runtime || throwSync('模型运行时尚未初始化');
  return {
    modelRef: modelRefOverride || modelRefFor(model),
    label: model.name || model.id,
    supportsImages: Array.isArray(model.input) && model.input.includes('image'),
    ...thinkingOptions(model, thinkingLevelOverride, actualRuntime),
  };
}

function throwSync(message) {
  throw new Error(message);
}

function defaultModelRef(runtime) {
  const db = getStudioDatabase();
  const models = runtime?.models || runtime;
  const configured = db.getSetting('studio.models.defaultModelRef', '');
  const configuredRef = splitModelRef(configured);
  if (configuredRef && runtimeModelFor(models, configuredRef) && enabledDatabaseModel(configuredRef)) {
    return configured;
  }
  const first = db.listEnabledModels()[0];
  const ref = first ? `${first.providerId}/${first.modelId}` : '';
  if (ref) db.setSetting('studio.models.defaultModelRef', ref);
  else if (configured) db.deleteSetting('studio.models.defaultModelRef');
  return ref;
}

function persistDefaultModel(runtime, modelRef) {
  const models = runtime?.models || runtime;
  const model = enabledRuntimeModel(models, modelRef);
  if (!model) throw new Error('模型已不存在，请刷新后重试');
  const canonicalRef = modelRefFor(model);
  getStudioDatabase().setSetting('studio.models.defaultModelRef', canonicalRef);
  return {
    ...modelInfoFor(model, DEFAULT_CWD, undefined, canonicalRef, runtime),
    source: 'default',
  };
}

function persistDefaultThinkingLevel(runtime, level) {
  const models = runtime?.models || runtime;
  const ref = defaultModelRef(models);
  const model = runtimeModelFor(models, ref);
  if (!model) throw new Error('当前默认模型不存在');
  validateThinkingLevel(model, level, runtime);
  getStudioDatabase().setSetting(
    'studio.models.defaultThinkingLevel',
    level === 'default' ? 'default' : concreteThinkingLevel(model, level, runtime),
  );
  return {
    ...modelInfoFor(model, DEFAULT_CWD, undefined, ref, runtime),
    source: 'default',
  };
}

async function resolvedRuntimeModel(runtime, preferredRef) {
  const models = runtime?.models || runtime;
  return enabledRuntimeModel(models, preferredRef) || enabledRuntimeModel(models, defaultModelRef(models));
}

async function modelInfo(_cwd = DEFAULT_CWD) {
  const runtime = await getStudioModelsRuntime();
  const ref = defaultModelRef(runtime);
  const model = enabledRuntimeModel(runtime.models, ref);
  return {
    ...modelInfoFor(model, _cwd, undefined, model ? modelRefFor(model) : ref, runtime),
    source: 'default',
  };
}

async function availableModels(_cwd = DEFAULT_CWD) {
  const runtime = await getStudioModelsRuntime();
  const db = getStudioDatabase();
  const enabledRows = db.listModels().filter((row) => {
    const provider = db.getProvider(row.providerId);
    return row.enabled && provider?.enabled;
  });
  const enabledSet = new Set(enabledRows.map((row) => `${row.providerId}/${row.modelId}`));
  const providers = new Map(runtime.models.getProviders().map((provider) => [provider.id, provider]));
  const providerRows = new Map(db.listProviders().map((provider) => [provider.id, provider]));
  const models = runtime.models.getModels()
    .filter((model) => enabledSet.has(modelRefFor(model)))
    .map((model) => ({
      id: modelRefFor(model),
      provider: model.provider,
      providerName: providers.get(model.provider)?.name || providerRows.get(model.provider)?.name || model.provider,
      model: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImages: Array.isArray(model.input) && model.input.includes('image'),
      reasoning: Boolean(model.reasoning),
      thinkingLevels: supportedThinkingLevels(model, runtime),
    }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));

  const selection = await modelInfo(_cwd);
  return {
    models,
    enabled: [...enabledSet],
    current: selection.modelRef,
    selection,
    defaultSelection: selection,
  };
}

/**
 * Read the credential directly from Studio's credential store.
 *
 * Pi only registers a provider once it has at least one model. Model discovery
 * must still work for a newly-created, empty source, so runtime.models.getAuth()
 * cannot be the primary lookup.
 */
async function resolveProviderApiKey(providerId) {
  const runtime = await getStudioModelsRuntime();
  const stored = await runtime.credentials.read(providerId);
  if (stored?.type === 'api_key' && typeof stored.key === 'string' && stored.key.trim()) {
    return stored.key.trim();
  }
  try {
    const resolved = await runtime.models.getAuth(providerId);
    return typeof resolved?.auth?.apiKey === 'string' ? resolved.auth.apiKey : '';
  } catch {
    return '';
  }
}

async function sessionModelInfo(agent) {
  const runtime = await getStudioModelsRuntime();
  const ref = agent?.model || splitModelRef(defaultModelRef(runtime));
  const model = enabledRuntimeModel(runtime.models, ref);
  if (!model) {
    return {
      modelRef: ref ? `${ref.provider}/${ref.modelId}` : '',
      label: ref ? `${ref.provider}/${ref.modelId}` : '未选择模型',
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      supportsImages: false,
      source: 'session',
      unavailable: true,
      unavailableReason: '这条会话使用的模型已从 Studio 模型目录移除，请重新选择。',
    };
  }
  return {
    ...modelInfoFor(model, DEFAULT_CWD, agent.thinkingLevel, modelRefFor(model), runtime),
    source: 'session',
  };
}

function reasoningFor(model, _cwd = DEFAULT_CWD) {
  const runtime = require('../core/studio-models.cjs').getStudioModelsRuntimeSync();
  if (!runtime) throw new Error('模型运行时尚未初始化');
  return thinkingOptions(model, undefined, runtime);
}

function validateThinkingLevel(model, level, runtime) {
  const levels = runtime.getSupportedThinkingLevels(model);
  if (level === 'default') return level;
  if (!levels.includes(level)) throw new Error('当前模型不支持这个推理等级');
  return level;
}

function concreteThinkingLevel(model, level, runtime) {
  const options = thinkingOptions(model, level, runtime);
  return options.effectiveThinkingLevel;
}

module.exports = {
  DEFAULT_CWD,
  availableModels,
  concreteThinkingLevel,
  defaultModelRef,
  enabledRuntimeModel,
  modelInfo,
  modelInfoFor,
  modelRefFor,
  persistDefaultModel,
  persistDefaultThinkingLevel,
  providerBaseUrl,
  reasoningFor,
  resolveProviderApiKey,
  resolvedRuntimeModel,
  runtimeModelFor,
  sessionModelInfo,
  splitModelRef,
  supportedThinkingLevels,
  validateThinkingLevel,
};
