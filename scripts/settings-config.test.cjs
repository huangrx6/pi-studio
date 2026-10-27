const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, writeConfig, updateMcp, updateProvider, updateCustomModel } = require('../electron/settings-config.cjs');

test('editing MCP preserves credentials, disabled state, and unrelated servers', () => {
  const config = { version: 1, mcpServers: { files: { command: 'node', args: ['old.js'], env: { TOKEN: '$TOKEN' }, enabled: false, timeout: 5000 }, docs: { url: 'https://example.test' } } };
  const original = structuredClone(config);
  const result = updateMcp(config, { originalName: 'files', name: 'workspace', transport: 'stdio', command: 'npx', args: ['-y', '/path/with spaces'], description: 'Updated' });
  assert.deepEqual(result.mcpServers.workspace, { command: 'npx', args: ['-y', '/path/with spaces'], env: { TOKEN: '$TOKEN' }, enabled: false, timeout: 5000, description: 'Updated' });
  assert.equal(result.mcpServers.files, undefined);
  assert.deepEqual(result.mcpServers.docs, config.mcpServers.docs);
  assert.deepEqual(config, original);
});

test('switching MCP transport removes obsolete transport fields without losing advanced options', () => {
  const result = updateMcp({ mcpServers: { files: { command: 'node', args: ['server.js'], headers: { Authorization: '$TOKEN' }, enabled: true } } }, { originalName: 'files', name: 'files', transport: 'http', url: 'https://example.test/mcp', args: [] });
  assert.equal(result.mcpServers.files.command, undefined);
  assert.equal(result.mcpServers.files.args, undefined);
  assert.equal(result.mcpServers.files.type, 'http');
  assert.deepEqual(result.mcpServers.files.headers, { Authorization: '$TOKEN' });
});

test('MCP creation and rename reject collisions or invalid URLs', () => {
  const config = { mcpServers: { one: {}, two: {} } };
  assert.throws(() => updateMcp(config, { name: 'one', transport: 'stdio', command: 'node', args: [] }), /已存在/);
  assert.throws(() => updateMcp(config, { originalName: 'one', name: 'two', transport: 'stdio', command: 'node', args: [] }), /已存在/);
  assert.throws(() => updateMcp(config, { name: 'new', transport: 'http', url: 'file:///tmp/mcp', args: [] }), /有效/);
});

test('provider editing preserves models, overrides, headers and unrelated metadata', () => {
  const config = { $schema: 'schema', providers: { custom: { baseUrl: 'https://old.test', api: 'openai-completions', headers: { authorization: '$KEY' }, modelOverrides: { a: { reasoning: true } }, models: [{ id: 'a', cost: { input: 1 }, contextWindow: 4096 }] } } };
  const result = updateProvider(config, { providerId: 'custom', editing: true, baseUrl: 'https://new.test/v1', api: 'openai-responses' });
  assert.deepEqual(result.providers.custom.models, config.providers.custom.models);
  assert.deepEqual(result.providers.custom.headers, config.providers.custom.headers);
  assert.deepEqual(result.providers.custom.modelOverrides, config.providers.custom.modelOverrides);
  assert.equal(result.providers.custom.baseUrl, 'https://new.test/v1');
  assert.equal(config.providers.custom.baseUrl, 'https://old.test');
  assert.equal(result.$schema, 'schema');
});

test('provider editing can override an authenticated built-in provider without replacing its catalog', () => {
  const result = updateProvider({ providers: {} }, { providerId: 'deepseek', editing: true, baseUrl: 'https://gateway.test/v1', api: 'openai-completions' }, ['deepseek']);
  assert.equal(result.providers.deepseek.models, undefined);
  assert.throws(() => updateProvider(result, { providerId: 'deepseek', baseUrl: 'https://gateway.test', api: 'openai-completions', modelId: 'chat' }), /已存在/);
});

test('custom model editing keeps advanced fields and supports disabling image and reasoning capabilities', () => {
  const config = { providers: { custom: { api: 'openai-completions', models: [{ id: 'chat', name: 'Old', reasoning: true, input: ['text', 'image', 'audio'], contextWindow: 4096, cost: { input: 1 }, compat: { supportsStore: false } }] } } };
  const result = updateCustomModel(config, { providerId: 'custom', modelId: 'chat', editing: true, name: 'New', supportsImages: false, reasoning: false, maxTokens: 2048 });
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

test('custom model validation rejects invalid token limits, missing edits, and duplicate creates', () => {
  const config = { providers: { custom: { models: [{ id: 'chat' }] } } };
  assert.throws(() => updateCustomModel(config, { providerId: 'custom', modelId: 'chat' }), /已存在/);
  assert.throws(() => updateCustomModel(config, { providerId: 'custom', modelId: 'missing', editing: true }), /不存在/);
  assert.throws(() => updateCustomModel(config, { providerId: 'custom', modelId: 'new', maxTokens: -1 }), /正整数/);
});

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
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
