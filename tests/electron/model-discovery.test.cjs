const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchProviderModelDiscovery,
  modelListEndpoint,
  normalizeDiscoveredModels,
} = require('../../electron/model-discovery.cjs');

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
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    contextWindow: 128000,
    maxTokens: 8192,
  });
});

test('model discovery uses declared reasoning levels and normalizes aliases', () => {
  const models = normalizeDiscoveredModels({
    data: [{
      id: 'vendor-reasoner',
      capabilities: {
        reasoning: {
          levels: ['none', 'low', 'HIGH', 'extra-high', 'maximum', 'unsupported'],
        },
      },
    }],
  });
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].thinkingLevels, ['off', 'low', 'high', 'xhigh', 'max']);
});

test('model discovery recognizes OpenRouter reasoning support parameters', () => {
  const [model] = normalizeDiscoveredModels({
    data: [{
      id: 'openrouter-reasoner',
      supported_parameters: ['tools', 'reasoning_effort', 'max_tokens'],
    }],
  });
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high']);
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

test('model discovery sends the Studio API key to an OpenAI-compatible endpoint', async () => {
  let request;
  const result = await fetchProviderModelDiscovery({
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    api: 'openai-completions',
    apiKey: 'studio-test-key',
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(request.url, 'https://open.bigmodel.cn/api/coding/paas/v4/models');
  assert.equal(request.options.headers.Authorization, 'Bearer studio-test-key');
  assert.deepEqual(result.models.map((model) => model.id), ['glm-5.3']);
});

test('model discovery reports API errors wrapped in a successful HTTP response', async () => {
  await assert.rejects(
    fetchProviderModelDiscovery({
      baseUrl: 'https://open.bigmodel.cn/api/v1/models',
      modelsUrl: 'https://open.bigmodel.cn/api/v1/models',
      apiKey: 'studio-test-key',
      fetcher: async () => new Response(JSON.stringify({
        code: 401,
        msg: '令牌已过期或验证不正确',
        success: false,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /模型列表接口返回错误：401 令牌已过期或验证不正确/,
  );
});
