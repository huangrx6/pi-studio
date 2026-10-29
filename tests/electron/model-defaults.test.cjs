const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-model-defaults-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  persistDefaultModel,
  persistDefaultThinkingLevel,
} = require('../../electron/services/models.cjs');

const reasoningModel = {
  provider: 'fixture',
  id: 'reasoning-model',
  name: 'Reasoning Model',
  reasoning: true,
};
const plainModel = {
  provider: 'fixture',
  id: 'plain-model',
  name: 'Plain Model',
  reasoning: false,
};
const models = new Map([
  [`${reasoningModel.provider}/${reasoningModel.id}`, reasoningModel],
  [`${plainModel.provider}/${plainModel.id}`, plainModel],
]);
const runtime = {
  models: {
    getModel: (provider, modelId) => models.get(`${provider}/${modelId}`),
    getModels: () => [...models.values()],
  },
  getSupportedThinkingLevels: (model) => (
    model.reasoning ? ['low', 'medium', 'high'] : []
  ),
};

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('new conversation model and thinking defaults persist in Studio SQLite', () => {
  const db = getStudioDatabase();
  db.upsertProvider({
    id: 'fixture',
    name: 'Fixture',
    baseUrl: 'https://fixture.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  for (const model of models.values()) {
    db.upsertModel({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      api: 'openai-completions',
      reasoning: model.reasoning,
      enabled: true,
      source: 'custom',
    });
  }
  const selected = persistDefaultModel(runtime, 'fixture/reasoning-model');
  assert.equal(selected.modelRef, 'fixture/reasoning-model');
  assert.equal(selected.thinkingLevel, 'default');
  assert.equal(selected.effectiveThinkingLevel, 'medium');
  assert.equal(
    db.getSetting('studio.models.defaultModelRef'),
    'fixture/reasoning-model',
  );

  const high = persistDefaultThinkingLevel(runtime, 'high');
  assert.equal(high.thinkingLevel, 'high');
  assert.equal(high.effectiveThinkingLevel, 'high');
  assert.equal(db.getSetting('studio.models.defaultThinkingLevel'), 'high');

  const inherited = persistDefaultThinkingLevel(runtime, 'default');
  assert.equal(inherited.thinkingLevel, 'default');
  assert.equal(inherited.effectiveThinkingLevel, 'medium');
  assert.equal(db.getSetting('studio.models.defaultThinkingLevel'), 'default');

  assert.throws(
    () => persistDefaultThinkingLevel(runtime, 'max'),
    /不支持这个推理等级/,
  );

  db.setProviderEnabled('fixture', false);
  assert.throws(
    () => persistDefaultModel(runtime, 'fixture/reasoning-model'),
    /模型已不存在/,
  );
});
