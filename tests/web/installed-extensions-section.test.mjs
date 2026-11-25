import { Accordion } from './helpers/accordion.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function compile(relative, imports = {}) {
  const context = { exports: {}, require: id => id.endsWith('.css') ? {} : id.endsWith('/Accordion') ? { Accordion } : imports[id] ?? require(id) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const icon = props => React.createElement('svg', props);
const card = ({ item }) => React.createElement('article', { 'data-extension': item.id }, item.name);
const sectionApi = compile('../../web/src/features/extensions/InstalledExtensionsSection.tsx', {
  '../../shared/DetailDialog': { DetailDialog: () => null },
  '../../shared/error-text': { errorText: String },
  '../../shared/LoadingState': { LoadingState: () => null },
  '../../shared/SettingsToast': { useSettingsToast: () => () => {} },
  '../conversation/conversation-extension-order': { moveConversationExtension: () => [] },
  './ExtensionStatusIcon': { ExtensionStatusIcon: icon },
  './InstalledExtensionCard': { InstalledExtensionCard: card },
});
const displayOrder = { items: [], order: [], saving: false, onSave: async () => {}, onRetry() {} };
const cardApi = compile('../../web/src/features/extensions/InstalledExtensionCard.tsx', {
  './ExtensionStatusIcon': { ExtensionStatusIcon: icon },
  './extension-presentation': compile('../../web/src/features/extensions/extension-presentation.ts'),
  '../../shared/plugin-ownership.ts': compile('../../web/src/shared/plugin-ownership.ts'),
  './extension-placement': { configurablePanels: () => [] },
});
const base = {
  id: 'qa.extension',
  name: 'QA 扩展',
  version: '1.0.0',
  scope: 'user',
  tier: 'user',
  source: '/qa',
  enabled: true,
  trusted: true,
  available: true,
  health: 'ready',
  canDisable: true,
  canRemove: true,
  manifest: {
    description: '用户需要快速理解的能力说明。',
    author: 'QA Publisher',
    permissions: ['agent.tools', 'network'],
    runtime: { durableEntry: './index.cjs' },
  },
};

test('user extensions stay visible while built-ins are grouped behind one closed disclosure', () => {
  const items = [
    { ...base, id: 'user', name: '用户扩展' },
    { ...base, id: 'project', name: '项目扩展', scope: 'project', tier: 'project', trusted: false },
    { ...base, id: 'core', name: '核心能力', scope: 'builtin', tier: 'core' },
    { ...base, id: 'system', name: '系统能力', scope: 'builtin', tier: 'system' },
  ];
  const html = renderToStaticMarkup(React.createElement(sectionApi.InstalledExtensionsSection, {
    items,
    displayOrder,
    onOpenDetail() {},
  }));
  assert.ok(html.indexOf('用户扩展') < html.indexOf('<details'));
  assert.ok(html.indexOf('项目扩展') < html.indexOf('<details'));
  assert.match(html, /<details\b[^>]*\bextension-disclosure-card builtin-extension-section\b/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /内置能力/);
  assert.match(html, /class="pi-accordion-badge">2/);
  assert.match(html, /Pi Studio 自带，可查看和单独启停/);
  assert.match(html, /data-extension="core"/);
  assert.match(html, /data-extension="system"/);
  assert.doesNotMatch(html, /列表视图|扩展排列方式/);
});

test('each extension has one keyboard-accessible settings entry and shows its status', () => {
  const builtin = { ...base, scope: 'builtin', tier: 'core', manifest: { ...base.manifest, author: undefined } };
  const html = renderToStaticMarkup(React.createElement(cardApi.InstalledExtensionCard, {
    item: builtin,
    onOpenDetail() {},
  }));
  assert.match(html, /Pi Studio 内置/);
  assert.match(html, /用户需要快速理解/);
  assert.match(html, /运行中/);
  assert.match(html, /aria-label="打开 QA 扩展 设置" aria-haspopup="dialog"/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(html, /role="switch"|卸载/);
});

test('an empty extension list still has one ordinary empty state', () => {
  const html = renderToStaticMarkup(React.createElement(sectionApi.InstalledExtensionsSection, {
    items: [],
    displayOrder,
    onOpenDetail() {},
  }));
  assert.match(html, /已安装/);
  assert.match(html, /还没有安装扩展/);
  assert.doesNotMatch(html, /builtin-extension-section/);
});
