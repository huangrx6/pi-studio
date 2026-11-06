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
    exports: {}, require: id => id.endsWith('.css') ? {} : imports[id] ?? require(id),
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}
const { ExtensionDetailDialog } = compile('../../web/src/features/extensions/ExtensionDetailDialog.tsx', {
  './extension-presentation': compile('../../web/src/features/extensions/extension-presentation.ts'),
  '../../shared/DetailDialog': { DetailDialog: ({ children }) => React.createElement('section', null, children) },
});
const item = {
  id: 'qa.extension', name: '扩展详情测试', version: '1.2.3', source: '/workspace/project/.pi-studio/extensions/qa',
  tier: 'project', scope: 'project', trusted: false, enabled: true, canDisable: true,
  available: false, health: 'untrusted', contentHash: 'content-hash-123', runtimeNames: ['qa-runtime'],
  blockedReason: '此扩展尚未信任', requirements: ['dependency.example'],
  manifest: { description: '检查扩展的真实来源', permissions: [], author: 'QA publisher', contributes: {} },
  installation: {
    source: '/managed/long-source/path', publisher: 'Managed publisher', sourceKind: 'local', sha256: 'version-hash-456', canRollback: true,
    versions: [{ version: '1.2.3', sourceKind: 'local', active: true, activatedAt: 1_700_000_000_000 }],
  },
};
const props = overrides => ({ item, busy: false, onClose() {}, onTrust() {}, onRollback() {}, ...overrides });
const render = overrides => renderToStaticMarkup(React.createElement(ExtensionDetailDialog, props(overrides)));
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];

test('empty permissions never imply safe declarative-only execution and trust essentials remain visible', () => {
  const html = render();
  assert.match(html, /未声明扩展权限/);
  assert.match(html, /权限声明不代表运行隔离/);
  assert.match(html, /Node 代码在 Electron 主进程执行/);
  assert.doesNotMatch(html, /仅声明式界面/);
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
  for (const content of ['Managed publisher', '/managed/long-source/path', '当前工作区', '未信任', '此扩展尚未信任', 'v1.2.3', '回滚版本', '信任扩展']) {
    assert.ok(visible.includes(content), content);
  }
});

test('technical identity and full hashes remain available in a closed native disclosure', () => {
  const html = render();
  assert.match(html, /<details class="extension-detail-technical"><summary>技术与运行信息<\/summary>/);
  const technical = html.match(/<details[\s\S]*?<\/details>/)?.[0];
  for (const content of ['qa.extension', 'qa-runtime', 'content-hash-123', 'version-hash-456', 'dependency.example']) {
    assert.ok(technical.includes(content), content);
  }
  assert.match(render({ item: { ...item, manifest: { ...item.manifest, permissions: ['network', 'agent.tools', 'future.permission'] } } }), /网络访问<\/li><li>智能体工具<\/li><li>future.permission/);
});

test('trust and rollback keep the original callbacks and busy/dependency restrictions', () => {
  const calls = [];
  const tree = ExtensionDetailDialog(props({ onTrust: (...args) => calls.push(['trust', ...args]), onRollback: target => calls.push(['rollback', target]) }));
  const buttons = nodes(tree).filter(node => node.type === 'button');
  const rollback = buttons.find(node => [node.props.children].flat().includes('回滚版本'));
  const trust = buttons.find(node => [node.props.children].flat().includes('信任扩展'));
  rollback.props.onClick(); trust.props.onClick();
  assert.deepEqual(calls, [['rollback', item], ['trust', item, true]]);
  const busy = render({ busy: true });
  assert.equal((busy.match(/disabled=""/g) || []).length, 2);
  const blocked = render({ item: { ...item, trusted: true, canDisable: false, disableBlockedReason: '已有扩展依赖此能力' } });
  assert.match(blocked, /disabled="" title="已有扩展依赖此能力"/);
  assert.match(blocked, /extension-detail-action-note">已有扩展依赖此能力/);
  const global = render({ item: { ...item, scope: 'user' } });
  assert.doesNotMatch(global, /信任扩展<\/button>/);
});
