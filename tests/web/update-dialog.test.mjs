import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';
import { normalizeUpdateProgress } from '../../web/src/features/update/update-presentation.ts';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../web/src/features/update/UpdateDialog.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const notesSource = fs.readFileSync(new URL('../../web/src/features/update/update-notes.ts', import.meta.url), 'utf8');
const notesCompiled = ts.transpileModule(notesSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const notesContext = { exports: {}, require };
vm.runInNewContext(notesCompiled, notesContext);

function component(react = React) {
  const context = { exports: {}, require(id) {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return react;
    if (id.endsWith('/DetailDialog')) return { DetailDialog: ({ children }) => React.createElement('section', null, children) };
    if (id.endsWith('/error-text')) return { errorText };
    if (id === './update-presentation') return { normalizeUpdateProgress };
    if (id === './update-notes') return notesContext.exports;
    return require(id);
  } };
  vm.runInNewContext(compiled, context);
  return context.exports.UpdateDialog;
}
const base = { currentVersion: '1.0.0', latestVersion: '1.1.0', state: 'idle' };
const idleCallbacks = { onClose() {}, onCheck: async () => {}, onDownload: async () => {}, onInstall: async () => {} };
const render = snapshot => renderToStaticMarkup(React.createElement(component(), { ...idleCallbacks, snapshot: { ...base, ...snapshot } }));
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness(snapshot, callbacks = {}) {
  let cursor = 0, tree, setup, cleanup, initialized = false, writes = 0;
  const slots = [];
  const Component = component({
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; writes++; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo(factory) { return factory(); },
    useEffect(effect) { if (!initialized) setup = effect; },
  });
  const props = { ...idleCallbacks, ...callbacks, snapshot: { ...base, ...snapshot } };
  function refresh() {
    cursor = 0; tree = Component(props);
    if (!initialized) { initialized = true; cleanup = setup(); }
  }
  refresh();
  return {
    refresh,
    button(text) { return nodes(tree).find(node => node.type === 'button' && node.props.children === text); },
    alerts() { return nodes(tree).filter(node => node.props?.role === 'alert').map(node => node.props.children); },
    strictReplay() { cleanup(); cleanup = setup(); },
    unmount() { cleanup(); },
    writeCount() { return writes; },
  };
}

test('all updater states have one title and only meaningful actions', () => {
  const cases = [
    ['idle', '检查应用更新', '检查更新'], ['checking', '正在检查更新', null],
    ['available', '发现新版本', '下载更新'], ['downloading', '正在下载更新', null],
    ['downloaded', '已准备好安装', '立即重启并更新'], ['up-to-date', '已是最新版本', '检查更新'],
    ['error', '更新未完成', '重新检查'], ['unsupported', '当前环境不支持更新', null],
  ];
  for (const [state, kicker, action] of cases) {
    const html = render({ state, error: '真实错误原因' });
    assert.equal((html.match(/<h2\b/g) || []).length, 1);
    assert.match(html, new RegExp(`update-kicker[^>]*>${kicker}</p>`));
    assert.match(html, /class="update-title">v1\./);
    assert.equal((html.match(/class="settings-save"/g) || []).length, action ? 1 : 0);
    if (action) assert.ok(html.includes(`>${action}</button>`));
    assert.doesNotMatch(html, /update-orbit|update-stage|update-status-pill|update-ready-card/);
  }
});

test('same-version updates retain both full build identities and plain release notes', () => {
  const html = render({ state: 'available', updateKind: 'same-version', latestVersion: '1.0.0', currentBuildId: 'current-full-build-id', latestBuildId: 'new-full-build-id', releaseNotes: '<script>not executable</script>\nChanges' });
  assert.match(html, /发现同版本新构建/);
  assert.ok(html.includes('current-full-build-id') && html.includes('new-full-build-id'));
  assert.equal((html.match(/v1\.0\.0/g) || []).length, 1);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.match(render({ state: 'downloaded' }), /下次正常退出应用时安装/);
  assert.match(render({ state: 'downloading' }), /关闭此窗口后，下载仍会继续/);
});

test('download progress clamps finite values and never invents a percentage for invalid input', () => {
  for (const [progress, expected] of [[-12, 0], [0, 0], [24.5, 24.5], [150, 100]]) {
    const html = render({ state: 'downloading', progress });
    assert.ok(html.includes(`aria-valuenow="${expected}"`));
    assert.ok(html.includes(`style="width:${expected}%"`));
  }
  for (const progress of [NaN, Infinity, undefined]) {
    const html = render({ state: 'downloading', progress, bytesPerSecond: Infinity, transferred: NaN });
    assert.doesNotMatch(html, /aria-valuenow|NaN|Infinity/);
    assert.match(html, /正在获取进度/);
  }
});

test('all actions use a synchronous lock, expose rejected callbacks, and allow explicit retry', async () => {
  for (const [state, label, callback] of [['idle', '检查更新', 'onCheck'], ['available', '下载更新', 'onDownload'], ['downloaded', '立即重启并更新', 'onInstall']]) {
    const pending = deferred(); let calls = 0;
    const h = harness({ state }, { [callback]: () => { calls++; return calls === 1 ? pending.promise : Promise.resolve(); } });
    const button = h.button(label);
    button.props.onClick(); button.props.onClick();
    assert.equal(calls, 1);
    pending.reject(new Error('操作被拒绝')); await tick(); h.refresh();
    assert.deepEqual(h.alerts(), ['操作被拒绝']);
    h.button(label).props.onClick(); await tick(); h.refresh();
    assert.equal(calls, 2); assert.deepEqual(h.alerts(), []);
  }
});

test('StrictMode setup-cleanup-setup restores lifecycle tracking; unmounted callbacks do not set state', async () => {
  const pending = deferred();
  const h = harness({ state: 'available' }, { onDownload: () => pending.promise });
  h.strictReplay(); h.button('下载更新').props.onClick();
  pending.reject(new Error('StrictMode error')); await tick(); h.refresh();
  assert.deepEqual(h.alerts(), ['StrictMode error']);
  const later = deferred(); const detached = harness({}, { onCheck: () => later.promise });
  detached.button('检查更新').props.onClick(); detached.unmount();
  const count = detached.writeCount(); later.reject(new Error('late')); await tick();
  assert.equal(detached.writeCount(), count);
});

test('synchronous callback exceptions become a local visible error', async () => {
  const h = harness({}, { onCheck() { throw new Error('sync failure'); } });
  h.button('检查更新').props.onClick(); await tick(); h.refresh();
  assert.deepEqual(h.alerts(), ['sync failure']);
});
