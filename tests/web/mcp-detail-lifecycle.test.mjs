import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { mcpConnectionStatus } from '../../web/src/features/mcp/mcp-status.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const makeServer = (name = 'A', extra = {}) => ({ name, transport: 'http', target: `https://${name}.example/mcp`, cwd: '', enabled: true, connected: false, oauthConnected: false, description: '', exposure: 'deferred', timeoutSeconds: 60, envKeys: [], headerKeys: ['Authorization'], toolCount: 1, tools: [{ name: 'saved-tool', originalName: 'saved-tool', description: 'saved description', exposure: 'deferred' }], error: '', stderr: '', ...extra });
const testResult = extra => ({ ok: true, durationMs: 15, instructions: 'tested', tools: [], resources: [], capabilities: { tools: true, resources: false }, stderr: '', ...extra });

function harness() {
  let slots = [], cursor = 0, key, tree, cleanup, effect, effectSet = false, dirty = false;
  const calls = { test: [], authorize: [], logout: [], refresh: [], runtime: [], committed: [], recovered: [] };
  const react = {
    useState(initial) { const store = slots, i = cursor++; if (!(i in store)) store[i] = initial; return [store[i], value => { const next = typeof value === 'function' ? value(store[i]) : value; dirty ||= !Object.is(next, store[i]); store[i] = next; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(fn) { if (!effectSet) { effect = fn; effectSet = true; } },
  };
  const call = (kind, ...args) => { const pending = deferred(); calls[kind].push({ ...pending, args }); return pending.promise; };
  const module = { exports: {} };
  const jsx = (type, props, key) => ({ type, props, key });
  const source = fs.readFileSync(new URL('../../web/src/features/mcp/McpDetailDialog.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, window: { piApi: { testSavedMcp: (...args) => call('test', ...args), startMcpOAuth: (...args) => call('authorize', ...args), logoutMcpOAuth: (...args) => call('logout', ...args), refreshMcp: (...args) => call('runtime', ...args) } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name.endsWith('mcp-status')) return { mcpConnectionStatus };
      if (name.endsWith('error-text')) return { errorText: error => error.message };
      if (name.endsWith('DetailDialog')) return { DetailDialog: 'dialog' };
      return {};
    },
  });
  let props = { server: makeServer(), workspace: '/workspace/A', onClose() {}, onRefresh: () => call('refresh'), onCommitted: (...args) => calls.committed.push(args), onRecovered: (...args) => calls.recovered.push(args) };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const nodeText = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(nodeText).join('') : node && typeof node === 'object' ? nodeText(node.props?.children) : '';
  function render(next) {
    props = { ...props, ...next }; const scope = module.exports.McpDetailDialog(props);
    if (scope.key !== key) { cleanup?.(); slots = []; effectSet = false; key = scope.key; }
    do { dirty = false; cursor = 0; tree = scope.type(scope.props); if (effect) { cleanup = effect(); effect = undefined; } } while (dirty);
  }
  render();
  return {
    calls, render,
    button(label) { return nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || nodeText(node) === label)); },
    text() { return nodeText(tree); },
    count(type) { return nodes(tree).filter(node => node.type === type).length; },
    section(label) { return nodes(tree).find(node => node.props?.['aria-label'] === label); },
    details(label) { return nodes(tree).find(node => node.type === 'details' && nodeText(node.props.children?.[0]) === label); },
    unmount() { cleanup?.(); },
  };
}

test('test and OAuth share a synchronous lock, including two clicks before React commits', async () => {
  const h = harness(); const testClick = h.button('测试连接').props.onClick, oauthClick = h.button('OAuth 登录').props.onClick;
  testClick(); testClick(); oauthClick(); assert.equal(h.calls.test.length, 1); assert.equal(h.calls.authorize.length, 0);
  h.calls.test[0].resolve(testResult()); await flush(); h.render(); oauthClick(); oauthClick(); assert.equal(h.calls.authorize.length, 1);
});

test('server/workspace changes reset results and old test completion cannot leak into another resource', async () => {
  const h = harness(); h.button('测试连接').props.onClick(); h.render({ server: makeServer('B') });
  h.calls.test[0].resolve(testResult({ instructions: 'OLD A ONLY' })); await flush(); h.render(); assert.doesNotMatch(h.text(), /OLD A ONLY|连接成功/);
  h.button('测试连接').props.onClick(); h.calls.test[1].resolve(testResult({ instructions: 'B result' })); await flush(); h.render(); assert.match(h.text(), /B result/);
  h.render({ workspace: '/workspace/other' }); assert.doesNotMatch(h.text(), /B result/);
});

test('closing immediately or unmounting suppresses late OAuth refresh and error publication', async () => {
  const h = harness(); h.button('OAuth 登录').props.onClick(); h.button('关闭 MCP 详情').props.onClick();
  h.calls.authorize[0].resolve({ committed: true, projection: { status: 'ready', value: { mcpServers: [] } } }); await flush(); assert.equal(h.calls.refresh.length, 0); assert.equal(h.calls.committed.length, 1); assert.equal(h.calls.committed[0][1], '/workspace/A'); assert.equal(h.calls.recovered.length, 0);
  h.render({ server: makeServer('B') }); h.button('测试连接').props.onClick(); h.unmount(); h.calls.test[0].reject(new Error('late test')); await flush(); assert.doesNotMatch(h.text(), /late test/);
});

test('successful authorization plus failed read preserves success and retries only the projection', async () => {
  const h = harness(); h.button('OAuth 登录').props.onClick(); h.calls.authorize[0].resolve({ committed: true, projection: { status: 'ready', value: { mcpServers: [] } } }); await flush(); h.render();
  assert.equal(h.calls.refresh.length, 1); assert.match(h.text(), /OAuth 授权已完成/);
  h.calls.refresh[0].reject(new Error('settings unavailable')); await flush(); h.render();
  assert.match(h.text(), /操作已完成，但详情刷新失败/); assert.equal(h.button('退出 OAuth').props.disabled, true); assert.equal(h.button('OAuth 登录'), undefined);
  const retry = h.button('重试刷新').props.onClick; retry(); retry(); assert.equal(h.calls.refresh.length, 2); assert.equal(h.calls.authorize.length, 1);
  h.render({ server: makeServer('A', { oauthConnected: true }) }); h.calls.refresh[1].resolve(); await flush(); h.render();
  assert.doesNotMatch(h.text(), /settings unavailable/); assert.equal(h.button('退出 OAuth').props.disabled, false); assert.equal(h.calls.authorize.length, 1);
});

test('logout success followed by read failure never logs out twice and failed operation does not refresh', async () => {
  const h = harness(); h.render({ server: makeServer('A', { oauthConnected: true }) }); h.button('退出 OAuth').props.onClick(); h.calls.logout[0].resolve({ committed: true, projection: { status: 'ready', value: { mcpServers: [] } } }); await flush();
  h.calls.refresh[0].reject(new Error('read failed')); await flush(); h.render(); assert.match(h.text(), /OAuth 凭据已清除/); assert.equal(h.button('OAuth 登录').props.disabled, true);
  h.button('重试刷新').props.onClick(); assert.equal(h.calls.logout.length, 1);
  h.render({ server: makeServer('B') }); h.button('OAuth 登录').props.onClick(); h.calls.authorize[0].reject(new Error('OAuth 操作未完成')); await flush(); h.render();
  assert.match(h.text(), /OAuth 操作未完成/); assert.equal(h.calls.refresh.length, 2);
});

test('failed test is not reported as connected; saved tools and diagnostics remain discoverable on demand', async () => {
  const h = harness(); h.render({ server: makeServer('A', { error: 'existing connection error', stderr: 'long diagnostic payload' }) });
  assert.match(h.text(), /existing connection error/); assert.equal(h.count('pre'), 0); assert.doesNotMatch(h.text(), /saved description/);
  h.button('测试连接').props.onClick(); h.calls.test[0].resolve(testResult({ ok: false })); await flush(); h.render();
  assert.match(h.text(), /连接测试未成功/); assert.doesNotMatch(h.text(), /连接成功/); assert.equal(h.section('连接测试结果').props.role, 'alert');
  h.details('工具 · 1').props.onToggle({ currentTarget: { open: true } }); h.details('诊断信息').props.onToggle({ currentTarget: { open: true } }); h.render();
  assert.match(h.text(), /saved description/); assert.equal(h.count('pre'), 1); assert.match(h.text(), /long diagnostic payload/);
});


test('committed backend failure retries runtime with the original cwd, then only the failed detail callback', async () => {
  const h = harness(); const oldAuthorizeClick = h.button('OAuth 登录').props.onClick; oldAuthorizeClick();
  h.calls.authorize[0].resolve({ committed: true, projection: { status: 'error', message: 'MCP 已保存，刷新未完成' } });
  await flush(); oldAuthorizeClick(); assert.equal(h.calls.authorize.length, 1); h.render();
  assert.match(h.text(), /OAuth 授权已完成/); assert.equal(h.calls.refresh.length, 0);
  assert.equal(h.button('退出 OAuth').props.disabled, true);
  const retry = h.button('重试刷新').props.onClick; retry(); retry();
  assert.equal(h.calls.runtime.length, 1); assert.equal(h.calls.runtime[0].args[0], '/workspace/A');
  h.calls.runtime[0].reject(new Error('runtime failed')); await flush(); h.render();
  h.button('重试刷新').props.onClick(); const snapshot = { mcpServers: [{ name: 'A' }] };
  h.calls.runtime[1].resolve(snapshot); await flush();
  h.calls.refresh[0].reject(new Error('detail failed')); await flush(); h.render();
  h.button('重试刷新').props.onClick(); assert.equal(h.calls.runtime.length, 2);
  h.calls.refresh[1].resolve(); await flush(); h.render();
  assert.equal(h.calls.authorize.length, 1); assert.equal(h.calls.committed.length, 1);
  assert.equal(h.calls.recovered.length, 1); assert.equal(h.calls.recovered[0][0], snapshot);
  assert.equal(h.calls.recovered[0][1], '/workspace/A'); assert.equal(h.button('重试刷新'), undefined);
});

test('closing during read-only recovery cannot apply or refresh a replaced detail', async () => {
  const h = harness(); h.button('OAuth 登录').props.onClick();
  h.calls.authorize[0].resolve({ committed: true, projection: { status: 'error', message: 'retry' } });
  await flush(); h.render(); h.button('重试刷新').props.onClick();
  h.render({ server: makeServer('B'), workspace: '/workspace/B' });
  h.calls.runtime[0].resolve({ mcpServers: [] }); await flush(); h.render();
  assert.equal(h.calls.refresh.length, 0); assert.equal(h.calls.recovered.length, 0);
  assert.doesNotMatch(h.text(), /授权已完成|retry/);
});
