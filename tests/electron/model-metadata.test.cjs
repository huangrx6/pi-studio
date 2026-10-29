const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createModelsDevCatalog,
  fetchModelsDevCatalog,
  loadOfficialCatalog,
  mergeDiscoveredModelMetadata,
  resolveOfficialModel,
  storedModelMetadata,
} = require('../../electron/core/model-metadata.cjs');
const {
  normalizeDiscoveredModels,
} = require('../../electron/model-discovery.cjs');

test('official metadata resolves a custom provider by its base URL', async () => {
  const catalog = await loadOfficialCatalog();
  const resolved = resolveOfficialModel(catalog, {
    providerId: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/',
    modelId: 'glm-5.3-flash',
  });

  assert.equal(resolved.provider.id, 'zai-coding-cn');
  assert.equal(resolved.model.contextWindow, 1_000_000);
  assert.equal(resolved.model.maxTokens, 131_072);
  assert.deepEqual(resolved.model.input, ['text', 'image']);
  assert.equal(resolved.model.reasoning, true);
});

test('discovery fills sparse Z.AI model data from the official catalog', async () => {
  const catalog = await loadOfficialCatalog();
  const [model] = mergeDiscoveredModelMetadata(
    normalizeDiscoveredModels({ data: [{ id: 'glm-5.3-flash', object: 'model' }] }),
    {
      providerId: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      officialCatalog: catalog,
    },
  );

  assert.deepEqual(model, {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    api: 'openai-completions',
    supportsImages: true,
    reasoning: true,
    thinkingLevels: ['low', 'high', 'max'],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  });
});

test('the same fallback works across other official providers', async () => {
  const catalog = await loadOfficialCatalog();
  const [model] = mergeDiscoveredModelMetadata(
    normalizeDiscoveredModels({ data: [{ id: 'deepseek-flash' }] }),
    {
      providerId: 'deepseek-custom',
      baseUrl: 'https://api.deepseek.com/v1',
      officialCatalog: catalog,
    },
  );

  assert.equal(model.name, 'DeepSeek V4.1 Flash');
  assert.equal(model.supportsImages, true);
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 384_000);
  assert.deepEqual(model.thinkingLevels, ['off', 'low', 'high', 'max']);
});

test('models.dev metadata overrides stale Pi catalog values', async () => {
  const remoteCatalog = createModelsDevCatalog({
    zhipuai: {
      id: 'zhipuai',
      name: 'Zhipu AI',
      api: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: {
        'glm-5.3-flash': {
          id: 'glm-5.3-flash',
          name: 'GLM-5.3-Flash',
          attachment: true,
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
          modalities: { input: ['text', 'image'] },
          limit: { context: 1_000_000, output: 131_072 },
        },
      },
    },
  });
  const stalePiCatalog = [{
    id: 'zai-coding-cn',
    name: 'Z.AI Coding CN',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [{
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      api: 'openai-completions',
      input: ['text'],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 32_768,
    }],
  }];
  const [model] = mergeDiscoveredModelMetadata(
    normalizeDiscoveredModels({ data: [{ id: 'glm-5.3-flash' }] }),
    {
      providerId: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      catalogs: [remoteCatalog, stalePiCatalog],
    },
  );

  assert.equal(model.supportsImages, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevels, ['low', 'high', 'max']);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 131_072);
});

test('models.dev catalog is cached locally and reused', async () => {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-dev-'));
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return new Response(JSON.stringify({
      zhipuai: {
        id: 'zhipuai',
        name: 'Zhipu AI',
        api: 'https://open.bigmodel.cn/api/paas/v4',
        models: {
          'glm-fixture': {
            id: 'glm-fixture',
            name: 'GLM Fixture',
            limit: { context: 64_000, output: 8_192 },
          },
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: 'fixture' },
    });
  };
  try {
    const first = await fetchModelsDevCatalog({ cacheDirectory, fetcher });
    const second = await fetchModelsDevCatalog({ cacheDirectory, fetcher });
    assert.equal(first[0].models[0].id, 'glm-fixture');
    assert.equal(second[0].models[0].contextWindow, 64_000);
    assert.equal(requests, 1);
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test('explicit API capabilities and limits remain authoritative', async () => {
  const catalog = await loadOfficialCatalog();
  const [model] = mergeDiscoveredModelMetadata(
    normalizeDiscoveredModels({
      data: [{
        id: 'glm-5.3-flash',
        display_name: 'Private GLM',
        supports_images: false,
        reasoning: false,
        context_length: 64_000,
        max_output_tokens: 8_192,
      }],
    }),
    {
      providerId: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      officialCatalog: catalog,
    },
  );

  assert.equal(model.name, 'Private GLM');
  assert.equal(model.supportsImages, false);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.thinkingLevels, []);
  assert.equal(model.contextWindow, 64_000);
  assert.equal(model.maxTokens, 8_192);
});

test('unknown third-party models are not assigned unrelated official metadata', async () => {
  const catalog = await loadOfficialCatalog();
  const [model] = mergeDiscoveredModelMetadata(
    normalizeDiscoveredModels({ data: [{ id: 'tenant-private-model' }] }),
    {
      providerId: 'custom-gateway',
      baseUrl: 'https://gateway.example.test/v1',
      officialCatalog: catalog,
    },
  );

  assert.deepEqual(model, {
    id: 'tenant-private-model',
    name: 'tenant-private-model',
    supportsImages: false,
    reasoning: false,
    thinkingLevels: [],
  });
});

test('legacy stored rows can be repaired when official metadata is available', async () => {
  const catalog = await loadOfficialCatalog();
  const official = resolveOfficialModel(catalog, {
    providerId: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    modelId: 'glm-5.3-flash',
  })?.model;
  const metadata = storedModelMetadata({
    providerId: 'zhipu',
    modelId: 'glm-5.3-flash',
    name: 'glm-5.3-flash',
    api: 'openai-completions',
    supportsImages: false,
    reasoning: false,
    thinkingLevels: [],
  }, official);

  assert.equal(metadata.name, 'GLM-5.3-Flash');
  assert.equal(metadata.supportsImages, true);
  assert.equal(metadata.reasoning, true);
  assert.deepEqual(metadata.thinkingLevels, ['low', 'high', 'max']);
  assert.equal(metadata.contextWindow, 1_000_000);
  assert.equal(metadata.maxTokens, 131_072);
});

test('explicit discovery values stay authoritative after they are stored', async () => {
  const catalog = await loadOfficialCatalog();
  const official = resolveOfficialModel(catalog, {
    providerId: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    modelId: 'glm-5.3-flash',
  })?.model;
  const metadata = storedModelMetadata({
    providerId: 'zhipu',
    modelId: 'glm-5.3-flash',
    name: 'Private GLM',
    api: 'openai-completions',
    contextWindow: 64_000,
    maxTokens: 8_192,
    supportsImages: false,
    reasoning: false,
    thinkingLevels: [],
    metadataSource: 'resolved',
  }, official);

  assert.equal(metadata.name, 'Private GLM');
  assert.equal(metadata.supportsImages, false);
  assert.equal(metadata.reasoning, false);
  assert.deepEqual(metadata.thinkingLevels, []);
  assert.equal(metadata.contextWindow, 64_000);
  assert.equal(metadata.maxTokens, 8_192);
});
