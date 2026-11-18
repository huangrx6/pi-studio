const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-empty-models-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
installElectronSafeStorage(test);

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/main/core/studio-db.cjs');
const {
  getStudioModelsRuntime,
  rebuildStudioModels,
} = require('../../electron/main/core/studio-models.cjs');
const {
  availableModels,
  modelInfo,
  resolveProviderApiKey,
} = require('../../electron/main/services/models.cjs');
const { listMediaModels, resolveMediaModel } = require('../../electron/main/services/media-models.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('media model choices expose only enabled provider IDs and resolve the selected capability with its own saved key', async t => {
  const db = getStudioDatabase();
  const id = 'media-gateway';
  t.after(() => db.deleteProvider(id));
  assert.deepEqual(listMediaModels(), { speech: [], image: [] });
  db.upsertProvider({ id, name: 'Media', baseUrl: 'https://media.example/v1', mediaModels: { speech: ['voice/a'], image: ['painter'] } });
  db.writeCredential(id, { type: 'api_key', key: 'synthetic-media-secret' });
  assert.deepEqual(listMediaModels().speech, [{ providerId: id, modelId: 'voice/a', label: 'Media · voice/a' }]);
  assert.deepEqual(await resolveMediaModel('image', id, 'painter'), { modelId: 'painter', baseUrl: 'https://media.example/v1', apiKey: 'synthetic-media-secret' });
  await assert.rejects(resolveMediaModel('speech', id, 'painter'), /重新选择/);
  await assert.rejects(resolveMediaModel('image', 'unknown', 'painter'), /重新选择/);
  db.setProviderEnabled(id, false);
  assert.deepEqual(listMediaModels(), { speech: [], image: [] });
  await assert.rejects(resolveMediaModel('speech', id, 'voice/a'), /已停用/);
  db.deleteProvider(id);
  db.upsertProvider({ id });
  assert.deepEqual(listMediaModels(), { speech: [], image: [] });
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
      supportsImages: false,
      source: 'default',
    },
    defaultSelection: {
      modelRef: '',
      label: '未选择模型',
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      effectiveThinkingLevel: 'off',
      defaultThinkingLevel: 'off',
      supportsImages: false,
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
