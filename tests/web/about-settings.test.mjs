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
function compile(relative) {
  return ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const compiled = compile('../../web/src/features/about/AboutSettings.tsx');
const header = { exports: {}, require: id => id.endsWith('.css') ? {} : require(id) };
vm.runInNewContext(compile('../../web/src/shared/SettingsPageHeader.tsx'), header);
const groups = { exports: {}, require: id => id.endsWith('.css') ? {} : require(id) };
vm.runInNewContext(compile('../../web/src/shared/PreferenceGroup.tsx'), groups);
function component(react = React, api = {}, showToast = () => {}) {
  const context = { exports: {}, window: { piApi: api }, navigator: { clipboard: api.clipboard }, require(id) {
    if (id.endsWith('.css')) return {};
    if (id.endsWith('.png')) return id;
    if (id === 'react') return react;
    if (id.endsWith('/SettingsPageHeader')) return header.exports;
    if (id.endsWith('/PreferenceGroup')) return groups.exports;
    if (id.endsWith('/SettingsToast')) return { useSettingsToast: () => showToast };
    if (id.endsWith('/error-text')) return { errorText };
    if (id.endsWith('/desktop-platform')) return { revealFileLabel: () => '在访达中显示', desktopPlatform: () => 'darwin' };
    return require(id);
  } };
  vm.runInNewContext(compiled, context);
  return context.exports.AboutSettings;
}
const snapshot = { state: 'idle', currentVersion: '1.2.3', currentBuildId: 'full-build-identity-0123456789abcdef' };
const runtime = { durable: '1.5.2', electron: '42.1.0', chromium: '148.0.10', node: '24.1.0', sqlite: '3.53.0', platform: 'darwin', arch: 'arm64' };
const paths = {
  databasePath: '/synthetic/user-data/a-very-long-path/studio.sqlite',
  attachmentsPath: '/synthetic/user-data/attachments/complete-directory',
  backupsPath: '/synthetic/user-data/backups/complete-directory',
  skillsPath: '/synthetic/user-data/skills/complete-directory',
  extensionsPath: '/synthetic/user-data/extensions/complete-directory',
};
const render = overrides => renderToStaticMarkup(React.createElement(component(), { snapshot: { ...snapshot, ...overrides }, paths, runtime, onOpenUpdates() {} }));
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children, value.props?.actions].flat(Infinity).flatMap(nodes)];
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness(overrides = {}) {
  let cursor = 0, tree, setup, cleanup, initialized = false, opens = 0;
  const slots = [], requests = [], toasts = [];
  const Component = component({
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(effect) { if (!initialized) setup = effect; },
  }, {
    openExternal: url => new Promise((resolve, reject) => requests.push({ type: 'open', url, resolve, reject })),
    clipboard: { writeText: path => new Promise((resolve, reject) => requests.push({ type: 'copy', path, resolve, reject })) },
    revealFile: payload => new Promise((resolve, reject) => requests.push({ type: 'reveal', payload, resolve, reject })),
  }, (...args) => toasts.push(args));
  function refresh() {
    cursor = 0;
    tree = Component({ snapshot: { ...snapshot, ...overrides }, paths, runtime, onOpenUpdates() { opens++; } });
    if (!initialized) { initialized = true; cleanup = setup(); }
  }
  refresh();
  return {
    refresh, requests, toasts,
    button(label) { return nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || [node.props.children].flat().includes(label))); },
    alerts() { return nodes(tree).filter(node => node.props?.role === 'alert').map(node => node.props.children); },
    unmount() { cleanup(); },
    strictReplay() { cleanup(); cleanup = setup(); },
    counts() { return { opens }; },
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

test('runtime versions, full build identity and storage paths are immediately readable', () => {
  const html = render();
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /<h2[^>]*>运行环境<\/h2>/);
  for (const value of [runtime.durable, runtime.electron, runtime.chromium, runtime.node, runtime.sqlite, 'macOS · arm64']) assert.ok(html.includes(value));
  const diagnostics = html.split('<section ').find(section => section.includes('本地存储与诊断信息'));
  assert.ok(diagnostics);
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

test('copying or revealing a storage location uses its complete path', async () => {
  const h = harness();
  h.button('复制会话附件与输出路径').props.onClick();
  assert.equal(h.requests[0].path, paths.attachmentsPath);
  h.requests[0].resolve(); await tick(); h.refresh();
  assert.equal(h.button('复制会话附件与输出路径').props.children, '复制');
  assert.deepEqual(h.toasts, [['已复制会话附件与输出路径']]);
  h.button('在访达中显示 SQLite 数据库').props.onClick();
  assert.equal(h.requests[1].payload.path, paths.databasePath);
  h.requests[1].reject(new Error('无法显示路径')); await tick(); h.refresh();
  assert.deepEqual(h.toasts.at(-1), ['无法显示路径', 'error']);
  assert.deepEqual(h.alerts(), []);
});

test('external-open rejections use a toast owned by the latest request', async () => {
  const h = harness();
  h.button('使用文档').props.onClick();
  h.requests[0].reject(new Error('无法打开浏览器')); await tick(); h.refresh();
  assert.deepEqual(h.toasts, [['无法打开浏览器', 'error']]);
  h.button('使用文档').props.onClick(); h.refresh();
  assert.deepEqual(h.alerts(), []);
  h.button('源代码').props.onClick();
  h.requests[1].reject(new Error('obsolete')); h.requests[2].resolve(); await tick(); h.refresh();
  assert.deepEqual(h.toasts, [['无法打开浏览器', 'error']]);
});

test('unmount ignores late failures and StrictMode setup restores error reporting', async () => {
  const h = harness(); h.button('问题反馈').props.onClick(); h.unmount();
  h.requests[0].reject(new Error('late')); await tick();
  assert.deepEqual(h.toasts, []);
  const strict = harness(); strict.strictReplay(); strict.button('源代码').props.onClick();
  strict.requests[0].reject(new Error('current')); await tick(); strict.refresh();
  assert.deepEqual(strict.toasts, [['current', 'error']]);
});
