const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-empty-models-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  getStudioModelsRuntime,
  rebuildStudioModels,
} = require('../../electron/core/studio-models.cjs');
const {
  availableModels,
  modelInfo,
  resolveProviderApiKey,
} = require('../../electron/services/models.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('a fresh Studio database starts with no providers or enabled models', async () => {
  await getStudioModelsRuntime();
  const db = getStudioDatabase();

  assert.deepEqual(db.listProviders(), []);
  assert.deepEqual(db.listModels(), []);
  assert.equal(db.getSetting('studio.models.defaultModelRef', ''), '');
  assert.equal(db.getSetting('studio.models.catalogRevision'), 2);

  const catalog = await availableModels();
  assert.deepEqual(catalog.models, []);
  assert.deepEqual(catalog.enabled, []);
  assert.equal(catalog.current, '');
  assert.equal(catalog.defaultSelection.modelRef, '');
  assert.equal((await modelInfo()).modelRef, '');
});

test('an empty custom provider stays configurable until its first model is added', async () => {
  const db = getStudioDatabase();
  db.upsertProvider({
    id: 'zhipu',
    name: 'Zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    builtin: false,
    enabled: true,
  });
  db.writeCredential('zhipu', { type: 'api_key', key: 'studio-test-key' });

  await rebuildStudioModels();

  assert.equal(db.getProvider('zhipu').name, 'Zhipu');
  assert.equal(await resolveProviderApiKey('zhipu'), 'studio-test-key');
  assert.deepEqual(await availableModels(), {
    models: [],
    enabled: [],
    current: '',
    selection: {
      modelRef: '',
      label: '未选择模型',
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      source: 'default',
    },
    defaultSelection: {
      modelRef: '',
      label: '未选择模型',
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      source: 'default',
    },
  });

  db.upsertModel({
    providerId: 'zhipu',
    modelId: 'glm-studio-test',
    name: 'GLM Studio Test',
    api: 'openai-completions',
    enabled: true,
    source: 'custom',
  });
  await rebuildStudioModels();

  const catalog = await availableModels();
  assert.deepEqual(catalog.enabled, ['zhipu/glm-studio-test']);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, 'zhipu/glm-studio-test');
  assert.equal(catalog.models[0].providerName, 'Zhipu');
});
