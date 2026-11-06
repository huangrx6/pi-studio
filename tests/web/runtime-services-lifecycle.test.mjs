import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const service = (id = 'A', extra = {}) => ({ id, pid: 42, port: 5173, startedAt: 1000, ownership: 'workspace', canStop: true, processName: `server-${id}`, url: 'http://localhost:5173', command: 'node serve', cwd: `/${id}`, evidence: [], ...extra });
const snapshot = (...services) => ({ services, scannedAt: Date.now(), supported: true, warning: '', summary: { related: services.filter(s => s.ownership === 'workspace').length, total: services.length } });

// Drive the real keyed component and effect lifetimes with deferred IPC. No
// discovery command or stop API ever reaches a real process.
function harness(initial = { cwd: '/A', workspace: '/A' }, hidden = false) {
  let slots = [], cursor = 0, deps, effect, cleanup, scopeKey, tree, dirty = false, nextTimer = 0;
  const scans = [], stops = [], confirmations = [], copies = [], intervals = new Map(), timeouts = new Map(), listeners = new Set();
  const changed = (before, after) => !before || after.some((value, i) => value !== before[i]);
  const react = {
    useState(initial) { const store = slots, i = cursor++; if (!(i in store)) store[i] = initial; return [store[i], value => { const next = typeof value === 'function' ? value(store[i]) : value; if (!Object.is(next, store[i])) dirty = true; store[i] = next; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useMemo(factory, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: factory() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, nextDeps) { if (changed(deps, nextDeps)) { deps = nextDeps; effect = fn; } },
  };
  const confirmation = { confirm(options) { const pending = deferred(); confirmations.push({ ...pending, options }); return pending.promise; }, dialog: null };
  const document = { hidden, addEventListener(type, fn) { assert.equal(type, 'visibilitychange'); listeners.add(fn); }, removeEventListener(type, fn) { listeners.delete(fn); } };
  const api = {
    runtimeServices(input) { const pending = deferred(); scans.push({ ...pending, input }); return pending.promise; },
    runtimeServiceStop(input) { const pending = deferred(); stops.push({ ...pending, input }); return pending.promise; },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../../web/src/features/runtime-services/RuntimeServicesPanel.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, document,
    navigator: { clipboard: { writeText(text) { const pending = deferred(); copies.push({ ...pending, text }); return pending.promise; } } },
    window: { piApi: api, setInterval(fn, ms) { intervals.set(++nextTimer, { fn, ms }); return nextTimer; }, clearInterval(id) { intervals.delete(id); }, setTimeout(fn) { timeouts.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { timeouts.delete(id); } },
    require(name) { if (name === 'react') return react; if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }; if (name.endsWith('ConfirmDialog')) return { useActionConfirmation: () => confirmation }; if (name.endsWith('error-text')) return { errorText: error => error.message }; return {}; },
  });
  let props = initial;
  function render(next) {
    props = { ...props, ...next };
    const scope = module.exports.RuntimeServicesPanel(props);
    if (scope.key !== scopeKey) { cleanup?.(); cleanup = undefined; deps = undefined; slots = []; scopeKey = scope.key; }
    do { dirty = false; cursor = 0; tree = scope.type(scope.props); if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; } } while (dirty);
  }
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  render();
  return {
    scans, stops, confirmations, copies, intervals, timeouts, render,
    rows() { return nodes(tree).filter(node => node.props?.service); },
    button(label) { return nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || node.props.children === label || (Array.isArray(node.props.children) && node.props.children[0] === label))); },
    text() { return JSON.stringify(tree); },
    poll() { for (const timer of [...intervals.values()]) if (timer.ms === 2500) timer.fn(); render(); },
    visible(value) { document.hidden = !value; for (const fn of listeners) fn(); render(); },
    unmount() { cleanup?.(); },
    listenerCount() { return listeners.size; },
  };
}

test('scope switches immediately discard old rows and busy locks; late old success/error cannot affect new scope', async () => {
  const h = harness(); assert.equal(h.scans.length, 1);
  h.render({ cwd: '/B', workspace: '/B' }); assert.equal(h.scans.length, 2); assert.equal(h.rows().length, 0);
  h.scans[1].resolve(snapshot(service('B'))); await flush(); h.render();
  h.scans[0].resolve(snapshot(service('A'))); await flush(); h.render(); assert.equal(h.rows()[0].props.service.id, 'B');
  h.poll(); h.render({ cwd: '/C', workspace: '/C' }); assert.equal(h.rows().length, 0);
  h.scans[2].reject(new Error('old B error')); await flush(); h.render(); assert.doesNotMatch(h.text(), /old B error/);
  assert.equal(h.scans[3].input.cwd, '/C');
});

test('hidden panels stop polling and clock timers, resume immediately, and never overlap same-scope scans', async () => {
  const h = harness(undefined, true); assert.equal(h.scans.length, 0); assert.equal(h.intervals.size, 0);
  h.visible(true); assert.equal(h.scans.length, 1); assert.equal(h.intervals.size, 2);
  h.poll(); h.poll(); assert.equal(h.scans.length, 1);
  h.visible(false); assert.equal(h.intervals.size, 0);
  h.scans[0].resolve(snapshot(service())); await flush(); h.render();
  h.visible(true); assert.equal(h.scans.length, 2); h.unmount();
  assert.equal(h.intervals.size, 0); assert.equal(h.listenerCount(), 0);
});

test('failed first scan never claims empty services; failed refresh explicitly retains previous results and retry recovers', async () => {
  const h = harness(); h.scans[0].reject(new Error('scan offline')); await flush(); h.render();
  assert.match(h.text(), /scan offline/); assert.doesNotMatch(h.text(), /当前任务还没有监听服务|没有发现监听端口/);
  h.button('重试').props.onClick(); h.scans[1].resolve(snapshot(service())); await flush(); h.render(); assert.equal(h.rows().length, 1);
  h.poll(); h.scans[2].reject(new Error('refresh offline')); await flush(); h.render();
  assert.equal(h.rows().length, 1); assert.match(h.text(), /以下显示上次扫描结果/);
  h.button('重试').props.onClick(); h.scans[3].resolve(snapshot()); await flush(); h.render();
  assert.match(h.text(), /当前任务还没有监听服务/); assert.doesNotMatch(h.text(), /refresh offline/);
});

test('late confirmation after scope change never invokes stop; already-issued stop cannot refresh or error in another scope', async () => {
  const h = harness(); h.scans[0].resolve(snapshot(service())); await flush(); h.render();
  h.rows()[0].props.onStop(); h.render({ cwd: '/B', workspace: '/B' });
  h.confirmations[0].resolve(true); await flush(); assert.equal(h.stops.length, 0);
  h.scans[1].resolve(snapshot(service('B'))); await flush(); h.render();
  h.rows()[0].props.onStop(); h.confirmations[1].resolve(true); await flush();
  assert.equal(h.stops.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(h.stops[0].input)), { pid: 42, port: 5173, startedAt: 1000 });
  h.render({ cwd: '/C', workspace: '/C' }); const calls = h.scans.length;
  h.stops[0].reject(new Error('old stop error')); await flush(); h.render();
  assert.equal(h.scans.length, calls); assert.doesNotMatch(h.text(), /old stop error/);
});

test('confirmed stop refresh supersedes pre-stop scan, preserves multiport/external risk and persistent stop errors', async () => {
  const h = harness(); h.scans[0].resolve(snapshot(service('A', { ownership: 'other' }), service('A2', { ownership: 'other', port: 5174 }))); await flush(); h.render();
  h.button('全部').props.onClick(); h.render();
  h.poll(); const preStop = h.scans[1];
  h.rows()[0].props.onStop(); h.rows()[0].props.onStop(); assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0].options.description, /当前工作区以外/);
  assert.match(h.confirmations[0].options.description, /5173、5174/); assert.match(h.confirmations[0].options.description, /强制结束/);
  h.confirmations[0].resolve(true); await flush(); h.stops[0].resolve({ ok: true }); await flush();
  assert.equal(h.scans.length, 3, 'post-stop read must not be swallowed by old pending scan');
  h.scans[2].resolve(snapshot()); await flush(); h.render(); preStop.resolve(snapshot(service())); await flush(); h.render(); assert.equal(h.rows().length, 0);
  h.poll(); h.scans[3].resolve(snapshot(service())); await flush(); h.render();
  h.rows()[0].props.onStop(); h.confirmations[1].resolve(true); await flush(); h.stops[1].reject(new Error('cannot stop')); await flush(); h.render();
  h.poll(); h.scans[4].resolve(snapshot(service())); await flush(); h.render(); assert.match(h.text(), /cannot stop/);
});

test('clipboard completions and cleanup stay scoped; missing process identity cannot stop', async () => {
  const h = harness(); h.scans[0].resolve(snapshot(service('A', { startedAt: undefined }))); await flush(); h.render();
  h.rows()[0].props.onStop(); assert.equal(h.confirmations.length, 0);
  h.rows()[0].props.onCopy(); h.render({ cwd: '/B', workspace: '/B' }); h.copies[0].reject(new Error('clipboard failure')); await flush(); h.render();
  assert.doesNotMatch(h.text(), /复制失败/); assert.equal(h.timeouts.size, 0);
  h.scans[1].resolve(snapshot(service('B'))); await flush(); h.render(); h.rows()[0].props.onCopy(); h.copies[1].resolve(); await flush(); h.render();
  assert.equal(h.timeouts.size, 1); h.unmount(); assert.equal(h.timeouts.size, 0);
});

test('stop completing while hidden invalidates older scan and resumes a fresh visible read', async () => {
  const h = harness(); h.scans[0].resolve(snapshot(service())); await flush(); h.render();
  h.poll(); const stale = h.scans[1];
  h.rows()[0].props.onStop(); h.confirmations[0].resolve(true); await flush();
  h.visible(false); h.stops[0].resolve({ ok: true }); await flush();
  assert.equal(h.scans.length, 2, 'hidden completion never starts background discovery');
  h.visible(true); assert.equal(h.scans.length, 3, 'old pre-stop read cannot block visible refresh');
  h.scans[2].resolve(snapshot()); await flush(); h.render();
  stale.resolve(snapshot(service())); await flush(); h.render(); assert.equal(h.rows().length, 0);
});
