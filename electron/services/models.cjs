/**
 * 模型相关逻辑：当前模型信息、推理强度、可用模型列表。
 *
 * 数据来源全部是 Pi 的 ModelRuntime，本模块只做「读取 + 挑选 + 组装」，
 * 不直接写配置文件（写操作在 ipc/models.cjs 里）。
 */

const {
  DEFAULT_CWD,
  getRuntime,
  getModelRef,
  getThinkingPreferences,
  readAuth,
  readJson,
  modelsFile,
  settingsFile,
  piModule,
  modelOptionsModule,
  syncModelRefFromPiDefault,
} = require('../core/state.cjs');
const { visibleProviderIds } = require('../settings-config.cjs');

/** 把 `provider/model` 解析为当前运行时目录中的模型。 */
function runtimeModelFor(runtime, modelRef) {
  if (typeof modelRef !== 'string' || !modelRef.includes('/')) return undefined;
  const [provider, ...parts] = modelRef.split('/');
  return provider && parts.length > 0 ? runtime.getModel(provider, parts.join('/')) : undefined;
}

/** 配置失效时使用列表中的第一个可用模型，保证应用仍能启动。 */
function resolvedRuntimeModel(runtime, preferredRef = getModelRef()) {
  return runtimeModelFor(runtime, preferredRef) || runtime.getModels()[0];
}

/**
 * 当前模型的展示信息。
 * 当配置里的模型不存在时，回退到目录里的第一个模型，避免前端空白。
 */
async function modelInfo(cwd = DEFAULT_CWD) {
  const runtime = await getRuntime();
  // 终端可能在本应用运行期间修改了 Pi 默认模型；刷新模型目录时同步回来。
  syncModelRefFromPiDefault();
  const configuredRef = getModelRef();
  const found = runtimeModelFor(runtime, configuredRef);
  return {
    ...modelInfoFor(found || runtime.getModels()[0], cwd, undefined, found ? configuredRef : undefined),
    source: 'default',
  };
}

/**
 * 把某个模型组装成前端需要的选择快照。
 * thinkingLevelOverride 用于会话自己的推理等级（不跟随全局默认）。
 */
function modelInfoFor(model, cwd = DEFAULT_CWD, thinkingLevelOverride, modelRefOverride) {
  if (!model) return { modelRef: modelRefOverride || getModelRef(), label: modelRefOverride || '未选择模型', thinkingLevel: 'off', thinkingLevels: ['off'], effectiveThinkingLevel: 'off', defaultThinkingLevel: 'off' };
  const info = reasoningFor(model, cwd);
  return {
    modelRef: modelRefOverride || `${model.provider}/${model.id}`,
    label: model.name || `${model.provider}/${model.id}`,
    ...info,
    ...(thinkingLevelOverride ? { thinkingLevel: thinkingLevelOverride, effectiveThinkingLevel: thinkingLevelOverride } : {}),
  };
}

/**
 * 计算某个模型支持的推理强度选项。
 * 默认值与各模型可选值由 Pi 的 SettingsManager 决定，
 * 用户上次选择的 level 来自 config.json 的 thinkingLevels。
 */
function reasoningFor(model, cwd = DEFAULT_CWD) {
  const settings = piModule().SettingsManager.create(cwd);
  const preferences = getThinkingPreferences();
  return modelOptionsModule().reasoningOptions(model, preferences[`${model?.provider}/${model?.id}`], {
    defaultThinkingLevel: settings.getDefaultThinkingLevel(),
    modelThinkingLevels: settings.getAllModelThinkingLevels(),
  });
}

/**
 * 模型选择器需要的数据：
 *  - models   当前可见（有密钥或已被启用）的模型列表
 *  - enabled  settings.json 里启用的模型 id
 *  - current  当前选中的 modelRef
 *  - selection 当前模型的富信息（含推理强度）
 */
async function availableModels(cwd = DEFAULT_CWD) {
  const runtime = await getRuntime();
  const auth = readAuth();
  const settings = readJson(settingsFile(), {});
  const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const configured = readJson(modelsFile(), { providers: {} }).providers || {};
  const authenticated = runtime.getProviders().filter((provider) => runtime.hasConfiguredAuth(provider.id)).map((provider) => provider.id);
  const visible = visibleProviderIds(auth, configured, enabled, getModelRef(), authenticated);
  const providerNames = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));
  const models = runtime.getModels()
    .filter((item) => visible.has(item.provider))
    .map((item) => ({
      id: `${item.provider}/${item.id}`,
      provider: item.provider,
      providerName: providerNames.get(item.provider) || item.provider,
      model: item.id,
      name: item.name,
      contextWindow: item.contextWindow,
      maxTokens: item.maxTokens,
      supportsImages: Array.isArray(item.input) && item.input.includes('image'),
      reasoning: Boolean(item.reasoning),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const defaultSelection = await modelInfo(cwd);
  return {
    models,
    enabled,
    current: defaultSelection.modelRef,
    selection: defaultSelection,
    defaultSelection,
  };
}

module.exports = {
  availableModels,
  modelInfo,
  modelInfoFor,
  reasoningFor,
  resolvedRuntimeModel,
  runtimeModelFor,
};
