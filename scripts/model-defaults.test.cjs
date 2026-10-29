const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveStartupModelRef } = require('../electron/model-defaults.cjs');
const { resolveSessionModel } = require('../electron/services/session-model.cjs');

test('startup model uses the Pi terminal default and keeps an explicit environment override', () => {
  assert.equal(resolveStartupModelRef({
    stored: '',
    terminal: 'deepseek/deepseek-flash',
    fallback: 'minimax-cn/MiniMax-M3.1-Flash',
  }), 'deepseek/deepseek-flash');
  assert.equal(resolveStartupModelRef({
    stored: 'zai-coding-cn/glm-5.3',
    terminal: 'deepseek/deepseek-flash',
    fallback: 'minimax-cn/MiniMax-M3.1-Flash',
  }), 'deepseek/deepseek-flash');
  assert.equal(resolveStartupModelRef({
    environment: 'opencode-go/deepseek-v4.1-flash',
    stored: 'zai-coding-cn/glm-5.3',
    terminal: 'deepseek/deepseek-flash',
    fallback: 'minimax-cn/MiniMax-M3.1-Flash',
  }), 'opencode-go/deepseek-v4.1-flash');
  assert.equal(resolveStartupModelRef({
    stored: 'zai-coding-cn/glm-5.3',
    terminal: '',
    fallback: 'minimax-cn/MiniMax-M3.1-Flash',
  }), 'zai-coding-cn/glm-5.3');
});

test('a historical session restores its last recorded model and thinking level', () => {
  const entries = [
    { type: 'model_change', provider: 'zai-coding-cn', modelId: 'glm-5.3' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
    { type: 'message', message: { role: 'user' } },
    { type: 'model_change', provider: 'deepseek', modelId: 'deepseek-flash' },
    { type: 'thinking_level_change', thinkingLevel: 'max' },
  ];
  const models = new Map([
    ['zai-coding-cn/glm-5.3', { provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM 5.3' }],
    ['deepseek/deepseek-flash', { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash' }],
  ]);
  const selection = resolveSessionModel(entries, {
    fallbackModel: models.get('zai-coding-cn/glm-5.3'),
    resolveModel: (provider, modelId) => models.get(`${provider}/${modelId}`),
    describe: (model, thinkingLevel) => ({
      modelRef: `${model.provider}/${model.id}`,
      label: model.name,
      thinkingLevel: thinkingLevel || 'default',
      thinkingLevels: ['default', 'max'],
    }),
  });

  assert.equal(selection.modelRef, 'deepseek/deepseek-flash');
  assert.equal(selection.label, 'DeepSeek Flash');
  assert.equal(selection.thinkingLevel, 'max');
  assert.equal(selection.source, 'session');
  assert.equal(selection.unavailable, undefined);
});

test('an unavailable historical model is surfaced instead of silently replaced', () => {
  const fallback = { provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM 5.3' };
  const selection = resolveSessionModel([
    { type: 'model_change', provider: 'deepseek', modelId: 'removed-model' },
  ], {
    fallbackModel: fallback,
    resolveModel: () => undefined,
    describe: (model) => ({ modelRef: `${model.provider}/${model.id}`, label: model.name }),
  });

  assert.equal(selection.modelRef, 'deepseek/removed-model');
  assert.equal(selection.label, 'removed-model');
  assert.equal(selection.source, 'session');
  assert.equal(selection.unavailable, true);
  assert.match(selection.unavailableReason, /当前不可用/);
});

test('changing the default model or thinking level updates Studio and Pi together', async () => {
  const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const piSettings = SettingsManager.inMemory({});
  const state = {
    modelRef: 'zai-coding-cn/glm-5.3',
    thinkingPreferences: {},
  };
  const saved = [];
  const pi = { SettingsManager: { create: () => piSettings } };
  const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash' };
  const ipc = loadModelsIpc({
    state,
    saved,
    pi,
    runtimeModelFor: (_runtime, modelRef) => modelRef === 'deepseek/deepseek-flash' ? model : undefined,
    modelInfo: async () => ({ modelRef: state.modelRef, label: model.name }),
    validateThinkingLevel: (_model, level) => {
      if (!['default', 'low', 'high', 'max'].includes(level)) throw new Error('不支持');
    },
  });

  await ipc.setDefaultModel('deepseek/deepseek-flash', '/tmp/project');
  assert.equal(piSettings.getDefaultProvider(), 'deepseek');
  assert.equal(piSettings.getDefaultModel(), 'deepseek-flash');
  assert.equal(state.modelRef, 'deepseek/deepseek-flash');
  assert.equal(saved.at(-1).modelRef, 'deepseek/deepseek-flash');

  await ipc.setDefaultThinkingLevel('max', '/tmp/project');
  assert.equal(piSettings.getDefaultThinkingLevel(), 'max');
  assert.equal(JSON.stringify(state.thinkingPreferences), JSON.stringify({ 'deepseek/deepseek-flash': 'max' }));
  assert.equal(JSON.stringify(saved.at(-1).levels), JSON.stringify({ 'deepseek/deepseek-flash': 'max' }));

  // Default 代表继续跟随 Pi 的启动默认，不应在用户没有选择固定档位时清掉它。
  await ipc.setDefaultThinkingLevel('default', '/tmp/project');
  assert.equal(piSettings.getDefaultThinkingLevel(), 'max');
  assert.equal(JSON.stringify(state.thinkingPreferences), JSON.stringify({ 'deepseek/deepseek-flash': 'default' }));
});

function loadModelsIpc({ state, saved, pi, runtimeModelFor, modelInfo, validateThinkingLevel }) {
  const filename = path.join(__dirname, '../electron/ipc/models.cjs');
  const module = { exports: {} };
  const stateModule = {
    DEFAULT_CWD: '/tmp',
    getRuntime: async () => ({ getModels: () => [{ provider: 'deepseek', id: 'deepseek-flash' }] }),
    getModelRef: () => state.modelRef,
    setModelRef: (value) => { state.modelRef = value; },
    getThinkingPreferences: () => state.thinkingPreferences,
    setThinkingPreferences: (value) => { state.thinkingPreferences = value; },
    saveConfig: (modelRef, levels) => saved.push({ modelRef, levels }),
    invalidateModelRuntime: () => {},
    readAuth: () => ({}),
    readConfig: (_file, fallback) => fallback,
    writeConfig: () => {},
    readJson: (_file, fallback) => fallback,
    authFile: () => '/tmp/auth.json',
    modelsFile: () => '/tmp/models.json',
    settingsFile: () => '/tmp/settings.json',
    modelOptionsModule: () => ({ validateThinkingLevel }),
    piModule: () => pi,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'electron') return { ipcMain: { handle() {} } };
      if (name === '../core/state.cjs') return stateModule;
      if (name === '../settings-config.cjs') return {
        updateProvider: (value) => value,
        updateCustomModel: (value) => value,
        removeCustomModel: (value) => value,
        importDiscoveredModels: (value) => value,
      };
      if (name === '../credential-env.cjs') return { prepareKey: async (value) => value };
      if (name === '../model-discovery.cjs') return { fetchProviderModelDiscovery: async () => ({}), httpUrl: () => true };
      if (name === '../services/models.cjs') return { modelInfo, availableModels: async () => ({}), runtimeModelFor };
      if (name === '../services/settings.cjs') return { settingsSnapshot: async () => ({}) };
      if (name === '../services/runtime-refresh.cjs') return { requestAgentRuntimeRefresh: async () => ({ status: 'ready' }) };
      return require(name);
    },
    __dirname: path.dirname(filename),
    __filename: filename,
    process,
    console,
    setTimeout,
    clearTimeout,
  });
  return module.exports;
}
