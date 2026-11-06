import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness(file, name, initial) {
  let slots = [], cursor = 0, tree, props = initial;
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  let source = fs.readFileSync(new URL(`../../web/src/features/${file}`, import.meta.url), 'utf8');
  if (name === 'McpEditorTestResult') source += '\nexport { McpEditorTestResult };';
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return { useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; } };
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (id.endsWith('/Select')) return { Select: 'Select' };
      if (id.endsWith('/InfoHint')) return { InfoHint: 'InfoHint' };
      return {};
    },
  });
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
  const render = next => { props = { ...props, ...next }; cursor = 0; tree = module.exports[name](props); };
  render();
  return { render, text: () => text(tree), find: predicate => nodes(tree).find(predicate), all: predicate => nodes(tree).filter(predicate) };
}
const provider = { providerId: 'source-a', name: 'Source A', baseUrl: 'https://source.example/v1', api: 'custom-api', apiKey: '', modelsUrl: '', icon: '' };
const mcp = { name: 'server', transport: 'stdio', command: 'npx', args: 'one\npath with spaces', cwd: '', url: '', description: '', env: 'TOKEN=', headers: '', exposure: 'deferred', timeoutSeconds: '60', toolExposure: '', clearEnv: false, clearHeaders: false };
const input = id => node => node.props?.id === id;

test('provider preserves unknown API types, explicit credential semantics and independent draft changes', () => {
  let draft = { ...provider };
  const h = harness('models/ProviderEditorFields.tsx', 'ProviderEditorFields', { draft, setDraft: update => { draft = update(draft); }, editing: true, apiTypeOptions: [{ value: 'openai', label: 'OpenAI' }] });
  const select = h.find(node => node.type === 'Select');
  assert.equal(select.props.options.at(-1).value, 'custom-api'); assert.equal(h.find(input('provider-id')).props.disabled, true);
  assert.match(h.text(), /全局模型来源/); assert.match(h.text(), /留空保留已保存的 API Key，不会清除凭据/);
  h.find(input('provider-api-key')).props.onChange({ target: { value: 'new-secret' } });
  h.find(input('provider-models-url')).props.onChange({ target: { value: 'https://source.example/catalog' } });
  assert.equal(draft.apiKey, 'new-secret'); assert.equal(draft.modelsUrl, 'https://source.example/catalog');
});

test('configured provider advanced fields are discoverable; collapsed invalid field opens synchronously without cancelling validation', () => {
  const h = harness('models/ProviderEditorFields.tsx', 'ProviderEditorFields', { draft: { ...provider, modelsUrl: 'bad-url' }, setDraft() {}, editing: true, apiTypeOptions: [] });
  let advanced = h.find(node => node.type === 'details'); assert.equal(advanced.props.open, true); assert.match(h.text(), /高级选项已配置/);
  advanced.props.onToggle({ currentTarget: { open: false } }); h.render(); advanced = h.find(node => node.type === 'details');
  assert.equal(advanced.props.open, false); assert.equal(h.find(input('provider-models-url')).props.type, 'url');
  const nativeDetails = { open: false };
  advanced.props.onInvalidCapture({ currentTarget: nativeDetails, preventDefault() { assert.fail('must preserve native validation'); } });
  assert.equal(nativeDetails.open, true); h.render(); assert.equal(h.find(node => node.type === 'details').props.open, true);
});

test('MCP retains explicit credential clearing after the text is erased and restores text after cancelling clear', () => {
  let draft = { ...mcp, env: '' };
  const h = harness('mcp/McpEditorFields.tsx', 'McpEditorFields', { draft, setDraft: update => { draft = update(draft); }, editing: true, mcpTesting: false, settingsBusy: false, testCurrentMcp() {}, testResult: null });
  assert.match(h.text(), /全局 MCP 连接/); assert.match(h.text(), /清除全部已保存环境变量/);
  h.find(input('mcp-env')).props.onChange({ target: { value: 'TOKEN=unchanged-draft' } });
  h.find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } }); h.render({ draft });
  assert.equal(h.find(input('mcp-env')).props.disabled, true); assert.match(h.text(), /上方输入不会生效/);
  h.find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: false } }); h.render({ draft });
  assert.equal(h.find(input('mcp-env')).props.value, 'TOKEN=unchanged-draft'); assert.equal(h.find(input('mcp-env')).props.disabled, false);
  h.render({ draft: { ...draft, transport: 'http' } }); assert.equal(h.find(input('mcp-env')), undefined);
  assert.equal(h.find(input('mcp-url')).props.required, true); assert.match(h.text(), /清除全部已保存 Headers/);
});

test('MCP test respects native validation and busy state; advanced timeout remains validatable while collapsed', () => {
  let tests = 0;
  const h = harness('mcp/McpEditorFields.tsx', 'McpEditorFields', { draft: mcp, setDraft() {}, editing: false, mcpTesting: false, settingsBusy: false, testCurrentMcp() { tests++; }, testResult: null });
  const button = () => h.find(node => node.type === 'button');
  button().props.onClick({ currentTarget: { form: { reportValidity: () => false } } }); assert.equal(tests, 0);
  button().props.onClick({ currentTarget: { form: { reportValidity: () => true } } }); assert.equal(tests, 1);
  const timeout = h.find(input('mcp-timeout')); assert.equal(timeout.props.min, '1'); assert.equal(timeout.props.max, '3600');
  const advanced = h.find(node => node.type === 'details'), nativeDetails = { open: false };
  assert.equal(advanced.props.open, false); advanced.props.onInvalidCapture({ currentTarget: nativeDetails }); assert.equal(nativeDetails.open, true);
  h.render({ mcpTesting: true }); assert.equal(button().props.disabled, true); button().props.onClick({ currentTarget: {} }); assert.equal(tests, 1);
});

test('MCP test failures stay failures and long result bodies mount only after explicit expansion', () => {
  const result = { ok: false, durationMs: 12, tools: [{ name: 'tool', description: 'very long tool description', argumentCount: 2, exposure: 'direct' }], resources: [], capabilities: { resources: false }, instructions: 'diagnostic summary', stderr: 'diagnostic stderr' };
  const h = harness('mcp/McpEditorFields.tsx', 'McpEditorTestResult', { result });
  assert.match(h.text(), /连接测试未成功/); assert.doesNotMatch(h.text(), /连接成功|very long tool description|diagnostic stderr/);
  assert.ok(h.find(node => node.props?.role === 'alert')); assert.equal(h.all(node => node.type === 'pre').length, 0);
  h.all(node => node.type === 'details').forEach(node => node.props.onToggle({ currentTarget: { open: true } })); h.render();
  assert.match(h.text(), /very long tool description/); assert.match(h.text(), /diagnostic stderr/); assert.equal(h.all(node => node.type === 'pre').length, 1);
  h.render({ result: { ...result, ok: true } }); assert.match(h.text(), /连接成功/); assert.ok(h.find(node => node.props?.role === 'status'));
});
