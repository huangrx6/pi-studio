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
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const context = {
    exports: {}, require: id => id.endsWith('.css') ? {} : id.endsWith('/Accordion') ? { Accordion } : imports[id] ?? require(id),
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}
const { ExtensionDetailDialog } = compile('../../web/src/features/extensions/ExtensionDetailDialog.tsx', {
  './extension-presentation': compile('../../web/src/features/extensions/extension-presentation.ts'),
  '../../shared/plugin-ownership.ts': compile('../../web/src/shared/plugin-ownership.ts'),
  '../../shared/PackageIcon': compile('../../web/src/shared/PackageIcon.tsx'),
  '../../shared/SettingsToast': { SettingsToast: ({ message, children }) => React.createElement('aside', null, message, children) },
  '../../shared/DetailDialog': { DetailDialog: ({ children, onClose }) => React.createElement('section', null, typeof children === 'function' ? children(onClose) : children) },
});
const item = {
  id: 'qa.extension', name: '扩展详情测试', version: '1.2.3', source: '/workspace/project/.pi-studio/extensions/qa',
  tier: 'project', scope: 'project', trusted: false, enabled: true, canDisable: true, canRemove: true,
  available: false, health: 'untrusted', contentHash: 'content-hash-123', runtimeNames: ['qa-runtime'],
  blockedReason: '此扩展尚未信任', requirements: ['dependency.example'],
  manifest: { description: '检查扩展的真实来源', permissions: [], author: 'QA publisher', contributes: {} },
  installation: {
    source: '/managed/long-source/path', publisher: 'Managed publisher', sourceKind: 'local', sha256: 'version-hash-456', canRollback: true,
    versions: [{ version: '1.2.3', sourceKind: 'local', active: true, activatedAt: 1_700_000_000_000 }],
  },
};
const props = overrides => ({ item, busy: false, refreshError: null, refreshing: false, onRefresh() {},
  onClose() {}, onTrust() {}, onRollback() {}, onToggle() {}, onDelete() {}, onOpenPlugins() {}, ...overrides });
const render = overrides => renderToStaticMarkup(React.createElement(ExtensionDetailDialog, props(overrides)));
const nodes = value => {
  if (!value || typeof value !== 'object') return [];
  const raw = value.props?.children;
  const children = typeof raw === 'function' ? raw(value.props?.onClose ?? (() => {})) : raw;
  return [value, ...[children].flat(Infinity).flatMap(nodes)];
};

test('empty permissions never imply safe declarative-only execution and trust essentials remain visible', () => {
  const html = render();
  assert.match(html, /未声明扩展权限/);
  assert.match(html, /权限声明不代表运行隔离/);
  assert.match(html, /Node 代码在 Electron 主进程执行/);
  assert.doesNotMatch(html, /仅声明式界面/);
  assert.match(html, /<details[^>]*extension-detail-source[^>]* open=""/);
  const visible = html.replace(/<details(?![^>]* open="")[^>]*>[\s\S]*?<\/details>/g, '');
  for (const content of ['Managed publisher', '/managed/long-source/path', '当前工作区', '未信任', '此扩展尚未信任', 'v1.2.3', '信任扩展']) {
    assert.ok(visible.includes(content), content);
  }
});

test('trusted extensions keep source and technical data in closed disclosures', () => {
  const html = render({ item: { ...item, trusted: true, available: true, blockedReason: '' } });
  assert.match(html, /<details class="pi-accordion is-compact extension-detail-source"><summary[^>]*>[\s\S]*?来源与权限[\s\S]*?<\/summary>/);
  assert.match(html, /<details class="pi-accordion is-compact extension-detail-technical"><summary[^>]*>[\s\S]*?技术与运行信息[\s\S]*?<\/summary>/);
  const technical = html.match(/<details[^>]*extension-detail-technical[^>]*>[\s\S]*?<\/details>/)?.[0];
  for (const content of ['qa.extension', 'qa-runtime', 'content-hash-123', 'version-hash-456', 'dependency.example', '版本记录', '回滚版本']) {
    assert.ok(technical.includes(content), content);
  }
  assert.match(render({ item: { ...item, manifest: { ...item.manifest, permissions: ['network', 'agent.tools', 'future.permission'] } } }), /网络访问<\/li><li>智能体工具<\/li><li>future.permission/);
});

test('trust and rollback keep the original callbacks and busy/dependency restrictions', () => {
  const calls = [];
  const tree = ExtensionDetailDialog(props({ onTrust: (...args) => calls.push(['trust', ...args]), onRollback: target => calls.push(['rollback', target]),
    onToggle: (...args) => calls.push(['toggle', ...args]), onDelete: (...args) => calls.push(['delete', ...args]) }));
  const buttons = nodes(tree).filter(node => node.type === 'button');
  const rollback = buttons.find(node => [node.props.children].flat().includes('回滚版本'));
  const trust = buttons.find(node => [node.props.children].flat().includes('信任扩展'));
  rollback.props.onClick(); trust.props.onClick();
  buttons.find(node => node.props.role === 'switch').props.onClick();
  buttons.find(node => node.props['aria-label'] === `卸载 ${item.name}`).props.onClick();
  assert.deepEqual(calls, [['rollback', item], ['trust', item, true], ['toggle', item, false], ['delete', item.id, item.name]]);
  const busy = render({ busy: true });
  assert.equal((busy.match(/disabled=""/g) || []).length, 4);
  const blocked = render({ item: { ...item, trusted: true, canDisable: false, disableBlockedReason: '已有扩展依赖此能力' } });
  assert.match(blocked, /disabled="" title="已有扩展依赖此能力"/);
  assert.match(blocked, /extension-detail-action-note">已有扩展依赖此能力/);
  const global = render({ item: { ...item, scope: 'user' } });
  assert.doesNotMatch(global, /信任扩展<\/button>/);
});

test('plugin-managed extensions provide a route to plugins in place of uninstall', () => {
  const managed = { ...item, scope: 'user', ownerPluginId: 'qa.plugin', origin: 'plugin', managed: true, canRemove: false };
  let navigated = false;
  const tree = ExtensionDetailDialog(props({ item: managed, onOpenPlugins: () => { navigated = true; } }));
  const buttons = nodes(tree).filter(node => node.type === 'button');
  assert.ok(!buttons.some(node => node.props['aria-label'] === `卸载 ${item.name}`));
  const manage = buttons.find(node => [node.props.children].flat().includes('前往插件页'));
  assert.equal(manage.props.disabled, false);
  manage.props.onClick();
  assert.ok(navigated);
});

test('extension detail renders contributed tools, commands, panels, and builtin settings link', () => {
  const browserExt = {
    ...item,
    id: 'builtin:studio-browser-tools',
    name: 'Studio 浏览器',
    scope: 'builtin',
    tier: 'system',
    trusted: true,
    available: true,
    blockedReason: '',
    canRemove: false,
    manifest: {
      description: '在工作台内嵌浏览器中打开、阅读并受控操作网页。',
      permissions: ['agent.tools'],
      author: 'Pi Studio',
      contributes: {
        tools: [
          { name: 'browser_open', description: '在工作台的浏览器中打开网页。' },
          { name: 'browser_click', description: '点击快照中指定的网页元素。' },
        ],
        commands: [
          { id: 'browser', title: '打开浏览器', description: '打开内置工作台浏览器。' },
        ],
        panels: [
          { id: 'browser-view', title: '浏览器面板', description: '实时网页视图', slot: 'tool.view' },
        ],
      },
    },
  };
  const html = render({ item: browserExt, onOpenSettingsPage() {} });
  assert.match(html, /提供的能力/);
  assert.match(html, /2 个工具 · 1 个命令 · 1 个面板/);
  assert.match(html, /<code>browser_open<\/code>/);
  assert.match(html, /在工作台的浏览器中打开网页。/);
  assert.match(html, /<code>\/browser<\/code>/);
  assert.match(html, /工具面板视图/);
  assert.match(html, /打开浏览器设置/);

  let openedTab = null;
  const tree = ExtensionDetailDialog(props({ item: browserExt, onOpenSettingsPage: tab => { openedTab = tab; } }));
  const btn = nodes(tree).filter(node => node.type === 'button').find(node => [node.props.children].flat().includes('打开浏览器设置'));
  assert.ok(btn);
  btn.props.onClick();
  assert.equal(openedTab, 'browser');
});

test('detail labels distinguish composer summaries and status bar details', () => {
  const html = render({item: {...item, manifest: {...item.manifest, contributes: {panels: [
    {id: 'above', title: '置顶读数', slot: 'composer.above'},
    {id: 'below', title: '底部读数', slot: 'composer.below'},
    {id: 'detail', title: '指标详情', slot: 'status.detail'},
  ]}}}});
  assert.equal((html.match(/>会话摘要</g) || []).length, 2);
  assert.match(html, />状态栏详情</);
  assert.doesNotMatch(html, />工具面板视图</);
});
