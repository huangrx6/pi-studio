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
  const context = { exports: {}, require: id => id.endsWith('.css') ? {} : imports[id] ?? require(id) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const icon = props => React.createElement('svg', props);
const card = ({ item, compact }) => React.createElement('article', {
  'data-extension': item.id,
  'data-compact': compact ? 'true' : 'false',
}, item.name);
const sectionApi = compile('../../web/src/features/extensions/InstalledExtensionsSection.tsx', {
  'lucide-react': { ChevronRight: icon },
  './InstalledExtensionCard': { InstalledExtensionCard: card },
});
const cardApi = compile('../../web/src/features/extensions/InstalledExtensionCard.tsx', {
  './extension-presentation': {
    extensionScopeLabel: scope => scope === 'builtin' ? '内置' : scope === 'project' ? '当前工作区' : '全局',
    extensionStateLabel: () => '不可用',
    extensionStateTone: () => 'pending',
  },
  '../../shared/Select': { Select: props => React.createElement('div', { 'data-select': props.value }) },
  './extension-placement': {
    EXTENSION_PLACEMENT_OPTIONS: [],
    placeablePanels: () => [],
    placementFor: () => 'both',
  },
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
    busy: false,
    onOpenDetail() {},
    onToggle() {},
    onDelete() {},
  }));
  assert.ok(html.indexOf('用户扩展') < html.indexOf('<details'));
  assert.ok(html.indexOf('项目扩展') < html.indexOf('<details'));
  assert.match(html, /<details class="extension-list-section builtin-extension-section">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /内置能力/);
  assert.match(html, /class="count-badge">2/);
  assert.match(html, /Pi Studio 自带，可查看和单独启停/);
  assert.match(html, /data-extension="core" data-compact="true"/);
  assert.match(html, /data-extension="system" data-compact="true"/);
});

test('compact built-in rows remove repeated publisher and capability copy while retaining actions', () => {
  const builtin = { ...base, scope: 'builtin', tier: 'core', manifest: { ...base.manifest, author: undefined } };
  const html = renderToStaticMarkup(React.createElement(cardApi.InstalledExtensionCard, {
    item: builtin,
    busy: false,
    compact: true,
    onOpenDetail() {},
    onToggle() {},
    onDelete() {},
  }));
  assert.match(html, /Pi Studio 内置/);
  assert.doesNotMatch(html, /QA Publisher|用户需要快速理解|主进程 Node 代码|网络访问/);
  assert.match(html, /查看 QA 扩展 详情/);
  assert.match(html, /aria-label="停用 QA 扩展"/);
  assert.doesNotMatch(html, /卸载/);
});

test('an empty extension list still has one ordinary empty state', () => {
  const html = renderToStaticMarkup(React.createElement(sectionApi.InstalledExtensionsSection, {
    items: [],
    busy: false,
    onOpenDetail() {},
    onToggle() {},
    onDelete() {},
  }));
  assert.match(html, /已安装/);
  assert.match(html, /还没有安装扩展/);
  assert.doesNotMatch(html, /builtin-extension-section/);
});
