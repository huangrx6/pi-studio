const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  modelListEndpoint,
  normalizeDiscoveredModels,
} = require('../electron/model-discovery.cjs');

test('model discovery derives /models and accepts an explicit endpoint', () => {
  assert.equal(modelListEndpoint('https://api.example.test/v1/'), 'https://api.example.test/v1/models');
  assert.equal(modelListEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/models');
  assert.equal(
    modelListEndpoint('https://ignored.example/v1', 'https://catalog.example.test/models?account=one'),
    'https://catalog.example.test/models?account=one',
  );
  assert.throws(() => modelListEndpoint('file:///tmp/models.json'), /服务地址无效/);
  assert.throws(() => modelListEndpoint('https://api.example.test/v1', 'javascript:alert(1)'), /HTTP/);
});

test('model discovery normalizes common OpenAI and gateway response shapes', () => {
  const models = normalizeDiscoveredModels({
    data: [
      {
        id: 'vision-model',
        name: 'Vision Model',
        context_length: 128000,
        max_output_tokens: 8192,
        architecture: { input_modalities: ['text', 'image'] },
        capabilities: { reasoning: true },
      },
      { id: 'vision-model', name: 'Duplicate' },
      { slug: 'text-model', display_name: 'Text Model', limit: { context: 32000, output: 4096 } },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ['text-model', 'vision-model']);
  assert.deepEqual(models[1], {
    id: 'vision-model',
    name: 'Vision Model',
    supportsImages: true,
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 8192,
  });
});

test('model discovery handles arrays, nested envelopes and model maps safely', () => {
  assert.deepEqual(
    normalizeDiscoveredModels([{ model: 'one' }, 'two']).map((model) => model.id),
    ['one', 'two'],
  );
  assert.deepEqual(
    normalizeDiscoveredModels({ data: { models: [{ id: 'nested' }] } }).map((model) => model.id),
    ['nested'],
  );
  assert.deepEqual(
    normalizeDiscoveredModels({ alpha: { name: 'Alpha' }, beta: { max_tokens: 2048 } }).map((model) => model.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual(normalizeDiscoveredModels({ error: { message: 'Unauthorized' } }), []);
});
