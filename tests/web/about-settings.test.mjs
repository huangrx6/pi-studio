import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { errorText } from '../../web/src/shared/error-text.ts';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../web/src/features/about/AboutSettings.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function component(react = React, api = {}) {
  const context = { exports: {}, window: { piApi: api }, require(id) {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return react;
    if (id.endsWith('/error-text')) return { errorText };
    return require(id);
  } };
  vm.runInNewContext(compiled, context);
  return context.exports.AboutSettings;
}
const snapshot = { state: 'idle', currentVersion: '1.2.3', currentBuildId: 'full-build-identity-0123456789abcdef' };
const paths = {
  databasePath: '/synthetic/user-data/a-very-long-path/studio.sqlite',
  skillsPath: '/synthetic/user-data/skills/complete-directory',
  extensionsPath: '/synthetic/user-data/extensions/complete-directory',
};
const render = overrides => renderToStaticMarkup(React.createElement(component(), { snapshot: { ...snapshot, ...overrides }, paths, onOpenUpdates() {} }));
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness(overrides = {}) {
  let cursor = 0, tree, setup, cleanup, initialized = false, writes = 0, opens = 0;
  const slots = [], requests = [];
  const Component = component({
    useState(initial) {
      const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; writes++; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect) { if (!initialized) setup = effect; },
  }, { openExternal: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })) });
  function refresh() {
    cursor = 0;
    tree = Component({ snapshot: { ...snapshot, ...overrides }, paths, onOpenUpdates() { opens++; } });
    if (!initialized) { initialized = true; cleanup = setup(); }
  }
  refresh();
  return {
    refresh, requests,
    button(label) { return nodes(tree).find(node => node.type === 'button' && [node.props.children].flat().includes(label)); },
    alerts() { return nodes(tree).filter(node => node.props?.role === 'alert').map(node => node.props.children); },
    unmount() { cleanup(); },
    strictReplay() { cleanup(); cleanup = setup(); },
    counts() { return { writes, opens }; },
  };
}

test('update entry names match state and open the update dialog without starting updater operations', () => {
  const cases = [
    [{ state: 'idle' }, '检查更新'], [{ state: 'checking' }, '正在检查更新'],
    [{ state: 'available' }, '查看更新'], [{ state: 'available', updateKind: 'same-version' }, '查看新构建'],
    [{ state: 'downloading' }, '查看下载进度'], [{ state: 'downloaded' }, '重启与更新'],
    [{ state: 'error' }, '检查更新'], [{ state: 'unsupported' }, '检查更新'], [{ state: 'up-to-date' }, '检查更新'],
  ];
  for (const [state, label] of cases) {
    const h = harness(state);
    assert.ok(h.button(label), `${state.state}: ${label}`);
    h.button(label).props.onClick();
    assert.equal(h.counts().opens, 1);
    assert.equal(h.requests.length, 0);
  }
});

test('diagnostics are initially collapsed and preserve full build identity and every local path', () => {
  const html = render();
  assert.match(html, /<details class="about-diagnostics"><summary>本地存储与诊断信息<\/summary>/);
  const diagnostics = html.match(/<details[\s\S]*?<\/details>/)?.[0];
  for (const text of [snapshot.currentBuildId, ...Object.values(paths)]) assert.ok(diagnostics.includes(text), text);
  assert.match(html, /v1\.2\.3/);
  const unknown = render({ currentVersion: '', currentBuildId: undefined });
  assert.match(unknown, /版本信息尚未加载/);
  assert.doesNotMatch(unknown, /构建标识/);
});

test('all documentation and author links use the existing external-open API with their exact targets', () => {
  const h = harness();
  const links = [
    ['使用文档', 'https://huangrx6.github.io/pi-studio/'],
    ['源代码', 'https://github.com/huangrx6/pi-studio'],
    ['问题反馈', 'https://github.com/huangrx6/pi-studio/issues'],
    ['huangrx6', 'https://github.com/huangrx6'],
    ['MIT License', 'https://github.com/huangrx6/pi-studio/blob/main/LICENSE'],
  ];
  for (const [label, url] of links) {
    h.button(label).props.onClick();
    assert.equal(h.requests.at(-1).url, url);
    h.requests.at(-1).resolve();
  }
});

test('external-open rejection is visible; a newer link owns errors and retry clears them', async () => {
  const h = harness();
  h.button('使用文档').props.onClick();
  h.requests[0].reject(new Error('无法打开浏览器')); await tick(); h.refresh();
  assert.deepEqual(h.alerts(), ['无法打开浏览器']);
  h.button('使用文档').props.onClick(); h.refresh();
  assert.deepEqual(h.alerts(), []);
  h.button('源代码').props.onClick();
  h.requests[1].reject(new Error('obsolete')); h.requests[2].resolve(); await tick(); h.refresh();
  assert.deepEqual(h.alerts(), []);
});

test('unmount ignores late failures and StrictMode setup restores error reporting', async () => {
  const h = harness(); h.button('问题反馈').props.onClick(); h.unmount();
  const before = h.counts().writes;
  h.requests[0].reject(new Error('late')); await tick();
  assert.equal(h.counts().writes, before);
  const strict = harness(); strict.strictReplay(); strict.button('源代码').props.onClick();
  strict.requests[0].reject(new Error('current')); await tick(); strict.refresh();
  assert.deepEqual(strict.alerts(), ['current']);
});
