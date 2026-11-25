import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { mcpConnectionStatus } from '../../web/src/features/mcp/mcp-status.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const makeServer = (name = 'A', extra = {}) => ({
  name, transport: 'http', target: `https://${name}.example/mcp`, cwd: '', enabled: true,
  connected: true, oauthConnected: false, description: '', exposure: 'deferred', timeoutSeconds: 60,
  envKeys: [], headerKeys: ['Authorization'], toolCount: 1,
  tools: [{ name: 'saved-tool', originalName: 'saved-tool', description: 'saved description', exposure: 'deferred', enabled: true }],
  error: '', stderr: '', ...extra,
});

function harness() {
  let slots = [], cursor = 0, key, tree, cleanup, effect, effectSet = false, dirty = false;
  const toasts = [];
  const calls = { method: [], refresh: [], runtime: [], committed: [], recovered: [] };
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
    module, exports: module.exports,
    window: { piApi: { setMcpMethodEnabled: (...args) => call('method', ...args), refreshMcp: (...args) => call('runtime', ...args) } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name.endsWith('mcp-status')) return { mcpConnectionStatus };
      if (name.endsWith('error-text')) return { errorText: error => error.message };
      if (name.endsWith('DetailDialog')) return { DetailDialog: 'dialog' };
      if (name.endsWith('/SettingsToast')) return { SettingsToast: 'SettingsToast', useSettingsToast: () => (...args) => toasts.push(args) };
      if (name.endsWith('/Accordion')) return { Accordion: 'Accordion' };
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
    calls, render, toasts,
    button(label) { return nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || nodeText(node) === label)); },
    text() { return nodeText(tree); },
    recovery() { return nodes(tree).find(node => node.type === 'SettingsToast')?.props; },
    count(type) { return nodes(tree).filter(node => node.type === type).length; },
    details(label) { return nodes(tree).find(node => node.type === 'Accordion' && nodeText(node.props.summary) === label); },
    unmount() { cleanup?.(); },
  };
}

test('detail dialog focuses on inspection and method toggles without test/OAuth buttons', () => {
  const h = harness();
  assert.equal(h.button('测试连接'), undefined);
  assert.equal(h.button('OAuth 登录'), undefined);
  assert.equal(h.button('退出 OAuth'), undefined);
  assert.ok(h.button('启用 MCP 方法 saved-tool'));
});

test('method toggles share a synchronous lock, including two clicks before React commits', async () => {
  const h = harness();
  const toggle = h.button('启用 MCP 方法 saved-tool').props.onClick;
  toggle(); toggle();
  assert.equal(h.calls.method.length, 1);
  h.calls.method[0].resolve({ committed: true, projection: { status: 'ready', value: { mcp: [] } } });
  await flush(); h.render();
  h.calls.refresh[0].resolve(); await flush(); h.render();
  assert.deepEqual(h.toasts, [['已停用 saved-tool']]);
});

test('closing immediately or unmounting suppresses late refresh and error publication', async () => {
  const h = harness();
  h.button('启用 MCP 方法 saved-tool').props.onClick();
  h.button('关闭 MCP 详情').props.onClick();
  h.calls.method[0].resolve({ committed: true, projection: { status: 'ready', value: { mcp: [] } } });
  await flush();
  assert.equal(h.calls.refresh.length, 0);
  assert.equal(h.calls.committed.length, 1);
  assert.equal(h.calls.committed[0][1], '/workspace/A');
  assert.equal(h.calls.recovered.length, 0);

  h.render({ server: makeServer('B') });
  h.button('启用 MCP 方法 saved-tool').props.onClick();
  h.unmount();
  h.calls.method[1].reject(new Error('late method error'));
  await flush();
  assert.deepEqual(h.toasts, []);
});

test('saved tools and diagnostics remain discoverable on demand', () => {
  const h = harness();
  h.render({ server: makeServer('err-server', { connected: false, error: 'existing connection error', stderr: 'long diagnostic payload' }) });
  assert.match(h.text(), /existing connection error/);
  assert.equal(h.count('pre'), 0);
  assert.doesNotMatch(h.text(), /saved description/);
  assert.equal(h.details('工具').props.badge, 1);
  h.details('工具').props.onToggle({ currentTarget: { open: true } });
  h.details('诊断信息').props.onToggle({ currentTarget: { open: true } });
  h.render();
  assert.match(h.text(), /saved description/);
  assert.equal(h.count('pre'), 1);
  assert.match(h.text(), /long diagnostic payload/);
});

test('short connected MCP tool lists open on entry and long lists stay folded', () => {
  const h = harness();
  const short = makeServer('short', { connected: true });
  h.render({ server: short });
  assert.equal(h.details('工具').props.open, true);
  h.details('工具').props.onToggle({ currentTarget: { open: false } });
  h.render({ server: { ...short } });
  assert.equal(h.details('工具').props.open, false);

  const tools = Array.from({ length: 6 }, (_, index) => ({
    ...short.tools[0], name: `tool-${index}`, originalName: `tool-${index}`,
  }));
  h.render({ server: makeServer('long', { connected: true, toolCount: tools.length, tools }) });
  assert.equal(h.details('工具').props.open, false);
  assert.equal(h.details('工具').props.badge, 6);
});

test('committed backend failure retries runtime with the original cwd, then only the failed detail callback', async () => {
  const h = harness();
  const toggle = h.button('启用 MCP 方法 saved-tool').props.onClick;
  toggle();
  h.calls.method[0].resolve({ committed: true, projection: { status: 'error', message: 'MCP 已保存，刷新未完成' } });
  await flush(); toggle(); assert.equal(h.calls.method.length, 1); h.render();
  assert.match(h.recovery().message, /已停用 saved-tool/);
  assert.equal(h.calls.refresh.length, 0);
  assert.equal(h.button('启用 MCP 方法 saved-tool').props.disabled, true);
  const retry = h.button('重试刷新').props.onClick; retry(); retry();
  assert.equal(h.calls.runtime.length, 1); assert.equal(h.calls.runtime[0].args[0], '/workspace/A');
  h.calls.runtime[0].reject(new Error('runtime failed')); await flush(); h.render();
  h.button('重试刷新').props.onClick(); const snapshot = { mcp: [{ name: 'A' }] };
  h.calls.runtime[1].resolve(snapshot); await flush();
  h.calls.refresh[0].reject(new Error('detail failed')); await flush(); h.render();
  h.button('重试刷新').props.onClick(); assert.equal(h.calls.runtime.length, 2);
  h.calls.refresh[1].resolve(); await flush(); h.render();
  assert.equal(h.calls.method.length, 1); assert.equal(h.calls.committed.length, 1);
  assert.equal(h.calls.recovered.length, 1); assert.equal(h.calls.recovered[0][0], snapshot);
  assert.equal(h.calls.recovered[0][1], '/workspace/A'); assert.equal(h.button('重试刷新'), undefined);
});

test('closing during read-only recovery cannot apply or refresh a replaced detail', async () => {
  const h = harness();
  h.button('启用 MCP 方法 saved-tool').props.onClick();
  h.calls.method[0].resolve({ committed: true, projection: { status: 'error', message: 'retry' } });
  await flush(); h.render(); h.button('重试刷新').props.onClick();
  h.render({ server: makeServer('B'), workspace: '/workspace/B' });
  h.calls.runtime[0].resolve({ mcp: [] }); await flush(); h.render();
  assert.equal(h.calls.refresh.length, 0); assert.equal(h.calls.recovered.length, 0);
  assert.equal(h.recovery(), undefined); assert.deepEqual(h.toasts, []);
});
