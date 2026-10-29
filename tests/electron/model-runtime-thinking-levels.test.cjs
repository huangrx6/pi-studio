const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-runtime-thinking-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  closeStudioModelsRuntime,
  getStudioModelsRuntime,
} = require('../../electron/core/studio-models.cjs');
const { availableModels } = require('../../electron/services/models.cjs');

test.after(() => {
  closeStudioModelsRuntime();
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('runtime and model picker projection read the persisted level capability', async () => {
  const db = getStudioDatabase();
  db.upsertProvider({
    id: 'fixture',
    name: 'Fixture',
    baseUrl: 'https://fixture.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  db.upsertModel({
    providerId: 'fixture',
    modelId: 'reasoner',
    name: 'Reasoner',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    enabled: true,
    source: 'custom',
  });

  const runtime = await getStudioModelsRuntime();
  const runtimeModel = runtime.models.getModel('fixture', 'reasoner');
  assert.deepEqual(runtime.getSupportedThinkingLevels(runtimeModel), [
    'off',
    'low',
    'high',
    'max',
  ]);

  const catalog = await availableModels();
  assert.deepEqual(catalog.models.find((model) => model.id === 'fixture/reasoner').thinkingLevels, [
    'off',
    'low',
    'high',
    'max',
  ]);
  assert.deepEqual(catalog.selection.thinkingLevels, [
    'default',
    'off',
    'low',
    'high',
    'max',
  ]);
});
