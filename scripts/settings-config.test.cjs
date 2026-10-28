/**
 * electron/settings-config.cjs 的单元测试。
 *
 * 被测模块：electron/settings-config.cjs
 * 覆盖：设置页可见来源的计算、MCP 服务器增删改、模型来源 / 自定义模型编辑、
 *       输入校验，以及配置文件的原子写入与损坏保护。
 *
 * 运行方式：
 *   pnpm test                                       # 跑 scripts/ 下全部单测
 *   node --test scripts/settings-config.test.cjs    # 只跑本文件
 *
 * 依赖：node:test / node:assert（Node 20+ 内置）、node:fs / os / path。
 * 所有用例都直接调用纯函数，不启动 Electron、不触碰真实用户配置。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readConfig,
  writeConfig,
  updateMcp,
  updateProvider,
  updateCustomModel,
  visibleProviderIds,
} = require('../electron/settings-config.cjs');

// 设置页展示哪些来源，由四部分合并而成：auth.json 里存过凭据的来源、
// models.json 里配置过的来源、运行时已认证的内置来源，以及 enabledModels /
// 当前模型 ID 的 provider 前缀。因此即使用户只存了 Zen（opencode）的凭据，
// 已启用的 Go 模型也必须出现在列表中，否则用户无法管理正在用的模型。
test('enabled Go models stay visible even if only a Zen credential is stored', () => {
  const visible = visibleProviderIds(
    { opencode: { type: 'api_key' } },
    {},
    ['opencode-go/deepseek-v4.1-flash'],
    'minimax-cn/flash',
    ['environment-provider'],
  );
  assert.deepEqual([...visible].sort(), ['environment-provider', 'minimax-cn', 'opencode', 'opencode-go']);
});

// 编辑 MCP 服务器（含改名）时，表单没提交的字段必须原样保留：env 里的凭据、
// enabled（禁用状态）、timeout 等高级选项；旧名字下的条目要移除，改名不能
// 丢失配置；与本条无关的服务器（docs）不受影响；入参 config 不能被原地修改。
test('editing MCP preserves credentials, disabled state, and unrelated servers', () => {
  const config = {
    version: 1,
    mcpServers: {
      files: {
        command: 'node',
        args: ['old.js'],
        env: { TOKEN: '$TOKEN' },
        enabled: false,
        timeout: 5000,
      },
      docs: { url: 'https://example.test' },
    },
  };
  const original = structuredClone(config);
  const result = updateMcp(config, {
    originalName: 'files',
    name: 'workspace',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '/path/with spaces'],
    description: 'Updated',
  });
  assert.deepEqual(result.mcpServers.workspace, {
    command: 'npx',
    args: ['-y', '/path/with spaces'],
    env: { TOKEN: '$TOKEN' },
    enabled: false,
    timeout: 5000,
    description: 'Updated',
  });
  assert.equal(result.mcpServers.files, undefined);
  assert.deepEqual(result.mcpServers.docs, config.mcpServers.docs);
  assert.deepEqual(config, original);
});

// 切换传输方式（stdio → http）时，旧方式专属字段 command / args 必须删除，
// 避免留下互相矛盾的配置；新方式写入 type: 'http' 与 url；headers 等与传输
// 方式无关的高级选项仍要保留。
test('switching MCP transport removes obsolete transport fields without losing advanced options', () => {
  const result = updateMcp(
    {
      mcpServers: {
        files: {
          command: 'node',
          args: ['server.js'],
          headers: { Authorization: '$TOKEN' },
          enabled: true,
        },
      },
    },
    {
      originalName: 'files',
      name: 'files',
      transport: 'http',
      url: 'https://example.test/mcp',
      args: [],
    },
  );
  assert.equal(result.mcpServers.files.command, undefined);
  assert.equal(result.mcpServers.files.args, undefined);
  assert.equal(result.mcpServers.files.type, 'http');
  assert.deepEqual(result.mcpServers.files.headers, { Authorization: '$TOKEN' });
});

// 新建时重名、改名后与另一条重名都应拒绝；HTTP 地址只接受 http/https
// （file:// 之类的本地路径不是合法的 MCP 端点），防止把错误配置写进 mcp.json。
test('MCP creation and rename reject collisions or invalid URLs', () => {
  const config = { mcpServers: { one: {}, two: {} } };
  assert.throws(
    () => updateMcp(config, { name: 'one', transport: 'stdio', command: 'node', args: [] }),
    /已存在/,
  );
  assert.throws(
    () => updateMcp(config, { originalName: 'one', name: 'two', transport: 'stdio', command: 'node', args: [] }),
    /已存在/,
  );
  assert.throws(
    () => updateMcp(config, { name: 'new', transport: 'http', url: 'file:///tmp/mcp', args: [] }),
    /有效/,
  );
});

// 编辑模型来源只应更新 baseUrl / api 等表单字段，models 目录、headers、
// modelOverrides 以及 $schema 等无关元数据必须保留；并且返回新对象，
// 不原地修改传入的 config（React 侧依赖不可变更新来触发重渲染）。
test('provider editing preserves models, overrides, headers and unrelated metadata', () => {
  const config = {
    $schema: 'schema',
    providers: {
      custom: {
        baseUrl: 'https://old.test',
        api: 'openai-completions',
        headers: { authorization: '$KEY' },
        modelOverrides: { a: { reasoning: true } },
        models: [{ id: 'a', cost: { input: 1 }, contextWindow: 4096 }],
      },
    },
  };
  const result = updateProvider(config, {
    providerId: 'custom',
    editing: true,
    baseUrl: 'https://new.test/v1',
    api: 'openai-responses',
  });
  assert.deepEqual(result.providers.custom.models, config.providers.custom.models);
  assert.deepEqual(result.providers.custom.headers, config.providers.custom.headers);
  assert.deepEqual(result.providers.custom.modelOverrides, config.providers.custom.modelOverrides);
  assert.equal(result.providers.custom.baseUrl, 'https://new.test/v1');
  assert.equal(config.providers.custom.baseUrl, 'https://old.test');
  assert.equal(result.$schema, 'schema');
});

// 已认证的内置来源（这里用 knownProviders 模拟 deepseek）允许只覆盖
// baseUrl / api 而不复制整份模型目录，因此不能凭空生成 models 字段。
// 之后再走“新建”入口添加同一个来源必须报“已存在”，避免误覆盖内置配置。
test('provider editing can override an authenticated built-in provider without replacing its catalog', () => {
  const result = updateProvider(
    { providers: {} },
    { providerId: 'deepseek', editing: true, baseUrl: 'https://gateway.test/v1', api: 'openai-completions' },
    ['deepseek'],
  );
  assert.equal(result.providers.deepseek.models, undefined);
  assert.throws(
    () => updateProvider(result, { providerId: 'deepseek', baseUrl: 'https://gateway.test', api: 'openai-completions', modelId: 'chat' }),
    /已存在/,
  );
});

// API Key 留空表示“不修改”，models.json 里已有的 $OLD_KEY 覆盖必须保留；
// 填入新 Key 时调用方会把它写进 auth.json，这里要删除 models.json 里的旧
// 覆盖，否则旧值会优先生效，用户会误以为新 Key 没保存成功。
test('leaving a key blank preserves its override; replacing it removes the stale override', () => {
  const config = { providers: { custom: { apiKey: '$OLD_KEY', models: [{ id: 'chat' }] } } };
  const input = { providerId: 'custom', editing: true, baseUrl: 'https://example.test/v1', api: 'openai-completions' };
  assert.equal(updateProvider(config, input).providers.custom.apiKey, '$OLD_KEY');
  assert.equal(
    updateProvider(config, { ...input, apiKey: '$NEW_KEY' }).providers.custom.apiKey,
    undefined,
  );
});

// 编辑自定义模型时，表单只覆盖部分字段：name / reasoning / 图像输入会被更新，
// 未提交的 contextWindow 被删除，maxTokens 写入新值；cost、compat 等高级字段
// 必须原样保留。input 中的 audio 等额外模态也不能因为关掉图像而丢失。
// 同时原 config 保持不变。
test('custom model editing keeps advanced fields and supports disabling image and reasoning capabilities', () => {
  const config = {
    providers: {
      custom: {
        api: 'openai-completions',
        models: [{
          id: 'chat',
          name: 'Old',
          reasoning: true,
          input: ['text', 'image', 'audio'],
          contextWindow: 4096,
          cost: { input: 1 },
          compat: { supportsStore: false },
        }],
      },
    },
  };
  const result = updateCustomModel(config, {
    providerId: 'custom',
    modelId: 'chat',
    editing: true,
    name: 'New',
    supportsImages: false,
    reasoning: false,
    maxTokens: 2048,
  });
  const model = result.providers.custom.models[0];
  assert.equal(model.name, 'New');
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, undefined);
  assert.equal(model.maxTokens, 2048);
  assert.deepEqual(model.input, ['text', 'audio']);
  assert.deepEqual(model.cost, { input: 1 });
  assert.deepEqual(model.compat, { supportsStore: false });
  assert.equal(config.providers.custom.models[0].name, 'Old');
});

// 自定义模型的三种拒绝路径：新增已存在的模型、编辑不存在的模型、
// 上下文 / 最大输出不是正整数。这些错误应抛给界面提示，而不是写入坏配置。
test('custom model validation rejects invalid token limits, missing edits, and duplicate creates', () => {
  const config = { providers: { custom: { models: [{ id: 'chat' }] } } };
  assert.throws(
    () => updateCustomModel(config, { providerId: 'custom', modelId: 'chat' }),
    /已存在/,
  );
  assert.throws(
    () => updateCustomModel(config, { providerId: 'custom', modelId: 'missing', editing: true }),
    /不存在/,
  );
  assert.throws(
    () => updateCustomModel(config, { providerId: 'custom', modelId: 'new', maxTokens: -1 }),
    /正整数/,
  );
});

// 配置文件写入必须是原子的：先写临时文件再 rename，目录里不能残留 .tmp；
// 已存在但 JSON 损坏的文件不能被 fallback 静默覆盖，而要报错让用户先修复，
// 同时保持原文件内容不变，避免丢配置。
test('config writes are atomic and invalid existing JSON is never silently replaced', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-test-'));
  const file = path.join(folder, 'mcp.json');
  try {
    assert.deepEqual(readConfig(file, { mcpServers: {} }), { mcpServers: {} });
    writeConfig(file, { mcpServers: {} });
    assert.deepEqual(readConfig(file), { mcpServers: {} });
    assert.deepEqual(fs.readdirSync(folder), ['mcp.json']);
    fs.writeFileSync(file, '{ invalid');
    assert.throws(() => readConfig(file, {}), /修复文件格式/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ invalid');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
